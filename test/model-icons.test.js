import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')
const manifest = JSON.parse(await readFile(new URL('../assets/model-icons/manifest.json', import.meta.url), 'utf8'))

// Extract the icon resolver block and run it against the real manifest with a
// synthetic icon table (data URIs are irrelevant for resolution).
const start = source.indexOf('    function normalizeIconModel')
const end = source.indexOf('    function chineseMagnitude')
assert.notEqual(start, -1, 'icon resolver start must exist')
assert.notEqual(end, -1, 'icon resolver end must exist')
assert.ok(end > start, 'icon resolver block must precede the formatting helpers')

const table = manifest.icons.map((icon) => ({
  key: icon.key,
  label: icon.label,
  providers: (icon.providers || []).map((value) => String(value).toLowerCase()),
  prefixes: (icon.prefixes || []).map((value) => String(value).toLowerCase()),
  exact: (icon.exact || []).map((value) => String(value).toLowerCase()),
  href: 'data:image/svg+xml;base64,AAAA',
}))

const context = {
  MODEL_ICON_TABLE: table,
  MODEL_ICON_CACHE: new Map(),
}
vm.runInNewContext(source.slice(start, end) + '\nglobalThis.__iconHelpers = { normalizeIconModel, iconForProvider, iconForModel, resolveModelIcon, resolveAggregateModelIcon }', context)
const { normalizeIconModel, iconForModel, iconForProvider, resolveModelIcon, resolveAggregateModelIcon } = context.__iconHelpers
const keyOf = (row) => { const icon = resolveModelIcon(row); return icon === null ? null : icon.key }

// Mirror of aggregateModelRows' icon attribution: provider views resolve by
// provider name only, model views require every member to share one brand.
function aggregateRows(rows, view) {
  const groups = new Map()
  for (const row of rows) {
    const label = view === 'provider' ? row.provider : String(row.actualModel || row.requestedModel || row.model)
    if (!groups.has(label)) groups.set(label, [])
    groups.get(label).push(row)
  }
  return Array.from(groups, ([model, members]) => {
    const icon = view === 'provider' ? iconForProvider(model) : resolveAggregateModelIcon(members)
    return { model, iconKey: icon === null ? null : icon.key }
  })
}


test('the manifest ships one valid entry per bundled brand icon', () => {
  assert.equal(manifest.schemaVersion, 1)
  assert.equal(manifest.icons.length, 11)
  const keys = manifest.icons.map((icon) => icon.key)
  assert.equal(new Set(keys).size, keys.length)
  for (const icon of manifest.icons) {
    assert.match(icon.file, /\.svg$/)
    assert.ok(typeof icon.label === 'string' && icon.label !== '')
    assert.ok(Array.isArray(icon.providers) && Array.isArray(icon.prefixes) && Array.isArray(icon.exact))
    assert.ok(icon.providers.length + icon.prefixes.length + icon.exact.length > 0, icon.key + ' needs at least one rule')
  }
})

