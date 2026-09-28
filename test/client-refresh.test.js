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
vm.runInNewContext(source.slice(pricingStart, pricingEnd) + '\nglobalThis.__pricingHelpers = { pricingUsedModelsOf, pricingDraftAfterSync, validPricingRateDraft, pricingDraftValidationError, pricingRowKey, pricingRowBasis, pricingBasisKey, pricingOverrideIndex, pricingMappingIndex, pricingRowsOf, pricingDraftUpsertOverride, pricingDraftSetRate, pricingDraftWithoutOverride, pricingDraftSetMapping, pricingDraftWithoutMapping, pricingDraftSetMappingField, pricingTierDraftAdd, pricingTierDraftUpdate, pricingTierDraftRemove, pricingTimeTextToMinute, pricingMinuteToTimeText, pricingDateTextToUtc, pricingTemporalDraftOfPlan, pricingTemporalDraftDefault, pricingTemporalDraftClone, pricingTemporalDraftWithRule, pricingTemporalDraftWithoutRule, pricingTemporalDraftToggleWeekday, pricingTemporalDraftValidationError, pricingTemporalPlanFromDraft, pricingRatesEqual, pricingTiersEqual, pricingRowViewEqual, pricingRowPropsEqual, pricingHolidayDatesFromText, pricingHolidayTextMerge }', pricingContext)
const { pricingUsedModelsOf, pricingDraftAfterSync, validPricingRateDraft, pricingDraftValidationError, pricingRowKey, pricingRowBasis, pricingBasisKey, pricingOverrideIndex, pricingMappingIndex, pricingRowsOf, pricingDraftUpsertOverride, pricingDraftSetRate, pricingDraftWithoutOverride, pricingDraftSetMapping, pricingDraftWithoutMapping, pricingDraftSetMappingField, pricingTierDraftAdd, pricingTierDraftUpdate, pricingTierDraftRemove, pricingTimeTextToMinute, pricingMinuteToTimeText, pricingDateTextToUtc, pricingTemporalDraftOfPlan, pricingTemporalDraftDefault, pricingTemporalDraftClone, pricingTemporalDraftWithRule, pricingTemporalDraftWithoutRule, pricingTemporalDraftToggleWeekday, pricingTemporalDraftValidationError, pricingTemporalPlanFromDraft, pricingRatesEqual, pricingTiersEqual, pricingRowViewEqual, pricingRowPropsEqual, pricingHolidayDatesFromText, pricingHolidayTextMerge } = pricingContext.__pricingHelpers

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
  // The desktop client keeps its own window buttons in a caption strip across the
  // top of the window and marks the document with `data-windows-titlebar`. The
  // sheet itself starts below that strip, so nothing the panel paints — backdrop,
  // grabber bar, close button — can hide the host's own close button.
  assert.ok(source.includes('function uhWindowControlsInset()'))
  assert.ok(source.includes("root.hasAttribute('data-windows-titlebar')"))
  assert.ok(source.includes("getPropertyValue('--dsh-windows-titlebar-height')"))
  assert.ok(source.includes('navigator.windowControlsOverlay'))
  assert.ok(source.includes('.uh-side-modal { position:fixed; inset:var(--uh-top-inset, 0px) 0 0 0;'))
  assert.ok(source.includes('max-height:calc(100vh - var(--uh-top-inset, 0px) - 44px);'))
  assert.ok(source.includes("style: captionInset > 0 ? { '--uh-top-inset': captionInset + 'px' } : undefined, onMouseDown"))
  assert.ok(source.includes('padding:12px 2px 34px;'))
  assert.ok(source.includes("className: 'uh-language-menu' + (languageMenuOpen ? ' uh-open' : '')"))
  assert.doesNotMatch(source, /uh-filter-select/)
})

