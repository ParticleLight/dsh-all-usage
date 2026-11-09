import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')
const bundle = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
// Brand artwork is served by the host on demand, so the bundle only carries the
// resolution metadata (one URL per brand). Nothing to exclude from the ratio.
const embeddedIconBytes = (bundle.match(/data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+/g) || []).reduce((sum, value) => sum + Buffer.byteLength(value), 0)
// The six translation dictionaries live outside src/client.js and are inlined by
// the build, so they are measured as data (minified JSON) rather than as code:
// the ratio below still proves the JavaScript around them is minified.
const localeDirectory = new URL('../src/locales/', import.meta.url)
const localeBytes = (await Promise.all(
  (await readdir(localeDirectory)).filter((name) => name.endsWith('.json')).map(async (name) => {
    const dictionary = JSON.parse(await readFile(new URL(name, localeDirectory), 'utf8'))
    return Buffer.byteLength(JSON.stringify(dictionary))
  }),
)).reduce((sum, value) => sum + value, 0)

test('ships a minified client bundle with the expected module contract', () => {
  let registration = null
  vm.runInNewContext(bundle, {
    window: { __ModuleLoader__: { load(value) { registration = value } } },
  })
  assert.ok(registration)
  assert.equal(registration.id, 'dsh-all-usage')
  assert.equal(typeof registration.factory, 'function')

  const React = { memo: (component) => component, Component: class {} }
  // The bundle may require react-dom for the usage sheet's portal (issue #4) and
  // nothing else. A host without react-dom still has to load the plugin, so that
  // module is required defensively — and every id the factory asks for is
  // recorded here, so an accidental extra dependency fails this test.
  const required = []
  const client = registration.factory((id) => {
    required.push(id)
    if (id === 'react') return React
    if (id === 'react-dom') return { createPortal: (element) => element }
    throw new Error('unexpected client module: ' + id)
  })
  assert.deepEqual(required, ['react', 'react-dom'], 'the client half requires react plus the optional portal module')
  assert.deepEqual(Array.from(client.inject), ['timer', 'slots'])
  assert.equal(typeof client.apply, 'function')
  assert.equal(embeddedIconBytes, 0, 'artwork must be served by the host, not embedded')
  assert.ok((bundle.match(/\/api\/all-usage\/icon\?key=/g) || []).length > 0, 'the bundle must reference the host icon route')
  // A stale lib/client.js would otherwise ship a trend chart without the bar view.
  assert.ok(bundle.includes('uh-trend-bar'), 'the built bundle must carry the bar marks')
  assert.ok(bundle.includes('uh-gh'), 'the built bundle must carry the GitHub star button')
  assert.ok(localeBytes > 100000, 'the six dictionaries are inlined, so they must weigh something')
  assert.ok(Buffer.byteLength(bundle) - embeddedIconBytes - localeBytes < Buffer.byteLength(source) * 0.7, 'everything the bundle adds beyond the dictionaries must be minified')
  assert.ok(bundle.includes('"{count} models"'), 'the bundle must carry the translated dictionaries, not their keys only')
})
