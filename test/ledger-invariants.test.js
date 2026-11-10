// Invariants of the usage ledger: properties that must hold however the event log
// is folded, split, deleted or migrated. They run against the real lib/ledger.js
// and lib/aggregation.js (no module under test is stubbed out); the host glue is
// the one lib/plugin.js builds, so a regression in either module has to show up here.
//
// Every invariant has a matching 'negative control: ...' test that proves the
// assertion above it can go red. Those controls tamper with the evidence on purpose
// instead of trusting that the assertion is not vacuous.
import assert from 'node:assert/strict'
import test from 'node:test'
import { RETIRED_WORKSPACE_ID } from '../lib/ledger.js'
import {
  LEDGER_META_KEY,
  LEDGER_SHARD_COUNT,
  LEDGER_UNIT_NAME,
  createInvariantHost,
  createLedgerBackend,
  createTempRoot,
  ledgerMetaRelativePath,
  ledgerShardUnitName,
  removeTempRoot,
  shardIndexOf,
} from './support/ledger-invariants.js'

const BASE_TIME = Date.parse('2026-10-13T08:00:00Z')

function contextEvent(seq, time, provider, model, turn, step) {
  return { seq, time, type: 'request/context', data: { provider, model, turn, step } }
}

function turnEndEvent(seq, time, turn) {
  return { seq, time, type: 'turn/end', data: { turn } }
}

function messageEvent(seq, time, turn, step, usage, provider, model) {
  return { seq, time, type: 'assistant/message', data: { turn, step, message: { source: { provider, model } }, usage } }
}

function chunkEvent(seq, time, turn, step, usage) {
  return { seq, time, type: 'assistant/chunk', data: { turn, step, chunk: { type: 'usage', usage } } }
}

// One session log: two turns, three usage samples (two messages and one streamed
// chunk), two request contexts and two different identities. The seed moves the
// timestamps and the token counts so no two fixture sessions are interchangeable.
function sessionLog(id, cwd, seed) {
  const start = BASE_TIME + seed * 60 * 60 * 1000
  return {
    id,
    header: { cwd },
    events: [
      contextEvent(0, start, 'deepseek', 'deepseek-chat', 1, 1),
      turnEndEvent(1, start + 1000, 1),
      messageEvent(2, start + 2000, 1, 1, { inputTokens: 10 + seed, outputTokens: 2 }, 'deepseek', 'deepseek-chat'),
      chunkEvent(3, start + 3000, 1, 2, { inputTokens: 5, cacheReadTokens: 3 }),
      contextEvent(4, start + 4000, 'other', 'other-chat', 2, 1),
      messageEvent(5, start + 5000, 2, 1, { inputTokens: 7, outputTokens: 1 + seed, reasoningTokens: 2 }, 'other', 'other-chat'),
      turnEndEvent(6, start + 6000, 2),
    ],
  }
}

const SESSIONS = [
  { session: sessionLog('s-alpha-1', 'C:/work/alpha', 1), workspaceId: 'w-alpha' },
  { session: sessionLog('s-alpha-2', 'C:/work/alpha', 2), workspaceId: 'w-alpha' },
  { session: sessionLog('s-beta-1', 'C:/work/beta', 3), workspaceId: 'w-beta' },
]

// A record's stamps differ between two folds by construction (updatedAt is a
// monotonic revision), so they are removed before comparing content.
function recordPayload(record) {
  const copy = JSON.parse(JSON.stringify(record))
  delete copy.updatedAt
  delete copy.lastRevision
  delete copy.sourceRevision
  return copy
}

// The fields of the dashboard payload a fold can influence. Revisions, the request
// token and the timestamp are per-host and deliberately left out.
function snapshotPayload(snapshot) {
  const fields = ['totals', 'perWorkspace', 'perModel', 'byDay', 'byDayUtc', 'workspaces', 'accounting', 'mismatch']
  return Object.fromEntries(fields.map((field) => [field, snapshot[field]]))
}

function pickTotals(totals) {
  return {
    input: totals.input,
    output: totals.output,
    cacheRead: totals.cacheRead,
    cacheWrite: totals.cacheWrite,
    reasoning: totals.reasoning,
  }
}

