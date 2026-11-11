import { mkdir, readdir, readFile, rmdir, stat, unlink, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { archiveRecords, createArchiveReader } from './archive.js'
import { recordKeyHash, recordKeyLocator } from './records-cache.js'
import { calculateCost, normalizeCostSnapshot } from './pricing.js'
import { billingInstantOf, contextTimeKey, extractUsageEvent, normalizeUsageValues as usageValues, pickPricingTime, touchContextTimes, upsertUsageSample as upsertUsageSampleState, usageStepKey } from './usage-core.js'

// Usage recorded for workspaces that left the registry is summed into one
// bucket. The ledger's promise is that flushed usage survives deletion, and a
// row per dead workspace would grow the dashboard without adding information.
const RETIRED_WORKSPACE_ID = 'retired:deleted'

// Re-attribute a record (and its turns/usage items) to another workspace id.
// Only the in-memory copy is retargeted: the persisted row keeps its original
// workspace id and cwd, so the mapping stays reversible.
function retargetLedgerRecord(record, workspaceId = RETIRED_WORKSPACE_ID) {
  if (record === null || record === undefined) return record
  const retargeted = {
    ...record,
    workspaceId,
    turns: Array.isArray(record.turns) ? record.turns.map((turn) => ({ ...turn, workspaceId })) : record.turns,
    usage: Array.isArray(record.usage) ? record.usage.map((item) => ({ ...item, workspaceId })) : record.usage,
  }
  // Pricing may later write a resident retired copy. Keep a non-enumerable pointer
  // to the original durable shape so that write-back changes costs without erasing
  // the historical workspace attribution.
  Object.defineProperty(retargeted, '__durableRecord', {
    value: record.__durableRecord || record,
    enumerable: false,
    configurable: true,
  })
  return retargeted
}

const LEDGER_VERSION = 3
const PREVIOUS_LEDGER_VERSION = 2
const LEGACY_LEDGER_VERSION = 1
const LEDGER_SHARD_COUNT = 32
const LEDGER_UNIT_NAME = 'all_usage_ledger'
const LEDGER_META_KEY = '__all_usage_ledger_meta__'
const LEDGER_WRITE_DEBOUNCE_MS = 25
// A second DSH process can share this data root, and maintenance deletes files
// the other one may still be reading. One lock guards every step that does: the
// first migration and every retirement. Record writes never take it.
const LEDGER_LOCK_OWNER_FILE = 'owner.json'
// A holder silent for this long is treated as killed. The threshold has to exceed
// the slowest honest migration, or a slow copy would be reclaimed while it runs.
const LEDGER_LOCK_STALE_MS = 30000

// DSH 0.1.5 replaced the Session `events` getter with `snapshotEvents()` while
// 0.1.1 exposed `events`; both return the log in seq order. Read whichever the
// running runtime provides, because falling back to an empty log would fold a
// flushed session into an empty ledger record.
function sessionEvents(session) {
  if (session === null || session === undefined) return []
  if (Array.isArray(session.events)) return session.events
  if (typeof session.snapshotEvents === 'function') {
    try {
      const snapshot = session.snapshotEvents()
      if (Array.isArray(snapshot)) return snapshot
    } catch (error) {
      return []
    }
  }
  return []
}

// Ledger sequences follow the DSH contract: -1 marks a missing/unavailable
// sequence, otherwise a non-negative safe integer is required.
function validLedgerSeq(value) {
  return value === -1 || (Number.isSafeInteger(value) && value >= 0)
}

function pollutedLedgerKey(key) {
  // Older builds stored raw String(seq) in event keys. Only keys that are
  // entirely numeric text (leading zeros, signs, whitespace, decimals,
  // exponents, huge values) are treated as bare sequence keys and rebuilt;
  // composite keys such as positional event:N and usageStepKey forms that
  // contain colons, letters, or hyphens are never flagged.
  if (typeof key !== 'string') return true
  // Bare whole values only: composite keys such as 'Infinity-session:step:1:1'
  // are valid usageStepKey output and must keep the revision fast path.
  if (key === 'Infinity' || key === '-Infinity' || key === 'NaN' || key === '-NaN') return true
  if (!/^[+\-0-9.eE \t]+$/.test(key)) return false
  if (!/^(?:0|[1-9]\d*)$/.test(key)) return true
  return !Number.isSafeInteger(Number(key))
}

function ledgerShardIndex(sessionId) {
  let hash = 2166136261
  const value = typeof sessionId === 'string' ? sessionId : String(sessionId)
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0) % LEDGER_SHARD_COUNT
}

function ledgerShardName(index) {
  return LEDGER_UNIT_NAME + '_' + String(index).padStart(2, '0')
}

function sessionRows(snapshot) {
  const rows = snapshot && snapshot.tables && snapshot.tables.sessions
  return rows !== null && rows !== undefined && typeof rows === 'object' ? rows : {}
}

function uniqueUnits(units) {
  return Array.from(new Set(units.filter((unit) => unit !== null && unit !== undefined)))
}

// The maintenance lock is a directory: mkdir is atomic, so exactly one process can
// create it, and the owner document inside tells later readers who holds it and
// since when. It is never taken around a record write.
function ledgerMaintenanceLockDir(root) {
  return join(root, LEDGER_UNIT_NAME + '.lock')
}

async function ledgerMaintenanceLockIsStale(dir, ownerFile) {
  let startedAt = null
  try {
    const owner = JSON.parse(await readFile(ownerFile, 'utf8'))
    if (owner !== null && typeof owner === 'object' && Number.isFinite(owner.startedAt)) startedAt = owner.startedAt
  } catch (error) {
    startedAt = null
  }
  if (startedAt !== null) return Date.now() - startedAt > LEDGER_LOCK_STALE_MS
  // The owner document is written right after the directory is created, so a lock
  // without one is either mid-acquisition or half-removed. Only the age of the
  // directory tells those apart from a holder that never got to write it.
  const info = await stat(dir).catch(() => null)
  return info === null || Date.now() - info.mtimeMs > LEDGER_LOCK_STALE_MS
}

/**
 * Take the maintenance lock for one root. Returns a handle, or null: null means
 * another process holds the lock, or something unexpected happened, and either way
 * the caller must not run maintenance.
 */
async function acquireMaintenanceLock(root) {
  if (typeof root !== 'string' || root === '') return null
  const dir = ledgerMaintenanceLockDir(root)
  const ownerFile = join(dir, LEDGER_LOCK_OWNER_FILE)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(dir, { mode: 0o700 })
      // No reader could ever date a lock without an owner document, so a failed
      // write releases the directory again instead of leaving it behind.
      const owner = { pid: process.pid, startedAt: Date.now(), host: hostname() }
      try {
        await writeFile(ownerFile, JSON.stringify(owner), { encoding: 'utf8', mode: 0o600 })
      } catch (error) {
        await rmdir(dir).catch(() => {})
        return null
      }
      return { dir, ownerFile, owner }
    } catch (error) {
      if (error === null || typeof error !== 'object' || error.code !== 'EEXIST') return null
      if (attempt > 0 || !(await ledgerMaintenanceLockIsStale(dir, ownerFile))) return null
      // Reclaim one lock left behind by a killed holder: its owner document and its
      // now empty directory, never anything else.
      await unlink(ownerFile).catch(() => {})
      if (!(await rmdir(dir).then(() => true, () => false))) return null
    }
  }
  return null
}

async function releaseMaintenanceLock(handle) {
  if (handle === null || handle === undefined) return
  const { dir, ownerFile, owner } = handle
  try {
    // A lock another process reclaimed belongs to that process now, and removing
    // its owner document would let a third one in while it works.
    const current = JSON.parse(await readFile(ownerFile, 'utf8'))
    if (current === null || typeof current !== 'object' || current.pid !== owner.pid || current.startedAt !== owner.startedAt) return
  } catch (error) {
    // A missing owner document leaves nothing of this handle to remove.
    return
  }
  await unlink(ownerFile).catch(() => {})
  await rmdir(dir).catch(() => {})
}

/**
 * Run fn while this process holds the maintenance lock of one root, and hand it the
 * lock handle so the step can pass it on instead of taking a second one. Returns
 * { acquired: true, value } when fn ran, or { acquired: false } when another process
 * owns the lock (or the root has none to take), in which case fn was never called:
 * a maintenance step that cannot prove it is alone must not delete or rewrite
 * anything. The migration and the archive command both go through here, so every
 * path that removes ledger files shares one lock and one release.
 */
