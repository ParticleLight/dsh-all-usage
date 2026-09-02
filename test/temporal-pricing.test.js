import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../lib/index.js'
import {
  calculateCost,
  normalizeCostSnapshot,
  normalizeTemporalPricing,
  resolvePricing,
  temporalBand,
  temporalPlanFor,
} from '../lib/pricing.js'

// ---------- helpers (same shape as aggregation.test.js) ----------

function makeResponse() {
  let body = ''
  const headers = {}
  const res = {
    statusCode: 200,
    setHeader(name, value) {
      headers[String(name).toLowerCase()] = value
    },
    end(value = '') {
      body += String(value)
    },
  }
  return { res, headers, body: () => body }
}

function makeRequest(method, headers = {}, body = '') {
  return {
    method,
    url: '/',
    headers,
    socket: { remoteAddress: '127.0.0.1' },
    on(event, callback) {
      if (event === 'data' && body !== '') callback(Buffer.from(body))
      if (event === 'end') callback()
      return this
    },
  }
}

async function createApp({ key = 'test-key', workspaces = [], withStorage = false, sessions = [], events = new Map(), listSessions: listSessionsOverride, readSession: readSessionOverride, ledgerSeed = {}, storage: storageUnitOverride } = {}) {
  const routes = new Map()
  const cleanups = []
  const listeners = {}
  const storageUnit = storageUnitOverride || {
    saved: [],
    global: {},
    records: { sessions: {} },
    async loadAll() {
      return { global: this.global || {}, tables: this.records }
    },
    async putRecord(table, key, value) {
      if (!this.records[table]) this.records[table] = {}
      this.records[table][key] = value
    },
    async deleteRecord(table, key) {
      if (this.records[table]) delete this.records[table][key]
    },
    async setGlobal(value) {
      this.saved.push(value)
      this.global = value
    },
    async close() {},
  }
  if (ledgerSeed !== null && typeof ledgerSeed === 'object') {
    if (!storageUnit.records) storageUnit.records = {}
    if (!storageUnit.records.sessions) storageUnit.records.sessions = {}
    Object.assign(storageUnit.records.sessions, ledgerSeed)
  }
  const webServer = {
    register(route) {
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  }
  const readCalls = new Map()
  const ctx = {
    sessionQuery: {
      async listSessions() {
        if (typeof listSessionsOverride === 'function') return listSessionsOverride()
        return sessions
      },
      async readSession(sid) {
        readCalls.set(sid, (readCalls.get(sid) || 0) + 1)
        if (typeof readSessionOverride === 'function') return readSessionOverride(sid)
        return { events: events instanceof Map ? (events.get(sid) || []) : [] }
      },
    },
    workspaceRegistry: {
      list() {
        return workspaces
      },
    },
    async timeout(ms) {
      if (typeof ms === 'number' && ms > 0) await new Promise((resolve) => setTimeout(resolve, 0))
    },
    on(event, handler) {
      listeners[event] = listeners[event] || []
      listeners[event].push(handler)
    },
    effect(factory) {
      const cleanup = factory()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
      return cleanup
    },
    get(service) {
      if (service === 'credentials') return { resolve: async () => ({ value: key }) }
      if (service === 'settings') return { get: () => ({}) }
      if (service === 'storage') return withStorage ? { backend: { get: () => ({ kv: { open: async () => storageUnit } }) } } : undefined
      if (service === 'webServer') return webServer
      if (service === 'sessionPersistence') return { listSnapshots: async () => [] }
      return undefined
    },
  }
  apply(ctx)
  await new Promise((resolve) => setImmediate(resolve))
  return { routes, storageUnit, cleanups, listeners, readCalls }
}

async function call(app, path, request) {
  const handler = app.routes.get(path)
  assert.equal(typeof handler, 'function', 'route should be registered: ' + path)
  const result = makeResponse()
  await handler(request, result.res)
  return { status: result.res.statusCode, body: result.body(), json: () => JSON.parse(result.body()) }
}

function usageEvent(time, turn, step, usage, seq, provider = 'deepseek', model = 'deepseek-v4-flash') {
  return {
    seq,
    time,
    type: 'assistant/message',
    data: {
      turn,
      step,
      message: { source: { provider, model } },
      usage,
    },
  }
}

function usageChunkEvent(time, turn, step, usage, seq) {
  return {
    seq,
    time,
    type: 'assistant/chunk',
    data: { turn, step, chunk: { type: 'usage', usage } },
  }
}

async function waitForLedgerWrite() {
  await new Promise((resolve) => setTimeout(resolve, 40))
}

async function waitForScan(app, predicate = (body) => body.scan.done) {
  let snapshot = null
  for (let i = 0; i < 200; i += 1) {
    snapshot = await call(app, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))
    if (predicate(snapshot.json())) return snapshot
    await new Promise((resolve) => setImmediate(resolve))
  }
  return snapshot
}

const V4_FLASH = { providerId: 'deepseek', modelId: 'deepseek-v4-flash', displayName: 'DeepSeek V4 Flash', input: '0.22', output: '0.66', cacheRead: '0.007', cacheWrite: '0' }
// 2026-08-17 is a Monday (after the 2026-08-16T16:00:00Z peak-pricing
// effective instant); 08-15 Saturday; 08-16 Sunday.
const MONDAY_PEAK = Date.UTC(2026, 7, 17, 2, 0, 0)          // 02:00 UTC peak window
const MONDAY_OFF = Date.UTC(2026, 7, 17, 10, 30, 0)         // 10:30 UTC off-peak
const MONDAY_EDGE_AM = Date.UTC(2026, 7, 17, 0, 59, 59)     // 00:59:59 off-peak
const MONDAY_EDGE_START = Date.UTC(2026, 7, 17, 1, 0, 0)    // 01:00:00 peak
const MONDAY_EDGE_END3 = Date.UTC(2026, 7, 17, 3, 59, 59)   // 03:59:59 peak
const MONDAY_EDGE_START4 = Date.UTC(2026, 7, 17, 4, 0, 0)   // 04:00:00 off-peak
const MONDAY_EDGE_START6 = Date.UTC(2026, 7, 17, 6, 0, 0)   // 06:00:00 peak
const MONDAY_EDGE_END10 = Date.UTC(2026, 7, 17, 10, 0, 0)   // 10:00:00 off-peak
const SATURDAY = Date.UTC(2026, 7, 15, 2, 0, 0)
const SUNDAY = Date.UTC(2026, 7, 16, 2, 0, 0)
const DEEPSEEK_EFFECTIVE = Date.UTC(2026, 7, 16, 16, 0, 0)  // official peak pricing start

function peakProfile() {
  return {
    policies: [{
      policyId: 'test-peak-policy',
      sourceUrl: 'https://example.test/pricing',
      timezone: 'UTC',
      effectiveFrom: 0,
      effectiveUntil: null,
      defaultPlan: null,
      rules: [{ id: 'peak', weekdays: [1, 2, 3, 4, 5], windows: [{ startMinute: 60, endMinute: 240 }, { startMinute: 360, endMinute: 600 }], rates: { input: '0.44', output: '1.32', cacheRead: '0.014', cacheWrite: '0' } }],
    }],
  }
}

// ---------- UTC band boundaries ----------

test('UTC peak windows use half-open boundaries and the 01:00-04:00 / 06:00-10:00 schedule', () => {
  const profile = peakProfile()
  assert.equal(temporalBand(profile, MONDAY_EDGE_AM), 'off-peak')       // 00:59:59
  assert.equal(temporalBand(profile, MONDAY_EDGE_START), 'peak')       // 01:00:00
  assert.equal(temporalBand(profile, MONDAY_EDGE_END3), 'peak')        // 03:59:59
  assert.equal(temporalBand(profile, MONDAY_EDGE_START4), 'off-peak')  // 04:00:00
  assert.equal(temporalBand(profile, Date.UTC(2026, 7, 3, 5, 59, 59)), 'off-peak')
  assert.equal(temporalBand(profile, MONDAY_EDGE_START6), 'peak')      // 06:00:00
  assert.equal(temporalBand(profile, Date.UTC(2026, 7, 3, 9, 59, 59)), 'peak')
  assert.equal(temporalBand(profile, MONDAY_EDGE_END10), 'off-peak')   // 10:00:00
  assert.equal(temporalBand(profile, SATURDAY), 'off-peak')            // Saturday all day
  assert.equal(temporalBand(profile, SUNDAY), 'off-peak')              // Sunday all day
})

