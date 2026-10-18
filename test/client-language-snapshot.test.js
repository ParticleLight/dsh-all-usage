import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

// The host serves one timezone calendar per snapshot request — byDay or byDayUtc,
// chosen by the utc flag the client derives from the panel language — and the fetch
// sits in a mount effect that only repeats when the host revision changes. Switching
// the language only rewrites storage, so the panel used to keep reading the calendar
// of the previous language: English reads stats.byDayUtc, which a snapshot fetched in
// Chinese leaves empty, and the dashboard stayed empty until a reload.
//
// The language itself resolves in a fixed order: an explicit choice made in the panel,
// then DSH's own Language row (the host locale runtime), then the browser, then
// English — and only once per page load, so the request flag can never disagree with
// the language the panel is rendering in.
const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')

const languageStart = source.indexOf('    const snapshotUtcFlag')
const languageEnd = source.indexOf('    // 与 Host 半的数据接口')
const keysStart = source.indexOf('    const LANGUAGE_STORAGE_KEY')
const keysEnd = source.indexOf('    const USAGE_UI_STATE_KEY')
assert.notEqual(languageStart, -1, 'snapshotUtcFlag must exist')
assert.notEqual(languageEnd, -1, 'the host data interface must follow the flag helper')
assert.notEqual(keysStart, -1, 'the language keys must exist')
assert.notEqual(keysEnd, -1, 'the UI-state key must follow the language helpers')
const languageSnippet = source.slice(languageStart, languageEnd) + '\n' + source.slice(keysStart, keysEnd) +
  '\nglobalThis.__language = { storedLanguage, snapshotUtcFlag, adoptLocaleScope, persistLanguage }'

/** Run the language helpers against a fake storage, navigator and locale runtime. */
function loadLanguage({ stored = null, chosen = false, navigatorLanguage = 'zh-CN', hostLocale = null } = {}) {
  const store = new Map()
  if (stored !== null) store.set('dsh-all-usage.language', stored)
  if (chosen) store.set('dsh-all-usage.language.chosen', '1')
  const context = {
    window: {
      localStorage: {
        getItem: (key) => (store.has(key) ? store.get(key) : null),
        setItem: (key, value) => { store.set(key, String(value)) },
      },
    },
    navigator: { language: navigatorLanguage },
  }
  vm.runInNewContext(languageSnippet, context)
  const api = context.__language
  const withHost = (active) => api.adoptLocaleScope({ get: (name) => (name === 'locale' ? { getLocale: () => ({ active }) } : undefined) })
  if (hostLocale !== null) withHost(hostLocale)
  return { api, store, withHost }
}

test("the language follows DSH's Language row until the panel chooses one", () => {
  const fresh = loadLanguage({ navigatorLanguage: 'zh-CN' })
  assert.equal(fresh.api.storedLanguage(), 'zh', 'the browser stands in before any host locale is seen')

  const englishHost = loadLanguage({ navigatorLanguage: 'zh-CN', hostLocale: 'en' })
  assert.equal(englishHost.api.storedLanguage(), 'en', 'an English host opens the panel in English')
  assert.equal(englishHost.api.snapshotUtcFlag(), '?utc=1', 'and asks for the UTC calendar')

  const chineseHost = loadLanguage({ hostLocale: 'zh' })
  assert.equal(chineseHost.api.storedLanguage(), 'zh')
  assert.equal(chineseHost.api.snapshotUtcFlag(), '?utc=0')

  const chosen = loadLanguage({ stored: 'zh', chosen: true, hostLocale: 'en' })
  assert.equal(chosen.api.storedLanguage(), 'zh', 'a panel choice outranks the host language')

  assert.equal(loadLanguage({ navigatorLanguage: 'ja-JP', hostLocale: 'ja' }).api.storedLanguage(), 'en', 'a language the panel does not ship reads English')
  assert.equal(loadLanguage({ navigatorLanguage: 'fr-FR' }).api.storedLanguage(), 'en', 'an unregistered browser language falls back to English')
  assert.equal(loadLanguage({ navigatorLanguage: 'zh-TW' }).api.storedLanguage(), 'zh', 'a Chinese browser starts in Chinese')

  // Resolved once: flipping the host under a mounted panel must not move the language,
  // because the next snapshot request would then fetch the other calendar.
  const pinned = loadLanguage({ hostLocale: 'en' })
  assert.equal(pinned.api.storedLanguage(), 'en')
  pinned.withHost('zh')
  assert.equal(pinned.api.storedLanguage(), 'en', 'the language is pinned for the page load')

  const persisted = loadLanguage({})
  persisted.api.persistLanguage('en')
  assert.equal(persisted.store.get('dsh-all-usage.language'), 'en')
  assert.equal(persisted.store.get('dsh-all-usage.language.chosen'), '1', 'a panel choice is marked as explicit')
  persisted.withHost('zh')
  assert.equal(persisted.api.storedLanguage(), 'en', 'the mark keeps the choice across host changes')
})

