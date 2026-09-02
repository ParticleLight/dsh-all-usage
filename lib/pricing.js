import { createHash } from 'node:crypto'

const PRICING_SCHEMA_VERSION = 1
const COST_SCHEMA_VERSION = 2
const MODEL_CATALOG_URL = 'https://models.dev/api.json'
const DEFAULT_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000
const MAX_CATALOG_BYTES = 24 * 1024 * 1024
const MAX_PRICE_ENTRIES = 10000
// Hard candidate ceiling before the sorting-heavy selection: a pathological
// upstream catalog is rejected instead of consuming unbounded memory.
// Hard candidate ceiling before any normalization-heavy sort: a pathological
// upstream catalog is rejected instead of consuming unbounded memory.
const MAX_CATALOG_CANDIDATES = 30000
const MAX_OVERRIDES = 500
const MAX_MAPPINGS = 500
const MAX_CONTEXT_TIERS = 32
const MAX_TEMPORAL_RULES = 16
const MAX_TEMPORAL_WINDOWS = 16
const TEMPORAL_TIMEZONE = 'UTC'
const TEMPORAL_TIME_SOURCES = ['request-context', 'usage-event', 'legacy-unknown']
const RATE_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite']
const INPUT_SEMANTICS = ['legacy', 'total', 'fresh']
const COST_STATUSES = ['priced', 'unpriced', 'ambiguous', 'unsupported']
const COST_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'baseTotal', 'total']
const COST_ACCUMULATOR = Symbol('costAccumulator')
const COST_PARTS_CACHE = new WeakMap()
const OFFICIAL_PROVIDER_RULES = [
  { providers: ['openai'], prefixes: ['gpt-', 'o1', 'o3', 'o4', 'o5'] },
  { providers: ['anthropic'], prefixes: ['claude-'] },
  { providers: ['google'], prefixes: ['gemini-', 'gemma-'] },
  { providers: ['xai'], prefixes: ['grok-'] },
  { providers: ['deepseek'], prefixes: ['deepseek-'] },
  { providers: ['moonshotai', 'moonshot'], prefixes: ['kimi-', 'moonshot-'] },
  { providers: ['qwen', 'alibaba'], prefixes: ['qwen'] },
  { providers: ['zai', 'zhipuai', 'zhipu'], prefixes: ['glm-', 'chatglm-'] },
  { providers: ['minimax'], prefixes: ['minimax-'] },
  { providers: ['mistral'], prefixes: ['mistral-', 'mixtral-'] },
  { providers: ['meta'], prefixes: ['llama-', 'meta-llama'] },
  { providers: ['cohere'], prefixes: ['command-'] },
  { providers: ['ai21'], prefixes: ['jamba-'] },
  { providers: ['baidu'], prefixes: ['ernie-'] },
]
const MAX_DECIMAL_DIGITS = 40
const MAX_DECIMAL_EXPONENT = 24

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function finiteNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function decimalParts(value) {
  const raw = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim().toLowerCase() : ''
  const match = raw.match(/^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/)
  if (!match) return null
  let digits = (match[1] || '') + (match[2] || '')
  const exponent = match[3] ? Number(match[3]) : 0
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > MAX_DECIMAL_EXPONENT) return null
  let scale = (match[2] || '').length - exponent
  digits = digits.replace(/^0+(?=\d)/, '')
  if (scale < 0) {
    digits += '0'.repeat(-scale)
    scale = 0
  }
  if (scale > digits.length) digits = '0'.repeat(scale - digits.length + 1) + digits
  if (digits.length > MAX_DECIMAL_DIGITS) return null
  while (scale > 0 && digits.length > 1 && digits.endsWith('0')) {
    digits = digits.slice(0, -1)
    scale -= 1
  }
  digits = digits.replace(/^0+(?=\d)/, '')
  return { digits: BigInt(digits || '0'), scale }
}

function decimalText(value) {
  const parts = decimalParts(value)
  if (parts === null) return null
  if (parts.digits === 0n) return '0'
  const raw = parts.digits.toString()
  if (parts.scale === 0) return raw
  const padded = raw.padStart(parts.scale + 1, '0')
  const split = padded.length - parts.scale
  return padded.slice(0, split) + '.' + padded.slice(split)
}

function normalizedDecimalParts(parts) {
  let digits = parts && typeof parts.digits === 'bigint' ? parts.digits : 0n
  let scale = parts && Number.isSafeInteger(parts.scale) && parts.scale >= 0 ? parts.scale : 0
  if (digits < 0n) digits = 0n
  while (scale > 0 && digits !== 0n && digits % 10n === 0n) {
    digits /= 10n
    scale -= 1
  }
  return { digits, scale }
}

function decimalAccumulatorText(value) {
  const parts = normalizedDecimalParts(value)
  if (parts.digits === 0n) return '0'
  const raw = parts.digits.toString()
  if (parts.scale === 0) return raw
  const padded = raw.padStart(parts.scale + 1, '0')
  const split = padded.length - parts.scale
  return padded.slice(0, split) + '.' + padded.slice(split)
}

function isCostAccumulator(value) {
  return value !== null && typeof value === 'object' && value[COST_ACCUMULATOR] === true
}

function createCostAccumulator(currency = 'USD') {
  const result = { currency, input: { digits: 0n, scale: 0 }, output: { digits: 0n, scale: 0 }, cacheRead: { digits: 0n, scale: 0 }, cacheWrite: { digits: 0n, scale: 0 }, baseTotal: { digits: 0n, scale: 0 }, total: { digits: 0n, scale: 0 }, pricedCalls: 0, unpricedCalls: 0, ambiguousCalls: 0, unsupportedCalls: 0 }
  Object.defineProperty(result, COST_ACCUMULATOR, { value: true })
  return result
}

function costAccumulatorParts(cost) {
  if (isCostAccumulator(cost)) return cost
  if (cost !== null && typeof cost === 'object') {
    const cached = COST_PARTS_CACHE.get(cost)
    if (cached !== undefined) return cached
  }
  const value = isRecord(cost) ? cost : {}
  const status = COST_STATUSES.includes(value.status) ? value.status : 'unpriced'
  const breakdown = isRecord(value.breakdown) ? value.breakdown : {}
  const result = {
    currency: typeof value.currency === 'string' && value.currency !== '' ? value.currency : 'USD',
    status,
    input: decimalParts(breakdown.input) || { digits: 0n, scale: 0 },
    output: decimalParts(breakdown.output) || { digits: 0n, scale: 0 },
    cacheRead: decimalParts(breakdown.cacheRead) || { digits: 0n, scale: 0 },
    cacheWrite: decimalParts(breakdown.cacheWrite) || { digits: 0n, scale: 0 },
    baseTotal: decimalParts(value.baseTotal) || { digits: 0n, scale: 0 },
    total: decimalParts(value.total) || { digits: 0n, scale: 0 },
  }
  if (cost !== null && typeof cost === 'object') COST_PARTS_CACHE.set(cost, result)
  return result
}

function addDecimalAccumulator(target, field, value, direction) {
  const left = normalizedDecimalParts(target[field])
  const right = normalizedDecimalParts(value)
  const scale = Math.max(left.scale, right.scale)
  let digits = left.digits * 10n ** BigInt(scale - left.scale) + BigInt(direction) * right.digits * 10n ** BigInt(scale - right.scale)
  if (digits < 0n) digits = 0n
  target[field] = normalizedDecimalParts({ digits, scale })
}

function addCostAccumulator(target, cost, direction = 1) {
  if (!isCostAccumulator(target)) return target
  if (isCostAccumulator(cost)) {
    for (const field of COST_FIELDS) addDecimalAccumulator(target, field, cost[field], direction)
    target.pricedCalls = Math.max(0, target.pricedCalls + direction * cost.pricedCalls)
    target.unpricedCalls = Math.max(0, target.unpricedCalls + direction * cost.unpricedCalls)
    target.ambiguousCalls = Math.max(0, target.ambiguousCalls + direction * cost.ambiguousCalls)
    target.unsupportedCalls = Math.max(0, target.unsupportedCalls + direction * cost.unsupportedCalls)
    return target
  }
  const value = costAccumulatorParts(cost)
  if (value.status === 'priced') {
    for (const field of COST_FIELDS) addDecimalAccumulator(target, field, value[field], direction)
    target.pricedCalls = Math.max(0, target.pricedCalls + direction)
  } else if (value.status === 'ambiguous') target.ambiguousCalls = Math.max(0, target.ambiguousCalls + direction)
  else if (value.status === 'unsupported') target.unsupportedCalls = Math.max(0, target.unsupportedCalls + direction)
  else target.unpricedCalls = Math.max(0, target.unpricedCalls + direction)
  return target
}

