import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import fs, { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createLedger, LEDGER_SHARD_COUNT, withLedgerMaintenanceLock } from '../lib/ledger.js'
import { recordKeyHash } from '../lib/records-cache.js'

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


test('does not reclaim a live maintenance holder after the stale threshold', async (t) => {
  const root = await makeRoot()
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  const now = Date.now()
  let clock = now
  t.mock.method(Date, 'now', () => clock)
  let first
  let active = 0
  let peak = 0
  try {
    first = withLedgerMaintenanceLock(root, async () => {
      active += 1
      peak = Math.max(peak, active)
      entered.resolve()
      try { await release.promise } finally { active -= 1 }
    })
    await entered.promise
    const owner = await lockSnapshot(root)
    clock += 30001
    let secondEntered = false
    const second = await withLedgerMaintenanceLock(root, async () => {
      secondEntered = true
      active += 1
      peak = Math.max(peak, active)
      active -= 1
    })
    t.diagnostic('simultaneous maintenance holders: ' + peak)
    assert.deepEqual(second, { acquired: false }, 'a running owner remains exclusive after 30 seconds')
    assert.equal(secondEntered, false)
    assert.equal(peak, 1)
    assert.deepEqual((await lockSnapshot(root)).owner, owner.owner, 'the live owner document is unchanged')
  } finally {
    release.resolve()
    if (first !== undefined) await first
    t.mock.restoreAll()
    await rm(root, { recursive: true, force: true })
  }
})


test('reclaims dead same-host owners while EPERM retains the lock', async (t) => {
  const root = await makeRoot()
  const now = Date.now()
  let clock = now
  t.mock.method(Date, 'now', () => clock)
  try {
    await mkdir(join(root, LOCK_NAME))
    const ownerFile = join(root, LOCK_NAME, 'owner.json')
    await writeFile(ownerFile, JSON.stringify({ pid: 2147483000, startedAt: now, host: hostname() }), 'utf8')
    const recovered = await withLedgerMaintenanceLock(root, async () => 'recovered')
    assert.deepEqual(recovered, { acquired: true, value: 'recovered' }, 'ESRCH proves the same-host owner exited')
    assert.equal(await exists(join(root, LOCK_NAME)), false)

    await mkdir(join(root, LOCK_NAME))
    await writeFile(ownerFile, JSON.stringify({ pid: 1, startedAt: now, host: hostname() }), 'utf8')
    clock += 60000
    const realKill = process.kill
    t.mock.method(process, 'kill', (pid, signal) => {
      if (pid === 1 && signal === 0) throw Object.assign(new Error('permission denied'), { code: 'EPERM' })
      return realKill(pid, signal)
    })
    const retained = await withLedgerMaintenanceLock(root, async () => 'must-not-run')
    assert.deepEqual(retained, { acquired: false }, 'EPERM never proves that the holder is dead')
    assert.equal((await lockSnapshot(root)).owner.pid, 1)
  } finally {
    t.mock.restoreAll()
    await rm(root, { recursive: true, force: true })
  }
})

function lockHolderTracker() {
  const release = Promise.withResolvers()
  const entered = new Map()
  const holders = []
  let active = 0
  let peak = 0
  return {
    release,
    holders,
    peak: () => peak,
    entered(label) {
      if (!entered.has(label)) entered.set(label, Promise.withResolvers())
      return entered.get(label).promise
    },
    callback(label) {
      if (!entered.has(label)) entered.set(label, Promise.withResolvers())
      return async () => {
        active += 1
        peak = Math.max(peak, active)
        holders.push(label)
        entered.get(label).resolve()
        try { await release.promise } finally { active -= 1 }
      }
    },
  }
}

