import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, writeFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { archiveRecords, createArchiveReader } from '../lib/archive.js'
import { withLedgerRecordLock } from '../lib/ledger.js'
import {
  createInvariantHost,
  createLedgerBackend,
  createTempRoot,
  ledgerShardUnitName,
  removeTempRoot,
  shardIndexOf,
} from './support/ledger-invariants.js'

const OLD_TIME = Date.parse('2026-06-05T04:00:00Z')
const CUTOFF = Date.parse('2026-09-01T00:00:00Z')
const LEDGER_MODULE_URL = new URL('../lib/ledger.js', import.meta.url).href
const CLI_PATH = fileURLToPath(new URL('../scripts/archive-ledger.mjs', import.meta.url))

// Publish synchronously at the backend boundary so each fixture row is visible on
// disk before the awaiting caller resumes. The ledger and archive are the real modules.
async function openFixture(root) {
  const storage = createLedgerBackend(root)
  const open = storage.backend.kv.open
  storage.backend.kv.open = async (descriptor) => {
    const unit = await open(descriptor)
    if (typeof unit.tableDir !== 'function') return unit
    return {
      ...unit,
      async putRecord(table, key, value) {
        const dir = unit.tableDir(table)
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, key + '.json'), JSON.stringify({ version: 0, record: value }), 'utf8')
      },
    }
  }
  const fixture = createInvariantHost({ backend: storage.backend })
  await fixture.ledger.loadLedger()
  return { ...fixture, storage }
}

// A separate Node process holds the shared file lock until told to publish a newer
// raw row, then exits so the waiting archive can take the same lock.
function startHeldWriter(root, sid, record) {
  const source = [
    'import { writeFile } from "node:fs/promises"',
    'import { join } from "node:path"',
    'import { withLedgerRecordLock } from ' + JSON.stringify(LEDGER_MODULE_URL),
    'const [root, sid, encoded] = process.argv.slice(1)',
    'const record = JSON.parse(encoded)',
    'const shard = [...sid].reduce((hash, char) => Math.imul(hash ^ char.charCodeAt(0), 16777619), 2166136261) >>> 0',
    'const dir = join(root, "all_usage_ledger_" + String(shard % 32).padStart(2, "0"), "sessions")',
    'const path = join(dir, sid + ".json")',
    'const result = await withLedgerRecordLock(root, sid, async () => {',
    '  process.stdout.write("LOCKED\\n")',
    '  await new Promise((resolve) => process.stdin.once("data", resolve))',
    '  await writeFile(path, JSON.stringify({ version: 0, record }), "utf8")',
    '})',
    'if (!result.acquired) throw new Error("record lock was not acquired")',
    'process.stdout.write("DONE\\n")',
  ].join('\n')
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, root, sid, JSON.stringify(record)], { stdio: ['pipe', 'pipe', 'pipe'] })
  const lines = []
  const waiters = []
  let stderr = ''
  let closed = null
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    for (const line of chunk.split(/\r?\n/)) {
      if (line === '') continue
      const waiter = waiters.shift()
      if (waiter === undefined) lines.push(line)
      else waiter.resolve(line)
    }
  })
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
  child.once('close', (code, signal) => {
    closed = { code, signal }
    for (const waiter of waiters.splice(0)) waiter.reject(new Error('child exited before marker; ' + JSON.stringify(closed) + '; stderr=' + stderr))
  })
  return {
    child,
    async nextLine() {
      if (lines.length > 0) return lines.shift()
      if (closed !== null) throw new Error('child exited before marker; ' + JSON.stringify(closed) + '; stderr=' + stderr)
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }))
    },
    release() { child.stdin.end('write-and-release\n') },
    async finish() {
      const { code, signal } = closed === null ? await once(child, 'close').then(([code, signal]) => ({ code, signal })) : closed
      assert.equal(code, 0, 'child exit; signal=' + signal + '; stderr=' + stderr)
    },
    async stop() {
      if (closed === null) {
        child.kill()
        await once(child, 'close')
      }
    },
  }
}

