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

async function createApp({ key = 'test-key', workspaces = [], withStorage = false, sessions = [], events = new Map(), listSessions: listSessionsOverride, readSession: readSessionOverride, ledgerSeed = {}, storage: storageUnitOverride, timeout: timeoutOverride } = {}) {
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
  const ctx = {
    sessionQuery: {
      async listSessions() {
        if (typeof listSessionsOverride === 'function') return listSessionsOverride()
        return sessions
      },
      async readSession(sid) {
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
      if (service === 'subprocess') throw new Error('subprocess must not be requested')
      return undefined
    },
  }
  apply(ctx)
  await new Promise((resolve) => setImmediate(resolve))
  return { routes, storageUnit, cleanups, listeners }
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

test('restricts API routes to loopback and rotates the process token', async () => {
  const first = await createApp()
  const firstStats = await call(first, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))
  assert.equal(firstStats.status, 200)
  const firstToken = firstStats.json().requestToken
  assert.match(firstToken, /^[A-Za-z0-9_-]+$/)

  const remote = await call(first, '/api/all-usage', makeRequest('GET', { host: '192.0.2.10:3080' }))
  assert.equal(remote.status, 403)

  const noPeer = makeRequest('GET', { host: '127.0.0.1:3080' })
  noPeer.socket = undefined
  const missingPeer = await call(first, '/api/all-usage', noPeer)
  assert.equal(missingPeer.status, 403)

  const spoofedPeer = makeRequest('GET', { host: '127.0.0.1:3080' })
  spoofedPeer.socket = { remoteAddress: '203.0.113.7' }
  const spoofedHost = await call(first, '/api/all-usage', spoofedPeer)
  assert.equal(spoofedHost.status, 403)

  const mappedPeer = makeRequest('GET', { host: '127.0.0.1:3080' })
  mappedPeer.socket = { remoteAddress: '::ffff:127.0.0.1' }
  const mappedLoopback = await call(first, '/api/all-usage', mappedPeer)
  assert.equal(mappedLoopback.status, 200)

  const ipv6Peer = makeRequest('GET', { host: '[::1]:3080' })
  ipv6Peer.socket = { remoteAddress: '::1' }
  const ipv6Loopback = await call(first, '/api/all-usage', ipv6Peer)
  assert.equal(ipv6Loopback.status, 200)

  const crossOrigin = await call(first, '/api/all-usage/balance', makeRequest('GET', {
    host: '127.0.0.1:3080',
    origin: 'http://evil.example',
    'x-all-usage-request-token': firstToken,
  }))
  assert.equal(crossOrigin.status, 403)

  const second = await createApp()
  const secondStats = await call(second, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))
  assert.notEqual(secondStats.json().requestToken, firstToken)
  const staleToken = await call(second, '/api/all-usage/alias', makeRequest('POST', {
    host: '127.0.0.1:3080',
    origin: 'http://127.0.0.1:3080',
    'x-all-usage-request-token': firstToken,
  }, JSON.stringify({ workspaceId: 'ws-1', alias: 'stale' })))
  assert.equal(staleToken.status, 403)
})

test('emits a UTC day bucket for English-mode calendar data', async () => {
  const eventTime = Date.now() - 60 * 1000
  const utcDate = new Date(eventTime).toISOString().slice(0, 10)
  const app = await createApp({
    workspaces: [{ id: 'ws-1', path: 'C:\\repo', title: 'Repo', sessionIds: ['s-1'] }],
    sessions: [{ header: { id: 's-1', cwd: 'C:\\repo' } }],
    events: new Map([['s-1', [{ seq: 1, time: eventTime, type: 'turn/end', data: {} }]]]),
  })
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve))
  const snapshot = await call(app, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))
  const utcDay = snapshot.json().byDayUtc.find((day) => day.date === utcDate)
  assert.equal(utcDay && utcDay.turns, 1)
})

