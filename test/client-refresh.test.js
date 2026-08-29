import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
const start = source.indexOf('    function createRequestGate')
const end = source.indexOf('    function rangeFilenamePart')
assert.notEqual(start, -1, 'refresh helper start must exist')
assert.notEqual(end, -1, 'refresh helper end must exist')

const context = {}
vm.runInNewContext(source.slice(start, end) + '\nglobalThis.__refreshHelpers = { createRequestGate, snapshotVersion, statusRequiresFullSnapshot, retryDelayFor }', context)
const { createRequestGate, snapshotVersion, statusRequiresFullSnapshot, retryDelayFor } = context.__refreshHelpers

test('compares full snapshot and status by instance plus revision', () => {
  const snapshot = { instanceId: 'host-a', revision: 7, scan: { done: true } }
  assert.equal(snapshotVersion(snapshot), 'host-a:7')
  assert.equal(snapshotVersion({ instanceId: '', revision: 7 }), null)
  assert.equal(snapshotVersion({ instanceId: 'host-a', revision: '7' }), null)
  assert.equal(statusRequiresFullSnapshot({ instanceId: 'host-a', revision: 7, scan: { done: true } }, snapshot), false)
  assert.equal(statusRequiresFullSnapshot({ instanceId: 'host-a', revision: 8, scan: { done: true } }, snapshot), true)
  assert.equal(statusRequiresFullSnapshot({ instanceId: 'host-b', revision: 7, scan: { done: true } }, snapshot), true)
  assert.equal(statusRequiresFullSnapshot({ instanceId: 'host-a', revision: 7, scan: { done: false } }, snapshot), true)
  assert.equal(statusRequiresFullSnapshot({ instanceId: 'host-a', revision: 7, scan: { done: true } }, null), true)
  assert.equal(statusRequiresFullSnapshot({ scan: { done: true } }, snapshot), true)
})

test('uses bounded exponential refresh retry delays', () => {
  assert.equal(retryDelayFor(1), 5000)
  assert.equal(retryDelayFor(2), 10000)
  assert.equal(retryDelayFor(3), 20000)
  assert.equal(retryDelayFor(4), 40000)
  assert.equal(retryDelayFor(99), 40000)
  assert.equal(retryDelayFor(0), 5000)
  assert.equal(retryDelayFor(undefined), 5000)
})

test('request gates discard stale refresh responses', () => {
  const gate = createRequestGate()
  const first = gate.next()
  const second = gate.next()
  assert.equal(gate.isCurrent(first), false)
  assert.equal(gate.isCurrent(second), true)
})

test('passes the injected timer service into the sidebar dashboard', () => {
  assert.match(source, /const timer = ctx\.get\('timer'\)/)
  assert.match(source, /timerCtx: timer/)
  assert.doesNotMatch(source, /timerCtx: ctx/)
})

test('opens the dashboard on the today range by default', () => {
  assert.ok(source.includes("const [range, setRange] = React.useState('today')"))
})

test('calculates streaks from the full daily history', () => {
  assert.ok(source.includes('for (const d of activeDayRows) dayMap.set(d.date, d)'))
})

test('uses the latest full refresh time as the normal health timestamp', () => {
  assert.match(source, /lastStatsText !== '' \? '已更新 ' \+ lastStatsText/)
  assert.doesNotMatch(source, /syncCompletedAt !== '' \? '已同步 '/)
})

