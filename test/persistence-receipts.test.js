import test from 'node:test'
import assert from 'node:assert/strict'
import { createCostAccumulator, createEmptyPricingState } from '../lib/pricing.js'
import { createPricingRuntime } from '../lib/pricing-runtime.js'

function makeRuntime(setGlobal, ledger = {}) {
  const state = {
    disposed: false,
    aggregationGeneration: 0,
    pricingReady: Promise.resolve(),
    ledgerReady: Promise.resolve(),
    pricingResolutionCache: new Map(),
    usageByStep: new Map(),
    perSession: new Map(),
    totals: { cost: createCostAccumulator() },
    dataRevision: 0,
    pricingRevision: 0,
    pricingState: createEmptyPricingState(),
    pricingUnit: { setGlobal },
    pricingWriteChain: Promise.resolve(),
  }
  const runtime = createPricingRuntime({
    state,
    services: {},
    aggregation: {},
    ledger,
    markStatsChanged() {},
  })
  return { runtime, state }
}

test('pricing write rejects per operation and the recovery tail permits retry', async () => {
  const attempts = []
  let failNext = true
  const { runtime, state } = makeRuntime(async (value) => {
    attempts.push(value)
    if (failNext) { failNext = false; throw new Error('fixture-storage-failure') }
  })

  await assert.rejects(runtime.persistPricing(), /fixture-storage-failure/)
  await assert.doesNotReject(state.pricingWriteChain)
  await assert.doesNotReject(runtime.persistPricing())
  assert.equal(attempts.length, 2)
})

test('missing pricing storage rejects instead of acknowledging a write', async () => {
  const { runtime, state } = makeRuntime(async () => {})
  state.pricingUnit = null
  await assert.rejects(runtime.persistPricing(), /storage/)
  await assert.doesNotReject(state.pricingWriteChain)
})

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

function mockCatalog(t) {
  const catalog = { openai: { name: 'OpenAI', models: { 'gpt-5.5': { name: 'GPT-5.5', cost: { input: 5, output: 30 } } } } }
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(url, 'https://models.dev/api.json')
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(catalog) }
  })
}

for (const operation of ['update', 'sync']) {
  for (const interruption of ['none', 'dispose', 'generation']) {
    test(operation + ' reports completed traversal only for a current generation: ' + interruption, { timeout: 5000 }, async (t) => {
      if (operation === 'sync') mockCatalog(t)
      const readStarted = deferred()
      const readGate = deferred()
      let pins = 0
      let reads = 0
      const { runtime, state } = makeRuntime(async () => {}, {
        pinRecord() { pins += 1; return () => { pins -= 1 } },
        async recordFor() { reads += 1; readStarted.resolve(); await readGate.promise; return { usage: [] } },
        async drainLedgerWrites() {},
      })
      state.perSession.set('s-1', { keys: new Map() })
      const pending = operation === 'update' ? runtime.updatePricingState({ sync: { autoEnabled: false } }, true) : runtime.syncPricing(true)
      await readStarted.promise
      if (interruption === 'dispose') state.disposed = true
      if (interruption === 'generation') state.aggregationGeneration += 1
      readGate.resolve()
      const result = await pending
      assert.equal(reads, 1)
      assert.equal(pins, 0)
      assert.equal(result.reestimated, interruption === 'none')
      assert.equal(result.persisted, interruption !== 'dispose')
      assert.equal(Object.hasOwn(result, 'completed'), false)
      const keys = operation === 'update' ? ['considered', 'priced', 'remaining', 'temporalReconciled'] : ['considered', 'priced', 'remaining']
      assert.deepEqual(Object.keys(result.backfill).sort(), keys.sort())
    })
  }

  for (const interruption of ['dispose', 'generation']) {
    test(operation + ' retains completed traversal when ' + interruption + ' occurs during configuration persistence', { timeout: 5000 }, async (t) => {
      if (operation === 'sync') mockCatalog(t)
      const writeStarted = deferred()
      const writeGate = deferred()
      const { runtime, state } = makeRuntime(async () => { writeStarted.resolve(); await writeGate.promise }, { async drainLedgerWrites() {} })
      const pending = operation === 'update' ? runtime.updatePricingState({ sync: { autoEnabled: false } }, true) : runtime.syncPricing(true)
      await writeStarted.promise
      if (interruption === 'dispose') state.disposed = true
      else state.aggregationGeneration += 1
      writeGate.resolve()
      const result = await pending
      assert.equal(result.persisted, true)
      assert.equal(result.reestimated, true)
    })
  }
}
