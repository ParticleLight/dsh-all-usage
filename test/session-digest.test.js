import assert from 'node:assert/strict'
import test from 'node:test'
import { createAggregation } from '../lib/aggregation.js'
import { createCostAccumulator } from '../lib/pricing.js'

// A minimal host: the digest only needs the shared state, and the counters it
// maintains live there.
function makeHost() {
  const state = {
    dayMap: new Map(),
    byDay: new Map(), byDayUtc: new Map(), perWorkspace: new Map(), perModel: new Map(),
    usageByStep: new Map(), turnRecords: new Map(), usageByLocalDate: new Map(), usageByUtcDate: new Map(),
    sessionModel: new Map(), sessionContextTimes: new Map(), sessionCount: new Set(), sessionSeq: new Map(),
    wsMeta: new Map(), pathIndex: new Map(), memberOf: new Map(), chains: new Map(),
    perSession: new Map(),
    totals: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: createCostAccumulator() },
    statsRevision: 0, dataRevision: 0, metadataRevision: 0, scanRevision: 0, pricingRevision: 0,
    statsDirtyScheduled: false, statsDirtyKinds: new Set(), aggregationGeneration: 0, retiredBucketUsed: false,
    pricingState: null, instanceId: 'test', statsUpdatedAt: 0, snapshotCache: null, queryCache: new Map(), recordsQueryCache: new Map(),
    scan: { started: true, done: true, scanned: 0, total: 0, failed: 0 },
    ledgerRecords: new Map(), ledgerRevision: 0, sync: {},
  }
  const host = {
    state,
    markStatsChanged() {},
    commitPendingStats() {},
    resetSyncState() {},
    pricingSnapshot: () => ({}),
    syncSnapshot: () => ({}),
  }
  host.aggregation = createAggregation(host)
  return host
}

function identityFor(model) {
  return { identityKey: 'deepseek / ' + model, provider: 'deepseek', requestedModel: model, actualModel: model, label: model }
}

function costFor(amount, at) {
  return {
    schemaVersion: 2, pricingMode: 'official-model', status: 'priced', currency: 'USD', source: 'catalog',
    pricingModel: 'deepseek-v4-flash', providerId: 'deepseek', inputTokenSemantics: 'fresh', multiplier: '1',
    billableInputTokens: 0, billableOutputTokens: 0, pricingAt: at, pricingTimeSource: 'usage-event',
    pricingBand: 'peak', pricingHoliday: false, pricingTimezone: 'UTC', temporalApplicable: false,
    rates: { input: '1', output: '1', cacheRead: '1', cacheWrite: '1' },
    breakdown: { input: amount, output: '0', cacheRead: '0', cacheWrite: '0' },
    baseTotal: amount, total: amount, reason: '', tiered: false, reasoningRateAvailable: false,
  }
}

function row(key, sid, wsId, date, model, amount, turn) {
  return {
    key, seq: 1, wsId, time: Date.parse(date + 'T03:00:00Z'), date, dateUtc: date,
    values: { input: 10, output: 2, cacheRead: 1, cacheWrite: 0, reasoning: 0 },
    identity: identityFor(model), modelId: model, cost: costFor(amount, Date.parse(date + 'T03:00:00Z')),
    turn, step: 1, materialization: 'scan', sid,
  }
}

function digestOf(host, sid) {
  const session = host.state.perSession.get(sid)
  if (session === undefined) return { calls: 0, input: 0, cost: '0' }
  let calls = 0
  let input = 0
  for (const bucket of session.buckets.values()) { calls += bucket.calls; input += bucket.values.input }
  return { calls, input, cost: String(session.buckets.values().next().value === undefined ? '0' : '') }
}

test('the per-session digest describes exactly the rows that were folded', () => {
  const host = makeHost()
  const rows = [
    row('s1:step:1:1', 's1', 'ws-a', '2026-08-17', 'deepseek-v4-flash', '0.1', 1),
    row('s1:step:1:2', 's1', 'ws-a', '2026-08-17', 'deepseek-v4-flash', '0.2', 1),
    row('s1:step:2:1', 's1', 'ws-b', '2026-08-18', 'deepseek-v4-pro', '0.3', 2),
    row('s2:step:1:1', 's2', 'ws-a', '2026-08-18', 'deepseek-v4-flash', '0.4', 1),
  ]
  for (const sample of rows) host.aggregation.upsertUsageSample(host.state.usageByStep, sample)
  assert.equal(host.state.usageByStep.size, rows.length)
  for (const [sid, expectedCalls, expectedInput] of [['s1', 3, 30], ['s2', 1, 10]]) {
    const digest = digestOf(host, sid)
    assert.equal(digest.calls, expectedCalls, sid + ' calls')
    assert.equal(digest.input, expectedInput, sid + ' input tokens')
  }
  // Every row key is tracked, so a removal can clear the date index without the rows.
  const session = host.state.perSession.get('s1')
  assert.equal(session.keys.size, 3)
  assert.equal(host.state.usageByLocalDate.get('2026-08-17').size, 2)
})

