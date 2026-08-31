const TOKEN_FIELDS = Object.freeze({
  input: 'inputTokens',
  output: 'outputTokens',
  cacheRead: 'cacheReadTokens',
  cacheWrite: 'cacheWriteTokens',
  reasoning: 'reasoningTokens',
})

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function tokenValue(source, field) {
  const value = source[TOKEN_FIELDS[field]] !== undefined ? source[TOKEN_FIELDS[field]] : source[field]
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

export function normalizeUsageValues(usage) {
  if (!isRecord(usage)) return null
  return {
    input: tokenValue(usage, 'input'),
    output: tokenValue(usage, 'output'),
    cacheRead: tokenValue(usage, 'cacheRead'),
    cacheWrite: tokenValue(usage, 'cacheWrite'),
    reasoning: tokenValue(usage, 'reasoning'),
  }
}

export function hasUsageValues(values) {
  return values !== null && values !== undefined && (values.input > 0 || values.output > 0 || values.cacheRead > 0 || values.cacheWrite > 0 || values.reasoning > 0)
}

function stepIndex(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

/** Extract the provider usage carried by one supported DSH event shape. */
export function extractUsageEvent(event) {
  if (!isRecord(event) || !isRecord(event.data) || typeof event.time !== 'number' || !Number.isFinite(event.time)) return null
  const data = event.data
  let kind
  let usage
  if (event.type === 'assistant/chunk') {
    if (!isRecord(data.chunk) || data.chunk.type !== 'usage') return null
    kind = 'chunk'
    usage = data.chunk.usage
  } else if (event.type === 'assistant/message') {
    if (!Object.hasOwn(data, 'usage') || data.usage === undefined) return null
    kind = 'message'
    usage = data.usage
  } else {
    return null
  }
  const values = normalizeUsageValues(usage)
  if (!hasUsageValues(values)) return null
  const turn = stepIndex(data.turn)
  const step = stepIndex(data.step)
  if (turn === null || step === null) return null
  return { kind, data, usage, values, turn, step }
}

function stableJson(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value)
  if (value === undefined) return 'null'
  if (typeof value !== 'object') return JSON.stringify(String(value))
  if (ancestors.has(value)) return '"[Circular]"'
  ancestors.add(value)
  let result
  if (Array.isArray(value)) {
    result = '[' + value.map((item) => stableJson(item, ancestors)).join(',') + ']'
  } else {
    result = '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stableJson(value[key], ancestors)).join(',') + '}'
  }
  ancestors.delete(value)
  return result
}

function stableIdentity(value) {
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

/** Build a stable logical usage key across live, scan, and flush materializations. */
export function usageStepKey(sid, data, seq, fallback) {
  const safeSid = typeof sid === 'string' ? sid : String(sid === undefined || sid === null ? '' : sid)
  const turn = stepIndex(data && data.turn)
  const step = stepIndex(data && data.step)
  if (turn !== null && step !== null) return safeSid + ':step:' + turn + ':' + step
  const message = data && isRecord(data.message) ? data.message : null
  const logicalId = [
    data && data.usageId,
    data && data.sampleId,
    data && data.requestId,
    data && data.callId,
    data && data.stepId,
    data && data.messageId,
    message && message.id,
  ].map(stableIdentity).find((value) => value !== null)
  if (logicalId !== undefined) return safeSid + ':logical:' + logicalId
  if (typeof seq === 'number' && Number.isFinite(seq)) return safeSid + ':event:' + seq
  const serialized = stableJson(isRecord(data) ? data : {})
  return safeSid + ':event:' + (serialized === undefined ? String(fallback === undefined ? '' : fallback) : serialized)
}

/** Replace one logical sample; stale lower-seq replays are ignored. */
export function upsertUsageSample(samples, sample) {
  if (!(samples instanceof Map) || !isRecord(sample) || typeof sample.key !== 'string' || sample.key === '') return { accepted: false, reason: 'invalid-sample', previous: undefined, next: undefined }
  const previous = samples.get(sample.key)
  const seq = typeof sample.seq === 'number' && Number.isFinite(sample.seq) ? sample.seq : -1
  const previousSeq = previous !== undefined && typeof previous.seq === 'number' && Number.isFinite(previous.seq) ? previous.seq : -1
  if (previous !== undefined && seq >= 0 && previousSeq > seq) return { accepted: false, reason: 'stale-sample', key: sample.key, previous, next: previous }
  const next = { ...sample, seq }
  samples.set(sample.key, next)
  return { accepted: true, replaced: previous !== undefined, key: sample.key, previous, next }
}

export { TOKEN_FIELDS }
