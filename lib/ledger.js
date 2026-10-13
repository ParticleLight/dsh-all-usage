import { readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { calculateCost, normalizeCostSnapshot } from './pricing.js'
import { billingInstantOf, contextTimeKey, extractUsageEvent, normalizeUsageValues as usageValues, pickPricingTime, touchContextTimes, upsertUsageSample as upsertUsageSampleState, usageStepKey } from './usage-core.js'

// Usage recorded for workspaces that left the registry is summed into one
// bucket. The ledger's promise is that flushed usage survives deletion, and a
// row per dead workspace would grow the dashboard without adding information.
const RETIRED_WORKSPACE_ID = 'retired:deleted'

// Re-attribute a record (and its turns/usage items) to another workspace id.
// Only the in-memory copy is retargeted: the persisted row keeps its original
// workspace id and cwd, so the mapping stays reversible.
function retargetLedgerRecord(record, workspaceId = RETIRED_WORKSPACE_ID) {
  if (record === null || record === undefined) return record
  const retargeted = {
    ...record,
    workspaceId,
    turns: Array.isArray(record.turns) ? record.turns.map((turn) => ({ ...turn, workspaceId })) : record.turns,
    usage: Array.isArray(record.usage) ? record.usage.map((item) => ({ ...item, workspaceId })) : record.usage,
  }
  // Pricing may later write a resident retired copy. Keep a non-enumerable pointer
  // to the original durable shape so that write-back changes costs without erasing
  // the historical workspace attribution.
  Object.defineProperty(retargeted, '__durableRecord', {
    value: record.__durableRecord || record,
    enumerable: false,
    configurable: true,
  })
  return retargeted
}

const LEDGER_VERSION = 3
const PREVIOUS_LEDGER_VERSION = 2
const LEGACY_LEDGER_VERSION = 1
const LEDGER_SHARD_COUNT = 32
const LEDGER_UNIT_NAME = 'all_usage_ledger'
const LEDGER_META_KEY = '__all_usage_ledger_meta__'
const LEDGER_WRITE_DEBOUNCE_MS = 25

// DSH 0.1.5 replaced the Session `events` getter with `snapshotEvents()` while
// 0.1.1 exposed `events`; both return the log in seq order. Read whichever the
// running runtime provides, because falling back to an empty log would fold a
// flushed session into an empty ledger record.
function sessionEvents(session) {
  if (session === null || session === undefined) return []
  if (Array.isArray(session.events)) return session.events
  if (typeof session.snapshotEvents === 'function') {
    try {
      const snapshot = session.snapshotEvents()
      if (Array.isArray(snapshot)) return snapshot
    } catch (error) {
      return []
    }
  }
  return []
}

// Ledger sequences follow the DSH contract: -1 marks a missing/unavailable
// sequence, otherwise a non-negative safe integer is required.
function validLedgerSeq(value) {
  return value === -1 || (Number.isSafeInteger(value) && value >= 0)
}

function pollutedLedgerKey(key) {
  // Older builds stored raw String(seq) in event keys. Only keys that are
  // entirely numeric text (leading zeros, signs, whitespace, decimals,
  // exponents, huge values) are treated as bare sequence keys and rebuilt;
  // composite keys such as positional event:N and usageStepKey forms that
  // contain colons, letters, or hyphens are never flagged.
  if (typeof key !== 'string') return true
  // Bare whole values only: composite keys such as 'Infinity-session:step:1:1'
  // are valid usageStepKey output and must keep the revision fast path.
  if (key === 'Infinity' || key === '-Infinity' || key === 'NaN' || key === '-NaN') return true
  if (!/^[+\-0-9.eE \t]+$/.test(key)) return false
  if (!/^(?:0|[1-9]\d*)$/.test(key)) return true
  return !Number.isSafeInteger(Number(key))
}

function ledgerShardIndex(sessionId) {
  let hash = 2166136261
  const value = typeof sessionId === 'string' ? sessionId : String(sessionId)
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0) % LEDGER_SHARD_COUNT
}

function ledgerShardName(index) {
  return LEDGER_UNIT_NAME + '_' + String(index).padStart(2, '0')
}

function sessionRows(snapshot) {
  const rows = snapshot && snapshot.tables && snapshot.tables.sessions
  return rows !== null && rows !== undefined && typeof rows === 'object' ? rows : {}
}

function uniqueUnits(units) {
  return Array.from(new Set(units.filter((unit) => unit !== null && unit !== undefined)))
}

function createLedgerUnitStore(legacyUnit, shardUnits, root = '') {
  const shards = uniqueUnits(shardUnits)
  const allUnits = uniqueUnits([legacyUnit, ...shards])
  return {

    async loadAll() {
      const snapshots = await Promise.all(shards.map((unit) => unit.loadAll()))
      const rows = Object.create(null)
      for (const snapshot of snapshots) {
        for (const [key, value] of Object.entries(sessionRows(snapshot))) {
          if (key !== LEDGER_META_KEY) rows[key] = value
        }
      }
      return { global: {}, tables: { sessions: rows } }
    },
    /**
     * Every session key the shards hold, without parsing a single record: the
     * per-record layout is a directory of documents, so the filenames are the
     * index and a record is read later, on demand, with readRecord().
     */
    async listKeys() {
      const keys = []
      for (const unit of shards) {
        let dir = ''
        try {
          dir = unit.tableDir('sessions')
        } catch (err) {
          continue
        }
        const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
        for (const entry of entries) {
          if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name.startsWith('__')) continue
          keys.push(entry.name.slice(0, -'.json'.length))
        }
      }
      return keys
    },
    /** One document, parsed the way the storage unit parses it when it loads. */
    async readRecord(key) {
      const unit = shardUnits[ledgerShardIndex(key)]
      if (unit === undefined) return undefined
      let path = ''
      try {
        path = join(unit.tableDir('sessions'), key + '.json')
      } catch (err) {
        return undefined
      }
      try {
        const doc = JSON.parse(await readFile(path, 'utf8'))
        if (doc === null || typeof doc !== 'object' || doc.version !== 0 || doc.record === undefined) return undefined
        return doc.record
      } catch (err) {
        return undefined
      }
    },
    async hasMigrationMarker() {
      if (shardUnits[0] === undefined) return false
      return Object.hasOwn(sessionRows(await shardUnits[0].loadAll()), LEDGER_META_KEY)
    },
    async putRecord(table, key, value) {
      if (table !== 'sessions') throw new Error('usage ledger only supports the sessions table')
      const index = key === LEDGER_META_KEY ? 0 : ledgerShardIndex(key)
      const unit = shardUnits[index]
      if (unit === undefined) throw new Error('usage ledger shard is unavailable: ' + index)
      return unit.putRecord(table, key, value)
    },
    async close() {
      await Promise.all(allUnits.map((unit) => unit.close().catch(() => {})))
    },
    shardCount: LEDGER_SHARD_COUNT,
  }
}

