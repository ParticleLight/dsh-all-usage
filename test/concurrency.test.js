import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate as yieldLoop } from 'node:timers/promises'
import { createAggregation } from '../lib/aggregation.js'
import { cacheRecordsResult, recordKeyHash, recordPageReferences } from '../lib/records-cache.js'
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
  host.install = async (sid, events, workspaceId = 'w') => {
    logs.set(sid, structuredClone(events))
    const record = host.ledger.buildLedgerRecord({ id: sid, events }, workspaceId, 'scan', undefined, null, true)
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

for (const evict of [false, true]) {
  test((evict ? 'mixed resident-evicted' : 'resident') + ' baseline reprices backfill and temporal costs in one session visit', async (t) => {
    const host = makeHost(); t.after(host.close)
    const first = usage(MIDNIGHT_UTC - 1000, 1, 1, 10, 0, 'pricing-a')
    const second = usage(MIDNIGHT_UTC + 1000, 1, 1, 20, 0, 'pricing-b')
    const pricingState = host.state.pricingState
    host.state.pricingState = normalizePricingState({ sync: { autoEnabled: false } })
    host.state.pricingResolutionCache.clear()
    await host.install('pricing-a', [first])
    host.state.pricingState = pricingState
    host.state.pricingResolutionCache.clear()
    await host.install('pricing-b', [second])
    if (evict) {
      host.aggregation.evictColdRows({ rows: 0 })
      assert.equal(host.state.usageByStep.size, 1)
      assert.ok(host.state.usageByStep.has('pricing-a:step:1:1'), 'the unpriced request stays resident')
      assert.equal(host.state.usageByStep.has('pricing-b:step:1:1'), false, 'the priced request is evicted')
    }

    const calls = new Map()
    const recordFor = host.ledger.recordFor.bind(host.ledger)
    host.ledger.recordFor = async (sid) => { calls.set(sid, (calls.get(sid) || 0) + 1); return recordFor(sid) }
    const reconciliation = await host.pricing.reconcileUsageCosts({ backfill: true, force: true })
    assert.equal(reconciliation.backfill.priced, 1)
    assert.ok(reconciliation.temporal.considered > 0)
    assert.deepEqual(Array.from(calls), [['pricing-a', 1], ['pricing-b', 1]])
    assert.equal(host.disk.get('pricing-a').usage[0].cost.status, 'priced')
    assertOracle(host, [first, second])
  })
}

test('authoritative live history accepts sequenced usage across a reversed midnight timestamp', async (t) => {
  const events = [usage(MIDNIGHT_CST + 1000, 1, 1, 10, 0), usage(MIDNIGHT_CST - 1000, 1, 2, 20, 1)]
  const host = makeHost(new Map(), new Map([['s', events]])); t.after(host.close)
  await host.sessionSync.enqueue('s', () => host.sessionSync.syncLiveSession('s', 'w', events[1], 0))
  await host.ledger.drainLedgerWrites()
  assertOracle(host, events)
  assert.equal(host.disk.get('s').usage.length, 2)
})

test('cold range reads concurrent with live events and repricing preserve both midnight calendars', async (t) => {
  const host = makeHost(); t.after(host.close)
  const source = new Map()
  for (let i = 0; i < 12; i++) {
    const sid = 's' + i
    const base = i % 2 ? MIDNIGHT_CST : MIDNIGHT_UTC
    const events = [usage(base - 1000, 1, 1, 10 + i, 0, sid), usage(base + 1000, 1, 2, 20 + i, 1, sid)]
    source.set(sid, events); await host.install(sid, events)
  }
  const all = () => Array.from(source.values()).flat()
  assertOracle(host, all())
  host.aggregation.evictColdRows({ rows: 0 })
  await Promise.all([
    host.ledger.loadRowsForRange(true, '2026-10-12', '2026-10-13'),
    host.pricing.updatePricingState({ catalogEntries: catalog(2) }, false, true),
    ...Array.from(source, async ([sid, list], i) => {
      const next = usage(list[1].time + 1000, 2, 1, 30 + i, 2, sid)
      list.push(next); host.logs.set(sid, structuredClone(list))
      await host.sessionSync.enqueue(sid, () => host.sessionSync.processLiveEvent(sid, 'w', next))
      const record = host.ledger.buildLedgerRecord({ id: sid, events: list }, 'w', 'flush', undefined, host.state.ledgerRecords.get(sid))
      host.ledger.storeLedgerRecord(record); await host.ledger.persistLedgerRecord(record)
    }),
  ])
  await host.pricing.updatePricingState({ catalogEntries: catalog(2) }, false, true)
  await host.ledger.drainLedgerWrites()
  assertOracle(host, all(), 2)
  host.aggregation.evictColdRows({ rows: 0 })
  const resumed = makeHost(host.disk, host.logs); t.after(resumed.close)
  resumed.state.pricingState = normalizePricingState({ catalogEntries: catalog(2), sync: { autoEnabled: false } })
  for (const [sid, raw] of host.disk) {
    const record = resumed.ledger.normalizeLedgerRecord(raw, sid)
    resumed.ledger.replaceLedgerRecord(record); resumed.ledger.applyLedgerRecord(record, 'ledger-reuse')
  }
  assertOracle(resumed, all(), 2)
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

test('a cold records page created during repricing uses the same revision as its cursor', async (t) => {
  const host = makeHost(); t.after(host.close)
  const events = [usage(MIDNIGHT_UTC - 1000, 1, 1, 10, 0), usage(MIDNIGHT_UTC + 1000, 1, 2, 20, 1)]
  await host.install('s', events)
  host.aggregation.evictColdRows({ rows: 0 })
  const entered = deferred(), gate = deferred()
  const load = host.ledger.loadRowsForRange
  host.ledger.loadRowsForRange = async (...args) => { entered.resolve(); await gate.promise; return load(...args) }
  const scope = { start: '2026-10-12', end: '2026-10-13', utc: true }
  let query
  try {
    query = host.aggregation.queryRecords(scope, undefined, 1)
    await entered.promise
    await host.pricing.updatePricingState({ catalogEntries: catalog(2) }, false, true)
    gate.resolve()
    const first = await query
    assert.ok(first.nextCursor)
    const cursor = JSON.parse(Buffer.from(first.nextCursor, 'base64url').toString('utf8'))
    assert.equal(cursor.queryRevision, first.queryRevision, 'a returned page must not advertise an already-stale cursor')
    const second = await host.aggregation.queryRecords(scope, first.nextCursor, 1)
    assert.equal(second.error, undefined)
    assert.equal(new Set(first.items.concat(second.items).map(r => r.id)).size, 2)
    assert.equal(first.items.concat(second.items).reduce((n, r) => n + fixedMoney(r.cost.total), 0n), expectedMoney({ input: 30, output: 4, cacheRead: 8, cacheWrite: 2 }, 2))
    assertOracle(host, events, 2)
  } finally {
    gate.resolve()
    if (query !== undefined) await Promise.allSettled([query])
  }
})

test('overlapping pricing updates serialize durable costs to the final table exactly once', async (t) => {
  const host = makeHost(); t.after(host.close)
  const events = [usage(MIDNIGHT_CST - 1000, 1, 1, 10, 0), usage(MIDNIGHT_CST + 1000, 1, 2, 20, 1)]
  await host.install('s', events)
  host.aggregation.evictColdRows({ rows: 0 })
  const gate = deferred(), entered = deferred()
  const write = host.state.ledgerUnit.putRecord
  let blocked = false
  host.state.ledgerUnit.putRecord = async (...args) => { if (!blocked) { blocked = true; entered.resolve(); await gate.promise }; return write(...args) }
  let first, second
  try {
    first = host.pricing.updatePricingState({ catalogEntries: catalog(2) }, false, true)
    await entered.promise
    second = host.pricing.updatePricingState({ catalogEntries: catalog(3) }, false, true)
    gate.resolve()
    await Promise.all([first, second])
    assertOracle(host, events, 3)
    for (const item of host.disk.get('s').usage) assert.equal(item.cost.rates.input, '3')
  } finally {
    gate.resolve()
    await Promise.allSettled([first, second].filter(Boolean))
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


test('cold rows keep per-key workspace ownership during partial retirement', async (t) => {
  const previousBudget = process.env.DSH_ALL_USAGE_RECORD_CACHE_MB
  process.env.DSH_ALL_USAGE_RECORD_CACHE_MB = '0'
  const host = makeHost(); t.after(host.close)
  const gate = deferred(), entered = deferred()
  let retiring
  try {
    const before = usage(MIDNIGHT_CST - 1000, 1, 1, 10, 0)
    const after = usage(MIDNIGHT_CST + 1000, 1, 2, 20, 1)
    await host.install('s', [before])
    host.state.memberOf.set('s', 'w')
    const load = host.ledger.loadRowsForSession
    let blocked = false
    host.ledger.loadRowsForSession = async sid => {
      if (sid === 's' && !blocked) { blocked = true; entered.resolve(); await gate.promise }
      return load(sid)
    }
    host.ctx.workspaceRegistry.list = () => []
    retiring = host.sessionSync.synchronizeWorkspaceRegistry()
    await entered.promise
    assert.ok(host.state.retiringWorkspaceIds.has('w'))
    host.logs.set('s', [before, after])
    await host.sessionSync.enqueue('s', () => host.sessionSync.processLiveEvent('s', 'w', after))
    assert.equal(host.state.perWorkspace.get('w').input, 10)
    assert.equal(host.state.perWorkspace.get('retired:deleted').input, 20)
    const record = host.ledger.buildLedgerRecord({ id: 's', header: { cwd: 'C:/stress' }, events: [before, after] }, 'w', 'flush', undefined, host.disk.get('s'), true)
    host.ledger.replaceLedgerRecord(record)
    await host.ledger.persistLedgerRecord(record)
    host.aggregation.evictColdRows({ rows: 0 })
    host.state.ledgerRecords.clear(); host.state.ledgerRecordSizes.clear(); host.state.ledgerRecordBytes = 0
    const page = await host.aggregation.queryRecords({ utc: true, start: '2026-10-12', end: '2026-10-13' }, undefined, 10)
    assert.deepEqual(page.items.map(row => [row.values.input, row.workspaceId]).sort((a, b) => a[0] - b[0]), [[10, 'w'], [20, 'retired:deleted']])
    assert.equal(host.state.perWorkspace.get('w').input, 10)
    assert.equal(host.state.perWorkspace.get('retired:deleted').input, 20)
    gate.resolve(); await retiring
    assert.equal(host.state.perWorkspace.get('w')?.input || 0, 0)
    assert.equal(host.state.perWorkspace.get('retired:deleted').input, 30)
    assertOracle(host, [before, after])
    assert.equal(host.disk.get('s').workspaceId, 'w')
  } finally {
    gate.resolve()
    if (retiring !== undefined) await Promise.allSettled([retiring])
    if (previousBudget === undefined) delete process.env.DSH_ALL_USAGE_RECORD_CACHE_MB
    else process.env.DSH_ALL_USAGE_RECORD_CACHE_MB = previousBudget
  }
})

test('workspace removal racing a truncated history and cold read never retires deleted usage', async (t) => {
  const previousBudget = process.env.DSH_ALL_USAGE_RECORD_CACHE_MB
  process.env.DSH_ALL_USAGE_RECORD_CACHE_MB = '0'
  const host = makeHost(); t.after(host.close)
  const gate = deferred(), entered = deferred()
  let retiring
  try {
    const event = usage(MIDNIGHT_CST - 1000, 1, 1, 100, 0)
    await host.install('s', [event])
    host.aggregation.evictColdRows({ rows: 0 })
    // Drop the clean record before the cold workspace scan begins.
    host.state.ledgerRecords.clear(); host.state.ledgerRecordSizes.clear(); host.state.ledgerRecordBytes = 0
    const read = host.state.ledgerUnit.readRecord
    let first = true
    host.state.ledgerUnit.readRecord = async (sid) => {
      if (first && sid === 's') { first = false; const old = structuredClone(host.disk.get(sid)); entered.resolve(); await gate.promise; return old }
      return read(sid)
    }
    host.ctx.workspaceRegistry.list = () => []
    retiring = host.sessionSync.synchronizeWorkspaceRegistry()
    await entered.promise
    host.logs.set('s', [])
    await host.sessionSync.enqueue('s', () => host.sessionSync.syncLiveSession('s', 'w', null, 0))
    await host.ledger.drainLedgerWrites()
    host.ledger.replaceLedgerRecord({ ...host.disk.get('s'), sessionId: 'other', updatedAt: Date.now() })
    gate.resolve(); await retiring
    assertOracle(host, [])
    assert.equal(host.state.usageByStep.size, 0)
    for (const value of host.state.perWorkspace.values()) {
      for (const key of TOKEN_KEYS) assert.equal(value[key], 0, 'no phantom or negative workspace contribution')
      assert.equal(fixedMoney(serializeCostAggregate(value.cost).total), 0n)
    }
    assert.equal(host.disk.get('s').usage.length, 0)
    assert.equal(host.state.ledgerReading.size, 0)
  } finally {
    gate.resolve()
    if (retiring !== undefined) await Promise.allSettled([retiring])
    if (previousBudget === undefined) delete process.env.DSH_ALL_USAGE_RECORD_CACHE_MB
    else process.env.DSH_ALL_USAGE_RECORD_CACHE_MB = previousBudget
  }
})



test('live appends and cold pages during workspace retirement stay in the retired aggregate', async (t) => {
  const previousBudget = process.env.DSH_ALL_USAGE_RECORD_CACHE_MB
  process.env.DSH_ALL_USAGE_RECORD_CACHE_MB = '0'
  const host = makeHost(); t.after(host.close)
  const gate = deferred(), entered = deferred()
  let retiring
  try {
    const before = usage(MIDNIGHT_CST - 1000, 1, 1, 10, 0, 'a')
    await host.install('a', [before])
    await host.install('b', [])
    host.state.memberOf.set('a', 'w'); host.state.memberOf.set('b', 'w')
    host.ctx.workspaceRegistry.list = () => []
    const load = host.ledger.loadRowsForSession
    host.ledger.loadRowsForSession = async sid => { if (sid === 'b') { entered.resolve(); await gate.promise }; return load(sid) }
    retiring = host.sessionSync.synchronizeWorkspaceRegistry()
    await entered.promise
    assert.equal(Array.from(host.state.perSession.get('a').buckets.values())[0].wsId, 'retired:deleted')
    // Its original durable record can be read after the remapped wrapper is evicted.
    host.aggregation.evictColdRows({ rows: 0 })
    host.state.ledgerRecords.clear(); host.state.ledgerRecordSizes.clear(); host.state.ledgerRecordBytes = 0
    const page = await host.aggregation.queryRecords({ utc: true, start:'2026-10-12', end:'2026-10-13' }, undefined, 10)
    assert.equal(page.items[0].workspaceId, 'retired:deleted', 'cold detail follows the aggregate while metadata retirement is awaiting another session')
    host.aggregation.evictColdRows({ rows:0 })
    await host.pricing.updatePricingState({ catalogEntries: catalog(2) }, false, true)
    assertOracle(host, [before], 2)
    const after = usage(MIDNIGHT_CST + 1000, 1, 2, 20, 1, 'a')
    host.logs.set('a', [before, after])
    const resolvedWs = host.sessionSync.wsForLiveSession({ header: { cwd:'C:/stress' } }, 'a')
    await host.sessionSync.enqueue('a', () => host.sessionSync.processLiveEvent('a', resolvedWs, after))
    gate.resolve(); await retiring
    assertOracle(host, [before, after], 2)
    assert.equal(host.state.perWorkspace.get('w')?.input || 0, 0, 'late live usage does not recreate the removed workspace bucket')
    assert.equal(host.state.perWorkspace.get('retired:deleted').input, 30)
    const finalPage = await host.aggregation.queryRecords({ utc: true, start:'2026-10-12', end:'2026-10-13' }, undefined, 10)
    assert.ok(finalPage.items.every(row => row.workspaceId === 'retired:deleted'))
    assert.equal(host.disk.get('a').workspaceId, 'w', 'durable attribution keeps the original workspace')
  } finally {
    gate.resolve()
    if (retiring !== undefined) await Promise.allSettled([retiring])
    if (previousBudget === undefined) delete process.env.DSH_ALL_USAGE_RECORD_CACHE_MB
    else process.env.DSH_ALL_USAGE_RECORD_CACHE_MB = previousBudget
  }
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

test('seeded mixed live, history rewrite, cold paging, repricing, and recovery sequences conserve accounting', async () => {
  const rounds = Number(process.env.DSH_ALL_USAGE_STRESS_ROUNDS || 8)
  const seeds = String(process.env.DSH_ALL_USAGE_STRESS_SEEDS || '7').split(',').map(Number)
  assert.ok(Number.isInteger(rounds) && rounds > 0 && rounds <= 10000)
  const previousBudget = process.env.DSH_ALL_USAGE_RECORD_CACHE_MB
  process.env.DSH_ALL_USAGE_RECORD_CACHE_MB = '0'
  const result = []
  try {
    for (const seed of seeds) {
      let entropy = seed >>> 0
      const next = () => { entropy = (Math.imul(entropy, 1664525) + 1013904223) >>> 0; return entropy }
      let host = makeHost()
      const source = new Map()
      let factor = 1, writes = 0, queries = 0, recoveries = 0
      try {
        for (let i = 0; i < 16; i++) {
          const sid = 's' + i, base = i % 2 ? MIDNIGHT_CST : MIDNIGHT_UTC
          const events = [usage(base - 1000, 1, 1, 10 + i, 0, sid), usage(base + 1000, 1, 2, 20 + i, 1, sid)]
          source.set(sid, events); await host.install(sid, events)
        }
        assertDurableOracle(host, source)
        for (let round = 0; round < rounds; round++) {
          host.aggregation.evictColdRows({ rows: 0 })
          const selected = new Set()
          while (selected.size < 4) selected.add('s' + (next() % 16))
          const tasks = []
          for (const sid of selected) {
            let events = source.get(sid).slice()
            const choice = next() % 3
            if (choice === 0 && events.length > 1) {
              events = events.slice(0, 1 + (next() % (events.length - 1))).map((event, seq) => ({ ...event, seq }))
            } else {
              const seq = events.length
              const old = events[next() % events.length]
              const turn = choice === 1 ? old.data.turn : round + 2
              const step = choice === 1 ? old.data.step : 1
              const time = (next() % 2 ? MIDNIGHT_CST : MIDNIGHT_UTC) + (next() % 5 - 2) * 3600000 + round * 100
              events.push(usage(time, turn, step, 1 + (next() % 1000), seq, sid))
            }
            source.set(sid, events); host.logs.set(sid, structuredClone(events))
            tasks.push(host.sessionSync.enqueue(sid, () => host.sessionSync.syncLiveSession(sid, 'w', null, 0)))
            writes++
          }
          for (const utc of [false, true]) {
            queries++
            tasks.push(host.aggregation.queryRecords({ utc, start: '2026-10-11', end: '2026-10-14' }, undefined, 7).then(page => {
              if (page.error) { assert.equal(page.error, 'stale-cursor'); return }
              if (page.nextCursor) assert.equal(JSON.parse(Buffer.from(page.nextCursor, 'base64url')).queryRevision, page.queryRevision)
            }))
          }
          if (round % 4 === 0) {
            factor = 1 + next() % 3
            tasks.push(host.pricing.updatePricingState({ catalogEntries: catalog(factor) }, false, true))
          }
          await Promise.all(tasks)
          await host.ledger.drainLedgerWrites()
          assertDurableOracle(host, source)
          if (round % 8 === 7) {
            const disk = host.disk, logs = host.logs
            await host.close()
            host = makeHost(disk, logs)
            host.state.pricingState = normalizePricingState({ catalogEntries: catalog(factor), sync: { autoEnabled: false } })
            for (const [sid, raw] of disk) {
              const record = host.ledger.normalizeLedgerRecord(raw, sid)
              host.ledger.replaceLedgerRecord(record); host.ledger.applyLedgerRecord(record, 'ledger-reuse')
            }
            recoveries++
            assertDurableOracle(host, source)
          }
        }
        result.push({ seed, rounds, writes, queries, recoveries, remainingRows: Array.from(source.values()).reduce((n, e) => n + canonical(e).length, 0) })
      } finally { await host.close() }
    }
  } finally {
    if (previousBudget === undefined) delete process.env.DSH_ALL_USAGE_RECORD_CACHE_MB
    else process.env.DSH_ALL_USAGE_RECORD_CACHE_MB = previousBudget
  }
  console.log('CONCURRENCY_STRESS ' + JSON.stringify(result))
})

function compactCachedScope(host) {
  const entry = Array.from(host.state.recordsQueryCache.values()).find(result => result.kind === 'rows' && result.rows.length > 0)
  assert.ok(entry)
  cacheRecordsResult(host.state.recordsQueryCache, 'test-padding', new Array(24000).fill(entry.rows[0]))
  assert.equal(entry.kind, 'index')
  return entry
}
function discardReadResidency(host) {
  // Date key indices survive residency eviction; cold adoption only restores
  // payload objects, so clearing those indices would create an invalid fixture.
  for (const name of ['usageByStep', 'rowTouch', 'ledgerRecords', 'ledgerRecordSizes']) host.state[name].clear()
  host.state.ledgerRecordBytes = 0
}
const recordsScope = { start: '2026-10-12', end: '2026-10-13', utc: true }

test('compact pages preserve tie order, read only missing page sessions, and recover after index eviction', async t => {
  const host = makeHost(); t.after(host.close)
  const a = [usage(MIDNIGHT_UTC - 1000, 1, 1, 1, 1, 'a'), usage(MIDNIGHT_UTC + 1000, 1, 2, 2, 2, 'a')]
  const b = [usage(MIDNIGHT_UTC - 1000, 1, 1, 11, 1, 'b'), usage(MIDNIGHT_UTC + 1000, 1, 2, 12, 2, 'b')]
  const older = [usage(MIDNIGHT_UTC - 2000, 1, 1, 100, 0, 'c')]
  await host.install('a', a); await host.install('b', b); await host.install('c', older)
  assertOracle(host, [...a, ...b, ...older])
  const all = await host.aggregation.queryRecords(recordsScope, undefined, 100)
  assert.deepEqual(all.items.map(item => item.values.input), [2, 12, 1, 11, 100])
  const first = await host.aggregation.queryRecords(recordsScope, undefined, 2)
  compactCachedScope(host); discardReadResidency(host)
  const residentRecord = host.disk.get('a')
  host.aggregation.adoptUsageRow(host.aggregation.usageRowOf(residentRecord, residentRecord.usage[0], 'ledger-reuse'))
  const read = host.state.ledgerUnit.readRecord, reads = []
  host.state.ledgerUnit.readRecord = async sid => { reads.push(sid); return read(sid) }
  const load = host.ledger.loadRowsForRange
  host.ledger.loadRowsForRange = async () => { throw new Error('an index hit must not read the whole range') }
  const second = await host.aggregation.queryRecords(recordsScope, first.nextCursor, 2)
  assert.deepEqual(second.items.map(item => item.values.input), [1, 11])
  assert.deepEqual(reads, ['b'], 'resident a is reused; c is outside this page')
  const last = await host.aggregation.queryRecords(recordsScope, second.nextCursor, 2)
  assert.deepEqual(last.items.map(item => item.values.input), [100])
  assert.deepEqual(reads, ['b', 'c'])
  assert.equal(last.hasMore, false); assert.equal(last.nextCursor, null)
  const ids = [...first.items, ...second.items, ...last.items].map(item => item.id)
  assert.deepEqual(ids, all.items.map(item => item.id)); assert.equal(new Set(ids).size, 5)
  const decoded = JSON.parse(Buffer.from(first.nextCursor, 'base64url').toString())
  decoded.offset = 5
  const empty = await host.aggregation.queryRecords(recordsScope, Buffer.from(JSON.stringify(decoded)).toString('base64url'), 2)
  assert.deepEqual(empty.items, []); assert.equal(empty.hasMore, false); assert.equal(empty.nextCursor, null)
  host.state.recordsQueryCache.clear(); host.ledger.loadRowsForRange = load
  const rebuilt = await host.aggregation.queryRecords(recordsScope, first.nextCursor, 2)
  assert.deepEqual(rebuilt.items.map(item => item.id), second.items.map(item => item.id))
  assertOracle(host, [...a, ...b, ...older])
})

test('index page rejects a stale cursor while repriced costs await durable persistence', async t => {
  const host = makeHost(); t.after(host.close)
  const events = [usage(MIDNIGHT_UTC - 1000, 1, 1, 10, 0), usage(MIDNIGHT_UTC + 1000, 1, 2, 20, 1)]
  await host.install('s', events)
  const first = await host.aggregation.queryRecords(recordsScope, undefined, 1)
  compactCachedScope(host); discardReadResidency(host)
  const readEntered = deferred(), readGate = deferred(), writeEntered = deferred(), writeGate = deferred()
  const read = host.state.ledgerUnit.readRecord, write = host.state.ledgerUnit.putRecord
  let holdRead = true, holdWrite = true, querying, repricing
  host.state.ledgerUnit.readRecord = async sid => {
    const snapshot = await read(sid)
    if (holdRead) { holdRead = false; readEntered.resolve(); await readGate.promise }
    return snapshot
  }
  host.state.ledgerUnit.putRecord = async (...args) => {
    if (holdWrite) { holdWrite = false; writeEntered.resolve(); await writeGate.promise }
    return write(...args)
  }
  try {
    querying = host.aggregation.queryRecords(recordsScope, first.nextCursor, 1)
    await readEntered.promise
    repricing = host.pricing.updatePricingState({ catalogEntries: catalog(2) }, false, true)
    await writeEntered.promise
    readGate.resolve()
    const stale = await querying
    assert.equal(stale.error, 'stale-cursor', 'new costs are published before persistence completes')
    const current = await host.aggregation.queryRecords(recordsScope, undefined, 1)
    assert.notEqual(current.pricingRevision, first.pricingRevision)
    assert.equal(current.items[0].cost.rates.input, '2')
    writeGate.resolve(); await repricing; await host.ledger.drainLedgerWrites()
    assertOracle(host, events, 2)
    assert.equal(host.state.ledgerReading.size, 0); assert.equal(host.state.ledgerWriting.size, 0)
  } finally {
    readGate.resolve(); writeGate.resolve()
    await Promise.allSettled([querying, repricing].filter(Boolean))
  }
})

test('index first page retries after data changes during page materialization', async t => {
  const host = makeHost(); t.after(host.close)
  const events = [usage(MIDNIGHT_UTC - 1000, 1, 1, 10, 0), usage(MIDNIGHT_UTC + 1000, 1, 2, 20, 1)]
  await host.install('s', events)
  await host.aggregation.queryRecords(recordsScope, undefined, 1)
  compactCachedScope(host); discardReadResidency(host)
  const entered = deferred(), gate = deferred(), read = host.state.ledgerUnit.readRecord
  let hold = true, querying
  host.state.ledgerUnit.readRecord = async sid => {
    const snapshot = await read(sid)
    if (hold) { hold = false; entered.resolve(); await gate.promise }
    return snapshot
  }
  try {
    querying = host.aggregation.queryRecords(recordsScope, undefined, 2)
    await entered.promise
    const next = [...events, usage(MIDNIGHT_UTC + 2000, 1, 3, 30, 2)]
    await host.install('s', next)
    gate.resolve()
    const result = await querying
    assert.equal(result.error, undefined)
    assert.deepEqual(result.items.map(item => item.values.input), [30, 20])
    const cursor = JSON.parse(Buffer.from(result.nextCursor, 'base64url').toString())
    assert.equal(cursor.queryRevision, host.state.dataRevision + ':' + host.state.pricingRevision)
    assertOracle(host, next)
  } finally { gate.resolve(); await Promise.allSettled([querying].filter(Boolean)) }
})

test('missing indexed keys do not silently shorten a cursor page', async t => {
  const host = makeHost(); t.after(host.close)
  const events = [usage(MIDNIGHT_UTC - 1000, 1, 1, 10, 0), usage(MIDNIGHT_UTC + 1000, 1, 2, 20, 1)]
  await host.install('s', events)
  const first = await host.aggregation.queryRecords(recordsScope, undefined, 1)
  const index = compactCachedScope(host)
  const reference = recordPageReferences(index, 1, 1)[0]
  discardReadResidency(host)
  host.disk.get('s').usage = host.disk.get('s').usage.filter(item => item.key !== reference.key)
  const result = await host.aggregation.queryRecords(recordsScope, first.nextCursor, 1)
  assert.equal(result.error, 'stale-cursor')
  assert.equal(host.state.ledgerReading.size, 0)
})

test('a failed index page read releases its borrowed record before propagating the error', async t => {
  const host = makeHost(); t.after(host.close)
  await host.install('s', [usage(MIDNIGHT_UTC - 1000, 1, 1, 10, 0), usage(MIDNIGHT_UTC + 1000, 1, 2, 20, 1)])
  const first = await host.aggregation.queryRecords(recordsScope, undefined, 1)
  compactCachedScope(host); discardReadResidency(host)
  const read = host.state.ledgerUnit.readRecord
  host.state.ledgerUnit.readRecord = async () => { throw new Error('injected page read failure') }
  await assert.rejects(host.aggregation.queryRecords(recordsScope, first.nextCursor, 1), /injected page read failure/)
  assert.equal(host.state.ledgerReading.size, 0)
  host.state.ledgerUnit.readRecord = read
  const retry = await host.aggregation.queryRecords(recordsScope, first.nextCursor, 1)
  assert.equal(retry.items.length, 1)
})

test('an index page keeps selected keys when cache churn recycles their numeric ids during I/O', async t => {
  const host = makeHost(); t.after(host.close)
  await host.install('s', [usage(MIDNIGHT_UTC - 1000, 1, 1, 10, 0), usage(MIDNIGHT_UTC + 1000, 1, 2, 20, 1)])
  const first = await host.aggregation.queryRecords(recordsScope, undefined, 1)
  compactCachedScope(host); discardReadResidency(host)
  const entered = deferred(), gate = deferred(), read = host.state.ledgerUnit.readRecord
  let querying
  host.state.ledgerUnit.readRecord = async sid => { entered.resolve(); await gate.promise; return read(sid) }
  try {
    querying = host.aggregation.queryRecords(recordsScope, first.nextCursor, 1)
    await entered.promise
    for (let index = 0; index < 25; index += 1) {
      const sid = 'other-' + index
      cacheRecordsResult(host.state.recordsQueryCache, sid, new Array(24001).fill({ item: { sid, key: sid + ':step:0:0' } }))
    }
    gate.resolve()
    const result = await querying
    assert.equal(result.error, undefined)
    assert.deepEqual(result.items.map(item => item.values.input), [10])
    assert.equal(result.hasMore, false)
    assert.equal(host.state.ledgerReading.size, 0)
  } finally { gate.resolve(); await Promise.allSettled([querying].filter(Boolean)) }
})

test('page read failures settle every borrowed session before returning an error', async t => {
  const host = makeHost(); t.after(host.close)
  for (const [sid, input] of [['a', 1], ['b', 10]]) await host.install(sid, [usage(MIDNIGHT_UTC - 1000, 1, 1, input, 1, sid), usage(MIDNIGHT_UTC + 1000, 1, 2, input + 1, 2, sid)])
  const first = await host.aggregation.queryRecords(recordsScope, undefined, 1)
  compactCachedScope(host); discardReadResidency(host)
  const entered = deferred(), gate = deferred(), read = host.state.ledgerUnit.readRecord
  let querying, settled = false
  host.state.ledgerUnit.readRecord = async sid => {
    if (sid === 'a') throw new Error('injected parallel read failure')
    entered.resolve(); await gate.promise; return read(sid)
  }
  try {
    querying = host.aggregation.queryRecords(recordsScope, first.nextCursor, 2)
    querying.then(() => { settled = true }, () => { settled = true })
    await entered.promise; await yieldLoop(); await yieldLoop()
    assert.equal(settled, false, 'the page owns the other outstanding read until it settles')
    gate.resolve(); await assert.rejects(querying, /injected parallel read failure/)
    assert.equal(host.state.ledgerReading.size, 0)
  } finally { gate.resolve(); await Promise.allSettled([querying].filter(Boolean)) }
})

test('legacy key digests materialize the original row without retaining its payload key in the index', async t => {
  const host = makeHost(); t.after(host.close)
  await host.install('s', [usage(MIDNIGHT_UTC - 1000, 1, 1, 10, 0)])
  const payloadKey = 's:event:' + JSON.stringify({ usage: { inputTokens: 10 }, extra: 'x'.repeat(10000) })
  host.disk.get('s').usage[0].key = payloadKey
  discardReadResidency(host)
  const rows = await host.ledger.readUsageRows([{ sid: 's', keyHash: recordKeyHash(payloadKey) }], true)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].item.key, payloadKey)
  assert.equal(rows[0].item.values.input, 10)
  assert.equal(rows[0].item.wsId, 'w')
  assert.equal(host.state.ledgerReading.size, 0)
})

test('compact cold pages preserve workspace, model, provider, local-day and UTC-day filters', async t => {
  const host = makeHost(); t.after(host.close)
  host.state.wsMeta.set('w2', { id: 'w2', path: 'C:/other', title: 'Other' })
  host.state.pricingState = normalizePricingState({ catalogEntries: [...catalog(), ...catalog().map(entry => ({ ...entry, modelId: 'deepseek-v4-pro' }))], sync: { autoEnabled: false } })
  const groups = [
    ['a', 'w', 'deepseek-v4-flash', 10],
    ['b', 'w2', 'deepseek-v4-flash', 100],
    ['c', 'w2', 'deepseek-v4-pro', 1000],
  ]
  const events = []
  const instants = [MIDNIGHT_CST - 1000, MIDNIGHT_CST + 1000, MIDNIGHT_UTC - 1000, MIDNIGHT_UTC + 1000]
  for (const [sid, workspaceId, model, input] of groups) {
    const rows = instants.map((time, index) => {
      const event = usage(time, 1, index + 1, input + index, index, sid)
      event.data.message.source.model = model
      return event
    })
    events.push(...rows); await host.install(sid, rows, workspaceId)
  }
  assertOracle(host, events)
  const all = (await host.aggregation.queryRecords(recordsScope, undefined, 100)).items
  const scopes = [
    ...[false, true].flatMap(utc => ['2026-10-12', '2026-10-13'].map(date => ({ start: date, end: date, utc }))),
    { ...recordsScope, workspaceId: 'w2' },
    { ...recordsScope, modelKey: 'vendor/DEEPSEEK-V4-PRO' },
    { ...recordsScope, workspaceId: 'w2', provider: 'deepseek', modelKey: all.find(row => row.actualModel === 'deepseek-v4-pro').identityKey },
  ]
  const view = item => ({ id: item.id, time: item.time, date: item.date, workspaceId: item.workspaceId, provider: item.provider, model: item.actualModel, values: item.values, cost: item.cost.total })
  const read = host.state.ledgerUnit.readRecord
  const range = host.ledger.loadRowsForRange
  for (const scope of scopes) {
    host.state.recordsQueryCache.clear()
    const expected = all.map(item => ({ ...item, date: scope.utc ? new Date(item.time).toISOString().slice(0, 10) : host.aggregation.dayKey(item.time) }))
      .filter(item => item.date >= scope.start && item.date <= scope.end)
      .filter(item => scope.workspaceId === undefined || item.workspaceId === scope.workspaceId)
      .filter(item => scope.modelKey === undefined || item.actualModel === 'deepseek-v4-pro')
    host.ledger.loadRowsForRange = range
    const full = await host.aggregation.queryRecords(scope, undefined, 100)
    assert.deepEqual(full.items.map(view), expected.map(view))
    compactCachedScope(host); discardReadResidency(host)
    const reads = new Map()
    host.state.ledgerUnit.readRecord = async sid => { reads.set(sid, (reads.get(sid) || 0) + 1); return read(sid) }
    host.ledger.loadRowsForRange = async () => { throw new Error('a compact filtered page must not reload the scope') }
    const selected = []
    let cursor
    do {
      const page = await host.aggregation.queryRecords(scope, cursor, 2)
      assert.equal(page.error, undefined)
      selected.push(...page.items); cursor = page.nextCursor
    } while (cursor)
    assert.deepEqual(selected.map(view), expected.map(view))
    assert.ok([...reads.values()].every(count => count === 1), 'each missing session is read once and reused across its rows/pages')
    assert.equal(host.state.ledgerReading.size, 0)
  }
  host.ledger.loadRowsForRange = range
  assertOracle(host, events)
})

test('a missing indexed key on the first page stays visible as stale instead of silently rebuilding a shorter scope', async t => {
  const host = makeHost(); t.after(host.close)
  const events = [usage(MIDNIGHT_UTC - 1000, 1, 1, 10, 0), usage(MIDNIGHT_UTC + 1000, 1, 2, 20, 1)]
  await host.install('s', events)
  await host.aggregation.queryRecords(recordsScope, undefined, 1)
  const entry = compactCachedScope(host)
  const reference = recordPageReferences(entry, 0, 1)[0]
  discardReadResidency(host)
  host.disk.get('s').usage = host.disk.get('s').usage.filter(item => item.key !== reference.key)
  const result = await host.aggregation.queryRecords(recordsScope, undefined, 1)
  assert.equal(result.error, 'stale-cursor')
  assert.equal(host.state.ledgerReading.size, 0)
  assertOracle(host, events)
})

test('legacy lone-surrogate keys materialize as separate original requests', async t => {
  const host = makeHost(); t.after(host.close)
  await host.install('s', [usage(MIDNIGHT_UTC - 1000, 1, 1, 10, 0), usage(MIDNIGHT_UTC + 1000, 1, 2, 20, 1)])
  const keys = ['s:legacy:\ud800', 's:legacy:\ud801']
  host.disk.get('s').usage.forEach((row, index) => { row.key = keys[index] })
  discardReadResidency(host)
  const rows = await host.ledger.readUsageRows(keys.map(key => ({ sid: 's', keyHash: recordKeyHash(key) })), true)
  assert.deepEqual(rows.map(row => row.item.key), keys)
  assert.deepEqual(rows.map(row => row.item.values.input), [10, 20])
  assert.equal(host.state.ledgerReading.size, 0)
})







test('page lookup walks a large authoritative array once then reads only selected positions', async t => {
  const host = makeHost(); t.after(host.close)
  await host.install('s', [usage(MIDNIGHT_UTC - 1000, 1, 1, 10, 0)])
  const template = host.disk.get('s').usage[0]
  const record = { ...host.disk.get('s'), usage: Array.from({ length: 30000 }, (_, index) => ({ ...template, key: 's:step:1:' + index, step: index, values: { ...template.values, input: index } })) }
  let reads = 0
  record.usage = new Proxy(record.usage, { get(target, key, receiver) { if (typeof key === 'string' && /^\d+$/.test(key)) reads++; return Reflect.get(target, key, receiver) } })
  discardReadResidency(host)
  host.state.ledgerRecords.set('s', record)
  const row = await host.ledger.readUsageRows([{ sid: 's', key: 's:step:1:29999' }])
  assert.equal(row[0].item.values.input, 29999)
  assert.equal(reads, 30001)
  const start = reads
  for (let index = 0; index < 20; index += 1) {
    const page = await host.ledger.readUsageRows([{ sid: 's', key: 's:step:1:' + index }])
    assert.equal(page[0].item.values.input, index)
  }
  assert.equal(reads - start, 20, 'subsequent pages reuse numeric positions without traversing the whole usage array')
  record.usage.reverse()
  const reordered = await host.ledger.readUsageRows([{ sid: 's', key: 's:step:1:0' }])
  assert.equal(reordered[0].item.values.input, 0, 'same-length in-place reordering invalidates selected positions')
  record.usage.push({ ...template, key: 's:step:1:30000', values: { ...template.values, input: 30000 } })
  const appended = await host.ledger.readUsageRows([{ sid: 's', key: 's:step:1:30000' }])
  assert.equal(appended[0].item.values.input, 30000)
  record.usage = [template]
  const replaced = await host.ledger.readUsageRows([{ sid: 's', key: template.key }])
  assert.equal(replaced[0].item.values.input, template.values.input)
  assert.equal(host.state.ledgerReading.size, 0)
})

test('compact page reads cap missing sessions at eight and leave residency unchanged', async t => {
  const host = makeHost(); t.after(host.close)
  const references = []
  for (let index = 0; index < 10; index += 1) {
    const sid = 'session-' + index
    const record = await host.install(sid, [usage(MIDNIGHT_UTC - 1000, 1, 1, index + 1, 0, sid)])
    references.push({ sid, key: record.usage[0].key })
  }
  discardReadResidency(host)
  const adopted = host.state.diagCounters?.get('row.adopted') || 0
  const read = host.state.ledgerUnit.readRecord
  let active = 0, highest = 0, reads = 0
  host.state.ledgerUnit.readRecord = async sid => {
    reads++; active++; highest = Math.max(highest, active)
    try { await yieldLoop(); return await read(sid) } finally { active-- }
  }
  const rows = await host.ledger.readUsageRows(references)
  assert.deepEqual(rows.map(row => row.item.values.input), Array.from({ length: 10 }, (_, index) => index + 1))
  assert.equal(reads, 10); assert.equal(highest, 8)
  assert.equal(host.state.usageByStep.size, 0)
  assert.equal(host.state.diagCounters?.get('row.adopted') || 0, adopted)
  assert.equal(host.state.ledgerReading.size, 0)
  discardReadResidency(host)
  host.state.ledgerUnit.readRecord = async sid => {
    if (sid === 'session-8') throw new Error('later batch failure')
    await yieldLoop(); return read(sid)
  }
  await assert.rejects(host.ledger.readUsageRows(references), /later batch failure/)
  assert.equal(host.state.ledgerReading.size, 0)
  assert.equal(host.state.usageByStep.size, 0)
})

test('unstable first-page construction returns stale after exactly three attempts', async t => {
  const host = makeHost(); t.after(host.close)
  await host.install('s', [usage(MIDNIGHT_UTC - 1000, 1, 1, 10, 0)])
  const load = host.ledger.loadRowsForRange
  let attempts = 0
  host.ledger.loadRowsForRange = async (...args) => { attempts++; await load(...args); host.markStatsChanged('data') }
  const result = await host.aggregation.queryRecords(recordsScope, undefined, 1)
  assert.equal(result.error, 'stale-cursor')
  assert.equal(attempts, 3)
  assert.equal(host.state.recordsQueryCache.size, 0)
})