test('a session unwinds from the digest alone, with its rows already gone', () => {
  const host = makeHost()
  const rows = [
    row('s1:step:1:1', 's1', 'ws-a', '2026-08-17', 'deepseek-v4-flash', '0.1', 1),
    row('s1:step:2:1', 's1', 'ws-b', '2026-08-18', 'deepseek-v4-pro', '0.3', 2),
    row('s2:step:1:1', 's2', 'ws-a', '2026-08-18', 'deepseek-v4-flash', '0.4', 1),
  ]
  for (const sample of rows) host.aggregation.upsertUsageSample(host.state.usageByStep, sample)
  const baseline = { input: host.state.totals.input, pricedCalls: host.state.totals.cost.pricedCalls }
  assert.equal(baseline.input, 30)
  assert.equal(baseline.pricedCalls, 3)
  // Simulate the eviction slice: the detail rows of s1 are gone, the digest is not.
  host.state.usageByStep.delete('s1:step:1:1')
  host.state.usageByStep.delete('s1:step:2:1')
  host.aggregation.removeSession('s1')
  assert.equal(host.state.totals.input, 10, 'only the second session is left')
  assert.equal(host.state.totals.cost.pricedCalls, 1)
  assert.equal(host.state.perSession.has('s1'), false)
  assert.equal(host.state.usageByStep.size, 1)
  assert.equal(host.state.usageByLocalDate.get('2026-08-17'), undefined, 'the evicted day index is cleaned')
  // The surviving session still unwinds exactly.
  host.aggregation.removeSession('s2')
  assert.equal(host.state.totals.input, 0)
  assert.equal(host.state.totals.cost.pricedCalls, 0)
})

test('settled rows can be dropped and read back without changing a single total', () => {
  const host = makeHost()
  const rows = [
    row('s1:step:1:1', 's1', 'ws-a', '2026-08-17', 'deepseek-v4-flash', '0.1', 1),
    row('s1:step:1:2', 's1', 'ws-a', '2026-08-17', 'deepseek-v4-flash', '0.2', 1),
  ]
  for (const sample of rows) host.aggregation.foldUsageRow(sample)
  const totalsBefore = { input: host.state.totals.input, pricedCalls: host.state.totals.cost.pricedCalls }
  assert.equal(totalsBefore.input, 20)
  assert.equal(totalsBefore.pricedCalls, 2)
  // The rows are settled (priced, priced from the event time), so they can go.
  const evicted = host.aggregation.evictColdRows({ rows: 0 })
  assert.equal(evicted.rows, 2)
  assert.equal(host.state.usageByStep.size, 0)
  assert.equal(host.state.perSession.get('s1').keys.size, 2, 'the digest still knows the rows')
  // Applying the record again must not count anything twice.
  for (const sample of rows) host.aggregation.foldUsageRow(sample)
  assert.equal(host.state.usageByStep.size, 0, 'the digest refuses a second fold')
  assert.deepEqual({ input: host.state.totals.input, pricedCalls: host.state.totals.cost.pricedCalls }, totalsBefore)
  // Reading a row back for a query is inert: it is data, not a new contribution.
  assert.equal(host.aggregation.adoptUsageRow(rows[0]), true)
  assert.equal(host.aggregation.adoptUsageRow(rows[0]), false, 'adopting twice is a no-op')
  assert.equal(host.state.usageByStep.size, 1)
  assert.deepEqual({ input: host.state.totals.input, pricedCalls: host.state.totals.cost.pricedCalls }, totalsBefore)
  // And the session still unwinds exactly, rows resident or not.
  host.aggregation.removeSession('s1')
  assert.equal(host.state.totals.input, 0)
  assert.equal(host.state.totals.cost.pricedCalls, 0)
})