async function openLedgerUnitStore(backend) {
  const shardUnits = []
  let legacyUnit
  try {
    for (let index = 0; index < LEDGER_SHARD_COUNT; index += 1) {
      // One file per session record: the single-file layout rewrote the whole
      // shard (a 4.9 MB average, 13.2 MB worst case, ~50-240 ms) for every
      // session update. The per-record layout publishes one document per write,
      // and it migrates itself from the same-named single-file unit on open.
      shardUnits.push(await backend.kv.open({ name: ledgerShardName(index), version: 0, tables: ['sessions'], hasGlobal: false, layout: 'per-record' }))
    }
    const root = typeof backend.root === 'string' ? backend.root : ''
    const shardStore = createLedgerUnitStore(undefined, shardUnits, root)
    // A per-record unit exposes tableDir(), so its documents can be listed and read
    // one at a time. Older or fake units cannot, and there the whole table is read
    // once (and stays resident) exactly as it always was.
    const streaming = shardUnits.length > 0 && typeof shardUnits[0].tableDir === 'function'
    const shardRows = streaming ? Object.create(null) : sessionRows(await shardStore.loadAll())
    if (await shardStore.hasMigrationMarker()) {
      // The trees are the record now, so any leftover whole-unit file is dead
      // weight. This also runs on the fast path, because a previous start may
      // have seeded the trees and exited before retiring them.
      const retired = await retireLegacyLedgerFiles(backend, shardUnits).catch((error) => { console.error('[all-usage] usage ledger legacy retirement failed:', error && error.message); return [] })
      return { store: shardStore, rows: shardRows, retired, streaming }
    }

    // Read the legacy monolith only during the one-time migration. Once shard 00
    // carries the marker, startup never parses the old multi-megabyte file again.
    legacyUnit = await backend.kv.open({ name: LEDGER_UNIT_NAME, version: 0, tables: ['sessions'], hasGlobal: false })
    const store = createLedgerUnitStore(legacyUnit, shardUnits)
    const rows = Object.assign(Object.create(null), shardRows)
    const legacyRows = sessionRows(await legacyUnit.loadAll())
    for (const [key, value] of Object.entries(legacyRows)) {
      if (key === LEDGER_META_KEY || Object.hasOwn(rows, key)) continue
      await store.putRecord('sessions', key, value)
      rows[key] = value
    }
    await store.putRecord('sessions', LEDGER_META_KEY, { version: 1, migratedAt: Date.now() })
    // Its records now live in the per-record trees (written above), so the
    // legacy document is retired. A failure here leaves the file in place and
    // simply tries again on the next start.
    const retired = await retireLegacyLedgerFiles(backend, shardUnits).catch((error) => { console.error('[all-usage] usage ledger legacy retirement failed:', error && error.message); return [] })
    return { store, rows, retired, streaming: false }
  } catch (error) {
    await Promise.all(uniqueUnits([legacyUnit, ...shardUnits]).map((unit) => unit.close().catch(() => {})))
    throw error
  }
}

// Once a legacy whole-unit file has seeded its per-record tree, the file itself
// is dead weight: every record lives in the tree now, while the old document
// keeps a full copy (155.9 MB across the 32 shards plus a 22.4 MB monolith on
// this machine). DSH's storage layer never removes it, so the ledger retires it
// itself — only after the tree is non-empty, only for files it owns, and never
// more than once per unit (a marker keeps a failed run from looping).
async function retireLegacyLedgerFiles(backend, shardUnits) {
  if (process.env.DSH_ALL_USAGE_KEEP_LEGACY === '1') return []
  const root = typeof backend.root === 'string' ? backend.root : ''
  if (root === '') return []
  const marker = join(root, LEDGER_UNIT_NAME + '.retired')
  if (await stat(marker).then(() => true, () => false)) return []
  const retired = []
  const candidates = []
  for (let index = 0; index < LEDGER_SHARD_COUNT; index += 1) {
    const name = ledgerShardName(index)
    if (shardUnits[index] === undefined || shardUnits[index] === null) continue
    // The medium tells the truth: a shard has been migrated when its per-record
    // tree holds documents.
    const count = await readdir(join(root, name, 'sessions')).then((entries) => entries.filter((entry) => entry.endsWith('.json')).length, () => 0)
    candidates.push({ name, count })
  }
  for (const candidate of candidates) {
    if (candidate.count === 0) continue
    const file = join(root, candidate.name + '.json')
    const size = await stat(file).then((info) => info.size, () => null)
    if (size === null) continue
    const removed = await unlink(file).then(() => size, (error) => { console.error('[all-usage] usage ledger legacy file could not be retired:', file, error && error.message); return null })
    if (removed !== null) retired.push({ name: candidate.name + '.json', bytes: removed })
  }
  const monolith = join(root, LEDGER_UNIT_NAME + '.json')
  const monolithSize = await stat(monolith).then((info) => info.size, () => null)
  if (monolithSize !== null && candidates.some((candidate) => candidate.count > 0)) {
    const removed = await unlink(monolith).then(() => monolithSize, () => null)
    if (removed !== null) retired.push({ name: LEDGER_UNIT_NAME + '.json', bytes: removed })
  }
  if (retired.length > 0) await writeFile(marker, JSON.stringify({ retiredAt: Date.now(), files: retired.length }), 'utf8').catch(() => {})
  return retired
}