function decimalAdd(left, right) {
  const a = decimalParts(left) || { digits: 0n, scale: 0 }
  const b = decimalParts(right) || { digits: 0n, scale: 0 }
  const scale = Math.max(a.scale, b.scale)
  const value = a.digits * 10n ** BigInt(scale - a.scale) + b.digits * 10n ** BigInt(scale - b.scale)
  return decimalText(value.toString() + (scale > 0 ? 'e-' + scale : '')) || '0'
}

function decimalMultiply(left, right) {
  const a = decimalParts(left) || { digits: 0n, scale: 0 }
  const b = decimalParts(right) || { digits: 0n, scale: 0 }
  return decimalText((a.digits * b.digits).toString() + ((a.scale + b.scale) > 0 ? 'e-' + (a.scale + b.scale) : '')) || '0'
}

function decimalSubtract(left, right) {
  const a = decimalParts(left) || { digits: 0n, scale: 0 }
  const b = decimalParts(right) || { digits: 0n, scale: 0 }
  const scale = Math.max(a.scale, b.scale)
  const value = a.digits * 10n ** BigInt(scale - a.scale) - b.digits * 10n ** BigInt(scale - b.scale)
  if (value <= 0n) return '0'
  return decimalText(value.toString() + (scale > 0 ? 'e-' + scale : '')) || '0'
}

function decimalGreaterThanZero(value) {
  const parts = decimalParts(value)
  return parts !== null && parts.digits > 0n
}

function nonNegativeDecimal(value, fallback = '0') {
  const parsed = decimalText(value)
  if (parsed === null || !decimalParts(parsed) || decimalParts(parsed).digits < 0n) return fallback
  return parsed
}

function normalizeModelId(value) {
  if (typeof value !== 'string') return ''
  let normalized = value.trim()
  const slash = normalized.lastIndexOf('/')
  if (slash >= 0) normalized = normalized.slice(slash + 1)
  normalized = normalized.split(':', 1)[0].trim().replace(/@/g, '-').toLowerCase()
  normalized = normalized.replace(/\[1m\]$/i, '').trim()
  return normalized
}

function pushUnique(list, value) {
  if (typeof value === 'string' && value !== '' && !list.includes(value)) list.push(value)
}

function stripKnownNamespace(value) {
  const claude = value.lastIndexOf('claude-')
  if (claude > 0) return value.slice(claude)
  for (const marker of ['openai.', 'anthropic.', 'google.', 'moonshot.', 'moonshotai.', 'bedrock.', 'global.']) {
    if (value.startsWith(marker)) return value.slice(marker.length)
  }
  return null
}

function stripClaudeDesktopPrefix(value) {
  const markers = ['abab', 'ark-code', 'arctic', 'astron', 'codex', 'command-r', 'deepseek', 'doubao', 'ernie', 'gemini', 'gemma', 'glm', 'gpt', 'grok', 'hermes', 'hy3', 'hunyuan', 'jamba', 'kimi', 'lfm', 'llama', 'longcat', 'mercury', 'mimo', 'minimax', 'mistral', 'mixtral', 'moonshot', 'nemotron', 'nova-', 'openai', 'qianfan', 'qwen', 'seed-', 'solar', 'stepfun']
  if (!value.startsWith('claude-')) return null
  const rest = value.slice('claude-'.length)
  return markers.some((marker) => rest.startsWith(marker)) ? rest : null
}

function stripBedrockSuffix(value) {
  const match = value.match(/^(.+)-v(\d+)$/)
  return match ? match[1] : null
}

function stripDateSuffix(value) {
  let match = value.match(/^(.+)-(\d{4}-\d{2}-\d{2})$/)
  if (match) return match[1]
  match = value.match(/^(.+)-(\d{8})$/)
  if (match) return match[1]
  match = value.match(/^(.+)-(\d{6})$/)
  if (!match) return null
  const month = Number(match[2].slice(2, 4))
  const day = Number(match[2].slice(4, 6))
  return month >= 1 && month <= 12 && day >= 1 && day <= 31 ? match[1] : null
}

function stripReasoningSuffix(value) {
  for (const suffix of ['-minimal', '-low', '-medium', '-high', '-xhigh']) {
    if (value.endsWith(suffix) && value.length > suffix.length) return value.slice(0, -suffix.length)
  }
  return null
}

function shouldTryPrefix(value) {
  const dashCount = (value.match(/-/g) || []).length
  if (value.startsWith('claude-')) return dashCount >= 3
  if (['o1', 'o3', 'o4', 'o5'].some((prefix) => value.startsWith(prefix))) return dashCount >= 1
  return ['gpt-', 'gemini-', 'deepseek-', 'qwen-', 'glm-', 'kimi-', 'minimax-'].some((prefix) => value.startsWith(prefix)) && dashCount >= 2
}

function modelPricingCandidates(value) {
  const cleaned = normalizeModelId(value)
  if (cleaned === '') return []
  const candidates = []
  const queue = [cleaned]
  while (queue.length > 0) {
    const candidate = queue.pop()
    if (candidates.includes(candidate)) continue
    pushUnique(candidates, candidate)
    for (const next of [stripKnownNamespace(candidate), stripClaudeDesktopPrefix(candidate), stripBedrockSuffix(candidate), stripDateSuffix(candidate), stripReasoningSuffix(candidate)]) {
      if (next !== null) queue.push(next)
    }
    if (candidate.startsWith('claude-') && candidate.includes('.')) queue.push(candidate.replace(/\./g, '-'))
  }
  return candidates
}

