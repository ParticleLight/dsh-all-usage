import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')
const start = source.indexOf('    function createRequestGate')
const end = source.indexOf('    function rangeFilenamePart')
assert.notEqual(start, -1, 'refresh helper start must exist')
assert.notEqual(end, -1, 'refresh helper end must exist')

const context = {}
vm.runInNewContext(source.slice(start, end) + '\nglobalThis.__refreshHelpers = { createRequestGate, snapshotVersion, queryVersion, metadataVersion, statusRefreshKind, statusRequiresFullSnapshot, statusRequiresQueryRefresh, retryDelayFor }', context)
const { createRequestGate, snapshotVersion, queryVersion, metadataVersion, statusRefreshKind, statusRequiresFullSnapshot, statusRequiresQueryRefresh, retryDelayFor } = context.__refreshHelpers

const pricingStart = source.indexOf('    function pricingDraftOf')
const pricingEnd = source.indexOf('    function pricingModelKey')
assert.notEqual(pricingStart, -1, 'pricing helper start must exist')
assert.notEqual(pricingEnd, -1, 'pricing helper end must exist')
const pricingContext = {}
vm.runInNewContext(source.slice(pricingStart, pricingEnd) + '\nglobalThis.__pricingHelpers = { pricingUsedModelsOf, pricingDraftAfterSync, validPricingRateDraft, pricingDraftValidationError }', pricingContext)
const { pricingUsedModelsOf, pricingDraftAfterSync, validPricingRateDraft, pricingDraftValidationError } = pricingContext.__pricingHelpers

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

