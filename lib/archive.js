// Cold storage for usage ledger records.
//
// The per-record trees (<root>/all_usage_ledger_NN/sessions/<id>.json) are the hot
// copy of the ledger: a write publishes one document, a query reads back only the
// documents it asks for. A session nobody has touched for months still costs a
// document and a directory entry, and that is the cost this module buys back.
//
// A cold record is folded into <root>/archive/<YYYY-MM>.jsonl.gz, one compact row
// per line (the exact shape serializeLedgerRecord() writes to the trees), and only
// then is its document removed. Whole records are stored, never aggregates: the
// read path can put a row back through the same fold that produced it, so the
// archive cannot disagree with the tree about a single token.
//
//   archive/<YYYY-MM>.jsonl.gz       the month's records, one JSON document per line
//   archive/<YYYY-MM>.keys.json.gz   that month's session ids (the listKeys index)
//   archive/manifest.json            {version: 1, months: {...}} - a description only
//
// A month is decided by record.updatedAt in UTC, so a record always lands in the
// same file however the machine's time zone moves.
//
// Durability order, per month: record file, key index, manifest, source documents.
// Every one of the first three is written as <name>.tmp, fsynced, closed and then
// renamed over its target, so a reader never sees a half-written file. The tree
// documents are unlinked only once all three are in place; a failure in any layer
// leaves the record in the tree as well. That is the one state the read path has to
// tolerate - it prefers the tree, so the record is still folded once, and the next
// archive run finds a duplicate it does not have to write again.
import { mkdir as makeDir, open as openFile, readFile as readFileBytes, readdir as readDir, rename as renameFile, stat as statFile, unlink as unlinkFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { gunzip as gunzipCallback, gzip as gzipCallback } from 'node:zlib'

const ARCHIVE_DIR = 'archive'
const MANIFEST_FILE = 'manifest.json'
const MANIFEST_VERSION = 1
const RECORD_SUFFIX = '.jsonl.gz'
const KEYS_SUFFIX = '.keys.json.gz'
const MONTH_FILE_PATTERN = /^(\d{4}-\d{2})\.jsonl\.gz$/
const gzip = promisify(gzipCallback)
const gunzip = promisify(gunzipCallback)

// node:fs/promises cannot be substituted by a test, so both public entry points
// accept an fs object. Production never passes one; the archive tests hand in a
// wrapper that counts calls, which is the only way to prove that a ledger without
// an archive directory does not pay for one.
const DEFAULT_FS = {
  open: openFile,
  mkdir: makeDir,
  readFile: readFileBytes,
  readdir: readDir,
  rename: renameFile,
  stat: statFile,
  unlink: unlinkFile,
}

function fsOf(options) {
  if (options === null || typeof options !== 'object') return DEFAULT_FS
  if (options.fs === null || typeof options.fs !== 'object') return DEFAULT_FS
  return options.fs
}

// The UTC month a record belongs to. Rows without a usable instant cannot be
// bucketed (and are already invalid to the ledger) and stay where they are.
function monthOfRecord(record) {
  if (record === null || typeof record !== 'object') return undefined
  if (!Number.isFinite(record.updatedAt)) return undefined
  const date = new Date(record.updatedAt)
  if (!Number.isFinite(date.getTime())) return undefined
  return date.toISOString().slice(0, 7)
}

function updatedAtOf(record) {
  return record !== null && typeof record === 'object' && Number.isFinite(record.updatedAt) ? record.updatedAt : -Infinity
}

// One fsynced, atomic publish. The staging name carries the pid so two processes
// that somehow slipped past the maintenance lock cannot truncate each other's file.
async function writeDurable(fs, path, data) {
  const tmp = path + '.tmp-' + String(process.pid)
  let handle = null
  try {
    handle = await fs.open(tmp, 'w')
    await handle.writeFile(data)
    await handle.sync()
    await handle.close()
    handle = null
    await fs.rename(tmp, path)
  } catch (error) {
    if (handle !== null) await handle.close().catch(() => {})
    await fs.unlink(tmp).catch(() => {})
    throw error
  }
}

// One month file, decompressed and parsed into one row per session id. An
// unreadable file throws: the writer must never replace a month it cannot read,
// because that would trade a damaged row for every row in it.
async function readArchiveMonth(fs, dir, month) {
  const packed = await fs.readFile(join(dir, month + RECORD_SUFFIX)).catch((error) => {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return null
    throw error
  })
  if (packed === null) return new Map()
  const text = (await gunzip(packed)).toString('utf8')
  const rows = new Map()
  for (const line of text.split('\n')) {
    if (line === '') continue
    const row = JSON.parse(line)
    if (row === null || typeof row !== 'object' || typeof row.sessionId !== 'string') continue
    rows.set(row.sessionId, row)
  }
  return rows
}

async function readManifest(fs, root) {
  const packed = await fs.readFile(join(root, ARCHIVE_DIR, MANIFEST_FILE)).catch(() => null)
  if (packed === null) return { version: MANIFEST_VERSION, months: {} }
  try {
    const parsed = JSON.parse(packed.toString('utf8'))
    if (parsed !== null && typeof parsed === 'object' && parsed.version === MANIFEST_VERSION && parsed.months !== null && typeof parsed.months === 'object') {
      return { version: MANIFEST_VERSION, months: parsed.months }
    }
  } catch (error) {
    // A damaged manifest is a description, not the archive: the months on disk
    // decide what is readable, and this one is simply rewritten from them.
  }
  return { version: MANIFEST_VERSION, months: {} }
}

async function writeManifest(fs, root, manifest) {
  const months = {}
  for (const month of Object.keys(manifest.months).sort()) months[month] = manifest.months[month]
  const body = JSON.stringify({ version: MANIFEST_VERSION, months }, null, 1) + '\n'
  await writeDurable(fs, join(root, ARCHIVE_DIR, MANIFEST_FILE), Buffer.from(body, 'utf8'))
}

/**
 * The read side of the archive, or null when <root>/archive does not exist.
 *
 * The directory listing is the whole feature switch, so a ledger that never
 * archived pays one failed listing per start and reads nothing else. The key index
 * is loaded eagerly because listKeys() is a synchronous question and the
 * .keys.json.gz files are small; the record files are decompressed one month at a
 * time, on the first read that needs them, and stay in memory afterwards.
 *
 * A month that cannot be decompressed or parsed is treated as missing: a warning
 * is logged once, its session ids leave the index, and startup carries on with the
 * months that are readable.
 */
export async function createArchiveReader(root, options = {}) {
  if (typeof root !== 'string' || root === '') return null
  const fs = fsOf(options)
  const dir = join(root, ARCHIVE_DIR)
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => null)
  if (entries === null) return null
  const months = []
  for (const entry of entries) {
    const match = entry.isFile() ? MONTH_FILE_PATTERN.exec(entry.name) : null
    if (match === null || months.includes(match[1])) continue
    months.push(match[1])
  }
  if (months.length === 0) return null
  months.sort()

  const records = new Map()
  const monthKeys = new Map()
  const keyMonths = new Map()
  const broken = new Set()
  const derived = new Set()
  const warned = new Set()
  const sessionIds = new Set()

  function rebuildSessionIds() {
    sessionIds.clear()
    for (const [month, keys] of monthKeys) {
      if (broken.has(month)) continue
      for (const key of keys) sessionIds.add(key)
    }
  }

  async function loadRecords(month) {
    if (records.has(month)) return records.get(month)
    let rows = null
    try {
      const packed = await fs.readFile(join(dir, month + RECORD_SUFFIX))
      const text = (await gunzip(packed)).toString('utf8')
      rows = new Map()
      for (const line of text.split('\n')) {
        if (line === '') continue
        const row = JSON.parse(line)
        if (row === null || typeof row !== 'object' || typeof row.sessionId !== 'string') continue
        rows.set(row.sessionId, row)
      }
    } catch (error) {
      rows = null
      if (!warned.has(month)) {
        warned.add(month)
        console.warn('[all-usage] usage ledger archive month is unreadable and is treated as missing:', month, error && error.message)
      }
      if (!broken.has(month)) {
        broken.add(month)
        rebuildSessionIds()
      }
    }
    records.set(month, rows)
    return rows
  }

  function indexMonth(month, keys) {
    monthKeys.set(month, keys)
    for (const key of keys) {
      let owners = keyMonths.get(key)
      if (owners === undefined) { owners = new Set(); keyMonths.set(key, owners) }
      owners.add(month)
    }
  }

  for (const month of months) {
    let keys = null
    try {
      const packed = await fs.readFile(join(dir, month + KEYS_SUFFIX))
      const parsed = JSON.parse((await gunzip(packed)).toString('utf8'))
      if (Array.isArray(parsed)) keys = parsed.filter((key) => typeof key === 'string' && key !== '')
    } catch (error) {
      keys = null
    }
    if (keys !== null) { indexMonth(month, keys); continue }
    // Without a usable index the month file itself is the only record of what the
    // month holds, and dropping those sessions from listKeys() would hide usage
    // that is still perfectly readable. One decompression buys the whole list.
    const rows = await loadRecords(month)
    if (rows === null) continue
    derived.add(month)
    indexMonth(month, Array.from(rows.keys()))
  }
  rebuildSessionIds()

  return {
    months: Object.freeze(months.slice()),
    /** Every session id the archive holds, in no particular order. */
    keys() { return new Set(sessionIds) },
    /**
     * One archived row, in the shape the trees store (compact, identity pool and
     * all): the ledger expands it with expandLedgerRecord() like any other row.
     * A session archived in two months is one record; the newer revision wins.
     */
    async readRecord(key) {
      if (typeof key !== 'string' || key === '') return undefined
      const owners = keyMonths.get(key)
      // A key the index never saw can still sit in a month whose index was derived
      // or missing, so those months are still searched. A complete index answers
      // 'missing' without decompressing anything.
      const candidates = owners !== undefined ? months.filter((month) => owners.has(month)) : Array.from(derived)
      let best
      for (const month of candidates) {
        if (broken.has(month)) continue
        const rows = await loadRecords(month)
        if (rows === null) continue
        const row = rows.get(key)
        if (row === undefined) continue
        if (best === undefined || updatedAtOf(row) > updatedAtOf(best)) best = row
      }
      return best
    },
  }
}

