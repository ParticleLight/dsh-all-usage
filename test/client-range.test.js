import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
const start = source.indexOf('    function pad2')
const end = source.indexOf('    function trendSeriesLabel')
assert.notEqual(start, -1, 'client date helpers must exist')
assert.notEqual(end, -1, 'client range helper boundary must exist')

const context = {}
vm.runInNewContext(source.slice(start, end) + '\nglobalThis.__rangeHelpers = { isCalendarDate, normalizeCustomRange, customRangeIssue, availableDateBounds, createRequestGate, rangeFilenamePart, rangeAgg, resolveRangeBounds, makeUsageScope, usageScopeKey, buildTrendRows, buildTrendHourlyRows, buildTrendGeometry, smoothTrendPath, aggregateModelRows, streaks, buildDonutSegments, donutArcPath, donutArcLinePath }', context)
const { isCalendarDate, normalizeCustomRange, customRangeIssue, availableDateBounds, createRequestGate, rangeFilenamePart, rangeAgg, resolveRangeBounds, makeUsageScope, usageScopeKey, buildTrendRows, buildTrendHourlyRows, buildTrendGeometry, smoothTrendPath, aggregateModelRows, streaks, buildDonutSegments, donutArcPath, donutArcLinePath } = context.__rangeHelpers

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
  assert.equal(aggregate.totals.calls, 5)
  assert.equal(aggregate.totals.input, 50)
  assert.equal(aggregate.totals.cacheRead, 150)
  assert.equal(aggregate.perWs.length, 1)
  assert.equal(aggregate.perWs[0].turns, 5)
  assert.equal(aggregate.perWs[0].input, 50)
  assert.equal(aggregate.perModel.length, 1)
  assert.equal(aggregate.perModel[0].calls, 5)
  assert.equal(aggregate.perModel[0].reasoning, 250)
})



test('groups model view by normalized model ID instead of provider labels', () => {
  const rows = [
    { provider: 'opencode-go', model: 'opencode-go / deepseek-v4-flash', calls: 47, input: 1, output: 2, cacheRead: 3, cacheWrite: 0, reasoning: 0 },
    { provider: 'siliconflow', model: 'siliconflow / deepseek-ai/DeepSeek-V4-Flash', calls: 15, input: 4, output: 5, cacheRead: 6, cacheWrite: 0, reasoning: 0 },
    { provider: 'deepseek-official', actualModel: 'deepseek-v4-flash', model: 'deepseek-official / deepseek-v4-flash', calls: 12, input: 7, output: 8, cacheRead: 9, cacheWrite: 0, reasoning: 0 },
  ]
  const grouped = aggregateModelRows(rows, 'model', '未知供应商', '未知模型')
  assert.equal(grouped.length, 1)
  assert.equal(grouped[0].model, 'deepseek-v4-flash')
  assert.equal(aggregateModelRows([{ provider: 'p', actualModel: 'm / alpha', model: 'p / m / alpha', calls: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }], 'model', 'Unknown provider', 'Unknown model')[0].model, 'm / alpha')
  assert.equal(grouped[0].provider, 'opencode-go')
  assert.equal(grouped[0].calls, 74)
})

test('builds a stable scope and zero-fills daily trend rows', () => {
  const stats = { byDay: [day('2026-08-01', 1, 10), day('2026-08-03', 2, 20)], byDayUtc: [] }
  const bounds = resolveRangeBounds(stats, 'custom', false, { start: '2026-08-01', end: '2026-08-03' })
  const scope = makeUsageScope(stats, 'custom', false, { start: '2026-08-01', end: '2026-08-03' }, 'ws-main', 'deepseek', 'model-key')
  assert.equal(bounds.start, '2026-08-01')
  assert.equal(bounds.end, '2026-08-03')
  assert.equal(usageScopeKey(scope), JSON.stringify({ start: '2026-08-01', end: '2026-08-03', utc: false, workspaceId: 'ws-main', provider: 'deepseek', modelKey: 'model-key' }))
  const rows = buildTrendRows(stats.byDay, bounds, false)
  assert.equal(Array.from(rows, (row) => row.date).join('|'), '2026-08-01|2026-08-02|2026-08-03')
  assert.equal(rows[1].total, 0)
  assert.equal(rows[2].tokens.cacheRead, 60)
})