test('the snapshot request asks for the calendar matching that language', () => {
  assert.match(source, /fetch\('\/api\/all-usage' \+ snapshotUtcFlag\(\)/, 'the full snapshot is the request that carries the calendar flag')
  assert.equal(loadLanguage({ hostLocale: 'en' }).api.snapshotUtcFlag(), '?utc=1')
})

test('a language switch refetches the snapshot instead of reusing the other calendar', () => {
  assert.match(source, /const refreshStatsRef = React\.useRef\(\(\) => \{\}\)/, 'the loader must be reachable outside its mount effect')
  assert.match(source, /refreshStatsRef\.current = refreshStats/, 'the mount effect must expose the loader')
  const at = source.indexOf('snapshotUtcRef.current === useUtc')
  assert.notEqual(at, -1, 'a language-keyed effect must detect the switch')
  const effect = source.slice(Math.max(0, at - 260), at + 260)
  assert.match(effect, /refreshStatsRef\.current\(\)/, 'the switch must refetch, not reuse the stale calendar')
  assert.match(effect, /\}, \[useUtc\]\)/, 'the effect must run when the language-derived flag changes')
  // The switch stays out of the mount effect: adding the flag to its dependency
  // array would tear down the polling timers and cost a second full fetch.
  const exposed = source.indexOf('refreshStatsRef.current = refreshStats')
  const closeAt = source.indexOf('      }, [', exposed)
  assert.notEqual(closeAt, -1, 'the snapshot mount effect must still close with a dependency array')
  assert.equal(source.slice(closeAt, closeAt + 12).trim(), '}, [])', 'the snapshot mount effect keeps its empty dependency array')
})

test('the hourly trend guard reads the calendar the snapshot actually carries', () => {
  // The host answers a UTC snapshot with byDayUtc and an empty byDay (lib/http.js), so
  // a guard that reads byDay alone drops every hourly series in English mode and the
  // "today" trend falls back to a single daily point.
  const start = source.indexOf('    function processedTokensOf')
  const end = source.indexOf('    function costCallsOf')
  assert.notEqual(start, -1, 'processedTokensOf must exist')
  assert.notEqual(end, -1, 'costCallsOf must follow the guard')
  const context = {}
  vm.runInNewContext(source.slice(start, end) + '\nglobalThis.__trusted = trustedHourlyRows', context)
  const hourly = [{ time: Date.UTC(2026, 9, 18, 3), tokens: { input: 10, output: 5 } }]
  const day = { date: '2026-10-18', tokens: { input: 10, output: 5 } }
  const utcStats = { byDay: [], byDayUtc: [day] }
  const localStats = { byDay: [day], byDayUtc: [] }
  assert.equal(context.__trusted(hourly, utcStats, '2026-10-18', true).length, 1, 'UTC mode must read byDayUtc')
  assert.equal(context.__trusted(hourly, localStats, '2026-10-18', false).length, 1, 'local mode must read byDay')
  assert.equal(context.__trusted(hourly, utcStats, '2026-10-18', false).length, 0, 'a local lookup against a UTC snapshot stays untrusted')
})
