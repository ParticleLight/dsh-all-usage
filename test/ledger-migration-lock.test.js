import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createLedger, LEDGER_SHARD_COUNT } from '../lib/ledger.js'

// The ledger retires the legacy whole-unit files only while it holds a lock
// directory next to them, and a start that cannot take that lock runs maintenance
// read-only. Every case below runs against a real root on disk, because the code
// under test stats, unlinks and readdirs that tree.

const LEDGER_UNIT = 'all_usage_ledger'
const LOCK_NAME = LEDGER_UNIT + '.lock'
const META_KEY = '__all_usage_ledger_meta__'

function shardName(index) {
  return LEDGER_UNIT + '_' + String(index).padStart(2, '0')
}

async function exists(path) {
  return stat(path).then(() => true, () => false)
}

async function makeRoot() {
  return mkdtemp(join(tmpdir(), 'all-usage-ledger-lock-'))
}

// One legacy whole-unit document, stored the way the storage layer stores it.
async function writeLegacyFile(root, name, rows) {
  await mkdir(root, { recursive: true })
  await writeFile(join(root, name + '.json'), JSON.stringify({ global: {}, tables: { sessions: rows } }), 'utf8')
}

// The lock as another process would see it: the directory, the owner document and,
// where the platform stores one, the file mode.
async function lockSnapshot(root) {
  const dir = join(root, LOCK_NAME)
  const ownerFile = join(dir, 'owner.json')
  if (!(await exists(dir))) return { exists: false, owner: null, mode: null }
  const owner = await readFile(ownerFile, 'utf8').then((raw) => JSON.parse(raw), () => null)
  const mode = await stat(ownerFile).then((info) => info.mode & 0o777, () => null)
  return { exists: true, owner, mode }
}

function treeUnit(root, name, state, options) {
  const tableDir = (table) => join(root, name, table)
  return {
    tableDir,
    async loadAll() {
      const dir = tableDir('sessions')
      const rows = Object.create(null)
      for (const entry of await readdir(dir).catch(() => [])) {
        if (!entry.endsWith('.json')) continue
        const document = JSON.parse(await readFile(join(dir, entry), 'utf8'))
        rows[entry.slice(0, -'.json'.length)] = document.record
      }
      return { global: {}, tables: { sessions: rows } }
    },
    async putRecord(table, key, value) {
      state.writes.push({ name, table, key })
      if (options.onWrite !== undefined) await options.onWrite(name, key)
      await mkdir(tableDir(table), { recursive: true })
      await writeFile(join(tableDir(table), key + '.json'), JSON.stringify({ version: 0, record: value }), 'utf8')
    },
    async close() {},
  }
}

// A single-file unit: no tableDir, so the ledger reads it whole and never streams it.
function legacyUnit(root, name, state) {
  const file = join(root, name + '.json')
  return {
    async loadAll() {
      const snapshot = JSON.parse(await readFile(file, 'utf8'))
      return { global: snapshot.global, tables: { sessions: snapshot.tables.sessions } }
    },
    async putRecord(table, key) {
      state.writes.push({ name, table, key })
    },
    async close() {},
  }
}

function makeBackend(root, options = {}) {
  const state = { opened: [], writes: [] }
  const units = new Map()
  return {
    root,
    state,
    kv: {
      async open(descriptor) {
        state.opened.push(descriptor.name)
        const existing = units.get(descriptor.name)
        if (existing !== undefined) return existing
        const unit = descriptor.layout === 'per-record'
          ? treeUnit(root, descriptor.name, state, options)
          : legacyUnit(root, descriptor.name, state)
        units.set(descriptor.name, unit)
        return unit
      },
    },
  }
}

