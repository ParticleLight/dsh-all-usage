// Recovery acceptance uses real temporary files and real ledger/aggregation modules.
// Injected I/O rejection is not an assertion about operating-system power loss.
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { archiveRecords } from '../lib/archive.js'
import { serializeLedgerRecord } from '../lib/ledger.js'
import { normalizePricingState, serializeCostAggregate } from '../lib/pricing.js'
import { createInvariantHost, createLedgerBackend, createTempRoot, removeTempRoot } from './support/ledger-invariants.js'

const TOKENS = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning']
const RATES = { input: 1000000n, output: 2000000n, cacheRead: 250000n, cacheWrite: 500000n }
const MONTH = '2026-05'
const CUTOFF = Date.parse('2026-09-01T00:00:00Z')
const SPECS = [
  { id: 'recovery-existing', workspaceId: 'w-alpha', model: 'deepseek-v4-flash', factor: 1, time: Date.parse('2026-05-30T23:30:00Z'), updatedAt: Date.parse('2026-05-31T01:00:00Z'), values: [11, 2, 3, 4, 5] },
  { id: 'recovery-new-alpha', workspaceId: 'w-alpha', model: 'deepseek-v4-flash', factor: 1, time: Date.parse('2026-05-31T00:30:00Z'), updatedAt: Date.parse('2026-05-31T02:00:00Z'), values: [23, 7, 5, 9, 2] },
  { id: 'recovery-new-beta', workspaceId: 'w-beta', model: 'deepseek-v4-pro', factor: 3, time: Date.parse('2026-05-31T16:30:00Z'), updatedAt: Date.parse('2026-05-31T03:00:00Z'), values: [31, 11, 7, 6, 13] },
  { id: 'recovery-resident', workspaceId: 'w-beta', model: 'deepseek-v4-pro', factor: 3, time: Date.parse('2026-10-13T04:30:00Z'), updatedAt: Date.parse('2026-10-13T05:00:00Z'), values: [41, 17, 11, 8, 19] },
].map(spec => ({ ...spec, values: Object.fromEntries(TOKENS.map((key, index) => [key, spec.values[index]])), modelKey: JSON.stringify(['deepseek', spec.model, spec.model, null]) }))
const IDS = SPECS.map(spec => spec.id).sort()
const OLD_IDS = SPECS.filter(spec => spec.updatedAt < CUTOFF).map(spec => spec.id).sort()