test('keeps daily usage and turns older than the former 53-week window', async () => {
  const eventTime = Date.now() - 400 * 24 * 60 * 60 * 1000
  const local = new Date(eventTime)
  const localDate = local.getFullYear() + '-' + String(local.getMonth() + 1).padStart(2, '0') + '-' + String(local.getDate()).padStart(2, '0')
  const utcDate = new Date(eventTime).toISOString().slice(0, 10)
  const app = await createApp({
    workspaces: [{ id: 'ws-1', path: 'C:\\repo', title: 'Repo', sessionIds: ['s-1'] }],
    sessions: [{ header: { id: 's-1', cwd: 'C:\\repo' } }],
    events: new Map([['s-1', [
      { seq: 1, time: eventTime, type: 'turn/end', data: {} },
      { seq: 2, time: eventTime, type: 'assistant/message', data: { turn: 1, step: 1, message: { source: { provider: 'deepseek', model: 'deepseek-chat' } }, usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40, reasoningTokens: 50 } } },
    ]]]),
  })
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve))
  const snapshot = await call(app, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))
  const body = snapshot.json()
  const localDay = body.byDay.find((day) => day.date === localDate)
  const utcDay = body.byDayUtc.find((day) => day.date === utcDate)
  assert.equal(localDay && localDay.turns, 1)
  assert.equal(localDay && localDay.tokens.input, 10)
  assert.equal(localDay && localDay.sessions, 1)
  assert.deepEqual(localDay && localDay.sessionIds, ['s-1'])
  assert.equal(utcDay && utcDay.turns, 1)
  assert.equal(utcDay && utcDay.tokens.input, 10)
  assert.equal(utcDay && utcDay.sessions, 1)
  assert.deepEqual(utcDay && utcDay.sessionIds, ['s-1'])
})

test('retries the baseline scan when listing sessions fails', async () => {
  let attempts = 0
  const eventTime = Date.now() - 60 * 1000
  const app = await createApp({
    workspaces: [{ id: 'ws-1', path: 'C:\\repo', title: 'Repo' }],
    sessions: [{ header: { id: 's-1', cwd: 'C:\\repo' } }],
    events: new Map([['s-1', [{ seq: 1, time: eventTime, type: 'turn/end', data: {} }]]]),
    listSessions: () => {
      attempts += 1
      if (attempts < 2) throw new Error('transient registry failure')
      return [{ header: { id: 's-1', cwd: 'C:\\repo' } }]
    },
  })
  let snapshot = null
  for (let i = 0; i < 200; i += 1) {
    snapshot = await call(app, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))
    if (snapshot.json().scan.done) break
    await new Promise((resolve) => setImmediate(resolve))
  }
  const body = snapshot.json()
  assert.equal(body.scan.done, true)
  assert.ok(attempts >= 2, 'baseline must retry after a failed listSessions')
  assert.equal(body.totals.turns, 1)
})
test('preserves usage after a disposed session disappears', async () => {
  const eventTime = Date.now() - 60 * 1000
  const firstSession = { header: { id: 's-1', cwd: 'C:\\repo' } }
  const secondSession = { header: { id: 's-2', cwd: 'C:\\repo' } }
  let currentSessions = [firstSession, secondSession]
  const app = await createApp({
    workspaces: [{ id: 'ws-1', path: 'C:\\repo', title: 'Repo', sessionIds: ['s-1', 's-2'] }],
    sessions: currentSessions,
    listSessions: () => currentSessions,
    events: new Map([['s-1', [{ seq: 1, time: eventTime, type: 'turn/end', data: {} }]], ['s-2', [{ seq: 1, time: eventTime, type: 'turn/end', data: {} }]]]),
  })
  let snapshot = null
  for (let i = 0; i < 200; i += 1) {
    snapshot = await call(app, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))
    if (snapshot.json().scan.done && snapshot.json().totals.turns === 2) break
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.equal(snapshot.json().totals.turns, 2)
  const disposedHandlers = app.listeners['session/disposed'] || []
  assert.equal(disposedHandlers.length, 1)
  currentSessions = [secondSession]
  disposedHandlers[0]({ id: 's-1' })
  for (let i = 0; i < 200; i += 1) {
    snapshot = await call(app, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))
    if (snapshot.json().scan.done && snapshot.json().totals.turns === 2) break
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.equal(snapshot.json().scan.done, true)
  assert.equal(snapshot.json().totals.turns, 2)
})
test('preserves a deletion hint that arrives during the baseline scan', async () => {
  const eventTime = Date.now() - 60 * 1000
  const firstSession = { header: { id: 's-1', cwd: 'C:\\repo' } }
  const secondSession = { header: { id: 's-2', cwd: 'C:\\repo' } }
  let currentSessions = [firstSession, secondSession]
  let resolveFirstList
  const firstList = new Promise((resolve) => { resolveFirstList = resolve })
  let listCalls = 0
  const app = await createApp({
    workspaces: [{ id: 'ws-1', path: 'C:\\repo', title: 'Repo', sessionIds: ['s-1', 's-2'] }],
    listSessions: () => {
      listCalls += 1
      return listCalls === 1 ? firstList : currentSessions
    },
    events: new Map([['s-1', [{ seq: 1, time: eventTime, type: 'turn/end', data: {} }]], ['s-2', [{ seq: 1, time: eventTime, type: 'turn/end', data: {} }]]]),
  })
  const disposedHandlers = app.listeners['session/disposed'] || []
  assert.equal(disposedHandlers.length, 1)
  currentSessions = [secondSession]
  disposedHandlers[0]({ id: 's-1' })
  resolveFirstList([firstSession, secondSession])
  let snapshot = null
  for (let i = 0; i < 200; i += 1) {
    snapshot = await call(app, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))
    if (snapshot.json().scan.done && snapshot.json().totals.turns === 2) break
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.equal(snapshot.json().scan.done, true)
  assert.equal(snapshot.json().totals.turns, 2)
})
test('persists canonical usage at session flush', async () => {
  const eventTime = Date.now() - 60 * 1000
  const events = [{ seq: 1, time: eventTime, type: 'turn/end', data: {} }, { seq: 2, time: eventTime, type: 'assistant/message', data: { turn: 1, step: 1, message: { source: { provider: 'deepseek', model: 'deepseek-chat' } }, usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40, reasoningTokens: 50 } } }]
  const app = await createApp({
    withStorage: true,
    workspaces: [{ id: 'ws-1', path: 'C:\\repo', title: 'Repo' }],
    sessions: [{ header: { id: 's-1', cwd: 'C:\\repo' } }],
    events: new Map([['s-1', events]]),
  })
  const handlers = app.listeners['session/flush'] || []
  assert.equal(handlers.length, 1)
  await handlers[0]({ id: 's-1', header: { id: 's-1', cwd: 'C:\\repo' }, events })
  const row = app.storageUnit.records.sessions['s-1']
  assert.ok(row)
  assert.equal(row.sessionId, 's-1')
  assert.equal(row.turns.length, 1)
  assert.equal(row.usage.length, 1)
  assert.equal(row.usage[0].values.input, 10)
})

