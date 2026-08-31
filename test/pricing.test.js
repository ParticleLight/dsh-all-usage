import assert from 'node:assert/strict'
import test from 'node:test'
import {
  addCostAggregate,
  calculateCost,
  decimalAdd,
  decimalMultiply,
  decimalText,
  emptyCostAggregate,
  fetchModelsDevCatalog,
  modelPricingCandidates,
  normalizeCostSnapshot,
  normalizePricingState,
  parseModelsDevCatalog,
  resolvePricing,
  serializePricingState,
} from '../lib/pricing.js'

const catalogFixture = {
  openai: {
    id: 'openai',
    name: 'OpenAI',
    models: {
      'openai/gpt-5.5': {
        id: 'openai/gpt-5.5',
        name: 'GPT-5.5',
        cost: { input: 5, output: 30, cache_read: 0.5, cache_write: 6.25, tiers: [{ input: 10 }] },
      },
    },
  },
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    models: {
      'anthropic/claude-opus-4.7': {
        id: 'anthropic/claude-opus-4.7',
        name: 'Claude Opus 4.7',
        cost: { input: 5, output: 25, cache_read: 0.5 },
      },
    },
  },
  alternate: {
    id: 'alternate',
    name: 'Alternate',
    models: {
      'alternate/gpt-5.5': {
        id: 'alternate/gpt-5.5',
        name: 'GPT-5.5',
        cost: { input: 7, output: 35, cache_read: 0.7 },
      },
      'alternate/free-model': {
        id: 'alternate/free-model',
        name: 'Free Model',
        cost: { input: 0, output: 0 },
      },
      'alternate/no-price': { id: 'alternate/no-price', name: 'No Price' },
    },
  },
}

test('normalizes model IDs using cc-switch candidate rules', () => {
  const dated = modelPricingCandidates('OpenAI/GPT-5.5-2026-05-14')
  assert.ok(dated.includes('gpt-5.5-2026-05-14'))
  assert.ok(dated.includes('gpt-5.5'))
  assert.ok(modelPricingCandidates('gpt-5.2-codex@low').includes('gpt-5.2-codex-low'))
  assert.ok(modelPricingCandidates('global.anthropic.claude-opus-4-8-v1:0').includes('claude-opus-4-8'))
  assert.ok(modelPricingCandidates('moonshotai/kimi-k2-0905:exa').includes('kimi-k2-0905'))
  assert.equal(decimalText('001.2500e+1'), '12.5')
  assert.equal(decimalText('1e999'), null)
  assert.equal(decimalText('1' + '0'.repeat(50)), null)
})

test('parses models.dev nested providers and keeps capability flags', () => {
  const parsed = parseModelsDevCatalog(catalogFixture, 123)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.catalog.fetchedAt, 123)
  const gpt = parsed.catalog.entries.find((entry) => entry.providerId === 'openai')
  assert.ok(gpt)
  assert.equal(gpt.modelId, 'gpt-5.5')
  assert.equal(gpt.input, '5')
  assert.equal(gpt.output, '30')
  assert.equal(gpt.cacheRead, '0.5')
  assert.equal(gpt.cacheWrite, '6.25')
  assert.equal(gpt.tiered, true)
  const free = parsed.catalog.entries.find((entry) => entry.modelId === 'free-model')
  assert.ok(free)
  assert.equal(free.input, '0')
  assert.equal(parsed.catalog.entries.some((entry) => entry.modelId === 'no-price'), false)
})

test('ignores DSH provider and selects the official model price', () => {
  const parsed = parseModelsDevCatalog(catalogFixture, 123)
  const state = normalizePricingState({ catalogEntries: parsed.catalog.entries.map((entry) => entry.modelId === 'gpt-5.5' ? { ...entry, tiered: false } : entry) })
  const direct = resolvePricing({ provider: 'openai', actualModel: 'gpt-5.5' }, state)
  const relay = resolvePricing({ provider: 'sudocode', actualModel: 'gpt-5.5' }, state)
  assert.equal(direct.status, 'priced')
  assert.equal(relay.status, 'priced')
  assert.equal(direct.providerId, 'openai')
  assert.equal(relay.providerId, 'openai')
  assert.equal(relay.rates.input, '5')
  const missing = resolvePricing({ provider: 'sudocode', actualModel: 'future-model' }, state)
  assert.equal(missing.status, 'unsupported')
  const qwenState = normalizePricingState({ catalogEntries: [{ providerId: 'alibaba', modelId: 'qwen3.5-plus', input: '0.4', output: '2.4' }] })
  const qwen = resolvePricing({ provider: 'any-relay', actualModel: 'qwen3.5-plus' }, qwenState)
  assert.equal(qwen.status, 'priced')
  assert.equal(qwen.providerId, 'alibaba')
})

