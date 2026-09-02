import { COST_SCHEMA_VERSION, calculateCost, fetchModelsDevCatalog, normalizeCostSnapshot, normalizePricingState, officialProviderIds, serializeCostAggregate, serializePricingState, temporalPlanFor } from './pricing.js'
import { billingInstantOf } from './usage-core.js'

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
        ...(resolved.temporalRoute !== undefined && resolved.temporalRoute !== null ? { temporalRoute: resolved.temporalRoute } : {}),
        ...(resolved.temporalProfile && Array.isArray(resolved.temporalProfile.policies) && resolved.temporalProfile.policies.length > 0 ? { temporalPolicyId: String(resolved.temporalProfile.policies[0].policyId || ''), temporalTimezone: resolved.temporalProfile.policies[0].timezone === 'UTC' ? 'UTC' : null } : {}),
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
      const backfill = backfillUnpricedCosts()
      const temporal = reconcileTemporalPricing()
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
  function backfillUnpricedCosts() {
    let considered = 0
    let priced = 0
    const touched = new Set()
    for (const item of state.usageByStep.values()) {
      const oldCost = normalizeCostSnapshot(item.cost)
      if (oldCost !== null && oldCost.pricingMode === 'official-model' && oldCost.status === 'priced') continue
      considered += 1
      const billing = billingInstantOf(item, oldCost)
      const next = calculateCost(item.values, resolveCurrentPricing(item.identity || item.modelId), billing.at, billing.source)
      const temporalFailClosed = next.status === 'unsupported' && typeof next.reason === 'string' && next.reason.startsWith('temporal-')
      // A valid fallback (priced) or a deterministic fail-closed verdict
      // (unsupported: history gap / invalid config) replaces the previous state;
      // merely unresolved pricing stays untouched.
      if (next.status !== 'priced' && !temporalFailClosed) continue
      if (oldCost !== null && oldCost.status === next.status && oldCost.total === next.total && oldCost.baseTotal === next.baseTotal) {
        if (item.cost !== next) {
          item.cost = next
          const record = state.ledgerRecords.get(item.sid)
          if (record !== undefined) {
            const stored = record.usage.find((candidate) => candidate.key === item.key)
            if (stored !== undefined) { stored.cost = next; touched.add(record) }
          }
        }
        continue
      }
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
      // Backfilling prices must not clear a mixed-workspace upgrade flag: stay
      // unfoldable until a rebuild normalizes every historical item.
      const stillMixed = record.turns.some((turn) => turn && turn.workspaceId !== record.workspaceId) || record.usage.some((item) => item && item.workspaceId !== record.workspaceId)
      record.needsUpgrade = stillMixed
      void persistLedgerRecord(record)
    }
    let remaining = 0
    for (const item of state.usageByStep.values()) {
      const cost = normalizeCostSnapshot(item.cost)
      if (cost === null || cost.status !== 'priced') remaining += 1
    }
    return { considered, priced, remaining }
  }
  function costSnapshotEquivalent(left, right) {
    if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false
    if (left.status !== right.status || left.currency !== right.currency || left.pricingModel !== right.pricingModel || left.providerId !== right.providerId || left.inputTokenSemantics !== right.inputTokenSemantics || left.multiplier !== right.multiplier || left.billableInputTokens !== right.billableInputTokens || left.billableOutputTokens !== right.billableOutputTokens || left.baseTotal !== right.baseTotal || left.total !== right.total || left.reason !== right.reason || left.tiered !== right.tiered || left.contextTokens !== right.contextTokens || left.pricingAt !== right.pricingAt || left.pricingTimeSource !== right.pricingTimeSource || left.pricingBand !== right.pricingBand || left.pricingPolicyId !== right.pricingPolicyId || left.pricingPolicyHash !== right.pricingPolicyHash || left.pricingTimezone !== right.pricingTimezone || left.temporalApplicable !== right.temporalApplicable || left.temporalExemptReason !== right.temporalExemptReason) return false
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
  /**
   * Controlled DeepSeek temporal reconciliation with auditable-history semantics:
   * legacy v1 snapshots of first-party DeepSeek routes are migrated against the
   * usage instant once; already-priced v2 snapshots are NEVER rewritten by a
   * catalog refresh (their policy hash intentionally excludes live rates) and
   * only a user-explicit repricing (repriceTemporal) recomputes them. Anything
   * that cannot be verified keeps its previous value (never guess a price).
   * Routes that are not first-party DeepSeek are never touched.
   */
  function snapshotPolicyMatches(rawCost, resolved) {
    const exemptReason = rawCost.temporalExemptReason
    const route = resolved.temporalRoute
    if (exemptReason === 'route-not-official') return route !== 'official' && route !== 'mapped'
    if (exemptReason === 'no-temporal-profile' && resolved.temporalProfile === undefined && resolved.temporalConfigInvalid !== true) return true
    if (typeof rawCost.pricingPolicyId !== 'string' || typeof rawCost.pricingPolicyHash !== 'string') return false
    const policies = resolved.temporalProfile && Array.isArray(resolved.temporalProfile.policies) ? resolved.temporalProfile.policies : []
    if (!policies.some((policy) => policy.policyId === rawCost.pricingPolicyId && policy.policyHash === rawCost.pricingPolicyHash)) return false
    // The snapshot's billing instant must still be covered by (and consistent
    // with) its own policy: an archive that shrank or moved the window leaves
    // the snapshot inside a gap, which must fail closed instead of staying priced.
    const plan = temporalPlanFor(resolved, rawCost.pricingAt)
    if (plan.status !== 'applied') return false
    return plan.policyHash === rawCost.pricingPolicyHash && plan.band === rawCost.pricingBand
  }

  function reconcileTemporalPricing(options = {}) {
    const force = options.force === true
    let considered = 0
    let reconciled = 0
    const touched = new Set()
    for (const item of state.usageByStep.values()) {
      const rawCost = item.cost
      if (rawCost === null || rawCost === undefined || typeof rawCost !== 'object' || rawCost.pricingMode !== 'official-model') continue
      const identity = coerceIdentity(item.identity || item.modelId)
      const resolved = resolveCurrentPricing(identity)
      const route = resolved.temporalRoute
      if (route !== 'official' && route !== 'mapped') continue
      const legacyShape = rawCost.schemaVersion !== COST_SCHEMA_VERSION || rawCost.pricingTimeSource === null || rawCost.pricingTimeSource === undefined || rawCost.pricingTimeSource === 'legacy-unknown'
      if (!legacyShape && !force) {
        // Priced snapshots stay auditable only while their policy (or exempt
        // verdict) still matches the current archive; snapshots priced under a
        // retired policy (e.g. an earlier effective instant) are migrated once.
        if (rawCost.status === 'priced' && snapshotPolicyMatches(rawCost, resolved)) continue
        if (rawCost.status !== 'priced') continue
      }
      considered += 1
      const oldCost = normalizeCostSnapshot(rawCost)
      const billing = billingInstantOf(item, oldCost)
      const next = calculateCost(item.values, resolved, billing.at, billing.source)
      if (costSnapshotEquivalent(oldCost, next)) {
        if (rawCost !== next) {
          item.cost = next
          const record = state.ledgerRecords.get(item.sid)
          if (record !== undefined) {
            const stored = record.usage.find((candidate) => candidate.key === item.key)
            if (stored !== undefined) { stored.cost = next; touched.add(record) }
          }
          reconciled += 1
        }
        continue
      }
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
      reconciled += 1
    }
    for (const record of touched) {
      record.version = LEDGER_VERSION
      record.updatedAt = nextLedgerRevision()
      // Reconciliation must not clear a mixed-workspace upgrade flag: stay
      // unfoldable until a rebuild normalizes every historical item.
      const stillMixed = record.turns.some((turn) => turn && turn.workspaceId !== record.workspaceId) || record.usage.some((item) => item && item.workspaceId !== record.workspaceId)
      record.needsUpgrade = stillMixed
      void persistLedgerRecord(record)
    }
    return { considered, reconciled }
  }

  function updatePricingState(raw, backfill, repriceTemporal = false) {
    const input = raw && typeof raw === 'object' && raw.pricing && typeof raw.pricing === 'object' ? raw.pricing : raw
    const current = serializePricingState(state.pricingState)
    const merged = { ...current, ...(input && typeof input === 'object' ? input : {}) }
    if (input && typeof input === 'object' && input.sync && typeof input.sync === 'object' && !Array.isArray(input.sync)) merged.sync = { ...current.sync, ...input.sync }
    state.pricingState = normalizePricingState(merged)
    state.pricingResolutionCache.clear()
    const result = backfill === true ? backfillUnpricedCosts() : { considered: 0, priced: 0, remaining: state.totals.cost.unpricedCalls + state.totals.cost.ambiguousCalls + state.totals.cost.unsupportedCalls }
    const temporal = reconcileTemporalPricing({ force: repriceTemporal === true })
    markStatsChanged('pricing')
    schedulePricingSync()
    return { ...result, temporalReconciled: temporal.reconciled }
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
    schedulePricingSync
  }
}
