#!/usr/bin/env node
// Measures the usage ledger's on-disk cost and the per-event write amplification.
// Usage: node bench/ledger.mjs [--json]
import { readFile, readdir, stat, writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

const json = process.argv.includes('--json')
const storageDir = join(homedir(), '.dsh', 'storages')
const files = (await readdir(storageDir)).filter((name) => name === 'all_usage_ledger.json' || /^all_usage_ledger_\d+\.json$/.test(name))
const shards = []
let usageEntries = 0
let sessions = 0
let usageBytes = 0
let recordBytes = 0
const fieldBytes = new Map()
let biggestSession = { entries: 0, key: null }
for (const name of files) {
  const full = join(storageDir, name)
  const info = await stat(full)
  let parsed = null
  try { parsed = JSON.parse(await readFile(full, 'utf8')) } catch (error) { shards.push({ name, mb: Number((info.size / 1048576).toFixed(2)), unreadable: true }); continue }
  const rows = (parsed.tables && parsed.tables.sessions) || {}
  const list = Array.isArray(rows) ? rows.map((row) => (Array.isArray(row) ? row[1] : row)) : Object.values(rows)
  let shardUsageEntries = 0
  for (const record of list) {
    if (record === null || typeof record !== 'object') continue
    sessions += 1
    recordBytes += Buffer.byteLength(JSON.stringify(record))
    const usage = Array.isArray(record.usage) ? record.usage : []
    shardUsageEntries += usage.length
    usageEntries += usage.length
    usageBytes += Buffer.byteLength(JSON.stringify(usage))
    if (usage.length > biggestSession.entries) biggestSession = { entries: usage.length, key: record.sessionId }
    for (const entry of usage) {
      if (entry === null || typeof entry !== 'object') continue
      for (const [key, value] of Object.entries(entry)) fieldBytes.set(key, (fieldBytes.get(key) || 0) + Buffer.byteLength(JSON.stringify(value)))
    }
  }
  shards.push({ name, mb: Number((info.size / 1048576).toFixed(2)), sessions: list.length, usageEntries: shardUsageEntries })
}
shards.sort((a, b) => b.mb - a.mb)
const fields = Array.from(fieldBytes.entries()).map(([key, bytes]) => ({ key, kb: Number((bytes / 1024).toFixed(0)), perEntryBytes: Number((bytes / Math.max(1, usageEntries)).toFixed(0)) })).sort((a, b) => b.kb - a.kb)

// Write amplification of the worst shard: the file a single session update rewrites.
const worst = shards.find((shard) => shard.unreadable !== true) || shards[0]
const worstPath = join(storageDir, worst.name)
let writeMs = 0
let rewriteBytes = 0
try {
  const text = await readFile(worstPath, 'utf8')
  const t0 = performance.now()
  const again = JSON.stringify(JSON.parse(text))
  const stringifyMs = performance.now() - t0
  const probe = join(storageDir, '.all-usage-ledger-bench.tmp')
  const t1 = performance.now()
  await writeFile(probe, again, 'utf8')
  writeMs = performance.now() - t1
  rewriteBytes = again.length
  await unlink(probe)
  worst.stringifyMs = Number(stringifyMs.toFixed(1))
} catch (error) {
  worst.error = String(error && error.message)
}

const totalMB = Number((shards.reduce((sum, shard) => sum + (shard.mb || 0), 0)).toFixed(1))
const report = {
  storageDir,
  shards: shards.length,
  totalMB,
  sessions,
  usageEntries,
  usageMB: Number((usageBytes / 1048576).toFixed(2)),
  recordMB: Number((recordBytes / 1048576).toFixed(2)),
  usageEntryBytes: Number((usageBytes / Math.max(1, usageEntries)).toFixed(0)),
  biggestSession,
  worstShard: { name: worst.name, mb: worst.mb, stringifyMs: worst.stringifyMs, rewriteMs: Number((writeMs + (worst.stringifyMs || 0)).toFixed(1)), rewriteBytes },
  fieldCost: fields.slice(0, 10),
  topShards: shards.slice(0, 8),
}
if (json) console.log(JSON.stringify(report, null, 1))
else {
  console.log('usage ledger @ ' + storageDir)
  console.log('  shards ' + report.shards + ' · ' + report.totalMB + ' MB · sessions ' + report.sessions + ' · usage entries ' + report.usageEntries)
  console.log('  per usage entry ' + report.usageEntryBytes + ' B (total ' + report.usageMB + ' MB of ' + report.recordMB + ' MB of records)')
  console.log('  biggest session ' + report.biggestSession.entries + ' entries')
  console.log('  worst shard ' + report.worstShard.name + ': rewrite ' + report.worstShard.rewriteBytes + ' B in ' + report.worstShard.rewriteMs + ' ms per event (stringify ' + report.worstShard.stringifyMs + ' ms)')
  console.log('  field cost per entry: ' + report.fieldCost.map((item) => item.key + ' ' + item.perEntryBytes + 'B').slice(0, 8).join(' · '))
}
