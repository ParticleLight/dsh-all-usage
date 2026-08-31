import assert from 'node:assert/strict'
import test from 'node:test'
import {
  addCostAggregate,
  calculateCost,
  decimalAdd,
  emptyCostAggregate,
} from '../lib/pricing.js'
import {
  extractUsageEvent,
  upsertUsageSample,
  usageStepKey,
} from '../lib/usage-core.js'

const FUZZ_SEED = 0x5eed
const requestedRounds = Number(process.env.DSH_FUZZ_ROUNDS)
const FUZZ_ROUNDS = Number.isInteger(requestedRounds) && requestedRounds >= 100 && requestedRounds <= 1000 ? requestedRounds : 256
const TOKEN_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning']

function createSeededRng(seed) {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x100000000
  }
}

function randInt(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1))
}

function usageFor(rng, scale = 1) {
  return {
    inputTokens: randInt(rng, 1, 90) * scale,
    outputTokens: randInt(rng, 1, 90) * scale,
    cacheReadTokens: randInt(rng, 0, 60) * scale,
    cacheWriteTokens: randInt(rng, 0, 40) * scale,
    reasoningTokens: randInt(rng, 0, 30) * scale,
  }
}

function chunkEvent(time, turn, step, usage, seq) {
  return { seq, time, type: 'assistant/chunk', data: { turn, step, chunk: { type: 'usage', usage } } }
}

function messageEvent(time, turn, step, usage, seq) {
  return { seq, time, type: 'assistant/message', data: { turn, step, message: { source: { provider: 'deepseek', model: 'deepseek-chat' } }, usage } }
}

function buildScenario(rng, round) {
  const events = []
  const baseTime = Date.UTC(2024, 0, 1) + round * 24 * 60 * 60 * 1000
  const sessionCount = randInt(rng, 1, 5)
  let hasReplacement = false
  for (let sessionIndex = 0; sessionIndex < sessionCount; sessionIndex += 1) {
    const sid = 's-' + sessionIndex
    const turns = randInt(rng, 1, 3)
    let seq = 0
    for (let turn = 1; turn <= turns; turn += 1) {
      const steps = randInt(rng, 1, 5)
      for (let step = 1; step <= steps; step += 1) {
        const time = baseTime + sessionIndex * 100000 + turn * 1000 + step
        const firstUsage = usageFor(rng, 1)
        events.push({ sid, event: chunkEvent(time, turn, step, firstUsage, seq) })
        seq += 1
        const shouldFinalize = sessionIndex === 0 && turn === 1 && step === 1 || rng() < 0.78
        if (shouldFinalize) {
          const finalUsage = usageFor(rng, 2)
          events.push({ sid, event: messageEvent(time + 1, turn, step, finalUsage, seq) })
          seq += 1
          hasReplacement = true
        }
        if (rng() < 0.22) {
          const retryUsage = usageFor(rng, 3)
          events.push({ sid, event: messageEvent(time + 2, turn, step, retryUsage, seq) })
          seq += 1
          hasReplacement = true
        }
      }
    }
  }
  const malformed = [
    { sid: 's-invalid', event: { seq: 0, time: Number.NaN, type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 99 } } } } },
    { sid: 's-invalid', event: { seq: 1, time: baseTime, type: 'assistant/chunk', data: { turn: 1, chunk: { type: 'usage', usage: { inputTokens: 99 } } } } },
    { sid: 's-invalid', event: { seq: 2, time: baseTime, type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'delta', usage: { inputTokens: 99 } } } } },
    { sid: 's-invalid', event: { seq: 3, time: baseTime, type: 'assistant/message', data: { turn: 1, step: 1, usage: null } } },
    { sid: 's-invalid', event: { seq: 4, time: baseTime, type: 'assistant/message', data: { turn: 1, step: 1, usage: { inputTokens: 'not-a-number' } } } },
  ]
  events.push(...malformed)

  const duplicateCandidates = events.filter(({ event }) => extractUsageEvent(event) !== null)
  for (const candidate of duplicateCandidates) {
    if (rng() < 0.6) events.push({ sid: candidate.sid, event: structuredClone(candidate.event) })
  }
  return { events, hasReplacement }
}

function sampleFrom(sid, event) {
  const extracted = extractUsageEvent(event)
  if (extracted === null) return null
  return {
    key: usageStepKey(sid, event.data, event.seq),
    seq: typeof event.seq === 'number' && Number.isFinite(event.seq) ? event.seq : -1,
    sid,
    turn: extracted.turn,
    step: extracted.step,
    kind: extracted.kind,
    values: extracted.values,
  }
}

function foldWithSharedUpsert(events) {
  const samples = new Map()
  for (const { sid, event } of events) {
    const sample = sampleFrom(sid, event)
    if (sample !== null) upsertUsageSample(samples, sample)
  }
  return samples
}

function foldOracle(events) {
  const samples = new Map()
  for (const { sid, event } of events) {
    const extracted = extractUsageEvent(event)
    if (extracted === null) continue
    const key = usageStepKey(sid, event.data, event.seq)
    const seq = typeof event.seq === 'number' && Number.isFinite(event.seq) ? event.seq : -1
    const previous = samples.get(key)
    if (previous !== undefined && seq >= 0 && previous.seq > seq) continue
    samples.set(key, { key, seq, sid, turn: extracted.turn, step: extracted.step, kind: extracted.kind, values: extracted.values })
  }
  return samples
}

