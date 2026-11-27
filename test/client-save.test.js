import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')
function between(start, end) {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from)
  assert.ok(from >= 0 && to > from, 'client save function boundaries must exist')
  return source.slice(from, to)
}
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const settle = async () => { for (let index = 0; index < 16; index += 1) await Promise.resolve() }
function harness(fetcher, options = {}) {
  const state = {
    stats: { aliases: { a: 'old-a', b: 'old-b' } }, aliasOpen: true, aliasError: '', aliasSaving: false,
    aliasDrafts: { a: 'new-a', b: 'new-b' }, pricingOpen: true, pricingError: '', pricingSaving: false,
    pricingDraft: { overrides: [{ model: 'manual-model', input: '1' }] }, refreshes: 0,
  }
  Object.assign(state, options)
  const context = {
    URLSearchParams, fetch: fetcher, snapshotUtcFlag: () => '?utc=0',
    requestTokenRef: { current: options.token === undefined ? 'token-a' : options.token },
    aliases: state.stats.aliases, aliasDrafts: state.aliasDrafts, aliasSaving: false, aliasPendingRef: { current: new Set() },
    workspaces: [{ id: 'a' }, { id: 'b' }],
    setStats: (update) => { state.stats = typeof update === 'function' ? update(state.stats) : update; context.aliases = state.stats.aliases },
    setAliasOpen: (value) => { state.aliasOpen = value },
    setAliasError: (value) => { state.aliasError = value },
    setAliasSaving: (value) => { state.aliasSaving = value; context.aliasSaving = value },
    setAliasDrafts: (update) => { state.aliasDrafts = typeof update === 'function' ? update(state.aliasDrafts) : update; context.aliasDrafts = state.aliasDrafts },
    pricingDraft: state.pricingDraft, pricingTemporalDrafts: {}, pricingSaving: false, pricingSyncing: false, pricingSyncSaving: false,
    pricingDraftValidationError: () => '', pricingDraftPayloadTooLarge: () => false,
    setPricingSaving: (value) => { state.pricingSaving = value; context.pricingSaving = value },
    setPricingError: (value) => { state.pricingError = value },
    setPricingDetails: (value) => { state.pricingDetails = value },
    setPricingDraft: (value) => { state.pricingDraft = value },
    pricingDraftOf: (value) => value.config,
    resetPricingTransients: () => { state.reset = true },
    closePricingPanel: () => { state.pricingOpen = false },
    refreshRef: { current: () => { state.refreshes += 1 } },
  }
  const code = between('    function createRequestGate', '    function rangeFilenamePart') + '\n' +
    between('    const getStats =', '    // Fetches one year of the Chinese holiday arrangement') + '\n' +
    'const pricingGate = createRequestGate();\n' +
    between('      const writeWithFreshToken =', '      // ---------- cost settings:') + '\n' +
    between('      const savePricingSettings =', '      const syncPricingNow =') +
    '\nglobalThis.api = { saveAlias, saveAllAliases, savePricingSettings, writeWithFreshToken, setAliasRpc, setPricingRpc }'
  vm.runInNewContext(code, context)
  return { state, context, ...context.api }
}
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data })
const persistenceFailure = (stage = 'alias') => response({ ok: false, messageCode: 'persistence-failed', stage, applied: true, persisted: false }, 503)

