#!/usr/bin/env node
// Cold-archives the usage ledger.
//
// node scripts/archive-ledger.mjs --root <dir> [--older-than-days 90] [--apply]
//
// Every session record whose updatedAt is older than the cutoff is folded into
// <root>/archive/<YYYY-MM>.jsonl.gz; only after that month's record file, its key
// index and the manifest are on disk is the per-record document removed. The
// default is a dry run that prints the plan and writes nothing at all.
//
// The whole run happens behind the ledger's maintenance lock. Losing that race is
// not an error to retry blindly: another process is migrating or archiving the same
// root, so this command exits 2 without touching a single file.
import { readFile, readdir, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { archiveRecords } from '../lib/archive.js'
import { withLedgerMaintenanceLock } from '../lib/ledger.js'

const USAGE = 'usage: node scripts/archive-ledger.mjs --root <dir> [--older-than-days 90] [--apply]'
const DEFAULT_DAYS = 90
const DAY_MS = 86400000
// The per-record trees the ledger keeps next to the archive. The legacy whole-unit
// files (all_usage_ledger_NN.json) are not trees and are left alone: the ledger
// retires them itself once the trees hold their rows.
const SHARD_DIR_PATTERN = /^all_usage_ledger_\d{2}$/

function parseArgs(argv) {
  const options = { root: '', days: DEFAULT_DAYS, apply: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--apply') { options.apply = true; continue }
    if (arg === '--help' || arg === '-h') return null
    const equals = arg.indexOf('=')
    const name = equals === -1 ? arg : arg.slice(0, equals)
    if (name !== '--root' && name !== '--older-than-days') throw new Error('unknown argument: ' + arg)
    let value
    if (equals !== -1) value = arg.slice(equals + 1)
    else {
      value = argv[index + 1]
      if (value === undefined) throw new Error('missing value for ' + name)
      index += 1
    }
    if (name === '--root') { options.root = value; continue }
    const days = Number(value)
    if (!Number.isFinite(days) || days < 0) throw new Error('--older-than-days must be a non-negative number of days')
    options.days = days
  }
  if (options.root === '') throw new Error('--root is required')
  return options
}

// The ledger's hot copy without a DSH storage backend: the per-record trees under
// <root>/all_usage_ledger_NN/sessions. The shard a session hashes to is not
// recomputed here - one listing of every tree answers listKeys() and readRecord()
// together, and a document can only sit in the tree it was found in.
async function openTreeStore(root) {
  const trees = []
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory() && SHARD_DIR_PATTERN.test(entry.name)) trees.push(join(root, entry.name, 'sessions'))
  }
  const paths = new Map()
  async function index() {
    paths.clear()
    for (const dir of trees) {
      for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name.startsWith('__')) continue
        paths.set(entry.name.slice(0, -'.json'.length), join(dir, entry.name))
      }
    }
  }
  return {
    async listKeys() {
      await index()
      return Array.from(paths.keys())
    },
    async readRecord(key) {
      const path = paths.get(key)
      if (path === undefined) return undefined
      const doc = JSON.parse(await readFile(path, 'utf8'))
      if (doc === null || typeof doc !== 'object' || doc.version !== 0 || doc.record === undefined) return undefined
      return doc.record
    },
    async deleteRecord(key, expected) {
      const path = paths.get(key)
      if (path === undefined) return false
      // Same optimistic check as the ledger's own store: a session that published a
      // newer revision while this run was planning keeps its document, and the next
      // run archives that revision instead of losing it.
      if (expected !== undefined) {
        if (expected === null || typeof expected !== 'object') return false
        let doc = null
        try { doc = JSON.parse(await readFile(path, 'utf8')) } catch (error) { return false }
        if (doc === null || typeof doc !== 'object' || doc.record === null || typeof doc.record !== 'object') return false
        if (doc.record.updatedAt !== expected.updatedAt) return false
        if (JSON.stringify(doc.record) !== JSON.stringify(expected)) return false
      }
      paths.delete(key)
      return unlink(path).then(() => true, () => false)
    },
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB'
}

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error('archive-ledger: ' + error.message)
    console.error(USAGE)
    return 2
  }
  if (options === null) {
    console.log(USAGE)
    return 0
  }
  const root = resolve(options.root)
  const cutoffMs = Date.now() - options.days * DAY_MS
  const mode = options.apply ? 'apply' : 'dry run (pass --apply to write)'
  console.log('all-usage ledger archive')
  console.log('  root:   ' + root)
  console.log('  cutoff: ' + new Date(cutoffMs).toISOString() + ' (' + options.days + ' days old or older)')
  console.log('  mode:   ' + mode)
  const store = await openTreeStore(root)
  try {
    const outcome = await withLedgerMaintenanceLock(root, () => archiveRecords({ root, store, cutoffMs, dryRun: !options.apply }))
    if (!outcome.acquired) {
      console.error('[all-usage] another process holds the maintenance lock in ' + root + ': nothing was written')
      return 2
    }
    const result = outcome.value
    if (result.months.length === 0 && result.archived === 0) {
      console.log('  nothing to archive: no record is older than the cutoff')
      return 0
    }
    console.log('  months:  ' + result.months.join(', '))
    console.log('  records: ' + result.archived)
    console.log('  bytes:   ' + formatBytes(result.bytes) + ' of records' + (options.apply ? ' -> ' + formatBytes(result.compressed) + ' of month files' : ''))
    if (result.errors.length > 0) {
      for (const error of result.errors) console.error('[all-usage] archive failed for ' + (error.month === undefined ? error.key : error.month) + ': ' + error.message)
      console.error('[all-usage] ' + result.errors.length + ' record group(s) stayed in the ledger trees')
      return 1
    }
    return 0
  } catch (error) {
    console.error('[all-usage] archive-ledger failed: ' + (error && error.stack ? error.stack : error))
    return 1
  }
}

process.exitCode = await main()