test('uses scoped query and records endpoints with stale-cursor recovery', () => {
  assert.match(source, /fetch\('\/api\/all-usage\/query\?/)
  assert.match(source, /fetch\('\/api\/all-usage\/records\?/)
  assert.match(source, /reason && reason\.status === 409/)
  assert.match(source, /tabIndex: 0, role: 'button'/)
  assert.match(source, /setAuditReload\(\(value\) => value \+ 1\)/)
})

test('uses language-style custom menus for unified filters', () => {
  assert.match(source, /function UsageFilterMenu/)
  assert.match(source, /uh-language-menu' \+ ' uh-filter-menu|uh-language-menu uh-filter-menu/)
  assert.match(source, /role: 'listbox'/)
  assert.match(source, /role: 'option'/)
  assert.match(source, /uh-filter-options/)
  assert.ok(source.includes("className: 'uh-filter-workspace'"))
  assert.ok(source.includes("className: 'uh-filter-provider'"))
  assert.ok(source.includes("className: 'uh-filter-model'"))
  assert.ok(source.includes('.uh-filter-menu { flex:0 1 auto; min-width:0; }'))
  assert.ok(source.includes('const rangeWorkspaceOptions = workspaces.filter((workspace) => workspaceHasUsage(rangeWorkspaceTotals.get(workspace.id)))'))
  assert.ok(source.includes('rangeWorkspaceOptions.map((w) => ({ value: w.id, label: wsTitle(w.id) }))'))
  assert.ok(source.includes('if (wsFilter !== null && !rangeWorkspaceIds.has(wsFilter)) setWsFilter(null)'))
  assert.ok(source.includes('.uh-head { position:relative; z-index:20;'))
  assert.ok(source.includes('.uh-language-menu.uh-open { z-index:30; }'))
  assert.ok(source.includes('.uh-head { position:sticky; top:-18px; z-index:20;'))
  assert.ok(source.includes("className: 'uh-language-menu' + (languageMenuOpen ? ' uh-open' : '')"))
  assert.doesNotMatch(source, /uh-filter-select/)
})

test('keeps provider and model filters independent', () => {
  assert.ok(source.includes('const modelFilterValue = (row) =>'))
  assert.ok(source.includes('const rangeOnlyAgg = React.useMemo(() => rangeAgg(stats, range, useUtc, activeCustomRange)'))
  assert.ok(source.includes('const modelOptions = Array.from(new Set(rangeModelOptions.map(modelFilterValue)))'))
  assert.ok(source.includes('modelOptions.map((value) => ({ value, label: value }))'))
  assert.doesNotMatch(source, /selected.provider !== next.*setModelFilter(null)/)
})

test('memoizes expensive scope derivations and active detail panels', () => {
  assert.ok(source.includes('const agg = React.useMemo(() => queryReady'))
  assert.ok(source.includes('const rows = React.useMemo(() =>'))
  assert.ok(source.includes('const modelRows = React.useMemo(() =>'))
  assert.ok(source.includes("detailView === 'model' ? React.createElement('div', { className: 'uh-panel uh-ios-list-panel' },"))
  assert.ok(source.includes("detailView === 'workspace' ? React.createElement('div', { className: 'uh-panel uh-ios-list-panel' },"))
})

test('selects hourly query data for single-day trend scopes', () => {
  assert.match(source, /Array\.isArray\(queryResult\.hourly\)/)
  assert.match(source, /queryScope !== null && queryScope\.start === queryScope\.end/)
  assert.match(source, /buildTrendHourlyRows\(queryResult\.hourly, useUtc\)/)
  assert.match(source, /Hourly Token usage trend/)
  assert.match(source, /trendRowLabel\(row, language, true\)/)
})

test('uses a centered spinner without idle chart controls while trend data loads', () => {
  assert.match(source, /uh-trend-stage uh-trend-loading/)
  assert.match(source, /uh-trend-spinner/)
  assert.ok(source.includes("'aria-label': tr('正在加载趋势', 'Loading trend')"))
  assert.ok(source.includes("chartReady ? React.createElement('div', { className: 'uh-trend-legend'"))
  assert.doesNotMatch(source, /正在加载趋势…/)
})

test('keeps the base path visible beneath a replayable draw overlay', () => {
  assert.ok(source.includes('.uh-trend-line { fill:none; stroke-width:2.2; vector-effect:non-scaling-stroke; stroke-linecap:round; stroke-linejoin:round; opacity:.22; }'))
  assert.ok(source.includes('.uh-trend-line-draw { fill:none; stroke-width:2.2;'))
  assert.ok(source.includes("const trendAnimationKey = queryReady && queryResult ? queryKey + ':' + queryResult.revision : queryKey"))
  assert.ok(source.includes('key: trendAnimationKey'))
})

test('adds donut charts to model and workspace detail panels', () => {
  assert.match(source, /function UsageDonutChart/)
  assert.match(source, /function buildDonutSegments/)
  assert.match(source, /function donutArcPath/)
  assert.match(source, /function donutArcLinePath/)
  assert.ok(source.includes("color: '#b8c2cf'"))
  assert.ok(source.includes('const modelDonutChart ='))
  assert.ok(source.includes('const workspaceDonutChart ='))
  assert.match(source, /uh-donut-layout/)
  assert.match(source, /uh-donut-svg/)
  assert.match(source, /const \[activeIndex, setActiveIndex\] = React\.useState\(null\)/)
  assert.match(source, /uh-donut-tooltip/)
  assert.match(source, /stroke-dashoffset:1/)
  assert.match(source, /animation:uh-donut-draw/)
  assert.match(source, /tooltipPosition/)
  assert.match(source, /onMouseMove: updatePointer/)
  assert.ok(source.includes("key: 'model-donut-' + detailView + ':' + queryKey + ':' + stats.revision + ':' + modelView"))
  assert.ok(source.includes("key: 'workspace-donut-' + detailView + ':' + queryKey + ':' + stats.revision"))
  assert.match(source, /modelDonutChart,/ )
  assert.match(source, /workspaceDonutChart,/)
})

test('uses one anchored chart tooltip with cc-switch-style transition', () => {
  assert.ok(source.includes('const [tooltipIndex, setTooltipIndex]'))
  assert.match(source, /uh-trend-tooltip-row/)
  assert.match(source, /uh-trend-tooltip-title/)
  assert.match(source, /transition:left \.16s/)
  assert.match(source, /activateHover\(index\)/)
  assert.doesNotMatch(source, /transform:translate\(-50%,-100%\)/)
})

test('normalizes stale tooltip indexes after range changes', () => {
  assert.ok(source.includes('const tooltipRow = tooltipIndex === null ? null : (rows[tooltipIndex] || null)'))
  assert.ok(source.includes('const tooltipPoint = tooltipIndex === null ? null : ((geometry.points[visible[0]] || [])[tooltipIndex] || null)'))
})

test('keeps lightweight legend chips with a distinct selected surface', () => {
  assert.ok(source.includes("className: 'uh-trend-legend-item' + (visible.includes(key) ? ' uh-on' : '')"))
  assert.match(source, /aria-pressed': visible\.includes\(key\)/)
  assert.match(source, /uh-trend-legend-item\.uh-on \{ background:var\(--dsw-alias-interactive-bg-hover\)/)
  assert.doesNotMatch(source, /uh-trend-legend-item\.uh-on \{[^}]*box-shadow/)
  assert.doesNotMatch(source, /uh-trend-legend-state/)
  assert.doesNotMatch(source, /uh-off/)
})

test('removes row-level log buttons from model and workspace details', () => {
  assert.doesNotMatch(source, /modelAuditScope/)
  assert.doesNotMatch(source, /uh-row-audit/)
  assert.doesNotMatch(source, /查看模型明细|查看工作区明细/)
})

test('aligns request log numeric headers with row values', () => {
  const start = source.indexOf("className: 'uh-record-grid uh-record-header'")
  const end = source.indexOf('auditRows.map((row)')
  const header = source.slice(start, end)
  assert.equal((header.match(/className: 'uh-record-num'/g) || []).length, 5)
})

test('places the usage heatmap directly below the trend chart', () => {
  const trend = source.indexOf('          trendPanel,')
  const heatmap = source.indexOf("tr('使用热力图', 'Usage Heatmap')")
  const details = source.indexOf("className: 'uh-detail-tabs'")
  assert.ok(trend >= 0 && heatmap > trend && details > heatmap)
})

test('isolates dashboard render errors from the sidebar entry', () => {
  assert.match(source, /class UsageDashboardBoundary extends React\.Component/)
  assert.match(source, /getDerivedStateFromError/)
  assert.match(source, /uh-boundary-fallback/)
  assert.match(source, /dashboardResetKey/)
})

test('keeps audit details in a persistent compact request log panel', () => {
  assert.match(source, /uh-records-panel/)
  assert.match(source, /uh-record-grid/)
  assert.match(source, /getUsageRecords\(selectedDetailScope, null, 20\)/)
  assert.match(source, /uh-record-detail/)
  assert.match(source, /Request Logs/)
  assert.match(source, /uh-detail-tabs/)
  assert.match(source, /scrollIntoView\(\{ behavior: 'smooth'/)
  assert.doesNotMatch(source, /uh-audit-modal/)
})
