import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate as yieldLoop } from 'node:timers/promises'
import { createAggregation } from '../lib/aggregation.js'
import { createLedger } from '../lib/ledger.js'
import { createPricingRuntime } from '../lib/pricing-runtime.js'
import { createSessionSync } from '../lib/session-sync.js'
import { createCostAccumulator, normalizePricingState, serializeCostAggregate } from '../lib/pricing.js'

const TOKEN_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning']
const MIDNIGHT_CST = Date.parse('2026-10-12T16:00:00Z')
const MIDNIGHT_UTC = Date.parse('2026-10-13T00:00:00Z')
const catalog = (factor = 1) => {
  const rates = { input: String(factor), output: String(2 * factor), cacheRead: String(0.25 * factor), cacheWrite: String(0.5 * factor) }
  return [{ providerId: 'deepseek', modelId: 'deepseek-v4-flash', displayName: 'Concurrency model', ...rates, temporalPricing: { policies: [{ policyId: 'stress-policy', timezone: 'UTC', effectiveFrom: 0, effectiveUntil: null, defaultPlan: null, rules: [{ id: 'peak', weekdays: [0,1,2,3,4,5,6], windows: [{ startMinute: 60, endMinute: 240 }], rates }] }] } }]
}
function deferred() {
  let resolve, reject
  const promise = new Promise((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}
function usage(time, turn, step, input, seq, sid = 's') {
  return { seq, time, type: 'assistant/message', data: { turn, step,
    message: { id: sid + ':' + turn + ':' + step, role: 'assistant', source: { kind: 'model', provider: 'deepseek', model: 'deepseek-v4-flash' } },
    usage: { inputTokens: input, outputTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 1, reasoningTokens: 3 },
  } }
}
function valuesOf(event) {
  const u = event.data.usage
  return { input: u.inputTokens, output: u.outputTokens, cacheRead: u.cacheReadTokens, cacheWrite: u.cacheWriteTokens, reasoning: u.reasoningTokens }
}
function fixedMoney(value) {
  const [whole, frac = ''] = String(value || '0').split('.')
  return BigInt(whole) * 1000000000000n + BigInt((frac + '0'.repeat(12)).slice(0, 12))
}
function expectedMoney(values, factor = 1) {
  return BigInt(factor) * (BigInt(values.input) * 1000000n + BigInt(values.output) * 2000000n + BigInt(values.cacheRead) * 250000n + BigInt(values.cacheWrite) * 500000n)
}
function makeHost(disk = new Map(), logs = new Map()) {
  const listeners = new Map()
  const state = {
    byDay: new Map(), byDayUtc: new Map(), perWorkspace: new Map(), perModel: new Map(), perSession: new Map(),
    usageByStep: new Map(), turnRecords: new Map(), usageByLocalDate: new Map(), usageByUtcDate: new Map(),
    sessionsByLocalDate: new Map(), sessionsByUtcDate: new Map(), rowTouch: new Map(),
    sessionModel: new Map(), sessionContextTimes: new Map(), sessionCount: new Set(), sessionSeq: new Map(),
    wsMeta: new Map([['w', { id: 'w', path: 'C:/stress', title: 'Stress' }]]), pathIndex: new Map(), memberOf: new Map(), chains: new Map(),
    totals: { turns: 0, ...Object.fromEntries(TOKEN_KEYS.map(k => [k, 0])), cost: createCostAccumulator() },
    statsRevision: 0, dataRevision: 0, metadataRevision: 0, scanRevision: 0, pricingRevision: 0,
    statsDirtyScheduled: false, statsDirtyKinds: new Set(), aggregationGeneration: 0, retiredBucketUsed: false,
    pricingState: normalizePricingState({ catalogEntries: catalog(), sync: { autoEnabled: false } }),
    pricingResolutionCache: new Map(), pricingWriteChain: Promise.resolve(), pricingUnit: null,
    holidayCache: new Map(), pricingReady: Promise.resolve(), pricingSyncTimer: null,
    instanceId: 'isolated-stress', statsUpdatedAt: 0, snapshotCache: null, queryCache: new Map(), recordsQueryCache: new Map(),
    scan: { started: true, done: true, scanned: 0, total: 0, failed: 0 },
    ledgerRecords: new Map(), ledgerKeys: new Set(disk.keys()), ledgerRevision: 0,
    ledgerRecordSizes: new Map(), ledgerRecordBytes: 0, ledgerWriteChain: Promise.resolve(), ledgerReady: Promise.resolve(),
    ledgerDirtySessions: new Set(), ledgerDirtyEpochs: new Map(), ledgerWriteFailedSessions: new Set(),
    liveResyncPending: new Set(), liveResyncTriggers: new Map(), liveResyncTimers: new Map(), liveResyncAttempts: new Map(), knownSessionIds: new Set(),
    sync: {}, disposed: false, aliases: {}, reconcileTimer: null, workspaceProbeTimer: null,
    workspaceSyncTimer: null, baselineFallbackTimer: null, baselineRetryDelay: 1000,
  }
  const host = { state, services: {}, logs, disk, listeners,
    ctx: {
      sessionQuery: { async readSession(sid) { await yieldLoop(); return { events: structuredClone(logs.get(sid) || []) } }, async listSessions() { return Array.from(logs.keys(), id => ({ header: { id, cwd: 'C:/stress' } })) } },
      workspaceRegistry: { list: () => Array.from(state.wsMeta.values()) },
      on(name, fn) { const list = listeners.get(name) || []; list.push(fn); listeners.set(name, list) },
      timeout: yieldLoop,
    },
    markStatsChanged(kind = 'data') {
      state.statsRevision += 1
      if (kind === 'pricing') state.pricingRevision += 1
      else state.dataRevision += 1
      state.snapshotCache = null; state.queryCache.clear(); state.recordsQueryCache.clear()
    },
    commitPendingStats() {}, resetSyncState() {}, beginSync() {}, noteSyncError() {},
    pricingSnapshot: () => ({}), syncSnapshot: () => ({}),
  }
  host.aggregation = createAggregation(host)
  host.ledger = createLedger(host)
  host.pricing = createPricingRuntime(host)
  host.sessionSync = createSessionSync(host)
  state.ledgerUnit = {
    async readRecord(sid) { const record = structuredClone(disk.get(sid)); await yieldLoop(); return record },
    async putRecord(table, sid, record) { await yieldLoop(); disk.set(sid, structuredClone(record)) },
  }
  host.install = async (sid, events) => {
    logs.set(sid, structuredClone(events))
    const record = host.ledger.buildLedgerRecord({ id: sid, events }, 'w', 'scan', undefined, null, true)
    host.ledger.replaceLedgerRecord(record)
    host.ledger.applyLedgerRecord(record, 'ledger-reuse')
    state.sessionSeq.set(sid, record.lastSeq)
    await host.ledger.persistLedgerRecord(record)
    return record
  }
  host.close = async () => {
    state.disposed = true
    for (const timer of state.liveResyncTimers.values()) clearTimeout(timer)
    for (const key of ['pricingSyncTimer', 'ledgerWriteTimer', 'baselineFallbackTimer', 'workspaceSyncTimer', 'reconcileTimer', 'workspaceProbeTimer']) if (state[key]) clearTimeout(state[key])
    await Promise.allSettled(Array.from(state.chains.values()))
    await host.ledger.drainLedgerWrites()
  }
  return host
}
function assertOracle(host, expected, factor = 1) {
  const state = host.state
  const totals = Object.fromEntries(TOKEN_KEYS.map(k => [k, 0]))
  const dates = [new Map(), new Map()]
  let totalMoney = 0n
  for (const row of expected) {
    const v = valuesOf(row)
    const rowFactor = typeof factor === 'function' ? factor(row) : factor
    totalMoney += expectedMoney(v, rowFactor)
    for (const k of TOKEN_KEYS) totals[k] += v[k]
    for (const utc of [false, true]) {
      const d = new Date(row.time)
      const date = utc ? d.toISOString().slice(0, 10) : d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
      const day = dates[Number(utc)].get(date) || { calls: 0, money: 0n, hours: new Map(), ...Object.fromEntries(TOKEN_KEYS.map(k => [k, 0])) }
      day.calls++; day.money += expectedMoney(v, rowFactor)
      for (const k of TOKEN_KEYS) day[k] += v[k]
      const hourDate = new Date(row.time)
      if (utc) hourDate.setUTCMinutes(0, 0, 0); else hourDate.setMinutes(0, 0, 0)
      const hour = day.hours.get(hourDate.getTime()) || { calls: 0, money: 0n, ...Object.fromEntries(TOKEN_KEYS.map(k => [k, 0])) }
      hour.calls++; hour.money += expectedMoney(v, rowFactor)
      for (const k of TOKEN_KEYS) hour[k] += v[k]
      day.hours.set(hourDate.getTime(), hour)
      dates[Number(utc)].set(date, day)
    }
  }
  for (const k of TOKEN_KEYS) assert.equal(state.totals[k], totals[k], 'total.' + k)
  const cost = serializeCostAggregate(state.totals.cost)
  assert.equal(cost.pricedCalls, expected.length)
  assert.equal(fixedMoney(cost.total), totalMoney, 'total cost equals the independent per-request integer sum')
  assert.equal(Array.from(state.perModel.values()).reduce((n, m) => n + m.calls, 0), expected.length)
  for (const utc of [false, true]) {
    const map = utc ? state.byDayUtc : state.byDay
    const observedTokens = Object.fromEntries(TOKEN_KEYS.map(k => [k, 0]))
    let observedCalls = 0, observedMoney = 0n
    for (const day of map.values()) {
      for (const k of TOKEN_KEYS) observedTokens[k] += day.tokens[k]
      observedCalls += Array.from(day.byModel.values()).reduce((n,m) => n + m.calls, 0)
      observedMoney += fixedMoney(serializeCostAggregate(day.cost).total)
    }
    for (const k of TOKEN_KEYS) assert.equal(observedTokens[k], totals[k], 'all day tokens:' + k)
    assert.equal(observedCalls, expected.length, 'all day calls')
    assert.equal(observedMoney, totalMoney, 'all day cost')
    for (const [date, want] of dates[Number(utc)]) {
      const day = map.get(date)
      assert.ok(day)
      for (const k of TOKEN_KEYS) assert.equal(day.tokens[k], want[k], date + ':' + k)
      assert.equal(Array.from(day.byModel.values()).reduce((n, m) => n + m.calls, 0), want.calls)
      assert.equal(fixedMoney(serializeCostAggregate(day.cost).total), want.money)
      const queryBuckets = Array.from(day.queryUsage.values()).flatMap(models => Array.from(models.values()))
      assert.equal(queryBuckets.reduce((n,m) => n + m.calls, 0), want.calls, 'raw query calls')
      for (const k of TOKEN_KEYS) assert.equal(queryBuckets.reduce((n,m) => n + m[k], 0), want[k], 'raw query:' + date + ':' + k)
      assert.equal(queryBuckets.reduce((n,m) => n + fixedMoney(serializeCostAggregate(m.cost).total), 0n), want.money, 'raw query cost')
      for (const [hour, wanted] of want.hours) {
        const buckets = day.queryHours.get(hour)?.usage
        assert.ok(buckets, 'hour ' + hour)
        const metrics = Array.from(buckets.values()).flatMap(m => Array.from(m.values()))
        assert.equal(metrics.reduce((n, m) => n + m.calls, 0), wanted.calls)
        for (const k of TOKEN_KEYS) assert.equal(metrics.reduce((n, m) => n + m[k], 0), wanted[k], 'hour:' + hour + ':' + k)
        assert.equal(metrics.reduce((n, m) => n + fixedMoney(serializeCostAggregate(m.cost).total), 0n), wanted.money)
      }
      const q = host.aggregation.queryUsageScope({ start: date, end: date, utc })
      assert.equal(q.totals.calls, want.calls)
      assert.equal(fixedMoney(q.totals.cost.total), want.money)
      for (const k of TOKEN_KEYS) assert.equal(q.totals[k], want[k], 'query:' + date + ':' + k)
    }
  }
  for (const [key, value] of state.diagCounters || []) if (key.startsWith('q.reconciled.')) assert.equal(value, 0, 'the stress oracle must not depend on query self-healing')
}

test('authoritative live history accepts sequenced usage across a reversed midnight timestamp', async (t) => {
  const events = [usage(MIDNIGHT_CST + 1000, 1, 1, 10, 0), usage(MIDNIGHT_CST - 1000, 1, 2, 20, 1)]
  const host = makeHost(new Map(), new Map([['s', events]])); t.after(host.close)
  await host.sessionSync.enqueue('s', () => host.sessionSync.syncLiveSession('s', 'w', events[1], 0))
  await host.ledger.drainLedgerWrites()
  assertOracle(host, events)
  assert.equal(host.disk.get('s').usage.length, 2)
})

test('an active ledger write survives cache pressure, cold reads and repricing', async (t) => {
  const previousBudget = process.env.DSH_ALL_USAGE_RECORD_CACHE_MB
  process.env.DSH_ALL_USAGE_RECORD_CACHE_MB = '0'
  const host = makeHost(); t.after(host.close)
  const gate = deferred(), entered = deferred()
  let installing, repricing
  try {
    const before = usage(MIDNIGHT_CST - 1000, 1, 1, 10, 0)
    const after = usage(MIDNIGHT_CST + 1000, 1, 2, 20, 1)
    await host.install('s', [before])
    const write = host.state.ledgerUnit.putRecord
    let blocked = false
    host.state.ledgerUnit.putRecord = async (...args) => {
      if (!blocked) { blocked = true; entered.resolve(); await gate.promise }
      return write(...args)
    }
    installing = host.install('s', [before, after])
    await entered.promise
    assert.equal(host.state.ledgerPending.has('s'), false, 'the write has already left the pending queue')
    host.ledger.replaceLedgerRecord({ ...host.disk.get('s'), sessionId: 'pressure', updatedAt: Date.now(), turns: [], usage: [] })
    const current = await host.ledger.recordFor('s')
    assert.equal(current.lastSeq, 1, 'a cold read must not restore the pre-write record')
    assert.equal(current.usage.length, 2)
    host.aggregation.evictColdRows({ rows: 0 })
    assert.equal(host.state.usageByStep.size, 2, 'detail rows remain recoverable until their write settles')
    repricing = host.pricing.updatePricingState({ catalogEntries: catalog(2) }, false, true)
    gate.resolve()
    await Promise.all([installing, repricing])
    await host.ledger.drainLedgerWrites()
    assert.equal(host.disk.get('s').lastSeq, 1)
    assert.equal(host.disk.get('s').usage.length, 2, 'repricing must not overwrite the durable tail with an old disk snapshot')
    assertOracle(host, [before, after], 2)
    assert.equal(host.state.ledgerWriting.size, 0)
    host.aggregation.evictColdRows({ rows: 0 })
    assert.equal(host.state.usageByStep.size, 0, 'settled writes release their detail-row pin')
    host.ledger.replaceLedgerRecord({ ...host.disk.get('s'), sessionId: 'after-write', updatedAt: Date.now(), turns: [], usage: [] })
    assert.equal(host.state.ledgerRecords.has('s'), false, 'settled writes release their record-cache pin')
  } finally {
    gate.resolve()
    await Promise.allSettled([installing, repricing].filter(Boolean))
    await host.ledger.drainLedgerWrites()
    if (previousBudget === undefined) delete process.env.DSH_ALL_USAGE_RECORD_CACHE_MB
    else process.env.DSH_ALL_USAGE_RECORD_CACHE_MB = previousBudget
  }
})

test('repricing retains a borrowed ledger record through concurrent cache pressure', async (t) => {
  const previousBudget = process.env.DSH_ALL_USAGE_RECORD_CACHE_MB
  process.env.DSH_ALL_USAGE_RECORD_CACHE_MB = '0'
  const host = makeHost(); t.after(host.close)
  try {
    const event = usage(MIDNIGHT_CST - 1000, 1, 1, 10, 0)
    await host.install('s', [event])
    host.aggregation.evictColdRows({ rows: 0 })
    const read = host.ledger.recordFor
    let pressured = false
    host.ledger.recordFor = async sid => {
      const record = await read(sid)
      if (sid === 's' && !pressured) {
        pressured = true
        host.ledger.replaceLedgerRecord({ ...record, sessionId: 'pressure', updatedAt: Date.now(), turns: [], usage: [] })
      }
      return record
    }
    await host.pricing.updatePricingState({ catalogEntries: catalog(2) }, false, true)
    assert.equal(pressured, true)
    assertOracle(host, [event], 2)
    assert.equal(host.disk.get('s').usage[0].cost.rates.input, '2', 'the durable price must follow the updated cube even when another session enters the LRU')
    assert.equal(host.state.ledgerReading.size, 0, 'pricing releases its record pin after persistence')
  } finally {
    if (previousBudget === undefined) delete process.env.DSH_ALL_USAGE_RECORD_CACHE_MB
    else process.env.DSH_ALL_USAGE_RECORD_CACHE_MB = previousBudget
  }
})

test('a live flush cannot replace the record borrowed by concurrent repricing', async (t) => {
  const host = makeHost(); t.after(host.close)
  const plainCatalog = factor => catalog(factor).map(({ temporalPricing, ...entry }) => entry)
  host.state.pricingState = normalizePricingState({ catalogEntries: plainCatalog(1), sync: { autoEnabled: false } })
  const gate = deferred(), entered = deferred()
  let repricing, flushing
  try {
    const before = usage(MIDNIGHT_CST - 1000, 1, 1, 10, 0)
    const after = usage(MIDNIGHT_CST + 1000, 2, 1, 20, 1)
    await host.install('s', [before])
    host.state.memberOf.set('s', 'w')
    const read = host.ledger.recordFor
    let blocked = false
    host.ledger.recordFor = async sid => {
      const record = await read(sid)
      if (sid === 's' && !blocked) { blocked = true; entered.resolve(); await gate.promise }
      return record
    }
    repricing = host.pricing.updatePricingState({ catalogEntries: plainCatalog(2) }, false, true)
    await entered.promise
    host.logs.set('s', [before, after])
    const session = { id: 's', header: { cwd: 'C:/stress' }, events: [before, after] }
    for (const fn of host.listeners.get('session/event') || []) fn(session, after)
    let flushReturned = false
    flushing = Promise.all((host.listeners.get('session/flush') || []).map(fn => fn(session))).then(() => { flushReturned = true })
    await yieldLoop(); await yieldLoop()
    assert.equal(flushReturned, false, 'the flush checkpoint waits for the earlier pricing task of this session')
    gate.resolve()
    await Promise.all([repricing, flushing])
    await host.sessionSync.enqueue('s', () => undefined)
    await host.ledger.drainLedgerWrites()
    assertOracle(host, [before, after], 2)
    assert.equal(host.disk.get('s').lastSeq, 1)
    assert.equal(host.disk.get('s').usage.length, 2)
    assert.ok(host.disk.get('s').usage.every(item => item.cost.rates.input === '2'), 'both requests retain their final prices on disk')
    assert.equal(host.disk.get('s').usage.reduce((n, item) => n + fixedMoney(item.cost.total), 0n), fixedMoney(serializeCostAggregate(host.state.totals.cost).total))
    assert.equal(host.state.ledgerReading.size, 0)
    assert.equal(host.state.ledgerWriting.size, 0)
    assert.equal(host.state.ledgerDirtySessions.size, 0)
  } finally {
    gate.resolve()
    await Promise.allSettled([repricing, flushing].filter(Boolean))
  }
})

test('a higher-sequence live correction to an evicted logical request replaces its original contribution', async (t) => {
  const host = makeHost(); t.after(host.close)
  const before = usage(MIDNIGHT_CST - 1000, 1, 1, 10, 0)
  const after = usage(MIDNIGHT_CST + 1000, 1, 1, 20, 1)
  await host.install('s', [before])
  host.aggregation.evictColdRows({ rows: 0 })
  assert.equal(host.state.usageByStep.size, 0)
  host.logs.set('s', [before, after])
  await host.sessionSync.enqueue('s', () => host.sessionSync.processLiveEvent('s', 'w', after))
  assertOracle(host, [after])
})


test('a contiguous new live request with a reversed midnight timestamp is aligned instead of dropped', async (t) => {
  const host = makeHost(); t.after(host.close)
  const before = usage(MIDNIGHT_CST + 1000, 1, 1, 10, 0)
  const after = usage(MIDNIGHT_CST - 1000, 1, 2, 20, 1)
  await host.install('s', [before])
  host.logs.set('s', [before, after])
  await host.sessionSync.enqueue('s', () => host.sessionSync.processLiveEvent('s', 'w', after))
  assertOracle(host, [before, after])
})


test('an evicted live correction stays pending when its authoritative read is unavailable', async (t) => {
  const host = makeHost(); t.after(host.close)
  const before = usage(MIDNIGHT_CST - 1000, 1, 1, 10, 0)
  const after = usage(MIDNIGHT_CST + 1000, 1, 1, 20, 1)
  await host.install('s', [before]); host.aggregation.evictColdRows({ rows:0 })
  host.logs.set('s', [before, after])
  const read = host.ctx.sessionQuery.readSession
  host.ctx.sessionQuery.readSession = async () => { throw new Error('temporarily unavailable session log') }
  await host.sessionSync.enqueue('s', () => host.sessionSync.processLiveEvent('s', 'w', after))
  const page = await host.aggregation.queryRecords({ utc:true, start:'2026-10-12', end:'2026-10-13' }, undefined, 10)
  assert.equal(page.items[0].values.input, 10, 'until resync succeeds, detail remains consistent with the last settled contribution')
  assertOracle(host, [before])
  host.ctx.sessionQuery.readSession = read
  await host.sessionSync.enqueue('s', () => host.sessionSync.resyncLiveSession('s', 'w', 0))
  assertOracle(host, [after])
  assert.equal(host.state.liveResyncPending.size, 0)
})

test('a stale retry retains late usage rejected as a completed-turn replay', async (t) => {
  const host = makeHost(); t.after(host.close)
  const first = usage(MIDNIGHT_CST + 1000, 1, 1, 30, 0)
  const turnEnd = { seq: 1, time: MIDNIGHT_CST + 2000, type: 'turn/end', data: { turn: 1 } }
  const late = usage(MIDNIGHT_CST - 1000, 1, 2, 10, 2)
  await host.install('s', [first, turnEnd])
  const read = host.ctx.sessionQuery.readSession
  host.ctx.sessionQuery.readSession = async () => { throw new Error('temporarily unavailable session log') }
  await host.sessionSync.enqueue('s', () => host.sessionSync.processLiveEvent('s', 'w', late))
  host.ctx.sessionQuery.readSession = read
  assert.ok(host.state.liveResyncTriggers.has('s'))
  assertOracle(host, [first])
  await host.sessionSync.enqueue('s', () => host.sessionSync.resyncLiveSession('s', 'w', 0))
  assert.ok(host.state.liveResyncPending.has('s'), 'the old complete snapshot must not discard an unconfirmed late append')
  assertOracle(host, [first])
  host.logs.set('s', [first, turnEnd, late])
  await host.sessionSync.enqueue('s', () => host.sessionSync.resyncLiveSession('s', 'w', 0))
  await host.ledger.drainLedgerWrites()
  assert.equal(host.state.liveResyncPending.size, 0)
  assert.equal(host.state.liveResyncTriggers.size, 0)
  assertOracle(host, [first, late])
  assert.equal(host.disk.get('s').usage.reduce((sum, row) => sum + row.values.input, 0), 40)
})

test('a sequence-damaged retry cannot acknowledge an evicted correction', async (t) => {
  const host = makeHost(); t.after(host.close)
  const first = usage(MIDNIGHT_CST - 2000, 1, 1, 10, 0)
  const second = usage(MIDNIGHT_CST - 1000, 1, 2, 30, 1)
  const corrected = usage(MIDNIGHT_CST + 1000, 1, 1, 20, 2)
  await host.install('s', [first, second]); host.aggregation.evictColdRows({ rows: 0 })
  const read = host.ctx.sessionQuery.readSession
  host.ctx.sessionQuery.readSession = async () => { throw new Error('temporarily unavailable session log') }
  await host.sessionSync.enqueue('s', () => host.sessionSync.processLiveEvent('s', 'w', corrected))
  host.ctx.sessionQuery.readSession = read
  const unrelated = { seq: 2, time: MIDNIGHT_CST, type: 'request/header', data: { provider: 'deepseek', model: 'deepseek-v4-flash' } }
  host.logs.set('s', [corrected, unrelated, second])
  await host.sessionSync.enqueue('s', () => host.sessionSync.resyncLiveSession('s', 'w', 0))
  assert.ok(host.state.liveResyncPending.has('s'), 'a non-monotonic snapshot cannot complete correction recovery')
  assert.ok(host.state.liveResyncTriggers.has('s'))
  assertOracle(host, [first, second])
  host.logs.set('s', [first, second, corrected])
  await host.sessionSync.enqueue('s', () => host.sessionSync.resyncLiveSession('s', 'w', 0))
  await host.ledger.drainLedgerWrites()
  assert.equal(host.state.liveResyncPending.size, 0)
  assert.equal(host.state.liveResyncTriggers.size, 0)
  assertOracle(host, [corrected, second])
  assert.equal(host.disk.get('s').usage.reduce((sum, row) => sum + row.values.input, 0), 50)
})

test('failed live corrections survive stale retry snapshots until every trigger is present', async (t) => {
  const host = makeHost(); t.after(host.close)
  const first = usage(MIDNIGHT_CST - 2000, 1, 1, 10, 0)
  const second = usage(MIDNIGHT_CST - 1000, 1, 2, 30, 1)
  const correctedFirst = usage(MIDNIGHT_CST + 1000, 1, 1, 20, 2)
  const correctedSecond = usage(MIDNIGHT_CST + 2000, 1, 2, 40, 3)
  await host.install('s', [first, second]); host.aggregation.evictColdRows({ rows: 0 })
  const read = host.ctx.sessionQuery.readSession
  host.ctx.sessionQuery.readSession = async () => { throw new Error('temporarily unavailable session log') }
  await host.sessionSync.enqueue('s', () => host.sessionSync.processLiveEvent('s', 'w', correctedFirst))
  await host.sessionSync.enqueue('s', () => host.sessionSync.processLiveEvent('s', 'w', correctedSecond))
  host.ctx.sessionQuery.readSession = read
  const generation = host.aggregation.resetAggregationState()
  host.state.wsMeta.set('w', { id: 'w', path: 'C:/stress', title: 'Stress' })
  await host.sessionSync.runBaseline(generation)
  assert.ok(host.state.liveResyncPending.has('s'), 'a baseline scan cannot acknowledge corrections missing from its old snapshot')
  assert.ok(host.state.liveResyncTriggers.has('s'), 'full state reset retains unconfirmed correction evidence')
  assertOracle(host, [first, second])
  host.logs.set('s', [first, second, correctedSecond])
  await host.sessionSync.enqueue('s', () => host.sessionSync.resyncLiveSession('s', 'w', generation))
  assert.ok(host.state.liveResyncPending.has('s'), 'seeing the latest trigger cannot drop an earlier missing trigger')
  host.logs.set('s', [first, second, correctedFirst, correctedSecond])
  await host.sessionSync.enqueue('s', () => host.sessionSync.resyncLiveSession('s', 'w', generation))
  await host.ledger.drainLedgerWrites()
  assertOracle(host, [correctedFirst, correctedSecond])
  assert.equal(host.state.liveResyncPending.size, 0)
  const page = await host.aggregation.queryRecords({ utc: true, start: '2026-10-12', end: '2026-10-13' }, undefined, 10)
  assert.equal(page.items.reduce((sum, row) => sum + row.values.input, 0), 60)
  assert.equal(host.disk.get('s').usage.reduce((sum, row) => sum + row.values.input, 0), 60)
})

function canonical(events) {
  const rows = new Map()
  for (const event of events) rows.set(event.data.message.id, event)
  return Array.from(rows.values())
}
function assertDurableOracle(host, source) {
  const expected = []
  const prices = new Map()
  for (const [sid, events] of source) {
    const rows = canonical(events)
    const diskRows = host.disk.get(sid).usage
    assert.equal(diskRows.length, rows.length, 'durable row count for ' + sid)
    for (const event of rows) {
      const item = diskRows.find(r => r.turn === event.data.turn && r.step === event.data.step)
      assert.ok(item, 'missing durable logical row')
      const value = valuesOf(event)
      for (const k of TOKEN_KEYS) assert.equal(item.values[k], value[k], 'disk ' + sid + ':' + k)
      const factor = Number(item.cost.rates.input)
      assert.ok([1, 2, 3].includes(factor))
      assert.equal(fixedMoney(item.cost.total), expectedMoney(value, factor), 'independent durable cost')
      prices.set(event.data.message.id, factor)
      expected.push(event)
    }
  }
  assertOracle(host, expected, row => prices.get(row.data.message.id))
  assert.equal(host.state.ledgerReading.size, 0, 'all cold-read pins released')
}
