import assert from 'node:assert/strict'
import test from 'node:test'
import { createLedger, LEDGER_SHARD_COUNT, ledgerShardIndex } from '../lib/ledger.js'

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

test('opens 32 stable ledger shards and migrates legacy rows', async () => {
  const opened = []
  const writes = []
  const units = new Map()
  const legacy = { version: 3, sessionId: 's-legacy', workspaceId: 'w', updatedAt: Date.now(), turns: [], usage: [] }
  const backend = {
    kv: {
      async open(descriptor) {
        opened.push(descriptor)
        let unit = units.get(descriptor.name)
        if (unit !== undefined) return unit
        const rows = descriptor.name === 'all_usage_ledger' ? { 's-legacy': legacy } : {}
        unit = {
          async loadAll() { return { global: {}, tables: { sessions: rows } } },
          async putRecord(table, key, value) { writes.push({ name: descriptor.name, key }); rows[key] = value },
          async close() {},
        }
        units.set(descriptor.name, unit)
        return unit
      },
    },
  }
  const { host, ledger } = makeLedger({ backend: { get() { return backend } } })
  await ledger.loadLedger()
  assert.equal(opened.length, LEDGER_SHARD_COUNT + 1)
  assert.deepEqual(opened.map((item) => item.name), Array.from({ length: LEDGER_SHARD_COUNT }, (_, index) => 'all_usage_ledger_' + String(index).padStart(2, '0')).concat(['all_usage_ledger']))
  assert.equal(host.state.ledgerRecords.has('s-legacy'), true)
  assert.equal(writes.some((item) => item.key === 's-legacy' && item.name === 'all_usage_ledger_' + String(ledgerShardIndex('s-legacy')).padStart(2, '0')), true)
  assert.equal(writes.some((item) => item.key === '__all_usage_ledger_meta__' && item.name === 'all_usage_ledger_00'), true)
  await host.state.ledgerUnit.close()
  const openedBeforeSecondLoad = opened.length
  const second = makeLedger({ backend: { get() { return backend } } })
  await second.ledger.loadLedger()
  assert.equal(opened.length, openedBeforeSecondLoad + LEDGER_SHARD_COUNT)
  await second.host.state.ledgerUnit.close()
})

test('coalesces pending ledger records and drains the latest value', async () => {
  const writes = []
  const { host, ledger } = makeLedger()
  host.state.ledgerUnit = {
    async putRecord(table, key, value) { writes.push({ table, key, value }) },
  }
  const first = { version: 3, sessionId: 's', lastSeq: 1, source: 'scan', updatedAt: 1, turns: [], usage: [] }
  const latest = { version: 3, sessionId: 's', lastSeq: 2, source: 'flush', updatedAt: 2, turns: [], usage: [] }
  ledger.storeLedgerRecord(first)
  const firstWait = ledger.persistLedgerRecord(first)
  ledger.storeLedgerRecord(latest)
  const latestWait = ledger.persistLedgerRecord(latest)
  assert.equal(writes.length, 0)
  await ledger.drainLedgerWrites()
  await Promise.all([firstWait, latestWait])
  assert.equal(writes.length, 1)
  assert.equal(writes[0].key, 's')
  assert.strictEqual(writes[0].value, latest)
})

test('keeps the in-memory ledger when an async write fails', async () => {
  const { host, ledger } = makeLedger()
  const writes = []
  host.state.ledgerUnit = {
    async putRecord(table, key, value) { writes.push({ table, key, value }); throw new Error('simulated shard failure') },
  }
  const record = { version: 3, sessionId: 's-failure', lastSeq: 1, source: 'flush', updatedAt: 1, turns: [], usage: [] }
  ledger.storeLedgerRecord(record)
  await ledger.persistLedgerRecord(record)
  assert.equal(writes.length, 1)
  assert.strictEqual(host.state.ledgerRecords.get('s-failure'), record)
  assert.equal(host.state.ledgerPending.size, 0)
})

test('builds an appended ledger tail from the previous record', () => {
  const { ledger, identity } = makeLedger()
  const time = Date.now()
  const previous = {
    version: 3,
    sessionId: 's-tail',
    workspaceId: 'w',
    lastSeq: 1,
    source: 'flush',
    updatedAt: 1,
    lastIdentity: identity,
    turns: [],
    usage: [{ key: 's-tail:step:1:1', seq: 1, time, workspaceId: 'w', identity, modelId: 'unknown', turn: 1, step: 1, values: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: 0 } }],
  }
  const events = [
    { seq: 0, time, type: 'request/context', data: { provider: 'deepseek', model: 'deepseek-chat' } },
    { seq: 1, time, type: 'assistant/message', data: { turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 20 } } },
    { seq: 2, time, type: 'assistant/message', data: { turn: 2, step: 1, usage: { inputTokens: 7, outputTokens: 8 } } },
  ]
  const record = ledger.buildLedgerRecord({ id: 's-tail', events }, 'w', 'flush', undefined, previous)
  assert.equal(record.lastSeq, 2)
  assert.equal(record.usage.length, 2)
  assert.equal(record.usage.find((item) => item.key === 's-tail:step:1:1').values.input, 10)
  assert.equal(record.usage.find((item) => item.key === 's-tail:step:2:1').values.input, 7)
})