// An oracle that never touches the ledger: it sums the fixture's own buckets.
function fixtureUsage(sessions) {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
  for (const { session } of sessions) {
    for (const event of session.events) {
      const usage = event.type === 'assistant/message'
        ? event.data.usage
        : event.type === 'assistant/chunk' ? event.data.chunk.usage : null
      if (usage === null || usage === undefined) continue
      totals.input += usage.inputTokens || 0
      totals.output += usage.outputTokens || 0
      totals.cacheRead += usage.cacheReadTokens || 0
      totals.cacheWrite += usage.cacheWriteTokens || 0
      totals.reasoning += usage.reasoningTokens || 0
    }
  }
  return totals
}

function usageRows(state) {
  return [...state.usageByStep]
    .map(([key, row]) => JSON.stringify([key, row.seq, row.turn, row.step, row.wsId, row.identity.identityKey, row.values, row.cost.total]))
    .sort()
}

// Same rows, workspace left out: used where the rows are expected to move.
function rowSignatures(state) {
  return [...state.usageByStep]
    .map(([key, row]) => JSON.stringify([key, row.seq, row.turn, row.step, row.identity.identityKey, row.values]))
    .sort()
}

// A second FNV-1a, written here rather than imported, so the shard mapping is
// checked against an independent implementation instead of against itself.
function independentShardIndex(sessionId, prime = 16777619) {
  let hash = 2166136261
  for (let index = 0; index < sessionId.length; index += 1) {
    hash ^= sessionId.charCodeAt(index)
    hash = Math.imul(hash, prime)
  }
  return (hash >>> 0) % LEDGER_SHARD_COUNT
}

function legacyRecords() {
  const { ledger } = createInvariantHost()
  const first = ledger.buildLedgerRecord(sessionLog('s-legacy-a', 'C:/work/legacy', 4), 'w-legacy', 'scan', 'legacy-a')
  const second = ledger.buildLedgerRecord(sessionLog('s-legacy-b', 'C:/work/legacy', 5), 'w-legacy', 'scan', 'legacy-b')
  // A row an older build wrote: it must be carried over and flagged, never upgraded
  // behind the scenes and never migrated a second time.
  return { first, second: { ...second, version: 2 } }
}

// ---------------------------------------------------------------------------
// Invariant 1: folding a log in increments equals folding it once.
// ---------------------------------------------------------------------------

test('an incremental fold of one session log equals the full fold', () => {
  const { ledger } = createInvariantHost()
  for (const { session, workspaceId } of SESSIONS) {
    const full = ledger.buildLedgerRecord(session, workspaceId, 'scan', 'rev-full')
    const head = ledger.buildLedgerRecord({ ...session, events: session.events.slice(0, 3) }, workspaceId, 'scan', 'rev-1')
    const middle = ledger.buildLedgerRecord({ ...session, events: session.events.slice(0, 5) }, workspaceId, 'scan', 'rev-2', head)
    const incremental = ledger.buildLedgerRecord(session, workspaceId, 'scan', 'rev-3', middle)
    // The fixture has to fold the tail in pieces: a rebuild at every step would
    // report every sample every time and make this invariant vacuous.
    assert.deepEqual([head.usage.length, middle.usage.length, incremental.usage.length], [1, 2, 3], session.id + ': the tail is folded in two pieces')
    assert.equal(incremental.lastSeq, 6)
    assert.deepEqual(recordPayload(incremental), recordPayload(full), session.id + ': an incremental fold must equal a full fold')
  }
})

test('incremental folds produce the same accounting as full folds', async () => {
  const fullHost = createInvariantHost()
  const incrementalHost = createInvariantHost()
  for (const host of [fullHost, incrementalHost]) {
    for (const workspaceId of ['w-alpha', 'w-beta']) {
      host.state.wsMeta.set(workspaceId, { id: workspaceId, title: workspaceId, path: '/' + workspaceId })
    }
  }
  const chains = []
  for (const { session, workspaceId } of SESSIONS) {
    fullHost.ledger.applyLedgerRecord(fullHost.ledger.buildLedgerRecord(session, workspaceId, 'scan', 'rev-full'))
    const head = incrementalHost.ledger.buildLedgerRecord({ ...session, events: session.events.slice(0, 3) }, workspaceId, 'scan', 'rev-1')
    const middle = incrementalHost.ledger.buildLedgerRecord({ ...session, events: session.events.slice(0, 5) }, workspaceId, 'scan', 'rev-2', head)
    const tail = incrementalHost.ledger.buildLedgerRecord(session, workspaceId, 'scan', 'rev-3', middle)
    chains.push([head, middle, tail])
  }
  // A sync pass applies one revision of every session at a time, not one session
  // to completion, so the incremental host is fed interleaved batches.
  for (let phase = 0; phase < 3; phase += 1) {
    for (const chain of chains) incrementalHost.ledger.applyLedgerRecord(chain[phase])
  }
  await fullHost.host.commitPendingStats()
  await incrementalHost.host.commitPendingStats()
  const fullSnapshot = fullHost.aggregation.snapshot(false)
  const incrementalSnapshot = incrementalHost.aggregation.snapshot(false)
  assert.deepEqual(snapshotPayload(incrementalSnapshot), snapshotPayload(fullSnapshot))
  assert.deepEqual(usageRows(incrementalHost.state), usageRows(fullHost.state))
  // Independent oracle: the payload must match the fixture, not only itself.
  assert.deepEqual(pickTotals(fullSnapshot.totals), fixtureUsage(SESSIONS))
  assert.equal(fullSnapshot.totals.turns, SESSIONS.length * 2)
  assert.equal(incrementalSnapshot.totals.sessions, SESSIONS.length)
  assert.equal(incrementalHost.state.usageByStep.size, SESSIONS.length * 3)
})

