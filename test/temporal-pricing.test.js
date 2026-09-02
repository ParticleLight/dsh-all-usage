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

async function createApp({ key = 'test-key', workspaces = [], withStorage = false, sessions = [], events = new Map(), listSessions: listSessionsOverride, readSession: readSessionOverride, ledgerSeed = {} } = {}) {
  const routes = new Map()
  const cleanups = []
  const listeners = {}
  const storageUnit = {
    saved: [],
    records: { sessions: {} },
    async loadAll() {
      return { global: {}, tables: this.records }
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
// 2026-08-03 is a Monday; 08-04 Tuesday; 08-01 Saturday; 08-02 Sunday.
const MONDAY_PEAK = Date.UTC(2026, 7, 3, 2, 0, 0)          // 02:00 UTC peak window
const MONDAY_OFF = Date.UTC(2026, 7, 3, 10, 30, 0)         // 10:30 UTC off-peak
const MONDAY_EDGE_AM = Date.UTC(2026, 7, 3, 0, 59, 59)     // 00:59:59 off-peak
const MONDAY_EDGE_START = Date.UTC(2026, 7, 3, 1, 0, 0)    // 01:00:00 peak
const MONDAY_EDGE_END3 = Date.UTC(2026, 7, 3, 3, 59, 59)   // 03:59:59 peak
const MONDAY_EDGE_START4 = Date.UTC(2026, 7, 3, 4, 0, 0)   // 04:00:00 off-peak
const MONDAY_EDGE_START6 = Date.UTC(2026, 7, 3, 6, 0, 0)   // 06:00:00 peak
const MONDAY_EDGE_END10 = Date.UTC(2026, 7, 3, 10, 0, 0)   // 10:00:00 off-peak
const SATURDAY = Date.UTC(2026, 7, 1, 2, 0, 0)
const SUNDAY = Date.UTC(2026, 7, 2, 2, 0, 0)

function peakProfile() {
  return {
    policyId: 'test-peak-policy',
    sourceUrl: 'https://example.test/pricing',
    timezone: 'UTC',
    effectiveFrom: 0,
    effectiveUntil: null,
    defaultPlan: null,
    rules: [{ id: 'peak', weekdays: [1, 2, 3, 4, 5], windows: [{ startMinute: 60, endMinute: 240 }, { startMinute: 360, endMinute: 600 }], rates: { input: '0.44', output: '1.32', cacheRead: '0.014', cacheWrite: '0' } }],
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
  assert.deepEqual(normalizeTemporalPricing(base), { policyId: 'p', sourceUrl: '', timezone: 'UTC', effectiveFrom: 0, effectiveUntil: null, defaultPlan: null, rules: [{ id: 'peak', weekdays: [1, 2], windows: [{ startMinute: 60, endMinute: 240 }], rates: { input: '1', output: '1', cacheRead: '1', cacheWrite: '0' } }] })
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
  const gapped = { ...profile, effectiveFrom: Date.UTC(2027, 0, 1), effectiveUntil: null }
  const resolved = { temporalProfile: { ...gapped, policyHash: 'h' }, temporalRoute: 'official', status: 'priced', rates: profile.rules[0].rates, currency: 'USD', source: 'manual', pricingModel: 'deepseek-v4-flash', providerId: 'deepseek', inputTokenSemantics: 'fresh', multiplier: '1', tiered: false, reasoningRateAvailable: false }
  const plan = temporalPlanFor(resolved, MONDAY_PEAK)
  assert.equal(plan.status, 'history-gap')
  const cost = calculateCost({ input: 1000000, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, resolved, MONDAY_PEAK, 'usage-event')
  assert.equal(cost.status, 'unsupported')
  assert.equal(cost.reason, 'temporal-price-history-unavailable')
  assert.equal(cost.total, '0')
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

test('pricing plan updates invalidate aggregated snapshots and reuse decisions', async () => {
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
  // Catalog rate change: baked into the policy hash, so prior snapshots are
  // stale and the reconciled totals must follow the new off-peak rate.
  await postPricing(app, token, { pricing: { catalogEntries: [{ ...V4_FLASH, input: '0.25' }] }, backfill: true })
  await waitForScan(app, (body) => body.totals.cost.total === '0.25')
  totals = (await call(app, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))).json().totals.cost
  assert.equal(totals.total, '0.25')
  const request = makeRequest('GET', { host: '127.0.0.1:3080' })
  request.url = '/api/all-usage/query?start=' + snap.byDay[0].date + '&end=' + snap.byDay[0].date + '&utc=0'
  assert.equal((await call(app, '/api/all-usage/query', request)).json().totals.cost.total, '0.25')
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