function rates(factor) {
  return { input: String(factor), output: String(2 * factor), cacheRead: String(0.25 * factor), cacheWrite: String(0.5 * factor) }
}
function fixtureHost(backend) {
  const fixture = createInvariantHost({ backend })
  fixture.state.pricingState = normalizePricingState({ catalogEntries: [1, 3].map((factor, index) => ({
    providerId: 'deepseek', modelId: index === 0 ? 'deepseek-v4-flash' : 'deepseek-v4-pro', inputTokenSemantics: 'fresh', ...rates(factor),
    temporalPricing: { policies: [{ policyId: 'archive-recovery', timezone: 'UTC', effectiveFrom: 0, effectiveUntil: null, defaultPlan: null,
      rules: [{ id: 'daily', weekdays: [0, 1, 2, 3, 4, 5, 6], windows: [{ startMinute: 0, endMinute: 1440 }], rates: rates(factor) }],
    }] },
  })), sync: { autoEnabled: false } })
  for (const id of ['w-alpha', 'w-beta']) fixture.state.wsMeta.set(id, { id, title: id, path: 'G:/archive-recovery/' + id })
  fixture.aggregation.queryUsageScope = () => assert.fail('recovery assertions must precede every query')
  return fixture
}
function records() {
  const builder = fixtureHost().ledger
  return SPECS.map(spec => {
    const usage = Object.fromEntries(TOKENS.map(key => [key + 'Tokens', spec.values[key]]))
    const events = [
      { seq: 0, time: spec.time - 1000, type: 'request/context', data: { provider: 'deepseek', model: spec.model, turn: 1, step: 1 } },
      { seq: 1, time: spec.time, type: 'assistant/message', data: { turn: 1, step: 1, message: { id: spec.id + ':1:1', role: 'assistant', source: { kind: 'model', provider: 'deepseek', model: spec.model } }, usage } },
      { seq: 2, time: spec.time + 1000, type: 'turn/end', data: { turn: 1 } },
    ]
    return { ...builder.buildLedgerRecord({ id: spec.id, header: { cwd: 'G:/archive-recovery/' + spec.workspaceId }, events }, spec.workspaceId, 'scan', 'recovery-fixture'), updatedAt: spec.updatedAt }
  })
}
function money(value) {
  const [whole, fraction = ''] = String(value || '0').split('.')
  assert.match(fraction.slice(12), /^0*$/, 'recovery money retains exact precision')
  return BigInt(whole) * 1000000000000n + BigInt((fraction + '0'.repeat(12)).slice(0, 12))
}
function expectedFee(rows, token) {
  return rows.reduce((sum, row) => sum + BigInt(row.values[token]) * RATES[token] * BigInt(row.factor), 0n)
}
function assertMetric(actual, rows, label) {
  const values = actual?.values || actual?.tokens || actual || {}
  for (const key of TOKENS) assert.equal(values[key] || 0, rows.reduce((sum, row) => sum + row.values[key], 0), label + ':' + key)
  const cost = serializeCostAggregate(actual?.cost)
  assert.equal(actual?.calls ?? cost.pricedCalls, rows.length, label + ':calls')
  assert.equal(cost.pricedCalls, rows.length, label + ':pricedCalls')
  for (const key of ['unpricedCalls', 'ambiguousCalls', 'unsupportedCalls']) assert.equal(cost[key], 0, label + ':' + key)
  for (const key of Object.keys(RATES)) assert.equal(money(cost[key]), expectedFee(rows, key), label + ':cost.' + key)
  const total = Object.keys(RATES).reduce((sum, key) => sum + expectedFee(rows, key), 0n)
  assert.equal(money(cost.total), total, label + ':total')
  assert.equal(money(cost.baseTotal), total, label + ':baseTotal')
}
function groups(rows, keyOf) {
  const result = new Map()
  for (const row of rows) {
    const key = keyOf(row)
    if (!result.has(key)) result.set(key, [])
    result.get(key).push(row)
  }
  return result
}
function assertMap(actual, expected, label) {
  assert.deepEqual([...actual.keys()].sort(), [...expected.keys()].sort(), label + ':keys')
  for (const [key, rows] of expected) assertMetric(actual.get(key), rows, label + ':' + key)
}
function assertScoped(actual, rows, label) {
  const workspaces = groups(rows, row => row.workspaceId)
  assert.deepEqual([...actual.keys()].sort(), [...workspaces.keys()].sort(), label + ':workspaces')
  for (const [id, subset] of workspaces) assertMap(actual.get(id), groups(subset, row => row.modelKey), label + ':' + id)
}
function dayOf(time, utc) {
  const date = new Date(time)
  return utc ? date.toISOString().slice(0, 10) : date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0')
}
function hourOf(time, utc) {
  const date = new Date(time)
  if (utc) date.setUTCMinutes(0, 0, 0)
  else date.setMinutes(0, 0, 0)
  return date.getTime()
}
function assertRaw(fixture) {
  const { state } = fixture
  assertMetric(state.totals, SPECS, 'global')
  assert.equal(state.totals.turns, SPECS.length, 'global turns')
  assertMap(state.perWorkspace, groups(SPECS, row => row.workspaceId), 'workspace')
  assertMap(state.perModel, groups(SPECS, row => row.modelKey), 'model')
  assert.deepEqual([...state.usageByStep.keys()].sort(), SPECS.map(spec => spec.id + ':step:1:1').sort(), 'logical usage keys')
  assert.deepEqual([...state.perSession.keys()].sort(), IDS, 'session keys')
  for (const spec of SPECS) {
    const session = state.perSession.get(spec.id)
    const key = spec.id + ':step:1:1'
    assert.deepEqual([...session.keys.keys()], [key])
    assert.equal(session.keys.get(key).wsId, spec.workspaceId)
    assert.equal(session.keys.get(key).identity.identityKey, spec.modelKey)
    assert.equal(session.keys.get(key).time, spec.time)
  }
  for (const utc of [false, true]) {
    const days = utc ? state.byDayUtc : state.byDay
    const expected = groups(SPECS, row => dayOf(row.time, utc))
    assert.deepEqual([...days.keys()].sort(), [...expected.keys()].sort(), 'calendar days')
    for (const [date, rows] of expected) {
      const day = days.get(date)
      assertMetric(day, rows, 'day:' + utc + ':' + date)
      assertMap(day.byWs, groups(rows, row => row.workspaceId), 'day workspace')
      assertMap(day.byModel, groups(rows, row => row.modelKey), 'day model')
      assertScoped(day.queryUsage, rows, 'day scoped')
      const hours = groups(rows, row => hourOf(row.time, utc))
      assert.deepEqual([...day.queryHours.keys()].sort(), [...hours.keys()].sort(), 'calendar hours')
      for (const [hour, subset] of hours) assertScoped(day.queryHours.get(hour).usage, subset, 'hour scoped')
    }
  }
  for (const [name, count] of state.diagCounters) if (name.startsWith('q.reconciled.')) assert.equal(count, 0, 'no query repair')
}
async function openHost(root) {
  const backend = createLedgerBackend(root)
  const fixture = fixtureHost(backend.backend)
  await fixture.ledger.loadLedger()
  assert.ok(fixture.state.ledgerUnit, 'real per-record store opened')
  return { ...fixture, backend }
}
async function closeHost(fixture) {
  if (!fixture) return
  await fixture.ledger.drainLedgerWrites()
  fixture.state.disposed = true
  await fixture.state.ledgerUnit?.close()
}
async function seed(fixture, rows) {
  for (const record of rows) {
    fixture.ledger.storeLedgerRecord(record)
    await fixture.ledger.persistLedgerRecord(record)
  }
  await fixture.ledger.drainLedgerWrites()
  assert.equal(fixture.state.ledgerDirtySessions.size, 0, 'seed writes reached disk')
}
async function assertReopened(root, originals) {
  const fixture = await openHost(root)
  try {
    const keys = await fixture.state.ledgerUnit.listKeys()
    assert.equal(new Set(keys).size, keys.length, 'hot/cold overlap enumerates a session only once')
    assert.deepEqual(keys.sort(), IDS, 'every original session survives reopening')
    for (const spec of SPECS) {
      const raw = await fixture.state.ledgerUnit.readRecord(spec.id)
      assert.deepEqual(raw, originals.get(spec.id), 'durable full record: ' + spec.id)
      const record = fixture.ledger.normalizeLedgerRecord(raw, spec.id)
      assert.ok(record && !record.needsUpgrade, 'recovery uses current rows without rebuilding')
      const item = record.usage[0]
      assert.equal(record.workspaceId, spec.workspaceId)
      assert.equal(item.workspaceId, spec.workspaceId)
      assert.equal(item.identity.identityKey, spec.modelKey)
      assert.equal(item.key, spec.id + ':step:1:1')
      assert.deepEqual(item.values, spec.values)
      assert.equal(item.cost.status, 'priced', 'fixture price applies at event time: ' + item.cost.reason)
      assert.deepEqual(item.cost.rates, rates(spec.factor), 'independently configured rates')
      for (const key of Object.keys(RATES)) assert.equal(money(item.cost.breakdown[key]), expectedFee([spec], key), 'durable fee: ' + key)
      assert.equal(money(item.cost.total), Object.keys(RATES).reduce((sum, key) => sum + expectedFee([spec], key), 0n))
      fixture.ledger.storeLedgerRecord(record)
      fixture.ledger.applyLedgerRecord(record)
    }
    assertRaw(fixture)
  } finally {
    await closeHost(fixture)
  }
}
function faultFs(root, target, stage) {
  const path = join(root, 'archive', target)
  const tmp = path + '.tmp-' + process.pid
  const message = 'recovery-fixture:' + target + ':' + stage
  let hits = 0
  const fail = () => { hits += 1; throw Object.assign(new Error(message), { code: 'EIO' }) }
  const injected = {
    ...fs,
    async open(name, ...args) {
      if (name === tmp && stage === 'open' && hits === 0) fail()
      const handle = await fs.open(name, ...args)
      if (name !== tmp) return handle
      return {
        async writeFile(data) {
          if (stage === 'writeFile' && hits === 0) { await handle.writeFile(data.subarray(0, Math.max(1, Math.floor(data.length / 2)))); fail() }
          return handle.writeFile(data)
        },
        async sync() { if (stage === 'sync' && hits === 0) fail(); return handle.sync() },
        async close() { await handle.close(); if (stage === 'close' && hits === 0) fail() },
      }
    },
    async rename(from, to) {
      if (to === path && stage === 'rename' && hits === 0) fail()
      return fs.rename(from, to)
    },
  }
  return { fs: injected, message, hits: () => hits }
}
async function setup(root, existing) {
  const fixture = await openHost(root)
  const rows = records()
  const originals = new Map(rows.map(row => [row.sessionId, serializeLedgerRecord(row)]))
  if (existing) {
    await seed(fixture, rows.slice(0, 1))
    const prior = await archiveRecords({ root, store: fixture.state.ledgerUnit.treeStore(), cutoffMs: CUTOFF })
    assert.deepEqual(prior.errors, [])
    assert.equal(prior.archived, 1)
  }
  await seed(fixture, existing ? rows.slice(1) : rows)
  return { fixture, originals }
}
async function retryAndReopen(root, originals) {
  const fresh = await openHost(root)
  try {
    const result = await archiveRecords({ root, store: fresh.state.ledgerUnit.treeStore(), cutoffMs: CUTOFF })
    assert.deepEqual(result.errors, [], 'retry completes after restoring real fs')
    assert.deepEqual(await fresh.backend.treeSessionIds(), ['recovery-resident'])
    const noOp = await archiveRecords({ root, store: fresh.state.ledgerUnit.treeStore(), cutoffMs: CUTOFF })
    assert.equal(noOp.archived, 0, 'successful retry is idempotent')
    assert.deepEqual(noOp.errors, [])
  } finally {
    await closeHost(fresh)
  }
  await assertReopened(root, originals)
}

