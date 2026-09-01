import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

function makeResponse() {
  let body = ''
  const headers = {}
  const res = {
    statusCode: 200,
    setHeader(name, value) {
      headers[String(name).toLowerCase()] = value
    },
    end(value = '') {
      body += String(value)
    },
  }
  return { res, headers, body: () => body }
}

function makeRequest(method, headers = {}, body = '') {
  return {
    method,
    url: '/',
    headers,
    socket: { remoteAddress: '127.0.0.1' },
    on(event, callback) {
      if (event === 'data' && body !== '') callback(Buffer.from(body))
      if (event === 'end') callback()
      return this
    },
  }
}

async function createApp({ key = 'test-key', workspaces = [], withStorage = false, sessions = [], events = new Map(), listSessions: listSessionsOverride, readSession: readSessionOverride, ledgerSeed = {}, storage: storageUnitOverride, timeout: timeoutOverride, snapshots = [] } = {}) {
  const routes = new Map()
  const cleanups = []
  const listeners = {}
  const storageUnit = storageUnitOverride || {
    saved: [],
    records: { sessions: {} },
    async loadAll() {
      return { global: {}, tables: this.records }
    },
    async putRecord(table, key, value) {
      if (!this.records[table]) this.records[table] = {}
      this.records[table][key] = value
    },
    async deleteRecord(table, key) {
      if (this.records[table]) delete this.records[table][key]
    },
    async setGlobal(value) {
      this.saved.push(value)
    },
    async close() {},
  }
  if (ledgerSeed !== null && typeof ledgerSeed === 'object') {
    if (!storageUnit.records) storageUnit.records = {}
    if (!storageUnit.records.sessions) storageUnit.records.sessions = {}
    Object.assign(storageUnit.records.sessions, ledgerSeed)
  }
  const webServer = {
    register(route) {
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  }
  const readCalls = new Map()
  const ctx = {
    sessionQuery: {
      async listSessions() {
        if (typeof listSessionsOverride === 'function') return listSessionsOverride()
        return sessions
      },
      async readSession(sid) {
        readCalls.set(sid, (readCalls.get(sid) || 0) + 1)
        if (typeof readSessionOverride === 'function') return readSessionOverride(sid)
        return { events: events instanceof Map ? (events.get(sid) || []) : [] }
      },
    },
    workspaceRegistry: {
      list() {
        return workspaces
      },
    },
    async timeout(ms) {
      if (typeof timeoutOverride === 'function') return timeoutOverride(ms)
    },
    on(event, handler) {
      listeners[event] = listeners[event] || []
      listeners[event].push(handler)
    },
    effect(factory) {
      const cleanup = factory()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
      return cleanup
    },
    get(service) {
      if (service === 'credentials') {
        return { resolve: async () => (key === undefined ? undefined : { value: key }) }
      }
      if (service === 'settings') return { get: () => ({}) }
      if (service === 'storage') {
        return withStorage
          ? { backend: { get: () => ({ kv: { open: async () => storageUnit } }) } }
          : undefined
      }
      if (service === 'webServer') return webServer
      if (service === 'sessionPersistence') {
        return { listSnapshots: async () => snapshots }
      }
      if (service === 'subprocess') throw new Error('subprocess must not be requested')
      return undefined
    },
  }
  apply(ctx)
  await new Promise((resolve) => setImmediate(resolve))
  return { routes, storageUnit, cleanups, listeners, readCalls }
}

async function call(app, path, request) {
  const handler = app.routes.get(path)
  assert.equal(typeof handler, 'function', 'route should be registered: ' + path)
  const result = makeResponse()
  await handler(request, result.res)
  return {
    status: result.res.statusCode,
    headers: result.headers,
    body: result.body(),
    json: () => JSON.parse(result.body()),
  }
}

function usageEvent(time, turn, step, usage, seq, provider = 'deepseek', model = 'deepseek-chat') {
  return {
    seq,
    time,
    type: 'assistant/message',
    data: {
      turn,
      step,
      message: { source: { provider, model } },
      usage,
    },
  }
}

function usageChunkEvent(time, turn, step, usage, seq) {
  return {
    seq,
    time,
    type: 'assistant/chunk',
    data: { turn, step, chunk: { type: 'usage', usage } },
  }
}

async function waitForScan(app, predicate = (body) => body.scan.done) {
  let snapshot = null
  for (let i = 0; i < 200; i += 1) {
    snapshot = await call(app, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))
    if (predicate(snapshot.json())) return snapshot
    await new Promise((resolve) => setImmediate(resolve))
  }
  return snapshot
}

async function waitForLedgerWrite() {
  await new Promise((resolve) => setTimeout(resolve, 40))
}

test('seeds unchanged sessions from the ledger and replaces retried steps without double-counting', async () => {
  const eventTime = Date.now() - 60 * 1000
  const events = [
    { seq: 1, time: eventTime, type: 'turn/end', data: {} },
    usageEvent(eventTime, 1, 1, { inputTokens: 10, outputTokens: 20 }, 2),
  ]
  const first = await createApp({
    withStorage: true,
    workspaces: [{ id: 'ws-1', path: 'C:\\repo', title: 'Repo', sessionIds: ['s-1'] }],
    sessions: [{ header: { id: 's-1', cwd: 'C:\\repo' } }],
    events: new Map([['s-1', events]]),
  })
  let snapshot = null
  for (let i = 0; i < 200; i += 1) {
    snapshot = await call(first, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))
    if (snapshot.json().scan.done && snapshot.json().totals.turns === 1) break
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.equal(snapshot.json().totals.input, 10)

  // Fresh instance over the same durable ledger: the session is unchanged, so the
  // baseline seeds it from the ledger instead of re-folding every event.
  const second = await createApp({
    withStorage: true,
    storage: first.storageUnit,
    workspaces: [{ id: 'ws-1', path: 'C:\\repo', title: 'Repo', sessionIds: ['s-1'] }],
    sessions: [{ header: { id: 's-1', cwd: 'C:\\repo' } }],
    events: new Map([['s-1', events]]),
  })
  const eventHandlers = second.listeners['session/event'] || []
  assert.equal(eventHandlers.length, 1)
  snapshot = null
  for (let i = 0; i < 200; i += 1) {
    snapshot = await call(second, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))
    if (snapshot.json().scan.done && snapshot.json().totals.turns === 1) break
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.equal(snapshot.json().scan.done, true)
  assert.equal(snapshot.json().totals.turns, 1)
  assert.equal(snapshot.json().totals.input, 10)
  assert.equal(snapshot.json().totals.sessions, 1)

  // A live retry of the already-recorded step replaces the seeded value instead
  // of adding on top of it (usageByStep seeds the ledger keys).
  eventHandlers[0]({ id: 's-1', header: { cwd: 'C:\\repo' } }, usageEvent(Date.now(), 1, 1, { inputTokens: 50, outputTokens: 60 }, 3))
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve))
  snapshot = await call(second, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))
  assert.equal(snapshot.json().totals.turns, 1)
  assert.equal(snapshot.json().totals.input, 50)
  assert.equal(snapshot.json().totals.output, 60)
})

test('keeps the first live event when the bootstrap snapshot misses it', async () => {
  const eventTime = Date.now() - 60 * 1000
  const app = await createApp({
    workspaces: [{ id: 'ws-live', path: 'C:\live', title: 'Live' }],
    sessions: [],
    readSession: async () => ({ events: [] }),
  })
  const handler = app.listeners['session/event'][0]
  handler({ id: 's-live', header: { cwd: 'C:\live' } }, usageEvent(eventTime, 1, 1, { inputTokens: 13, outputTokens: 17 }, 0))
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve))
  const snapshot = await call(app, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))
  assert.equal(snapshot.json().totals.input, 13)
  assert.equal(snapshot.json().totals.output, 17)
})

test('keeps the first live event when bootstrap reading fails', async () => {
  let attempts = 0
  const eventTime = Date.now() - 60 * 1000
  const app = await createApp({
    workspaces: [{ id: 'ws-live', path: 'C:\live', title: 'Live' }],
    sessions: [],
    readSession: async () => { attempts += 1; throw new Error('temporary read failure') },
  })
  const handler = app.listeners['session/event'][0]
  handler({ id: 's-live', header: { cwd: 'C:\live' } }, usageEvent(eventTime, 1, 1, { inputTokens: 19, outputTokens: 23 }, 1))
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve))
  const snapshot = await call(app, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))
  assert.equal(snapshot.json().totals.input, 19)
  assert.equal(snapshot.json().totals.output, 23)
  assert.ok(attempts >= 1)
  const cleanups = app.cleanups.map((cleanup) => cleanup()).filter((value) => value && typeof value.then === 'function')
  await Promise.all(cleanups)
})

test('updates date indexes when a live usage is replaced', async () => {
  const firstTime = new Date()
  firstTime.setHours(12, 0, 0, 0)
  firstTime.setDate(firstTime.getDate() - 2)
  const secondTime = new Date(firstTime)
  secondTime.setDate(secondTime.getDate() + 1)
  const dateText = (date) => date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0')
  const app = await createApp({
    workspaces: [{ id: 'ws-index', path: 'C:\index', title: 'Index' }],
    sessions: [],
    readSession: async () => ({ events: [] }),
  })
  const handler = app.listeners['session/event'][0]
  handler({ id: 's-index', header: { cwd: 'C:\index' } }, usageEvent(firstTime.getTime(), 1, 1, { inputTokens: 10, outputTokens: 11 }, 1))
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve))
  handler({ id: 's-index', header: { cwd: 'C:\index' } }, usageEvent(secondTime.getTime(), 1, 1, { inputTokens: 20, outputTokens: 21 }, 2))
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve))
  const firstRequest = makeRequest('GET', { host: '127.0.0.1:3080' })
  firstRequest.url = '/api/all-usage/query?start=' + dateText(firstTime) + '&end=' + dateText(firstTime) + '&utc=0'
  const secondRequest = makeRequest('GET', { host: '127.0.0.1:3080' })
  secondRequest.url = '/api/all-usage/query?start=' + dateText(secondTime) + '&end=' + dateText(secondTime) + '&utc=0'
  const firstQuery = (await call(app, '/api/all-usage/query', firstRequest)).json()
  const secondQuery = (await call(app, '/api/all-usage/query', secondRequest)).json()
  assert.equal(firstQuery.totals.input, 0)
  assert.equal(firstQuery.hourly.reduce((sum, row) => sum + row.calls, 0), 0)
  assert.equal(firstQuery.heatmap.some((row) => row.date === dateText(firstTime)), false)
  assert.equal(secondQuery.totals.input, 20)
  assert.equal(secondQuery.hourly.reduce((sum, row) => sum + row.calls, 0), 1)
  const full = (await call(app, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))).json()
  assert.equal(full.byDay.find((day) => day.date === dateText(firstTime)).sessions, 0)
  assert.equal(full.byDay.find((day) => day.date === dateText(secondTime)).sessions, 1)
})

test('ignores invalid event timestamps during baseline folding', async () => {
  const eventTime = Date.now() - 60 * 1000
  const app = await createApp({
    workspaces: [{ id: 'ws-time', path: 'C:\time', title: 'Time' }],
    sessions: [{ header: { id: 's-time', cwd: 'C:\time' } }],
    events: new Map([['s-time', [
      usageEvent(Number.NaN, 1, 1, { inputTokens: 101, outputTokens: 103 }, 1),
      usageEvent(1e20, 1, 2, { inputTokens: 107, outputTokens: 109 }, 2),
      usageEvent(Number.MAX_SAFE_INTEGER, 1, 3, { inputTokens: 113, outputTokens: 127 }, 3),
      usageEvent(eventTime, 2, 1, { inputTokens: 7, outputTokens: 11 }, 4),
    ]]]),
  })
  let snapshot = null
  for (let i = 0; i < 100; i += 1) {
    snapshot = await call(app, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))
    if (snapshot.json().scan.done) break
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.equal(snapshot.json().totals.input, 7)
  assert.equal(snapshot.json().totals.output, 11)
  assert.equal(JSON.stringify(snapshot.json()).includes('NaN-NaN-NaN'), false)
})

test('folds only the new tail for a session that gained events (incremental seed)', async () => {
  const eventTime = Date.now() - 60 * 1000
  const firstEvents = [
    { seq: 1, time: eventTime, type: 'turn/end', data: {} },
    usageEvent(eventTime, 1, 1, { inputTokens: 10, outputTokens: 20 }, 2),
  ]
  const secondEvents = firstEvents.concat([
    { seq: 3, time: eventTime, type: 'turn/end', data: {} },
    usageEvent(eventTime, 2, 1, { inputTokens: 7, outputTokens: 8 }, 4),
  ])
  const first = await createApp({
    withStorage: true,
    workspaces: [{ id: 'ws-1', path: 'C:\\repo', title: 'Repo' }],
    sessions: [{ header: { id: 's-1', cwd: 'C:\\repo' } }],
    events: new Map([['s-1', firstEvents]]),
  })
  let snapshot = null
  for (let i = 0; i < 200; i += 1) {
    snapshot = await call(first, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))
    if (snapshot.json().scan.done && snapshot.json().totals.turns === 1) break
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.equal(snapshot.json().totals.input, 10)

  const second = await createApp({
    withStorage: true,
    storage: first.storageUnit,
    workspaces: [{ id: 'ws-1', path: 'C:\\repo', title: 'Repo' }],
    sessions: [{ header: { id: 's-1', cwd: 'C:\\repo' } }],
    events: new Map([['s-1', secondEvents]]),
  })
  snapshot = null
  for (let i = 0; i < 200; i += 1) {
    snapshot = await call(second, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))
    if (snapshot.json().scan.done && snapshot.json().totals.turns === 2) break
    await new Promise((resolve) => setImmediate(resolve))
  }
  const body = snapshot.json()
  assert.equal(body.scan.done, true)
  // Old tail seeded from the ledger + new tail folded once: never double-counted.
  assert.equal(body.totals.turns, 2)
  assert.equal(body.totals.input, 17)
  assert.equal(body.totals.output, 28)
  assert.equal(body.totals.sessions, 1)
})

