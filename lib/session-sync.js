import { contextTimeKey, extractUsageEvent, pickPricingTime, touchContextTimes, workspacePathKey } from './usage-core.js'

const RECONCILE_INTERVAL_MS = 120000
const RECONCILE_HINT_DELAY_MS = 3000
const WORKSPACE_SYNC_DEBOUNCE_MS = 300

export function createSessionSync(host) {
  const { ctx, state } = host
  const { sessionPersistence } = host.services
  const {
    validEventTime,
    identityFromRoute,
    identityFromMessage,
    coerceIdentity,
    addTurn,
    addUsage,
    resetAggregationState,
  } = host.aggregation
  const { beginSync, noteSyncError, markStatsChanged } = host
  const {
    sessionEvents,
    buildLedgerRecord,
    applyLedgerRecord,
    storeLedgerRecord,
    replaceLedgerRecord,
    persistLedgerRecord,
    drainLedgerWrites,
  } = host.ledger
  const backfillUnpricedCosts = (...args) => host.pricing.backfillUnpricedCosts(...args)
  const reconcileTemporalPricing = (...args) => host.pricing.reconcileTemporalPricing(...args)
  const safeContextTimeout = async (ms) => {
    if (state.disposed) return false
    try {
      await ctx.timeout(ms)
      return !state.disposed
    } catch (err) {
      if (!state.disposed) console.error('[all-usage] context timer unavailable:', err)
      return false
    }
  }

  function foldEvent(wsId, time, type, data, sid, seq, materialization = 'live') {
    if ((type === 'turn/end' || type === 'assistant/message' || type === 'assistant/chunk') && !validEventTime(time)) return
    if (type === 'request/context') {
      state.sessionModel.set(sid, identityFromRoute(data, state.sessionModel.get(sid)))
      if (validEventTime(time)) {
        let times = state.sessionContextTimes.get(sid)
        if (times === undefined) { times = new Map(); state.sessionContextTimes.set(sid, times) }
        touchContextTimes(times, contextTimeKey(data && data.turn, data && data.step), time)
      }
    } else if (type === 'request/header') {
      state.sessionModel.set(sid, identityFromRoute(data, state.sessionModel.get(sid)))
    } else if (type === 'turn/end') {
      addTurn(wsId, time, sid, data && typeof data.turn === 'number' ? data.turn : null, state.sessionModel.get(sid), materialization, seq)
    } else if (type === 'assistant/message' || type === 'assistant/chunk') {
      const usageEvent = extractUsageEvent({ type, time, data, seq })
      if (usageEvent === null) return
      const identity = usageEvent.kind === 'message' ? identityFromMessage(data, state.sessionModel.get(sid)) : coerceIdentity(state.sessionModel.get(sid))
      state.sessionModel.set(sid, identity)
      const pricing = pickPricingTime(state.sessionContextTimes.get(sid), time, usageEvent.turn, usageEvent.step)
      addUsage(wsId, time, usageEvent.usage, identity, sid, data, seq, materialization, pricing.time, pricing.source)
    }
  }
  function foldEvents(wsId, events, fromSeq, sid, materialization = 'scan') {
    // Full folds keep their callers responsible for atomicity: runBaseline and
    // syncLiveSession remove the session's old usage/turn/context/identity
    // first when the snapshot is authoritative (see rebuildSession below), so
    // usage deleted by a history rewrite disappears from the aggregate.
    for (const ev of events) {
      if (fromSeq !== undefined) {
        const s = typeof ev.seq === 'number' ? ev.seq : -1
        if (s <= fromSeq) continue
      }
      if (ev.type === 'turn/end' || ev.type === 'assistant/message' || ev.type === 'assistant/chunk' || ev.type === 'request/context' || ev.type === 'request/header') foldEvent(wsId, ev.time, ev.type, ev.data, sid, ev.seq, materialization)
    }
  }
  function lastSeqOf(events) {
    let last = -1
    for (const ev of events) {
      const s = Number.isSafeInteger(ev.seq) ? ev.seq : -1
      if (s > last) last = s
    }
    return last
  }
  function sequenceProfile(events) {
    let previous = -1
    let last = -1
    let nonMonotonic = false
    let hasInvalid = false
    for (const ev of events) {
      const seq = ev && Number.isSafeInteger(ev.seq) && ev.seq >= 0 ? ev.seq : -1
      if (seq < 0) { hasInvalid = true; continue }
      if (seq <= previous) nonMonotonic = true
      previous = seq
      if (seq > last) last = seq
    }
    return { lastSeq: last, nonMonotonic, hasInvalid }
  }
  function enqueue(sid, task) {
    const prev = state.chains.get(sid) || Promise.resolve()
    const next = prev.then(() => task(), () => task())
    state.chains.set(sid, next)
    const cleanup = () => { if (state.chains.get(sid) === next) state.chains.delete(sid) }
    void next.then(cleanup, cleanup)
    return next
  }
  function markLedgerDirty(sid) {
    if (typeof sid !== 'string' || sid === '') return
    state.ledgerDirtySessions.add(sid)
    state.ledgerDirtyEpochs.set(sid, (state.ledgerDirtyEpochs.get(sid) || 0) + 1)
  }
  function buildWorkspaceSnapshot(workspaces) {
    const wsMeta = new Map()
    const pathIndex = new Map()
    const memberOf = new Map()
    for (const w of workspaces) {
      const id = w && w.id
      const path = w && typeof w.path === 'string' ? w.path : ''
      const title = w && typeof w.title === 'string' ? w.title : ''
      if (id === undefined) continue
      wsMeta.set(id, { id, title, path })
      if (path !== '') pathIndex.set(workspacePathKey(path), id)
      if (w && Array.isArray(w.sessionIds)) {
        for (const sid of w.sessionIds) memberOf.set(sid, id)
      }
    }
    return { wsMeta, pathIndex, memberOf }
  }
  function installWorkspaceSnapshot(next) {
    let metadataChanged = state.wsMeta.size !== next.wsMeta.size || state.pathIndex.size !== next.pathIndex.size || state.memberOf.size !== next.memberOf.size
    if (!metadataChanged) {
      for (const [id, value] of next.wsMeta) {
        const previous = state.wsMeta.get(id)
        if (previous === undefined || previous.title !== value.title || previous.path !== value.path) { metadataChanged = true; break }
      }
    }
    if (!metadataChanged) {
      for (const [path, id] of next.pathIndex) if (state.pathIndex.get(path) !== id) { metadataChanged = true; break }
    }
    if (!metadataChanged) {
      for (const [sid, id] of next.memberOf) if (state.memberOf.get(sid) !== id) { metadataChanged = true; break }
    }
    state.wsMeta.clear()
    state.pathIndex.clear()
    state.memberOf.clear()
    for (const [id, value] of next.wsMeta) state.wsMeta.set(id, value)
    for (const [path, id] of next.pathIndex) state.pathIndex.set(path, id)
    for (const [sid, id] of next.memberOf) state.memberOf.set(sid, id)
    if (metadataChanged) markStatsChanged('metadata')
    return metadataChanged
  }
  function workspaceForCwd(cwd) {
    if (typeof cwd !== 'string' || cwd === '') return undefined
    return state.pathIndex.get(workspacePathKey(cwd))
  }
  function wsForLiveSession(session, sid) {
    let wsId = state.memberOf.get(sid)
    if (wsId !== undefined) return wsId
    const header = session && session.header
    const cwd = header && typeof header.cwd === 'string' ? header.cwd : ''
    wsId = workspaceForCwd(cwd)
    if (wsId !== undefined) state.memberOf.set(sid, wsId)
    return wsId
  }
  function cancelLiveResync(sid) {
    const timer = state.liveResyncTimers.get(sid)
    if (timer !== undefined) {
      clearTimeout(timer)
      state.liveResyncTimers.delete(sid)
    }
    state.liveResyncAttempts.delete(sid)
    state.liveResyncPending.delete(sid)
  }
  function scheduleLiveResync(sid, wsId, generation) {
    if (state.disposed || generation !== state.aggregationGeneration || !state.liveResyncPending.has(sid) || state.liveResyncTimers.has(sid)) return
    const attempt = state.liveResyncAttempts.get(sid) || 0
    const delay = Math.min(30000, 1000 * Math.pow(2, Math.min(attempt, 5)))
    const timer = setTimeout(() => {
      state.liveResyncTimers.delete(sid)
      if (state.disposed || generation !== state.aggregationGeneration || !state.liveResyncPending.has(sid)) return
      void enqueue(sid, () => resyncLiveSession(sid, wsId, generation))
    }, delay)
    state.liveResyncTimers.set(sid, timer)
    if (timer && typeof timer.unref === 'function') timer.unref()
  }
  function foldLiveFallback(sid, wsId, event) {
    if (event === null || event === undefined) return
    const seq = Number.isSafeInteger(event.seq) && event.seq >= 0 ? event.seq : -1
    foldEvent(wsId, event.time, event.type, event.data, sid, seq, 'live')
    if (seq >= 0) {
      const current = state.sessionSeq.get(sid)
      if (current === undefined || seq > current) state.sessionSeq.set(sid, seq)
    }
    state.sessionCount.add(sid)
  }
  async function syncLiveSession(sid, wsId, event, generation) {
    try {
      const snap = await ctx.sessionQuery.readSession(sid)
      if (state.disposed || generation !== state.aggregationGeneration) return true
      if (snap && Array.isArray(snap.events)) {
        const snapshotLast = lastSeqOf(snap.events)
        const snapshotProfile = sequenceProfile(snap.events)
        const eventSeq = event === null || event === undefined ? -1 : (Number.isSafeInteger(event.seq) && event.seq >= 0 ? event.seq : -1)
        // The snapshot may replace the session only when it is provably
        // complete AND it already contains the triggering event: a timer / full
        // resync (no event), or an explicitly contained, monotonic event
        // stream. A snapshot that merely has a higher tail than the event is
        // NOT proof — the event could be a live append the snapshot missed (or
        // the snapshot could have been rewritten without it), so the event is
        // upserted and the session stays pending for a follow-up alignment.
        // Events without a usable seq never trigger a destructive replacement.
        const containsEvent = event !== null && event !== undefined && eventSeq >= 0 && snap.events.some((candidate) => candidate && Number.isSafeInteger(candidate.seq) && candidate.seq === eventSeq)
        const authoritative = event === null || event === undefined ? true : eventSeq < 0 ? false : containsEvent && !snapshotProfile.nonMonotonic && !snapshotProfile.hasInvalid
        if (authoritative) {
          host.aggregation.removeSession(sid)
          // The authoritative snapshot is the new truth for both the in-memory
          // aggregate and the durable ledger: rebuild the record from scratch
          // and persist it, so a restart after a live history rewrite cannot
          // resurrect usage that the snapshot deleted.
          const rebuiltRecord = buildLedgerRecord({ id: sid, events: snap.events }, wsId, 'scan', undefined, null, true)
          if (rebuiltRecord !== null) {
            const canonical = replaceLedgerRecord(rebuiltRecord)
            if (canonical === rebuiltRecord) {
              void persistLedgerRecord(rebuiltRecord).then(() => {
                if (state.ledgerWriteFailedSessions && state.ledgerWriteFailedSessions.has(sid)) {
                  console.error('[all-usage] authoritative resync ledger persist failed; session stays dirty:', sid)
                  noteSyncError('resync-ledger-persist-failed')
                }
              })
            }
          }
        }
        foldEvents(wsId, snap.events, undefined, sid, 'live')
        let nextLast = snapshotLast
        const needsFollowup = !authoritative && event !== null && event !== undefined
        if (needsFollowup) {
          foldLiveFallback(sid, wsId, event)
          const current = state.sessionSeq.get(sid)
          nextLast = Math.max(nextLast, current === undefined ? -1 : current)
        }
        state.sessionSeq.set(sid, nextLast)
        state.sessionCount.add(sid)
        if (needsFollowup) {
          // The snapshot is behind: keep the pending flag so the follow-up
          // resync realigns the cursor once the missing history arrives.
          scheduleLiveResync(sid, wsId, generation)
        } else {
          state.liveResyncPending.delete(sid)
          cancelLiveResync(sid)
        }
        return true
      }
    } catch (err) {
      // Keep the event as a fallback and retry a complete session state.sync later.
    }
    return false
  }
  async function resyncLiveSession(sid, wsId, generation) {
    if (state.disposed || generation !== state.aggregationGeneration || !state.liveResyncPending.has(sid)) return
    if (await syncLiveSession(sid, wsId, null, generation)) return
    state.liveResyncAttempts.set(sid, (state.liveResyncAttempts.get(sid) || 0) + 1)
    scheduleLiveResync(sid, wsId, generation)
  }
  async function processLiveEvent(sid, wsId, event, generation = state.aggregationGeneration) {
    if (state.disposed || generation !== state.aggregationGeneration) return
    const seq = Number.isSafeInteger(event.seq) ? event.seq : -1
    const last = state.sessionSeq.get(sid)
    const needsSync = last === undefined || state.liveResyncPending.has(sid) || (seq >= 0 && seq > last + 1)
    if (needsSync) {
      state.liveResyncPending.add(sid)
      if (await syncLiveSession(sid, wsId, event, generation)) return
      foldLiveFallback(sid, wsId, event)
      state.liveResyncAttempts.set(sid, (state.liveResyncAttempts.get(sid) || 0) + 1)
      scheduleLiveResync(sid, wsId, generation)
      return
    }
    if (seq < 0) {
      foldLiveFallback(sid, wsId, event)
      return
    }
    if (seq <= last) return
    foldLiveFallback(sid, wsId, event)
  }

  // ---------- durable usage ledger ----------
  function scheduleNativeBaselineRetry(generation, delay) {
    if (state.disposed || state.baselineFallbackTimer !== null) return
    state.baselineFallbackTimer = setTimeout(() => {
      state.baselineFallbackTimer = null
      if (!state.disposed && generation === state.aggregationGeneration && !state.scan.started && !state.scan.done) void runBaseline(generation)
    }, delay)
    if (state.baselineFallbackTimer && typeof state.baselineFallbackTimer.unref === 'function') state.baselineFallbackTimer.unref()
  }
  function scheduleBaselineRetry(generation = state.aggregationGeneration) {
    if (state.disposed || state.baselineRetryScheduled || state.scan.done || generation !== state.aggregationGeneration) return
    state.baselineRetryScheduled = true
    const delay = state.baselineRetryDelay
    state.baselineRetryDelay = Math.min(state.baselineRetryDelay * 2, 30000)
    void safeContextTimeout(delay).then((ready) => {
      if (generation !== state.aggregationGeneration) return undefined
      state.baselineRetryScheduled = false
      if (ready && !state.scan.started && !state.scan.done) return runBaseline(generation)
      if (!ready && !state.disposed) scheduleNativeBaselineRetry(generation, delay)
      return undefined
    })
  }
  function scanOneSession(sid, record, wsId, generation, snapshots) {
    return enqueue(sid, async () => {
      if (state.disposed || generation !== state.aggregationGeneration) return
      try {
        if (state.sessionSeq.has(sid) && !state.liveResyncPending.has(sid)) return
        // v1.0.8: when the persisted log revision is unchanged since the last ledger
        // write, the whole readSession (full event transfer) is skipped — the ledger
        // record is applied directly and the live feed keeps catching new events.
        const previousRecord = state.ledgerRecords.get(sid)
        const revision = snapshots === null ? undefined : snapshots.get(sid)
        if (!state.liveResyncPending.has(sid) && previousRecord !== undefined && previousRecord.needsUpgrade !== true && previousRecord.rebuildRequired === undefined && previousRecord.workspaceId === wsId && typeof previousRecord.lastRevision === 'string' && typeof revision === 'string' && revision === previousRecord.lastRevision) {
          state.sync.sessionsSkippedByRevision += 1
          applyLedgerRecord(previousRecord, 'ledger-reuse')
          state.sessionSeq.set(sid, previousRecord.lastSeq)
          state.sessionCount.add(sid)
          markStatsChanged('scan')
          return
        }
        state.sync.sessionsRead += 1
        markStatsChanged('scan')
        const snap = await ctx.sessionQuery.readSession(sid)
        if (state.disposed || generation !== state.aggregationGeneration) return
        if (snap && Array.isArray(snap.events)) {
          // v1.0.7: incremental seed — the durable ledger doubles as a per-session
          // cursor (cc-switch session_log_sync mtime+offset parity). An unchanged
          // session applies its canonical record directly and never re-folds;
          // a changed session seeds the previous record once, then folds only the
          // new tail (previously every listed session was re-read and fully rebuilt).
          const sequence = sequenceProfile(snap.events)
          const currentLastSeq = sequence.lastSeq
          const previous = state.ledgerRecords.get(sid)
          const canFoldTail = previous !== undefined && previous.needsUpgrade !== true && previous.rebuildRequired === undefined && previous.workspaceId === wsId && !sequence.nonMonotonic && !sequence.hasInvalid && previous.lastSeq >= 0 && currentLastSeq > previous.lastSeq
          if (canFoldTail) {
            applyLedgerRecord(previous, 'ledger-reuse')
            foldEvents(wsId, snap.events, previous.lastSeq, sid, 'scan')
          } else {
            // A changed revision with no new tail may still contain a replacement;
            // rebuild from the complete read instead of trusting lastSeq alone.
            foldEvents(wsId, snap.events, undefined, sid, 'scan')
          }
          const ledger = buildLedgerRecord({ id: sid, header: record.header, events: snap.events }, wsId, 'scan', revision, previous, !sequence.hasInvalid)
          const canonical = ledger === null ? state.ledgerRecords.get(sid) : (canFoldTail ? storeLedgerRecord(ledger) : replaceLedgerRecord(ledger))
          if (canonical === ledger) {
            void persistLedgerRecord(ledger)
          }
          const observedLastSeq = state.sessionSeq.get(sid)
          const nextLastSeq = Math.max(currentLastSeq, observedLastSeq === undefined ? -1 : observedLastSeq)
          state.sessionSeq.set(sid, nextLastSeq)
          state.sessionCount.add(sid)
          if (observedLastSeq === undefined || observedLastSeq <= currentLastSeq) cancelLiveResync(sid)
          else scheduleLiveResync(sid, wsId, generation)
        }
      } catch (err) {
        if (generation !== state.aggregationGeneration) return
        state.sync.sessionsFailed += 1
        state.scan.failed += 1
        noteSyncError('session-read-failed')
        const saved = state.ledgerRecords.get(sid)
        if (saved !== undefined) {
          applyLedgerRecord(saved, 'ledger-recovery')
          if (saved.turns.length > 0 || saved.usage.length > 0) state.sync.sessionsRestoredFromLedger += 1
          state.sessionSeq.set(sid, -1)
          state.sessionCount.add(sid)
        } else {
          state.sessionSeq.set(sid, -1)
        }
      } finally {
        if (generation === state.aggregationGeneration) {
          state.scan.scanned += 1
          markStatsChanged('scan')
        }
      }
    })
  }

  async function runBaseline(generation = state.aggregationGeneration) {
    if (state.scan.started || state.disposed || generation !== state.aggregationGeneration) return
    state.scan.started = true
    beginSync()
    await Promise.all([state.ledgerReady, state.pricingReady])
    if (state.disposed || generation !== state.aggregationGeneration) return
    let setupFailed = false
    try {
      const workspaces = ctx.workspaceRegistry.list()
      installWorkspaceSnapshot(buildWorkspaceSnapshot(workspaces))
    } catch (err) {
      console.error('[all-usage] workspace list failed:', err)
      setupFailed = true
      noteSyncError('workspace-list-failed')
    }
    let records = null
    try {
      records = await ctx.sessionQuery.listSessions()
    } catch (err) {
      console.error('[all-usage] session list failed:', err)
      if (state.disposed || generation !== state.aggregationGeneration) return
      noteSyncError('session-list-failed')
    }
    if (state.disposed || generation !== state.aggregationGeneration) return
    // v1.0.8: cheap per-session change signal (header line + stat, no full-log read)
    let snapshots = null
    if (sessionPersistence !== undefined && typeof sessionPersistence.listSnapshots === 'function') {
      try {
        const rows = await sessionPersistence.listSnapshots()
        if (state.disposed || generation !== state.aggregationGeneration) return
        if (Array.isArray(rows)) {
          state.sync.persistenceSnapshotsAvailable = true
          snapshots = new Map()
          for (const row of rows) {
            const rid = row && row.header && typeof row.header.id === 'string' ? row.header.id : undefined
            if (rid !== undefined && row && typeof row.revision === 'string') snapshots.set(rid, row.revision)
          }
        }
      } catch (err) {
        console.error('[all-usage] session persistence snapshots unavailable:', err)
        if (state.disposed || generation !== state.aggregationGeneration) return
        state.sync.persistenceSnapshotsAvailable = false
        markStatsChanged('scan')
      }
    }
    if (state.disposed || generation !== state.aggregationGeneration) return
    if (setupFailed || !Array.isArray(records)) {
      // A transient registry failure must not be reported as a completed empty state.scan.
      state.scan.started = false
      markStatsChanged('scan')
      scheduleBaselineRetry(generation)
      return
    }
    state.scan.total = records.length
    state.sync.sessionsTotal = records.length
    markStatsChanged('scan')
    const listedSessionIds = new Set()
    for (const record of records) {
      if (record === undefined || record === null || record.header === undefined) continue
      const sid = record.header.id
      const cwd = typeof record.header.cwd === 'string' ? record.header.cwd : ''
      const wsId = workspaceForCwd(cwd)
      if (sid !== undefined && wsId !== undefined) listedSessionIds.add(sid)
    }
    for (const [sid, record] of state.ledgerRecords) {
      if (!listedSessionIds.has(sid)) {
        // A ledger row from a deleted cwd is stale historical data, not an
        // active workspace. Registered records remain recoverable; unknown
        // records are recovered only while their source cwd still exists. Old
        // synthetic rows predate sourceCwd persistence and cannot be validated,
        // so they are fail-closed rather than resurrected after a restart.
        if (record.sourceCwd !== undefined && workspaceForCwd(record.sourceCwd) === undefined) continue
        if (typeof record.workspaceId === 'string' && record.workspaceId.startsWith('unregistered:')) continue
        applyLedgerRecord(record, 'ledger-recovery')
        if (record.turns.length > 0 || record.usage.length > 0) state.sync.sessionsRestoredFromLedger += 1
      }
    }
    if (state.sync.sessionsRestoredFromLedger > 0) markStatsChanged('scan')
    for (const record of records) {
      if (state.disposed || generation !== state.aggregationGeneration) return
      if (record === undefined || record === null || record.header === undefined) {
        state.scan.scanned += 1
        markStatsChanged('scan')
        continue
      }
      const sid = record.header.id
      const cwd = typeof record.header.cwd === 'string' ? record.header.cwd : ''
      const wsId = workspaceForCwd(cwd)
      if (sid === undefined || wsId === undefined) {
        state.scan.scanned += 1
        markStatsChanged('scan')
        continue
      }
      listedSessionIds.add(sid)
      await scanOneSession(sid, record, wsId, generation, snapshots)
      if (!(await safeContextTimeout(0))) {
        state.scan.started = false
        noteSyncError('baseline-yield-unavailable')
        scheduleBaselineRetry(generation)
        return
      }
    }
    if (state.disposed || generation !== state.aggregationGeneration) return
    await drainLedgerWrites()
    if (state.disposed || generation !== state.aggregationGeneration) return
    const costBackfill = backfillUnpricedCosts()
    if (costBackfill.priced > 0) {
      await drainLedgerWrites()
      markStatsChanged('pricing')
    }
    if (state.disposed || generation !== state.aggregationGeneration) return
    const temporalReconcile = reconcileTemporalPricing()
    if (temporalReconcile.reconciled > 0) {
      await drainLedgerWrites()
      markStatsChanged('pricing')
    }
    if (state.disposed || generation !== state.aggregationGeneration) return
    state.knownSessionIds.clear()
    for (const sid of listedSessionIds) state.knownSessionIds.add(sid)
    state.scan.done = true
    state.sync.lastCompletedAt = Date.now()
    if (state.sync.sessionsFailed === 0) {
      state.sync.lastErrorAt = 0
      state.sync.lastErrorCode = null
    }
    markStatsChanged('scan')
    if (state.reconcilePending) scheduleReconcileHint()
  }

  function scheduleWorkspaceSync() {
    if (state.disposed) return
    if (state.workspaceSyncTimer !== null) return
    state.workspaceSyncTimer = setTimeout(() => {
      state.workspaceSyncTimer = null
      if (!state.disposed) void runWorkspaceSync()
    }, WORKSPACE_SYNC_DEBOUNCE_MS)
    if (state.workspaceSyncTimer && typeof state.workspaceSyncTimer.unref === 'function') state.workspaceSyncTimer.unref()
  }
  async function runWorkspaceSync() {
    if (state.disposed) return
    if (state.workspaceSyncInFlight) {
      state.workspaceSyncPending = true
      return
    }
    state.workspaceSyncInFlight = true
    try {
      await synchronizeWorkspaceRegistry()
    } catch (err) {
      console.error('[all-usage] workspace synchronize failed:', err)
      noteSyncError('workspace-sync-failed')
    } finally {
      state.workspaceSyncInFlight = false
      if (state.workspaceSyncPending) {
        state.workspaceSyncPending = false
        scheduleWorkspaceSync()
      }
    }
  }
  async function synchronizeWorkspaceRegistry() {
    // The first baseline reads the registry with the latest list, so a probe
    // arriving before it completes has nothing to add.
    if (state.disposed || !state.scan.done) return
    let workspaces
    try {
      workspaces = ctx.workspaceRegistry.list()
    } catch (err) {
      console.error('[all-usage] workspace list failed:', err)
      noteSyncError('workspace-list-failed')
      return
    }
    const next = buildWorkspaceSnapshot(workspaces)
    const removedWs = new Set()
    for (const id of state.wsMeta.keys()) if (!next.wsMeta.has(id)) removedWs.add(id)
    const addedWs = new Set()
    for (const id of next.wsMeta.keys()) if (!state.wsMeta.has(id)) addedWs.add(id)
    // Reuse path: no membership change — metadata only, zero rescan.
    if (removedWs.size === 0 && addedWs.size === 0) {
      installWorkspaceSnapshot(next)
      return
    }
    // Remove path: subtract every session that belonged to a deregistered workspace.
    if (removedWs.size > 0) {
      const removedSids = new Set()
      for (const [sid, record] of state.ledgerRecords) {
        if (record !== null && record !== undefined && typeof record.workspaceId === 'string' && removedWs.has(record.workspaceId)) removedSids.add(sid)
      }
      for (const [sid, id] of state.memberOf) if (removedWs.has(id)) removedSids.add(sid)
      for (const sid of removedSids) {
        if (typeof sid !== 'string' || sid === '') continue
        host.aggregation.removeSession(sid)
        state.ledgerRecords.delete(sid)
        state.knownSessionIds.delete(sid)
        state.sessionCount.delete(sid)
        state.sessionSeq.delete(sid)
        state.sessionModel.delete(sid)
        state.sessionContextTimes.delete(sid)
        state.memberOf.delete(sid)
        state.liveResyncPending.delete(sid)
        cancelLiveResync(sid)
      }
      for (const id of removedWs) {
        state.perWorkspace.delete(id)
        for (const day of state.byDay.values()) day.byWs.delete(id)
        for (const day of state.byDayUtc.values()) day.byWs.delete(id)
      }
    }
    installWorkspaceSnapshot(next)
    // Add path: scan only the sessions that belong to newly registered workspaces.
    if (addedWs.size === 0) return
    let records = null
    try {
      records = await ctx.sessionQuery.listSessions()
    } catch (err) {
      console.error('[all-usage] session list failed:', err)
      noteSyncError('session-list-failed')
    }
    if (!Array.isArray(records)) return
    state.sync.sessionsTotal = records.length
    markStatsChanged('scan')
    let snapshots = null
    if (sessionPersistence !== undefined && typeof sessionPersistence.listSnapshots === 'function') {
      try {
        const rows = await sessionPersistence.listSnapshots()
        if (Array.isArray(rows)) {
          snapshots = new Map()
          for (const row of rows) {
            const rid = row && row.header && typeof row.header.id === 'string' ? row.header.id : undefined
            if (rid !== undefined && row && typeof row.revision === 'string') snapshots.set(rid, row.revision)
          }
        }
      } catch (err) {
        console.error('[all-usage] session persistence snapshots unavailable:', err)
        markStatsChanged('scan')
      }
    }
    for (const record of records) {
      if (state.disposed) return
      if (record === undefined || record === null || record.header === undefined) continue
      const sid = record.header.id
      const cwd = typeof record.header.cwd === 'string' ? record.header.cwd : ''
      const wsId = workspaceForCwd(cwd)
      if (sid === undefined || wsId === undefined) continue
      if (!addedWs.has(wsId)) continue
      state.knownSessionIds.add(sid)
      scanOneSession(sid, record, wsId, state.aggregationGeneration, snapshots)
    }
  }

  function sessionIdsFromRecords(records) {
    const ids = new Set()
    for (const record of records) {
      if (record === undefined || record === null || record.header === undefined) continue
      const sid = record.header.id
      const cwd = typeof record.header.cwd === 'string' ? record.header.cwd : ''
      const wsId = workspaceForCwd(cwd)
      if (sid !== undefined && wsId !== undefined) ids.add(sid)
    }
    return ids
  }
  async function reconcileSessions() {
    if (state.disposed || state.reconcileInFlight || !state.scan.done) return
    state.reconcilePending = false
    state.reconcileInFlight = true
    try {
      const records = await ctx.sessionQuery.listSessions()
      if (state.disposed || !Array.isArray(records)) return
      const currentIds = sessionIdsFromRecords(records)
      let removed = false
      for (const sid of state.knownSessionIds) {
        if (!currentIds.has(sid)) { removed = true; break }
      }
      if (removed && !state.disposed && state.scan.done) {
        console.info('[all-usage] session removal detected; rebuilding usage index')
        const generation = resetAggregationState()
        void runBaseline(generation)
        return
      }
      state.knownSessionIds.clear()
      for (const sid of currentIds) state.knownSessionIds.add(sid)
    } catch (err) {
      console.error('[all-usage] session reconciliation failed:', err)
      noteSyncError('session-reconcile-failed')
    } finally {
      state.reconcileInFlight = false
      if (state.reconcilePending && !state.disposed) scheduleReconcileHint()
    }
  }
  function scheduleReconcileHint() {
    if (state.disposed) return
    state.reconcilePending = true
    if (state.reconcileHintScheduled || state.reconcileInFlight) return
    state.reconcileHintScheduled = true
    const generation = state.aggregationGeneration
    void safeContextTimeout(RECONCILE_HINT_DELAY_MS).then((ready) => {
      if (generation !== state.aggregationGeneration) return
      state.reconcileHintScheduled = false
      if (ready && !state.disposed) void reconcileSessions()
    }, () => {
      if (generation === state.aggregationGeneration) state.reconcileHintScheduled = false
    })
  }
  function scheduleReconcileTimer() {
    if (state.disposed || state.reconcileTimer !== null) return
    state.reconcileTimer = setTimeout(() => {
      state.reconcileTimer = null
      if (!state.disposed) {
        void reconcileSessions()
        scheduleReconcileTimer()
      }
    }, RECONCILE_INTERVAL_MS)
    if (state.reconcileTimer && typeof state.reconcileTimer.unref === 'function') state.reconcileTimer.unref()
  }

  // ---------- live feed ----------
  ctx.on('session/event', (session, event) => {
    if (state.disposed) return
    if (event === undefined || event === null) return
    const type = event.type
    if (type !== 'turn/end' && type !== 'assistant/message' && type !== 'assistant/chunk' && type !== 'request/context' && type !== 'request/header') return
    const sid = session && session.id
    if (typeof sid !== 'string') return
    markLedgerDirty(sid)
    const wsId = wsForLiveSession(session, sid)
    if (wsId === undefined) return
    const generation = state.aggregationGeneration
    state.knownSessionIds.add(sid)
    enqueue(sid, () => processLiveEvent(sid, wsId, event, generation))
  })
  ctx.on('session/flush', async (session) => {
    if (state.disposed || session === null || typeof session !== 'object' || typeof session.id !== 'string') return
    const sid = session.id
    const previous = state.ledgerRecords.get(sid)
    const eventList = sessionEvents(session)
    // DSH sequences events with seq === log index: the tail event gives the
    // latest sequence in O(1) without scanning a 500K-event session twice.
    const tailEvent = eventList.length > 0 ? eventList[eventList.length - 1] : null
    const currentLastSeq = tailEvent !== null && Number.isSafeInteger(tailEvent.seq) && tailEvent.seq >= 0 ? tailEvent.seq : lastSeqOf(eventList)
    const hasNewEvents = state.ledgerDirtySessions.has(sid) || state.ledgerWriteFailedSessions.has(sid) || (previous === undefined && currentLastSeq >= 0) || (previous !== undefined && currentLastSeq > previous.lastSeq)
    if (!hasNewEvents) return
    const dirtyEpoch = state.ledgerDirtyEpochs.get(sid) || 0
    await Promise.all([state.ledgerReady, state.pricingReady])
    if (state.disposed) return
    const wsId = wsForLiveSession(session, sid)
    if (wsId === undefined) return
    // Any dirty flush whose log contains invalid sequences may have rewritten
    // history (even when a new tail was appended) or carries contract-external
    // events; refuse to fold it and rebuild the whole usage index instead, so
    // the in-memory aggregate and the persisted ledger cannot disagree.
    if (previous !== undefined && eventList.length > 0) {
      const sequence = sequenceProfile(eventList)
      if (sequence.hasInvalid) {
        if (state.scan.done && !state.disposed) {
          console.info('[all-usage] invalid sequences in flushed log; rebuilding usage index')
          // Persist the rebuild flag so the baseline cannot fast-path the stale
          // record (the persistence revision may still match a lagging log).
          const current = state.ledgerRecords.get(sid)
          if (current !== undefined) {
            current.rebuildRequired = 'invalid-flush-sequence'
            current.needsUpgrade = true
            void persistLedgerRecord(current)
          }
          const generation = resetAggregationState()
          void runBaseline(generation)
        }
        return
      }
    }
    const ledger = buildLedgerRecord(session, wsId, 'flush', undefined, previous)
    if (ledger === null) return
    const canonical = storeLedgerRecord(ledger)
    if (canonical === ledger) void persistLedgerRecord(ledger)
    if (state.ledgerDirtyEpochs.get(sid) === dirtyEpoch) {
      state.ledgerDirtySessions.delete(sid)
      state.ledgerDirtyEpochs.delete(sid)
    }
  })
  ctx.on('session/disposed', () => {
    if (!state.disposed) scheduleReconcileHint()
  })
  // Workspace registry probe: DSH emits domain/changed after every durable
  // workspace-domain write (create/delete/rename/reorder/archive/attach/detach).
  // On any such change we re-read workspaceRegistry.list() and, when membership
  // changed, rescan only the affected workspaces — unchanged ones keep their
  // computed aggregates and ledger untouched.
  ctx.on('domain/changed', (change) => {
    if (state.disposed) return
    if (change === undefined || change === null) return
    if (change.domain !== 'workspace') return
    if (change.table !== 'workspaces' && change.table !== '') return
    scheduleWorkspaceSync()
  })

  return {
    foldEvent,
    foldEvents,
    lastSeqOf,
    sequenceProfile,
    enqueue,
    wsForLiveSession,
    cancelLiveResync,
    scheduleLiveResync,
    foldLiveFallback,
    syncLiveSession,
    resyncLiveSession,
    processLiveEvent,
    scheduleNativeBaselineRetry,
    scheduleBaselineRetry,
    runBaseline,
    synchronizeWorkspaceRegistry,
    scheduleWorkspaceSync,
    sessionIdsFromRecords,
    reconcileSessions,
    scheduleReconcileHint,
    scheduleReconcileTimer,
    markLedgerDirty
  }
}