test('rehydrates deleted-session usage from the durable ledger', async () => {
  const eventTime = Date.now() - 60 * 1000
  const ledger = { 's-1': { version: 1, sessionId: 's-1', workspaceId: 'ws-1', turns: [{ key: '1', time: eventTime, workspaceId: 'ws-1' }], usage: [{ key: 's-1:step:1:1', seq: 2, time: eventTime, workspaceId: 'ws-1', modelId: 'deepseek / deepseek-chat', values: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, reasoning: 50 } }] } }
  const app = await createApp({
    withStorage: true,
    ledgerSeed: ledger,
    workspaces: [{ id: 'ws-1', path: 'C:\\repo', title: 'Repo' }],
    sessions: [],
    listSessions: () => [],
  })
  let snapshot = null
  for (let i = 0; i < 100; i += 1) {
    snapshot = await call(app, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))
    if (snapshot.json().scan.done) break
    await new Promise((resolve) => setImmediate(resolve))
  }
  const body = snapshot.json()
  assert.equal(body.scan.done, true)
  assert.equal(body.totals.turns, 1)
  assert.equal(body.totals.input, 10)
  assert.equal(body.totals.sessions, 1)
  assert.equal(body.sync.sessionsRead, 0)
  assert.equal(body.sync.sessionsRestoredFromLedger, 1)
})
test('replaces an existing ledger row without double-counting usage', async () => {
  const eventTime = Date.now() - 60 * 1000
  const firstEvents = [{ seq: 1, time: eventTime, type: 'turn/end', data: {} }, { seq: 2, time: eventTime, type: 'assistant/message', data: { turn: 1, step: 1, message: { source: { provider: 'deepseek', model: 'deepseek-chat' } }, usage: { inputTokens: 10, outputTokens: 20 } } }]
  const secondEvents = [{ seq: 1, time: eventTime, type: 'turn/end', data: {} }, { seq: 2, time: eventTime, type: 'assistant/message', data: { turn: 1, step: 1, message: { source: { provider: 'deepseek', model: 'deepseek-chat' } }, usage: { inputTokens: 30, outputTokens: 40 } } }]
  const app = await createApp({
    withStorage: true,
    workspaces: [{ id: 'ws-1', path: 'C:\\repo', title: 'Repo' }],
    sessions: [{ header: { id: 's-1', cwd: 'C:\\repo' } }],
    events: new Map([['s-1', secondEvents]]),
  })
  const handler = (app.listeners['session/flush'] || [])[0]
  await handler({ id: 's-1', header: { id: 's-1', cwd: 'C:\\repo' }, events: firstEvents })
  await handler({ id: 's-1', header: { id: 's-1', cwd: 'C:\\repo' }, events: secondEvents })
  const row = app.storageUnit.records.sessions['s-1']
  assert.equal(row.usage.length, 1)
  assert.equal(row.usage[0].values.input, 30)
})