function normalizeProvider(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function officialProviderIds(modelId) {
  const providers = new Set()
  for (const candidate of modelPricingCandidates(modelId)) {
    for (const rule of OFFICIAL_PROVIDER_RULES) if (rule.prefixes.some((prefix) => candidate.startsWith(prefix))) for (const provider of rule.providers) providers.add(provider)
  }
  return providers
}

function identityModels(identity) {
  const value = isRecord(identity) ? identity : {}
  const result = []
  for (const candidate of [value.actualModel, value.requestedModel, value.model, value.label]) {
    const normalized = normalizeModelId(candidate)
    if (normalized !== '' && !result.includes(normalized)) result.push(normalized)
  }
  return result
}

function identityKeyOf(identity) {
  if (!isRecord(identity)) return ''
  const key = typeof identity.identityKey === 'string' && identity.identityKey.trim() !== '' ? identity.identityKey : identity.usageIdentityKey
  return typeof key === 'string' ? key.trim() : ''
}

function priceEntryKey(entry) {
  return normalizeProvider(entry.providerId) + '\0' + normalizeModelId(entry.modelId)
}

function decimalRate(raw, keys, fallback = undefined) {
  let value
  for (const key of keys) {
    if (raw && raw[key] !== undefined) {
      value = raw[key]
      break
    }
  }
  if (value === undefined || value === null || value === '') value = fallback
  return decimalText(value)
}

function temporalRatesOf(raw, fallback) {
  const rates = isRecord(raw) ? raw : {}
  const input = decimalRate(rates, ['input', 'inputPerMillion'], fallback && fallback.input)
  const output = decimalRate(rates, ['output', 'outputPerMillion'], fallback && fallback.output)
  const cacheRead = decimalRate(rates, ['cacheRead', 'cache_read', 'cacheReadPerMillion'], fallback && fallback.cacheRead)
  const cacheWrite = decimalRate(rates, ['cacheWrite', 'cache_write', 'cacheCreation', 'cacheWritePerMillion'], fallback && fallback.cacheWrite)
  if (input === null || output === null || cacheRead === null || cacheWrite === null) return null
  const parts = [decimalParts(input), decimalParts(output), decimalParts(cacheRead), decimalParts(cacheWrite)]
  if (parts.some((entry) => entry === null || entry.digits < 0n)) return null
  return { input, output, cacheRead, cacheWrite }
}

function normalizeTemporalWindows(raw) {
  if (!Array.isArray(raw)) return null
  const windows = []
  for (const candidate of raw.slice(0, MAX_TEMPORAL_WINDOWS)) {
    if (!isRecord(candidate)) return null
    const startMinute = finiteNumber(candidate.startMinute)
    const endMinute = finiteNumber(candidate.endMinute)
    if (startMinute === null || endMinute === null || !Number.isInteger(startMinute) || !Number.isInteger(endMinute) || startMinute < 0 || startMinute >= 1440 || endMinute <= startMinute || endMinute > 1440) return null
    windows.push({ startMinute, endMinute })
  }
  if (windows.length === 0) return null
  // Half-open [start, end) windows that overlap would make the band ambiguous;
  // deterministic order plus adjacency-only constraint keeps selection stable.
  windows.sort((left, right) => left.startMinute - right.startMinute || left.endMinute - right.endMinute)
  for (let index = 1; index < windows.length; index += 1) {
    if (windows[index].startMinute < windows[index - 1].endMinute) return null
  }
  return windows
}

/** Temporal pricing plan: versioned, effective-windowed, UTC-band rules. */
function normalizeTemporalPricing(raw, entryDefaultRates = undefined) {
  if (!isRecord(raw)) return null
  const policyId = typeof raw.policyId === 'string' && raw.policyId.trim() !== '' ? raw.policyId.trim().slice(0, 128) : ''
  if (policyId === '') return null
  const sourceUrl = typeof raw.sourceUrl === 'string' && raw.sourceUrl.trim() !== '' ? raw.sourceUrl.trim().slice(0, 512) : ''
  const timezone = typeof raw.timezone === 'string' && raw.timezone.trim() !== '' ? raw.timezone.trim().toUpperCase() : TEMPORAL_TIMEZONE
  // DeepSeek peak/off-peak windows are defined in UTC; any other timezone is
  // rejected outright so band selection can never depend on the viewer's clock.
  if (timezone !== TEMPORAL_TIMEZONE) return null
  const effectiveFrom = raw.effectiveFrom === undefined || raw.effectiveFrom === null ? 0 : finiteNumber(raw.effectiveFrom)
  const effectiveUntil = raw.effectiveUntil === undefined || raw.effectiveUntil === null ? null : finiteNumber(raw.effectiveUntil)
  if (effectiveFrom === null || !Number.isSafeInteger(effectiveFrom) || effectiveFrom < 0) return null
  if (effectiveUntil !== null && (!Number.isSafeInteger(effectiveUntil) || effectiveUntil <= effectiveFrom)) return null
  let defaultPlan = null
  if (raw.defaultPlan !== undefined && raw.defaultPlan !== null) {
    if (!isRecord(raw.defaultPlan)) return null
    const rates = temporalRatesOf(raw.defaultPlan.rates || raw.defaultPlan, entryDefaultRates)
    if (rates === null) return null
    defaultPlan = { id: typeof raw.defaultPlan.id === 'string' && raw.defaultPlan.id.trim() !== '' ? raw.defaultPlan.id.trim().slice(0, 64) : 'default', rates }
  }
  if (raw.rules !== undefined && !Array.isArray(raw.rules)) return null
  if (!Array.isArray(raw.rules)) return null
  if (raw.rules.length > MAX_TEMPORAL_RULES) return null
  const rules = []
  for (const rawRule of raw.rules) {
    if (!isRecord(rawRule)) return null
    const id = typeof rawRule.id === 'string' && rawRule.id.trim() !== '' ? rawRule.id.trim().slice(0, 64) : ''
    if (id === '') return null
    const weekdays = Array.from(new Set((Array.isArray(rawRule.weekdays) ? rawRule.weekdays : []).map(Number)))
    if (weekdays.length === 0 || weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) return null
    weekdays.sort((left, right) => left - right)
    const windows = normalizeTemporalWindows(rawRule.windows)
    if (windows === null) return null
    const rates = temporalRatesOf(rawRule.rates || rawRule, defaultPlan ? defaultPlan.rates : entryDefaultRates)
    if (rates === null) return null
    rules.push({ id, weekdays, windows, rates })
  }
  if (rules.length === 0) return null
  return { policyId, sourceUrl, timezone, effectiveFrom, effectiveUntil, defaultPlan, rules }
}

const DEEPSEEK_TEMPORAL_POLICY_ID = 'deepseek-v4-2026-08-pricing'
const DEEPSEEK_TEMPORAL_POLICY_URL = 'https://api-docs.deepseek.com/quick_start/pricing/'
// Built-in first-party profiles: each model carries its own explicit off-peak
// (inherited from the live catalog entry) and peak rates; the peak rates are
// stored as data, never derived as an automatic 'half price' rule.
const DEEPSEEK_TEMPORAL_MODELS = new Map([
  ['deepseek-v4-flash', { input: '0.44', output: '1.32', cacheRead: '0.014', cacheWrite: '0' }],
  ['deepseek-v4-flash-vision-exp', { input: '0.44', output: '1.32', cacheRead: '0.014', cacheWrite: '0' }],
  ['deepseek-v4-pro', { input: '1.32', output: '3.96', cacheRead: '0.044', cacheWrite: '0' }],
])

function builtinTemporalProfileFor(modelId) {
  const peakRates = DEEPSEEK_TEMPORAL_MODELS.get(normalizeModelId(modelId))
  if (peakRates === undefined) return null
  return {
    policyId: DEEPSEEK_TEMPORAL_POLICY_ID,
    sourceUrl: DEEPSEEK_TEMPORAL_POLICY_URL,
    timezone: TEMPORAL_TIMEZONE,
    effectiveFrom: 0,
    effectiveUntil: null,
    defaultPlan: null,
    rules: [{ id: 'peak', weekdays: [1, 2, 3, 4, 5], windows: [{ startMinute: 60, endMinute: 240 }, { startMinute: 360, endMinute: 600 }], rates: { ...peakRates } }],
  }
}

/** UTC half-open band: weekday in rule set AND minute within [start, end). */
function temporalBand(profile, atMs) {
  if (!isRecord(profile) || !Number.isFinite(atMs) || atMs < 0) return null
  const matched = matchingTemporalRule(profile, atMs)
  return matched === null ? 'off-peak' : 'peak'
}

function matchingTemporalRule(profile, atMs) {
  const date = new Date(Math.trunc(atMs))
  const weekday = date.getUTCDay()
  const minute = date.getUTCHours() * 60 + date.getUTCMinutes()
  for (const rule of (profile && Array.isArray(profile.rules) ? profile.rules : [])) {
    if (!(Array.isArray(rule.weekdays) ? rule.weekdays : []).includes(weekday)) continue
    if ((Array.isArray(rule.windows) ? rule.windows : []).some((window) => minute >= window.startMinute && minute < window.endMinute)) return rule
  }
  return null
}

/** Deterministic hash of the effective plan (policy + applied defaults). */
function temporalPolicyHash(profile, entryRates) {
  const stable = JSON.stringify([
    profile.policyId,
    profile.timezone,
    profile.effectiveFrom,
    profile.effectiveUntil,
    profile.defaultPlan,
    profile.rules,
    entryRates,
  ])
  return createHash('sha256').update(stable).digest('hex')
}

/**
 * Resolve one usage instant against a resolved pricing entry: which band
 * applies and which rates that band carries. Returns the stable signature that
 * both calculateCost() and the snapshot-reuse check consume.
 */
function temporalPlanFor(resolved, pricingAtMs) {
  const profile = isRecord(resolved) && resolved.temporalProfile ? resolved.temporalProfile : null
  if (profile === null) {
    return { status: 'none', band: null, ruleRates: null, policyId: null, policyHash: null, timezone: null, exemptReason: 'no-temporal-profile' }
  }
  const common = { policyId: profile.policyId || null, policyHash: profile.policyHash || null, timezone: profile.timezone === TEMPORAL_TIMEZONE ? TEMPORAL_TIMEZONE : null }
  const route = resolved.temporalRoute === 'official' || resolved.temporalRoute === 'mapped' ? resolved.temporalRoute : 'other'
  if (route === 'other') return { status: 'other-route', band: null, ruleRates: null, exemptReason: 'route-not-official', ...common }
  if (!Number.isFinite(pricingAtMs) || pricingAtMs < 0) return { status: 'time-missing', band: null, ruleRates: null, exemptReason: null, ...common }
  const at = Math.trunc(pricingAtMs)
  if (at < profile.effectiveFrom || (profile.effectiveUntil !== null && at >= profile.effectiveUntil)) return { status: 'history-gap', band: null, ruleRates: null, exemptReason: null, ...common }
  const rule = matchingTemporalRule(profile, at)
  if (rule !== null) return { status: 'applied', band: 'peak', ruleRates: rule.rates, exemptReason: null, ...common }
  return { status: 'applied', band: 'off-peak', ruleRates: profile.defaultPlan ? profile.defaultPlan.rates : null, exemptReason: null, ...common }
}

function normalizeContextTier(raw, fallbackRates, legacySize = null) {
  if (!isRecord(raw)) return null
  const descriptor = isRecord(raw.tier) ? raw.tier : raw
  const type = legacySize === null ? (typeof descriptor.type === 'string' ? descriptor.type.trim().toLowerCase() : '') : 'context'
  const sizeValue = legacySize === null ? descriptor.size : legacySize
  const size = finiteNumber(sizeValue)
  if (type !== 'context' || size === null || !Number.isSafeInteger(size) || size <= 0 || size > 1000000000) return null
  const input = decimalRate(raw, ['input', 'inputPerMillion'], fallbackRates.input)
  const output = decimalRate(raw, ['output', 'outputPerMillion'], fallbackRates.output)
  const cacheRead = decimalRate(raw, ['cacheRead', 'cache_read', 'cacheReadPerMillion'], fallbackRates.cacheRead)
  const cacheWrite = decimalRate(raw, ['cacheWrite', 'cache_write', 'cacheCreation', 'cacheWritePerMillion'], fallbackRates.cacheWrite)
  if (input === null || output === null || cacheRead === null || cacheWrite === null) return null
  if (decimalParts(input).digits < 0n || decimalParts(output).digits < 0n || decimalParts(cacheRead).digits < 0n || decimalParts(cacheWrite).digits < 0n) return null
  return { type: 'context', size, input, output, cacheRead, cacheWrite }
}

function normalizePriceEntry(raw, sourceDefault = 'models.dev') {
  if (!isRecord(raw)) return null
  const modelId = normalizeModelId(raw.modelId || raw.id)
  if (modelId === '') return null
  const input = decimalRate(raw, ['input', 'inputPerMillion'])
  const output = decimalRate(raw, ['output', 'outputPerMillion'])
  if (input === null || output === null || decimalParts(input).digits < 0n || decimalParts(output).digits < 0n) return null
  const cacheRead = decimalRate(raw, ['cacheRead', 'cache_read', 'cacheReadPerMillion'], '0')
  const cacheWrite = decimalRate(raw, ['cacheWrite', 'cache_write', 'cacheCreation', 'cacheWritePerMillion'], '0')
  if (cacheRead === null || cacheWrite === null || decimalParts(cacheRead).digits < 0n || decimalParts(cacheWrite).digits < 0n) return null
  const fallbackRates = { input, output, cacheRead, cacheWrite }
  const tiers = []
  let tieredInvalid = false
  const hasTierData = raw.tiers !== undefined || raw.context_over_200k !== undefined
  if (raw.tiers !== undefined) {
    if (!Array.isArray(raw.tiers)) tieredInvalid = true
    else {
      if (raw.tiers.length > MAX_CONTEXT_TIERS) tieredInvalid = true
      for (const rawTier of raw.tiers.slice(0, MAX_CONTEXT_TIERS)) {
        const tier = normalizeContextTier(rawTier, fallbackRates)
        if (tier === null || tiers.some((existing) => existing.size === tier.size)) tieredInvalid = true
        else tiers.push(tier)
      }
    }
  }
  if (raw.context_over_200k !== undefined && raw.tiers === undefined) {
    const tier = normalizeContextTier(raw.context_over_200k, fallbackRates, 200000)
    if (tier === null) tieredInvalid = true
    else tiers.push(tier)
  }
  tiers.sort((left, right) => left.size - right.size)
  const tiered = raw.tiered !== undefined ? raw.tiered === true : hasTierData || tiers.length > 0
  if (!tiered) {
    tiers.length = 0
    tieredInvalid = false
  } else if (tiers.length === 0) tieredInvalid = true
  const temporalPricing = raw.temporalPricing === undefined || raw.temporalPricing === null ? undefined : normalizeTemporalPricing(raw.temporalPricing, fallbackRates)
  return {
    providerId: typeof raw.providerId === 'string' ? raw.providerId.trim().toLowerCase() : '',
    providerName: typeof raw.providerName === 'string' ? raw.providerName.trim().slice(0, 200) : '',
    modelId,
    displayName: typeof raw.displayName === 'string' && raw.displayName.trim() !== '' ? raw.displayName.trim().slice(0, 200) : modelId,
    currency: typeof raw.currency === 'string' && raw.currency.trim() !== '' ? raw.currency.trim().toUpperCase() : 'USD',
    input,
    output,
    cacheRead,
    cacheWrite,
    source: raw.source === 'manual' ? 'manual' : sourceDefault,
    tiered,
    ...(tiered ? { tiers, tieredInvalid } : {}),
    reasoningRateAvailable: raw.reasoningRateAvailable === true || raw.reasoning !== undefined,
    fetchedAt: Number.isFinite(raw.fetchedAt) ? raw.fetchedAt : 0,
    ...(temporalPricing === undefined ? {} : { temporalPricing }),
  }
}

function parseModelsDevCatalog(raw, fetchedAt = Date.now()) {
  if (!isRecord(raw)) return { ok: false, error: 'catalog-not-object' }
  const entries = []
  for (const [providerKey, provider] of Object.entries(raw)) {
    if (!isRecord(provider) || !isRecord(provider.models)) continue
    const providerId = typeof provider.id === 'string' && provider.id.trim() !== '' ? provider.id.trim() : providerKey
    const providerName = typeof provider.name === 'string' ? provider.name : providerId
    for (const [modelKey, model] of Object.entries(provider.models)) {
      if (!isRecord(model)) continue
      const entry = normalizePriceEntry({
        providerId,
        providerName,
        modelId: typeof model.id === 'string' ? model.id : modelKey,
        displayName: model.name,
        currency: 'USD',
        input: model.cost && model.cost.input,
        output: model.cost && model.cost.output,
        cacheRead: model.cost && model.cost.cache_read,
        cacheWrite: model.cost && model.cost.cache_write,
        tiers: model.cost && model.cost.tiers,
        context_over_200k: model.cost && model.cost.context_over_200k,
        tiered: model.cost && model.cost.tiers !== undefined || model.cost && model.cost.context_over_200k !== undefined,
        reasoningRateAvailable: model.cost && model.cost.reasoning !== undefined,
        source: 'models.dev',
        fetchedAt,
      })
      if (entry === null || entry.currency !== 'USD') continue
      // Duplicate normalized keys are NOT resolved here: they are kept and
      // resolved deterministically after the stable sort below.
      entries.push(entry)
      if (entries.length > MAX_CATALOG_CANDIDATES) return { ok: false, error: 'catalog-exceeds-candidate-limit', candidateCount: entries.length }
    }
  }
  if (entries.length === 0) return { ok: false, error: 'catalog-has-no-priced-models' }
  // Sort by the stable key first: upstream object order must not decide which
  // models survive a large catalog or which conflicting duplicate is kept.
  // Code-unit comparison: default-locale localeCompare can report ties for
  // distinct strings (e.g. composed/decomposed accents), which would let
  // upstream enumeration order decide the surviving entry.
  entries.sort((left, right) => { const ka = priceEntryKey(left); const kb = priceEntryKey(right); return ka < kb ? -1 : ka > kb ? 1 : 0 })
  // Deterministic duplicate selection: within one normalized key, compare only
  // the small conflict group by their full content (fetchedAt excluded), so
  // ordering swaps cannot change the surviving price.
  const stableText = (entry) => {
    const copy = Object.assign({}, entry)
    delete copy.fetchedAt
    if (typeof copy.providerId === 'string') copy.providerId = copy.providerId.trim().toLowerCase()
    return JSON.stringify(copy)
  }
  const ordered = []
  {
    let index = 0
    while (index < entries.length) {
      const key = priceEntryKey(entries[index])
      let end = index + 1
      while (end < entries.length && priceEntryKey(entries[end]) === key) end += 1
      let group = end - index > 1 ? entries.slice(index, end).sort((left, right) => { const la = stableText(left); const lb = stableText(right); return la < lb ? -1 : la > lb ? 1 : 0 }) : entries.slice(index, end)
      ordered.push(group[0])
      index = end
    }
  }
  ordered.length = Math.min(ordered.length, MAX_PRICE_ENTRIES)
  // The fetchedAt stamp differs on every fetch; exclude it from the content
  // hash so identical catalog contents hash identically across syncs.
  const canonical = JSON.stringify(ordered.map((entry) => {
    if (entry.fetchedAt === undefined) return entry
    const { fetchedAt, ...stable } = entry
    return stable
  }))
  return {
    ok: true,
    catalog: {
      schemaVersion: PRICING_SCHEMA_VERSION,
      sourceUrl: MODEL_CATALOG_URL,
      fetchedAt,
      catalogHash: createHash('sha256').update(canonical).digest('hex'),
      entries: ordered,
    },
  }
}

function normalizePricingState(raw) {
  const value = isRecord(raw) ? raw : {}
  const sync = isRecord(value.sync) ? value.sync : {}
  const source = isRecord(value.source) ? value.source : {}
  const normalizeEntries = (items, sourceDefault, limit) => (Array.isArray(items) ? items.slice(0, limit) : []).map((item) => normalizePriceEntry(item, sourceDefault)).filter((item) => item !== null)
  const catalogEntries = normalizeEntries(value.catalogEntries || value.entries, 'models.dev', MAX_PRICE_ENTRIES)
  const overrides = normalizeEntries(value.overrides, 'manual', MAX_OVERRIDES).map((entry) => ({ ...entry, source: 'manual' }))
  const mappings = (Array.isArray(value.mappings) ? value.mappings : []).slice(0, MAX_MAPPINGS).map((mapping) => {
    if (!isRecord(mapping)) return null
    const provider = typeof mapping.provider === 'string' ? mapping.provider.trim() : ''
    const model = normalizeModelId(mapping.model || mapping.modelId)
    const catalogProviderId = typeof mapping.catalogProviderId === 'string' ? mapping.catalogProviderId.trim() : ''
    const catalogModelId = normalizeModelId(mapping.catalogModelId || mapping.catalogModel)
    const identityKey = (typeof mapping.identityKey === 'string' && mapping.identityKey.trim() !== '' ? mapping.identityKey : mapping.usageIdentityKey)
    const normalizedIdentityKey = typeof identityKey === 'string' ? identityKey.trim().slice(0, 1024) : ''
    if (provider === '' && model === '' && catalogProviderId === '' && catalogModelId === '' && normalizedIdentityKey === '') return null
    return {
      identityKey: normalizedIdentityKey,
      provider,
      model,
      catalogProviderId,
      catalogModelId,
      inputTokenSemantics: INPUT_SEMANTICS.includes(mapping.inputTokenSemantics) ? mapping.inputTokenSemantics : 'fresh',
      multiplier: decimalText(mapping.multiplier === undefined ? '1' : mapping.multiplier) || '1',
    }
  }).filter((mapping) => mapping !== null)
  const providerAliases = {}
  if (isRecord(value.providerAliases)) {
    for (const [from, to] of Object.entries(value.providerAliases).slice(0, MAX_MAPPINGS)) {
      if (typeof from === 'string' && typeof to === 'string' && from.trim() !== '' && to.trim() !== '') providerAliases[from.trim()] = to.trim()
    }
  }
  const normalized = {
    schemaVersion: PRICING_SCHEMA_VERSION,
    source: {
      url: typeof source.url === 'string' && source.url !== '' ? source.url : MODEL_CATALOG_URL,
      fetchedAt: Number.isFinite(source.fetchedAt) ? source.fetchedAt : 0,
      catalogHash: typeof source.catalogHash === 'string' ? source.catalogHash.slice(0, 128) : '',
      lastError: typeof source.lastError === 'string' ? source.lastError.slice(0, 500) : '',
    },
    sync: {
      autoEnabled: sync.autoEnabled === true,
      intervalMs: Number.isFinite(sync.intervalMs) && sync.intervalMs >= 60 * 60 * 1000 ? sync.intervalMs : DEFAULT_SYNC_INTERVAL_MS,
      lastAttemptAt: Number.isFinite(sync.lastAttemptAt) ? sync.lastAttemptAt : 0,
      lastSuccessAt: Number.isFinite(sync.lastSuccessAt) ? sync.lastSuccessAt : 0,
      lastError: typeof sync.lastError === 'string' ? sync.lastError.slice(0, 500) : '',
    },
    catalogEntries,
    overrides,
    mappings,
    providerAliases,
  }
  const entries = normalized.overrides.concat(normalized.catalogEntries)
  const exactIndex = new Map()
  for (const entry of entries) {
    const list = exactIndex.get(entry.modelId) || []
    list.push(entry)
    exactIndex.set(entry.modelId, list)
  }
  Object.defineProperty(normalized, '_entries', { value: entries, enumerable: false })
  Object.defineProperty(normalized, '_exactIndex', { value: exactIndex, enumerable: false })
  Object.defineProperty(normalized, '_normalized', { value: true, enumerable: false })
  return normalized
}

function createEmptyPricingState() {
  return normalizePricingState({})
}

function serializePricingState(state) {
  const normalized = normalizePricingState(state)
  return {
    schemaVersion: normalized.schemaVersion,
    source: { ...normalized.source },
    sync: { ...normalized.sync },
    catalogEntries: normalized.catalogEntries.map((entry) => ({ ...entry })),
    overrides: normalized.overrides.map((entry) => ({ ...entry })),
    mappings: normalized.mappings.map((mapping) => ({ ...mapping })),
    providerAliases: { ...normalized.providerAliases },
  }
}

function sameRates(left, right) {
  if (left.input !== right.input || left.output !== right.output || left.cacheRead !== right.cacheRead || left.cacheWrite !== right.cacheWrite || left.currency !== right.currency || left.tiered !== right.tiered || left.tieredInvalid !== right.tieredInvalid) return false
  const leftTiers = Array.isArray(left.tiers) ? left.tiers : []
  const rightTiers = Array.isArray(right.tiers) ? right.tiers : []
  if (leftTiers.length !== rightTiers.length) return false
  return leftTiers.every((leftTier, index) => {
    const rightTier = rightTiers[index]
    return rightTier && leftTier.type === rightTier.type && leftTier.size === rightTier.size && leftTier.input === rightTier.input && leftTier.output === rightTier.output && leftTier.cacheRead === rightTier.cacheRead && leftTier.cacheWrite === rightTier.cacheWrite
  })
}

function mappingMatches(mapping, identity) {
  if (mapping.identityKey !== '') {
    if (mapping.identityKey !== identityKeyOf(identity)) return false
    return mapping.provider === '' || (isRecord(identity) && typeof identity.provider === 'string' && identity.provider.trim().toLowerCase() === mapping.provider.toLowerCase())
  }
  if (mapping.provider !== '' && (!isRecord(identity) || typeof identity.provider !== 'string' || identity.provider.trim().toLowerCase() !== mapping.provider.toLowerCase())) return false
  const models = identityModels(identity)
  return mapping.model !== '' && models.includes(mapping.model)
}

function findMappedEntry(mapping, state) {
  if (mapping.catalogProviderId !== '' && mapping.catalogModelId !== '') {
    return state.overrides.find((entry) => normalizeProvider(entry.providerId) === normalizeProvider(mapping.catalogProviderId) && entry.modelId === mapping.catalogModelId) || state.catalogEntries.find((entry) => normalizeProvider(entry.providerId) === normalizeProvider(mapping.catalogProviderId) && entry.modelId === mapping.catalogModelId) || null
  }
  if (mapping.catalogModelId !== '') {
    const matches = state.overrides.concat(state.catalogEntries).filter((entry) => entry.modelId === mapping.catalogModelId)
    return matches.length === 1 ? matches[0] : null
  }
  return null
}

const DEEPSEEK_OFFICIAL_PROVIDERS = ['deepseek', 'deepseek-official']

function attachTemporalProfile(entry, mapped, identity) {
  if (entry === null || entry === undefined || !isRecord(entry)) return null
  let profile = isRecord(entry.temporalPricing) ? entry.temporalPricing : null
  if (profile === null && DEEPSEEK_OFFICIAL_PROVIDERS.includes(normalizeProvider(entry.providerId))) profile = builtinTemporalProfileFor(entry.modelId)
  if (profile === null) return null
  const providerId = normalizeProvider(entry.providerId)
  const identityProvider = normalizeProvider(identity && identity.provider)
  // Safety boundary: the peak/off-peak table applies only when the DSH route
  // is the first-party provider, or when the user explicitly mapped this route
  // to the DeepSeek official entry. OpenRouter and other resellers never get
  // the DeepSeek temporal band automatically.
  const route = DEEPSEEK_OFFICIAL_PROVIDERS.includes(providerId) && DEEPSEEK_OFFICIAL_PROVIDERS.includes(identityProvider) ? 'official' : mapped !== undefined && mapped !== null ? 'mapped' : 'other'
  return {
    route,
    profile: {
      ...profile,
      policyHash: temporalPolicyHash(profile, { input: entry.input, output: entry.output, cacheRead: entry.cacheRead, cacheWrite: entry.cacheWrite }),
    },
  }
}

function resolvePricing(identity, rawState) {
  const state = rawState && rawState._normalized === true ? rawState : normalizePricingState(rawState)
  const identityKey = identityKeyOf(identity)
  const exactMapped = identityKey === '' ? undefined : state.mappings.find((mapping) => mapping.identityKey !== '' && mapping.identityKey === identityKey && mappingMatches(mapping, identity))
  const mapped = exactMapped || state.mappings.find((mapping) => mapping.identityKey === '' && mappingMatches(mapping, identity))
  const mappedEntry = mapped === undefined ? null : findMappedEntry(mapped, state)
  if (mapped !== undefined && mappedEntry === null && (mapped.catalogModelId !== '' || mapped.catalogProviderId !== '')) {
    return { status: 'unpriced', reason: 'mapping-target-not-found', pricingModel: mapped.catalogModelId || null, providerId: mapped.catalogProviderId || null }
  }
  const models = mappedEntry === null ? identityModels(identity) : [mappedEntry.modelId]
  const pool = state._entries || state.overrides.concat(state.catalogEntries)
  const exactIndex = state._exactIndex || new Map()
  const officialProviders = new Set(models.flatMap((model) => Array.from(officialProviderIds(model))))
  const choose = (entries, model, candidate, exact) => entries.filter((entry) => {
    if (mappedEntry !== null && entry !== mappedEntry) return false
    if (entry.currency !== 'USD') return false
    if (entry.source === 'manual') return true
    return officialProviders.has(normalizeProvider(entry.providerId))
  }).map((entry) => ({ entry, model, candidate, exact }))
  for (const model of models) {
    const manualMatches = []
    const officialMatches = []
    for (const [index, id] of modelPricingCandidates(model).entries()) {
      const exactMatches = choose(exactIndex.get(id) || [], model, id, true)
      manualMatches.push(...exactMatches.filter((match) => match.entry.source === 'manual').map((match) => ({ ...match, rank: index * 2 })))
      officialMatches.push(...exactMatches.filter((match) => match.entry.source !== 'manual').map((match) => ({ ...match, rank: index * 2 })))
      if (shouldTryPrefix(id)) {
        const prefixMatches = choose(pool.filter((entry) => entry.modelId.startsWith(id + '-')), model, id, false)
        manualMatches.push(...prefixMatches.filter((match) => match.entry.source === 'manual').map((match) => ({ ...match, rank: index * 2 + 1 })))
        officialMatches.push(...prefixMatches.filter((match) => match.entry.source !== 'manual').map((match) => ({ ...match, rank: index * 2 + 1 })))
      }
    }
    const matches = manualMatches.length > 0 ? manualMatches : officialMatches
    if (matches.length === 0) continue
    matches.sort((a, b) => a.rank - b.rank || a.entry.modelId.length - b.entry.modelId.length)
    const best = matches[0]
    const sameRank = matches.filter((match) => match.rank === best.rank)
    const unique = []
    for (const match of sameRank) if (!unique.some((entry) => sameRates(entry, match.entry))) unique.push(match.entry)
    if (unique.length > 1) return { status: 'ambiguous', reason: 'multiple-official-prices', pricingModel: best.entry.modelId, providerId: null, candidates: unique.map((entry) => ({ providerId: entry.providerId, modelId: entry.modelId })) }
    const entry = unique[0] || best.entry
    const tiered = entry.tiered === true
    const tiers = Array.isArray(entry.tiers) ? entry.tiers.map((tier) => ({ ...tier })) : []
    const tieredSupported = !tiered || (entry.tieredInvalid !== true && tiers.length > 0)
    return {
      status: tieredSupported ? 'priced' : 'unsupported',
      reason: tieredSupported ? '' : 'tiered-pricing-not-modeled',
      pricingModel: entry.modelId,
      providerId: entry.providerId || null,
      providerName: entry.providerName || null,
      displayName: entry.displayName,
      currency: entry.currency,
      rates: { input: entry.input, output: entry.output, cacheRead: entry.cacheRead, cacheWrite: entry.cacheWrite },
      source: entry.source,
      tiered,
      ...(tiered ? { tiers, tieredInvalid: entry.tieredInvalid === true } : {}),
      reasoningRateAvailable: entry.reasoningRateAvailable,
      inputTokenSemantics: mapped && INPUT_SEMANTICS.includes(mapped.inputTokenSemantics) ? mapped.inputTokenSemantics : 'fresh',
      multiplier: mapped ? mapped.multiplier : '1',
      ...(() => { const temporal = attachTemporalProfile(entry, mapped, identity); return temporal === null ? {} : { temporalProfile: temporal.profile, temporalRoute: temporal.route } })(),
    }
  }
  const model = models[0] || null
  if (officialProviders.size === 0) return { status: 'unsupported', reason: 'official-provider-unknown', pricingModel: model, providerId: null }
  return { status: 'unpriced', reason: 'official-price-not-found', pricingModel: model, providerId: null }
}

function tokenCount(value) {
  const parsed = finiteNumber(value)
  if (parsed === null || parsed <= 0) return 0n
  return BigInt(Math.trunc(parsed))
}

function costPerMillion(tokens, rate) {
  const tokenValue = tokenCount(tokens)
  const rateParts = decimalParts(rate) || { digits: 0n, scale: 0 }
  const numerator = tokenValue * rateParts.digits
  const scale = rateParts.scale + 6
  return decimalText(numerator.toString() + (scale > 0 ? 'e-' + scale : '')) || '0'
}

function contextTokenCount(input, cacheRead, cacheWrite, inputSemantics) {
  const values = inputSemantics === 'total' ? [input] : inputSemantics === 'legacy' ? [input, cacheWrite] : [input, cacheRead, cacheWrite]
  let total = 0
  for (const value of values) {
    const tokens = Math.max(0, Math.trunc(value))
    if (!Number.isFinite(tokens) || total > Number.MAX_SAFE_INTEGER - tokens) return Number.MAX_SAFE_INTEGER
    total += tokens
  }
  return total
}

function validContextTier(tier, previousSize = 0) {
  if (!isRecord(tier) || tier.type !== 'context' || !Number.isSafeInteger(tier.size) || tier.size <= previousSize || tier.size > 1000000000) return false
  return RATE_KEYS.every((key) => decimalText(tier[key]) !== null)
}

function validContextTierSchedule(tiers) {
  if (!Array.isArray(tiers) || tiers.length === 0) return false
  let previousSize = 0
  for (const tier of tiers) {
    if (!validContextTier(tier, previousSize)) return false
    previousSize = tier.size
  }
  return true
}

function selectContextTier(tiers, contextTokens) {
  let selected = null
  for (const tier of tiers) {
    // models.dev defines size as the point where the next band starts.
    if (contextTokens > tier.size) selected = tier
    else break
  }
  return selected
}

function calculateCost(values, resolved, pricingAtMs = null, pricingTimeSource = 'usage-event') {
  const input = finiteNumber(values && values.input) || 0
  const output = finiteNumber(values && values.output) || 0
  const cacheRead = finiteNumber(values && values.cacheRead) || 0
  const cacheWrite = finiteNumber(values && values.cacheWrite) || 0
  const inputSemantics = INPUT_SEMANTICS.includes(resolved && resolved.inputTokenSemantics) ? resolved.inputTokenSemantics : 'fresh'
  const billableInput = inputSemantics === 'total' ? Math.max(0, input - cacheRead - cacheWrite) : inputSemantics === 'legacy' ? Math.max(0, input - cacheRead) : input
  const billableOutput = output
  const tiered = resolved && resolved.tiered === true
  const tiers = tiered && Array.isArray(resolved.tiers) ? resolved.tiers : []
  const tierScheduleValid = !tiered || validContextTierSchedule(tiers)
  const plan = temporalPlanFor(resolved, pricingAtMs)
  const pricingAt = Number.isFinite(pricingAtMs) && pricingAtMs >= 0 ? Math.trunc(pricingAtMs) : null
  const timeSource = TEMPORAL_TIME_SOURCES.includes(pricingTimeSource) ? pricingTimeSource : 'usage-event'
  let status = tierScheduleValid && resolved && COST_STATUSES.includes(resolved.status) ? resolved.status : tiered ? 'unsupported' : 'unpriced'
  let reason = tiered && !tierScheduleValid ? 'tiered-pricing-not-modeled' : resolved && typeof resolved.reason === 'string' ? resolved.reason : 'model-not-found'
  if (status === 'priced') {
    if (tiered && (plan.status === 'applied' || plan.status === 'history-gap' || plan.status === 'time-missing')) {
      // Band plans and context tiers are two independent pricing axes; a model
      // carrying both is not modeled and fails closed instead of guessing.
      status = 'unsupported'
      reason = 'temporal-tiered-unsupported'
    } else if (plan.status === 'history-gap') {
      // A profile exists but the usage instant falls outside its effective
      // window: never discount into an unverifiable period.
      status = 'unsupported'
      reason = 'temporal-price-history-unavailable'
    } else if (plan.status === 'time-missing') {
      status = 'unsupported'
      reason = 'temporal-time-unavailable'
    }
  }
  const base = {
    schemaVersion: COST_SCHEMA_VERSION,
    pricingMode: 'official-model',
    status,
    currency: resolved && resolved.currency ? resolved.currency : 'USD',
    source: resolved && resolved.source ? resolved.source : 'none',
    pricingModel: resolved && resolved.pricingModel ? resolved.pricingModel : null,
    providerId: resolved && resolved.providerId ? resolved.providerId : null,
    inputTokenSemantics: inputSemantics,
    multiplier: decimalText(resolved && resolved.multiplier !== undefined ? resolved.multiplier : '1') || '1',
    billableInputTokens: Math.trunc(billableInput),
    billableOutputTokens: Math.trunc(billableOutput),
    pricingAt,
    pricingTimeSource: timeSource,
    pricingBand: plan.band,
    pricingTimezone: plan.timezone,
    pricingPolicyId: plan.policyId,
    pricingPolicyHash: plan.policyHash,
    temporalApplicable: plan.status === 'applied',
    temporalExemptReason: plan.exemptReason,
    rates: resolved && resolved.rates ? { ...resolved.rates } : { input: '0', output: '0', cacheRead: '0', cacheWrite: '0' },
    breakdown: { input: '0', output: '0', cacheRead: '0', cacheWrite: '0' },
    baseTotal: '0',
    total: '0',
    reason,
    tiered,
    reasoningRateAvailable: resolved && resolved.reasoningRateAvailable === true,
  }
  if (base.status !== 'priced') return base
  if (tiered) {
    const contextTokens = contextTokenCount(input, cacheRead, cacheWrite, inputSemantics)
    const selectedTier = selectContextTier(tiers, contextTokens)
    const selectedRates = selectedTier || base.rates
    base.rates = { input: selectedRates.input, output: selectedRates.output, cacheRead: selectedRates.cacheRead, cacheWrite: selectedRates.cacheWrite }
    base.contextTokens = contextTokens
    base.selectedTier = { type: 'context', size: selectedTier ? selectedTier.size : 0 }
  } else if (plan.status === 'applied' && plan.ruleRates !== null && typeof plan.ruleRates === 'object') {
    // Peak windows carry their own rates; off-peak plans without an explicit
    // default inherit the live entry rates (catalog updates flow through).
    base.rates = { input: plan.ruleRates.input, output: plan.ruleRates.output, cacheRead: plan.ruleRates.cacheRead, cacheWrite: plan.ruleRates.cacheWrite }
  }
  base.breakdown.input = costPerMillion(base.billableInputTokens, base.rates.input)
  base.breakdown.output = costPerMillion(base.billableOutputTokens, base.rates.output)
  base.breakdown.cacheRead = costPerMillion(cacheRead, base.rates.cacheRead)
  base.breakdown.cacheWrite = costPerMillion(cacheWrite, base.rates.cacheWrite)
  base.baseTotal = decimalAdd(decimalAdd(base.breakdown.input, base.breakdown.output), decimalAdd(base.breakdown.cacheRead, base.breakdown.cacheWrite))
  base.total = decimalMultiply(base.baseTotal, base.multiplier)
  return base
}

function emptyCostAggregate(currency = 'USD') {
  return { currency, input: '0', output: '0', cacheRead: '0', cacheWrite: '0', baseTotal: '0', total: '0', pricedCalls: 0, unpricedCalls: 0, ambiguousCalls: 0, unsupportedCalls: 0 }
}

function addCostAggregate(target, cost) {
  if (isCostAccumulator(target)) return addCostAccumulator(target, cost)
  const value = isRecord(cost) ? cost : {}
  const status = COST_STATUSES.includes(value.status) ? value.status : 'unpriced'
  if (status === 'priced') {
    target.input = decimalAdd(target.input, value.breakdown && value.breakdown.input)
    target.output = decimalAdd(target.output, value.breakdown && value.breakdown.output)
    target.cacheRead = decimalAdd(target.cacheRead, value.breakdown && value.breakdown.cacheRead)
    target.cacheWrite = decimalAdd(target.cacheWrite, value.breakdown && value.breakdown.cacheWrite)
    target.baseTotal = decimalAdd(target.baseTotal, value.baseTotal)
    target.total = decimalAdd(target.total, value.total)
    target.pricedCalls += 1
  } else if (status === 'ambiguous') target.ambiguousCalls += 1
  else if (status === 'unsupported') target.unsupportedCalls += 1
  else target.unpricedCalls += 1
  return target
}

function serializeCostAggregate(cost) {
  const value = cost || emptyCostAggregate()
  const accumulator = isCostAccumulator(value)
  const text = (field) => accumulator ? decimalAccumulatorText(value[field]) : decimalText(value[field]) || '0'
  return {
    currency: typeof value.currency === 'string' && value.currency !== '' ? value.currency : 'USD',
    input: text('input'),
    output: text('output'),
    cacheRead: text('cacheRead'),
    cacheWrite: text('cacheWrite'),
    baseTotal: text('baseTotal'),
    total: text('total'),
    pricedCalls: Number.isFinite(value.pricedCalls) ? value.pricedCalls : 0,
    unpricedCalls: Number.isFinite(value.unpricedCalls) ? value.unpricedCalls : 0,
    ambiguousCalls: Number.isFinite(value.ambiguousCalls) ? value.ambiguousCalls : 0,
    unsupportedCalls: Number.isFinite(value.unsupportedCalls) ? value.unsupportedCalls : 0,
  }
}

function normalizeCostSnapshot(raw) {
  if (!isRecord(raw) || !COST_STATUSES.includes(raw.status)) return null
  const rates = isRecord(raw.rates) ? raw.rates : {}
  const breakdown = isRecord(raw.breakdown) ? raw.breakdown : {}
  const fields = ['input', 'output', 'cacheRead', 'cacheWrite']
  const normalizedRates = {}
  const normalizedBreakdown = {}
  for (const field of fields) {
    const rate = decimalText(rates[field])
    const cost = decimalText(breakdown[field])
    if (rate === null || cost === null) return null
    normalizedRates[field] = rate
    normalizedBreakdown[field] = cost
  }
  const baseTotal = decimalText(raw.baseTotal)
  const total = decimalText(raw.total)
  const multiplier = decimalText(raw.multiplier)
  if (baseTotal === null || total === null || multiplier === null) return null
  let contextTokens = null
  if (raw.contextTokens !== undefined) {
    const parsed = finiteNumber(raw.contextTokens)
    if (parsed === null || parsed < 0 || !Number.isSafeInteger(parsed)) return null
    contextTokens = parsed
  }
  let selectedTier = null
  if (raw.selectedTier !== undefined && raw.selectedTier !== null) {
    if (!isRecord(raw.selectedTier) || raw.selectedTier.type !== 'context' || !Number.isSafeInteger(raw.selectedTier.size) || raw.selectedTier.size < 0 || raw.selectedTier.size > 1000000000) return null
    selectedTier = { type: 'context', size: raw.selectedTier.size }
  }
  const isV2 = raw.schemaVersion === COST_SCHEMA_VERSION
  const legacy = !isV2
  let pricingAt = null
  if (raw.pricingAt !== undefined && raw.pricingAt !== null) {
    if (!Number.isFinite(raw.pricingAt) || raw.pricingAt < 0 || !Number.isSafeInteger(raw.pricingAt)) return null
    pricingAt = raw.pricingAt
  }
  if (raw.pricingTimeSource !== undefined && raw.pricingTimeSource !== null && raw.pricingTimeSource !== 'legacy-unknown' && !TEMPORAL_TIME_SOURCES.includes(raw.pricingTimeSource)) return null
  if (raw.pricingBand !== undefined && raw.pricingBand !== null && raw.pricingBand !== 'peak' && raw.pricingBand !== 'off-peak') return null
  if (raw.pricingTimezone !== undefined && raw.pricingTimezone !== null && raw.pricingTimezone !== 'UTC') return null
  const pricingTimeSource = TEMPORAL_TIME_SOURCES.includes(raw.pricingTimeSource) ? raw.pricingTimeSource : legacy ? 'legacy-unknown' : null
  const pricingBand = raw.pricingBand === 'peak' || raw.pricingBand === 'off-peak' ? raw.pricingBand : null
  const pricingTimezone = raw.pricingTimezone === 'UTC' ? 'UTC' : null
  const pricingPolicyId = typeof raw.pricingPolicyId === 'string' && raw.pricingPolicyId !== '' ? raw.pricingPolicyId.slice(0, 128) : null
  const pricingPolicyHash = typeof raw.pricingPolicyHash === 'string' && raw.pricingPolicyHash !== '' ? raw.pricingPolicyHash.slice(0, 128) : null
  return {
    schemaVersion: COST_SCHEMA_VERSION,
    pricingMode: raw.pricingMode === 'official-model' ? 'official-model' : 'legacy-provider-aware',
    status: raw.status,
    currency: typeof raw.currency === 'string' ? raw.currency : 'USD',
    source: typeof raw.source === 'string' ? raw.source : 'none',
    pricingModel: typeof raw.pricingModel === 'string' ? raw.pricingModel : null,
    providerId: typeof raw.providerId === 'string' ? raw.providerId : null,
    inputTokenSemantics: INPUT_SEMANTICS.includes(raw.inputTokenSemantics) ? raw.inputTokenSemantics : 'fresh',
    multiplier,
    billableInputTokens: Number.isFinite(raw.billableInputTokens) ? Math.max(0, Math.trunc(raw.billableInputTokens)) : 0,
    billableOutputTokens: Number.isFinite(raw.billableOutputTokens) ? Math.max(0, Math.trunc(raw.billableOutputTokens)) : 0,
    pricingAt,
    pricingTimeSource,
    pricingBand,
    pricingTimezone,
    pricingPolicyId,
    pricingPolicyHash,
    temporalApplicable: raw.temporalApplicable === true,
    temporalExemptReason: raw.temporalExemptReason === null || raw.temporalExemptReason === undefined ? null : typeof raw.temporalExemptReason === 'string' ? raw.temporalExemptReason.slice(0, 64) : null,
    ...(contextTokens === null ? {} : { contextTokens }),
    ...(selectedTier === null ? {} : { selectedTier }),
    rates: normalizedRates,
    breakdown: normalizedBreakdown,
    baseTotal,
    total,
    reason: typeof raw.reason === 'string' ? raw.reason.slice(0, 200) : '',
    tiered: raw.tiered === true,
    reasoningRateAvailable: raw.reasoningRateAvailable === true,
  }
}

async function fetchModelsDevCatalog(fetchImpl = globalThis.fetch, options = {}) {
  if (typeof fetchImpl !== 'function') return { ok: false, error: 'fetch-unavailable' }
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 15000
  const url = typeof options.url === 'string' && options.url !== '' ? options.url : MODEL_CATALOG_URL
  let controller = null
  let timer = null
  try {
    if (typeof AbortController === 'function') {
      controller = new AbortController()
      timer = setTimeout(() => controller.abort(), timeoutMs)
    }
    const response = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: controller ? controller.signal : undefined })
    if (!response || response.ok !== true) return { ok: false, error: 'http-' + String(response && response.status || 0) }
    const length = response.headers && typeof response.headers.get === 'function' ? Number(response.headers.get('content-length')) : 0
    if (Number.isFinite(length) && length > MAX_CATALOG_BYTES) return { ok: false, error: 'catalog-too-large' }
    const text = await response.text()
    if (new TextEncoder().encode(text).length > MAX_CATALOG_BYTES) return { ok: false, error: 'catalog-too-large' }
    let parsed
    try { parsed = JSON.parse(text.replace(/^\uFEFF/, '')) } catch (err) { return { ok: false, error: 'catalog-invalid-json' } }
    return parseModelsDevCatalog(parsed, Date.now())
  } catch (err) {
    return { ok: false, error: 'catalog-fetch-failed' }
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

export {
  COST_SCHEMA_VERSION,
  COST_STATUSES,
  DEFAULT_SYNC_INTERVAL_MS,
  INPUT_SEMANTICS,
  MODEL_CATALOG_URL,
  PRICING_SCHEMA_VERSION,
  RATE_KEYS,
  addCostAggregate,
  addCostAccumulator,
  calculateCost,
  createCostAccumulator,
  createEmptyPricingState,
  decimalAdd,
  decimalMultiply,
  decimalSubtract,
  decimalText,
  emptyCostAggregate,
  fetchModelsDevCatalog,
  isCostAccumulator,
  modelPricingCandidates,
  officialProviderIds,
  normalizeCostSnapshot,
  normalizeModelId,
  normalizePricingState,
  normalizeTemporalPricing,
  parseModelsDevCatalog,
  resolvePricing,
  serializeCostAggregate,
  serializePricingState,
  temporalBand,
  temporalPlanFor,
  temporalPolicyHash,
}
