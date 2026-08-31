import { createHash } from 'node:crypto'
import { COST_SCHEMA_VERSION, addCostAccumulator, addCostAggregate, calculateCost, createCostAccumulator, decimalSubtract, isCostAccumulator, normalizeCostSnapshot, resolvePricing, serializeCostAggregate } from './pricing.js'
import { extractUsageEvent, normalizeUsageValues as usageValues, upsertUsageSample as upsertUsageSampleState, usageStepKey, validEventTime as validUsageEventTime } from './usage-core.js'

export function createAggregation(host) {
  const { state, markStatsChanged, commitPendingStats, resetSyncState } = host
  const pricingSnapshot = (...args) => host.pricingSnapshot(...args)
  const syncSnapshot = (...args) => host.syncSnapshot(...args)

  function dayKey(ms) {
    const d = new Date(ms)
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
  }
  function dayKeyUtc(ms) {
    const d = new Date(ms)
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0')
  }
  function dateKeys(ms) {
    const d = new Date(ms)
    const local = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
    const utc = d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0')
    return { local, utc }
  }
  function num(v) {
    return typeof v === 'number' && Number.isFinite(v) ? v : 0
  }
  const validEventTime = validUsageEventTime
  function addDateIndex(index, date, key) {
    if (typeof date !== 'string' || date === '') return
    let keys = index.get(date)
    if (keys === undefined) { keys = new Set(); index.set(date, keys) }
    keys.add(key)
  }
  function removeDateIndex(index, date, key) {
    if (typeof date !== 'string' || date === '') return
    const keys = index.get(date)
    if (keys === undefined) return
    keys.delete(key)
    if (keys.size === 0) index.delete(date)
  }
  function indexUsage(item) {
    addDateIndex(state.usageByLocalDate, item.date, item.key)
    addDateIndex(state.usageByUtcDate, item.dateUtc, item.key)
  }
  function unindexUsage(item) {
    removeDateIndex(state.usageByLocalDate, item.date, item.key)
    removeDateIndex(state.usageByUtcDate, item.dateUtc, item.key)
  }
  function indexedEntriesInRange(index, source, start, end) {
    const result = []
    for (const [date, keys] of index) {
      if (date < start || date > end) continue
      for (const key of keys) {
        const item = source.get(key)
        if (item !== undefined) result.push({ item, date })
      }
    }
    return result
  }
  function usageBasisEqual(first, identity, values) {
    if (first === null || first === undefined) return false
    const firstIdentity = first.identity || first.modelId
    const left = coerceIdentity(firstIdentity)
    const right = coerceIdentity(identity)
    if (left.identityKey !== right.identityKey) return false
    return ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'].every((key) => num(first.values && first.values[key]) === num(values && values[key]))
  }
  function resolveCurrentPricing(identity) {
    const normalized = coerceIdentity(identity)
    const key = normalized.identityKey
    const cached = state.pricingResolutionCache.get(key)
    if (cached !== undefined) return cached
    const resolved = resolvePricing(normalized, state.pricingState)
    state.pricingResolutionCache.set(key, resolved)
    while (state.pricingResolutionCache.size > 5000) state.pricingResolutionCache.delete(state.pricingResolutionCache.keys().next().value)
    return resolved
  }
  function costForUsage(values, identity, previous) {
    const previousCost = normalizeCostSnapshot(previous && previous.cost)
    if (previousCost !== null && previousCost.pricingMode === 'official-model' && usageBasisEqual(previous, identity, values)) return previousCost
    return calculateCost(values, resolveCurrentPricing(identity))
  }
  function resetAggregationState() {
    state.aggregationGeneration += 1
    state.wsMeta.clear()
    state.pathIndex.clear()
    state.memberOf.clear()
    state.byDay.clear()
    state.byDayUtc.clear()
    state.perWorkspace.clear()
    state.perModel.clear()
    state.usageByStep.clear()
    state.turnRecords.clear()
    state.usageByLocalDate.clear()
    state.usageByUtcDate.clear()
    for (const timer of state.liveResyncTimers.values()) clearTimeout(timer)
    state.liveResyncTimers.clear()
    state.liveResyncAttempts.clear()
    state.liveResyncPending.clear()
    state.reconcileHintScheduled = false
    if (state.baselineFallbackTimer !== null) {
      clearTimeout(state.baselineFallbackTimer)
      state.baselineFallbackTimer = null
    }
    state.baselineRetryScheduled = false
    state.queryCache.clear()
    state.recordsQueryCache.clear()
    state.sessionModel.clear()
    state.sessionCount.clear()
    state.sessionSeq.clear()
    state.chains.clear()
    state.knownSessionIds.clear()
    state.totals.turns = 0
    state.totals.input = 0
    state.totals.output = 0
    state.totals.cacheRead = 0
    state.totals.cacheWrite = 0
    state.totals.reasoning = 0
    Object.assign(state.totals.cost, createCostAccumulator())
    state.scan.started = false
    state.scan.done = false
    state.scan.scanned = 0
    state.scan.total = 0
    state.scan.failed = 0
    resetSyncState()
    state.baselineRetryDelay = 1000
    markStatsChanged(['data', 'metadata', 'scan'])
    return state.aggregationGeneration
  }
  function ensureDay(dayMap, date) {
    let day = dayMap.get(date)
    if (day === undefined) {
      day = { turns: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, cost: createCostAccumulator(), perWs: new Map(), byWs: new Map(), byModel: new Map(), sessionIds: new Set(), sessionRefs: new Map(), queryUsage: new Map(), queryTurns: new Map(), queryHours: new Map() }
      dayMap.set(date, day)
      markStatsChanged('metadata')
    }
    return day
  }
  function ensureWs(wsId) {
    let ws = state.perWorkspace.get(wsId)
    if (ws === undefined) {
      ws = { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: createCostAccumulator() }
      state.perWorkspace.set(wsId, ws)
      markStatsChanged('metadata')
    }
    return ws
  }
  function ensureDayWs(day, wsId) {
    let w = day.byWs.get(wsId)
    if (w === undefined) {
      w = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: createCostAccumulator() }
      day.byWs.set(wsId, w)
    }
    return w
  }
  function ensureModel(value) {
    const identity = coerceIdentity(value)
    let item = state.perModel.get(identity.identityKey)
    if (item === undefined) {
      item = { ...identity, model: identity.label, calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: createCostAccumulator() }
      state.perModel.set(identity.identityKey, item)
      markStatsChanged('metadata')
    }
    return item
  }
  function ensureDayModel(day, value) {
    const identity = coerceIdentity(value)
    let item = day.byModel.get(identity.identityKey)
    if (item === undefined) {
      item = { ...identity, model: identity.label, calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: createCostAccumulator() }
      day.byModel.set(identity.identityKey, item)
    }
    return item
  }
  function adjustValues(target, values, direction) {
    target.input += values.input * direction
    target.output += values.output * direction
    target.cacheRead += values.cacheRead * direction
    target.cacheWrite += values.cacheWrite * direction
    target.reasoning += values.reasoning * direction
  }
  function addQueryMetricTokens(target, values, direction = 1) {
    target.input += values.input * direction
    target.output += values.output * direction
    target.cacheRead += values.cacheRead * direction
    target.cacheWrite += values.cacheWrite * direction
    target.reasoning += values.reasoning * direction
  }
  function noValues(target) {
    return target.input === 0 && target.output === 0 && target.cacheRead === 0 && target.cacheWrite === 0 && target.reasoning === 0
  }
  function adjustDaySession(day, sid, direction) {
    if (sid === undefined || sid === null) return
    const current = day.sessionRefs.get(sid) || 0
    const next = current + direction
    if (next > 0) {
      day.sessionRefs.set(sid, next)
      day.sessionIds.add(sid)
    } else {
      day.sessionRefs.delete(sid)
      day.sessionIds.delete(sid)
    }
  }
  function adjustDay(dayMap, date, wsId, values, identity, direction, sid, cost) {
    const day = ensureDay(dayMap, date)
    adjustDaySession(day, sid, direction)
    adjustValues(day.tokens, values, direction)
    addCostAggregateDirection(day.cost, cost, direction)
    const dayWs = ensureDayWs(day, wsId)
    adjustValues(dayWs, values, direction)
    addCostAggregateDirection(dayWs.cost, cost, direction)
    if (noValues(dayWs)) day.byWs.delete(wsId)
    const dayModel = ensureDayModel(day, identity)
    dayModel.calls += direction
    adjustValues(dayModel, values, direction)
    addCostAggregateDirection(dayModel.cost, cost, direction)
    if (dayModel.calls === 0 && noValues(dayModel)) day.byModel.delete(dayModel.identityKey)
  }
  function addCostAggregateDirection(target, cost, direction) {
    if (direction === 1) {
      if (isCostAccumulator(target)) addCostAccumulator(target, cost, 1)
      else addCostAggregate(target, cost)
      return
    }
    if (direction !== -1) return
    if (isCostAccumulator(target)) {
      addCostAccumulator(target, cost, -1)
      return
    }
    const status = cost && typeof cost.status === 'string' ? cost.status : 'unpriced'
    if (status === 'priced') {
      target.input = decimalSubtract(target.input, cost.breakdown && cost.breakdown.input)
      target.output = decimalSubtract(target.output, cost.breakdown && cost.breakdown.output)
      target.cacheRead = decimalSubtract(target.cacheRead, cost.breakdown && cost.breakdown.cacheRead)
      target.cacheWrite = decimalSubtract(target.cacheWrite, cost.breakdown && cost.breakdown.cacheWrite)
      target.baseTotal = decimalSubtract(target.baseTotal, cost.baseTotal)
      target.total = decimalSubtract(target.total, cost.total)
      target.pricedCalls -= 1
    } else if (status === 'ambiguous') target.ambiguousCalls -= 1
    else if (status === 'unsupported') target.unsupportedCalls -= 1
    else target.unpricedCalls -= 1
  }
  function adjustQueryRefs(bucket, field, sid, direction) {
    if (sid === undefined || sid === null) return
    const refs = field === 'sessions' ? bucket.sessionRefs : bucket[field + 'Refs']
    const values = bucket[field]
    const current = refs.get(sid) || 0
    const next = current + direction
    if (next > 0) { refs.set(sid, next); values.add(sid) }
    else { refs.delete(sid); values.delete(sid) }
  }
  function queryUsageMetric(identity) {
    return { identity: coerceIdentity(identity), calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: createCostAccumulator(), sessions: new Set(), sessionRefs: new Map(), turnKeys: new Set(), turnKeyRefs: new Map() }
  }
  function queryTurnMetric(identity) {
    return { identity: coerceIdentity(identity), turns: 0, sessions: new Set(), sessionRefs: new Map(), records: new Map() }
  }
  function queryWorkspaceMap(root, wsId, create) {
    let value = root.get(wsId)
    if (value === undefined && create) { value = new Map(); root.set(wsId, value) }
    return value
  }
  function adjustQueryUsageMap(root, item, direction) {
    const identity = coerceIdentity(item.identity || item.modelId)
    const workspace = queryWorkspaceMap(root, item.wsId, direction === 1)
    if (workspace === undefined) return
    let bucket = workspace.get(identity.identityKey)
    if (bucket === undefined && direction === 1) { bucket = queryUsageMetric(identity); workspace.set(identity.identityKey, bucket) }
    if (bucket === undefined) return
    bucket.calls += direction
    adjustQueryRefs(bucket, 'sessions', item.sid, direction)
    addQueryMetricTokens(bucket, item.values, direction)
    addCostAccumulator(bucket.cost, item.cost, direction)
    if (item.turn !== null && item.turn !== undefined) {
      const turnKey = String(item.sid) + ':turn:' + String(item.turn)
      const current = bucket.turnKeyRefs.get(turnKey) || 0
      const next = current + direction
      if (next > 0) { bucket.turnKeyRefs.set(turnKey, next); bucket.turnKeys.add(turnKey) }
      else { bucket.turnKeyRefs.delete(turnKey); bucket.turnKeys.delete(turnKey) }
    }
    if (direction === -1 && bucket.calls <= 0) workspace.delete(identity.identityKey)
    if (workspace.size === 0) root.delete(item.wsId)
  }
  function ensureQueryHour(day, hour) {
    let value = day.queryHours.get(hour)
    if (value === undefined) { value = { usage: new Map(), turns: new Map() }; day.queryHours.set(hour, value) }
    return value
  }
  function adjustQueryUsage(day, item, direction, utc) {
    if (day === undefined) return
    adjustQueryUsageMap(day.queryUsage, item, direction)
    const hour = hourStartOf(item.time, utc)
    adjustQueryUsageMap(ensureQueryHour(day, hour).usage, item, direction)
    const hourValue = day.queryHours.get(hour)
    if (hourValue !== undefined && hourValue.usage.size === 0 && hourValue.turns.size === 0) day.queryHours.delete(hour)
  }
  function adjustQueryTurnMap(root, turn, direction) {
    const identity = coerceIdentity(turn.identity)
    const workspace = queryWorkspaceMap(root, turn.wsId, direction === 1)
    if (workspace === undefined) return
    let bucket = workspace.get(identity.identityKey)
    if (bucket === undefined && direction === 1) { bucket = queryTurnMetric(identity); workspace.set(identity.identityKey, bucket) }
    if (bucket === undefined) return
    if (direction === 1) {
      if (bucket.records.has(turn.key)) return
      bucket.records.set(turn.key, turn)
      bucket.turns += 1
      adjustQueryRefs(bucket, 'sessions', turn.sid, 1)
    } else {
      const previous = bucket.records.get(turn.key)
      if (previous === undefined) return
      bucket.records.delete(turn.key)
      bucket.turns -= 1
      adjustQueryRefs(bucket, 'sessions', previous.sid, -1)
    }
    if (direction === -1 && bucket.turns <= 0) workspace.delete(identity.identityKey)
    if (workspace.size === 0) root.delete(turn.wsId)
  }
  function adjustQueryTurn(day, turn, direction, utc) {
    if (day === undefined) return
    adjustQueryTurnMap(day.queryTurns, turn, direction)
    const hour = hourStartOf(turn.time, utc)
    const hourValue = ensureQueryHour(day, hour)
    adjustQueryTurnMap(hourValue.turns, turn, direction)
    if (hourValue.usage.size === 0 && hourValue.turns.size === 0) day.queryHours.delete(hour)
  }
  function adjustUsage(wsId, time, values, identity, direction, sid, cachedDates, cost) {
    const normalized = coerceIdentity(identity)
    const dates = cachedDates && typeof cachedDates.local === 'string' && typeof cachedDates.utc === 'string' ? cachedDates : dateKeys(time)
    const modelTotals = ensureModel(normalized)
    modelTotals.calls += direction
    adjustValues(modelTotals, values, direction)
    addCostAggregateDirection(modelTotals.cost, cost, direction)
    if (modelTotals.calls === 0 && noValues(modelTotals)) {
      state.perModel.delete(normalized.identityKey)
      markStatsChanged('metadata')
    }
    adjustValues(state.totals, values, direction)
    addCostAggregateDirection(state.totals.cost, cost, direction)
    const ws = ensureWs(wsId)
    adjustValues(ws, values, direction)
    addCostAggregateDirection(ws.cost, cost, direction)
    adjustDay(state.byDay, dates.local, wsId, values, normalized, direction, sid, cost)
    adjustDay(state.byDayUtc, dates.utc, wsId, values, normalized, direction, sid, cost)
  }
  function upsertUsageSample(target, sample, options = {}) {
    const previous = target.get(sample.key)
    const candidate = sample.cost === undefined
      ? { ...sample, cost: costForUsage(sample.values, sample.identity, options.costPrevious === undefined ? previous : options.costPrevious) }
      : sample
    const result = upsertUsageSampleState(target, candidate)
    if (!result.accepted || target !== state.usageByStep || options.materialize === false) return result
    const previousItem = result.previous
    if (previousItem !== undefined) {
      unindexUsage(previousItem)
      adjustUsage(previousItem.wsId, previousItem.time, previousItem.values, previousItem.identity || previousItem.modelId, -1, previousItem.sid, { local: previousItem.date, utc: previousItem.dateUtc }, previousItem.cost)
      adjustQueryUsage(state.byDay.get(previousItem.date), previousItem, -1, false)
      adjustQueryUsage(state.byDayUtc.get(previousItem.dateUtc), previousItem, -1, true)
    }
    const next = result.next
    indexUsage(next)
    adjustUsage(next.wsId, next.time, next.values, next.identity, 1, next.sid, { local: next.date, utc: next.dateUtc }, next.cost)
    adjustQueryUsage(state.byDay.get(next.date), next, 1, false)
    adjustQueryUsage(state.byDayUtc.get(next.dateUtc), next, 1, true)
    markStatsChanged('data')
    return result
  }
  function adjustQueryCost(item, cost, direction) {
    if (item === null || item === undefined || typeof item !== 'object') return
    const identity = coerceIdentity(item.identity || item.modelId)
    const dates = typeof item.date === 'string' && typeof item.dateUtc === 'string' ? { local: item.date, utc: item.dateUtc } : dateKeys(item.time)
    const update = (day, utc) => {
      if (day === undefined) return
      const models = day.queryUsage.get(item.wsId)
      const bucket = models && models.get(identity.identityKey)
      if (bucket !== undefined) addCostAccumulator(bucket.cost, cost, direction)
      const hour = hourStartOf(item.time, utc)
      const hourValue = day.queryHours.get(hour)
      const hourModels = hourValue && hourValue.usage.get(item.wsId)
      const hourBucket = hourModels && hourModels.get(identity.identityKey)
      if (hourBucket !== undefined) addCostAccumulator(hourBucket.cost, cost, direction)
    }
    update(state.byDay.get(dates.local), false)
    update(state.byDayUtc.get(dates.utc), true)
  }
  function addUsage(wsId, time, usage, model, sid, data, seq, materialization = 'live') {
    if (!validEventTime(time)) return
    const values = usageValues(usage)
    if (values === null || noValues(values)) return
    const identity = coerceIdentity(model)
    const eventSeq = typeof seq === 'number' && Number.isFinite(seq) ? seq : -1
    const dates = dateKeys(time)
    const key = usageStepKey(sid, data, seq)
    upsertUsageSample(state.usageByStep, {
      key,
      seq: eventSeq,
      wsId,
      time,
      date: dates.local,
      dateUtc: dates.utc,
      values,
      identity,
      modelId: identity.label,
      turn: data && Number.isSafeInteger(data.turn) && data.turn >= 0 ? data.turn : null,
      step: data && Number.isSafeInteger(data.step) && data.step >= 0 ? data.step : null,
      materialization,
      sid,
    })
  }
  function addDayTurn(dayMap, date, wsId, sid) {
    const day = ensureDay(dayMap, date)
    adjustDaySession(day, sid, 1)
    day.turns += 1
    day.perWs.set(wsId, (day.perWs.get(wsId) || 0) + 1)
  }
  function turnRecordKey(sid, turn, seq, time) {
    if (typeof turn === 'number' && Number.isFinite(turn)) return sid + ':turn:' + turn
    if (typeof seq === 'number' && Number.isFinite(seq)) return sid + ':event:' + seq
    return sid + ':time:' + String(time)
  }
  function addTurn(wsId, time, sid, turn, identity, materialization = 'live', seq) {
    if (!validEventTime(time)) return
    const key = turnRecordKey(sid, turn, seq, time)
    if (state.turnRecords.has(key)) return
    const normalized = coerceIdentity(identity)
    const dates = dateKeys(time)
    const record = { key, sid, wsId, time, date: dates.local, dateUtc: dates.utc, turn: typeof turn === 'number' ? turn : null, identity: normalized, materialization }
    state.turnRecords.set(key, record)
    ensureWs(wsId).turns += 1
    state.totals.turns += 1
    addDayTurn(state.byDay, dates.local, wsId, sid)
    addDayTurn(state.byDayUtc, dates.utc, wsId, sid)
    adjustQueryTurn(state.byDay.get(record.date), record, 1, false)
    adjustQueryTurn(state.byDayUtc.get(record.dateUtc), record, 1, true)
    markStatsChanged('data')
  }
  const UNKNOWN_MODEL_LABEL = '未知模型（历史记录缺少路由）'
  function textOrNull(value) {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
  }
  function identityLabel(provider, requestedModel, actualModel, legacyLabel) {
    const model = actualModel || requestedModel
    if (model !== null) return provider === null ? model : provider + ' / ' + model
    return legacyLabel || UNKNOWN_MODEL_LABEL
  }
  function makeIdentity(provider, requestedModel, actualModel, legacyLabel) {
    const normalizedProvider = textOrNull(provider)
    const normalizedRequested = textOrNull(requestedModel)
    const normalizedActual = textOrNull(actualModel)
    const normalizedLegacy = textOrNull(legacyLabel)
    const key = JSON.stringify([normalizedProvider, normalizedRequested, normalizedActual, normalizedLegacy])
    return {
      identityKey: key,
      provider: normalizedProvider,
      requestedModel: normalizedRequested,
      actualModel: normalizedActual,
      label: identityLabel(normalizedProvider, normalizedRequested, normalizedActual, normalizedLegacy),
      legacy: normalizedLegacy !== null && normalizedProvider === null && normalizedRequested === null && normalizedActual === null,
    }
  }
  function identityFromLegacy(label) {
    return makeIdentity(null, null, null, textOrNull(label) || UNKNOWN_MODEL_LABEL)
  }
  function isCanonicalIdentity(value) {
    return value !== null && typeof value === 'object' && typeof value.identityKey === 'string' && typeof value.label === 'string' && (value.provider === null || typeof value.provider === 'string') && (value.requestedModel === null || typeof value.requestedModel === 'string') && (value.actualModel === null || typeof value.actualModel === 'string') && typeof value.legacy === 'boolean'
  }
  function coerceIdentity(value) {
    if (isCanonicalIdentity(value)) return value
    if (value !== null && typeof value === 'object') {
      return makeIdentity(value.provider, value.requestedModel, value.actualModel, value.legacyLabel || (value.legacy === true ? value.label : null))
    }
    if (typeof value === 'string' && value !== '') return identityFromLegacy(value)
    return makeIdentity(null, null, null, UNKNOWN_MODEL_LABEL)
  }
  function routeObject(data) {
    if (data && typeof data === 'object' && (data.provider !== undefined || data.model !== undefined)) return data
    const config = data && data.header && data.header.config
    return config && typeof config === 'object' ? config : null
  }
  function identityFromRoute(data, fallback) {
    const base = fallback === undefined ? makeIdentity(null, null, null, null) : coerceIdentity(fallback)
    const route = routeObject(data)
    if (route === null) return base
    return makeIdentity(route.provider === undefined ? base.provider : route.provider, route.model === undefined ? base.requestedModel : route.model, null, base.legacy ? base.label : null)
  }
  function identityFromMessage(data, fallback) {
    const base = fallback === undefined ? makeIdentity(null, null, null, null) : coerceIdentity(fallback)
    const source = data && data.message && data.message.source
    if (source === null || typeof source !== 'object') return base
    return makeIdentity(source.provider === undefined ? base.provider : source.provider, base.requestedModel || source.model, source.model, base.legacy ? base.label : null)
  }
  function modelFromRoute(data) {
    const identity = identityFromRoute(data)
    return identity.label === UNKNOWN_MODEL_LABEL ? undefined : identity.label
  }
  function modelFromMessage(data, fallback) {
    return identityFromMessage(data, fallback).label
  }

  // ---------- snapshot for the client ----------
  function scanSnapshot() {
    return { started: state.scan.started, done: state.scan.done, scanned: state.scan.scanned, total: state.scan.total, failed: state.scan.failed }
  }
  function queryRevision() {
    return String(state.dataRevision) + ':' + String(state.pricingRevision)
  }
  function revisionSnapshot() {
    return { revision: state.statsRevision, dataRevision: state.dataRevision, metadataRevision: state.metadataRevision, scanRevision: state.scanRevision, pricingRevision: state.pricingRevision, queryRevision: queryRevision() }
  }
  function statusSnapshot() {
    commitPendingStats()
    return { instanceId: state.instanceId, ...revisionSnapshot(), updatedAt: state.statsUpdatedAt, scan: scanSnapshot(), sync: syncSnapshot() }
  }
  function serializeIdentity(identity) {
    const value = coerceIdentity(identity)
    return { identityKey: value.identityKey, provider: value.provider, requestedModel: value.requestedModel, actualModel: value.actualModel, model: value.label, legacy: value.legacy }
  }
  function serializeModelAggregate(item) {
    return { ...serializeIdentity(item), calls: item.calls, input: item.input, output: item.output, cacheRead: item.cacheRead, cacheWrite: item.cacheWrite, reasoning: item.reasoning, cost: serializeCostAggregate(item.cost) }
  }
  function serializeDays(dayMap) {
    const result = []
    for (const pair of dayMap) {
      const date = pair[0]
      const day = pair[1]
      result.push({
        date,
        turns: day.turns,
        sessions: day.sessionIds.size,
        sessionIds: Array.from(day.sessionIds).sort(),
        tokens: { input: day.tokens.input, output: day.tokens.output, cacheRead: day.tokens.cacheRead, cacheWrite: day.tokens.cacheWrite, reasoning: day.tokens.reasoning },
        cost: serializeCostAggregate(day.cost),
        perWorkspace: Array.from(day.perWs, (p) => ({ workspaceId: p[0], turns: p[1] })),
        byWorkspace: Array.from(day.byWs, (p) => ({ workspaceId: p[0], input: p[1].input, output: p[1].output, cacheRead: p[1].cacheRead, cacheWrite: p[1].cacheWrite, reasoning: p[1].reasoning, cost: serializeCostAggregate(day.byWs.get(p[0]).cost) })),
        byModel: Array.from(day.byModel, (p) => serializeModelAggregate(p[1])),
      })
    }
    result.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    return result
  }
  function snapshot() {
    commitPendingStats()
    const generatedAt = Date.now()
    if (state.snapshotCache !== null && state.snapshotCache.revision === state.statsRevision) return Object.assign({}, state.snapshotCache.value, { generatedAt })
    const value = {
      ...statusSnapshot(),
      generatedAt,
      usageSchemaVersion: 3,
      costSchemaVersion: COST_SCHEMA_VERSION,
      requestToken: state.requestToken,
      workspaces: Array.from(state.wsMeta.values(), (w) => ({ id: w.id, title: w.title, path: w.path })),
      aliases: Object.assign({}, state.aliases),
      pricing: pricingSnapshot(),
      tokenSemantics: {
        processedTotal: 'input + output + cacheRead + cacheWrite + reasoning',
        cacheRead: 'reused context tokens; not newly generated output',
        cacheWrite: 'tokens written into a provider cache',
        // v1.0.7: structured, machine-readable accounting semantics (cc-switch
        // input_token_semantics parity). DSH reports input as fresh (cache read /
        // cache write sit in their own buckets) — verified against real ledger data;
        // reasoning is bucketed separately from output and assumed non-overlapping.
        semantics: {
          input: 'fresh (excludes cache-read and cache-write tokens, bucketed separately)',
          buckets: ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'],
          inputIncludesCache: false,
          cacheBucketed: true,
          reasoningSeparate: true,
          gate: 'all-zero usage rows are ignored; pure cache-read requests still count',
        },
      },
      costSemantics: {
        source: 'models.dev',
        currency: 'USD',
        buckets: ['input', 'output', 'cacheRead', 'cacheWrite'],
        input: 'fresh (DSH TokenUsage already excludes cache)',
        reasoning: 'not added to output again; provider output already carries completion/thoughts where reported',
        multiplier: 'applies only to final total',
        providerMatching: 'DSH provider is ignored; only the official model vendor entry is selected',
        historical: 'positive non-tiered cost snapshots are stable; legacy tiered snapshots migrate to unsupported; only unresolved usage is eligible for backfill',
      },
      totals: { turns: state.totals.turns, sessions: state.sessionCount.size, input: state.totals.input, output: state.totals.output, cacheRead: state.totals.cacheRead, cacheWrite: state.totals.cacheWrite, reasoning: state.totals.reasoning, cost: serializeCostAggregate(state.totals.cost) },
      perWorkspace: Array.from(state.perWorkspace, (p) => ({ workspaceId: p[0], turns: p[1].turns, input: p[1].input, output: p[1].output, cacheRead: p[1].cacheRead, cacheWrite: p[1].cacheWrite, reasoning: p[1].reasoning, cost: serializeCostAggregate(p[1].cost) })),
      perModel: Array.from(state.perModel.values(), (item) => serializeModelAggregate(item)),
      byDay: serializeDays(state.byDay),
      byDayUtc: serializeDays(state.byDayUtc),
    }
    state.snapshotCache = { revision: state.statsRevision, value }
    return Object.assign({}, value, { generatedAt })
  }

  function validDateText(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
    const year = Number(value.slice(0, 4))
    const month = Number(value.slice(5, 7))
    const day = Number(value.slice(8, 10))
    const date = new Date(Date.UTC(year, month - 1, day))
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  }
  function shiftDateText(value, days, utc) {
    const parts = value.split('-').map(Number)
    const date = utc ? new Date(Date.UTC(parts[0], parts[1] - 1, parts[2] + days)) : new Date(parts[0], parts[1] - 1, parts[2] + days)
    return utc ? dayKeyUtc(date.getTime()) : dayKey(date.getTime())
  }
  function queryScopeFromRequest(req) {
    let url
    try { url = new URL(req.url || '/', 'http://all-usage.local') } catch (err) { return { ok: false, message: 'bad-query' } }
    const rawUtc = url.searchParams.get('utc')
    if (rawUtc !== null && rawUtc !== '' && rawUtc !== '0' && rawUtc !== '1') return { ok: false, message: 'invalid-timezone' }
    const utc = rawUtc === '1'
    const today = utc ? dayKeyUtc(Date.now()) : dayKey(Date.now())
    const start = url.searchParams.get('start') || today
    const end = url.searchParams.get('end') || today
    if (!validDateText(start) || !validDateText(end) || start > end) return { ok: false, message: 'invalid-date-range' }
    const readParam = (name, max) => {
      const value = url.searchParams.get(name)
      if (value === null || value === '') return undefined
      return value.length <= max ? value : null
    }
    const workspaceId = readParam('workspaceId', 256)
    const provider = readParam('provider', 256)
    const modelKey = readParam('modelKey', 1024)
    if (workspaceId === null || provider === null || modelKey === null) return { ok: false, message: 'query-too-long' }
    return { ok: true, scope: { start, end, utc, workspaceId, provider, modelKey } }
  }
  function scopeFingerprint(scope) {
    return JSON.stringify({ start: scope.start, end: scope.end, utc: scope.utc === true, workspaceId: scope.workspaceId || null, provider: scope.provider || null, modelKey: scope.modelKey || null })
  }
  function dateInScope(date, scope) {
    return date >= scope.start && date <= scope.end
  }
  function modelNameOfIdentity(identity) {
    const normalized = coerceIdentity(identity)
    const structured = normalized.actualModel || normalized.requestedModel
    if (structured !== null) return structured
    if (normalized.legacy && typeof normalized.label === 'string') {
      const separator = normalized.label.indexOf(' / ')
      if (separator > 0) return normalized.label.slice(separator + 3)
    }
    return normalized.label
  }
  function identityMatchesScope(identity, scope) {
    const normalized = coerceIdentity(identity)
    if (scope.provider !== undefined && scope.provider !== null && normalized.provider !== scope.provider) return false
    if (scope.modelKey !== undefined && scope.modelKey !== null && normalized.identityKey !== scope.modelKey && modelNameOfIdentity(normalized) !== scope.modelKey) return false
    return true
  }
  function queryMetric() {
    return { turns: 0, calls: 0, sessions: new Set(), turnKeys: new Set(), input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: createCostAccumulator() }
  }
  function queryAggregate() {
    return { totals: queryMetric(), days: new Map(), workspaces: new Map(), models: new Map() }
  }
  function queryDay(aggregate, date) {
    let day = aggregate.days.get(date)
    if (day === undefined) { day = queryMetric(); day.date = date; aggregate.days.set(date, day) }
    return day
  }
  function queryWorkspace(aggregate, workspaceId) {
    let row = aggregate.workspaces.get(workspaceId)
    if (row === undefined) { row = queryMetric(); row.workspaceId = workspaceId; aggregate.workspaces.set(workspaceId, row) }
    return row
  }
  function queryModel(aggregate, identity) {
    const normalized = coerceIdentity(identity)
    let row = aggregate.models.get(normalized.identityKey)
    if (row === undefined) { row = queryMetric(); Object.assign(row, serializeIdentity(normalized)); aggregate.models.set(normalized.identityKey, row) }
    return row
  }
  function addQueryTokens(metric, values) {
    metric.input += values.input
    metric.output += values.output
    metric.cacheRead += values.cacheRead
    metric.cacheWrite += values.cacheWrite
    metric.reasoning += values.reasoning
  }
  function mergeQuerySessions(target, sessions) {
    for (const sid of sessions) target.sessions.add(sid)
  }
  function mergeQueryUsageMetric(target, bucket) {
    target.calls += bucket.calls
    mergeQuerySessions(target, bucket.sessions)
    addQueryTokens(target, bucket)
    addCostAccumulator(target.cost, bucket.cost)
  }
  function addQueryUsageBucket(aggregate, bucket, date, workspaceId) {
    const targets = [aggregate.totals, queryDay(aggregate, date), queryWorkspace(aggregate, workspaceId)]
    targets.push(queryModel(aggregate, bucket.identity))
    for (const target of targets) mergeQueryUsageMetric(target, bucket)
  }
  function addQueryTurnMetric(target, turn) {
    if (target.turnKeys.has(turn.key)) return
    target.turnKeys.add(turn.key)
    target.turns += 1
    target.sessions.add(turn.sid)
  }
  function mergeQueryTurnBucket(target, bucket) {
    target.turns += bucket.turns
    mergeQuerySessions(target, bucket.sessions)
  }
  function addQueryTurn(aggregate, turn, date) {
    const targets = [aggregate.totals, queryDay(aggregate, date), queryWorkspace(aggregate, turn.wsId)]
    targets.push(queryModel(aggregate, turn.identity))
    for (const target of targets) addQueryTurnMetric(target, turn)
  }
  function addQueryTurnBucket(aggregate, bucket, date, workspaceId) {
    const targets = [aggregate.totals, queryDay(aggregate, date), queryWorkspace(aggregate, workspaceId)]
    targets.push(queryModel(aggregate, bucket.identity))
    for (const target of targets) mergeQueryTurnBucket(target, bucket)
  }
  function finalizeQueryMetric(metric) {
    return { turns: metric.turns, calls: metric.calls, sessions: metric.sessions.size, input: metric.input, output: metric.output, cacheRead: metric.cacheRead, cacheWrite: metric.cacheWrite, reasoning: metric.reasoning, cost: serializeCostAggregate(metric.cost) }
  }
  function finalizeQueryAggregate(aggregate) {
    const daily = Array.from(aggregate.days.values()).sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0).map((day) => ({ date: day.date, ...finalizeQueryMetric(day), tokens: { input: day.input, output: day.output, cacheRead: day.cacheRead, cacheWrite: day.cacheWrite, reasoning: day.reasoning } }))
    const perWorkspace = Array.from(aggregate.workspaces.values()).map((row) => ({ workspaceId: row.workspaceId, ...finalizeQueryMetric(row) }))
    const perModel = Array.from(aggregate.models.values()).filter((row) => row.calls > 0 || row.input > 0 || row.output > 0 || row.cacheRead > 0 || row.cacheWrite > 0 || row.reasoning > 0).map((row) => ({ identityKey: row.identityKey, provider: row.provider, requestedModel: row.requestedModel, actualModel: row.actualModel, model: row.model, legacy: row.legacy, ...finalizeQueryMetric(row) }))
    return { totals: finalizeQueryMetric(aggregate.totals), daily, perWorkspace, perModel }
  }
  function heatmapDay(days, date) {
    let day = days.get(date)
    if (day === undefined) { day = { date, turns: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, perWorkspace: new Map() }; days.set(date, day) }
    return day
  }
  function addHeatmapUsage(days, bucket, date) {
    const day = heatmapDay(days, date)
    addQueryTokens(day.tokens, bucket)
  }
  function addHeatmapTurnBucket(days, bucket, date, workspaceId) {
    const day = heatmapDay(days, date)
    day.turns += bucket.turns
    day.perWorkspace.set(workspaceId, (day.perWorkspace.get(workspaceId) || 0) + bucket.turns)
  }
  function addHeatmapTurns(days, records, date) {
    const day = heatmapDay(days, date)
    for (const turn of records) {
      day.turns += 1
      day.perWorkspace.set(turn.wsId, (day.perWorkspace.get(turn.wsId) || 0) + 1)
    }
  }
  function serializeHeatmap(days) {
    return Array.from(days.values()).sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0).map((day) => ({ date: day.date, turns: day.turns, tokens: { input: day.tokens.input, output: day.tokens.output, cacheRead: day.tokens.cacheRead, cacheWrite: day.tokens.cacheWrite, reasoning: day.tokens.reasoning }, perWorkspace: Array.from(day.perWorkspace, (pair) => ({ workspaceId: pair[0], turns: pair[1] })) }))
  }
  const HOUR_MS = 60 * 60 * 1000
  function hourStartOf(time, utc) {
    const date = new Date(time)
    return utc ? Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours()) : new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours()).getTime()
  }
  function calendarStartOf(dateText, utc) {
    const parts = dateText.split('-').map(Number)
    return utc ? Date.UTC(parts[0], parts[1] - 1, parts[2]) : new Date(parts[0], parts[1] - 1, parts[2]).getTime()
  }
  function nextCalendarStartOf(dateText, utc) {
    const parts = dateText.split('-').map(Number)
    return utc ? Date.UTC(parts[0], parts[1] - 1, parts[2] + 1) : new Date(parts[0], parts[1] - 1, parts[2] + 1).getTime()
  }
  function hourlyRangeOf(scope, nowMs) {
    if (scope.start !== scope.end) return null
    const start = calendarStartOf(scope.start, scope.utc)
    const today = scope.utc ? dayKeyUtc(nowMs) : dayKey(nowMs)
    const end = scope.start === today ? nowMs : nextCalendarStartOf(scope.start, scope.utc)
    return { start, count: Math.max(1, Math.ceil(Math.max(0, end - start) / HOUR_MS)) }
  }
  function serializeTrendMetric(time, metric) {
    const value = finalizeQueryMetric(metric || queryMetric())
    return { time, date: new Date(time).toISOString(), ...value, tokens: { input: value.input, output: value.output, cacheRead: value.cacheRead, cacheWrite: value.cacheWrite, reasoning: value.reasoning } }
  }
  function queryHourlyTrend(day, scope, nowMs, matchingTurnKeys) {
    const range = hourlyRangeOf(scope, nowMs)
    if (range === null) return []
    const buckets = new Map()
    const metricFor = (hour) => {
      const index = Math.floor((hour - range.start) / HOUR_MS)
      if (index < 0 || index >= range.count) return null
      let metric = buckets.get(index)
      if (metric === undefined) { metric = queryMetric(); buckets.set(index, metric) }
      return metric
    }
    const hasIdentityFilter = (scope.provider !== undefined && scope.provider !== null) || (scope.modelKey !== undefined && scope.modelKey !== null)
    const hours = day && day.queryHours instanceof Map ? day.queryHours : new Map()
    for (const [hour, value] of hours) {
      for (const [workspaceId, models] of value.usage) {
        if (scope.workspaceId !== undefined && scope.workspaceId !== null && workspaceId !== scope.workspaceId) continue
        for (const bucket of models.values()) {
          if (!identityMatchesScope(bucket.identity, scope)) continue
          const metric = metricFor(hour)
          if (metric === null) continue
          mergeQueryUsageMetric(metric, bucket)
        }
      }
      for (const [workspaceId, models] of value.turns) {
        if (scope.workspaceId !== undefined && scope.workspaceId !== null && workspaceId !== scope.workspaceId) continue
        for (const bucket of models.values()) {
          if (!hasIdentityFilter || identityMatchesScope(bucket.identity, scope)) {
            const metric = metricFor(hour)
            if (metric !== null) mergeQueryTurnBucket(metric, bucket)
          } else if (matchingTurnKeys.size > 0) {
            const metric = metricFor(hour)
            if (metric === null) continue
            for (const turn of bucket.records.values()) if (matchingTurnKeys.has(turn.key)) addQueryTurnMetric(metric, turn)
          }
        }
      }
    }
    return Array.from({ length: range.count }, (_, index) => serializeTrendMetric(range.start + index * HOUR_MS, buckets.get(index)))
  }
  function queryUsageScope(scope) {
    commitPendingStats()
    const nowMs = Date.now()
    const today = scope.utc ? dayKeyUtc(nowMs) : dayKey(nowMs)
    const hourlyCacheKey = scope.start === scope.end ? ':' + (scope.start === today ? hourStartOf(nowMs, scope.utc) : 'fixed') : ''
    const currentQueryRevision = queryRevision()
    const key = currentQueryRevision + ':' + scopeFingerprint(scope) + hourlyCacheKey
    const cached = state.queryCache.get(key)
    if (cached !== undefined) {
      const revisions = revisionSnapshot()
      return { ...cached, ...revisions, updatedAt: state.statsUpdatedAt, partial: !state.scan.done, completeThrough: { ...revisions, at: state.statsUpdatedAt } }
    }
    const now = new Date(nowMs)
    const weekday = scope.utc ? now.getUTCDay() : now.getDay()
    const sunday = shiftDateText(today, -weekday, scope.utc)
    const heatStart = shiftDateText(sunday, -52 * 7, scope.utc)
    const selected = queryAggregate()
    const heatmap = new Map()
    const matchingTurnKeys = new Set()
    const dayMap = scope.utc ? state.byDayUtc : state.byDay
    const hasIdentityFilter = (scope.provider !== undefined && scope.provider !== null) || (scope.modelKey !== undefined && scope.modelKey !== null)
    for (const [date, day] of dayMap) {
      const inSelected = dateInScope(date, scope)
      const inHeat = date >= heatStart && date <= today
      if (!inSelected && !inHeat) continue
      for (const [workspaceId, models] of day.queryUsage) {
        if (scope.workspaceId !== undefined && scope.workspaceId !== null && workspaceId !== scope.workspaceId) continue
        for (const bucket of models.values()) {
          if (!identityMatchesScope(bucket.identity, scope)) continue
          if (hasIdentityFilter) for (const turnKey of bucket.turnKeys) matchingTurnKeys.add(turnKey)
          if (inSelected) addQueryUsageBucket(selected, bucket, date, workspaceId)
          if (inHeat) addHeatmapUsage(heatmap, bucket, date)
        }
      }
    }
    for (const [date, day] of dayMap) {
      const inSelected = dateInScope(date, scope)
      const inHeat = date >= heatStart && date <= today
      if (!inSelected && !inHeat) continue
      for (const [workspaceId, models] of day.queryTurns) {
        if (scope.workspaceId !== undefined && scope.workspaceId !== null && workspaceId !== scope.workspaceId) continue
        for (const bucket of models.values()) {
          if (!hasIdentityFilter || identityMatchesScope(bucket.identity, scope)) {
            if (inSelected) addQueryTurnBucket(selected, bucket, date, workspaceId)
            if (inHeat) addHeatmapTurnBucket(heatmap, bucket, date, workspaceId)
            continue
          }
          if (matchingTurnKeys.size === 0) continue
          const matching = []
          for (const turn of bucket.records.values()) if (matchingTurnKeys.has(turn.key)) matching.push(turn)
          if (matching.length === 0) continue
          if (inSelected) for (const turn of matching) addQueryTurn(selected, turn, date)
          if (inHeat) addHeatmapTurns(heatmap, matching, date)
        }
      }
    }
    const hourly = queryHourlyTrend(dayMap.get(scope.start), scope, nowMs, matchingTurnKeys)
    const revisions = revisionSnapshot()
    const result = { schemaVersion: 1, usageSchemaVersion: 3, costSchemaVersion: COST_SCHEMA_VERSION, instanceId: state.instanceId, ...revisions, updatedAt: state.statsUpdatedAt, scope: JSON.parse(scopeFingerprint(scope)), partial: !state.scan.done, completeThrough: { ...revisions, at: state.statsUpdatedAt }, ...finalizeQueryAggregate(selected), hourly, heatmap: serializeHeatmap(heatmap) }
    state.queryCache.set(key, result)
    while (state.queryCache.size > 20) state.queryCache.delete(state.queryCache.keys().next().value)
    return result
  }
  function opaqueRecordId(item) {
    return createHash('sha256').update(item.sid + '\0' + item.key).digest('hex').slice(0, 20)
  }
  function recordOrder(a, b) {
    return b.time - a.time || b.seq - a.seq || (a.sid < b.sid ? -1 : a.sid > b.sid ? 1 : 0) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  }
  function queryRecords(scope, cursor, limit) {
    commitPendingStats()
    const fingerprint = scopeFingerprint(scope)
    const currentQueryRevision = queryRevision()
    let offset = 0
    if (cursor !== undefined && cursor !== '') {
      try {
        const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
        if (decoded.queryRevision !== currentQueryRevision || decoded.scope !== fingerprint || !Number.isInteger(decoded.offset) || decoded.offset < 0) return { error: 'stale-cursor' }
        offset = decoded.offset
      } catch (err) { return { error: 'bad-cursor' } }
    }
    const cacheKey = currentQueryRevision + ':' + fingerprint
    let rows = state.recordsQueryCache.get(cacheKey)
    if (rows === undefined) {
      const index = scope.utc ? state.usageByUtcDate : state.usageByLocalDate
      rows = indexedEntriesInRange(index, state.usageByStep, scope.start, scope.end).filter(({ item }) => {
        if (scope.workspaceId !== undefined && scope.workspaceId !== null && item.wsId !== scope.workspaceId) return false
        return identityMatchesScope(item.identity || item.modelId, scope)
      })
      rows.sort((left, right) => recordOrder(left.item, right.item))
      state.recordsQueryCache.set(cacheKey, rows)
      while (state.recordsQueryCache.size > 20) state.recordsQueryCache.delete(state.recordsQueryCache.keys().next().value)
    }
    const page = rows.slice(offset, offset + limit)
    const items = page.map(({ item, date }) => {
      const identity = coerceIdentity(item.identity || item.modelId)
      return { id: opaqueRecordId(item), date, time: item.time, workspaceId: item.wsId, provider: identity.provider, requestedModel: identity.requestedModel, actualModel: identity.actualModel, model: identity.label, identityKey: identity.identityKey, turn: item.turn, step: item.step, seq: item.seq, values: item.values, cost: item.cost, materialization: item.materialization || 'unknown' }
    })
    const nextOffset = offset + items.length
    return { schemaVersion: 1, usageSchemaVersion: 3, costSchemaVersion: COST_SCHEMA_VERSION, instanceId: state.instanceId, ...revisionSnapshot(), scope: JSON.parse(fingerprint), items, hasMore: nextOffset < rows.length, nextCursor: nextOffset < rows.length ? Buffer.from(JSON.stringify({ queryRevision: currentQueryRevision, scope: fingerprint, offset: nextOffset })).toString('base64url') : null }
  }

  return {
    dayKey,
    dayKeyUtc,
    dateKeys,
    num,
    validEventTime,
    addDateIndex,
    removeDateIndex,
    indexUsage,
    unindexUsage,
    indexedEntriesInRange,
    usageBasisEqual,
    resolveCurrentPricing,
    costForUsage,
    resetAggregationState,
    ensureDay,
    ensureWs,
    ensureDayWs,
    ensureModel,
    ensureDayModel,
    adjustValues,
    noValues,
    adjustDaySession,
    adjustDay,
    addCostAggregateDirection,
    adjustUsage,
    adjustQueryCost,
    upsertUsageSample,
    addUsage,
    addDayTurn,
    turnRecordKey,
    addTurn,
    textOrNull,
    identityLabel,
    makeIdentity,
    identityFromLegacy,
    isCanonicalIdentity,
    coerceIdentity,
    routeObject,
    identityFromRoute,
    identityFromMessage,
    modelFromRoute,
    modelFromMessage,
    scanSnapshot,
    queryRevision,
    revisionSnapshot,
    statusSnapshot,
    serializeIdentity,
    serializeModelAggregate,
    serializeDays,
    snapshot,
    validDateText,
    shiftDateText,
    queryScopeFromRequest,
    scopeFingerprint,
    dateInScope,
    modelNameOfIdentity,
    identityMatchesScope,
    queryMetric,
    queryAggregate,
    queryDay,
    queryWorkspace,
    queryModel,
    addQueryTokens,
    addQueryTurn,
    finalizeQueryMetric,
    finalizeQueryAggregate,
    hourStartOf,
    calendarStartOf,
    nextCalendarStartOf,
    hourlyRangeOf,
    serializeTrendMetric,
    queryHourlyTrend,
    queryUsageScope,
    opaqueRecordId,
    recordOrder,
    queryRecords
  }
}
