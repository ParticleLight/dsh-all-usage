// Acceptance tests for archiving from the running host: the lib/ledger.js glue
// (archiveLedger/treeStore/attachArchive) and the POST /api/all-usage/archive route.
//
// The integration cases run against a real temporary root and the real ledger, so
// what they prove is what the panel does: a plan that writes nothing, an apply that
// files the records into month files and removes their tree documents, and a read
// path that still answers for those records in the same process afterwards.
import assert from 'node:assert/strict'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { gunzipSync } from 'node:zlib'
import { registerRoutes } from '../lib/http.js'
import { serializeLedgerRecord } from '../lib/ledger.js'
import { createInvariantHost, createLedgerBackend, createTempRoot, removeTempRoot } from './support/ledger-invariants.js'

const DAY_MS = 86400000
const BASE_TIME = Date.parse('2026-10-13T08:00:00Z')

function contextEvent(seq, time, turn, step) {
  return { seq, time, type: 'request/context', data: { provider: 'deepseek', model: 'deepseek-chat', turn, step } }
}

function messageEvent(seq, time, turn, step, usage) {
  return { seq, time, type: 'assistant/message', data: { turn, step, message: { source: { provider: 'deepseek', model: 'deepseek-chat' } }, usage } }
}

function turnEndEvent(seq, time, turn) {
  return { seq, time, type: 'turn/end', data: { turn } }
}

// One turn with one usage sample: enough for a record the ledger accepts, small
// enough that a failure points at the archive and not at the fold.
function sessionLog(id, cwd, seed) {
  const start = BASE_TIME + seed * 3600000
  return {
    id,
    header: { cwd },
    events: [
      contextEvent(0, start, 1, 1),
      messageEvent(1, start + 1000, 1, 1, { inputTokens: 10 + seed, outputTokens: 2 }),
      turnEndEvent(2, start + 2000, 1),
    ],
  }
}

// Two records far older than any cutoff used here (and in two different UTC months,
// so the run has to write two month files) plus one that must stay resident.
const OLD_IDS = ['s-old-a', 's-old-b']
const NEW_ID = 's-new'

function fixtureRecords() {
  const builder = createInvariantHost().ledger
  const now = Date.now()
  const rows = [
    { id: OLD_IDS[0], workspaceId: 'w-alpha', cwd: 'C:/work/alpha', seed: 1, updatedAt: now - 300 * DAY_MS },
    { id: OLD_IDS[1], workspaceId: 'w-beta', cwd: 'C:/work/beta', seed: 2, updatedAt: now - 200 * DAY_MS },
    { id: NEW_ID, workspaceId: 'w-beta', cwd: 'C:/work/beta', seed: 3, updatedAt: now - DAY_MS },
  ]
  return rows.map((row) => ({
    ...builder.buildLedgerRecord(sessionLog(row.id, row.cwd, row.seed), row.workspaceId, 'scan', 'rev'),
    updatedAt: row.updatedAt,
  }))
}

function monthOf(record) {
  return new Date(record.updatedAt).toISOString().slice(0, 7)
}

async function openHost(root) {
  const backend = createLedgerBackend(root)
  const fixture = createInvariantHost({ backend: backend.backend })
  await fixture.ledger.loadLedger()
  return { ...fixture, backend }
}

// Seed the hot copy through lib/ledger.js itself, so the documents the archive
// plans are the documents a real start writes.
async function seed(fixture, records) {
  for (const record of records) {
    fixture.ledger.storeLedgerRecord(record)
    fixture.ledger.applyLedgerRecord(record)
    await fixture.ledger.persistLedgerRecord(record)
  }
  await fixture.ledger.drainLedgerWrites()
}

/** Every archived row on disk, by session id - month files only, no key indexes. */
async function archivedRows(root) {
  const rows = new Map()
  const dir = join(root, 'archive')
  for (const entry of await readdir(dir).catch(() => [])) {
    if (!entry.endsWith('.jsonl.gz') || entry.includes('.keys.')) continue
    const text = gunzipSync(await readFile(join(dir, entry))).toString('utf8')
    for (const line of text.split(/[\r\n]+/)) {
      if (line === '') continue
      const row = JSON.parse(line)
      rows.set(row.sessionId, row)
    }
  }
  return rows
}

