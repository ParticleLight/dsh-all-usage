// Fixtures for test/ledger-invariants.test.js.
//
// The host below is the glue lib/plugin.js builds in apply(): the state maps
// createAggregation()/createLedger() expect, plus markStatsChanged, the stats
// commit, resetSyncState, pricingSnapshot/syncSnapshot and sessionSync.lastSeqOf.
// Only the DSH services the invariants never reach (webServer, sessionQuery,
// timers) are left out. lib/ledger.js and lib/aggregation.js are the real modules
// and nothing here reimplements their logic; shardIndexOf is the exported
// ledgerShardIndex() itself.
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAggregation } from '../../lib/aggregation.js'
import { createLedger, ledgerShardIndex } from '../../lib/ledger.js'
import { createCostAccumulator, createEmptyPricingState } from '../../lib/pricing.js'

export const LEDGER_UNIT_NAME = 'all_usage_ledger'
export const LEDGER_SHARD_COUNT = 32
// lib/ledger.js keeps the migration marker private; the tests only need the key it
// is stored under, and only to prove the marker is written once and never rewritten.
export const LEDGER_META_KEY = '__all_usage_ledger_meta__'

export function ledgerShardUnitName(index) {
  return LEDGER_UNIT_NAME + '_' + String(index).padStart(2, '0')
}

export function shardIndexOf(sessionId) {
  return ledgerShardIndex(sessionId)
}

/** Where the migration marker lives once the trees exist (shard 00, per record). */
export function ledgerMetaRelativePath() {
  return ledgerShardUnitName(0) + '/sessions/' + LEDGER_META_KEY + '.json'
}

/** A host state object carrying the fields both modules read. */
function createInvariantState(overrides = {}) {
  const state = {
    wsMeta: new Map(),
    pathIndex: new Map(),
    memberOf: new Map(),
    byDay: new Map(),
    byDayUtc: new Map(),
    perWorkspace: new Map(),
    perModel: new Map(),
    perSession: new Map(),
    usageByStep: new Map(),
    turnRecords: new Map(),
    usageByLocalDate: new Map(),
    usageByUtcDate: new Map(),
    sessionsByLocalDate: new Map(),
    sessionsByUtcDate: new Map(),
    rowTouch: new Map(),
    sessionModel: new Map(),
    sessionContextTimes: new Map(),
    sessionCount: new Set(),
    sessionSeq: new Map(),
    chains: new Map(),
    liveResyncPending: new Set(),
    liveResyncTriggers: new Map(),
    liveResyncTimers: new Map(),
    liveResyncAttempts: new Map(),
    retiringWorkspaceIds: new Set(),
    totals: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: createCostAccumulator() },
    scan: { started: false, done: true, scanned: 0, total: 0, failed: 0 },
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
      workspaceProbeEvents: 0,
      workspaceSyncRuns: 0,
      workspaceSyncAdded: 0,
      workspaceSyncRemoved: 0,
      workspaceSyncDeferred: 0,
    },
    aliases: {},
    retiredBucketUsed: false,
    requestToken: 'invariant-token',
    instanceId: 'invariant-host',
    pluginVersion: '',
    statsRevision: 0,
    dataRevision: 0,
    metadataRevision: 0,
    scanRevision: 0,
    pricingRevision: 0,
    statsUpdatedAt: 0,
    statsDirtyScheduled: false,
    statsDirtyKinds: new Set(),
    snapshotCache: null,
    queryCache: new Map(),
    recordsQueryCache: new Map(),
    ledgerRecords: new Map(),
    ledgerKeys: new Set(),
    ledgerRecordSizes: new Map(),
    ledgerRecordBytes: 0,
    ledgerRevision: Number.NaN,
    ledgerUnit: null,
    ledgerReady: Promise.resolve(),
    ledgerWriteChain: Promise.resolve(),
    ledgerPending: new Map(),
    ledgerReading: new Map(),
    ledgerWriting: new Set(),
    ledgerWriteWaiters: new Map(),
    ledgerWriteRunning: false,
    ledgerWriteScheduled: false,
    ledgerWriteTimer: null,
    ledgerDirtySessions: new Set(),
    ledgerDirtyEpochs: new Map(),
    ledgerWriteFailedSessions: new Set(),
    pricingState: createEmptyPricingState(),
    pricingResolutionCache: new Map(),
    aggregationGeneration: 0,
    disposed: false,
    knownSessionIds: new Set(),
    diagCounters: new Map(),
    diagSums: new Map(),
  }
  return Object.assign(state, overrides)
}