test('temporal band rules are local-timezone independent (UTC methods only)', () => {
  const profile = peakProfile()
  const previousTz = process.env.TZ
  const cases = []
  try {
    for (const tz of ['Asia/Shanghai', 'America/New_York', 'Australia/Lord_Howe', 'Europe/Berlin']) {
      process.env.TZ = tz
      cases.push(temporalBand(profile, MONDAY_EDGE_START), temporalBand(profile, MONDAY_EDGE_AM), temporalBand(profile, SUNDAY), temporalBand(profile, MONDAY_EDGE_START6))
    }
  } finally {
    if (previousTz === undefined) delete process.env.TZ
    else process.env.TZ = previousTz
  }
  assert.deepEqual(cases, ['peak', 'off-peak', 'off-peak', 'peak', 'peak', 'off-peak', 'off-peak', 'peak', 'peak', 'off-peak', 'off-peak', 'peak', 'peak', 'off-peak', 'off-peak', 'peak'])
})

// ---------- temporal plan normalization ----------

test('normalizeTemporalPricing rejects ambiguous or invalid configurations', () => {
  const base = { policyId: 'p', rules: [{ id: 'peak', weekdays: [1, 2], windows: [{ startMinute: 60, endMinute: 240 }], rates: { input: '1', output: '1', cacheRead: '1', cacheWrite: '0' } }] }
  assert.deepEqual(normalizeTemporalPricing(base), { policies: [{ policyId: 'p', sourceUrl: '', timezone: 'UTC', effectiveFrom: 0, effectiveUntil: null, defaultPlan: null, rules: [{ id: 'peak', weekdays: [1, 2], windows: [{ startMinute: 60, endMinute: 240 }], rates: { input: '1', output: '1', cacheRead: '1', cacheWrite: '0' } }] }] })
  assert.equal(normalizeTemporalPricing({ ...base, timezone: 'Asia/Shanghai' }), null)
  assert.equal(normalizeTemporalPricing({ ...base, policyId: '' }), null)
  assert.equal(normalizeTemporalPricing({ ...base, effectiveFrom: -1 }), null)
  assert.equal(normalizeTemporalPricing({ ...base, effectiveUntil: 5, effectiveFrom: 10 }), null)
  assert.equal(normalizeTemporalPricing({ ...base, rules: [] }), null)
  assert.equal(normalizeTemporalPricing({ ...base, rules: [{ id: 'peak', weekdays: [7], windows: [{ startMinute: 60, endMinute: 240 }], rates: { input: '1', output: '1', cacheRead: '1', cacheWrite: '0' } }] }), null)
  assert.equal(normalizeTemporalPricing({ ...base, rules: [{ id: 'peak', weekdays: [1], windows: [{ startMinute: 240, endMinute: 60 }] }] }), null)
  // Overlapping windows are rejected deterministically.
  assert.equal(normalizeTemporalPricing({ ...base, rules: [{ id: 'peak', weekdays: [1], windows: [{ startMinute: 60, endMinute: 180 }, { startMinute: 120, endMinute: 240 }] }] }), null)
  assert.equal(normalizeTemporalPricing({ ...base, rules: [{ id: 'peak', weekdays: [1], windows: [{ startMinute: 60, endMinute: 520 }] }] }), null)
})

// ---------- exact BigInt costs per band ----------

test('calculateCost applies the exact band rates with BigInt decimal precision', () => {
  const state = { catalogEntries: [{ ...V4_FLASH, source: 'models.dev', fetchedAt: 0 }], overrides: [], mappings: [], providerAliases: {} }
  const resolved = resolvePricing({ provider: 'deepseek', requestedModel: 'deepseek-v4-flash', actualModel: 'deepseek-v4-flash', label: 'deepseek-v4-flash', legacy: false }, state)
  assert.equal(resolved.status, 'priced')
  assert.equal(resolved.temporalRoute, 'official')
  const values = { input: 2000000, output: 1000000, cacheRead: 1000000, cacheWrite: 0, reasoning: 0 }
  const peak = calculateCost(values, resolved, MONDAY_PEAK, 'usage-event')
  assert.equal(peak.status, 'priced')
  assert.equal(peak.pricingBand, 'peak')
  assert.equal(peak.pricingTimezone, 'UTC')
  assert.equal(peak.pricingAt, MONDAY_PEAK)
  assert.equal(peak.pricingTimeSource, 'usage-event')
  assert.equal(peak.pricingPolicyId, 'deepseek-v4-2026-08-pricing')
  assert.ok(peak.pricingPolicyHash)
  assert.equal(peak.temporalApplicable, true)
  // 2M input * 0.44/1M = 0.88; 1M output * 1.32/1M = 1.32; 1M cache * 0.014/1M = 0.014
  assert.equal(peak.breakdown.input, '0.88')
  assert.equal(peak.breakdown.output, '1.32')
  assert.equal(peak.breakdown.cacheRead, '0.014')
  assert.equal(peak.breakdown.cacheWrite, '0')
  assert.equal(peak.baseTotal, '2.214')
  assert.equal(peak.total, '2.214')
  const off = calculateCost(values, resolved, MONDAY_OFF, 'usage-event')
  assert.equal(off.pricingBand, 'off-peak')
  assert.equal(off.breakdown.input, '0.44')
  assert.equal(off.breakdown.output, '0.66')
  assert.equal(off.breakdown.cacheRead, '0.007')
  assert.equal(off.total, '1.107')
})

