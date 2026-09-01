import { calculateCost, normalizeCostSnapshot } from './pricing.js'
import { extractUsageEvent, normalizeUsageValues as usageValues, upsertUsageSample as upsertUsageSampleState, usageStepKey } from './usage-core.js'

const LEDGER_VERSION = 3
const PREVIOUS_LEDGER_VERSION = 2
const LEGACY_LEDGER_VERSION = 1
const LEDGER_SHARD_COUNT = 32
const LEDGER_UNIT_NAME = 'all_usage_ledger'
const LEDGER_META_KEY = '__all_usage_ledger_meta__'
const LEDGER_WRITE_DEBOUNCE_MS = 25

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

function createLedgerUnitStore(legacyUnit, shardUnits) {
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
      shardUnits.push(await backend.kv.open({ name: ledgerShardName(index), version: 0, tables: ['sessions'], hasGlobal: false }))
    }
    const shardStore = createLedgerUnitStore(undefined, shardUnits)
    const shardRows = sessionRows(await shardStore.loadAll())
    if (await shardStore.hasMigrationMarker()) return { store: shardStore, rows: shardRows }

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
    return { store, rows }
  } catch (error) {
    await Promise.all(uniqueUnits([legacyUnit, ...shardUnits]).map((unit) => unit.close().catch(() => {})))
    throw error
  }
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
    return typeof event.seq === 'number' ? String(event.seq) : 'event:' + index
  }
  function canFoldLedgerTail(previousRecord, events, workspaceId) {
    if (previousRecord === null || previousRecord === undefined || !Number.isSafeInteger(previousRecord.lastSeq) || previousRecord.lastSeq < 0 || !Array.isArray(events) || events.length === 0) return false
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
  function buildLedgerRecord(session, workspaceId, source = 'scan', revision, previousRecord) {
    const sid = session && typeof session.id === 'string' ? session.id : ''
    const events = session && Array.isArray(session.events) ? session.events : []
    if (sid === '' || workspaceId === undefined) return null
    // DSH sequences every persisted event with seq === log index, so the last
    // event's seq is the record's lastSeq in O(1); fall back to a full scan only
    // when the tail carries no seq (legacy or truncated logs).
    const tailEvent = events.length > 0 ? events[events.length - 1] : null
    const lastSeq = tailEvent !== null && typeof tailEvent.seq === 'number' && tailEvent.seq >= 0 ? tailEvent.seq : lastSeqOf(events)
    const canFoldTail = canFoldLedgerTail(previousRecord, events, workspaceId)
    const turns = canFoldTail ? new Map((previousRecord.turns || []).map((item) => [item.key, { ...item }])) : new Map()
    const usage = canFoldTail ? new Map((previousRecord.usage || []).map((item) => [item.key, { ...item }])) : new Map()
    const previousUsage = new Map(Array.isArray(previousRecord && previousRecord.usage) ? previousRecord.usage.map((item) => [item.key, item]) : [])
    let currentIdentity = canFoldTail ? coerceIdentity(previousRecord.lastIdentity) : makeIdentity(null, null, null, null)
    const startIndex = canFoldTail ? previousRecord.lastSeq + 1 : 0
    for (let index = startIndex; index < events.length; index += 1) {
      const event = events[index]
      if (event === null || typeof event !== 'object') continue
      if (canFoldTail && event.seq <= previousRecord.lastSeq) continue
      const data = event.data
      if (event.type === 'request/context' || event.type === 'request/header') {
        currentIdentity = identityFromRoute(data, currentIdentity)
        continue
      }
      if (event.type === 'turn/end') {
        if (!validEventTime(event.time)) continue
        const key = ledgerEventKey(event, index)
        const turn = data && typeof data.turn === 'number' ? data.turn : null
        turns.set(key, { key, seq: typeof event.seq === 'number' ? event.seq : -1, time: event.time, workspaceId, turn, identity: currentIdentity })
        continue
      }
      if (!validEventTime(event.time)) continue
      const usageEvent = extractUsageEvent(event)
      if (usageEvent === null) continue
      const identity = usageEvent.kind === 'message' ? identityFromMessage(data, currentIdentity) : currentIdentity
      const key = usageStepKey(sid, data, event.seq)
      const result = upsertUsageSample(usage, {
        key,
        seq: typeof event.seq === 'number' && Number.isFinite(event.seq) ? event.seq : -1,
        time: event.time,
        workspaceId,
        identity,
        modelId: identity.label,
        turn: usageEvent.turn,
        step: usageEvent.step,
        values: usageEvent.values,
      }, { costPrevious: previousUsage.get(key) })
      if (result.accepted && usageEvent.kind === 'message') currentIdentity = identity
    }
    return { version: LEDGER_VERSION, sessionId: sid, workspaceId, lastSeq, source, updatedAt: nextLedgerRevision(), lastRevision: typeof revision === 'string' ? revision : undefined, sourceRevision: typeof revision === 'string' ? revision : undefined, lastIdentity: currentIdentity, turns: Array.from(turns.values()), usage: Array.from(usage.values()) }
  }
  function normalizeLedgerRecord(raw, key) {
    if (raw === null || typeof raw !== 'object' || (raw.version !== LEDGER_VERSION && raw.version !== PREVIOUS_LEDGER_VERSION && raw.version !== LEGACY_LEDGER_VERSION) || typeof raw.sessionId !== 'string' || raw.sessionId !== key) return null
    if (!Array.isArray(raw.turns) || !Array.isArray(raw.usage)) return null
    const invalidTurn = raw.turns.some((turn) => turn === null || typeof turn !== 'object' || typeof turn.key !== 'string' || turn.workspaceId === undefined || !validEventTime(turn.time))
    const invalidUsage = raw.usage.some((item) => { const cost = normalizeCostSnapshot(item && item.cost); return item === null || typeof item !== 'object' || !validEventTime(item.time) || item.identity === undefined || cost === null || cost.pricingMode !== 'official-model' || isLegacyTieredCost(cost) })
    // Older versions could write records whose top-level workspaceId belonged to
    // a recreated workspace while the historical items kept the previous one;
    // such mixed records must never be reused as a fast path.
    const mixedWorkspace = raw.turns.some((turn) => turn && turn.workspaceId !== raw.workspaceId) || raw.usage.some((item) => item && item.workspaceId !== raw.workspaceId)
    const needsUpgrade = !Number.isFinite(raw.updatedAt) || raw.version !== LEDGER_VERSION || invalidTurn || invalidUsage || mixedWorkspace
    const turnMap = new Map()
    for (const turn of raw.turns) {
      if (turn && typeof turn.key === 'string' && turn.workspaceId !== undefined && validEventTime(turn.time)) turnMap.set(turn.key, { key: turn.key, seq: typeof turn.seq === 'number' ? turn.seq : -1, time: turn.time, workspaceId: turn.workspaceId, turn: typeof turn.turn === 'number' ? turn.turn : null, identity: coerceIdentity(turn.identity || turn.modelId) })
    }
    const usageMap = new Map()
    for (const item of raw.usage) {
      if (!item || typeof item.key !== 'string' || item.workspaceId === undefined || !validEventTime(item.time) || item.values === null || typeof item.values !== 'object') continue
      const identity = coerceIdentity(item.identity || item.modelId)
      const normalizedCost = normalizeCostSnapshot(item.cost)
      const normalized = { key: item.key, seq: typeof item.seq === 'number' ? item.seq : -1, time: item.time, workspaceId: item.workspaceId, identity, modelId: identity.label, ...(normalizedCost === null ? {} : { cost: normalizedCost }), turn: typeof item.turn === 'number' ? item.turn : null, step: typeof item.step === 'number' ? item.step : null, values: usageValues({ inputTokens: item.values.input, outputTokens: item.values.output, cacheReadTokens: item.values.cacheRead, cacheWriteTokens: item.values.cacheWrite, reasoningTokens: item.values.reasoning }) }
      upsertUsageSampleState(usageMap, normalized)
    }
    const updatedAt = Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0
    state.ledgerRevision = Math.max(Number.isFinite(state.ledgerRevision) ? state.ledgerRevision : 0, updatedAt)
    const lastUsage = Array.from(usageMap.values()).at(-1)
    const lastIdentity = coerceIdentity(raw.lastIdentity || raw.sourceRevisionIdentity || (lastUsage && lastUsage.identity))
    const normalizedRecord = { version: LEDGER_VERSION, sessionId: raw.sessionId, workspaceId: raw.workspaceId, lastSeq: typeof raw.lastSeq === 'number' ? raw.lastSeq : -1, source: raw.source === 'flush' ? 'flush' : 'scan', updatedAt, lastRevision: typeof raw.lastRevision === 'string' ? raw.lastRevision : (typeof raw.sourceRevision === 'string' ? raw.sourceRevision : undefined), sourceRevision: typeof raw.sourceRevision === 'string' ? raw.sourceRevision : (typeof raw.lastRevision === 'string' ? raw.lastRevision : undefined), lastIdentity, turns: Array.from(turnMap.values()), usage: Array.from(usageMap.values()) }
    Object.defineProperty(normalizedRecord, 'needsUpgrade', { value: needsUpgrade, enumerable: false, writable: true })
    return normalizedRecord
  }
  function prepareLedgerRecord(record) {
    if (record === null || record === undefined) return record
    let changed = record.needsUpgrade === true || record.version !== LEDGER_VERSION
    for (const item of record.usage) {
      const cost = normalizeCostSnapshot(item.cost)
      if (isLegacyTieredCost(cost)) {
        item.cost = calculateCost(item.values, { ...cost, status: 'unsupported', reason: 'tiered-pricing-not-modeled' })
        changed = true
        continue
      }
      if (cost !== null && cost.pricingMode === 'official-model') { item.cost = cost; continue }
      const identity = item.identity || identityFromLegacy(item.modelId)
      item.cost = calculateCost(item.values, resolveCurrentPricing(identity))
      changed = true
    }
    if (changed) {
      record.version = LEDGER_VERSION
      record.updatedAt = nextLedgerRevision()
      record.needsUpgrade = false
      state.ledgerRecords.set(record.sessionId, record)
      void persistLedgerRecord(record)
    }
    return record
  }
  function applyLedgerRecord(record, materialization = 'ledger-reuse') {
    if (record === null || record === undefined) return
    prepareLedgerRecord(record)
    if (record.lastIdentity !== undefined) state.sessionModel.set(record.sessionId, record.lastIdentity)
    for (const turn of record.turns) addTurn(turn.workspaceId, turn.time, record.sessionId, turn.turn, turn.identity, materialization, turn.seq)
    for (const item of record.usage) {
      const identity = item.identity || identityFromLegacy(item.modelId)
      const dates = dateKeys(item.time)
      upsertUsageSample(state.usageByStep, {
        key: item.key,
        seq: item.seq,
        wsId: item.workspaceId,
        time: item.time,
        date: dates.local,
        dateUtc: dates.utc,
        values: item.values,
        identity,
        modelId: identity.label,
        cost: item.cost,
        turn: item.turn,
        step: item.step,
        materialization,
        sid: record.sessionId,
      })
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
    state.ledgerRecords.set(record.sessionId, record)
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
    state.ledgerRecords.set(record.sessionId, record)
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
      if (state.ledgerUnit === null || state.ledgerRecords.get(sid) !== record) {
        if (!state.ledgerPending.has(sid)) resolveLedgerWaiters(sid)
        continue
      }
      try {
        await state.ledgerUnit.putRecord('sessions', sid, record)
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
    if (state.ledgerRecords.get(record.sessionId) !== record) return Promise.resolve()
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
  async function loadLedger() {
    if (storage === undefined || storage.backend === undefined || typeof storage.backend.get !== 'function') return
    try {
      const backend = storage.backend.get('json')
      if (backend === undefined || backend === null || backend.kv === undefined) return
      const opened = await openLedgerUnitStore(backend)
      if (state.disposed) { await opened.store.close(); return }
      state.ledgerUnit = opened.store
      for (const [key, raw] of Object.entries(opened.rows)) {
        const record = normalizeLedgerRecord(raw, key)
        if (record === null) console.warn('[all-usage] ignoring malformed usage ledger row:', key)
        else state.ledgerRecords.set(key, record)
      }
    } catch (err) {
      console.error('[all-usage] usage ledger unavailable:', err)
    }
  }

  return {
    nextLedgerRevision,
    ledgerEventKey,
    buildLedgerRecord,
    normalizeLedgerRecord,
    prepareLedgerRecord,
    applyLedgerRecord,
    ledgerRank,
    replaceLedgerRecord,
    storeLedgerRecord,
    persistLedgerRecord,
    drainLedgerWrites,
    assertLedgerRecord,
    loadLedger
  }
}

export { LEDGER_VERSION, PREVIOUS_LEDGER_VERSION, LEGACY_LEDGER_VERSION, LEDGER_SHARD_COUNT, ledgerShardIndex }
