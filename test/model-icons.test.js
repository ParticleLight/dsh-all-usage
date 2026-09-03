import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { assertSafeSvg, decodeEntities } from '../scripts/svg-guard.mjs'

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
  MAX_MODEL_ICON_CACHE: 2000,
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
  assert.equal(manifest.schemaVersion, 2)
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

test('the manifest records pinned upstream provenance for every icon', () => {
  assert.equal(manifest.schemaVersion, 2)
  const upstream = manifest.upstream
  assert.ok(upstream !== null && typeof upstream === 'object')
  assert.match(upstream.revision, /^[0-9a-f]{40}$/)
  assert.equal(upstream.license, 'MIT')
  assert.ok(upstream.copyright.includes('Copyright'))
  assert.ok(Array.isArray(manifest.modifications) && manifest.modifications.length > 0)
  for (const icon of manifest.icons) {
    assert.ok(typeof icon.upstreamPath === 'string' && icon.upstreamPath !== '', icon.key + ' needs an upstream path')
    assert.equal(typeof icon.modified, 'boolean', icon.key + ' needs a modification flag')
  }
  // The two neutralised marks must be flagged as modified.
  assert.equal(manifest.icons.find((icon) => icon.key === 'grok').modified, true)
  assert.equal(manifest.icons.find((icon) => icon.key === 'openai').modified, true)
})