function makeLedger(storage = undefined) {
  const identity = { identityKey: 'identity', provider: null, requestedModel: null, actualModel: null, label: 'unknown', legacy: true }
  const host = {
    services: { storage },
    state: {
      ledgerRevision: Number.NaN,
      ledgerRecords: new Map(),
      ledgerUnit: null,
      ledgerWriteChain: Promise.resolve(),
      disposed: false,
      sessionModel: new Map(),
      usageByStep: new Map(),
      sessionCount: new Set(),
    },
    aggregation: {
      addTurn() {},
      coerceIdentity(value) { return value || identity },
      identityFromLegacy() { return identity },
      identityFromMessage() { return identity },
      identityFromRoute() { return identity },
      makeIdentity() { return identity },
      costForUsage() { return {} },
      resolveCurrentPricing() { return {} },
      dateKeys() { return { local: '2024-01-01', utc: '2024-01-01' } },
      validEventTime(value) { return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 8640000000000000 },
      upsertUsageSample(target, sample) {
        const previous = target.get(sample.key)
        target.set(sample.key, sample)
        return { accepted: true, replaced: previous !== undefined, previous, next: sample }
      },
    },
    sessionSync: {
      lastSeqOf(events) {
        let last = -1
        for (const event of events || []) if (event && typeof event.seq === 'number' && event.seq > last) last = event.seq
        return last
      },
    },
    markStatsChanged() {},
  }
  return { host, ledger: createLedger(host), identity }
}

function legacyRecord() {
  return { version: 3, sessionId: 's-legacy', workspaceId: 'w', updatedAt: 1, turns: [], usage: [] }
}

