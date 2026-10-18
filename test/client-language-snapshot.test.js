import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

// The host serves one timezone calendar per snapshot request — byDay or byDayUtc,
// chosen by the utc flag the client derives from the stored language — and the
// fetch sits in a mount effect that only repeats when the host revision changes.
// Switching the language only rewrites storage, so the panel used to keep reading
// the calendar of the previous language: English reads stats.byDayUtc, which a
// snapshot fetched in Chinese leaves empty, and the dashboard stayed empty until a
// reload. These assertions pin the wiring that fixes it, at the source level, the
// way the other client tests do.
const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')

test('the snapshot request asks for the calendar matching the stored language', () => {
  const start = source.indexOf('const snapshotUtcFlag')
  const end = source.indexOf('const getStats')
  assert.notEqual(start, -1, 'snapshotUtcFlag must exist')
  assert.notEqual(end, -1, 'getStats must follow snapshotUtcFlag')
  const context = { window: { localStorage: { getItem: () => 'en' } } }
  vm.runInNewContext('const LANGUAGE_STORAGE_KEY = "k"\n' + source.slice(start, end) + '\nglobalThis.__flag = snapshotUtcFlag()', context)
  assert.equal(context.__flag, '?utc=1', 'English must ask for the UTC calendar')
  const chinese = { window: { localStorage: { getItem: () => 'zh' } } }
  vm.runInNewContext('const LANGUAGE_STORAGE_KEY = "k"\n' + source.slice(start, end) + '\nglobalThis.__flag = snapshotUtcFlag()', chinese)
  assert.equal(chinese.__flag, '?utc=0', 'Chinese must ask for the local calendar')
  assert.match(source, /fetch\('\/api\/all-usage' \+ snapshotUtcFlag\(\)/, 'the full snapshot is the request that carries the calendar flag')
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