const IDENTITY_REF_FIELD = 'identityRef'

// The same route is used for thousands of requests, yet a ledger row used to
// repeat its identity object (key, provider, requested/actual model, label) on
// every usage item — 14.5 MB of the current 91 MB of records. Rows are written
// with one shared identity list and per-item indexes instead, and read back into
// the same shape as before, so nothing outside this file changes. Rows whose
// workspace differs from the record's keep their own workspaceId, and a row with
// no identity at all still normalizes through its modelId.
function serializeLedgerRecord(record) {
  if (record === null || typeof record !== 'object' || !Array.isArray(record.usage)) return record
  const identities = []
  const identityIndex = new Map()
  const usage = record.usage.map((item) => {
    if (item === null || typeof item !== 'object') return item
    const identity = item.identity
    if (identity === undefined || identity === null) return item
    const identityKey = JSON.stringify(identity)
    let index = identityIndex.get(identityKey)
    if (index === undefined) { index = identities.length; identities.push(identity); identityIndex.set(identityKey, index) }
    // workspaceId stays on every item: it is what tells a mixed-workspace row
    // apart, and a record retargeted to another workspace must not re-home its
    // history.
    const next = { ...item, [IDENTITY_REF_FIELD]: index }
    delete next.identity
    delete next.modelId
    return next
  })
  if (identities.length === 0) return { ...record, usage }
  return { ...record, usageIdentities: identities, usage }
}

function expandLedgerRecord(raw) {
  if (raw === null || typeof raw !== 'object' || !Array.isArray(raw.usage) || !Array.isArray(raw.usageIdentities)) return raw
  const identities = raw.usageIdentities
  const usage = raw.usage.map((item) => {
    if (item === null || typeof item !== 'object' || !Number.isInteger(item[IDENTITY_REF_FIELD])) return item
    const identity = identities[item[IDENTITY_REF_FIELD]]
    const next = { ...item, identity, modelId: identity === undefined || identity === null ? item.modelId : identity.label }
    delete next[IDENTITY_REF_FIELD]
    return next
  })
  const expanded = { ...raw, usage }
  delete expanded.usageIdentities
  return expanded
}

