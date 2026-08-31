import { randomBytes } from 'node:crypto'
import { createAggregation } from './aggregation.js'
import { createBalance } from './balance.js'
import { registerRoutes } from './http.js'
import { createLedger } from './ledger.js'
import { createPricingRuntime } from './pricing-runtime.js'
import { createSessionSync } from './session-sync.js'
import { createCostAccumulator, createEmptyPricingState } from './pricing.js'

const name = 'dsh-all-usage'
const inject = ['sessionQuery', 'workspaceRegistry', 'timer', 'sessionPersistence', 'storage', 'webServer']

function apply(ctx) {
  const services = {
    credentials: ctx.get('credentials'),
    settings: ctx.get('settings'),
    storage: ctx.get('storage'),
    webServer: ctx.get('webServer'),
    sessionPersistence: ctx.get('sessionPersistence'),
  }
  const state = {
    wsMeta: new Map(),
    pathIndex: new Map(),
    memberOf: new Map(),
    byDay: new Map(),
    byDayUtc: new Map(),
    perWorkspace: new Map(),
    perModel: new Map(),
    usageByStep: new Map(),
    turnRecords: new Map(),
    usageByLocalDate: new Map(),
    usageByUtcDate: new Map(),
    sessionModel: new Map(),
    totals: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: createCostAccumulator() },
    sessionCount: new Set(),
    sessionSeq: new Map(),
    chains: new Map(),
    liveResyncPending: new Set(),
    liveResyncTimers: new Map(),
    liveResyncAttempts: new Map(),
    scan: { started: false, done: false, scanned: 0, total: 0, failed: 0 },
    aliases: {},
    kvUnit: null,
    aliasWriteChain: Promise.resolve(),
    aliasesReady: Promise.resolve(),
    balanceCache: { fetchedAt: 0, payload: null },
    requestToken: randomBytes(32).toString('base64url'),
    instanceId: randomBytes(12).toString('base64url'),
    statsRevision: 0,
    dataRevision: 0,
    metadataRevision: 0,
    scanRevision: 0,
    pricingRevision: 0,
    statsUpdatedAt: Date.now(),
    statsDirtyScheduled: false,
    statsDirtyKinds: new Set(),
    sync: {
      lastStartedAt: 0,
      lastCompletedAt: 0,
      lastErrorAt: 0,
      lastErrorCode: null,
      persistenceSnapshotsAvailable: false,
      sessionsTotal: 0,
      sessionsRead: 0,
      sessionsSkippedByRevision: 0,
      sessionsRestoredFromLedger: 0,
      sessionsFailed: 0,
    },
    ledgerRecords: new Map(),
    queryCache: new Map(),
    recordsQueryCache: new Map(),
    snapshotCache: null,
    ledgerRevision: Date.now(),
    ledgerUnit: null,
    ledgerReady: Promise.resolve(),
    ledgerWriteChain: Promise.resolve(),
    ledgerPending: new Map(),
    ledgerWriteWaiters: new Map(),
    ledgerWriteRunning: false,
    ledgerWriteScheduled: false,
    ledgerWriteTimer: null,
    ledgerDirtySessions: new Set(),
    ledgerDirtyEpochs: new Map(),
    ledgerWriteFailedSessions: new Set(),
    pricingState: createEmptyPricingState(),
    pricingResolutionCache: new Map(),
    pricingUnit: null,
    pricingReady: Promise.resolve(),
    pricingWriteChain: Promise.resolve(),
    pricingSyncInFlight: false,
    pricingSyncTimer: null,
    aggregationGeneration: 0,
    disposed: false,
    baselineRetryDelay: 1000,
    baselineRetryScheduled: false,
    baselineFallbackTimer: null,
    knownSessionIds: new Set(),
    reconcileHintScheduled: false,
    reconcilePending: false,
    reconcileInFlight: false,
    reconcileTimer: null,
  }

  const host = { ctx, services, state, webServer: services.webServer, aggregation: null, ledger: null, pricing: null, balance: null, sessionSync: null, aliases: null }
  function commitPendingStats() {
    if (!state.statsDirtyScheduled) return
    state.statsDirtyScheduled = false
    const kinds = state.statsDirtyKinds
    state.statsDirtyKinds = new Set()
    if (state.disposed) return
    state.statsRevision += 1
    if (kinds.has('data')) state.dataRevision += 1
    if (kinds.has('metadata')) state.metadataRevision += 1
    if (kinds.has('scan')) state.scanRevision += 1
    if (kinds.has('pricing')) state.pricingRevision += 1
    state.statsUpdatedAt = Date.now()
  }
  function markStatsChanged(kind = 'data') {
    const kinds = Array.isArray(kind) ? kind : [kind]
    let recordsChanged = false
    for (const value of kinds) {
      if (value !== 'data' && value !== 'metadata' && value !== 'scan' && value !== 'pricing') continue
      state.statsDirtyKinds.add(value)
      if (value === 'data' || value === 'pricing') recordsChanged = true
    }
    state.snapshotCache = null
    if (recordsChanged) state.recordsQueryCache.clear()
    if (state.disposed || state.statsDirtyScheduled) return
    state.statsDirtyScheduled = true
    if (typeof queueMicrotask === 'function') queueMicrotask(commitPendingStats)
    else Promise.resolve().then(commitPendingStats)
  }
  function resetSyncState() {
    state.sync.lastStartedAt = 0
    state.sync.lastCompletedAt = 0
    state.sync.lastErrorAt = 0
    state.sync.lastErrorCode = null
    state.sync.persistenceSnapshotsAvailable = false
    state.sync.sessionsTotal = 0
    state.sync.sessionsRead = 0
    state.sync.sessionsSkippedByRevision = 0
    state.sync.sessionsRestoredFromLedger = 0
    state.sync.sessionsFailed = 0
  }
  function beginSync() {
    resetSyncState()
    state.sync.lastStartedAt = Date.now()
    markStatsChanged('scan')
  }
  function noteSyncError(code) {
    state.sync.lastErrorAt = Date.now()
    state.sync.lastErrorCode = code
    markStatsChanged('scan')
  }
  function syncSnapshot() {
    return {
      lastStartedAt: state.sync.lastStartedAt,
      lastCompletedAt: state.sync.lastCompletedAt,
      lastErrorAt: state.sync.lastErrorAt,
      lastErrorCode: state.sync.lastErrorCode,
      persistenceSnapshotsAvailable: state.sync.persistenceSnapshotsAvailable,
      sessionsTotal: state.sync.sessionsTotal,
      sessionsRead: state.sync.sessionsRead,
      sessionsSkippedByRevision: state.sync.sessionsSkippedByRevision,
      sessionsRestoredFromLedger: state.sync.sessionsRestoredFromLedger,
      sessionsFailed: state.sync.sessionsFailed,
    }
  }
  Object.assign(host, { commitPendingStats, markStatsChanged, resetSyncState, beginSync, noteSyncError, syncSnapshot })

  host.pricingSnapshot = (...args) => host.pricing.pricingSnapshot(...args)
  host.syncSnapshot = (...args) => syncSnapshot(...args)
  host.aggregation = createAggregation(host)
  host.ledger = createLedger(host)
  host.pricing = createPricingRuntime(host)
  host.balance = createBalance(host)
  host.sessionSync = createSessionSync(host)

  async function loadAliases() {
    const storage = services.storage
    if (storage === undefined || storage === null) return
    try {
      const backend = storage.backend.get('json')
      if (backend === undefined || backend === null || backend.kv === undefined) return
      const unit = await backend.kv.open({ name: 'all_usage_aliases', version: 0, tables: [], hasGlobal: true })
      if (state.disposed) { await unit.close().catch(() => {}); return }
      state.kvUnit = unit
      const snap = await unit.loadAll()
      const global = snap && snap.global
      if (global !== null && global !== undefined && typeof global === 'object') {
        let changed = false
        for (const key of Object.keys(global)) {
          const value = global[key]
          const next = typeof value === 'string' ? value.trim() : ''
          if (next !== '' && state.aliases[key] !== next) {
            state.aliases[key] = next
            changed = true
          }
        }
        if (changed) markStatsChanged('metadata')
      }
    } catch (err) {
      console.error('[all-usage] alias storage unavailable:', err)
    }
  }
  function persistAliases() {
    if (state.disposed) return state.aliasWriteChain
    const snapshotAliases = {}
    for (const key of Object.keys(state.aliases)) snapshotAliases[key] = state.aliases[key]
    state.aliasWriteChain = state.aliasWriteChain.then(() => {
      if (state.kvUnit === null || state.kvUnit === undefined) return undefined
      return state.kvUnit.setGlobal(snapshotAliases).catch((err) => {
        console.error('[all-usage] alias persist failed:', err)
      })
    })
    return state.aliasWriteChain
  }
  function setAlias(wsId, raw) {
    if (typeof wsId !== 'string' || wsId.length === 0 || wsId.length > 256) return { ok: false, message: 'invalid-workspace', aliases: Object.assign({}, state.aliases) }
    if (typeof raw !== 'string') return { ok: false, message: 'invalid-alias', aliases: Object.assign({}, state.aliases) }
    const alias = raw.trim().slice(0, 80)
    if (!state.wsMeta.has(wsId)) return { ok: false, message: 'unknown-workspace', aliases: Object.assign({}, state.aliases) }
    const previous = typeof state.aliases[wsId] === 'string' ? state.aliases[wsId] : ''
    if (alias === previous) return { ok: true, aliases: Object.assign({}, state.aliases) }
    if (alias === '') delete state.aliases[wsId]
    else state.aliases[wsId] = alias
    persistAliases()
    markStatsChanged('metadata')
    return { ok: true, aliases: Object.assign({}, state.aliases) }
  }
  host.aliases = { loadAliases, persistAliases, setAlias }

  ctx.effect(() => async () => {
    state.disposed = true
    if (state.reconcileTimer !== null) {
      clearTimeout(state.reconcileTimer)
      state.reconcileTimer = null
    }
    if (state.baselineFallbackTimer !== null) {
      clearTimeout(state.baselineFallbackTimer)
      state.baselineFallbackTimer = null
    }
    if (state.pricingSyncTimer !== null) {
      clearTimeout(state.pricingSyncTimer)
      state.pricingSyncTimer = null
    }
    for (const timer of state.liveResyncTimers.values()) clearTimeout(timer)
    state.liveResyncTimers.clear()
    state.liveResyncAttempts.clear()
    state.liveResyncPending.clear()
    state.baselineRetryScheduled = false
    if (state.ledgerWriteTimer !== null) {
      clearTimeout(state.ledgerWriteTimer)
      state.ledgerWriteTimer = null
    }
    state.ledgerWriteScheduled = false
    state.chains.clear()
    await Promise.all([state.aliasesReady, state.ledgerReady, state.pricingReady, state.aliasWriteChain, state.pricingWriteChain])
    await host.ledger.drainLedgerWrites()
    const units = [state.kvUnit, state.ledgerUnit, state.pricingUnit]
    state.kvUnit = null
    state.ledgerUnit = null
    state.pricingUnit = null
    await Promise.all(units.map((unit) => unit === null || unit === undefined ? undefined : unit.close().catch(() => {})))
  })

  registerRoutes(host)
  state.ledgerReady = host.ledger.loadLedger()
  state.pricingReady = host.pricing.loadPricing().then(() => { host.pricing.schedulePricingSync() })
  void host.sessionSync.runBaseline()
  host.sessionSync.scheduleReconcileTimer()
  state.aliasesReady = loadAliases()
}

export { name, inject, apply }
export default { name, inject, apply }