test('restores flushed usage in a fresh plugin instance after log deletion', async () => {
  const eventTime = Date.now() - 60 * 1000
  const events = [{ seq: 1, time: eventTime, type: 'turn/end', data: {} }, { seq: 2, time: eventTime, type: 'assistant/message', data: { turn: 1, step: 1, message: { source: { provider: 'deepseek', model: 'deepseek-chat' } }, usage: { inputTokens: 17, outputTokens: 23 } } }]
  const first = await createApp({
    withStorage: true,
    workspaces: [{ id: 'ws-1', path: 'C:\\repo', title: 'Repo' }],
    sessions: [{ header: { id: 's-1', cwd: 'C:\\repo' } }],
    events: new Map([['s-1', events]]),
  })
  const handler = (first.listeners['session/flush'] || [])[0]
  await handler({ id: 's-1', header: { id: 's-1', cwd: 'C:\\repo' }, events })
  const second = await createApp({
    withStorage: true,
    storage: first.storageUnit,
    workspaces: [{ id: 'ws-1', path: 'C:\\repo', title: 'Repo' }],
    sessions: [],
    listSessions: () => [],
  })
  let snapshot = null
  for (let i = 0; i < 100; i += 1) {
    snapshot = await call(second, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))
    if (snapshot.json().scan.done) break
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.equal(snapshot.json().totals.turns, 1)
  assert.equal(snapshot.json().totals.input, 17)
  assert.equal(snapshot.json().totals.output, 23)
})
test('drains queued ledger writes before disposal closes storage', async () => {
  let blockWrites = false
  let putStarted = false
  let resolvePut
  let closed = false
  const putGate = new Promise((resolve) => { resolvePut = resolve })
  const storage = {
    records: { sessions: {} },
    async loadAll() { return { global: {}, tables: this.records } },
    async putRecord(table, key, value) {
      if (blockWrites) { putStarted = true; await putGate }
      this.records[table][key] = value
    },
    async deleteRecord(table, key) { delete this.records[table][key] },
    async setGlobal() {},
    async close() { closed = true },
  }
  const eventTime = Date.now() - 60 * 1000
  const events = [{ seq: 1, time: eventTime, type: 'turn/end', data: {} }]
  const app = await createApp({
    withStorage: true,
    storage,
    workspaces: [{ id: 'ws-1', path: 'C:\\repo', title: 'Repo' }],
    sessions: [{ header: { id: 's-1', cwd: 'C:\\repo' } }],
    events: new Map([['s-1', events]]),
  })
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve))
  blockWrites = true
  const eventListener = (app.listeners['session/event'] || [])[0]
  eventListener({ id: 's-1', header: { id: 's-1', cwd: 'C:\\repo' }, events }, events[0])
  const flush = (app.listeners['session/flush'] || [])[0]({ id: 's-1', header: { id: 's-1', cwd: 'C:\\repo' }, events })
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(putStarted, true)
  const cleanups = app.cleanups.map((cleanup) => cleanup()).filter((value) => value && typeof value.then === 'function')
  resolvePut()
  await flush
  await Promise.all(cleanups)
  assert.equal(closed, true)
  assert.ok(storage.records.sessions['s-1'])
})
test('does not crash when Cordis timer becomes inactive during baseline', async () => {
  let timeoutCalls = 0
  const app = await createApp({
    workspaces: [{ id: 'ws-1', path: 'C:\\repo', title: 'Repo' }],
    sessions: [{ header: { id: 's-1', cwd: 'C:\\repo' } }],
    events: new Map([['s-1', [{ seq: 1, time: Date.now(), type: 'turn/end', data: {} }]]]),
    timeout: () => { timeoutCalls += 1; throw new Error('cannot get required service \"timer\" in inactive context') },
  })
  await new Promise((resolve) => setImmediate(resolve))
  const snapshot = await call(app, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))
  assert.equal(snapshot.status, 200)
  assert.ok(timeoutCalls > 0)
})
test('uses native fetch for balance after loopback and token checks', async () => {
  const app = await createApp({ key: 'secret-key' })
  const stats = await call(app, '/api/all-usage', makeRequest('GET', { host: 'localhost:3080' }))
  const token = stats.json().requestToken
  const requests = []
  const previousFetch = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options })
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ balance_infos: [{ currency: 'CNY', total_balance: '12.50' }] })
      },
    }
  }
  try {
    const missingToken = await call(app, '/api/all-usage/balance', makeRequest('GET', {
      host: 'localhost:3080',
      origin: 'http://localhost:3080',
    }))
    assert.equal(missingToken.status, 403)
    assert.equal(requests.length, 0)

    // Same-origin browser GET requests may omit Origin entirely.
    const valid = await call(app, '/api/all-usage/balance', makeRequest('GET', {
      host: 'localhost:3080',
      'x-all-usage-request-token': token,
    }))
    assert.equal(valid.status, 200)
    assert.deepEqual(valid.json().currencies, [{ currency: 'CNY', total: 12.5, granted: null, toppedUp: null }])
    assert.equal(requests.length, 1)
    assert.equal(requests[0].url, 'https://api.deepseek.com/user/balance')
    assert.equal(requests[0].options.headers.authorization, 'Bearer secret-key')
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('requires the capability for alias writes and persists trusted updates', async () => {
  const app = await createApp({
    workspaces: [{ id: 'ws-1', path: 'C:\\repo', title: 'Repo' }],
    withStorage: true,
  })
  const stats = await call(app, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))
  const token = stats.json().requestToken
  const denied = await call(app, '/api/all-usage/alias', makeRequest('POST', {
    host: '127.0.0.1:3080',
    origin: 'http://127.0.0.1:3080',
  }, JSON.stringify({ workspaceId: 'ws-1', alias: 'denied' })))
  assert.equal(denied.status, 403)

  const allowed = await call(app, '/api/all-usage/alias', makeRequest('POST', {
    host: '127.0.0.1:3080',
    origin: 'http://127.0.0.1:3080',
    'x-all-usage-request-token': token,
  }, JSON.stringify({ workspaceId: 'ws-1', alias: 'Main repo' })))
  assert.equal(allowed.status, 200)
  assert.deepEqual(allowed.json().aliases, { 'ws-1': 'Main repo' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(app.storageUnit.saved, [{ 'ws-1': 'Main repo' }])
})

test('rejects oversized state updates and malformed aliases', async () => {
  const app = await createApp({
    withStorage: true,
    workspaces: [{ id: 'ws-1', path: 'C:\repo', title: 'Repo' }],
  })
  const stats = await call(app, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))
  const token = stats.json().requestToken
  const headers = { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', 'x-all-usage-request-token': token }
  const oversizedPricing = JSON.stringify({ sync: { autoEnabled: false } }) + ' '.repeat(256 * 1024)
  assert.equal((await call(app, '/api/all-usage/pricing', makeRequest('POST', headers, oversizedPricing))).status, 413)
  const seed = await call(app, '/api/all-usage/alias', makeRequest('POST', headers, JSON.stringify({ workspaceId: 'ws-1', alias: 'Keep' })))
  assert.equal(seed.status, 200)
  const invalidAlias = await call(app, '/api/all-usage/alias', makeRequest('POST', headers, JSON.stringify({ workspaceId: 'ws-1', alias: 42 })))
  assert.equal(invalidAlias.status, 400)
  assert.deepEqual(invalidAlias.json().aliases, { 'ws-1': 'Keep' })
  const invalidWorkspace = await call(app, '/api/all-usage/alias', makeRequest('POST', headers, JSON.stringify({ workspaceId: 'x'.repeat(257), alias: 'Ignored' })))
  assert.equal(invalidWorkspace.status, 400)
  const oversizedAlias = JSON.stringify({ workspaceId: 'ws-1', alias: 'Ignored' }) + ' '.repeat(16 * 1024)
  assert.equal((await call(app, '/api/all-usage/alias', makeRequest('POST', headers, oversizedAlias))).status, 413)
})

test('drains alias writes before closing storage', async () => {
  let blockWrites = false
  let writeStarted = false
  let closed = false
  let release
  const writeGate = new Promise((resolve) => { release = resolve })
  const storage = {
    records: { sessions: {} },
    async loadAll() { return { global: {}, tables: this.records } },
    async putRecord(table, key, value) { this.records[table][key] = value },
    async deleteRecord(table, key) { delete this.records[table][key] },
    async setGlobal(value) {
      if (blockWrites) { writeStarted = true; await writeGate }
    },
    async close() { closed = true },
  }
  const app = await createApp({
    withStorage: true,
    storage,
    workspaces: [{ id: 'ws-1', path: 'C:\repo', title: 'Repo' }],
  })
  const stats = await call(app, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))
  const headers = { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', 'x-all-usage-request-token': stats.json().requestToken }
  blockWrites = true
  const aliasRequest = call(app, '/api/all-usage/alias', makeRequest('POST', headers, JSON.stringify({ workspaceId: 'ws-1', alias: 'Queued' })))
  for (let i = 0; i < 50 && !writeStarted; i += 1) await new Promise((resolve) => setImmediate(resolve))
  assert.equal(writeStarted, true)
  const cleanups = app.cleanups.map((cleanup) => cleanup()).filter((value) => value && typeof value.then === 'function')
  assert.equal(closed, false)
  release()
  await aliasRequest
  await Promise.all(cleanups)
  assert.equal(closed, true)
})

test('reports session read failures in the completed scan status', async () => {
  const app = await createApp({
    workspaces: [{ id: 'ws-fail', path: 'C:\fail', title: 'Fail' }],
    sessions: [{ header: { id: 's-fail', cwd: 'C:\fail' } }],
    readSession: async () => { throw new Error('read failed') },
  })
  let snapshot = null
  for (let i = 0; i < 100; i += 1) {
    snapshot = await call(app, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))
    if (snapshot.json().scan.done) break
    await new Promise((resolve) => setImmediate(resolve))
  }
  const body = snapshot.json()
  assert.equal(body.scan.done, true)
  assert.equal(body.scan.failed, 1)
  assert.equal(body.sync.sessionsFailed, 1)
  assert.equal(body.sync.lastErrorCode, 'session-read-failed')
})

test('stops folding events after disposal', async () => {
  const eventTime = Date.now() - 60 * 1000
  const app = await createApp({
    workspaces: [{ id: 'ws-1', path: 'C:\\repo', title: 'Repo' }],
    sessions: [{ header: { id: 's-1', cwd: 'C:\\repo' } }],
    events: new Map([['s-1', [{ seq: 1, time: eventTime, type: 'turn/end', data: {} }]]]),
  })
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve))
  const handlers = app.listeners['session/event'] || []
  assert.equal(handlers.length, 1)
  const emit = (event) => {
    for (const handler of handlers) handler({ id: 's-1', header: { cwd: 'C:\\repo' } }, event)
  }
  emit({ seq: 2, time: Date.now(), type: 'turn/end', data: {} })
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve))
  const before = await call(app, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))
  assert.equal(before.json().totals.turns, 2)
  // The first registered effect only flips the disposal flag; later cleanups
  // would unregister the API routes this assertion still needs.
  app.cleanups[0]()
  emit({ seq: 3, time: Date.now(), type: 'turn/end', data: {} })
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve))
  const after = await call(app, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))
  assert.equal(after.json().totals.turns, 2)
})