export function createLedger(host) {
  const { state, markStatsChanged } = host
  const { storage } = host.services
  state.ledgerPending = state.ledgerPending || new Map()
  state.ledgerWriteWaiters = state.ledgerWriteWaiters || new Map()
  state.ledgerWriteRunning = state.ledgerWriteRunning === true
  state.ledgerWriteScheduled = state.ledgerWriteScheduled === true
  state.ledgerWriteTimer = state.ledgerWriteTimer || null
  state.ledgerWriteFailedSessions = state.ledgerWriteFailedSessions || new Set()
  const {
    addTurn,
    coerceIdentity,
    identityFromLegacy,
    identityFromMessage,
    identityFromRoute,
    makeIdentity,
    costForUsage,
    resolveCurrentPricing,
    dateKeys,
    validEventTime,
    upsertUsageSample,
    usageRowOf,
    foldUsageRow,
    adoptUsageRow,
    sessionsForRange,
  } = host.aggregation
  const lastSeqOf = (...args) => host.sessionSync.lastSeqOf(...args)
  function isLegacyTieredCost(cost) {
    const selectedTier = cost && cost.selectedTier
    const hasSelectedTier = selectedTier && selectedTier.type === 'context' && Number.isSafeInteger(selectedTier.size) && selectedTier.size >= 0
    return cost !== null && cost.tiered === true && cost.status === 'priced' && !hasSelectedTier
  }

  function nextLedgerRevision() {
    const current = Number.isFinite(state.ledgerRevision) ? state.ledgerRevision : 0
    state.ledgerRevision = Math.max(current + 1, Date.now())
    return state.ledgerRevision
  }
  function ledgerEventKey(event, index) {
    // Only finite safe-integer sequences are canonical event ids; anything else
    // falls back to the positional index so two invalid events cannot overwrite
    // each other in the ledger.
    return Number.isSafeInteger(event.seq) && event.seq >= 0 ? String(event.seq) : 'event:' + index
  }
  function canFoldLedgerTail(previousRecord, events, workspaceId) {
    if (previousRecord === null || previousRecord === undefined || previousRecord.needsUpgrade === true || previousRecord.rebuildRequired !== undefined || !Number.isSafeInteger(previousRecord.lastSeq) || previousRecord.lastSeq < 0 || !Array.isArray(events) || events.length === 0) return false
    // A changed workspace identity (deleted and re-added workspace gets a new id)
    // assigns every historical event to a different bucket, so the previous
    // record can never be reused as a tail seed for the new workspace.
    if (workspaceId !== undefined && previousRecord.workspaceId !== undefined && previousRecord.workspaceId !== workspaceId) return false
    const startIndex = previousRecord.lastSeq + 1
    if (startIndex >= events.length || events[startIndex] === null || typeof events[startIndex] !== 'object' || events[startIndex].seq !== startIndex) return false
    const previousTurns = new Set(Array.isArray(previousRecord.turns) ? previousRecord.turns.map((turn) => turn && turn.turn).filter((turn) => Number.isSafeInteger(turn)) : [])
    for (let index = startIndex, expectedSeq = startIndex; index < events.length; index += 1, expectedSeq += 1) {
      const event = events[index]
      if (event === null || typeof event !== 'object' || event.seq !== expectedSeq) return false
      if (event.type === 'turn/end' && event.data && Number.isSafeInteger(event.data.turn) && previousTurns.has(event.data.turn)) return false
    }
    return true
  }
function buildLedgerRecord(session, workspaceId, source = 'scan', revision, previousRecord, sequenceClean = true) {
    const sid = session && typeof session.id === 'string' ? session.id : ''
    const events = sessionEvents(session)
    if (sid === '' || workspaceId === undefined) return null
    // DSH sequences every persisted event with seq === log index, so the last
    // event's seq is the record's lastSeq in O(1); fall back to a full scan only
    // when the tail carries no seq (legacy or truncated logs).
    const tailEvent = events.length > 0 ? events[events.length - 1] : null
    const lastSeq = tailEvent !== null && Number.isSafeInteger(tailEvent.seq) && tailEvent.seq >= 0 ? tailEvent.seq : lastSeqOf(events)
    // A changed incremental log that contains invalid sequences anywhere must
    // be rebuilt wholesale: the fold check only validates the tail, so a bad
    // event before the fold start would otherwise be skipped in memory while
    // the persisted record still contains everything.
    const canFoldTail = sequenceClean === true && canFoldLedgerTail(previousRecord, events, workspaceId)
    const turns = canFoldTail ? new Map((previousRecord.turns || []).map((item) => [item.key, { ...item }])) : new Map()
    const usage = canFoldTail ? new Map((previousRecord.usage || []).map((item) => [item.key, { ...item }])) : new Map()
    const previousUsage = new Map(Array.isArray(previousRecord && previousRecord.usage) ? previousRecord.usage.map((item) => [item.key, item]) : [])
    let currentIdentity = canFoldTail ? coerceIdentity(previousRecord.lastIdentity) : makeIdentity(null, null, null, null)
    // Request-context instants are kept per turn/step so parallel requests each
    // carry their own billing time while scanning the persisted log.  When the
    // tail is folded onto a persisted record, the previous context archive seeds
    // the map so an open request whose context arrived in the previous batch
    // still bills its usage with the matching request instant after a restart.
    const contextTimes = canFoldTail ? new Map(Array.isArray(previousRecord.contextTimes) ? previousRecord.contextTimes.map((entry) => [entry.key, entry.time]) : []) : new Map()
    const startIndex = canFoldTail ? previousRecord.lastSeq + 1 : 0
    for (let index = startIndex; index < events.length; index += 1) {
      const event = events[index]
      if (event === null || typeof event !== 'object') continue
      if (canFoldTail && event.seq <= previousRecord.lastSeq) continue
      const data = event.data
      if (event.type === 'request/context') {
        currentIdentity = identityFromRoute(data, currentIdentity)
        if (validEventTime(event.time)) touchContextTimes(contextTimes, contextTimeKey(data && data.turn, data && data.step), event.time)
        continue
      }
      if (event.type === 'request/header') {
        currentIdentity = identityFromRoute(data, currentIdentity)
        continue
      }
      if (event.type === 'turn/end') {
        if (!validEventTime(event.time)) continue
        const key = ledgerEventKey(event, index)
        const turn = data && typeof data.turn === 'number' ? data.turn : null
        turns.set(key, { key, seq: validLedgerSeq(event.seq) ? event.seq : -1, time: event.time, workspaceId, turn, identity: currentIdentity })
        continue
      }
      if (!validEventTime(event.time)) continue
      const usageEvent = extractUsageEvent(event)
      if (usageEvent === null) continue
      const identity = usageEvent.kind === 'message' ? identityFromMessage(data, currentIdentity) : currentIdentity
      const key = usageStepKey(sid, data, event.seq)
      const pricing = pickPricingTime(contextTimes, event.time, usageEvent.turn, usageEvent.step)
      const result = upsertUsageSample(usage, {
        key,
        seq: validLedgerSeq(event.seq) ? event.seq : -1,
        time: event.time,
        workspaceId,
        identity,
        modelId: identity.label,
        turn: usageEvent.turn,
        step: usageEvent.step,
        values: usageEvent.values,
        pricingAt: pricing.time,
        pricingTimeSource: pricing.source,
      }, { costPrevious: previousUsage.get(key) })
      if (result.accepted && usageEvent.kind === 'message') currentIdentity = identity
    }
    const sourceCwd = session && session.header && typeof session.header.cwd === 'string' ? session.header.cwd : undefined
    return { version: LEDGER_VERSION, sessionId: sid, workspaceId, ...(sourceCwd === undefined ? {} : { sourceCwd }), lastSeq, source, updatedAt: nextLedgerRevision(), lastRevision: typeof revision === 'string' ? revision : undefined, sourceRevision: typeof revision === 'string' ? revision : undefined, lastIdentity: currentIdentity, contextTimes: Array.from(contextTimes.entries()).map(([key, time]) => ({ key, time })), turns: Array.from(turns.values()), usage: Array.from(usage.values()) }
  }
  function normalizeLedgerRecord(input, key) {
    // Rows written with a shared identity list are expanded first: every check
    // below then sees exactly the same item shape it always did.
    const raw = expandLedgerRecord(input)
    if (raw === null || typeof raw !== 'object' || (raw.version !== LEDGER_VERSION && raw.version !== PREVIOUS_LEDGER_VERSION && raw.version !== LEGACY_LEDGER_VERSION) || typeof raw.sessionId !== 'string' || raw.sessionId !== key) return null
    if (!Array.isArray(raw.turns) || !Array.isArray(raw.usage)) return null
    // One pass per list: validity, workspace mixing and the map share it, and a
    // usage row normalizes its cost snapshot once instead of once per question
    // (that call parses eleven decimal fields).
    let invalidTurn = false
    let invalidUsage = false
    let mixedWorkspace = false
    const turnMap = new Map()
    for (const turn of raw.turns) {
      if (turn === null || typeof turn !== 'object' || typeof turn.key !== 'string' || turn.workspaceId === undefined || !validEventTime(turn.time) || pollutedLedgerKey(turn.key) || (turn.seq !== undefined && !validLedgerSeq(turn.seq))) invalidTurn = true
      if (turn && turn.workspaceId !== raw.workspaceId) mixedWorkspace = true
      if (turn && typeof turn.key === 'string' && turn.workspaceId !== undefined && validEventTime(turn.time)) turnMap.set(turn.key, { key: turn.key, seq: Number.isSafeInteger(turn.seq) ? turn.seq : -1, time: turn.time, workspaceId: turn.workspaceId, turn: typeof turn.turn === 'number' ? turn.turn : null, identity: coerceIdentity(turn.identity || turn.modelId) })
    }
    const usageMap = new Map()
    for (const item of raw.usage) {
      const normalizedCost = normalizeCostSnapshot(item === null || item === undefined ? null : item.cost)
      if (item === null || typeof item !== 'object' || !validEventTime(item.time) || item.identity === undefined || pollutedLedgerKey(item.key) || (item.seq !== undefined && !validLedgerSeq(item.seq)) || normalizedCost === null || normalizedCost.pricingMode !== 'official-model' || isLegacyTieredCost(normalizedCost)) invalidUsage = true
      // Older versions could write a record whose top-level workspaceId belonged
      // to a recreated workspace while its historical items kept the previous one;
      // such mixed records must never be reused as a fast path.
      if (item && item.workspaceId !== raw.workspaceId) mixedWorkspace = true
      if (!item || typeof item.key !== 'string' || item.workspaceId === undefined || !validEventTime(item.time) || item.values === null || typeof item.values !== 'object') continue
      const identity = coerceIdentity(item.identity || item.modelId)
      const normalized = { key: item.key, seq: Number.isSafeInteger(item.seq) ? item.seq : -1, time: item.time, workspaceId: item.workspaceId, identity, modelId: identity.label, ...(normalizedCost === null ? {} : { cost: normalizedCost }), turn: typeof item.turn === 'number' ? item.turn : null, step: typeof item.step === 'number' ? item.step : null, values: usageValues({ inputTokens: item.values.input, outputTokens: item.values.output, cacheReadTokens: item.values.cacheRead, cacheWriteTokens: item.values.cacheWrite, reasoningTokens: item.values.reasoning }) }
      upsertUsageSampleState(usageMap, normalized)
    }
    // The rebuild reason is persisted (enumerable) so the flag survives a
    // failure-and-restart cycle even when normalized content alone no longer
    // carries the evidence (e.g. lastSeq -1 after an invalid non-safe value).
    const persistedReason = typeof raw.rebuildRequired === 'string' && raw.rebuildRequired !== '' ? raw.rebuildRequired : undefined
    const computedReason = invalidTurn ? 'invalid-turn' : invalidUsage ? 'invalid-usage' : mixedWorkspace ? 'mixed-workspace' : (raw.lastSeq !== undefined && !validLedgerSeq(raw.lastSeq)) ? 'invalid-last-seq' : raw.version !== LEDGER_VERSION ? 'legacy-version' : !Number.isFinite(raw.updatedAt) ? 'invalid-updated-at' : undefined
    const rebuildReason = persistedReason !== undefined ? persistedReason : computedReason
    const needsUpgrade = rebuildReason !== undefined || !Number.isFinite(raw.updatedAt) || raw.version !== LEDGER_VERSION
    const updatedAt = Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0
    state.ledgerRevision = Math.max(Number.isFinite(state.ledgerRevision) ? state.ledgerRevision : 0, updatedAt)
    const contextMap = new Map()
    if (Array.isArray(raw.contextTimes)) {
      for (const entry of raw.contextTimes) {
        if (entry === null || typeof entry !== 'object' || typeof entry.key !== 'string' || !entry.key.startsWith('context:') || entry.key.length > 128 || !validEventTime(entry.time)) continue
        touchContextTimes(contextMap, entry.key, entry.time)
      }
    }
    const lastUsage = Array.from(usageMap.values()).at(-1)
    const lastIdentity = coerceIdentity(raw.lastIdentity || raw.sourceRevisionIdentity || (lastUsage && lastUsage.identity))
    const sourceCwd = typeof raw.sourceCwd === 'string' && raw.sourceCwd.trim() !== '' ? raw.sourceCwd : undefined
    const normalizedRecord = { version: LEDGER_VERSION, sessionId: raw.sessionId, workspaceId: raw.workspaceId, ...(sourceCwd === undefined ? {} : { sourceCwd }), lastSeq: validLedgerSeq(raw.lastSeq) ? raw.lastSeq : -1, source: raw.source === 'flush' ? 'flush' : 'scan', updatedAt, lastRevision: typeof raw.lastRevision === 'string' ? raw.lastRevision : (typeof raw.sourceRevision === 'string' ? raw.sourceRevision : undefined), sourceRevision: typeof raw.sourceRevision === 'string' ? raw.sourceRevision : (typeof raw.lastRevision === 'string' ? raw.lastRevision : undefined), lastIdentity, contextTimes: Array.from(contextMap.entries()).map(([key, time]) => ({ key, time })), turns: Array.from(turnMap.values()), usage: Array.from(usageMap.values()) }
    if (rebuildReason !== undefined) normalizedRecord.rebuildRequired = rebuildReason
    Object.defineProperty(normalizedRecord, 'needsUpgrade', { value: needsUpgrade, enumerable: false, writable: true })
    return normalizedRecord
  }
  function prepareLedgerRecord(record) {
    if (record === null || record === undefined) return record
    // A current record was normalized on the way in, so every item already carries
    // a canonical cost snapshot: re-parsing each one (eleven decimal fields apiece)
    // would be a pass over the whole record that changes nothing.
    if (record.needsUpgrade !== true && record.version === LEDGER_VERSION) return record
    let changed = true
    for (const item of record.usage) {
      const cost = normalizeCostSnapshot(item.cost)
      if (isLegacyTieredCost(cost)) {
        item.cost = calculateCost(item.values, { ...cost, status: 'unsupported', reason: 'tiered-pricing-not-modeled' })
        changed = true
        continue
      }
      if (cost !== null && cost.pricingMode === 'official-model') { item.cost = cost; continue }
      const identity = item.identity || identityFromLegacy(item.modelId)
      const billing = billingInstantOf(item, cost)
      item.cost = calculateCost(item.values, resolveCurrentPricing(identity), billing.at, billing.source)
      changed = true
    }
    if (changed) {
      // Repacking costs must never clear the rebuild flag: only a complete
      // rebuild from the source log produces a record that is safe to reuse.
      record.version = LEDGER_VERSION
      record.updatedAt = nextLedgerRevision()
      cacheLedgerRecord(record)
      rememberLedgerKey(record.sessionId)
      void persistLedgerRecord(record)
    }
    return record
  }
  function applyLedgerRecord(record, materialization = 'ledger-reuse') {
    if (record === null || record === undefined) return
    prepareLedgerRecord(record)
    if (record.lastIdentity !== undefined) state.sessionModel.set(record.sessionId, record.lastIdentity)
    if (Array.isArray(record.contextTimes)) {
      const times = new Map()
      for (const entry of record.contextTimes) if (entry && typeof entry.key === 'string' && Number.isFinite(entry.time)) times.set(entry.key, entry.time)
      state.sessionContextTimes.set(record.sessionId, times)
    }
    for (const turn of record.turns) addTurn(turn.workspaceId, turn.time, record.sessionId, turn.turn, turn.identity, materialization, turn.seq)
    for (const item of record.usage) {
      foldUsageRow(usageRowOf(record, item, materialization), materialization)
    }
    if (record.turns.length > 0 || record.usage.length > 0) {
      state.sessionCount.add(record.sessionId)
      if (record.usage.length > 0) markStatsChanged('scan')
    }
  }
  function ledgerRank(record) {
    return [Number.isFinite(record.lastSeq) ? record.lastSeq : -1, record.source === 'flush' ? 1 : 0, Number.isFinite(record.updatedAt) ? record.updatedAt : 0]
  }
  function replaceLedgerRecord(record) {
    assertLedgerRecord(record)
    cacheLedgerRecord(record)
    rememberLedgerKey(record.sessionId)
    return record
  }
  function assertLedgerRecord(record) {
    if (record === null || typeof record !== 'object' || !Number.isFinite(record.updatedAt)) throw new TypeError('usage ledger updatedAt must be a finite number')
    return record
  }
  function storeLedgerRecord(record) {
    assertLedgerRecord(record)
    const current = state.ledgerRecords.get(record.sessionId)
    if (current !== undefined) {
      const nextRank = ledgerRank(record)
      const currentRank = ledgerRank(current)
      if (nextRank[0] < currentRank[0] || (nextRank[0] === currentRank[0] && (nextRank[1] < currentRank[1] || (nextRank[1] === currentRank[1] && nextRank[2] <= currentRank[2])))) return current
    }
    cacheLedgerRecord(record)
    rememberLedgerKey(record.sessionId)
    return record
  }
  function resolveLedgerWaiters(sid) {
    const waiters = state.ledgerWriteWaiters.get(sid)
    if (waiters === undefined) return
    state.ledgerWriteWaiters.delete(sid)
    for (const resolve of waiters) resolve()
  }
  async function drainPendingLedgerWrites() {
    while (state.ledgerPending.size > 0) {
      const entry = state.ledgerPending.entries().next().value
      if (entry === undefined) break
      const [sid, record] = entry
      state.ledgerPending.delete(sid)
      const resident = state.ledgerRecords.get(sid)
      if (state.ledgerUnit === null || (resident !== record && resident?.__durableRecord !== record)) {
        if (!state.ledgerPending.has(sid)) resolveLedgerWaiters(sid)
        continue
      }
      try {
        // The medium receives the compact row; everything in memory keeps the record.
        await state.ledgerUnit.putRecord('sessions', sid, serializeLedgerRecord(record))
        state.ledgerWriteFailedSessions.delete(sid)
      } catch (err) {
        state.ledgerWriteFailedSessions = state.ledgerWriteFailedSessions || new Set()
        state.ledgerWriteFailedSessions.add(sid)
        state.ledgerDirtySessions = state.ledgerDirtySessions || new Set()
        state.ledgerDirtyEpochs = state.ledgerDirtyEpochs || new Map()
        state.ledgerDirtySessions.add(sid)
        state.ledgerDirtyEpochs.set(sid, (state.ledgerDirtyEpochs.get(sid) || 0) + 1)
        console.error('[all-usage] usage ledger write failed:', err)
      }
      if (!state.ledgerPending.has(sid)) resolveLedgerWaiters(sid)
    }
  }
  function startLedgerWrite() {
    if (state.ledgerWriteRunning || state.ledgerPending.size === 0 || state.ledgerUnit === null) return
    state.ledgerWriteRunning = true
    const write = state.ledgerWriteChain.then(() => drainPendingLedgerWrites(), () => drainPendingLedgerWrites())
    state.ledgerWriteChain = write.catch((err) => {
      console.error('[all-usage] usage ledger queue failed:', err)
    }).finally(() => {
      state.ledgerWriteRunning = false
      if (state.ledgerPending.size > 0 && state.ledgerUnit !== null) scheduleLedgerWrite()
    })
  }
  function scheduleLedgerWrite() {
    if (state.ledgerWriteScheduled || state.ledgerWriteRunning || state.ledgerPending.size === 0 || state.ledgerUnit === null) return
    state.ledgerWriteScheduled = true
    const run = () => {
      state.ledgerWriteScheduled = false
      state.ledgerWriteTimer = null
      startLedgerWrite()
    }
    state.ledgerWriteTimer = setTimeout(run, LEDGER_WRITE_DEBOUNCE_MS)
    // Keep a reference while write waiters are pending: the debounce timer is
    // what eventually resolves persistLedgerRecord promises, and an unreferenced
    // timer lets the event loop (and test runs) settle before the write happens.
    if (state.ledgerWriteTimer && typeof state.ledgerWriteTimer.unref === 'function' && state.ledgerWriteWaiters.size === 0) state.ledgerWriteTimer.unref()
  }
  function persistLedgerRecord(record) {
    if (record !== null && record !== undefined) assertLedgerRecord(record)
    if (record === null || record === undefined || state.disposed || state.ledgerUnit === null) return Promise.resolve()
    const resident = state.ledgerRecords.get(record.sessionId)
    if (resident !== record && resident?.__durableRecord !== record) return Promise.resolve()
    const waiter = new Promise((resolve) => {
      const waiters = state.ledgerWriteWaiters.get(record.sessionId) || []
      waiters.push(resolve)
      state.ledgerWriteWaiters.set(record.sessionId, waiters)
    })
    state.ledgerPending.set(record.sessionId, record)
    scheduleLedgerWrite()
    return waiter
  }
  async function drainLedgerWrites() {
    if (state.ledgerWriteTimer !== null) {
      clearTimeout(state.ledgerWriteTimer)
      state.ledgerWriteTimer = null
    }
    state.ledgerWriteScheduled = false
    if (state.ledgerPending.size > 0 && !state.ledgerWriteRunning && state.ledgerUnit !== null) startLedgerWrite()
    await state.ledgerWriteChain
    if (state.ledgerPending.size > 0 && !state.ledgerWriteRunning && state.ledgerUnit !== null) {
      startLedgerWrite()
      await state.ledgerWriteChain
    }
    for (const sid of Array.from(state.ledgerWriteWaiters.keys())) {
      if (!state.ledgerPending.has(sid)) resolveLedgerWaiters(sid)
    }
  }
  function recordCacheLimit() {
    const megabytes = Number(process.env.DSH_ALL_USAGE_RECORD_CACHE_MB)
    return Number.isFinite(megabytes) && megabytes >= 0 ? megabytes * 1024 * 1024 : 16 * 1024 * 1024
  }
  // Rough but allocation-free: the usage rows dominate a record's footprint, and
  // the cap only has to be in the right ballpark.
  function recordSizeOf(record) {
    const usage = Array.isArray(record.usage) ? record.usage.length : 0
    const turns = Array.isArray(record.turns) ? record.turns.length : 0
    return 1024 + usage * 1024 + turns * 256
  }
  function rememberLedgerKey(sid) {
    if (typeof sid === 'string' && sid !== '' && state.ledgerKeys instanceof Set) state.ledgerKeys.add(sid)
  }
  /**
   * Put a record into the resident set, evicting the oldest clean ones when the
   * cache is over budget. A dirty session (unwritten changes, a pending write or a
   * live resync) is never evicted: its in-memory copy is the pending write.
   */
  function cacheLedgerRecord(record) {
    if (record === null || record === undefined || typeof record.sessionId !== 'string') return
    const sid = record.sessionId
    if (state.ledgerRecords.has(sid)) {
      state.ledgerRecordBytes = Math.max(0, (state.ledgerRecordBytes || 0) - (state.ledgerRecordSizes.get(sid) || 0))
      state.ledgerRecords.delete(sid)
    }
    const size = recordSizeOf(record)
    state.ledgerRecords.set(sid, record)
    if (!(state.ledgerRecordSizes instanceof Map)) state.ledgerRecordSizes = new Map()
    state.ledgerRecordSizes.set(sid, size)
    state.ledgerRecordBytes = (state.ledgerRecordBytes || 0) + size
    // A store that cannot read one record back has to keep them all.
    if (state.ledgerRecordsComplete === true) return
    const limit = recordCacheLimit()
    while ((state.ledgerRecordBytes || 0) > limit && state.ledgerRecords.size > 1) {
      const oldest = state.ledgerRecords.keys().next()
      if (oldest.done) break
      const candidate = oldest.value
      if (candidate === sid) break
      const protectedDirty = state.ledgerDirtySessions instanceof Set && state.ledgerDirtySessions.has(candidate)
      const protectedPending = state.ledgerPending instanceof Map && state.ledgerPending.has(candidate)
      const protectedResync = state.liveResyncPending instanceof Set && state.liveResyncPending.has(candidate)
      const protectedPrefetch = state.ledgerPrefetching instanceof Set && state.ledgerPrefetching.has(candidate)
      if (protectedDirty || protectedPending || protectedResync || protectedPrefetch) {
        // Rotate the protected entry to the back and stop: the resident set is
        // dominated by sessions that are still being written.
        const keep = state.ledgerRecords.get(candidate)
        state.ledgerRecords.delete(candidate)
        state.ledgerRecords.set(candidate, keep)
        break
      }
      state.ledgerRecords.delete(candidate)
      state.ledgerRecordBytes = Math.max(0, (state.ledgerRecordBytes || 0) - (state.ledgerRecordSizes.get(candidate) || 0))
      state.ledgerRecordSizes.delete(candidate)
    }
  }
  /**
   * Read a window of session documents, a few files at a time. One file per read is
   * what keeps memory flat, but doing that strictly one-at-a-time serialises the
   * I/O behind the folding; a small parallel window restores the overlap while the
   * resident set stays bounded (a record is dropped again once it is folded).
   */
  async function loadRecords(sids, concurrency = 16) {
    if (state.ledgerUnit === null || typeof state.ledgerUnit.readRecord !== 'function') return
    if (!(state.ledgerKeys instanceof Set)) return
    const queue = []
    for (const sid of sids) {
      if (typeof sid !== 'string' || sid === '') continue
      if (state.ledgerRecords.has(sid) || !state.ledgerKeys.has(sid)) continue
      queue.push(sid)
    }
    if (!(state.ledgerPrefetching instanceof Set)) state.ledgerPrefetching = new Set()
    const width = Number.isFinite(concurrency) && concurrency > 0 ? Math.floor(concurrency) : 8
    for (let index = 0; index < queue.length; index += width) {
      const batch = queue.slice(index, index + width)
      await Promise.all(batch.map((sid) => {
        state.ledgerPrefetching.add(sid)
        return recordFor(sid).catch(() => undefined).finally(() => state.ledgerPrefetching.delete(sid))
      }))
    }
  }
  /**
   * Read back the detail rows of every session that has usage in a date range, so a
   * query over old history sees them without the rows having to stay resident. The
   * rows are adopted, not folded: the cubes already hold their contribution.
   */
  /** A row read back from a record that no longer belongs to a live workspace is
   * attributed to the shared retired bucket, exactly like the scan does. */
  function adoptableRow(row) {
    const published = typeof row.wsId === 'string' && row.wsId !== '' && state.wsMeta instanceof Map && state.wsMeta.has(row.wsId)
    return published || row.wsId === RETIRED_WORKSPACE_ID ? row : { ...row, wsId: RETIRED_WORKSPACE_ID, retiredAtRead: true }
  }
  /** Read back every detail row of one session (used before a retarget walks them). */
  async function loadRowsForSession(sid) {
    const record = await recordFor(sid)
    if (record === undefined || record === null || !Array.isArray(record.usage)) return 0
    let adopted = 0
    for (const item of record.usage) if (adoptUsageRow(adoptableRow(usageRowOf(record, item, 'ledger-reuse')))) adopted += 1
    return adopted
  }
  async function loadRowsForRange(utc, start, end) {
    if (typeof sessionsForRange !== 'function' || typeof adoptUsageRow !== 'function') return 0
    const sessions = sessionsForRange(utc === true, start, end)
    if (sessions.size === 0) return 0
    let adopted = 0
    // A day can own rows in dozens of sessions; reading their documents one at a
    // time made a first open of an old day take hundreds of milliseconds, so the
    // reads go in small parallel windows (the row is data, the order does not matter).
    const queue = Array.from(sessions)
    for (let index = 0; index < queue.length; index += 8) {
      const batch = queue.slice(index, index + 8)
      await Promise.all(batch.map(async (sid) => {
        const record = await recordFor(sid)
        if (record === undefined || record === null || !Array.isArray(record.usage)) return
        for (const item of record.usage) {
          const row = adoptableRow(usageRowOf(record, item, 'ledger-reuse'))
          const date = utc === true ? row.dateUtc : row.date
          if (typeof start === 'string' && start !== '' && date < start) continue
          if (typeof end === 'string' && end !== '' && date > end) continue
          if (adoptUsageRow(row)) adopted += 1
        }
      }))
    }
    return adopted
  }
  /** The record of one session: resident, else read from its own document. */
  async function recordFor(sid) {
    if (typeof sid !== 'string' || sid === '') return undefined
    const resident = state.ledgerRecords.get(sid)
    if (resident !== undefined) {
      // Reapply the budget after prefetch or pending-write pins have cleared.
      cacheLedgerRecord(resident)
      return resident
    }
    if (state.ledgerKeys instanceof Set && !state.ledgerKeys.has(sid)) return undefined
    if (state.ledgerUnit === null || typeof state.ledgerUnit.readRecord !== 'function') return undefined
    const raw = await state.ledgerUnit.readRecord(sid)
    if (raw === undefined) return undefined
    const record = normalizeLedgerRecord(raw, sid)
    if (record === null) {
      console.warn('[all-usage] ignoring malformed usage ledger row:', sid)
      return undefined
    }
    if (state.disposed) return record
    // A concurrent flush may have installed a newer in-memory record while the
    // disk read was awaiting I/O. Never let that stale read replace it or make
    // drainPendingLedgerWrites discard the pending newer write.
    const current = state.ledgerRecords.get(sid)
    // An authoritative history rewrite may reduce lastSeq, so rank is not a
    // concurrency token. Any record installed while this read awaited I/O wins.
    if (current !== undefined) return current
    cacheLedgerRecord(record)
    return record
  }
  async function loadLedger() {
    if (storage === undefined || storage.backend === undefined || typeof storage.backend.get !== 'function') return
    try {
      const backend = storage.backend.get('json')
      if (backend === undefined || backend === null || backend.kv === undefined) return
      const opened = await openLedgerUnitStore(backend)
      if (state.disposed) { await opened.store.close(); return }
      state.ledgerUnit = opened.store
      if (!(state.ledgerKeys instanceof Set)) state.ledgerKeys = new Set()
      if (!(state.ledgerRecordSizes instanceof Map)) state.ledgerRecordSizes = new Map()
      if (!Number.isFinite(state.ledgerRecordBytes)) state.ledgerRecordBytes = 0
      // The per-record tree is its own index: enumerate the keys and read a record
      // only when something asks for it, so a cold start no longer materialises
      // every session document at once (123 MB on a 66k-row ledger).
      if (opened.streaming !== true) {
        // A unit that cannot read a single record has already handed us the whole
        // table; keep the old behaviour there (tests, exotic backends).
        state.ledgerRecordsComplete = true
        for (const [key, raw] of Object.entries(opened.rows)) {
          if (key.startsWith('__')) continue
          const record = normalizeLedgerRecord(raw, key)
          if (record === null) console.warn('[all-usage] ignoring malformed usage ledger row:', key)
          else cacheLedgerRecord(record)
          state.ledgerKeys.add(key)
        }
      }
      if (typeof opened.store.listKeys === 'function') {
        for (const key of await opened.store.listKeys()) state.ledgerKeys.add(key)
      }
      if (state.ledgerUnit !== null && state.ledgerUnit !== undefined && typeof state.ledgerUnit.readRecord !== 'function') state.ledgerRecordsComplete = true
    } catch (err) {
      console.error('[all-usage] usage ledger unavailable:', err)
    }
  }

  return {
    nextLedgerRevision,
    ledgerEventKey,
    sessionEvents,
    retargetLedgerRecord,
    buildLedgerRecord,
    normalizeLedgerRecord,
    prepareLedgerRecord,
    applyLedgerRecord,
    ledgerRank,
    replaceLedgerRecord,
    storeLedgerRecord,
    persistLedgerRecord,
    drainLedgerWrites,
    // Exposed for the round-trip test: the on-disk shape is private otherwise.
    serializeLedgerRecordForTest: serializeLedgerRecord,
    expandLedgerRecordForTest: expandLedgerRecord,
    assertLedgerRecord,
    loadLedger,
    recordFor,
    loadRecords,
    loadRowsForRange,
    loadRowsForSession
  }
}

export { LEDGER_VERSION, PREVIOUS_LEDGER_VERSION, LEGACY_LEDGER_VERSION, LEDGER_SHARD_COUNT, RETIRED_WORKSPACE_ID, ledgerShardIndex, retargetLedgerRecord, serializeLedgerRecord }