// lib/session-sync.js lastSeqOf (session-sync.js:101-108). The ledger calls it only
// when the log tail carries no usable seq, which the fixtures never do; it is
// reproduced here because session-sync does not export it.
function lastSeqOf(events) {
  let last = -1
  for (const event of events) {
    const seq = Number.isSafeInteger(event.seq) ? event.seq : -1
    if (seq > last) last = seq
  }
  return last
}

export function createInvariantHost({ backend, state = createInvariantState() } = {}) {
  const host = {
    services: { storage: backend === undefined ? undefined : { backend: { get: (name) => (name === 'json' ? backend : undefined) } } },
    state,
  }
  // Host glue from lib/plugin.js apply(). The invariants do not depend on it; it
  // only has to exist for the modules to call.
  host.commitPendingStats = () => {
    if (!state.statsDirtyScheduled) return
    state.statsDirtyScheduled = false
    const kinds = state.statsDirtyKinds
    state.statsDirtyKinds = new Set()
    state.statsRevision += 1
    if (kinds.has('data')) state.dataRevision += 1
    if (kinds.has('metadata')) state.metadataRevision += 1
    if (kinds.has('scan')) state.scanRevision += 1
    if (kinds.has('pricing')) state.pricingRevision += 1
    state.statsUpdatedAt = Date.now()
  }
  host.markStatsChanged = (kind = 'data') => {
    for (const value of Array.isArray(kind) ? kind : [kind]) state.statsDirtyKinds.add(value)
    state.snapshotCache = null
    if (state.statsDirtyKinds.has('data') || state.statsDirtyKinds.has('pricing')) {
      state.queryCache.clear()
      state.recordsQueryCache.clear()
    }
    if (state.statsDirtyScheduled) return
    state.statsDirtyScheduled = true
    queueMicrotask(host.commitPendingStats)
  }
  host.resetSyncState = () => {
    state.sync.lastStartedAt = 0
    state.sync.lastCompletedAt = 0
    state.sync.sessionsTotal = 0
    state.sync.sessionsRead = 0
    state.sync.sessionsRestoredFromLedger = 0
    state.sync.sessionsFailed = 0
  }
  host.pricingSnapshot = () => ({})
  host.syncSnapshot = () => ({ ...state.sync })
  host.sessionSync = { lastSeqOf }
  host.aggregation = createAggregation(host)
  host.ledger = createLedger(host)
  return { host, state, aggregation: host.aggregation, ledger: host.ledger }
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    return undefined
  }
}

async function exists(path) {
  return stat(path).then(() => true, () => false)
}

/**
 * A kv backend laid out the way DSH's json storage is once the ledger has migrated:
 * one document per session under <root>/<unit>/sessions/<key>.json, plus the legacy
 * whole-unit file <root>/<unit>.json that the migration reads once and then retires.
 * Every open and write is recorded, so "the second start is a no-op" is checkable.
 */
