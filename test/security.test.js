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

async function createApp({ key = 'test-key', workspaces = [], withStorage = false } = {}) {
  const routes = new Map()
  const cleanups = []
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
        return []
      },
      async readSession() {
        return { events: [] }
      },
    },
    workspaceRegistry: {
      list() {
        return workspaces
      },
    },
    async timeout() {},
    on() {},
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
  return { routes, storageUnit, cleanups }
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

test('enforces route methods', async () => {
  const app = await createApp()
  assert.equal((await call(app, '/api/all-usage', makeRequest('POST', { host: '127.0.0.1:3080' }))).status, 405)
  assert.equal((await call(app, '/api/all-usage/balance', makeRequest('POST', { host: '127.0.0.1:3080' }))).status, 405)
  assert.equal((await call(app, '/api/all-usage/alias', makeRequest('GET', { host: '127.0.0.1:3080' }))).status, 405)
})
