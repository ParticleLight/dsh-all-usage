import { createHash } from 'node:crypto'
import { RETIRED_WORKSPACE_ID } from './ledger.js'
import { COST_SCHEMA_VERSION, addCostAccumulator, addCostAggregate, calculateCost, createCostAccumulator, decimalSubtract, isCostAccumulator, normalizeCostSnapshot, resolvePricing, serializeCostAggregate, temporalPlanFor } from './pricing.js'
import { contextTimeIsFresh, extractUsageEvent, normalizeEventSeq, normalizeUsageValues as usageValues, upsertUsageSample as upsertUsageSampleState, usageStepKey, validEventTime as validUsageEventTime } from './usage-core.js'

export function createAggregation(host) {
  const { state, markStatsChanged, commitPendingStats, resetSyncState } = host
  // Older hosts (and hand-built test states) predate the per-session digest and the
  // date -> sessions index the /records loader consults.
  if (!(state.perSession instanceof Map)) state.perSession = new Map()
  if (!(state.sessionsByLocalDate instanceof Map)) state.sessionsByLocalDate = new Map()
  if (!(state.sessionsByUtcDate instanceof Map)) state.sessionsByUtcDate = new Map()
  if (!(state.rowTouch instanceof Map)) state.rowTouch = new Map()
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
  // A per-session digest of everything that was folded in: the day/workspace/model
  // cubes can be unwound from it without the session's rows, which is what lets the
  // detail rows be dropped from memory and read back from disk on demand.
  function sessionAggregateFor(sid, create) {
    if (typeof sid !== 'string' || sid === '') return undefined
    let session = state.perSession.get(sid)
    if (session === undefined) {
      if (create !== true) return undefined
      session = { keys: new Map(), buckets: new Map() }
      state.perSession.set(sid, session)
    }
    return session
  }
  function pruneSessionAggregate(sid, session) {
    if (session === undefined) return
    if (session.keys.size === 0 && session.buckets.size === 0) state.perSession.delete(sid)
  }
  /**
   * How a row's cost was decided. A row stays resident only when something can still
   * change it: an unpriced row (backfill) or one priced from a request context that
   * had already gone stale (the temporal reconcile rewrites exactly those).
   */
  function pricingExposureOf(cost, eventTime) {
    const priced = cost !== null && cost !== undefined && cost.status === 'priced'
    let requestContext = 0
    if (cost !== null && cost !== undefined && cost.pricingTimeSource === 'request-context') {
      const at = cost.pricingAt
      requestContext = Number.isFinite(at) && contextTimeIsFresh(at, eventTime) ? 0 : 1
    }
    return { unpriced: priced ? 0 : 1, requestContext }
  }
  /** True when nothing about this session's rows can still change without a rebuild. */
  function sessionIsSettled(session) {
    for (const bucket of session.buckets.values()) if (bucket.unpriced > 0 || bucket.requestContext > 0) return false
    return true
  }
  // date -> session -> how many of that session's rows fall on the date. A
  // reference count, because a session usually has several rows in one day and a
  // plain Set would drop it after the first one is forgotten.
  function addSessionDate(index, date, sid) {
    if (typeof date !== 'string' || date === '' || typeof sid !== 'string' || sid === '') return
    let day = index.get(date)
    if (day === undefined) { day = new Map(); index.set(date, day) }
    day.set(sid, (day.get(sid) || 0) + 1)
  }
  function forgetSessionDate(index, date, sid) {
    const day = index.get(date)
    if (day === undefined) return
    const next = (day.get(sid) || 0) - 1
    if (next > 0) day.set(sid, next)
    else day.delete(sid)
    if (day.size === 0) index.delete(date)
  }
  function sessionBucketKey(entry) {
    // adjustUsage() already coerced the identity (66k rows per rebuild), so the key
    // takes the ready one when the caller has it.
    const identityKey = typeof entry.identityKey === 'string' && entry.identityKey !== '' ? entry.identityKey : coerceIdentity(entry.identity).identityKey
    return entry.date + '|' + entry.wsId + '|' + identityKey
  }
  /** Roll one usage row into its session's digest (both directions). */
  function adjustSessionUsage(sid, direction, entry) {
    const session = sessionAggregateFor(sid, direction === 1)
    if (session === undefined) return
    const key = sessionBucketKey(entry)
    let bucket = session.buckets.get(key)
    if (bucket === undefined) {
      if (direction !== 1) return
      bucket = {
        time: entry.time,
        date: entry.date,
        dateUtc: entry.dateUtc,
        wsId: entry.wsId,
        identity: coerceIdentity(entry.identity),
        calls: 0,
        unpriced: 0,
        requestContext: 0,
        turns: new Map(),
        values: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        cost: createCostAccumulator(),
      }
      session.buckets.set(key, bucket)
    }
    bucket.calls += direction
    const exposure = pricingExposureOf(entry.cost, entry.time)
    bucket.unpriced += direction * exposure.unpriced
    bucket.requestContext += direction * exposure.requestContext
    adjustValues(bucket.values, entry.values, direction)
    addCostAggregateDirection(bucket.cost, entry.cost, direction)
    if (entry.turn !== null && entry.turn !== undefined) {
      const turnKey = String(sid) + ':turn:' + String(entry.turn)
      const next = (bucket.turns.get(turnKey) || 0) + direction
      if (next > 0) bucket.turns.set(turnKey, next)
      else bucket.turns.delete(turnKey)
    }
    if (bucket.calls <= 0 && noValues(bucket.values)) session.buckets.delete(key)
    pruneSessionAggregate(sid, session)
  }
  /**
   * Only the cost changed (a backfill or re-price): keep the session digest's
   * bucket in step, or a later removal would unwind the stale amount.
   */
  function adjustSessionCostOnly(item, cost, direction) {
    if (item === null || item === undefined || typeof item.sid !== 'string' || item.sid === '') return
    const session = sessionAggregateFor(item.sid, false)
    if (session === undefined) return
    const identity = coerceIdentity(item.identity || item.modelId)
    const dates = typeof item.date === 'string' && typeof item.dateUtc === 'string' ? { local: item.date, utc: item.dateUtc } : dateKeys(item.time)
    const bucket = session.buckets.get(dates.local + '|' + item.wsId + '|' + identity.identityKey)
    if (bucket === undefined) return
    const exposure = pricingExposureOf(cost, item.time)
    bucket.unpriced += direction * exposure.unpriced
    bucket.requestContext += direction * exposure.requestContext
    addCostAggregateDirection(bucket.cost, cost, direction)
  }
  function recordSessionKey(item) {
    const session = sessionAggregateFor(item.sid, true)
    if (session === undefined) return
    session.keys.set(item.key, { date: item.date, dateUtc: item.dateUtc })
    // which sessions have rows on a date: the disk lookup for /records starts here
    addSessionDate(state.sessionsByLocalDate, item.date, item.sid)
    addSessionDate(state.sessionsByUtcDate, item.dateUtc, item.sid)
    if (state.rowTouch instanceof Map) state.rowTouch.set(item.sid, (state.rowTouch.get(item.sid) || 0) + 1)
  }
  function forgetSessionKey(item) {
    const session = sessionAggregateFor(item.sid, false)
    if (session === undefined) return
    session.keys.delete(item.key)
    if (state.sessionsByLocalDate instanceof Map) forgetSessionDate(state.sessionsByLocalDate, item.date, item.sid)
    if (state.sessionsByUtcDate instanceof Map) forgetSessionDate(state.sessionsByUtcDate, item.dateUtc, item.sid)
    pruneSessionAggregate(item.sid, session)
  }
  /** The resident detail-row budget; the rest lives in the ledger on disk. */
  function residentRowBudget() {
    const configured = Number(process.env.DSH_ALL_USAGE_RESIDENT_ROWS)
    if (Number.isFinite(configured)) return Math.floor(configured)
    return 12000
  }
  function rowIsProtected(sid) {
    if (state.ledgerDirtySessions instanceof Set && state.ledgerDirtySessions.has(sid)) return true
    if (state.ledgerPending instanceof Map && state.ledgerPending.has(sid)) return true
    if (state.liveResyncPending instanceof Set && state.liveResyncPending.has(sid)) return true
    if (state.ledgerPrefetching instanceof Set && state.ledgerPrefetching.has(sid)) return true
    return false
  }
  /**
   * Drop the detail rows of sessions whose contribution is already in the cubes and
   * whose pricing is final. The digest keeps such a session removable, and the rows
   * are read back from the ledger when a query or a rebuild asks for them.
   */
  function evictColdRows(options) {
    bumpCount('evict.runs')
    const requested = options !== null && options !== undefined ? options.rows : undefined
    const budget = Number.isFinite(requested) ? Math.floor(requested) : residentRowBudget()
    const keep = options !== null && options !== undefined && options.keep instanceof Set ? options.keep : null
    if (!(state.usageByStep instanceof Map)) return { sessions: 0, rows: 0 }
    // A negative budget keeps every row resident (the pre-eviction behaviour).
    if (budget < 0) return { sessions: 0, rows: 0 }
    if (state.usageByStep.size <= budget) return { sessions: 0, rows: 0 }
    const candidates = []
    for (const [sid, session] of state.perSession) {
      if (session.keys.size === 0) continue
      if (keep !== null && keep.has(sid)) continue
      if (rowIsProtected(sid)) continue
      candidates.push([sid, state.rowTouch instanceof Map ? (state.rowTouch.get(sid) || 0) : 0])
    }
    // Least recently folded first: the rows of the sessions the scan is working
    // through stay, and only rows whose cost is final are dropped, so a session with
    // one unsettled row keeps just that row.
    candidates.sort((left, right) => left[1] - right[1])
    const startSize = state.usageByStep.size
    let sessions = 0
    let rows = 0
    for (const [sid] of candidates) {
      if (startSize - rows <= budget) break
      const session = state.perSession.get(sid)
      if (session === undefined) continue
      let dropped = 0
      for (const key of session.keys.keys()) {
        const item = state.usageByStep.get(key)
        if (item === undefined) continue
        const exposure = pricingExposureOf(item.cost, item.time)
        if (exposure.unpriced > 0 || exposure.requestContext > 0) continue
        if (state.usageByStep.delete(key)) dropped += 1
      }
      if (dropped > 0) sessions += 1
      rows += dropped
    }
    return { sessions, rows }
  }
  /** The sessions that own at least one row on a date inside the range. */
  function sessionsForRange(utc, start, end) {
    const index = utc === true ? state.sessionsByUtcDate : state.sessionsByLocalDate
    const result = new Set()
    if (!(index instanceof Map)) return result
    for (const [date, day] of index) {
      if (typeof start === 'string' && start !== '' && date < start) continue
      if (typeof end === 'string' && end !== '' && date > end) continue
      // The day is a Map of session id -> row count, so its keys are the sessions.
      for (const sid of day.keys()) result.add(sid)
    }
    return result
  }
  /** One usage row, built the same way whether it is folded or read back. */
  function usageRowOf(record, item, materialization) {
    const identity = item.identity || identityFromLegacy(item.modelId)
    const dates = dateKeys(item.time)
    return {
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
    }
  }
  /**
   * Put a row back for a query without touching the cubes: they already hold its
   * contribution, so it is data for the log view and nothing else.
   */
  function adoptUsageRow(row) {
    if (row === null || row === undefined || typeof row.key !== 'string' || row.key === '') return false
    if (state.usageByStep.has(row.key)) return false
    state.usageByStep.set(row.key, row)
    bumpCount('row.adopted')
    return true
  }
  /**
   * Fold one row into the cubes, unless the digest says it is already in them. That
   * is what makes applying a record idempotent once its rows may have been dropped.
   */
  function foldUsageRow(row, materialization) {
    if (row === null || row === undefined || typeof row.key !== 'string' || row.key === '') return false
    const session = sessionAggregateFor(row.sid, false)
    if (session !== undefined && session.keys.has(row.key)) { bumpCount('fold.skipped'); return false }
    bumpCount('fold.folded')
    const candidate = materialization === undefined || materialization === null || row.materialization === materialization ? row : { ...row, materialization }
    const result = upsertUsageSample(state.usageByStep, candidate)
    return result !== null && result !== undefined && result.accepted === true
  }
  function indexUsage(item) {
    addDateIndex(state.usageByLocalDate, item.date, item.key)
    addDateIndex(state.usageByUtcDate, item.dateUtc, item.key)
    recordSessionKey(item)
  }
  function unindexUsage(item) {
    removeDateIndex(state.usageByLocalDate, item.date, item.key)
    removeDateIndex(state.usageByUtcDate, item.dateUtc, item.key)
    forgetSessionKey(item)
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
  function costForUsage(values, identity, previous, pricingAt, pricingTimeSource) {
    const previousCost = normalizeCostSnapshot(previous && previous.cost)
    if (previousCost !== null && previousCost.pricingMode === 'official-model' && previousCost.pricingTimeSource !== 'legacy-unknown' && usageBasisEqual(previous, identity, values) && costTemporalCompatible(previousCost, identity, pricingAt, pricingTimeSource)) return previousCost
    return calculateCost(values, resolveCurrentPricing(identity), pricingAt, pricingTimeSource)
  }
  function costTemporalCompatible(previousCost, identity, pricingAt, pricingTimeSource) {
    if (previousCost.pricingAt === null || previousCost.pricingTimeSource === null) return false
    const resolved = resolveCurrentPricing(identity)
    const plan = temporalPlanFor(resolved, pricingAt)
    const normalizedAt = Number.isFinite(pricingAt) && pricingAt >= 0 ? Math.trunc(pricingAt) : null
    const normalizedSource = pricingTimeSource === 'request-context' || pricingTimeSource === 'usage-event' ? pricingTimeSource : 'usage-event'
    return previousCost.pricingBand === plan.band && previousCost.pricingPolicyId === plan.policyId && previousCost.pricingPolicyHash === plan.policyHash && previousCost.pricingTimezone === plan.timezone && previousCost.temporalApplicable === (plan.status === 'applied') && previousCost.temporalExemptReason === plan.exemptReason && previousCost.pricingAt === normalizedAt && previousCost.pricingTimeSource === normalizedSource
  }
  function resetAggregationState() {
    state.aggregationGeneration += 1
    state.wsMeta.clear()
    if (state.sessionContextTimes) state.sessionContextTimes.clear()
    state.pathIndex.clear()
    state.memberOf.clear()
    state.byDay.clear()
    state.byDayUtc.clear()
    state.perWorkspace.clear()
    // The deleted bucket is re-derived from the ledger during the rebuild that
    // follows, so a stale flag cannot advertise an empty row.
    state.retiredBucketUsed = false
    state.perModel.clear()
    state.usageByStep.clear()
    if (state.perSession instanceof Map) state.perSession.clear()
    if (state.sessionsByLocalDate instanceof Map) state.sessionsByLocalDate.clear()
    if (state.sessionsByUtcDate instanceof Map) state.sessionsByUtcDate.clear()
    if (state.rowTouch instanceof Map) state.rowTouch.clear()
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
    bumpCount(direction === 1 ? 'query.add' : 'query.sub')
    const identity = coerceIdentity(item.identity || item.modelId)
    // A subtraction has to land even when the bucket is gone: taking the row back out
    // of the cube is what keeps it honest. The old code returned early when the
    // workspace or bucket was missing, so the amounts it had added stayed in the cube
    // for ever - the current day's query cube drifted several times above the day
    // cube that way. Buckets are also no longer deleted when they empty, so a later
    // subtraction still finds them.
    const workspace = queryWorkspaceMap(root, item.wsId, true)
    if (workspace === undefined) return
    let bucket = workspace.get(identity.identityKey)
    if (bucket === undefined) { bucket = queryUsageMetric(identity); workspace.set(identity.identityKey, bucket) }
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
  }
  /** The trailing segment of "<sid>:turn:<n>" as a number, or null. */
  function turnNumberOf(turnKey) {
    const at = typeof turnKey === 'string' ? turnKey.lastIndexOf(':') : -1
    if (at < 0) return null
    const value = Number(turnKey.slice(at + 1))
    return Number.isSafeInteger(value) && value >= 0 ? value : null
  }
  /**
   * Drop the turn-key reference a usage row left behind in a query bucket, without
   * touching that bucket's calls/tokens/cost (the caller already did that).
   */
  function adjustQueryUsageTurnRefs(day, item, direction, utc) {
    if (day === undefined) return
    adjustQueryTurnRefsMap(day.queryUsage, item, direction)
    adjustQueryTurnRefsMap(ensureQueryHour(day, hourStartOf(item.time, utc)).usage, item, direction)
  }
  function adjustQueryTurnRefsMap(root, item, direction) {
    const identity = coerceIdentity(item.identity || item.modelId)
    const workspace = queryWorkspaceMap(root, item.wsId, direction === 1)
    if (workspace === undefined) return
    const bucket = workspace.get(identity.identityKey)
    if (bucket === undefined) return
    if (item.turn === null || item.turn === undefined) return
    const turnKey = String(item.sid) + ':turn:' + String(item.turn)
    const current = bucket.turnKeyRefs.get(turnKey) || 0
    const next = current + direction
    if (next > 0) { bucket.turnKeyRefs.set(turnKey, next); bucket.turnKeys.add(turnKey) }
    else { bucket.turnKeyRefs.delete(turnKey); bucket.turnKeys.delete(turnKey) }
  }
  function ensureQueryHour(day, hour) {
    let value = day.queryHours.get(hour)
    if (value === undefined) { value = { usage: new Map(), turns: new Map() }; day.queryHours.set(hour, value) }
    return value
  }
  function adjustQueryUsage(day, item, direction, utc) {
    if (day === undefined) return
    // Scoped to the day the add lands on, so the total can be compared with what the
    // root actually holds (and with the day cube the same row also feeds).
    bumpSum('q.' + (utc ? 'utc' : 'local') + '.' + (utc ? item.dateUtc : item.date), direction * ((item.values && item.values.input) || 0))
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
  function bumpCount(name, amount = 1) {
    if (!(state.diagCounters instanceof Map)) state.diagCounters = new Map()
    state.diagCounters.set(name, (state.diagCounters.get(name) || 0) + amount)
  }
  function bumpSum(name, amount) {
    if (!Number.isFinite(amount) || amount === 0) return
    if (!(state.diagSums instanceof Map)) state.diagSums = new Map()
    state.diagSums.set(name, (state.diagSums.get(name) || 0) + amount)
  }
  /**
   * What the accounting added versus what it holds. The two must agree; when they do
   * not, the difference names the layer that loses or duplicates a row.
   */
  function accountingSnapshot() {
    const todayKey = dayKey(Date.now())
    const day = state.byDay.get(todayKey)
    let queryInput = 0
    let queryCalls = 0
    let queryBuckets = 0
    if (day !== undefined && day.queryUsage instanceof Map) {
      const seen = new Set()
      for (const models of day.queryUsage.values()) {
        queryBuckets += models.size
        for (const bucket of models.values()) {
          if (seen.has(bucket)) continue
          seen.add(bucket)
          queryInput += bucket.input
          queryCalls += bucket.calls
        }
      }
    }
    return {
      date: todayKey,
      added: Object.fromEntries(state.diagSums instanceof Map ? state.diagSums : []),
      dayTokensInput: day === undefined ? null : day.tokens.input,
      dayCalls: day === undefined || !(day.byModel instanceof Map) ? null : Array.from(day.byModel.values()).reduce((acc, row) => acc + (row.calls || 0), 0),
      queryRootInput: queryInput,
      queryRootCalls: queryCalls,
      queryBuckets,
      residentRows: state.usageByStep instanceof Map ? state.usageByStep.size : null,
    }
  }
  function adjustUsage(wsId, time, values, identity, direction, sid, cachedDates, cost) {
    bumpCount(direction === 1 ? 'day.add' : 'day.sub')
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
    adjustSessionUsage(sid, direction, { time, date: dates.local, dateUtc: dates.utc, wsId, identity: normalized, identityKey: normalized.identityKey, values, cost, turn: null })
  }
  /**
   * Undo one session's contribution. The per-session digest describes it without
   * the rows, so a session whose detail rows were evicted still unwinds exactly;
   * a session that only ever existed as rows (a hand-built test state) falls back
   * to the row walk.
   */
  function removeSession(sid) {
    if (typeof sid !== 'string' || sid === '') return 0
    let removed = 0
    const session = sessionAggregateFor(sid, false)
    if (session !== undefined) {
      for (const bucket of session.buckets.values()) {
        const identity = coerceIdentity(bucket.identity)
        adjustUsage(bucket.wsId, bucket.time, bucket.values, identity, -1, sid, { local: bucket.date, utc: bucket.dateUtc }, bucket.cost)
        const item = { sid, wsId: bucket.wsId, time: bucket.time, values: bucket.values, identity, cost: bucket.cost, turn: null }
        adjustQueryUsage(state.byDay.get(bucket.date), item, -1, false)
        adjustQueryUsage(state.byDayUtc.get(bucket.dateUtc), item, -1, true)
        for (const turnKey of bucket.turns.keys()) {
          const turnItem = { sid, wsId: bucket.wsId, time: bucket.time, identity, turn: turnNumberOf(turnKey) }
          adjustQueryUsageTurnRefs(state.byDay.get(bucket.date), turnItem, -1, false)
          adjustQueryUsageTurnRefs(state.byDayUtc.get(bucket.dateUtc), turnItem, -1, true)
        }
        removed += bucket.calls
      }
      for (const [key, dates] of session.keys) {
        state.usageByStep.delete(key)
        removeDateIndex(state.usageByLocalDate, dates.date, key)
        removeDateIndex(state.usageByUtcDate, dates.dateUtc, key)
        if (state.sessionsByLocalDate instanceof Map) forgetSessionDate(state.sessionsByLocalDate, dates.date, sid)
        if (state.sessionsByUtcDate instanceof Map) forgetSessionDate(state.sessionsByUtcDate, dates.dateUtc, sid)
      }
      if (state.rowTouch instanceof Map) state.rowTouch.delete(sid)
      state.perSession.delete(sid)
    } else {
      const usageKeys = []
      for (const [key, item] of state.usageByStep) if (item.sid === sid) usageKeys.push([key, item])
      for (const [key, item] of usageKeys) {
        unindexUsage(item)
        adjustUsage(item.wsId, item.time, item.values, item.identity || item.modelId, -1, sid, { local: item.date, utc: item.dateUtc }, item.cost)
        adjustQueryUsage(state.byDay.get(item.date), item, -1, false)
        adjustQueryUsage(state.byDayUtc.get(item.dateUtc), item, -1, true)
        state.usageByStep.delete(key)
        removed += 1
      }
    }
    const turnKeys = []
    for (const [key, turn] of state.turnRecords) if (turn.sid === sid) turnKeys.push([key, turn])
    for (const [key, turn] of turnKeys) {
      removeTurnRecord(turn)
      state.turnRecords.delete(key)
      removed += 1
    }
    state.sessionContextTimes.delete(sid)
    state.sessionModel.delete(sid)
    if (removed > 0) markStatsChanged('data')
    return removed
  }
  // Re-key every aggregate entry owned by one session to another workspace id.
  //
  // Retiring a workspace cannot rely on the ledger alone: usage folded from the
  // live feed in the last few milliseconds has no persisted row yet, so it would
  // keep a workspace id the dashboard no longer advertises. Moving the in-memory
  // records keeps the totals, the per-workspace split and the query buckets
  // consistent no matter when the workspace disappears.
  function retargetSession(sid, workspaceId) {
    if (typeof sid !== 'string' || sid === '' || typeof workspaceId !== 'string' || workspaceId === '') return 0
    let moved = 0
    for (const item of state.usageByStep.values()) {
      if (item.sid !== sid || item.wsId === workspaceId) continue
      const previousWs = item.wsId
      const identity = item.identity || item.modelId
      const dates = { local: item.date, utc: item.dateUtc }
      // Decrement under the old workspace, then increment under the new one: the
      // session, model and global totals cancel out exactly.
      adjustUsage(previousWs, item.time, item.values, identity, -1, sid, dates, item.cost)
      adjustQueryUsage(state.byDay.get(item.date), item, -1, false)
      adjustQueryUsage(state.byDayUtc.get(item.dateUtc), item, -1, true)
      item.wsId = workspaceId
      adjustUsage(workspaceId, item.time, item.values, identity, 1, sid, dates, item.cost)
      adjustQueryUsage(state.byDay.get(item.date), item, 1, false)
      adjustQueryUsage(state.byDayUtc.get(item.dateUtc), item, 1, true)
      moved += 1
    }
    for (const turn of state.turnRecords.values()) {
      if (turn.sid !== sid || turn.wsId === workspaceId) continue
      removeTurnRecord(turn)
      turn.wsId = workspaceId
      ensureWs(workspaceId).turns += 1
      state.totals.turns += 1
      addDayTurn(state.byDay, turn.date, workspaceId, turn.sid, 1)
      addDayTurn(state.byDayUtc, turn.dateUtc, workspaceId, turn.sid, 1)
      adjustQueryTurn(state.byDay.get(turn.date), turn, 1, false)
      adjustQueryTurn(state.byDayUtc.get(turn.dateUtc), turn, 1, true)
      moved += 1
    }
    if (moved > 0) markStatsChanged('data')
    return moved
  }
  function upsertUsageSample(target, sample, options = {}) {
    const previous = target.get(sample.key)
    const candidate = sample.cost === undefined
      ? { ...sample, cost: costForUsage(sample.values, sample.identity, options.costPrevious === undefined ? previous : options.costPrevious, sample.pricingAt, sample.pricingTimeSource) }
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
  function addUsage(wsId, time, usage, model, sid, data, seq, materialization = 'live', pricingAt, pricingTimeSource) {
    bumpCount('live.addUsage')
    if (!validEventTime(time)) return
    const values = usageValues(usage)
    if (values === null || noValues(values)) return
    const identity = coerceIdentity(model)
    const eventSeq = normalizeEventSeq(seq)
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
      ...(pricingAt === undefined ? {} : { pricingAt }),
      ...(pricingTimeSource === undefined ? {} : { pricingTimeSource }),
    })
  }
  function addDayTurn(dayMap, date, wsId, sid, direction = 1) {
    const day = ensureDay(dayMap, date)
    adjustDaySession(day, sid, direction)
    day.turns = Math.max(0, day.turns + direction)
    const next = (day.perWs.get(wsId) || 0) + direction
    if (next > 0) day.perWs.set(wsId, next)
    else day.perWs.delete(wsId)
  }
  function removeTurnRecord(turn) {
    const ws = state.perWorkspace.get(turn.wsId)
    if (ws !== undefined) ws.turns = Math.max(0, ws.turns - 1)
    state.totals.turns = Math.max(0, state.totals.turns - 1)
    addDayTurn(state.byDay, turn.date, turn.wsId, turn.sid, -1)
    addDayTurn(state.byDayUtc, turn.dateUtc, turn.wsId, turn.sid, -1)
    adjustQueryTurn(state.byDay.get(turn.date), turn, -1, false)
    adjustQueryTurn(state.byDayUtc.get(turn.dateUtc), turn, -1, true)
  }
  function turnRecordKey(sid, turn, seq, time) {
    if (Number.isSafeInteger(turn)) return sid + ':turn:' + turn
    if (Number.isSafeInteger(seq) && seq >= 0) return sid + ':event:' + seq
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
    return {
      instanceId: state.instanceId,
      // The write capability is minted per plugin apply, so a reload rotates it
      // without moving the process instance id or any revision. The status poll
      // carries only this derived id (never the capability itself), which is enough
      // for the page to notice the rotation and re-fetch the full snapshot.
      capabilityId: state.capabilityId,
      pluginVersion: state.pluginVersion,
      ...revisionSnapshot(),
      updatedAt: state.statsUpdatedAt,
      scan: scanSnapshot(),
      sync: syncSnapshot(),
      clientEnv: state.clientEnv,
      // What the plugin itself is holding, so the residency policy can be checked
      // from the outside instead of guessed from the host process.
      counters: Object.fromEntries(state.diagCounters instanceof Map ? state.diagCounters : []),
      accounting: accountingSnapshot(),
      memory: {
        heapUsedMB: Number((process.memoryUsage().heapUsed / 1048576).toFixed(1)),
        rssMB: Number((process.memoryUsage().rss / 1048576).toFixed(1)),
        residentRows: state.usageByStep instanceof Map ? state.usageByStep.size : 0,
        residentRecords: state.ledgerRecords instanceof Map ? state.ledgerRecords.size : 0,
        recordCacheMB: Number(((state.ledgerRecordBytes || 0) / 1048576).toFixed(1)),
        sessions: state.perSession instanceof Map ? state.perSession.size : 0,
      },
    }
  }
  function serializeIdentity(identity) {
    const value = coerceIdentity(identity)
    return { identityKey: value.identityKey, provider: value.provider, requestedModel: value.requestedModel, actualModel: value.actualModel, model: value.label, legacy: value.legacy }
  }
  function serializeModelAggregate(item) {
    return { ...serializeIdentity(item), calls: item.calls, input: item.input, output: item.output, cacheRead: item.cacheRead, cacheWrite: item.cacheWrite, reasoning: item.reasoning, cost: serializeCostAggregate(item.cost) }
  }
  // Per-day session ids are the only part of a snapshot row that grows with the
  // number of sessions rather than the number of days, and the panel only needs
  // them for recent history (the request log for an old day is fetched on
  // demand). Older rows keep their count and scope session ids, so the payload
  // stops carrying every session id ever recorded.
  const SNAPSHOT_SESSION_WINDOW_DAYS = 180
  function serializeDays(dayMap, sessionWindowStart) {
    const result = []
    for (const pair of dayMap) {
      const date = pair[0]
      const day = pair[1]
      result.push({
        date,
        turns: day.turns,
        sessions: day.sessionIds.size,
        // Time-based so the local and UTC copies window identically.
        sessionIds: sessionWindowStart !== undefined && calendarStartOf(date, false) < sessionWindowStart ? [] : Array.from(day.sessionIds).sort(),
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
  function snapshot(utc = null) {
    commitPendingStats()
    const generatedAt = Date.now()
    const cacheKey = utc === null ? 'both' : (utc ? 'utc' : 'local')
    if (state.snapshotCache !== null && state.snapshotCache.revision === state.statsRevision && state.snapshotCache.key === cacheKey) return Object.assign({}, state.snapshotCache.value, { generatedAt })
    const windowStart = Date.now() - SNAPSHOT_SESSION_WINDOW_DAYS * 86400000
    const value = {
      ...statusSnapshot(),
      generatedAt,
      usageSchemaVersion: 3,
      costSchemaVersion: COST_SCHEMA_VERSION,
      requestToken: state.requestToken,
      workspaces: [
        ...Array.from(state.wsMeta.values(), (w) => ({ id: w.id, title: w.title, path: w.path })),
        ...(state.retiredBucketUsed ? [{ id: RETIRED_WORKSPACE_ID, title: '', path: '', deleted: true, retiredBucket: true }] : []),
      ],
      aliases: Object.assign({}, state.aliases),
      pricing: pricingSnapshot({ detailed: false }),
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
      byDay: utc === true ? [] : serializeDays(state.byDay, windowStart),
      byDayUtc: utc === false ? [] : serializeDays(state.byDayUtc, windowStart),
    }
    state.snapshotCache = { revision: state.statsRevision, key: cacheKey, value }
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
  /**
   * The same model is often served through several routes, whose ids differ only by
   * a vendor namespace or letter case (`deepseek-v4.1-flash` versus
   * `deepseek/deepseek-v4.1-flash`). A model filter is about the model, so it
   * compares this key: the last path segment, lowercased. The exact identity key
   * still matches, which keeps a stored route-level value working.
   */
  function modelNameKeyOf(value) {
    if (typeof value !== 'string') return ''
    const text = value.trim()
    if (text === '') return ''
    const slash = text.lastIndexOf('/')
    return (slash >= 0 ? text.slice(slash + 1) : text).trim().toLowerCase()
  }
  function identityMatchesScope(identity, scope) {
    const normalized = coerceIdentity(identity)
    if (scope.provider !== undefined && scope.provider !== null && normalized.provider !== scope.provider) return false
    if (scope.modelKey !== undefined && scope.modelKey !== null) {
      const wanted = String(scope.modelKey)
      const byIdentity = normalized.identityKey === wanted
      const byName = modelNameOfIdentity(normalized) === wanted
      const byModelKey = modelNameKeyOf(modelNameOfIdentity(normalized)) === modelNameKeyOf(wanted) && modelNameKeyOf(wanted) !== ''
      if (!byIdentity && !byName && !byModelKey) return false
    }
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
    // The source's numbers are copied first, and its cost is only merged when it is
    // not the same accumulator: a bucket must never be able to aggregate into
    // itself. That aliasing is what let the current day's query numbers run away -
    // every fresh read doubled what the previous one had left behind.
    const calls = bucket.calls
    const values = { input: bucket.input, output: bucket.output, cacheRead: bucket.cacheRead, cacheWrite: bucket.cacheWrite, reasoning: bucket.reasoning }
    target.calls += calls
    mergeQuerySessions(target, bucket.sessions)
    addQueryTokens(target, values)
    if (target.cost !== bucket.cost) addCostAccumulator(target.cost, bucket.cost)
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
    if (utc) return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours())
    // Reconstructing a local hour with new Date(y, m, d, h) collapses a DST
    // fall-back twice-repeated hour (both 01:xx map to the first occurrence).
    // Instead align the instant to the local hour boundary using the offset
    // that applied at that instant, keeping repeated local hours distinct.
    const offset = date.getTimezoneOffset()
    const shifted = time - offset * 60000
    return Math.floor(shifted / HOUR_MS) * HOUR_MS + offset * 60000
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
    const indexHours = new Map()
    const metricFor = (hour) => {
      // Zone offsets are not always whole hours (Lord Howe +10:30/+11), so a
      // floor can drop or merge fractional-hour buckets; round and clamp keeps
      // every event inside the requested range without losing rows.
      const index = Math.min(range.count - 1, Math.max(0, Math.round((hour - range.start) / HOUR_MS)))
      if (index < 0 || index >= range.count) return null
      const previousHour = indexHours.get(index)
      if (previousHour === undefined || hour < previousHour) indexHours.set(index, hour)
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
    // Emit the real bucket boundary when the bucket was rounded into this slot;
    // the uniform grid only labels empty slots, so fractional-hour zones keep
    // exact labels instead of drifting 30 minutes off.
    return Array.from({ length: range.count }, (_, index) => serializeTrendMetric(indexHours.has(index) ? indexHours.get(index) : range.start + index * HOUR_MS, buckets.get(index)))
  }
  function queryUsageScope(scope) {
    bumpCount('read.queryUsageScope')
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
      // A bucket is counted once per day, whatever the workspace map it hangs under:
      // the same object can be reachable from two keys after a session is moved.
      const countedBuckets = new Set()
      for (const [workspaceId, models] of day.queryUsage) {
        if (scope.workspaceId !== undefined && scope.workspaceId !== null && workspaceId !== scope.workspaceId) continue
        for (const bucket of models.values()) {
          if (bucket.calls <= 0 && noValues(bucket)) continue
          if (countedBuckets.has(bucket)) continue
          countedBuckets.add(bucket)
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
  async function queryRecords(scope, cursor, limit) {
    bumpCount('read.queryRecords')
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
      // The detail rows of an old session are not resident: read the sessions that
      // own rows in this range back from the ledger first (they are inert here, the
      // cubes already hold their contribution).
      if (host.ledger !== undefined && typeof host.ledger.loadRowsForRange === 'function') {
        await host.ledger.loadRowsForRange(scope.utc === true, scope.start, scope.end)
      }
      const index = scope.utc ? state.usageByUtcDate : state.usageByLocalDate
      rows = indexedEntriesInRange(index, state.usageByStep, scope.start, scope.end).filter(({ item }) => {
        if (scope.workspaceId !== undefined && scope.workspaceId !== null && item.wsId !== scope.workspaceId) return false
        return identityMatchesScope(item.identity || item.modelId, scope)
      })
      rows.sort((left, right) => recordOrder(left.item, right.item))
      state.recordsQueryCache.set(cacheKey, rows)
      while (state.recordsQueryCache.size > 20) state.recordsQueryCache.delete(state.recordsQueryCache.keys().next().value)
      // The list holds what the page needs; the resident rows can go again.
      evictColdRows()
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
    removeSession,
    retargetSession,
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
    adjustSessionCostOnly,
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
    queryRecords,
    // Used by the ledger: one row, built the same way whether it is folded or
    // read back from its document for a query.
    usageRowOf,
    foldUsageRow,
    adoptUsageRow,
    sessionsForRange,
    evictColdRows
  }
}
