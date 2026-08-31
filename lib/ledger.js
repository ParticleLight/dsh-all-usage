import { calculateCost, normalizeCostSnapshot } from './pricing.js'
import { extractUsageEvent, normalizeUsageValues as usageValues, upsertUsageSample as upsertUsageSampleState, usageStepKey } from './usage-core.js'

const LEDGER_VERSION = 3
const PREVIOUS_LEDGER_VERSION = 2
const LEGACY_LEDGER_VERSION = 1

export function createLedger(host) {
  const { state, markStatsChanged } = host
  const { storage } = host.services
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
    return cost !== null && cost.tiered === true && cost.status === 'priced'
  }

  function nextLedgerRevision() {
    const current = Number.isFinite(state.ledgerRevision) ? state.ledgerRevision : 0
    state.ledgerRevision = Math.max(current + 1, Date.now())
    return state.ledgerRevision
  }
  function ledgerEventKey(event, index) {
    return typeof event.seq === 'number' ? String(event.seq) : 'event:' + index
  }
  function buildLedgerRecord(session, workspaceId, source = 'scan', revision, previousRecord) {
    const sid = session && typeof session.id === 'string' ? session.id : ''
    const events = session && Array.isArray(session.events) ? session.events : []
    if (sid === '' || workspaceId === undefined) return null
    const turns = new Map()
    const usage = new Map()
    const previousUsage = new Map(Array.isArray(previousRecord && previousRecord.usage) ? previousRecord.usage.map((item) => [item.key, item]) : [])
    let currentIdentity = makeIdentity(null, null, null, null)
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index]
      if (event === null || typeof event !== 'object') continue
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
    return { version: LEDGER_VERSION, sessionId: sid, workspaceId, lastSeq: lastSeqOf(events), source, updatedAt: nextLedgerRevision(), lastRevision: typeof revision === 'string' ? revision : undefined, sourceRevision: typeof revision === 'string' ? revision : undefined, lastIdentity: currentIdentity, turns: Array.from(turns.values()), usage: Array.from(usage.values()) }
  }
  function normalizeLedgerRecord(raw, key) {
    if (raw === null || typeof raw !== 'object' || (raw.version !== LEDGER_VERSION && raw.version !== PREVIOUS_LEDGER_VERSION && raw.version !== LEGACY_LEDGER_VERSION) || typeof raw.sessionId !== 'string' || raw.sessionId !== key) return null
    if (!Array.isArray(raw.turns) || !Array.isArray(raw.usage)) return null
    const invalidTurn = raw.turns.some((turn) => turn === null || typeof turn !== 'object' || typeof turn.key !== 'string' || turn.workspaceId === undefined || !validEventTime(turn.time))
    const invalidUsage = raw.usage.some((item) => { const cost = normalizeCostSnapshot(item && item.cost); return item === null || typeof item !== 'object' || !validEventTime(item.time) || item.identity === undefined || cost === null || cost.pricingMode !== 'official-model' || isLegacyTieredCost(cost) })
    const needsUpgrade = !Number.isFinite(raw.updatedAt) || raw.version !== LEDGER_VERSION || invalidTurn || invalidUsage
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
      if (record.usage.length > 0) markStatsChanged()
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
  function persistLedgerRecord(record) {
    if (record !== null && record !== undefined) assertLedgerRecord(record)
    if (state.disposed || state.ledgerUnit === null || record === null || record === undefined) return state.ledgerWriteChain
    const write = state.ledgerWriteChain.then(async () => {
      if (state.ledgerUnit !== null && state.ledgerRecords.get(record.sessionId) === record) await state.ledgerUnit.putRecord('sessions', record.sessionId, record)
    })
    state.ledgerWriteChain = write.catch((err) => {
      console.error('[all-usage] usage ledger write failed:', err)
    })
    return state.ledgerWriteChain
  }
  async function loadLedger() {
    if (storage === undefined || storage.backend === undefined || typeof storage.backend.get !== 'function') return
    try {
      const backend = storage.backend.get('json')
      if (backend === undefined || backend === null || backend.kv === undefined) return
      const unit = await backend.kv.open({ name: 'all_usage_ledger', version: 0, tables: ['sessions'], hasGlobal: false })
      if (state.disposed) { await unit.close().catch(() => {}); return }
      state.ledgerUnit = unit
      const snapshot = await unit.loadAll()
      const rows = snapshot && snapshot.tables && snapshot.tables.sessions
      if (rows !== null && rows !== undefined && typeof rows === 'object') {
        for (const [key, raw] of Object.entries(rows)) {
          const record = normalizeLedgerRecord(raw, key)
          if (record === null) console.warn('[all-usage] ignoring malformed usage ledger row:', key)
          else state.ledgerRecords.set(key, record)
        }
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
    assertLedgerRecord,
    loadLedger
  }
}

export { LEDGER_VERSION, PREVIOUS_LEDGER_VERSION, LEGACY_LEDGER_VERSION }