test('aggregation skips all-zero usage rows during the baseline scan', async () => {
  const eventTime = Date.now() - 60 * 1000
  const app = await createApp({
    workspaces: [{ id: 'ws-1', path: 'C:\\repo', title: 'Repo' }],
    sessions: [{ header: { id: 's-1', cwd: 'C:\\repo' } }],
    events: new Map([['s-1', [
      { seq: 1, time: eventTime, type: 'turn/end', data: {} },
      usageEvent(eventTime, 1, 1, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }, 2),
      usageEvent(eventTime, 1, 1, { inputTokens: 10, outputTokens: 20 }, 3),
    ]]]),
  })
  let snapshot = null
  for (let i = 0; i < 200; i += 1) {
    snapshot = await call(app, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))
    if (snapshot.json().scan.done && snapshot.json().totals.turns === 1) break
    await new Promise((resolve) => setImmediate(resolve))
  }
  const body = snapshot.json()
  assert.equal(body.scan.done, true)
  assert.equal(body.totals.turns, 1)
  assert.equal(body.totals.input, 10)
  assert.equal(body.totals.output, 20)
})

test('keeps pure cache-read usage events (billable gate)', async () => {
  const eventTime = Date.now() - 60 * 1000
  const app = await createApp({
    workspaces: [{ id: 'ws-1', path: 'C:\\repo', title: 'Repo' }],
    sessions: [{ header: { id: 's-1', cwd: 'C:\\repo' } }],
    events: new Map([['s-1', [
      { seq: 1, time: eventTime, type: 'turn/end', data: {} },
      usageEvent(eventTime, 1, 1, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 500 }, 2),
    ]]]),
  })
  let snapshot = null
  for (let i = 0; i < 200; i += 1) {
    snapshot = await call(app, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))
    if (snapshot.json().scan.done && snapshot.json().totals.cacheRead === 500) break
    await new Promise((resolve) => setImmediate(resolve))
  }
  const body = snapshot.json()
  assert.equal(body.scan.done, true)
  assert.equal(body.totals.cacheRead, 500)
  assert.equal(body.totals.input, 0)
  assert.equal(body.totals.output, 0)
})

test('ignores all-zero usage replays when persisting the durable ledger', async () => {
  const eventTime = Date.now() - 60 * 1000
  const app = await createApp({
    withStorage: true,
    workspaces: [{ id: 'ws-1', path: 'C:\\repo', title: 'Repo' }],
    sessions: [{ header: { id: 's-1', cwd: 'C:\\repo' } }],
    events: new Map([['s-1', []]]),
  })
  const flush = (app.listeners['session/flush'] || [])[0]
  assert.equal(typeof flush, 'function')
  await flush({ id: 's-1', header: { cwd: 'C:\\repo' }, events: [
    usageEvent(eventTime, 1, 1, { inputTokens: 10, outputTokens: 20 }, 2),
    usageEvent(eventTime, 1, 1, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }, 3),
    usageEvent(eventTime, 2, 1, { inputTokens: 7, outputTokens: 8 }, 4),
  ] })
  await waitForLedgerWrite()
  const row = app.storageUnit.records.sessions['s-1']
  assert.ok(row)
  assert.equal(Number.isFinite(row.updatedAt), true)
  assert.equal(row.usage.length, 2)
  const step1 = row.usage.find((item) => item.key === 's-1:step:1:1')
  const step2 = row.usage.find((item) => item.key === 's-1:step:2:1')
  assert.equal(step1 && step1.values.input, 10)
  assert.equal(step2 && step2.values.input, 7)
})


test('skips a clean session flush and writes only after a dirty event', async () => {
  const eventTime = Date.now() - 60 * 1000
  const events = [
    { seq: 1, time: eventTime, type: 'turn/end', data: { turn: 1 } },
    usageEvent(eventTime, 1, 1, { inputTokens: 10, outputTokens: 20 }, 2),
  ]
  const storage = {
    records: { sessions: {} },
    ledgerWrites: [],
    async loadAll() { return { global: {}, tables: this.records } },
    async putRecord(table, key, value) {
      if (key !== '__all_usage_ledger_meta__') this.ledgerWrites.push({ table, key, value })
      if (!this.records[table]) this.records[table] = {}
      this.records[table][key] = value
    },
    async deleteRecord(table, key) { if (this.records[table]) delete this.records[table][key] },
    async setGlobal() {},
    async close() {},
  }
  const app = await createApp({
    withStorage: true,
    storage,
    workspaces: [{ id: 'ws-dirty', path: 'C:\\dirty', title: 'Dirty' }],
    sessions: [{ header: { id: 's-dirty', cwd: 'C:\\dirty' } }],
    events: new Map([['s-dirty', events]]),
  })
  await waitForScan(app)
  await new Promise((resolve) => setImmediate(resolve))
  const before = storage.ledgerWrites.length
  const flush = app.listeners['session/flush'][0]
  await flush({ id: 's-dirty', header: { id: 's-dirty', cwd: 'C:\\dirty' }, events })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(storage.ledgerWrites.length, before)
  const next = usageEvent(eventTime, 2, 1, { inputTokens: 7, outputTokens: 8 }, 3)
  app.listeners['session/event'][0]({ id: 's-dirty', header: { id: 's-dirty', cwd: 'C:\\dirty' } }, next)
  await flush({ id: 's-dirty', header: { id: 's-dirty', cwd: 'C:\\dirty' }, events: events.concat([next]) })
  await waitForLedgerWrite()
  assert.equal(storage.ledgerWrites.length, before + 1)
})


test('retries a failed ledger write on the next dirty flush', async () => {
  const eventTime = Date.now() - 60 * 1000
  const events = [usageEvent(eventTime, 1, 1, { inputTokens: 10, outputTokens: 20 }, 1)]
  const storage = {
    records: { sessions: {} },
    ledgerWrites: [],
    failNext: true,
    async loadAll() { return { global: {}, tables: this.records } },
    async putRecord(table, key, value) {
      if (key === '__all_usage_ledger_meta__') {
        this.records[table][key] = value
        return
      }
      this.ledgerWrites.push({ table, key, value })
      if (this.failNext) {
        this.failNext = false
        throw new Error('transient shard failure')
      }
      this.records[table][key] = value
    },
    async deleteRecord(table, key) { if (this.records[table]) delete this.records[table][key] },
    async setGlobal() {},
    async close() {},
  }
  const app = await createApp({
    withStorage: true,
    storage,
    workspaces: [{ id: 'ws-retry', path: 'C:\\retry', title: 'Retry' }],
    sessions: [{ header: { id: 's-retry', cwd: 'C:\\retry' } }],
    events: new Map([['s-retry', events]]),
  })
  await waitForScan(app)
  await waitForLedgerWrite()
  assert.equal(storage.ledgerWrites.length, 1)
  await app.listeners['session/flush'][0]({ id: 's-retry', header: { id: 's-retry', cwd: 'C:\\retry' }, events })
  await waitForLedgerWrite()
  assert.equal(storage.ledgerWrites.length, 2)
  assert.ok(storage.records.sessions['s-retry'])
  await app.listeners['session/flush'][0]({ id: 's-retry', header: { id: 's-retry', cwd: 'C:\\retry' }, events })
  await waitForLedgerWrite()
  assert.equal(storage.ledgerWrites.length, 2)
})

test('exposes structured token semantics in the API snapshot', async () => {
  const app = await createApp()
  const stats = await call(app, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))
  const body = stats.json()
  const semantics = body.tokenSemantics && body.tokenSemantics.semantics
  assert.ok(semantics, 'tokenSemantics.semantics must be present')
  assert.equal(semantics.inputIncludesCache, false)
  assert.equal(semantics.cacheBucketed, true)
  assert.equal(semantics.reasoningSeparate, true)
  assert.ok(Array.isArray(semantics.buckets))
  assert.ok(semantics.buckets.includes('cacheRead'))
  assert.equal(body.tokenSemantics.processedTotal, 'input + output + cacheRead + cacheWrite + reasoning')
  for (const key of ['revision', 'dataRevision', 'metadataRevision', 'scanRevision', 'pricingRevision', 'queryRevision']) assert.ok(Object.hasOwn(body, key), key + ' must be present')
  assert.equal(body.queryRevision, body.dataRevision + ':' + body.pricingRevision)
})

test('separates data, metadata, and query revisions across live changes', async () => {
  const eventTime = Date.now() - 60 * 1000
  const events = [
    { seq: 1, time: eventTime, type: 'request/context', data: { provider: 'deepseek', model: 'deepseek-chat' } },
    usageEvent(eventTime, 1, 1, { inputTokens: 10, outputTokens: 20 }, 2),
    { seq: 3, time: eventTime, type: 'turn/end', data: { turn: 1 } },
  ]
  const app = await createApp({
    workspaces: [{ id: 'ws-revisions', path: 'C:/revisions', title: 'Revisions' }],
    sessions: [{ header: { id: 's-revisions', cwd: 'C:/revisions' } }],
    events: new Map([['s-revisions', events]]),
  })
  await waitForScan(app)
  const before = (await call(app, '/api/all-usage/status', makeRequest('GET', { host: '127.0.0.1:3080' }))).json()
  const live = usageEvent(eventTime, 2, 1, { inputTokens: 7, outputTokens: 8 }, 4)
  events.push(live)
  app.listeners['session/event'][0]({ id: 's-revisions', header: { cwd: 'C:/revisions' } }, live)
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve))
  const afterData = (await call(app, '/api/all-usage/status', makeRequest('GET', { host: '127.0.0.1:3080' }))).json()
  assert.ok(afterData.dataRevision > before.dataRevision)
  assert.equal(afterData.metadataRevision, before.metadataRevision)
  assert.equal(afterData.pricingRevision, before.pricingRevision)
  assert.notEqual(afterData.queryRevision, before.queryRevision)

  const token = (await call(app, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))).json().requestToken
  const alias = await call(app, '/api/all-usage/alias', makeRequest('POST', {
    host: '127.0.0.1:3080',
    origin: 'http://127.0.0.1:3080',
    'x-all-usage-request-token': token,
  }, JSON.stringify({ workspaceId: 'ws-revisions', alias: 'Renamed' })))
  assert.equal(alias.status, 200)
  await new Promise((resolve) => setImmediate(resolve))
  const afterMetadata = (await call(app, '/api/all-usage/status', makeRequest('GET', { host: '127.0.0.1:3080' }))).json()
  assert.ok(afterMetadata.metadataRevision > afterData.metadataRevision)
  assert.equal(afterMetadata.dataRevision, afterData.dataRevision)
  assert.equal(afterMetadata.pricingRevision, afterData.pricingRevision)
  assert.equal(afterMetadata.queryRevision, afterData.queryRevision)
})

test('skips re-reading unchanged sessions after restart using persistence revisions', async () => {
  const eventTime = Date.now() - 60 * 1000
  const events = [
    { seq: 1, time: eventTime, type: 'turn/end', data: {} },
    usageEvent(eventTime, 1, 1, { inputTokens: 10, outputTokens: 20 }, 2),
  ]
  const opts = {
    withStorage: true,
    workspaces: [{ id: 'ws-1', path: 'C:\\repo', title: 'Repo', sessionIds: ['s-1'] }],
    sessions: [{ header: { id: 's-1', cwd: 'C:\\repo' } }],
    events: new Map([['s-1', events]]),
    snapshots: [{ header: { id: 's-1' }, revision: 'rev-1' }],
  }
  const first = await createApp(opts)
  let snap = null
  for (let i = 0; i < 200; i += 1) {
    snap = await call(first, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))
    if (snap.json().scan.done && snap.json().totals.turns === 1) break
    await new Promise((resolve) => setImmediate(resolve))
  }
  const firstBody = snap.json()
  assert.equal(firstBody.totals.input, 10)
  assert.equal(firstBody.sync.persistenceSnapshotsAvailable, true)
  assert.equal(firstBody.sync.sessionsTotal, 1)
  assert.equal(firstBody.sync.sessionsRead, 1)
  assert.equal(firstBody.sync.sessionsSkippedByRevision, 0)
  assert.equal(first.readCalls.get('s-1'), 1, 'first baseline must read the session')
  assert.equal(first.storageUnit.records.sessions['s-1'].lastRevision, 'rev-1', 'ledger must store the log revision')

  // Fresh instance over the same durable ledger with an identical log revision:
  // the unchanged session is applied straight from the ledger WITHOUT readSession.
  const second = await createApp({ ...opts, storage: first.storageUnit })
  snap = null
  for (let i = 0; i < 200; i += 1) {
    snap = await call(second, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))
    if (snap.json().scan.done && snap.json().totals.turns === 1) break
    await new Promise((resolve) => setImmediate(resolve))
  }
  const secondBody = snap.json()
  assert.equal(secondBody.scan.done, true)
  assert.equal(secondBody.totals.input, 10)
  assert.equal(secondBody.totals.output, 20)
  assert.equal(secondBody.totals.sessions, 1)
  assert.equal(secondBody.sync.persistenceSnapshotsAvailable, true)
  assert.equal(secondBody.sync.sessionsRead, 0)
  assert.equal(secondBody.sync.sessionsSkippedByRevision, 1)
  assert.equal(second.readCalls.get('s-1') || 0, 0, 'unchanged session must not be re-read')

  // A live retry of the seeded step still replaces instead of double-counting.
  const eventHandlers = second.listeners['session/event'] || []
  eventHandlers[0]({ id: 's-1', header: { cwd: 'C:\\repo' } }, usageEvent(Date.now(), 1, 1, { inputTokens: 50, outputTokens: 60 }, 3))
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve))
  snap = await call(second, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))
  assert.equal(snap.json().totals.input, 50)
})