function delayed() {
  return new Promise((resolve) => setImmediate(resolve))
}

async function awaitArchiveRow(root, sid, expected) {
  for (let attempt = 0; attempt < 5000; attempt += 1) {
    const reader = await createArchiveReader(root)
    if (reader !== null && JSON.stringify(await reader.readRecord(sid)) === JSON.stringify(expected)) return
    await delayed()
  }
  assert.fail('archive did not publish the planned row before the process barrier')
}

for (const sameStamp of [false, true]) {
  test('archive deletion preserves a cross-process write after planning' + (sameStamp ? ' with the same timestamp' : ''), async (t) => {
    const root = await createTempRoot()
    let fixture
    let writer
    try {
      fixture = await openFixture(root)
      const sid = 's-delete-race'
      const original = {
        version: 3, sessionId: sid, workspaceId: 'w-original', sourceCwd: 'G:/fixture/original',
        lastSeq: 1, source: 'scan', updatedAt: OLD_TIME, lastRevision: 'rev-1', turns: [], usage: [],
      }
      const next = { ...original, lastSeq: 2, lastRevision: 'rev-2', updatedAt: sameStamp ? OLD_TIME : OLD_TIME + 1000 }
      const unit = fixture.state.ledgerUnit
      await unit.putRecord('sessions', sid, original)
      writer = startHeldWriter(root, sid, next)
      assert.equal(await writer.nextLine(), 'LOCKED')
      const deleteStarted = Promise.withResolvers()
      const tree = unit.treeStore()
      const store = {
        listKeys: () => tree.listKeys(),
        readRecord: (key) => tree.readRecord(key),
        deleteRecord(key, expected) {
          deleteStarted.resolve()
          return tree.deleteRecord(key, expected)
        },
      }
      const archive = archiveRecords({ root, store, cutoffMs: CUTOFF })
      await deleteStarted.promise
      writer.release()
      assert.equal(await writer.nextLine(), 'DONE')
      await writer.finish()
      const outcome = await archive
      assert.deepEqual(outcome.errors, [])
      const cold = await createArchiveReader(root)
      assert.deepEqual(await cold.readRecord(sid), original, 'the archive contains the planned revision')
      const raw = await fixture.storage.readDoc(sid)
      assert.deepEqual(raw, { version: 0, record: next }, 'the newer raw tree row remains before any query or reload')
      assert.equal((await unit.readRecord(sid)).sourceCwd, original.sourceCwd)
    } finally {
      if (writer !== undefined) await writer.stop()
      if (fixture !== undefined) await fixture.state.ledgerUnit.close()
      await removeTempRoot(root)
    }
  })
}

test('runtime record writes wait on the same cross-process key lock', async (t) => {
  const root = await createTempRoot()
  let fixture
  let writer
  try {
    fixture = await openFixture(root)
    const sid = 's-runtime-lock'
    const record = { version: 3, sessionId: sid, workspaceId: 'w', updatedAt: OLD_TIME, turns: [], usage: [] }
    const next = { ...record, lastSeq: 3 }
    await fixture.state.ledgerUnit.putRecord('sessions', sid, record)
    writer = startHeldWriter(root, sid, next)
    assert.equal(await writer.nextLine(), 'LOCKED')
    const attempted = Promise.withResolvers()
    const realMkdir = fs.mkdir
    t.mock.method(fs, 'mkdir', async (path, options) => {
      if (options?.recursive !== true && String(path).includes('.record-locks')) attempted.resolve()
      return realMkdir(path, options)
    })
    syncBuiltinESMExports()
    let completed = false
    const pending = fixture.state.ledgerUnit.putRecord('sessions', sid, record).then(() => { completed = true })
    await Promise.race([attempted.promise, pending])
    assert.equal(completed, false, 'runtime put reaches and waits at the held key lock')
    const other = await withLedgerRecordLock(root, 's-another-key', async () => 'independent')
    assert.deepEqual(other, { acquired: true, value: 'independent' }, 'different keys do not share a lock')
    writer.release()
    assert.equal(await writer.nextLine(), 'DONE')
    await writer.finish()
    await pending
    assert.deepEqual(await fixture.storage.readDoc(sid), { version: 0, record })
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
    if (writer !== undefined) await writer.stop()
    if (fixture !== undefined) await fixture.state.ledgerUnit.close()
    await removeTempRoot(root)
  }
})

