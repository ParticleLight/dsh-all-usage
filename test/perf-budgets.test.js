import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

// Every unbounded structure this plugin used to have now has a number attached
// to it. The numbers live in the code, and this test is the registry: removing or
// loosening a budget without updating its entry fails here, so growth has to be a
// deliberate decision rather than a drift.
const client = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')
const aggregation = await readFile(new URL('../lib/aggregation.js', import.meta.url), 'utf8')
const ledger = await readFile(new URL('../lib/ledger.js', import.meta.url), 'utf8')
const pricingRuntime = await readFile(new URL('../lib/pricing-runtime.js', import.meta.url), 'utf8')
const plugin = await readFile(new URL('../lib/plugin.js', import.meta.url), 'utf8')
const usageCore = await readFile(new URL('../lib/usage-core.js', import.meta.url), 'utf8')

const budgets = [
  ['trend chart points', client, 'const TREND_MAX_POINTS = 180'],
  ['snapshot session-id window (days)', aggregation, 'const SNAPSHOT_SESSION_WINDOW_DAYS = 180'],
  ['query result cache entries', aggregation, 'state.queryCache.size > 20'],
  ['records result cache entries', aggregation, 'state.recordsQueryCache.size > 20'],
  ['pricing resolution cache entries', aggregation, '5000'],
  ['context archive per session', usageCore, 'const MAX_CONTEXT_TIMES = 512'],
  ['pricing rows per snapshot', pricingRuntime, 'const MAX_PRICING_ROWS = 500'],
  ['ledger shards', ledger, 'const LEDGER_SHARD_COUNT = 32'],
  ['superseded scope results are dropped', plugin, 'if (recordsChanged) state.queryCache.clear()'],
]

test('documents every performance budget and keeps it in place', () => {
  const missing = budgets.filter(([, source, marker]) => !source.includes(marker)).map(([label, , marker]) => label + ' (' + marker + ')')
  assert.deepEqual(missing, [])
})
