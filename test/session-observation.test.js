import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate as yieldLoop } from 'node:timers/promises'
import { createAggregation } from '../lib/aggregation.js'
import { createLedger } from '../lib/ledger.js'
import { createPricingRuntime } from '../lib/pricing-runtime.js'
import { createSessionSync } from '../lib/session-sync.js'
import { createCostAccumulator, normalizePricingState } from '../lib/pricing.js'

const TOKEN_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning']
const BASE_TIME = Date.parse('2026-10-13T00:00:00Z')
const MODEL = 'deepseek-v4-flash'
function catalog() {
  return [{
    providerId: 'deepseek',
    modelId: MODEL,
    displayName: 'Observed model',
    input: '1',
    output: '2',
    cacheRead: '0.25',
    cacheWrite: '0.5',
  }]
}
function deferred() {
  let resolve, reject
  const promise = new Promise((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}
function routeEvent(time) {
  return { seq: 0, time, type: 'request/context', data: { provider: 'deepseek', model: MODEL } }
}
function turnEnd(time, turn, seq) {
  return { seq, time, type: 'turn/end', data: { turn } }
}
function usage(time, turn, step, input, seq, sid = 's') {
  return { seq, time, type: 'assistant/message', data: { turn, step,
    message: { id: sid + ':' + turn + ':' + step, role: 'assistant', source: { kind: 'model', provider: 'deepseek', model: MODEL } },
    usage: { inputTokens: input, outputTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 1, reasoningTokens: 3 },
  } }
}
function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value
  Object.freeze(value)
  for (const item of Object.values(value)) deepFreeze(item)
  return value
}
// A hand-built host running the real aggregation, ledger, pricing and session-sync
// modules: the observation cut is injected where the Host would expose
// ctx.sessionQuery, and every lease reports its own lifetime.
function makeHost() {
  const logs = new Map()
  const disk = new Map()
  const listeners = new Map()
  const observations = { calls: [], order: [], leases: 0, releases: 0, readCalls: 0 }
  const state = {
    byDay: new Map(), byDayUtc: new Map(), perWorkspace: new Map(), perModel: new Map(), perSession: new Map(),
    usageByStep: new Map(), turnRecords: new Map(), usageByLocalDate: new Map(), usageByUtcDate: new Map(),
    sessionsByLocalDate: new Map(), sessionsByUtcDate: new Map(), rowTouch: new Map(),
    sessionModel: new Map(), sessionContextTimes: new Map(), sessionCount: new Set(), sessionSeq: new Map(),
    wsMeta: new Map([['w', { id: 'w', path: 'C:/stress', title: 'Observed' }]]), pathIndex: new Map(), memberOf: new Map(), chains: new Map(),
    totals: { turns: 0, ...Object.fromEntries(TOKEN_KEYS.map((k) => [k, 0])), cost: createCostAccumulator() },
    statsRevision: 0, dataRevision: 0, metadataRevision: 0, scanRevision: 0, pricingRevision: 0,
    statsDirtyScheduled: false, statsDirtyKinds: new Set(), aggregationGeneration: 0, retiredBucketUsed: false,
    pricingState: normalizePricingState({ catalogEntries: catalog(), sync: { autoEnabled: false } }),
    pricingResolutionCache: new Map(), pricingWriteChain: Promise.resolve(), pricingUnit: null,
    holidayCache: new Map(), pricingReady: Promise.resolve(), pricingSyncTimer: null,
    instanceId: 'isolated-observation', statsUpdatedAt: 0, snapshotCache: null, queryCache: new Map(), recordsQueryCache: new Map(),
    scan: { started: false, done: false, scanned: 0, total: 0, failed: 0 },
    ledgerRecords: new Map(), ledgerKeys: new Set(), ledgerRevision: 0,
    ledgerRecordSizes: new Map(), ledgerRecordBytes: 0, ledgerWriteChain: Promise.resolve(), ledgerReady: Promise.resolve(),
    ledgerDirtySessions: new Set(), ledgerDirtyEpochs: new Map(), ledgerWriteFailedSessions: new Set(),
    liveResyncPending: new Set(), liveResyncTriggers: new Map(), liveResyncTimers: new Map(), liveResyncAttempts: new Map(), knownSessionIds: new Set(),
    sync: { sessionsRead: 0, sessionsRestoredFromLedger: 0, sessionsFailed: 0, sessionsSkippedByRevision: 0, sessionsTotal: 0, persistenceSnapshotsAvailable: false, lastCompletedAt: 0, lastErrorAt: 0, lastErrorCode: null, workspaceSyncRuns: 0, workspaceSyncAdded: 0, workspaceSyncRemoved: 0, workspaceSyncDeferred: 0 },
    disposed: false, aliases: {}, reconcileTimer: null, workspaceProbeTimer: null,
    workspaceSyncTimer: null, baselineFallbackTimer: null, baselineRetryDelay: 1000,
  }
  function buildLease(sid, eventsFor) {
    let released = false
    let got = false
    observations.leases += 1
    observations.order.push('read')
    return {
      source: 'prepared',
      header: { id: sid, cwd: 'C:/stress' },
      inheritedEventCount: 0,
      cursor: -1,
      get events() {
        if (!got) { got = true; observations.order.push('get') }
        if (eventsFor === null) throw new Error('session cut is unreadable')
        return eventsFor
      },
      retain() { return this },
      [Symbol.dispose]() {
        if (released) return
        released = true
        observations.order.push('release')
        observations.releases += 1
      },
    }
  }
  const sessionQuery = {
    async listSessions() { return Array.from(logs.keys(), (id) => ({ header: { id, cwd: 'C:/stress' } })) },
    async readSession(sid) {
      observations.readCalls += 1
      await yieldLoop()
      return { events: structuredClone(logs.get(sid) || []) }
    },
    async observeSession(sid, options) {
      observations.calls.push({ sid, options })
      await yieldLoop()
      return buildLease(sid, Object.freeze(logs.get(sid) || []))
    },
  }
  const host = { state, services: {}, logs, disk, listeners, observations, makeLease: buildLease,
    ctx: {
      sessionQuery,
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
    async readRecord(sid) { await yieldLoop(); return structuredClone(disk.get(sid)) },
    async putRecord(table, sid, record) { await yieldLoop(); disk.set(sid, structuredClone(record)) },
  }
  host.install = async (sid, events, workspaceId = 'w') => {
    logs.set(sid, events)
    const record = host.ledger.buildLedgerRecord({ id: sid, events }, workspaceId, 'scan', undefined, null, true)
    host.ledger.replaceLedgerRecord(record)
    host.ledger.applyLedgerRecord(record, 'ledger-reuse')
    state.ledgerKeys.add(sid)
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
// resetAggregationState drops workspace metadata as part of the generation bump.
function reseed(host) {
  const generation = host.aggregation.resetAggregationState()
  host.state.wsMeta.set('w', { id: 'w', path: 'C:/stress', title: 'Observed' })
  return generation
}

test('a baseline scan reads through observeSession and never requests projections', async (t) => {
  const host = makeHost()
  t.after(host.close)
  host.logs.set('observed', [routeEvent(BASE_TIME), usage(BASE_TIME, 1, 1, 10, 1, 'observed'), turnEnd(BASE_TIME, 1, 2)])
  await host.sessionSync.runBaseline(reseed(host))
  assert.equal(host.observations.calls.length, 1)
  assert.equal(host.observations.calls[0].sid, 'observed')
  assert.deepEqual(host.observations.calls[0].options, { projectionMode: 'none' })
  assert.equal(host.observations.readCalls, 0, 'readSession must not run when observeSession exists')
  assert.equal(host.observations.releases, 1)
  assert.deepEqual(host.observations.order, ['read', 'get', 'release'], 'the cut is read, folded, then released')
  assert.equal(host.state.totals.input, 10)
  assert.equal(host.state.totals.turns, 1)
  assert.equal(host.state.scan.scanned, 1)
})

test('a frozen observation cut is folded without being rewritten', async (t) => {
  const host = makeHost()
  t.after(host.close)
  host.logs.set('frozen', deepFreeze([routeEvent(BASE_TIME), usage(BASE_TIME, 1, 1, 10, 1, 'frozen'), turnEnd(BASE_TIME, 1, 2)]))
  const before = JSON.stringify(host.logs.get('frozen'))
  await host.sessionSync.runBaseline(reseed(host))
  assert.equal(JSON.stringify(host.logs.get('frozen')), before, 'the read-only cut must not be modified')
  assert.equal(Object.isFrozen(host.logs.get('frozen')), true)
  assert.equal(host.state.totals.input, 10)
  assert.equal(host.state.totals.turns, 1)
  assert.equal(host.observations.releases, 1)
})

test('a Host without observeSession keeps the legacy readSession snapshot', async (t) => {
  const host = makeHost()
  t.after(host.close)
  delete host.ctx.sessionQuery.observeSession
  host.logs.set('legacy', [routeEvent(BASE_TIME), usage(BASE_TIME, 1, 1, 10, 1, 'legacy'), turnEnd(BASE_TIME, 1, 2)])
  await host.sessionSync.runBaseline(reseed(host))
  assert.equal(host.observations.calls.length, 0)
  assert.equal(host.observations.readCalls, 1, 'the legacy snapshot is still read')
  assert.equal(host.observations.releases, 0, 'a readSession snapshot has no lease to release')
  assert.equal(host.state.totals.input, 10)
  assert.equal(host.state.totals.turns, 1)
})

test('a baseline scan releases the lease after success, a throwing getter, and a rejected read', async (t) => {
  const host = makeHost()
  t.after(host.close)
  const goodEvents = [routeEvent(BASE_TIME), usage(BASE_TIME, 1, 1, 5, 1, 'good'), turnEnd(BASE_TIME, 1, 2)]
  const readFailEvents = [routeEvent(BASE_TIME), usage(BASE_TIME, 1, 1, 10, 1, 'read-fail'), turnEnd(BASE_TIME, 1, 2)]
  const getterFailEvents = [routeEvent(BASE_TIME), usage(BASE_TIME, 1, 1, 20, 1, 'getter-fail'), turnEnd(BASE_TIME, 1, 2)]
  await host.install('read-fail', readFailEvents)
  await host.install('getter-fail', getterFailEvents)
  host.logs.set('good', goodEvents)
  host.logs.set('read-fail', readFailEvents)
  host.logs.set('getter-fail', getterFailEvents)
  // Cold recovery: the saved records come back from the document store, not the cube.
  host.state.ledgerRecords.clear()
  host.state.ledgerRecordSizes.clear()
  host.state.ledgerRecordBytes = 0
  const generation = reseed(host)
  host.ctx.sessionQuery.observeSession = async (sid, options) => {
    host.observations.calls.push({ sid, options })
    await yieldLoop()
    if (sid === 'read-fail') throw new Error('observation unavailable')
    if (sid === 'getter-fail') return host.makeLease(sid, null)
    return host.makeLease(sid, Object.freeze(host.logs.get(sid) || []))
  }
  await host.sessionSync.runBaseline(generation)
  assert.equal(host.observations.calls.length, 3)
  assert.equal(host.observations.readCalls, 0, 'the legacy reader must not mask a failed observation')
  assert.equal(host.observations.leases, 2, 'a rejected read never produces a lease')
  assert.equal(host.observations.releases, 2, 'every lease is released exactly once, success or failure')
  assert.equal(host.state.totals.input, 35, 'the saved records are restored when the cut cannot be read')
  assert.equal(host.state.totals.turns, 3)
  assert.equal(host.state.scan.failed, 2)
  assert.equal(host.state.scan.scanned, 3)
  assert.equal(host.state.sync.sessionsRestoredFromLedger, 2)
  assert.equal(host.state.sessionSeq.get('good'), 2)
  for (const sid of ['read-fail', 'getter-fail']) {
    assert.equal(host.state.sessionSeq.get(sid), -1)
    assert.ok(host.state.sessionCount.has(sid))
  }
})

test('a generation change during a live read releases the lease and folds nothing', async (t) => {
  const host = makeHost()
  t.after(host.close)
  const events = [routeEvent(BASE_TIME), usage(BASE_TIME, 1, 1, 10, 1, 'racing')]
  host.logs.set('racing', events)
  const entered = deferred()
  const gate = deferred()
  host.ctx.sessionQuery.observeSession = async (sid, options) => {
    host.observations.calls.push({ sid, options })
    const lease = host.makeLease(sid, Object.freeze(events))
    entered.resolve()
    await gate.promise
    return lease
  }
  const task = host.sessionSync.enqueue('racing', () => host.sessionSync.processLiveEvent('racing', 'w', events[1]))
  // A regression that bypassed the observation path would never reach the gate:
  // fail cleanly instead of hanging the run on the in-flight read.
  const observed = await Promise.race([
    entered.promise.then(() => true),
    new Promise((resolve) => { const timer = setTimeout(() => resolve(false), 1000); if (timer.unref) timer.unref() }),
  ])
  if (!observed) {
    gate.resolve()
    await task
    assert.fail('the live read must go through observeSession')
  }
  assert.equal(host.observations.releases, 0, 'the lease must not be released while the read is in flight')
  host.aggregation.resetAggregationState()
  gate.resolve()
  await task
  assert.equal(host.observations.releases, 1, 'a superseded generation still releases its lease')
  assert.equal(host.state.totals.input, 0)
  assert.equal(host.state.sessionCount.has('racing'), false, 'a superseded snapshot is never folded')
  assert.equal(host.state.sessionSeq.has('racing'), false)
  assert.equal(host.state.liveResyncPending.size, 0)
})

test('an initial live event folds the complete observed cut and releases once', async (t) => {
  const host = makeHost()
  t.after(host.close)
  const events = [routeEvent(BASE_TIME), usage(BASE_TIME, 1, 1, 10, 1, 'live')]
  host.logs.set('live', events)
  await host.sessionSync.enqueue('live', () => host.sessionSync.processLiveEvent('live', 'w', events[1]))
  await host.ledger.drainLedgerWrites()
  assert.equal(host.observations.readCalls, 0)
  assert.deepEqual(host.observations.calls.map((call) => call.options), [{ projectionMode: 'none' }])
  assert.deepEqual(host.observations.order, ['read', 'get', 'release'])
  assert.equal(host.observations.releases, 1)
  assert.equal(host.state.totals.input, 10)
  assert.equal(host.state.sessionSeq.get('live'), 1)
  assert.equal(host.state.sessionCount.has('live'), true)
  assert.equal(host.state.liveResyncPending.size, 0)
  assert.equal(host.disk.get('live').usage.length, 1)
})

test('a failed live observation keeps fallback usage and a later resync recovers and releases', async (t) => {
  const host = makeHost()
  t.after(host.close)
  const first = usage(BASE_TIME, 1, 1, 10, 1, 'recover')
  host.logs.set('recover', [routeEvent(BASE_TIME), first])
  const observe = host.ctx.sessionQuery.observeSession
  host.ctx.sessionQuery.observeSession = async () => { throw new Error('observation unavailable') }
  await host.sessionSync.enqueue('recover', () => host.sessionSync.processLiveEvent('recover', 'w', first))
  assert.equal(host.observations.leases, 0, 'a rejected read never produced a lease')
  assert.equal(host.observations.releases, 0)
  assert.equal(host.state.totals.input, 10, 'the triggering usage survives the failed observation')
  assert.equal(host.state.liveResyncPending.has('recover'), true)
  host.ctx.sessionQuery.observeSession = observe
  const second = usage(BASE_TIME + 1000, 1, 2, 20, 2, 'recover')
  host.logs.set('recover', [routeEvent(BASE_TIME), first, second])
  await host.sessionSync.enqueue('recover', () => host.sessionSync.resyncLiveSession('recover', 'w', host.state.aggregationGeneration))
  assert.equal(host.observations.releases, 1, 'the successful resync releases its lease exactly once')
  assert.equal(host.state.totals.input, 30, 'the complete cut replaces the fallback without losing usage')
  assert.equal(host.state.liveResyncPending.size, 0)
  assert.equal(host.state.sessionSeq.get('recover'), 2)
})
