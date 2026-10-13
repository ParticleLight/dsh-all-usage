import { COST_SCHEMA_VERSION, builtinTemporalProfileFor, calculateCost, fetchHolidayCalendar, fetchModelsDevCatalog, normalizeCostSnapshot, normalizeModelId, normalizePricingState, officialProviderIds, serializeCostAggregate, serializePricingState, temporalPlanFor } from './pricing.js'
import { billingInstantOf, contextTimeIsFresh, contextTimeKey, validEventTime } from './usage-core.js'

const LEDGER_VERSION = 3
// One price table row per usage identity; the cap keeps the panel payload bounded.
const MAX_PRICING_ROWS = 500
// The holiday arrangement changes at most once a year (and only for the next
// one); a day-long cache keeps the panel from re-fetching on every open.
const HOLIDAY_CALENDAR_TTL_MS = 24 * 60 * 60 * 1000

export function createPricingRuntime(host) {
  const { state, markStatsChanged } = host
  const { storage } = host.services
  const {
    coerceIdentity,
    dateKeys,
    ensureDay,
    ensureDayModel,
    ensureDayWs,
    ensureModel,
    ensureWs,
    addCostAggregateDirection,
    adjustQueryCost,
    resolveCurrentPricing,
  } = host.aggregation
  const persistLedgerRecord = (...args) => host.ledger.persistLedgerRecord(...args)
  const drainLedgerWrites = (...args) => host.ledger.drainLedgerWrites(...args)
  const nextLedgerRevision = (...args) => host.ledger.nextLedgerRevision(...args)
  let pricingMutation = Promise.resolve()
  function serializePricingMutation(task) {
    const next = pricingMutation.then(task, task)
    pricingMutation = next.catch(() => {})
    return next
  }

  function adjustCostOnly(item, cost, direction) {
    const identity = coerceIdentity(item.identity || item.modelId)
    const dates = item && typeof item.date === 'string' && typeof item.dateUtc === 'string' ? { local: item.date, utc: item.dateUtc } : dateKeys(item.time)
    const targets = []
    const seen = new Set()
    for (const target of [
      ensureModel(identity).cost,
      state.totals.cost,
      ensureWs(item.wsId).cost,
      ensureDay(state.byDay, dates.local).cost,
      ensureDay(state.byDayUtc, dates.utc).cost,
      ensureDayWs(ensureDay(state.byDay, dates.local), item.wsId).cost,
      ensureDayWs(ensureDay(state.byDayUtc, dates.utc), item.wsId).cost,
      ensureDayModel(ensureDay(state.byDay, dates.local), identity).cost,
      ensureDayModel(ensureDay(state.byDayUtc, dates.utc), identity).cost,
    ]) {
      if (seen.has(target)) continue
      seen.add(target)
      targets.push(target)
    }
    for (const target of targets) addCostAggregateDirection(target, cost, direction)
    // The session digest is a target too: a later removeSession() unwinds from it.
    if (host.aggregation !== undefined && typeof host.aggregation.adjustSessionCostOnly === 'function') host.aggregation.adjustSessionCostOnly(item, cost, direction)
  }
  function usedPricingModels(tierSchedules = null, temporalSchedules = null, detailed = false) {
    const rows = []
    const seen = new Set()
    const scheduleIds = new Map()
    const scheduleIdFor = (tiers) => {
      if (!Array.isArray(tierSchedules) || tiers.length === 0) return null
      const key = JSON.stringify(tiers)
      const existing = scheduleIds.get(key)
      if (existing !== undefined) return existing
      const id = 'tier-' + tierSchedules.length
      scheduleIds.set(key, id)
      tierSchedules.push({ id, tiers: tiers.map((tier) => ({ ...tier })) })
      return id
    }
    // Peak/off-peak plans are shared by every route priced from the same entry,
    // so they travel once per distinct plan exactly like tier schedules do.
    const temporalIds = new Map()
    const temporalScheduleIdFor = (profile) => {
      if (!Array.isArray(temporalSchedules) || profile === null || typeof profile !== 'object') return null
      const policies = Array.isArray(profile.policies) ? profile.policies : []
      if (policies.length === 0) return null
      // Every attached policy carries the hash of its own content, so the plan
      // identity is a cheap join instead of a full serialization per row
      // (falling back to JSON when a hash is missing).
      const key = policies.every((policy) => typeof policy.policyHash === 'string' && policy.policyHash !== '')
        ? policies.map((policy) => policy.policyId + ':' + policy.policyHash).join('|')
        : JSON.stringify(policies)
      const existing = temporalIds.get(key)
      if (existing !== undefined) return existing
      const id = 'temporal-' + temporalSchedules.length
      temporalIds.set(key, id)
      temporalSchedules.push({ id, policies: policies.map((policy) => ({ ...policy })) })
      return id
    }
    const providerKey = (value) => (typeof value === 'string' ? value.trim().toLowerCase() : '')
    // Route identity keys are JSON tuples; rebuilding the exact tuple keeps a
    // synthetic row on the same resolution-cache entry a real usage row uses.
    const parseIdentityKey = (identityKey) => {
      if (typeof identityKey !== 'string' || identityKey === '') return null
      let parsed = null
      try { parsed = JSON.parse(identityKey) } catch (err) { return null }
      if (!Array.isArray(parsed) || parsed.length !== 4) return null
      const textOrNull = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null)
      return { provider: textOrNull(parsed[0]), requestedModel: textOrNull(parsed[1]), actualModel: textOrNull(parsed[2]), legacyLabel: textOrNull(parsed[3]) }
    }
    // The price edit target of a row: the entry that is actually in effect. A
    // priced row edits its resolved entry, an unpriced row gets a new
    // provider-agnostic manual entry keyed by its own model id.
    const basisKeyFor = (identity, resolved) => {
      const priced = resolved.status === 'priced' && typeof resolved.pricingModel === 'string' && resolved.pricingModel !== ''
      const modelId = priced ? resolved.pricingModel : (identity.actualModel || identity.requestedModel || resolved.pricingModel || identity.label || '')
      const provider = priced ? resolved.providerId || '' : ''
      return providerKey(provider) + '\u0000' + normalizeModelId(modelId)
    }
    const coveredBases = new Set()
    const rowOf = (identity, resolved, options = {}) => {
      const tiers = Array.isArray(resolved.tiers) ? resolved.tiers : []
      const tierScheduleId = resolved.tiered === true ? scheduleIdFor(tiers) : null
      const temporalScheduleId = detailed ? temporalScheduleIdFor(resolved.temporalProfile) : null
      coveredBases.add(basisKeyFor(identity, resolved))
      return {
        identityKey: typeof options.identityKey === 'string' ? options.identityKey : identity.identityKey,
        provider: identity.provider,
        requestedModel: identity.requestedModel,
        actualModel: identity.actualModel,
        model: typeof options.model === 'string' && options.model !== '' ? options.model : identity.label,
        status: resolved.status,
        reason: resolved.reason || '',
        pricingModel: resolved.pricingModel || null,
        providerId: resolved.providerId || null,
        source: resolved.source || 'none',
        currency: resolved.currency || 'USD',
        rates: resolved.rates || null,
        tiered: resolved.tiered === true,
        tierCount: tiers.length,
        ...(tierScheduleId === null ? {} : { tierScheduleId }),
        tieredInvalid: resolved.tieredInvalid === true,
        inputTokenSemantics: resolved.inputTokenSemantics || 'fresh',
        multiplier: resolved.multiplier || '1',
        temporalExplicit: resolved.temporalExplicit === true,
        temporalBuiltin: resolved.temporalBuiltin === true,
        temporalConfigInvalid: resolved.temporalConfigInvalid === true,
        ...(detailed ? { usageBacked: options.usageBacked === true } : {}),
        ...(temporalScheduleId === null ? {} : { temporalScheduleId }),
        ...(resolved.temporalRoute !== undefined && resolved.temporalRoute !== null ? { temporalRoute: resolved.temporalRoute } : {}),
        ...(resolved.temporalProfile && Array.isArray(resolved.temporalProfile.policies) && resolved.temporalProfile.policies.length > 0 ? { temporalPolicyId: String(resolved.temporalProfile.policies[0].policyId || ''), temporalTimezone: resolved.temporalProfile.policies[0].timezone === 'UTC' ? 'UTC' : null } : {}),
      }
    }
    for (const item of state.usageByStep.values()) {
      const identity = coerceIdentity(item.identity || item.modelId)
      if (seen.has(identity.identityKey)) continue
      seen.add(identity.identityKey)
      rows.push(rowOf(identity, resolveCurrentPricing(identity), { usageBacked: true }))
      if (rows.length >= MAX_PRICING_ROWS) break
    }
    if (detailed) {
      // Configured rows the ledger never saw: an override or an
      // identity-scoped mapping would otherwise become invisible and
      // un-editable in the merged price table.
      for (const mapping of state.pricingState.mappings) {
        if (rows.length >= MAX_PRICING_ROWS) break
        const identityKey = typeof mapping.identityKey === 'string' ? mapping.identityKey.trim() : ''
        if (identityKey === '' || seen.has(identityKey)) continue
        seen.add(identityKey)
        const parsed = parseIdentityKey(identityKey)
        const provider = parsed !== null ? parsed.provider : (mapping.provider === '' ? null : mapping.provider)
        const model = parsed !== null ? (parsed.actualModel || parsed.requestedModel || parsed.legacyLabel) : (mapping.model !== '' ? mapping.model : (mapping.catalogModelId === '' ? null : mapping.catalogModelId))
        const identity = {
          identityKey,
          provider,
          requestedModel: parsed !== null ? parsed.requestedModel : model,
          actualModel: parsed !== null ? parsed.actualModel : null,
          label: (provider === null ? '' : provider + ' / ') + (model === null || model === '' ? identityKey : model),
          legacy: parsed !== null && parsed.legacyLabel !== null && parsed.provider === null && parsed.requestedModel === null && parsed.actualModel === null,
        }
        rows.push(rowOf(identity, resolveCurrentPricing(identity), { identityKey, model: identity.label, usageBacked: false }))
      }
      for (const entry of state.pricingState.overrides) {
        if (rows.length >= MAX_PRICING_ROWS) break
        const key = providerKey(entry.providerId) + '\u0000' + normalizeModelId(entry.modelId)
        if (coveredBases.has(key)) continue
        coveredBases.add(key)
        // A non-JSON key: it can never collide with a real route key (those are
        // always JSON tuples), so a configured row cannot poison the shared
        // resolution cache the way a constant key would.
        const identity = {
          identityKey: 'override:' + key,
          provider: entry.providerId === '' ? null : entry.providerId,
          requestedModel: entry.modelId,
          actualModel: null,
          label: entry.displayName || entry.modelId,
          legacy: false,
        }
        rows.push(rowOf(identity, resolveCurrentPricing(identity), { identityKey: '', model: entry.displayName || entry.modelId, usageBacked: false }))
      }
    }
    rows.sort((left, right) => {
      if (left.usageBacked !== right.usageBacked) return left.usageBacked === true ? -1 : 1
      return String(left.model).localeCompare(String(right.model))
    })
    return rows
  }
  function pricingModelSearch(query, limit = 20) {
    const raw = typeof query === 'string' ? query.trim().toLowerCase() : ''
    if (raw === '') return []
    const normalized = raw.replace(/\s+/g, ' ')
    const selected = new Map()
    for (const entry of state.pricingState.catalogEntries) {
      const official = officialProviderIds(entry.modelId)
      if (!official.has(String(entry.providerId || '').toLowerCase())) continue
      const modelId = entry.modelId.toLowerCase()
      const displayName = String(entry.displayName || '').toLowerCase()
      if (!modelId.includes(normalized) && !displayName.includes(normalized)) continue
      const score = modelId === normalized ? 0 : modelId.startsWith(normalized) ? 1 : displayName.startsWith(normalized) ? 2 : 3
      const previous = selected.get(entry.modelId)
      // The mapping column previews the target price before saving, so the
      // search result must carry the rates and the built-in peak/off-peak
      // capability (never the whole catalog entry).
      if (previous === undefined || score < previous.score) selected.set(entry.modelId, {
        value: entry.modelId,
        label: entry.displayName,
        providerId: entry.providerId,
        providerName: entry.providerName || '',
        tiered: entry.tiered === true,
        tierCount: Array.isArray(entry.tiers) ? entry.tiers.length : 0,
        rates: { input: entry.input, output: entry.output, cacheRead: entry.cacheRead, cacheWrite: entry.cacheWrite },
        builtinTemporal: builtinTemporalProfileFor(entry.modelId) !== null,
        score,
      })
    }
    return Array.from(selected.values()).sort((a, b) => a.score - b.score || a.value.localeCompare(b.value)).slice(0, Math.max(1, Math.min(50, Number.isInteger(limit) ? limit : 20))).map(({ score, ...entry }) => entry)
  }
  // The route list only changes when the ledger or the pricing state changes, and
  // building it walks every usage row (~65k here) plus the resolution of each
  // route. The cache keeps the last revision's result, so the per-refresh pricing
  // snapshot and the detail table stop paying that walk.
  let usedModelsCache = { key: '', rows: null }
  function usedPricingModelsCached(tierSchedules, temporalSchedules, detailed) {
    const key = String(state.dataRevision) + ':' + String(state.pricingRevision) + (detailed ? ':d' : ':s')
    if (usedModelsCache.rows !== null && usedModelsCache.key === key) {
      // The schedules travel with the rows; a cached result hands back its own
      // copies so a caller cannot mutate them.
      if (detailed) {
        tierSchedules.push(...usedModelsCache.tierSchedules.map((entry) => ({ id: entry.id, tiers: entry.tiers.map((tier) => ({ ...tier })) })))
        temporalSchedules.push(...usedModelsCache.temporalSchedules.map((entry) => ({ id: entry.id, policies: entry.policies.map((policy) => ({ ...policy })) })))
      }
      return usedModelsCache.rows
    }
    const rows = usedPricingModels(tierSchedules, temporalSchedules, detailed)
    usedModelsCache = {
      key,
      rows,
      tierSchedules: detailed ? tierSchedules.map((entry) => ({ id: entry.id, tiers: entry.tiers.map((tier) => ({ ...tier })) })) : [],
      temporalSchedules: detailed ? temporalSchedules.map((entry) => ({ id: entry.id, policies: entry.policies.map((policy) => ({ ...policy })) })) : [],
    }
    return rows
  }
  function pricingSnapshot(options = {}) {
    const pricingStateSnapshot = state.pricingState
    const detailed = options.detailed !== false
    const tierSchedules = detailed ? [] : null
    const temporalSchedules = detailed ? [] : null
    const snapshot = {
      schemaVersion: pricingStateSnapshot.schemaVersion,
      source: { ...pricingStateSnapshot.source },
      sync: { ...pricingStateSnapshot.sync },
      catalogModelCount: pricingStateSnapshot.catalogEntries.length,
      overrideCount: pricingStateSnapshot.overrides.length,
      mappingCount: pricingStateSnapshot.mappings.length,
      configured: pricingStateSnapshot.catalogEntries.length > 0 || pricingStateSnapshot.overrides.length > 0 || pricingStateSnapshot.mappings.length > 0,
      usedModels: usedPricingModelsCached(tierSchedules, temporalSchedules, detailed),
      cost: serializeCostAggregate(state.totals.cost),
    }
    if (detailed) {
      snapshot.config = {
        sync: { ...pricingStateSnapshot.sync },
        mappings: pricingStateSnapshot.mappings.map((mapping) => ({ ...mapping })),
        // providerId and the peak/off-peak plan must round-trip: dropping
        // providerId would turn a provider-scoped manual price into a
        // provider-agnostic one on the next save (and would stop it from
        // being found as a mapping target).
        overrides: pricingStateSnapshot.overrides.map((entry) => ({
          ...entry,
          ...(Array.isArray(entry.tiers) ? { tiers: entry.tiers.map((tier) => ({ ...tier })) } : {}),
          ...(entry.temporalPricing === undefined ? {} : { temporalPricing: JSON.parse(JSON.stringify(entry.temporalPricing)) }),
        })),
      }
      snapshot.tierSchedules = tierSchedules
      snapshot.temporalSchedules = temporalSchedules
    }
    return snapshot
  }
  async function loadPricing() {
    if (storage === undefined || storage.backend === undefined || typeof storage.backend.get !== 'function') return
    try {
      const backend = storage.backend.get('json')
      if (backend === undefined || backend === null || backend.kv === undefined) return
      const unit = await backend.kv.open({ name: 'all_usage_pricing', version: 0, tables: [], hasGlobal: true })
      if (state.disposed) { await unit.close().catch(() => {}); return }
      state.pricingUnit = unit
      const snapshot = await unit.loadAll()
      const global = snapshot && snapshot.global
      const raw = global && typeof global === 'object' && global.pricing !== undefined ? global.pricing : global
      state.pricingState = normalizePricingState(raw)
      state.pricingResolutionCache.clear()
    } catch (err) {
      console.error('[all-usage] pricing catalog unavailable:', err)
    }
  }
  function persistPricing() {
    if (state.disposed) return state.pricingWriteChain
    const payload = { pricing: serializePricingState(state.pricingState) }
    state.pricingWriteChain = state.pricingWriteChain.then(async () => {
      if (state.pricingUnit === null || state.pricingUnit === undefined) return
      await state.pricingUnit.setGlobal(payload)
    })
    state.pricingWriteChain = state.pricingWriteChain.catch((err) => {
      console.error('[all-usage] pricing persist failed:', err)
    })
    return state.pricingWriteChain
  }
  function syncPricing(force = false) {
    return serializePricingMutation(() => syncPricingOnce(force))
  }
  async function syncPricingOnce(force) {
    await Promise.all([state.pricingReady, state.ledgerReady])
    if (state.pricingSyncInFlight) return { ok: false, message: 'pricing-sync-in-progress', pricing: pricingSnapshot() }
    const now = Date.now()
    if (!force && state.pricingState.sync.lastSuccessAt > 0 && now - state.pricingState.sync.lastSuccessAt < state.pricingState.sync.intervalMs) return { ok: true, skipped: true, pricing: pricingSnapshot() }
    state.pricingSyncInFlight = true
    state.pricingState.sync.lastAttemptAt = now
    try {
      const result = await fetchModelsDevCatalog()
      if (!result.ok) {
        state.pricingState.source.lastError = result.error
        state.pricingState.sync.lastError = result.error
        // A failed attempt changes only sync health, not any configured price,
        // so it must not invalidate the query snapshot/records caches.
        markStatsChanged('sync-health')
        await persistPricing()
        return { ok: false, message: result.error, pricing: pricingSnapshot() }
      }
      const previousHash = state.pricingState.source && state.pricingState.source.catalogHash !== undefined ? String(state.pricingState.source.catalogHash) : ''
      state.pricingState = normalizePricingState({
        ...serializePricingState(state.pricingState),
        source: { url: result.catalog.sourceUrl, fetchedAt: result.catalog.fetchedAt, catalogHash: result.catalog.catalogHash, lastError: '' },
        sync: { ...state.pricingState.sync, lastSuccessAt: result.catalog.fetchedAt, lastError: '' },
        catalogEntries: result.catalog.entries,
      })
      state.pricingResolutionCache.clear()
      const backfill = await backfillUnpricedCosts()
      const temporal = await reconcileTemporalPricing()
      // Only catalog changes, newly priced usage, or temporal snapshot
      // reconciliation can alter computed costs; a successful sync with an
      // unchanged catalog must not invalidate the query snapshot, scoped caches,
      // or records cursors. The sync-health bump still rebuilds the snapshot
      // cache so lastSuccessAt is not stale on the next full response.
      if (String(result.catalog.catalogHash || '') !== previousHash || backfill.priced > 0 || temporal.reconciled > 0) markStatsChanged('pricing')
      else markStatsChanged('sync-health')
      await persistPricing()
      await drainLedgerWrites()
      return { ok: true, skipped: false, backfill, pricing: pricingSnapshot() }
    } finally {
      state.pricingSyncInFlight = false
      schedulePricingSync()
    }
  }
  // A cost rewrite must update both the cubes and its durable ledger item.
  const usageIndexCache = new WeakMap()
  function usageIndexFor(record) {
    if (record === undefined || !Array.isArray(record.usage)) return new Map()
    let index = usageIndexCache.get(record)
    if (index === undefined || index.size !== record.usage.length) {
      index = new Map()
      for (const stored of record.usage) if (stored !== null && typeof stored === 'object') index.set(stored.key, stored)
      usageIndexCache.set(record, index)
    }
    return index
  }
  /** Visit one session at a time, reading its record only when it is needed. */
  async function visitPricingRows(visitor, includeEvicted = false) {
    const generation = state.aggregationGeneration
    const sessions = new Set()
    for (const item of state.usageByStep.values()) if (typeof item.sid === 'string') sessions.add(item.sid)
    if (includeEvicted && state.perSession instanceof Map) for (const sid of state.perSession.keys()) sessions.add(sid)
    for (const sid of sessions) {
      const task = async () => {
        const releaseRecord = host.ledger?.pinRecord?.(sid)
        try {
          if (state.disposed || generation !== state.aggregationGeneration) return
          const record = host.ledger !== undefined && typeof host.ledger.recordFor === 'function'
            ? await host.ledger.recordFor(sid)
            : state.ledgerRecords.get(sid)
          if (state.disposed || generation !== state.aggregationGeneration) return
          const digest = state.perSession instanceof Map ? state.perSession.get(sid) : undefined
          const durableRecord = record !== undefined && record !== null && record.__durableRecord !== undefined ? record.__durableRecord : record
          const storedItems = usageIndexFor(durableRecord)
          const residentItems = record === durableRecord ? storedItems : usageIndexFor(record)
          const keys = includeEvicted && digest !== undefined
            ? Array.from(digest.keys.keys())
            : Array.from(state.usageByStep.values()).filter((item) => item.sid === sid).map((item) => item.key)
          let changed = false
          let published = false
          for (const key of keys) {
            const stored = storedItems.get(key)
            let item = state.usageByStep.get(key)
            if (item === undefined && includeEvicted && stored !== undefined && record !== undefined) {
              item = host.ledger.adoptableRow(host.aggregation.usageRowOf(record, stored, 'ledger-reuse'))
            }
            if (item === undefined) continue
            if (visitor(item) !== true) continue
            // Queries must observe the revision as soon as costs change, including
            // the await while the new durable record is being persisted.
            if (!published) { markStatsChanged('pricing'); published = true }
            if (stored !== undefined) {
              stored.cost = item.cost
              const residentItem = residentItems.get(key)
              if (residentItem !== undefined) residentItem.cost = item.cost
              changed = true
            }
          }
          if (changed && durableRecord !== undefined) {
            durableRecord.version = LEDGER_VERSION
            durableRecord.updatedAt = nextLedgerRevision()
            if (record !== durableRecord) { record.version = durableRecord.version; record.updatedAt = durableRecord.updatedAt }
            // Keep upgrade evidence until a complete source-log rebuild clears it.
            const stillMixed = durableRecord.turns.some((turn) => turn && turn.workspaceId !== durableRecord.workspaceId) || durableRecord.usage.some((item) => item && item.workspaceId !== durableRecord.workspaceId)
            durableRecord.needsUpgrade = stillMixed || durableRecord.rebuildRequired !== undefined
            await persistLedgerRecord(durableRecord)
          }
        } finally {
          releaseRecord?.()
        }
      }
      if (host.sessionSync !== undefined && typeof host.sessionSync.enqueue === 'function') await host.sessionSync.enqueue(sid, task)
      else await task()
    }
  }
  async function backfillUnpricedCosts() {
    let considered = 0
    let priced = 0
    await visitPricingRows((item) => {
      const oldCost = normalizeCostSnapshot(item.cost)
      if (oldCost !== null && oldCost.pricingMode === 'official-model' && oldCost.status === 'priced') return false
      considered += 1
      const billing = billingInstantOf(item, oldCost)
      const next = calculateCost(item.values, resolveCurrentPricing(item.identity || item.modelId), billing.at, billing.source)
      const temporalFailClosed = next.status === 'unsupported' && typeof next.reason === 'string' && next.reason.startsWith('temporal-')
      if (next.status !== 'priced' && !temporalFailClosed) return false
      if (costSnapshotEquivalent(oldCost, next)) return false
      if (oldCost !== null) {
        adjustCostOnly(item, oldCost, -1)
        adjustQueryCost(item, oldCost, -1)
      }
      item.cost = next
      adjustCostOnly(item, next, 1)
      adjustQueryCost(item, next, 1)
      priced += 1
      return true
    }, true)
    return { considered, priced, remaining: state.totals.cost.unpricedCalls + state.totals.cost.ambiguousCalls + state.totals.cost.unsupportedCalls }
  }
  function costSnapshotEquivalent(left, right) {
    if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false
    if (left.schemaVersion !== right.schemaVersion || left.status !== right.status || left.currency !== right.currency || left.pricingModel !== right.pricingModel || left.providerId !== right.providerId || left.inputTokenSemantics !== right.inputTokenSemantics || left.multiplier !== right.multiplier || left.billableInputTokens !== right.billableInputTokens || left.billableOutputTokens !== right.billableOutputTokens || left.baseTotal !== right.baseTotal || left.total !== right.total || left.reason !== right.reason || left.tiered !== right.tiered || left.contextTokens !== right.contextTokens || left.pricingAt !== right.pricingAt || left.pricingTimeSource !== right.pricingTimeSource || left.pricingBand !== right.pricingBand || left.pricingHoliday !== right.pricingHoliday || left.pricingPolicyId !== right.pricingPolicyId || left.pricingPolicyHash !== right.pricingPolicyHash || left.pricingTimezone !== right.pricingTimezone || left.temporalApplicable !== right.temporalApplicable || left.temporalExemptReason !== right.temporalExemptReason) return false
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) {
      if (left.breakdown !== null && left.breakdown !== undefined && right.breakdown !== null && right.breakdown !== undefined) {
        if (left.breakdown[key] !== right.breakdown[key]) return false
      }
      if (left.rates[key] !== right.rates[key] || right.rates[key] === undefined) return false
    }
    const leftTier = left.selectedTier || null
    const rightTier = right.selectedTier || null
    if (leftTier === null !== (rightTier === null)) return false
    if (leftTier !== null && (leftTier.type !== rightTier.type || leftTier.size !== rightTier.size)) return false
    return true
  }
  function snapshotPolicyMatches(rawCost, resolved) {
    const exemptReason = rawCost.temporalExemptReason
    const route = resolved.temporalRoute
    if (exemptReason === 'route-not-official') return route !== 'official' && route !== 'mapped'
    if (exemptReason === 'no-temporal-profile' && resolved.temporalProfile === undefined && resolved.temporalConfigInvalid !== true) return true
    if (typeof rawCost.pricingPolicyId !== 'string' || typeof rawCost.pricingPolicyHash !== 'string') return false
    const policies = resolved.temporalProfile && Array.isArray(resolved.temporalProfile.policies) ? resolved.temporalProfile.policies : []
    if (!policies.some((policy) => policy.policyId === rawCost.pricingPolicyId && policy.policyHash === rawCost.pricingPolicyHash)) return false
    const plan = temporalPlanFor(resolved, rawCost.pricingAt)
    if (plan.status !== 'applied') return false
    return plan.policyHash === rawCost.pricingPolicyHash && plan.band === rawCost.pricingBand
  }
  /** Preserve event-time snapshots on catalog refresh; reprice all rows only on demand. */
  async function reconcileTemporalPricing(options = {}) {
    const force = options.force === true
    let considered = 0
    let reconciled = 0
    await visitPricingRows((item) => {
      const rawCost = item.cost
      if (rawCost === null || rawCost === undefined || typeof rawCost !== 'object' || rawCost.pricingMode !== 'official-model') return false
      const identity = coerceIdentity(item.identity || item.modelId)
      const resolved = resolveCurrentPricing(identity)
      const route = resolved.temporalRoute
      if (route !== 'official' && route !== 'mapped') return false
      const legacyShape = rawCost.schemaVersion !== COST_SCHEMA_VERSION || rawCost.pricingTimeSource === null || rawCost.pricingTimeSource === undefined || rawCost.pricingTimeSource === 'legacy-unknown'
      const contextTimes = state.sessionContextTimes.get(item.sid)
      const ownStamp = contextTimes !== undefined && Number.isFinite(rawCost.pricingAt)
        && contextTimes.get(contextTimeKey(item.turn, item.step)) === rawCost.pricingAt
      const staleInstant = rawCost.pricingTimeSource === 'request-context' && Number.isFinite(rawCost.pricingAt) && validEventTime(item.time)
        && !ownStamp && !contextTimeIsFresh(rawCost.pricingAt, item.time)
      if (!legacyShape && !force && !staleInstant) {
        if (rawCost.status === 'priced' && snapshotPolicyMatches(rawCost, resolved)) return false
        if (rawCost.status !== 'priced') return false
      }
      considered += 1
      const oldCost = normalizeCostSnapshot(rawCost)
      const billing = billingInstantOf(item, oldCost, !staleInstant)
      const next = calculateCost(item.values, resolved, billing.at, billing.source)
      if (costSnapshotEquivalent(oldCost, next) && rawCost.schemaVersion === next.schemaVersion) return false
      if (oldCost !== null) {
        adjustCostOnly(item, oldCost, -1)
        adjustQueryCost(item, oldCost, -1)
      }
      item.cost = next
      adjustCostOnly(item, next, 1)
      adjustQueryCost(item, next, 1)
      reconciled += 1
      return true
    }, true)
    return { considered, reconciled }
  }
  function updatePricingState(raw, backfill, repriceTemporal = false) {
    return serializePricingMutation(() => updatePricingStateOnce(raw, backfill, repriceTemporal))
  }
  async function updatePricingStateOnce(raw, backfill, repriceTemporal) {
    const input = raw && typeof raw === 'object' && raw.pricing && typeof raw.pricing === 'object' ? raw.pricing : raw
    const current = serializePricingState(state.pricingState)
    const merged = { ...current, ...(input && typeof input === 'object' ? input : {}) }
    if (input && typeof input === 'object' && input.sync && typeof input.sync === 'object' && !Array.isArray(input.sync)) merged.sync = { ...current.sync, ...input.sync }
    state.pricingState = normalizePricingState(merged)
    state.pricingResolutionCache.clear()
    const result = backfill === true ? await backfillUnpricedCosts() : { considered: 0, priced: 0, remaining: state.totals.cost.unpricedCalls + state.totals.cost.ambiguousCalls + state.totals.cost.unsupportedCalls }
    const temporal = await reconcileTemporalPricing({ force: repriceTemporal === true })
    markStatsChanged('pricing')
    schedulePricingSync()
    return { ...result, temporalReconciled: temporal.reconciled }
  }
  /**
   * Fetch one year of the Chinese holiday arrangement for the editor. Nothing is
   * persisted here: the panel freezes the returned dates into a pricing policy,
   * which is what makes later reconciliation reproducible.
   */
  async function loadHolidayCalendar(year) {
    const cache = state.holidayCache instanceof Map ? state.holidayCache : (state.holidayCache = new Map())
    const key = String(Number(year))
    const cached = cache.get(key)
    if (cached !== undefined && Date.now() - cached.fetchedAt < HOLIDAY_CALENDAR_TTL_MS) return { ok: true, cached: true, ...cached }
    const result = await fetchHolidayCalendar(year)
    if (!result.ok) return result
    const entry = {
      year: result.calendar.year,
      dates: result.calendar.dates,
      paperUrl: result.calendar.paperUrl,
      sourceUrl: result.calendar.sourceUrl,
      fetchedAt: result.calendar.fetchedAt,
    }
    cache.set(key, entry)
    return { ok: true, cached: false, ...entry }
  }
  function schedulePricingSync() {
    if (state.pricingSyncTimer !== null) { clearTimeout(state.pricingSyncTimer); state.pricingSyncTimer = null }
    if (state.disposed || state.pricingState.sync.autoEnabled !== true) return
    const elapsed = state.pricingState.sync.lastSuccessAt > 0 ? Date.now() - state.pricingState.sync.lastSuccessAt : state.pricingState.sync.intervalMs
    const delay = Math.max(0, state.pricingState.sync.intervalMs - elapsed)
    state.pricingSyncTimer = setTimeout(() => {
      state.pricingSyncTimer = null
      void syncPricing(true)
    }, delay)
    if (state.pricingSyncTimer && typeof state.pricingSyncTimer.unref === 'function') state.pricingSyncTimer.unref()
  }


  return {
    adjustCostOnly,
    usedPricingModels,
    pricingModelSearch,
    pricingSnapshot,
    loadPricing,
    persistPricing,
    syncPricing,
    backfillUnpricedCosts,
    reconcileTemporalPricing,
    updatePricingState,
    schedulePricingSync,
    loadHolidayCalendar
  }
}