test('concurrent stale reclaimers never overlap maintenance callbacks', { timeout: 10000 }, async (t) => {
  const root = await makeRoot()
  const ownerFile = join(root, LOCK_NAME, 'owner.json')
  const scope = new AsyncLocalStorage()
  const paused = Promise.withResolvers()
  const resume = Promise.withResolvers()
  const tracked = lockHolderTracker()
  const realUnlink = fs.unlink
  let pausedOnce = false
  let first
  let second
  try {
    await mkdir(join(root, LOCK_NAME))
    await writeFile(ownerFile, JSON.stringify({ host: 'dead-fixture', pid: 999999, startedAt: Date.now() - 60000, token: 'dead' }))
    t.mock.method(fs, 'unlink', async (path) => {
      if (scope.getStore() === 'B' && path === ownerFile && !pausedOnce) {
        pausedOnce = true
        paused.resolve()
        await resume.promise
      }
      return realUnlink(path)
    })
    syncBuiltinESMExports()
    second = scope.run('B', () => withLedgerMaintenanceLock(root, tracked.callback('B')))
    await Promise.race([paused.promise, second.then(() => assert.fail('stale contender never reached owner deletion'))])
    first = scope.run('A', () => withLedgerMaintenanceLock(root, tracked.callback('A')))
    await Promise.race([tracked.entered('A'), first])
    resume.resolve()
    await Promise.race([tracked.entered('B'), second])
    assert.equal(tracked.peak(), 1, 'a delayed stale decision does not delete a live replacement and admit two callbacks')
  } finally {
    resume.resolve()
    tracked.release.resolve()
    await Promise.allSettled([first, second])
    t.mock.restoreAll()
    syncBuiltinESMExports()
    await rm(root, { recursive: true, force: true })
  }
})

for (const writeFailure of [null, 'EIO', 'ENOENT']) {
  test('a late owner writer preserves the winner after its mkdir generation disappears' + (writeFailure ? ' on ' + writeFailure : ''), { timeout: 10000 }, async (t) => {
    const root = await makeRoot()
    const dir = join(root, LOCK_NAME)
    const ownerFile = join(dir, 'owner.json')
    const scope = new AsyncLocalStorage()
    const oldGenerationRemoved = Promise.withResolvers()
    const resumeOldWriter = Promise.withResolvers()
    const tracked = lockHolderTracker()
    const realMkdir = fs.mkdir
    const realRmdir = fs.rmdir
    const realWriteFile = fs.writeFile
    let firstMkdir = true
    let injectedFailure = false
    let first
    let second
    let third
    try {
      t.mock.method(fs, 'mkdir', async (path, options) => {
        const result = await realMkdir(path, options)
        if (scope.getStore() === 'A' && path === dir && firstMkdir) {
          firstMkdir = false
          // A delayed rmdir from an old release/reclaimer completes after mkdir.
          await realRmdir(dir)
          oldGenerationRemoved.resolve()
          await resumeOldWriter.promise
        }
        return result
      })
      t.mock.method(fs, 'writeFile', async (path, value, options) => {
        if (writeFailure && scope.getStore() === 'A' && String(path).includes('owner.')) {
          injectedFailure = true
          throw Object.assign(new Error('late owner write failed'), { code: writeFailure })
        }
        return realWriteFile(path, value, options)
      })
      syncBuiltinESMExports()
      first = scope.run('A', () => withLedgerMaintenanceLock(root, tracked.callback('A')))
      await Promise.race([oldGenerationRemoved.promise, first.then(() => assert.fail('old writer did not reach the generation barrier'))])
      second = scope.run('B', () => withLedgerMaintenanceLock(root, tracked.callback('B')))
      await Promise.race([tracked.entered('B'), second.then(() => assert.fail('replacement writer did not acquire'))])
      const winner = JSON.parse(await readFile(ownerFile, 'utf8'))
      resumeOldWriter.resolve()
      await Promise.race([tracked.entered('A'), first])
      const current = await readFile(ownerFile, 'utf8').then(JSON.parse, () => null)
      assert.deepEqual(current, winner, 'a failed or losing late writer preserves the existing owner')
      if (writeFailure) assert.equal(injectedFailure, true, 'the write failure was actually injected')
      third = scope.run('C', () => withLedgerMaintenanceLock(root, tracked.callback('C')))
      await Promise.race([tracked.entered('C'), third])
      assert.equal(tracked.peak(), 1)
      assert.deepEqual(await first, { acquired: false })
      assert.deepEqual(await third, { acquired: false })
    } finally {
      resumeOldWriter.resolve()
      tracked.release.resolve()
      await Promise.allSettled([first, second, third])
      t.mock.restoreAll()
      syncBuiltinESMExports()
      await rm(root, { recursive: true, force: true })
    }
  })
}