test('archive CLI shares the runtime per-record lock before its final delete', async (t) => {
  const root = await createTempRoot()
  let fixture
  let writer
  let cli
  let cliOutput = ''
  let cliError = ''
  try {
    fixture = await openFixture(root)
    const sid = 's-cli-lock'
    const original = { version: 3, sessionId: sid, workspaceId: 'w', updatedAt: OLD_TIME, turns: [], usage: [] }
    const next = { ...original, lastSeq: 4, updatedAt: OLD_TIME + 5000 }
    await fixture.state.ledgerUnit.putRecord('sessions', sid, original)
    writer = startHeldWriter(root, sid, next)
    assert.equal(await writer.nextLine(), 'LOCKED')
    cli = spawn(process.execPath, [CLI_PATH, '--root', root, '--older-than-days', '0', '--apply'], { stdio: ['ignore', 'pipe', 'pipe'] })
    cli.stdout.setEncoding('utf8').on('data', (chunk) => { cliOutput += chunk })
    cli.stderr.setEncoding('utf8').on('data', (chunk) => { cliError += chunk })
    await awaitArchiveRow(root, sid, original)
    writer.release()
    assert.equal(await writer.nextLine(), 'DONE')
    await writer.finish()
    const [code, signal] = await once(cli, 'close')
    assert.equal(code, 0, 'CLI exit; signal=' + signal + '; stderr=' + cliError + '; stdout=' + cliOutput)
    const raw = await fixture.storage.readDoc(sid)
    assert.deepEqual(raw, { version: 0, record: next }, 'CLI rereads under the shared key lock and keeps the newer row')
    const cold = await createArchiveReader(root)
    assert.deepEqual(await cold.readRecord(sid), original)
  } finally {
    if (writer !== undefined) await writer.stop()
    if (cli !== undefined && cli.exitCode === null) {
      cli.kill()
      await once(cli, 'close')
    }
    if (fixture !== undefined) await fixture.state.ledgerUnit.close()
    await removeTempRoot(root)
  }
})


test('record lock releases its owner after the protected callback fails', async () => {
  const root = await createTempRoot()
  try {
    await assert.rejects(withLedgerRecordLock(root, 's-error', async () => { throw new Error('record operation failed') }), /record operation failed/)
    const retry = await withLedgerRecordLock(root, 's-error', async () => 'recovered')
    assert.deepEqual(retry, { acquired: true, value: 'recovered' })
  } finally {
    await removeTempRoot(root)
  }
})

