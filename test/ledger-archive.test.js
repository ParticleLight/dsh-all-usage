// Acceptance tests for the cold half of the usage ledger: lib/archive.js, the
// lib/ledger.js integration it needs, and scripts/archive-ledger.mjs.
//
// Every case runs against a real temporary root. The archive opens, renames,
// unlinks and readdirs real files, and the property under test is that moving a
// record from its tree into a month file moves no number: the dashboard has to fold
// exactly the same daily, workspace and model totals before and after.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { gunzipSync } from 'node:zlib'
import { archiveRecords, createArchiveReader } from '../lib/archive.js'
import { serializeLedgerRecord } from '../lib/ledger.js'
import {
  createInvariantHost,
  createLedgerBackend,
  createTempRoot,
  ledgerShardUnitName,
  removeTempRoot,
  shardIndexOf,
  LEDGER_SHARD_COUNT,
} from './support/ledger-invariants.js'

const run = promisify(execFile)
const CLI = fileURLToPath(new URL('../scripts/archive-ledger.mjs', import.meta.url))
const DAY_MS = 86400000
const BASE_TIME = Date.parse('2026-10-13T08:00:00Z')
// Two months that are certainly older than any cutoff used here, plus one record
// that stays resident so every test can check that the archive is selective.
const OLD_CUTOFF = Date.parse('2026-09-01T00:00:00Z')
const FIXTURE = [
  { id: 's-june-1', workspaceId: 'w-alpha', cwd: 'C:/work/alpha', seed: 1, updatedAt: Date.parse('2026-06-03T04:00:00Z') },
  { id: 's-june-2', workspaceId: 'w-alpha', cwd: 'C:/work/alpha', seed: 2, updatedAt: Date.parse('2026-06-28T04:00:00Z') },
  { id: 's-may-1', workspaceId: 'w-beta', cwd: 'C:/work/beta', seed: 3, updatedAt: Date.parse('2026-05-12T04:00:00Z') },
  { id: 's-today', workspaceId: 'w-beta', cwd: 'C:/work/beta', seed: 4, updatedAt: Date.now() - 3600000 },
]
const WORKSPACES = [
  { id: 'w-alpha', title: 'Alpha', path: 'C:/work/alpha' },
  { id: 'w-beta', title: 'Beta', path: 'C:/work/beta' },
]
const OLD_IDS = FIXTURE.filter((row) => row.updatedAt < OLD_CUTOFF).map((row) => row.id).sort()

function contextEvent(seq, time, provider, model, turn, step) {
  return { seq, time, type: 'request/context', data: { provider, model, turn, step } }
}

function turnEndEvent(seq, time, turn) {
  return { seq, time, type: 'turn/end', data: { turn } }
}

function messageEvent(seq, time, turn, step, usage, provider, model) {
  return { seq, time, type: 'assistant/message', data: { turn, step, message: { source: { provider, model } }, usage } }
}

function chunkEvent(seq, time, turn, step, usage) {
  return { seq, time, type: 'assistant/chunk', data: { turn, step, chunk: { type: 'usage', usage } } }
}

// Two turns, three usage samples and two identities per session, the same log shape
// test/ledger-invariants.test.js folds: enough for a per-day, per-workspace and
// per-model total that is not just one bucket.
function sessionLog(id, cwd, seed) {
  // One fixture session per day, so the daily layer of the fold has more than one
  // bucket to compare before and after archiving.
  const start = BASE_TIME + seed * 26 * 3600000
  return {
    id,
    header: { cwd },
    events: [
      contextEvent(0, start, 'deepseek', 'deepseek-chat', 1, 1),
      turnEndEvent(1, start + 1000, 1),
      messageEvent(2, start + 2000, 1, 1, { inputTokens: 10 + seed, outputTokens: 2 }, 'deepseek', 'deepseek-chat'),
      chunkEvent(3, start + 3000, 1, 2, { inputTokens: 5, cacheReadTokens: 3 }),
      contextEvent(4, start + 4000, 'other', 'other-chat', 2, 1),
      messageEvent(5, start + 5000, 2, 1, { inputTokens: 7, outputTokens: 1 + seed, reasoningTokens: 2 }, 'other', 'other-chat'),
      turnEndEvent(6, start + 6000, 2),
    ],
  }
}