test('holds the maintenance lock only while the first migration runs', async () => {
  const root = await makeRoot()
  try {
    const legacy = legacyRecord()
    await writeLegacyFile(root, LEDGER_UNIT, { 's-legacy': legacy })
    const held = []
    const backend = makeBackend(root, { onWrite: async (name, key) => { if (key === META_KEY) held.push(await lockSnapshot(root)) } })
    const { host, ledger } = makeLedger({ backend: { get() { return backend } } })
    await ledger.loadLedger()
    // The marker write is the last step before the retirement, so this snapshot is
    // taken with the lock held and the legacy document still in place.
    assert.equal(held.length, 1)
    assert.equal(held[0].exists, true)
    assert.equal(Number.isInteger(held[0].owner.pid), true)
    assert.equal(Number.isFinite(held[0].owner.startedAt), true)
    assert.equal(typeof held[0].owner.host, 'string')
    // Windows reports 0o666 for every file however it was created, so the owner
    // mode only carries information where the platform stores it.
    if (process.platform !== 'win32') assert.equal(held[0].mode & 0o077, 0)
    assert.equal(await exists(join(root, LOCK_NAME)), false)
    assert.equal(host.state.ledgerRecords.has('s-legacy'), true)
    assert.equal(await exists(join(root, LEDGER_UNIT + '.json')), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('leaves the legacy files and rows alone while a fresh lock belongs to another process', async () => {
  const root = await makeRoot()
  try {
    const legacy = legacyRecord()
    await writeLegacyFile(root, LEDGER_UNIT, { 's-legacy': legacy })
    await writeLegacyFile(root, shardName(0), {})
    await mkdir(join(root, LOCK_NAME))
    const foreign = { pid: 4242, startedAt: Date.now(), host: 'other-host' }
    await writeFile(join(root, LOCK_NAME, 'owner.json'), JSON.stringify(foreign), 'utf8')
    const backend = makeBackend(root)
    const { host, ledger } = makeLedger({ backend: { get() { return backend } } })
    await ledger.loadLedger()
    // Read-only maintenance: not one document written, not one file deleted.
    assert.deepEqual(backend.state.writes, [])
    assert.equal(await exists(join(root, LEDGER_UNIT + '.json')), true)
    assert.equal(await exists(join(root, shardName(0) + '.json')), true)
    assert.equal(await exists(join(root, shardName(0), 'sessions', META_KEY + '.json')), false)
    // The foreign lock is still the other process's, so this one must not remove it.
    assert.deepEqual(JSON.parse(await readFile(join(root, LOCK_NAME, 'owner.json'), 'utf8')), foreign)
    // The legacy rows are still readable through the store the ledger adopted.
    const store = host.state.ledgerUnit
    assert.deepEqual(await store.listKeys(), ['s-legacy'])
    assert.deepEqual(await store.readRecord('s-legacy'), legacy)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('reclaims a lock its holder never released', async () => {
  const root = await makeRoot()
  try {
    const legacy = legacyRecord()
    await writeLegacyFile(root, LEDGER_UNIT, { 's-legacy': legacy })
    await mkdir(join(root, LOCK_NAME))
    await writeFile(join(root, LOCK_NAME, 'owner.json'), JSON.stringify({ pid: 999999, startedAt: Date.now() - 60000, host: 'killed' }), 'utf8')
    const backend = makeBackend(root)
    const { host, ledger } = makeLedger({ backend: { get() { return backend } } })
    await ledger.loadLedger()
    assert.equal(host.state.ledgerRecords.has('s-legacy'), true)
    assert.equal(await exists(join(root, LEDGER_UNIT + '.json')), false)
    assert.equal(await exists(join(root, LOCK_NAME)), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('reclaims a lock directory that never got an owner document', async () => {
  const root = await makeRoot()
  try {
    const legacy = legacyRecord()
    await writeLegacyFile(root, LEDGER_UNIT, { 's-legacy': legacy })
    await mkdir(join(root, LOCK_NAME))
    const past = new Date(Date.now() - 60000)
    await utimes(join(root, LOCK_NAME), past, past)
    const backend = makeBackend(root)
    const { host, ledger } = makeLedger({ backend: { get() { return backend } } })
    await ledger.loadLedger()
    assert.equal(host.state.ledgerRecords.has('s-legacy'), true)
    assert.equal(await exists(join(root, LEDGER_UNIT + '.json')), false)
    assert.equal(await exists(join(root, LOCK_NAME)), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('does not migrate or rewrite anything on a second start', async () => {
  const root = await makeRoot()
  try {
    await writeLegacyFile(root, LEDGER_UNIT, { 's-legacy': legacyRecord() })
    const backend = makeBackend(root)
    const first = makeLedger({ backend: { get() { return backend } } })
    await first.ledger.loadLedger()
    const openedAfterFirst = backend.state.opened.length
    const writesAfterFirst = backend.state.writes.length
    await first.host.state.ledgerUnit.close()
    const second = makeLedger({ backend: { get() { return backend } } })
    await second.ledger.loadLedger()
    // The marker in the trees ends the migration: the legacy document is never
    // opened again, and nothing is copied or rewritten.
    assert.equal(backend.state.opened.length, openedAfterFirst + LEDGER_SHARD_COUNT)
    assert.equal(backend.state.opened.slice(openedAfterFirst).includes(LEDGER_UNIT), false)
    assert.equal(backend.state.writes.length, writesAfterFirst)
    assert.equal(await exists(join(root, LOCK_NAME)), false)
    await second.host.state.ledgerUnit.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('keeps the legacy files when DSH_ALL_USAGE_KEEP_LEGACY is set', async () => {
  const root = await makeRoot()
  const previous = process.env.DSH_ALL_USAGE_KEEP_LEGACY
  process.env.DSH_ALL_USAGE_KEEP_LEGACY = '1'
  try {
    await writeLegacyFile(root, LEDGER_UNIT, { 's-legacy': legacyRecord() })
    await writeLegacyFile(root, shardName(3), {})
    const backend = makeBackend(root)
    const { host, ledger } = makeLedger({ backend: { get() { return backend } } })
    await ledger.loadLedger()
    // The migration still copies the rows, it just does not retire any file.
    assert.equal(host.state.ledgerRecords.has('s-legacy'), true)
    assert.equal(await exists(join(root, LEDGER_UNIT + '.json')), true)
    assert.equal(await exists(join(root, shardName(3) + '.json')), true)
    assert.equal(await exists(join(root, LOCK_NAME)), false)
  } finally {
    if (previous === undefined) delete process.env.DSH_ALL_USAGE_KEEP_LEGACY
    else process.env.DSH_ALL_USAGE_KEEP_LEGACY = previous
    await rm(root, { recursive: true, force: true })
  }
})

test('releases the lock and deletes nothing when the migration fails', async () => {
  const root = await makeRoot()
  try {
    await writeLegacyFile(root, LEDGER_UNIT, { 's-legacy': legacyRecord() })
    const backend = makeBackend(root, { onWrite: async (name, key) => { if (key === META_KEY) throw new Error('tree write failed') } })
    const { host, ledger } = makeLedger({ backend: { get() { return backend } } })
    const logged = []
    const original = console.error
    console.error = (...args) => { logged.push(args.map(String).join(' ')) }
    try {
      await ledger.loadLedger()
    } finally {
      console.error = original
    }
    assert.equal(logged.some((line) => line.includes('usage ledger unavailable')), true)
    assert.equal(host.state.ledgerUnit, null)
    // A failed migration must not leave the lock behind, and must not delete the
    // document it did not manage to copy.
    assert.equal(await exists(join(root, LOCK_NAME)), false)
    assert.equal(await exists(join(root, LEDGER_UNIT + '.json')), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