test('the bundled licence file carries the upstream notice and pinned revision', async () => {
  const text = await readFile(new URL('../assets/model-icons/' + manifest.upstream.licenseFile, import.meta.url), 'utf8')
  assert.ok(text.includes(manifest.upstream.revision), 'licence must reference the pinned revision')
  assert.ok(text.includes('MIT License'))
  assert.ok(text.includes(manifest.upstream.copyright))
  assert.ok(/Trademark notice/i.test(text))
  assert.ok(/#8a8f98/.test(text), 'local modifications must be documented')
})

test('the SVG guard rejects encoded and unquoted external references', () => {
  const cases = [
    ['unquoted href', '<svg><a href=//attacker.invalid>x</a></svg>'],
    ['entity-encoded css url', '<svg><path style="fill:url(&quot;https://attacker.invalid/x&quot;)"/></svg>'],
    ['entity-encoded attribute', '<svg><a &#104;ref="https://attacker.invalid">x</a></svg>'],
    ['use element', '<svg><use href="#a"/></svg>'],
    ['image element', '<svg><image href="#a"/></svg>'],
    ['script element', '<svg><script>alert(1)</script></svg>'],
    ['inline handler', '<svg onload=alert(1)></svg>'],
    ['javascript uri', '<svg><a href="javascript:alert(1)">x</a></svg>'],
    ['data uri paint', '<svg><path fill="data:image/png;base64,AAA"/></svg>'],
    ['quoted css import', '<svg><style>@import \"https://attacker.invalid/x.css\";</style></svg>'],
    ['unquoted css import', '<svg><style>@import //attacker.invalid/x.css;</style></svg>'],
    ['relative css import', '<svg><style>@import \"/vendor.css\";</style></svg>'],
    ['encoded css import', '<svg><style>@import &quot;https://attacker.invalid/x.css&quot;;</style></svg>'],
    ['css url import', '<svg><style>@import url(https://attacker.invalid/x.css);</style></svg>'],
    ['comment separated import', '<svg><style>@import/**/\"https://attacker.invalid/x.css\";</style></svg>'],
    ['escaped import', '<svg><style>@\\69 mport \"https://attacker.invalid/x.css\";</style></svg>'],
    ['escaped middle import', '<svg><style>@im\\70 ort \"https://attacker.invalid/x.css\";</style></svg>'],
    ['continued import', '<svg><style>@im\\\nport \"https://attacker.invalid/x.css\";</style></svg>'],
    ['CDO import', '<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"16\" height=\"16\"><style><!--@import \"https://attacker.invalid/x.css\";--></style><rect width=\"16\" height=\"16\" fill=\"#000\"/></svg>'],
    ['CDC import', '<svg xmlns=\"http://www.w3.org/2000/svg\"><style>a{}-->&#64;import \"https://attacker.invalid/x.css\";</style><rect width=\"16\" height=\"16\" fill=\"#000\"/></svg>'],
    ['namespaced svg:style import', '<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:svg=\"http://www.w3.org/2000/svg\" width=\"16\" height=\"16\"><svg:style>@import \"https://attacker.invalid/x.css\";</svg:style><rect width=\"16\" height=\"16\" fill=\"#000\"/></svg>'],
    ['escaped url identifier', '<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"16\" height=\"16\"><style>#a{background-image:\\75 rl(\"https://attacker.invalid/p.png\")}</style><rect id=\"a\" width=\"16\" height=\"16\" fill=\"#000\"/></svg>'],
    ['escaped url in style attribute', '<svg xmlns=\"http://www.w3.org/2000/svg\"><rect width=\"16\" height=\"16\" fill=\"#000\" style=\"background-image:\\75 rl(/p.png)\"/></svg>'],
    ['image-set external', '<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"16\" height=\"16\"><style>#a{background-image:image-set(\"https://attacker.invalid/p.png\" 1x)}</style><rect id=\"a\" width=\"16\" height=\"16\" fill=\"#000\"/></svg>'],
    ['doctype', '<!DOCTYPE svg><svg></svg>'],
    ['currentColor', '<svg fill="currentColor"></svg>'],
    ['error page body', '404: Not Found'],
    ['unclosed root', '<svg><path/>'],
  ]
  for (const [name, svg] of cases) {
    // Assert the reason so these cases cannot be rejected by an unrelated rule
    // (size, root, DOCTYPE) and stay warnings that never exercise CSS checks.
    assert.throws(() => assertSafeSvg(name, svg), (error) => {
      const message = String(error && error.message)
      const cssCases = name.includes('import') || name.includes('url') || name.includes('url identifier') || name.includes('image-set')
      if (cssCases) return /@import|external CSS resource/.test(message)
      // Fixtures without a valid <svg> root are rejected by the structural
      // check before their own rule fires; that is still a correct rejection.
      if (name === 'doctype' || name === 'error page body' || name === 'unclosed root') return /DOCTYPE|not a valid SVG document|closing/.test(message)
      return /external resource|external URI|disallowed|scripting|DOCTYPE|currentColor|not an SVG|closing/.test(message)
    }, name + ' must be rejected by the expected check')
  }
  // Entities are decoded repeatedly so nested encodings cannot hide a payload.
  assert.equal(decodeEntities('&#104;ref &quot;x&quot;'), 'href "x"')
  assert.equal(decodeEntities('&amp;#104;ref'), 'href')
})

test('the SVG guard permits local styles, comments and non-CSS text', () => {
  const svg = '<svg><defs><linearGradient id="paint"/></defs><style>/* @import "https://example.invalid/x.css" */ .mark{fill:url(#paint);content:"@import"}</style><path class="mark"/></svg>'
  assert.equal(assertSafeSvg('local-style', svg), svg)
  const styledPath = '<svg><path style="fill:url(#paint)"/></svg>'
  assert.equal(assertSafeSvg('style-attribute', styledPath), styledPath)
  // SVG data (text, XML comments) is not CSS and must never be checked for url().
  const text = '<svg><text>@import "https://example.invalid/x.css"</text></svg>'
  assert.equal(assertSafeSvg('text-content', text), text)
  assert.equal(assertSafeSvg('text-url', '<svg><text x="0" y="8" fill="#000">url(https://x.example)</text></svg>'), '<svg><text x="0" y="8" fill="#000">url(https://x.example)</text></svg>')
  assert.equal(assertSafeSvg('xml-comment-url', '<svg xmlns="http://www.w3.org/2000/svg"><!-- source url(https://lobehub.com/icons) --><path d="M0 0h4v4H0z" fill="#000"/></svg>'), '<svg xmlns="http://www.w3.org/2000/svg"><!-- source url(https://lobehub.com/icons) --><path d="M0 0h4v4H0z" fill="#000"/></svg>')
  assert.equal(assertSafeSvg('css-comment-url', '<svg xmlns="http://www.w3.org/2000/svg"><style>/* was url(https://cdn.example/x.png) */ .a{fill:#000}</style><path class="a" d="M0 0h4v4H0z"/></svg>'), '<svg xmlns="http://www.w3.org/2000/svg"><style>/* was url(https://cdn.example/x.png) */ .a{fill:#000}</style><path class="a" d="M0 0h4v4H0z"/></svg>')
  // Escape-decoded @ is literal text, not an at-rule (Blink treats \40 import as inert).
  const escapedAt = '<svg xmlns="http://www.w3.org/2000/svg"><style>.a{content:"\\40 import"}</style><path class="a" d="M0 0h4v4H0z"/></svg>'
  assert.equal(assertSafeSvg('escaped-at', escapedAt), escapedAt)
})

test('every bundled icon passes the same guard the build uses', async () => {
  for (const icon of manifest.icons) {
    const svg = await readFile(new URL('../assets/model-icons/' + icon.file, import.meta.url), 'utf8')
    assert.equal(assertSafeSvg(icon.file, svg), svg)
  }
})

test('model prefixes match on token boundaries only', () => {
  const key = (model) => { const icon = iconForModel(model); return icon === null ? null : icon.key }
  assert.equal(key('o3-mini'), 'openai')
  assert.equal(key('o3'), 'openai')
  assert.equal(key('gpt-5.6-luna'), 'openai')
  assert.equal(key('qwen3-max'), 'qwen')
  assert.equal(key('abab6.5s'), 'minimax')
  // Negative cases: a longer word that merely starts with the same letters.
  assert.equal(key('o10-preview'), null)
  assert.equal(key('o3x'), null)
  assert.equal(key('qwenfoo'), null)
  assert.equal(key('ababcustom'), null)
  assert.equal(key('gptzero'), null)
  assert.equal(key('claudette-1'), null)
})

test('an unrecognised actual model never inherits the requested brand', () => {
  // A gateway that answers with its own private model id must stay neutral:
  // attributing an unknown model to the requested vendor would be a false claim.
  assert.equal(keyOf({ provider: 'openrouter', actualModel: 'vendor-private-v1', requestedModel: 'gpt-4o' }), null)
  assert.equal(keyOf({ provider: 'openrouter', actualModel: 'house-model-v1', requestedModel: 'gpt-4o' }), null)
  // Only a missing actual model falls back to the requested one.
  assert.equal(keyOf({ provider: 'openrouter', actualModel: null, requestedModel: 'gpt-4o' }), 'openai')
  assert.equal(keyOf({ provider: 'openrouter', actualModel: '', requestedModel: 'deepseek-v4-flash' }), 'deepseek')
  // A recognised actual model still wins over a different requested brand.
  assert.equal(keyOf({ provider: 'openrouter', actualModel: 'claude-opus-4.7', requestedModel: 'gpt-4o' }), 'claude')
})

test('model filter options resolve to brand icons the same way rows do', () => {
  const optionKey = (model) => { const icon = resolveModelIcon({ actualModel: model, requestedModel: model }); return icon === null ? null : icon.key }
  assert.equal(optionKey('claude-opus-5-thinking'), 'claude')
  assert.equal(optionKey('deepseek-ai/DeepSeek-V4-Flash'), 'deepseek')
  assert.equal(optionKey('deepseek-v4-flash-free'), 'deepseek')
  assert.equal(optionKey('gpt-5.6-luna'), 'openai')
  assert.equal(optionKey('grok-4.6'), 'grok')
  assert.equal(optionKey('nemotron-3-ultra-free'), null)
  assert.equal(optionKey('x-preview-f-free'), null)
  // The neutral option (empty value) renders the plain line icon, never a brand.
  const neutral = resolveModelIcon({ actualModel: '', requestedModel: '' })
  assert.equal(neutral, null)
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
