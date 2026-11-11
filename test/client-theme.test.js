import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

// 1.2.3 item 4 - light-theme tokens. The panel used to hard-code the dark palette in
// the stylesheet and in JS, so a light host got dark-on-white data colours, a black
// scrim and a dark scrollbar. The colours now live in a --uh-* token block (light
// defaults plus body[data-ds-dark-theme] overrides) and every paint site resolves
// them. These guards pin the four ways the split regresses: a token defined on one
// side only, a palette that loses contrast, a var() left in an SVG presentation
// attribute (it does not resolve there, so the mark falls back to a hard-coded
// colour) and the dark palette drifting away from what shipped before.
const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')

// The token layer is read out of the stylesheet literal only: client.js also writes
// custom properties inline at runtime (style: { '--uh-top-inset': ... }), and those
// are measurements, not theme tokens.
const CSS_OPEN = 'const CSS = ' + '`'
const cssOpenAt = source.indexOf(CSS_OPEN)
assert.notEqual(cssOpenAt, -1, 'the client stylesheet literal is missing: expected const CSS = followed by a template literal')
const cssFrom = cssOpenAt + CSS_OPEN.length
const cssTo = source.indexOf('\n`', cssFrom)
assert.ok(cssTo > cssFrom, 'the client stylesheet literal is not closed by a line that holds only a backtick')
const css = source.slice(cssFrom, cssTo).replace(/\/\*[\s\S]*?\*\//g, '')
assert.ok(css.includes('.uh-side-dialog'), 'the stylesheet literal was sliced incorrectly: .uh-side-dialog is missing')

// "Code" side of the file: the paint sites and any colour that escaped the token
// layer. The stylesheet itself declares the tokens, so it is excluded here.
const outsideCss = source.slice(0, cssOpenAt) + source.slice(cssTo)
const outsideCssLines = outsideCss.split(/\r?\n/)

const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
  selector: match[1].replace(/\s+/g, ' ').trim(),
  body: match[2],
}))
const isDarkRule = (rule) => rule.selector.includes('[data-ds-dark-theme]')
const selectorParts = (rule) => rule.selector.split(',').map((part) => part.trim())

const tokens = new Map()
for (const rule of rules) {
  for (const match of rule.body.matchAll(/(--uh-[a-z0-9-]+)\s*:\s*([^;]+)/gi)) {
    const name = match[1].toLowerCase()
    const entry = tokens.get(name) || { name, light: [], dark: [] }
    entry[isDarkRule(rule) ? 'dark' : 'light'].push(match[2].replace(/\s+/g, ' ').trim())
    tokens.set(name, entry)
  }
}
const tokenNames = [...tokens.keys()].sort()
const lightValue = (name) => (tokens.get(name) || { light: [] }).light[0]
const darkValue = (name) => {
  const entry = tokens.get(name) || { dark: [] }
  return entry.dark[entry.dark.length - 1]
}

function declarations(body, property) {
  return body
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(property + ':'))
    .map((part) => part.slice(property.length + 1).replace(/\s+/g, ' ').trim())
}