// Records as lib/ledger.js builds them, stamped into the month each one belongs to.
function fixtureRecords() {
  const builder = createInvariantHost().ledger
  return FIXTURE.map((row) => {
    const record = builder.buildLedgerRecord(sessionLog(row.id, row.cwd, row.seed), row.workspaceId, 'scan', 'rev')
    return { ...record, updatedAt: row.updatedAt }
  })
}

/** The dashboard fields a fold can influence. */
function payload(snapshot) {
  const fields = ['totals', 'perWorkspace', 'perModel', 'byDay', 'byDayUtc']
  return Object.fromEntries(fields.map((field) => [field, snapshot[field]]))
}

/** Fold records the way a start does and return the dashboard payload. */
function fold(host, records) {
  for (const meta of WORKSPACES) host.state.wsMeta.set(meta.id, meta)
  for (const record of records) host.ledger.applyLedgerRecord(record)
  return payload(host.aggregation.snapshot(false))
}

function treeDir(root, sessionId) {
  return join(root, ledgerShardUnitName(shardIndexOf(sessionId)), 'sessions')
}

async function treeIds(root) {
  const ids = []
  for (let index = 0; index < LEDGER_SHARD_COUNT; index += 1) {
    const dir = join(root, ledgerShardUnitName(index), 'sessions')
    for (const entry of await readdir(dir).catch(() => [])) {
      if (!entry.endsWith('.json') || entry.startsWith('__')) continue
      ids.push(entry.slice(0, -'.json'.length))
    }
  }
  return ids.sort()
}

// Seed the hot copy through lib/ledger.js itself, so the documents the archive
// reads are the documents a real start writes.
async function seedTree(root, records) {
  const backend = createLedgerBackend(root)
  const { host, ledger } = createInvariantHost({ backend: backend.backend })
  await ledger.loadLedger()
  for (const record of records) {
    ledger.storeLedgerRecord(record)
    ledger.applyLedgerRecord(record)
    await ledger.persistLedgerRecord(record)
  }
  await ledger.drainLedgerWrites()
  await host.state.ledgerUnit.close()
}

// The archive's view of the hot copy: the per-record trees, without a DSH storage
// backend (scripts/archive-ledger.mjs builds the same store). remove:false freezes
// the intermediate state where a month file is already on disk and its source
// document has not been deleted yet.
async function treeStore(root, { remove = true } = {}) {
  const dirs = []
  for (let index = 0; index < LEDGER_SHARD_COUNT; index += 1) dirs.push(join(root, ledgerShardUnitName(index), 'sessions'))
  const paths = new Map()
  return {
    async listKeys() {
      paths.clear()
      for (const dir of dirs) {
        for (const entry of await readdir(dir).catch(() => [])) {
          if (!entry.endsWith('.json') || entry.startsWith('__')) continue
          paths.set(entry.slice(0, -'.json'.length), join(dir, entry))
        }
      }
      return Array.from(paths.keys())
    },
    async readRecord(key) {
      const path = paths.get(key)
      if (path === undefined) return undefined
      const doc = JSON.parse(await readFile(path, 'utf8'))
      return doc.record
    },
    async deleteRecord(key, expected) {
      const path = paths.get(key)
      if (!remove || path === undefined) return false
      // Same optimistic rule as the real stores: re-read the document and remove it
      // only while it still holds the row that was archived.
      if (expected !== undefined) {
        if (expected === null || typeof expected !== 'object') return false
        let doc = null
        try { doc = JSON.parse(await readFile(path, 'utf8')) } catch (error) { return false }
        if (doc === null || typeof doc !== 'object' || doc.record === null || typeof doc.record !== 'object') return false
        if (doc.record.updatedAt !== expected.updatedAt) return false
        if (JSON.stringify(doc.record) !== JSON.stringify(expected)) return false
      }
      paths.delete(key)
      return rm(path).then(() => true, () => false)
    },
  }
}