test('migrates legacy tiered priced costs to unsupported', () => {
  const { host, ledger, identity } = makeLedger()
  const oldCost = {
    schemaVersion: 1,
    pricingMode: 'official-model',
    status: 'priced',
    currency: 'USD',
    source: 'models.dev',
    pricingModel: 'gpt-5.5',
    providerId: 'openai',
    inputTokenSemantics: 'fresh',
    multiplier: '1',
    billableInputTokens: 1000000,
    billableOutputTokens: 1000000,
    rates: { input: '5', output: '30', cacheRead: '0.5', cacheWrite: '6.25' },
    breakdown: { input: '5', output: '30', cacheRead: '0', cacheWrite: '0' },
    baseTotal: '35',
    total: '35',
    reason: '',
    tiered: true,
    reasoningRateAvailable: false,
  }
  const record = ledger.normalizeLedgerRecord({
    version: 3,
    sessionId: 's-tiered',
    workspaceId: 'w',
    updatedAt: Date.now(),
    turns: [],
    usage: [{ key: 's-tiered:step:1:1', seq: 1, time: Date.now(), workspaceId: 'w', identity, modelId: 'gpt-5.5', turn: 1, step: 1, values: { input: 1000000, output: 1000000, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, cost: oldCost }],
  }, 's-tiered')
  assert.equal(record.needsUpgrade, true)
  ledger.prepareLedgerRecord(record)
  // Cost repacking must not clear the rebuild flag: only a complete rebuild
  // from the source log produces a record safe for revision fast-pathing.
  assert.equal(record.needsUpgrade, true)
  assert.equal(record.usage[0].cost.status, 'unsupported')
  assert.equal(record.usage[0].cost.reason, 'tiered-pricing-not-modeled')
  assert.equal(record.usage[0].cost.total, '0')
  const migratedRevision = record.updatedAt
  const roundTrip = ledger.normalizeLedgerRecord(JSON.parse(JSON.stringify(record)), 's-tiered')
  // The persisted rebuild reason survives the JSON round trip until a complete
  // source-log rebuild clears it.
  assert.equal(roundTrip.needsUpgrade, true)
  assert.equal(roundTrip.rebuildRequired, 'invalid-usage')
  assert.equal(roundTrip.usage[0].cost.status, 'unsupported')
  assert.equal(roundTrip.usage[0].cost.reason, 'tiered-pricing-not-modeled')
  assert.equal(host.state.ledgerRevision, migratedRevision)
})

test('preserves a newly tier-resolved priced snapshot during ledger normalization', () => {
  const { ledger, identity } = makeLedger()
  const cost = {
    schemaVersion: 1,
    pricingMode: 'official-model',
    status: 'priced',
    currency: 'USD',
    source: 'models.dev',
    pricingModel: 'gpt-5.5',
    providerId: 'openai',
    inputTokenSemantics: 'fresh',
    multiplier: '1',
    billableInputTokens: 100,
    billableOutputTokens: 20,
    contextTokens: 200001,
    selectedTier: { type: 'context', size: 200000 },
    rates: { input: '10', output: '40', cacheRead: '1', cacheWrite: '2' },
    breakdown: { input: '0.001', output: '0.0008', cacheRead: '0', cacheWrite: '0' },
    baseTotal: '0.0018',
    total: '0.0018',
    reason: '',
    tiered: true,
    reasoningRateAvailable: false,
  }
  const record = ledger.normalizeLedgerRecord({
    version: 3,
    sessionId: 's-new-tier',
    workspaceId: 'w',
    updatedAt: Date.now(),
    turns: [],
    usage: [{ key: 's-new-tier:step:1:1', seq: 1, time: Date.now(), workspaceId: 'w', identity, modelId: 'gpt-5.5', turn: 1, step: 1, values: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, cost }],
  }, 's-new-tier')
  assert.equal(record.needsUpgrade, false)
  ledger.prepareLedgerRecord(record)
  assert.equal(record.usage[0].cost.status, 'priced')
  assert.deepEqual(record.usage[0].cost.selectedTier, { type: 'context', size: 200000 })
})

test('keeps ledger revisions and persisted timestamps finite', () => {
  const { host, ledger, identity } = makeLedger()
  const revision = ledger.nextLedgerRevision()
  assert.equal(Number.isFinite(revision), true)
  assert.equal(Number.isFinite(host.state.ledgerRevision), true)
  const normalized = ledger.normalizeLedgerRecord({ version: 3, sessionId: 's', workspaceId: 'w', updatedAt: Number.NaN, turns: [], usage: [] }, 's')
  assert.equal(Number.isFinite(normalized.updatedAt), true)
  assert.equal(normalized.needsUpgrade, true)
  const invalidTime = ledger.normalizeLedgerRecord({ version: 3, sessionId: 's', workspaceId: 'w', updatedAt: Date.now(), turns: [], usage: [{ key: 'bad', time: 1e20, workspaceId: 'w', values: { input: 1 }, identity }] }, 's')
  assert.equal(invalidTime.needsUpgrade, true)
  assert.equal(invalidTime.usage.length, 0)
  const invalidTurn = ledger.normalizeLedgerRecord({ version: 3, sessionId: 's-turn', workspaceId: 'w', updatedAt: Date.now(), turns: [{ key: 'bad-turn', time: 1e20, workspaceId: 'w' }], usage: [] }, 's-turn')
  assert.equal(invalidTurn.needsUpgrade, true)
  assert.equal(invalidTurn.turns.length, 0)
  assert.throws(() => ledger.assertLedgerRecord({ updatedAt: Number.NaN }), /finite number/)
  assert.throws(() => ledger.assertLedgerRecord({ updatedAt: Infinity }), /finite number/)
  const record = { updatedAt: revision }
  assert.equal(ledger.assertLedgerRecord(record), record)
})