test('negative control: the record comparison catches a one-token and a one-event difference', () => {
  const { ledger } = createInvariantHost()
  const { session, workspaceId } = SESSIONS[0]
  const full = ledger.buildLedgerRecord(session, workspaceId, 'scan', 'rev-full')
  // One bucket off by one: the shape a lost or duplicated sample takes.
  const tampered = JSON.parse(JSON.stringify(full))
  tampered.usage[0].values.input += 1
  assert.throws(() => assert.deepEqual(recordPayload(tampered), recordPayload(full)))
  // Persisted cursor one event too far: the tail fold then skips a sample.
  const head = ledger.buildLedgerRecord({ ...session, events: session.events.slice(0, 3) }, workspaceId, 'scan', 'rev-1')
  const skipped = ledger.buildLedgerRecord(session, workspaceId, 'scan', 'rev-2', { ...head, lastSeq: head.lastSeq + 1 })
  assert.equal(skipped.usage.length, full.usage.length - 1)
  assert.throws(() => assert.deepEqual(recordPayload(skipped), recordPayload(full)))
  // A sample lost on the way into the aggregates is visible in the payload
  // comparison as well, not only in the record comparison.
  const lossyHost = createInvariantHost()
  const wholeHost = createInvariantHost()
  const lossy = JSON.parse(JSON.stringify(full))
  lossy.usage.pop()
  lossyHost.ledger.applyLedgerRecord(lossy)
  wholeHost.ledger.applyLedgerRecord(full)
  assert.throws(() => assert.deepEqual(snapshotPayload(lossyHost.aggregation.snapshot(false)), snapshotPayload(wholeHost.aggregation.snapshot(false))))
})

test('negative control: a replay only stays harmless because the fold refuses to count it twice', () => {
  const { state, ledger, aggregation } = createInvariantHost()
  const { session, workspaceId } = SESSIONS[0]
  const record = ledger.buildLedgerRecord(session, workspaceId, 'scan', 'rev')
  ledger.applyLedgerRecord(record)
  const once = pickTotals(aggregation.snapshot(false).totals)
  ledger.applyLedgerRecord(record)
  assert.deepEqual(pickTotals(aggregation.snapshot(false).totals), once, 'a replay must not add anything')
  // Take away the two pieces of evidence the fold checks (the resident digest and
  // the resident rows) and the very same replay doubles the counters, so the
  // assertion above is not vacuous.
  state.perSession.clear()
  state.usageByStep.clear()
  ledger.applyLedgerRecord(record)
  const doubled = pickTotals(aggregation.snapshot(false).totals)
  assert.notDeepEqual(doubled, once)
  assert.equal(doubled.input, once.input * 2)
  assert.equal(doubled.output, once.output * 2)
})
// ---------------------------------------------------------------------------
// Invariant 2: deleting a session or a workspace never loses recorded usage.
// ---------------------------------------------------------------------------

function seedLedger(host) {
  const records = []
  for (const { session, workspaceId } of SESSIONS) {
    const record = host.ledger.buildLedgerRecord(session, workspaceId, 'scan', 'rev')
    host.ledger.storeLedgerRecord(record)
    host.ledger.applyLedgerRecord(record)
    host.state.ledgerKeys.add(record.sessionId)
    records.push(record)
  }
  return records
}

