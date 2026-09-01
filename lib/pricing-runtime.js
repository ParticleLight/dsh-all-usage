import { COST_SCHEMA_VERSION, calculateCost, fetchModelsDevCatalog, normalizeCostSnapshot, normalizePricingState, officialProviderIds, serializeCostAggregate, serializePricingState } from './pricing.js'

const LEDGER_VERSION = 3

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
  }
  function usedPricingModels(tierSchedules = null) {
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
    for (const item of state.usageByStep.values()) {
      const identity = coerceIdentity(item.identity || item.modelId)
      if (seen.has(identity.identityKey)) continue
      seen.add(identity.identityKey)
      const resolved = resolveCurrentPricing(identity)
      const tiers = Array.isArray(resolved.tiers) ? resolved.tiers : []
      const tierScheduleId = resolved.tiered === true ? scheduleIdFor(tiers) : null
      rows.push({
        identityKey: identity.identityKey,
        provider: identity.provider,
        requestedModel: identity.requestedModel,
        actualModel: identity.actualModel,
        model: identity.label,
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
      })
      if (rows.length >= 500) break
    }
    rows.sort((a, b) => String(a.model).localeCompare(String(b.model)))
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
      if (previous === undefined || score < previous.score) selected.set(entry.modelId, { value: entry.modelId, label: entry.displayName, providerId: entry.providerId, tiered: entry.tiered === true, tierCount: Array.isArray(entry.tiers) ? entry.tiers.length : 0, score })
    }
    return Array.from(selected.values()).sort((a, b) => a.score - b.score || a.value.localeCompare(b.value)).slice(0, Math.max(1, Math.min(50, Number.isInteger(limit) ? limit : 20))).map(({ score, ...entry }) => entry)
  }
  function pricingSnapshot(options = {}) {
    const pricingStateSnapshot = state.pricingState
    const detailed = options.detailed !== false
    const tierSchedules = detailed ? [] : null
    const snapshot = {
      schemaVersion: pricingStateSnapshot.schemaVersion,
      source: { ...pricingStateSnapshot.source },
      sync: { ...pricingStateSnapshot.sync },
      catalogModelCount: pricingStateSnapshot.catalogEntries.length,
      overrideCount: pricingStateSnapshot.overrides.length,
      mappingCount: pricingStateSnapshot.mappings.length,
      configured: pricingStateSnapshot.catalogEntries.length > 0 || pricingStateSnapshot.overrides.length > 0 || pricingStateSnapshot.mappings.length > 0,
      usedModels: usedPricingModels(tierSchedules),
      cost: serializeCostAggregate(state.totals.cost),
    }
    if (detailed) {
      snapshot.config = {
        sync: { ...pricingStateSnapshot.sync },
        mappings: pricingStateSnapshot.mappings.map((mapping) => ({ ...mapping })),
        overrides: pricingStateSnapshot.overrides.map(({ providerId, ...entry }) => ({ ...entry, ...(Array.isArray(entry.tiers) ? { tiers: entry.tiers.map((tier) => ({ ...tier })) } : {}) })),
      }
      snapshot.tierSchedules = tierSchedules
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
  async function syncPricing(force = false) {
    await state.pricingReady
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
        markStatsChanged('sync-failure')
        await persistPricing()
        return { ok: false, message: result.error, pricing: pricingSnapshot() }
      }
      state.pricingState = normalizePricingState({
        ...serializePricingState(state.pricingState),
        source: { url: result.catalog.sourceUrl, fetchedAt: result.catalog.fetchedAt, catalogHash: result.catalog.catalogHash, lastError: '' },
        sync: { ...state.pricingState.sync, lastSuccessAt: result.catalog.fetchedAt, lastError: '' },
        catalogEntries: result.catalog.entries,
      })
      state.pricingResolutionCache.clear()
      const backfill = backfillUnpricedCosts()
      markStatsChanged('pricing')
      await persistPricing()
      await drainLedgerWrites()
      return { ok: true, skipped: false, backfill, pricing: pricingSnapshot() }
    } finally {
      state.pricingSyncInFlight = false
      schedulePricingSync()
    }
  }
  function backfillUnpricedCosts() {
    let considered = 0
    let priced = 0
    const touched = new Set()
    for (const item of state.usageByStep.values()) {
      const oldCost = normalizeCostSnapshot(item.cost)
      if (oldCost !== null && oldCost.pricingMode === 'official-model' && oldCost.status === 'priced') continue
      considered += 1
      const next = calculateCost(item.values, resolveCurrentPricing(item.identity || item.modelId))
      if (next.status !== 'priced') continue
      if (oldCost !== null) {
        adjustCostOnly(item, oldCost, -1)
        adjustQueryCost(item, oldCost, -1)
      }
      item.cost = next
      adjustCostOnly(item, next, 1)
      adjustQueryCost(item, next, 1)
      const record = state.ledgerRecords.get(item.sid)
      if (record !== undefined) {
        const stored = record.usage.find((candidate) => candidate.key === item.key)
        if (stored !== undefined) { stored.cost = next; touched.add(record) }
      }
      priced += 1
    }
    for (const record of touched) {
      record.version = LEDGER_VERSION
      record.updatedAt = nextLedgerRevision()
      record.needsUpgrade = false
      void persistLedgerRecord(record)
    }
    let remaining = 0
    for (const item of state.usageByStep.values()) {
      const cost = normalizeCostSnapshot(item.cost)
      if (cost === null || cost.status !== 'priced') remaining += 1
    }
    return { considered, priced, remaining }
  }
  function updatePricingState(raw, backfill) {
    const input = raw && typeof raw === 'object' && raw.pricing && typeof raw.pricing === 'object' ? raw.pricing : raw
    const current = serializePricingState(state.pricingState)
    const merged = { ...current, ...(input && typeof input === 'object' ? input : {}) }
    if (input && typeof input === 'object' && input.sync && typeof input.sync === 'object' && !Array.isArray(input.sync)) merged.sync = { ...current.sync, ...input.sync }
    state.pricingState = normalizePricingState(merged)
    state.pricingResolutionCache.clear()
    const result = backfill === true ? backfillUnpricedCosts() : { considered: 0, priced: 0, remaining: state.totals.cost.unpricedCalls + state.totals.cost.ambiguousCalls + state.totals.cost.unsupportedCalls }
    markStatsChanged('pricing')
    schedulePricingSync()
    return result
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
    updatePricingState,
    schedulePricingSync
  }
}