test('a late owner writer waits for pinned reclaimers and revalidates its token before entering', { timeout: 10000 }, async (t) => {
  const root = await makeRoot()
  const dir = join(root, LOCK_NAME)
  const ownerFile = join(dir, 'owner.json')
  const scope = new AsyncLocalStorage()
  const oldWriterReady = Promise.withResolvers()
  const resumeOldWriter = Promise.withResolvers()
  const reclaimerReady = Promise.withResolvers()
  const resumeReclaimer = Promise.withResolvers()
  const writerScannedMarkers = Promise.withResolvers()
  const tracked = lockHolderTracker()
  const realMkdir = fs.mkdir
  const realWriteFile = fs.writeFile
  const realUnlink = fs.unlink
  const realReaddir = fs.readdir
  let blockedDelete = false
  let blockedWrite = false
  let writer
  let reclaimer
  try {
    await mkdir(dir)
    await writeFile(ownerFile, JSON.stringify({ host: 'dead-fixture', pid: 999999, startedAt: Date.now() - 60000, token: 'dead' }))
    t.mock.method(fs, 'mkdir', async (path, options) => {
      // The old writer already completed mkdir in a prior directory generation.
      if (scope.getStore() === 'A' && path === dir) return undefined
      return realMkdir(path, options)
    })
    t.mock.method(fs, 'writeFile', async (path, value, options) => {
      if (scope.getStore() === 'A' && path === ownerFile && !blockedWrite) {
        blockedWrite = true
        oldWriterReady.resolve()
        await resumeOldWriter.promise
      }
      return realWriteFile(path, value, options)
    })
    t.mock.method(fs, 'unlink', async (path) => {
      if (scope.getStore() === 'B' && path === ownerFile && !blockedDelete) {
        blockedDelete = true
        reclaimerReady.resolve()
        await resumeReclaimer.promise
      }
      return realUnlink(path)
    })
    t.mock.method(fs, 'readdir', async (path, options) => {
      const entries = await realReaddir(path, options)
      if (scope.getStore() === 'A' && path === dir) writerScannedMarkers.resolve()
      return entries
    })
    syncBuiltinESMExports()
    writer = scope.run('A', () => withLedgerMaintenanceLock(root, tracked.callback('A')))
    await Promise.race([oldWriterReady.promise, writer.then(() => assert.fail('old writer never reached owner write'))])
    reclaimer = scope.run('B', () => withLedgerMaintenanceLock(root, tracked.callback('B')))
    const phase = await Promise.race([reclaimerReady.promise.then(() => 'deleting'), reclaimer.then(() => 'busy')])
    if (phase === 'deleting') {
      // A peer reclaimer removed the dead owner while B still pins this directory.
      await realUnlink(ownerFile)
      resumeOldWriter.resolve()
      await Promise.race([writerScannedMarkers.promise, tracked.entered('A'), writer])
      resumeReclaimer.resolve()
      await Promise.race([tracked.entered('B'), reclaimer])
      assert.equal(tracked.peak(), 1, 'an old creator cannot enter until every earlier stale decision has finished')
      assert.deepEqual(await writer, { acquired: false }, 'a deleted reservation never runs its callback')
    } else {
      // A lifetime claim can exclude B before either owner write is published.
      assert.deepEqual(await reclaimer, { acquired: false })
      resumeOldWriter.resolve()
      await Promise.race([tracked.entered('A'), writer])
      assert.ok(tracked.peak() <= 1)
      if (tracked.peak() === 0) {
        assert.deepEqual(await writer, { acquired: false })
        assert.deepEqual(await withLedgerMaintenanceLock(root, async () => 'retry'), { acquired: true, value: 'retry' }, 'two busy attempts do not leave a live reservation or fresh empty directory behind')
      } else {
        assert.deepEqual(tracked.holders, ['A'])
      }
    }
  } finally {
    resumeOldWriter.resolve()
    resumeReclaimer.resolve()
    tracked.release.resolve()
    await Promise.allSettled([writer, reclaimer])
    t.mock.restoreAll()
    syncBuiltinESMExports()
    await rm(root, { recursive: true, force: true })
  }
})

test('recovers a crashed reclaimer using the immutable marker filename even without marker contents', async (t) => {
  const root = await makeRoot()
  const dir = join(root, LOCK_NAME)
  const marker = 'owner.' + recordKeyHash(hostname()) + '.2147483000.' + Date.now() + '.11111111-1111-4111-8111-111111111111'
  const realKill = process.kill
  try {
    await mkdir(dir)
    await writeFile(join(dir, 'owner.json'), JSON.stringify({ host: 'dead-fixture', pid: 999999, startedAt: Date.now() - 60000, token: 'dead' }))
    await writeFile(join(dir, marker), '')
    t.mock.method(process, 'kill', (pid, signal) => {
      if (pid === 2147483000 && signal === 0) throw Object.assign(new Error('process exited'), { code: 'ESRCH' })
      return realKill(pid, signal)
    })
    const result = await withLedgerMaintenanceLock(root, async () => 'recovered')
    assert.deepEqual(result, { acquired: true, value: 'recovered' })
    assert.equal(await exists(dir), false)
  } finally {
    t.mock.restoreAll()
    await rm(root, { recursive: true, force: true })
  }
})

