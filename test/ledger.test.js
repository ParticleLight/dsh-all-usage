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
      validEventTime() { return true },
      upsertUsageSample() {},
    },
    sessionSync: { lastSeqOf() { return -1 } },
    markStatsChanged() {},
  }
  return { host, ledger: createLedger(host) }
}

test('keeps ledger revisions and persisted timestamps finite', () => {
  const { host, ledger } = makeLedger()
  const revision = ledger.nextLedgerRevision()
  assert.equal(Number.isFinite(revision), true)
  assert.equal(Number.isFinite(host.state.ledgerRevision), true)
  const normalized = ledger.normalizeLedgerRecord({ version: 3, sessionId: 's', workspaceId: 'w', updatedAt: Number.NaN, turns: [], usage: [] }, 's')
  assert.equal(Number.isFinite(normalized.updatedAt), true)
  assert.equal(normalized.needsUpgrade, true)
  assert.throws(() => ledger.assertLedgerRecord({ updatedAt: Number.NaN }), /finite number/)
  assert.throws(() => ledger.assertLedgerRecord({ updatedAt: Infinity }), /finite number/)
  const record = { updatedAt: revision }
  assert.equal(ledger.assertLedgerRecord(record), record)
})
