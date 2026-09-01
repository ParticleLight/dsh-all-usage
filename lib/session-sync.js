import { extractUsageEvent } from './usage-core.js'

const RECONCILE_INTERVAL_MS = 120000
const RECONCILE_HINT_DELAY_MS = 3000

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
    buildLedgerRecord,
    applyLedgerRecord,
    storeLedgerRecord,
    replaceLedgerRecord,
    persistLedgerRecord,
    drainLedgerWrites,
  } = host.ledger
  const backfillUnpricedCosts = (...args) => host.pricing.backfillUnpricedCosts(...args)
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
    if (type === 'request/context' || type === 'request/header') {
      state.sessionModel.set(sid, identityFromRoute(data, state.sessionModel.get(sid)))
    } else if (type === 'turn/end') {
      addTurn(wsId, time, sid, data && typeof data.turn === 'number' ? data.turn : null, state.sessionModel.get(sid), materialization, seq)
    } else if (type === 'assistant/message' || type === 'assistant/chunk') {
      const usageEvent = extractUsageEvent({ type, time, data, seq })
      if (usageEvent === null) return
      const identity = usageEvent.kind === 'message' ? identityFromMessage(data, state.sessionModel.get(sid)) : coerceIdentity(state.sessionModel.get(sid))
      state.sessionModel.set(sid, identity)
      addUsage(wsId, time, usageEvent.usage, identity, sid, data, seq, materialization)
    }
  }
  function foldEvents(wsId, events, fromSeq, sid, materialization = 'scan') {
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
    for (const ev of events) {
      const seq = ev && Number.isSafeInteger(ev.seq) ? ev.seq : -1
      if (seq < 0) continue
      if (seq <= previous) nonMonotonic = true
      previous = seq
      if (seq > last) last = seq
    }
    return { lastSeq: last, nonMonotonic }
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
  function wsForLiveSession(session, sid) {
    let wsId = state.memberOf.get(sid)
    if (wsId !== undefined) return wsId
    const header = session && session.header
    const cwd = header && typeof header.cwd === 'string' ? header.cwd : ''
    if (cwd === '') return undefined
    wsId = state.pathIndex.get(cwd)
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
        const previousLast = state.sessionSeq.get(sid)
        const previousLastSafe = Number.isSafeInteger(previousLast) && previousLast >= 0 ? previousLast : -1
        const snapshotLast = lastSeqOf(snap.events)
        foldEvents(wsId, snap.events, undefined, sid, 'live')
        let nextLast = Math.max(previousLastSafe, snapshotLast)
        const eventSeq = event === null || event === undefined ? -1 : (Number.isSafeInteger(event.seq) && event.seq >= 0 ? event.seq : -1)
        const needsFollowup = event !== null && event !== undefined && (eventSeq < 0 || eventSeq > snapshotLast)
        if (needsFollowup) {
          foldLiveFallback(sid, wsId, event)
          const current = state.sessionSeq.get(sid)
          nextLast = Math.max(nextLast, current === undefined ? -1 : current)
        }
        state.sessionSeq.set(sid, nextLast)
        state.sessionCount.add(sid)
        if (needsFollowup) scheduleLiveResync(sid, wsId, generation)
        else cancelLiveResync(sid)
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
  async function runBaseline(generation = state.aggregationGeneration) {
    if (state.scan.started || state.disposed || generation !== state.aggregationGeneration) return
    state.scan.started = true
    beginSync()
    await Promise.all([state.ledgerReady, state.pricingReady])
    if (state.disposed || generation !== state.aggregationGeneration) return
    let setupFailed = false
    try {
      const workspaces = ctx.workspaceRegistry.list()
      const nextWsMeta = new Map()
      const nextPathIndex = new Map()
      const nextMemberOf = new Map()
      for (const w of workspaces) {
        const id = w && w.id
        const path = w && typeof w.path === 'string' ? w.path : ''
        const title = w && typeof w.title === 'string' ? w.title : ''
        if (id === undefined) continue
        nextWsMeta.set(id, { id, title, path })
        if (path !== '') nextPathIndex.set(path, id)
        if (w && Array.isArray(w.sessionIds)) {
          for (const sid of w.sessionIds) nextMemberOf.set(sid, id)
        }
      }
      let metadataChanged = state.wsMeta.size !== nextWsMeta.size || state.pathIndex.size !== nextPathIndex.size || state.memberOf.size !== nextMemberOf.size
      if (!metadataChanged) {
        for (const [id, value] of nextWsMeta) {
          const previous = state.wsMeta.get(id)
          if (previous === undefined || previous.title !== value.title || previous.path !== value.path) { metadataChanged = true; break }
        }
      }
      if (!metadataChanged) {
        for (const [path, id] of nextPathIndex) if (state.pathIndex.get(path) !== id) { metadataChanged = true; break }
      }
      if (!metadataChanged) {
        for (const [sid, id] of nextMemberOf) if (state.memberOf.get(sid) !== id) { metadataChanged = true; break }
      }
      state.wsMeta.clear()
      state.pathIndex.clear()
      state.memberOf.clear()
      for (const [id, value] of nextWsMeta) state.wsMeta.set(id, value)
      for (const [path, id] of nextPathIndex) state.pathIndex.set(path, id)
      for (const [sid, id] of nextMemberOf) state.memberOf.set(sid, id)
      if (metadataChanged) markStatsChanged('metadata')
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
      const wsId = cwd === '' ? undefined : state.pathIndex.get(cwd)
      if (sid !== undefined && wsId !== undefined) listedSessionIds.add(sid)
    }
    for (const [sid, record] of state.ledgerRecords) {
      if (!listedSessionIds.has(sid)) {
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
      const wsId = cwd === '' ? undefined : state.pathIndex.get(cwd)
      if (sid === undefined || wsId === undefined) {
        state.scan.scanned += 1
        markStatsChanged('scan')
        continue
      }
      listedSessionIds.add(sid)
      await enqueue(sid, async () => {
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
            const canFoldTail = previous !== undefined && previous.needsUpgrade !== true && previous.rebuildRequired === undefined && previous.workspaceId === wsId && !sequence.nonMonotonic && previous.lastSeq >= 0 && currentLastSeq > previous.lastSeq
            if (canFoldTail) {
              applyLedgerRecord(previous, 'ledger-reuse')
              foldEvents(wsId, snap.events, previous.lastSeq, sid, 'scan')
            } else {
              // A changed revision with no new tail may still contain a replacement;
              // rebuild from the complete read instead of trusting lastSeq alone.
              foldEvents(wsId, snap.events, undefined, sid, 'scan')
            }
            const ledger = buildLedgerRecord({ id: sid, header: record.header, events: snap.events }, wsId, 'scan', revision, previous)
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

  function sessionIdsFromRecords(records) {
    const ids = new Set()
    for (const record of records) {
      if (record === undefined || record === null || record.header === undefined) continue
      const sid = record.header.id
      const cwd = typeof record.header.cwd === 'string' ? record.header.cwd : ''
      const wsId = cwd === '' ? undefined : state.pathIndex.get(cwd)
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
    const eventList = Array.isArray(session.events) ? session.events : []
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
    sessionIdsFromRecords,
    reconcileSessions,
    scheduleReconcileHint,
    scheduleReconcileTimer,
    markLedgerDirty
  }
}