test('bundled SVG assets are self-contained and script-free', async () => {
  for (const icon of manifest.icons) {
    const svg = await readFile(new URL('../assets/model-icons/' + icon.file, import.meta.url), 'utf8')
    assert.match(svg, /^\s*<svg[\s>]/i, icon.file + ' must start with an <svg> root')
    assert.match(svg.trim(), /<\/svg>$/i, icon.file + ' must close its <svg> root')
    assert.doesNotMatch(svg, /<script|<foreignObject|javascript:|on[a-z]+\s*=/i, icon.file + ' must not contain scripting')
    assert.doesNotMatch(svg, /currentColor/i, icon.file + ' must bake an explicit colour for <img> rendering')
    assert.doesNotMatch(svg, /(?:xlink:)?href\s*=\s*["'](?!#)/i, icon.file + ' must not reference external resources')
    assert.doesNotMatch(svg, /404: Not Found/i, icon.file + ' must not be an error page')
  }
})

test('normalizes model ids before matching', () => {
  assert.equal(normalizeIconModel('DeepSeek/DeepSeek-V4-Flash'), 'deepseek-v4-flash')
  assert.equal(normalizeIconModel('moonshotai/kimi-k2-0905:exa'), 'kimi-k2-0905')
  assert.equal(normalizeIconModel('gpt-5.2-codex@low'), 'gpt-5.2-codex-low')
  assert.equal(normalizeIconModel(undefined), '')
})

test('resolves first-party brands by model namespace', () => {
  assert.equal(keyOf({ provider: 'deepseek-official', actualModel: 'deepseek-v4-flash' }), 'deepseek')
  assert.equal(keyOf({ provider: 'openai', actualModel: 'gpt-5.6-luna' }), 'openai')
  assert.equal(keyOf({ provider: 'anthropic', actualModel: 'claude-opus-4.7' }), 'claude')
  assert.equal(keyOf({ provider: 'google', actualModel: 'gemini-3.2-pro' }), 'gemini')
  assert.equal(keyOf({ provider: 'meta', actualModel: 'llama-4.2-405b' }), 'meta')
  assert.equal(keyOf({ provider: 'zhipu', actualModel: 'glm-5-air' }), 'zhipu')
  assert.equal(keyOf({ provider: 'xai', actualModel: 'grok-4.6' }), 'grok')
  assert.equal(keyOf({ provider: 'alibaba', actualModel: 'qwen3-max' }), 'qwen')
  assert.equal(keyOf({ provider: 'bytedance', actualModel: 'doubao-2.0-pro' }), 'doubao')
  assert.equal(keyOf({ provider: 'moonshotai', actualModel: 'kimi-k2' }), 'kimi')
  assert.equal(keyOf({ provider: 'minimax', actualModel: 'minimax-m2' }), 'minimax')
})

test('reseller and gateway routes are attributed by the served model', () => {
  // The DSH provider is a gateway, but the model namespace is unambiguous.
  assert.equal(keyOf({ provider: 'openrouter', actualModel: 'deepseek-v4-flash' }), 'deepseek')
  assert.equal(keyOf({ provider: 'siliconflow', actualModel: 'deepseek-ai/DeepSeek-V4-Flash' }), 'deepseek')
  assert.equal(keyOf({ provider: 'a6api', actualModel: 'grok-4.6' }), 'grok')
  assert.equal(keyOf({ provider: 'rightcode', actualModel: 'gpt-5.6-luna' }), 'openai')
  // An unknown gateway serving an unknown model keeps the neutral fallback.
  assert.equal(keyOf({ provider: 'some-gateway', actualModel: 'house-model-v1' }), null)
  assert.equal(keyOf({ provider: null, actualModel: null, model: '未知模型（历史记录缺少路由）' }), null)
})

test('provider-only rows resolve, but never contradict the model namespace', () => {
  assert.equal(keyOf({ provider: 'deepseek', actualModel: null, requestedModel: null, model: 'deepseek' }), 'deepseek')
  // Legacy label carries the model after the separator.
  assert.equal(keyOf({ provider: null, actualModel: null, requestedModel: null, model: 'deepseek / deepseek-v4-flash' }), 'deepseek')
  // Provider says OpenAI while the model is a Claude namespace: the model wins.
  assert.equal(keyOf({ provider: 'openai', actualModel: 'claude-opus-4.7' }), 'claude')
  // Provider matches, label model is unknown: the provider still wins.
  assert.equal(keyOf({ provider: 'anthropic', actualModel: null, model: 'anthropic / house-tuned' }), 'claude')
})

test('aggregate rows only carry an icon when every member is one brand', () => {
  const single = resolveAggregateModelIcon([
    { provider: 'deepseek-official', actualModel: 'deepseek-v4-flash' },
    { provider: 'openrouter', actualModel: 'deepseek-v4-flash' },
  ])
  assert.equal(single === null ? null : single.key, 'deepseek')
  const mixed = resolveAggregateModelIcon([
    { provider: 'deepseek-official', actualModel: 'deepseek-v4-flash' },
    { provider: 'openai', actualModel: 'gpt-5.6-luna' },
  ])
  assert.equal(mixed, null)
  const withUnknown = resolveAggregateModelIcon([
    { provider: 'deepseek-official', actualModel: 'deepseek-v4-flash' },
    { provider: 'house', actualModel: 'house-model-v1' },
  ])
  assert.equal(withUnknown, null)
  assert.equal(resolveAggregateModelIcon([]), null)
})

test('provider aggregates use provider icons and never inherit a model brand', () => {
  const rows = [
    { provider: 'openrouter', requestedModel: 'deepseek-v4-flash', actualModel: 'deepseek-v4-flash', model: 'openrouter / deepseek-v4-flash', calls: 1, input: 10, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    { provider: 'openrouter', requestedModel: 'gpt-5.6-luna', actualModel: 'gpt-5.6-luna', model: 'openrouter / gpt-5.6-luna', calls: 1, input: 10, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    { provider: 'deepseek-official', requestedModel: 'deepseek-v4-flash', actualModel: 'deepseek-v4-flash', model: 'deepseek-official / deepseek-v4-flash', calls: 1, input: 10, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
  ]
  const byProvider = aggregateRows(rows, 'provider')
  // A gateway serving several vendors stays neutral even though one of its rows
  // would resolve to a DeepSeek model icon.
  assert.equal(byProvider.find((row) => row.model === 'openrouter').iconKey, null)
  assert.equal(byProvider.find((row) => row.model === 'deepseek-official').iconKey, 'deepseek')
  const byModel = aggregateRows(rows, 'model')
  assert.equal(byModel.find((row) => row.model === 'deepseek-v4-flash').iconKey, 'deepseek')
  assert.equal(byModel.find((row) => row.model === 'gpt-5.6-luna').iconKey, 'openai')
})

test('longer model prefixes win over shorter ones', () => {
  const icon = iconForModel('gemma-3-27b')
  assert.equal(icon === null ? null : icon.key, 'gemini')
  assert.equal(iconForProvider('DeepSeek-Official').key, 'deepseek')
  assert.equal(iconForProvider(''), null)
})

test('the built bundle embeds every icon as an inline data URI', async () => {
  const bundle = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  const matches = bundle.match(/data:image\/svg\+xml;base64,/g) || []
  assert.equal(matches.length, manifest.icons.length)
  assert.doesNotMatch(bundle, /__MODEL_ICON_DATA__/)
  assert.doesNotMatch(bundle, /AIICOsvg/)
  assert.doesNotMatch(bundle, /MyDocument/)
  for (const icon of manifest.icons) {
    const svg = await readFile(new URL('../assets/model-icons/' + icon.file, import.meta.url), 'utf8')
    const encoded = Buffer.from(svg.replace(/>\s+</g, '><').trim(), 'utf8').toString('base64')
    assert.ok(bundle.includes(encoded), icon.file + ' must be embedded in the bundle')
  }
})