/**
 * Fold every tree record older than cutoffMs into its month file and, once that is
 * durable, remove the tree document.
 *
 * The store is the ledger's unit store (or the filesystem stand-in the CLI builds):
 * listKeys() names the records, readRecord() returns the compact row, and
 * deleteRecord() removes one tree document. Only updatedAt is compared, so a record
 * that is still being written before the cutoff and again after it can never be
 * archived twice with different content.
 *
 * Returns { months, archived, bytes, compressed, dryRun, errors }. months lists the
 * month files written, archived counts the records this run moved, bytes is their
 * serialized (uncompressed) size, compressed the bytes those month files grew by.
 * A dry run reports the same plan and writes nothing at all - not even the archive
 * directory.
 */
export async function archiveRecords({ root, store, cutoffMs, dryRun = false, fs: fsOption } = {}) {
  if (typeof root !== 'string' || root === '') throw new TypeError('archiveRecords needs a ledger root')
  if (store === null || typeof store !== 'object') throw new TypeError('archiveRecords needs a ledger store')
  if (typeof store.listKeys !== 'function' || typeof store.readRecord !== 'function' || typeof store.deleteRecord !== 'function') throw new TypeError('archiveRecords needs store.listKeys(), store.readRecord() and store.deleteRecord()')
  if (!Number.isFinite(cutoffMs)) throw new TypeError('archiveRecords needs a finite cutoffMs')
  const fs = fsOf({ fs: fsOption })
  const result = { months: [], archived: 0, bytes: 0, compressed: 0, dryRun: dryRun === true, errors: [] }
  const byMonth = new Map()
  let planned = 0
  let plannedBytes = 0
  for (const key of await store.listKeys()) {
    if (typeof key !== 'string' || key === '' || key.startsWith('__')) continue
    let row
    try {
      row = await store.readRecord(key)
    } catch (error) {
      result.errors.push({ key, message: error && error.message ? error.message : String(error) })
      continue
    }
    if (row === null || typeof row !== 'object' || typeof row.sessionId !== 'string') continue
    if (!(updatedAtOf(row) < cutoffMs)) continue
    const month = monthOfRecord(row)
    if (month === undefined) continue
    let plan = byMonth.get(month)
    if (plan === undefined) { plan = { entries: new Map(), bytes: 0 }; byMonth.set(month, plan) }
    const json = JSON.stringify(row)
    const size = Buffer.byteLength(json)
    plan.entries.set(key, { row, json, bytes: size })
    plan.bytes += size
    planned += 1
    plannedBytes += size
  }
  if (result.dryRun || byMonth.size === 0) {
    result.months = Array.from(byMonth.keys()).sort()
    result.archived = planned
    result.bytes = plannedBytes
    return result
  }

  const manifest = await readManifest(fs, root)
  for (const month of Array.from(byMonth.keys()).sort()) {
    const plan = byMonth.get(month)
    try {
      const written = await archiveMonth({ root, fs, month, entries: plan.entries, manifest, store })
      result.months.push(month)
      result.archived += plan.entries.size
      result.bytes += plan.bytes
      result.compressed += written
    } catch (error) {
      // The tree still holds every record of this month: the run reports the
      // failure and leaves the archive (if any) exactly as it found it.
      result.errors.push({ month, message: error && error.message ? error.message : String(error) })
    }
  }
  return result
}