for (const existing of [false, true]) {
  for (const target of [MONTH + '.jsonl.gz', MONTH + '.keys.json.gz', 'manifest.json']) {
    for (const stage of ['open', 'writeFile', 'sync', 'close', 'rename']) {
      test('archive recovery reopens and retries ' + (existing ? 'existing' : 'new') + ' month after ' + target + ' ' + stage + ' fails', async () => {
        const root = await createTempRoot()
        let fixture
        try {
          const prepared = await setup(root, existing)
          fixture = prepared.fixture
          const injected = faultFs(root, target, stage)
          const before = await fixture.backend.treeSessionIds()
          const result = await archiveRecords({ root, store: fixture.state.ledgerUnit.treeStore(), cutoffMs: CUTOFF, fs: injected.fs })
          assert.equal(injected.hits(), 1, 'the selected real I/O stage was reached')
          assert.deepEqual(result.errors, [{ month: MONTH, message: injected.message }])
          assert.equal(result.archived, 0, 'failed publication does not acknowledge the month')
          assert.deepEqual(await fixture.backend.treeSessionIds(), before, 'publication failure preserves every hot source')
          await closeHost(fixture)
          fixture = null
          await assertReopened(root, prepared.originals)
          await retryAndReopen(root, prepared.originals)
        } finally {
          await closeHost(fixture)
          await removeTempRoot(root)
        }
      })
    }
  }
}
for (const position of ['first', 'after-one']) {
  test('archive recovery reopens and retries after deleteRecord fails ' + position, async () => {
    const root = await createTempRoot()
    let fixture
    try {
      const prepared = await setup(root, false)
      fixture = prepared.fixture
      const tree = fixture.state.ledgerUnit.treeStore()
      const ordered = (await tree.listKeys()).filter(key => OLD_IDS.includes(key))
      const failedKey = ordered[position === 'first' ? 0 : 1]
      let hits = 0
      const store = { ...tree, async deleteRecord(key, expected) {
        if (key === failedKey && hits === 0) { hits += 1; throw Object.assign(new Error('recovery-fixture:deleteRecord'), { code: 'EIO' }) }
        return tree.deleteRecord(key, expected)
      } }
      const result = await archiveRecords({ root, store, cutoffMs: CUTOFF })
      assert.equal(hits, 1, 'the selected deleteRecord failure was reached')
      assert.deepEqual(result.errors, [], 'a redundant source can remain after the month is durable')
      assert.equal(result.archived, OLD_IDS.length)
      assert.deepEqual(await fixture.backend.treeSessionIds(), [failedKey, 'recovery-resident'].sort())
      await closeHost(fixture)
      fixture = null
      await assertReopened(root, prepared.originals)
      await retryAndReopen(root, prepared.originals)
    } finally {
      await closeHost(fixture)
      await removeTempRoot(root)
    }
  })
}
