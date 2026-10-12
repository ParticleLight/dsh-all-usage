#!/usr/bin/env node
// Times the read endpoints of a running host (5 runs, median) and reports payload
// sizes, so a change can be compared before and after a restart.
//
// Usage: node bench/endpoints.mjs [--json] [baseUrl]
import { request } from 'node:http'

const json = process.argv.includes('--json')
const base = process.argv.find((value) => value.startsWith('http')) || 'http://127.0.0.1:3080'

function get(path) {
  return new Promise((resolve, reject) => {
    const started = performance.now()
    const req = request(base + path, { method: 'GET', headers: { accept: 'application/json' } }, (res) => {
      let bytes = 0
      res.on('data', (chunk) => { bytes += chunk.length })
      res.on('end', () => resolve({ status: res.statusCode, ms: performance.now() - started, bytes }))
    })
    req.on('error', reject)
    req.end()
  })
}

const today = new Date().toISOString().slice(0, 10)
const from = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)
const cases = [
  ['snapshot (local)', '/api/all-usage?utc=0'],
  ['query 30d', '/api/all-usage/query?start=' + from + '&end=' + today + '&utc=0'],
  ['records 20', '/api/all-usage/records?start=' + from + '&end=' + today + '&utc=0&limit=20'],
  ['pricing', '/api/all-usage/pricing'],
  ['status', '/api/all-usage/status'],
]
const report = []
for (const [label, path] of cases) {
  const runs = []
  for (let index = 0; index < 5; index += 1) runs.push(await get(path))
  const sorted = runs.map((run) => run.ms).sort((a, b) => a - b)
  report.push({ label, status: runs[0].status, medianMs: Number(sorted[2].toFixed(1)), minMs: Number(sorted[0].toFixed(1)), kb: Math.round(runs[0].bytes / 1024) })
}
if (json) console.log(JSON.stringify({ base, report }, null, 1))
else {
  console.log('endpoints @ ' + base)
  for (const row of report) console.log('  ' + row.label.padEnd(18) + row.medianMs.toString().padStart(7) + ' ms  ' + row.kb.toString().padStart(5) + ' KB')
}