async function coldStart(root) {
  const backend = createLedgerBackend(root)
  const fixture = createInvariantHost({ backend: backend.backend })
  await fixture.ledger.loadLedger()
  return fixture
}

// One row of one month file, as the read path would see it.
async function archivedRow(root, month, sessionId) {
  const text = gunzipSync(await readFile(join(root, 'archive', month + '.jsonl.gz'))).toString('utf8')
  for (const line of text.split(/[\r\n]+/)) {
    if (line === '') continue
    const row = JSON.parse(line)
    if (row.sessionId === sessionId) return row
  }
  return undefined
}

// A second fold of the same session that really records more: one extra turn with
// its own usage sample, so a stale copy is visible in the record, not only in a stamp.
function raceLog(id, cwd, seed, extraTurn) {
  const log = sessionLog(id, cwd, seed)
  if (!extraTurn) return log
  const start = BASE_TIME + seed * 26 * 3600000
  return {
    ...log,
    events: log.events.concat([
      contextEvent(7, start + 7000, 'deepseek', 'deepseek-chat', 3, 1),
      messageEvent(8, start + 8000, 3, 1, { inputTokens: 30, outputTokens: 4 }, 'deepseek', 'deepseek-chat'),
      turnEndEvent(9, start + 9000, 3),
    ]),
  }
}

async function restoredRecords(fixture, sessionIds) {
  const records = []
  for (const sessionId of sessionIds) records.push(await fixture.ledger.recordFor(sessionId))
  return records
}

async function archivedMonths(root) {
  return (await readdir(join(root, 'archive')).catch(() => [])).sort()
}

function quietWarnings() {
  const lines = []
  const original = console.warn
  console.warn = (...args) => { lines.push(args.map(String).join(' ')) }
  return { lines, restore() { console.warn = original } }
}

// node:fs/promises cannot be substituted, so both public entry points take an fs
// object. This wrapper counts the calls, which is how "a ledger without an archive
// pays one directory listing and nothing else" becomes a test instead of a claim.
async function countingFs() {
  const real = await import('node:fs/promises')
  const counts = new Map()
  const wrapped = {}
  for (const name of ['open', 'mkdir', 'readFile', 'readdir', 'rename', 'stat', 'unlink']) {
    wrapped[name] = (...args) => {
      counts.set(name, (counts.get(name) || 0) + 1)
      return real[name](...args)
    }
  }
  return { fs: wrapped, count: (name) => counts.get(name) || 0, total: () => [...counts.values()].reduce((sum, value) => sum + value, 0) }
}

test('archiving moves records out of the trees without moving a single number', async () => {
  const root = await createTempRoot()
  try {
    const records = fixtureRecords()
    await seedTree(root, records)
    const before = fold(createInvariantHost(), records)
    const result = await archiveRecords({ root, store: await treeStore(root), cutoffMs: OLD_CUTOFF })
    assert.deepEqual(result.errors, [])
    assert.deepEqual(result.months, ['2026-05', '2026-06'])
    assert.equal(result.archived, 3)
    assert.ok(result.bytes > 0)
    assert.deepEqual(await treeIds(root), ['s-today'], 'only the resident record keeps its document')

    // A cold start reads the same numbers out of the month files.
    const cold = await coldStart(root)
    for (const record of records) assert.equal(cold.state.ledgerKeys.has(record.sessionId), true, 'listKeys must include ' + record.sessionId)
    const restored = []
    for (const record of records) {
      const one = await cold.ledger.recordFor(record.sessionId)
      assert.ok(one !== undefined, 'recordFor must read back ' + record.sessionId)
      assert.equal(one.sessionId, record.sessionId)
      assert.equal(one.workspaceId, record.workspaceId)
      assert.equal(one.turns.length, record.turns.length)
      assert.deepEqual(one.usage.map((item) => item.values), record.usage.map((item) => item.values), 'usage keeps its shape')
      assert.deepEqual(one.usage.map((item) => item.workspaceId), record.usage.map((item) => item.workspaceId))
      restored.push(one)
    }
    assert.deepEqual(fold(cold, restored), before, 'the three totals may not move by one token')
  } finally {
    await removeTempRoot(root)
  }
})