async function withLedgerMaintenanceLock(root, fn) {
  const lock = await acquireMaintenanceLock(root)
  if (lock === null) return { acquired: false }
  try {
    return { acquired: true, value: await fn(lock) }
  } finally {
    await releaseMaintenanceLock(lock)
  }
}

// legacyFallbackRows carries the rows of a legacy whole-unit document that the
// trees have not received yet, so read-only maintenance can still answer for them.
// archive is the cold half of the ledger (lib/archive.js): its session ids join
// listKeys() and its rows answer a read the trees cannot, never the other way round.
function createLedgerUnitStore(legacyUnit, shardUnits, root = '', legacyFallbackRows = undefined, archive = null) {
  const shards = uniqueUnits(shardUnits)
  const allUnits = uniqueUnits([legacyUnit, ...shards])
  // Mutable on purpose: a live archive run removes the tree documents it just
  // filed, so the reader built at start stops answering for exactly those records.
  // attachArchive() swaps in the reader of the month files that run wrote.
  let archiveReader = archive
  // Every session key the trees hold, without parsing a single record: the
  // per-record layout is a directory of documents, so the filenames are the index
  // and a record is read later, on demand, with readRecord().
  async function listTreeKeys() {
    const keys = []
    const known = new Set()
    for (const unit of shards) {
      let dir = ''
      try {
        dir = unit.tableDir('sessions')
      } catch (err) {
        continue
      }
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name.startsWith('__')) continue
        const key = entry.name.slice(0, -'.json'.length)
        if (key === LEDGER_META_KEY || known.has(key)) continue
        known.add(key)
        keys.push(key)
      }
    }
    return keys
  }
  // One document, parsed the way the storage unit parses it when it loads. A tree
  // that does not answer for a record yet is the archive's business.
  async function readTreeRecord(key) {
    const unit = shardUnits[ledgerShardIndex(key)]
    if (unit === undefined) return undefined
    let path = ''
    try {
      path = join(unit.tableDir('sessions'), key + '.json')
    } catch (err) {
      return undefined
    }
    try {
      const doc = JSON.parse(await readFile(path, 'utf8'))
      if (doc !== null && typeof doc === 'object' && doc.version === 0 && doc.record !== undefined) return doc.record
    } catch (err) {
      // A missing or unreadable document is the archive's and the legacy
      // fallback's business.
    }
    return undefined
  }
  /**
   * Remove one tree document, which is what archiving does once a record's month
   * file, key index and the manifest are all on disk. Best effort by contract: a
   * document left behind is a duplicate the read path already prefers, never a
   * lost record.
   *
   * expected is the compact row that was archived. Runtime writes do not hold the
   * maintenance lock, so between planning a key and deleting it the session may
   * have published a newer revision; the document is then re-read and left alone
   * unless it still holds exactly that row, because deleting it would throw away
   * a revision nothing else has a copy of yet.
   */
  async function deleteTreeRecord(key, expected) {
    const unit = shardUnits[ledgerShardIndex(key)]
    if (unit === undefined) return false
    let path = ''
    try {
      path = join(unit.tableDir('sessions'), key + '.json')
    } catch (err) {
      return false
    }
    if (expected !== undefined) {
      if (expected === null || typeof expected !== 'object') return false
      const text = await readFile(path, 'utf8').catch(() => null)
      if (text === null) return false
      let doc = null
      try { doc = JSON.parse(text) } catch (err) { return false }
      if (doc === null || typeof doc !== 'object' || doc.record === null || typeof doc.record !== 'object') return false
      // updatedAt is the revision stamp; the serialized row is the belt and braces
      // that keeps a same-stamp rewrite in the tree too.
      if (doc.record.updatedAt !== expected.updatedAt) return false
      if (JSON.stringify(doc.record) !== JSON.stringify(expected)) return false
    }
    return unlink(path).then(() => true, () => false)
  }
  const store = {
    async loadAll() {
      const snapshots = await Promise.all(shards.map((unit) => unit.loadAll()))
      const rows = Object.create(null)
      for (const snapshot of snapshots) {
        for (const [key, value] of Object.entries(sessionRows(snapshot))) {
          if (key !== LEDGER_META_KEY) rows[key] = value
        }
      }
      return { global: {}, tables: { sessions: rows } }
    },
    /**
     * Every session key the shards hold, without parsing a single record: the
     * per-record layout is a directory of documents, so the filenames are the
     * index and a record is read later, on demand, with readRecord().
     */
    async listKeys() {
      const keys = await listTreeKeys()
      const known = new Set(keys)
      const remember = (key) => {
        if (key === LEDGER_META_KEY || known.has(key)) return
        known.add(key)
        keys.push(key)
      }
      // A legacy row that a concurrent migration has not copied into the trees
      // yet is still a record of this ledger.
      if (legacyFallbackRows !== undefined) for (const key of Object.keys(legacyFallbackRows)) remember(key)
      // Cold records are records of this ledger too, and their ids are what lets
      // recordFor() know that reading one is worth a month decompression.
      if (archiveReader !== null) for (const key of archiveReader.keys()) remember(key)
      return keys
    },
    /**
     * One document, parsed the way the storage unit parses it when it loads. A tree
     * that does not answer for a record yet falls back to the cold archive and then
     * to the legacy rows that read-only maintenance keeps in memory.
     */
    async readRecord(key) {
      // The tree is the newer copy whenever it holds one, so a record that is both
      // archived and still in its tree is read once, from the tree: a failed
      // archive run leaves duplicates that must not be counted twice.
      const tree = await readTreeRecord(key)
      if (tree !== undefined) return tree
      if (archiveReader !== null) {
        const archived = await archiveReader.readRecord(key).catch(() => undefined)
        if (archived !== undefined) return archived
      }
      if (legacyFallbackRows === undefined || !Object.hasOwn(legacyFallbackRows, key)) return undefined
      return legacyFallbackRows[key]
    },
    /** See deleteTreeRecord(): archiving is the only caller that removes documents. */
    deleteRecord: deleteTreeRecord,
    /**
     * Swap the cold reader, or drop it with null. A run that just deleted tree
     * documents must re-attach the reader of the month files it wrote, or every read
     * of a record it filed would answer 'missing' until the next DSH start.
     */
    attachArchive(reader) {
      archiveReader = reader === undefined ? null : reader
      return store
    },
    /**
     * The trees alone: no archive ids, no legacy rows. archiveRecords() must get this
     * view rather than the store, because the store answers from the month files it
     * is about to merge into - it would plan every already-archived record again and
     * count it a second time.
     */
    treeStore() {
      return { listKeys: listTreeKeys, readRecord: readTreeRecord, deleteRecord: deleteTreeRecord }
    },
    async hasMigrationMarker() {
      if (shardUnits[0] === undefined) return false
      return Object.hasOwn(sessionRows(await shardUnits[0].loadAll()), LEDGER_META_KEY)
    },
    async putRecord(table, key, value) {
      if (table !== 'sessions') throw new Error('usage ledger only supports the sessions table')
      const index = key === LEDGER_META_KEY ? 0 : ledgerShardIndex(key)
      const unit = shardUnits[index]
      if (unit === undefined) throw new Error('usage ledger shard is unavailable: ' + index)
      return unit.putRecord(table, key, value)
    },
    async close() {
      await Promise.all(allUnits.map((unit) => unit.close().catch(() => {})))
    },
    shardCount: LEDGER_SHARD_COUNT,
  }
  return store
}

// The archive is optional and never fatal: a root that cannot provide a readable
// archive simply opens as a tree-only ledger (lib/archive.js already treats a
// damaged month as missing), and the error is reported once at start.
async function openLedgerArchive(root) {
  try {
    return await createArchiveReader(root)
  } catch (error) {
    console.warn('[all-usage] usage ledger archive is unavailable:', error && error.message)
    return null
  }
}