test('does not use a non-official supplier price when the model family is unknown', () => {
  const state = normalizePricingState({ catalogEntries: [
    { providerId: 'relay-a', modelId: 'custom-model', input: '1', output: '2' },
    { providerId: 'relay-b', modelId: 'custom-model', input: '3', output: '4' },
  ] })
  const resolved = resolvePricing({ provider: 'any-provider', actualModel: 'custom-model' }, state)
  assert.equal(resolved.status, 'unsupported')
  assert.equal(resolved.reason, 'official-provider-unknown')
})

test('model-only manual override wins regardless of DSH provider', () => {
  const parsed = parseModelsDevCatalog(catalogFixture, 123)
  const state = normalizePricingState({
    catalogEntries: parsed.catalog.entries,
    overrides: [{ providerId: 'relay-price-table', modelId: 'gpt-5.5', input: '9', output: '18', cacheRead: '0.9', cacheWrite: '0' }],
  })
  const resolved = resolvePricing({ provider: 'sudocode', actualModel: 'gpt-5.5' }, state)
  assert.equal(resolved.status, 'priced')
  assert.equal(resolved.source, 'manual')
  assert.equal(resolved.rates.input, '9')
})

test('calculates fresh four-bucket cost and applies multiplier only to final total', () => {
  const parsed = parseModelsDevCatalog(catalogFixture, 123)
  const state = normalizePricingState({ catalogEntries: parsed.catalog.entries.map((entry) => entry.modelId === 'gpt-5.5' ? { ...entry, tiered: false } : entry) })
  const resolved = resolvePricing({ provider: 'openai', actualModel: 'gpt-5.5' }, state)
  resolved.multiplier = '1.5'
  const cost = calculateCost({ input: 1000000, output: 2000000, cacheRead: 100000, cacheWrite: 200000, reasoning: 900000 }, resolved)
  assert.equal(cost.status, 'priced')
  assert.equal(cost.pricingMode, 'official-model')
  assert.equal(cost.inputTokenSemantics, 'fresh')
  assert.equal(cost.billableInputTokens, 1000000)
  assert.equal(cost.billableOutputTokens, 2000000)
  assert.deepEqual(cost.breakdown, { input: '5', output: '60', cacheRead: '0.05', cacheWrite: '1.25' })
  assert.equal(cost.baseTotal, '66.3')
  assert.equal(cost.total, '99.45')
})

test('supports total and legacy input semantics without changing DSH fresh default', () => {
  const resolved = { status: 'priced', currency: 'USD', source: 'models.dev', pricingModel: 'model', rates: { input: '10', output: '20', cacheRead: '1', cacheWrite: '2' }, multiplier: '1' }
  const fresh = calculateCost({ input: 1000000, output: 0, cacheRead: 200000, cacheWrite: 100000 }, resolved)
  assert.equal(fresh.billableInputTokens, 1000000)
  const total = calculateCost({ input: 1000000, output: 0, cacheRead: 200000, cacheWrite: 100000 }, { ...resolved, inputTokenSemantics: 'total' })
  assert.equal(total.billableInputTokens, 700000)
  assert.equal(total.breakdown.input, '7')
  assert.equal(total.breakdown.cacheRead, '0.2')
  assert.equal(total.breakdown.cacheWrite, '0.2')
  const legacy = calculateCost({ input: 1000000, output: 0, cacheRead: 200000, cacheWrite: 100000 }, { ...resolved, inputTokenSemantics: 'legacy' })
  assert.equal(legacy.billableInputTokens, 800000)
})

