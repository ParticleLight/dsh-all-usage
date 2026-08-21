import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
const start = source.indexOf('    function pad2')
const end = source.indexOf('    function modelParts')
assert.notEqual(start, -1, 'client date helpers must exist')
assert.notEqual(end, -1, 'client range helper boundary must exist')

const context = {}
vm.runInNewContext(source.slice(start, end) + '\nglobalThis.__rangeHelpers = { isCalendarDate, normalizeCustomRange, customRangeIssue, availableDateBounds, createRequestGate, rangeFilenamePart, rangeAgg }', context)
const { isCalendarDate, normalizeCustomRange, customRangeIssue, availableDateBounds, createRequestGate, rangeFilenamePart, rangeAgg } = context.__rangeHelpers

function day(date, turns, input, workspaceId = 'ws-main', model = 'deepseek/deepseek-chat') {
  return {
    date,
    turns,
    tokens: { input, output: input * 2, cacheRead: input * 3, cacheWrite: input * 4, reasoning: input * 5 },
    perWorkspace: [{ workspaceId, turns }],
    byWorkspace: [{ workspaceId, input, output: input * 2, cacheRead: input * 3, cacheWrite: input * 4, reasoning: input * 5 }],
    byModel: [{ model, calls: turns, input, output: input * 2, cacheRead: input * 3, cacheWrite: input * 4, reasoning: input * 5 }],
  }
}

test('validates custom calendar ranges and retained-history bounds', () => {
  assert.equal(isCalendarDate('2024-02-29', true), true)
  assert.equal(isCalendarDate('2026-02-29', true), false)
  assert.equal(isCalendarDate('2026-2-09', false), false)
  assert.equal(normalizeCustomRange({ start: '2026-05-10', end: '2026-05-09' }, true), null)
  assert.equal(customRangeIssue({ start: '2026-05-10', end: '2026-05-09' }, '2025-08-13', '2026-08-19', true), 'order')
  assert.equal(customRangeIssue({ start: '2025-08-12', end: '2026-08-19' }, '2025-08-13', '2026-08-19', true), 'bounds')
  assert.equal(customRangeIssue({ start: '2025-08-13', end: '2026-08-19' }, '2025-08-13', '2026-08-19', true), '')
  assert.equal(rangeFilenamePart('custom', { start: '2026-05-01', end: '2026-05-31' }, true), 'custom-2026-05-01-to-2026-05-31')
})

test('uses the earliest available daily row as the custom range minimum', () => {
  const bounds = availableDateBounds([day('2024-01-02', 1, 10), day('2026-08-20', 1, 20)], '2026-08-20')
  assert.equal(bounds.min, '2024-01-02')
  assert.equal(bounds.max, '2026-08-20')
  assert.equal(customRangeIssue({ start: '2024-01-02', end: '2024-01-02' }, bounds.min, bounds.max, true), '')
})

test('counts distinct sessions across a custom range', () => {
  const first = day('2026-05-01', 1, 10)
  first.sessionIds = ['s1', 's2']
  const second = day('2026-05-02', 1, 10)
  second.sessionIds = ['s2', 's3']
  const aggregate = rangeAgg({ byDay: [first, second], byDayUtc: [] }, 'custom', false, { start: '2026-05-01', end: '2026-05-02' })
  assert.equal(aggregate.totals.sessions, 3)
})

test('request gate drops stale responses', () => {
  const gate = createRequestGate()
  const first = gate.next()
  assert.equal(gate.isCurrent(first), true)
  const second = gate.next()
  assert.equal(gate.isCurrent(first), false)
  assert.equal(gate.isCurrent(second), true)
})

test('aggregates custom ranges inclusively across summary, workspace, and model rows', () => {
  const stats = {
    byDay: [
      day('2026-05-01', 1, 10),
      day('2026-05-02', 2, 20),
      day('2026-05-03', 3, 30),
      day('2026-05-04', 4, 40),
    ],
    byDayUtc: [],
  }
  const aggregate = rangeAgg(stats, 'custom', false, { start: '2026-05-02', end: '2026-05-03' })
  assert.equal(aggregate.totals.turns, 5)
  assert.equal(aggregate.totals.input, 50)
  assert.equal(aggregate.totals.cacheRead, 150)
  assert.equal(aggregate.perWs.length, 1)
  assert.equal(aggregate.perWs[0].turns, 5)
  assert.equal(aggregate.perWs[0].input, 50)
  assert.equal(aggregate.perModel.length, 1)
  assert.equal(aggregate.perModel[0].calls, 5)
  assert.equal(aggregate.perModel[0].reasoning, 250)
})

test('uses the selected language calendar bucket for custom ranges', () => {
  const stats = {
    byDay: [day('2026-05-02', 2, 20)],
    byDayUtc: [day('2026-05-01', 7, 70)],
  }
  const range = { start: '2026-05-01', end: '2026-05-01' }
  assert.equal(rangeAgg(stats, 'custom', false, range).totals.turns, 0)
  assert.equal(rangeAgg(stats, 'custom', true, range).totals.turns, 7)
})
