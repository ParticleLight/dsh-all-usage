import assert from 'node:assert/strict'
import test from 'node:test'
import { createBalance } from '../lib/balance.js'

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const settle = async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve() }
const body = (total) => JSON.stringify({ balance_infos: [{ currency: 'USD', total_balance: total, granted_balance: '0', topped_up_balance: total }] })
const reply = (total, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => body(total) })

function harness(t, { ref = 'DEEPSEEK_API_KEY', key = 'key-a', fetcher, resolver } = {}) {
  const originalFetch = globalThis.fetch
  const originalNow = Date.now
  t.after(() => { globalThis.fetch = originalFetch; Date.now = originalNow })
  const state = {
    balanceCache: { fetchedAt: 0, payload: null },
    statsRevision: 7,
    totals: { turns: 3, input: 11 },
    querySnapshot: { marker: 'unchanged' },
  }
  const identity = { ref, key }
  const requests = []
  const resolvedRefs = []
  const settings = { get(name) { assert.equal(name, 'llm-deepseek'); return { apiKeyEnv: identity.ref } } }
  const credentials = { async resolve(name) { resolvedRefs.push(name); return resolver ? resolver(name, identity.key) : identity.key === null ? null : { value: identity.key } } }
  globalThis.fetch = async (url, options) => {
    const request = { url, options }
    requests.push(request)
    return fetcher ? fetcher(request, requests.length - 1) : reply(String(requests.length))
  }
  return { state, requests, resolvedRefs, balance: createBalance({ state, services: { settings, credentials } }), setIdentity(nextRef, nextKey) { identity.ref = nextRef; identity.key = nextKey } }
}

test('resolves the configured account before reusing its cached balance', async (t) => {
  const h = harness(t, { fetcher: ({ options }) => reply(options.headers.authorization === 'Bearer key-a' ? '1' : '2') })
  const first = await h.balance.fetchBalance(false)
  h.setIdentity('OTHER_KEY', 'key-b')
  const second = await h.balance.fetchBalance(false)
  assert.equal(first.currencies[0].total, 1)
  assert.equal(second.currencies[0].total, 2)
  assert.equal(h.requests.length, 2)
  assert.deepEqual(h.resolvedRefs, ['DEEPSEEK_API_KEY', 'OTHER_KEY'])
  assert.equal(h.state.balanceCache.payload, second)
})

test('invalidates the cache when the same credential ref resolves to a new key', async (t) => {
  const h = harness(t, { fetcher: ({ options }) => reply(options.headers.authorization === 'Bearer key-a' ? '10' : '20') })
  await h.balance.fetchBalance(false)
  h.setIdentity('DEEPSEEK_API_KEY', 'key-b')
  const result = await h.balance.fetchBalance(false)
  assert.equal(result.currencies[0].total, 20)
  assert.equal(h.requests.length, 2)
})

test('a missing key does not mask a later configured credential', async (t) => {
  const h = harness(t, { key: null })
  assert.deepEqual(await h.balance.fetchBalance(false), { status: 'missing-key' })
  h.setIdentity('DEEPSEEK_API_KEY', 'key-ready')
  const result = await h.balance.fetchBalance(false)
  assert.equal(result.status, 'ok')
  assert.equal(h.requests.length, 1)
})

test('keeps missing-key, unavailable and error statuses distinct', async (t) => {
  const h = harness(t, { fetcher: () => ({ ok: true, status: 200, text: async () => JSON.stringify({ is_available: false }) }) })
  const result = await h.balance.fetchBalance(true)
  assert.equal(result.status, 'unavailable')
  assert.equal(result.messageCode, 'balance-unavailable')
  assert.equal(result.message, 'DeepSeek 接口返回余额不可用（is_available=false）')
})

test('uses the unsupported-runtime message code when fetch is absent', async (t) => {
  const h = harness(t)
  globalThis.fetch = undefined
  const result = await h.balance.fetchBalance(true)
  assert.equal(result.status, 'error')
  assert.equal(result.messageCode, 'unsupported-runtime')
  assert.equal(result.message, '当前 DSH 运行时不支持余额查询')
})

