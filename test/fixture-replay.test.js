import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { runFixture } from '../scripts/replay-fixture.mjs'

const fixturePath = fileURLToPath(new URL('../fixtures/usage-events.json', import.meta.url))

test('replays the redacted usage fixture with its documented totals', async () => {
  const fixture = JSON.parse(await readFile(fixturePath, 'utf8'))
  const result = await runFixture(fixture)
  assert.equal(result.fixture, 'redacted-usage-fixture')
  assert.equal(result.records, fixture.expected.records)
  assert.equal(result.totals.input, fixture.expected.totals.input)
  assert.equal(result.totals.output, fixture.expected.totals.output)
  assert.equal(result.totals.cacheRead, fixture.expected.totals.cacheRead)
  assert.equal(result.totals.cacheWrite, fixture.expected.totals.cacheWrite)
  assert.equal(result.totals.reasoning, fixture.expected.totals.reasoning)
})