test('does not add reasoning twice when output already carries completion tokens', () => {
  const resolved = { status: 'priced', currency: 'USD', source: 'models.dev', pricingModel: 'model', rates: { input: '0', output: '10', cacheRead: '0', cacheWrite: '0' }, multiplier: '1' }
  const cost = calculateCost({ input: 0, output: 1000000, reasoning: 500000 }, resolved)
  assert.equal(cost.billableOutputTokens, 1000000)
  assert.equal(cost.breakdown.output, '10')
  assert.equal(cost.total, '10')
})

test('distinguishes an official free model from an unpriced model', () => {
  const parsed = parseModelsDevCatalog({ openai: { id: 'openai', models: { 'gpt-5.5-free': { id: 'gpt-5.5-free', name: 'GPT Free', cost: { input: 0, output: 0 } } } } }, 123)
  const state = normalizePricingState({ catalogEntries: parsed.catalog.entries })
  const free = calculateCost({ input: 1000000, output: 1000000 }, resolvePricing({ provider: 'relay', actualModel: 'gpt-5.5-free' }, state))
  const missing = calculateCost({ input: 1000000, output: 1000000 }, resolvePricing({ provider: 'relay', actualModel: 'missing-model' }, state))
  assert.equal(free.status, 'priced')
  assert.equal(free.total, '0')
  assert.equal(missing.status, 'unsupported')
  assert.equal(missing.total, '0')
})

test('adds exact decimal aggregates without binary floating point drift', () => {
  assert.equal(decimalAdd('0.1', '0.2'), '0.3')
  assert.equal(decimalMultiply('5.95', '1.5'), '8.925')
  const aggregate = emptyCostAggregate()
  addCostAggregate(aggregate, { status: 'priced', breakdown: { input: '0.1', output: '0.2', cacheRead: '0', cacheWrite: '0' }, baseTotal: '0.3', total: '0.45' })
  addCostAggregate(aggregate, { status: 'unpriced' })
  assert.equal(aggregate.total, '0.45')
  assert.equal(aggregate.pricedCalls, 1)
  assert.equal(aggregate.unpricedCalls, 1)
})

test('normalizes and validates persisted cost snapshots', () => {
  const snapshot = normalizeCostSnapshot({
    status: 'priced', currency: 'USD', source: 'models.dev', pricingModel: 'gpt-5.5', providerId: 'openai', inputTokenSemantics: 'fresh', multiplier: 1,
    rates: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
    breakdown: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 }, baseTotal: 71.75, total: 71.75,
  })
  assert.ok(snapshot)
  assert.equal(snapshot.pricingMode, 'legacy-provider-aware')
  assert.equal(snapshot.total, '71.75')
  assert.equal(normalizeCostSnapshot({ status: 'priced', rates: {}, breakdown: {} }), null)
})

test('fetches and rejects malformed models.dev responses without credentials', async () => {
  const calls = []
  const response = { ok: true, status: 200, headers: { get: () => String(JSON.stringify(catalogFixture).length) }, text: async () => JSON.stringify(catalogFixture) }
  const fetched = await fetchModelsDevCatalog(async (url, options) => { calls.push({ url, options }); return response })
  assert.equal(fetched.ok, true)
  assert.equal(calls[0].url, 'https://models.dev/api.json')
  assert.equal(calls[0].options.headers.authorization, undefined)
  const malformed = await fetchModelsDevCatalog(async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => '{' }))
  assert.equal(malformed.ok, false)
  assert.equal(malformed.error, 'catalog-invalid-json')
})


