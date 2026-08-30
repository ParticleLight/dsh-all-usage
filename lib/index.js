// dsh-all-usage 插件 Host 半（永久版）
// 数据聚合 + 账户余额 + 工作区别名持久化，通过 webServer 路由向客户端提供数据。
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { COST_SCHEMA_VERSION, addCostAggregate, calculateCost, createEmptyPricingState, decimalSubtract, fetchModelsDevCatalog, emptyCostAggregate, normalizeCostSnapshot, normalizePricingState, officialProviderIds, resolvePricing, serializeCostAggregate, serializePricingState } from './pricing.js'

const name = 'dsh-all-usage'
const inject = ['sessionQuery', 'workspaceRegistry', 'timer', 'sessionPersistence', 'storage']

// webServer route handlers do not inherit the connection API fence; keep this plugin
// local and require a browser-originated capability for state-changing reads/writes.
function requestHeader(req, name) {
  const headers = req && req.headers
  if (headers === null || headers === undefined || typeof headers !== 'object') return undefined
  const value = headers[name.toLowerCase()]
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : undefined
  return typeof value === 'string' ? value : undefined
}

function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

function isTrustedLocalApiRequest(req, requireOrigin) {
  const host = requestHeader(req, 'host')
  if (host === undefined) return false
  let hostUrl
  try {
    hostUrl = new URL('http://' + host)
  } catch (err) {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (requestHeader(req, 'sec-fetch-site') === 'cross-site') return false
  const origin = requestHeader(req, 'origin')
  if (origin === undefined) return requireOrigin !== true
  try {
    const originUrl = new URL(origin)
    return originUrl.protocol === 'http:' && originUrl.host === hostUrl.host
  } catch (err) {
    return false
  }
}

function hasWriteToken(req, expected) {
  const actual = requestHeader(req, 'x-all-usage-request-token')
  if (typeof actual !== 'string' || typeof expected !== 'string') return false
  const actualBytes = Buffer.from(actual)
  const expectedBytes = Buffer.from(expected)
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)
}

function sendJson(res, code, value) {
  res.statusCode = code
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(value))
}

function readBody(req, maxBytes) {
  return new Promise((resolve) => {
    const chunks = []
    const declaredLength = Number(requestHeader(req, 'content-length'))
    let size = Number.isFinite(declaredLength) && declaredLength > maxBytes ? maxBytes + 1 : 0
    let tooLarge = size > maxBytes
    let settled = false
    const finish = (text, oversized) => {
      if (settled) return
      settled = true
      resolve({ text, tooLarge: oversized })
    }
    req.on('data', (chunk) => {
      if (tooLarge) return
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += value.length
      if (size > maxBytes) {
        tooLarge = true
        chunks.length = 0
        return
      }
      chunks.push(value)
    })
    req.on('end', () => finish(tooLarge ? '' : Buffer.concat(chunks).toString('utf8'), tooLarge))
    req.on('error', () => finish('', false))
  })
}