for (const sameStamp of [false, true]) {
  test('archive final unlink excludes a concurrent runtime write' + (sameStamp ? ' with the same timestamp' : ''), async (t) => {
    const root = await createTempRoot()
    let fixture
    let pendingWrite
    try {
      fixture = await openFixture(root)
      const sid = 's-final-unlink'
      const original = { version: 3, sessionId: sid, workspaceId: 'w', lastRevision: 'rev-1', updatedAt: OLD_TIME, turns: [], usage: [] }
      const next = { ...original, lastRevision: 'rev-2', updatedAt: sameStamp ? OLD_TIME : OLD_TIME + 1 }
      const unit = fixture.state.ledgerUnit
      const path = join(root, ledgerShardUnitName(shardIndexOf(sid)), 'sessions', sid + '.json')
      await unit.putRecord('sessions', sid, original)
      const realUnlink = fs.unlink
      const realMkdir = fs.mkdir
      const attempted = Promise.withResolvers()
      const order = []
      let submitting = false
      let completed = false
      t.mock.method(fs, 'mkdir', async (target, options) => {
        if (submitting && options?.recursive !== true && String(target).includes('.record-locks')) attempted.resolve()
        return realMkdir(target, options)
      })
      t.mock.method(fs, 'unlink', async (target) => {
        if (target !== path) return realUnlink(target)
        order.push('delete-compared')
        submitting = true
        pendingWrite = unit.putRecord('sessions', sid, next).then(() => {
          completed = true
          order.push('write-completed')
        })
        await Promise.race([attempted.promise, pendingWrite])
        assert.equal(completed, false, 'the later write waits inside the final compare/unlink boundary')
        order.push('write-waiting')
        const outcome = await realUnlink(target)
        order.push('unlink-completed')
        return outcome
      })
      syncBuiltinESMExports()
      const outcome = await archiveRecords({ root, store: unit.treeStore(), cutoffMs: CUTOFF })
      await pendingWrite
      assert.deepEqual(outcome.errors, [])
      assert.deepEqual(order, ['delete-compared', 'write-waiting', 'unlink-completed', 'write-completed'])
      assert.deepEqual(await fixture.storage.readDoc(sid), { version: 0, record: next }, 'new raw bytes survive without a query or reload')
      assert.deepEqual(await (await createArchiveReader(root)).readRecord(sid), original)
    } finally {
      t.mock.restoreAll()
      syncBuiltinESMExports()
      if (pendingWrite !== undefined) await pendingWrite
      if (fixture !== undefined) await fixture.state.ledgerUnit.close()
      await removeTempRoot(root)
    }
  })
}

test('record-lock timeout keeps queued writes dirty and permits a later retry', async (t) => {
  const root = await createTempRoot()
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  let fixture
  let held
  try {
    fixture = await openFixture(root)
    const sid = 's-timeout'
    const original = { version: 3, sessionId: sid, workspaceId: 'w', lastSeq: 1, updatedAt: OLD_TIME, turns: [], usage: [] }
    const next = { ...original, lastSeq: 2, updatedAt: OLD_TIME + 1 }
    await fixture.state.ledgerUnit.putRecord('sessions', sid, original)
    held = withLedgerRecordLock(root, sid, async () => { entered.resolve(); await release.promise })
    await entered.promise
    let tick = 0
    const clock = t.mock.method(performance, 'now', () => tick++ * 6000)
    await assert.rejects(fixture.state.ledgerUnit.putRecord('sessions', sid, next), { code: 'ELEDGERLOCK' })
    const logged = []
    t.mock.method(console, 'error', (...args) => logged.push(args))
    fixture.ledger.storeLedgerRecord(next)
    const pending = fixture.ledger.persistLedgerRecord(next)
    await fixture.ledger.drainLedgerWrites()
    await pending
    assert.equal(fixture.state.ledgerDirtySessions.has(sid), true)
    assert.equal(fixture.state.ledgerWriteFailedSessions.has(sid), true)
    assert.equal(fixture.state.ledgerWriting.has(sid), false)
    assert.equal(logged.some((args) => args[1]?.code === 'ELEDGERLOCK'), true)
    assert.deepEqual(await fixture.storage.readDoc(sid), { version: 0, record: original })
    clock.mock.restore()
    release.resolve()
    await held
    const retry = fixture.ledger.persistLedgerRecord(next)
    await fixture.ledger.drainLedgerWrites()
    await retry
    assert.equal(fixture.state.ledgerWriteFailedSessions.has(sid), false)
    assert.equal((await fixture.storage.readDoc(sid)).record.lastSeq, 2)
  } finally {
    release.resolve()
    if (held !== undefined) await held
    t.mock.restoreAll()
    if (fixture !== undefined) await fixture.state.ledgerUnit.close()
    await removeTempRoot(root)
  }
})