test('calculates streaks from complete history instead of selected range', () => {
  const now = new Date()
  const keyFor = (offset) => {
    const date = new Date(now)
    date.setDate(date.getDate() + offset)
    return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0')
  }
  const fullHistory = new Map([
    [keyFor(0), { turns: 1 }],
    [keyFor(-1), { turns: 1 }],
    [keyFor(-2), { turns: 1 }],
  ])
  const todayOnly = new Map([[keyFor(0), { turns: 1 }]])
  const todayResult = streaks(todayOnly, false)
  const fullResult = streaks(fullHistory, false)
  assert.equal(todayResult.streak, 1)
  assert.equal(todayResult.best, 1)
  assert.equal(fullResult.streak, 3)
  assert.equal(fullResult.best, 3)
})

test('normalizes hourly trend rows with unique time points', () => {
  const first = Date.UTC(2026, 7, 1, 0, 0, 0)
  const rows = buildTrendHourlyRows([
    { time: first + 60 * 60 * 1000, turns: 2, calls: 3, tokens: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, reasoning: 50 } },
    { time: first, turns: 1, calls: 1, tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, reasoning: 5 } },
  ], true)
  assert.deepEqual(Array.from(rows, (row) => row.time), [first, first + 60 * 60 * 1000])
  assert.deepEqual(Array.from(rows, (row) => row.date), ['2026-08-01', '2026-08-01'])
  assert.equal(rows[0].total, 15)
  assert.equal(rows[1].tokens.cacheRead, 30)
})

test('builds donut segments with normalized percentages and remainder', () => {
  const donut = buildDonutSegments([
    { label: 'A', value: 70, color: '#0a84ff' },
    { label: 'B', value: 20, color: '#30d158' },
    { label: 'C', value: 10, color: '#bf5af2' },
    { label: 'D', value: 5, color: '#ff9f0a' },
  ], '其他', 2)
  assert.equal(donut.total, 105)
  assert.equal(donut.segments.length, 3)
  assert.equal(donut.segments[0].label, 'A')
  assert.equal(donut.segments[2].label, '其他 (2)')
  assert.equal(donut.segments[2].color, '#b8c2cf')
  assert.equal(Math.round(donut.segments.reduce((sum, item) => sum + item.percentage, 0)), 100)
  assert.ok(donut.segments.every((item) => item.endAngle > item.startAngle))
  assert.match(donutArcPath(130, 130, 94, 61, donut.segments[0].startAngle, donut.segments[0].endAngle), /A94 94/)
  assert.match(donutArcLinePath(130, 130, 77.5, donut.segments[0].startAngle, donut.segments[0].endAngle), /A77.5 77.5/)
  const single = buildDonutSegments([{ label: 'Only', value: 1 }], '其他')
  assert.equal(single.segments.length, 1)
  assert.match(donutArcPath(130, 130, 94, 61, single.segments[0].startAngle, single.segments[0].endAngle), /A94 94 0 1 1/)
})

test('carries segment costs into the other bucket', () => {
  const cost = (total) => ({ currency: 'USD', input: total, output: '0', cacheRead: '0', cacheWrite: '0', baseTotal: total, total, pricedCalls: 1, unpricedCalls: 0, ambiguousCalls: 0, unsupportedCalls: 0 })
  const donut = buildDonutSegments([
    { label: 'A', value: 70, cost: cost('1') },
    { label: 'B', value: 20, cost: cost('2') },
    { label: 'C', value: 10, cost: cost('3') },
  ], '其他', 2)
  assert.equal(donut.segments[0].cost.total, '1')
  assert.equal(donut.segments[2].cost.total, '3')
  assert.equal(donut.segments[2].cost.pricedCalls, 1)
})