test('a record in a month file and still in its tree is read once, from the tree', async () => {
  const root = await createTempRoot()
  try {
    const records = fixtureRecords()
    await seedTree(root, records)
    const before = fold(createInvariantHost(), records)
    // The window between "month file is on disk" and "source document is deleted".
    const result = await archiveRecords({ root, store: await treeStore(root, { remove: false }), cutoffMs: OLD_CUTOFF })
    assert.equal(result.archived, 3)
    assert.deepEqual(await treeIds(root), FIXTURE.map((row) => row.id).sort(), 'both copies exist')
    // The tree copy is the newer one: rewriting it with a later stamp must be what
    // readRecord() answers, or a retried write would be shadowed by its own archive.
    const target = 's-june-1'
    const newer = Date.parse('2026-06-30T00:00:00Z')
    const record = records.find((item) => item.sessionId === target)
    await writeFile(join(treeDir(root, target), target + '.json'), JSON.stringify({ version: 0, record: serializeLedgerRecord({ ...record, updatedAt: newer }) }), 'utf8')

    const cold = await coldStart(root)
    assert.deepEqual([...cold.state.ledgerKeys].sort(), FIXTURE.map((row) => row.id).sort(), 'one key per session, not one per copy')
    const restored = []
    for (const row of FIXTURE) restored.push(await cold.ledger.recordFor(row.id))
    assert.equal(restored.find((item) => item.sessionId === target).updatedAt, newer, 'the tree copy wins over the archived one')
    assert.deepEqual(fold(cold, restored), before, 'two copies are still one record')
  } finally {
    await removeTempRoot(root)
  }
})

test('a second run has nothing to do and rewrites no archive file', async () => {
  const root = await createTempRoot()
  try {
    await seedTree(root, fixtureRecords())
    const first = await archiveRecords({ root, store: await treeStore(root), cutoffMs: OLD_CUTOFF })
    assert.equal(first.archived, 3)
    const monthFile = join(root, 'archive', '2026-06.jsonl.gz')
    const before = { names: await archivedMonths(root), size: (await stat(monthFile)).size, mtime: (await stat(monthFile)).mtimeMs }
    const second = await archiveRecords({ root, store: await treeStore(root), cutoffMs: OLD_CUTOFF })
    assert.deepEqual({ months: second.months, archived: second.archived, bytes: second.bytes, errors: second.errors }, { months: [], archived: 0, bytes: 0, errors: [] })
    const after = { names: await archivedMonths(root), size: (await stat(monthFile)).size, mtime: (await stat(monthFile)).mtimeMs }
    assert.deepEqual(after, before, 'a no-op run may not touch a month file')
    assert.deepEqual(after.names, ['2026-05.jsonl.gz', '2026-05.keys.json.gz', '2026-06.jsonl.gz', '2026-06.keys.json.gz', 'manifest.json'], 'no staging file is left behind')
  } finally {
    await removeTempRoot(root)
  }
})