test('cleans only its own immutable marker when marker creation reports a write error', async (t) => {
  const root = await makeRoot()
  const dir = join(root, LOCK_NAME)
  const ownerFile = join(dir, 'owner.json')
  const deadOwner = { host: 'dead-fixture', pid: 999999, startedAt: Date.now() - 60000, token: 'dead' }
  const realWriteFile = fs.writeFile
  let failed = false
  try {
    await mkdir(dir)
    await writeFile(ownerFile, JSON.stringify(deadOwner))
    t.mock.method(fs, 'writeFile', async (path, value, options) => {
      const result = await realWriteFile(path, value, options)
      if (!failed && String(path).includes('owner.') && !String(path).endsWith('owner.json')) {
        failed = true
        throw Object.assign(new Error('marker write failed after creation'), { code: 'EIO' })
      }
      return result
    })
    syncBuiltinESMExports()
    let entered = false
    const result = await withLedgerMaintenanceLock(root, async () => { entered = true })
    assert.deepEqual(result, { acquired: false })
    assert.equal(entered, false)
    assert.deepEqual(JSON.parse(await readFile(ownerFile, 'utf8')), deadOwner)
    assert.deepEqual(await readdir(dir), ['owner.json'])
    assert.deepEqual(await withLedgerMaintenanceLock(root, async () => 'retry'), { acquired: true, value: 'retry' })
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
    await rm(root, { recursive: true, force: true })
  }
})

test('two busy claim snapshots leave no reservation and allow an immediate retry', { timeout: 10000 }, async (t) => {
  const root = await makeRoot()
  const dir = join(root, LOCK_NAME)
  const scope = new AsyncLocalStorage()
  const realReaddir = fs.readdir
  const bothReady = Promise.withResolvers()
  const bothRead = Promise.withResolvers()
  let ready = 0
  let readCount = 0
  let first
  let second
  try {
    t.mock.method(fs, 'readdir', async (path, options) => {
      if (path !== dir || !['A', 'B'].includes(scope.getStore())) return realReaddir(path, options)
      ready += 1
      if (ready === 2) bothReady.resolve()
      await bothReady.promise
      const names = await realReaddir(path, options)
      readCount += 1
      if (readCount === 2) bothRead.resolve()
      await bothRead.promise
      return names
    })
    syncBuiltinESMExports()
    first = scope.run('A', () => withLedgerMaintenanceLock(root, async () => assert.fail('both-claim snapshot must back off')))
    second = scope.run('B', () => withLedgerMaintenanceLock(root, async () => assert.fail('both-claim snapshot must back off')))
    assert.deepEqual(await Promise.all([first, second]), [{ acquired: false }, { acquired: false }])
    assert.equal(await exists(dir), false, 'the last claimant removes the empty directory')
    assert.deepEqual(await withLedgerMaintenanceLock(root, async () => 'retry'), { acquired: true, value: 'retry' })
  } finally {
    bothReady.resolve()
    bothRead.resolve()
    await Promise.allSettled([first, second])
    t.mock.restoreAll()
    syncBuiltinESMExports()
    await rm(root, { recursive: true, force: true })
  }
})

for (const status of ['live', 'EPERM', 'unknown']) {
  test('preserves another ' + status + ' claim without entering or deleting the legacy owner', async (t) => {
    const root = await makeRoot()
    const dir = join(root, LOCK_NAME)
    const deadOwner = { host: 'dead-fixture', pid: 999999, startedAt: Date.now() - 60000, token: 'dead' }
    const pid = status === 'EPERM' ? 1 : process.pid
    const marker = status === 'unknown' ? 'owner.unknown-claim' : 'owner.' + recordKeyHash(hostname()) + '.' + pid + '.' + (Date.now() - 60000) + '.11111111-1111-4111-8111-111111111111'
    const realKill = process.kill
    try {
      await mkdir(dir)
      await writeFile(join(dir, 'owner.json'), JSON.stringify(deadOwner))
      await writeFile(join(dir, marker), '')
      t.mock.method(process, 'kill', (target, signal) => {
        if (status === 'EPERM' && target === pid && signal === 0) throw Object.assign(new Error('permission denied'), { code: 'EPERM' })
        return realKill(target, signal)
      })
      const result = await withLedgerMaintenanceLock(root, async () => assert.fail('another claimant still owns its pin'))
      assert.deepEqual(result, { acquired: false })
      assert.deepEqual(JSON.parse(await readFile(join(dir, 'owner.json'), 'utf8')), deadOwner)
      assert.deepEqual((await readdir(dir)).sort(), [marker, 'owner.json'].sort())
    } finally {
      t.mock.restoreAll()
      await rm(root, { recursive: true, force: true })
    }
  })
}