test('a dry run plans the archive and writes nothing at all', async () => {
  const root = await createTempRoot()
  try {
    const fixture = await openHost(root)
    const records = fixtureRecords()
    await seed(fixture, records)
    const treesBefore = await fixture.backend.treeSessionIds()

    const dry = await fixture.ledger.archiveLedger({ days: 90, dryRun: true })
    assert.equal(dry.ok, true)
    assert.equal(dry.dryRun, true)
    assert.equal(dry.archived, 2, 'the plan names both records older than the cutoff')
    assert.equal(dry.bytes > 0, true)
    assert.equal(dry.compressed, 0)
    assert.deepEqual(dry.errors, [])
    assert.deepEqual(dry.months, [monthOf(records[0]), monthOf(records[1])].sort())
    // Not even the archive directory: a plan is a read of the trees.
    assert.equal(await fixture.backend.hasFile('archive'), false)
    assert.deepEqual(await fixture.backend.treeSessionIds(), treesBefore, 'no document is removed by a plan')
  } finally {
    await removeTempRoot(root)
  }
})

test('an apply writes the month files, removes their documents and answers for them afterwards', async () => {
  const root = await createTempRoot()
  try {
    const fixture = await openHost(root)
    const records = fixtureRecords()
    await seed(fixture, records)
    const originals = new Map(records.map((record) => [record.sessionId, record]))

    const applied = await fixture.ledger.archiveLedger({ days: 90, dryRun: false })
    assert.equal(applied.ok, true)
    assert.equal(applied.dryRun, false)
    assert.equal(applied.archived, 2)
    assert.deepEqual(applied.errors, [])
    assert.equal(applied.compressed > 0, true)

    const files = (await readdir(join(root, 'archive'))).sort()
    for (const month of applied.months) {
      assert.equal(files.includes(month + '.jsonl.gz'), true, 'month file: ' + month)
      assert.equal(files.includes(month + '.keys.json.gz'), true, 'key index: ' + month)
    }
    assert.equal(files.includes('manifest.json'), true)
    assert.deepEqual(applied.months, [monthOf(records[0]), monthOf(records[1])].sort())

    // Whole records, in the exact shape the trees store them.
    const archived = await archivedRows(root)
    assert.deepEqual(Array.from(archived.keys()).sort(), OLD_IDS.slice().sort())
    for (const id of OLD_IDS) assert.deepEqual(archived.get(id), serializeLedgerRecord(originals.get(id)))

    // The documented order: the month file first, then the document.
    assert.deepEqual(await fixture.backend.treeSessionIds(), [NEW_ID], 'only the resident record keeps its document')

    // The reader this process opened at start knows nothing of the new month files,
    // so the store has to be re-attached for the records it just removed.
    const unit = fixture.state.ledgerUnit
    assert.deepEqual(await unit.treeStore().listKeys(), [NEW_ID], 'the trees no longer name the archived records')
    assert.equal(await unit.treeStore().readRecord(OLD_IDS[0]), undefined)
    for (const id of OLD_IDS) assert.deepEqual(await unit.readRecord(id), serializeLedgerRecord(originals.get(id)), 'attachArchive() answers for ' + id)
    assert.deepEqual((await unit.listKeys()).sort(), [NEW_ID, ...OLD_IDS].sort(), 'listKeys() still names every record of the ledger')

    // A second run has nothing to do: the unit store plans from the trees only, so
    // the records the first run filed are not planned (or counted) a second time.
    const again = await fixture.ledger.archiveLedger({ days: 90, dryRun: false })
    assert.equal(again.ok, true)
    assert.equal(again.archived, 0)
    assert.deepEqual(again.months, [])
    assert.deepEqual(await fixture.backend.treeSessionIds(), [NEW_ID], 'the resident record still stays')
  } finally {
    await removeTempRoot(root)
  }
})

test('a record newer than the cutoff is never archived', async () => {
  const root = await createTempRoot()
  try {
    const fixture = await openHost(root)
    const records = fixtureRecords()
    await seed(fixture, records)
    const plan = await fixture.ledger.archiveLedger({ days: 3650, dryRun: true })
    assert.equal(plan.ok, true)
    assert.equal(plan.archived, 0, 'ten years is still not older than ten years')
    assert.deepEqual(plan.months, [])
    // 250 days sits between the two old records: -300 is past it, -200 is not.
    const byDays = await fixture.ledger.archiveLedger({ days: 250, dryRun: true })
    assert.deepEqual(byDays.months, [monthOf(records[0])], 'only the record past 250 days is planned')
    assert.equal(byDays.archived, 1)
  } finally {
    await removeTempRoot(root)
  }
})