async function openLedgerUnitStore(backend) {
  const shardUnits = []
  let legacyUnit
  try {
    for (let index = 0; index < LEDGER_SHARD_COUNT; index += 1) {
      // One file per session record: the single-file layout rewrote the whole
      // shard (a 4.9 MB average, 13.2 MB worst case, ~50-240 ms) for every
      // session update. The per-record layout publishes one document per write,
      // and it migrates itself from the same-named single-file unit on open.
      shardUnits.push(await backend.kv.open({ name: ledgerShardName(index), version: 0, tables: ['sessions'], hasGlobal: false, layout: 'per-record' }))
    }
    const root = typeof backend.root === 'string' ? backend.root : ''
    // Cold records live in <root>/archive. The reader is built only when that
    // directory holds a month file, so a ledger that never archives pays one failed
    // directory listing per start and reads nothing else.
    const archive = root === '' ? null : await openLedgerArchive(root)
    const shardStore = createLedgerUnitStore(undefined, shardUnits, root, undefined, archive)
    // A per-record unit exposes tableDir(), so its documents can be listed and read
    // one at a time. Older or fake units cannot, and there the whole table is read
    // once (and stays resident) exactly as it always was.
    const streaming = shardUnits.length > 0 && typeof shardUnits[0].tableDir === 'function'
    const shardRows = streaming ? Object.create(null) : sessionRows(await shardStore.loadAll())
    if (await shardStore.hasMigrationMarker()) {
      // The trees are the record now, so any leftover whole-unit file is dead
      // weight. This also runs on the fast path, because a previous start may
      // have seeded the trees and exited before retiring them.
      const retired = await retireLegacyLedgerFiles(backend, shardUnits).catch((error) => { console.error('[all-usage] usage ledger legacy retirement failed:', error && error.message); return [] })
      return { store: shardStore, rows: shardRows, retired, streaming }
    }

    // The first migration writes the marker and then retires the legacy files, so
    // the whole section is one critical section under the maintenance lock: a
    // second process must never delete a file this one is still reading. An empty
    // root has nothing to retire, so it keeps the unlocked behaviour.
    const readLegacyRows = async () => {
      // Read the legacy monolith only during the one-time migration. Once shard 00
      // carries the marker, startup never parses the old multi-megabyte file again.
      legacyUnit = await backend.kv.open({ name: LEDGER_UNIT_NAME, version: 0, tables: ['sessions'], hasGlobal: false })
      return sessionRows(await legacyUnit.loadAll())
    }
    const mergedRows = (legacyRows) => {
      const rows = Object.assign(Object.create(null), shardRows)
      for (const [key, value] of Object.entries(legacyRows)) {
        if (key === LEDGER_META_KEY || Object.hasOwn(rows, key)) continue
        rows[key] = value
      }
      return rows
    }
    const migrate = async (lock) => {
      const legacyRows = await readLegacyRows()
      const rows = mergedRows(legacyRows)
      const store = createLedgerUnitStore(legacyUnit, shardUnits, '', undefined, archive)
      // A row the tree already holds is the newer one (a previous migration may have
      // been interrupted after copying it), so only the missing rows are copied. A
      // streaming backend keeps its trees on disk, so there it copies every row
      // exactly as before.
      for (const [key, value] of Object.entries(legacyRows)) {
        if (key === LEDGER_META_KEY || Object.hasOwn(shardRows, key)) continue
        await store.putRecord('sessions', key, value)
      }
      await store.putRecord('sessions', LEDGER_META_KEY, { version: 1, migratedAt: Date.now() })
      // Those rows now live in the per-record trees (written above), so the legacy
      // document is retired. A failure here leaves the file in place and simply
      // tries again on the next start.
      const retired = await retireLegacyLedgerFiles(backend, shardUnits, lock).catch((error) => { console.error('[all-usage] usage ledger legacy retirement failed:', error && error.message); return [] })
      return { store, rows, retired, streaming: false }
    }
    if (root === '') return await migrate(undefined)
    const outcome = await withLedgerMaintenanceLock(root, migrate)
    if (outcome.acquired) return outcome.value
    // Another process owns the maintenance section: merge what it has not copied
    // into the trees yet (the trees win) and write nothing at all. The legacy
    // document stays where it is, and its rows stay readable through the store
    // until a start that holds the lock finishes the migration.
    const legacyRows = await readLegacyRows()
    return { store: createLedgerUnitStore(legacyUnit, shardUnits, root, legacyRows, archive), rows: mergedRows(legacyRows), retired: [], streaming }
  } catch (error) {
    await Promise.all(uniqueUnits([legacyUnit, ...shardUnits]).map((unit) => unit.close().catch(() => {})))
    throw error
  }
}

// Once a legacy whole-unit file has seeded its per-record tree, the file itself
// is dead weight: every record lives in the tree now, while the old document
// keeps a full copy (155.9 MB across the 32 shards plus a 22.4 MB monolith on
// this machine). DSH's storage layer never removes it, so the ledger retires it
// itself — only after the tree is non-empty, only for files it owns, never more
// than once per unit (a marker keeps a failed run from looping), and never
// without the maintenance lock: deleting a whole-unit file another process is
// still loading would lose the rows it has not copied yet.
async function retireLegacyLedgerFiles(backend, shardUnits, heldLock = undefined) {
  if (process.env.DSH_ALL_USAGE_KEEP_LEGACY === '1') return []
  const root = typeof backend.root === 'string' ? backend.root : ''
  if (root === '') return []
  const marker = join(root, LEDGER_UNIT_NAME + '.retired')
  if (await stat(marker).then(() => true, () => false)) return []
  // The migration already holds the lock and hands its handle over, so one
  // critical section covers the copy and the retirement.
  const lock = heldLock === undefined ? await acquireMaintenanceLock(root) : heldLock
  if (lock === null) return []
  try {
    return await collectLegacyRetirement(root, shardUnits, marker)
  } finally {
    if (heldLock === undefined) await releaseMaintenanceLock(lock)
  }
}

// The retirement proper, only ever entered while holding the maintenance lock.
async function collectLegacyRetirement(root, shardUnits, marker) {
  const retired = []
  const candidates = []
  for (let index = 0; index < LEDGER_SHARD_COUNT; index += 1) {
    const name = ledgerShardName(index)
    if (shardUnits[index] === undefined || shardUnits[index] === null) continue
    // The medium tells the truth: a shard has been migrated when its per-record
    // tree holds documents.
    const count = await readdir(join(root, name, 'sessions')).then((entries) => entries.filter((entry) => entry.endsWith('.json')).length, () => 0)
    candidates.push({ name, count })
  }
  for (const candidate of candidates) {
    if (candidate.count === 0) continue
    const file = join(root, candidate.name + '.json')
    const size = await stat(file).then((info) => info.size, () => null)
    if (size === null) continue
    const removed = await unlink(file).then(() => size, (error) => { console.error('[all-usage] usage ledger legacy file could not be retired:', file, error && error.message); return null })
    if (removed !== null) retired.push({ name: candidate.name + '.json', bytes: removed })
  }
  const monolith = join(root, LEDGER_UNIT_NAME + '.json')
  const monolithSize = await stat(monolith).then((info) => info.size, () => null)
  if (monolithSize !== null && candidates.some((candidate) => candidate.count > 0)) {
    const removed = await unlink(monolith).then(() => monolithSize, () => null)
    if (removed !== null) retired.push({ name: LEDGER_UNIT_NAME + '.json', bytes: removed })
  }
  if (retired.length > 0) await writeFile(marker, JSON.stringify({ retiredAt: Date.now(), files: retired.length }), 'utf8').catch(() => {})
  return retired
}

const IDENTITY_REF_FIELD = 'identityRef'

// The same route is used for thousands of requests, yet a ledger row used to
// repeat its identity object (key, provider, requested/actual model, label) on
// every usage item — 14.5 MB of the current 91 MB of records. Rows are written
// with one shared identity list and per-item indexes instead, and read back into
// the same shape as before, so nothing outside this file changes. Rows whose
// workspace differs from the record's keep their own workspaceId, and a row with
// no identity at all still normalizes through its modelId.
function serializeLedgerRecord(record) {
  if (record === null || typeof record !== 'object' || !Array.isArray(record.usage)) return record
  const identities = []
  const identityIndex = new Map()
  const usage = record.usage.map((item) => {
    if (item === null || typeof item !== 'object') return item
    const identity = item.identity
    if (identity === undefined || identity === null) return item
    const identityKey = JSON.stringify(identity)
    let index = identityIndex.get(identityKey)
    if (index === undefined) { index = identities.length; identities.push(identity); identityIndex.set(identityKey, index) }
    // workspaceId stays on every item: it is what tells a mixed-workspace row
    // apart, and a record retargeted to another workspace must not re-home its
    // history.
    const next = { ...item, [IDENTITY_REF_FIELD]: index }
    delete next.identity
    delete next.modelId
    return next
  })
  if (identities.length === 0) return { ...record, usage }
  return { ...record, usageIdentities: identities, usage }
}

function expandLedgerRecord(raw) {
  if (raw === null || typeof raw !== 'object' || !Array.isArray(raw.usage) || !Array.isArray(raw.usageIdentities)) return raw
  const identities = raw.usageIdentities
  const usage = raw.usage.map((item) => {
    if (item === null || typeof item !== 'object' || !Number.isInteger(item[IDENTITY_REF_FIELD])) return item
    const identity = identities[item[IDENTITY_REF_FIELD]]
    const next = { ...item, identity, modelId: identity === undefined || identity === null ? item.modelId : identity.label }
    delete next[IDENTITY_REF_FIELD]
    return next
  })
  const expanded = { ...raw, usage }
  delete expanded.usageIdentities
  return expanded
}