test('serves a lightweight status snapshot with full stats route protections', async () => {
  const eventTime = Date.now() - 60 * 1000
  const app = await createApp({
    workspaces: [{ id: 'ws-1', path: 'C:\repo', title: 'Repo', sessionIds: ['s-1'] }],
    sessions: [{ header: { id: 's-1', cwd: 'C:\repo' } }],
    events: new Map([['s-1', [{ seq: 1, time: eventTime, type: 'turn/end', data: {} }]]]),
  })
  let full = null
  for (let i = 0; i < 100; i += 1) {
    full = await call(app, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))
    if (full.json().scan.done) break
    await new Promise((resolve) => setImmediate(resolve))
  }
  const status = await call(app, '/api/all-usage/status', makeRequest('GET', { host: '127.0.0.1:3080' }))
  assert.equal(status.status, 200)
  const body = status.json()
  assert.match(body.instanceId, /^[A-Za-z0-9_-]+$/)
  assert.equal(typeof body.revision, 'number')
  for (const key of ['dataRevision', 'metadataRevision', 'scanRevision', 'pricingRevision']) assert.equal(typeof body[key], 'number')
  assert.equal(body.queryRevision, body.dataRevision + ':' + body.pricingRevision)
  assert.equal(typeof body.updatedAt, 'number')
  assert.equal(body.scan.done, true)
  assert.equal(body.sync.sessionsTotal, 1)
  assert.equal(body.sync.sessionsRead, 1)
  assert.equal(body.sync.persistenceSnapshotsAvailable, false)
  assert.equal(Object.hasOwn(body, 'requestToken'), false)
  assert.equal(Object.hasOwn(body, 'totals'), false)
  assert.equal(Object.hasOwn(body, 'aliases'), false)
  assert.equal(Object.hasOwn(body, 'workspaces'), false)
  assert.equal(Object.hasOwn(body, 'byDay'), false)
  assert.equal(Object.hasOwn(body, 'byDayUtc'), false)
  assert.equal((await call(app, '/api/all-usage/status', makeRequest('GET', { host: '192.0.2.10:3080' }))).status, 403)
  assert.equal((await call(app, '/api/all-usage/status', makeRequest('GET', { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' }))).status, 403)
})

test('advances the status revision after alias and live usage changes', async () => {
  const eventTime = Date.now() - 60 * 1000
  const app = await createApp({
    workspaces: [{ id: 'ws-1', path: 'C:\repo', title: 'Repo', sessionIds: ['s-1'] }],
    sessions: [{ header: { id: 's-1', cwd: 'C:\repo' } }],
    events: new Map([['s-1', [{ seq: 1, time: eventTime, type: 'turn/end', data: {} }]]]),
  })
  let full = null
  for (let i = 0; i < 100; i += 1) {
    full = await call(app, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))
    if (full.json().scan.done) break
    await new Promise((resolve) => setImmediate(resolve))
  }
  const token = full.json().requestToken
  const before = (await call(app, '/api/all-usage/status', makeRequest('GET', { host: '127.0.0.1:3080' }))).json()
  const alias = await call(app, '/api/all-usage/alias', makeRequest('POST', {
    host: '127.0.0.1:3080',
    origin: 'http://127.0.0.1:3080',
    'x-all-usage-request-token': token,
  }, JSON.stringify({ workspaceId: 'ws-1', alias: 'Main' })))
  assert.equal(alias.status, 200)
  await new Promise((resolve) => setImmediate(resolve))
  const afterAlias = (await call(app, '/api/all-usage/status', makeRequest('GET', { host: '127.0.0.1:3080' }))).json()
  assert.ok(afterAlias.revision > before.revision)
  assert.ok(afterAlias.metadataRevision > before.metadataRevision)
  assert.equal(afterAlias.dataRevision, before.dataRevision)
  assert.equal(afterAlias.pricingRevision, before.pricingRevision)
  const handlers = app.listeners['session/event'] || []
  assert.equal(handlers.length, 1)
  handlers[0]({ id: 's-1', header: { cwd: 'C:\repo' } }, { seq: 2, time: eventTime, type: 'turn/end', data: {} })
  await new Promise((resolve) => setImmediate(resolve))
  const afterLive = (await call(app, '/api/all-usage/status', makeRequest('GET', { host: '127.0.0.1:3080' }))).json()
  assert.ok(afterLive.revision > afterAlias.revision)
  assert.ok(afterLive.dataRevision > afterAlias.dataRevision)
  assert.equal(afterLive.metadataRevision, afterAlias.metadataRevision)
  assert.notEqual(afterLive.queryRevision, afterAlias.queryRevision)
  const latest = await call(app, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))
  assert.equal(latest.json().totals.turns, 2)
})


test('guards scoped query and records endpoints and omits private fields', async () => {
  const eventTime = Date.now() - 60 * 1000
  const date = new Date(eventTime)
  const dateText = date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0')
  const app = await createApp({
    workspaces: [{ id: 'ws-1', path: 'C:\repo', title: 'Repo' }],
    sessions: [{ header: { id: 's-1', cwd: 'C:\repo' } }],
    events: new Map([['s-1', [
      { seq: 1, time: eventTime, type: 'request/context', data: { provider: 'deepseek', model: 'deepseek-chat' } },
      { seq: 2, time: eventTime, type: 'assistant/message', data: { turn: 1, step: 1, message: { source: { provider: 'deepseek', model: 'deepseek-chat' } }, usage: { inputTokens: 4, outputTokens: 5 } } },
      { seq: 3, time: eventTime, type: 'turn/end', data: { turn: 1 } },
    ]] ]),
  })
  let full = null
  for (let i = 0; i < 100; i += 1) {
    full = await call(app, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))
    if (full.json().scan.done) break
    await new Promise((resolve) => setImmediate(resolve))
  }
  const queryRequest = makeRequest('GET', { host: '127.0.0.1:3080' })
  queryRequest.url = '/api/all-usage/query?start=' + dateText + '&end=' + dateText + '&utc=0'
  const query = await call(app, '/api/all-usage/query', queryRequest)
  assert.equal(query.status, 200)
  assert.equal(query.headers['cache-control'], 'no-store')
  assert.equal(query.json().totals.calls, 1)
  assert.equal(query.json().totals.sessions, 1)
  assert.equal(Object.hasOwn(query.json(), 'requestToken'), false)
  assert.equal(Object.hasOwn(query.json(), 'sessionIds'), false)
  assert.equal(Object.hasOwn(query.json(), 'workspaces'), false)
  const recordsRequest = makeRequest('GET', { host: '127.0.0.1:3080' })
  recordsRequest.url = '/api/all-usage/records?start=' + dateText + '&end=' + dateText + '&utc=0&limit=201'
  assert.equal((await call(app, '/api/all-usage/records', recordsRequest)).status, 400)
  const badTimezone = makeRequest('GET', { host: '127.0.0.1:3080' })
  badTimezone.url = '/api/all-usage/query?start=' + dateText + '&end=' + dateText + '&utc=2'
  assert.equal((await call(app, '/api/all-usage/query', badTimezone)).status, 400)
  const staleCursor = makeRequest('GET', { host: '127.0.0.1:3080' })
  staleCursor.url = '/api/all-usage/records?start=' + dateText + '&end=' + dateText + '&utc=0&cursor=' + encodeURIComponent(Buffer.from(JSON.stringify({ revision: -1, scope: '{}', offset: 1 })).toString('base64url'))
  assert.equal((await call(app, '/api/all-usage/records', staleCursor)).status, 409)
  const outside = makeRequest('GET', { host: '192.0.2.10:3080' })
  outside.url = '/api/all-usage/query?start=' + dateText + '&end=' + dateText
  assert.equal((await call(app, '/api/all-usage/query', outside)).status, 403)
  const cross = makeRequest('GET', { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' })
  cross.url = '/api/all-usage/records?start=' + dateText + '&end=' + dateText
  assert.equal((await call(app, '/api/all-usage/records', cross)).status, 403)
})

test('enforces route methods', async () => {
  const app = await createApp()
  assert.equal((await call(app, '/api/all-usage', makeRequest('POST', { host: '127.0.0.1:3080' }))).status, 405)
  assert.equal((await call(app, '/api/all-usage/status', makeRequest('POST', { host: '127.0.0.1:3080' }))).status, 405)
  assert.equal((await call(app, '/api/all-usage/query', makeRequest('POST', { host: '127.0.0.1:3080' }))).status, 405)
  assert.equal((await call(app, '/api/all-usage/records', makeRequest('POST', { host: '127.0.0.1:3080' }))).status, 405)
  assert.equal((await call(app, '/api/all-usage/balance', makeRequest('POST', { host: '127.0.0.1:3080' }))).status, 405)
  assert.equal((await call(app, '/api/all-usage/alias', makeRequest('GET', { host: '127.0.0.1:3080' }))).status, 405)
  assert.equal((await call(app, '/api/all-usage/pricing', makeRequest('PUT', { host: '127.0.0.1:3080' }))).status, 405)
  assert.equal((await call(app, '/api/all-usage/pricing/models', makeRequest('POST', { host: '127.0.0.1:3080' }))).status, 405)
  assert.equal((await call(app, '/api/all-usage/pricing/sync', makeRequest('GET', { host: '127.0.0.1:3080' }))).status, 405)
})

test('protects pricing configuration writes with loopback, origin, and process capability', async () => {
  const app = await createApp({ workspaces: [{ id: 'ws-1', path: 'C:\repo', title: 'Repo' }] })
  const stats = await call(app, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))
  const token = stats.json().requestToken
  assert.equal((await call(app, '/api/all-usage/pricing', makeRequest('GET', { host: '127.0.0.1:3080' }))).status, 200)
  const noToken = await call(app, '/api/all-usage/pricing', makeRequest('POST', { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }, JSON.stringify({ sync: { autoEnabled: false } })))
  assert.equal(noToken.status, 403)
  const crossSite = await call(app, '/api/all-usage/pricing', makeRequest('POST', { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', 'sec-fetch-site': 'cross-site', 'x-all-usage-request-token': token }, JSON.stringify({ sync: { autoEnabled: false } })))
  assert.equal(crossSite.status, 403)
  const allowed = await call(app, '/api/all-usage/pricing', makeRequest('POST', { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', 'x-all-usage-request-token': token }, JSON.stringify({ sync: { autoEnabled: false } })))
  assert.equal(allowed.status, 200)
  assert.equal(allowed.json().ok, true)
  assert.equal(allowed.json().pricing.sync.autoEnabled, false)
})

test('waits for the persisted pricing state before serving reads and writes', async () => {
  let releaseLoad = null
  const loadGate = new Promise((resolve) => { releaseLoad = resolve })
  const storageUnit = {
    saved: [],
    records: { sessions: {} },
    async loadAll() {
      await loadGate
      return { global: { pricing: { sync: { autoEnabled: true, intervalMs: 21600000 }, mappings: [], overrides: [], catalogEntries: [] } }, tables: { sessions: {} } }
    },
    async putRecord(table, key, value) {
      if (!this.records[table]) this.records[table] = {}
      this.records[table][key] = value
    },
    async deleteRecord() {},
    async setGlobal(value) { this.saved.push(value) },
    async close() {},
  }
  const app = await createApp({ withStorage: true, storage: storageUnit })
  // The GET must wait for the persisted configuration instead of reporting the
  // default (empty) state that exists before loadPricing resolves.
  const pendingRead = call(app, '/api/all-usage/pricing', makeRequest('GET', { host: '127.0.0.1:3080' }))
  releaseLoad()
  const read = await pendingRead
  assert.equal(read.status, 200)
  assert.equal(read.json().sync.autoEnabled, true)
  const stats = (await call(app, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))).json()
  const token = stats.requestToken
  const write = await call(app, '/api/all-usage/pricing', makeRequest('POST', { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', 'x-all-usage-request-token': token }, JSON.stringify({ sync: { autoEnabled: false } })))
  assert.equal(write.status, 200)
  assert.equal(write.json().pricing.sync.autoEnabled, false)
  assert.ok(storageUnit.saved.some((entry) => entry.pricing && entry.pricing.sync && entry.pricing.sync.autoEnabled === false))
})