test('a damaged month is treated as missing while the readable months still load', async () => {
  const root = await createTempRoot()
  try {
    const records = fixtureRecords()
    await seedTree(root, records)
    await archiveRecords({ root, store: await treeStore(root), cutoffMs: OLD_CUTOFF })
    const damaged = join(root, 'archive', '2026-05.jsonl.gz')
    const garbage = 'this is not a gzip stream'
    await writeFile(damaged, garbage, 'utf8')

    const reader = await createArchiveReader(root)
    assert.ok(reader !== null)
    assert.deepEqual(reader.months, ['2026-05', '2026-06'], 'the damaged month is still listed, so a retry can repair it')
    const warnings = quietWarnings()
    try {
      assert.equal(await reader.readRecord('s-june-1').then((row) => row !== undefined), true, 'a readable month still answers')
      assert.equal(await reader.readRecord('s-may-1'), undefined, 'the damaged month answers nothing')
      assert.equal(await reader.readRecord('s-may-1'), undefined, 'and stays missing on the next read')
    } finally {
      warnings.restore()
    }
    assert.equal(warnings.lines.filter((line) => line.includes('unreadable')).length, 1, 'one warning per damaged month, not one per read')
    assert.equal(await readFile(damaged, 'utf8'), garbage, 'a damaged month is never rewritten or deleted')

    // Startup must survive it: no throw, and the readable months still fold.
    const coldWarnings = quietWarnings()
    let cold
    try {
      cold = await coldStart(root)
    } finally {
      coldWarnings.restore()
    }
    const healthy = records.filter((record) => record.sessionId !== 's-may-1')
    const restored = []
    for (const record of healthy) restored.push(await cold.ledger.recordFor(record.sessionId))
    assert.deepEqual(fold(cold, restored), fold(createInvariantHost(), healthy))
    const lateWarnings = quietWarnings()
    try {
      assert.equal(await cold.ledger.recordFor('s-may-1'), undefined, 'a session only the damaged month holds reads as missing')
    } finally {
      lateWarnings.restore()
    }
  } finally {
    await removeTempRoot(root)
  }
})

test('the archive CLI refuses to run without the maintenance lock', async () => {
  const root = await createTempRoot()
  try {
    await seedTree(root, fixtureRecords())
    await mkdir(join(root, 'all_usage_ledger.lock'))
    await writeFile(join(root, 'all_usage_ledger.lock', 'owner.json'), JSON.stringify({ pid: 4242, startedAt: Date.now(), host: 'other-host' }), 'utf8')
    const result = await run(process.execPath, [CLI, '--root', root, '--older-than-days', '30', '--apply'], { encoding: 'utf8' }).then(
      (out) => ({ code: 0, ...out }),
      (error) => ({ code: error.code, stdout: error.stdout || '', stderr: error.stderr || '' }),
    )
    assert.equal(result.code, 2, 'a lost lock is exit code 2')
    assert.match(result.stderr, /maintenance lock/)
    assert.deepEqual(await archivedMonths(root), [], 'nothing is written without the lock')
    assert.deepEqual(await treeIds(root), FIXTURE.map((row) => row.id).sort(), 'and nothing is deleted')
    assert.deepEqual(JSON.parse(await readFile(join(root, 'all_usage_ledger.lock', 'owner.json'), 'utf8')).pid, 4242, 'the foreign lock is left alone')
  } finally {
    await removeTempRoot(root)
  }
})

