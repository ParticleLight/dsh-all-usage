#!/usr/bin/env node
// Compares the two JSON storage layouts the ledger can use, on a COPY of the real
// shards (the live host is never touched): one whole-file rewrite per session
// update (the old single layout) against one document per record (per-record).
//
// Usage: node bench/ledger-layout.mjs [--json] [shardName...]
import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const json = process.argv.includes('--json')
const args = process.argv.slice(2).filter((value) => value.endsWith('.json'))
const runtimeRoot = process.env.DSH_RUNTIME_ROOT || 'F:/dsh-web/runtime-0.2.1-alpha.2'
const { JsonStorageBackend } = await import('file:///' + runtimeRoot + '/node_modules/@deepseek-ai/dsh-storage-json/lib/index.js')
const realRoot = join(homedir(), '.dsh', 'storages')
const shard = args[0] || 'all_usage_ledger_10.json'
const unitName = shard.replace(/\.json$/, '')
const workRoot = join(tmpdir(), 'all-usage-layout-bench')

const fresh = async () => { await rm(workRoot, { recursive: true, force: true }); await mkdir(workRoot, { recursive: true }); await cp(join(realRoot, shard), join(workRoot, shard)) }

// Single layout: the whole shard is one document, rewritten per update.
await fresh()
const legacyBytes = (await stat(join(workRoot, shard))).size
const singleBackend = new JsonStorageBackend(workRoot)
const single = await singleBackend.kv.open({ name: unitName, version: 0, tables: ['sessions'], hasGlobal: false })
const singleRows = (await single.loadAll()).tables.sessions
const singleIds = Object.keys(singleRows)
const t0 = performance.now()
await single.putRecord('sessions', singleIds[0], { ...singleRows[singleIds[0]], touched: 1 })
const singleWriteMs = performance.now() - t0
await single.close()
await singleBackend.close()

// Per-record layout: migrates itself from the same legacy file, one document per write.
await fresh()
const perBackend = new JsonStorageBackend(workRoot)
const tOpen = performance.now()
const per = await perBackend.kv.open({ name: unitName, version: 0, tables: ['sessions'], hasGlobal: false, layout: 'per-record' })
const perRows = (await per.loadAll()).tables.sessions
const migrateMs = performance.now() - tOpen
const perIds = Object.keys(perRows)
const sizes = []
for (const id of perIds) {
  const path = join(workRoot, unitName, 'sessions', id + '.json')
  const info = await stat(path).catch(() => null)
  sizes.push({ id, kb: (info === null ? 0 : info.size) / 1024, usage: Array.isArray(perRows[id].usage) ? perRows[id].usage.length : 0 })
}
sizes.sort((a, b) => b.kb - a.kb)
const timings = []
for (const entry of [sizes[0], sizes[Math.floor(sizes.length / 2)], sizes[sizes.length - 1]]) {
  const t = performance.now()
  await per.putRecord('sessions', entry.id, { ...perRows[entry.id], touched: Date.now() })
  timings.push({ usage: entry.usage, fileKB: Number(entry.kb.toFixed(1)), writeMs: Number((performance.now() - t).toFixed(1)) })
}
const dirMB = Number((sizes.reduce((sum, item) => sum + item.kb, 0) / 1024).toFixed(2))
await per.close()
await perBackend.close()

// The per-record document tree is empty right after the copy; give the directory
// listing a moment so the count is the migrated one.
const files = (await readdir(join(workRoot, unitName, 'sessions')).catch(() => [])).length
await rm(workRoot, { recursive: true, force: true })

const report = {
  shard,
  records: singleIds.length,
  legacyMB: Number((legacyBytes / 1048576).toFixed(2)),
  single: { keys: singleIds.length, writeMs: Number(singleWriteMs.toFixed(1)) },
  perRecord: { keys: perIds.length, files, migrateMs: Number(migrateMs.toFixed(0)), dirMB, biggestRecordMB: Number((sizes[0].kb / 1024).toFixed(2)), medianRecordKB: Number(sizes[Math.floor(sizes.length / 2)].kb.toFixed(1)) },
  writes: timings,
}
if (json) console.log(JSON.stringify(report, null, 1))
else {
  console.log('ledger layout benchmark on a copy of ' + shard + ' (' + report.records + ' records, ' + report.legacyMB + ' MB)')
  console.log('  single layout   : one update = ' + report.single.writeMs + ' ms (rewrites the whole file)')
  console.log('  per-record      : migrate on open ' + report.perRecord.migrateMs + ' ms · ' + report.perRecord.files + ' files / ' + report.perRecord.dirMB + ' MB')
  console.log('  per-record write: median record ' + report.perRecord.medianRecordKB + ' KB -> ' + report.writes[1].writeMs + ' ms · biggest ' + report.perRecord.biggestRecordMB + ' MB -> ' + report.writes[0].writeMs + ' ms')
}
