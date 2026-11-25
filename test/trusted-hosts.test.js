import test from 'node:test'
import assert from 'node:assert/strict'
import { hostnameFromAuthority, isLoopbackHostname, normalizeHostname } from '../lib/net-address.js'
import { createTrustedHosts, parseTrustedHostList } from '../lib/trusted-hosts.js'

test('normalizes host names and addresses the same way everywhere', () => {
  assert.equal(normalizeHostname('  Usage.Example.COM.  '), 'usage.example.com')
  assert.equal(normalizeHostname('[::1]'), '::1')
  assert.equal(normalizeHostname(undefined), '')
  assert.equal(hostnameFromAuthority('usage.example.com:3080'), 'usage.example.com')
  assert.equal(hostnameFromAuthority('https://usage.example.com/panel?x=1'), 'usage.example.com')
  assert.equal(hostnameFromAuthority('[::1]:3080'), '::1')
  assert.equal(hostnameFromAuthority('not a host'), '')
  assert.equal(isLoopbackHostname('LOCALHOST'), true)
  assert.equal(isLoopbackHostname('127.0.0.9'), true)
  assert.equal(isLoopbackHostname('10.0.0.2'), false)
})

test('parses a trusted-host list and drops loopback and unusable entries', () => {
  const names = parseTrustedHostList(' usage.example.com,192.168.168.226:3080, http://extra.example:8443;127.0.0.1,localhost,,[::1] ')
  assert.deepEqual([...names].sort(), ['192.168.168.226', 'extra.example', 'usage.example.com'])
  assert.equal(parseTrustedHostList('').size, 0)
  assert.equal(parseTrustedHostList(undefined).size, 0)
})

test('trusts the advertised URL at once and the listener address as soon as it binds', () => {
  const warnings = []
  const originalWarn = console.warn
  console.warn = (message) => warnings.push(String(message))
  try {
    let listening = false
    const trust = createTrustedHosts({
      getWebApp: () => ({ getAdvertisedUrl: () => 'https://usage.example.com/' }),
      getWebServer: () => ({
        getOrigin() {
          if (!listening) throw new Error('webserver: listener has not bound a port')
          return 'http://192.168.168.226:3080'
        },
      }),
      env: {},
    })
    // Plugins apply before the port is bound: only the advertised name is known.
    assert.deepEqual(trust.names(), ['usage.example.com'])
    assert.equal(trust.has('192.168.168.226'), false)

    listening = true
    // An unsettled answer is never cached, so the next call sees the address.
    assert.equal(trust.has('192.168.168.226'), true)
    assert.equal(trust.has('127.0.0.1'), false)
    assert.equal(trust.has('evil.example'), false)
    assert.equal(trust.names().includes('192.168.168.226'), true)

    trust.refresh()
    assert.deepEqual(trust.names().sort(), ['192.168.168.226', 'usage.example.com'])
    // One line when the advertised URL is known, one more once the listener
    // reports its bound address; repeating the same set says nothing.
    assert.equal(warnings.length, 2)
    assert.match(warnings[0], /usage\.example\.com/u)
    assert.doesNotMatch(warnings[0], /192\.168\.168\.226/u)
    assert.match(warnings[1], /192\.168\.168\.226/u)
    trust.names()
    assert.equal(warnings.length, 2, 'an unchanged allowlist is not announced twice')
  } finally {
    console.warn = originalWarn
  }
})

test('environment host names are added and strict mode ignores every source', () => {
  const originalWarn = console.warn
  console.warn = () => {}
  try {
    const env = { DSH_ALL_USAGE_TRUSTED_HOSTS: 'alias.example, 10.1.2.3:8080' }
    const trust = createTrustedHosts({
      getWebApp: () => ({ getAdvertisedUrl: () => 'https://usage.example.com/' }),
      getWebServer: () => ({ getOrigin: () => 'http://192.168.168.226:3080' }),
      env,
    })
    assert.deepEqual(trust.names().sort(), ['10.1.2.3', '192.168.168.226', 'alias.example', 'usage.example.com'])

    const strict = createTrustedHosts({
      getWebApp: () => ({ getAdvertisedUrl: () => 'https://usage.example.com/' }),
      getWebServer: () => ({ getOrigin: () => 'http://192.168.168.226:3080' }),
      env: { ...env, DSH_ALL_USAGE_STRICT_LOCAL: '1' },
    })
    assert.equal(strict.strict, true)
    assert.equal(strict.has('usage.example.com'), false)
    assert.equal(strict.has('192.168.168.226'), false)
    assert.deepEqual(strict.names(), [])
  } finally {
    console.warn = originalWarn
  }
})

test('a host without a web server or web app still answers loopback only', () => {
  const originalWarn = console.warn
  console.warn = () => {}
  try {
    const trust = createTrustedHosts({ getWebApp: () => undefined, getWebServer: () => undefined, env: {} })
    assert.deepEqual(trust.names(), [])
    assert.equal(trust.has('usage.example.com'), false)
  } finally {
    console.warn = originalWarn
  }
})