test('classifies split revisions without promoting data changes to full snapshots', () => {
  const base = { instanceId: 'host-a', revision: 10, dataRevision: 4, metadataRevision: 2, scanRevision: 8, pricingRevision: 1, queryRevision: '4:1', scan: { done: true } }
  assert.equal(queryVersion(base), 'host-a:4:1')
  assert.equal(metadataVersion(base), 'host-a:2')
  assert.equal(statusRefreshKind({ ...base, revision: 11, dataRevision: 5, queryRevision: '5:1' }, base), 'query')
  assert.equal(statusRequiresQueryRefresh({ ...base, dataRevision: 5, queryRevision: '5:1' }, base), true)
  assert.equal(statusRefreshKind({ ...base, revision: 11, pricingRevision: 2, queryRevision: '4:2' }, base), 'full')
  assert.equal(statusRequiresFullSnapshot({ ...base, revision: 11, pricingRevision: 2, queryRevision: '4:2' }, base), true)
  assert.equal(statusRefreshKind({ ...base, revision: 12, dataRevision: 5, pricingRevision: 2, queryRevision: '5:2' }, base), 'full')
  assert.equal(statusRequiresQueryRefresh({ ...base, revision: 12, dataRevision: 5, pricingRevision: 2, queryRevision: '5:2' }, base), false)
  assert.equal(statusRefreshKind({ ...base, revision: 12, dataRevision: 5, pricingRevision: 2, queryRevision: '5:2' }, base), 'full')
  assert.equal(statusRequiresQueryRefresh({ ...base, revision: 12, dataRevision: 5, pricingRevision: 2, queryRevision: '5:2' }, base), false)
  assert.equal(statusRefreshKind({ ...base, revision: 11, scanRevision: 9 }, base), 'status')
  assert.equal(statusRefreshKind({ ...base, revision: 11, metadataRevision: 3 }, base), 'full')
  assert.equal(statusRequiresFullSnapshot({ ...base, revision: 11, dataRevision: 5, queryRevision: '5:1' }, base), false)
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

test('validates pricing drafts with the same decimal grammar as the host', () => {
  for (const value of ['0', '0.5', '1', '1.0', '1e24', '0.000001']) assert.equal(validPricingRateDraft(value), true, value)
  for (const value of ['', '.5', '1.', '-1', '1e25', '1e-25', '9'.repeat(41), 'NaN', 'Infinity']) assert.equal(validPricingRateDraft(value), false, value)
  assert.equal(pricingDraftValidationError({ mappings: [], overrides: [{ modelId: 'manual', input: '.5', output: '1', cacheRead: '0', cacheWrite: '0', tiers: [] }] }), 'override')
  assert.equal(pricingDraftValidationError({ mappings: [{ model: 'alias', catalogModelId: 'official', inputTokenSemantics: 'fresh', multiplier: '1.' }], overrides: [] }), 'mapping')
})

test('hydrates shared tier schedules and preserves unsaved drafts after sync', () => {
  const schedule = [{ type: 'context', size: 200000, input: '4', output: '12', cacheRead: '0.4', cacheWrite: '6' }]
  const hydrated = pricingUsedModelsOf({ tierSchedules: [{ id: 'tier-0', tiers: schedule }], usedModels: [{ identityKey: 'route', tierScheduleId: 'tier-0', tierCount: 1 }] })
  assert.equal(hydrated[0].tiers[0].size, 200000)
  hydrated[0].tiers[0].size = 1
  assert.equal(schedule[0].size, 200000)

  const previous = {
    sync: { autoEnabled: false, intervalMs: 21600000 },
    mappings: [{ model: 'local', catalogModelId: 'official', inputTokenSemantics: 'total', multiplier: '1.5' }],
    overrides: [{ modelId: 'local', input: '2', output: '8', cacheRead: '0.2', cacheWrite: '3', tiered: true, tiers: schedule }],
  }
  const synced = pricingDraftAfterSync(previous, { config: { sync: { autoEnabled: true, intervalMs: 21600000 }, mappings: [], overrides: [] } })
  assert.equal(synced.sync.autoEnabled, true)
  assert.equal(synced.mappings[0].inputTokenSemantics, 'total')
  assert.equal(synced.overrides[0].tiers[0].size, 200000)
  synced.overrides[0].tiers[0].size = 2
  assert.equal(previous.overrides[0].tiers[0].size, 200000)
})

test('passes the injected timer service into the sidebar dashboard', () => {
  assert.match(source, /const timer = ctx\.get\('timer'\)/)
  assert.match(source, /timerCtx: timer/)
  assert.doesNotMatch(source, /timerCtx: ctx/)
})

test('opens the dashboard on the today range by default', () => {
  assert.ok(source.includes("const [range, setRange] = React.useState(() => usageUiState.range || 'today')"))
})

test('calculates streaks from the full daily history', () => {
  assert.ok(source.includes('for (const day of activeDayRows) result.set(day.date, day)'))
  assert.ok(source.includes('streaks(fullHistoryDayMap, useUtc)'))
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
  assert.ok(source.includes("const recordsVisible = detailView === 'logs'"))
  assert.ok(source.includes("}, [detailKey, detailView, liveQueryVersion, auditReload])"))
  assert.doesNotMatch(source, /setAuditRows\(\[\]\)/)
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
  assert.ok(source.includes('const agg = React.useMemo(() => queryUsable'))
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
  assert.ok(source.includes("const trendAnimationKey = queryUsable && queryResult ? queryKey + ':' + (queryVersion(queryResult) || 'query') : queryKey"))
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
  assert.ok(source.includes("costDisplay(activeSegment.cost, language)"))
  assert.ok(source.includes("className: 'uh-donut-cost'"))
  assert.ok(source.includes('tooltipHeight = 82'))
  assert.match(source, /stroke-dashoffset:1/)
  assert.match(source, /animation:uh-donut-draw/)
  assert.match(source, /const data = React\.useMemo\(\(\) => buildDonutSegments/)
  assert.match(source, /window\.requestAnimationFrame\(flushPointer\)/)
  assert.match(source, /onMouseMove: updatePointer/)
  assert.ok(source.includes("key: 'model-donut-' + detailView + ':' + queryKey + ':' + (liveQueryVersion || 'query') + ':' + modelView"))
  assert.ok(source.includes("key: 'workspace-donut-' + detailView + ':' + queryKey + ':' + (liveQueryVersion || 'query')"))
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
  const end = source.indexOf('rows.map((row)', start)
  const header = source.slice(start, end)
  assert.equal((header.match(/className: 'uh-record-num'/g) || []).length, 6)
})

test('places the usage heatmap directly below the trend chart', () => {
  const trend = source.indexOf('          trendPanel,')
  const heatmap = source.indexOf('          React.createElement(MemoUsageHeatmap, {')
  const details = source.indexOf("className: 'uh-detail-tabs'")
  assert.ok(trend >= 0 && heatmap > trend && details > heatmap)
})

test('isolates heatmap pointer motion from the dashboard render path', () => {
  const pageStart = source.indexOf('    function UsagePage(props)')
  const pageEnd = source.indexOf('    class UsageDashboardBoundary')
  const pageSource = source.slice(pageStart, pageEnd)
  const heatmapStart = source.indexOf('    function UsageHeatmap(props)')
  const heatmapEnd = source.indexOf('    const MemoUsageHeatmap = React.memo(UsageHeatmap)')
  const heatmapSource = source.slice(heatmapStart, heatmapEnd)
  assert.doesNotMatch(pageSource, /\[hover, setHover\]/)
  assert.match(heatmapSource, /const \[hoverDate, setHoverDate\] = React\.useState\(null\)/)
  assert.match(heatmapSource, /window\.requestAnimationFrame\(flushTooltipPosition\)/)
  assert.match(heatmapSource, /onMouseMove: moveTooltip/)
  assert.match(heatmapSource, /\[hoverDate, flushTooltipPosition\]/)
  assert.ok(source.includes('const MemoUsageHeatmapTooltip = React.memo(UsageHeatmapTooltip)'))
  assert.ok(source.includes('const cellElements = React.useMemo'))
  assert.ok(source.includes('const calendar = React.useMemo(() => buildCalendarModel'))
})

test('memoizes chart geometry and parent trend rows', () => {
  assert.ok(source.includes('const MemoUsageDonutChart = React.memo(UsageDonutChart)'))
  assert.ok(source.includes('const MemoUsageTrendChart = React.memo(UsageTrendChart)'))
  assert.ok(source.includes('const MemoUsageRecordsPanel = React.memo(UsageRecordsPanel, equalRecordsPanelProps)'))
  assert.ok(source.includes('const MemoUsagePricingDialog = React.memo(UsagePricingDialog'))
  const pricingRevision = source.slice(source.indexOf('const pricingRenderRevision'), source.indexOf('const modelDonutItems'))
  assert.match(pricingRevision, /pricingModelSearchOpen/)
  assert.match(pricingRevision, /pricingModelSearchOptions/)
  assert.ok(source.includes('const geometry = React.useMemo(() => buildTrendGeometry(rows, visible, width, height), [rows, visible])'))
  assert.ok(source.includes('const trendRows = React.useMemo(() => {'))
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

test('renders cost totals, pricing status, and models.dev settings controls', () => {
  assert.match(source, /uh-ios-summary-meta-cost/)
  assert.match(source, /costDisplay/)
  assert.match(source, /minimumFractionDigits: 4, maximumFractionDigits: 4/)
  assert.match(source, /costCoverageLabel/)
  assert.match(source, /api\/all-usage\/pricing/)
  assert.match(source, /api\/all-usage\/pricing\/sync/)
  assert.match(source, /api\/all-usage\/pricing\/models/)
  assert.match(source, /getPricingModels/)
  assert.match(source, /searchOfficialModels/)
  assert.match(source, /pricingModelSearchTimerRef/)
  assert.ok(source.includes('const timerId = setTimeout(() => {'))
  assert.ok(source.includes('clearTimeout(previousTimer)'))
  assert.match(source, /selectPricingUsedModel/)
  assert.match(source, /identityKey: value/)
  assert.match(source, /mapping.identityKey \|\| mapping.usageIdentityKey/)
  assert.match(source, /selectPricingOverrideModel/)
  assert.match(source, /searchPricingOverrideModels/)
  assert.match(source, /pricingModelKey\(mapping\.model\)/)
  assert.match(source, /uh-pricing-used-model-picker/)
  assert.match(source, /pricingUsedModelSearchText/)
  assert.match(source, /pricingOverrideSearchText/)
  assert.match(source, /USAGE_UI_STATE_KEY/)
  assert.match(source, /storedUsageUiState/)
  assert.match(source, /persistUsageUiState/)
  assert.match(source, /pricingSyncSaving/)
  assert.ok(source.includes("useState(() => usageUiState.detailView"))
  assert.match(source, /uh-pricing-price-head/)
  assert.ok(source.includes('输入价 / 1M'))
  assert.ok(source.includes('缓存读 / 1M'))
  assert.ok(source.includes("value: entry.input === undefined ? '' : entry.input"))
  assert.ok(source.includes('输入价格，美元 / 100 万 Token'))
  assert.match(source, /选择当前用过的模型/)
  assert.match(source, /输入官方模型 ID 检索/)
  assert.match(source, /'aria-haspopup': 'listbox'/)
  assert.match(source, /models.dev/)
  assert.match(source, /Save and backfill/)
  assert.match(source, /Cost status/)
  assert.match(source, /Pricing model/)
  assert.match(source, /pricingSemanticsLabel/)
  assert.doesNotMatch(source, /React\.createElement\('select', \{ value: mapping\.inputTokenSemantics/)
  assert.doesNotMatch(source, /输入 Token 口径/)
  assert.match(source, /pricingTierBandLabel/)
  assert.match(source, /pricingDraftValidationError/)
  assert.match(source, /getPricing\(\)\.then/)
  // The server-persisted auto-sync value must never be replaced by UI state,
  // and deleting a mapping moves (and guards) in-flight official model searches.
  assert.doesNotMatch(source, /draft\.sync\.autoEnabled = uiState\.pricingAutoSync/)
  assert.ok(source.includes('pricingSearchEpochRef.current += 1'))
  assert.match(source, /const closePricingPanel = \(\) => \{[\s\S]*?pricingSearchEpochRef\.current \+= 1/)
  assert.ok(source.includes('setPricingModelSearchOptions((prev) => shiftIndexedMap(prev, index))'))
  assert.ok(source.includes('if (pricingSearchEpochRef.current !== searchEpoch) return'))
  assert.ok(source.includes('refreshPricingPanelRef.current'))
  assert.doesNotMatch(source, /shiftIndexedSeqMap/)
  assert.match(source, /pricingDraftAfterSync\(prev, data\.pricing\)/)
  assert.match(source, /const closePricingPanel = \(\) => \{\s*if \(pricingSaving \|\| pricingSyncing \|\| pricingSyncSaving\) return/)
  assert.match(source, /setPricingRpc\(pricingDraft, backfill, requestToken\)\.then\(\(data\) => \{\s*if \(!pricingGate\.isCurrent\(seq\)\) return/)
  assert.match(source, /disabled: pricingSaving \|\| pricingSyncing \|\| pricingSyncSaving, onClick: closePricingPanel/)
  assert.match(source, /pricingUsedModelsOf\(currentPricing\)/)
  assert.match(source, /pricingLoading/)
  assert.match(source, /addPricingOverrideTier/)
  assert.match(source, /updatePricingOverrideTier/)
  assert.match(source, /removePricingOverrideTier/)
  assert.match(source, /pricingStatusLabel(model.status || 'unpriced', language)/)
  assert.doesNotMatch(source, /tr\('官方厂商 ID'/)
  assert.match(source, /uh-pricing-model-table/)
  assert.match(source, /React\.createElement\('table'/)
  assert.match(source, /React\.createElement\('thead'/)
  assert.ok(source.includes("plus: [React.createElement('path'"))
  assert.equal((source.match(/name: 'plus'/g) || []).length, 3)
  assert.match(source, /上下文费率档位/)
  assert.match(source, /uh-pricing-tier-table/)
  assert.match(source, /uh-pricing-tier-edit-row/)
  assert.match(source, /tr\('输入', 'Input'\)/)
  assert.match(source, /tr\('输出', 'Output'\)/)
  assert.match(source, /tr\('缓存读', 'Cache read'\)/)
  assert.match(source, /tr\('缓存写', 'Cache write'\)/)
  assert.match(source, /max-height:392px/)
  assert.match(source, /uh-pricing-edit-row \{[^}]*grid-template-columns:minmax\(240px,1\.2fr\) minmax\(260px,1\.3fr\) minmax\(78px,\.45fr\) 32px/)
  assert.match(source, /uh-pricing-edit-row \{[^}]*gap:10px/)
  assert.match(source, /@media \(max-width:640px\) \{[\s\S]*?uh-pricing-edit-row \{ grid-template-columns:minmax\(0,1fr\) 36px/)
  assert.match(source, /uh-pricing-price-row > input\[type='number'\] \{ grid-column:1 \/ -1/)
  assert.match(source, /uh-pricing-tier-edit-row \{ grid-template-columns:minmax\(0,1fr\) 36px/)
  assert.match(source, /uh-pricing-used-model-input \{ box-sizing:border-box/)
  assert.match(source, /uh-pricing-model-search-input \{ box-sizing:border-box/)
  assert.match(source, /uh-pricing-table-wrap \{[^}]*overflow-y:scroll/)
  assert.match(source, /uh-side-dialog \{[^}]*overflow-y:scroll/)
  assert.match(source, /scrollbar-gutter:stable/)
  assert.match(source, /::-webkit-scrollbar/)
  assert.match(source, /scrollbar-color:#707780 #1d1f22/)
})

test('keeps the replacement cards and merges cache hits into the rate card', () => {
  assert.ok(source.includes("className: 'uh-ios-summary-hero'"))
  assert.ok(source.includes("className: 'uh-ios-summary-meta'"))
  assert.ok(source.includes("className: 'uh-ios-metrics'"))
  assert.ok(source.includes("card(tr('DeepSeek 账户余额', 'DeepSeek Account Balance')"))
  assert.ok(source.includes("card(scopedCountIsCalls ? tr('匹配调用次数', 'Matching Calls')"))
  assert.ok(source.includes("card(tr('连续使用', 'Current Streak')"))
  assert.ok(source.includes('              tokenCard,'))
  assert.ok(source.includes('              summaryRateMetric,'))
  assert.ok(source.includes("className: 'uh-ios-metric-rate-detail'"))
  const rateStart = source.indexOf("className: 'uh-ios-metric uh-ios-metric-rate'")
  const rateBar = source.indexOf("className: 'uh-ios-metric-bar'", rateStart)
  const rateDetail = source.indexOf("className: 'uh-ios-metric-rate-detail'", rateStart)
  assert.ok(rateStart >= 0 && rateBar > rateStart && rateDetail > rateBar)
  assert.ok(source.includes("language === 'en' ? 'Context reused ' + fmtCompact(agg.totals.cacheRead) + ' tokens' : '复用上下文 ' + fmtCompact(agg.totals.cacheRead) + ' Token'"))
  assert.ok(source.includes('.uh-ios-metric-rate-detail { min-width:0; overflow:hidden; color:var(--dsw-alias-label-secondary); font-size:14px;'))
  assert.ok(source.includes('fmtCompact(agg.totals.cacheRead)'))
  assert.doesNotMatch(source, /summaryMetric/)
  assert.ok(source.includes('.uh-ios-metrics { display:grid; grid-template-columns:repeat(5,minmax(0,1fr));'))
  assert.ok(source.includes('.uh-ios-metrics > .uh-card { min-width:0; min-height:141px;'))
  assert.ok(source.includes('.uh-ios-metrics > .uh-card:nth-child(-n+3) { justify-content:center; }'))
  assert.ok(source.includes('.uh-ios-summary-hero { display:grid; grid-template-columns:minmax(0,1fr) minmax(320px,.48fr);'))
})