test('builds safe single-point and large-value trend geometry', () => {
  const rows = buildTrendRows([day('2026-08-01', 1, 1000000)], { start: '2026-08-01', end: '2026-08-01' }, false)
  const geometry = buildTrendGeometry(rows, ['total', 'input'], 900, 250)
  assert.equal(geometry.points.total.length, 1)
  assert.equal(geometry.points.total[0].x, 466)
  assert.ok(Number.isFinite(geometry.points.total[0].y))
  assert.ok(geometry.max > 1000000)
  const path = smoothTrendPath([{ x: 0, y: 10 }, { x: 10, y: 2 }, { x: 20, y: 8 }])
  assert.match(path, /C/)
})

test('renders a visible marker for a single-day trend series', () => {
  assert.match(source, /points.length !== 1/)
  assert.match(source, /key: 'single-point-' \+ key/)
})

test('animates smooth chart paths', () => {
  assert.match(source, /uh-trend-draw/)
  assert.match(source, /stroke-dasharray:var\(--uh-draw-length\)/)
  assert.match(source, /uh-trend-area/)
  assert.match(source, /uh-trend-gradient-/)
  assert.match(source, /uh-trend-cursor/)
  assert.match(source, /uh-trend-point/)
  assert.doesNotMatch(source, /uh-trend-point-in/)
  assert.match(source, /smoothTrendPath/)
  assert.match(source, /key: 'line-base-' \+ key/)
  assert.match(source, /key: 'line-draw-' \+ key/)
  assert.match(source, /uh-trend-line-draw/)
  assert.match(source, /stroke-dashoffset:var\(--uh-draw-length\)/)
})

test('uses structured identity instead of splitting display labels', () => {
  const rows = [
    { identityKey: 'a', provider: 'p/one', actualModel: 'm / alpha', model: 'p/one / m / alpha', calls: 1, input: 1, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    { identityKey: 'b', provider: 'p/two', actualModel: 'm / alpha', model: 'p/two / m / alpha', calls: 2, input: 2, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
  ]
  const grouped = aggregateModelRows(rows, 'model', 'Unknown provider', 'Unknown model')
  assert.equal(grouped.length, 1)
  assert.equal(grouped[0].model, 'm / alpha')
  assert.equal(grouped[0].calls, 3)
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

test('aggregates persisted decimal costs without floating point drift', () => {
  const first = day('2026-05-01', 1, 10)
  first.cost = { currency: 'USD', input: '0.1', output: '0.2', cacheRead: '0', cacheWrite: '0', baseTotal: '0.3', total: '0.3', pricedCalls: 1, unpricedCalls: 0, ambiguousCalls: 0, unsupportedCalls: 0 }
  const second = day('2026-05-02', 1, 10)
  second.cost = { currency: 'USD', input: '0.2', output: '0.4', cacheRead: '0', cacheWrite: '0', baseTotal: '0.6', total: '0.6', pricedCalls: 1, unpricedCalls: 0, ambiguousCalls: 0, unsupportedCalls: 0 }
  second.byWorkspace[0].cost = second.cost
  second.byModel[0].cost = second.cost
  const aggregate = rangeAgg({ byDay: [first, second], byDayUtc: [] }, 'custom', false, { start: '2026-05-01', end: '2026-05-02' })
  assert.equal(aggregate.totals.cost.input, '0.3')
  assert.equal(aggregate.totals.cost.total, '0.9')
  assert.equal(aggregate.totals.cost.pricedCalls, 2)
  assert.equal(aggregate.perWs[0].cost.total, '0.6')
  assert.equal(aggregate.perModel[0].cost.total, '0.6')
})

test('carries cost through zero-filled trend rows', () => {
  const priced = day('2026-08-01', 1, 10)
  priced.cost = { currency: 'USD', input: '1', output: '2', cacheRead: '0', cacheWrite: '0', baseTotal: '3', total: '3', pricedCalls: 1, unpricedCalls: 0, ambiguousCalls: 0, unsupportedCalls: 0 }
  const rows = buildTrendRows([priced], { start: '2026-08-01', end: '2026-08-02' }, false)
  assert.equal(rows[0].cost.total, '3')
  assert.equal(rows[1].cost.total, '0')
  assert.equal(rows[1].cost.pricedCalls, 0)
})
