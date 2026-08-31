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
  assert.equal((await call(app, '/api/all-usage/query', firstRequest)).json().totals.input, 0)
  assert.equal((await call(app, '/api/all-usage/query', secondRequest)).json().totals.input, 20)
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
  assert.equal(query.scope.workspaceId, 'ws-a')
  assert.equal(query.scope.provider, 'deepseek')
  assert.equal(query.totals.calls, 1)
  assert.equal(query.totals.sessions, 1)
  assert.equal(query.totals.input, 10)
  assert.equal(query.totals.cacheRead, 30)
  assert.equal(query.daily.length, 1)
  assert.equal(query.daily[0].tokens.output, 20)
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
    events: new Map([['s-old', [{ seq: 1, time: eventTime, type: 'turn/end', data: { turn: 1 } }]]]),
  })
  let snapshot = null
  for (let i = 0; i < 200; i += 1) {
    snapshot = await call(app, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))
    if (snapshot.json().scan.done) break
    await new Promise((resolve) => setImmediate(resolve))
  }
  const request = makeRequest('GET', { host: '127.0.0.1:3080' })
  request.url = '/api/all-usage/query?start=2024-01-15&end=2024-01-15&utc=1&workspaceId=ws-old'
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
    pricing: { catalogEntries: [{ providerId: 'openai', modelId: 'gpt-5.5', displayName: 'GPT-5.5', input: '5', output: '30', cacheRead: '0.5', cacheWrite: '6.25' }] },
    backfill: true,
  }))
  const saved = await call(app, '/api/all-usage/pricing', saveRequest)
  assert.equal(saved.status, 200)
  assert.equal(saved.json().backfill.priced, 1)
  const pricedModelSearch = makeRequest('GET', { host: '127.0.0.1:3080' })
  pricedModelSearch.url = '/api/all-usage/pricing/models?q=gpt-5.5'
  const pricedModelSearchResult = await call(app, '/api/all-usage/pricing/models', pricedModelSearch)
  assert.equal(pricedModelSearchResult.status, 200)
  assert.equal(pricedModelSearchResult.json().items[0].value, 'gpt-5.5')
  assert.equal(pricedModelSearchResult.json().items[0].providerId, 'openai')

  full = await call(app, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))
  const body = full.json()
  assert.equal(body.usageSchemaVersion, 3)
  assert.equal(body.costSchemaVersion, 1)
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
    pricing: { overrides: [{ providerId: 'relay', modelId: 'gpt-5.5', input: '9', output: '18', cacheRead: '0.9', cacheWrite: '0' }] },
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
  }, JSON.stringify({ pricing: { mappings: [{ identityKey, model: 'gpt-5.5', catalogProviderId: 'openai', catalogModelId: 'gpt-5.5' }] } })))
  assert.equal(saved.status, 200)
  assert.equal(saved.json().pricing.config.mappings[0].identityKey, identityKey)
  assert.equal(Object.hasOwn(saved.json().pricing.config.mappings[0], 'usageIdentityKey'), false)
  const second = await createApp({ withStorage: true, storage })
  const loaded = await call(second, '/api/all-usage/pricing', makeRequest('GET', { host: '127.0.0.1:3080' }))
  assert.equal(loaded.json().config.mappings[0].identityKey, identityKey)
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