test('resolvePricing applies the built-in DeepSeek profile only on first-party routes', () => {
  const state = { catalogEntries: [{ ...V4_FLASH, source: 'models.dev', fetchedAt: 0 }], overrides: [], mappings: [], providerAliases: {} }
  const official = resolvePricing({ provider: 'deepseek', requestedModel: 'deepseek-v4-flash', actualModel: 'deepseek-v4-flash', label: 'deepseek-v4-flash', legacy: false }, state)
  assert.equal(official.temporalRoute, 'official')
  const officialNamed = resolvePricing({ provider: 'deepseek-official', requestedModel: 'deepseek-v4-flash', actualModel: 'deepseek-v4-flash', label: 'deepseek-official / deepseek-v4-flash', legacy: false }, state)
  assert.equal(officialNamed.temporalRoute, 'official')
  const reseller = resolvePricing({ provider: 'openrouter', requestedModel: 'deepseek-v4-flash', actualModel: 'deepseek-v4-flash', label: 'openrouter / deepseek-v4-flash', legacy: false }, state)
  assert.equal(reseller.temporalRoute, 'other')
  const plan = temporalPlanFor(reseller, MONDAY_PEAK)
  assert.equal(plan.status, 'other-route')
  assert.equal(plan.band, null)
  assert.equal(plan.exemptReason, 'route-not-official')
  const resellerCost = calculateCost({ input: 2000000, output: 1000000, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, reseller, MONDAY_PEAK, 'usage-event')
  assert.equal(resellerCost.status, 'priced')
  assert.equal(resellerCost.pricingBand, null)
  assert.equal(resellerCost.temporalApplicable, false)
  assert.equal(resellerCost.temporalExemptReason, 'route-not-official')
  assert.equal(resellerCost.total, '1.1')
  // Legacy route with no provider never silently inherits the band plan.
  const legacy = resolvePricing({ requestedModel: 'deepseek-v4-flash', actualModel: 'deepseek-v4-flash', label: 'deepseek-v4-flash', legacy: false }, state)
  assert.equal(legacy.temporalRoute, 'other')
})

test('a plan whose effective window does not cover the instant fails closed', () => {
  const profile = peakProfile()
  const gapped = { ...profile.policies[0], effectiveFrom: Date.UTC(2027, 0, 1), effectiveUntil: null }
  const resolved = { temporalProfile: { policies: [{ ...gapped, policyHash: 'h' }] }, temporalRoute: 'official', status: 'priced', rates: profile.policies[0].rules[0].rates, currency: 'USD', source: 'manual', pricingModel: 'deepseek-v4-flash', providerId: 'deepseek', inputTokenSemantics: 'fresh', multiplier: '1', tiered: false, reasoningRateAvailable: false }
  const plan = temporalPlanFor(resolved, MONDAY_PEAK)
  assert.equal(plan.status, 'history-gap')
  const cost = calculateCost({ input: 1000000, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, resolved, MONDAY_PEAK, 'usage-event')
  assert.equal(cost.status, 'unsupported')
  assert.equal(cost.reason, 'temporal-price-history-unavailable')
  assert.equal(cost.total, '0')
})

test('the built-in plan starts exactly at the official 2026-08-16T16:00:00Z instant', () => {
  const state = { catalogEntries: [{ ...V4_FLASH, source: 'models.dev', fetchedAt: 0 }], overrides: [], mappings: [], providerAliases: {} }
  const resolved = resolvePricing({ provider: 'deepseek', requestedModel: 'deepseek-v4-flash', actualModel: 'deepseek-v4-flash', label: 'deepseek-v4-flash', legacy: false }, state)
  const values = { input: 1000000, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
  // 1 ms before the effective instant: fail closed, never today's V4 rates.
  const beforeMs = calculateCost(values, resolved, DEEPSEEK_EFFECTIVE - 1, 'usage-event')
  assert.equal(beforeMs.status, 'unsupported')
  assert.equal(beforeMs.reason, 'temporal-price-history-unavailable')
  const beforeSecond = calculateCost(values, resolved, DEEPSEEK_EFFECTIVE - 1000, 'usage-event')
  assert.equal(beforeSecond.status, 'unsupported')
  assert.equal(temporalBand(resolved.temporalProfile, DEEPSEEK_EFFECTIVE - 1), null)
  // Exactly at the instant: the plan applies (08-16 is Sunday, off-peak).
  const atMs = calculateCost(values, resolved, DEEPSEEK_EFFECTIVE, 'usage-event')
  assert.equal(atMs.status, 'priced')
  assert.equal(atMs.pricingBand, 'off-peak')
  const atPlus = calculateCost(values, resolved, DEEPSEEK_EFFECTIVE + 1000, 'usage-event')
  assert.equal(atPlus.pricingBand, 'off-peak')
  // Weekday instants right after the effective start still respect the windows.
  const mondayAfter = calculateCost(values, resolved, MONDAY_EDGE_START, 'usage-event')
  assert.equal(mondayAfter.status, 'priced')
  assert.equal(mondayAfter.pricingBand, 'peak')
})

test('vision-exp got its own availability boundary on 2026-08-21', () => {
  const state = { catalogEntries: [{ ...V4_FLASH, modelId: 'deepseek-v4-flash-vision-exp', source: 'models.dev', fetchedAt: 0 }], overrides: [], mappings: [], providerAliases: {} }
  const resolved = resolvePricing({ provider: 'deepseek', requestedModel: 'deepseek-v4-flash-vision-exp', actualModel: 'deepseek-v4-flash-vision-exp', label: 'deepseek-v4-flash-vision-exp', legacy: false }, state)
  assert.equal(temporalBand(resolved.temporalProfile, Date.UTC(2026, 7, 20, 23, 59, 59)), null)
  assert.equal(temporalBand(resolved.temporalProfile, Date.UTC(2026, 7, 21, 0, 0, 0)), 'off-peak')
})

// ---------- snapshot schema round trips ----------

test('normalizeCostSnapshot carries v2 temporal fields and marks legacy snapshots', () => {
  const legacy = normalizeCostSnapshot({ status: 'priced', pricingMode: 'official-model', currency: 'USD', source: 'catalog', pricingModel: 'deepseek-v4-flash', providerId: 'deepseek', inputTokenSemantics: 'fresh', multiplier: '1', billableInputTokens: 1, billableOutputTokens: 1, rates: { input: '0.22', output: '0.66', cacheRead: '0.007', cacheWrite: '0' }, breakdown: { input: '0', output: '0', cacheRead: '0', cacheWrite: '0' }, baseTotal: '0', total: '0', reason: '', tiered: false })
  assert.equal(legacy.schemaVersion, 2)
  assert.equal(legacy.pricingTimeSource, 'legacy-unknown')
  assert.equal(legacy.pricingBand, null)
  assert.equal(legacy.pricingAt, null)
  const v2 = normalizeCostSnapshot({ ...legacy, pricingAt: MONDAY_PEAK, pricingTimeSource: 'usage-event', pricingBand: 'peak', pricingTimezone: 'UTC', pricingPolicyId: 'deepseek-v4-2026-08-pricing', pricingPolicyHash: 'abc', temporalApplicable: true, temporalExemptReason: null })
  assert.equal(v2.pricingAt, MONDAY_PEAK)
  assert.equal(v2.pricingBand, 'peak')
  assert.equal(v2.pricingPolicyHash, 'abc')
  assert.equal(v2.temporalApplicable, true)
  assert.equal(normalizeCostSnapshot({ ...v2, pricingAt: -1 }), null)
  assert.equal(normalizeCostSnapshot({ ...v2, pricingBand: 'evening' }), null)
})

// ---------- integration: cross-boundary reuse, migration, cache invalidation ----------

async function postPricing(app, token, payload) {
  return call(app, '/api/all-usage/pricing', makeRequest('POST', { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', 'x-all-usage-request-token': token }, JSON.stringify(payload)))
}

test('a final message crossing the peak boundary never reuses the chunk price', async () => {
  const app = await createApp({
    withStorage: true,
    workspaces: [{ id: 'ws-x', path: 'C:\\x', title: 'X' }],
    sessions: [{ header: { id: 's-x', cwd: 'C:\\x' } }],
    events: new Map([['s-x', [
      usageChunkEvent(MONDAY_EDGE_END3, 1, 1, { inputTokens: 1000000, outputTokens: 500000, cacheReadTokens: 0, cacheWriteTokens: 0 }, 1),
      usageEvent(MONDAY_EDGE_START4, 1, 1, { inputTokens: 1000000, outputTokens: 500000, cacheReadTokens: 0, cacheWriteTokens: 0 }, 2),
    ]]]),
  })
  await waitForScan(app)
  const snapshot = (await call(app, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))).json()
  const token = snapshot.requestToken
  await postPricing(app, token, { pricing: { catalogEntries: [V4_FLASH] }, backfill: true })
  await waitForScan(app, (body) => body.totals.cost.pricedCalls === 1)
  const dateText = snapshot.byDay[0].date
  const request = makeRequest('GET', { host: '127.0.0.1:3080' })
  request.url = '/api/all-usage/records?start=' + dateText + '&end=' + dateText + '&utc=0&limit=10'
  const records = (await call(app, '/api/all-usage/records', request)).json()
  assert.equal(records.items.length, 1)
  const cost = records.items[0].cost
  // The message at 04:00:00 is off-peak and must win over the chunk snapshot
  // (same turn/step key); the 03:59:59 request/context stays unknown for it.
  assert.equal(cost.pricingBand, 'off-peak')
  assert.equal(cost.pricingAt, MONDAY_EDGE_START4)
  assert.equal(cost.total, '0.55')
  const totals = (await call(app, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))).json()
  assert.equal(totals.totals.cost.total, '0.55')
})

test('request-context instants are preferred when they match turn and step', async () => {
  const app = await createApp({
    withStorage: true,
    workspaces: [{ id: 'ws-ctx', path: 'C:\\ctx', title: 'Ctx' }],
    sessions: [{ header: { id: 's-ctx', cwd: 'C:\\ctx' } }],
    events: new Map([['s-ctx', [
      { seq: 1, time: MONDAY_EDGE_START, type: 'request/context', data: { provider: 'deepseek', model: 'deepseek-v4-flash', turn: 1, step: 1 } },
      { seq: 2, time: MONDAY_EDGE_START, type: 'request/context', data: { provider: 'deepseek', model: 'deepseek-v4-flash', turn: 2, step: 1 } },
      usageEvent(MONDAY_OFF, 1, 1, { inputTokens: 1000000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, 3),
      usageEvent(MONDAY_OFF, 2, 1, { inputTokens: 1000000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, 4),
    ]]]),
  })
  await waitForScan(app)
  const snapshot = (await call(app, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))).json()
  const token = snapshot.requestToken
  await postPricing(app, token, { pricing: { catalogEntries: [V4_FLASH] }, backfill: true })
  await waitForScan(app, (body) => body.totals.cost.pricedCalls === 2)
  const dateText = snapshot.byDay[0].date
  const request = makeRequest('GET', { host: '127.0.0.1:3080' })
  request.url = '/api/all-usage/records?start=' + dateText + '&end=' + dateText + '&utc=0&limit=10'
  const items = (await call(app, '/api/all-usage/records', request)).json().items
  const byTurn = (turn) => items.find((item) => item.turn === turn)
  assert.equal(byTurn(1).cost.pricingTimeSource, 'request-context')
  assert.equal(byTurn(1).cost.pricingAt, MONDAY_EDGE_START)
  assert.equal(byTurn(1).cost.pricingBand, 'peak')
  assert.equal(byTurn(2).cost.pricingBand, 'peak')
})

test('ledger v1 snapshots are re-priced on recovery and persisted with the band', async () => {
  const v1 = {
    status: 'priced', pricingMode: 'official-model', currency: 'USD', source: 'catalog', pricingModel: 'deepseek-v4-flash', providerId: 'deepseek', inputTokenSemantics: 'fresh', multiplier: '1', billableInputTokens: 1000000, billableOutputTokens: 0,
    rates: { input: '0.22', output: '0.66', cacheRead: '0.007', cacheWrite: '0' }, breakdown: { input: '0.22', output: '0', cacheRead: '0', cacheWrite: '0' }, baseTotal: '0.22', total: '0.22', reason: '', tiered: false,
  }
  const identity = { identityKey: 'deepseek / deepseek-v4-flash', provider: 'deepseek', requestedModel: 'deepseek-v4-flash', actualModel: 'deepseek-v4-flash', label: 'deepseek-v4-flash', legacy: false }
  const record = {
    version: 3, sessionId: 's-migrate', workspaceId: 'ws-m', lastSeq: 2, lastRevision: 'r1', updatedAt: 1000,
    turns: [{ key: 's-migrate:turn:1', seq: 1, time: MONDAY_PEAK, workspaceId: 'ws-m', turn: 1, identity }],
    usage: [{ key: 's-migrate:step:1:1', seq: 2, time: MONDAY_PEAK, workspaceId: 'ws-m', identity, modelId: 'deepseek-v4-flash', turn: 1, step: 1, values: { input: 1000000, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, cost: v1 }],
    lastIdentity: identity,
  }
  const app = await createApp({
    withStorage: true,
    ledgerSeed: { 's-migrate': record },
    workspaces: [{ id: 'ws-m', path: 'C:\\m', title: 'M' }],
    // Session listed but unreadable: the baseline applies the ledger record
    // through ledger-recovery and the reconciliation pass must re-price it.
    sessions: [{ header: { id: 's-migrate', cwd: 'C:\\m' } }],
    readSession: async () => { throw new Error('read failed') },
  })
  await waitForScan(app)
  const snap = (await call(app, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))).json()
  const token = snap.requestToken
  await postPricing(app, token, { pricing: { catalogEntries: [V4_FLASH] }, backfill: true })
  await waitForScan(app, (body) => body.totals.cost.pricedCalls === 1)
  const after = (await call(app, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))).json()
  assert.equal(after.totals.cost.total, '0.44')
  const stored = app.storageUnit.records.sessions['s-migrate'].usage[0].cost
  assert.equal(stored.pricingBand, 'peak')
  assert.equal(stored.pricingTimeSource, 'usage-event')
  assert.ok(stored.pricingPolicyHash)
})

test('catalog refreshes keep priced history auditable; repriceTemporal re-estimates', async () => {
  const app = await createApp({
    withStorage: true,
    workspaces: [{ id: 'ws-u', path: 'C:\\u', title: 'U' }],
    sessions: [{ header: { id: 's-u', cwd: 'C:\\u' } }],
    events: new Map([['s-u', [
      { seq: 1, time: MONDAY_OFF, type: 'request/context', data: { provider: 'deepseek', model: 'deepseek-v4-flash', turn: 1, step: 1 } },
      usageEvent(MONDAY_OFF, 1, 1, { inputTokens: 1000000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, 2),
    ]]]),
  })
  await waitForScan(app)
  const snap = (await call(app, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))).json()
  const token = snap.requestToken
  await postPricing(app, token, { pricing: { catalogEntries: [V4_FLASH] }, backfill: true })
  await waitForScan(app, (body) => body.totals.cost.pricedCalls === 1)
  let totals = (await call(app, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))).json().totals.cost
  assert.equal(totals.total, '0.22')
  // Catalog refresh with a new off-peak rate: the priced v2 snapshot keeps its
  // event-time estimate (auditable history) instead of being rewritten.
  await postPricing(app, token, { pricing: { catalogEntries: [{ ...V4_FLASH, input: '0.25' }] }, backfill: true })
  await new Promise((resolve) => setTimeout(resolve, 60))
  totals = (await call(app, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))).json().totals.cost
  assert.equal(totals.total, '0.22')
  // New usage after the refresh uses the current catalog rate.
  const liveHandler = app.listeners['session/event'][0]
  liveHandler({ id: 's-u', header: { cwd: 'C:\\u' } }, usageEvent(MONDAY_OFF, 2, 1, { inputTokens: 1000000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, 3, 'deepseek', 'deepseek-v4-flash'))
  for (let i = 0; i < 40; i += 1) {
    await new Promise((resolve) => setImmediate(resolve))
    totals = (await call(app, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))).json().totals.cost
    if (totals.total === '0.47') break
  }
  assert.equal(totals.total, '0.47')
  // Explicit repricing recomputes every priced v2 snapshot against the plan.
  await postPricing(app, token, { pricing: { catalogEntries: [{ ...V4_FLASH, input: '0.25' }] }, backfill: true, repriceTemporal: true })
  for (let i = 0; i < 60; i += 1) {
    await new Promise((resolve) => setImmediate(resolve))
    totals = (await call(app, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))).json().totals.cost
    if (totals.total === '0.5') break
  }
  assert.equal(totals.total, '0.5')
  const request = makeRequest('GET', { host: '127.0.0.1:3080' })
  request.url = '/api/all-usage/query?start=' + snap.byDay[0].date + '&end=' + snap.byDay[0].date + '&utc=0'
  assert.equal((await call(app, '/api/all-usage/query', request)).json().totals.cost.total, '0.5')
})

test('reseller routes never inherit the DeepSeek band plan end to end', async () => {
  const app = await createApp({
    withStorage: true,
    workspaces: [{ id: 'ws-r', path: 'C:\\r', title: 'R' }],
    sessions: [{ header: { id: 's-r', cwd: 'C:\\r' } }],
    events: new Map([['s-r', [
      usageEvent(MONDAY_PEAK, 1, 1, { inputTokens: 1000000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, 1, 'openrouter', 'deepseek-v4-flash'),
    ]]]),
  })
  await waitForScan(app)
  const snap = (await call(app, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))).json()
  const token = snap.requestToken
  await postPricing(app, token, { pricing: { catalogEntries: [V4_FLASH] }, backfill: true })
  await waitForScan(app, (body) => body.totals.cost.pricedCalls === 1)
  const dateText = snap.byDay[0].date
  const request = makeRequest('GET', { host: '127.0.0.1:3080' })
  request.url = '/api/all-usage/records?start=' + dateText + '&end=' + dateText + '&utc=0&limit=10'
  const cost = (await call(app, '/api/all-usage/records', request)).json().items[0].cost
  assert.equal(cost.pricingBand, null)
  assert.equal(cost.temporalApplicable, false)
  assert.equal(cost.temporalExemptReason, 'route-not-official')
  // Static official price: 1M input at 0.22 regardless of the peak instant.
  assert.equal(cost.total, '0.22')
})

test('mapped routes may declare the DeepSeek official billing plan explicitly', async () => {
  const app = await createApp({
    withStorage: true,
    workspaces: [{ id: 'ws-map', path: 'C:\\map', title: 'Map' }],
    sessions: [{ header: { id: 's-map', cwd: 'C:\\map' } }],
    events: new Map([['s-map', [
      usageEvent(MONDAY_PEAK, 1, 1, { inputTokens: 1000000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, 1, 'my-gateway', 'deepseek-v4-flash'),
    ]]]),
  })
  await waitForScan(app)
  const snap = (await call(app, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))).json()
  const token = snap.requestToken
  await postPricing(app, token, { pricing: { catalogEntries: [V4_FLASH], mappings: [{ provider: 'my-gateway', model: 'deepseek-v4-flash', catalogProviderId: 'deepseek', catalogModelId: 'deepseek-v4-flash' }] }, backfill: true })
  await waitForScan(app, (body) => body.totals.cost.pricedCalls === 1)
  const dateText = snap.byDay[0].date
  const request = makeRequest('GET', { host: '127.0.0.1:3080' })
  request.url = '/api/all-usage/records?start=' + dateText + '&end=' + dateText + '&utc=0&limit=10'
  const cost = (await call(app, '/api/all-usage/records', request)).json().items[0].cost
  assert.equal(cost.pricingBand, 'peak')
  assert.equal(cost.total, '0.44')
})

test('unknown historical models never get a guessed band price (fail closed on gap)', async () => {
  const app = await createApp({
    withStorage: true,
    workspaces: [{ id: 'ws-gap', path: 'C:\\gap', title: 'Gap' }],
    sessions: [{ header: { id: 's-gap', cwd: 'C:\\gap' } }],
    events: new Map([['s-gap', [
      usageEvent(MONDAY_PEAK, 1, 1, { inputTokens: 1000000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, 1),
    ]]]),
  })
  await waitForScan(app)
  const snap = (await call(app, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))).json()
  const token = snap.requestToken
  await postPricing(app, token, { pricing: { catalogEntries: [{ ...V4_FLASH, temporalPricing: { policyId: 'later-plan', timezone: 'UTC', effectiveFrom: Date.UTC(2027, 0, 1), effectiveUntil: null, defaultPlan: null, rules: [{ id: 'peak', weekdays: [1, 2, 3, 4, 5], windows: [{ startMinute: 60, endMinute: 240 }], rates: { input: '0.44', output: '1.32', cacheRead: '0.014', cacheWrite: '0' } }] } }] }, backfill: true })
  await waitForScan(app, (body) => body.totals.cost.unsupportedCalls === 1)
  const dateText = snap.byDay[0].date
  const request = makeRequest('GET', { host: '127.0.0.1:3080' })
  request.url = '/api/all-usage/records?start=' + dateText + '&end=' + dateText + '&utc=0&limit=10'
  const cost = (await call(app, '/api/all-usage/records', request)).json().items[0].cost
  assert.equal(cost.status, 'unsupported')
  assert.equal(cost.reason, 'temporal-price-history-unavailable')
  assert.equal(cost.total, '0')
})

test('overlapping rules across different rules are rejected regardless of order', () => {
  const base = (rates) => ({ policyId: 'p', rules: [{ id: 'a', weekdays: [1], windows: [{ startMinute: 60, endMinute: 240 }], rates }, { id: 'b', weekdays: [1], windows: [{ startMinute: 120, endMinute: 300 }], rates }] })
  const ratesA = { input: '1', output: '1', cacheRead: '1', cacheWrite: '0' }
  const ratesB = { input: '2', output: '2', cacheRead: '2', cacheWrite: '0' }
  assert.equal(normalizeTemporalPricing(base(ratesA), ratesA), null)
  assert.equal(normalizeTemporalPricing({ policyId: 'p', rules: [{ id: 'b', weekdays: [1], windows: [{ startMinute: 120, endMinute: 300 }], rates: ratesB }, { id: 'a', weekdays: [1], windows: [{ startMinute: 60, endMinute: 240 }], rates: ratesA }] }, ratesA), null)
  // Adjacent windows are still legal (half-open [60,240) then [240,420)).
  assert.ok(normalizeTemporalPricing({ policyId: 'p', rules: [{ id: 'a', weekdays: [1], windows: [{ startMinute: 60, endMinute: 240 }], rates: ratesA }, { id: 'b', weekdays: [1], windows: [{ startMinute: 240, endMinute: 420 }], rates: ratesB }] }, ratesA))
})

test('an invalid temporal config never silently falls back to the built-in profile', async () => {
  const app = await createApp({
    withStorage: true,
    workspaces: [{ id: 'ws-inv', path: 'C:\\inv', title: 'Inv' }],
    sessions: [{ header: { id: 's-inv', cwd: 'C:\\inv' } }],
    events: new Map([['s-inv', [
      usageEvent(MONDAY_PEAK, 1, 1, { inputTokens: 1000000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, 1),
    ]]]),
  })
  await waitForScan(app)
  const snap = (await call(app, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))).json()
  const token = snap.requestToken
  // timezone other than UTC makes the whole temporal config invalid.
  await postPricing(app, token, { pricing: { catalogEntries: [Object.assign({}, V4_FLASH, { temporalPricing: { policyId: 'bad-plan', timezone: 'Asia/Shanghai', effectiveFrom: 0, effectiveUntil: null, defaultPlan: null, rules: [{ id: 'peak', weekdays: [1, 2, 3, 4, 5], windows: [{ startMinute: 60, endMinute: 240 }], rates: { input: '0.44', output: '1.32', cacheRead: '0.014', cacheWrite: '0' } }] } })] }, backfill: true })
  await waitForScan(app, (body) => body.totals.cost.unsupportedCalls === 1)
  const dateText = snap.byDay[0].date
  const request = makeRequest('GET', { host: '127.0.0.1:3080' })
  request.url = '/api/all-usage/records?start=' + dateText + '&end=' + dateText + '&utc=0&limit=10'
  const cost = (await call(app, '/api/all-usage/records', request)).json().items[0].cost
  assert.equal(cost.status, 'unsupported')
  assert.equal(cost.reason, 'temporal-config-invalid')
  assert.equal(cost.total, '0')
})

test('entries with the same flat rates but different band plans resolve ambiguous', () => {
  const planA = { policyId: 'plan-a', timezone: 'UTC', effectiveFrom: 0, effectiveUntil: null, defaultPlan: null, rules: [{ id: 'peak', weekdays: [1, 2, 3, 4, 5], windows: [{ startMinute: 60, endMinute: 240 }], rates: { input: '0.44', output: '1.32', cacheRead: '0.014', cacheWrite: '0' } }] }
  const planB = { policyId: 'plan-b', timezone: 'UTC', effectiveFrom: 0, effectiveUntil: null, defaultPlan: null, rules: [{ id: 'peak', weekdays: [1, 2, 3, 4, 5], windows: [{ startMinute: 360, endMinute: 600 }], rates: { input: '0.5', output: '1.4', cacheRead: '0.02', cacheWrite: '0' } }] }
  const state = {
    catalogEntries: [],
    overrides: [
      Object.assign({}, V4_FLASH, { providerName: 'DeepSeek A', temporalPricing: planA }),
      Object.assign({}, V4_FLASH, { providerName: 'DeepSeek B', temporalPricing: planB }),
    ],
    mappings: [],
    providerAliases: {},
  }
  const resolved = resolvePricing({ provider: 'deepseek', requestedModel: 'deepseek-v4-flash', actualModel: 'deepseek-v4-flash', label: 'deepseek-v4-flash', legacy: false }, state)
  assert.equal(resolved.status, 'ambiguous')
  assert.equal(resolved.reason, 'multiple-official-prices')
})

test('incremental ledger folds keep the request context from a previous batch after a restart', async () => {
  const contextAt = MONDAY_PEAK
  const first = await createApp({
    withStorage: true,
    workspaces: [{ id: 'ws-ctx2', path: 'C:\\ctx2', title: 'Ctx2' }],
    sessions: [{ header: { id: 's-ctx2', cwd: 'C:\\ctx2' } }],
    events: new Map([['s-ctx2', [
      { seq: 0, time: contextAt, type: 'request/context', data: { provider: 'deepseek', model: 'deepseek-v4-flash', turn: 1, step: 1 } },
      { seq: 1, time: contextAt, type: 'turn/end', data: { turn: 1 } },
    ]]]),
    snapshots: [{ header: { id: 's-ctx2' }, revision: 'r1' }],
  })
  await waitForScan(first)
  assert.ok(Array.isArray(first.storageUnit.records.sessions['s-ctx2'].contextTimes))
  assert.equal(first.storageUnit.records.sessions['s-ctx2'].contextTimes.length, 1)
  await waitForLedgerWrite()
  // Restart with an appended usage tail: the context arrived in the previous
  // batch, so the incremental fold must seed it from the persisted archive.
  const second = await createApp({
    withStorage: true,
    storage: first.storageUnit,
    workspaces: [{ id: 'ws-ctx2', path: 'C:\\ctx2', title: 'Ctx2' }],
    sessions: [{ header: { id: 's-ctx2', cwd: 'C:\\ctx2' } }],
    events: new Map([['s-ctx2', [
      { seq: 0, time: contextAt, type: 'request/context', data: { provider: 'deepseek', model: 'deepseek-v4-flash', turn: 1, step: 1 } },
      { seq: 1, time: contextAt, type: 'turn/end', data: { turn: 1 } },
      usageEvent(MONDAY_OFF, 1, 1, { inputTokens: 1000000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, 2),
    ]]]),
    snapshots: [{ header: { id: 's-ctx2' }, revision: 'r2' }],
  })
  await waitForScan(second)
  const snap = (await call(second, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))).json()
  const token = snap.requestToken
  await postPricing(second, token, { pricing: { catalogEntries: [V4_FLASH] }, backfill: true })
  await waitForScan(second, (body) => body.totals.cost.pricedCalls === 1)
  const dateText = snap.byDay[0].date
  const request = makeRequest('GET', { host: '127.0.0.1:3080' })
  request.url = '/api/all-usage/records?start=' + dateText + '&end=' + dateText + '&utc=0&limit=10'
  const cost = (await call(second, '/api/all-usage/records', request)).json().items[0].cost
  assert.equal(cost.pricingAt, contextAt)
  assert.equal(cost.pricingTimeSource, 'request-context')
  assert.equal(cost.pricingBand, 'peak')
  assert.equal(cost.total, '0.44')
})

test('a full live resync clears stale request contexts after a history rewrite', async () => {
  let source = [
    { seq: 0, time: MONDAY_PEAK, type: 'request/context', data: { provider: 'deepseek', model: 'deepseek-v4-flash', turn: 1, step: 1 } },
    usageEvent(MONDAY_OFF, 1, 1, { inputTokens: 1000000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, 1),
  ]
  const app = await createApp({
    withStorage: true,
    workspaces: [{ id: 'ws-rew', path: 'C:\\rew3', title: 'Rew3' }],
    sessions: [{ header: { id: 's-rew3', cwd: 'C:\\rew3' } }],
    events: new Map(),
    readSession: async () => ({ events: source }),
    snapshots: [{ header: { id: 's-rew3' }, revision: 'r1' }],
  })
  await waitForScan(app)
  const snap = (await call(app, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))).json()
  const token = snap.requestToken
  await postPricing(app, token, { pricing: { catalogEntries: [V4_FLASH] }, backfill: true })
  await waitForScan(app, (body) => body.totals.cost.pricedCalls === 1)
  const dateText = snap.byDay[0].date
  let request = makeRequest('GET', { host: '127.0.0.1:3080' })
  request.url = '/api/all-usage/records?start=' + dateText + '&end=' + dateText + '&utc=0&limit=10'
  let cost = (await call(app, '/api/all-usage/records', request)).json().items[0].cost
  assert.equal(cost.pricingBand, 'peak')
  assert.equal(cost.pricingTimeSource, 'request-context')
  // History rewrite removes the request/context; the rewrite becomes
  // authoritative once the snapshot contains the triggering event (tail seq
  // matches), so the live resync drops the stale peak context.
  source = [
    usageEvent(MONDAY_OFF, 1, 1, { inputTokens: 1000000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, 1),
    { seq: 3, time: MONDAY_OFF, type: 'turn/end', data: { turn: 1 } },
  ]
  app.listeners['session/event'][0]({ id: 's-rew3', header: { cwd: 'C:\\rew3' } }, { seq: 3, time: MONDAY_OFF, type: 'turn/end', data: { turn: 1 } })
  let outcome = null
  for (let i = 0; i < 100; i += 1) {
    await new Promise((resolve) => setImmediate(resolve))
    request = makeRequest('GET', { host: '127.0.0.1:3080' })
    request.url = '/api/all-usage/records?start=' + dateText + '&end=' + dateText + '&utc=0&limit=10'
    const items = (await call(app, '/api/all-usage/records', request)).json().items
    if (items.length > 0) {
      const candidate = items[0].cost
      outcome = candidate
      if (candidate.pricingBand === 'off-peak') break
    }
  }
  assert.ok(outcome !== null)
  assert.equal(outcome.pricingBand, 'off-peak')
  assert.equal(outcome.pricingTimeSource, 'usage-event')
  assert.equal(outcome.pricingAt, MONDAY_OFF)
})

test('an authoritative live resync removes usage deleted by a rewritten history', async () => {
  let source = [
    { seq: 0, time: MONDAY_PEAK, type: 'request/context', data: { provider: 'deepseek', model: 'deepseek-v4-flash', turn: 1, step: 1 } },
    usageEvent(MONDAY_OFF, 1, 1, { inputTokens: 1000000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, 1),
  ]
  const app = await createApp({
    withStorage: true,
    workspaces: [{ id: 'ws-del', path: 'C:\\del', title: 'Del' }],
    sessions: [{ header: { id: 's-del', cwd: 'C:\\del' } }],
    events: new Map(),
    readSession: async () => ({ events: source }),
    snapshots: [{ header: { id: 's-del' }, revision: 'r1' }],
  })
  await waitForScan(app)
  const snap = (await call(app, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))).json()
  const token = snap.requestToken
  await postPricing(app, token, { pricing: { catalogEntries: [V4_FLASH] }, backfill: true })
  await waitForScan(app, (body) => body.totals.cost.pricedCalls === 1)
  let snapNow = (await call(app, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))).json()
  assert.equal(snapNow.totals.input, 1000000)
  // The history rewrite deletes every usage row; once the authoritative
  // snapshot carries the triggering tail event (which makes the read complete
  // and triggers the resync through the sequence gap), the aggregate must drop
  // the removed usage.
  source = [
    { seq: 3, time: MONDAY_OFF, type: 'turn/end', data: { turn: 1 } },
  ]
  app.listeners['session/event'][0]({ id: 's-del', header: { cwd: 'C:\\del' } }, { seq: 3, time: MONDAY_OFF, type: 'turn/end', data: { turn: 1 } })
  let result = null
  for (let i = 0; i < 100; i += 1) {
    await new Promise((resolve) => setImmediate(resolve))
    const body = (await call(app, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))).json()
    if (body.totals.input === 0) { result = body; break }
  }
  assert.ok(result !== null)
  assert.equal(result.totals.input, 0)
  assert.equal(result.totals.cost.pricedCalls, 0)
  const dateText = snap.byDay[0].date
  const request = makeRequest('GET', { host: '127.0.0.1:3080' })
  request.url = '/api/all-usage/records?start=' + dateText + '&end=' + dateText + '&utc=0&limit=10'
  assert.equal((await call(app, '/api/all-usage/records', request)).json().items.length, 0)
})