test('reports busy, no-root and ledger-unavailable instead of archiving', async () => {
  const root = await createTempRoot()
  try {
    const fixture = await openHost(root)
    const records = fixtureRecords()
    await seed(fixture, records)
    const treesBefore = await fixture.backend.treeSessionIds()
    // Another process's live lock: this process must not write or delete anything.
    await mkdir(join(root, 'all_usage_ledger.lock'))
    await writeFile(join(root, 'all_usage_ledger.lock', 'owner.json'), JSON.stringify({ pid: 4242, startedAt: Date.now(), host: 'other-host' }), 'utf8')
    const busy = await fixture.ledger.archiveLedger({ days: 90, dryRun: false })
    assert.deepEqual(busy, { ok: false, message: 'busy' })
    assert.equal(await fixture.backend.hasFile('archive'), false)
    assert.deepEqual(await fixture.backend.treeSessionIds(), treesBefore)

    // A host without a json storage backend has no root to archive.
    const noRoot = await createInvariantHost().ledger.archiveLedger({ days: 90, dryRun: true })
    assert.deepEqual(noRoot, { ok: false, message: 'no-root' })

    // A backend whose ledger has not loaded yet has no trees to plan from.
    const late = createInvariantHost({ backend: createLedgerBackend(root).backend })
    const unavailable = await late.ledger.archiveLedger({ days: 90, dryRun: true })
    assert.deepEqual(unavailable, { ok: false, message: 'ledger-unavailable' })
  } finally {
    await removeTempRoot(root)
  }
})

// ---------- the route ----------

function makeResponse() {
  let body = ''
  const headers = {}
  return {
    res: {
      statusCode: 200,
      setHeader(name, value) { headers[String(name).toLowerCase()] = value },
      end(value = '') { body += String(value) },
    },
    headers,
    body: () => body,
    json: () => JSON.parse(body),
  }
}

function makeRequest(method, headers = {}, body = '') {
  return {
    method,
    url: '/api/all-usage/archive',
    headers,
    socket: { remoteAddress: '127.0.0.1' },
    on(event, callback) {
      if (event === 'data' && body !== '') callback(Buffer.from(body))
      if (event === 'end') callback()
      return this
    },
  }
}

const TOKEN = 'archive-route-token'
const TRUSTED = { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }
const WITH_TOKEN = { ...TRUSTED, 'x-all-usage-request-token': TOKEN }

// The rest of registerRoutes only has to exist; this route never reaches it.
function createRouteHost({ reply = () => ({ ok: true, months: [], archived: 0, bytes: 0, compressed: 0, dryRun: true, errors: [] }), ready = Promise.resolve() } = {}) {
  const routes = new Map()
  const calls = []
  const host = {
    ctx: { effect: (factory) => factory() },
    webServer: { register(route) { routes.set(route.path, route.handler) } },
    state: { requestToken: TOKEN, ledgerReady: ready },
    aggregation: {
      queryScopeFromRequest: () => ({ ok: false, message: 'bad-query' }),
      queryUsageScope: () => ({}),
      queryRecords: async () => ({}),
      snapshot: () => ({}),
      statusSnapshot: () => ({}),
    },
    pricing: {
      pricingModelSearch: () => [],
      pricingSnapshot: () => ({}),
      updatePricingState: async () => ({}),
      persistPricing: async () => {},
      syncPricing: async () => ({ ok: true }),
      loadHolidayCalendar: async () => ({ ok: true }),
    },
    sessionSync: { runBaseline: async () => {}, lastSeqOf: () => -1 },
    balance: { fetchBalance: async () => ({ ok: true }) },
    aliases: { setAlias: () => ({ ok: true }) },
    ledger: {
      drainLedgerWrites: async () => {},
      archiveLedger: async (args) => { calls.push(args); return reply(args) },
    },
  }
  registerRoutes(host)
  return { calls, handler: routes.get('/api/all-usage/archive') }
}

async function call(handler, request) {
  const response = makeResponse()
  await handler(request, response.res)
  return response
}

