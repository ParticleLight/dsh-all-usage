import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { localeHelperSource } from './support/locale-helpers.js'

const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')
function between(start, end) {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from)
  assert.ok(from >= 0 && to > from, 'client balance function boundaries must exist')
  return source.slice(from, to)
}
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const settle = async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve() }
function harness(fetcher) {
  const state = { balance: null, calls: [] }
  const context = {
    fetch: (url, options) => { state.calls.push({ url, options }); return fetcher(url, options) },
    setBalance: (value) => { state.balance = value },
  }
  const code = between('    function createRequestGate', '    function rangeFilenamePart') + '\n' +
    between('    const getBalance =', '    const setAliasRpc =') + '\n' +
    'let alive = true; let requestToken = "token-a"; const balanceGate = createRequestGate();\n' +
    between('        const refreshBalance = (force) => {', '        const scheduleRetry =') +
    '\nglobalThis.api = { refresh: refreshBalance, unmount() { alive = false }, token(value) { requestToken = value } }'
  vm.runInNewContext(code, context)
  return { state, ...context.api }
}
function display(balance, language = 'en') {
  const context = { balance, language, money: (currency, value) => currency + ' ' + value }
  vm.runInNewContext(localeHelperSource(source) + '\nconst tr = (zh, en) => pick(language, zh, en);\n' +
    between("      let balanceValue = '—'", '      // brandKey renders') + '\nglobalThis.result = { value: balanceValue, sub: balanceSub }', context)
  return context.result
}
for (const status of [403, 503]) {
  test('balance HTTP ' + status + ' leaves Checking and allows a successful refresh', async () => {
    let failed = true
    const h = harness(async () => failed ? { ok: false, status } : { ok: true, json: async () => ({ status: 'ok', currencies: [{ currency: 'CNY', total: '12.34', granted: '0', toppedUp: '12.34' }] }) })
    h.refresh(false)
    await settle()
    assert.equal(h.state.balance?.status, 'error')
    assert.equal(display(h.state.balance).value, 'Lookup failed')
    assert.match(display(h.state.balance).sub, /Refresh/)
    failed = false
    h.refresh(true)
    await settle()
    assert.equal(h.state.balance.status, 'ok')
    assert.equal(display(h.state.balance).value, 'CNY 12.34')
    assert.equal(h.state.calls[1].url, '/api/all-usage/balance?force=1')
    assert.equal(h.state.calls[1].options.headers['x-all-usage-request-token'], 'token-a')
  })
}
test('balance network failure is visible and never publishes its raw exception', async () => {
  const h = harness(async () => { throw new Error('sensitive transport detail') })
  h.refresh(false)
  await settle()
  assert.equal(h.state.balance?.status, 'error')
  assert.equal(display(h.state.balance).value, 'Lookup failed')
  assert.doesNotMatch(JSON.stringify(h.state.balance), /sensitive transport detail/)
})
test('balance rejects malformed successful payloads instead of retaining Checking', async () => {
  const h = harness(async () => ({ ok: true, json: async () => null }))
  h.refresh(false)
  await settle()
  assert.equal(h.state.balance?.status, 'error')
})
test('late balance success and failure cannot replace the newer request', async () => {
  const pending = []
  const h = harness(() => { const next = deferred(); pending.push(next); return next.promise })
  h.refresh(false)
  h.refresh(true)
  pending[1].resolve({ ok: true, json: async () => ({ status: 'missing-key' }) })
  await settle()
  pending[0].reject(new Error('old network failure'))
  await settle()
  assert.equal(h.state.balance.status, 'missing-key')
  h.refresh(false)
  h.refresh(true)
  pending[3].resolve({ ok: false, status: 503 })
  await settle()
  pending[2].resolve({ ok: true, json: async () => ({ status: 'ok', currencies: [] }) })
  await settle()
  assert.equal(h.state.balance.status, 'error')
})
test('an unmounted dashboard ignores balance completion', async () => {
  const pending = deferred()
  const h = harness(() => pending.promise)
  h.refresh(false)
  h.unmount()
  pending.reject(new Error('late failure'))
  await settle()
  assert.equal(h.state.balance, null)
})
test('balance keeps the server missing-key, unavailable and error states distinguishable', async () => {
  for (const status of ['missing-key', 'unavailable', 'error']) {
    const h = harness(async () => ({ ok: true, json: async () => ({ status }) }))
    h.refresh(false)
    await settle()
    assert.equal(h.state.balance.status, status)
    assert.notEqual(display(h.state.balance).sub, 'Checking…')
  }
})

test('balance message codes outrank legacy server text in the selected language', () => {
  assert.equal(display({ status: 'error', messageCode: 'lookup-failed', message: 'legacy server text' }).sub, 'Balance lookup failed Click Refresh to try again')
  assert.equal(display({ status: 'error', messageCode: 'unsupported-runtime', message: 'legacy server text' }).sub, 'The current DSH runtime does not support balance lookups Click Refresh to try again')
  assert.equal(display({ status: 'unavailable', messageCode: 'balance-unavailable', message: 'legacy server text' }).sub, 'The DeepSeek API reported that balance information is unavailable')
  assert.match(display({ status: 'error', messageCode: 'lookup-failed' }, 'zh').sub, /余额查询失败/)
  assert.match(display({ status: 'error', message: 'legacy error' }).sub, /legacy error/)
})