function projectSamples(samples) {
  return Array.from(samples.values())
    .sort((left, right) => left.key.localeCompare(right.key))
    .map((sample) => ({ key: sample.key, seq: sample.seq, sid: sample.sid, turn: sample.turn, step: sample.step, kind: sample.kind, values: sample.values }))
}

function sumValues(samples) {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
  for (const sample of samples.values()) for (const key of TOKEN_KEYS) totals[key] += sample.values[key]
  return totals
}

function costAggregateFor(samples) {
  const resolved = {
    status: 'priced',
    currency: 'USD',
    source: 'fuzz',
    pricingModel: 'fuzz-model',
    inputTokenSemantics: 'fresh',
    multiplier: '1.37',
    rates: { input: '0.13', output: '0.27', cacheRead: '0.031', cacheWrite: '0.007' },
  }
  const aggregate = emptyCostAggregate()
  const expected = emptyCostAggregate()
  for (const sample of samples.values()) {
    const cost = calculateCost(sample.values, resolved)
    addCostAggregate(aggregate, cost)
    expected.input = decimalAdd(expected.input, cost.breakdown.input)
    expected.output = decimalAdd(expected.output, cost.breakdown.output)
    expected.cacheRead = decimalAdd(expected.cacheRead, cost.breakdown.cacheRead)
    expected.cacheWrite = decimalAdd(expected.cacheWrite, cost.breakdown.cacheWrite)
    expected.baseTotal = decimalAdd(expected.baseTotal, cost.baseTotal)
    expected.total = decimalAdd(expected.total, cost.total)
    expected.pricedCalls += 1
  }
  return { aggregate, expected }
}

test('accepts official chunk/message usage shapes and rejects incomplete events', () => {
  const time = Date.UTC(2024, 0, 1)
  const chunk = chunkEvent(time, 1, 1, { inputTokens: 10, outputTokens: 20 }, 1)
  const message = messageEvent(time, 1, 1, { inputTokens: 30, outputTokens: 40 }, 2)
  assert.equal(extractUsageEvent(chunk).kind, 'chunk')
  assert.equal(extractUsageEvent(message).kind, 'message')
  assert.equal(extractUsageEvent({ ...chunk, time: Number.NaN }), null)
  assert.equal(extractUsageEvent({ ...chunk, data: { turn: 1, chunk: chunk.data.chunk } }), null)
  assert.equal(extractUsageEvent({ ...chunk, data: { turn: 1, step: 1, chunk: { type: 'delta', usage: chunk.data.chunk.usage } } }), null)
  assert.equal(extractUsageEvent({ ...message, data: { turn: 1, step: 1, usage: null } }), null)
})

test('holds aggregation invariants across deterministic usage event fuzzing', () => {
  const rng = createSeededRng(FUZZ_SEED)
  for (let round = 0; round < FUZZ_ROUNDS; round += 1) {
    try {
      const scenario = buildScenario(rng, round)
      const events = scenario.events
      const oracle = foldOracle(events)
      const full = foldWithSharedUpsert(events)
      const split = randInt(rng, 0, events.length)
      const incremental = foldWithSharedUpsert(events.slice(0, split))
      for (const entry of events.slice(split)) {
        const sample = sampleFrom(entry.sid, entry.event)
        if (sample !== null) upsertUsageSample(incremental, sample)
      }
      const flushReload = foldWithSharedUpsert(events.slice().reverse())
      const replay = foldWithSharedUpsert(events.concat(events.slice().reverse()))

      assert.deepEqual(projectSamples(full), projectSamples(oracle), 'full fold must match independent oracle')
      assert.deepEqual(projectSamples(incremental), projectSamples(full), 'full scan must equal incremental scan')
      assert.deepEqual(projectSamples(flushReload), projectSamples(full), 'full scan must equal flush/reload fold')
      assert.deepEqual(projectSamples(replay), projectSamples(full), 'repeated events must be idempotent')
      assert.equal(scenario.hasReplacement, true)

      const totals = sumValues(full)
      const oracleTotals = sumValues(oracle)
      assert.deepEqual(totals, oracleTotals)
      const processedFromSamples = Array.from(oracle.values()).reduce((sum, sample) => sum + TOKEN_KEYS.reduce((sampleTotal, key) => sampleTotal + sample.values[key], 0), 0)
      assert.equal(totals.input + totals.output + totals.cacheRead + totals.cacheWrite + totals.reasoning, processedFromSamples)
      assert.equal(totals.output, Array.from(oracle.values()).reduce((sum, sample) => sum + sample.values.output, 0), 'reasoning must remain separate from output')

      const costs = costAggregateFor(full)
      assert.deepEqual(costs.aggregate, costs.expected, 'decimal cost aggregate must not drift')
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error('deterministic fuzz failed: seed=' + FUZZ_SEED + ' round=' + round + ' of ' + FUZZ_ROUNDS + ': ' + detail, { cause: error })
    }
  }
})