test('a row whose pricing can still change stays resident', () => {
  const host = makeHost()
  const stale = row('s1:step:1:1', 's1', 'ws-a', '2026-08-17', 'deepseek-v4-flash', '0.1', 1)
  stale.cost = { ...stale.cost, pricingTimeSource: 'request-context', pricingAt: Date.parse('2026-08-17T00:00:00Z') }
  host.aggregation.foldUsageRow(stale)
  const settled = row('s2:step:1:1', 's2', 'ws-a', '2026-08-17', 'deepseek-v4-flash', '0.1', 1)
  host.aggregation.foldUsageRow(settled)
  const evicted = host.aggregation.evictColdRows({ rows: 0 })
  assert.equal(evicted.rows, 1, 'only the settled row goes')
  assert.equal(host.state.usageByStep.has('s1:step:1:1'), true, 'a stale request-context row is kept')
  assert.equal(host.state.usageByStep.has('s2:step:1:1'), false)
})

test('a scoped cube that drifted is rebuilt from the digest', () => {
  const host = makeHost()
  host.aggregation.foldUsageRow(row('s1:step:1:1', 's1', 'ws-a', '2026-08-17', 'deepseek-v4-flash', '0.1', 1))
  host.aggregation.foldUsageRow(row('s2:step:1:1', 's2', 'ws-b', '2026-08-17', 'deepseek-v4-pro', '0.2', 1))
  const day = host.state.byDay.get('2026-08-17')
  const scopedInput = () => {
    let total = 0
    for (const models of day.queryUsage.values()) for (const bucket of models.values()) total += bucket.input
    return total
  }
  assert.equal(scopedInput(), day.tokens.input, 'both cubes start in step')
  // Inflate the scoped cube the way the live path did for the current day.
  for (const models of day.queryUsage.values()) for (const bucket of models.values()) bucket.input += 5000
  assert.equal(scopedInput(), day.tokens.input + 10000)
  // A read rebuilds it from the digest, which describes the same rows.
  host.aggregation.queryUsageScope({ start: '2026-08-17', end: '2026-08-17', utc: false })
  assert.equal(scopedInput(), day.tokens.input, 'the scoped cube is back in step with the day cube')
})

test('a replayed row is stored without being counted twice', () => {
  const host = makeHost()
  const sample = row('s1:step:1:1', 's1', 'ws-a', '2026-08-17', 'deepseek-v4-flash', '0.1', 1)
  host.aggregation.foldUsageRow(sample)
  const totals = { input: host.state.totals.input, pricedCalls: host.state.totals.cost.pricedCalls, turns: host.state.totals.turns }
  assert.equal(totals.input, 10)
  // Hand the row back to the ledger the way eviction does, then replay the event: a
  // restart used to replay a whole day like this and count every row again.
  host.aggregation.evictColdRows({ rows: 0 })
  assert.equal(host.state.usageByStep.size, 0)
  host.aggregation.upsertUsageSample(host.state.usageByStep, sample)
  assert.equal(host.state.usageByStep.size, 1, 'the row is back for the log')
  assert.deepEqual({ input: host.state.totals.input, pricedCalls: host.state.totals.cost.pricedCalls, turns: host.state.totals.turns }, totals, 'and nothing was counted twice')
})

test('retargeting a session moves its digest with its rows', () => {
  const host = makeHost()
  host.aggregation.upsertUsageSample(host.state.usageByStep, row('s1:step:1:1', 's1', 'ws-old', '2026-08-17', 'deepseek-v4-flash', '0.1', 1))
  assert.equal(host.aggregation.retargetSession('s1', 'ws-new'), 1)
  const session = host.state.perSession.get('s1')
  assert.equal(session.buckets.size, 1)
  assert.equal(Array.from(session.buckets.values())[0].wsId, 'ws-new')
  host.aggregation.removeSession('s1')
  assert.equal(host.state.totals.input, 0)
  assert.equal(host.state.totals.cost.pricedCalls, 0)
  // A workspace entry is created on demand and may stay behind as a zero row (the
  // same happens for a plain add/remove); what must never stay is a non-zero one.
  const residue = []
  for (const [wsId, ws] of host.state.perWorkspace) {
    if (ws.input !== 0 || ws.cost.pricedCalls !== 0) residue.push({ wsId, input: ws.input, pricedCalls: ws.cost.pricedCalls })
  }
  assert.deepEqual(residue, [], 'a workspace may keep a zeroed row, never a non-zero one: ' + JSON.stringify(residue))
})
