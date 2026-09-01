import test from 'node:test'
import assert from 'node:assert/strict'
import { upsertUsageSample, normalizeEventSeq } from '../lib/usage-core.js'

test('normalizes event sequences instead of accepting unsafe finite numbers', () => {
  assert.equal(normalizeEventSeq(2), 2)
  assert.equal(normalizeEventSeq(0), 0)
  assert.equal(normalizeEventSeq(-1), -1)
  assert.equal(normalizeEventSeq(-2), -1)
  assert.equal(normalizeEventSeq(Number.MAX_SAFE_INTEGER + 1), -1)
  assert.equal(normalizeEventSeq(Number.POSITIVE_INFINITY), -1)
  assert.equal(normalizeEventSeq(Number.NaN), -1)
})

test('a legal replay replaces a merely unsafe-sequence sample', () => {
  const samples = new Map()
  const first = upsertUsageSample(samples, { key: 's:logical:u1', seq: Number.MAX_SAFE_INTEGER + 1, values: { input: 10 } })
  assert.equal(first.accepted, true)
  const second = upsertUsageSample(samples, { key: 's:logical:u1', seq: 2, values: { input: 20 } })
  assert.equal(second.accepted, true)
  assert.equal(samples.get('s:logical:u1').seq, 2)
  assert.equal(samples.get('s:logical:u1').values.input, 20)
})