test('re-reads a session whose persisted log revision changed', async () => {
  const eventTime = Date.now() - 60 * 1000
  const firstEvents = [
    { seq: 1, time: eventTime, type: 'turn/end', data: {} },
    usageEvent(eventTime, 1, 1, { inputTokens: 10, outputTokens: 20 }, 2),
  ]
  const secondEvents = firstEvents.concat([
    { seq: 3, time: eventTime, type: 'turn/end', data: {} },
    usageEvent(eventTime, 2, 1, { inputTokens: 7, outputTokens: 8 }, 4),
  ])
  const first = await createApp({
    withStorage: true,
    workspaces: [{ id: 'ws-1', path: 'C:\\repo', title: 'Repo' }],
    sessions: [{ header: { id: 's-1', cwd: 'C:\\repo' } }],
    events: new Map([['s-1', firstEvents]]),
    snapshots: [{ header: { id: 's-1' }, revision: 'rev-1' }],
  })
  let snap = null
  for (let i = 0; i < 200; i += 1) {
    snap = await call(first, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))
    if (snap.json().scan.done && snap.json().totals.turns === 1) break
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.equal(snap.json().totals.input, 10)
  assert.equal(first.storageUnit.records.sessions['s-1'].lastRevision, 'rev-1')

  // Same ledger, but the persisted log has changed (new revision + new events):
  // the baseline must re-read and fold only the new tail.
  const second = await createApp({
    withStorage: true,
    storage: first.storageUnit,
    workspaces: [{ id: 'ws-1', path: 'C:\\repo', title: 'Repo' }],
    sessions: [{ header: { id: 's-1', cwd: 'C:\\repo' } }],
    events: new Map([['s-1', secondEvents]]),
    snapshots: [{ header: { id: 's-1' }, revision: 'rev-2' }],
  })
  snap = null
  for (let i = 0; i < 200; i += 1) {
    snap = await call(second, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))
    if (snap.json().scan.done && snap.json().totals.turns === 2) break
    await new Promise((resolve) => setImmediate(resolve))
  }
  const body = snap.json()
  assert.equal(body.totals.input, 17)
  assert.equal(body.totals.turns, 2)
  assert.equal(body.sync.persistenceSnapshotsAvailable, true)
  assert.equal(body.sync.sessionsRead, 1)
  assert.equal(body.sync.sessionsSkippedByRevision, 0)
  assert.equal(second.readCalls.get('s-1'), 1, 'changed revision must trigger a re-read')
  assert.equal(second.storageUnit.records.sessions['s-1'].lastRevision, 'rev-2')
})


test('serves structured scoped aggregates and privacy-safe paginated records', async () => {
  const eventTime = Date.now() - 60 * 1000
  const date = new Date(eventTime)
  const dateText = date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0')
  const app = await createApp({
    workspaces: [
      { id: 'ws-a', path: 'C:\\a', title: 'A' },
      { id: 'ws-b', path: 'C:\\b', title: 'B' },
    ],
    sessions: [
      { header: { id: 's-a', cwd: 'C:\\a' } },
      { header: { id: 's-b', cwd: 'C:\\b' } },
    ],
    events: new Map([
      ['s-a', [
        { seq: 1, time: eventTime, type: 'request/context', data: { provider: 'provider-a', model: 'requested-a' } },
        usageEvent(eventTime, 1, 1, { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30 }, 2),
        { seq: 3, time: eventTime, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      ]],
      ['s-b', [
        { seq: 1, time: eventTime, type: 'request/context', data: { provider: 'provider-b', model: 'requested-b' } },
        { seq: 2, time: eventTime, type: 'assistant/message', data: { turn: 1, step: 1, message: { source: { provider: 'provider-b', model: 'actual-b' } }, usage: { inputTokens: 7, outputTokens: 8 } } },
        { seq: 3, time: eventTime, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      ]],
    ]),
  })
  let snapshot = null
  for (let i = 0; i < 200; i += 1) {
    snapshot = await call(app, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))
    if (snapshot.json().scan.done) break
    await new Promise((resolve) => setImmediate(resolve))
  }
  const full = snapshot.json()
  assert.equal(full.usageSchemaVersion, 3)
  const modelA = full.perModel.find((row) => row.provider === 'deepseek')
  assert.ok(modelA)
  assert.equal(modelA.requestedModel, 'requested-a')
  assert.equal(modelA.actualModel, 'deepseek-chat')
  assert.equal(typeof modelA.identityKey, 'string')

  const request = makeRequest('GET', { host: '127.0.0.1:3080' })
  request.url = '/api/all-usage/query?start=' + dateText + '&end=' + dateText + '&utc=0&workspaceId=ws-a&provider=deepseek'
  const scoped = await call(app, '/api/all-usage/query', request)
  assert.equal(scoped.status, 200)
  const query = scoped.json()
  assert.equal(query.usageSchemaVersion, 3)
  assert.equal(query.queryRevision, query.dataRevision + ':' + query.pricingRevision)
  assert.equal(query.dataRevision, full.dataRevision)
  assert.equal(query.metadataRevision, full.metadataRevision)
  assert.equal(query.scope.workspaceId, 'ws-a')
  assert.equal(query.scope.provider, 'deepseek')
  assert.equal(query.totals.calls, 1)
  assert.equal(query.totals.sessions, 1)
  assert.equal(query.totals.input, 10)
  assert.equal(query.totals.cacheRead, 30)
  assert.equal(query.daily.length, 1)
  assert.equal(query.daily[0].tokens.output, 20)
  const scopedHeatmap = query.heatmap.find((row) => row.date === dateText)
  assert.ok(scopedHeatmap)
  assert.equal(scopedHeatmap.turns, 1)
  assert.deepEqual(scopedHeatmap.tokens, { input: 10, output: 20, cacheRead: 30, cacheWrite: 0, reasoning: 0 })
  assert.deepEqual(scopedHeatmap.perWorkspace, [{ workspaceId: 'ws-a', turns: 1 }])
  assert.ok(Array.isArray(query.hourly))
  assert.ok(query.hourly.length >= 1 && query.hourly.length <= 24)
  const currentHour = query.hourly.find((row) => eventTime >= row.time && eventTime < row.time + 60 * 60 * 1000)
  assert.ok(currentHour)
  assert.equal(currentHour.turns, 1)
  assert.equal(currentHour.calls, 1)
  assert.equal(currentHour.tokens.input, 10)
  assert.equal(currentHour.tokens.cacheRead, 30)
  assert.ok(Array.isArray(query.heatmap))
  const longRequest = makeRequest('GET', { host: '127.0.0.1:3080' })
  const previousDate = new Date(date); previousDate.setDate(previousDate.getDate() - 1)
  const previousDateText = previousDate.getFullYear() + '-' + String(previousDate.getMonth() + 1).padStart(2, '0') + '-' + String(previousDate.getDate()).padStart(2, '0')
  longRequest.url = '/api/all-usage/query?start=' + previousDateText + '&end=' + dateText + '&utc=0&workspaceId=ws-a&provider=deepseek'
  const longQuery = await call(app, '/api/all-usage/query', longRequest)
  assert.equal(longQuery.status, 200)
  assert.deepEqual(longQuery.json().hourly, [])
  const modelRequest = makeRequest('GET', { host: '127.0.0.1:3080' })
  modelRequest.url = '/api/all-usage/query?start=' + dateText + '&end=' + dateText + '&utc=0&modelKey=' + encodeURIComponent(modelA.identityKey)
  const modelQuery = await call(app, '/api/all-usage/query', modelRequest)
  assert.equal(modelQuery.json().totals.input, 10)
  assert.equal(modelQuery.json().totals.sessions, 1)
  const modelNameRequest = makeRequest('GET', { host: '127.0.0.1:3080' })
  modelNameRequest.url = '/api/all-usage/query?start=' + dateText + '&end=' + dateText + '&utc=0&provider=deepseek&modelKey=' + encodeURIComponent(modelA.actualModel)
  const modelNameQuery = await call(app, '/api/all-usage/query', modelNameRequest)
  assert.equal(modelNameQuery.json().totals.input, 10)
  assert.equal(modelNameQuery.json().totals.sessions, 1)
  const conflictingModelRequest = makeRequest('GET', { host: '127.0.0.1:3080' })
  conflictingModelRequest.url = '/api/all-usage/query?start=' + dateText + '&end=' + dateText + '&utc=0&provider=deepseek&modelKey=actual-b'
  const conflictingModelQuery = await call(app, '/api/all-usage/query', conflictingModelRequest)
  assert.equal(conflictingModelQuery.json().totals.calls, 0)
  assert.equal(app.readCalls.get('s-a'), 1)
  assert.equal(app.readCalls.get('s-b'), 1)

  const recordsRequest = makeRequest('GET', { host: '127.0.0.1:3080' })
  recordsRequest.url = '/api/all-usage/records?start=' + dateText + '&end=' + dateText + '&utc=0&limit=1'
  const page = await call(app, '/api/all-usage/records', recordsRequest)
  assert.equal(page.status, 200)
  const pageBody = page.json()
  assert.equal(pageBody.usageSchemaVersion, 3)
  assert.equal(pageBody.queryRevision, query.queryRevision)
  assert.equal(pageBody.items.length, 1)
  assert.equal(typeof pageBody.items[0].id, 'string')
  assert.equal(Object.hasOwn(pageBody.items[0], 'sid'), false)
  assert.equal(Object.hasOwn(pageBody.items[0], 'sessionId'), false)
  assert.equal(Object.hasOwn(pageBody.items[0], 'path'), false)
  assert.equal(Object.hasOwn(pageBody.items[0], 'prompt'), false)
  assert.equal(Object.hasOwn(pageBody.items[0], 'reply'), false)
  assert.equal(pageBody.hasMore, true)
  const nextRequest = makeRequest('GET', { host: '127.0.0.1:3080' })
  nextRequest.url = '/api/all-usage/records?start=' + dateText + '&end=' + dateText + '&utc=0&limit=1&cursor=' + encodeURIComponent(pageBody.nextCursor)
  const next = await call(app, '/api/all-usage/records', nextRequest)
  assert.equal(next.status, 200)
  assert.notEqual(next.json().items[0].id, pageBody.items[0].id)
  const liveHandlers = app.listeners['session/event'] || []
  liveHandlers[0]({ id: 's-a', header: { cwd: 'C:\\a' } }, usageEvent(Date.now(), 2, 1, { inputTokens: 1, outputTokens: 1 }, 4))
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve))
  const staleRequest = makeRequest('GET', { host: '127.0.0.1:3080' })
  staleRequest.url = '/api/all-usage/records?start=' + dateText + '&end=' + dateText + '&utc=0&limit=1&cursor=' + encodeURIComponent(pageBody.nextCursor)
  assert.equal((await call(app, '/api/all-usage/records', staleRequest)).status, 409)
  const freshRequest = makeRequest('GET', { host: '127.0.0.1:3080' })
  freshRequest.url = '/api/all-usage/records?start=' + dateText + '&end=' + dateText + '&utc=0&limit=1'
  const freshBody = (await call(app, '/api/all-usage/records', freshRequest)).json()
  assert.equal(freshBody.items[0].values.input, 1)
})

test('fills hourly rows for a single calendar day and keeps cross-day trends daily', async () => {
  const firstTime = Date.UTC(2024, 0, 15, 1, 10)
  const secondTime = Date.UTC(2024, 0, 15, 4, 20)
  const app = await createApp({
    workspaces: [{ id: 'ws-hour', path: 'C:\\hour', title: 'Hour' }],
    sessions: [{ header: { id: 's-hour', cwd: 'C:\\hour' } }],
    events: new Map([['s-hour', [
      usageEvent(firstTime, 1, 1, { inputTokens: 10, outputTokens: 20 }, 1),
      usageEvent(secondTime, 2, 1, { inputTokens: 7, outputTokens: 8 }, 2),
    ]]]),
  })
  let snapshot = null
  for (let i = 0; i < 200; i += 1) {
    snapshot = await call(app, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))
    if (snapshot.json().scan.done) break
    await new Promise((resolve) => setImmediate(resolve))
  }
  const request = makeRequest('GET', { host: '127.0.0.1:3080' })
  request.url = '/api/all-usage/query?start=2024-01-15&end=2024-01-15&utc=1&workspaceId=ws-hour'
  const query = (await call(app, '/api/all-usage/query', request)).json()
  assert.equal(query.hourly.length, 24)
  assert.equal(query.hourly[0].time, Date.UTC(2024, 0, 15, 0, 0))
  assert.equal(query.hourly[1].calls, 1)
  assert.equal(query.hourly[1].tokens.input, 10)
  assert.equal(query.hourly[2].calls, 0)
  assert.equal(query.hourly[4].calls, 1)
  assert.equal(query.hourly[4].tokens.output, 8)
  assert.equal(query.totals.calls, 2)
  assert.equal(query.hourly.reduce((sum, row) => sum + row.tokens.input, 0), query.totals.input)
  const longRequest = makeRequest('GET', { host: '127.0.0.1:3080' })
  longRequest.url = '/api/all-usage/query?start=2024-01-14&end=2024-01-15&utc=1&workspaceId=ws-hour'
  const longQuery = (await call(app, '/api/all-usage/query', longRequest)).json()
  assert.deepEqual(longQuery.hourly, [])
})

