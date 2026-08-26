import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
const start = source.indexOf('    function createRequestGate')
const end = source.indexOf('    function rangeFilenamePart')
assert.notEqual(start, -1, 'refresh helper start must exist')
assert.notEqual(end, -1, 'refresh helper end must exist')

const context = {}
vm.runInNewContext(source.slice(start, end) + '\nglobalThis.__refreshHelpers = { createRequestGate, snapshotVersion, statusRequiresFullSnapshot, retryDelayFor }', context)
const { createRequestGate, snapshotVersion, statusRequiresFullSnapshot, retryDelayFor } = context.__refreshHelpers

test('compares full snapshot and status by instance plus revision', () => {
  const snapshot = { instanceId: 'host-a', revision: 7, scan: { done: true } }
  assert.equal(snapshotVersion(snapshot), 'host-a:7')
  assert.equal(snapshotVersion({ instanceId: '', revision: 7 }), null)
  assert.equal(snapshotVersion({ instanceId: 'host-a', revision: '7' }), null)
  assert.equal(statusRequiresFullSnapshot({ instanceId: 'host-a', revision: 7, scan: { done: true } }, snapshot), false)
  assert.equal(statusRequiresFullSnapshot({ instanceId: 'host-a', revision: 8, scan: { done: true } }, snapshot), true)
  assert.equal(statusRequiresFullSnapshot({ instanceId: 'host-b', revision: 7, scan: { done: true } }, snapshot), true)
  assert.equal(statusRequiresFullSnapshot({ instanceId: 'host-a', revision: 7, scan: { done: false } }, snapshot), true)
  assert.equal(statusRequiresFullSnapshot({ instanceId: 'host-a', revision: 7, scan: { done: true } }, null), true)
  assert.equal(statusRequiresFullSnapshot({ scan: { done: true } }, snapshot), true)
})

test('uses bounded exponential refresh retry delays', () => {
  assert.equal(retryDelayFor(1), 5000)
  assert.equal(retryDelayFor(2), 10000)
  assert.equal(retryDelayFor(3), 20000)
  assert.equal(retryDelayFor(4), 40000)
  assert.equal(retryDelayFor(99), 40000)
  assert.equal(retryDelayFor(0), 5000)
  assert.equal(retryDelayFor(undefined), 5000)
})

test('request gates discard stale refresh responses', () => {
  const gate = createRequestGate()
  const first = gate.next()
  const second = gate.next()
  assert.equal(gate.isCurrent(first), false)
  assert.equal(gate.isCurrent(second), true)
})

test('passes the injected timer service into the sidebar dashboard', () => {
  assert.match(source, /const timer = ctx\.get\('timer'\)/)
  assert.match(source, /timerCtx: timer/)
  assert.doesNotMatch(source, /timerCtx: ctx/)
})

test('uses the latest full refresh time as the normal health timestamp', () => {
  assert.match(source, /lastStatsText !== '' \? '已更新 ' \+ lastStatsText/)
  assert.doesNotMatch(source, /syncCompletedAt !== '' \? '已同步 '/)
})