test('keeps the five-minute TTL and lets force bypass it', async (t) => {
  const h = harness(t)
  let now = 1000
  Date.now = () => now
  const first = await h.balance.fetchBalance(false)
  now = 300999
  assert.equal(await h.balance.fetchBalance(false), first)
  assert.equal(h.requests.length, 1)
  now = 301000
  await h.balance.fetchBalance(false)
  assert.equal(h.requests.length, 2)
  now += 1
  await h.balance.fetchBalance(true)
  assert.equal(h.requests.length, 3)
})

test('a late response from a previous account cannot replace the current cache', async (t) => {
  const pending = []
  const h = harness(t, { fetcher: () => { const gate = deferred(); pending.push(gate); return gate.promise } })
  const first = h.balance.fetchBalance(true)
  await settle()
  h.setIdentity('OTHER_KEY', 'key-b')
  const second = h.balance.fetchBalance(true)
  await settle()
  pending[1].resolve(reply('2'))
  const current = await second
  pending[0].resolve(reply('1'))
  await first
  assert.equal(h.state.balanceCache.payload, current)
  assert.equal((await h.balance.fetchBalance(false)).currencies[0].total, 2)
  assert.equal(h.requests.length, 2)
})

test('an older same-account force response cannot replace a newer force result', async (t) => {
  const pending = []
  const h = harness(t, { fetcher: () => { const gate = deferred(); pending.push(gate); return gate.promise } })
  const first = h.balance.fetchBalance(true)
  await settle()
  const second = h.balance.fetchBalance(true)
  await settle()
  pending[1].resolve(reply('2'))
  const current = await second
  pending[0].resolve(reply('1'))
  await first
  assert.equal(h.state.balanceCache.payload, current)
  assert.equal((await h.balance.fetchBalance(false)).currencies[0].total, 2)
  assert.equal(h.requests.length, 2)
})

for (const primed of [false, true]) {
  test('a late same-account credential resolver preserves the newer force result with a ' + (primed ? 'warm' : 'cold') + ' cache', async (t) => {
    const lookups = []
    const totals = primed ? ['0', '22', '11'] : ['22', '11']
    const h = harness(t, {
      resolver: (_name, key) => lookups.length > 0 ? lookups.shift().promise : { value: key },
      fetcher: () => reply(totals.shift()),
    })
    if (primed) await h.balance.fetchBalance(true)
    const firstLookup = deferred()
    const secondLookup = deferred()
    lookups.push(firstLookup, secondLookup)
    const first = h.balance.fetchBalance(true)
    const second = h.balance.fetchBalance(true)
    secondLookup.resolve({ value: 'key-a' })
    const current = await second
    assert.equal(current.currencies[0].total, 22)
    assert.equal(h.state.balanceCache.payload, current)
    firstLookup.resolve({ value: 'key-a' })
    assert.equal((await first).currencies[0].total, 11)
    assert.equal(h.state.balanceCache.payload, current)
    assert.equal(await h.balance.fetchBalance(false), current)
    assert.equal(h.requests.length, primed ? 3 : 2)
  })
}

test('a superseded credential resolver does not reuse a newer lookup cache', async (t) => {
  const lookups = []
  const totals = ['22', '11']
  const h = harness(t, {
    resolver: (_name, key) => lookups.length > 0 ? lookups.shift().promise : { value: key },
    fetcher: () => reply(totals.shift()),
  })
  const firstLookup = deferred()
  const secondLookup = deferred()
  lookups.push(firstLookup, secondLookup)
  const first = h.balance.fetchBalance(false)
  const second = h.balance.fetchBalance(true)
  secondLookup.resolve({ value: 'key-a' })
  const current = await second
  firstLookup.resolve({ value: 'key-a' })
  assert.equal((await first).currencies[0].total, 11)
  assert.equal(h.state.balanceCache.payload, current)
  assert.equal(await h.balance.fetchBalance(false), current)
  assert.equal(h.requests.length, 2)
})

test('a credential resolver from an earlier A-to-B-to-A generation does not publish', async (t) => {
  const lookups = []
  const totals = ['0', '2', '3', '1']
  const h = harness(t, {
    resolver: (_name, key) => lookups.length > 0 ? lookups.shift().promise : { value: key },
    fetcher: () => reply(totals.shift()),
  })
  await h.balance.fetchBalance(true)
  const oldLookup = deferred()
  lookups.push(oldLookup)
  const first = h.balance.fetchBalance(true)
  h.setIdentity('OTHER_KEY', 'key-b')
  assert.equal((await h.balance.fetchBalance(true)).currencies[0].total, 2)
  h.setIdentity('DEEPSEEK_API_KEY', 'key-a')
  const current = await h.balance.fetchBalance(true)
  assert.equal(current.currencies[0].total, 3)
  oldLookup.resolve({ value: 'key-a' })
  assert.equal((await first).currencies[0].total, 1)
  assert.equal(h.state.balanceCache.payload, current)
  assert.equal(await h.balance.fetchBalance(false), current)
  assert.equal(h.requests.length, 4)
})