test('reuses the previous route identity when folding a changed session tail', async () => {
  const eventTime = Date.now() - 60 * 1000
  const firstEvents = [
    { seq: 1, time: eventTime, type: 'request/context', data: { provider: 'provider-a', model: 'requested-a' } },
    usageEvent(eventTime, 1, 1, { inputTokens: 10, outputTokens: 20 }, 2),
    { seq: 3, time: eventTime, type: 'turn/end', data: { turn: 1 } },
  ]
  const secondEvents = firstEvents.concat([
    usageEvent(eventTime, 2, 1, { inputTokens: 5, outputTokens: 6 }, 4),
    { seq: 5, time: eventTime, type: 'turn/end', data: { turn: 2 } },
  ])
  const first = await createApp({ withStorage: true, workspaces: [{ id: 'ws-1', path: 'C:\\repo', title: 'Repo' }], sessions: [{ header: { id: 's-1', cwd: 'C:\\repo' } }], events: new Map([['s-1', firstEvents]]), snapshots: [{ header: { id: 's-1' }, revision: 'r1' }] })
  let snap = null
  for (let i = 0; i < 200; i += 1) { snap = await call(first, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' })); if (snap.json().scan.done) break; await new Promise((resolve) => setImmediate(resolve)) }
  const second = await createApp({ withStorage: true, storage: first.storageUnit, workspaces: [{ id: 'ws-1', path: 'C:\\repo', title: 'Repo' }], sessions: [{ header: { id: 's-1', cwd: 'C:\\repo' } }], events: new Map([['s-1', secondEvents]]), snapshots: [{ header: { id: 's-1' }, revision: 'r2' }] })
  for (let i = 0; i < 200; i += 1) { snap = await call(second, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' })); if (snap.json().scan.done) break; await new Promise((resolve) => setImmediate(resolve)) }
  const row = snap.json().perModel.find((item) => item.provider === 'deepseek')
  assert.ok(row)
  assert.equal(row.actualModel, 'deepseek-chat')
  assert.equal(snap.json().totals.input, 15)
})




test('upgrades a legacy ledger row whose canonical usage key changed', async () => {
  const eventTime = Date.now() - 60 * 1000
  const legacy = { 's-1': { version: 1, sessionId: 's-1', workspaceId: 'ws-1', lastSeq: 2, lastRevision: 'old-rev', turns: [{ key: 'old-turn', time: eventTime, workspaceId: 'ws-1' }], usage: [{ key: 'legacy-key', seq: 2, time: eventTime, workspaceId: 'ws-1', modelId: 'legacy / model', values: { input: 99, output: 88, cacheRead: 0, cacheWrite: 0, reasoning: 0 } }] } }
  const app = await createApp({
    withStorage: true,
    ledgerSeed: legacy,
    workspaces: [{ id: 'ws-1', path: 'C:\\repo', title: 'Repo' }],
    sessions: [{ header: { id: 's-1', cwd: 'C:\\repo' } }],
    events: new Map([['s-1', [
      { seq: 1, time: eventTime, type: 'request/context', data: { provider: 'deepseek', model: 'deepseek-chat' } },
      usageEvent(eventTime, 1, 1, { inputTokens: 3, outputTokens: 4 }, 2),
      { seq: 3, time: eventTime, type: 'turn/end', data: { turn: 1 } },
    ]]]),
    snapshots: [{ header: { id: 's-1' }, revision: 'new-rev' }],
  })
  let snap = null
  for (let i = 0; i < 200; i += 1) { snap = await call(app, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' })); if (snap.json().scan.done) break; await new Promise((resolve) => setImmediate(resolve)) }
  assert.equal(snap.json().totals.input, 3)
  assert.equal(snap.json().totals.output, 4)
  assert.equal(app.readCalls.get('s-1'), 1)
  assert.equal(app.storageUnit.records.sessions['s-1'].version, 3)
  assert.equal(app.storageUnit.records.sessions['s-1'].usage.length, 1)
})

test('rebuilds from the full log when a changed session is truncated', async () => {
  const eventTime = Date.now() - 60 * 1000
  const fullEvents = [
    { seq: 1, time: eventTime, type: 'request/context', data: { provider: 'deepseek', model: 'deepseek-chat' } },
    usageEvent(eventTime, 1, 1, { inputTokens: 10, outputTokens: 20 }, 2),
    { seq: 3, time: eventTime, type: 'turn/end', data: { turn: 1 } },
    usageEvent(eventTime, 2, 1, { inputTokens: 30, outputTokens: 40 }, 4),
  ]
  const truncatedEvents = [
    { seq: 1, time: eventTime, type: 'request/context', data: { provider: 'deepseek', model: 'deepseek-chat' } },
    usageEvent(eventTime, 1, 1, { inputTokens: 3, outputTokens: 4 }, 2),
    { seq: 3, time: eventTime, type: 'turn/end', data: { turn: 1 } },
  ]
  const opts = { withStorage: true, workspaces: [{ id: 'ws-1', path: 'C:\\repo', title: 'Repo' }], sessions: [{ header: { id: 's-1', cwd: 'C:\\repo' } }], snapshots: [{ header: { id: 's-1' }, revision: 'r1' }] }
  const first = await createApp({ ...opts, events: new Map([['s-1', fullEvents]]) })
  let snap = null
  for (let i = 0; i < 200; i += 1) { snap = await call(first, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' })); if (snap.json().scan.done) break; await new Promise((resolve) => setImmediate(resolve)) }
  const second = await createApp({ ...opts, storage: first.storageUnit, events: new Map([['s-1', truncatedEvents]]), snapshots: [{ header: { id: 's-1' }, revision: 'r2' }] })
  for (let i = 0; i < 200; i += 1) { snap = await call(second, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' })); if (snap.json().scan.done) break; await new Promise((resolve) => setImmediate(resolve)) }
  assert.equal(snap.json().totals.input, 3)
  assert.equal(snap.json().totals.output, 4)
  assert.equal(snap.json().totals.turns, 1)
})


test('includes historical turn-only records outside the heatmap window', async () => {
  const eventTime = Date.UTC(2024, 0, 15, 12, 0, 0)
  const app = await createApp({
    workspaces: [{ id: 'ws-old', path: 'C:\\old', title: 'Old' }],
    sessions: [{ header: { id: 's-old', cwd: 'C:\\old' } }],
    events: new Map([['s-old', [
      { seq: 1, time: eventTime - 1, type: 'request/context', data: { provider: 'provider-old', model: 'model-old' } },
      { seq: 2, time: eventTime, type: 'turn/end', data: { turn: 1 } },
    ]]]),
  })
  let snapshot = null
  for (let i = 0; i < 200; i += 1) {
    snapshot = await call(app, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))
    if (snapshot.json().scan.done) break
    await new Promise((resolve) => setImmediate(resolve))
  }
  const request = makeRequest('GET', { host: '127.0.0.1:3080' })
  request.url = '/api/all-usage/query?start=2024-01-15&end=2024-01-15&utc=1&workspaceId=ws-old&provider=provider-old&modelKey=model-old'
  const result = await call(app, '/api/all-usage/query', request)
  assert.equal(result.status, 200)
  assert.equal(result.json().totals.turns, 1)
  assert.equal(result.json().totals.calls, 0)
  assert.equal(result.json().totals.sessions, 1)
  assert.equal(result.json().daily[0].turns, 1)
})

test('backfills the revision on the first read after upgrading (old ledger rows)', async () => {
  const eventTime = Date.now() - 60 * 1000
  const ledger = { 's-1': { version: 1, sessionId: 's-1', workspaceId: 'ws-1', lastSeq: 2, turns: [{ key: '1', time: eventTime, workspaceId: 'ws-1' }], usage: [{ key: 's-1:step:1:1', seq: 2, time: eventTime, workspaceId: 'ws-1', modelId: 'deepseek / deepseek-chat', values: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: 0 } }] } }
  const app = await createApp({
    withStorage: true,
    ledgerSeed: ledger,
    workspaces: [{ id: 'ws-1', path: 'C:\\repo', title: 'Repo' }],
    sessions: [{ header: { id: 's-1', cwd: 'C:\\repo' } }],
    events: new Map([['s-1', [
      { seq: 1, time: eventTime, type: 'turn/end', data: {} },
      usageEvent(eventTime, 1, 1, { inputTokens: 10, outputTokens: 20 }, 2),
    ]]]),
    snapshots: [{ header: { id: 's-1' }, revision: 'rev-9' }],
  })
  let snap = null
  for (let i = 0; i < 200; i += 1) {
    snap = await call(app, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))
    if (snap.json().scan.done && snap.json().totals.turns === 1) break
    await new Promise((resolve) => setImmediate(resolve))
  }
  const body = snap.json()
  assert.equal(body.totals.input, 10)
  assert.equal(body.sync.sessionsRead, 1)
  assert.equal(body.sync.sessionsSkippedByRevision, 0)
  assert.equal(app.readCalls.get('s-1'), 1, 'rows without a stored revision must be read once')
  assert.equal(app.storageUnit.records.sessions['s-1'].version, 3)
  assert.ok(body.perModel.some((row) => row.provider === 'deepseek'), 'upgraded ledger should expose structured identity')
  assert.equal(app.storageUnit.records.sessions['s-1'].lastRevision, 'rev-9')
})

test('syncs models.dev pricing, backfills unpriced rows, and keeps cost consistent across APIs', async () => {
  const eventTime = Date.now() - 60 * 1000
  const app = await createApp({
    withStorage: true,
    workspaces: [{ id: 'ws-cost', path: 'C:/cost', title: 'Cost' }],
    sessions: [{ header: { id: 's-cost', cwd: 'C:/cost' } }],
    events: new Map([['s-cost', [
      { seq: 1, time: eventTime, type: 'request/context', data: { provider: 'sudocode', model: 'gpt-5.5' } },
      usageEvent(eventTime, 1, 1, { inputTokens: 1000000, outputTokens: 2000000, cacheReadTokens: 100000, cacheWriteTokens: 200000, reasoningTokens: 400000 }, 2, 'sudocode', 'gpt-5.5'),
      { seq: 3, time: eventTime, type: 'turn/end', data: { turn: 1 } },
    ]]]),
  })
  let full = null
  for (let i = 0; i < 200; i += 1) {
    full = await call(app, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))
    if (full.json().scan.done && full.json().totals.cost.unpricedCalls === 1) break
    await new Promise((resolve) => setImmediate(resolve))
  }
  const initial = full.json()
  assert.equal(initial.totals.cost.pricedCalls, 0)
  assert.equal(initial.totals.cost.unpricedCalls, 1)
  const token = initial.requestToken
  const pricing = await call(app, '/api/all-usage/pricing', makeRequest('GET', { host: '127.0.0.1:3080' }))
  assert.equal(pricing.status, 200)
  assert.equal(pricing.json().catalogModelCount, 0)
  const modelSearch = makeRequest('GET', { host: '127.0.0.1:3080' })
  modelSearch.url = '/api/all-usage/pricing/models?q=gpt-5.5'
  const modelSearchResult = await call(app, '/api/all-usage/pricing/models', modelSearch)
  assert.deepEqual(modelSearchResult.json().items, [])

  const saveRequest = makeRequest('POST', { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', 'x-all-usage-request-token': token }, JSON.stringify({
    pricing: { catalogEntries: [{ providerId: 'openai', modelId: 'gpt-5.5', displayName: 'GPT-5.5', input: '5', output: '30', cacheRead: '0.5', cacheWrite: '6.25', tiers: [{ type: 'context', size: 2000000, input: '10', output: '40', cacheRead: '1', cacheWrite: '12.5' }] }] },
    backfill: true,
  }))
  const saved = await call(app, '/api/all-usage/pricing', saveRequest)
  assert.equal(saved.status, 200)
  assert.equal(saved.json().backfill.priced, 1)
  const savedTieredModel = saved.json().pricing.usedModels.find((model) => model.pricingModel === 'gpt-5.5')
  assert.equal(savedTieredModel.tiered, true)
  assert.equal(savedTieredModel.tierCount, 1)
  assert.equal(savedTieredModel.inputTokenSemantics, 'fresh')
  assert.equal(Object.hasOwn(savedTieredModel, 'tiers'), false)
  const savedSchedule = saved.json().pricing.tierSchedules.find((schedule) => schedule.id === savedTieredModel.tierScheduleId)
  assert.deepEqual(savedSchedule.tiers, [{ type: 'context', size: 2000000, input: '10', output: '40', cacheRead: '1', cacheWrite: '12.5' }])
  const pricedModelSearch = makeRequest('GET', { host: '127.0.0.1:3080' })
  pricedModelSearch.url = '/api/all-usage/pricing/models?q=gpt-5.5'
  const pricedModelSearchResult = await call(app, '/api/all-usage/pricing/models', pricedModelSearch)
  assert.equal(pricedModelSearchResult.status, 200)
  assert.equal(pricedModelSearchResult.json().items[0].value, 'gpt-5.5')
  assert.equal(pricedModelSearchResult.json().items[0].providerId, 'openai')
  assert.equal(pricedModelSearchResult.json().items[0].tiered, true)
  assert.equal(pricedModelSearchResult.json().items[0].tierCount, 1)

  full = await call(app, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))
  const body = full.json()
  assert.equal(body.usageSchemaVersion, 3)
  assert.equal(body.costSchemaVersion, 1)
  const compactTieredModel = body.pricing.usedModels.find((model) => model.pricingModel === 'gpt-5.5')
  assert.equal(compactTieredModel.tiered, true)
  assert.equal(compactTieredModel.tierCount, 1)
  assert.equal(Object.hasOwn(compactTieredModel, 'tiers'), false)
  assert.equal(Object.hasOwn(compactTieredModel, 'tierScheduleId'), false)
  assert.equal(Object.hasOwn(body.pricing, 'tierSchedules'), false)
  assert.equal(Object.hasOwn(body.pricing, 'config'), false)
  assert.equal(body.totals.cost.input, '5')
  assert.equal(body.totals.cost.output, '60')
  assert.equal(body.totals.cost.cacheRead, '0.05')
  assert.equal(body.totals.cost.cacheWrite, '1.25')
  assert.equal(body.totals.cost.baseTotal, '66.3')
  assert.equal(body.totals.cost.total, '66.3')
  assert.equal(body.totals.cost.pricedCalls, 1)
  assert.equal(body.totals.cost.unpricedCalls, 0)
  assert.equal(body.perModel[0].cost.total, '66.3')
  assert.equal(body.byDay[0].cost.total, '66.3')
  assert.equal(body.byDay[0].byWorkspace[0].cost.total, '66.3')
  assert.equal(app.storageUnit.records.sessions['s-cost'].version, 3)
  assert.equal(app.storageUnit.records.sessions['s-cost'].usage[0].cost.total, '66.3')

  const date = body.byDay[0].date
  const queryRequest = makeRequest('GET', { host: '127.0.0.1:3080' })
  queryRequest.url = '/api/all-usage/query?start=' + date + '&end=' + date + '&utc=0&workspaceId=ws-cost&provider=sudocode'
  const query = await call(app, '/api/all-usage/query', queryRequest)
  assert.equal(query.json().totals.cost.total, '66.3')
  assert.equal(query.json().daily[0].cost.total, '66.3')
  const hourly = query.json().hourly.find((row) => eventTime >= row.time && eventTime < row.time + 60 * 60 * 1000)
  assert.equal(hourly.cost.total, '66.3')

  const recordsRequest = makeRequest('GET', { host: '127.0.0.1:3080' })
  recordsRequest.url = '/api/all-usage/records?start=' + date + '&end=' + date + '&utc=0&workspaceId=ws-cost&provider=sudocode&limit=10'
  const records = await call(app, '/api/all-usage/records', recordsRequest)
  assert.equal(records.json().items[0].cost.total, '66.3')
  assert.equal(Object.hasOwn(records.json().items[0], 'sessionId'), false)

  const changeRequest = makeRequest('POST', { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', 'x-all-usage-request-token': token }, JSON.stringify({
    pricing: { catalogEntries: [{ providerId: 'openai', modelId: 'gpt-5.5', input: '50', output: '300', cacheRead: '5', cacheWrite: '62.5' }] },
    backfill: true,
  }))
  const changed = await call(app, '/api/all-usage/pricing', changeRequest)
  assert.equal(changed.status, 200)
  full = await call(app, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))
  assert.equal(full.json().totals.cost.total, '66.3', 'positive historical cost must remain stable after price changes')
})

test('migrates legacy provider-aware cost snapshots to official model pricing once', async () => {
  const storage = {
    global: { pricing: { catalogEntries: [{ providerId: 'openai', modelId: 'gpt-5.5', input: '5', output: '30', cacheRead: '0.5', cacheWrite: '6.25' }] } },
    records: { sessions: { 's-legacy-cost': {
      version: 3, sessionId: 's-legacy-cost', workspaceId: 'ws-legacy-cost', lastSeq: 2,
      turns: [{ key: '1', seq: 1, time: Date.now() - 60000, workspaceId: 'ws-legacy-cost', turn: 1 }],
      usage: [{ key: 's-legacy-cost:step:1:1', seq: 2, time: Date.now() - 60000, workspaceId: 'ws-legacy-cost', identity: { provider: 'sudocode', requestedModel: 'gpt-5.5', actualModel: 'gpt-5.5', label: 'sudocode / gpt-5.5', legacy: false }, modelId: 'sudocode / gpt-5.5', values: { input: 1000000, output: 1000000, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, cost: { status: 'priced', currency: 'USD', source: 'models.dev', pricingModel: 'gpt-5.5', providerId: 'sudocode', inputTokenSemantics: 'fresh', multiplier: '1', rates: { input: '50', output: '300', cacheRead: '5', cacheWrite: '0' }, breakdown: { input: '50', output: '300', cacheRead: '0', cacheWrite: '0' }, baseTotal: '350', total: '350' } }],
    } } },
    async loadAll() { return { global: this.global, tables: this.records } },
    async putRecord(table, key, value) { if (!this.records[table]) this.records[table] = {}; this.records[table][key] = value },
    async deleteRecord(table, key) { if (this.records[table]) delete this.records[table][key] },
    async setGlobal(value) { this.global = value },
    async close() {},
  }
  const app = await createApp({ withStorage: true, storage, workspaces: [{ id: 'ws-legacy-cost', path: 'C:/legacy-cost', title: 'Legacy Cost' }], sessions: [] })
  let full = null
  for (let i = 0; i < 100; i += 1) {
    full = await call(app, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))
    if (full.json().scan.done) break
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.equal(full.json().totals.cost.total, '35')
  assert.equal(full.json().totals.cost.pricedCalls, 1)
  assert.equal(storage.records.sessions['s-legacy-cost'].usage[0].cost.pricingMode, 'official-model')
  assert.equal(storage.records.sessions['s-legacy-cost'].usage[0].cost.providerId, 'openai')
})

test('persists pricing mappings and overrides through the DSH storage unit', async () => {
  const storage = {
    global: {},
    records: { sessions: {} },
    async loadAll() { return { global: this.global, tables: this.records } },
    async putRecord(table, key, value) { if (!this.records[table]) this.records[table] = {}; this.records[table][key] = value },
    async deleteRecord(table, key) { if (this.records[table]) delete this.records[table][key] },
    async setGlobal(value) { this.global = value },
    async close() {},
  }
  const first = await createApp({ withStorage: true, storage: storage })
  const full = await call(first, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))
  const saved = await call(first, '/api/all-usage/pricing', makeRequest('POST', { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', 'x-all-usage-request-token': full.json().requestToken }, JSON.stringify({
    pricing: { overrides: [{ providerId: 'relay', modelId: 'gpt-5.5', input: '9', output: '18', cacheRead: '0.9', cacheWrite: '0', tiered: true, tiers: [{ type: 'context', size: 200000, input: '18', output: '27', cacheRead: '1.8', cacheWrite: '0' }] }] },
  })))
  assert.equal(saved.status, 200)
  const toggle = await call(first, '/api/all-usage/pricing', makeRequest('POST', { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', 'x-all-usage-request-token': full.json().requestToken }, JSON.stringify({ pricing: { sync: { autoEnabled: true } } })))
  assert.equal(toggle.status, 200)
  assert.equal(toggle.json().pricing.sync.autoEnabled, true)
  assert.equal(toggle.json().pricing.sync.intervalMs, 21600000)
  const second = await createApp({ withStorage: true, storage: storage })
  const pricing = await call(second, '/api/all-usage/pricing', makeRequest('GET', { host: '127.0.0.1:3080' }))
  assert.equal(pricing.json().overrideCount, 1)
  assert.equal(pricing.json().config.overrides[0].input, '9')
  assert.equal(pricing.json().config.overrides[0].tiered, true)
  assert.deepEqual(pricing.json().config.overrides[0].tiers, [{ type: 'context', size: 200000, input: '18', output: '27', cacheRead: '1.8', cacheWrite: '0' }])
})



test('round-trips route-specific pricing mapping identity through the API', async () => {
  const storage = {
    global: {},
    records: { sessions: {} },
    async loadAll() { return { global: this.global, tables: this.records } },
    async putRecord(table, key, value) { if (!this.records[table]) this.records[table] = {}; this.records[table][key] = value },
    async deleteRecord(table, key) { if (this.records[table]) delete this.records[table][key] },
    async setGlobal(value) { this.global = value },
    async close() {},
  }
  const first = await createApp({ withStorage: true, storage })
  const snapshot = await call(first, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))
  const identityKey = '["relay-a","gpt-5.5","gpt-5.5",null]'
  const saved = await call(first, '/api/all-usage/pricing', makeRequest('POST', {
    host: '127.0.0.1:3080',
    origin: 'http://127.0.0.1:3080',
    'x-all-usage-request-token': snapshot.json().requestToken,
  }, JSON.stringify({ pricing: { mappings: [{ identityKey, model: 'gpt-5.5', catalogProviderId: 'openai', catalogModelId: 'gpt-5.5', inputTokenSemantics: 'total', multiplier: '1.5' }] } })))
  assert.equal(saved.status, 200)
  assert.equal(saved.json().pricing.config.mappings[0].identityKey, identityKey)
  assert.equal(saved.json().pricing.config.mappings[0].inputTokenSemantics, 'total')
  assert.equal(saved.json().pricing.config.mappings[0].multiplier, '1.5')
  assert.equal(Object.hasOwn(saved.json().pricing.config.mappings[0], 'usageIdentityKey'), false)
  const second = await createApp({ withStorage: true, storage })
  const loaded = await call(second, '/api/all-usage/pricing', makeRequest('GET', { host: '127.0.0.1:3080' }))
  assert.equal(loaded.json().config.mappings[0].identityKey, identityKey)
  assert.equal(loaded.json().config.mappings[0].inputTokenSemantics, 'total')
  assert.equal(loaded.json().config.mappings[0].multiplier, '1.5')
})

test('counts an assistant usage chunk when the request later fails', async () => {
  const eventTime = Date.now() - 60 * 1000
  const app = await createApp({
    workspaces: [{ id: 'ws-chunk', path: 'C:\\chunk', title: 'Chunk' }],
    sessions: [{ header: { id: 's-chunk', cwd: 'C:\\chunk' } }],
    events: new Map([['s-chunk', [
      { seq: 1, time: eventTime, type: 'request/context', data: { provider: 'deepseek', model: 'deepseek-chat' } },
      usageChunkEvent(eventTime, 1, 1, { inputTokens: 11, outputTokens: 13, cacheReadTokens: 17, cacheWriteTokens: 19, reasoningTokens: 23 }, 2),
      { seq: 3, time: eventTime, type: 'request/error', data: { code: 'upstream-failed' } },
    ]]]),
  })
  const body = (await waitForScan(app)).json()
  assert.equal(body.scan.done, true)
  assert.equal(body.perModel[0].calls, 1)
  assert.equal(body.totals.input, 11)
  assert.equal(body.totals.output, 13)
  assert.equal(body.totals.cacheRead, 17)
  assert.equal(body.totals.cacheWrite, 19)
  assert.equal(body.totals.reasoning, 23)
  assert.equal(body.perModel.length, 1)
  assert.equal(body.perModel[0].model, 'deepseek / deepseek-chat')
})

test('folds a live usage chunk through the shared upsert path', async () => {
  const eventTime = Date.now() - 60 * 1000
  const app = await createApp({
    workspaces: [{ id: 'ws-live-chunk', path: 'C:\\live-chunk', title: 'Live Chunk' }],
    sessions: [],
    readSession: async () => ({ events: [] }),
  })
  const handler = app.listeners['session/event'][0]
  const session = { id: 's-live-chunk', header: { cwd: 'C:\\live-chunk' } }
  handler(session, { seq: 0, time: eventTime, type: 'request/context', data: { provider: 'deepseek', model: 'deepseek-chat' } })
  handler(session, usageChunkEvent(eventTime, 1, 1, { inputTokens: 21, outputTokens: 22, cacheReadTokens: 23 }, 1))
  for (let i = 0; i < 30; i += 1) await new Promise((resolve) => setImmediate(resolve))
  const body = (await call(app, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))).json()
  assert.equal(body.totals.input, 21)
  assert.equal(body.totals.output, 22)
  assert.equal(body.totals.cacheRead, 23)
  assert.equal(body.perModel.length, 1)
  assert.equal(body.perModel[0].model, 'deepseek / deepseek-chat')
})

test('replaces one usage chunk with the final assistant message', async () => {
  const eventTime = Date.now() - 60 * 1000
  const app = await createApp({
    withStorage: true,
    workspaces: [{ id: 'ws-chunk-replace', path: 'C:\\chunk-replace', title: 'Chunk Replace' }],
    sessions: [{ header: { id: 's-chunk-replace', cwd: 'C:\\chunk-replace' } }],
    events: new Map([['s-chunk-replace', [
      { seq: 1, time: eventTime, type: 'request/context', data: { provider: 'deepseek', model: 'deepseek-chat' } },
      usageChunkEvent(eventTime, 1, 1, { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30 }, 2),
      usageEvent(eventTime, 1, 1, { inputTokens: 40, outputTokens: 50, cacheReadTokens: 60, cacheWriteTokens: 70, reasoningTokens: 80 }, 3),
      { seq: 4, time: eventTime, type: 'turn/end', data: { turn: 1 } },
    ]]]),
  })
  const body = (await waitForScan(app)).json()
  assert.equal(body.perModel[0].calls, 1)
  assert.equal(body.totals.input, 40)
  assert.equal(body.totals.output, 50)
  assert.equal(body.totals.cacheRead, 60)
  assert.equal(body.totals.cacheWrite, 70)
  assert.equal(body.totals.reasoning, 80)
  assert.equal(app.storageUnit.records.sessions['s-chunk-replace'].usage.length, 1)
  assert.equal(app.storageUnit.records.sessions['s-chunk-replace'].usage[0].values.input, 40)
  assert.equal(app.storageUnit.records.sessions['s-chunk-replace'].usage[0].seq, 3)
})

test('does not duplicate a chunk when its final message crosses an incremental scan boundary', async () => {
  const eventTime = Date.now() - 60 * 1000
  const firstEvents = [
    { seq: 1, time: eventTime, type: 'request/context', data: { provider: 'deepseek', model: 'deepseek-chat' } },
    usageChunkEvent(eventTime, 1, 1, { inputTokens: 12, outputTokens: 14, cacheReadTokens: 16 }, 2),
  ]
  const secondEvents = firstEvents.concat([
    usageEvent(eventTime, 1, 1, { inputTokens: 32, outputTokens: 34, cacheReadTokens: 36, cacheWriteTokens: 38 }, 3),
  ])
  const opts = {
    withStorage: true,
    workspaces: [{ id: 'ws-boundary', path: 'C:\\boundary', title: 'Boundary' }],
    sessions: [{ header: { id: 's-boundary', cwd: 'C:\\boundary' } }],
    snapshots: [{ header: { id: 's-boundary' }, revision: 'chunk-r1' }],
  }
  const first = await createApp({ ...opts, events: new Map([['s-boundary', firstEvents]]) })
  await waitForScan(first)
  const second = await createApp({
    ...opts,
    storage: first.storageUnit,
    events: new Map([['s-boundary', secondEvents]]),
    snapshots: [{ header: { id: 's-boundary' }, revision: 'chunk-r2' }],
  })
  const body = (await waitForScan(second)).json()
  assert.equal(body.scan.done, true)
  assert.equal(body.perModel[0].calls, 1)
  assert.equal(body.totals.input, 32)
  assert.equal(body.totals.output, 34)
  assert.equal(body.totals.cacheRead, 36)
  assert.equal(body.totals.cacheWrite, 38)
  assert.equal(second.storageUnit.records.sessions['s-boundary'].usage.length, 1)
  assert.equal(second.storageUnit.records.sessions['s-boundary'].usage[0].seq, 3)
})

test('restores the final replacement after flush and restart', async () => {
  const eventTime = Date.now() - 60 * 1000
  const events = [
    { seq: 1, time: eventTime, type: 'request/context', data: { provider: 'deepseek', model: 'deepseek-chat' } },
    usageChunkEvent(eventTime, 1, 1, { inputTokens: 15, outputTokens: 16 }, 2),
    usageEvent(eventTime, 1, 1, { inputTokens: 25, outputTokens: 26, cacheReadTokens: 27, cacheWriteTokens: 28 }, 3),
  ]
  const first = await createApp({
    withStorage: true,
    workspaces: [{ id: 'ws-restart', path: 'C:\\restart', title: 'Restart' }],
    sessions: [],
    events: new Map(),
  })
  await waitForScan(first)
  const flush = first.listeners['session/flush'][0]
  await flush({ id: 's-restart', header: { id: 's-restart', cwd: 'C:\\restart' }, events })
  await waitForLedgerWrite()
  assert.equal(first.storageUnit.records.sessions['s-restart'].usage.length, 1)
  assert.equal(first.storageUnit.records.sessions['s-restart'].usage[0].values.input, 25)

  const second = await createApp({
    withStorage: true,
    storage: first.storageUnit,
    workspaces: [{ id: 'ws-restart', path: 'C:\\restart', title: 'Restart' }],
    sessions: [],
    events: new Map(),
  })
  const body = (await waitForScan(second)).json()
  assert.equal(body.perModel[0].calls, 1)
  assert.equal(body.totals.input, 25)
  assert.equal(body.totals.output, 26)
  assert.equal(body.totals.cacheRead, 27)
  assert.equal(body.totals.cacheWrite, 28)
  assert.equal(second.storageUnit.records.sessions['s-restart'].usage.length, 1)
})

test('ignores incomplete usage events without invalid dates or fabricated models', async () => {
  const eventTime = Date.now() - 60 * 1000
  const app = await createApp({
    workspaces: [{ id: 'ws-invalid', path: 'C:\\invalid', title: 'Invalid' }],
    sessions: [{ header: { id: 's-invalid', cwd: 'C:\\invalid' } }],
    events: new Map([['s-invalid', [
      { seq: 1, time: Number.NaN, type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 9 } } } },
      { seq: 2, time: eventTime, type: 'assistant/chunk', data: { turn: 1, chunk: { type: 'usage', usage: { inputTokens: 10 } } } },
      { seq: 3, time: eventTime, type: 'assistant/message', data: { step: 1, usage: { inputTokens: 11 } } },
      { seq: 4, time: eventTime, type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'delta', usage: { inputTokens: 12 } } } },
      { seq: 5, time: eventTime, type: 'assistant/message', data: { turn: 1, step: 1, usage: null } },
      { seq: 6, time: eventTime, type: 'assistant/message', data: { turn: 1, step: 1, usage: { inputTokens: Number.NaN } } },
    ]]]),
  })
  const body = (await waitForScan(app)).json()
  assert.equal(body.perModel.length, 0)
  assert.deepEqual(body.perModel, [])
  assert.equal(JSON.stringify(body).includes('Invalid Date'), false)
  assert.equal(JSON.stringify(body).includes('undefined'), false)
})

