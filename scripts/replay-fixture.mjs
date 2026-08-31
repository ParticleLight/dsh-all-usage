import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { apply } from '../lib/index.js'

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))

function makeResponse() {
  let body = ''
  const headers = {}
  return {
    res: {
      statusCode: 200,
      setHeader(name, value) {
        headers[String(name).toLowerCase()] = value
      },
      end(value = '') {
        body += String(value)
      },
    },
    body: () => body,
  }
}

function makeRequest(url) {
  return {
    method: 'GET',
    url,
    headers: { host: '127.0.0.1:3080' },
    socket: { remoteAddress: '127.0.0.1' },
    on(event, callback) {
      if (event === 'end') callback()
      return this
    },
  }
}

function createHarness(fixture) {
  const routes = new Map()
  const listeners = new Map()
  const cleanups = []
  const webServer = {
    register(route) {
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  }
  const ctx = {
    sessionQuery: {
      async listSessions() {
        return fixture.sessions
      },
      async readSession(sessionId) {
        return { events: fixture.events[sessionId] || [] }
      },
    },
    workspaceRegistry: {
      list() {
        return fixture.workspaces
      },
    },
    async timeout() {},
    on(name, handler) {
      const current = listeners.get(name) || []
      current.push(handler)
      listeners.set(name, current)
    },
    effect(factory) {
      const cleanup = factory()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
      return cleanup
    },
    get(name) {
      return name === 'webServer' ? webServer : undefined
    },
  }
  return { ctx, routes, cleanups, listeners }
}

async function invoke(harness, url) {
  const pathname = new URL(url || '/', 'http://fixture.local').pathname
  const handler = harness.routes.get(pathname)
  assert.equal(typeof handler, 'function', 'fixture route should be registered: ' + pathname)
  const response = makeResponse()
  await handler(makeRequest(url), response.res)
  return { status: response.res.statusCode, body: JSON.parse(response.body()) }
}

function projectModel(row) {
  return {
    provider: row.provider,
    requestedModel: row.requestedModel,
    actualModel: row.actualModel,
    calls: row.calls,
    input: row.input,
    output: row.output,
    cacheRead: row.cacheRead,
    cacheWrite: row.cacheWrite,
    reasoning: row.reasoning,
  }
}

function assertExpected(fixture, snapshot, records) {
  const expected = fixture.expected
  const totals = snapshot.totals
  assert.deepEqual({
    turns: totals.turns,
    sessions: totals.sessions,
    input: totals.input,
    output: totals.output,
    cacheRead: totals.cacheRead,
    cacheWrite: totals.cacheWrite,
    reasoning: totals.reasoning,
  }, expected.totals)
  assert.equal(records.items.length, expected.records)
  assert.deepEqual(snapshot.perModel.map(projectModel).sort((left, right) => String(left.provider).localeCompare(String(right.provider))), expected.models)
  assert.equal(totals.cost.unpricedCalls + totals.cost.ambiguousCalls + totals.cost.unsupportedCalls + totals.cost.pricedCalls, expected.records)
}

export async function runFixture(fixture) {
  assert.equal(fixture.schemaVersion, 1)
  const harness = createHarness(fixture)
  apply(harness.ctx)
  try {
    let snapshot = null
    for (let attempt = 0; attempt < 200; attempt += 1) {
      snapshot = await invoke(harness, '/api/all-usage')
      if (snapshot.status === 200 && snapshot.body.scan.done === true) break
      await new Promise((resolvePromise) => setImmediate(resolvePromise))
    }
    assert.ok(snapshot && snapshot.body && snapshot.body.scan.done === true, 'fixture scan did not complete')
    const records = await invoke(harness, '/api/all-usage/records?start=' + fixture.query.start + '&end=' + fixture.query.end + '&utc=' + fixture.query.utc + '&limit=200')
    assert.equal(records.status, 200)
    assertExpected(fixture, snapshot.body, records.body)
    return {
      fixture: fixture.name,
      totals: snapshot.body.totals,
      models: snapshot.body.perModel.map(projectModel),
      records: records.body.items.length,
    }
  } finally {
    for (const cleanup of harness.cleanups.slice().reverse()) await cleanup()
  }
}

async function main() {
  const fixturePath = process.argv[2] === undefined ? join(PACKAGE_ROOT, 'fixtures', 'usage-events.json') : resolve(process.argv[2])
  const fixture = JSON.parse(await readFile(fixturePath, 'utf8'))
  const result = await runFixture(fixture)
  console.log(JSON.stringify(result, null, 2))
}

const invokedPath = process.argv[1] === undefined ? null : pathToFileURL(resolve(process.argv[1])).href
if (invokedPath === import.meta.url) await main()