test('verifies the complete owner token before invoking the protected callback', async (t) => {
  const root = await makeRoot()
  const ownerFile = join(root, LOCK_NAME, 'owner.json')
  const realWriteFile = fs.writeFile
  let replacement
  try {
    t.mock.method(fs, 'writeFile', async (path, value, options) => {
      const result = await realWriteFile(path, value, options)
      if (path === ownerFile) {
        replacement = { ...JSON.parse(value), token: 'replacement-before-callback' }
        await realWriteFile(path, JSON.stringify(replacement), 'utf8')
      }
      return result
    })
    syncBuiltinESMExports()
    const result = await withLedgerMaintenanceLock(root, async () => assert.fail('a replaced reservation must not enter'))
    assert.deepEqual(result, { acquired: false })
    assert.deepEqual(JSON.parse(await readFile(ownerFile, 'utf8')), replacement)
    assert.deepEqual(await readdir(join(root, LOCK_NAME)), ['owner.json'])
    assert.deepEqual(await withLedgerMaintenanceLock(root, async () => assert.fail('a mismatched token never borrows an old missing claim binding')), { acquired: false })
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
    await rm(root, { recursive: true, force: true })
  }
})

for (const failedOperation of ['readFile', 'unlink', 'claim-unlink']) {
  for (const persistent of [false, true]) {
    test((persistent ? 'reports persistent ' : 'recovers from one ') + failedOperation + ' cleanup error', async (t) => {
      const root = await makeRoot()
      const ownerFile = join(root, LOCK_NAME, 'owner.json')
      const method = failedOperation === 'claim-unlink' ? 'unlink' : failedOperation
      const realOperation = fs[method]
      let releasing = false
      let injected = 0
      let held
      try {
        t.mock.method(fs, method, async (path, ...args) => {
          const target = failedOperation === 'claim-unlink' ? held?.claimFile : ownerFile
          if (releasing && path === target && (persistent || injected === 0)) {
            injected += 1
            throw Object.assign(new Error('temporary owner cleanup failure'), { code: 'EIO' })
          }
          return realOperation(path, ...args)
        })
        syncBuiltinESMExports()
        const pending = withLedgerMaintenanceLock(root, async (handle) => { held = handle; releasing = true; return 'done' })
        if (persistent) {
          await assert.rejects(pending, { code: 'EIO' })
          assert.equal(injected, 2, 'cleanup retries remain bounded')
          releasing = false
          if (failedOperation === 'claim-unlink') {
            assert.equal(await exists(held.claimFile), true, 'an uncertain claim unlink remains fail-closed')
            assert.equal(await exists(ownerFile), false)
            assert.deepEqual(await withLedgerMaintenanceLock(root, async () => assert.fail('the retained live claim remains exclusive')), { acquired: false })
          } else {
            assert.equal(await exists(held.claimFile), false, 'callback completion removes its unique claim even when owner cleanup failed')
            assert.deepEqual(JSON.parse(await readFile(ownerFile, 'utf8')), held.owner)
            assert.deepEqual(await withLedgerMaintenanceLock(root, async () => 'recovered'), { acquired: true, value: 'recovered' }, 'a valid missing bound claim permits immediate recovery after I/O resumes')
          }
        } else {
          assert.deepEqual(await pending, { acquired: true, value: 'done' })
          assert.equal(injected, 1)
          releasing = false
          assert.equal(await exists(join(root, LOCK_NAME)), false)
          assert.deepEqual(await withLedgerMaintenanceLock(root, async () => 'recovered'), { acquired: true, value: 'recovered' })
        }
      } finally {
        t.mock.restoreAll()
        syncBuiltinESMExports()
        await rm(root, { recursive: true, force: true })
      }
    })
  }
}
