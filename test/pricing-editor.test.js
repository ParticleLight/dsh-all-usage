import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../lib/index.js'
import { fetchHolidayCalendar, parseHolidayCalendar } from '../lib/pricing.js'

// ---------- helpers (same shape as temporal-pricing.test.js) ----------

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

async function createApp({ key = 'test-key', workspaces = [], withStorage = false, sessions = [], events = new Map(), ledgerSeed = {} } = {}) {
  const routes = new Map()
  const cleanups = []
  const listeners = {}
  const storageUnit = {
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
    if (!storageUnit.records.sessions) storageUnit.records.sessions = {}
    Object.assign(storageUnit.records.sessions, ledgerSeed)
  }
  const webServer = {
    register(route) {
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  }
  const ctx = {
    sessionQuery: {
      async listSessions() {
        return sessions
      },
      async readSession(sid) {
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
  return { routes, storageUnit, cleanups, listeners }
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

async function waitForScan(app, predicate = (body) => body.scan.done) {
  let snapshot = null
  for (let i = 0; i < 200; i += 1) {
    snapshot = await call(app, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))
    if (predicate(snapshot.json())) return snapshot
    await new Promise((resolve) => setImmediate(resolve))
  }
  return snapshot
}

async function postPricing(app, token, payload) {
  return call(app, '/api/all-usage/pricing', makeRequest('POST', { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', 'x-all-usage-request-token': token }, JSON.stringify(payload)))
}

async function getPricing(app) {
  return call(app, '/api/all-usage/pricing', makeRequest('GET', { host: '127.0.0.1:3080' }))
}

const V4_FLASH = { providerId: 'deepseek', providerName: 'DeepSeek', modelId: 'deepseek-v4-flash', displayName: 'DeepSeek V4 Flash', input: '0.22', output: '0.66', cacheRead: '0.007', cacheWrite: '0' }
const GPT = { providerId: 'openai', providerName: 'OpenAI', modelId: 'gpt-5.5', displayName: 'GPT-5.5', input: '5', output: '30', cacheRead: '0.5', cacheWrite: '6.25' }
const MONDAY_PEAK = Date.UTC(2026, 7, 17, 2, 0, 0)

function customPeakPlan() {
  return {
    policies: [{
      policyId: 'custom-peak',
      timezone: 'UTC',
      effectiveFrom: 0,
      effectiveUntil: null,
      defaultPlan: null,
      rules: [{ id: 'peak', weekdays: [1, 2, 3, 4, 5], windows: [{ startMinute: 60, endMinute: 240 }], rates: { input: '0.5', output: '1.5', cacheRead: '0.02', cacheWrite: '0' } }],
    }],
  }
}

async function seededApp(events, provider = 'deepseek', model = 'deepseek-v4-flash') {
  const app = await createApp({
    withStorage: true,
    workspaces: [{ id: 'ws-1', path: 'C:\\proj', title: 'Proj' }],
    sessions: [{ header: { id: 's-1', cwd: 'C:\\proj' } }],
    events: new Map([['s-1', events]]),
  })
  const snapshot = await waitForScan(app)
  return { app, token: snapshot.json().requestToken }
}

// ---------- rows ----------

test('the detailed table flags the built-in DeepSeek plan without freezing it', async () => {
  const { app, token } = await seededApp([
    usageEvent(MONDAY_PEAK, 1, 1, { inputTokens: 1000000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, 1),
  ])
  await postPricing(app, token, { pricing: { catalogEntries: [V4_FLASH] }, backfill: true })
  const pricing = (await getPricing(app)).json()
  const row = pricing.usedModels.find((model) => model.pricingModel === 'deepseek-v4-flash')
  assert.ok(row, 'the usage row must exist')
  assert.equal(row.usageBacked, true)
  assert.equal(row.temporalBuiltin, true)
  assert.equal(row.temporalExplicit, false)
  assert.equal(row.temporalPolicyId, 'deepseek-v4-2026-08-pricing')
  const schedule = pricing.temporalSchedules.find((entry) => entry.id === row.temporalScheduleId)
  assert.equal(schedule.policies[0].policyId, 'deepseek-v4-2026-08-pricing')
  assert.equal(schedule.policies[0].rules[0].windows[0].startMinute, 60)
  assert.equal(typeof schedule.policies[0].policyHash, 'string')
})

test('two routes priced from one manual entry share a single custom temporal schedule', async () => {
  const { app, token } = await seededApp([
    usageEvent(MONDAY_PEAK, 1, 1, { inputTokens: 1000000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, 1, 'deepseek', 'deepseek-v4-flash'),
    usageEvent(MONDAY_PEAK, 1, 2, { inputTokens: 1000000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, 2, 'openrouter', 'deepseek-v4-flash'),
  ])
  await postPricing(app, token, {
    pricing: {
      overrides: [Object.assign({}, V4_FLASH, { temporalPricing: customPeakPlan() })],
      mappings: [],
    },
    backfill: true,
  })
  const pricing = (await getPricing(app)).json()
  assert.equal(pricing.usedModels.length, 2)
  for (const row of pricing.usedModels) {
    assert.equal(row.source, 'manual')
    assert.equal(row.temporalExplicit, true)
    assert.equal(row.temporalBuiltin, false)
    assert.equal(row.temporalPolicyId, 'custom-peak')
  }
  const [first, second] = pricing.usedModels
  assert.equal(first.temporalScheduleId, second.temporalScheduleId)
  assert.equal(pricing.temporalSchedules.length, 1)
  assert.equal(pricing.temporalSchedules[0].policies[0].policyId, 'custom-peak')
})

test('configured rows the ledger never saw stay visible and editable in the detailed table', async () => {
  const mappingKey = JSON.stringify(['openrouter', 'unused-route', 'unused-route', null])
  const { app, token } = await seededApp([
    usageEvent(MONDAY_PEAK, 1, 1, { inputTokens: 1000000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, 1),
  ])
  await postPricing(app, token, {
    pricing: {
      catalogEntries: [V4_FLASH],
      overrides: [{ providerId: 'openai', modelId: 'gpt-5.5', displayName: 'GPT-5.5', input: '5', output: '30', cacheRead: '0.5', cacheWrite: '6.25' }],
      mappings: [{ identityKey: mappingKey, provider: 'openrouter', model: 'unused-route', catalogProviderId: 'deepseek', catalogModelId: 'deepseek-v4-flash' }],
    },
  })
  const pricing = (await getPricing(app)).json()
  const usageRow = pricing.usedModels.find((row) => row.pricingModel === 'deepseek-v4-flash' && row.usageBacked === true)
  assert.ok(usageRow, 'the ledger row must be present')
  const overrideRow = pricing.usedModels.find((row) => row.usageBacked === false && row.pricingModel === 'gpt-5.5')
  assert.ok(overrideRow, 'an override with no ledger usage must still get a row')
  assert.equal(overrideRow.source, 'manual')
  assert.equal(overrideRow.identityKey, '')
  const mappingRow = pricing.usedModels.find((row) => row.usageBacked === false && row.identityKey === mappingKey)
  assert.ok(mappingRow, 'a mapping with no ledger usage must still get a row')
  assert.equal(mappingRow.pricingModel, 'deepseek-v4-flash')
  assert.equal(mappingRow.model, 'openrouter / unused-route')
  // Ledger rows come first, configured rows after them.
  assert.equal(pricing.usedModels[pricing.usedModels.length - 1].usageBacked, false)

  const compact = (await call(app, '/api/all-usage', makeRequest('GET', { host: '127.0.0.1:3080' }))).json()
  assert.equal(Object.hasOwn(compact.pricing, 'temporalSchedules'), false)
  assert.equal(Object.hasOwn(compact.pricing, 'config'), false)
  for (const row of compact.pricing.usedModels) {
    assert.equal(Object.hasOwn(row, 'usageBacked'), false)
    assert.equal(Object.hasOwn(row, 'temporalScheduleId'), false)
  }
  assert.equal(compact.pricing.usedModels.some((row) => row.model === 'GPT-5.5'), false)
  assert.equal(compact.pricing.usedModels.some((row) => row.identityKey === mappingKey), false)
})

// ---------- search ----------

test('the model search previews rates and the built-in peak flag', async () => {
  const { app, token } = await seededApp([
    usageEvent(MONDAY_PEAK, 1, 1, { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, 1),
  ])
  await postPricing(app, token, { pricing: { catalogEntries: [V4_FLASH, GPT] } })
  const request = makeRequest('GET', { host: '127.0.0.1:3080' })
  request.url = '/api/all-usage/pricing/models?q=deepseek-v4-flash'
  const items = (await call(app, '/api/all-usage/pricing/models', request)).json().items
  assert.equal(items.length, 1)
  assert.deepEqual(items[0].rates, { input: '0.22', output: '0.66', cacheRead: '0.007', cacheWrite: '0' })
  assert.equal(items[0].providerName, 'DeepSeek')
  assert.equal(items[0].builtinTemporal, true)
  const other = makeRequest('GET', { host: '127.0.0.1:3080' })
  other.url = '/api/all-usage/pricing/models?q=gpt-5.5'
  const gptItems = (await call(app, '/api/all-usage/pricing/models', other)).json().items
  assert.equal(gptItems[0].builtinTemporal, false)
  assert.equal(gptItems[0].rates.input, '5')
})

// ---------- round trips ----------

test('overrides round-trip their providerId, display name and peak plan', async () => {
  const { app, token } = await seededApp([])
  await postPricing(app, token, {
    pricing: {
      catalogEntries: [V4_FLASH],
      overrides: [Object.assign({}, V4_FLASH, { temporalPricing: customPeakPlan() })],
    },
  })
  const pricing = (await getPricing(app)).json()
  assert.equal(pricing.config.overrides[0].providerId, 'deepseek')
  assert.equal(pricing.config.overrides[0].displayName, 'DeepSeek V4 Flash')
  assert.equal(pricing.config.overrides[0].temporalPricing.policies[0].policyId, 'custom-peak')
  const expectedPlan = customPeakPlan()
  expectedPlan.policies[0].sourceUrl = ''
  expectedPlan.policies[0].holidays = []
  expectedPlan.policies[0].holidaysSource = ''
  assert.deepEqual(pricing.config.overrides[0].temporalPricing, expectedPlan)
})

test('a provider-scoped manual price is found as the mapping target on the next save', async () => {
  const routeKey = JSON.stringify(['openrouter', 'deepseek-v4-flash', 'deepseek-v4-flash', null])
  const { app, token } = await seededApp([
    usageEvent(MONDAY_PEAK, 1, 1, { inputTokens: 1000000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, 1, 'openrouter', 'deepseek-v4-flash'),
  ])
  await postPricing(app, token, {
    pricing: {
      catalogEntries: [V4_FLASH],
      mappings: [{ identityKey: routeKey, provider: 'openrouter', model: 'deepseek-v4-flash', catalogProviderId: 'deepseek', catalogModelId: 'deepseek-v4-flash', inputTokenSemantics: 'fresh', multiplier: '1.5' }],
      overrides: [{ providerId: 'deepseek', modelId: 'deepseek-v4-flash', displayName: 'My V4 Flash', input: '0.5', output: '1.5', cacheRead: '0.02', cacheWrite: '0' }],
    },
    backfill: true,
  })
  const pricing = (await getPricing(app)).json()
  const row = pricing.usedModels.find((model) => model.identityKey === routeKey)
  assert.ok(row, 'the mapped row must exist')
  assert.equal(row.source, 'manual')
  assert.equal(row.pricingModel, 'deepseek-v4-flash')
  assert.equal(row.providerId, 'deepseek')
  assert.equal(row.rates.input, '0.5')
  assert.equal(row.multiplier, '1.5')
  // The manual entry is the mapping target, so the config row is not duplicated.
  assert.equal(pricing.usedModels.filter((model) => model.pricingModel === 'deepseek-v4-flash').length, 1)
})

test('several configured rows keep their own price and never share a cache slot', async () => {
  const { app, token } = await seededApp([])
  await postPricing(app, token, {
    pricing: {
      catalogEntries: [V4_FLASH],
      overrides: [
        { providerId: 'openai', modelId: 'gpt-5.5', displayName: 'GPT-5.5', input: '5', output: '30', cacheRead: '0.5', cacheWrite: '6.25' },
        { providerId: 'zai', modelId: 'glm-4v', displayName: 'GLM-4V', input: '0.5', output: '2', cacheRead: '0.05', cacheWrite: '0' },
      ],
    },
  })
  const pricing = (await getPricing(app)).json()
  const rows = pricing.usedModels.filter((row) => row.usageBacked === false)
  assert.equal(rows.length, 2)
  const byModel = new Map(rows.map((row) => [row.pricingModel, row]))
  assert.equal(byModel.get('gpt-5.5').rates.input, '5')
  assert.equal(byModel.get('gpt-5.5').providerId, 'openai')
  assert.equal(byModel.get('glm-4v').rates.input, '0.5')
  assert.equal(byModel.get('glm-4v').providerId, 'zai')
  assert.equal(byModel.get('glm-4v').model, 'GLM-4V')
})

// ---------- holiday calendar source ----------

function holidayDataset(year, days, papers) {
  return { $schema: 'https://example.test/schema.json', year, papers: papers || ['https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm'], days }
}

test('the holiday calendar parser keeps only days off and stays strict', () => {
  const raw = holidayDataset(2026, [
    { name: '元旦', date: '2026-01-02', isOffDay: true },
    { name: '元旦', date: '2026-01-01', isOffDay: true },
    { name: '元旦', date: '2026-01-01', isOffDay: true },
    { name: '元旦后补班', date: '2026-01-04', isOffDay: false },
  ])
  const parsed = parseHolidayCalendar(raw, 2026)
  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.calendar.dates, ['2026-01-01', '2026-01-02'])
  assert.equal(parsed.calendar.paperUrl, 'https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm')
  assert.equal(parseHolidayCalendar(raw, 2025).ok, false)
  assert.equal(parseHolidayCalendar({ year: 2026 }, 2026).error, 'holiday-calendar-days-missing')
  assert.equal(parseHolidayCalendar(holidayDataset(2026, [{ date: '2026-01-04', isOffDay: false }]), 2026).error, 'holiday-calendar-empty')
  assert.equal(parseHolidayCalendar(holidayDataset(2026, [{ date: '2026-02-30', isOffDay: true }]), 2026).error, 'holiday-calendar-date-invalid')
  assert.equal(parseHolidayCalendar(null, 2026).error, 'holiday-calendar-not-object')
})

test('the holiday fetch falls back to the second source and reports failures', async () => {
  const payload = holidayDataset(2026, [{ name: '国庆节', date: '2026-10-01', isOffDay: true }])
  const calls = []
  const flaky = async (url) => {
    calls.push(url)
    if (url.includes('cdn.jsdelivr.net')) throw new Error('offline')
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(payload) }
  }
  const result = await fetchHolidayCalendar(2026, flaky)
  assert.equal(result.ok, true)
  assert.deepEqual(result.calendar.dates, ['2026-10-01'])
  assert.equal(calls.length, 2)
  assert.ok(result.calendar.sourceUrl.includes('raw.githubusercontent.com'))
  const dead = await fetchHolidayCalendar(2026, async () => ({ ok: false, status: 503, headers: { get: () => null }, text: async () => '' }))
  assert.equal(dead.ok, false)
  assert.equal(dead.error, 'http-503')
  assert.equal((await fetchHolidayCalendar(1999, flaky)).error, 'holiday-year-invalid')
  assert.equal((await fetchHolidayCalendar(2026, null, {})).error, 'fetch-unavailable')
})

test('the holiday route fetches once, caches in memory and stays protected', async () => {
  const payload = holidayDataset(2026, [{ name: '国庆节', date: '2026-10-01', isOffDay: true }, { name: '国庆节', date: '2026-10-02', isOffDay: true }])
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => { calls += 1; return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(payload) } }
  try {
    const { app, token } = await seededApp([])
    const ok = await call(app, '/api/all-usage/pricing/holidays', makeRequest('POST', { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', 'x-all-usage-request-token': token }, JSON.stringify({ year: 2026 })))
    assert.equal(ok.status, 200)
    assert.equal(ok.json().ok, true)
    assert.deepEqual(ok.json().dates, ['2026-10-01', '2026-10-02'])
    assert.equal(ok.json().cached, false)
    assert.ok(String(ok.json().paperUrl).includes('gov.cn'))
    const cached = await call(app, '/api/all-usage/pricing/holidays', makeRequest('POST', { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', 'x-all-usage-request-token': token }, JSON.stringify({ year: 2026 })))
    assert.equal(cached.json().cached, true)
    assert.equal(calls, 1)
    const noToken = await call(app, '/api/all-usage/pricing/holidays', makeRequest('POST', { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }, JSON.stringify({ year: 2026 })))
    assert.equal(noToken.status, 403)
    const badYear = await call(app, '/api/all-usage/pricing/holidays', makeRequest('POST', { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', 'x-all-usage-request-token': token }, JSON.stringify({ year: 1999 })))
    assert.equal(badYear.status, 400)
    const getInstead = await call(app, '/api/all-usage/pricing/holidays', makeRequest('GET', { host: '127.0.0.1:3080' }))
    assert.equal(getInstead.status, 405)
  } finally {
    globalThis.fetch = originalFetch
  }
})