test('the archive route requires an authorized POST', async () => {
  const app = createRouteHost()
  const get = await call(app.handler, makeRequest('GET', WITH_TOKEN))
  assert.equal(get.res.statusCode, 405)
  assert.equal(get.body(), '')
  for (const [label, headers] of [
    ['no capability', TRUSTED],
    ['wrong capability', { ...TRUSTED, 'x-all-usage-request-token': 'not-the-token' }],
    ['cross-site', { ...WITH_TOKEN, 'sec-fetch-site': 'cross-site' }],
    ['remote host', { ...WITH_TOKEN, host: '192.0.2.10:3080' }],
    ['foreign origin', { ...WITH_TOKEN, origin: 'https://evil.example' }],
  ]) {
    const response = await call(app.handler, makeRequest('POST', headers, '{}'))
    assert.equal(response.res.statusCode, 403, label)
    assert.deepEqual(response.json(), { ok: false, message: 'forbidden' }, label)
  }
  assert.deepEqual(app.calls, [], 'a rejected request never reaches the ledger')
})

test('the archive route rejects oversized and malformed bodies and a bad day count', async () => {
  const app = createRouteHost()
  const oversized = await call(app.handler, makeRequest('POST', WITH_TOKEN, 'x'.repeat(9 * 1024)))
  assert.equal(oversized.res.statusCode, 413)
  assert.deepEqual(oversized.json(), { ok: false, message: 'request-too-large' })

  for (const body of ['', 'null', '[]', '"90"']) {
    const response = await call(app.handler, makeRequest('POST', WITH_TOKEN, body))
    assert.equal(response.res.statusCode, 400, 'body: ' + JSON.stringify(body))
    assert.deepEqual(response.json(), { ok: false, message: 'invalid-json' }, 'body: ' + JSON.stringify(body))
  }

  for (const days of [0, 3651, 'x', 1.5, -1, null]) {
    const response = await call(app.handler, makeRequest('POST', WITH_TOKEN, JSON.stringify({ days })))
    assert.equal(response.res.statusCode, 400, 'days: ' + JSON.stringify(days))
    assert.deepEqual(response.json(), { ok: false, message: 'invalid-days' }, 'days: ' + JSON.stringify(days))
  }
  assert.deepEqual(app.calls, [], 'nothing invalid is worth a ledger run')
})

test('the archive route defaults to a 90 day plan and passes the answer through', async () => {
  const planned = { ok: true, months: ['2026-05'], archived: 2, bytes: 480, compressed: 0, dryRun: true, errors: [] }
  const app = createRouteHost({ reply: () => planned })
  const response = await call(app.handler, makeRequest('POST', WITH_TOKEN, '{}'))
  assert.equal(response.res.statusCode, 200)
  assert.equal(response.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(response.headers['cache-control'], 'no-store')
  assert.deepEqual(response.json(), planned, 'the route hands the result back unchanged')
  assert.deepEqual(app.calls, [{ days: 90, dryRun: true }], 'a missing dryRun must plan')
})

test('the archive route only applies on an explicit dryRun:false', async () => {
  const app = createRouteHost({ reply: () => ({ ok: true, months: [], archived: 0, bytes: 0, compressed: 0, dryRun: false, errors: [] }) })
  for (const [args, expected] of [
    [{ dryRun: false }, { days: 90, dryRun: false }],
    [{ days: 30, dryRun: false }, { days: 30, dryRun: false }],
    [{ days: '45' }, { days: 45, dryRun: true }],
    [{ days: 180, dryRun: null }, { days: 180, dryRun: true }],
  ]) {
    const response = await call(app.handler, makeRequest('POST', WITH_TOKEN, JSON.stringify(args)))
    assert.equal(response.res.statusCode, 200)
    assert.deepEqual(app.calls.at(-1), expected, JSON.stringify(args))
  }
})

test('the archive route maps each ledger answer to its status', async () => {
  for (const [result, status] of [
    [{ ok: false, message: 'busy' }, 409],
    [{ ok: false, message: 'no-root' }, 400],
    [{ ok: false, message: 'ledger-unavailable' }, 503],
    [{ ok: false, message: 'archive-failed', error: 'disk full' }, 500],
  ]) {
    const app = createRouteHost({ reply: () => result })
    const response = await call(app.handler, makeRequest('POST', WITH_TOKEN, '{}'))
    assert.equal(response.res.statusCode, status, result.message)
    assert.deepEqual(response.json(), result)
  }
})

test('the archive route waits for the ledger before running', async () => {
  let release
  const ready = new Promise((resolve) => { release = resolve })
  const app = createRouteHost({ ready })
  const pending = call(app.handler, makeRequest('POST', WITH_TOKEN, '{}'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(app.calls, [], 'the ledger has not loaded yet')
  release()
  const response = await pending
  assert.equal(response.res.statusCode, 200)
  assert.deepEqual(app.calls, [{ days: 90, dryRun: true }])
})