test('a live resync cursor never keeps the pre-rewrite tail', async () => {
  let source = [
    { seq: 0, time: MONDAY_OFF, type: 'request/context', data: { provider: 'deepseek', model: 'deepseek-v4-flash', turn: 1, step: 1 } },
  ]
  const app = await createApp({
    workspaces: [{ id: 'ws-cur', path: 'C:\\cur', title: 'Cur' }],
    sessions: [{ header: { id: 's-cur', cwd: 'C:\\cur' } }],
    events: new Map(),
    readSession: async () => ({ events: source }),
  })
  await waitForScan(app)
  const before = (await call(app, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))).json()
  assert.equal(before.totals.input, 0)
  // The appended history arrives together with the triggering tail event; the
  // resync must fold it all instead of trusting the old cursor of 0.
  source = [
    usageEvent(MONDAY_OFF, 1, 1, { inputTokens: 60, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, 1),
    usageEvent(MONDAY_OFF, 2, 1, { inputTokens: 60, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, 2),
    usageEvent(MONDAY_OFF, 3, 1, { inputTokens: 60, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, 3),
    usageEvent(MONDAY_OFF, 4, 1, { inputTokens: 60, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, 4),
    usageEvent(MONDAY_OFF, 5, 1, { inputTokens: 60, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, 5),
    usageEvent(MONDAY_OFF, 6, 1, { inputTokens: 60, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, 6),
    { seq: 7, time: MONDAY_OFF, type: 'turn/end', data: { turn: 6 } },
  ]
  app.listeners['session/event'][0]({ id: 's-cur', header: { cwd: 'C:\\cur' } }, { seq: 7, time: MONDAY_OFF, type: 'turn/end', data: { turn: 6 } })
  let total = null
  for (let i = 0; i < 100; i += 1) {
    await new Promise((resolve) => setImmediate(resolve))
    const body = (await call(app, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))).json()
    if (body.totals.input === 360) { total = 360; break }
  }
  assert.equal(total, 360)
})
test('snapshots priced under a retired policy are migrated once', async () => {
  // A usage instant BEFORE the official effective start priced under the old
  // build (effectiveFrom 0) must fail closed after the policy archive changed.
  const beforeEffective = Date.UTC(2026, 7, 15, 2, 0, 0)
  const retiredCost = {
    schemaVersion: 2, status: 'priced', pricingMode: 'official-model', currency: 'USD', source: 'catalog', pricingModel: 'deepseek-v4-flash', providerId: 'deepseek', inputTokenSemantics: 'fresh', multiplier: '1', billableInputTokens: 1000000, billableOutputTokens: 0,
    pricingAt: beforeEffective, pricingTimeSource: 'usage-event', pricingBand: 'peak', pricingTimezone: 'UTC', pricingPolicyId: 'deepseek-v4-2026-08-pricing', pricingPolicyHash: 'stale-hash-from-an-earlier-build', temporalApplicable: true, temporalExemptReason: null,
    rates: { input: '0.22', output: '0.66', cacheRead: '0.007', cacheWrite: '0' }, breakdown: { input: '0.44', output: '0', cacheRead: '0', cacheWrite: '0' }, baseTotal: '0.44', total: '0.44', reason: '', tiered: false,
  }
  const identity = { identityKey: 'deepseek / deepseek-v4-flash', provider: 'deepseek', requestedModel: 'deepseek-v4-flash', actualModel: 'deepseek-v4-flash', label: 'deepseek-v4-flash', legacy: false }
  const record = {
    version: 3, sessionId: 's-retired', workspaceId: 'ws-ret', lastSeq: 2, lastRevision: 'r1', updatedAt: 1000,
    turns: [{ key: 's-retired:turn:1', seq: 1, time: beforeEffective, workspaceId: 'ws-ret', turn: 1, identity }],
    usage: [{ key: 's-retired:step:1:1', seq: 2, time: beforeEffective, workspaceId: 'ws-ret', identity, modelId: 'deepseek-v4-flash', turn: 1, step: 1, values: { input: 1000000, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, cost: retiredCost }],
    lastIdentity: identity,
  }
  const app = await createApp({
    withStorage: true,
    ledgerSeed: { 's-retired': record },
    workspaces: [{ id: 'ws-ret', path: 'C:\\ret', title: 'Ret' }],
    sessions: [{ header: { id: 's-retired', cwd: 'C:\\ret' } }],
    readSession: async () => { throw new Error('read failed') },
  })
  await waitForScan(app)
  const snap = (await call(app, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))).json()
  const token = snap.requestToken
  await postPricing(app, token, { pricing: { catalogEntries: [V4_FLASH] }, backfill: true })
  await waitForScan(app, (body) => body.totals.cost.unsupportedCalls === 1)
  const stored = app.storageUnit.records.sessions['s-retired'].usage[0].cost
  assert.equal(stored.status, 'unsupported')
  assert.equal(stored.reason, 'temporal-price-history-unavailable')
  assert.equal(stored.total, '0')
})

test('an invalid temporal config stays fail-closed across persistence and restart', async () => {
  const invalidEntry = Object.assign({}, V4_FLASH, { temporalPricing: { policyId: 'bad-plan', timezone: 'Asia/Shanghai', effectiveFrom: 0, effectiveUntil: null, defaultPlan: null, rules: [{ id: 'peak', weekdays: [1, 2, 3, 4, 5], windows: [{ startMinute: 60, endMinute: 240 }], rates: { input: '0.44', output: '1.32', cacheRead: '0.014', cacheWrite: '0' } }] } })
  const first = await createApp({
    withStorage: true,
    workspaces: [{ id: 'ws-inv2', path: 'C:\\inv2', title: 'Inv2' }],
    sessions: [{ header: { id: 's-inv2', cwd: 'C:\\inv2' } }],
    events: new Map([['s-inv2', [
      usageEvent(MONDAY_PEAK, 1, 1, { inputTokens: 1000000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, 1),
    ]]]),
  })
  await waitForScan(first)
  const snap = (await call(first, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))).json()
  const token = snap.requestToken
  await postPricing(first, token, { pricing: { catalogEntries: [invalidEntry] }, backfill: true })
  let body = (await call(first, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))).json()
  assert.equal(body.totals.cost.unsupportedCalls, 1)
  await waitForLedgerWrite()
  // Restart over the same storage: the invalid sentinel must survive the
  // serialize → normalize cycle and the built-in profile must not return.
  const second = await createApp({
    withStorage: true,
    storage: first.storageUnit,
    workspaces: [{ id: 'ws-inv2', path: 'C:\\inv2', title: 'Inv2' }],
    sessions: [{ header: { id: 's-inv2', cwd: 'C:\\inv2' } }],
    events: new Map([['s-inv2', [
      usageEvent(MONDAY_PEAK, 1, 1, { inputTokens: 1000000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, 1),
    ]]]),
  })
  await waitForScan(second, (pred) => pred.totals.cost.unsupportedCalls === 1)
  body = (await call(second, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))).json()
  assert.equal(body.totals.cost.unsupportedCalls, 1)
  assert.equal(body.totals.cost.pricedCalls, 0)
  const request = makeRequest('GET', { host: '127.0.0.1:3080' })
  request.url = '/api/all-usage/records?start=' + snap.byDay[0].date + '&end=' + snap.byDay[0].date + '&utc=0&limit=10'
  const cost = (await call(second, '/api/all-usage/records', request)).json().items[0].cost
  assert.equal(cost.status, 'unsupported')
  assert.equal(cost.reason, 'temporal-config-invalid')
})

test('a same-hash snapshot whose instant left the policy window fails closed', async () => {
  const beforeWindow = Date.UTC(2026, 7, 17, 2, 0, 0)
  // Archive: one policy ending 08-18. The snapshot was priced under the same
  // policy id/hash but its instant (08-21) now lies in a history gap.
  const profile = peakProfile()
  const policy = profile.policies[0]
  const ownHash = 'same-policy-hash'
  const lateCost = {
    schemaVersion: 2, status: 'priced', pricingMode: 'official-model', currency: 'USD', source: 'manual', pricingModel: 'deepseek-v4-flash', providerId: 'deepseek', inputTokenSemantics: 'fresh', multiplier: '1', billableInputTokens: 1000000, billableOutputTokens: 0,
    pricingAt: Date.UTC(2026, 7, 21, 2, 0, 0), pricingTimeSource: 'usage-event', pricingBand: 'peak', pricingTimezone: 'UTC', pricingPolicyId: policy.policyId, pricingPolicyHash: ownHash, temporalApplicable: true, temporalExemptReason: null,
    rates: { input: '0.22', output: '0.66', cacheRead: '0.007', cacheWrite: '0' }, breakdown: { input: '0.44', output: '0', cacheRead: '0', cacheWrite: '0' }, baseTotal: '0.44', total: '0.44', reason: '', tiered: false,
  }
  const identity = { identityKey: 'deepseek / deepseek-v4-flash', provider: 'deepseek', requestedModel: 'deepseek-v4-flash', actualModel: 'deepseek-v4-flash', label: 'deepseek-v4-flash', legacy: false }
  const record = {
    version: 3, sessionId: 's-gap2', workspaceId: 'ws-gap2', lastSeq: 2, lastRevision: 'r1', updatedAt: 1000,
    turns: [{ key: 's-gap2:turn:1', seq: 1, time: beforeWindow, workspaceId: 'ws-gap2', turn: 1, identity }],
    usage: [{ key: 's-gap2:step:1:1', seq: 2, time: beforeWindow, workspaceId: 'ws-gap2', identity, modelId: 'deepseek-v4-flash', turn: 1, step: 1, values: { input: 1000000, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, cost: lateCost }],
    lastIdentity: identity,
  }
  const app = await createApp({
    withStorage: true,
    ledgerSeed: { 's-gap2': record },
    workspaces: [{ id: 'ws-gap2', path: 'C:\\gap2', title: 'Gap2' }],
    sessions: [{ header: { id: 's-gap2', cwd: 'C:\\gap2' } }],
    readSession: async () => { throw new Error('read failed') },
  })
  await waitForScan(app)
  const snap = (await call(app, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))).json()
  const token = snap.requestToken
  // Provide a windowed plan (08-16 16:00 UTC -> 08-18 00:00 UTC) that no longer
  // covers the snapshot instant of 08-21.
  await postPricing(app, token, { pricing: { catalogEntries: [Object.assign({}, V4_FLASH, { temporalPricing: { policyId: policy.policyId, timezone: 'UTC', effectiveFrom: DEEPSEEK_EFFECTIVE, effectiveUntil: Date.UTC(2026, 7, 18, 0, 0, 0), defaultPlan: null, rules: [{ id: 'peak', weekdays: [1, 2, 3, 4, 5], windows: [{ startMinute: 60, endMinute: 240 }], rates: { input: '0.44', output: '1.32', cacheRead: '0.014', cacheWrite: '0' } }] } })] }, backfill: true })
  await waitForScan(app, (body) => body.totals.cost.unsupportedCalls === 1)
  const stored = app.storageUnit.records.sessions['s-gap2'].usage[0].cost
  assert.equal(stored.status, 'unsupported')
  assert.equal(stored.reason, 'temporal-price-history-unavailable')
})

test('a same-band update refreshes the pricingAt audit metadata', async () => {
  const app = await createApp({
    withStorage: true,
    workspaces: [{ id: 'ws-meta', path: 'C:\\meta', title: 'Meta' }],
    sessions: [{ header: { id: 's-meta', cwd: 'C:\\meta' } }],
    events: new Map([['s-meta', [
      { seq: 1, time: MONDAY_EDGE_START, type: 'request/context', data: { provider: 'deepseek', model: 'deepseek-v4-flash', turn: 1, step: 1 } },
      usageChunkEvent(MONDAY_EDGE_START, 1, 1, { inputTokens: 1000000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, 2),
    ]]]),
  })
  await waitForScan(app)
  const snap = (await call(app, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))).json()
  const token = snap.requestToken
  await postPricing(app, token, { pricing: { catalogEntries: [V4_FLASH] }, backfill: true })
  await waitForScan(app, (body) => body.totals.cost.pricedCalls === 1)
  const dateText = snap.byDay[0].date
  const readRecord = async () => {
    const request = makeRequest('GET', { host: '127.0.0.1:3080' })
    request.url = '/api/all-usage/records?start=' + dateText + '&end=' + dateText + '&utc=0&limit=10'
    return (await call(app, '/api/all-usage/records', request)).json().items[0].cost
  }
  let cost = await readRecord()
  assert.equal(cost.pricingAt, MONDAY_EDGE_START)
  assert.equal(cost.pricingBand, 'peak')
  // Replacement with the same turn/step but a later context (still peak): the
  // audit instant must move to the new context even though the band unchanged.
  const laterContext = Date.UTC(2026, 7, 17, 3, 30, 0)
  app.listeners['session/event'][0]({ id: 's-meta', header: { cwd: 'C:\\meta' } }, { seq: 3, time: laterContext, type: 'request/context', data: { provider: 'deepseek', model: 'deepseek-v4-flash', turn: 1, step: 1 } })
  app.listeners['session/event'][0]({ id: 's-meta', header: { cwd: 'C:\\meta' } }, usageChunkEvent(laterContext, 1, 1, { inputTokens: 1000000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, 4))
  await new Promise((resolve) => setTimeout(resolve, 60))
  const meta = await readRecord()
  assert.equal(meta.pricingAt, laterContext)
  assert.equal(meta.pricingBand, 'peak')
  assert.equal(meta.total, '0.44')
})

test('context archives evict true LRU and stay bounded across restart', async () => {
  const time = MONDAY_OFF
  const events = []
  for (let index = 1; index <= 512; index += 1) {
    events.push({ seq: index - 1, time, type: 'request/context', data: { provider: 'deepseek', model: 'deepseek-v4-flash', turn: index, step: 1 } })
  }
  // Rewrite context:1 (LRU touch) then add context:513: the archive must keep
  // context:1 and evict context:2 instead of the FIFO head.
  events.push({ seq: 512, time, type: 'request/context', data: { provider: 'deepseek', model: 'deepseek-v4-flash', turn: 1, step: 1 } })
  events.push({ seq: 513, time, type: 'request/context', data: { provider: 'deepseek', model: 'deepseek-v4-flash', turn: 513, step: 1 } })
  const app = await createApp({
    withStorage: true,
    workspaces: [{ id: 'ws-lru', path: 'C:\\lru', title: 'Lru' }],
    sessions: [{ header: { id: 's-lru', cwd: 'C:\\lru' } }],
    events: new Map([['s-lru', events]]),
    snapshots: [{ header: { id: 's-lru' }, revision: 'r1' }],
  })
  await waitForScan(app)
  await waitForLedgerWrite()
  const archive = app.storageUnit.records.sessions['s-lru'].contextTimes
  const keys = archive.map((entry) => entry.key)
  assert.equal(archive.length, 512)
  assert.ok(keys.includes('context:1:1'))
  assert.ok(keys.includes('context:513:1'))
  assert.ok(!keys.includes('context:2:1'))
  // Restart: the normalized archive stays bounded and keeps the same entries.
  const second = await createApp({
    withStorage: true,
    storage: app.storageUnit,
    workspaces: [{ id: 'ws-lru', path: 'C:\\lru', title: 'Lru' }],
    sessions: [{ header: { id: 's-lru', cwd: 'C:\\lru' } }],
    events: new Map([['s-lru', events]]),
    snapshots: [{ header: { id: 's-lru' }, revision: 'r1' }],
  })
  await waitForScan(second)
  const secondArchiveKeys = second.storageUnit.records.sessions['s-lru'].contextTimes.map((entry) => entry.key)
  assert.equal(secondArchiveKeys.length, 512)
  assert.ok(secondArchiveKeys.includes('context:1:1'))
})