test('the archive CLI plans by default and writes only with --apply', async () => {
  const root = await createTempRoot()
  const records = fixtureRecords()
  try {
    await seedTree(root, records)
    const dry = await run(process.execPath, [CLI, '--root', root, '--older-than-days', '30'], { encoding: 'utf8' }).then(
      (out) => ({ code: 0, ...out }),
      (error) => ({ code: error.code, stdout: error.stdout || '', stderr: error.stderr || '' }),
    )
    assert.equal(dry.code, 0, dry.stderr)
    assert.match(dry.stdout, /dry run/)
    assert.match(dry.stdout, /records: 3/)
    assert.deepEqual(await archivedMonths(root), [], 'a dry run writes no archive directory at all')
    assert.deepEqual(await treeIds(root), FIXTURE.map((row) => row.id).sort())

    const applied = await run(process.execPath, [CLI, '--root', root, '--older-than-days', '30', '--apply'], { encoding: 'utf8' }).then(
      (out) => ({ code: 0, ...out }),
      (error) => ({ code: error.code, stdout: error.stdout || '', stderr: error.stderr || '' }),
    )
    assert.equal(applied.code, 0, applied.stderr)
    assert.match(applied.stdout, /records: 3/)
    assert.deepEqual(await archivedMonths(root), ['2026-05.jsonl.gz', '2026-05.keys.json.gz', '2026-06.jsonl.gz', '2026-06.keys.json.gz', 'manifest.json'])
    assert.deepEqual(await treeIds(root), ['s-today'], 'the resident record stays in its tree')

    // The month file is one JSON row per line, in the shape the ledger stores.
    const rows = gunzipSync(await readFile(join(root, 'archive', '2026-06.jsonl.gz'))).toString('utf8').trim().split(/[\r\n]+/).map((line) => JSON.parse(line))
    assert.deepEqual(rows.map((row) => row.sessionId).sort(), ['s-june-1', 's-june-2'])
    const originals = new Map(records.map((record) => [record.sessionId, record]))
    for (const row of rows) {
      const compact = serializeLedgerRecord(originals.get(row.sessionId))
      assert.deepEqual(row, compact, 'the archived row is the ledger row, not a re-shaped copy')
    }
    assert.deepEqual(JSON.parse(gunzipSync(await readFile(join(root, 'archive', '2026-06.keys.json.gz'))).toString('utf8')), ['s-june-1', 's-june-2'])
    const manifest = JSON.parse(await readFile(join(root, 'archive', 'manifest.json'), 'utf8'))
    assert.equal(manifest.version, 1)
    assert.deepEqual(Object.keys(manifest.months).sort(), ['2026-05', '2026-06'])
    assert.equal(manifest.months['2026-06'].records, 2)
    assert.equal(manifest.months['2026-06'].bytes, (await stat(join(root, 'archive', '2026-06.jsonl.gz'))).size)

    // A second CLI run is a no-op, an old month's archive is not rewritten.
    const again = await run(process.execPath, [CLI, '--root', root, '--older-than-days', '30', '--apply'], { encoding: 'utf8' }).then(
      (out) => ({ code: 0, ...out }),
      (error) => ({ code: error.code, stdout: error.stdout || '', stderr: error.stderr || '' }),
    )
    assert.equal(again.code, 0, again.stderr)
    assert.match(again.stdout, /nothing to archive/)
  } finally {
    await removeTempRoot(root)
  }
})

test('a ledger without an archive directory reads as before and pays one listing', async () => {
  const root = await createTempRoot()
  try {
    const records = fixtureRecords()
    await seedTree(root, records)
    const before = fold(createInvariantHost(), records)
    const counting = await countingFs()
    assert.equal(await createArchiveReader(root, { fs: counting.fs }), null, 'no archive directory means no reader')
    assert.equal(counting.count('readdir'), 1, 'one failed listing is the whole cost')
    assert.equal(counting.count('readFile') + counting.count('stat') + counting.count('open'), 0, 'nothing else is touched')

    const cold = await coldStart(root)
    assert.deepEqual([...cold.state.ledgerKeys].sort(), FIXTURE.map((row) => row.id).sort())
    const restored = await restoredRecords(cold, FIXTURE.map((row) => row.id))
    assert.deepEqual(fold(cold, restored), before)
  } finally {
    await removeTempRoot(root)
  }
})