test('keeps provider and model filters independent', () => {
  assert.ok(source.includes('const modelFilterValue = (row) =>'))
  assert.ok(source.includes('const rangeOnlyAgg = React.useMemo(() => rangeAgg(stats, range, useUtc, activeCustomRange)'))
  assert.ok(source.includes('const modelOptions = Array.from(new Set(rangeModelOptions.map(modelFilterValue)))'))
  assert.ok(source.includes('modelOptions.map((value) => { const icon = resolveModelIcon({ actualModel: value, requestedModel: value }); return { value, label: value, iconKey: icon === null ? null : icon.key } })'))
  assert.ok(source.includes('option.iconKey === undefined || option.iconKey === null'))
  assert.ok(source.includes('React.createElement(MemoModelIcon, { iconKey, size: 14 })'))
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

test('renders cost totals, pricing status, and the merged price table controls', () => {
  assert.match(source, /uh-ios-summary-meta-cost/)
  assert.match(source, /costDisplay/)
  assert.match(source, /minimumFractionDigits: 4, maximumFractionDigits: 4/)
  assert.match(source, /costCoverageLabel/)
  assert.match(source, /api\/all-usage\/pricing/)
  assert.match(source, /api\/all-usage\/pricing\/sync/)
  assert.match(source, /api\/all-usage\/pricing\/models/)
  assert.match(source, /getPricingModels/)
  // The mapping column searches the official catalog per row with a debounced,
  // epoch-guarded request keyed by the stable row key.
  assert.match(source, /searchRowTargets/)
  assert.match(source, /chooseRowTarget/)
  assert.match(source, /pricingModelSearchTimerRef/)
  assert.ok(source.includes('const timerId = setTimeout(() => {'))
  assert.ok(source.includes('clearTimeout(previousTimer)'))
  assert.ok(source.includes('if (pricingSearchEpochRef.current !== searchEpoch) return'))
  assert.ok(source.includes('pricingModelSearchSeqRef.current[key] !== nextSeq'))
  assert.doesNotMatch(source, /shiftIndexedMap/)
  assert.doesNotMatch(source, /selectPricingUsedModel/)
  assert.doesNotMatch(source, /selectPricingOverrideModel/)
  // Rows are derived from the snapshot plus the local draft, keyed by row key.
  assert.match(source, /pricingRowsOf\(currentPricing, pricingDraft, pricingPickedTargets\)/)
  assert.match(source, /pricingUsedModelsOf\(source\)/)
  assert.match(source, /pricingRowKey/)
  assert.match(source, /pricingRowBasis/)
  assert.match(source, /pricingOverrideIndex/)
  assert.match(source, /pricingMappingIndex/)
  assert.match(source, /mapping.identityKey \|\| mapping.usageIdentityKey/)
  assert.match(source, /identityKey: view\.identityKey/)
  // Editing a price cell upserts the manual entry for the row basis and keeps
  // its bands; resetting removes it again.
  assert.match(source, /pricingDraftUpsertOverride/)
  assert.match(source, /pricingDraftSetRate/)
  assert.match(source, /pricingDraftSetMapping/)
  assert.match(source, /pricingDraftWithoutOverride/)
  assert.match(source, /pricingDraftWithoutMapping/)
  assert.match(source, /addRowTier/)
  assert.match(source, /updateRowTier/)
  assert.match(source, /removeRowTier/)
  // Peak/off-peak plans are edited as a loose draft that is validated before it
  // reaches the wire payload.
  assert.match(source, /pricingTemporalDraftOfPlan/)
  assert.match(source, /pricingTemporalDraftValidationError/)
  assert.match(source, /pricingTemporalPlanFromDraft/)
  assert.match(source, /applyTemporalDraft/)
  assert.match(source, /pricingTemporalDrafts/)
  assert.match(source, /startTemporalRules/)
  assert.match(source, /resetTemporalPlan/)
  assert.match(source, /pricingDraftPayloadTooLarge/)
  assert.match(source, /pricingDraftValidationError\(pricingDraft, pricingTemporalDrafts\)/)
  assert.match(source, /USAGE_UI_STATE_KEY/)
  assert.match(source, /storedUsageUiState/)
  assert.match(source, /persistUsageUiState/)
  assert.match(source, /pricingSyncSaving/)
  assert.ok(source.includes("useState(() => usageUiState.detailView"))
  // Labels and structure of the merged table and its two editors.
  assert.match(source, /uh-pricing-price-table/)
  assert.match(source, /uh-pricing-rate-input/)
  assert.match(source, /uh-pricing-chip/)
  assert.match(source, /uh-pricing-map-cell/)
  assert.match(source, /uh-pricing-model-search-input/)
  assert.match(source, /uh-pricing-editor-row/)
  assert.match(source, /uh-pricing-weekday/)
  assert.match(source, /uh-pricing-time-input/)
  assert.match(source, /uh-pricing-model-table/)
  assert.match(source, /React\.createElement\('table'/)
  assert.match(source, /React\.createElement\('thead'/)
  assert.ok(source.includes("plus: [React.createElement('path'"))
  assert.equal((source.match(/name: 'plus'/g) || []).length, 3)
  assert.ok(source.includes('输入官方模型 ID 检索'))
  assert.ok(source.includes('上下文费率档位'))
  assert.ok(source.includes('分时段计费（UTC）'))
  assert.ok(source.includes('输入 / 1M'))
  assert.ok(source.includes('缓存读 / 1M'))
  assert.ok(source.includes('缓存写 / 1M'))
  assert.ok(source.includes('生效起点（UTC，留空 = 全部历史）'))
  assert.ok(source.includes('该时刻之前的用量没有可用档位，会失败关闭为未计价。'))
  assert.match(source, /pricingTierBandLabel/)
  assert.match(source, /pricingSemanticsLabel/)
  assert.match(source, /pricingStatusLabel\(view\.status, language\)/)
  assert.match(source, /models\.dev/)
  assert.match(source, /Save and backfill/)
  assert.match(source, /pricingDraftValidationError/)
  assert.match(source, /getPricing\(\)\.then/)
  assert.doesNotMatch(source, /draft\.sync\.autoEnabled = uiState\.pricingAutoSync/)
  assert.ok(source.includes('pricingSearchEpochRef.current += 1'))
  assert.match(source, /const closePricingPanel = \(\) => \{[\s\S]*?invalidatePricingSearches\(\)/)
  const invalidations = source.match(/invalidatePricingSearches\(\)/g) || []
  assert.ok(invalidations.length >= 4)
  assert.ok(source.includes('refreshPricingPanelRef.current'))
  assert.match(source, /pricingDraftAfterSync\(prev, data\.pricing\)/)
  assert.match(source, /const closePricingPanel = \(\) => \{\s*if \(pricingSaving \|\| pricingSyncing \|\| pricingSyncSaving\) return/)
  assert.match(source, /setPricingRpc\(pricingDraft, backfill, requestToken\)\.then\(\(data\) => \{\s*if \(!pricingGate\.isCurrent\(seq\)\) return/)
  assert.match(source, /disabled: pricingBusy, onClick: closePricingPanel/)
  assert.match(source, /pricingLoading/)
  // The two legacy sections are gone and the read-only match table moved into
  // the editable table.
  assert.doesNotMatch(source, /'模型映射', 'Model mappings'/)
  assert.doesNotMatch(source, /'显式价格覆盖', 'Explicit price overrides'/)
  assert.match(source, /'官方模型 \/ 映射', 'Official model \/ mapping'/)
  assert.match(source, /'aria-autocomplete': 'list'/)
  // Focusing the official-model field never clears the row's current model.
  assert.doesNotMatch(source, /setPricingModelSearchText\(\(prev\) => Object\.assign\(\{\}, prev, \{ \[view\.key\]: '' \}\)\)/)
  assert.match(source, /Focusing must never clear the row's current model/)
  assert.doesNotMatch(source, /React\.createElement\('select', \{ value: mapping\.inputTokenSemantics/)
  assert.doesNotMatch(source, /输入 Token 口径/)
  assert.doesNotMatch(source, /tr\('官方厂商 ID'/)
  // Style guards for the merged table and its editors.
  assert.match(source, /max-height:392px/)
  assert.match(source, /uh-pricing-price-table \{ width:100%; min-width:0; \}/)
  assert.match(source, /uh-pricing-table-wrap \{ max-height:392px; overflow-x:hidden;/)
  assert.match(source, /uh-pricing-row-actions \{ display:flex/)
  assert.match(source, /uh-pricing-rate-input \{ box-sizing:border-box/)
  assert.match(source, /uh-pricing-table-wrap \{[^}]*overflow-y:scroll/)
  assert.match(source, /uh-side-dialog \{[^}]*overflow-y:scroll/)
  assert.match(source, /scrollbar-gutter:stable/)
  assert.match(source, /::-webkit-scrollbar/)
  assert.match(source, /scrollbar-color:#707780 #1d1f22/)
  assert.match(source, /@media \(max-width:640px\) \{[\s\S]*?uh-pricing-price-table \{ min-width:820px/)
  assert.match(source, /uh-pricing-tier-edit-row \{ grid-template-columns:minmax\(0,1fr\) 36px/)
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

// ---------- merged price table helpers ----------

const PRICING_ROUTE_KEY = JSON.stringify(['deepseek', 'deepseek-v4-flash', 'deepseek-v4-flash', null])

function flashRow(extra) {
  return Object.assign({
    identityKey: PRICING_ROUTE_KEY,
    provider: 'deepseek',
    requestedModel: 'deepseek-v4-flash',
    actualModel: 'deepseek-v4-flash',
    model: 'deepseek / deepseek-v4-flash',
    status: 'priced',
    reason: '',
    pricingModel: 'deepseek-v4-flash',
    providerId: 'deepseek',
    source: 'models.dev',
    currency: 'USD',
    rates: { input: '0.22', output: '0.66', cacheRead: '0.007', cacheWrite: '0' },
    tiered: false,
    tierCount: 0,
    inputTokenSemantics: 'fresh',
    multiplier: '1',
    temporalScheduleId: 'temporal-0',
    temporalBuiltin: true,
    usageBacked: true,
  }, extra || {})
}

// Helpers live in the vm context, so their objects never share a prototype
// with this realm: compare primitives or serialized values, never deepEqual.
function jsonOf(value) {
  return JSON.stringify(value)
}

test('pricing rows merge draft prices, mapping previews and configured rows', () => {
  const pricing = {
    usedModels: [flashRow()],
    temporalSchedules: [{ id: 'temporal-0', policies: [{ policyId: 'builtin', rules: [{ id: 'peak', weekdays: [1], windows: [{ startMinute: 60, endMinute: 240 }], rates: { input: '0.44', output: '1.32', cacheRead: '0.014', cacheWrite: '0' } }] }] }],
  }
  const base = { sync: {}, mappings: [], overrides: [] }
  const untouched = pricingRowsOf(pricing, base, {})[0]
  assert.equal(untouched.key, PRICING_ROUTE_KEY)
  assert.equal(untouched.source, 'models.dev')
  assert.equal(untouched.rates.input, '0.22')
  assert.equal(untouched.temporalBuiltin, true)
  assert.equal(untouched.temporalExplicit, false)
  assert.equal(untouched.temporalRuleCount, 1)
  assert.equal(untouched.usageBacked, true)
  assert.equal(untouched.mappable, true)
  assert.equal(untouched.basis.providerId, 'deepseek')
  assert.equal(untouched.basis.modelId, 'deepseek-v4-flash')

  const manual = {
    sync: {},
    mappings: [],
    overrides: [{ providerId: 'deepseek', modelId: 'deepseek-v4-flash', input: '0.5', output: '1.5', cacheRead: '0.02', cacheWrite: '0', tiered: true, tiers: [{ type: 'context', size: 200000, input: '1', output: '2', cacheRead: '0.1', cacheWrite: '0' }] }],
  }
  const edited = pricingRowsOf(pricing, manual, {})[0]
  assert.equal(edited.source, 'manual')
  assert.equal(edited.rates.input, '0.5')
  assert.equal(edited.tierCount, 1)
  assert.equal(edited.tiered, true)
  assert.equal(edited.overrideIndex, 0)
  // A manual price never freezes the built-in peak plan.
  assert.equal(edited.temporalBuiltin, true)
  assert.equal(edited.temporalExplicit, false)

  const mapped = {
    sync: {},
    mappings: [{ identityKey: PRICING_ROUTE_KEY, provider: 'deepseek', model: 'deepseek-v4-flash', catalogProviderId: 'openai', catalogModelId: 'gpt-5.5', inputTokenSemantics: 'total', multiplier: '1.5' }],
    overrides: [],
  }
  const preview = pricingRowsOf(pricing, mapped, { [PRICING_ROUTE_KEY]: { value: 'gpt-5.5', providerId: 'openai', rates: { input: '5', output: '30', cacheRead: '0.5', cacheWrite: '6.25' }, tiered: true, tierCount: 3 } })[0]
  assert.equal(preview.mapped, true)
  assert.equal(preview.pricingModel, 'gpt-5.5')
  assert.equal(preview.providerId, 'openai')
  assert.equal(preview.rates.input, '5')
  assert.equal(preview.tierCount, 3)
  assert.equal(preview.multiplier, '1.5')
  assert.equal(preview.inputTokenSemantics, 'total')
  assert.equal(preview.basis.modelId, 'gpt-5.5')
  assert.equal(preview.basis.providerId, 'openai')

  const configured = pricingRowsOf({ usedModels: [flashRow({ identityKey: 'configured-1', usageBacked: false, pricingModel: 'gpt-5.5', providerId: 'openai', model: 'GPT-5.5', source: 'manual' })] }, base, {})[0]
  assert.equal(configured.usageBacked, false)
  assert.equal(configured.key, 'configured-1')
  const synthetic = pricingRowsOf({ usedModels: [flashRow({ identityKey: '', providerId: null, requestedModel: 'glm-4v', actualModel: 'glm-4v', pricingModel: 'glm-4v', model: 'glm-4v', status: 'unpriced', rates: null, source: 'none' })] }, base, {})[0]
  assert.equal(synthetic.mappable, false)
  assert.equal(synthetic.key, 'price||glm-4v')
  assert.equal(synthetic.basis.providerId, '')
  assert.equal(synthetic.basis.modelId, 'glm-4v')
})

test('rate edits upsert one manual entry for the row basis and keep its bands', () => {
  const tiers = [{ type: 'context', size: 200000, input: '1', output: '2', cacheRead: '0.1', cacheWrite: '0' }]
  const view = { basis: { providerId: 'zai', modelId: 'glm-4v' }, model: 'zai / glm-4v', rates: null, tiers: [] }
  const created = pricingDraftSetRate({ sync: {}, mappings: [], overrides: [] }, view, 'input', '0.3')
  assert.equal(created.overrides.length, 1)
  assert.equal(created.overrides[0].providerId, 'zai')
  assert.equal(created.overrides[0].modelId, 'glm-4v')
  assert.equal(created.overrides[0].displayName, 'zai / glm-4v')
  assert.equal(created.overrides[0].input, '0.3')
  assert.equal(created.overrides[0].output, '0')
  assert.equal(created.overrides[0].cacheRead, '0')
  assert.equal(created.overrides[0].cacheWrite, '0')
  assert.equal(created.overrides[0].tiered, false)
  const updated = pricingDraftSetRate(created, view, 'output', '2')
  assert.equal(updated.overrides.length, 1)
  assert.equal(updated.overrides[0].output, '2')
  assert.equal(created.overrides[0].output, '0')

  const tieredView = { basis: { providerId: 'deepseek', modelId: 'deepseek-v4-flash' }, model: 'm', rates: { input: '0.22', output: '0.66', cacheRead: '0.007', cacheWrite: '0' }, tiers }
  const seeded = pricingDraftSetRate({ sync: {}, mappings: [], overrides: [] }, tieredView, 'input', '0.44')
  assert.equal(seeded.overrides[0].tiered, true)
  assert.equal(jsonOf(seeded.overrides[0].tiers), jsonOf(tiers))
  assert.equal(seeded.overrides[0].cacheRead, '0.007')
  assert.equal(pricingDraftWithoutOverride(seeded, tieredView.basis).overrides.length, 0)
  assert.equal(pricingDraftWithoutOverride(created, { providerId: '', modelId: 'nope' }).overrides.length, 1)
  assert.equal(pricingDraftUpsertOverride(created, { basis: { providerId: 'ZAI', modelId: 'GLM-4V' }, model: 'x', rates: null, tiers: [] }, { output: '9' }).overrides.length, 1)
  assert.equal(pricingDraftUpsertOverride(created, { basis: { providerId: 'ZAI', modelId: 'GLM-4V' }, model: 'x', rates: null, tiers: [] }, { output: '9' }).overrides[0].output, '9')
})

test('mapping edits write one identity mapping and can be cleared', () => {
  const view = { identityKey: PRICING_ROUTE_KEY, mappable: true, row: { provider: 'openrouter', actualModel: 'deepseek-v4-flash', requestedModel: 'deepseek-v4-flash' } }
  const draft = pricingDraftSetMapping({ sync: {}, mappings: [], overrides: [] }, view, { value: 'deepseek-v4-pro', providerId: 'deepseek' })
  assert.equal(draft.mappings.length, 1)
  assert.equal(draft.mappings[0].identityKey, PRICING_ROUTE_KEY)
  assert.equal(draft.mappings[0].provider, 'openrouter')
  assert.equal(draft.mappings[0].model, 'deepseek-v4-flash')
  assert.equal(draft.mappings[0].catalogProviderId, 'deepseek')
  assert.equal(draft.mappings[0].catalogModelId, 'deepseek-v4-pro')
  assert.equal(draft.mappings[0].inputTokenSemantics, 'fresh')
  assert.equal(draft.mappings[0].multiplier, '1')
  const tuned = pricingDraftSetMappingField(draft, view, 'multiplier', '2')
  assert.equal(tuned.mappings[0].multiplier, '2')
  assert.equal(draft.mappings[0].multiplier, '1')
  assert.equal(pricingDraftWithoutMapping(tuned, PRICING_ROUTE_KEY).mappings.length, 0)
  assert.equal(pricingDraftWithoutMapping(tuned, 'other').mappings.length, 1)
  assert.equal(pricingDraftSetMapping({ sync: {}, mappings: [], overrides: [] }, { identityKey: '', mappable: false, row: {} }, { value: 'gpt-5.5' }).mappings.length, 0)
})

test('peak and off-peak drafts round-trip, validate and reject overlapping windows', () => {
  assert.equal(pricingTimeTextToMinute('01:30'), 90)
  assert.equal(pricingTimeTextToMinute('1:5'), 65)
  assert.equal(pricingTimeTextToMinute('24:00'), 1440)
  assert.equal(pricingTimeTextToMinute('0100'), null)
  assert.equal(pricingTimeTextToMinute('25:00'), null)
  assert.equal(pricingTimeTextToMinute(''), null)
  assert.equal(pricingMinuteToTimeText(90), '01:30')
  assert.equal(pricingMinuteToTimeText(1440), '24:00')
  assert.equal(pricingDateTextToUtc(''), 0)
  assert.equal(pricingDateTextToUtc('2026-08-16'), Date.UTC(2026, 7, 16))
  assert.equal(pricingDateTextToUtc('2026-02-30'), null)
  assert.equal(pricingDateTextToUtc('16/08/2026'), null)

  const plan = {
    policies: [{
      policyId: 'custom-peak',
      timezone: 'UTC',
      effectiveFrom: Date.UTC(2026, 7, 16),
      effectiveUntil: null,
      defaultPlan: null,
      rules: [{ id: 'peak', weekdays: [5, 1, 2], windows: [{ startMinute: 60, endMinute: 240 }, { startMinute: 360, endMinute: 600 }], rates: { input: '0.44', output: '1.32', cacheRead: '0.014', cacheWrite: '0' } }],
    }],
  }
  const draft = pricingTemporalDraftOfPlan(plan)
  assert.equal(draft.policyId, 'custom-peak')
  assert.equal(draft.effectiveFromText, '2026-08-16')
  assert.equal(jsonOf(draft.rules[0].weekdays), jsonOf([1, 2, 5]))
  assert.equal(jsonOf(draft.rules[0].windows), jsonOf([{ start: '01:00', end: '04:00' }, { start: '06:00', end: '10:00' }]))
  assert.equal(pricingTemporalDraftValidationError(draft), '')
  const wire = pricingTemporalPlanFromDraft(draft)
  assert.equal(jsonOf(wire.policies[0].rules[0].windows), jsonOf([{ startMinute: 60, endMinute: 240 }, { startMinute: 360, endMinute: 600 }]))
  assert.equal(wire.policies[0].effectiveFrom, Date.UTC(2026, 7, 16))
  assert.equal(wire.policies[0].timezone, 'UTC')
  assert.equal(wire.policies[0].defaultPlan, null)
  assert.equal(pricingTemporalDraftOfPlan({ policies: [] }), null)
  assert.equal(pricingTemporalDraftValidationError(pricingTemporalDraftDefault(null)), '')
  assert.equal(pricingTemporalDraftValidationError({ policyId: '', effectiveFromText: '', rules: draft.rules }), 'temporal')
  assert.equal(pricingTemporalDraftValidationError({ policyId: 'p', effectiveFromText: 'nope', rules: draft.rules }), 'temporal')
  const noDays = pricingTemporalDraftClone(draft)
  noDays.rules[0].weekdays = []
  assert.equal(pricingTemporalDraftValidationError(noDays), 'temporal')
  const reversed = pricingTemporalDraftClone(draft)
  reversed.rules[0].windows = [{ start: '04:00', end: '01:00' }]
  assert.equal(pricingTemporalDraftValidationError(reversed), 'temporal')
  const badRate = pricingTemporalDraftClone(draft)
  badRate.rules[0].rates.output = ''
  assert.equal(pricingTemporalDraftValidationError(badRate), 'temporal')
  const overlapping = { policyId: 'p', effectiveFromText: '', rules: [{ id: 'a', weekdays: [1], windows: [{ start: '01:00', end: '05:00' }], rates: { input: '1', output: '1', cacheRead: '0', cacheWrite: '0' } }, { id: 'b', weekdays: [1], windows: [{ start: '04:00', end: '08:00' }], rates: { input: '1', output: '1', cacheRead: '0', cacheWrite: '0' } }] }
  assert.equal(pricingTemporalDraftValidationError(overlapping), 'temporal')
  const disjoint = pricingTemporalDraftClone(overlapping)
  disjoint.rules[1].weekdays = [2]
  assert.equal(pricingTemporalDraftValidationError(disjoint), '')
  assert.equal(pricingTemporalDraftToggleWeekday(disjoint, 1, 2).rules[1].weekdays.length, 0)
  assert.equal(jsonOf(pricingTemporalDraftToggleWeekday(disjoint, 1, 5).rules[1].weekdays), jsonOf([2, 5]))
  assert.equal(pricingTemporalDraftWithRule(disjoint).rules.length, 3)
  assert.equal(pricingTemporalDraftWithoutRule(disjoint, 0).rules.length, 1)
  assert.equal(pricingTemporalDraftWithoutRule(disjoint, 1).rules.length, 1)
  // Loose drafts take part in the save validation.
  assert.equal(pricingDraftValidationError({ mappings: [], overrides: [] }, { row: overlapping }), 'temporal')
  assert.equal(pricingDraftValidationError({ mappings: [], overrides: [] }, { row: draft }), '')
})

test('tier draft helpers keep thresholds increasing and bands removable', () => {
  const first = pricingTierDraftAdd([], { input: '1', output: '2', cacheRead: '0.1', cacheWrite: '0' })
  assert.equal(jsonOf(first), jsonOf([{ type: 'context', size: 200000, input: '1', output: '2', cacheRead: '0.1', cacheWrite: '0' }]))
  const second = pricingTierDraftAdd(first, null)
  assert.equal(second[1].size, 300000)
  assert.equal(second[1].input, '1')
  const patched = pricingTierDraftUpdate(second, 0, 'size', '250000')
  assert.equal(patched[0].size, '250000')
  assert.equal(second[0].size, 200000)
  assert.equal(pricingTierDraftRemove(patched, 0).length, 1)
})

test('a payload from an older host still reports its peak plan', () => {
  const base = { sync: {}, mappings: [], overrides: [] }
  const legacy = flashRow({ temporalScheduleId: undefined, temporalBuiltin: undefined, temporalPolicyId: 'deepseek-v4-2026-08-pricing', temporalRoute: 'official' })
  const view = pricingRowsOf({ usedModels: [legacy] }, base, {})[0]
  assert.equal(view.temporalRulesUnavailable, true)
  assert.equal(view.temporalBuiltin, true)
  assert.equal(view.temporalExplicit, false)
  assert.equal(view.temporalPolicyId, 'deepseek-v4-2026-08-pricing')
  assert.equal(view.temporalRuleCount, 0)
  // A reseller route is never promoted to a peak-plan row.
  const reseller = pricingRowsOf({ usedModels: [flashRow({ temporalScheduleId: undefined, temporalBuiltin: undefined, temporalPolicyId: 'deepseek-v4-2026-08-pricing', temporalRoute: 'other' })] }, base, {})[0]
  assert.equal(reseller.temporalRulesUnavailable, false)
  assert.equal(reseller.temporalBuiltin, false)
  // The current payload shape keeps its schedule and rule count.
  const modern = pricingRowsOf({ usedModels: [flashRow()], temporalSchedules: [{ id: 'temporal-0', policies: [{ policyId: 'builtin', rules: [{ id: 'peak', weekdays: [1], windows: [{ startMinute: 60, endMinute: 240 }], rates: { input: '1', output: '1', cacheRead: '0', cacheWrite: '0' } }] }] }] }, base, {})[0]
  assert.equal(modern.temporalRulesUnavailable, false)
  assert.equal(modern.temporalBuiltin, true)
  assert.equal(modern.temporalRuleCount, 1)
})

// ---------- row memoization ----------

test('the row comparator bails out for identical rows and re-renders on any change', () => {
  const empty = { sync: {}, mappings: [], overrides: [] }
  const view = pricingRowsOf({ usedModels: [flashRow()] }, empty, {})[0]
  const base = { view, busy: false, language: 'zh', openSection: null, searchText: null, searchOpen: false, searchOptions: null, temporalDraft: null, temporalPlan: view.temporalPlan }
  // A rebuilt row with identical content must still bail out.
  const clone = pricingRowsOf({ usedModels: [flashRow()] }, empty, {})[0]
  assert.notEqual(clone, view)
  assert.equal(pricingRowViewEqual(view, clone), true)
  assert.equal(pricingRowPropsEqual(base, Object.assign({}, base, { view: clone })), true)
  assert.equal(pricingRowPropsEqual(base, base), true)
  // Every rendered property invalidates the bailout.
  assert.equal(pricingRowPropsEqual(base, Object.assign({}, base, { busy: true })), false)
  assert.equal(pricingRowPropsEqual(base, Object.assign({}, base, { language: 'en' })), false)
  assert.equal(pricingRowPropsEqual(base, Object.assign({}, base, { openSection: view.key + '|tiers' })), false)
  assert.equal(pricingRowPropsEqual(base, Object.assign({}, base, { searchText: 'gpt' })), false)
  assert.equal(pricingRowPropsEqual(base, Object.assign({}, base, { searchOpen: true })), false)
  assert.equal(pricingRowPropsEqual(base, Object.assign({}, base, { searchOptions: [{ value: 'gpt-5.5' }] })), false)
  assert.equal(pricingRowPropsEqual(base, Object.assign({}, base, { temporalDraft: { policyId: 'custom-peak', effectiveFromText: '', rules: [] } })), false)
  assert.equal(pricingRowPropsEqual(base, Object.assign({}, base, { temporalPlan: { policies: [] } })), false)
  // Price, band, mapping and peak-plan changes are all visible.
  const editedRate = pricingRowsOf({ usedModels: [flashRow()] }, { sync: {}, mappings: [], overrides: [{ providerId: 'deepseek', modelId: 'deepseek-v4-flash', input: '9', output: '0.66', cacheRead: '0.007', cacheWrite: '0' }] }, {})[0]
  assert.equal(pricingRowPropsEqual(base, Object.assign({}, base, { view: editedRate })), false)
  const editedTiers = pricingRowsOf({ usedModels: [flashRow()] }, { sync: {}, mappings: [], overrides: [{ providerId: 'deepseek', modelId: 'deepseek-v4-flash', input: '0.22', output: '0.66', cacheRead: '0.007', cacheWrite: '0', tiered: true, tiers: [{ type: 'context', size: 200000, input: '1', output: '2', cacheRead: '0.1', cacheWrite: '0' }] }] }, {})[0]
  assert.equal(pricingRowPropsEqual(base, Object.assign({}, base, { view: editedTiers })), false)
  const mapped = pricingRowsOf({ usedModels: [flashRow()] }, { sync: {}, mappings: [{ identityKey: PRICING_ROUTE_KEY, provider: 'deepseek', model: 'deepseek-v4-flash', catalogProviderId: 'openai', catalogModelId: 'gpt-5.5' }], overrides: [] }, {})[0]
  assert.equal(pricingRowPropsEqual(base, Object.assign({}, base, { view: mapped })), false)
  // The legacy peak-plan fallback is part of the row identity too.
  const legacy = pricingRowsOf({ usedModels: [flashRow({ temporalScheduleId: undefined, temporalBuiltin: undefined, temporalPolicyId: 'deepseek-v4-2026-08-pricing', temporalRoute: 'official' })] }, empty, {})[0]
  assert.equal(pricingRowPropsEqual(base, Object.assign({}, base, { view: legacy })), false)
  assert.equal(pricingRatesEqual(null, null), true)
  assert.equal(pricingRatesEqual({ input: '1' }, null), false)
  assert.equal(pricingTiersEqual([], []), true)
  assert.equal(pricingTiersEqual([{ size: 1 }], [{ size: 2 }]), false)
})

test('holiday drafts round-trip dates and ranges', () => {
  const plan = { policies: [{ policyId: 'p', timezone: 'UTC', effectiveFrom: 0, effectiveUntil: null, defaultPlan: null, holidays: ['2026-10-01', '2026-10-02'], rules: [{ id: 'peak', weekdays: [1], windows: [{ startMinute: 60, endMinute: 240 }], rates: { input: '1', output: '1', cacheRead: '0', cacheWrite: '0' } }] }] }
  const draft = pricingTemporalDraftOfPlan(plan)
  assert.equal(draft.holidaysEnabled, true)
  assert.equal(draft.holidaysText, '2026-10-01\n2026-10-02')
  assert.equal(pricingTemporalDraftValidationError(draft), '')
  assert.equal(jsonOf(pricingTemporalPlanFromDraft(draft).policies[0].holidays), jsonOf(['2026-10-01', '2026-10-02']))
  assert.equal(jsonOf(pricingHolidayDatesFromText('2026-10-01..2026-10-03\n2026-10-02\n2025-01-01')), jsonOf(['2025-01-01', '2026-10-01', '2026-10-02', '2026-10-03']))
  assert.equal(jsonOf(pricingHolidayDatesFromText('')), jsonOf([]))
  assert.equal(pricingHolidayDatesFromText('2026-02-30'), null)
  assert.equal(pricingHolidayDatesFromText('2026-10-05..2026-10-01'), null)
  assert.equal(pricingHolidayDatesFromText('2026-10-01..'), null)
  assert.equal(pricingHolidayDatesFromText('国庆'), null)
  const broken = pricingTemporalDraftClone(draft)
  broken.holidaysText = '国庆'
  assert.equal(pricingTemporalDraftValidationError(broken), 'temporal')
  assert.equal(pricingDraftValidationError({ mappings: [], overrides: [] }, { row: broken }), 'temporal')
  const disabled = pricingTemporalDraftClone(draft)
  disabled.holidaysEnabled = false
  disabled.holidaysText = '国庆'
  assert.equal(pricingTemporalDraftValidationError(disabled), '')
  assert.equal(jsonOf(pricingTemporalPlanFromDraft(disabled).policies[0].holidays), jsonOf([]))
  assert.equal(pricingTemporalDraftClone(draft).holidaysEnabled, true)
  assert.equal(pricingTemporalDraftDefault(null).holidaysEnabled, false)
  assert.equal(pricingTemporalDraftDefault(null).holidaysText, '')
  // The comparator sees holiday-only plan changes through the plan identity.
  const view = { key: 'k', model: 'm', status: 'priced', tiers: [], rates: null, basis: { providerId: '', modelId: 'm' } }
  assert.equal(pricingRowViewEqual(view, Object.assign({}, view)), true)
})

test('holiday text merges fetched dates and the plan carries its provenance', () => {
  assert.equal(pricingHolidayTextMerge('', ['2026-10-02', '2026-10-01']), '2026-10-01\n2026-10-02')
  assert.equal(pricingHolidayTextMerge('2026-10-02', ['2026-10-01', '2026-10-02']), '2026-10-01\n2026-10-02')
  assert.equal(pricingHolidayTextMerge('2026-05-01..2026-05-02', ['2026-05-01', '2026-01-01']), '2026-01-01\n2026-05-01\n2026-05-02')
  // A malformed existing list cannot poison the merge: the fetched dates survive.
  assert.equal(pricingHolidayTextMerge('国庆', ['2026-10-01']), '2026-10-01')
  assert.equal(pricingHolidayTextMerge('2026-10-01', []), '2026-10-01')
  assert.equal(pricingHolidayTextMerge('', []), '')
  const plan = { policies: [{ policyId: 'p', timezone: 'UTC', effectiveFrom: 0, effectiveUntil: null, defaultPlan: null, holidays: ['2026-10-01'], holidaysSource: 'https://www.gov.cn/zhengce/content_7047091.htm · 2026-09-28 04:00', rules: [{ id: 'peak', weekdays: [1], windows: [{ startMinute: 60, endMinute: 240 }], rates: { input: '1', output: '1', cacheRead: '0', cacheWrite: '0' } }] }] }
  const draft = pricingTemporalDraftOfPlan(plan)
  assert.equal(draft.holidaysSourceText, 'https://www.gov.cn/zhengce/content_7047091.htm · 2026-09-28 04:00')
  assert.equal(pricingTemporalPlanFromDraft(draft).policies[0].holidaysSource, 'https://www.gov.cn/zhengce/content_7047091.htm · 2026-09-28 04:00')
  const fetched = Object.assign(pricingTemporalDraftClone(draft), { holidaysEnabled: true, holidaysText: pricingHolidayTextMerge(draft.holidaysText, ['2026-10-02']), holidaysSourceText: 'holiday-cn · 2026-09-28 05:00' })
  assert.equal(pricingTemporalDraftValidationError(fetched), '')
  const wire = pricingTemporalPlanFromDraft(fetched)
  assert.equal(jsonOf(wire.policies[0].holidays), jsonOf(['2026-10-01', '2026-10-02']))
  assert.equal(wire.policies[0].holidaysSource, 'holiday-cn · 2026-09-28 05:00')
  // The row comparator notices the loader state of an open editor.
  const view = pricingRowsOf({ usedModels: [flashRow()] }, { sync: {}, mappings: [], overrides: [] }, {})[0]
  const base = { view, busy: false, language: 'zh', openSection: null, searchText: null, searchOpen: false, searchOptions: null, temporalDraft: null, temporalPlan: view.temporalPlan, holidayStatus: '', holidayLoading: false }
  assert.equal(pricingRowPropsEqual(base, Object.assign({}, base)), true)
  assert.equal(pricingRowPropsEqual(base, Object.assign({}, base, { holidayLoading: true })), false)
  assert.equal(pricingRowPropsEqual(base, Object.assign({}, base, { holidayStatus: '已载入 33 天' })), false)
})