test('a session dropped from the log listing keeps its recorded usage', async () => {
  const host = createInvariantHost()
  const records = seedLedger(host)
  const before = snapshotPayload(host.aggregation.snapshot(false))
  const beforeRows = usageRows(host.state)
  // A session that is no longer listed has no log to fold, so lib/session-sync.js
  // restores it from its ledger record instead. Folding the remaining sessions and
  // re-applying that record must leave every number where it was.
  const dropped = records.find((record) => record.sessionId === 's-alpha-2')
  const restored = await host.ledger.recordFor(dropped.sessionId)
  assert.equal(restored, dropped, 'the resident record is what gets re-applied')
  host.ledger.applyLedgerRecord(restored)
  for (const record of records) if (record !== dropped) host.ledger.applyLedgerRecord(record)
  assert.deepEqual(snapshotPayload(host.aggregation.snapshot(false)), before, 'the rescan must not change one number')
  assert.deepEqual(usageRows(host.state), beforeRows)
  assert.equal([...host.state.usageByStep.keys()].filter((key) => key.startsWith('s-alpha-2:')).length, 3)
})

test('deleting a workspace moves every recorded usage row into the retired bucket', async () => {
  const host = createInvariantHost()
  for (const workspaceId of ['w-alpha', 'w-beta']) {
    host.state.wsMeta.set(workspaceId, { id: workspaceId, title: workspaceId, path: '/' + workspaceId })
  }
  const records = seedLedger(host)
  const before = pickTotals(host.aggregation.snapshot(false).totals)
  const beforeRows = rowSignatures(host.state)
  // What lib/session-sync.js does for every session of a removed workspace: read the
  // detail rows back, retarget them, and keep the durable record in step.
  host.state.retiringWorkspaceIds.add('w-alpha')
  host.state.wsMeta.delete('w-alpha')
  const retiredSids = [...host.state.ledgerKeys].filter((sid) => host.state.ledgerRecords.get(sid).workspaceId === 'w-alpha')
  assert.deepEqual(retiredSids.sort(), ['s-alpha-1', 's-alpha-2'])
  let moved = 0
  for (const sid of retiredSids) {
    await host.ledger.loadRowsForSession(sid)
    moved += host.aggregation.retargetSession(sid, RETIRED_WORKSPACE_ID)
    host.state.ledgerRecords.set(sid, host.ledger.retargetLedgerRecord(host.state.ledgerRecords.get(sid)))
  }
  assert.ok(moved > 0)
  if (moved > 0) host.state.retiredBucketUsed = true
  const after = host.aggregation.snapshot(false)
  assert.deepEqual(pickTotals(after.totals), before, 'no usage may leave the totals')
  assert.deepEqual(rowSignatures(host.state), beforeRows, 'the rows keep their identity and values')
  assert.deepEqual(after.workspaces.find((item) => item.id === RETIRED_WORKSPACE_ID), { id: RETIRED_WORKSPACE_ID, title: '', path: '', deleted: true, retiredBucket: true })
  assert.equal(after.workspaces.some((item) => item.id === 'w-alpha'), false)
  for (const [key, row] of host.state.usageByStep) {
    if (retiredSids.some((sid) => key.startsWith(sid + ':'))) assert.equal(row.wsId, RETIRED_WORKSPACE_ID, key)
  }
  // The durable record carries the new workspace on every item, not only on its
  // header, so a later read cannot re-home the history back to the deleted id.
  const retargeted = host.state.ledgerRecords.get('s-alpha-1')
  const compact = host.ledger.serializeLedgerRecordForTest(retargeted)
  const expanded = host.ledger.expandLedgerRecordForTest(JSON.parse(JSON.stringify(compact)))
  assert.equal(expanded.workspaceId, RETIRED_WORKSPACE_ID)
  assert.deepEqual(expanded.usage.map((item) => item.workspaceId), expanded.usage.map(() => RETIRED_WORKSPACE_ID))
  assert.deepEqual(expanded.usage.map((item) => item.values), records[0].usage.map((item) => item.values))
  // ...and the durable back-pointer is what lets the retargeted copy be written back.
  const writes = []
  host.state.ledgerUnit = { putRecord(table, key, value) { writes.push({ table, key, value }) } }
  await host.ledger.persistLedgerRecord(retargeted)
  await host.ledger.drainLedgerWrites()
  assert.equal(writes.length, 1)
  assert.equal(writes[0].key, 's-alpha-1')
  assert.equal(writes[0].value.workspaceId, RETIRED_WORKSPACE_ID)
  assert.deepEqual(writes[0].value.usage.map((item) => item.workspaceId), writes[0].value.usage.map(() => RETIRED_WORKSPACE_ID))
})