// Runtime writes deliberately do not take the maintenance lock (a write must never
// wait on a migration), so a session can publish a newer revision between the moment
// the archive plans its key and the moment it deletes the document. The delete has to
// re-read and notice, or it would throw away the only copy of that revision.
test('a record rewritten between the plan and the delete keeps its tree document', async () => {
  const root = await createTempRoot()
  try {
    const sid = 's-race'
    const builder = createInvariantHost().ledger
    const rev5 = { ...builder.buildLedgerRecord(raceLog(sid, 'C:/work/beta', 5, false), 'w-beta', 'scan', 'rev-5'), updatedAt: Date.parse('2026-06-05T04:00:00Z') }
    const rev6 = { ...builder.buildLedgerRecord(raceLog(sid, 'C:/work/beta', 5, true), 'w-beta', 'scan', 'rev-6'), updatedAt: Date.parse('2026-06-20T04:00:00Z') }
    assert.equal(rev6.usage.length, rev5.usage.length + 1, 'rev6 has to carry usage rev5 does not')
    await seedTree(root, [rev5])
    const doc = join(treeDir(root, sid), sid + '.json')
    const planned = JSON.parse(await readFile(doc, 'utf8')).record

    const cold = await coldStart(root)
    // The live write lands after the planning read and before the delete.
    await writeFile(doc, JSON.stringify({ version: 0, record: serializeLedgerRecord(rev6) }), 'utf8')

    // The store the ledger exports refuses on its own: the document no longer holds
    // the row that was archived.
    assert.equal(await cold.state.ledgerUnit.deleteRecord(sid, planned), false)
    assert.equal((await treeIds(root)).includes(sid), true, 'the newer revision keeps its document')
    const restored = await cold.ledger.recordFor(sid)
    assert.equal(restored.updatedAt, rev6.updatedAt, 'the read path answers with the revision in the tree')
    assert.equal(restored.usage.length, rev6.usage.length)

    // The same interleaving through a whole run: the plan read answers rev5 while
    // the document on disk already holds rev6.
    const plain = await treeStore(root)
    const racing = {
      listKeys: () => plain.listKeys(),
      readRecord: async (key) => (key === sid ? planned : plain.readRecord(key)),
      deleteRecord: (key, expected) => plain.deleteRecord(key, expected),
    }
    const first = await archiveRecords({ root, store: racing, cutoffMs: OLD_CUTOFF })
    assert.deepEqual(first.errors, [])
    assert.equal(first.archived, 1)
    assert.deepEqual(await treeIds(root), [sid], 'the newer revision still sits in its tree')
    assert.equal((await archivedRow(root, '2026-06', sid)).updatedAt, rev5.updatedAt, 'the archive holds the revision it planned')
    const fresh = await coldStart(root)
    assert.equal((await fresh.ledger.recordFor(sid)).updatedAt, rev6.updatedAt, 'and a cold read still prefers the tree')

    // The next run files rev6 and only then removes the document.
    const second = await archiveRecords({ root, store: await treeStore(root), cutoffMs: OLD_CUTOFF })
    assert.deepEqual(second.errors, [])
    assert.equal(second.archived, 1)
    assert.deepEqual(await treeIds(root), [], 'the document leaves once the archive holds its revision')
    const filed = await archivedRow(root, '2026-06', sid)
    assert.equal(filed.updatedAt, rev6.updatedAt, 'the archive caught up to rev6')
    assert.equal(filed.usage.length, rev6.usage.length)
    const archivedOnly = await coldStart(root)
    assert.equal((await archivedOnly.ledger.recordFor(sid)).usage.length, rev6.usage.length, 'a cold read now folds rev6 from the archive')
  } finally {
    await removeTempRoot(root)
  }
})

test('the reader decompresses a month at most once, and only when asked', async () => {
  const root = await createTempRoot()
  try {
    await seedTree(root, fixtureRecords())
    await archiveRecords({ root, store: await treeStore(root), cutoffMs: OLD_CUTOFF })
    const counting = await countingFs()
    const reader = await createArchiveReader(root, { fs: counting.fs })
    assert.deepEqual(reader.months, ['2026-05', '2026-06'])
    // Construction reads the two key indexes and nothing else: the month files are
    // lazy until a row is actually requested.
    assert.deepEqual([counting.count('readdir'), counting.count('readFile')], [1, 2])
    assert.equal(counting.count('open') + counting.count('stat') + counting.count('rename') + counting.count('unlink') + counting.count('mkdir'), 0)
    const keys = reader.keys()
    for (const id of OLD_IDS) assert.equal(keys.has(id), true, 'listKeys is answered by the key index: ' + id)
    assert.equal(keys.has('s-today'), false)
    assert.equal(counting.count('readFile'), 2, 'keys() decompresses nothing')
    assert.equal((await reader.readRecord('s-may-1')).sessionId, 's-may-1')
    assert.equal(counting.count('readFile'), 3, 'the first read loads that month')
    assert.equal((await reader.readRecord('s-june-1')).sessionId, 's-june-1')
    assert.equal((await reader.readRecord('s-june-2')).sessionId, 's-june-2')
    assert.equal(counting.count('readFile'), 4, 'the second row of the same month is already resident')
    assert.equal(await reader.readRecord('s-today'), undefined, 'a key the index never saw costs no read')
    assert.equal(counting.count('readFile'), 4)
  } finally {
    await removeTempRoot(root)
  }
})