test('record lock cleans a partially written owner document after acquisition fails', async (t) => {
  const root = await createTempRoot()
  const realWriteFile = fs.writeFile
  let fail = true
  try {
    t.mock.method(fs, 'writeFile', async (path, value, options) => {
      if (fail && String(path).endsWith('owner.json')) {
        fail = false
        await realWriteFile(path, value, options)
        throw Object.assign(new Error('owner write failed after partial output'), { code: 'EIO' })
      }
      return realWriteFile(path, value, options)
    })
    syncBuiltinESMExports()
    let entered = false
    await assert.rejects(withLedgerRecordLock(root, 's-owner-error', async () => { entered = true }), { code: 'EIO' })
    assert.equal(entered, false)
    assert.deepEqual(await fs.readdir(join(root, 'all_usage_ledger.record-locks')), [], 'failed acquisition removes its own owner and directory')
    assert.deepEqual(await withLedgerRecordLock(root, 's-owner-error', async () => 'retry'), { acquired: true, value: 'retry' })
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
    await removeTempRoot(root)
  }
})

test('record release preserves a replacement owner with the same PID and timestamp', async () => {
  const root = await createTempRoot()
  let replaced
  try {
    const result = await withLedgerRecordLock(root, 's-owner-token', async (handle) => {
      replaced = { ...handle, owner: { ...handle.owner, token: 'replacement-owner' } }
      await fs.writeFile(handle.ownerFile, JSON.stringify(replaced.owner), 'utf8')
      return 'done'
    })
    assert.deepEqual(result, { acquired: true, value: 'done' })
    assert.deepEqual(JSON.parse(await fs.readFile(replaced.ownerFile, 'utf8')), replaced.owner)
  } finally {
    await removeTempRoot(root)
  }
})

test('record lock reclaims a dead same-host owner immediately', async (t) => {
  const root = await createTempRoot()
  let ownerFile
  try {
    await withLedgerRecordLock(root, 's-dead-owner', async (handle) => {
      ownerFile = handle.ownerFile
      await fs.writeFile(ownerFile, JSON.stringify({ ...handle.owner, host: hostname(), pid: 2147483000 }), 'utf8')
    })
    const realKill = process.kill
    t.mock.method(process, 'kill', (pid, signal) => {
      if (pid === 2147483000 && signal === 0) throw Object.assign(new Error('process exited'), { code: 'ESRCH' })
      return realKill(pid, signal)
    })
    assert.deepEqual(await withLedgerRecordLock(root, 's-dead-owner', async () => 'recovered'), { acquired: true, value: 'recovered' })
    await assert.rejects(fs.stat(ownerFile), { code: 'ENOENT' })
  } finally {
    t.mock.restoreAll()
    await removeTempRoot(root)
  }
})

test('record lock aliases share one key while different roots remain independent', async (t) => {
  const root = await createTempRoot()
  const release = Promise.withResolvers()
  const entered = Promise.withResolvers()
  let held
  try {
    held = withLedgerRecordLock(root, 's-root-alias', async () => { entered.resolve(); await release.promise })
    await entered.promise
    const aliasRoot = process.platform === 'win32' ? (root + '/.').toUpperCase() : root + '/.'
    const aliasKey = process.platform === 'win32' ? 'S-ROOT-ALIAS' : 's-root-alias'
    let tick = 0
    const clock = t.mock.method(performance, 'now', () => tick++ * 6000)
    const blocked = await withLedgerRecordLock(aliasRoot, aliasKey, async () => assert.fail('alias acquired a second lock'))
    assert.deepEqual(blocked, { acquired: false })
    clock.mock.restore()
    const other = await withLedgerRecordLock(join(root, 'independent-root'), 's-root-alias', async () => 'independent')
    assert.deepEqual(other, { acquired: true, value: 'independent' })
  } finally {
    release.resolve()
    if (held !== undefined) await held
    t.mock.restoreAll()
    await removeTempRoot(root)
  }
})