test('uses exact identity mappings before model-only mappings', () => {
  const state = normalizePricingState({
    catalogEntries: [{ providerId: 'openai', modelId: 'gpt-5.5', input: '5', output: '30', cacheRead: '0.5', cacheWrite: '6.25' }],
    overrides: [
      { providerId: 'global-price', modelId: 'gpt-5.5', input: '4', output: '8', cacheRead: '0.4', cacheWrite: '0.8' },
      { providerId: 'route-a-price', modelId: 'gpt-5.5', input: '9', output: '18', cacheRead: '0.9', cacheWrite: '1.8' },
      { providerId: 'route-b-price', modelId: 'gpt-5.5', input: '11', output: '22', cacheRead: '1.1', cacheWrite: '2.2' },
    ],
    mappings: [
      { model: 'gpt-5.5', catalogProviderId: 'global-price', catalogModelId: 'gpt-5.5' },
      { identityKey: 'route-a-key', model: 'gpt-5.5', catalogProviderId: 'route-a-price', catalogModelId: 'gpt-5.5' },
      { identityKey: 'route-b-key', model: 'gpt-5.5', catalogProviderId: 'route-b-price', catalogModelId: 'gpt-5.5' },
    ],
  })
  const routeA = resolvePricing({ identityKey: 'route-a-key', provider: 'relay-a', actualModel: 'gpt-5.5' }, state)
  const routeB = resolvePricing({ identityKey: 'route-b-key', provider: 'relay-b', actualModel: 'gpt-5.5' }, state)
  const otherRoute = resolvePricing({ identityKey: 'other-route', provider: 'relay-c', actualModel: 'gpt-5.5' }, state)
  assert.equal(routeA.status, 'priced')
  assert.equal(routeA.rates.input, '9')
  assert.equal(routeB.status, 'priced')
  assert.equal(routeB.rates.input, '11')
  assert.equal(otherRoute.status, 'priced')
  assert.equal(otherRoute.rates.input, '4')
  assert.equal(serializePricingState(state).mappings[1].identityKey, 'route-a-key')
})

test('accepts legacy usageIdentityKey mappings and canonicalizes them', () => {
  const state = normalizePricingState({
    overrides: [{ providerId: 'legacy-price', modelId: 'gpt-5.5', input: '13', output: '26', cacheRead: '1.3', cacheWrite: '2.6' }],
    mappings: [{ usageIdentityKey: 'legacy-route', model: 'gpt-5.5', catalogProviderId: 'legacy-price', catalogModelId: 'gpt-5.5' }],
  })
  assert.equal(state.mappings.length, 1)
  assert.equal(state.mappings[0].identityKey, 'legacy-route')
  const resolved = resolvePricing({ identityKey: 'legacy-route', actualModel: 'gpt-5.5' }, state)
  const emptyCanonical = resolvePricing({ identityKey: '', usageIdentityKey: 'legacy-route', actualModel: 'gpt-5.5' }, state)
  assert.equal(resolved.status, 'priced')
  assert.equal(emptyCanonical.status, 'priced')
  assert.equal(resolved.rates.input, '13')
})



test('does not apply provider-scoped model mappings to another route', () => {
  const state = normalizePricingState({
    catalogEntries: [{ providerId: 'openai', modelId: 'gpt-5.5', input: '5', output: '30', cacheRead: '0.5', cacheWrite: '6.25' }],
    overrides: [{ providerId: 'openai', modelId: 'gpt-5.5-special', input: '9', output: '18', cacheRead: '0.9', cacheWrite: '1.8' }],
    mappings: [{ provider: 'relay-a', model: 'gpt-5.5', catalogProviderId: 'openai', catalogModelId: 'gpt-5.5-special' }],
  })
  const matching = resolvePricing({ provider: 'relay-a', actualModel: 'gpt-5.5' }, state)
  const other = resolvePricing({ provider: 'relay-b', actualModel: 'gpt-5.5' }, state)
  assert.equal(matching.rates.input, '9')
  assert.equal(other.rates.input, '5')
})

test('does not report tiered catalog pricing as flat priced', () => {
  const state = normalizePricingState({
    catalogEntries: [{ providerId: 'openai', modelId: 'gpt-5.5', input: '5', output: '30', cacheRead: '0.5', cacheWrite: '6.25', tiers: [{ input: 10 }] }],
  })
  const resolved = resolvePricing({ provider: 'relay', actualModel: 'gpt-5.5' }, state)
  assert.equal(resolved.status, 'unsupported')
  assert.equal(resolved.reason, 'tiered-pricing-not-modeled')
  assert.equal(resolved.tiered, true)
  const cost = calculateCost({ input: 1000000, output: 1000000 }, resolved)
  assert.equal(cost.status, 'unsupported')
  assert.equal(cost.total, '0')
})