test('alias Save All waits for persistence before closing the editor', async () => {
  const pending = deferred()
  const h = harness(() => pending.promise, { aliasDrafts: { a: 'new-a', b: 'old-b' } })
  const saving = h.saveAllAliases()
  assert.equal(h.state.aliasOpen, true)
  assert.equal(h.state.aliasSaving, true)
  pending.resolve(response({ ok: true, aliases: { a: 'new-a', b: 'old-b' } }))
  await saving
  await settle()
  assert.equal(h.state.aliasOpen, false)
  assert.equal(h.state.aliasSaving, false)
  assert.equal(h.state.stats.aliases.a, 'new-a')
})
test('alias persistence failure keeps the editor and drafts with a visible error', async () => {
  const h = harness(async () => persistenceFailure())
  await h.saveAllAliases()
  await settle()
  assert.equal(h.state.aliasOpen, true)
  assert.notEqual(h.state.aliasError, '')
  assert.equal(h.state.aliasSaving, false)
  assert.deepEqual(h.state.aliasDrafts, { a: 'new-a', b: 'new-b' })
  assert.deepEqual(h.state.stats.aliases, { a: 'old-a', b: 'old-b' })
  const render = between('      const aliasPanel =', '      const pricingSync =')
  assert.match(render, /role: 'alert'/, 'the alias error must be rendered, not only stored')
})
test('a partial alias failure does not close or erase the failed edit', async () => {
  let failed = true
  const h = harness(async (_, options) => {
    const { workspaceId, alias } = JSON.parse(options.body)
    if (workspaceId === 'b' && failed) return persistenceFailure()
    return response({ ok: true, aliases: { a: workspaceId === 'a' ? alias : 'new-a', b: workspaceId === 'b' ? alias : 'old-b' } })
  })
  await h.saveAllAliases()
  await settle()
  assert.equal(h.state.aliasOpen, true)
  assert.equal(h.state.stats.aliases.a, 'new-a')
  assert.equal(h.state.stats.aliases.b, 'old-b')
  assert.equal(h.state.aliasDrafts.b, 'new-b')
  failed = false
  await h.saveAllAliases()
  await settle()
  assert.equal(h.state.aliasOpen, false)
  assert.equal(h.state.aliasError, '')
  assert.equal(h.state.stats.aliases.b, 'new-b')
})
test('out-of-order alias acknowledgements only publish their own workspace', async () => {
  const pending = []
  const h = harness(() => { const item = deferred(); pending.push(item); return item.promise })
  const saving = h.saveAllAliases()
  assert.equal(pending.length, 2)
  pending[1].resolve(response({ ok: true, aliases: { a: 'new-a', b: 'new-b' } }))
  await settle()
  pending[0].resolve(response({ ok: true, aliases: { a: 'new-a', b: 'old-b' } }))
  await saving
  await settle()
  assert.deepEqual({ ...h.state.stats.aliases }, { a: 'new-a', b: 'new-b' })
})
test('single-alias failure is visible and a missing token is not successful', async () => {
  const h = harness(async () => persistenceFailure())
  await h.saveAlias('a', 'new-a')
  await settle()
  assert.notEqual(h.state.aliasError, '')
  const missing = harness(async () => { throw new Error('must not send') }, { token: '' })
  await missing.saveAllAliases()
  await settle()
  assert.equal(missing.state.aliasOpen, true)
  assert.equal(missing.state.aliasError, 'token')
})
test('alias RPC keeps HTTP status for the capability retry', async () => {
  const h = harness(async () => response({ ok: false }, 403))
  await assert.rejects(h.setAliasRpc('a', 'new-a', 'token-a'), (error) => error.status === 403)
})
test('a retry after capability rotation reports its actual persistence failure', async () => {
  const h = harness(async () => response({ requestToken: 'token-b' }))
  let reason, calls = 0
  await h.writeWithFreshToken(() => Promise.reject(Object.assign(new Error('HTTP ' + (++calls === 1 ? 403 : 503)), { status: calls === 1 ? 403 : 503 })), () => assert.fail('a failed write is not successful'), (error) => { reason = error })
  assert.equal(reason.status, 503)
})
test('pricing HTTP503 retains the draft and editor without a success refresh', async () => {
  const h = harness(async () => persistenceFailure())
  const draft = h.state.pricingDraft
  h.savePricingSettings(false)
  await settle()
  assert.notEqual(h.state.pricingError, '')
  assert.equal(h.state.pricingDraft, draft)
  assert.equal(h.state.pricingOpen, true)
  assert.equal(h.state.pricingSaving, false)
  assert.equal(h.state.refreshes, 0)
  assert.equal(h.state.reset, undefined)
})
test('pricing successful persistence applies the acknowledged draft', async () => {
  const config = { overrides: [] }
  const h = harness(async () => response({ ok: true, pricing: { config } }), { pricingError: 'persistence' })
  h.savePricingSettings(false)
  await settle()
  assert.equal(h.state.pricingError, '')
  assert.equal(h.state.pricingDraft, config)
  assert.equal(h.state.pricingOpen, false)
  assert.equal(h.state.refreshes, 1)
})

