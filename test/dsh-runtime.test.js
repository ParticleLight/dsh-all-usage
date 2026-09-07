import assert from 'node:assert/strict'
import { request } from 'node:http'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import test from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const RUNTIME_ROOT = process.env.DSH_RUNTIME_ROOT || 'F:\\dsh-web\\runtime'
const requestedRuntimeVersion = process.env.DSH_RUNTIME_VERSION
const RUNTIME_VERSIONS = requestedRuntimeVersion ? [requestedRuntimeVersion] : ['0.1.1-rc.2', '0.1.1-rc.1']
const REQUIRE_RUNTIME_SMOKE = process.env.DSH_REQUIRE_RUNTIME_SMOKE === '1'

async function findPackage(packageName, version) {
  const pnpmRoot = join(RUNTIME_ROOT, 'node_modules', '.pnpm')
  const segments = packageName.split('/')
  const directPackageDir = join(RUNTIME_ROOT, 'node_modules', ...segments)
  try {
    const metadata = JSON.parse(await readFile(join(directPackageDir, 'package.json'), 'utf8'))
    if (metadata.name === packageName && (version === undefined || metadata.version === version)) return directPackageDir
  } catch (error) {
    // CI may use a flat npm-installed runtime instead of pnpm's virtual store.
  }
  let entries
  try {
    entries = await readdir(pnpmRoot)
  } catch (error) {
    return null
  }
  for (const entry of entries) {
    const packageDir = join(pnpmRoot, entry, 'node_modules', ...segments)
    try {
      const metadata = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'))
      if (metadata.name === packageName && (version === undefined || metadata.version === version)) return packageDir
    } catch (error) {
      // A pnpm store entry may be a partial or platform-incompatible package.
    }
  }
  return null
}

async function locateRuntime(version) {
  const required = {
    cordis: ['@deepseek-ai/cordis', '4.0.1'],
    loader: ['@deepseek-ai/cordis-plugin-loader', '1.0.2'],
    timer: ['@deepseek-ai/cordis-plugin-timer', '1.1.3'],
    session: ['@deepseek-ai/dsh-session', version],
    sessionQuery: ['@deepseek-ai/dsh-session-query', version],
    sessionPersistenceJsonl: ['@deepseek-ai/dsh-session-persistence-jsonl', version],
    storage: ['@deepseek-ai/dsh-storage', version],
    storageJson: ['@deepseek-ai/dsh-storage-json', version],
    storageDomain: ['@deepseek-ai/dsh-storage-domain', version],
    workspace: ['@deepseek-ai/dsh-workspace', version],
    webServer: ['@deepseek-ai/dsh-host-webserver', version],
    settingsFile: ['@deepseek-ai/dsh-settings-file', version],
  }
  const entries = Object.fromEntries(await Promise.all(Object.entries(required).map(async ([key, [name, packageVersion]]) => [key, await findPackage(name, packageVersion)])))
  const missing = Object.entries(entries).filter(([, value]) => value === null).map(([key]) => key)
  return missing.length === 0 ? { version, entries } : { version, entries, missing }
}

async function importEntry(packageDir, relativePath = 'lib/index.js') {
  return import(pathToFileURL(join(packageDir, relativePath)).href)
}

function hookCount(ctx, name) {
  const hooks = ctx.events && ctx.events._hooks && ctx.events._hooks[name]
  return Array.isArray(hooks) ? hooks.length : 0
}

function requestJson(url) {
  return new Promise((resolve, reject) => {
    const requestUrl = new URL(url)
    const req = request({ hostname: requestUrl.hostname, port: requestUrl.port, path: requestUrl.pathname + requestUrl.search, method: 'GET', headers: { accept: 'application/json' } }, (response) => {
      let text = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { text += chunk })
      response.on('end', () => {
        try { resolve({ status: response.statusCode, body: JSON.parse(text) }) }
        catch (error) { reject(error) }
      })
    })
    req.on('error', reject)
    req.end()
  })
}

async function waitForSnapshot(webServer, predicate = (body) => body && body.scan && body.scan.done === true) {
  const address = webServer.server && webServer.server.address()
  const port = address && typeof address === 'object' ? address.port : webServer.port
  if (!Number.isInteger(port) || port < 1) throw new Error('real webServer did not expose a listening port')
  const url = 'http://127.0.0.1:' + String(port) + '/api/all-usage'
  let last
  for (let attempt = 0; attempt < 80; attempt += 1) {
    let response
    try {
      response = await requestJson(url)
    } catch (error) {
      if (attempt === 79) throw error
      await new Promise((resolve) => setTimeout(resolve, 25))
      continue
    }
    last = response.body
    if (response.status === 200 && predicate(last)) return { response, body: last }
    await new Promise((resolve) => setImmediate(resolve))
  }
  return { response: null, body: last }
}