for (const nextRef of ['DEEPSEEK_API_KEY', 'OTHER_KEY']) {
  test('an old network response stays private while a newer ' + (nextRef === 'OTHER_KEY' ? 'different-account' : 'same-account') + ' lookup is resolving', async (t) => {
    let pendingLookup = null
    const oldNetwork = deferred()
    const networkStarted = deferred()
    const h = harness(t, {
      resolver: (_name, key) => pendingLookup === null ? { value: key } : pendingLookup.promise,
      fetcher: (_request, index) => {
        if (index > 0) return reply('22')
        networkStarted.resolve()
        return oldNetwork.promise
      },
    })
    const first = h.balance.fetchBalance(true)
    await networkStarted.promise
    const cacheBefore = h.state.balanceCache
    const nextKey = nextRef === 'OTHER_KEY' ? 'key-b' : 'key-a'
    h.setIdentity(nextRef, nextKey)
    pendingLookup = deferred()
    const second = h.balance.fetchBalance(true)
    oldNetwork.resolve(reply('11'))
    assert.equal((await first).currencies[0].total, 11)
    assert.equal(h.state.balanceCache, cacheBefore)
    pendingLookup.resolve({ value: nextKey })
    pendingLookup = null
    const current = await second
    assert.equal(current.currencies[0].total, 22)
    assert.equal(h.state.balanceCache.payload, current)
    assert.equal(await h.balance.fetchBalance(false), current)
    assert.equal(h.requests.length, 2)
  })
}

test('HTTP errors redact the full body before truncating the returned detail', async (t) => {
  const key = 'credential-secret-12345'
  const body = 'x'.repeat(290) + key + ' response tail'
  const h = harness(t, { key, fetcher: () => ({ ok: false, status: 403, text: async () => body }) })
  const result = await h.balance.fetchBalance(true)
  assert.equal(result.status, 'error')
  assert.equal(result.messageCode, 'lookup-failed')
  assert.equal(result.message, '余额查询失败')
  assert.doesNotMatch(JSON.stringify(result), /credential|secret-12345/)
  assert.ok(result.detail.length <= 300)
  assert.equal(h.state.balanceCache.payload, result)
  assert.equal(h.state.statsRevision, 7)
  assert.deepEqual(h.state.totals, { turns: 3, input: 11 })
  assert.deepEqual(h.state.querySnapshot, { marker: 'unchanged' })
  assert.deepEqual(Object.keys(h.state.balanceCache).sort(), ['fetchedAt', 'payload'])
})

test('network failures retain error status without exposing transport detail or key', async (t) => {
  const h = harness(t, { fetcher: async () => { throw new Error('transport echoed key-a') } })
  const result = await h.balance.fetchBalance(true)
  assert.equal(result.status, 'error')
  assert.equal(result.messageCode, 'lookup-failed')
  assert.equal(result.message, '余额查询失败')
  assert.doesNotMatch(JSON.stringify(result), /key-a|transport echoed/)
})

test('balance requests stay on the fixed endpoint with the resolved key and 30-second timeout', async (t) => {
  const h = harness(t, { ref: 'CUSTOM_DEEPSEEK_KEY', key: 'fixture-key' })
  const originalSetTimeout = globalThis.setTimeout
  const timeoutDelays = []
  globalThis.setTimeout = (callback, delay, ...args) => { timeoutDelays.push(delay); return originalSetTimeout(callback, delay, ...args) }
  t.after(() => { globalThis.setTimeout = originalSetTimeout })
  await h.balance.fetchBalance(true)
  assert.equal(h.requests[0].url, 'https://api.deepseek.com/user/balance')
  assert.equal(h.requests[0].options.method, 'GET')
  assert.equal(h.requests[0].options.headers.authorization, 'Bearer fixture-key')
  assert.ok(h.requests[0].options.signal instanceof AbortSignal)
  assert.deepEqual(timeoutDelays, [30000])
})