test('aggregates exact multi-call costs from query cubes and keeps heatmap rows minimal', async () => {
  const eventTime = Date.now() - 60 * 1000
  const app = await createApp({
    withStorage: true,
    workspaces: [{ id: 'ws-query-cube', path: 'C:\\query-cube', title: 'Query Cube' }],
    sessions: [{ header: { id: 's-query-cube', cwd: 'C:\\query-cube' } }],
    events: new Map([['s-query-cube', [
      { seq: 1, time: eventTime, type: 'request/context', data: { provider: 'sudocode', model: 'gpt-5.5' } },
      usageEvent(eventTime, 1, 1, { inputTokens: 1000000, outputTokens: 2000000, cacheReadTokens: 100000, cacheWriteTokens: 200000 }, 2, 'sudocode', 'gpt-5.5'),
      { seq: 3, time: eventTime, type: 'turn/end', data: { turn: 1 } },
      usageEvent(eventTime + 1, 2, 1, { inputTokens: 2000000, outputTokens: 1000000, cacheReadTokens: 300000, cacheWriteTokens: 400000 }, 4, 'sudocode', 'gpt-5.5'),
      { seq: 5, time: eventTime + 1, type: 'turn/end', data: { turn: 2 } },
    ]]]),
  })
  const initial = await waitForScan(app)
  const token = initial.json().requestToken
  const pricing = await call(app, '/api/all-usage/pricing', makeRequest('POST', { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', 'x-all-usage-request-token': token }, JSON.stringify({
    pricing: { catalogEntries: [{ providerId: 'openai', modelId: 'gpt-5.5', input: '5', output: '30', cacheRead: '0.5', cacheWrite: '6.25' }] },
    backfill: true,
  })))
  assert.equal(pricing.status, 200)
  const date = new Date(eventTime)
  const dateText = date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0')
  const request = makeRequest('GET', { host: '127.0.0.1:3080' })
  request.url = '/api/all-usage/query?start=' + dateText + '&end=' + dateText + '&utc=0&workspaceId=ws-query-cube&provider=sudocode'
  const query = (await call(app, '/api/all-usage/query', request)).json()
  assert.equal(query.totals.calls, 2)
  assert.equal(query.totals.turns, 2)
  assert.deepEqual(query.totals.cost, { currency: 'USD', input: '15', output: '90', cacheRead: '0.2', cacheWrite: '3.75', baseTotal: '108.95', total: '108.95', pricedCalls: 2, unpricedCalls: 0, ambiguousCalls: 0, unsupportedCalls: 0 })
  assert.deepEqual(query.daily[0].cost, query.totals.cost)
  const hourly = query.hourly.find((row) => eventTime >= row.time && eventTime < row.time + 60 * 60 * 1000)
  assert.deepEqual(hourly.cost, query.totals.cost)
  const heatmap = query.heatmap.find((row) => row.date === dateText)
  assert.ok(heatmap)
  assert.deepEqual(Object.keys(heatmap).sort(), ['date', 'perWorkspace', 'tokens', 'turns'])
  assert.deepEqual(heatmap.tokens, { input: 3000000, output: 3000000, cacheRead: 400000, cacheWrite: 600000, reasoning: 0 })
  assert.deepEqual(heatmap.perWorkspace, [{ workspaceId: 'ws-query-cube', turns: 2 }])
})

