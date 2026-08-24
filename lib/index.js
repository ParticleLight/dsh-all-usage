// dsh-all-usage 插件 Host 半（永久版）
// 数据聚合 + 账户余额 + 工作区别名持久化，通过 webServer 路由向客户端提供数据。
import { randomBytes, timingSafeEqual } from 'node:crypto'

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
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size <= maxBytes) chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(''))
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
  const sessionModel = new Map()
  const totals = { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
  const sessionCount = new Set()
  const sessionSeq = new Map()
  const chains = new Map()
  const scan = { started: false, done: false, scanned: 0, total: 0, failed: 0 }
  const aliases = {}
  let kvUnit = null
  let aliasWriteChain = Promise.resolve()
  let balanceCache = { fetchedAt: 0, payload: null }
  const requestToken = randomBytes(32).toString('base64url')
  const ledgerRecords = new Map()
  let ledgerUnit = null
  let ledgerReady = Promise.resolve()
  let ledgerWriteChain = Promise.resolve()
  const LEDGER_VERSION = 1
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
  function num(v) {
    return typeof v === 'number' && Number.isFinite(v) ? v : 0
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
    scan.started = false
    scan.done = false
    scan.scanned = 0
    scan.total = 0
    scan.failed = 0
    baselineRetryDelay = 1000
    return aggregationGeneration
  }
  function ensureDay(dayMap, date) {
    let day = dayMap.get(date)
    if (day === undefined) {
      day = { turns: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, perWs: new Map(), byWs: new Map(), byModel: new Map(), sessionIds: new Set() }
      dayMap.set(date, day)
    }
    return day
  }
  function ensureWs(wsId) {
    let ws = perWorkspace.get(wsId)
    if (ws === undefined) {
      ws = { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
      perWorkspace.set(wsId, ws)
    }
    return ws
  }
  function ensureDayWs(day, wsId) {
    let w = day.byWs.get(wsId)
    if (w === undefined) {
      w = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
      day.byWs.set(wsId, w)
    }
    return w
  }
  function ensureModel(model) {
    let item = perModel.get(model)
    if (item === undefined) {
      item = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
      perModel.set(model, item)
    }
    return item
  }
  function ensureDayModel(day, model) {
    let item = day.byModel.get(model)
    if (item === undefined) {
      item = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
      day.byModel.set(model, item)
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
  function adjustDay(dayMap, date, wsId, values, modelId, direction, sid) {
    const day = ensureDay(dayMap, date)
    if (sid !== undefined && sid !== null) day.sessionIds.add(sid)
    adjustValues(day.tokens, values, direction)
    const dayWs = ensureDayWs(day, wsId)
    adjustValues(dayWs, values, direction)
    if (noValues(dayWs)) day.byWs.delete(wsId)
    const dayModel = ensureDayModel(day, modelId)
    dayModel.calls += direction
    adjustValues(dayModel, values, direction)
    if (dayModel.calls === 0 && noValues(dayModel)) day.byModel.delete(modelId)
  }
  function adjustUsage(wsId, time, values, modelId, direction, sid) {
    const modelTotals = ensureModel(modelId)
    modelTotals.calls += direction
    adjustValues(modelTotals, values, direction)
    if (modelTotals.calls === 0 && noValues(modelTotals)) perModel.delete(modelId)
    adjustValues(totals, values, direction)
    const ws = ensureWs(wsId)
    adjustValues(ws, values, direction)
    adjustDay(byDay, dayKey(time), wsId, values, modelId, direction, sid)
    adjustDay(byDayUtc, dayKeyUtc(time), wsId, values, modelId, direction, sid)
  }
  function usageStepKey(sid, data, seq) {
    const turn = data && typeof data.turn === 'number' ? data.turn : null
    const step = data && typeof data.step === 'number' ? data.step : null
    if (turn !== null && step !== null) return sid + ':step:' + turn + ':' + step
    return sid + ':event:' + (typeof seq === 'number' ? seq : String(Date.now()))
  }
  function addUsage(wsId, time, usage, model, sid, data, seq) {
    const values = usageValues(usage)
    const modelId = typeof model === 'string' && model !== '' ? model : '未知模型（历史记录缺少路由）'
    const eventSeq = typeof seq === 'number' ? seq : -1
    // v1.0.7: a usage event carrying no billable token in any bucket must not add a
    // meaningless row nor wipe previously recorded real usage (cc-switch
    // has_billable_tokens parity). Pure cache-read requests are billable and pass.
    if (noValues(values)) return
    const key = usageStepKey(sid, data, seq)
    const previous = usageByStep.get(key)
    // A late replay of an older raw event cannot replace the canonical later step.
    if (previous !== undefined && eventSeq >= 0 && previous.seq > eventSeq) return
    if (previous !== undefined) adjustUsage(previous.wsId, previous.time, previous.values, previous.modelId, -1, previous.sid)
    const next = { seq: eventSeq, wsId, time, values, modelId, sid }
    usageByStep.set(key, next)
    adjustUsage(wsId, time, values, modelId, 1, sid)
  }
  function addDayTurn(dayMap, date, wsId, sid) {
    const day = ensureDay(dayMap, date)
    if (sid !== undefined && sid !== null) day.sessionIds.add(sid)
    day.turns += 1
    day.perWs.set(wsId, (day.perWs.get(wsId) || 0) + 1)
  }
  function addTurn(wsId, time, sid) {
    ensureWs(wsId).turns += 1
    totals.turns += 1
    addDayTurn(byDay, dayKey(time), wsId, sid)
    addDayTurn(byDayUtc, dayKeyUtc(time), wsId, sid)
  }
  function routeLabel(route) {
    if (route && typeof route.model === 'string' && route.model !== '') return (typeof route.provider === 'string' && route.provider !== '' ? route.provider + ' / ' : '') + route.model
    return undefined
  }
  function modelFromRoute(data) {
    return routeLabel(data) || routeLabel(data && data.header && data.header.config)
  }
  function modelFromMessage(data, fallback) {
    return routeLabel(data && data.message && data.message.source) || fallback
  }
  function nextLedgerRevision() {
    ledgerRevision = Math.max(ledgerRevision + 1, Date.now())
    return ledgerRevision
  }
  function ledgerEventKey(event, index) {
    return typeof event.seq === 'number' ? String(event.seq) : 'event:' + index
  }
  function buildLedgerRecord(session, workspaceId, source = 'scan', revision) {
    const sid = session && typeof session.id === 'string' ? session.id : ''
    const events = session && Array.isArray(session.events) ? session.events : []
    if (sid === '' || workspaceId === undefined) return null
    const turns = new Map()
    const usage = new Map()
    let currentModel
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index]
      if (event === null || typeof event !== 'object') continue
      const data = event.data
      if (event.type === 'request/context' || event.type === 'request/header') {
        const model = modelFromRoute(data)
        if (model !== undefined) currentModel = model
        continue
      }
      if (event.type === 'turn/end') {
        const key = ledgerEventKey(event, index)
        turns.set(key, { key, time: event.time, workspaceId })
        continue
      }
      if (event.type !== 'assistant/message' || data === null || typeof data !== 'object' || data.usage === undefined) continue
      const values = usageValues(data.usage)
      // v1.0.7: all-zero usage rows carry no billable tokens and stay out of the
      // durable ledger (cc-switch has_billable_tokens parity).
      if (noValues(values)) continue
      const modelId = typeof modelFromMessage(data, currentModel) === 'string' && modelFromMessage(data, currentModel) !== ''
        ? modelFromMessage(data, currentModel) : '未知模型（历史记录缺少路由）'
      const eventSeq = typeof event.seq === 'number' ? event.seq : -1
      const key = usageStepKey(sid, data, event.seq)
      const previous = usage.get(key)
      if (previous !== undefined && eventSeq >= 0 && previous.seq > eventSeq) continue
      usage.set(key, { key, seq: eventSeq, time: event.time, workspaceId, modelId, values })
    }
    return { version: LEDGER_VERSION, sessionId: sid, workspaceId, lastSeq: lastSeqOf(events), source, updatedAt: nextLedgerRevision(), lastRevision: typeof revision === 'string' ? revision : undefined, turns: Array.from(turns.values()), usage: Array.from(usage.values()) }
  }
  function normalizeLedgerRecord(raw, key) {
    if (raw === null || typeof raw !== 'object' || raw.version !== LEDGER_VERSION || typeof raw.sessionId !== 'string' || raw.sessionId !== key) return null
    if (!Array.isArray(raw.turns) || !Array.isArray(raw.usage)) return null
    const turnMap = new Map()
    for (const turn of raw.turns) {
      if (turn && typeof turn.key === 'string' && turn.workspaceId !== undefined && Number.isFinite(turn.time)) turnMap.set(turn.key, { key: turn.key, time: turn.time, workspaceId: turn.workspaceId })
    }
    const usageMap = new Map()
    for (const item of raw.usage) {
      if (!item || typeof item.key !== 'string' || item.workspaceId === undefined || typeof item.modelId !== 'string' || !Number.isFinite(item.time) || item.values === null || typeof item.values !== 'object') continue
      const normalized = { key: item.key, seq: typeof item.seq === 'number' ? item.seq : -1, time: item.time, workspaceId: item.workspaceId, modelId: item.modelId, values: usageValues({ inputTokens: item.values.input, outputTokens: item.values.output, cacheReadTokens: item.values.cacheRead, cacheWriteTokens: item.values.cacheWrite, reasoningTokens: item.values.reasoning }) }
      const previous = usageMap.get(normalized.key)
      if (previous === undefined || previous.seq <= normalized.seq) usageMap.set(normalized.key, normalized)
    }
    const updatedAt = typeof raw.updatedAt === 'number' ? raw.updatedAt : 0
    ledgerRevision = Math.max(ledgerRevision, updatedAt)
    return { version: LEDGER_VERSION, sessionId: raw.sessionId, workspaceId: raw.workspaceId, lastSeq: typeof raw.lastSeq === 'number' ? raw.lastSeq : -1, source: raw.source === 'flush' ? 'flush' : 'scan', updatedAt, lastRevision: typeof raw.lastRevision === 'string' ? raw.lastRevision : undefined, turns: Array.from(turnMap.values()), usage: Array.from(usageMap.values()) }
  }
  function applyLedgerRecord(record) {
    if (record === null || record === undefined) return
    for (const turn of record.turns) addTurn(turn.workspaceId, turn.time, record.sessionId)
    for (const item of record.usage) adjustUsage(item.workspaceId, item.time, item.values, item.modelId, 1, record.sessionId)
    if (record.turns.length > 0 || record.usage.length > 0) sessionCount.add(record.sessionId)
  }
  function ledgerRank(record) {
    return [typeof record.lastSeq === 'number' ? record.lastSeq : -1, record.source === 'flush' ? 1 : 0, typeof record.updatedAt === 'number' ? record.updatedAt : 0]
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
    if (ledgerUnit === null || record === null || record === undefined) return ledgerWriteChain
    const write = ledgerWriteChain.then(async () => {
      if (ledgerUnit !== null && ledgerRecords.get(record.sessionId) === record) await ledgerUnit.putRecord('sessions', record.sessionId, record)
    })
    ledgerWriteChain = write.catch((err) => {
      console.error('[all-usage] usage ledger write failed:', err)
    })
    return ledgerWriteChain
  }
  function foldEvent(wsId, time, type, data, sid, seq) {
    if (type === 'request/context' || type === 'request/header') {
      const model = modelFromRoute(data)
      if (model !== undefined) sessionModel.set(sid, model)
    } else if (type === 'turn/end') addTurn(wsId, time, sid)
    else if (type === 'assistant/message' && data && data.usage) addUsage(wsId, time, data.usage, modelFromMessage(data, sessionModel.get(sid)), sid, data, seq)
  }
  function foldEvents(wsId, events, fromSeq, sid) {
    for (const ev of events) {
      if (fromSeq !== undefined) {
        const s = typeof ev.seq === 'number' ? ev.seq : -1
        if (s <= fromSeq) continue
      }
      if (ev.type === 'turn/end' || ev.type === 'assistant/message' || ev.type === 'request/context' || ev.type === 'request/header') foldEvent(wsId, ev.time, ev.type, ev.data, sid, ev.seq)
    }
  }
  function lastSeqOf(events) {
    let last = 0
    for (const ev of events) {
      const s = typeof ev.seq === 'number' ? ev.seq : -1
      if (s > last) last = s
    }
    return last
  }
  function enqueue(sid, task) {
    const prev = chains.get(sid) || Promise.resolve()
    const next = prev.then(() => task(), () => task())
    chains.set(sid, next)
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
  async function processLiveEvent(sid, wsId, event, generation = aggregationGeneration) {
    if (disposed || generation !== aggregationGeneration) return
    const seq = typeof event.seq === 'number' ? event.seq : -1
    const last = sessionSeq.get(sid)
    if (last === undefined) {
      try {
        const snap = await ctx.sessionQuery.readSession(sid)
        if (disposed || generation !== aggregationGeneration) return
        if (snap && Array.isArray(snap.events)) {
          foldEvents(wsId, snap.events, undefined, sid)
          sessionSeq.set(sid, lastSeqOf(snap.events))
          sessionCount.add(sid)
        }
      } catch (err) { /* retry on the next event */ }
      return
    }
    if (seq <= last) return
    if (seq > last + 1) {
      try {
        const snap = await ctx.sessionQuery.readSession(sid)
        if (disposed || generation !== aggregationGeneration) return
        if (snap && Array.isArray(snap.events)) {
          foldEvents(wsId, snap.events, last, sid)
          sessionSeq.set(sid, lastSeqOf(snap.events))
        }
      } catch (err) { /* keep last; retry later */ }
      return
    }
    foldEvent(wsId, event.time, event.type, event.data, sid, event.seq)
    sessionSeq.set(sid, seq)
    sessionCount.add(sid)
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
      baselineRetryScheduled = false
      if (ready && generation === aggregationGeneration && !scan.started && !scan.done) return runBaseline(generation)
      if (!ready && generation === aggregationGeneration && !disposed) scheduleNativeBaselineRetry(generation, delay)
      return undefined
    })
  }
  async function runBaseline(generation = aggregationGeneration) {
    if (scan.started || disposed || generation !== aggregationGeneration) return
    scan.started = true
    await ledgerReady
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
    }
    let records = null
    try {
      records = await ctx.sessionQuery.listSessions()
    } catch (err) {
      console.error('[all-usage] session list failed:', err)
    }
    // v1.0.8: cheap per-session change signal (header line + stat, no full-log read)
    let snapshots = null
    if (sessionPersistence !== undefined && typeof sessionPersistence.listSnapshots === 'function') {
      try {
        const rows = await sessionPersistence.listSnapshots()
        if (Array.isArray(rows)) {
          snapshots = new Map()
          for (const row of rows) {
            const rid = row && row.header && typeof row.header.id === 'string' ? row.header.id : undefined
            if (rid !== undefined && row && typeof row.revision === 'string') snapshots.set(rid, row.revision)
          }
        }
      } catch (err) {
        console.error('[all-usage] session persistence snapshots unavailable:', err)
      }
    }
    if (disposed || generation !== aggregationGeneration) return
    if (setupFailed || !Array.isArray(records)) {
      // A transient registry failure must not be reported as a completed empty scan.
      scan.started = false
      scheduleBaselineRetry(generation)
      return
    }
    scan.total = records.length
    const listedSessionIds = new Set()
    for (const record of records) {
      if (record === undefined || record === null || record.header === undefined) continue
      const sid = record.header.id
      const cwd = typeof record.header.cwd === 'string' ? record.header.cwd : ''
      const wsId = cwd === '' ? undefined : pathIndex.get(cwd)
      if (sid !== undefined && wsId !== undefined) listedSessionIds.add(sid)
    }
    for (const [sid, record] of ledgerRecords) {
      if (!listedSessionIds.has(sid)) applyLedgerRecord(record)
    }
    for (const record of records) {
      if (disposed || generation !== aggregationGeneration) return
      if (record === undefined || record === null || record.header === undefined) {
        scan.scanned += 1
        continue
      }
      const sid = record.header.id
      const cwd = typeof record.header.cwd === 'string' ? record.header.cwd : ''
      const wsId = cwd === '' ? undefined : pathIndex.get(cwd)
      if (sid === undefined || wsId === undefined) {
        scan.scanned += 1
        continue
      }
      listedSessionIds.add(sid)
      await enqueue(sid, async () => {
        if (disposed || generation !== aggregationGeneration) return
        try {
          if (sessionSeq.has(sid)) return
          // v1.0.8: when the persisted log revision is unchanged since the last ledger
          // write, the whole readSession (full event transfer) is skipped — the ledger
          // record is applied directly and the live feed keeps catching new events.
          const previousRecord = ledgerRecords.get(sid)
          const revision = snapshots === null ? undefined : snapshots.get(sid)
          if (previousRecord !== undefined && typeof previousRecord.lastRevision === 'string' && typeof revision === 'string' && revision === previousRecord.lastRevision) {
            applyLedgerRecord(previousRecord)
            for (const item of previousRecord.usage) {
              usageByStep.set(item.key, { seq: item.seq, wsId: item.workspaceId, time: item.time, values: item.values, modelId: item.modelId, sid })
            }
            sessionSeq.set(sid, previousRecord.lastSeq)
            sessionCount.add(sid)
            return
          }
          const snap = await ctx.sessionQuery.readSession(sid)
          if (disposed || generation !== aggregationGeneration) return
          if (snap && Array.isArray(snap.events)) {
            // v1.0.7: incremental seed — the durable ledger doubles as a per-session
            // cursor (cc-switch session_log_sync mtime+offset parity). An unchanged
            // session applies its canonical record directly and never re-folds;
            // a changed session seeds the previous record once, then folds only the
            // new tail (previously every listed session was re-read and fully rebuilt).
            const currentLastSeq = lastSeqOf(snap.events)
            const previous = ledgerRecords.get(sid)
            if (previous !== undefined) {
              applyLedgerRecord(previous)
              // Seed usageByStep so a later live retry of an already-recorded step
              // reverses the ledger contribution instead of double-counting it.
              for (const item of previous.usage) {
                usageByStep.set(item.key, { seq: item.seq, wsId: item.workspaceId, time: item.time, values: item.values, modelId: item.modelId, sid })
              }
              if (previous.lastSeq >= currentLastSeq) {
                // Content unchanged despite a revision change (rare: ctime-only churn):
                // refresh the stored revision so future restarts can skip the read.
                if (revision !== undefined && previous.lastRevision !== revision) {
                  previous.lastRevision = revision
                  void persistLedgerRecord(previous)
                }
                sessionSeq.set(sid, previous.lastSeq)
                sessionCount.add(sid)
                return
              }
              foldEvents(wsId, snap.events, previous.lastSeq, sid)
            } else {
              foldEvents(wsId, snap.events, undefined, sid)
            }
            const ledger = buildLedgerRecord({ id: sid, header: record.header, events: snap.events }, wsId, 'scan', revision)
            const canonical = ledger === null ? ledgerRecords.get(sid) : storeLedgerRecord(ledger)
            if (canonical === ledger) {
              void persistLedgerRecord(ledger)
            } else if (canonical !== undefined) {
              applyLedgerRecord(canonical)
            }
            sessionSeq.set(sid, currentLastSeq)
            sessionCount.add(sid)
          }
        } catch (err) {
          const saved = ledgerRecords.get(sid)
          if (saved !== undefined) {
            applyLedgerRecord(saved)
            sessionSeq.set(sid, -1)
            sessionCount.add(sid)
          } else if (generation === aggregationGeneration) {
            sessionSeq.set(sid, -1)
            scan.failed += 1
          }
        } finally {
          if (generation === aggregationGeneration) scan.scanned += 1
        }
      })
      if (!(await safeContextTimeout(0))) {
        scan.started = false
        scheduleBaselineRetry(generation)
        return
      }
    }
    if (disposed || generation !== aggregationGeneration) return
    await ledgerWriteChain
    if (disposed || generation !== aggregationGeneration) return
    knownSessionIds.clear()
    for (const sid of listedSessionIds) knownSessionIds.add(sid)
    scan.done = true
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
    void safeContextTimeout(RECONCILE_HINT_DELAY_MS).then((ready) => {
      reconcileHintScheduled = false
      if (ready && !disposed) void reconcileSessions()
    }, () => {
      reconcileHintScheduled = false
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
    await ledgerReady
    if (disposed) return
    const wsId = wsForLiveSession(session, session.id)
    if (wsId === undefined) return
    const ledger = buildLedgerRecord(session, wsId, 'flush')
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
      kvUnit = unit
      const snap = await unit.loadAll()
      const g = snap && snap.global
      if (g !== null && g !== undefined && typeof g === 'object') {
        for (const key of Object.keys(g)) {
          const value = g[key]
          if (typeof value === 'string' && value.trim() !== '') aliases[key] = value
        }
      }
    } catch (err) {
      console.error('[all-usage] alias storage unavailable:', err)
    }
  }
  function persistAliases() {
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
    const alias = typeof raw === 'string' ? raw.trim().slice(0, 80) : ''
    if (!wsMeta.has(wsId)) return { ok: false, message: 'unknown-workspace', aliases: Object.assign({}, aliases) }
    if (alias === '') delete aliases[wsId]
    else aliases[wsId] = alias
    persistAliases()
    return { ok: true, aliases: Object.assign({}, aliases) }
  }
  ctx.effect(() => () => {
    disposed = true
    if (reconcileTimer !== null) {
      clearTimeout(reconcileTimer)
      reconcileTimer = null
    }
    if (baselineFallbackTimer !== null) {
      clearTimeout(baselineFallbackTimer)
      baselineFallbackTimer = null
    }
  })
  ctx.effect(() => () => {
    const unit = kvUnit
    kvUnit = null
    if (unit !== null && unit !== undefined) void unit.close().catch(() => {})
  })
  ctx.effect(() => async () => {
    const unit = ledgerUnit
    await ledgerWriteChain
    if (unit !== null && unit !== undefined) await unit.close().catch(() => {})
    if (ledgerUnit === unit) ledgerUnit = null
  })

  // ---------- snapshot for the client ----------
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
        perWorkspace: Array.from(day.perWs, (p) => ({ workspaceId: p[0], turns: p[1] })),
        byWorkspace: Array.from(day.byWs, (p) => ({ workspaceId: p[0], input: p[1].input, output: p[1].output, cacheRead: p[1].cacheRead, cacheWrite: p[1].cacheWrite, reasoning: p[1].reasoning })),
        byModel: Array.from(day.byModel, (p) => ({ model: p[0], calls: p[1].calls, input: p[1].input, output: p[1].output, cacheRead: p[1].cacheRead, cacheWrite: p[1].cacheWrite, reasoning: p[1].reasoning })),
      })
    }
    result.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    return result
  }
  function snapshot() {
    return {
      scan: { started: scan.started, done: scan.done, scanned: scan.scanned, total: scan.total, failed: scan.failed },
      generatedAt: Date.now(),
      requestToken,
      workspaces: Array.from(wsMeta.values(), (w) => ({ id: w.id, title: w.title, path: w.path })),
      aliases: Object.assign({}, aliases),
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
      totals: { turns: totals.turns, sessions: sessionCount.size, input: totals.input, output: totals.output, cacheRead: totals.cacheRead, cacheWrite: totals.cacheWrite, reasoning: totals.reasoning },
      perWorkspace: Array.from(perWorkspace, (p) => ({ workspaceId: p[0], turns: p[1].turns, input: p[1].input, output: p[1].output, cacheRead: p[1].cacheRead, cacheWrite: p[1].cacheWrite, reasoning: p[1].reasoning })),
      perModel: Array.from(perModel, (p) => ({ model: p[0], calls: p[1].calls, input: p[1].input, output: p[1].output, cacheRead: p[1].cacheRead, cacheWrite: p[1].cacheWrite, reasoning: p[1].reasoning })),
      byDay: serializeDays(byDay),
      byDayUtc: serializeDays(byDayUtc),
    }
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
        let args = null
        try {
          args = JSON.parse(body)
        } catch (err) { /* invalid json */ }
        const result = args !== null && args !== undefined && typeof args.workspaceId === 'string'
          ? setAlias(args.workspaceId, args.alias)
          : { ok: false, message: 'bad-request', aliases: Object.assign({}, aliases) }
        sendJson(res, 200, result)
      },
    }))
  }

  // ---------- start the historical backfill immediately ----------
  ledgerReady = loadLedger()
  void runBaseline()
  scheduleReconcileTimer()
  void loadAliases()
}

export { name, inject, apply }
export default { name, inject, apply }
