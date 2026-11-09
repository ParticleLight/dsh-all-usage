import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { collectClientStrings, verifyDictionary } from '../scripts/locale-keys.mjs'
import { localeHelperSource } from './support/locale-helpers.js'

// DSH ships eight interface locales (Settings → General → Language). The panel
// offers the same eight ids under their native labels, resolves the same way (a
// panel choice, then the host locale, then the browser, then English) and keeps its
// text as literals keyed by the English source string, exactly like the host's own
// dictionaries: a missing key falls back to English instead of blanking the row.
// These tests make the last part mechanical — a string that is not a literal, or a
// dictionary that misses one, fails here instead of showing English to a reader of
// another language.
const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')
const LOCALES = ['ja', 'es', 'fr', 'de', 'ru', 'pt']
const HOST_MENU = [['zh', '中文'], ['en', 'English'], ['ja', '日本語'], ['es', 'Español'], ['fr', 'Français'], ['de', 'Deutsch'], ['ru', 'Русский'], ['pt', 'Português']]
const { entries, dynamic } = collectClientStrings(source)
const dictionaries = new Map()
for (const id of LOCALES) {
  dictionaries.set(id, JSON.parse(await readFile(new URL('../src/locales/' + id + '.json', import.meta.url), 'utf8')))
}

function problems(report) {
  return {
    missing: report.missing,
    extra: report.extra,
    empty: report.empty,
    placeholders: report.placeholders,
  }
}