async function runRuntimeSmoke(runtime) {
  const modules = {}
  for (const [key, packageDir] of Object.entries(runtime.entries)) modules[key] = await importEntry(packageDir)
  const localPlugin = await import(pathToFileURL(join(REPO_ROOT, 'lib', 'index.js')).href)
  assert.ok(Array.isArray(localPlugin.inject) && localPlugin.inject.includes('webServer'), 'the Host must require webServer before apply')
  const root = new modules.cordis.Context()
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-all-usage-runtime-' + runtime.version.replaceAll('.', '-') + '-'))
  const allUsageName = pathToFileURL(join(REPO_ROOT, 'lib', 'index.js')).href
  let allUsageId
  try {
    await root.plugin(modules.loader.default || modules.loader)
    allUsageId = await root.loader.create({ id: 'all-usage', name: allUsageName })

    // all-usage is created before its required services; load the real services
    // on the ancestor Context, matching the DSH Web profile's service topology.
    await root.plugin(modules.timer.default || modules.timer)
    await root.plugin(modules.session.SessionStore)
    await root.plugin(modules.storage.default || modules.storage)
    await root.plugin(modules.storageJson, { root: join(scratch, 'storages') })
    await root.plugin(modules.storageDomain, { backend: 'json' })
    await root.plugin(modules.sessionPersistenceJsonl.default || modules.sessionPersistenceJsonl, {
      root: join(scratch, 'sessions'),
      compression: 'none',
      packChunks: false,
    })
    await root.plugin(modules.workspace.default || modules.workspace)
    const workspace = await root.get('workspaceRegistry').create(scratch, 'Runtime Smoke')
    await root.plugin(modules.sessionQuery.default || modules.sessionQuery)
    await root.plugin(modules.webServer.default || modules.webServer, { host: '127.0.0.1', port: 0 })
    await root.loader.await()

    const webServer = root.get('webServer')
    assert.equal(root.get('timer').constructor.name, 'TimerService')
    assert.equal(root.get('sessionPersistence').constructor.name, 'JsonlSessionPersistence')
    assert.equal(root.get('storage').constructor.name, 'Storage')
    assert.equal(root.get('workspaceRegistry').constructor.name, 'WorkspaceRegistry')
    assert.equal(root.get('sessionQuery').constructor.name, 'SessionQueryEngine')
    assert.equal(webServer.constructor.name, 'WebServer')
    for (const path of ['/api/all-usage', '/api/all-usage/status', '/api/all-usage/query', '/api/all-usage/records', '/api/all-usage/pricing', '/api/all-usage/pricing/models', '/api/all-usage/pricing/sync', '/api/all-usage/balance', '/api/all-usage/alias']) assert.equal(webServer.exact.has(path), true, 'real webServer must register ' + path)
    const eventHooksAfterLoad = {
      event: hookCount(root, 'session/event'),
      flush: hookCount(root, 'session/flush'),
      disposed: hookCount(root, 'session/disposed'),
    }
    assert.ok(eventHooksAfterLoad.event >= 1)
    assert.ok(eventHooksAfterLoad.flush >= 1)
    assert.ok(eventHooksAfterLoad.disposed >= 1)

    // Settings is optional to all-usage and appears after the plugin has already started.
    await root.plugin(modules.settingsFile.default || modules.settingsFile, {
      path: join(scratch, 'settings.yaml'),
      dshHome: scratch,
      watch: false,
    })
    await root.loader.await()
    assert.equal(root.get('settings').constructor.name, 'FileSettingsProvider')
    const fetched = await waitForSnapshot(webServer)
    assert.ok(fetched.response)
    assert.equal(fetched.response.status, 200)
    assert.equal(fetched.body.scan.done, true)
    assert.equal(fetched.body.totals.input, 0)

    const sessions = root.get('sessions')
    const session = sessions.create('runtime-smoke-session', { meta: { cwd: workspace.path } })
    await root.loader.await()
    await workspace.attachSession(session.id)
    assert.equal(workspace.sessionIds.includes(session.id), true)
    session.append('request/context', { provider: 'deepseek', model: 'deepseek-chat' })
    session.append('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 15, cacheReadTokens: 3, cacheWriteTokens: 2, reasoningTokens: 1 } } })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: { id: 'runtime-smoke-message', role: 'assistant', source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' }, content: [{ type: 'text', text: 'runtime smoke' }] },
      usage: { inputTokens: 12, outputTokens: 18, cacheReadTokens: 4, cacheWriteTokens: 2, reasoningTokens: 2 },
    }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    assert.deepEqual(session.events.map((event) => event.type), ['request/context', 'assistant/chunk', 'assistant/message', 'turn/end'])
    assert.equal(await sessions.flush(session), true)
    const measured = await waitForSnapshot(webServer, (body) => body.scan && body.scan.done === true && body.totals.input === 12 && body.totals.output === 18 && body.totals.cacheRead === 4 && body.totals.cacheWrite === 2 && body.totals.reasoning === 2)
    const diagnostic = { snapshot: measured.body === null ? null : { scan: measured.body.scan, sync: measured.body.sync, totals: measured.body.totals, perModel: measured.body.perModel }, sessionHeader: session.header, eventTypes: session.events.map((event) => ({ type: event.type, seq: event.seq })), workspaces: root.get('workspaceRegistry').list().map((item) => ({ id: item.id, path: item.path, sessionIds: item.sessionIds })) }
    if (!measured.response) throw new Error('real firehose did not reach expected totals: ' + JSON.stringify(diagnostic))
    assert.equal(measured.body.totals.input, 12)
    assert.equal(measured.body.totals.output, 18)
    assert.equal(measured.body.totals.cacheRead, 4)
    assert.equal(measured.body.totals.cacheWrite, 2)
    assert.equal(measured.body.totals.reasoning, 2)
    assert.equal(measured.body.perModel.length, 1)
    assert.equal(measured.body.perModel[0].actualModel, 'deepseek-chat')
    const storageFiles = await readdir(join(scratch, 'storages'))
    assert.equal(storageFiles.includes('all_usage_ledger.json'), false)
    assert.ok(storageFiles.some((file) => /^all_usage_ledger_\d{2}\.json$/.test(file)))

    const exactBeforeDispose = webServer.exact.size
    assert.ok(exactBeforeDispose >= 9)
    await root.loader.remove(allUsageId)
    await root.loader.await()
    assert.equal(webServer.exact.size, exactBeforeDispose - 9)
    for (const path of ['/api/all-usage', '/api/all-usage/status', '/api/all-usage/query', '/api/all-usage/records', '/api/all-usage/pricing', '/api/all-usage/pricing/models', '/api/all-usage/pricing/sync', '/api/all-usage/balance', '/api/all-usage/alias']) assert.equal(webServer.exact.has(path), false, 'dispose must remove ' + path)
    assert.equal(hookCount(root, 'session/event'), eventHooksAfterLoad.event - 1)
    assert.equal(hookCount(root, 'session/flush'), eventHooksAfterLoad.flush - 1)
    assert.equal(hookCount(root, 'session/disposed'), eventHooksAfterLoad.disposed - 1)
    assert.equal(root.get('timer').constructor.name, 'TimerService')
    assert.equal(root.get('storage').constructor.name, 'Storage')
    assert.equal(typeof localPlugin.apply, 'function')
  } finally {
    if (allUsageId !== undefined && root.loader.resolve) {
      try { await root.loader.remove(allUsageId) } catch (error) { /* already removed */ }
    }
    try { await root.loader.await() } catch (error) { /* preserve the primary assertion */ }
    await root.fiber.dispose()
    await rm(scratch, { recursive: true, force: true })
  }
}

for (const version of RUNTIME_VERSIONS) {
  const runtime = await locateRuntime(version)
  const title = 'loads dsh-all-usage through real Cordis runtime ' + version
  if (runtime.missing && REQUIRE_RUNTIME_SMOKE) {
    test(title, async () => {
      throw new Error('required DSH runtime packages are missing under ' + RUNTIME_ROOT + ': ' + runtime.missing.join(', '))
    })
  } else {
    test(title, { skip: runtime.missing ? 'runtime packages missing: ' + runtime.missing.join(', ') : false }, async () => {
      await runRuntimeSmoke(runtime)
    })
  }
}