function apply(ctx) {
  const credentials = ctx.get('credentials')
  const settings = ctx.get('settings')
  const storage = ctx.get('storage')
  const webServer = ctx.get('webServer')
  // v1.0.8: optional sessionPersistence exposes listSnapshots() — a cheap per-session
  // revision (header line + stat, no full-log read) that lets the baseline skip
  // re-reading unchanged sessions after a DSH restart.
  const sessionPersistence = ctx.get('sessionPersistence')

  // ---------- owned aggregation state ----------
  const wsMeta = new Map()
  const pathIndex = new Map()
  const memberOf = new Map()
  const byDay = new Map()
  const byDayUtc = new Map()
  const perWorkspace = new Map()
  const perModel = new Map()
  // One canonical usage contribution per session turn/step. This makes retries and
  // replacement messages update a logical model call instead of double-counting it.
  const usageByStep = new Map()
  const turnRecords = new Map()
  const usageByLocalDate = new Map()
  const usageByUtcDate = new Map()
  const turnsByLocalDate = new Map()
  const turnsByUtcDate = new Map()
  const sessionModel = new Map()
  const totals = { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: emptyCostAggregate() }
  const sessionCount = new Set()
  const sessionSeq = new Map()
  const chains = new Map()
  const liveResyncPending = new Set()
  const liveResyncTimers = new Map()
  const liveResyncAttempts = new Map()
  const scan = { started: false, done: false, scanned: 0, total: 0, failed: 0 }
  const aliases = {}
  let kvUnit = null
  let aliasWriteChain = Promise.resolve()
  let aliasesReady = Promise.resolve()
  let balanceCache = { fetchedAt: 0, payload: null }
  const requestToken = randomBytes(32).toString('base64url')
  // A non-secret identity distinguishes HMR/restart revision resets from a stale page.
  const instanceId = randomBytes(12).toString('base64url')
  let statsRevision = 0
  let statsUpdatedAt = Date.now()
  let statsDirtyScheduled = false
  const sync = {
    lastStartedAt: 0,
    lastCompletedAt: 0,
    lastErrorAt: 0,
    lastErrorCode: null,
    persistenceSnapshotsAvailable: false,
    sessionsTotal: 0,
    sessionsRead: 0,
    sessionsSkippedByRevision: 0,
    sessionsRestoredFromLedger: 0,
    sessionsFailed: 0,
  }
  const ledgerRecords = new Map()
  const queryCache = new Map()
  const recordsQueryCache = new Map()
  let snapshotCache = null
  let ledgerUnit = null
  let ledgerReady = Promise.resolve()
  let ledgerWriteChain = Promise.resolve()
  let pricingState = createEmptyPricingState()
  const pricingResolutionCache = new Map()
  let pricingUnit = null
  let pricingReady = Promise.resolve()
  let pricingWriteChain = Promise.resolve()
  let pricingSyncInFlight = false
  let pricingSyncTimer = null
  const LEDGER_VERSION = 3
  const PREVIOUS_LEDGER_VERSION = 2
  const LEGACY_LEDGER_VERSION = 1
  let ledgerRevision = Date.now()
  let disposed = false
  let baselineRetryDelay = 1000
  let baselineRetryScheduled = false
  let baselineFallbackTimer = null
  const knownSessionIds = new Set()
  let aggregationGeneration = 0
  let reconcileHintScheduled = false
  let reconcilePending = false
  let reconcileInFlight = false
  let reconcileTimer = null
  const RECONCILE_INTERVAL_MS = 120000
  const RECONCILE_HINT_DELAY_MS = 3000

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
  function validEventTime(value) {
    return typeof value === 'number' && Number.isFinite(value)
  }
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
    addDateIndex(usageByLocalDate, item.date, item.key)
    addDateIndex(usageByUtcDate, item.dateUtc, item.key)
  }
  function unindexUsage(item) {
    removeDateIndex(usageByLocalDate, item.date, item.key)
    removeDateIndex(usageByUtcDate, item.dateUtc, item.key)
  }
  function indexTurn(turn) {
    addDateIndex(turnsByLocalDate, turn.date, turn.key)
    addDateIndex(turnsByUtcDate, turn.dateUtc, turn.key)
  }
  function indexedEntries(index, source, scope, heatStart, today) {
    const result = []
    for (const [date, keys] of index) {
      if (!dateInScope(date, scope) && (date < heatStart || date > today)) continue
      for (const key of keys) {
        const item = source.get(key)
        if (item !== undefined) result.push({ item, date })
      }
    }
    return result
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
    const cached = pricingResolutionCache.get(key)
    if (cached !== undefined) return cached
    const resolved = resolvePricing(normalized, pricingState)
    pricingResolutionCache.set(key, resolved)
    while (pricingResolutionCache.size > 5000) pricingResolutionCache.delete(pricingResolutionCache.keys().next().value)
    return resolved
  }
  function costForUsage(values, identity, previous) {
    const previousCost = normalizeCostSnapshot(previous && previous.cost)
    if (previousCost !== null && previousCost.pricingMode === 'official-model' && usageBasisEqual(previous, identity, values)) return previousCost
    return calculateCost(values, resolveCurrentPricing(identity))
  }
  // Coalesce synchronous aggregation writes without adding a timer lifecycle.
  function commitPendingStats() {
    if (!statsDirtyScheduled) return
    statsDirtyScheduled = false
    if (disposed) return
    statsRevision += 1
    statsUpdatedAt = Date.now()
  }
  function markStatsChanged() {
    snapshotCache = null
    recordsQueryCache.clear()
    if (disposed || statsDirtyScheduled) return
    statsDirtyScheduled = true
    if (typeof queueMicrotask === 'function') queueMicrotask(commitPendingStats)
    else Promise.resolve().then(commitPendingStats)
  }
  function resetSyncState() {
    sync.lastStartedAt = 0
    sync.lastCompletedAt = 0
    sync.lastErrorAt = 0
    sync.lastErrorCode = null
    sync.persistenceSnapshotsAvailable = false
    sync.sessionsTotal = 0
    sync.sessionsRead = 0
    sync.sessionsSkippedByRevision = 0
    sync.sessionsRestoredFromLedger = 0
    sync.sessionsFailed = 0
  }
  function beginSync() {
    resetSyncState()
    sync.lastStartedAt = Date.now()
    markStatsChanged()
  }
  function noteSyncError(code) {
    sync.lastErrorAt = Date.now()
    sync.lastErrorCode = code
    markStatsChanged()
  }
  function syncSnapshot() {
    return {
      lastStartedAt: sync.lastStartedAt,
      lastCompletedAt: sync.lastCompletedAt,
      lastErrorAt: sync.lastErrorAt,
      lastErrorCode: sync.lastErrorCode,
      persistenceSnapshotsAvailable: sync.persistenceSnapshotsAvailable,
      sessionsTotal: sync.sessionsTotal,
      sessionsRead: sync.sessionsRead,
      sessionsSkippedByRevision: sync.sessionsSkippedByRevision,
      sessionsRestoredFromLedger: sync.sessionsRestoredFromLedger,
      sessionsFailed: sync.sessionsFailed,
    }
  }
  async function safeContextTimeout(ms) {
    if (disposed) return false
    try {
      await ctx.timeout(ms)
      return !disposed
    } catch (err) {
      if (!disposed) console.error('[all-usage] context timer unavailable:', err)
      return false
    }
  }
  function resetAggregationState() {
    aggregationGeneration += 1
    wsMeta.clear()
    pathIndex.clear()
    memberOf.clear()
    byDay.clear()
    byDayUtc.clear()
    perWorkspace.clear()
    perModel.clear()
    usageByStep.clear()
    turnRecords.clear()
    usageByLocalDate.clear()
    usageByUtcDate.clear()
    turnsByLocalDate.clear()
    turnsByUtcDate.clear()
    for (const timer of liveResyncTimers.values()) clearTimeout(timer)
    liveResyncTimers.clear()
    liveResyncAttempts.clear()
    liveResyncPending.clear()
    reconcileHintScheduled = false
    if (baselineFallbackTimer !== null) {
      clearTimeout(baselineFallbackTimer)
      baselineFallbackTimer = null
    }
    baselineRetryScheduled = false
    queryCache.clear()
    recordsQueryCache.clear()
    sessionModel.clear()
    sessionCount.clear()
    sessionSeq.clear()
    chains.clear()
    knownSessionIds.clear()
    totals.turns = 0
    totals.input = 0
    totals.output = 0
    totals.cacheRead = 0
    totals.cacheWrite = 0
    totals.reasoning = 0
    Object.assign(totals.cost, emptyCostAggregate())
    scan.started = false
    scan.done = false
    scan.scanned = 0
    scan.total = 0
    scan.failed = 0
    resetSyncState()
    baselineRetryDelay = 1000
    markStatsChanged()
    return aggregationGeneration
  }
  function ensureDay(dayMap, date) {
    let day = dayMap.get(date)
    if (day === undefined) {
      day = { turns: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, cost: emptyCostAggregate(), perWs: new Map(), byWs: new Map(), byModel: new Map(), sessionIds: new Set(), sessionRefs: new Map() }
      dayMap.set(date, day)
    }
    return day
  }
  function ensureWs(wsId) {
    let ws = perWorkspace.get(wsId)
    if (ws === undefined) {
      ws = { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: emptyCostAggregate() }
      perWorkspace.set(wsId, ws)
    }
    return ws
  }
  function ensureDayWs(day, wsId) {
    let w = day.byWs.get(wsId)
    if (w === undefined) {
      w = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: emptyCostAggregate() }
      day.byWs.set(wsId, w)
    }
    return w
  }
  function ensureModel(value) {
    const identity = coerceIdentity(value)
    let item = perModel.get(identity.identityKey)
    if (item === undefined) {
      item = { ...identity, model: identity.label, calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: emptyCostAggregate() }
      perModel.set(identity.identityKey, item)
    }
    return item
  }
  function ensureDayModel(day, value) {
    const identity = coerceIdentity(value)
    let item = day.byModel.get(identity.identityKey)
    if (item === undefined) {
      item = { ...identity, model: identity.label, calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: emptyCostAggregate() }
      day.byModel.set(identity.identityKey, item)
    }
    return item
  }
  function usageValues(usage) {
    return {
      input: num(usage && usage.inputTokens),
      output: num(usage && usage.outputTokens),
      cacheRead: num(usage && usage.cacheReadTokens),
      cacheWrite: num(usage && usage.cacheWriteTokens),
      reasoning: num(usage && usage.reasoningTokens),
    }
  }
  function adjustValues(target, values, direction) {
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
      addCostAggregate(target, cost)
      return
    }
    if (direction !== -1) return
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
  function adjustUsage(wsId, time, values, identity, direction, sid, cachedDates, cost) {
    const normalized = coerceIdentity(identity)
    const dates = cachedDates && typeof cachedDates.local === 'string' && typeof cachedDates.utc === 'string' ? cachedDates : dateKeys(time)
    const modelTotals = ensureModel(normalized)
    modelTotals.calls += direction
    adjustValues(modelTotals, values, direction)
    addCostAggregateDirection(modelTotals.cost, cost, direction)
    if (modelTotals.calls === 0 && noValues(modelTotals)) perModel.delete(normalized.identityKey)
    adjustValues(totals, values, direction)
    addCostAggregateDirection(totals.cost, cost, direction)
    const ws = ensureWs(wsId)
    adjustValues(ws, values, direction)
    addCostAggregateDirection(ws.cost, cost, direction)
    adjustDay(byDay, dates.local, wsId, values, normalized, direction, sid, cost)
    adjustDay(byDayUtc, dates.utc, wsId, values, normalized, direction, sid, cost)
  }
  function usageStepKey(sid, data, seq, fallback) {
    const turn = data && typeof data.turn === 'number' ? data.turn : null
    const step = data && typeof data.step === 'number' ? data.step : null
    if (turn !== null && step !== null) return sid + ':step:' + turn + ':' + step
    if (typeof seq === 'number') return sid + ':event:' + seq
    return sid + ':event:' + (fallback === undefined ? JSON.stringify(data || {}) : String(fallback))
  }
  function addUsage(wsId, time, usage, model, sid, data, seq, materialization = 'live') {
    if (!validEventTime(time)) return
    const values = usageValues(usage)
    const identity = coerceIdentity(model)
    const eventSeq = typeof seq === 'number' ? seq : -1
    // v1.0.7: a usage event carrying no billable token in any bucket must not add a
    // meaningless row nor wipe previously recorded real usage (cc-switch
    // has_billable_tokens parity). Pure cache-read requests are billable and pass.
    if (noValues(values)) return
    const dates = dateKeys(time)
    const key = usageStepKey(sid, data, seq)
    const previous = usageByStep.get(key)
    // A late replay of an older raw event cannot replace the canonical later step.
    if (previous !== undefined && eventSeq >= 0 && previous.seq > eventSeq) return
    if (previous !== undefined) {
      unindexUsage(previous)
      adjustUsage(previous.wsId, previous.time, previous.values, previous.identity || previous.modelId, -1, previous.sid, { local: previous.date, utc: previous.dateUtc }, previous.cost)
    }
    const cost = costForUsage(values, identity, previous)
    const next = { key, seq: eventSeq, wsId, time, date: dates.local, dateUtc: dates.utc, values, identity, modelId: identity.label, cost, turn: data && typeof data.turn === 'number' ? data.turn : null, step: data && typeof data.step === 'number' ? data.step : null, materialization, sid }
    usageByStep.set(key, next)
    indexUsage(next)
    adjustUsage(wsId, time, values, identity, 1, sid, dates, cost)
    markStatsChanged()
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
    if (turnRecords.has(key)) return
    const normalized = coerceIdentity(identity)
    const dates = dateKeys(time)
    const record = { key, sid, wsId, time, date: dates.local, dateUtc: dates.utc, turn: typeof turn === 'number' ? turn : null, identity: normalized, materialization }
    turnRecords.set(key, record)
    indexTurn(record)
    ensureWs(wsId).turns += 1
    totals.turns += 1
    addDayTurn(byDay, dates.local, wsId, sid)
    addDayTurn(byDayUtc, dates.utc, wsId, sid)
    markStatsChanged()
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
  function nextLedgerRevision() {
    ledgerRevision = Math.max(ledgerRevision + 1, Date.now())
    return ledgerRevision
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
      if (event.type !== 'assistant/message' || data === null || typeof data !== 'object' || data.usage === undefined || !validEventTime(event.time)) continue
      const values = usageValues(data.usage)
      // v1.0.7: all-zero usage rows carry no billable tokens and stay out of the
      // durable ledger (cc-switch has_billable_tokens parity).
      if (noValues(values)) continue
      const identity = identityFromMessage(data, currentIdentity)
      const eventSeq = typeof event.seq === 'number' ? event.seq : -1
      const key = usageStepKey(sid, data, event.seq, index)
      const previous = usage.get(key)
      if (previous !== undefined && eventSeq >= 0 && previous.seq > eventSeq) continue
      const previousItem = previousUsage.get(key)
      const previousCost = normalizeCostSnapshot(previousItem && previousItem.cost)
      const cost = previousItem !== undefined && previousCost !== null && previousCost.pricingMode === 'official-model' && usageBasisEqual(previousItem, identity, values) ? previousCost : calculateCost(values, resolveCurrentPricing(identity))
      usage.set(key, {
        key,
        seq: eventSeq,
        time: event.time,
        workspaceId,
        identity,
        modelId: identity.label,
        cost,
        turn: data && typeof data.turn === 'number' ? data.turn : null,
        step: data && typeof data.step === 'number' ? data.step : null,
        values,
      })
      currentIdentity = identity
    }
    return { version: LEDGER_VERSION, sessionId: sid, workspaceId, lastSeq: lastSeqOf(events), source, updatedAt: nextLedgerRevision(), lastRevision: typeof revision === 'string' ? revision : undefined, sourceRevision: typeof revision === 'string' ? revision : undefined, lastIdentity: currentIdentity, turns: Array.from(turns.values()), usage: Array.from(usage.values()) }
  }
  function normalizeLedgerRecord(raw, key) {
    if (raw === null || typeof raw !== 'object' || (raw.version !== LEDGER_VERSION && raw.version !== PREVIOUS_LEDGER_VERSION && raw.version !== LEGACY_LEDGER_VERSION) || typeof raw.sessionId !== 'string' || raw.sessionId !== key) return null
    if (!Array.isArray(raw.turns) || !Array.isArray(raw.usage)) return null
    const needsUpgrade = raw.version !== LEDGER_VERSION || raw.usage.some((item) => { const cost = normalizeCostSnapshot(item && item.cost); return item === null || typeof item !== 'object' || item.identity === undefined || cost === null || cost.pricingMode !== 'official-model' })
    const turnMap = new Map()
    for (const turn of raw.turns) {
      if (turn && typeof turn.key === 'string' && turn.workspaceId !== undefined && Number.isFinite(turn.time)) turnMap.set(turn.key, { key: turn.key, seq: typeof turn.seq === 'number' ? turn.seq : -1, time: turn.time, workspaceId: turn.workspaceId, turn: typeof turn.turn === 'number' ? turn.turn : null, identity: coerceIdentity(turn.identity || turn.modelId) })
    }
    const usageMap = new Map()
    for (const item of raw.usage) {
      if (!item || typeof item.key !== 'string' || item.workspaceId === undefined || !Number.isFinite(item.time) || item.values === null || typeof item.values !== 'object') continue
      const identity = coerceIdentity(item.identity || item.modelId)
      const normalizedCost = normalizeCostSnapshot(item.cost)
      const normalized = { key: item.key, seq: typeof item.seq === 'number' ? item.seq : -1, time: item.time, workspaceId: item.workspaceId, identity, modelId: identity.label, ...(normalizedCost === null ? {} : { cost: normalizedCost }), turn: typeof item.turn === 'number' ? item.turn : null, step: typeof item.step === 'number' ? item.step : null, values: usageValues({ inputTokens: item.values.input, outputTokens: item.values.output, cacheReadTokens: item.values.cacheRead, cacheWriteTokens: item.values.cacheWrite, reasoningTokens: item.values.reasoning }) }
      const previous = usageMap.get(normalized.key)
      if (previous === undefined || previous.seq <= normalized.seq) usageMap.set(normalized.key, normalized)
    }
    const updatedAt = typeof raw.updatedAt === 'number' ? raw.updatedAt : 0
    ledgerRevision = Math.max(ledgerRevision, updatedAt)
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
      if (cost !== null && cost.pricingMode === 'official-model') { item.cost = cost; continue }
      const identity = item.identity || identityFromLegacy(item.modelId)
      item.cost = calculateCost(item.values, resolveCurrentPricing(identity))
      changed = true
    }
    if (changed) {
      record.version = LEDGER_VERSION
      record.updatedAt = nextLedgerRevision()
      record.needsUpgrade = false
      ledgerRecords.set(record.sessionId, record)
      void persistLedgerRecord(record)
    }
    return record
  }
  function applyLedgerRecord(record, materialization = 'ledger-reuse') {
    if (record === null || record === undefined) return
    prepareLedgerRecord(record)
    if (record.lastIdentity !== undefined) sessionModel.set(record.sessionId, record.lastIdentity)
    for (const turn of record.turns) addTurn(turn.workspaceId, turn.time, record.sessionId, turn.turn, turn.identity, materialization, turn.seq)
    for (const item of record.usage) {
      const identity = item.identity || identityFromLegacy(item.modelId)
      const dates = dateKeys(item.time)
      const previous = usageByStep.get(item.key)
      if (previous !== undefined) {
        unindexUsage(previous)
        adjustUsage(previous.wsId, previous.time, previous.values, previous.identity || previous.modelId, -1, previous.sid, { local: previous.date, utc: previous.dateUtc }, previous.cost)
      }
      const next = { key: item.key, seq: item.seq, wsId: item.workspaceId, time: item.time, date: dates.local, dateUtc: dates.utc, values: item.values, identity, modelId: identity.label, cost: item.cost, turn: item.turn, step: item.step, materialization, sid: record.sessionId }
      adjustUsage(item.workspaceId, item.time, item.values, identity, 1, record.sessionId, dates, item.cost)
      usageByStep.set(item.key, next)
      indexUsage(next)
    }
    if (record.turns.length > 0 || record.usage.length > 0) {
      sessionCount.add(record.sessionId)
      if (record.usage.length > 0) markStatsChanged()
    }
  }
  function ledgerRank(record) {
    return [typeof record.lastSeq === 'number' ? record.lastSeq : -1, record.source === 'flush' ? 1 : 0, typeof record.updatedAt === 'number' ? record.updatedAt : 0]
  }
  function replaceLedgerRecord(record) {
    ledgerRecords.set(record.sessionId, record)
    return record
  }
  function storeLedgerRecord(record) {
    const current = ledgerRecords.get(record.sessionId)
    if (current !== undefined) {
      const nextRank = ledgerRank(record)
      const currentRank = ledgerRank(current)
      if (nextRank[0] < currentRank[0] || (nextRank[0] === currentRank[0] && (nextRank[1] < currentRank[1] || (nextRank[1] === currentRank[1] && nextRank[2] <= currentRank[2])))) return current
    }
    ledgerRecords.set(record.sessionId, record)
    return record
  }
  function persistLedgerRecord(record) {
    if (disposed || ledgerUnit === null || record === null || record === undefined) return ledgerWriteChain
    const write = ledgerWriteChain.then(async () => {
      if (ledgerUnit !== null && ledgerRecords.get(record.sessionId) === record) await ledgerUnit.putRecord('sessions', record.sessionId, record)
    })
    ledgerWriteChain = write.catch((err) => {
      console.error('[all-usage] usage ledger write failed:', err)
    })
    return ledgerWriteChain
  }
  function foldEvent(wsId, time, type, data, sid, seq, materialization = 'live') {
    if ((type === 'turn/end' || type === 'assistant/message') && !validEventTime(time)) return
    if (type === 'request/context' || type === 'request/header') {
      sessionModel.set(sid, identityFromRoute(data, sessionModel.get(sid)))
    } else if (type === 'turn/end') {
      addTurn(wsId, time, sid, data && typeof data.turn === 'number' ? data.turn : null, sessionModel.get(sid), materialization, seq)
    } else if (type === 'assistant/message' && data && data.usage) {
      const identity = identityFromMessage(data, sessionModel.get(sid))
      sessionModel.set(sid, identity)
      addUsage(wsId, time, data.usage, identity, sid, data, seq, materialization)
    }
  }
  function foldEvents(wsId, events, fromSeq, sid, materialization = 'scan') {
    for (const ev of events) {
      if (fromSeq !== undefined) {
        const s = typeof ev.seq === 'number' ? ev.seq : -1
        if (s <= fromSeq) continue
      }
      if (ev.type === 'turn/end' || ev.type === 'assistant/message' || ev.type === 'request/context' || ev.type === 'request/header') foldEvent(wsId, ev.time, ev.type, ev.data, sid, ev.seq, materialization)
    }
  }
  function lastSeqOf(events) {
    let last = -1
    for (const ev of events) {
      const s = typeof ev.seq === 'number' ? ev.seq : -1
      if (s > last) last = s
    }
    return last
  }
  function sequenceProfile(events) {
    let previous = -1
    let last = -1
    let nonMonotonic = false
    for (const ev of events) {
      const seq = ev && typeof ev.seq === 'number' ? ev.seq : -1
      if (seq < 0) continue
      if (seq <= previous) nonMonotonic = true
      previous = seq
      if (seq > last) last = seq
    }
    return { lastSeq: last, nonMonotonic }
  }
  function enqueue(sid, task) {
    const prev = chains.get(sid) || Promise.resolve()
    const next = prev.then(() => task(), () => task())
    chains.set(sid, next)
    const cleanup = () => { if (chains.get(sid) === next) chains.delete(sid) }
    void next.then(cleanup, cleanup)
    return next
  }
  function wsForLiveSession(session, sid) {
    let wsId = memberOf.get(sid)
    if (wsId !== undefined) return wsId
    const header = session && session.header
    const cwd = header && typeof header.cwd === 'string' ? header.cwd : ''
    if (cwd === '') return undefined
    wsId = pathIndex.get(cwd)
    if (wsId !== undefined) memberOf.set(sid, wsId)
    return wsId
  }
  function cancelLiveResync(sid) {
    const timer = liveResyncTimers.get(sid)
    if (timer !== undefined) {
      clearTimeout(timer)
      liveResyncTimers.delete(sid)
    }
    liveResyncAttempts.delete(sid)
    liveResyncPending.delete(sid)
  }
  function scheduleLiveResync(sid, wsId, generation) {
    if (disposed || generation !== aggregationGeneration || !liveResyncPending.has(sid) || liveResyncTimers.has(sid)) return
    const attempt = liveResyncAttempts.get(sid) || 0
    const delay = Math.min(30000, 1000 * Math.pow(2, Math.min(attempt, 5)))
    const timer = setTimeout(() => {
      liveResyncTimers.delete(sid)
      if (disposed || generation !== aggregationGeneration || !liveResyncPending.has(sid)) return
      void enqueue(sid, () => resyncLiveSession(sid, wsId, generation))
    }, delay)
    liveResyncTimers.set(sid, timer)
    if (timer && typeof timer.unref === 'function') timer.unref()
  }
  function foldLiveFallback(sid, wsId, event) {
    if (event === null || event === undefined) return
    foldEvent(wsId, event.time, event.type, event.data, sid, event.seq, 'live')
    const seq = typeof event.seq === 'number' ? event.seq : -1
    if (seq >= 0) {
      const current = sessionSeq.get(sid)
      if (current === undefined || seq > current) sessionSeq.set(sid, seq)
    }
    sessionCount.add(sid)
  }
  async function syncLiveSession(sid, wsId, event, generation) {
    try {
      const snap = await ctx.sessionQuery.readSession(sid)
      if (disposed || generation !== aggregationGeneration) return true
      if (snap && Array.isArray(snap.events)) {
        const previousLast = sessionSeq.get(sid)
        const snapshotLast = lastSeqOf(snap.events)
        foldEvents(wsId, snap.events, undefined, sid, 'live')
        let nextLast = Math.max(previousLast === undefined ? -1 : previousLast, snapshotLast)
        const eventSeq = event === null || event === undefined || typeof event.seq !== 'number' ? -1 : event.seq
        const needsFollowup = event !== null && event !== undefined && (eventSeq < 0 || eventSeq > snapshotLast)
        if (needsFollowup) {
          foldLiveFallback(sid, wsId, event)
          const current = sessionSeq.get(sid)
          nextLast = Math.max(nextLast, current === undefined ? -1 : current)
        }
        sessionSeq.set(sid, nextLast)
        sessionCount.add(sid)
        if (needsFollowup) scheduleLiveResync(sid, wsId, generation)
        else cancelLiveResync(sid)
        return true
      }
    } catch (err) {
      // Keep the event as a fallback and retry a complete session sync later.
    }
    return false
  }
  async function resyncLiveSession(sid, wsId, generation) {
    if (disposed || generation !== aggregationGeneration || !liveResyncPending.has(sid)) return
    if (await syncLiveSession(sid, wsId, null, generation)) return
    liveResyncAttempts.set(sid, (liveResyncAttempts.get(sid) || 0) + 1)
    scheduleLiveResync(sid, wsId, generation)
  }
  async function processLiveEvent(sid, wsId, event, generation = aggregationGeneration) {
    if (disposed || generation !== aggregationGeneration) return
    const seq = typeof event.seq === 'number' ? event.seq : -1
    const last = sessionSeq.get(sid)
    const needsSync = last === undefined || liveResyncPending.has(sid) || (seq >= 0 && seq > last + 1)
    if (needsSync) {
      liveResyncPending.add(sid)
      if (await syncLiveSession(sid, wsId, event, generation)) return
      foldLiveFallback(sid, wsId, event)
      liveResyncAttempts.set(sid, (liveResyncAttempts.get(sid) || 0) + 1)
      scheduleLiveResync(sid, wsId, generation)
      return
    }
    if (seq < 0) {
      foldLiveFallback(sid, wsId, event)
      return
    }
    if (seq <= last) return
    foldLiveFallback(sid, wsId, event)
  }

  // ---------- durable usage ledger ----------
  async function loadLedger() {
    if (storage === undefined || storage.backend === undefined || typeof storage.backend.get !== 'function') return
    try {
      const backend = storage.backend.get('json')
      if (backend === undefined || backend === null || backend.kv === undefined) return
      const unit = await backend.kv.open({ name: 'all_usage_ledger', version: 0, tables: ['sessions'], hasGlobal: false })
      if (disposed) { await unit.close().catch(() => {}); return }
      ledgerUnit = unit
      const snapshot = await unit.loadAll()
      const rows = snapshot && snapshot.tables && snapshot.tables.sessions
      if (rows !== null && rows !== undefined && typeof rows === 'object') {
        for (const [key, raw] of Object.entries(rows)) {
          const record = normalizeLedgerRecord(raw, key)
          if (record === null) console.warn('[all-usage] ignoring malformed usage ledger row:', key)
          else ledgerRecords.set(key, record)
        }
      }
    } catch (err) {
      console.error('[all-usage] usage ledger unavailable:', err)
    }
  }


  // ---------- pricing catalog and cost backfill ----------
  function adjustCostOnly(item, cost, direction) {
    const identity = coerceIdentity(item.identity || item.modelId)
    const dates = item && typeof item.date === 'string' && typeof item.dateUtc === 'string' ? { local: item.date, utc: item.dateUtc } : dateKeys(item.time)
    const targets = []
    const seen = new Set()
    for (const target of [
      ensureModel(identity).cost,
      totals.cost,
      ensureWs(item.wsId).cost,
      ensureDay(byDay, dates.local).cost,
      ensureDay(byDayUtc, dates.utc).cost,
      ensureDayWs(ensureDay(byDay, dates.local), item.wsId).cost,
      ensureDayWs(ensureDay(byDayUtc, dates.utc), item.wsId).cost,
      ensureDayModel(ensureDay(byDay, dates.local), identity).cost,
      ensureDayModel(ensureDay(byDayUtc, dates.utc), identity).cost,
    ]) {
      if (seen.has(target)) continue
      seen.add(target)
      targets.push(target)
    }
    for (const target of targets) addCostAggregateDirection(target, cost, direction)
  }
  function usedPricingModels() {
    const rows = []
    const seen = new Set()
    for (const item of usageByStep.values()) {
      const identity = coerceIdentity(item.identity || item.modelId)
      if (seen.has(identity.identityKey)) continue
      seen.add(identity.identityKey)
      const resolved = resolveCurrentPricing(identity)
      rows.push({ identityKey: identity.identityKey, provider: identity.provider, requestedModel: identity.requestedModel, actualModel: identity.actualModel, model: identity.label, status: resolved.status, reason: resolved.reason || '', pricingModel: resolved.pricingModel || null, providerId: resolved.providerId || null, source: resolved.source || 'none', currency: resolved.currency || 'USD', rates: resolved.rates || null, tiered: resolved.tiered === true })
      if (rows.length >= 500) break
    }
    rows.sort((a, b) => String(a.model).localeCompare(String(b.model)))
    return rows
  }
  function pricingModelSearch(query, limit = 20) {
    const raw = typeof query === 'string' ? query.trim().toLowerCase() : ''
    if (raw === '') return []
    const normalized = raw.replace(/\s+/g, ' ')
    const selected = new Map()
    for (const entry of pricingState.catalogEntries) {
      const official = officialProviderIds(entry.modelId)
      if (!official.has(String(entry.providerId || '').toLowerCase())) continue
      const modelId = entry.modelId.toLowerCase()
      const displayName = String(entry.displayName || '').toLowerCase()
      if (!modelId.includes(normalized) && !displayName.includes(normalized)) continue
      const score = modelId === normalized ? 0 : modelId.startsWith(normalized) ? 1 : displayName.startsWith(normalized) ? 2 : 3
      const previous = selected.get(entry.modelId)
      if (previous === undefined || score < previous.score) selected.set(entry.modelId, { value: entry.modelId, label: entry.displayName, providerId: entry.providerId, score })
    }
    return Array.from(selected.values()).sort((a, b) => a.score - b.score || a.value.localeCompare(b.value)).slice(0, Math.max(1, Math.min(50, Number.isInteger(limit) ? limit : 20))).map(({ score, ...entry }) => entry)
  }
  function pricingSnapshot() {
    const state = pricingState
    const used = usedPricingModels()
    return {
      schemaVersion: state.schemaVersion,
      source: { ...state.source },
      sync: { ...state.sync },
      catalogModelCount: state.catalogEntries.length,
      overrideCount: state.overrides.length,
      mappingCount: state.mappings.length,
      configured: state.catalogEntries.length > 0 || state.overrides.length > 0 || state.mappings.length > 0,
      config: { sync: { ...state.sync }, mappings: state.mappings.map(({ provider, identityKey, ...mapping }) => ({ ...mapping })), overrides: state.overrides.map(({ providerId, ...entry }) => ({ ...entry })) },
      usedModels: used,
      cost: serializeCostAggregate(totals.cost),
    }
  }
  async function loadPricing() {
    if (storage === undefined || storage.backend === undefined || typeof storage.backend.get !== 'function') return
    try {
      const backend = storage.backend.get('json')
      if (backend === undefined || backend === null || backend.kv === undefined) return
      const unit = await backend.kv.open({ name: 'all_usage_pricing', version: 0, tables: [], hasGlobal: true })
      if (disposed) { await unit.close().catch(() => {}); return }
      pricingUnit = unit
      const snapshot = await unit.loadAll()
      const global = snapshot && snapshot.global
      const raw = global && typeof global === 'object' && global.pricing !== undefined ? global.pricing : global
      pricingState = normalizePricingState(raw)
      pricingResolutionCache.clear()
    } catch (err) {
      console.error('[all-usage] pricing catalog unavailable:', err)
    }
  }
  function persistPricing() {
    if (disposed) return pricingWriteChain
    const payload = { pricing: serializePricingState(pricingState) }
    pricingWriteChain = pricingWriteChain.then(async () => {
      if (pricingUnit === null || pricingUnit === undefined) return
      await pricingUnit.setGlobal(payload)
    })
    pricingWriteChain = pricingWriteChain.catch((err) => {
      console.error('[all-usage] pricing persist failed:', err)
    })
    return pricingWriteChain
  }
  async function syncPricing(force = false) {
    await pricingReady
    if (pricingSyncInFlight) return { ok: false, message: 'pricing-sync-in-progress', pricing: pricingSnapshot() }
    const now = Date.now()
    if (!force && pricingState.sync.lastSuccessAt > 0 && now - pricingState.sync.lastSuccessAt < pricingState.sync.intervalMs) return { ok: true, skipped: true, pricing: pricingSnapshot() }
    pricingSyncInFlight = true
    pricingState.sync.lastAttemptAt = now
    markStatsChanged()
    try {
      const result = await fetchModelsDevCatalog()
      if (!result.ok) {
        pricingState.source.lastError = result.error
        pricingState.sync.lastError = result.error
        markStatsChanged()
        await persistPricing()
        return { ok: false, message: result.error, pricing: pricingSnapshot() }
      }
      pricingState = normalizePricingState({
        ...serializePricingState(pricingState),
        source: { url: result.catalog.sourceUrl, fetchedAt: result.catalog.fetchedAt, catalogHash: result.catalog.catalogHash, lastError: '' },
        sync: { ...pricingState.sync, lastSuccessAt: result.catalog.fetchedAt, lastError: '' },
        catalogEntries: result.catalog.entries,
      })
      pricingResolutionCache.clear()
      const backfill = backfillUnpricedCosts()
      markStatsChanged()
      await persistPricing()
      await ledgerWriteChain
      return { ok: true, skipped: false, backfill, pricing: pricingSnapshot() }
    } finally {
      pricingSyncInFlight = false
      schedulePricingSync()
    }
  }
  function backfillUnpricedCosts() {
    let considered = 0
    let priced = 0
    const touched = new Set()
    for (const item of usageByStep.values()) {
      const oldCost = normalizeCostSnapshot(item.cost)
      if (oldCost !== null && oldCost.pricingMode === 'official-model' && oldCost.status === 'priced') continue
      considered += 1
      const next = calculateCost(item.values, resolveCurrentPricing(item.identity || item.modelId))
      if (next.status !== 'priced') continue
      if (oldCost !== null) adjustCostOnly(item, oldCost, -1)
      item.cost = next
      adjustCostOnly(item, next, 1)
      const record = ledgerRecords.get(item.sid)
      if (record !== undefined) {
        const stored = record.usage.find((candidate) => candidate.key === item.key)
        if (stored !== undefined) { stored.cost = next; touched.add(record) }
      }
      priced += 1
    }
    for (const record of touched) {
      record.version = LEDGER_VERSION
      record.updatedAt = nextLedgerRevision()
      record.needsUpgrade = false
      void persistLedgerRecord(record)
    }
    let remaining = 0
    for (const item of usageByStep.values()) {
      const cost = normalizeCostSnapshot(item.cost)
      if (cost === null || cost.status !== 'priced') remaining += 1
    }
    return { considered, priced, remaining }
  }
  function updatePricingState(raw, backfill) {
    const input = raw && typeof raw === 'object' && raw.pricing && typeof raw.pricing === 'object' ? raw.pricing : raw
    const current = serializePricingState(pricingState)
    const merged = { ...current, ...(input && typeof input === 'object' ? input : {}) }
    if (input && typeof input === 'object' && input.sync && typeof input.sync === 'object' && !Array.isArray(input.sync)) merged.sync = { ...current.sync, ...input.sync }
    pricingState = normalizePricingState(merged)
    pricingResolutionCache.clear()
    const result = backfill === true ? backfillUnpricedCosts() : { considered: 0, priced: 0, remaining: totals.cost.unpricedCalls + totals.cost.ambiguousCalls + totals.cost.unsupportedCalls }
    markStatsChanged()
    schedulePricingSync()
    return result
  }
  function schedulePricingSync() {
    if (pricingSyncTimer !== null) { clearTimeout(pricingSyncTimer); pricingSyncTimer = null }
    if (disposed || pricingState.sync.autoEnabled !== true) return
    const elapsed = pricingState.sync.lastSuccessAt > 0 ? Date.now() - pricingState.sync.lastSuccessAt : pricingState.sync.intervalMs
    const delay = Math.max(0, pricingState.sync.intervalMs - elapsed)
    pricingSyncTimer = setTimeout(() => {
      pricingSyncTimer = null
      void syncPricing(true)
    }, delay)
    if (pricingSyncTimer && typeof pricingSyncTimer.unref === 'function') pricingSyncTimer.unref()
  }

  // ---------- baseline scan over durable logs ----------
  function scheduleNativeBaselineRetry(generation, delay) {
    if (disposed || baselineFallbackTimer !== null) return
    baselineFallbackTimer = setTimeout(() => {
      baselineFallbackTimer = null
      if (!disposed && generation === aggregationGeneration && !scan.started && !scan.done) void runBaseline(generation)
    }, delay)
    if (baselineFallbackTimer && typeof baselineFallbackTimer.unref === 'function') baselineFallbackTimer.unref()
  }
  function scheduleBaselineRetry(generation = aggregationGeneration) {
    if (disposed || baselineRetryScheduled || scan.done || generation !== aggregationGeneration) return
    baselineRetryScheduled = true
    const delay = baselineRetryDelay
    baselineRetryDelay = Math.min(baselineRetryDelay * 2, 30000)
    void safeContextTimeout(delay).then((ready) => {
      if (generation !== aggregationGeneration) return undefined
      baselineRetryScheduled = false
      if (ready && !scan.started && !scan.done) return runBaseline(generation)
      if (!ready && !disposed) scheduleNativeBaselineRetry(generation, delay)
      return undefined
    })
  }
  async function runBaseline(generation = aggregationGeneration) {
    if (scan.started || disposed || generation !== aggregationGeneration) return
    scan.started = true
    beginSync()
    await Promise.all([ledgerReady, pricingReady])
    if (disposed || generation !== aggregationGeneration) return
    let setupFailed = false
    try {
      const workspaces = ctx.workspaceRegistry.list()
      for (const w of workspaces) {
        const id = w && w.id
        const path = w && typeof w.path === 'string' ? w.path : ''
        const title = w && typeof w.title === 'string' ? w.title : ''
        if (id === undefined) continue
        wsMeta.set(id, { id, title, path })
        if (path !== '') pathIndex.set(path, id)
        if (w && Array.isArray(w.sessionIds)) {
          for (const sid of w.sessionIds) memberOf.set(sid, id)
        }
      }
    } catch (err) {
      console.error('[all-usage] workspace list failed:', err)
      setupFailed = true
      noteSyncError('workspace-list-failed')
    }
    let records = null
    try {
      records = await ctx.sessionQuery.listSessions()
    } catch (err) {
      console.error('[all-usage] session list failed:', err)
      if (disposed || generation !== aggregationGeneration) return
      noteSyncError('session-list-failed')
    }
    if (disposed || generation !== aggregationGeneration) return
    // v1.0.8: cheap per-session change signal (header line + stat, no full-log read)
    let snapshots = null
    if (sessionPersistence !== undefined && typeof sessionPersistence.listSnapshots === 'function') {
      try {
        const rows = await sessionPersistence.listSnapshots()
        if (disposed || generation !== aggregationGeneration) return
        if (Array.isArray(rows)) {
          sync.persistenceSnapshotsAvailable = true
          snapshots = new Map()
          for (const row of rows) {
            const rid = row && row.header && typeof row.header.id === 'string' ? row.header.id : undefined
            if (rid !== undefined && row && typeof row.revision === 'string') snapshots.set(rid, row.revision)
          }
        }
      } catch (err) {
        console.error('[all-usage] session persistence snapshots unavailable:', err)
        if (disposed || generation !== aggregationGeneration) return
        sync.persistenceSnapshotsAvailable = false
        markStatsChanged()
      }
    }
    if (disposed || generation !== aggregationGeneration) return
    if (setupFailed || !Array.isArray(records)) {
      // A transient registry failure must not be reported as a completed empty scan.
      scan.started = false
      markStatsChanged()
      scheduleBaselineRetry(generation)
      return
    }
    scan.total = records.length
    sync.sessionsTotal = records.length
    markStatsChanged()
    const listedSessionIds = new Set()
    for (const record of records) {
      if (record === undefined || record === null || record.header === undefined) continue
      const sid = record.header.id
      const cwd = typeof record.header.cwd === 'string' ? record.header.cwd : ''
      const wsId = cwd === '' ? undefined : pathIndex.get(cwd)
      if (sid !== undefined && wsId !== undefined) listedSessionIds.add(sid)
    }
    for (const [sid, record] of ledgerRecords) {
      if (!listedSessionIds.has(sid)) {
        applyLedgerRecord(record, 'ledger-recovery')
        if (record.turns.length > 0 || record.usage.length > 0) sync.sessionsRestoredFromLedger += 1
      }
    }
    if (sync.sessionsRestoredFromLedger > 0) markStatsChanged()
    for (const record of records) {
      if (disposed || generation !== aggregationGeneration) return
      if (record === undefined || record === null || record.header === undefined) {
        scan.scanned += 1
        markStatsChanged()
        continue
      }
      const sid = record.header.id
      const cwd = typeof record.header.cwd === 'string' ? record.header.cwd : ''
      const wsId = cwd === '' ? undefined : pathIndex.get(cwd)
      if (sid === undefined || wsId === undefined) {
        scan.scanned += 1
        markStatsChanged()
        continue
      }
      listedSessionIds.add(sid)
      await enqueue(sid, async () => {
        if (disposed || generation !== aggregationGeneration) return
        try {
          if (sessionSeq.has(sid) && !liveResyncPending.has(sid)) return
          // v1.0.8: when the persisted log revision is unchanged since the last ledger
          // write, the whole readSession (full event transfer) is skipped — the ledger
          // record is applied directly and the live feed keeps catching new events.
          const previousRecord = ledgerRecords.get(sid)
          const revision = snapshots === null ? undefined : snapshots.get(sid)
          if (!liveResyncPending.has(sid) && previousRecord !== undefined && previousRecord.needsUpgrade !== true && typeof previousRecord.lastRevision === 'string' && typeof revision === 'string' && revision === previousRecord.lastRevision) {
            sync.sessionsSkippedByRevision += 1
            applyLedgerRecord(previousRecord, 'ledger-reuse')
            sessionSeq.set(sid, previousRecord.lastSeq)
            sessionCount.add(sid)
            markStatsChanged()
            return
          }
          sync.sessionsRead += 1
          markStatsChanged()
          const snap = await ctx.sessionQuery.readSession(sid)
          if (disposed || generation !== aggregationGeneration) return
          if (snap && Array.isArray(snap.events)) {
            // v1.0.7: incremental seed — the durable ledger doubles as a per-session
            // cursor (cc-switch session_log_sync mtime+offset parity). An unchanged
            // session applies its canonical record directly and never re-folds;
            // a changed session seeds the previous record once, then folds only the
            // new tail (previously every listed session was re-read and fully rebuilt).
            const sequence = sequenceProfile(snap.events)
            const currentLastSeq = sequence.lastSeq
            const previous = ledgerRecords.get(sid)
            const canFoldTail = previous !== undefined && previous.needsUpgrade !== true && !sequence.nonMonotonic && previous.lastSeq >= 0 && currentLastSeq > previous.lastSeq
            if (canFoldTail) {
              applyLedgerRecord(previous, 'ledger-reuse')
              foldEvents(wsId, snap.events, previous.lastSeq, sid, 'scan')
            } else {
              // A changed revision with no new tail may still contain a replacement;
              // rebuild from the complete read instead of trusting lastSeq alone.
              foldEvents(wsId, snap.events, undefined, sid, 'scan')
            }
            const ledger = buildLedgerRecord({ id: sid, header: record.header, events: snap.events }, wsId, 'scan', revision, previous)
            const canonical = ledger === null ? ledgerRecords.get(sid) : (canFoldTail ? storeLedgerRecord(ledger) : replaceLedgerRecord(ledger))
            if (canonical === ledger) {
              void persistLedgerRecord(ledger)
            }
            const observedLastSeq = sessionSeq.get(sid)
            const nextLastSeq = Math.max(currentLastSeq, observedLastSeq === undefined ? -1 : observedLastSeq)
            sessionSeq.set(sid, nextLastSeq)
            sessionCount.add(sid)
            if (observedLastSeq === undefined || observedLastSeq <= currentLastSeq) cancelLiveResync(sid)
            else scheduleLiveResync(sid, wsId, generation)
          }
        } catch (err) {
          if (generation !== aggregationGeneration) return
          sync.sessionsFailed += 1
          scan.failed += 1
          noteSyncError('session-read-failed')
          const saved = ledgerRecords.get(sid)
          if (saved !== undefined) {
            applyLedgerRecord(saved, 'ledger-recovery')
            if (saved.turns.length > 0 || saved.usage.length > 0) sync.sessionsRestoredFromLedger += 1
            sessionSeq.set(sid, -1)
            sessionCount.add(sid)
          } else {
            sessionSeq.set(sid, -1)
          }
        } finally {
          if (generation === aggregationGeneration) {
            scan.scanned += 1
            markStatsChanged()
          }
        }
      })
      if (!(await safeContextTimeout(0))) {
        scan.started = false
        noteSyncError('baseline-yield-unavailable')
        scheduleBaselineRetry(generation)
        return
      }
    }
    if (disposed || generation !== aggregationGeneration) return
    await ledgerWriteChain
    if (disposed || generation !== aggregationGeneration) return
    const costBackfill = backfillUnpricedCosts()
    if (costBackfill.priced > 0) {
      await ledgerWriteChain
      markStatsChanged()
    }
    if (disposed || generation !== aggregationGeneration) return
    knownSessionIds.clear()
    for (const sid of listedSessionIds) knownSessionIds.add(sid)
    scan.done = true
    sync.lastCompletedAt = Date.now()
    if (sync.sessionsFailed === 0) {
      sync.lastErrorAt = 0
      sync.lastErrorCode = null
    }
    markStatsChanged()
    if (reconcilePending) scheduleReconcileHint()
  }

  function sessionIdsFromRecords(records) {
    const ids = new Set()
    for (const record of records) {
      if (record === undefined || record === null || record.header === undefined) continue
      const sid = record.header.id
      const cwd = typeof record.header.cwd === 'string' ? record.header.cwd : ''
      const wsId = cwd === '' ? undefined : pathIndex.get(cwd)
      if (sid !== undefined && wsId !== undefined) ids.add(sid)
    }
    return ids
  }
  async function reconcileSessions() {
    if (disposed || reconcileInFlight || !scan.done) return
    reconcilePending = false
    reconcileInFlight = true
    try {
      const records = await ctx.sessionQuery.listSessions()
      if (disposed || !Array.isArray(records)) return
      const currentIds = sessionIdsFromRecords(records)
      let removed = false
      for (const sid of knownSessionIds) {
        if (!currentIds.has(sid)) { removed = true; break }
      }
      if (removed && !disposed && scan.done) {
        console.info('[all-usage] session removal detected; rebuilding usage index')
        const generation = resetAggregationState()
        void runBaseline(generation)
        return
      }
      knownSessionIds.clear()
      for (const sid of currentIds) knownSessionIds.add(sid)
    } catch (err) {
      console.error('[all-usage] session reconciliation failed:', err)
      noteSyncError('session-reconcile-failed')
    } finally {
      reconcileInFlight = false
      if (reconcilePending && !disposed) scheduleReconcileHint()
    }
  }
  function scheduleReconcileHint() {
    if (disposed) return
    reconcilePending = true
    if (reconcileHintScheduled || reconcileInFlight) return
    reconcileHintScheduled = true
    const generation = aggregationGeneration
    void safeContextTimeout(RECONCILE_HINT_DELAY_MS).then((ready) => {
      if (generation !== aggregationGeneration) return
      reconcileHintScheduled = false
      if (ready && !disposed) void reconcileSessions()
    }, () => {
      if (generation === aggregationGeneration) reconcileHintScheduled = false
    })
  }
  function scheduleReconcileTimer() {
    if (disposed || reconcileTimer !== null) return
    reconcileTimer = setTimeout(() => {
      reconcileTimer = null
      if (!disposed) {
        void reconcileSessions()
        scheduleReconcileTimer()
      }
    }, RECONCILE_INTERVAL_MS)
    if (reconcileTimer && typeof reconcileTimer.unref === 'function') reconcileTimer.unref()
  }

  // ---------- live feed ----------
  ctx.on('session/event', (session, event) => {
    if (disposed) return
    if (event === undefined || event === null) return
    const type = event.type
    if (type !== 'turn/end' && type !== 'assistant/message' && type !== 'request/context' && type !== 'request/header') return
    const sid = session && session.id
    if (typeof sid !== 'string') return
    const wsId = wsForLiveSession(session, sid)
    if (wsId === undefined) return
    const generation = aggregationGeneration
    knownSessionIds.add(sid)
    enqueue(sid, () => processLiveEvent(sid, wsId, event, generation))
  })
  ctx.on('session/flush', async (session) => {
    if (disposed || session === null || typeof session !== 'object' || typeof session.id !== 'string') return
    await Promise.all([ledgerReady, pricingReady])
    if (disposed) return
    const wsId = wsForLiveSession(session, session.id)
    if (wsId === undefined) return
    const ledger = buildLedgerRecord(session, wsId, 'flush', undefined, ledgerRecords.get(session.id))
    if (ledger === null) return
    const canonical = storeLedgerRecord(ledger)
    if (canonical === ledger) await persistLedgerRecord(ledger)
  })
  ctx.on('session/disposed', () => {
    if (!disposed) scheduleReconcileHint()
  })

  // ---------- workspace aliases (durable, schema-free KV unit) ----------
  async function loadAliases() {
    if (storage === undefined) return
    try {
      const backend = storage.backend.get('json')
      if (backend === undefined || backend === null || backend.kv === undefined) return
      const unit = await backend.kv.open({ name: 'all_usage_aliases', version: 0, tables: [], hasGlobal: true })
      if (disposed) { await unit.close().catch(() => {}); return }
      kvUnit = unit
      const snap = await unit.loadAll()
      const g = snap && snap.global
      if (g !== null && g !== undefined && typeof g === 'object') {
        for (const key of Object.keys(g)) {
          const value = g[key]
          if (typeof value === 'string' && value.trim() !== '') aliases[key] = value
        }
        markStatsChanged()
      }
    } catch (err) {
      console.error('[all-usage] alias storage unavailable:', err)
    }
  }
  function persistAliases() {
    if (disposed) return aliasWriteChain
    const snapshotAliases = {}
    for (const key of Object.keys(aliases)) snapshotAliases[key] = aliases[key]
    aliasWriteChain = aliasWriteChain.then(() => {
      if (kvUnit === null || kvUnit === undefined) return undefined
      return kvUnit.setGlobal(snapshotAliases).catch((err) => {
        console.error('[all-usage] alias persist failed:', err)
      })
    })
  }
  function setAlias(wsId, raw) {
    if (typeof wsId !== 'string' || wsId.length === 0 || wsId.length > 256) return { ok: false, message: 'invalid-workspace', aliases: Object.assign({}, aliases) }
    if (typeof raw !== 'string') return { ok: false, message: 'invalid-alias', aliases: Object.assign({}, aliases) }
    const alias = raw.trim().slice(0, 80)
    if (!wsMeta.has(wsId)) return { ok: false, message: 'unknown-workspace', aliases: Object.assign({}, aliases) }
    if (alias === '') delete aliases[wsId]
    else aliases[wsId] = alias
    persistAliases()
    markStatsChanged()
    return { ok: true, aliases: Object.assign({}, aliases) }
  }
  ctx.effect(() => async () => {
    disposed = true
    if (reconcileTimer !== null) {
      clearTimeout(reconcileTimer)
      reconcileTimer = null
    }
    if (baselineFallbackTimer !== null) {
      clearTimeout(baselineFallbackTimer)
      baselineFallbackTimer = null
    }
    if (pricingSyncTimer !== null) {
      clearTimeout(pricingSyncTimer)
      pricingSyncTimer = null
    }
    for (const timer of liveResyncTimers.values()) clearTimeout(timer)
    liveResyncTimers.clear()
    liveResyncAttempts.clear()
    liveResyncPending.clear()
    baselineRetryScheduled = false
    chains.clear()
    await Promise.all([aliasesReady, ledgerReady, pricingReady, aliasWriteChain, ledgerWriteChain, pricingWriteChain])
    const units = [kvUnit, ledgerUnit, pricingUnit]
    kvUnit = null
    ledgerUnit = null
    pricingUnit = null
    await Promise.all(units.map((unit) => unit === null || unit === undefined ? undefined : unit.close().catch(() => {})))
  })

  // ---------- snapshot for the client ----------
  function scanSnapshot() {
    return { started: scan.started, done: scan.done, scanned: scan.scanned, total: scan.total, failed: scan.failed }
  }
  function statusSnapshot() {
    commitPendingStats()
    return { instanceId, revision: statsRevision, updatedAt: statsUpdatedAt, scan: scanSnapshot(), sync: syncSnapshot() }
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
    if (snapshotCache !== null && snapshotCache.revision === statsRevision) return Object.assign({}, snapshotCache.value, { generatedAt })
    const value = {
      ...statusSnapshot(),
      generatedAt,
      usageSchemaVersion: 3,
      costSchemaVersion: COST_SCHEMA_VERSION,
      requestToken,
      workspaces: Array.from(wsMeta.values(), (w) => ({ id: w.id, title: w.title, path: w.path })),
      aliases: Object.assign({}, aliases),
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
        historical: 'positive cost snapshots are stable; only unresolved usage is eligible for backfill',
      },
      totals: { turns: totals.turns, sessions: sessionCount.size, input: totals.input, output: totals.output, cacheRead: totals.cacheRead, cacheWrite: totals.cacheWrite, reasoning: totals.reasoning, cost: serializeCostAggregate(totals.cost) },
      perWorkspace: Array.from(perWorkspace, (p) => ({ workspaceId: p[0], turns: p[1].turns, input: p[1].input, output: p[1].output, cacheRead: p[1].cacheRead, cacheWrite: p[1].cacheWrite, reasoning: p[1].reasoning, cost: serializeCostAggregate(p[1].cost) })),
      perModel: Array.from(perModel.values(), (item) => serializeModelAggregate(item)),
      byDay: serializeDays(byDay),
      byDayUtc: serializeDays(byDayUtc),
    }
    snapshotCache = { revision: statsRevision, value }
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
    return { turns: 0, calls: 0, sessions: new Set(), turnKeys: new Set(), input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: emptyCostAggregate() }
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
  function addQueryTurn(aggregate, turn, date) {
    const targets = [aggregate.totals, queryDay(aggregate, date), queryWorkspace(aggregate, turn.wsId)]
    const model = queryModel(aggregate, turn.identity)
    targets.push(model)
    const key = turn.key
    for (const target of targets) {
      if (target.turnKeys.has(key)) continue
      target.turnKeys.add(key)
      target.turns += 1
      target.sessions.add(turn.sid)
    }
  }
  function addQueryUsage(aggregate, item, date) {
    const targets = [aggregate.totals, queryDay(aggregate, date), queryWorkspace(aggregate, item.wsId)]
    const model = queryModel(aggregate, item.identity || item.modelId)
    targets.push(model)
    for (const target of targets) {
      target.calls += 1
      target.sessions.add(item.sid)
      addQueryTokens(target, item.values)
      addCostAggregate(target.cost, item.cost)
    }
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
  function queryHourlyTrend(matchingUsage, matchingTurns, scope, nowMs) {
    const range = hourlyRangeOf(scope, nowMs)
    if (range === null) return []
    const buckets = new Map()
    const metricFor = (time) => {
      const index = Math.floor((hourStartOf(time, scope.utc) - range.start) / HOUR_MS)
      if (index < 0 || index >= range.count) return null
      let metric = buckets.get(index)
      if (metric === undefined) { metric = queryMetric(); buckets.set(index, metric) }
      return metric
    }
    for (const entry of matchingUsage) {
      if (!dateInScope(entry.date, scope)) continue
      const metric = metricFor(entry.item.time)
      if (metric === null) continue
      metric.calls += 1
      metric.sessions.add(entry.item.sid)
      addQueryTokens(metric, entry.item.values)
      addCostAggregate(metric.cost, entry.item.cost)
    }
    for (const entry of matchingTurns) {
      if (!dateInScope(entry.date, scope)) continue
      const metric = metricFor(entry.turn.time)
      if (metric === null || metric.turnKeys.has(entry.turn.key)) continue
      metric.turnKeys.add(entry.turn.key)
      metric.turns += 1
      metric.sessions.add(entry.turn.sid)
    }
    return Array.from({ length: range.count }, (_, index) => serializeTrendMetric(range.start + index * HOUR_MS, buckets.get(index)))
  }
  function queryUsageScope(scope) {
    commitPendingStats()
    const nowMs = Date.now()
    const today = scope.utc ? dayKeyUtc(nowMs) : dayKey(nowMs)
    const hourlyCacheKey = scope.start === scope.end ? ':' + (scope.start === today ? hourStartOf(nowMs, scope.utc) : 'fixed') : ''
    const key = statsRevision + ':' + scopeFingerprint(scope) + hourlyCacheKey
    const cached = queryCache.get(key)
    if (cached !== undefined) return cached
    const now = new Date(nowMs)
    const weekday = scope.utc ? now.getUTCDay() : now.getDay()
    const sunday = shiftDateText(today, -weekday, scope.utc)
    const heatStart = shiftDateText(sunday, -52 * 7, scope.utc)
    const matchingUsage = []
    const matchingTurnKeys = new Set()
    const usageIndex = scope.utc ? usageByUtcDate : usageByLocalDate
    for (const indexed of indexedEntries(usageIndex, usageByStep, scope, heatStart, today)) {
      const item = indexed.item
      const date = indexed.date
      if (scope.workspaceId !== undefined && scope.workspaceId !== null && item.wsId !== scope.workspaceId) continue
      if (!identityMatchesScope(item.identity || item.modelId, scope)) continue
      matchingUsage.push({ item, date })
      if (item.turn !== null && item.turn !== undefined) matchingTurnKeys.add(item.sid + ':turn:' + item.turn)
    }
    const matchingTurns = []
    const turnIndex = scope.utc ? turnsByUtcDate : turnsByLocalDate
    for (const indexed of indexedEntries(turnIndex, turnRecords, scope, heatStart, today)) {
      const turn = indexed.item
      const date = indexed.date
      if (scope.workspaceId !== undefined && scope.workspaceId !== null && turn.wsId !== scope.workspaceId) continue
      if ((scope.provider !== undefined && scope.provider !== null) || (scope.modelKey !== undefined && scope.modelKey !== null)) {
        if (!identityMatchesScope(turn.identity, scope) && !matchingTurnKeys.has(turn.key)) continue
      }
      matchingTurns.push({ turn, date })
    }
    const selected = queryAggregate()
    const heatmap = queryAggregate()
    for (const entry of matchingUsage) {
      if (dateInScope(entry.date, scope)) addQueryUsage(selected, entry.item, entry.date)
      if (entry.date >= heatStart && entry.date <= today) addQueryUsage(heatmap, entry.item, entry.date)
    }
    for (const entry of matchingTurns) {
      if (dateInScope(entry.date, scope)) addQueryTurn(selected, entry.turn, entry.date)
      if (entry.date >= heatStart && entry.date <= today) addQueryTurn(heatmap, entry.turn, entry.date)
    }
    const hourly = queryHourlyTrend(matchingUsage, matchingTurns, scope, nowMs)
    const result = { schemaVersion: 1, usageSchemaVersion: 3, costSchemaVersion: COST_SCHEMA_VERSION, instanceId, revision: statsRevision, updatedAt: statsUpdatedAt, scope: JSON.parse(scopeFingerprint(scope)), partial: !scan.done, completeThrough: { revision: statsRevision, at: statsUpdatedAt }, ...finalizeQueryAggregate(selected), hourly, heatmap: finalizeQueryAggregate(heatmap).daily }
    queryCache.set(key, result)
    while (queryCache.size > 20) queryCache.delete(queryCache.keys().next().value)
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
    let offset = 0
    if (cursor !== undefined && cursor !== '') {
      try {
        const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
        if (decoded.revision !== statsRevision || decoded.scope !== fingerprint || !Number.isInteger(decoded.offset) || decoded.offset < 0) return { error: 'stale-cursor' }
        offset = decoded.offset
      } catch (err) { return { error: 'bad-cursor' } }
    }
    const cacheKey = statsRevision + ':' + fingerprint
    let rows = recordsQueryCache.get(cacheKey)
    if (rows === undefined) {
      const index = scope.utc ? usageByUtcDate : usageByLocalDate
      rows = indexedEntriesInRange(index, usageByStep, scope.start, scope.end).filter(({ item }) => {
        if (scope.workspaceId !== undefined && scope.workspaceId !== null && item.wsId !== scope.workspaceId) return false
        return identityMatchesScope(item.identity || item.modelId, scope)
      })
      rows.sort((left, right) => recordOrder(left.item, right.item))
      recordsQueryCache.set(cacheKey, rows)
      while (recordsQueryCache.size > 20) recordsQueryCache.delete(recordsQueryCache.keys().next().value)
    }
    const page = rows.slice(offset, offset + limit)
    const items = page.map(({ item, date }) => {
      const identity = coerceIdentity(item.identity || item.modelId)
      return { id: opaqueRecordId(item), date, time: item.time, workspaceId: item.wsId, provider: identity.provider, requestedModel: identity.requestedModel, actualModel: identity.actualModel, model: identity.label, identityKey: identity.identityKey, turn: item.turn, step: item.step, seq: item.seq, values: item.values, cost: item.cost, materialization: item.materialization || 'unknown' }
    })
    const nextOffset = offset + items.length
    return { schemaVersion: 1, usageSchemaVersion: 3, costSchemaVersion: COST_SCHEMA_VERSION, instanceId, revision: statsRevision, scope: JSON.parse(fingerprint), items, hasMore: nextOffset < rows.length, nextCursor: nextOffset < rows.length ? Buffer.from(JSON.stringify({ revision: statsRevision, scope: fingerprint, offset: nextOffset })).toString('base64url') : null }
  }

  // ---------- account balance (DeepSeek open platform) ----------
  async function requestBalance(url, key) {
    let controller = null
    let timer = null
    try {
      if (typeof AbortController === 'function') {
        controller = new AbortController()
        timer = setTimeout(() => controller.abort(), 30000)
      }
      const response = await fetch(url, {
        method: 'GET',
        headers: { accept: 'application/json', authorization: 'Bearer ' + key },
        ...(controller === null ? {} : { signal: controller.signal }),
      })
      return { ok: response.ok, status: response.status, text: await response.text() }
    } catch (err) {
      return { ok: false, status: 0, text: '', error: 'network request failed' }
    } finally {
      if (timer !== null) clearTimeout(timer)
    }
  }
  function moneyOf(v) {
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string' && v.trim() !== '') {
      const n = parseFloat(v)
      if (Number.isFinite(n)) return n
    }
    return null
  }
  function parseBalance(text) {
    let obj = null
    try {
      obj = JSON.parse(String(text).replace(/^\uFEFF/, ''))
    } catch (err) {
      return null
    }
    if (obj === null || typeof obj !== 'object') return null
    if (obj.is_available === false) return { unavailable: true, currencies: [] }
    const infos = (Array.isArray(obj.balance_infos) && obj.balance_infos) || (Array.isArray(obj.balance) && obj.balance) || null
    if (!infos) return null
    const out = []
    for (const info of infos) {
      if (info === null || typeof info !== 'object') continue
      if (typeof info.currency !== 'string') continue
      out.push({
        currency: info.currency,
        total: moneyOf(info.total_balance !== undefined ? info.total_balance : info.balance),
        granted: moneyOf(info.granted_balance),
        toppedUp: moneyOf(info.topped_up_balance),
      })
    }
    return { unavailable: false, currencies: out }
  }
  async function fetchBalance(force) {
    const now = Date.now()
    if (force !== true && balanceCache.payload !== null && now - balanceCache.fetchedAt < 300000) return balanceCache.payload
    let ref = 'DEEPSEEK_API_KEY'
    if (settings !== undefined) {
      try {
        const section = settings.get('llm-deepseek')
        if (section !== null && typeof section === 'object' && typeof section.apiKeyEnv === 'string' && section.apiKeyEnv.length > 0) ref = section.apiKeyEnv
      } catch (err) { /* default ref */ }
    }
    let key
    if (credentials !== undefined) {
      try {
        const hit = await credentials.resolve(ref)
        if (hit !== null && hit !== undefined && typeof hit.value === 'string' && hit.value.length > 0) key = hit.value
      } catch (err) { /* unconfigured */ }
    }
    if (key === undefined) {
      const payload = { status: 'missing-key' }
      balanceCache = { fetchedAt: now, payload }
      return payload
    }
    if (typeof fetch !== 'function') {
      const payload = { status: 'error', message: '当前 DSH 运行时不支持余额查询' }
      balanceCache = { fetchedAt: now, payload }
      return payload
    }
    const result = await requestBalance('https://api.deepseek.com/user/balance', key)
    const body = (result.text || '').trim()
    if (result.ok && body.length > 0) {
      const parsed = parseBalance(body)
      if (parsed !== null && parsed.unavailable) {
        const payload = { status: 'unavailable', message: 'DeepSeek 接口返回余额不可用（is_available=false）' }
        balanceCache = { fetchedAt: now, payload }
        return payload
      }
      if (parsed !== null && parsed.currencies.length > 0) {
        const payload = { status: 'ok', currencies: parsed.currencies, fetchedAt: now }
        balanceCache = { fetchedAt: now, payload }
        return payload
      }
    }
    const detail = body.length > 0 ? body.slice(0, 300) : (result.status > 0 ? 'HTTP ' + result.status : result.error || 'network request failed')
    const payload = { status: 'error', message: '余额查询失败', detail }
    balanceCache = { fetchedAt: now, payload }
    return payload
  }

  // ---------- HTTP data routes for the client half ----------
  if (webServer !== undefined) {
    const rejectRequest = (res) => sendJson(res, 403, { ok: false, message: 'forbidden' })
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/api/all-usage/query',
      handler: (req, res) => {
        if (req.method !== 'GET') { res.statusCode = 405; res.end(); return }
        if (!isTrustedLocalApiRequest(req, false)) { rejectRequest(res); return }
        const parsed = queryScopeFromRequest(req)
        if (!parsed.ok) { sendJson(res, 400, { ok: false, message: parsed.message }); return }
        sendJson(res, 200, queryUsageScope(parsed.scope))
      },
    }))
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/api/all-usage/records',
      handler: (req, res) => {
        if (req.method !== 'GET') { res.statusCode = 405; res.end(); return }
        if (!isTrustedLocalApiRequest(req, false)) { rejectRequest(res); return }
        const parsed = queryScopeFromRequest(req)
        if (!parsed.ok) { sendJson(res, 400, { ok: false, message: parsed.message }); return }
        let limit = 50
        let cursor
        try {
          const url = new URL(req.url || '/', 'http://all-usage.local')
          const rawLimit = url.searchParams.get('limit')
          if (rawLimit !== null && rawLimit !== '') limit = Number(rawLimit)
          cursor = url.searchParams.get('cursor') || undefined
        } catch (err) { sendJson(res, 400, { ok: false, message: 'bad-query' }); return }
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) { sendJson(res, 400, { ok: false, message: 'invalid-limit' }); return }
        const result = queryRecords(parsed.scope, cursor, limit)
        if (result.error !== undefined) { sendJson(res, result.error === 'stale-cursor' ? 409 : 400, { ok: false, message: result.error }); return }
        sendJson(res, 200, result)
      },
    }))
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/api/all-usage/pricing/models',
      handler: (req, res) => {
        if (req.method !== 'GET') { res.statusCode = 405; res.end(); return }
        if (!isTrustedLocalApiRequest(req, false)) { rejectRequest(res); return }
        let query = ''
        let limit = 20
        try {
          const url = new URL(req.url || '/', 'http://all-usage.local')
          query = url.searchParams.get('q') || ''
          const rawLimit = url.searchParams.get('limit')
          if (rawLimit !== null && rawLimit !== '') limit = Number(rawLimit)
        } catch (err) { sendJson(res, 400, { ok: false, message: 'bad-query' }); return }
        if (query.length > 120 || !Number.isInteger(limit) || limit < 1 || limit > 50) { sendJson(res, 400, { ok: false, message: 'invalid-model-search' }); return }
        sendJson(res, 200, { items: pricingModelSearch(query, limit) })
      },
    }))
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/api/all-usage/pricing',
      handler: async (req, res) => {
        if (req.method === 'GET') {
          if (!isTrustedLocalApiRequest(req, false)) { rejectRequest(res); return }
          sendJson(res, 200, pricingSnapshot())
          return
        }
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return }
        if (!isTrustedLocalApiRequest(req, true) || !hasWriteToken(req, requestToken)) { rejectRequest(res); return }
        const body = await readBody(req, 256 * 1024)
        if (body.tooLarge) { sendJson(res, 413, { ok: false, message: 'request-too-large' }); return }
        let args = null
        try { args = JSON.parse(body.text) } catch (err) { /* invalid json */ }
        if (args === null || typeof args !== 'object' || Array.isArray(args)) { sendJson(res, 400, { ok: false, message: 'bad-pricing-request' }); return }
        const result = updatePricingState(args.pricing || args, args.backfill === true)
        await persistPricing()
        await ledgerWriteChain
        sendJson(res, 200, { ok: true, backfill: result, pricing: pricingSnapshot() })
      },
    }))
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/api/all-usage/pricing/sync',
      handler: async (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return }
        if (!isTrustedLocalApiRequest(req, true) || !hasWriteToken(req, requestToken)) { rejectRequest(res); return }
        const result = await syncPricing(true)
        sendJson(res, result.ok ? 200 : 502, result)
      },
    }))
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/api/all-usage/status',
      handler: (req, res) => {
        if (req.method !== 'GET') { res.statusCode = 405; res.end(); return }
        if (!isTrustedLocalApiRequest(req, false)) { rejectRequest(res); return }
        if (!scan.started) void runBaseline()
        sendJson(res, 200, statusSnapshot())
      },
    }))
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/api/all-usage',
      handler: (req, res) => {
        if (req.method !== 'GET') { res.statusCode = 405; res.end(); return }
        if (!isTrustedLocalApiRequest(req, false)) { rejectRequest(res); return }
        if (!scan.started) void runBaseline()
        sendJson(res, 200, snapshot())
      },
    }))
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/api/all-usage/balance',
      handler: async (req, res) => {
        if (req.method !== 'GET') { res.statusCode = 405; res.end(); return }
        // Browsers may omit Origin on same-origin GET; the process token remains required.
        if (!isTrustedLocalApiRequest(req, false) || !hasWriteToken(req, requestToken)) { rejectRequest(res); return }
        let force = false
        try {
          const url = new URL(req.url ?? '/', 'http://x')
          force = url.searchParams.get('force') === '1'
        } catch (err) { /* default */ }
        sendJson(res, 200, await fetchBalance(force))
      },
    }))
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/api/all-usage/alias',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end()
          return
        }
        if (!isTrustedLocalApiRequest(req, true) || !hasWriteToken(req, requestToken)) { rejectRequest(res); return }
        const body = await readBody(req, 16 * 1024)
        if (body.tooLarge) { sendJson(res, 413, { ok: false, message: 'request-too-large' }); return }
        let args = null
        try {
          args = JSON.parse(body.text)
        } catch (err) { /* invalid json */ }
        const validAliasRequest = args !== null && args !== undefined && typeof args === 'object' && !Array.isArray(args) && typeof args.workspaceId === 'string' && args.workspaceId.length > 0 && args.workspaceId.length <= 256 && typeof args.alias === 'string'
        const result = validAliasRequest
          ? setAlias(args.workspaceId, args.alias)
          : { ok: false, message: 'bad-request', aliases: Object.assign({}, aliases) }
        sendJson(res, result.ok ? 200 : 400, result)
      },
    }))
  }

  // ---------- start the historical backfill immediately ----------
  ledgerReady = loadLedger()
  pricingReady = loadPricing().then(() => { schedulePricingSync() })
  void runBaseline()
  scheduleReconcileTimer()
  aliasesReady = loadAliases()
}

export { name, inject, apply }
export default { name, inject, apply }