export function createLedger(host) {
  const { state, markStatsChanged } = host
  const { storage } = host.services
  state.ledgerPending = state.ledgerPending || new Map()
  state.ledgerReading = state.ledgerReading || new Map()
  state.ledgerWriting = state.ledgerWriting || new Set()
  state.ledgerWriteWaiters = state.ledgerWriteWaiters || new Map()
  state.ledgerWriteRunning = state.ledgerWriteRunning === true
  state.ledgerWriteScheduled = state.ledgerWriteScheduled === true
  state.ledgerWriteTimer = state.ledgerWriteTimer || null
  state.ledgerWriteFailedSessions = state.ledgerWriteFailedSessions || new Set()
  const {
    addTurn,
    coerceIdentity,
    identityFromLegacy,
    identityFromMessage,
    identityFromRoute,
    makeIdentity,
    costForUsage,
    resolveCurrentPricing,
    dateKeys,
    validEventTime,
    upsertUsageSample,
    usageRowOf,
    foldUsageRow,
    adoptUsageRow,
    sessionsForRange,
  } = host.aggregation
  const lastSeqOf = (...args) => host.sessionSync.lastSeqOf(...args)
  function isLegacyTieredCost(cost) {
    const selectedTier = cost && cost.selectedTier
    const hasSelectedTier = selectedTier && selectedTier.type === 'context' && Number.isSafeInteger(selectedTier.size) && selectedTier.size >= 0
    return cost !== null && cost.tiered === true && cost.status === 'priced' && !hasSelectedTier
  }

  function nextLedgerRevision() {
    const current = Number.isFinite(state.ledgerRevision) ? state.ledgerRevision : 0
    state.ledgerRevision = Math.max(current + 1, Date.now())
    return state.ledgerRevision
  }
  function ledgerEventKey(event, index) {
    // Only finite safe-integer sequences are canonical event ids; anything else
    // falls back to the positional index so two invalid events cannot overwrite
    // each other in the ledger.
    return Number.isSafeInteger(event.seq) && event.seq >= 0 ? String(event.seq) : 'event:' + index
  }
  function canFoldLedgerTail(previousRecord, events, workspaceId) {
    if (previousRecord === null || previousRecord === undefined || previousRecord.needsUpgrade === true || previousRecord.rebuildRequired !== undefined || !Number.isSafeInteger(previousRecord.lastSeq) || previousRecord.lastSeq < 0 || !Array.isArray(events) || events.length === 0) return false
    // A changed workspace identity (deleted and re-added workspace gets a new id)
    // assigns every historical event to a different bucket, so the previous
    // record can never be reused as a tail seed for the new workspace.
    if (workspaceId !== undefined && previousRecord.workspaceId !== undefined && previousRecord.workspaceId !== workspaceId) return false
    const startIndex = previousRecord.lastSeq + 1
    if (startIndex >= events.length || events[startIndex] === null || typeof events[startIndex] !== 'object' || events[startIndex].seq !== startIndex) return false
    const previousTurns = new Set(Array.isArray(previousRecord.turns) ? previousRecord.turns.map((turn) => turn && turn.turn).filter((turn) => Number.isSafeInteger(turn)) : [])
    for (let index = startIndex, expectedSeq = startIndex; index < events.length; index += 1, expectedSeq += 1) {
      const event = events[index]
      if (event === null || typeof event !== 'object' || event.seq !== expectedSeq) return false
      if (event.type === 'turn/end' && event.data && Number.isSafeInteger(event.data.turn) && previousTurns.has(event.data.turn)) return false
    }
    return true
  }
function buildLedgerRecord(session, workspaceId, source = 'scan', revision, previousRecord, sequenceClean = true) {
    const sid = session && typeof session.id === 'string' ? session.id : ''
    const events = sessionEvents(session)
    if (sid === '' || workspaceId === undefined) return null
    // DSH sequences every persisted event with seq === log index, so the last
    // event's seq is the record's lastSeq in O(1); fall back to a full scan only
    // when the tail carries no seq (legacy or truncated logs).
    const tailEvent = events.length > 0 ? events[events.length - 1] : null
    const lastSeq = tailEvent !== null && Number.isSafeInteger(tailEvent.seq) && tailEvent.seq >= 0 ? tailEvent.seq : lastSeqOf(events)
    // A changed incremental log that contains invalid sequences anywhere must
    // be rebuilt wholesale: the fold check only validates the tail, so a bad
    // event before the fold start would otherwise be skipped in memory while
    // the persisted record still contains everything.
    const canFoldTail = sequenceClean === true && canFoldLedgerTail(previousRecord, events, workspaceId)
    const turns = canFoldTail ? new Map((previousRecord.turns || []).map((item) => [item.key, { ...item }])) : new Map()
    const usage = canFoldTail ? new Map((previousRecord.usage || []).map((item) => [item.key, { ...item }])) : new Map()
    const previousUsage = new Map(Array.isArray(previousRecord && previousRecord.usage) ? previousRecord.usage.map((item) => [item.key, item]) : [])
    let currentIdentity = canFoldTail ? coerceIdentity(previousRecord.lastIdentity) : makeIdentity(null, null, null, null)
    // Request-context instants are kept per turn/step so parallel requests each
    // carry their own billing time while scanning the persisted log.  When the
    // tail is folded onto a persisted record, the previous context archive seeds
    // the map so an open request whose context arrived in the previous batch
    // still bills its usage with the matching request instant after a restart.
    const contextTimes = canFoldTail ? new Map(Array.isArray(previousRecord.contextTimes) ? previousRecord.contextTimes.map((entry) => [entry.key, entry.time]) : []) : new Map()
    const startIndex = canFoldTail ? previousRecord.lastSeq + 1 : 0
    for (let index = startIndex; index < events.length; index += 1) {
      const event = events[index]
      if (event === null || typeof event !== 'object') continue
      if (canFoldTail && event.seq <= previousRecord.lastSeq) continue
      const data = event.data
      if (event.type === 'request/context') {
        currentIdentity = identityFromRoute(data, currentIdentity)
        if (validEventTime(event.time)) touchContextTimes(contextTimes, contextTimeKey(data && data.turn, data && data.step), event.time)
        continue
      }
      if (event.type === 'request/header') {
        currentIdentity = identityFromRoute(data, currentIdentity)
        continue
      }
      if (event.type === 'turn/end') {
        if (!validEventTime(event.time)) continue
        const key = ledgerEventKey(event, index)
        const turn = data && typeof data.turn === 'number' ? data.turn : null
        turns.set(key, { key, seq: validLedgerSeq(event.seq) ? event.seq : -1, time: event.time, workspaceId, turn, identity: currentIdentity })
        continue
      }
      if (!validEventTime(event.time)) continue
      const usageEvent = extractUsageEvent(event)
      if (usageEvent === null) continue
      const identity = usageEvent.kind === 'message' ? identityFromMessage(data, currentIdentity) : currentIdentity
      const key = usageStepKey(sid, data, event.seq)
      const pricing = pickPricingTime(contextTimes, event.time, usageEvent.turn, usageEvent.step)
      const result = upsertUsageSample(usage, {
        key,
        seq: validLedgerSeq(event.seq) ? event.seq : -1,
        time: event.time,
        workspaceId,
        identity,
        modelId: identity.label,
        turn: usageEvent.turn,
        step: usageEvent.step,
        values: usageEvent.values,
        pricingAt: pricing.time,
        pricingTimeSource: pricing.source,
      }, { costPrevious: previousUsage.get(key) })
      if (result.accepted && usageEvent.kind === 'message') currentIdentity = identity
    }
    const sourceCwd = session && session.header && typeof session.header.cwd === 'string' ? session.header.cwd : undefined
    return { version: LEDGER_VERSION, sessionId: sid, workspaceId, ...(sourceCwd === undefined ? {} : { sourceCwd }), lastSeq, source, updatedAt: nextLedgerRevision(), lastRevision: typeof revision === 'string' ? revision : undefined, sourceRevision: typeof revision === 'string' ? revision : undefined, lastIdentity: currentIdentity, contextTimes: Array.from(contextTimes.entries()).map(([key, time]) => ({ key, time })), turns: Array.from(turns.values()), usage: Array.from(usage.values()) }
  }
  function normalizeLedgerRecord(input, key) {
    // Rows written with a shared identity list are expanded first: every check
    // below then sees exactly the same item shape it always did.
    const raw = expandLedgerRecord(input)
    if (raw === null || typeof raw !== 'object' || (raw.version !== LEDGER_VERSION && raw.version !== PREVIOUS_LEDGER_VERSION && raw.version !== LEGACY_LEDGER_VERSION) || typeof raw.sessionId !== 'string' || raw.sessionId !== key) return null
    if (!Array.isArray(raw.turns) || !Array.isArray(raw.usage)) return null
    // One pass per list: validity, workspace mixing and the map share it, and a
    // usage row normalizes its cost snapshot once instead of once per question
    // (that call parses eleven decimal fields).
    let invalidTurn = false
    let invalidUsage = false
    let mixedWorkspace = false
    const turnMap = new Map()
    for (const turn of raw.turns) {
      if (turn === null || typeof turn !== 'object' || typeof turn.key !== 'string' || turn.workspaceId === undefined || !validEventTime(turn.time) || pollutedLedgerKey(turn.key) || (turn.seq !== undefined && !validLedgerSeq(turn.seq))) invalidTurn = true
      if (turn && turn.workspaceId !== raw.workspaceId) mixedWorkspace = true
      if (turn && typeof turn.key === 'string' && turn.workspaceId !== undefined && validEventTime(turn.time)) turnMap.set(turn.key, { key: turn.key, seq: Number.isSafeInteger(turn.seq) ? turn.seq : -1, time: turn.time, workspaceId: turn.workspaceId, turn: typeof turn.turn === 'number' ? turn.turn : null, identity: coerceIdentity(turn.identity || turn.modelId) })
    }
    const usageMap = new Map()
    for (const item of raw.usage) {
      const normalizedCost = normalizeCostSnapshot(item === null || item === undefined ? null : item.cost)
      if (item === null || typeof item !== 'object' || !validEventTime(item.time) || item.identity === undefined || pollutedLedgerKey(item.key) || (item.seq !== undefined && !validLedgerSeq(item.seq)) || normalizedCost === null || normalizedCost.pricingMode !== 'official-model' || isLegacyTieredCost(normalizedCost)) invalidUsage = true
      // Older versions could write a record whose top-level workspaceId belonged
      // to a recreated workspace while its historical items kept the previous one;
      // such mixed records must never be reused as a fast path.
      if (item && item.workspaceId !== raw.workspaceId) mixedWorkspace = true
      if (!item || typeof item.key !== 'string' || item.workspaceId === undefined || !validEventTime(item.time) || item.values === null || typeof item.values !== 'object') continue
      const identity = coerceIdentity(item.identity || item.modelId)
      const normalized = { key: item.key, seq: Number.isSafeInteger(item.seq) ? item.seq : -1, time: item.time, workspaceId: item.workspaceId, identity, modelId: identity.label, ...(normalizedCost === null ? {} : { cost: normalizedCost }), turn: typeof item.turn === 'number' ? item.turn : null, step: typeof item.step === 'number' ? item.step : null, values: usageValues({ inputTokens: item.values.input, outputTokens: item.values.output, cacheReadTokens: item.values.cacheRead, cacheWriteTokens: item.values.cacheWrite, reasoningTokens: item.values.reasoning }) }
      upsertUsageSampleState(usageMap, normalized)
    }
    // The rebuild reason is persisted (enumerable) so the flag survives a
    // failure-and-restart cycle even when normalized content alone no longer
    // carries the evidence (e.g. lastSeq -1 after an invalid non-safe value).
    const persistedReason = typeof raw.rebuildRequired === 'string' && raw.rebuildRequired !== '' ? raw.rebuildRequired : undefined
    const computedReason = invalidTurn ? 'invalid-turn' : invalidUsage ? 'invalid-usage' : mixedWorkspace ? 'mixed-workspace' : (raw.lastSeq !== undefined && !validLedgerSeq(raw.lastSeq)) ? 'invalid-last-seq' : raw.version !== LEDGER_VERSION ? 'legacy-version' : !Number.isFinite(raw.updatedAt) ? 'invalid-updated-at' : undefined
    const rebuildReason = persistedReason !== undefined ? persistedReason : computedReason
    const needsUpgrade = rebuildReason !== undefined || !Number.isFinite(raw.updatedAt) || raw.version !== LEDGER_VERSION
    const updatedAt = Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0
    state.ledgerRevision = Math.max(Number.isFinite(state.ledgerRevision) ? state.ledgerRevision : 0, updatedAt)
    const contextMap = new Map()
    if (Array.isArray(raw.contextTimes)) {
      for (const entry of raw.contextTimes) {
        if (entry === null || typeof entry !== 'object' || typeof entry.key !== 'string' || !entry.key.startsWith('context:') || entry.key.length > 128 || !validEventTime(entry.time)) continue
        touchContextTimes(contextMap, entry.key, entry.time)
      }
    }
    const lastUsage = Array.from(usageMap.values()).at(-1)
    const lastIdentity = coerceIdentity(raw.lastIdentity || raw.sourceRevisionIdentity || (lastUsage && lastUsage.identity))
    const sourceCwd = typeof raw.sourceCwd === 'string' && raw.sourceCwd.trim() !== '' ? raw.sourceCwd : undefined
    const normalizedRecord = { version: LEDGER_VERSION, sessionId: raw.sessionId, workspaceId: raw.workspaceId, ...(sourceCwd === undefined ? {} : { sourceCwd }), lastSeq: validLedgerSeq(raw.lastSeq) ? raw.lastSeq : -1, source: raw.source === 'flush' ? 'flush' : 'scan', updatedAt, lastRevision: typeof raw.lastRevision === 'string' ? raw.lastRevision : (typeof raw.sourceRevision === 'string' ? raw.sourceRevision : undefined), sourceRevision: typeof raw.sourceRevision === 'string' ? raw.sourceRevision : (typeof raw.lastRevision === 'string' ? raw.lastRevision : undefined), lastIdentity, contextTimes: Array.from(contextMap.entries()).map(([key, time]) => ({ key, time })), turns: Array.from(turnMap.values()), usage: Array.from(usageMap.values()) }
    if (rebuildReason !== undefined) normalizedRecord.rebuildRequired = rebuildReason
    Object.defineProperty(normalizedRecord, 'needsUpgrade', { value: needsUpgrade, enumerable: false, writable: true })
    return normalizedRecord
  }
  function prepareLedgerRecord(record) {
    if (record === null || record === undefined) return record
    // A current record was normalized on the way in, so every item already carries
    // a canonical cost snapshot: re-parsing each one (eleven decimal fields apiece)
    // would be a pass over the whole record that changes nothing.
    if (record.needsUpgrade !== true && record.version === LEDGER_VERSION) return record
    let changed = true
    for (const item of record.usage) {
      const cost = normalizeCostSnapshot(item.cost)
      if (isLegacyTieredCost(cost)) {
        item.cost = calculateCost(item.values, { ...cost, status: 'unsupported', reason: 'tiered-pricing-not-modeled' })
        changed = true
        continue
      }
      if (cost !== null && cost.pricingMode === 'official-model') { item.cost = cost; continue }
      const identity = item.identity || identityFromLegacy(item.modelId)
      const billing = billingInstantOf(item, cost)
      item.cost = calculateCost(item.values, resolveCurrentPricing(identity), billing.at, billing.source)
      changed = true
    }
    if (changed) {
      // Repacking costs must never clear the rebuild flag: only a complete
      // rebuild from the source log produces a record that is safe to reuse.
      record.version = LEDGER_VERSION
      record.updatedAt = nextLedgerRevision()
      cacheLedgerRecord(record)
      rememberLedgerKey(record.sessionId)
      void persistLedgerRecord(record)
    }
    return record
  }
  function applyLedgerRecord(record, materialization = 'ledger-reuse') {
    if (record === null || record === undefined) return
    prepareLedgerRecord(record)
    if (record.lastIdentity !== undefined) state.sessionModel.set(record.sessionId, record.lastIdentity)
    if (Array.isArray(record.contextTimes)) {
      const times = new Map()
      for (const entry of record.contextTimes) if (entry && typeof entry.key === 'string' && Number.isFinite(entry.time)) times.set(entry.key, entry.time)
      state.sessionContextTimes.set(record.sessionId, times)
    }
    for (const turn of record.turns) addTurn(turn.workspaceId, turn.time, record.sessionId, turn.turn, turn.identity, materialization, turn.seq)
    for (const item of record.usage) {
      foldUsageRow(usageRowOf(record, item, materialization), materialization)
    }
    if (record.turns.length > 0 || record.usage.length > 0) {
      state.sessionCount.add(record.sessionId)
      if (record.usage.length > 0) markStatsChanged('scan')
    }
  }
  function ledgerRank(record) {
    return [Number.isFinite(record.lastSeq) ? record.lastSeq : -1, record.source === 'flush' ? 1 : 0, Number.isFinite(record.updatedAt) ? record.updatedAt : 0]
  }
  function replaceLedgerRecord(record) {
    assertLedgerRecord(record)
    cacheLedgerRecord(record)
    rememberLedgerKey(record.sessionId)
    return record
  }
  function assertLedgerRecord(record) {
    if (record === null || typeof record !== 'object' || !Number.isFinite(record.updatedAt)) throw new TypeError('usage ledger updatedAt must be a finite number')
    return record
  }
  function storeLedgerRecord(record) {
    assertLedgerRecord(record)
    const current = state.ledgerRecords.get(record.sessionId)
    if (current !== undefined) {
      const nextRank = ledgerRank(record)
      const currentRank = ledgerRank(current)
      if (nextRank[0] < currentRank[0] || (nextRank[0] === currentRank[0] && (nextRank[1] < currentRank[1] || (nextRank[1] === currentRank[1] && nextRank[2] <= currentRank[2])))) return current
    }
    cacheLedgerRecord(record)
    rememberLedgerKey(record.sessionId)
    return record
  }
  function resolveLedgerWaiters(sid) {
    const waiters = state.ledgerWriteWaiters.get(sid)
    if (waiters === undefined) return
    state.ledgerWriteWaiters.delete(sid)
    for (const resolve of waiters) resolve()
  }
  async function drainPendingLedgerWrites() {
    while (state.ledgerPending.size > 0) {
      const entry = state.ledgerPending.entries().next().value
      if (entry === undefined) break
      const [sid, record] = entry
      state.ledgerPending.delete(sid)
      const resident = state.ledgerRecords.get(sid)
      if (state.ledgerUnit === null || (resident !== record && resident?.__durableRecord !== record)) {
        if (!state.ledgerPending.has(sid)) resolveLedgerWaiters(sid)
        continue
      }
      // Pending ends before I/O begins. Keep this session resident until the
      // write settles, so a cold read cannot restore the older durable record.
      state.ledgerWriting.add(sid)
      try {
        // The medium receives the compact row; everything in memory keeps the record.
        await state.ledgerUnit.putRecord('sessions', sid, serializeLedgerRecord(record))
        state.ledgerWriteFailedSessions.delete(sid)
      } catch (err) {
        state.ledgerWriteFailedSessions = state.ledgerWriteFailedSessions || new Set()
        state.ledgerWriteFailedSessions.add(sid)
        state.ledgerDirtySessions = state.ledgerDirtySessions || new Set()
        state.ledgerDirtyEpochs = state.ledgerDirtyEpochs || new Map()
        state.ledgerDirtySessions.add(sid)
        state.ledgerDirtyEpochs.set(sid, (state.ledgerDirtyEpochs.get(sid) || 0) + 1)
        console.error('[all-usage] usage ledger write failed:', err)
      } finally {
        state.ledgerWriting.delete(sid)
      }
      if (!state.ledgerPending.has(sid)) resolveLedgerWaiters(sid)
    }
  }
  function startLedgerWrite() {
    if (state.ledgerWriteRunning || state.ledgerPending.size === 0 || state.ledgerUnit === null) return
    state.ledgerWriteRunning = true
    const write = state.ledgerWriteChain.then(() => drainPendingLedgerWrites(), () => drainPendingLedgerWrites())
    state.ledgerWriteChain = write.catch((err) => {
      console.error('[all-usage] usage ledger queue failed:', err)
    }).finally(() => {
      state.ledgerWriteRunning = false
      if (state.ledgerPending.size > 0 && state.ledgerUnit !== null) scheduleLedgerWrite()
    })
  }
  function scheduleLedgerWrite() {
    if (state.ledgerWriteScheduled || state.ledgerWriteRunning || state.ledgerPending.size === 0 || state.ledgerUnit === null) return
    state.ledgerWriteScheduled = true
    const run = () => {
      state.ledgerWriteScheduled = false
      state.ledgerWriteTimer = null
      startLedgerWrite()
    }
    state.ledgerWriteTimer = setTimeout(run, LEDGER_WRITE_DEBOUNCE_MS)
    // Keep a reference while write waiters are pending: the debounce timer is
    // what eventually resolves persistLedgerRecord promises, and an unreferenced
    // timer lets the event loop (and test runs) settle before the write happens.
    if (state.ledgerWriteTimer && typeof state.ledgerWriteTimer.unref === 'function' && state.ledgerWriteWaiters.size === 0) state.ledgerWriteTimer.unref()
  }
  function persistLedgerRecord(record) {
    if (record !== null && record !== undefined) assertLedgerRecord(record)
    if (record === null || record === undefined || state.disposed || state.ledgerUnit === null) return Promise.resolve()
    const resident = state.ledgerRecords.get(record.sessionId)
    if (resident !== record && resident?.__durableRecord !== record) return Promise.resolve()
    const waiter = new Promise((resolve) => {
      const waiters = state.ledgerWriteWaiters.get(record.sessionId) || []
      waiters.push(resolve)
      state.ledgerWriteWaiters.set(record.sessionId, waiters)
    })
    state.ledgerPending.set(record.sessionId, record)
    scheduleLedgerWrite()
    return waiter
  }
  async function drainLedgerWrites() {
    if (state.ledgerWriteTimer !== null) {
      clearTimeout(state.ledgerWriteTimer)
      state.ledgerWriteTimer = null
    }
    state.ledgerWriteScheduled = false
    if (state.ledgerPending.size > 0 && !state.ledgerWriteRunning && state.ledgerUnit !== null) startLedgerWrite()
    await state.ledgerWriteChain
    if (state.ledgerPending.size > 0 && !state.ledgerWriteRunning && state.ledgerUnit !== null) {
      startLedgerWrite()
      await state.ledgerWriteChain
    }
    for (const sid of Array.from(state.ledgerWriteWaiters.keys())) {
      if (!state.ledgerPending.has(sid)) resolveLedgerWaiters(sid)
    }
  }
  /**
   * Cold-archive the ledger from the running host: fold every record older than
   * days days into <root>/archive/<YYYY-MM>.jsonl.gz, and only then remove the tree
   * documents that are durable there. The panel asks for the plan first (dryRun)
   * and only a second, explicit request writes. Either way the run is one
   * maintenance step behind the same lock the CLI and the migration take, so two
   * processes never archive the same root at once.
   *
   * Returns { ok: true, months, archived, bytes, compressed, dryRun, errors }, or
   * { ok: false, message } with message no-root | ledger-unavailable | busy |
   * archive-failed.
   */
  async function archiveLedger({ days = 90, dryRun = true } = {}) {
    try {
      const backend = storage === undefined || storage === null || storage.backend === undefined || storage.backend === null ? undefined : storage.backend.get('json')
      const root = backend !== undefined && backend !== null && typeof backend.root === 'string' ? backend.root : ''
      if (root === '') return { ok: false, message: 'no-root' }
      // A record still queued for its tree would be planned from the revision before
      // the last write; the plan reads the documents the delete will remove.
      await drainLedgerWrites()
      const unit = state.ledgerUnit
      if (unit === null || unit === undefined || typeof unit.treeStore !== 'function') return { ok: false, message: 'ledger-unavailable' }
      const cutoffMs = Date.now() - days * 86400000
      // treeStore(), never the unit itself: the unit answers from the archive, so a
      // second run would plan the records the first one filed all over again.
      const outcome = await withLedgerMaintenanceLock(root, () => archiveRecords({ root, store: unit.treeStore(), cutoffMs, dryRun: dryRun === true }))
      if (!outcome.acquired) return { ok: false, message: 'busy' }
      if (dryRun !== true) {
        // The month files are on disk and their tree documents are gone: the reader
        // this process opened at start knows neither. attachArchive() answers for
        // those records now instead of after the next DSH start.
        const reader = await openLedgerArchive(root)
        unit.attachArchive(reader)
        if (reader === null) console.warn('[all-usage] usage ledger archive holds no readable month; the records it removed read back after the next start')
      }
      return { ok: true, ...outcome.value }
    } catch (error) {
      return { ok: false, message: 'archive-failed', error: String(error && error.message ? error.message : error) }
    }
  }
  function recordCacheLimit() {
    const megabytes = Number(process.env.DSH_ALL_USAGE_RECORD_CACHE_MB)
    return Number.isFinite(megabytes) && megabytes >= 0 ? megabytes * 1024 * 1024 : 16 * 1024 * 1024
  }
  // Rough but allocation-free: the usage rows dominate a record's footprint, and
  // the cap only has to be in the right ballpark.
  function recordSizeOf(record) {
    const usage = Array.isArray(record.usage) ? record.usage.length : 0
    const turns = Array.isArray(record.turns) ? record.turns.length : 0
    return 1024 + usage * 1024 + turns * 256
  }
  function rememberLedgerKey(sid) {
    if (typeof sid === 'string' && sid !== '' && state.ledgerKeys instanceof Set) state.ledgerKeys.add(sid)
  }
  /**
   * Put a record into the resident set, evicting the oldest clean ones when the
   * cache is over budget. A dirty session (unwritten changes, a pending write or a
   * live resync) is never evicted: its in-memory copy is the pending write.
   */
  function cacheLedgerRecord(record) {
    if (record === null || record === undefined || typeof record.sessionId !== 'string') return
    const sid = record.sessionId
    if (state.ledgerRecords.has(sid)) {
      state.ledgerRecordBytes = Math.max(0, (state.ledgerRecordBytes || 0) - (state.ledgerRecordSizes.get(sid) || 0))
      state.ledgerRecords.delete(sid)
    }
    const size = recordSizeOf(record)
    state.ledgerRecords.set(sid, record)
    if (!(state.ledgerRecordSizes instanceof Map)) state.ledgerRecordSizes = new Map()
    state.ledgerRecordSizes.set(sid, size)
    state.ledgerRecordBytes = (state.ledgerRecordBytes || 0) + size
    // A store that cannot read one record back has to keep them all.
    if (state.ledgerRecordsComplete === true) return
    const limit = recordCacheLimit()
    while ((state.ledgerRecordBytes || 0) > limit && state.ledgerRecords.size > 1) {
      const oldest = state.ledgerRecords.keys().next()
      if (oldest.done) break
      const candidate = oldest.value
      if (candidate === sid) break
      const protectedDirty = state.ledgerDirtySessions instanceof Set && state.ledgerDirtySessions.has(candidate)
      const protectedPending = state.ledgerPending instanceof Map && state.ledgerPending.has(candidate)
      const protectedWrite = state.ledgerWriting.has(candidate)
      const protectedResync = state.liveResyncPending instanceof Set && state.liveResyncPending.has(candidate)
      const protectedPrefetch = state.ledgerPrefetching instanceof Set && state.ledgerPrefetching.has(candidate)
      const protectedRead = (state.ledgerReading.get(candidate) || 0) > 0
      if (protectedDirty || protectedPending || protectedWrite || protectedResync || protectedPrefetch || protectedRead) {
        // Rotate the protected entry to the back and stop: the resident set is
        // dominated by sessions that are still being written.
        const keep = state.ledgerRecords.get(candidate)
        state.ledgerRecords.delete(candidate)
        state.ledgerRecords.set(candidate, keep)
        break
      }
      state.ledgerRecords.delete(candidate)
      state.ledgerRecordBytes = Math.max(0, (state.ledgerRecordBytes || 0) - (state.ledgerRecordSizes.get(candidate) || 0))
      state.ledgerRecordSizes.delete(candidate)
    }
  }
  /**
   * Read a window of session documents, a few files at a time. One file per read is
   * what keeps memory flat, but doing that strictly one-at-a-time serialises the
   * I/O behind the folding; a small parallel window restores the overlap while the
   * resident set stays bounded (a record is dropped again once it is folded).
   */
  async function loadRecords(sids, concurrency = 16) {
    if (state.ledgerUnit === null || typeof state.ledgerUnit.readRecord !== 'function') return
    if (!(state.ledgerKeys instanceof Set)) return
    const queue = []
    for (const sid of sids) {
      if (typeof sid !== 'string' || sid === '') continue
      if (state.ledgerRecords.has(sid) || !state.ledgerKeys.has(sid)) continue
      queue.push(sid)
    }
    if (!(state.ledgerPrefetching instanceof Set)) state.ledgerPrefetching = new Set()
    const width = Number.isFinite(concurrency) && concurrency > 0 ? Math.floor(concurrency) : 8
    for (let index = 0; index < queue.length; index += width) {
      const batch = queue.slice(index, index + width)
      await Promise.all(batch.map((sid) => {
        state.ledgerPrefetching.add(sid)
        return recordFor(sid).catch(() => undefined).finally(() => state.ledgerPrefetching.delete(sid))
      }))
    }
  }
  /**
   * Read back the detail rows of every session that has usage in a date range, so a
   * query over old history sees them without the rows having to stay resident. The
   * rows are adopted, not folded: the cubes already hold their contribution.
   */
  /** A row read back from a record that no longer belongs to a live workspace is
   * attributed to the shared retired bucket, exactly like the scan does. */
  function adoptableRow(row) {
    const published = typeof row.wsId === 'string' && row.wsId !== '' && state.wsMeta instanceof Map && state.wsMeta.has(row.wsId)
    const digest = state.perSession?.get(row.sid)
    const keyMeta = digest && digest.keys instanceof Map ? digest.keys.get(row.key) : undefined
    const keyWorkspace = keyMeta && typeof keyMeta.wsId === 'string' && keyMeta.wsId !== '' ? keyMeta.wsId : undefined
    if (keyWorkspace !== undefined) {
      const keyWorkspacePublished = keyWorkspace === RETIRED_WORKSPACE_ID || (state.wsMeta instanceof Map && state.wsMeta.has(keyWorkspace))
      if (keyWorkspace !== row.wsId && keyWorkspacePublished) return { ...row, wsId: keyWorkspace, ...(keyWorkspace === RETIRED_WORKSPACE_ID ? { retiredAtRead: true } : {}) }
      if (keyWorkspace === row.wsId && keyWorkspacePublished) return row
    }
    // Legacy digests do not carry workspace ownership per key. Preserve the prior
    // all-session fallback only for those; mixed digests are ambiguous by design.
    const moved = keyWorkspace === undefined && published && state.retiringWorkspaceIds?.has(row.wsId) && digest !== undefined && digest.buckets.size > 0 && Array.from(digest.buckets.values()).every(bucket => bucket.wsId === RETIRED_WORKSPACE_ID)
    return (published && !moved) || row.wsId === RETIRED_WORKSPACE_ID ? row : { ...row, wsId: RETIRED_WORKSPACE_ID, retiredAtRead: true }
  }
  /** Read back every detail row of one session (used before a retarget walks them). */
  async function loadRowsForSession(sid) {
    const record = await recordFor(sid)
    if (record === undefined || record === null || !Array.isArray(record.usage)) return 0
    let adopted = 0
    for (const item of record.usage) if (adoptUsageRow(adoptableRow(usageRowOf(record, item, 'ledger-reuse')))) adopted += 1
    return adopted
  }
  // An authoritative usage array owns this lookup weakly. Values contain only
  // bounded locators and numeric positions, never a row/array/cost reference.
  // Replacement and LRU eviction can therefore release the old payloads.
  const usagePageIndices = new WeakMap()
  function storedRowsForPage(record, selected) {
    const requests = [
      ...Array.from(selected.keys, ([key, positions]) => ({ key, positions, lookup: recordKeyLocator(record.sessionId, key) })),
      ...Array.from(selected.hashes, ([keyHash, positions]) => ({ keyHash, positions, lookup: 'hash:' + keyHash })),
    ]
    const build = () => {
      const index = { length: record.usage.length, positions: new Map() }
      for (let position = 0; position < record.usage.length; position += 1) {
        const stored = record.usage[position]
        if (typeof stored?.key === 'string') index.positions.set(recordKeyLocator(record.sessionId, stored.key), position)
      }
      usagePageIndices.set(record.usage, index)
      return index
    }
    let index = usagePageIndices.get(record.usage)
    const fresh = index === undefined || index.length !== record.usage.length
    if (fresh) index = build()
    const matches = (stored, request) => stored !== undefined && (request.key === undefined ? recordKeyHash(stored.key) === request.keyHash : stored.key === request.key)
    const resolve = () => requests.map(request => ({ request, stored: record.usage[index.positions.get(request.lookup)] }))
    let rows = resolve()
    // Same-length in-place rewrites/reorders can invalidate numeric positions.
    // Verify selected keys and rebuild once before declaring a key missing.
    if (!fresh && rows.some(({ stored, request }) => !matches(stored, request))) { index = build(); rows = resolve() }
    return rows.filter(({ stored, request }) => matches(stored, request)).map(({ stored, request }) => [stored, request.positions])
  }

  // A compact result keeps only keys. Borrow just the sessions needed by this
  // page, without adopting their unrelated rows back into the resident set.
  async function readUsageRows(references, utc = false) {
    const rows = new Array(references.length).fill(undefined)
    const sessions = new Map()
    const assign = (positions, item) => {
      for (const index of positions) rows[index] = { item, date: utc ? item.dateUtc : item.date }
    }
    for (let index = 0; index < references.length; index += 1) {
      const { sid, key, keyHash } = references[index]
      const item = key === undefined ? undefined : state.usageByStep.get(key)
      if (item !== undefined && item.sid === sid) { assign([index], item); continue }
      let selected = sessions.get(sid)
      if (selected === undefined) { selected = { keys: new Map(), hashes: new Map() }; sessions.set(sid, selected) }
      const wanted = key === undefined ? selected.hashes : selected.keys
      const locator = key === undefined ? keyHash : key
      let positions = wanted.get(locator)
      if (positions === undefined) { positions = []; wanted.set(locator, positions) }
      positions.push(index)
    }
    // Hash lookups are only needed for noncanonical legacy keys. Ordinary pages
    // use direct resident lookups and read each missing session at most once.
    if (Array.from(sessions.values()).some(selected => selected.hashes.size > 0)) {
      for (const item of state.usageByStep.values()) {
        const selected = sessions.get(item.sid)
        if (selected === undefined || selected.hashes.size === 0) continue
        const hash = recordKeyHash(item.key)
        const positions = selected.hashes.get(hash)
        if (positions !== undefined) { assign(positions, item); selected.hashes.delete(hash) }
      }
    }
    const queue = Array.from(sessions).filter(([, selected]) => selected.keys.size > 0 || selected.hashes.size > 0)
    for (let offset = 0; offset < queue.length; offset += 8) {
      const results = await Promise.allSettled(queue.slice(offset, offset + 8).map(async ([sid, selected]) => {
        const releaseRecord = pinRecord(sid)
        try {
          const record = await recordFor(sid)
          if (record === undefined || record === null || !Array.isArray(record.usage)) return
          for (const [stored, positions] of storedRowsForPage(record, selected)) {
            const resident = state.usageByStep.get(stored.key)
            const item = resident !== undefined && resident.sid === sid ? resident : adoptableRow(usageRowOf(record, stored, 'ledger-reuse'))
            assign(positions, item)
          }
        } finally { releaseRecord() }
      }))
      const failed = results.find(result => result.status === 'rejected')
      if (failed !== undefined) throw failed.reason
    }
    return rows
  }


  async function loadRowsForRange(utc, start, end) {
    if (typeof sessionsForRange !== 'function' || typeof adoptUsageRow !== 'function') return 0
    const sessions = sessionsForRange(utc === true, start, end)
    if (sessions.size === 0) return 0
    let adopted = 0
    // A day can own rows in dozens of sessions; reading their documents one at a
    // time made a first open of an old day take hundreds of milliseconds, so the
    // reads go in small parallel windows (the row is data, the order does not matter).
    const queue = Array.from(sessions)
    for (let index = 0; index < queue.length; index += 8) {
      const batch = queue.slice(index, index + 8)
      await Promise.all(batch.map(async (sid) => {
        const record = await recordFor(sid)
        if (record === undefined || record === null || !Array.isArray(record.usage)) return
        for (const item of record.usage) {
          const row = adoptableRow(usageRowOf(record, item, 'ledger-reuse'))
          const date = utc === true ? row.dateUtc : row.date
          if (typeof start === 'string' && start !== '' && date < start) continue
          if (typeof end === 'string' && end !== '' && date > end) continue
          if (adoptUsageRow(row)) adopted += 1
        }
      }))
    }
    return adopted
  }
  /** The record of one session: resident, else read from its own document. */
  // A caller that borrows a record across awaits must keep the authoritative
  // resident copy alive until its work (including any write-back) has settled.
  function pinRecord(sid) {
    state.ledgerReading.set(sid, (state.ledgerReading.get(sid) || 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const remaining = (state.ledgerReading.get(sid) || 1) - 1
      if (remaining > 0) state.ledgerReading.set(sid, remaining)
      else state.ledgerReading.delete(sid)
      const current = state.ledgerRecords.get(sid)
      if (!state.disposed && current !== undefined) cacheLedgerRecord(current)
    }
  }
  async function recordFor(sid) {
    if (typeof sid !== 'string' || sid === '') return undefined
    const resident = state.ledgerRecords.get(sid)
    if (resident !== undefined) {
      cacheLedgerRecord(resident)
      return resident
    }
    if (state.ledgerKeys instanceof Set && !state.ledgerKeys.has(sid)) return undefined
    if (state.ledgerUnit === null || typeof state.ledgerUnit.readRecord !== 'function') return undefined
    // Keep a concurrently installed authoritative record resident until every
    // older disk read of this session has settled. Otherwise LRU pressure can
    // remove the evidence that the old read must not restore deleted history.
    const releaseRecord = pinRecord(sid)
    try {
      const raw = await state.ledgerUnit.readRecord(sid)
      const current = state.ledgerRecords.get(sid)
      if (current !== undefined) return current
      if (raw === undefined) return undefined
      const record = normalizeLedgerRecord(raw, sid)
      if (record === null) {
        console.warn('[all-usage] ignoring malformed usage ledger row:', sid)
        return undefined
      }
      if (!state.disposed) cacheLedgerRecord(record)
      return record
    } catch (err) {
      const current = state.ledgerRecords.get(sid)
      if (current !== undefined) return current
      throw err
    } finally {
      releaseRecord()
    }
  }
  async function loadLedger() {
    if (storage === undefined || storage.backend === undefined || typeof storage.backend.get !== 'function') return
    try {
      const backend = storage.backend.get('json')
      if (backend === undefined || backend === null || backend.kv === undefined) return
      const opened = await openLedgerUnitStore(backend)
      if (state.disposed) { await opened.store.close(); return }
      state.ledgerUnit = opened.store
      if (!(state.ledgerKeys instanceof Set)) state.ledgerKeys = new Set()
      if (!(state.ledgerRecordSizes instanceof Map)) state.ledgerRecordSizes = new Map()
      if (!Number.isFinite(state.ledgerRecordBytes)) state.ledgerRecordBytes = 0
      // The per-record tree is its own index: enumerate the keys and read a record
      // only when something asks for it, so a cold start no longer materialises
      // every session document at once (123 MB on a 66k-row ledger).
      if (opened.streaming !== true) {
        // A unit that cannot read a single record has already handed us the whole
        // table; keep the old behaviour there (tests, exotic backends).
        state.ledgerRecordsComplete = true
        for (const [key, raw] of Object.entries(opened.rows)) {
          if (key.startsWith('__')) continue
          const record = normalizeLedgerRecord(raw, key)
          if (record === null) console.warn('[all-usage] ignoring malformed usage ledger row:', key)
          else cacheLedgerRecord(record)
          state.ledgerKeys.add(key)
        }
      }
      if (typeof opened.store.listKeys === 'function') {
        for (const key of await opened.store.listKeys()) state.ledgerKeys.add(key)
      }
      if (state.ledgerUnit !== null && state.ledgerUnit !== undefined && typeof state.ledgerUnit.readRecord !== 'function') state.ledgerRecordsComplete = true
    } catch (err) {
      console.error('[all-usage] usage ledger unavailable:', err)
    }
  }

  return {
    nextLedgerRevision,
    ledgerEventKey,
    sessionEvents,
    retargetLedgerRecord,
    buildLedgerRecord,
    normalizeLedgerRecord,
    prepareLedgerRecord,
    applyLedgerRecord,
    ledgerRank,
    replaceLedgerRecord,
    storeLedgerRecord,
    persistLedgerRecord,
    drainLedgerWrites,
    archiveLedger,
    // Exposed for the round-trip test: the on-disk shape is private otherwise.
    serializeLedgerRecordForTest: serializeLedgerRecord,
    expandLedgerRecordForTest: expandLedgerRecord,
    assertLedgerRecord,
    loadLedger,
    recordFor,
    pinRecord,
    loadRecords,
    adoptableRow,
    loadRowsForRange,
    readUsageRows,
    loadRowsForSession
  }
}

export { LEDGER_VERSION, PREVIOUS_LEDGER_VERSION, LEGACY_LEDGER_VERSION, LEDGER_SHARD_COUNT, RETIRED_WORKSPACE_ID, ledgerShardIndex, retargetLedgerRecord, serializeLedgerRecord, withLedgerMaintenanceLock }
