import assert from 'node:assert/strict'
import test from 'node:test'
import { createLedger } from '../lib/ledger.js'

function makeLedger() {
  const identity = { identityKey: 'identity', provider: null, requestedModel: null, actualModel: null, label: 'unknown', legacy: true }
  const host = {
    services: { storage: undefined },
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
      upsertUsageSample() {},
    },
    sessionSync: { lastSeqOf() { return -1 } },
    markStatsChanged() {},
  }
  return { host, ledger: createLedger(host), identity }
}

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
  assert.equal(record.needsUpgrade, false)
  assert.equal(record.usage[0].cost.status, 'unsupported')
  assert.equal(record.usage[0].cost.reason, 'tiered-pricing-not-modeled')
  assert.equal(record.usage[0].cost.total, '0')
  const migratedRevision = record.updatedAt
  const roundTrip = ledger.normalizeLedgerRecord(JSON.parse(JSON.stringify(record)), 's-tiered')
  assert.equal(roundTrip.needsUpgrade, false)
  assert.equal(roundTrip.usage[0].cost.status, 'unsupported')
  assert.equal(roundTrip.usage[0].cost.reason, 'tiered-pricing-not-modeled')
  assert.equal(host.state.ledgerRevision, migratedRevision)
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