test('negative control: the retention checks fail when the history is really unwound', async () => {
  const host = createInvariantHost()
  const records = seedLedger(host)
  const before = snapshotPayload(host.aggregation.snapshot(false))
  const beforeRows = rowSignatures(host.state)
  // A deletion path that trusts the listing instead of the ledger. This is the
  // exact regression the retention tests above have to catch.
  host.aggregation.removeSession(records[0].sessionId)
  assert.throws(() => assert.deepEqual(snapshotPayload(host.aggregation.snapshot(false)), before))
  assert.throws(() => assert.deepEqual(rowSignatures(host.state), beforeRows))
  assert.equal([...host.state.usageByStep.keys()].filter((key) => key.startsWith(records[0].sessionId + ':')).length, 0)
  // A retarget that rewrites only the record header leaves every usage item on the
  // deleted workspace, which the per-item assertion above would catch.
  const { workspaceId } = SESSIONS[0]
  const headerOnly = { ...records[0], workspaceId: RETIRED_WORKSPACE_ID }
  const expanded = host.ledger.expandLedgerRecordForTest(JSON.parse(JSON.stringify(host.ledger.serializeLedgerRecordForTest(headerOnly))))
  assert.equal(expanded.workspaceId, RETIRED_WORKSPACE_ID)
  assert.deepEqual(expanded.usage.map((item) => item.workspaceId), expanded.usage.map(() => workspaceId))
  assert.throws(() => assert.deepEqual(expanded.usage.map((item) => item.workspaceId), expanded.usage.map(() => RETIRED_WORKSPACE_ID)))
})

// ---------------------------------------------------------------------------
// Invariant 3: the layout migration happens once and is idempotent afterwards.
// ---------------------------------------------------------------------------

test('a session document lives in the shard its id hashes to', () => {
  const ids = SESSIONS.map(({ session }) => session.id).concat(['s-legacy-a', 's-legacy-b'])
  for (const id of ids) {
    assert.equal(shardIndexOf(id), independentShardIndex(id), id + ': the ledger hash and an independent FNV-1a must agree')
    assert.ok(shardIndexOf(id) >= 0 && shardIndexOf(id) < LEDGER_SHARD_COUNT)
  }
  // Pinned positions: a changed offset, prime or modulus has to move at least one.
  assert.equal(shardIndexOf('s-legacy-a'), 0)
  assert.equal(shardIndexOf('s-legacy-b'), 25)
  // Negative control: the same ids under a different FNV prime land somewhere else,
  // so the agreement above really is sensitive to the hash constants.
  const movedBySwappedPrime = ids.filter((id) => independentShardIndex(id, 16777633) !== shardIndexOf(id))
  assert.ok(movedBySwappedPrime.length > 0)
})

test('the first start copies every legacy row once and retires the legacy files', async () => {
  const root = await createTempRoot()
  try {
    const backend = createLedgerBackend(root)
    const rows = legacyRecords()
    await backend.seedLegacy({ 's-legacy-a': rows.first, 's-legacy-b': rows.second })
    await backend.seedLegacyShardFile(shardIndexOf('s-legacy-a'))
    const host = createInvariantHost({ backend: backend.backend })
    await host.ledger.loadLedger()
    // 32 per-record trees, then the legacy whole unit exactly once.
    assert.equal(backend.opens.length, LEDGER_SHARD_COUNT + 1)
    assert.deepEqual(backend.opens.filter((item) => item.name === LEDGER_UNIT_NAME).map((item) => item.layout), ['whole'])
    // Each row is copied into the tree its id hashes to, and no row is copied twice.
    const rowWrites = backend.writes.filter((item) => item.key !== LEDGER_META_KEY)
    assert.deepEqual(rowWrites.map((item) => item.key).sort(), ['s-legacy-a', 's-legacy-b'])
    for (const write of rowWrites) assert.equal(write.unit, ledgerShardUnitName(shardIndexOf(write.key)))
    assert.equal(backend.writes.filter((item) => item.key === LEDGER_META_KEY).length, 1, 'the migration marker is written once')
    // Both rows are known to the ledger, and each has exactly one document.
    assert.deepEqual([...host.state.ledgerKeys].sort(), ['s-legacy-a', 's-legacy-b'])
    assert.deepEqual(await backend.treeSessionIds(), ['s-legacy-a', 's-legacy-b'])
    for (const id of ['s-legacy-a', 's-legacy-b']) {
      const doc = await backend.readDoc(id)
      assert.equal(doc.version, 0)
      assert.equal(doc.record.sessionId, id)
    }
    // The legacy files are gone, their retirement is recorded, and the lock is free.
    assert.equal(await backend.hasFile(LEDGER_UNIT_NAME + '.json'), false)
    assert.equal(await backend.hasFile(ledgerShardUnitName(shardIndexOf('s-legacy-a')) + '.json'), false)
    assert.ok(JSON.parse(await backend.readText(LEDGER_UNIT_NAME + '.retired')).files >= 2)
    assert.equal(await backend.hasFile(LEDGER_UNIT_NAME + '.lock'), false)
    // A current row is reusable; the older row is carried over and flagged for a
    // rebuild, so 'migrated exactly once' never means 'silently rewritten'.
    assert.equal((await host.ledger.recordFor('s-legacy-a')).needsUpgrade, false)
    const carried = await host.ledger.recordFor('s-legacy-b')
    assert.equal(carried.version, 3)
    assert.equal(carried.needsUpgrade, true)
    assert.equal(carried.rebuildRequired, 'legacy-version')
  } finally {
    await removeTempRoot(root)
  }
})