// One month under the maintenance lock. Returns the bytes the month file grew by.
async function archiveMonth({ root, fs, month, entries, manifest, store }) {
  const dir = join(root, ARCHIVE_DIR)
  const recordPath = join(dir, month + RECORD_SUFFIX)
  const keysPath = join(dir, month + KEYS_SUFFIX)
  // Merge into what the month already holds instead of replacing it: a crashed run
  // (or one that lost the race to delete a source) leaves rows this run must keep.
  // The same session id keeps the newer row, so a retry can never roll a record
  // back to an older revision.
  const merged = await readArchiveMonth(fs, dir, month)
  let changed = false
  for (const [key, entry] of entries) {
    const current = merged.get(key)
    if (current !== undefined) {
      if (updatedAtOf(current) > updatedAtOf(entry.row)) continue
      if (JSON.stringify(current) === entry.json) continue
    }
    merged.set(key, entry.row)
    changed = true
  }
  const keys = Array.from(merged.keys()).sort()
  let packed = 0
  if (changed) {
    await fs.mkdir(dir, { recursive: true })
    const lines = keys.map((key) => JSON.stringify(merged.get(key))).join('\n') + '\n'
    const body = await gzip(Buffer.from(lines, 'utf8'))
    await writeDurable(fs, recordPath, body)
    await writeDurable(fs, keysPath, await gzip(Buffer.from(JSON.stringify(keys), 'utf8')))
    packed = body.length
  } else if (!(await fs.stat(keysPath).then(() => true, () => false))) {
    // The rows are already archived; the fast key index behind listKeys() is not.
    await fs.mkdir(dir, { recursive: true })
    await writeDurable(fs, keysPath, await gzip(Buffer.from(JSON.stringify(keys), 'utf8')))
  }
  const size = changed ? packed : await fs.stat(recordPath).then((info) => info.size, () => 0)
  const previous = manifest.months[month]
  if (previous === undefined || previous.records !== keys.length || previous.bytes !== size) {
    manifest.months[month] = { records: keys.length, bytes: size, updatedAt: Date.now() }
    await writeManifest(fs, root, manifest)
  }
  // Record file, key index and manifest are on disk: only now is the tree copy
  // redundant. A failure here leaves both, which the read path dedupes.
  for (const key of entries.keys()) {
    try {
      await store.deleteRecord(key)
    } catch (error) {
      // Leaving the document behind is safe (the tree wins on read). It only means
      // the next run sees the record again, so it must not abort the month.
    }
  }
  return packed
}