test('the panel offers exactly the eight languages the host ships', () => {
  const start = source.indexOf('    const LANGUAGE_ENTRIES = [')
  const end = source.indexOf('    const LANGUAGE_IDS')
  assert.notEqual(start, -1, 'the language table must exist')
  assert.notEqual(end, -1, 'the language ids must follow the table')
  const found = [...source.slice(start, end).matchAll(/\['([a-z]{2})', '([^']+)'\]/g)].map((match) => [match[1], match[2]])
  assert.deepEqual(found, HOST_MENU, 'the ids, the native labels and their order must match the host menu')
})

test('every string the panel renders is a literal a dictionary can key on', () => {
  assert.deepEqual(dynamic, [], 'a string built at runtime cannot be translated: write both branches of the choice as literals')
  assert.ok(entries.size > 300, 'the panel renders more than three hundred distinct strings')
  for (const [english, entry] of entries) {
    assert.ok(english !== '', 'an empty English literal cannot be translated')
    assert.equal(typeof entry.zh, 'string', 'every English literal carries the Chinese copy beside it: ' + JSON.stringify(english))
  }
})

test('every dictionary covers exactly the strings the panel renders', () => {
  for (const id of LOCALES) {
    const report = verifyDictionary(id, dictionaries.get(id), entries)
    assert.deepEqual(problems(report), { missing: [], extra: [], empty: [], placeholders: [] }, 'src/locales/' + id + '.json: ' + JSON.stringify(problems(report)).slice(0, 600))
  }
})

test('the dictionary gate fails on a hole, a stray key, a broken placeholder and a blank value', () => {
  // Negative controls: a gate that cannot go red is decoration.
  const german = dictionaries.get('de')
  const templated = [...entries.keys()].find((key) => key.includes('{count}'))
  assert.ok(templated, 'the panel renders at least one {count} template')
  const holed = Object.assign({}, german)
  delete holed[templated]
  assert.deepEqual(verifyDictionary('de', holed, entries).missing, [templated])
  const stray = Object.assign({}, german, { 'a string the panel dropped': 'x' })
  assert.deepEqual(verifyDictionary('de', stray, entries).extra, ['a string the panel dropped'])
  const broken = Object.assign({}, german, { [templated]: 'kein platzhalter' })
  assert.deepEqual(verifyDictionary('de', broken, entries).placeholders, [templated])
  const blank = Object.assign({}, german, { [templated]: '   ' })
  assert.deepEqual(verifyDictionary('de', blank, entries).empty, [templated])
})

test('the lookup follows the host: dictionary first, English when a key is missing', () => {
  const table = Object.fromEntries(dictionaries)
  const snippet = localeHelperSource(source).replace('/* __LOCALE_MESSAGES__ */ {}', JSON.stringify(table)) +
    '\nglobalThis.__locale = { pick, pickFormat, intlLocale, normalizeLanguage, LANGUAGE_IDS, LANGUAGE_LABELS }'
  const context = {}
  vm.runInNewContext(snippet, context)
  const { pick, pickFormat, intlLocale, normalizeLanguage, LANGUAGE_LABELS } = context.__locale
  const sample = [...entries.keys()].sort((left, right) => right.length - left.length)[0]
  for (const id of LOCALES) {
    assert.equal(pick(id, '中文原文', sample), table[id][sample], id + ' reads its own dictionary')
    assert.equal(LANGUAGE_LABELS.get(id), HOST_MENU.find(([entryId]) => entryId === id)[1])
  }
  assert.equal(pick('zh', '中文原文', sample), '中文原文', 'Chinese reads the copy written in the source')
  assert.equal(pick('en', '中文原文', sample), sample, 'English reads the source string itself')
  assert.equal(pick('ru', '中文原文', 'a string no dictionary carries'), 'a string no dictionary carries', 'an unknown key falls back to English')
  assert.equal(pickFormat('en', '{count} 个', 'Total {count}', { count: 7 }), 'Total 7', 'templates fill their placeholders')
  assert.equal(pickFormat('fr', '{count} 个', 'Total {count}', { count: 7 }).includes('7'), true)
  assert.equal(intlLocale('pt'), 'pt-BR')
  assert.equal(intlLocale('ja'), 'ja-JP')
  assert.equal(intlLocale('xx'), 'en-US', 'an unknown language formats numbers in English')
  assert.equal(normalizeLanguage('pt-BR'), 'pt', 'a regional tag resolves to its language')
  assert.equal(normalizeLanguage('ko-KR'), null, 'a language the panel does not carry is not adopted')
})

test('no dictionary leaks the Chinese copy', () => {
  for (const id of ['es', 'fr', 'de', 'ru', 'pt']) {
    const dictionary = dictionaries.get(id)
    const leaked = Object.keys(dictionary).filter((key) => /[\u3400-\u4dbf\u4e00-\u9fff]/.test(dictionary[key]))
    assert.deepEqual(leaked.slice(0, 5), [], 'src/locales/' + id + '.json must translate the Chinese copy, not carry it over')
  }
})

test('pricing labels resolve through the dictionary instead of an empty lookup', () => {
  // The first rewrite of the language ternaries left `pair[undefined]` in three
  // pricing label helpers, which rendered an empty chip. Evaluate them so the
  // regression cannot come back unnoticed.
  const start = source.indexOf('    function pricingStatusLabel')
  const end = source.indexOf('    function pricingRowKey')
  assert.notEqual(start, -1, 'the pricing label helpers must exist')
  assert.notEqual(end, -1, 'the helpers must be contiguous')
  const context = {}
  vm.runInNewContext(localeHelperSource(source) + '\n' + source.slice(start, end) + '\nglobalThis.__labels = { pricingStatusLabel, pricingSemanticsLabel, pricingRateLabel }', context)
  const { pricingStatusLabel, pricingSemanticsLabel, pricingRateLabel } = context.__labels
  assert.equal(pricingStatusLabel('priced', 'zh'), '已计价')
  assert.equal(pricingStatusLabel('unpriced', 'en'), 'unpriced')
  assert.equal(pricingStatusLabel('unknown-status', 'zh'), '未计价', 'an unknown status falls back to the unpriced pair')
  assert.equal(pricingSemanticsLabel('total', 'zh').startsWith('Total'), true)
  assert.equal(pricingRateLabel('cacheRead', 'zh'), '缓存读 / 1M')
  assert.equal(pricingRateLabel('missing', 'en'), 'Input / 1M')
})

test('the built bundle carries every dictionary', async () => {
  const bundle = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  const sample = [...entries.keys()].sort((left, right) => right.length - left.length)[0]
  for (const id of LOCALES) {
    assert.ok(bundle.includes(dictionaries.get(id)[sample]), 'lib/client.js is stale: run npm run build:client so ' + id + ' ships inside the bundle')
  }
})
test('a language choice keeps the id the menu offered instead of collapsing to two languages', () => {
  // The old switch was binary: everything that was not English became Chinese, so
  // picking 日本語 showed Chinese and stored 'zh'. Both hand-off points must keep the
  // id; a regression here looks like a working menu that silently does nothing.
  assert.ok(!/=== 'en' \? 'en' : 'zh'/.test(source), 'no language hand-off may collapse a choice to English or Chinese')
  const forwarded = source.match(/onLanguageChange\(normalizeLanguage\(next\) \?\? 'zh'\)/g) || []
  assert.equal(forwarded.length, 1, 'the sheet forwards the chosen id through normalizeLanguage')
  assert.equal((source.match(/const value = normalizeLanguage\(next\) \?\? 'zh'/g) || []).length, 1, 'the sidebar entry stores the chosen id through normalizeLanguage')
})