// Six-digit hex only: the palettes are checked numerically, so a colour-mix or a var()
// in a data-colour slot must not slip past the contrast guard unnoticed.
function channels(hex, label) {
  const text = String(hex).trim()
  assert.match(text, /^#[0-9a-f]{6}$/i, label + ' must hold a six-digit hex colour so its contrast is checkable, got: ' + text)
  return [1, 3, 5].map((index) => parseInt(text.slice(index, index + 2), 16) / 255)
}

function luminance(hex, label) {
  const linear = channels(hex, label).map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
}

function contrast(foreground, background, label) {
  const first = luminance(foreground, label)
  const second = luminance(background, 'the ' + background + ' host background')
  const lighter = Math.max(first, second)
  const darker = Math.min(first, second)
  return (lighter + 0.05) / (darker + 0.05)
}

// The calibrated light palette (>= 4.75:1 on #ffffff).
const LIGHT_SERIES = {
  '--uh-series-total': '#8a5a00',
  '--uh-series-input': '#0b5cad',
  '--uh-series-cache-read': '#17703a',
  '--uh-series-cache-write': '#6d2fb8',
  '--uh-series-output': '#a8451c',
  '--uh-series-reasoning': '#55606f',
  '--uh-series-other': '#6b7280',
  '--uh-donut-1': '#0a63c9',
  '--uh-donut-2': '#1a7a3c',
  '--uh-donut-3': '#7a34c9',
  '--uh-donut-4': '#a8620a',
  '--uh-donut-5': '#bf2439',
  '--uh-donut-6': '#0d7b93',
}

// The palette the panel shipped while it was dark-only: the split has to be a no-op
// for a dark host, byte for byte.
const DARK_TOKENS = {
  '--uh-series-total': '#f4c542',
  '--uh-series-input': '#5aa9ff',
  '--uh-series-cache-read': '#44d483',
  '--uh-series-cache-write': '#d98bff',
  '--uh-series-output': '#ff8c66',
  '--uh-series-reasoning': '#aab4c4',
  '--uh-series-other': '#b8c2cf',
  '--uh-donut-1': '#0a84ff',
  '--uh-donut-2': '#30d158',
  '--uh-donut-3': '#bf5af2',
  '--uh-donut-4': '#ff9f0a',
  '--uh-donut-5': '#ff375f',
  '--uh-donut-6': '#64d2ff',
  '--uh-heat': '#0969da',
  '--uh-cell-empty': 'var(--dsw-alias-bg-layer-2)',
  '--uh-scrim': 'rgba(0,0,0,.34)',
  '--uh-dialog-shadow': '0 -10px 44px rgba(0,0,0,.25)',
  '--uh-scrollbar-thumb': '#707780',
  '--uh-scrollbar-track': '#1d1f22',
}

const DARK_ONLY_LITERALS = ['#f4c542', '#5aa9ff', '#44d483', '#d98bff', '#ff8c66', '#aab4c4', '#b8c2cf', '#9aa4b2', '#0a84ff', '#30d158', '#bf5af2', '#ff9f0a', '#ff375f', '#64d2ff']
const withoutTokenDeclarations = source.replace(/--uh-[a-z0-9-]+\s*:\s*[^;'"]*/gi, '')

test('declares every theme token for the light sheet and repeats it for the dark one', () => {
  const surfaces = ['.uh-side-modal', '.uh-side-dialog', '.uh-panel', '.uh-tip', '.uh-donut-tooltip', '.uh-trend-tooltip']
  const lightSelectors = rules.filter((rule) => !isDarkRule(rule) && /--uh-/.test(rule.body)).flatMap(selectorParts)
  const missingSurfaces = surfaces.filter((surface) => !lightSelectors.includes(surface))
  assert.equal(missingSurfaces.length, 0, 'the light token defaults must be declared on every painted surface, otherwise that surface keeps inheriting the dark palette: ' + missingSurfaces.join(', '))
  assert.ok(tokenNames.length >= 18, 'the --uh-* token layer is missing (' + tokenNames.length + ' tokens found): the light sheet keeps painting hard-coded dark data colours')
  const missingLight = tokenNames.filter((name) => tokens.get(name).light.length === 0)
  assert.equal(missingLight.length, 0, 'these tokens only exist under body[data-ds-dark-theme], so a light host resolves nothing and falls back to the dark literal: ' + missingLight.join(', '))
  const missingDark = tokenNames.filter((name) => tokens.get(name).dark.length === 0)
  assert.equal(missingDark.length, 0, 'these tokens have no body[data-ds-dark-theme] override, so a dark host silently takes the light palette: ' + missingDark.join(', '))
  const series = tokenNames.filter((name) => name.startsWith('--uh-series-'))
  assert.equal(series.length, 7, 'the trend chart paints 7 series (total, input, cache read, cache write, output, reasoning, other), found: ' + series.join(', '))
  const donut = tokenNames.filter((name) => /^--uh-donut-[1-6]$/.test(name))
  assert.equal(donut.length, 6, 'the donut paints 6 segments, found: ' + donut.join(', '))
  const scalars = ['--uh-heat', '--uh-today', '--uh-cell-empty', '--uh-scrim', '--uh-dialog-shadow', '--uh-scrollbar-thumb', '--uh-scrollbar-track']
  const missingScalars = scalars.filter((name) => !tokens.has(name))
  assert.equal(missingScalars.length, 0, 'these non-series tokens are missing from the theme layer: ' + missingScalars.join(', '))
})

test('keeps the series and donut palettes readable on both host backgrounds', () => {
  const names = tokenNames.filter((name) => /^--uh-(series-[a-z-]+|donut-[1-6])$/.test(name))
  assert.equal(names.length, 13, 'expected 7 series plus 6 donut tokens, found: ' + names.join(', '))
  for (const name of names) {
    const light = lightValue(name)
    const dark = darkValue(name)
    assert.equal(light, LIGHT_SERIES[name], 'the light palette is the calibrated set (>= 4.75:1 on #ffffff) and must not drift: ' + name + ' got ' + light)
    const onLight = contrast(light, '#ffffff', name + ' on the light sheet')
    assert.ok(onLight >= 4.5, name + ' reaches only ' + onLight.toFixed(2) + ':1 against #ffffff (guard floor 4.5:1), so a light host cannot read the mark: got ' + light)
    assert.notEqual(dark, undefined, name + ' has no body[data-ds-dark-theme] override')
    const onDark = contrast(dark, '#111a27', name + ' on the dark sheet')
    assert.ok(onDark >= 4.5, name + ' reaches only ' + onDark.toFixed(2) + ':1 against #111a27 (needs >= 4.5:1): got ' + dark)
  }
})

test('keeps the dark-only colours inside the token layer', () => {
  const remaining = withoutTokenDeclarations.toLowerCase()
  const leaked = DARK_ONLY_LITERALS.filter((hex) => remaining.includes(hex))
  assert.equal(leaked.length, 0, 'these colours escaped the token layer, so a light host paints an unreadable dark colour: ' + leaked.join(', '))
})

const SVG_PAINT = [
  ['uh-trend-bar', 'fill'],
  ['uh-trend-line', 'stroke'],
  ['uh-trend-line-draw', 'stroke'],
  ['uh-trend-point', 'fill'],
  ['uh-donut-track', 'stroke'],
  ['uh-donut-segment', 'stroke'],
]
const PRESENTATION_COLOUR = /\b(fill|stroke|stopColor)\s*:\s*(colors\[|segment\.color|'#|'var\()/

test('paints every SVG mark through style so the tokens resolve', () => {
  for (const [className, property] of SVG_PAINT) {
    const lines = outsideCssLines.filter((line) => line.includes("'" + className + "'"))
    assert.ok(lines.length > 0, 'no element renders with className ' + className + ', so this guard has nothing to check any more')
    for (const line of lines) {
      const bare = line.replace(/style:\s*\{[^{}]*\}/g, '')
      assert.doesNotMatch(bare, PRESENTATION_COLOUR, className + ' paints its ' + property + ' through an SVG presentation attribute; var() does not resolve there, so the light sheet falls back to the hard-coded dark colour (move it into style: { ' + property + ': ... })')
      assert.match(line, new RegExp('style:\\s*\\{[^}]*\\b' + property + '\\s*:'), className + ' must pass its ' + property + ' in a style object; a presentation attribute would ignore var()')
    }
  }
  const stops = outsideCssLines.filter((line) => line.includes("React.createElement('stop'"))
  assert.ok(stops.length >= 2, 'the trend area gradient lost its <stop> elements')
  for (const line of stops) {
    const bare = line.replace(/style:\s*\{[^{}]*\}/g, '')
    assert.doesNotMatch(bare, /\bstopColor\s*:\s*(colors\[|'#|'var\()/, 'a gradient <stop> sets stopColor as a presentation attribute; var() does not resolve there, so the area gradient keeps a hard-coded colour on the light sheet')
    assert.match(line, /style:\s*\{[^}]*\bstopColor\s*:/, 'a gradient <stop> must set stopColor in a style object')
  }
})

test('mixes the heatmap cells into the themed empty colour', () => {
  const cellBgMatch = /\r?\n    function cellBg\(level\) \{[\s\S]*?\r?\n    \}/.exec(source)
  assert.ok(cellBgMatch, 'cellBg is missing from the client: the heatmap must blend into the themed empty cell')
  const cellBg = cellBgMatch[0]
  assert.match(cellBg, /var\(--uh-cell-empty\)/, 'cellBg must blend into var(--uh-cell-empty); without it a light host mixes the heat accent into the dark layer colour and every filled cell turns into a dark blob')
  assert.doesNotMatch(cellBg, /var\(--dsw-alias-bg-layer-2\)/, 'cellBg still mixes straight into the host layer colour instead of the themed empty cell')
  assert.doesNotMatch(cellBg, /#[0-9a-f]{3,8}/i, 'cellBg still hard-codes a colour instead of resolving the theme tokens')
  const heat = cellBg.includes('var(--uh-heat)') || /const HEAT_COLOR = 'var\(--uh-heat\)'/.test(source)
  assert.ok(heat, 'the heat accent must come from var(--uh-heat) so the light sheet can tune it')
  const lightEmpty = lightValue('--uh-cell-empty')
  assert.notEqual(lightEmpty, undefined, '--uh-cell-empty has no light default')
  assert.match(lightEmpty, /^color-mix\(in srgb, var\(--dsw-alias-label-primary\) \d+(?:\.\d+)?%/, 'the light empty cell must mix the host label colour into the layer, got: ' + lightEmpty)
  assert.doesNotMatch(lightEmpty, /^#(?:fff|ffffff)$/i, 'a pure white empty cell erases the heatmap grid on the light sheet')
})

test('drops the hard-coded dark chrome from the modal, the sheet and its scrollbars', () => {
  const modal = rules.filter((rule) => selectorParts(rule).includes('.uh-side-modal'))
  const scrims = modal.flatMap((rule) => declarations(rule.body, 'background'))
  assert.ok(scrims.length >= 2, 'the modal no longer declares a background in both of its rules')
  for (const value of scrims) {
    assert.equal(value, 'var(--uh-scrim)', 'the modal scrim must come from var(--uh-scrim); a hard-coded dark scrim (rgba(0,0,0,.34) or a color-mix with #000) dims the light sheet into a black veil')
  }
  // The floating card's rule carries two classes (.uh-side-modal .uh-side-dialog) so the
  // host skin cannot override its radius, so match the class inside a compound selector
  // instead of requiring the selector to be exactly '.uh-side-dialog'.
  const dialog = rules.filter((rule) => selectorParts(rule).some((part) => part.split(/\s+/).includes('.uh-side-dialog')))
  const shadows = dialog.flatMap((rule) => declarations(rule.body, 'box-shadow'))
  assert.ok(shadows.length >= 2, 'both .uh-side-dialog rules must carry the themed sheet shadow')
  for (const value of shadows) {
    assert.equal(value, 'var(--uh-dialog-shadow)', 'the sheet shadow must come from var(--uh-dialog-shadow); a hard-coded rgba(0,0,0,.25) shadow is a dark shadow on a light sheet')
  }
  const scrollbarColors = rules.flatMap((rule) => declarations(rule.body, 'scrollbar-color'))
  assert.ok(scrollbarColors.length >= 2, 'both scroll containers must set scrollbar-color')
  for (const value of scrollbarColors) {
    assert.equal(value, 'var(--uh-scrollbar-thumb) var(--uh-scrollbar-track)', 'scrollbar-color must use the two themed tokens; a literal pair stays dark on the light sheet, got: ' + value)
  }
  for (const [part, token] of [['::-webkit-scrollbar-track', 'var(--uh-scrollbar-track)'], ['::-webkit-scrollbar-thumb', 'var(--uh-scrollbar-thumb)']]) {
    const scoped = rules.filter((rule) => rule.selector.includes(part) && !rule.selector.includes(':hover'))
    assert.ok(scoped.length > 0, 'no rule styles ' + part)
    for (const rule of scoped) {
      assert.ok(rule.body.includes(token), 'the ' + part + ' rule must paint with ' + token + ': ' + rule.selector)
      assert.doesNotMatch(rule.body, /#[0-9a-f]{3,8}/i, 'the ' + part + ' rule still hard-codes a hex colour instead of resolving the scrollbar tokens: ' + rule.selector)
    }
  }
  for (const literal of ['#707780', '#1d1f22', '#363a40', 'rgba(0,0,0,.34)', 'color-mix(in srgb, #000 44%']) {
    assert.equal(withoutTokenDeclarations.toLowerCase().includes(literal.toLowerCase()), false, literal + ' is still painted outside the token layer, so the light sheet gets dark chrome')
  }
})

test('repeats the dark palette the panel shipped before the split', () => {
  for (const [name, value] of Object.entries(DARK_TOKENS)) {
    const actual = darkValue(name)
    assert.notEqual(actual, undefined, name + ' has no body[data-ds-dark-theme] override: the dark sheet would silently lighten')
    assert.equal(actual, value, name + ' changed on the dark sheet; the split has to be a no-op for dark hosts, got: ' + actual)
  }
})
