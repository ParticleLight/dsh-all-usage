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
    on(event, callback) {
      if (event === 'data' && body !== '') callback(Buffer.from(body))
      if (event === 'end') callback()
      return this
    },
  }
}

async function createApp({ key = 'test-key', workspaces = [], withStorage = false, sessions = [], events = new Map(), listSessions: listSessionsOverride } = {}) {
  const routes = new Map()
  const cleanups = []
  const listeners = {}
  const storageUnit = {
    saved: [],
    async loadAll() {
      return { global: {} }
    },
    async setGlobal(value) {
      this.saved.push(value)
    },
    async close() {},
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
        return { events: events instanceof Map ? (events.get(sid) || []) : [] }
      },
    },
    workspaceRegistry: {
      list() {
        return workspaces
      },
    },
    async timeout() {},
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

test('enforces route methods', async () => {
  const app = await createApp()
  assert.equal((await call(app, '/api/all-usage', makeRequest('POST', { host: '127.0.0.1:3080' }))).status, 405)
  assert.equal((await call(app, '/api/all-usage/balance', makeRequest('POST', { host: '127.0.0.1:3080' }))).status, 405)
  assert.equal((await call(app, '/api/all-usage/alias', makeRequest('GET', { host: '127.0.0.1:3080' }))).status, 405)
})