function aliasAlert(state) {
  const context = {
    aliasOpen: state.aliasOpen, aliasError: state.aliasError, aliasSaving: state.aliasSaving, aliasDrafts: state.aliasDrafts,
    workspaces: [{ id: 'a' }, { id: 'b' }], wsColor: () => '#000', tr: (zh, en) => en,
    setAliasOpen() {}, setAliasDrafts() {}, setAliasError() {}, saveAlias() {}, saveAllAliases() {},
    React: { createElement: (type, props, ...children) => ({ type, props, children }) },
  }
  vm.runInNewContext(between('      const aliasPanel =', '      const pricingSync =') + '\nglobalThis.tree = aliasPanel', context)
  const findAlert = (node) => {
    if (!node || typeof node !== 'object') return null
    if (node.props?.role === 'alert') return node.children.join('')
    return (Array.isArray(node) ? node : node.children || []).map(findAlert).find((value) => value !== null) ?? null
  }
  return findAlert(context.tree)
}
test('storage-failure acknowledgement preserves its flags and renders the actual save stage', async () => {
  const h = harness(async (url) => persistenceFailure(url.endsWith('/alias') ? 'alias' : 'pricing'))
  await assert.rejects(h.setPricingRpc({}, false, 'token-a'), (error) => error.status === 503 && error.messageCode === 'persistence-failed' && error.applied === true && error.persisted === false && error.stage === 'pricing')
  await h.saveAlias('a', 'new-a')
  await settle()
  assert.equal(aliasAlert(h.state), 'The settings are applied in this process but have not been saved to storage. Retry saving.')
  h.savePricingSettings(false)
  await settle()
  const context = { tr: (zh, en) => en }
  vm.runInNewContext(between('      const pricingErrorMessage =', '      const pricingSourceLabel =') + '\nglobalThis.message = pricingErrorMessage', context)
  assert.equal(context.message(h.state.pricingError), 'The settings are applied in this process but have not been saved to storage. Retry saving.')
})
test('alias capability recovery retries once and exposes the second HTTP503 response', async () => {
  const calls = []
  const h = harness(async (url, options) => {
    calls.push({ url, options })
    if (url === '/api/all-usage?utc=0') return response({ requestToken: 'token-b' })
    return calls.length === 1 ? response({ ok: false }, 403) : persistenceFailure()
  }, { aliasDrafts: { a: 'new-a', b: 'old-b' } })
  await h.saveAllAliases()
  await settle()
  assert.equal(calls.length, 3)
  assert.equal(calls[2].options.headers['x-all-usage-request-token'], 'token-b')
  assert.equal(h.state.aliasOpen, true)
  assert.equal(h.state.aliasError, 'persistence')
})
test('an HTTP error with an unreadable body retains its status and stays visible', async () => {
  const h = harness(async () => ({ ok: false, status: 503, json: async () => { throw new SyntaxError('HTML body') } }))
  await assert.rejects(h.setAliasRpc('a', 'new-a', 'token-a'), (error) => error.status === 503)
  await h.saveAlias('a', 'new-a')
  await settle()
  assert.equal(aliasAlert(h.state), 'Workspace aliases could not be saved; your edits were kept. Retry saving.')
})
test('clearing one alias removes only the acknowledged workspace key', async () => {
  const h = harness(async () => response({ ok: true, aliases: { b: 'old-b' } }))
  await h.saveAlias('a', '')
  await settle()
  assert.equal(Object.hasOwn(h.state.stats.aliases, 'a'), false)
  assert.equal(h.state.stats.aliases.b, 'old-b')
})

test('an applied alias from a failed save is retried after a background snapshot matches the draft', async () => {
  let failing = true, writes = 0
  const h = harness(async () => { writes += 1; return failing ? persistenceFailure() : response({ ok: true, aliases: { a: 'new-a', b: 'old-b' } }) }, { aliasDrafts: { a: 'new-a', b: 'old-b' } })
  await h.saveAllAliases()
  await settle()
  assert.equal(h.state.aliasOpen, true)
  h.context.aliases = h.state.stats.aliases = { a: 'new-a', b: 'old-b' }
  failing = false
  await h.saveAllAliases()
  await settle()
  assert.equal(writes, 2, 'matching in-memory state is not a persistence receipt')
  assert.equal(h.state.aliasOpen, false)
  assert.equal(h.state.aliasError, '')
})
test('stable persistence codes take precedence while legacy message codes stay compatible', async () => {
  for (const code of [{ messageCode: 'persistence-failed', message: 'legacy detail' }, { message: 'persistence-failed' }]) {
    const h = harness(async () => response({ ok: false, ...code, stage: 'alias', applied: true, persisted: false }, 503))
    await h.saveAlias('a', 'new-a')
    await settle()
    assert.equal(h.state.aliasError, 'persistence')
    assert.equal(h.state.aliasOpen, true)
  }
})

test('a failure requires explicit receipt flags before claiming the settings were applied but not persisted', async () => {
  for (const flags of [{ applied: false, persisted: false }, { persisted: false }, { applied: true }, { applied: true, persisted: true }]) {
    const h = harness(async () => response({ ok: false, messageCode: 'persistence-failed', ...flags }, 503))
    await h.saveAlias('a', 'new-a')
    await settle()
    assert.equal(aliasAlert(h.state), 'Workspace aliases could not be saved; your edits were kept. Retry saving.', JSON.stringify(flags))
  }
})
