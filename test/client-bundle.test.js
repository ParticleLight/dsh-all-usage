import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')
const bundle = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
// Brand artwork is served by the host on demand, so the bundle only carries the
// resolution metadata (one URL per brand). Nothing to exclude from the ratio.
const embeddedIconBytes = (bundle.match(/data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+/g) || []).reduce((sum, value) => sum + Buffer.byteLength(value), 0)

test('ships a minified client bundle with the expected module contract', () => {
  let registration = null
  vm.runInNewContext(bundle, {
    window: { __ModuleLoader__: { load(value) { registration = value } } },
  })
  assert.ok(registration)
  assert.equal(registration.id, 'dsh-all-usage')
  assert.equal(typeof registration.factory, 'function')

  const React = { memo: (component) => component, Component: class {} }
  const client = registration.factory((id) => {
    assert.equal(id, 'react')
    return React
  })
  assert.deepEqual(Array.from(client.inject), ['timer', 'slots'])
  assert.equal(typeof client.apply, 'function')
  assert.equal(embeddedIconBytes, 0, 'artwork must be served by the host, not embedded')
  assert.ok((bundle.match(/\/api\/all-usage\/icon\?key=/g) || []).length > 0, 'the bundle must reference the host icon route')
  assert.ok(Buffer.byteLength(bundle) - embeddedIconBytes < Buffer.byteLength(source) * 0.7)
})
