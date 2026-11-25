import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { localeHelperSource } from './support/locale-helpers.js'

// A refused dashboard call carries the rule that failed; the panel turns that code
// into a sentence, so a reader learns which address is missing instead of reading
// "please retry" forever. The wording is pure, so it is sliced out and evaluated.
const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')
const start = source.indexOf('    // ---------- access reason ----------')
const end = source.indexOf('    // ---------- access reason end ----------')
assert.notEqual(start, -1, 'the access-reason start marker must exist')
assert.notEqual(end, -1, 'the access-reason end marker must exist')
assert.ok(end > start, 'the access-reason helpers must sit in one contiguous block')
const block = source.slice(start, end)

const snippet = localeHelperSource(source) + '\n' + block +
  '\nglobalThis.__access = { responseError, reasonOf, pageHost, accessErrorText }'

function load(host = '192.168.168.226:3080') {
  const context = { location: { host } }
  vm.runInNewContext(snippet, context)
  return context.__access
}

const access = load()

test('reads the refusal reason off the response header', () => {
  const error = access.responseError({
    status: 403,
    headers: { get: (name) => (name === 'x-all-usage-forbidden-reason' ? 'host-not-trusted' : null) },
  })
  assert.equal(error.status, 403)
  assert.equal(error.reason, 'host-not-trusted')
  assert.equal(error.message, 'HTTP 403')
  assert.equal(access.reasonOf(error), 'host-not-trusted')
  assert.equal(access.reasonOf(undefined), '')
  assert.equal(access.reasonOf(new Error('boom')), '')

  // A host that answers without the header (or without a Headers object) still
  // produces a usable error instead of throwing.
  assert.equal(access.responseError({ status: 500 }).reason, '')
  assert.equal(access.responseError({ status: 500, headers: null }).reason, '')
})

test('explains a host refusal with the address the browser used', () => {
  const zh = access.accessErrorText('host-not-trusted', 'zh')
  assert.match(zh, /192\.168\.168\.226:3080/u)
  assert.match(zh, /DSH_ALL_USAGE_TRUSTED_HOSTS/u)
  const en = access.accessErrorText('peer-loopback-host', 'en')
  assert.match(en, /192\.168\.168\.226:3080/u)
  assert.match(en, /allowlist/u)
})

test('gives each remaining rule its own sentence and keeps a generic fallback', () => {
  const origin = access.accessErrorText('origin-not-trusted', 'en')
  const crossSite = access.accessErrorText('cross-site', 'en')
  const capability = access.accessErrorText('capability-invalid', 'en')
  const fallback = access.accessErrorText('full', 'en')
  assert.match(origin, /reverse proxy/u)
  assert.match(crossSite, /cross-site/u)
  assert.match(capability, /refresh the page/u)
  assert.equal(fallback, 'Unable to load usage statistics. Please retry.')
  const distinct = new Set([origin, crossSite, capability, fallback])
  assert.equal(distinct.size, 4, 'each rule reads differently')
})

test('survives a sandbox without a location object', () => {
  const bare = load('')
  assert.equal(typeof bare.pageHost(), 'string')
  assert.match(bare.accessErrorText('host-not-trusted', 'en'), /allowlist/u)
})
