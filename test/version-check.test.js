import assert from 'node:assert/strict'
import test from 'node:test'
import { VERSION_CHECK_URL, compareVersions, createVersionCheck, fetchLatestVersion, versionStatus } from '../lib/version-check.js'

test('orders release and prerelease tags the way semver does', () => {
  assert.equal(compareVersions('1.1.17', '1.1.18'), -1)
  assert.equal(compareVersions('1.1.18', '1.1.18'), 0)
  assert.equal(compareVersions('1.1.18-rc.1', '1.1.18'), -1)
  assert.equal(compareVersions('1.1.18', '1.1.18-rc.1'), 1)
  assert.equal(compareVersions('1.1.18-rc.1', '1.1.18-rc.2'), -1)
  assert.equal(compareVersions('1.1.18-rc.2', '1.1.18-rc.10'), -1)
  assert.equal(compareVersions('1.1.18-beta', '1.1.18-rc.1'), -1)
  assert.equal(compareVersions('2.0.0', '1.9.9'), 1)
  assert.equal(compareVersions('v1.2.3', '1.2.3'), 0)
  assert.equal(compareVersions('1.1.18+build.5', '1.1.18'), 0)
  // Anything unparseable must never claim an update.
  assert.equal(compareVersions('nightly', '1.1.18'), 0)
  assert.equal(compareVersions(undefined, '1.1.18'), 0)
  assert.equal(versionStatus('nightly', '1.1.18'), 'unknown')
  assert.equal(versionStatus('1.1.17', 'nightly'), 'unknown')
  assert.equal(versionStatus('1.1.17', '1.1.18'), 'outdated')
  assert.equal(versionStatus('1.1.18', '1.1.18'), 'latest')
  assert.equal(versionStatus('1.1.19', '1.1.18'), 'latest')
  assert.equal(versionStatus('1.1.18-rc.2', '1.1.18'), 'outdated')
  assert.equal(versionStatus('', '1.1.18'), 'unknown')
  assert.equal(versionStatus('1.1.17', ''), 'unknown')
})

test('reports fetch failures without inventing a verdict', async () => {
  assert.equal((await fetchLatestVersion(null)).error, 'fetch-unavailable')
  assert.equal((await fetchLatestVersion(async () => ({ ok: false, status: 500 }))).error, 'http-500')
  assert.equal((await fetchLatestVersion(async () => { throw new Error('offline') })).error, 'version-fetch-failed')
  const invalidJson = async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => 'nope' })
  assert.equal((await fetchLatestVersion(invalidJson)).error, 'version-invalid-json')
  const invalidTag = async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ version: 'not-a-version' }) })
  assert.equal((await fetchLatestVersion(invalidTag)).error, 'version-invalid')
  const noVersionField = async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ name: 'dsh-all-usage' }) })
  assert.equal((await fetchLatestVersion(noVersionField)).error, 'version-invalid')
  const ok = ({ version = '1.1.18' } = {}) => async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ version }) })
  const success = await fetchLatestVersion(ok(), { url: 'https://registry.example/latest' })
  assert.equal(success.ok, true)
  assert.equal(success.version, '1.1.18')
  assert.equal(success.sourceUrl, 'https://registry.example/latest')
})

test('caches the registry answer, honours force, and keeps the last good verdict', async () => {
  let calls = 0
  let fail = false
  const fetchImpl = async () => {
    calls += 1
    if (fail) throw new Error('offline')
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ version: '1.1.18' }) }
  }
  const check = createVersionCheck({ currentVersion: '1.1.17', fetchImpl, ttlMs: 60000 })
  assert.equal(check.snapshot().status, 'unknown')
  assert.equal(check.snapshot().latest, null)
  assert.equal(check.snapshot().sourceUrl, VERSION_CHECK_URL)
  const first = await check.read(false)
  assert.equal(first.status, 'outdated')
  assert.equal(first.latest, '1.1.18')
  assert.equal(first.cached, false)
  assert.equal(first.current, '1.1.17')
  assert.equal(calls, 1)
  const cached = await check.read(false)
  assert.equal(cached.cached, true)
  assert.equal(calls, 1)
  const forced = await check.read(true)
  assert.equal(forced.cached, false)
  assert.equal(calls, 2)
  // A failed refresh keeps the last good verdict (and says what went wrong).
  fail = true
  const stale = await check.read(true)
  assert.equal(stale.status, 'outdated')
  assert.equal(stale.latest, '1.1.18')
  assert.equal(stale.error, 'version-fetch-failed')
  // Without a good answer the chip degrades to unknown instead of guessing.
  const broken = createVersionCheck({ currentVersion: '1.1.17', fetchImpl: async () => { throw new Error('offline') }, ttlMs: 60000 })
  const none = await broken.read(false)
  assert.equal(none.status, 'unknown')
  assert.equal(none.latest, null)
  assert.equal(none.checkedAt, null)
  assert.equal(none.error, 'version-fetch-failed')
})