test('record acquisition releases its reservation when the shared deadline expires before callback', async (t) => {
  const root = await createTempRoot()
  const realReadFile = fs.readFile
  let clock = 0
  let expire = true
  try {
    t.mock.method(performance, 'now', () => clock)
    t.mock.method(fs, 'readFile', async (path, options) => {
      const raw = await realReadFile(path, options)
      if (expire && String(path).endsWith('owner.json')) clock = 5001
      return raw
    })
    syncBuiltinESMExports()
    let entered = false
    const result = await withLedgerRecordLock(root, 's-expired-at-acquire', async () => { entered = true })
    assert.deepEqual(result, { acquired: false }, 'time spent acquiring belongs to the same five-second deadline')
    assert.equal(entered, false)
    assert.deepEqual(await fs.readdir(join(root, 'all_usage_ledger.record-locks')), [], 'an expired attempt leaves no live-PID reservation')
    expire = false
    clock = 0
    assert.deepEqual(await withLedgerRecordLock(root, 's-expired-at-acquire', async () => 'retry'), { acquired: true, value: 'retry' })
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
    await removeTempRoot(root)
  }
})

test('record writers receive a cleanup I/O error and publish their bound claim completion', async (t) => {
  const root = await createTempRoot()
  const realUnlink = fs.unlink
  let held
  let releasing = false
  try {
    t.mock.method(fs, 'unlink', async (path) => {
      if (releasing && path === held.ownerFile) throw Object.assign(new Error('owner cleanup failed'), { code: 'EIO' })
      return realUnlink(path)
    })
    syncBuiltinESMExports()
    await assert.rejects(withLedgerRecordLock(root, 's-cleanup-io-error', async (handle) => { held = handle; releasing = true; return 'written' }), { code: 'EIO' })
    releasing = false
    await assert.rejects(fs.stat(held.claimFile), { code: 'ENOENT' })
    assert.deepEqual(JSON.parse(await fs.readFile(held.ownerFile, 'utf8')), held.owner)
    assert.deepEqual(await withLedgerRecordLock(root, 's-cleanup-io-error', async () => 'recovered'), { acquired: true, value: 'recovered' })
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
    await removeTempRoot(root)
  }
})

test('a truly truncated owner recovers by its own age despite repeated claim churn', async (t) => {
  const root = await createTempRoot()
  const realWriteFile = fs.writeFile
  const baseTime = Date.now()
  let clock = baseTime
  let perfReads = 0
  let allowAcquire = false
  let fail = true
  let ownerFile
  try {
    t.mock.method(Date, 'now', () => clock)
    t.mock.method(fs, 'writeFile', async (path, value, options) => {
      if (fail && String(path).endsWith('owner.json')) {
        fail = false
        ownerFile = path
        await realWriteFile(path, String(value).slice(0, 15), options)
        throw Object.assign(new Error('owner write stopped after fifteen characters'), { code: 'EIO' })
      }
      return realWriteFile(path, value, options)
    })
    syncBuiltinESMExports()
    await assert.rejects(withLedgerRecordLock(root, 's-truncated-owner', async () => assert.fail('partial owner must not enter')), { code: 'EIO' })
    assert.equal((await fs.readFile(ownerFile, 'utf8')).length, 15)
    await fs.utimes(ownerFile, new Date(baseTime), new Date(baseTime))
    t.mock.method(performance, 'now', () => allowAcquire || perfReads++ < 3 ? 0 : 6000)
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      clock = baseTime + attempt * 5000
      perfReads = 0
      assert.deepEqual(await withLedgerRecordLock(root, 's-truncated-owner', async () => assert.fail('partial owner is still within its thirty-second recovery age')), { acquired: false })
      assert.equal((await fs.readFile(ownerFile, 'utf8')).length, 15)
    }
    clock = baseTime + 35000
    allowAcquire = true
    assert.deepEqual(await withLedgerRecordLock(root, 's-truncated-owner', async () => 'recovered'), { acquired: true, value: 'recovered' })
    await assert.rejects(fs.stat(ownerFile), { code: 'ENOENT' })
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
    await removeTempRoot(root)
  }
})