test('keeps both repeated local hours of a DST fall-back day as distinct buckets', async () => {
  const previousTz = process.env.TZ
  process.env.TZ = 'America/New_York'
  try {
    // 2024-11-03 in New York: 01:10 EDT (05:10Z) and 01:25 EST (06:25Z) are two
    // different local 01:xx hours, not one bucket.
    const firstBack = Date.UTC(2024, 10, 3, 5, 10)
    const secondBack = Date.UTC(2024, 10, 3, 6, 25)
    const app = await createApp({
      workspaces: [{ id: 'ws-dst', path: 'C:\\dst', title: 'Dst' }],
      sessions: [{ header: { id: 's-dst', cwd: 'C:\\dst' } }],
      events: new Map([['s-dst', [
        usageEvent(firstBack, 1, 1, { inputTokens: 10, outputTokens: 1 }, 1),
        usageEvent(secondBack, 2, 1, { inputTokens: 20, outputTokens: 2 }, 2),
      ]]]),
    })
    let snapshot = null
    for (let i = 0; i < 200; i += 1) {
      snapshot = await call(app, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))
      if (snapshot.json().scan.done) break
      await new Promise((resolve) => setImmediate(resolve))
    }
    const request = makeRequest('GET', { host: '127.0.0.1:3080' })
    request.url = '/api/all-usage/query?start=2024-11-03&end=2024-11-03&utc=0'
    const query = (await call(app, '/api/all-usage/query', request)).json()
    const counted = query.hourly.filter((row) => row.calls > 0)
    assert.equal(query.hourly.length, 25)
    assert.equal(counted.length, 2)
    assert.equal(counted[0].time, Date.UTC(2024, 10, 3, 5, 0))
    assert.equal(counted[0].tokens.input, 10)
    assert.equal(counted[1].time, Date.UTC(2024, 10, 3, 6, 0))
    assert.equal(counted[1].tokens.input, 20)
    assert.equal(query.hourly.reduce((sum, row) => sum + row.tokens.input, 0), 30)
  } finally {
    if (previousTz === undefined) delete process.env.TZ
    else process.env.TZ = previousTz
  }
})