export function createLedgerBackend(root) {
  const opens = []
  const writes = []

  function perRecordUnit(name) {
    const dir = join(root, name, 'sessions')
    return {
      name,
      tableDir(table) {
        if (table !== 'sessions') throw new Error('unexpected table: ' + table)
        return dir
      },
      async loadAll() {
        const rows = Object.create(null)
        for (const entry of await readdir(dir).catch(() => [])) {
          if (!entry.endsWith('.json')) continue
          const doc = await readJson(join(dir, entry))
          if (doc === null || doc === undefined || doc.record === undefined) continue
          rows[entry.slice(0, -'.json'.length)] = doc.record
        }
        return { global: {}, tables: { sessions: rows } }
      },
      async putRecord(table, key, value) {
        if (table !== 'sessions') throw new Error('unexpected table: ' + table)
        writes.push({ unit: name, key, layout: 'per-record' })
        await mkdir(dir, { recursive: true })
        await writeFile(join(dir, key + '.json'), JSON.stringify({ version: 0, record: value }), 'utf8')
      },
      async close() {},
    }
  }

  function wholeUnit(name) {
    const path = join(root, name + '.json')
    const unit = {
      name,
      async loadAll() {
        const doc = await readJson(path)
        if (doc === null || doc === undefined) return { global: {}, tables: { sessions: {} } }
        return { global: {}, tables: { sessions: doc.tables && doc.tables.sessions ? doc.tables.sessions : {} } }
      },
      async putRecord(table, key, value) {
        if (table !== 'sessions') throw new Error('unexpected table: ' + table)
        writes.push({ unit: name, key, layout: 'whole' })
        const current = await unit.loadAll()
        current.tables.sessions[key] = value
        await mkdir(root, { recursive: true })
        await writeFile(path, JSON.stringify({ version: 0, tables: current.tables }, null, 2), 'utf8')
      },
      async close() {},
    }
    return unit
  }

  const backend = {
    root,
    kv: {
      async open(descriptor) {
        opens.push({ name: descriptor.name, layout: descriptor.layout === undefined ? 'whole' : descriptor.layout })
        return descriptor.layout === 'per-record' ? perRecordUnit(descriptor.name) : wholeUnit(descriptor.name)
      },
    },
  }

  return {
    backend,
    opens,
    writes,
    /** Seed the pre-migration monolith: one whole-unit file holding session rows. */
    async seedLegacy(records) {
      await mkdir(root, { recursive: true })
      const sessions = Object.assign({}, records)
      await writeFile(join(root, LEDGER_UNIT_NAME + '.json'), JSON.stringify({ version: 0, tables: { sessions } }, null, 2), 'utf8')
    },
    /** Seed the old per-shard whole-unit file retirement removes. */
    async seedLegacyShardFile(index) {
      await writeFile(join(root, ledgerShardUnitName(index) + '.json'), JSON.stringify({ version: 0, tables: { sessions: {} } }, null, 2), 'utf8')
    },
    /** One session document, raw (identity pool and all). */
    async readDoc(sessionId) {
      return readJson(join(root, ledgerShardUnitName(shardIndexOf(sessionId)), 'sessions', sessionId + '.json'))
    },
    async treeSessionIds() {
      const ids = []
      for (let index = 0; index < LEDGER_SHARD_COUNT; index += 1) {
        const dir = join(root, ledgerShardUnitName(index), 'sessions')
        for (const entry of await readdir(dir).catch(() => [])) {
          if (!entry.endsWith('.json') || entry.startsWith('__')) continue
          ids.push(entry.slice(0, -'.json'.length))
        }
      }
      return ids.sort()
    },
    hasFile(relativePath) {
      return exists(join(root, relativePath))
    },
    /** Raw text of one file under the root, or null when it is not there. */
    async readText(relativePath) {
      return readFile(join(root, relativePath), 'utf8').then((text) => text, () => null)
    },
    /** Forget the marker, which is what an interrupted or older start looks like. */
    async removeMeta() {
      await rm(join(root, ledgerMetaRelativePath()), { force: true })
    },
  }
}

export async function createTempRoot() {
  return mkdtemp(join(tmpdir(), 'dsh-ledger-invariants-'))
}

export async function removeTempRoot(root) {
  await rm(root, { recursive: true, force: true })
}