test('a second start reuses the trees, writes nothing and leaves the marker alone', async () => {
  const root = await createTempRoot()
  try {
    const first = createLedgerBackend(root)
    const rows = legacyRecords()
    await first.seedLegacy({ 's-legacy-a': rows.first, 's-legacy-b': rows.second })
    const firstHost = createInvariantHost({ backend: first.backend })
    await firstHost.ledger.loadLedger()
    const markerBefore = await first.readText(ledgerMetaRelativePath())
    const treeBefore = await first.treeSessionIds()
    const recordBefore = recordPayload(await firstHost.ledger.recordFor('s-legacy-a'))
    const second = createLedgerBackend(root)
    const secondHost = createInvariantHost({ backend: second.backend })
    await secondHost.ledger.loadLedger()
    // The trees are the record now, so the legacy unit is never opened again.
    assert.equal(second.opens.length, LEDGER_SHARD_COUNT)
    assert.equal(second.opens.some((item) => item.name === LEDGER_UNIT_NAME), false, 'the migration section must not run again')
    assert.deepEqual(second.writes, [], 'a second start must not write a row or a marker')
    assert.equal(await second.readText(ledgerMetaRelativePath()), markerBefore, 'the marker must not be rewritten')
    assert.deepEqual(await second.treeSessionIds(), treeBefore, 'no record may be duplicated')
    assert.deepEqual([...secondHost.state.ledgerKeys].sort(), ['s-legacy-a', 's-legacy-b'])
    assert.deepEqual(recordPayload(await secondHost.ledger.recordFor('s-legacy-a')), recordBefore)
  } finally {
    await removeTempRoot(root)
  }
})

test('negative control: without the marker the same start migrates a second time', async () => {
  const root = await createTempRoot()
  try {
    const backend = createLedgerBackend(root)
    const rows = legacyRecords()
    await backend.seedLegacy({ 's-legacy-a': rows.first })
    const firstHost = createInvariantHost({ backend: backend.backend })
    await firstHost.ledger.loadLedger()
    assert.deepEqual(await backend.treeSessionIds(), ['s-legacy-a'])
    // An interrupted or older start: no marker, and a legacy row the trees never saw.
    await backend.removeMeta()
    await backend.seedLegacy({ 's-legacy-a': rows.first, 's-legacy-b': rows.second })
    const third = createLedgerBackend(root)
    const thirdHost = createInvariantHost({ backend: third.backend })
    await thirdHost.ledger.loadLedger()
    // This is what 'a second start is a no-op' detects: the legacy unit is opened
    // again and the migration rewrites the marker and the rows.
    assert.equal(third.opens.filter((item) => item.name === LEDGER_UNIT_NAME).length, 1)
    assert.ok(third.writes.some((item) => item.key === LEDGER_META_KEY))
    assert.ok(third.writes.some((item) => item.key === 's-legacy-b'))
    assert.deepEqual(await third.treeSessionIds(), ['s-legacy-a', 's-legacy-b'])
  } finally {
    await removeTempRoot(root)
  }
})