test('rebuilds the full log when a workspace is recreated with a different id', async () => {
  const eventTime = Date.now() - 60 * 1000
  const firstEvents = [
    { seq: 1, time: eventTime, type: 'request/context', data: { provider: 'deepseek', model: 'deepseek-chat' } },
    usageEvent(eventTime, 1, 1, { inputTokens: 10, outputTokens: 20 }, 2),
    { seq: 3, time: eventTime, type: 'turn/end', data: { turn: 1 } },
  ]
  const secondEvents = firstEvents.concat([
    usageEvent(eventTime, 2, 1, { inputTokens: 5, outputTokens: 6 }, 4),
    { seq: 5, time: eventTime, type: 'turn/end', data: { turn: 2 } },
  ])
  const samePath = 'C:\\repo'
  const base = {
    withStorage: true,
    sessions: [{ header: { id: 's-1', cwd: samePath } }],
    snapshots: [{ header: { id: 's-1' }, revision: 'r1' }],
  }
  const first = await createApp({ ...base, workspaces: [{ id: 'ws-old', path: samePath, title: 'Repo' }], events: new Map([['s-1', firstEvents]]) })
  let snap = null
  for (let i = 0; i < 200; i += 1) { snap = await call(first, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' })); if (snap.json().scan.done) break; await new Promise((resolve) => setImmediate(resolve)) }
  // Same path now maps to a NEW workspace id; the stored record is for ws-old.
  const second = await createApp({ ...base, storage: first.storageUnit, workspaces: [{ id: 'ws-new', path: samePath, title: 'Repo' }], events: new Map([['s-1', secondEvents]]) })
  for (let i = 0; i < 200; i += 1) { snap = await call(second, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' })); if (snap.json().scan.done) break; await new Promise((resolve) => setImmediate(resolve)) }
  assert.equal(snap.json().totals.input, 15)
  assert.equal(snap.json().totals.output, 26)
  const perWorkspace = snap.json().perWorkspace
  assert.equal(perWorkspace.length, 1)
  assert.equal(perWorkspace[0].workspaceId, 'ws-new')
  assert.equal(second.storageUnit.records.sessions['s-1'].workspaceId, 'ws-new')
})

test('rebuilds a legacy mixed-workspace ledger record instead of reusing it', async () => {
  const eventTime = Date.now() - 60 * 1000
  const validCost = { status: 'priced', pricingMode: 'official-model', currency: 'USD', source: 'catalog', pricingModel: 'deepseek-chat', providerId: 'deepseek', inputTokenSemantics: 'fresh', multiplier: '1', billableInputTokens: 10, billableOutputTokens: 20, rates: { input: '0.27', output: '1.1', cacheRead: '0.07', cacheWrite: '0.27' }, breakdown: { input: '0', output: '0', cacheRead: '0', cacheWrite: '0' }, baseTotal: '0', total: '0', reason: '', tiered: false, reasoningRateAvailable: false, selectedTier: { type: 'context', size: 0 } }
  const identity = { identityKey: 'deepseek / deepseek-chat', provider: 'deepseek', requestedModel: 'deepseek-chat', actualModel: 'deepseek-chat', label: 'deepseek-chat', legacy: false }
  // An old write could leave record.workspaceId = ws-b while every historical
  // item still carries the previous ws-a; such a record must not be reused.
  const mixed = { version: 3, sessionId: 's-mixed', workspaceId: 'ws-b', lastSeq: 3, lastRevision: 'same-rev', updatedAt: 1000, turns: [{ key: '3', seq: 3, time: eventTime, workspaceId: 'ws-a', turn: 1, identity }], usage: [{ key: 's-mixed:1:2', seq: 2, time: eventTime, workspaceId: 'ws-a', identity, modelId: 'deepseek-chat', turn: 1, step: 1, values: { input: 100, output: 100, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, cost: validCost }], lastIdentity: identity }
  const app = await createApp({
    withStorage: true,
    ledgerSeed: { 's-mixed': mixed },
    workspaces: [{ id: 'ws-b', path: 'C:\\mixed', title: 'Mixed' }],
    sessions: [{ header: { id: 's-mixed', cwd: 'C:\\mixed' } }],
    events: new Map([['s-mixed', [
      { seq: 1, time: eventTime, type: 'request/context', data: { provider: 'deepseek', model: 'deepseek-chat' } },
      usageEvent(eventTime, 1, 1, { inputTokens: 7, outputTokens: 9 }, 2),
      { seq: 3, time: eventTime, type: 'turn/end', data: { turn: 1 } },
    ]]]),
    snapshots: [{ header: { id: 's-mixed' }, revision: 'same-rev' }],
  })
  let snap = null
  for (let i = 0; i < 200; i += 1) { snap = await call(app, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' })); if (snap.json().scan.done) break; await new Promise((resolve) => setImmediate(resolve)) }
  assert.equal(snap.json().totals.input, 7)
  assert.equal(snap.json().totals.output, 9)
  const reconstructed = app.storageUnit.records.sessions['s-mixed']
  assert.equal(reconstructed.workspaceId, 'ws-b')
  assert.equal(reconstructed.usage.length, 1)
  assert.equal(reconstructed.usage[0].workspaceId, 'ws-b')
  assert.equal(reconstructed.turns[0].workspaceId, 'ws-b')
})

test('keeps fractional-hour DST fall-back buckets without losing events', async () => {
  const previousTz = process.env.TZ
  process.env.TZ = 'Australia/Lord_Howe'
  try {
    // 2025-04-06 Lord Howe clocks fall back 02:00 (+11) to 01:30 (+10:30).
    const firstBack = Date.UTC(2025, 3, 5, 14, 45)   // 01:45 +11
    const secondBack = Date.UTC(2025, 3, 5, 15, 15)  // repeated 01:45 +10:30
    const afterBack = Date.UTC(2025, 3, 5, 15, 45)   // 02:15 +10:30
    const app = await createApp({
      workspaces: [{ id: 'ws-lh', path: 'C:\\lh', title: 'Lh' }],
      sessions: [{ header: { id: 's-lh', cwd: 'C:\\lh' } }],
      events: new Map([['s-lh', [
        usageEvent(firstBack, 1, 1, { inputTokens: 1, outputTokens: 0 }, 1),
        usageEvent(secondBack, 2, 1, { inputTokens: 2, outputTokens: 0 }, 2),
        usageEvent(afterBack, 3, 1, { inputTokens: 4, outputTokens: 0 }, 3),
      ]]]),
    })
    let snapshot = null
    for (let i = 0; i < 200; i += 1) {
      snapshot = await call(app, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))
      if (snapshot.json().scan.done) break
      await new Promise((resolve) => setImmediate(resolve))
    }
    const request = makeRequest('GET', { host: '127.0.0.1:3080' })
    request.url = '/api/all-usage/query?start=2025-04-06&end=2025-04-06&utc=0'
    const query = (await call(app, '/api/all-usage/query', request)).json()
    assert.equal(query.totals.calls, 3)
    assert.equal(query.totals.input, 7)
    assert.equal(query.hourly.reduce((sum, row) => sum + row.calls, 0), 3)
    assert.equal(query.hourly.reduce((sum, row) => sum + row.tokens.input, 0), 7)
    const counted = query.hourly.filter((row) => row.calls > 0)
    assert.equal(counted.length, 3)
  } finally {
    if (previousTz === undefined) delete process.env.TZ
    else process.env.TZ = previousTz
  }
})

test('labels Lord Howe spring-forward rows with the true hour boundary', async () => {
  const previousTz = process.env.TZ
  process.env.TZ = 'Australia/Lord_Howe'
  try {
    // 2025-10-05 Lord Howe clocks jump 02:00 (+10:30) to 03:00 (+11).
    const springEvent = Date.UTC(2025, 9, 4, 16, 15) // 03:15 +11
    const app = await createApp({
      workspaces: [{ id: 'ws-lh2', path: 'C:\\lh2', title: 'Lh2' }],
      sessions: [{ header: { id: 's-lh2', cwd: 'C:\\lh2' } }],
      events: new Map([['s-lh2', [
        usageEvent(springEvent, 1, 1, { inputTokens: 3, outputTokens: 0 }, 1),
      ]]]),
    })
    let snapshot = null
    for (let i = 0; i < 200; i += 1) {
      snapshot = await call(app, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))
      if (snapshot.json().scan.done) break
      await new Promise((resolve) => setImmediate(resolve))
    }
    const request = makeRequest('GET', { host: '127.0.0.1:3080' })
    request.url = '/api/all-usage/query?start=2025-10-05&end=2025-10-05&utc=0'
    const query = (await call(app, '/api/all-usage/query', request)).json()
    const row = query.hourly.find((candidate) => candidate.calls > 0)
    assert.equal(query.totals.input, 3)
    assert.equal(row.time, Date.UTC(2025, 9, 4, 16, 0))
  } finally {
    if (previousTz === undefined) delete process.env.TZ
    else process.env.TZ = previousTz
  }
})

test('mixed-workspace records are never tail-folded on flush', async () => {
  const eventTime = Date.now() - 60 * 1000
  const validCost = { status: 'priced', pricingMode: 'official-model', currency: 'USD', source: 'catalog', pricingModel: 'deepseek-chat', providerId: 'deepseek', inputTokenSemantics: 'fresh', multiplier: '1', billableInputTokens: 10, billableOutputTokens: 20, rates: { input: '0.27', output: '1.1', cacheRead: '0.07', cacheWrite: '0.27' }, breakdown: { input: '0', output: '0', cacheRead: '0', cacheWrite: '0' }, baseTotal: '0', total: '0', reason: '', tiered: false, reasoningRateAvailable: false, selectedTier: { type: 'context', size: 0 } }
  const identity = { identityKey: 'deepseek / deepseek-chat', provider: 'deepseek', requestedModel: 'deepseek-chat', actualModel: 'deepseek-chat', label: 'deepseek-chat', legacy: false }
  const mixed = { version: 3, sessionId: 's-flush-mixed', workspaceId: 'ws-b', lastSeq: 3, lastRevision: 'r1', updatedAt: 1000, turns: [{ key: '3', seq: 3, time: eventTime, workspaceId: 'ws-a', turn: 1, identity }], usage: [{ key: 's-flush-mixed:1:2', seq: 2, time: eventTime, workspaceId: 'ws-a', identity, modelId: 'deepseek-chat', turn: 1, step: 1, values: { input: 100, output: 100, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, cost: validCost }], lastIdentity: identity }
  const app = await createApp({
    withStorage: true,
    ledgerSeed: { 's-flush-mixed': mixed },
    workspaces: [{ id: 'ws-b', path: 'C:\\mixed-flush', title: 'MixedFlush' }],
    sessions: [],
    events: new Map(),
  })
  await waitForScan(app)
  // Appending A-workspace events must rebuild the whole record instead of
  // copying the historical B-workspace items into the flushed row.
  await app.listeners['session/flush'][0]({ id: 's-flush-mixed', header: { id: 's-flush-mixed', cwd: 'C:\\mixed-flush' }, events: [
    { seq: 1, time: eventTime, type: 'request/context', data: { provider: 'deepseek', model: 'deepseek-chat' } },
    usageEvent(eventTime, 1, 1, { inputTokens: 8, outputTokens: 9 }, 2),
    { seq: 3, time: eventTime, type: 'turn/end', data: { turn: 1 } },
    usageEvent(eventTime, 2, 1, { inputTokens: 11, outputTokens: 12 }, 4),
    { seq: 5, time: eventTime, type: 'turn/end', data: { turn: 2 } },
  ] })
  await waitForLedgerWrite()
  const record = app.storageUnit.records.sessions['s-flush-mixed']
  assert.equal(record.usage.length, 2)
  assert.equal(record.turns.length, 2)
  for (const item of record.usage) assert.equal(item.workspaceId, 'ws-b')
  for (const turn of record.turns) assert.equal(turn.workspaceId, 'ws-b')
  assert.equal(record.usage.reduce((sum, item) => sum + item.values.input, 0), 19)
})

test('non-finite sequence numbers cannot freeze later flushes', async () => {
  const eventTime = Date.now() - 60 * 1000
  const app = await createApp({
    withStorage: true,
    workspaces: [{ id: 'ws-seq', path: 'C:\\seq', title: 'Seq' }],
    sessions: [],
    events: new Map(),
  })
  await waitForScan(app)
  const flush = app.listeners['session/flush'][0]
  // An unsafe tail sequence must not produce lastSeq=Infinity.
  await flush({ id: 's-seq', header: { id: 's-seq', cwd: 'C:\\seq' }, events: [
    { seq: 1, time: eventTime, type: 'request/context', data: { provider: 'deepseek', model: 'deepseek-chat' } },
    usageEvent(eventTime, 1, 1, { inputTokens: 1, outputTokens: 1 }, 2),
    usageEvent(eventTime, 2, 1, { inputTokens: 2, outputTokens: 2 }, Number.POSITIVE_INFINITY),
  ] })
  await waitForLedgerWrite()
  const firstRecord = app.storageUnit.records.sessions['s-seq']
  assert.equal(firstRecord.lastSeq, 2)
  assert.ok(Number.isSafeInteger(firstRecord.lastSeq))
  // A later normal flush still works and keeps finite sequences.
  await flush({ id: 's-seq', header: { id: 's-seq', cwd: 'C:\\seq' }, events: [
    { seq: 1, time: eventTime, type: 'request/context', data: { provider: 'deepseek', model: 'deepseek-chat' } },
    usageEvent(eventTime, 1, 1, { inputTokens: 5, outputTokens: 6 }, 2),
    { seq: 3, time: eventTime, type: 'turn/end', data: { turn: 1 } },
    usageEvent(eventTime, 2, 1, { inputTokens: 7, outputTokens: 8 }, 4),
    { seq: 5, time: eventTime, type: 'turn/end', data: { turn: 2 } },
  ] })
  await waitForLedgerWrite()
  const record = app.storageUnit.records.sessions['s-seq']
  assert.equal(record.lastSeq, 5)
  assert.equal(record.usage.length, 2)
  for (const item of record.usage) assert.ok(Number.isSafeInteger(item.seq))
})

test('pricing backfill cannot re-enable folding of mixed-workspace records', async () => {
  const eventTime = Date.now() - 60 * 1000
  const unpricedCost = { status: 'unpriced', pricingMode: 'official-model', currency: 'USD', source: 'none', pricingModel: null, providerId: null, inputTokenSemantics: 'fresh', multiplier: '1', billableInputTokens: 100, billableOutputTokens: 100, rates: { input: '0', output: '0', cacheRead: '0', cacheWrite: '0' }, breakdown: { input: '0', output: '0', cacheRead: '0', cacheWrite: '0' }, baseTotal: '0', total: '0', reason: 'model-not-found', tiered: false, reasoningRateAvailable: false }
  const identity = { identityKey: 'deepseek / deepseek-chat', provider: 'deepseek', requestedModel: 'deepseek-chat', actualModel: 'deepseek-chat', label: 'deepseek-chat', legacy: false }
  const mixed = { version: 3, sessionId: 's-backfill', workspaceId: 'ws-b', lastSeq: 3, lastRevision: 'r1', updatedAt: 1000, turns: [{ key: '3', seq: 3, time: eventTime, workspaceId: 'ws-a', turn: 1, identity }], usage: [{ key: 's-backfill:1:2', seq: 2, time: eventTime, workspaceId: 'ws-a', identity, modelId: 'deepseek-chat', turn: 1, step: 1, values: { input: 100, output: 100, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, cost: unpricedCost }], lastIdentity: identity }
  // The mixed record is applied through the ledger-recovery path (read failure),
  // which is how it ends up in the in-memory usage index that backfill repairs.
  const app = await createApp({
    withStorage: true,
    ledgerSeed: { 's-backfill': mixed },
    workspaces: [{ id: 'ws-b', path: 'C:\\backfill', title: 'Backfill' }],
    sessions: [{ header: { id: 's-backfill', cwd: 'C:\\backfill' } }],
    events: new Map([['s-backfill', []]]),
    readSession: async () => { throw new Error('read failed') },
  })
  await waitForScan(app)
  const stats = (await call(app, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))).json()
  const token = stats.requestToken
  // Backfill the unpriced entry through the pricing POST with a small catalog.
  const backfill = await call(app, '/api/all-usage/pricing', makeRequest('POST', { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', 'x-all-usage-request-token': token }, JSON.stringify({ pricing: { catalogEntries: [{ providerId: 'deepseek', modelId: 'deepseek-chat', providerName: 'DeepSeek', displayName: 'DeepSeek Chat', currency: 'USD', input: '0.27', output: '1.1', cacheRead: '0.07', cacheWrite: '0.27', source: 'models.dev', fetchedAt: 0, tiered: false }], mappings: [], overrides: [], sync: { autoEnabled: false } }, backfill: true })))
  assert.equal(backfill.status, 200)
  assert.equal(backfill.json().backfill.priced, 1)
  await waitForLedgerWrite()
  // A flush that appends new events must rebuild, not copy the ws-a items.
  await app.listeners['session/flush'][0]({ id: 's-backfill', header: { id: 's-backfill', cwd: 'C:\\backfill' }, events: [
    { seq: 1, time: eventTime, type: 'request/context', data: { provider: 'deepseek', model: 'deepseek-chat' } },
    usageEvent(eventTime, 1, 1, { inputTokens: 5, outputTokens: 6 }, 2),
    { seq: 3, time: eventTime, type: 'turn/end', data: { turn: 1 } },
    usageEvent(eventTime, 2, 1, { inputTokens: 7, outputTokens: 8 }, 4),
    { seq: 5, time: eventTime, type: 'turn/end', data: { turn: 2 } },
  ] })
  await waitForLedgerWrite()
  const record = app.storageUnit.records.sessions['s-backfill']
  assert.equal(record.usage.length, 2)
  for (const item of record.usage) assert.equal(item.workspaceId, 'ws-b')
  for (const turn of record.turns) assert.equal(turn.workspaceId, 'ws-b')
})

test('invalid live sequences get positional keys and survive restart reuse', async () => {
  const eventTime = Date.now() - 60 * 1000
  const baseEvents = [
    { seq: 1, time: eventTime, type: 'request/context', data: { provider: 'deepseek', model: 'deepseek-chat' } },
    usageEvent(eventTime, 1, 1, { inputTokens: 10, outputTokens: 1 }, 2),
    { seq: 3, time: eventTime, type: 'turn/end', data: { turn: 1 } },
  ]
  const fullEvents = baseEvents.concat([
    { seq: Number.POSITIVE_INFINITY, time: eventTime, type: 'turn/end', data: { turn: 2 } },
    { seq: Number.POSITIVE_INFINITY, time: eventTime, type: 'turn/end', data: { turn: 3 } },
  ])
  const first = await createApp({
    withStorage: true,
    workspaces: [{ id: 'ws-ins', path: 'C:\\ins', title: 'Ins' }],
    sessions: [{ header: { id: 's-ins', cwd: 'C:\\ins' } }],
    events: new Map([['s-ins', baseEvents]]),
    snapshots: [{ header: { id: 's-ins' }, revision: 'r1' }],
  })
  await waitForScan(first)
  const handler = first.listeners['session/event'][0]
  handler({ id: 's-ins', header: { cwd: 'C:\\ins' } }, { seq: Number.POSITIVE_INFINITY, time: eventTime, type: 'turn/end', data: { turn: 2 } })
  handler({ id: 's-ins', header: { cwd: 'C:\\ins' } }, { seq: Number.POSITIVE_INFINITY, time: eventTime, type: 'turn/end', data: { turn: 3 } })
  await new Promise((resolve) => setImmediate(resolve))
  await first.listeners['session/flush'][0]({ id: 's-ins', header: { id: 's-ins', cwd: 'C:\\ins' }, events: fullEvents })
  await waitForLedgerWrite()
  const stored = first.storageUnit.records.sessions['s-ins']
  assert.equal(stored.turns.length, 3)
  assert.ok(stored.turns.every((turn) => turn.key !== 'Infinity'))
  const second = await createApp({
    withStorage: true,
    storage: first.storageUnit,
    workspaces: [{ id: 'ws-ins', path: 'C:\\ins', title: 'Ins' }],
    sessions: [{ header: { id: 's-ins', cwd: 'C:\\ins' } }],
    events: new Map([['s-ins', fullEvents]]),
    snapshots: [{ header: { id: 's-ins' }, revision: 'r1' }],
  })
  const snap = (await waitForScan(second)).json()
  assert.equal(snap.totals.turns, 3)
})

test('legacy invalid-sequence ledger rows are rebuilt from source', async () => {
  const eventTime = Date.now() - 60 * 1000
  const identity = { identityKey: 'deepseek / deepseek-chat', provider: 'deepseek', requestedModel: 'deepseek-chat', actualModel: 'deepseek-chat', label: 'deepseek-chat', legacy: false }
  const validCost = { status: 'priced', pricingMode: 'official-model', currency: 'USD', source: 'catalog', pricingModel: 'deepseek-chat', providerId: 'deepseek', inputTokenSemantics: 'fresh', multiplier: '1', billableInputTokens: 100, billableOutputTokens: 100, rates: { input: '0.27', output: '1.1', cacheRead: '0.07', cacheWrite: '0.27' }, breakdown: { input: '0', output: '0', cacheRead: '0', cacheWrite: '0' }, baseTotal: '0', total: '0', reason: '', tiered: false, reasoningRateAvailable: false, selectedTier: { type: 'context', size: 0 } }
  const polluted = { version: 3, sessionId: 's-polluted', workspaceId: 'ws-poll', lastSeq: -2, lastRevision: 'r1', updatedAt: 1000, turns: [{ key: 'Infinity', seq: -1, time: eventTime, workspaceId: 'ws-poll', turn: 1, identity }], usage: [{ key: 'Infinity', seq: -2, time: eventTime, workspaceId: 'ws-poll', identity, modelId: 'deepseek-chat', turn: 1, step: 1, values: { input: 100, output: 100, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, cost: validCost }], lastIdentity: identity }
  const fullEvents = [
    { seq: 1, time: eventTime, type: 'request/context', data: { provider: 'deepseek', model: 'deepseek-chat' } },
    usageEvent(eventTime, 1, 1, { inputTokens: 10, outputTokens: 2 }, 2),
    { seq: 3, time: eventTime, type: 'turn/end', data: { turn: 1 } },
    usageEvent(eventTime, 2, 1, { inputTokens: 7, outputTokens: 3 }, 4),
    { seq: 5, time: eventTime, type: 'turn/end', data: { turn: 2 } },
  ]
  const app = await createApp({
    withStorage: true,
    ledgerSeed: { 's-polluted': polluted },
    workspaces: [{ id: 'ws-poll', path: 'C:\\poll', title: 'Poll' }],
    sessions: [{ header: { id: 's-polluted', cwd: 'C:\\poll' } }],
    events: new Map([['s-polluted', fullEvents]]),
    snapshots: [{ header: { id: 's-polluted' }, revision: 'r1' }],
  })
  const snap = (await waitForScan(app)).json()
  assert.equal(snap.totals.input, 17)
  assert.equal(snap.totals.turns, 2)
  assert.ok((app.readCalls.get('s-polluted') || 0) >= 1)
  const rebuilt = app.storageUnit.records.sessions['s-polluted']
  assert.ok(rebuilt.turns.every((turn) => turn.key !== 'Infinity'))
})

test('oversized numeric ledger keys are rebuilt from source', async () => {
  const eventTime = Date.now() - 60 * 1000
  const identity = { identityKey: 'deepseek / deepseek-chat', provider: 'deepseek', requestedModel: 'deepseek-chat', actualModel: 'deepseek-chat', label: 'deepseek-chat', legacy: false }
  const validCost = { status: 'priced', pricingMode: 'official-model', currency: 'USD', source: 'catalog', pricingModel: 'deepseek-chat', providerId: 'deepseek', inputTokenSemantics: 'fresh', multiplier: '1', billableInputTokens: 100, billableOutputTokens: 100, rates: { input: '0.27', output: '1.1', cacheRead: '0.07', cacheWrite: '0.27' }, breakdown: { input: '0', output: '0', cacheRead: '0', cacheWrite: '0' }, baseTotal: '0', total: '0', reason: '', tiered: false, reasoningRateAvailable: false, selectedTier: { type: 'context', size: 0 } }
  const oversized = { version: 3, sessionId: 's-oversized', workspaceId: 'ws-ov', lastSeq: Number.MAX_SAFE_INTEGER + 1, lastRevision: 'r1', updatedAt: 1000, turns: [{ key: String(Number.MAX_SAFE_INTEGER + 1), seq: -1, time: eventTime, workspaceId: 'ws-ov', turn: 1, identity }], usage: [{ key: 's-oversized:step:1:1', seq: -1, time: eventTime, workspaceId: 'ws-ov', identity, modelId: 'deepseek-chat', turn: 1, step: 1, values: { input: 100, output: 100, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, cost: validCost }], lastIdentity: identity }
  const fullEvents = [
    { seq: 1, time: eventTime, type: 'request/context', data: { provider: 'deepseek', model: 'deepseek-chat' } },
    usageEvent(eventTime, 1, 1, { inputTokens: 10, outputTokens: 2 }, 2),
    { seq: 3, time: eventTime, type: 'turn/end', data: { turn: 1 } },
    usageEvent(eventTime, 2, 1, { inputTokens: 7, outputTokens: 3 }, 4),
    { seq: 5, time: eventTime, type: 'turn/end', data: { turn: 2 } },
  ]
  const app = await createApp({
    withStorage: true,
    ledgerSeed: { 's-oversized': oversized },
    workspaces: [{ id: 'ws-ov', path: 'C:\\ov', title: 'Ov' }],
    sessions: [{ header: { id: 's-oversized', cwd: 'C:\\ov' } }],
    events: new Map([['s-oversized', fullEvents]]),
    snapshots: [{ header: { id: 's-oversized' }, revision: 'r1' }],
  })
  const snap = (await waitForScan(app)).json()
  assert.equal(snap.totals.input, 17)
  assert.equal(snap.totals.turns, 2)
  assert.ok((app.readCalls.get('s-oversized') || 0) >= 1)
})

test('ledger-recovery cannot clear the rebuild flag of invalid records', async () => {
  const eventTime = Date.now() - 60 * 1000
  const identity = { identityKey: 'deepseek / deepseek-chat', provider: 'deepseek', requestedModel: 'deepseek-chat', actualModel: 'deepseek-chat', label: 'deepseek-chat', legacy: false }
  const validCost = { status: 'priced', pricingMode: 'official-model', currency: 'USD', source: 'catalog', pricingModel: 'deepseek-chat', providerId: 'deepseek', inputTokenSemantics: 'fresh', multiplier: '1', billableInputTokens: 100, billableOutputTokens: 100, rates: { input: '0.27', output: '1.1', cacheRead: '0.07', cacheWrite: '0.27' }, breakdown: { input: '0', output: '0', cacheRead: '0', cacheWrite: '0' }, baseTotal: '0', total: '0', reason: '', tiered: false, reasoningRateAvailable: false, selectedTier: { type: 'context', size: 0 } }
  const polluted = { version: 3, sessionId: 's-recovery', workspaceId: 'ws-rec', lastSeq: -2, lastRevision: 'r1', updatedAt: 1000, turns: [{ key: 'Infinity', seq: -1, time: eventTime, workspaceId: 'ws-rec', turn: 1, identity }], usage: [{ key: 'Infinity', seq: -1, time: eventTime, workspaceId: 'ws-rec', identity, modelId: 'deepseek-chat', turn: 1, step: 1, values: { input: 100, output: 100, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, cost: validCost }], lastIdentity: identity }
  const base = {
    withStorage: true,
    ledgerSeed: { 's-recovery': polluted },
    workspaces: [{ id: 'ws-rec', path: 'C:\\rec', title: 'Rec' }],
    sessions: [{ header: { id: 's-recovery', cwd: 'C:\\rec' } }],
  }
  const first = await createApp({ ...base, events: new Map(), readSession: async () => { throw new Error('read failed') } })
  await waitForScan(first)
  const fullEvents = [
    { seq: 1, time: eventTime, type: 'request/context', data: { provider: 'deepseek', model: 'deepseek-chat' } },
    usageEvent(eventTime, 1, 1, { inputTokens: 10, outputTokens: 2 }, 2),
    { seq: 3, time: eventTime, type: 'turn/end', data: { turn: 1 } },
    usageEvent(eventTime, 2, 1, { inputTokens: 7, outputTokens: 3 }, 4),
    { seq: 5, time: eventTime, type: 'turn/end', data: { turn: 2 } },
  ]
  const second = await createApp({ ...base, storage: first.storageUnit, ledgerSeed: {}, events: new Map([['s-recovery', fullEvents]]) })
  const snap = (await waitForScan(second)).json()
  assert.equal(snap.totals.input, 17)
  assert.equal(snap.totals.turns, 2)
  assert.ok((second.readCalls.get('s-recovery') || 0) >= 1)
})

test('safe-integer sequences prevent live cursor poisoning', async () => {
  const eventTime = Date.now() - 60 * 1000
  const app = await createApp({
    workspaces: [{ id: 'ws-poison', path: 'C:\\poison', title: 'Poison' }],
    sessions: [{ header: { id: 's-poison', cwd: 'C:\\poison' } }],
    events: new Map([['s-poison', [
      { seq: 1, time: eventTime, type: 'request/context', data: { provider: 'deepseek', model: 'deepseek-chat' } },
      usageEvent(eventTime, 1, 1, { inputTokens: 10, outputTokens: 1 }, 2),
      { seq: Number.POSITIVE_INFINITY, time: eventTime, type: 'turn/end', data: { turn: 9 } },
    ]]]),
  })
  await waitForScan(app)
  const handler = app.listeners['session/event'][0]
  handler({ id: 's-poison', header: { cwd: 'C:\\poison' } }, usageEvent(eventTime, 3, 1, { inputTokens: 7, outputTokens: 1 }, 3))
  await new Promise((resolve) => setImmediate(resolve))
  const snap = (await call(app, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))).json()
  assert.equal(snap.totals.input, 17)
})
