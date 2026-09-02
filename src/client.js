// dsh-all-usage 插件 Client 半（永久版，浏览器 bundle）
// 客户端模块工厂格式：window.__ModuleLoader__.load({ id, factory })
window.__ModuleLoader__.load({
  id: "dsh-all-usage",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");

    function pad2(n) {
      return String(n).padStart(2, '0')
    }
    function fmtDate(d, utc) {
      const year = utc ? d.getUTCFullYear() : d.getFullYear()
      const month = utc ? d.getUTCMonth() : d.getMonth()
      const day = utc ? d.getUTCDate() : d.getDate()
      return year + '-' + pad2(month + 1) + '-' + pad2(day)
    }
    function shiftCalendarDate(d, days, utc) {
      if (utc) return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + days))
      return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days)
    }
    function isCalendarDate(value, utc) {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
      const year = Number(value.slice(0, 4))
      const month = Number(value.slice(5, 7))
      const day = Number(value.slice(8, 10))
      const date = utc ? new Date(Date.UTC(year, month - 1, day)) : new Date(year, month - 1, day)
      return Number.isFinite(date.getTime()) && fmtDate(date, utc) === value
    }
    function normalizeCustomRange(range, utc) {
      if (range === null || typeof range !== 'object') return null
      const start = range.start
      const end = range.end
      if (!isCalendarDate(start, utc) || !isCalendarDate(end, utc) || start > end) return null
      return { start, end }
    }
    function customRangeIssue(range, minDate, maxDate, utc) {
      if (range === null || typeof range !== 'object' || !isCalendarDate(range.start, utc) || !isCalendarDate(range.end, utc)) return 'invalid'
      if (range.start > range.end) return 'order'
      if (range.start < minDate || range.end > maxDate) return 'bounds'
      return ''
    }
    function availableDateBounds(days, maxDate) {
      let min = maxDate
      if (Array.isArray(days)) {
        for (const day of days) {
          if (day && isCalendarDate(day.date, true) && day.date <= maxDate && day.date < min) min = day.date
        }
      }
      return { min, max: maxDate }
    }
    function createRequestGate() {
      let latest = 0
      return {
        next() { latest += 1; return latest },
        isCurrent(seq) { return seq === latest },
      }
    }
    function snapshotVersion(data) {
      if (data === null || typeof data !== 'object') return null
      const instanceId = typeof data.instanceId === 'string' ? data.instanceId : ''
      const revision = typeof data.revision === 'number' && Number.isFinite(data.revision) ? data.revision : null
      return instanceId === '' || revision === null ? null : instanceId + ':' + revision
    }
    function revisionPart(data, key, fallback) {
      const value = data && typeof data === 'object' ? data[key] : undefined
      return typeof value === 'number' && Number.isFinite(value) ? value : fallback
    }
    function hasSplitRevisions(data) {
      return data !== null && typeof data === 'object' && ['dataRevision', 'metadataRevision', 'scanRevision', 'pricingRevision'].every((key) => revisionPart(data, key, null) !== null)
    }
    function queryVersion(data) {
      if (data === null || typeof data !== 'object' || typeof data.instanceId !== 'string' || data.instanceId === '') return null
      if (typeof data.queryRevision === 'string' && data.queryRevision !== '') return data.instanceId + ':' + data.queryRevision
      const dataRevision = revisionPart(data, 'dataRevision', revisionPart(data, 'revision', null))
      const pricingRevision = revisionPart(data, 'pricingRevision', 0)
      return dataRevision === null ? null : data.instanceId + ':' + dataRevision + ':' + pricingRevision
    }
    function metadataVersion(data) {
      if (data === null || typeof data !== 'object' || typeof data.instanceId !== 'string' || data.instanceId === '') return null
      const metadataRevision = revisionPart(data, 'metadataRevision', revisionPart(data, 'revision', null))
      return metadataRevision === null ? null : data.instanceId + ':' + metadataRevision
    }
    function statusRefreshKind(status, snapshot) {
      if (status === null || typeof status !== 'object' || snapshot === null || typeof snapshot !== 'object') return 'full'
      if (typeof status.instanceId !== 'string' || typeof snapshot.instanceId !== 'string' || status.instanceId === '' || status.instanceId !== snapshot.instanceId) return 'full'
      if (hasSplitRevisions(status) && hasSplitRevisions(snapshot)) {
        if (status.metadataRevision !== snapshot.metadataRevision) return 'full'
        // Check pricing first: when data and pricing move together a query-only
        // refresh would merge the new pricing revision into the applied baseline
        // and the summary costs/dialog would never see the change.
        if (status.pricingRevision !== snapshot.pricingRevision) return 'full'
        if (status.dataRevision !== snapshot.dataRevision) return 'query'
        const statusScan = status.scan
        const snapshotScan = snapshot.scan
        if (status.scanRevision !== snapshot.scanRevision || !!(statusScan && snapshotScan && !!statusScan.done !== !!snapshotScan.done)) return 'status'
        return 'none'
      }
      const statusVersion = snapshotVersion(status)
      const snapshotVersionValue = snapshotVersion(snapshot)
      if (statusVersion === null || snapshotVersionValue === null || statusVersion !== snapshotVersionValue) return 'full'
      const statusScan = status.scan
      const snapshotScan = snapshot.scan
      return !!(statusScan && snapshotScan && !!statusScan.done !== !!snapshotScan.done) ? 'full' : 'none'
    }
    function statusRequiresFullSnapshot(status, snapshot) {
      return statusRefreshKind(status, snapshot) === 'full'
    }
    function statusRequiresQueryRefresh(status, snapshot) {
      return statusRefreshKind(status, snapshot) === 'query'
    }
    function retryDelayFor(failures) {
      const count = Math.max(1, Math.min(4, typeof failures === 'number' && Number.isFinite(failures) ? failures : 1))
      return 5000 * Math.pow(2, count - 1)
    }
    function rangeFilenamePart(range, customRange, utc) {
      if (range !== 'custom') return range
      const normalized = normalizeCustomRange(customRange, utc)
      return normalized === null ? 'custom' : 'custom-' + normalized.start + '-to-' + normalized.end
    }
    function trim1(v) {
      return String(Math.round(v * 10) / 10)
    }
    function fmtCompact(n) {
      if (typeof n !== 'number' || !Number.isFinite(n)) return '0'
      if (n < 1000) return String(n)
      if (n < 1000000) return trim1(n / 1000) + 'k'
      if (n < 1000000000) return trim1(n / 1000000) + 'M'
      return trim1(n / 1000000000) + 'B'
    }
    function fmtCount(n, language) {
      if (typeof n !== 'number' || !Number.isFinite(n)) return '0'
      return Math.round(n).toLocaleString(language === 'en' ? 'en-US' : 'zh-CN')
    }
    function rateOf(input, cacheRead) {
      const denom = input + cacheRead
      if (denom <= 0) return 0
      return (cacheRead / denom) * 100
    }
    function LineIcon(props) {
      const size = props.size || 16
      const base = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' }
      const paths = {
        edit: [React.createElement('path', { key: 'a', d: 'M12.2 3.4l2.4 2.4M4 16l2.8-.6L15 7.2a1.7 1.7 0 0 0-2.4-2.4L4.4 13z', ...base })],
        export: [React.createElement('path', { key: 'a', d: 'M12 3v11M8 7l4-4 4 4M5 13v5h14v-5', ...base })],
        refresh: [React.createElement('path', { key: 'a', d: 'M19 9a7 7 0 1 0 1.1 5.2M19 4v5h-5', ...base })],
        close: [React.createElement('path', { key: 'a', d: 'M6 6l12 12M18 6L6 18', ...base })],
        chart: [React.createElement('path', { key: 'a', d: 'M4 19V5M4 19h16M7 15l3-4 3 2 5-7', ...base })],
        list: [React.createElement('path', { key: 'a', d: 'M6 6h12M6 12h12M6 18h12', ...base }), React.createElement('circle', { key: 'b', cx: 3.5, cy: 6, r: .7, fill: 'currentColor' }), React.createElement('circle', { key: 'c', cx: 3.5, cy: 12, r: .7, fill: 'currentColor' }), React.createElement('circle', { key: 'd', cx: 3.5, cy: 18, r: .7, fill: 'currentColor' })],
        cache: [React.createElement('path', { key: 'a', d: 'M12 4l7 4-7 4-7-4 7-4zM5 12l7 4 7-4M5 16l7 4 7-4', ...base })],
        wallet: [React.createElement('path', { key: 'a', d: 'M4 7.5A2.5 2.5 0 0 1 6.5 5H18v14H6.5A2.5 2.5 0 0 1 4 16.5zM4 8h14M14 13h.01', ...base })],
        clock: [React.createElement('path', { key: 'a', d: 'M12 6v6l4 2M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0z', ...base })],
        folder: [React.createElement('path', { key: 'a', d: 'M3.5 7.5h6l2 2h9v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z', ...base })],
        language: [React.createElement('circle', { key: 'a', cx: 12, cy: 12, r: 8, ...base }), React.createElement('path', { key: 'b', d: 'M4 12h16M12 4c2.1 2.2 3.2 4.9 3.2 8S14.1 17.8 12 20M12 4C9.9 6.2 8.8 8.9 8.8 12s1.1 5.8 3.2 8', ...base })],
        chevron: [React.createElement('path', { key: 'a', d: 'M7 10l5 5 5-5', ...base })],
        check: [React.createElement('path', { key: 'a', d: 'M5 12.5l4.2 4.1L19 7.3', ...base })],
        plus: [React.createElement('path', { key: 'a', d: 'M12 5v14M5 12h14', ...base })],
        calendar: [React.createElement('path', { key: 'a', d: 'M6 4v3M18 4v3M4 9h16M5 6h14a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z', ...base })],
      }
      return React.createElement('svg', { className: 'uh-line-icon ' + (props.className || ''), width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': true }, paths[props.name] || paths.chart)
    }
    // Model brand icons are embedded by scripts/build-client.mjs at build time
    // (data: URIs only, no runtime file or network access). The placeholder is
    // replaced with the validated icon table; a plain source checkout keeps the
    // neutral fallback dot.
    const MODEL_ICONS = /* __MODEL_ICON_DATA__ */ null
    const MODEL_ICON_TABLE = Array.isArray(MODEL_ICONS) ? MODEL_ICONS : []
    const MODEL_ICON_BY_KEY = new Map(MODEL_ICON_TABLE.map((icon) => [icon.key, icon]))
    const MODEL_ICON_CACHE = new Map()
    function normalizeIconModel(value) {
      if (typeof value !== 'string') return ''
      let text = value.trim().toLowerCase()
      const slash = text.lastIndexOf('/')
      if (slash >= 0) text = text.slice(slash + 1)
      return text.split(':')[0].replace(/@/g, '-').trim()
    }
    function iconForProvider(provider) {
      const normalized = typeof provider === 'string' ? provider.trim().toLowerCase() : ''
      if (normalized === '') return null
      for (const icon of MODEL_ICON_TABLE) if (icon.providers.includes(normalized)) return icon
      return null
    }
    function iconForModel(model) {
      const normalized = normalizeIconModel(model)
      if (normalized === '') return null
      for (const icon of MODEL_ICON_TABLE) if (icon.exact.includes(normalized)) return icon
      let best = null
      let bestLength = 0
      for (const icon of MODEL_ICON_TABLE) {
        for (const prefix of icon.prefixes) {
          if (prefix !== '' && normalized.startsWith(prefix) && prefix.length > bestLength) { best = icon; bestLength = prefix.length }
        }
      }
      return best
    }
    /**
     * Resolve one row to a brand icon. Model namespaces win over the DSH
     * provider name so reseller and gateway routes (openrouter, siliconflow,
     * custom gateways) are attributed by the model they actually served; an
     * unknown or conflicting row keeps the neutral fallback.
     */
    function resolveModelIcon(row) {
      if (MODEL_ICON_TABLE.length === 0 || row === null || typeof row !== 'object') return null
      const actual = typeof row.actualModel === 'string' ? row.actualModel : ''
      const requested = typeof row.requestedModel === 'string' ? row.requestedModel : ''
      const label = typeof row.model === 'string' ? row.model : ''
      const provider = typeof row.provider === 'string' ? row.provider : ''
      const cacheKey = actual + '\u0000' + requested + '\u0000' + label + '\u0000' + provider
      if (MODEL_ICON_CACHE.has(cacheKey)) return MODEL_ICON_CACHE.get(cacheKey)
      const labelModel = label.includes(' / ') ? label.slice(label.indexOf(' / ') + 3) : label
      let icon = iconForModel(actual) || iconForModel(requested)
      if (icon === null) {
        const providerIcon = iconForProvider(provider)
        const labelIcon = iconForModel(labelModel)
        // A provider-only match must not contradict the model namespace.
        icon = providerIcon !== null && (labelIcon === null || labelIcon === providerIcon) ? providerIcon : labelIcon
      }
      MODEL_ICON_CACHE.set(cacheKey, icon)
      return icon
    }
    /** Icon for an aggregate row: only when every member maps to one brand. */
    function resolveAggregateModelIcon(rows) {
      if (!Array.isArray(rows) || rows.length === 0) return null
      let icon = null
      for (const row of rows) {
        const candidate = resolveModelIcon(row)
        if (candidate === null) return null
        if (icon === null) icon = candidate
        else if (icon !== candidate) return null
      }
      return icon
    }
    function chineseMagnitude(n, language) {
      if (language === 'en' || typeof n !== 'number' || !Number.isFinite(n) || n < 10000) return ''
      const value = n >= 100000000 ? n / 100000000 : n / 10000
      const rounded = Math.round(value * 1000) / 1000
      return String(rounded) + (n >= 100000000 ? '亿' : '万')
    }
    function valueWithMagnitude(value, raw, language) {
      const magnitude = chineseMagnitude(raw, language)
      return React.createElement(React.Fragment, null, value, magnitude ? React.createElement('span', { className: 'uh-unit' }, magnitude) : null)
    }
    function money(currency, n, language) {
      if (n === null || n === undefined) return '—'
      const sym = currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : currency + ' '
      return sym + n.toLocaleString(language === 'en' ? 'en-US' : 'zh-CN', { minimumFractionDigits: 4, maximumFractionDigits: 4 })
    }
    function decimalParts(value) {
      const raw = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim().toLowerCase() : ''
      const match = raw.match(/^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/)
      if (!match) return { digits: 0n, scale: 0 }
      let digits = (match[1] || '') + (match[2] || '')
      let scale = (match[2] || '').length - (match[3] ? Number(match[3]) : 0)
      if (scale < 0) { digits += '0'.repeat(-scale); scale = 0 }
      if (scale > digits.length) digits = '0'.repeat(scale - digits.length + 1) + digits
      while (scale > 0 && digits.length > 1 && digits.endsWith('0')) { digits = digits.slice(0, -1); scale -= 1 }
      return { digits: BigInt(digits.replace(/^0+(?=\d)/, '') || '0'), scale }
    }
    function decimalText(value) {
      const parts = decimalParts(value)
      if (parts.digits === 0n) return '0'
      const raw = parts.digits.toString()
      if (parts.scale === 0) return raw
      const padded = raw.padStart(parts.scale + 1, '0')
      const split = padded.length - parts.scale
      return padded.slice(0, split) + '.' + padded.slice(split)
    }
    function decimalAdd(left, right) {
      const a = decimalParts(left); const b = decimalParts(right)
      const scale = Math.max(a.scale, b.scale)
      const value = a.digits * 10n ** BigInt(scale - a.scale) + b.digits * 10n ** BigInt(scale - b.scale)
      return decimalText(value.toString() + (scale > 0 ? 'e-' + scale : ''))
    }
    function emptyCostAggregate() {
      return { currency: 'USD', input: '0', output: '0', cacheRead: '0', cacheWrite: '0', baseTotal: '0', total: '0', pricedCalls: 0, unpricedCalls: 0, ambiguousCalls: 0, unsupportedCalls: 0 }
    }
    function costAggregate(row) {
      const source = row && row.cost && typeof row.cost === 'object' ? row.cost : (row && typeof row === 'object' ? row : {})
      const value = emptyCostAggregate()
      value.currency = typeof source.currency === 'string' && source.currency !== '' ? source.currency : 'USD'
      if (source.breakdown && typeof source.breakdown === 'object') {
        if (source.status === 'priced') {
          value.input = decimalText(source.breakdown.input)
          value.output = decimalText(source.breakdown.output)
          value.cacheRead = decimalText(source.breakdown.cacheRead)
          value.cacheWrite = decimalText(source.breakdown.cacheWrite)
          value.baseTotal = decimalText(source.baseTotal)
          value.total = decimalText(source.total)
          value.pricedCalls = 1
        } else if (source.status === 'ambiguous') value.ambiguousCalls = 1
        else if (source.status === 'unsupported') value.unsupportedCalls = 1
        else value.unpricedCalls = 1
        return value
      }
      for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'baseTotal', 'total']) value[key] = decimalText(source[key])
      for (const key of ['pricedCalls', 'unpricedCalls', 'ambiguousCalls', 'unsupportedCalls']) value[key] = Number.isFinite(source[key]) ? source[key] : 0
      return value
    }
    function addCostAggregate(target, row) {
      const value = costAggregate(row)
      for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'baseTotal', 'total']) target[key] = decimalAdd(target[key], value[key])
      target.pricedCalls += value.pricedCalls
      target.unpricedCalls += value.unpricedCalls
      target.ambiguousCalls += value.ambiguousCalls
      target.unsupportedCalls += value.unsupportedCalls
      return target
    }
    function costDisplay(row, language) {
      const value = costAggregate(row)
      if (value.pricedCalls <= 0) return '—'
      const numeric = Number(value.total)
      return Number.isFinite(numeric) ? money(value.currency, numeric, language) : value.currency + ' ' + value.total
    }
    function costBandLabel(row, language) {
      const cost = row && row.cost && typeof row.cost === 'object' ? row.cost : {}
      if (cost.pricingBand === 'peak') return language === 'en' ? 'Peak' : '峰时'
      if (cost.pricingBand === 'off-peak') return language === 'en' ? 'Off-peak' : '谷时'
      if (cost.temporalExemptReason === 'route-not-official') return language === 'en' ? 'static (non-first-party)' : '静态价（非官方直连）'
      if (cost.temporalExemptReason === 'no-temporal-profile') return language === 'en' ? 'static (no band plan)' : '静态价（无峰谷计划）'
      return '—'
    }
    function costPolicyLabel(row, language) {
      const cost = row && row.cost && typeof row.cost === 'object' ? row.cost : {}
      const parts = []
      if (cost.pricingPolicyId) parts.push(cost.pricingPolicyId)
      if (cost.pricingTimezone === 'UTC' && Number.isFinite(cost.pricingAt)) parts.push((language === 'en' ? 'at ' : '计费时刻 ') + new Date(cost.pricingAt).toISOString().slice(0, 16).replace('T', ' ') + ' UTC')
      return parts.length > 0 ? parts.join(' · ') : null
    }
    function costCoverageLabel(row, language) {
      const value = costAggregate(row)
      if (value.pricedCalls > 0 && value.unpricedCalls === 0 && value.ambiguousCalls === 0 && value.unsupportedCalls === 0) return language === 'en' ? value.pricedCalls + ' priced' : value.pricedCalls + ' 次已计价'
      const pending = value.unpricedCalls + value.ambiguousCalls + value.unsupportedCalls
      return pending > 0 ? (language === 'en' ? pending + ' unpriced' : pending + ' 次未计价') : (language === 'en' ? 'No pricing' : '暂无价格')
    }
    function pricingDraftOf(pricing) {
      const config = pricing && pricing.config && typeof pricing.config === 'object' ? pricing.config : {}
      const sync = config.sync && typeof config.sync === 'object' ? config.sync : {}
      return {
        sync: { autoEnabled: sync.autoEnabled === true, intervalMs: Number.isFinite(sync.intervalMs) ? sync.intervalMs : 21600000 },
        providerAliases: config.providerAliases && typeof config.providerAliases === 'object' ? Object.assign({}, config.providerAliases) : {},
        mappings: Array.isArray(config.mappings) ? config.mappings.map((mapping) => Object.assign({}, mapping)) : [],
        overrides: Array.isArray(config.overrides) ? config.overrides.map((entry) => Object.assign({}, entry, { tiers: Array.isArray(entry.tiers) ? entry.tiers.map((tier) => Object.assign({}, tier)) : [] })) : [],
      }
    }
    function pricingUsedModelsOf(pricing) {
      const schedules = new Map()
      const rows = pricing && Array.isArray(pricing.tierSchedules) ? pricing.tierSchedules : []
      for (const schedule of rows) {
        if (!schedule || typeof schedule.id !== 'string' || !Array.isArray(schedule.tiers)) continue
        schedules.set(schedule.id, schedule.tiers)
      }
      return pricing && Array.isArray(pricing.usedModels) ? pricing.usedModels.map((model) => {
        const referenced = model && typeof model.tierScheduleId === 'string' ? schedules.get(model.tierScheduleId) : null
        const tiers = Array.isArray(referenced) ? referenced : model && Array.isArray(model.tiers) ? model.tiers : []
        return Object.assign({}, model, { tiers: tiers.map((tier) => Object.assign({}, tier)) })
      }) : []
    }
    function pricingDraftAfterSync(previous, pricing) {
      const synced = pricingDraftOf(pricing)
      if (previous === null || typeof previous !== 'object') return synced
      const local = pricingDraftOf({ config: previous })
      return Object.assign({}, synced, {
        providerAliases: local.providerAliases,
        mappings: local.mappings,
        overrides: local.overrides,
      })
    }
    function pricingStatusLabel(status, language) {
      const labels = { priced: ['已计价', 'priced'], unpriced: ['未计价', 'unpriced'], ambiguous: ['待确认', 'ambiguous'], unsupported: ['不支持', 'unsupported'] }
      const pair = labels[status] || labels.unpriced
      return language === 'en' ? pair[1] : pair[0]
    }
    function pricingSemanticsLabel(value, language) {
      const labels = {
        fresh: ['Fresh：输入 + 缓存读写', 'Fresh: input + cache read/write'],
        total: ['Total：输入已含缓存', 'Total: input already includes cache'],
        legacy: ['Legacy：输入 + 缓存写', 'Legacy: input + cache write'],
      }
      const pair = labels[value] || labels.fresh
      return language === 'en' ? pair[1] : pair[0]
    }
    function pricingTierBandLabel(tiers, index, language) {
      const rows = Array.isArray(tiers) ? tiers : []
      if (index < 0) return rows.length > 0 ? '≤ ' + fmtCount(rows[0].size, language) : (language === 'en' ? 'All contexts' : '全部上下文')
      const tier = rows[index]
      if (!tier) return ''
      const lower = '> ' + fmtCount(tier.size, language)
      const next = rows[index + 1]
      return next ? lower + (language === 'en' ? ' and ≤ ' : ' 且 ≤ ') + fmtCount(next.size, language) : lower
    }
    function validPricingRateDraft(value) {
      const text = String(value === undefined || value === null ? '' : value).trim().toLowerCase()
      if (text === '' || text.length > 128) return false
      const match = text.match(/^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/)
      if (!match) return false
      const exponent = match[3] ? Number(match[3]) : 0
      if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 24) return false
      let digits = (match[1] || '') + (match[2] || '')
      let scale = (match[2] || '').length - exponent
      digits = digits.replace(/^0+(?=\d)/, '')
      if (scale < 0) {
        digits += '0'.repeat(-scale)
        scale = 0
      }
      if (scale > digits.length) digits = '0'.repeat(scale - digits.length + 1) + digits
      return digits.length <= 40
    }
    function pricingTierDraftValid(tier, previousSize) {
      const size = Number(tier && tier.size)
      if (!tier || tier.type !== 'context' || !Number.isSafeInteger(size) || size <= previousSize || size > 1000000000) return false
      return ['input', 'output', 'cacheRead', 'cacheWrite'].every((key) => validPricingRateDraft(tier[key]))
    }
    function pricingDraftValidationError(draft) {
      const mappings = draft && Array.isArray(draft.mappings) ? draft.mappings : []
      for (const mapping of mappings) {
        if (!mapping || String(mapping.identityKey || mapping.usageIdentityKey || mapping.model || '').trim() === '' || String(mapping.catalogModelId || '').trim() === '') return 'mapping'
        if (!['fresh', 'total', 'legacy'].includes(mapping.inputTokenSemantics || 'fresh') || !validPricingRateDraft(mapping.multiplier === undefined ? '1' : mapping.multiplier)) return 'mapping'
      }
      const overrides = draft && Array.isArray(draft.overrides) ? draft.overrides : []
      for (const entry of overrides) {
        if (!entry || String(entry.modelId || '').trim() === '') return 'override'
        if (!['input', 'output', 'cacheRead', 'cacheWrite'].every((key) => validPricingRateDraft(entry[key]))) return 'override'
        let previousSize = 0
        const tiers = Array.isArray(entry.tiers) ? entry.tiers : []
        if (tiers.length > 32) return 'tier'
        for (const tier of tiers) {
          if (!pricingTierDraftValid(tier, previousSize)) return 'tier'
          previousSize = Number(tier.size)
        }
        if (entry.tiered === true && tiers.length === 0) return 'tier'
      }
      return ''
    }
    function pricingModelKey(value) {
      return String(value || '').trim().toLowerCase().replace(/^.*\//, '').split(':')[0]
    }
    function modelViewKey(value) {
      const text = String(value || '').trim()
      return text.includes(' / ') ? text : pricingModelKey(text)
    }
    function humanDate(date, language) {
      const parts = date.split('-')
      const utc = language === 'en'
      const d = utc ? new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]))) : new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]))
      const monthIndex = utc ? d.getUTCMonth() : d.getMonth()
      const weekIndex = utc ? d.getUTCDay() : d.getDay()
      if (language === 'en') {
        const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][monthIndex]
        const week = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][weekIndex]
        return month + ' ' + Number(parts[2]) + ', ' + parts[0] + ' (' + week + ', UTC)'
      }
      const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][weekIndex]
      return parts[0] + '年' + Number(parts[1]) + '月' + Number(parts[2]) + '日 ' + week
    }
    function monthLabel(year, month, language) {
      if (language === 'en') {
        const label = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][month]
        return month === 0 ? year + ' ' + label : label
      }
      return month === 0 ? year + '年1月' : (month + 1) + '月'
    }
    function levelOf(count) {
      if (count >= 10) return 4
      if (count >= 6) return 3
      if (count >= 3) return 2
      if (count >= 1) return 1
      return 0
    }
    const GH_GREEN = '#2ea043'
    const LEVEL_PCT = [20, 45, 70, 96]
    function cellBg(level) {
      if (level <= 0) return 'var(--dsw-alias-bg-layer-2)'
      return 'color-mix(in srgb, ' + GH_GREEN + ' ' + LEVEL_PCT[level - 1] + '%, var(--dsw-alias-bg-layer-2))'
    }
    function wsColor(i) {
      return 'hsl(' + ((i * 137) % 360) + ', 70%, 55%)'
    }
    function buildCalendarModel(todayKey, utc, language) {
      const parts = String(todayKey || '').split('-').map(Number)
      const today = utc ? new Date(Date.UTC(parts[0], parts[1] - 1, parts[2])) : new Date(parts[0], parts[1] - 1, parts[2])
      const weekday = utc ? today.getUTCDay() : today.getDay()
      const sunday = shiftCalendarDate(today, -weekday, utc)
      const start = shiftCalendarDate(sunday, -52 * 7, utc)
      const cells = []
      for (let index = 0; index < 53 * 7; index += 1) {
        const date = shiftCalendarDate(start, index, utc)
        cells.push({ date: fmtDate(date, utc), month: utc ? date.getUTCMonth() : date.getMonth(), year: utc ? date.getUTCFullYear() : date.getFullYear() })
      }
      const months = []
      for (let week = 0; week < 53; week += 1) {
        const first = cells[week * 7]
        const previous = week > 0 ? cells[(week - 1) * 7] : null
        if (previous === null || first.month !== previous.month) months.push({ left: (week * 100 / 53) + '%', text: monthLabel(first.year, first.month, language) })
      }
      return { cells, months, weekdays: language === 'en' ? ['', 'Mon', '', 'Wed', '', 'Fri', ''] : ['', '周一', '', '周三', '', '周五', ''] }
    }
    function rangeAgg(stats, range, utc, customRange) {
      const empty = { totals: { turns: 0, calls: 0, sessions: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: emptyCostAggregate() }, perWs: [], perModel: [] }
      if (stats === null) return empty
      if (range === 'all') return { totals: stats.totals, perWs: stats.perWorkspace, perModel: stats.perModel || [] }
      const days = utc && Array.isArray(stats.byDayUtc) ? stats.byDayUtc : (Array.isArray(stats.byDay) ? stats.byDay : [])
      let start
      let end = null
      if (range === 'custom') {
        const normalized = normalizeCustomRange(customRange, utc)
        if (normalized === null) return empty
        start = normalized.start
        end = normalized.end
      } else if (range === 'today') {
        start = fmtDate(new Date(), utc)
      } else if (range === '30d') {
        start = fmtDate(shiftCalendarDate(new Date(), -29, utc), utc)
      } else {
        start = fmtDate(shiftCalendarDate(new Date(), -89, utc), utc)
      }
      const t = { turns: 0, calls: 0, sessions: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: emptyCostAggregate() }
      const per = new Map()
      const models = new Map()
      const sessionsInRange = new Set()
      for (const day of days) {
        if (day.date < start || (end !== null && day.date > end)) continue
        const daySessionIds = Array.isArray(day.sessionIds) ? day.sessionIds : []
        for (const sid of daySessionIds) sessionsInRange.add(sid)
        t.turns += day.turns
        t.input += day.tokens.input
        t.output += day.tokens.output
        t.cacheRead += day.tokens.cacheRead
        t.cacheWrite += day.tokens.cacheWrite
        t.reasoning += day.tokens.reasoning
        addCostAggregate(t.cost, day.cost)
        for (const w of day.byWorkspace) {
          let p = per.get(w.workspaceId)
          if (p === undefined) { p = { workspaceId: w.workspaceId, turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: emptyCostAggregate() }; per.set(w.workspaceId, p) }
          p.input += w.input
          p.output += w.output
          p.cacheRead += w.cacheRead
          p.cacheWrite += w.cacheWrite
          p.reasoning += w.reasoning
          addCostAggregate(p.cost, w.cost)
        }
        for (const w of day.perWorkspace) {
          let p = per.get(w.workspaceId)
          if (p === undefined) { p = { workspaceId: w.workspaceId, turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: emptyCostAggregate() }; per.set(w.workspaceId, p) }
          p.turns += w.turns
        }
        for (const m of (day.byModel || [])) {
          const key = m.identityKey || m.model
          let p = models.get(key)
          if (p === undefined) { p = { ...m, calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: emptyCostAggregate() }; models.set(key, p) }
          p.calls += m.calls; p.input += m.input; p.output += m.output; p.cacheRead += m.cacheRead; p.cacheWrite += m.cacheWrite; p.reasoning += m.reasoning
          t.calls += Number.isFinite(m.calls) ? m.calls : 0
          addCostAggregate(p.cost, m.cost)
        }
      }
      t.sessions = sessionsInRange.size
      return { totals: t, perWs: Array.from(per.values()), perModel: Array.from(models.values()) }
    }
    function resolveRangeBounds(stats, range, utc, customRange) {
      const days = utc && Array.isArray(stats && stats.byDayUtc) ? stats.byDayUtc : (Array.isArray(stats && stats.byDay) ? stats.byDay : [])
      const latest = fmtDate(new Date(), utc)
      if (range === 'custom') {
        const normalized = normalizeCustomRange(customRange, utc)
        return normalized === null ? null : { start: normalized.start, end: normalized.end }
      }
      if (range === 'today') return { start: latest, end: latest }
      if (range === '30d') return { start: fmtDate(shiftCalendarDate(new Date(), -29, utc), utc), end: latest }
      if (range === '90d') return { start: fmtDate(shiftCalendarDate(new Date(), -89, utc), utc), end: latest }
      const bounds = availableDateBounds(days, latest)
      return { start: bounds.min, end: bounds.max }
    }
    function makeUsageScope(stats, range, utc, customRange, workspaceId, provider, modelKey) {
      const bounds = resolveRangeBounds(stats, range, utc, customRange)
      if (bounds === null) return null
      return { start: bounds.start, end: bounds.end, utc: utc === true, workspaceId: workspaceId || null, provider: provider || null, modelKey: modelKey || null }
    }
    function usageScopeKey(scope) {
      return scope === null ? '' : JSON.stringify({ start: scope.start, end: scope.end, utc: scope.utc === true, workspaceId: scope.workspaceId || null, provider: scope.provider || null, modelKey: scope.modelKey || null })
    }
    function rowTokens(row) {
      const tokens = row && row.tokens && typeof row.tokens === 'object' ? row.tokens : row || {}
      return { input: Number.isFinite(tokens.input) ? tokens.input : 0, output: Number.isFinite(tokens.output) ? tokens.output : 0, cacheRead: Number.isFinite(tokens.cacheRead) ? tokens.cacheRead : 0, cacheWrite: Number.isFinite(tokens.cacheWrite) ? tokens.cacheWrite : 0, reasoning: Number.isFinite(tokens.reasoning) ? tokens.reasoning : 0 }
    }
    function buildTrendRows(rows, bounds, utc) {
      if (bounds === null || typeof bounds !== 'object') return []
      const source = new Map((Array.isArray(rows) ? rows : []).filter((row) => row && typeof row.date === 'string').map((row) => [row.date, row]))
      const startParts = bounds.start.split('-').map(Number)
      const endParts = bounds.end.split('-').map(Number)
      const cursor = utc ? new Date(Date.UTC(startParts[0], startParts[1] - 1, startParts[2])) : new Date(startParts[0], startParts[1] - 1, startParts[2])
      const end = utc ? new Date(Date.UTC(endParts[0], endParts[1] - 1, endParts[2])) : new Date(endParts[0], endParts[1] - 1, endParts[2])
      const result = []
      while (cursor.getTime() <= end.getTime()) {
        const date = fmtDate(cursor, utc)
        const row = source.get(date)
        const tokens = rowTokens(row)
        result.push({ date, turns: row && Number.isFinite(row.turns) ? row.turns : 0, calls: row && Number.isFinite(row.calls) ? row.calls : 0, sessions: row && Number.isFinite(row.sessions) ? row.sessions : 0, tokens, cost: costAggregate(row), total: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite + tokens.reasoning })
        if (utc) cursor.setUTCDate(cursor.getUTCDate() + 1)
        else cursor.setDate(cursor.getDate() + 1)
      }
      return result
    }
    function buildTrendHourlyRows(rows, utc) {
      const result = []
      for (const row of (Array.isArray(rows) ? rows : [])) {
        if (row === null || typeof row !== 'object') continue
        const time = Number.isFinite(row.time) ? row.time : (typeof row.date === 'string' ? Date.parse(row.date) : NaN)
        if (!Number.isFinite(time)) continue
        const tokens = rowTokens(row)
        result.push({ date: fmtDate(new Date(time), utc), time, turns: Number.isFinite(row.turns) ? row.turns : 0, calls: Number.isFinite(row.calls) ? row.calls : 0, sessions: Number.isFinite(row.sessions) ? row.sessions : 0, tokens, cost: costAggregate(row), total: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite + tokens.reasoning })
      }
      return result.sort((a, b) => a.time - b.time)
    }
    function trendHourLabel(time, language, detailed) {
      const options = detailed
        ? { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }
        : { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }
      if (language === 'en') options.timeZone = 'UTC'
      return new Date(time).toLocaleString(language === 'en' ? 'en-US' : 'zh-CN', options)
    }
    function trendRowLabel(row, language, detailed) {
      if (row && Number.isFinite(row.time)) return trendHourLabel(row.time, language, detailed)
      if (!row || typeof row.date !== 'string') return ''
      return detailed ? humanDate(row.date, language) : row.date.slice(5)
    }
    function trendRowKey(row, index) {
      return row && Number.isFinite(row.time) ? String(row.time) : (row && typeof row.date === 'string' ? row.date : String(index))
    }
    function trendRowDate(row) {
      return row && typeof row.date === 'string' ? row.date : ''
    }
    function buildTrendGeometry(rows, visible, width = 900, height = 250) {
      const keys = Array.isArray(visible) && visible.length > 0 ? visible : ['total']
      const padding = { left: 46, right: 14, top: 14, bottom: 30 }
      const innerWidth = Math.max(1, width - padding.left - padding.right)
      const innerHeight = Math.max(1, height - padding.top - padding.bottom)
      const values = (Array.isArray(rows) ? rows : []).flatMap((row) => keys.map((key) => key === 'total' ? row.total : row.tokens[key] || 0))
      const max = Math.max(1, ...values)
      const points = {}
      for (const key of keys) points[key] = (Array.isArray(rows) ? rows : []).map((row, index) => ({ x: padding.left + (rows.length > 1 ? index * innerWidth / (rows.length - 1) : innerWidth / 2), y: padding.top + innerHeight - ((key === 'total' ? row.total : row.tokens[key] || 0) / max) * innerHeight, value: key === 'total' ? row.total : row.tokens[key] || 0 }))
      return { width, height, padding, max, points }
    }
    function modelParts(row, unknownProvider, unknownModel) {
      const structuredModel = typeof row.actualModel === 'string' && row.actualModel !== '' ? row.actualModel : (typeof row.requestedModel === 'string' && row.requestedModel !== '' ? row.requestedModel : '')
      const displayModel = typeof row.model === 'string' && row.model !== '' ? row.model : unknownModel
      const separator = displayModel.indexOf(' / ')
      const rowProvider = typeof row.provider === 'string' && row.provider !== '' ? row.provider : ''
      const provider = rowProvider || (separator > 0 ? displayModel.slice(0, separator) : unknownProvider)
      const providerPrefix = provider !== unknownProvider ? provider + ' / ' : ''
      const fallbackModel = structuredModel !== '' ? displayModel : providerPrefix !== '' && displayModel.startsWith(providerPrefix) ? displayModel.slice(providerPrefix.length) : separator > 0 ? displayModel.slice(separator + 3) : displayModel
      const model = modelViewKey(structuredModel || fallbackModel) || unknownModel
      return { provider, model }
    }
    function modelOptionLabel(row, unknownProvider, unknownModel) {
      const parts = modelParts(row, unknownProvider, unknownModel)
      const base = parts.provider + ' / ' + parts.model
      return row && row.requestedModel && row.actualModel && row.requestedModel !== row.actualModel ? base + ' ← ' + row.requestedModel : base
    }
    function aggregateModelRows(rows, view, unknownProvider, unknownModel) {
      if (view === 'route') return rows.slice()
      const grouped = new Map()
      const members = new Map()
      for (const row of rows) {
        const parts = modelParts(row, unknownProvider, unknownModel)
        const key = view === 'model' ? parts.model : parts.provider
        let item = grouped.get(key)
        if (item === undefined) { item = { model: key, provider: view === 'provider' ? key : parts.provider, calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: emptyCostAggregate() }; grouped.set(key, item); members.set(key, []) }
        members.get(key).push(row)
        item.calls += row.calls; item.input += row.input; item.output += row.output; item.cacheRead += row.cacheRead; item.cacheWrite += row.cacheWrite; item.reasoning += row.reasoning
        addCostAggregate(item.cost, row.cost)
      }
      // Provider aggregates are attributed by the provider name alone, so a
      // reseller or gateway (which serves many vendors) never inherits a model
      // brand. Model aggregates only carry a brand when every member maps to
      // the same one; mixed attribution keeps the neutral fallback.
      for (const [key, item] of grouped) {
        const icon = view === 'provider' ? iconForProvider(key) : resolveAggregateModelIcon(members.get(key))
        item.iconKey = icon === null ? null : icon.key
      }
      return Array.from(grouped.values())
    }
    function streaks(dayMap, utc) {
      const today = new Date()
      let streak = 0
      for (let i = 0; i < 371; i++) {
        const d = shiftCalendarDate(today, -i, utc)
        const day = dayMap.get(fmtDate(d, utc))
        const active = day !== undefined && day.turns > 0
        if (active) streak += 1
        else if (i > 0) break
      }
      let best = 0
      let run = 0
      for (let i = 0; i < 371; i++) {
        const d = shiftCalendarDate(today, -i, utc)
        const day = dayMap.get(fmtDate(d, utc))
        if (day !== undefined && day.turns > 0) {
          run += 1
          if (run > best) best = run
        } else {
          run = 0
        }
      }
      return { streak, best }
    }
    // 数字滚动动画：首次从 0 滚动到目标值，之后直接同步目标值
    function useCountUp(target, timer) {
      const [state, setState] = React.useState({ value: 0, done: false })
      React.useEffect(() => {
        if (typeof target !== 'number' || !Number.isFinite(target) || target <= 0) {
          setState({ value: 0, done: false })
          return undefined
        }
        if (state.done) {
          setState({ value: target, done: true })
          return undefined
        }
        const start = Date.now()
        const duration = 700
        const stop = timer.interval(() => {
          const t = Math.min(1, (Date.now() - start) / duration)
          const eased = 1 - Math.pow(1 - t, 3)
          if (t >= 1) {
            stop()
            setState({ value: target, done: true })
          } else {
            setState({ value: Math.round(target * eased), done: false })
          }
        }, 32)
        return stop
      }, [target])
      return state.value
    }

    function smoothTrendPath(points) {
      if (!Array.isArray(points) || points.length === 0) return ''
      if (points.length === 1) return 'M' + points[0].x.toFixed(2) + ' ' + points[0].y.toFixed(2)
      const slopes = []
      for (let i = 0; i < points.length - 1; i += 1) {
        const dx = points[i + 1].x - points[i].x
        slopes.push(dx === 0 ? 0 : (points[i + 1].y - points[i].y) / dx)
      }
      const tangents = new Array(points.length).fill(0)
      tangents[0] = slopes[0]
      tangents[points.length - 1] = slopes[slopes.length - 1]
      for (let i = 1; i < points.length - 1; i += 1) {
        const before = slopes[i - 1]
        const after = slopes[i]
        tangents[i] = before * after <= 0 ? 0 : (before + after) / 2
      }
      // Fritsch-Carlson limiting keeps the smooth curve monotone between points.
      for (let i = 0; i < slopes.length; i += 1) {
        if (slopes[i] === 0) { tangents[i] = 0; tangents[i + 1] = 0; continue }
        const a = tangents[i] / slopes[i]
        const b = tangents[i + 1] / slopes[i]
        const magnitude = a * a + b * b
        if (magnitude > 9) {
          const scale = 3 / Math.sqrt(magnitude)
          tangents[i] = scale * a * slopes[i]
          tangents[i + 1] = scale * b * slopes[i]
        }
      }
      let path = 'M' + points[0].x.toFixed(2) + ' ' + points[0].y.toFixed(2)
      for (let i = 0; i < points.length - 1; i += 1) {
        const dx = points[i + 1].x - points[i].x
        const c1x = points[i].x + dx / 3
        const c1y = points[i].y + tangents[i] * dx / 3
        const c2x = points[i + 1].x - dx / 3
        const c2y = points[i + 1].y - tangents[i + 1] * dx / 3
        path += ' C' + c1x.toFixed(2) + ' ' + c1y.toFixed(2) + ' ' + c2x.toFixed(2) + ' ' + c2y.toFixed(2) + ' ' + points[i + 1].x.toFixed(2) + ' ' + points[i + 1].y.toFixed(2)
      }
      return path
    }
    function trendPathLength(points) {
      if (!Array.isArray(points) || points.length < 2) return 1
      let length = 0
      for (let i = 1; i < points.length; i += 1) {
        const dx = points[i].x - points[i - 1].x
        const dy = points[i].y - points[i - 1].y
        length += Math.sqrt(dx * dx + dy * dy)
      }
      return Math.max(1, Math.ceil(length * 1.35 + 2))
    }
    const DONUT_COLORS = ['#0a84ff', '#30d158', '#bf5af2', '#ff9f0a', '#ff375f', '#64d2ff']
    const TREND_COLORS = { total: '#f4c542', input: '#5aa9ff', cacheRead: '#44d483', cacheWrite: '#d98bff', output: '#ff8c66', reasoning: '#aab4c4' }
    const TREND_GRADIENT_OPACITY = { total: .20, input: .16, cacheRead: .18, cacheWrite: .14, output: .16, reasoning: .10 }
    function tokenMagnitude(value, language) {
      const magnitude = chineseMagnitude(value, language)
      return magnitude !== '' ? magnitude : fmtCompact(value)
    }
    function tokenDisplay(value, language) {
      return tokenMagnitude(value, language) + (language === 'en' ? ' tokens' : ' Token')
    }
    function buildDonutSegments(items, otherLabel, limit = 5) {
      const topLimit = Math.max(1, Number.isInteger(limit) ? limit : 5)
      const normalized = (Array.isArray(items) ? items : []).map((item, index) => ({
        label: item && item.label !== undefined ? String(item.label) : '',
        value: Number(item && item.value),
        color: item && typeof item.color === 'string' && item.color !== '' ? item.color : DONUT_COLORS[index % DONUT_COLORS.length],
        // The caller resolves the brand (undefined = no icon for this series).
        iconKey: item && item.iconKey !== undefined ? item.iconKey : undefined,
        cost: costAggregate(item),
      })).filter((item) => item.label !== '' && Number.isFinite(item.value) && item.value > 0).sort((a, b) => b.value - a.value)
      const total = normalized.reduce((sum, item) => sum + item.value, 0)
      if (total <= 0) return { total: 0, segments: [] }
      const segments = normalized.slice(0, topLimit)
      const remainderItems = normalized.slice(topLimit)
      const remainder = remainderItems.reduce((sum, item) => sum + item.value, 0)
      if (remainder > 0) {
        const remainderCost = emptyCostAggregate()
        for (const item of remainderItems) addCostAggregate(remainderCost, item.cost)
        segments.push({ label: otherLabel + ' (' + (normalized.length - topLimit) + ')', value: remainder, color: '#b8c2cf', iconKey: null, cost: remainderCost, other: true })
      }
      let angle = -Math.PI / 2
      return {
        total,
        segments: segments.map((item, index) => {
          const sweep = item.value / total * Math.PI * 2
          const gap = segments.length > 1 ? Math.min(.018, sweep / 3) : 0
          const startAngle = angle + gap
          const endAngle = angle + sweep - gap
          angle += sweep
          return { ...item, index, percentage: item.value / total * 100, startAngle: endAngle <= startAngle ? angle - sweep : startAngle, endAngle: endAngle <= startAngle ? angle : endAngle }
        }),
      }
    }
    function donutArcPath(cx, cy, outerRadius, innerRadius, startAngle, endAngle) {
      const sweep = Math.max(0, endAngle - startAngle)
      const point = (radius, angle) => ({ x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) })
      const outerStart = point(outerRadius, startAngle)
      const innerStart = point(innerRadius, startAngle)
      if (sweep >= Math.PI * 2 - .0001) {
        const outerMid = point(outerRadius, startAngle + Math.PI)
        const innerMid = point(innerRadius, startAngle + Math.PI)
        return 'M' + outerStart.x.toFixed(2) + ' ' + outerStart.y.toFixed(2) + ' A' + outerRadius + ' ' + outerRadius + ' 0 1 1 ' + outerMid.x.toFixed(2) + ' ' + outerMid.y.toFixed(2) + ' A' + outerRadius + ' ' + outerRadius + ' 0 1 1 ' + outerStart.x.toFixed(2) + ' ' + outerStart.y.toFixed(2) + ' L' + innerStart.x.toFixed(2) + ' ' + innerStart.y.toFixed(2) + ' A' + innerRadius + ' ' + innerRadius + ' 0 1 0 ' + innerMid.x.toFixed(2) + ' ' + innerMid.y.toFixed(2) + ' A' + innerRadius + ' ' + innerRadius + ' 0 1 0 ' + innerStart.x.toFixed(2) + ' ' + innerStart.y.toFixed(2) + ' Z'
      }
      const outerEnd = point(outerRadius, endAngle)
      const innerEnd = point(innerRadius, endAngle)
      const largeArc = sweep > Math.PI ? 1 : 0
      return 'M' + outerStart.x.toFixed(2) + ' ' + outerStart.y.toFixed(2) + ' A' + outerRadius + ' ' + outerRadius + ' 0 ' + largeArc + ' 1 ' + outerEnd.x.toFixed(2) + ' ' + outerEnd.y.toFixed(2) + ' L' + innerEnd.x.toFixed(2) + ' ' + innerEnd.y.toFixed(2) + ' A' + innerRadius + ' ' + innerRadius + ' 0 ' + largeArc + ' 0 ' + innerStart.x.toFixed(2) + ' ' + innerStart.y.toFixed(2) + ' Z'
    }
    function donutArcLinePath(cx, cy, radius, startAngle, endAngle) {
      const sweep = Math.max(0, endAngle - startAngle)
      const point = (angle) => ({ x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) })
      const start = point(startAngle)
      if (sweep >= Math.PI * 2 - .0001) {
        const mid = point(startAngle + Math.PI)
        return 'M' + start.x.toFixed(2) + ' ' + start.y.toFixed(2) + ' A' + radius + ' ' + radius + ' 0 1 1 ' + mid.x.toFixed(2) + ' ' + mid.y.toFixed(2) + ' A' + radius + ' ' + radius + ' 0 1 1 ' + start.x.toFixed(2) + ' ' + start.y.toFixed(2)
      }
      const end = point(endAngle)
      return 'M' + start.x.toFixed(2) + ' ' + start.y.toFixed(2) + ' A' + radius + ' ' + radius + ' 0 ' + (sweep > Math.PI ? 1 : 0) + ' 1 ' + end.x.toFixed(2) + ' ' + end.y.toFixed(2)
    }
    function UsageDonutChart(props) {
      const language = props.language === 'en' ? 'en' : 'zh'
      const tr = (zh, en) => language === 'en' ? en : zh
      const [activeIndex, setActiveIndex] = React.useState(null)
      const tooltipRef = React.useRef(null)
      const pointerRef = React.useRef(null)
      const frameRef = React.useRef(null)
      const fallbackRef = React.useRef(null)
      const data = React.useMemo(() => buildDonutSegments(props.items, tr('其他', 'Other')), [props.items, language])
      const activeSegment = activeIndex === null ? null : (data.segments[activeIndex] || null)
      const cx = 130
      const cy = 130
      const outerRadius = 94
      const innerRadius = 61
      const percentText = (value) => (value >= 10 ? Math.round(value) : Math.round(value * 10) / 10) + '%'
      const flushPointer = React.useCallback(() => {
        frameRef.current = null
        if (fallbackRef.current !== null) { window.clearTimeout(fallbackRef.current); fallbackRef.current = null }
        const tooltip = tooltipRef.current
        const pointer = pointerRef.current
        if (tooltip === null || pointer === null) return
        if (pointer.fixed) {
          tooltip.style.left = pointer.left + 'px'
          tooltip.style.top = pointer.top + 'px'
        } else {
          const box = pointer.visual?.getBoundingClientRect()
          if (!box) return
          const tooltipWidth = 198
          const tooltipHeight = 82
          tooltip.style.left = Math.max(8, Math.min(Math.max(8, box.width - tooltipWidth), pointer.x - box.left + 14)) + 'px'
          tooltip.style.top = Math.max(8, Math.min(Math.max(8, box.height - tooltipHeight), pointer.y - box.top + 14)) + 'px'
        }
        tooltip.style.visibility = 'visible'
      }, [])
      const schedulePointer = React.useCallback((pointer) => {
        pointerRef.current = pointer
        if (frameRef.current !== null) return
        frameRef.current = window.requestAnimationFrame(flushPointer)
        fallbackRef.current = window.setTimeout(() => {
          if (frameRef.current === null) return
          window.cancelAnimationFrame(frameRef.current)
          flushPointer()
        }, 80)
      }, [flushPointer])
      const updatePointer = React.useCallback((event) => {
        schedulePointer({ x: event.clientX, y: event.clientY, visual: event.currentTarget.ownerSVGElement?.parentElement })
      }, [schedulePointer])
      const clearPointer = React.useCallback(() => { setActiveIndex(null); pointerRef.current = null }, [])
      React.useEffect(() => () => {
        if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current)
        if (fallbackRef.current !== null) window.clearTimeout(fallbackRef.current)
      }, [])
      React.useEffect(() => {
        if (activeIndex === null || pointerRef.current === null || frameRef.current !== null) return
        frameRef.current = window.requestAnimationFrame(flushPointer)
      }, [activeIndex, flushPointer])
      if (data.total <= 0) return null
      return React.createElement('div', { className: 'uh-donut-chart', 'aria-label': props.title },
        React.createElement('div', { className: 'uh-donut-title' }, React.createElement(LineIcon, { name: props.icon || 'chart', size: 16 }), props.title),
        React.createElement('div', { className: 'uh-donut-layout' },
          React.createElement('div', { className: 'uh-donut-visual' },
            React.createElement('svg', { className: 'uh-donut-svg', viewBox: '0 0 260 260', role: 'img', 'aria-label': props.title + ' ' + tokenDisplay(data.total, language) },
              React.createElement('circle', { cx, cy, r: (outerRadius + innerRadius) / 2, className: 'uh-donut-track', fill: 'none', stroke: 'var(--dsw-alias-bg-layer-2)', strokeWidth: outerRadius - innerRadius }),
              data.segments.map((segment) => React.createElement('path', { key: 'donut-' + segment.index, d: donutArcLinePath(cx, cy, (outerRadius + innerRadius) / 2, segment.startAngle, segment.endAngle), className: 'uh-donut-segment' + (activeIndex === segment.index ? ' uh-active' : ''), fill: 'none', stroke: segment.color, strokeWidth: outerRadius - innerRadius, strokeLinecap: 'butt', strokeLinejoin: 'round', pathLength: 1, style: { animationDelay: (segment.index * 90) + 'ms' }, tabIndex: 0, 'aria-label': segment.label + ' ' + tokenDisplay(segment.value, language) + ' ' + percentText(segment.percentage) + ' ' + costDisplay(segment.cost, language), onMouseEnter: (event) => { setActiveIndex(segment.index); updatePointer(event) }, onMouseMove: updatePointer, onMouseLeave: clearPointer, onFocus: () => { setActiveIndex(segment.index); schedulePointer({ fixed: true, left: 12, top: 12 }) }, onBlur: clearPointer })),
            ),
            activeSegment ? React.createElement('div', { ref: tooltipRef, className: 'uh-donut-tooltip', style: { visibility: 'hidden' } },
              React.createElement('span', { className: 'uh-donut-dot', style: { background: activeSegment.color } }),
              activeSegment.iconKey === undefined || activeSegment.iconKey === null ? null : React.createElement(MemoModelIcon, { iconKey: activeSegment.iconKey, size: 15 }),
              React.createElement('div', {},
                React.createElement('strong', {}, activeSegment.label),
                React.createElement('span', {}, tokenDisplay(activeSegment.value, language) + ' · ' + percentText(activeSegment.percentage)),
                React.createElement('span', { className: 'uh-donut-tooltip-cost' }, costDisplay(activeSegment.cost, language)),
              ),
            ) : null,
            React.createElement('div', { className: 'uh-donut-center' },
              React.createElement('strong', {}, tokenMagnitude(data.total, language)),
              React.createElement('span', {}, language === 'en' ? 'tokens' : 'Token'),
            ),
          ),
          React.createElement('div', { className: 'uh-donut-legend', role: 'list' },
            data.segments.map((segment) => React.createElement('div', { key: 'legend-' + segment.index, className: 'uh-donut-legend-row', role: 'listitem' },
              // The colour dot and the brand icon share one grid cell so the
              // legend keeps its four-column layout (label / metrics / percent).
              React.createElement('span', { className: 'uh-donut-legend-mark' },
                React.createElement('span', { className: 'uh-donut-dot', style: { background: segment.color } }),
                segment.iconKey === undefined || segment.iconKey === null ? null : React.createElement(MemoModelIcon, { iconKey: segment.iconKey, size: 16, showTitle: true }),
              ),
              React.createElement('div', { className: 'uh-donut-legend-copy' },
                React.createElement('strong', { title: segment.label }, segment.label),
              ),
              React.createElement('div', { className: 'uh-donut-legend-metrics' },
                React.createElement('span', {}, tokenDisplay(segment.value, language)),
                React.createElement('span', { className: 'uh-donut-cost' }, costDisplay(segment.cost, language)),
              ),
              React.createElement('strong', { className: 'uh-donut-percent' }, percentText(segment.percentage)),
            )),
          ),
        ),
      )
    }
    const MemoUsageDonutChart = React.memo(UsageDonutChart)

    function trendSeriesLabel(key, language) {
      const labels = {
        total: language === 'en' ? 'Total' : '总处理',
        input: language === 'en' ? 'Input' : '输入',
        cacheRead: language === 'en' ? 'Cache hits' : '缓存命中',
        cacheWrite: language === 'en' ? 'Cache writes' : '缓存写入',
        output: language === 'en' ? 'Output' : '输出',
        reasoning: language === 'en' ? 'Reasoning' : '推理',
      }
      return labels[key] || key
    }
    function trendSeriesValue(row, key) {
      return key === 'total' ? row.total : (row.tokens && Number.isFinite(row.tokens[key]) ? row.tokens[key] : 0)
    }
    function UsageTrendChart(props) {
      const language = props.language === 'en' ? 'en' : 'zh'
      const tr = (zh, en) => language === 'en' ? en : zh
      const rows = Array.isArray(props.rows) ? props.rows : []
      const visible = Array.isArray(props.visible) && props.visible.length > 0 ? props.visible : ['total']
      const [hoverIndex, setHoverIndex] = React.useState(null)
      const [tooltipIndex, setTooltipIndex] = React.useState(null)
      const width = 900
      const height = 280
      const geometry = React.useMemo(() => buildTrendGeometry(rows, visible, width, height), [rows, visible])
      const colors = TREND_COLORS
      const gradientOpacity = TREND_GRADIENT_OPACITY
      const bottomY = height - geometry.padding.bottom
      const seriesPaths = React.useMemo(() => {
        const result = {}
        for (const key of visible) {
          const points = geometry.points[key] || []
          const line = smoothTrendPath(points)
          result[key] = { line, area: points.length === 0 ? '' : line + ' L' + points[points.length - 1].x.toFixed(2) + ' ' + bottomY + ' L' + points[0].x.toFixed(2) + ' ' + bottomY + ' Z', length: trendPathLength(points) }
        }
        return result
      }, [geometry, visible, bottomY])
      const tickIndexes = React.useMemo(() => rows.length <= 1 ? [0] : Array.from(new Set([0, Math.floor((rows.length - 1) / 4), Math.floor((rows.length - 1) / 2), Math.floor((rows.length - 1) * 3 / 4), rows.length - 1])), [rows])
      const chartReady = !props.loading && !props.error && rows.length > 0
      const hourly = rows.length > 0 && Number.isFinite(rows[0].time)
      const chartAriaLabel = hourly ? tr('每小时 Token 使用趋势，选择小时查看当天请求日志', 'Hourly Token usage trend; select an hour to view request logs') : tr('每日 Token 使用趋势，选择日期查看请求日志', 'Daily Token usage trend; select a date to view request logs')
      const hovered = hoverIndex === null ? null : (rows[hoverIndex] || null)
      const hoverPoint = hoverIndex === null ? null : ((geometry.points[visible[0]] || [])[hoverIndex] || null)
      const tooltipRow = tooltipIndex === null ? null : (rows[tooltipIndex] || null)
      const tooltipPoint = tooltipIndex === null ? null : ((geometry.points[visible[0]] || [])[tooltipIndex] || null)
      const tooltipVisible = hoverIndex !== null && tooltipRow !== null && tooltipPoint !== null
      const tooltipSide = tooltipPoint !== null && tooltipPoint.x > width * .68 ? ' uh-left' : ' uh-right'
      const tooltipStyle = tooltipPoint === null ? undefined : { left: (tooltipPoint.x / width * 100).toFixed(2) + '%', top: Math.max(23, Math.min(77, tooltipPoint.y / height * 100)).toFixed(2) + '%' }
      const activateHover = (index) => { setHoverIndex(index); setTooltipIndex(index) }
      const toggle = (key) => {
        if (typeof props.onToggle === 'function') props.onToggle(key)
      }
      const chartBody = props.loading
        ? React.createElement('div', { className: 'uh-trend-stage uh-trend-loading', role: 'status', 'aria-label': tr('正在加载趋势', 'Loading trend') }, React.createElement('span', { className: 'uh-trend-spinner', 'aria-hidden': true }))
        : props.error
          ? React.createElement('div', { className: 'uh-trend-stage uh-trend-message', role: 'alert' }, props.error)
          : rows.length === 0
            ? React.createElement('div', { className: 'uh-trend-stage uh-trend-message' }, tr('该范围内暂无趋势数据', 'No trend data in this range'))
            : React.createElement('div', { className: 'uh-trend-chart-wrap' },
              React.createElement('svg', { className: 'uh-trend-svg', viewBox: '0 0 ' + width + ' ' + height, role: 'group', 'aria-label': chartAriaLabel },
                [0, 0.5, 1].map((ratio) => React.createElement(React.Fragment, { key: ratio },
                  React.createElement('line', { x1: geometry.padding.left, x2: width - geometry.padding.right, y1: geometry.padding.top + (height - geometry.padding.top - geometry.padding.bottom) * ratio, y2: geometry.padding.top + (height - geometry.padding.top - geometry.padding.bottom) * ratio, className: 'uh-trend-grid' }),
                  React.createElement('text', { x: geometry.padding.left - 7, y: geometry.padding.top + (height - geometry.padding.top - geometry.padding.bottom) * ratio + 4, className: 'uh-trend-axis-label', textAnchor: 'end' }, fmtCompact(Math.round(geometry.max * (1 - ratio)))),
                )),
                React.createElement('defs', {},
                  visible.map((key) => React.createElement('linearGradient', { key: key, id: 'uh-trend-gradient-' + key, x1: '0', y1: '0', x2: '0', y2: '1' },
                    React.createElement('stop', { offset: '4%', stopColor: colors[key] || '#9aa4b2', stopOpacity: gradientOpacity[key] || .12 }),
                    React.createElement('stop', { offset: '96%', stopColor: colors[key] || '#9aa4b2', stopOpacity: 0 }),
                  )),
                ),
                visible.map((key, seriesIndex) => {
                  const areaPath = seriesPaths[key] ? seriesPaths[key].area : ''
                  return areaPath === '' ? null : React.createElement('path', { key: 'area-' + key, d: areaPath, className: 'uh-trend-area', 'data-series': key, fill: 'url(#uh-trend-gradient-' + key + ')', style: { animationDelay: (80 + seriesIndex * 80) + 'ms' } })
                }),
                visible.map((key) => React.createElement('path', { key: 'line-base-' + key, d: seriesPaths[key] ? seriesPaths[key].line : '', className: 'uh-trend-line', 'data-series': key, stroke: colors[key] || '#9aa4b2' })),
                visible.map((key, seriesIndex) => {
                  const points = geometry.points[key] || []
                  const drawLength = seriesPaths[key] ? seriesPaths[key].length : 0
                  return React.createElement('path', { key: 'line-draw-' + key, d: seriesPaths[key] ? seriesPaths[key].line : '', className: 'uh-trend-line-draw', 'data-series': key, stroke: colors[key] || '#9aa4b2', style: { '--uh-draw-length': drawLength + 'px', animationDelay: (seriesIndex * 90) + 'ms' } })
                }),
                visible.map((key) => {
                  const points = geometry.points[key] || []
                  if (points.length !== 1) return null
                  const point = points[0]
                  return React.createElement('circle', { key: 'single-point-' + key, cx: point.x, cy: point.y, r: 4, className: 'uh-trend-point', fill: colors[key] || '#9aa4b2' })
                }),
                hoverIndex !== null && hoverPoint ? React.createElement(React.Fragment, { key: 'hover-' + hoverIndex },
                  React.createElement('line', { x1: hoverPoint.x, x2: hoverPoint.x, y1: geometry.padding.top, y2: bottomY, className: 'uh-trend-cursor' }),
                  visible.map((key) => { const point = (geometry.points[key] || [])[hoverIndex]; return point ? React.createElement('circle', { key: key, cx: point.x, cy: point.y, r: 4, className: 'uh-trend-point', fill: colors[key] || '#9aa4b2' }) : null }),
                ) : null,
                rows.map((row, index) => {
                  const point = (geometry.points[visible[0]] || [])[index]
                  if (!point) return null
                  const next = (geometry.points[visible[0]] || [])[index + 1]
                  const cellWidth = next ? Math.max(8, next.x - point.x) : (index > 0 ? Math.max(8, point.x - (geometry.points[visible[0]] || [])[index - 1].x) : 24)
                  return React.createElement('rect', { key: trendRowKey(row, index), x: Math.max(geometry.padding.left, point.x - cellWidth / 2), y: geometry.padding.top, width: cellWidth, height: height - geometry.padding.top - geometry.padding.bottom, className: 'uh-trend-hit', tabIndex: 0, role: 'button', 'aria-label': trendRowLabel(row, language, true) + ' ' + trendSeriesLabel('total', language) + ' ' + fmtCompact(row.total), onMouseEnter: () => activateHover(index), onMouseLeave: () => setHoverIndex(null), onFocus: () => activateHover(index), onBlur: () => setHoverIndex(null), onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); if (typeof props.onPointClick === 'function') props.onPointClick(trendRowDate(row)) } }, onClick: () => { if (typeof props.onPointClick === 'function') props.onPointClick(trendRowDate(row)) } })
                }),
                tickIndexes.map((index) => {
                  const point = (geometry.points[visible[0]] || [])[index]
                  const row = rows[index]
                  return point && row ? React.createElement('text', { key: trendRowKey(row, index), x: point.x, y: height - 8, className: 'uh-trend-axis-label', textAnchor: index === 0 ? 'start' : index === rows.length - 1 ? 'end' : 'middle' }, trendRowLabel(row, language, false)) : null
                }),
              ),
              tooltipRow && tooltipPoint ? React.createElement('div', { className: 'uh-trend-tooltip' + tooltipSide + (tooltipVisible ? ' uh-visible' : ''), style: tooltipStyle, 'aria-hidden': !tooltipVisible },
                React.createElement('strong', { className: 'uh-trend-tooltip-title' }, trendRowLabel(tooltipRow, language, true)),
                visible.map((key) => React.createElement('div', { key, className: 'uh-trend-tooltip-row', style: { color: colors[key] || '#9aa4b2' } },
                  React.createElement('span', { className: 'uh-trend-dot', style: { background: colors[key] || '#9aa4b2' } }),
                  React.createElement('span', { className: 'uh-trend-tooltip-label' }, trendSeriesLabel(key, language)),
                  React.createElement('strong', { className: 'uh-trend-tooltip-value' }, fmtCompact(trendSeriesValue(tooltipRow, key))),
                )),
              ) : null,
            )
      return React.createElement('div', { className: 'uh-panel uh-trend-panel' },
        React.createElement('div', { className: 'uh-trend-head' },
          React.createElement('div', {}, React.createElement('h3', { className: 'uh-tbl-title uh-title-with-icon' }, React.createElement(LineIcon, { name: 'chart', size: 16 }), tr('Token 使用趋势', 'Token Usage Trend')), React.createElement('div', { className: 'uh-note' }, props.rangeLabel || '')),
          chartReady ? React.createElement('div', { className: 'uh-note' }, tr('点击数据点查看当日明细', 'Click a point to inspect that day')) : null,
        ),
        chartBody,
        chartReady ? React.createElement('div', { className: 'uh-trend-legend' },
          ['total', 'input', 'cacheRead', 'cacheWrite', 'output', 'reasoning'].map((key) => React.createElement('button', { key, type: 'button', className: 'uh-trend-legend-item' + (visible.includes(key) ? ' uh-on' : ''), onClick: () => toggle(key), 'aria-pressed': visible.includes(key) }, React.createElement('span', { className: 'uh-trend-dot', style: { background: colors[key] || '#9aa4b2' } }), trendSeriesLabel(key, language))),
        ) : null,
      )
    }

    const MemoUsageTrendChart = React.memo(UsageTrendChart)

    function UsageHeatmapTooltip(props) {
      const language = props.language === 'en' ? 'en' : 'zh'
      const day = props.day
      const rows = React.useMemo(() => (day && Array.isArray(day.perWorkspace) ? day.perWorkspace : []).slice().sort((left, right) => right.turns - left.turns), [day])
      const tokens = day === undefined ? null : rowTokens(day)
      const tokensText = tokens !== null && tokens.input + tokens.output + tokens.cacheRead > 0
        ? (language === 'en'
          ? 'Tokens: Input ' + fmtCompact(tokens.input) + ' · Cache hits ' + fmtCompact(tokens.cacheRead) + ' · Output ' + fmtCompact(tokens.output)
          : 'Token：输入 ' + fmtCompact(tokens.input) + ' · 缓存命中 ' + fmtCompact(tokens.cacheRead) + ' · 输出 ' + fmtCompact(tokens.output))
        : ''
      return React.createElement('div', { ref: props.tooltipRef, className: 'uh-tip', style: { left: 0, top: 0, visibility: 'hidden' } },
        React.createElement('div', { className: 'uh-tip-date' }, humanDate(props.date, language)),
        day !== undefined && day.turns > 0
          ? rows.map((entry) => React.createElement('div', { key: entry.workspaceId, className: 'uh-tip-row', onClick: () => props.onWorkspaceSelect(entry.workspaceId) },
              React.createElement('span', { className: 'uh-dot', style: { background: wsColor(props.workspaceIndexes.get(entry.workspaceId) || 0) } }),
              React.createElement('span', {}, props.workspaceTitles.get(entry.workspaceId) || (language === 'en' ? 'Unknown workspace' : '未知工作区')),
              React.createElement('span', { className: 'uh-n' }, language === 'en' ? entry.turns + ' uses' : entry.turns + ' 次'),
            ))
          : React.createElement('div', { className: 'uh-empty', style: { padding: '6px 0' } }, language === 'en' ? 'No usage records for this day' : '这一天没有使用记录'),
        tokensText !== '' ? React.createElement('div', { className: 'uh-tip-tokens' }, tokensText) : null,
      )
    }
    const MemoUsageHeatmapTooltip = React.memo(UsageHeatmapTooltip)

    function UsageHeatmap(props) {
      const language = props.language === 'en' ? 'en' : 'zh'
      const tr = (zh, en) => language === 'en' ? en : zh
      const workspaces = Array.isArray(props.workspaces) ? props.workspaces : []
      const heatmapRows = Array.isArray(props.rows) ? props.rows : []
      const selectedWorkspace = props.workspaceId || null
      const [hoverDate, setHoverDate] = React.useState(null)
      const activeDateRef = React.useRef(null)
      const tooltipRef = React.useRef(null)
      const pointerRef = React.useRef({ x: 0, y: 0 })
      const frameRef = React.useRef(null)
      const fallbackRef = React.useRef(null)
      const dateClickRef = React.useRef(props.onDateClick)
      const workspaceSelectRef = React.useRef(props.onWorkspaceSelect)
      dateClickRef.current = props.onDateClick
      workspaceSelectRef.current = props.onWorkspaceSelect
      const calendar = React.useMemo(() => buildCalendarModel(props.todayKey, props.utc === true, language), [props.todayKey, props.utc, language])
      const heatmapMap = React.useMemo(() => {
        const result = new Map()
        for (const day of heatmapRows) if (day && typeof day.date === 'string') result.set(day.date, day)
        return result
      }, [heatmapRows])
      const workspaceLookup = React.useMemo(() => {
        const titles = new Map()
        const indexes = new Map()
        const aliases = props.aliases && typeof props.aliases === 'object' ? props.aliases : {}
        workspaces.forEach((workspace, index) => {
          const alias = aliases[workspace.id]
          titles.set(workspace.id, typeof alias === 'string' && alias !== '' ? alias : (workspace.title || tr('未知工作区', 'Unknown workspace')))
          indexes.set(workspace.id, index)
        })
        return { titles, indexes }
      }, [workspaces, props.aliases, language])
      const flushTooltipPosition = React.useCallback(() => {
        frameRef.current = null
        if (fallbackRef.current !== null) { window.clearTimeout(fallbackRef.current); fallbackRef.current = null }
        const tooltip = tooltipRef.current
        if (tooltip === null) return
        const point = pointerRef.current
        const viewportWidth = typeof window === 'undefined' ? 1280 : window.innerWidth
        tooltip.style.left = (point.x + 14) + 'px'
        tooltip.style.top = (point.y + 12) + 'px'
        tooltip.style.transform = point.x > viewportWidth * .65 ? 'translateX(calc(-100% - 28px))' : 'none'
        tooltip.style.visibility = 'visible'
      }, [])
      const scheduleTooltipPosition = React.useCallback((x, y) => {
        pointerRef.current = { x, y }
        if (frameRef.current !== null) return
        frameRef.current = window.requestAnimationFrame(flushTooltipPosition)
        fallbackRef.current = window.setTimeout(() => {
          if (frameRef.current === null) return
          window.cancelAnimationFrame(frameRef.current)
          flushTooltipPosition()
        }, 80)
      }, [flushTooltipPosition])
      React.useEffect(() => () => {
        if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current)
        if (fallbackRef.current !== null) window.clearTimeout(fallbackRef.current)
      }, [])
      React.useEffect(() => {
        if (hoverDate === null || frameRef.current !== null) return
        frameRef.current = window.requestAnimationFrame(flushTooltipPosition)
      }, [hoverDate, flushTooltipPosition])
      const activateCell = React.useCallback((date, event) => {
        if (activeDateRef.current !== date) {
          activeDateRef.current = date
          setHoverDate(date)
        }
        scheduleTooltipPosition(event.clientX, event.clientY)
      }, [scheduleTooltipPosition])
      const moveTooltip = React.useCallback((event) => {
        scheduleTooltipPosition(event.clientX, event.clientY)
      }, [scheduleTooltipPosition])
      const clearHover = React.useCallback(() => {
        activeDateRef.current = null
        setHoverDate(null)
      }, [])
      const selectWorkspace = React.useCallback((workspaceId) => {
        if (typeof workspaceSelectRef.current === 'function') workspaceSelectRef.current(workspaceId)
        clearHover()
      }, [clearHover])
      const cellElements = React.useMemo(() => calendar.cells.map((cell, index) => {
        const day = heatmapMap.get(cell.date)
        let count = 0
        if (day !== undefined) {
          if (props.queryUsable === true || selectedWorkspace === null) count = day.turns
          else {
            const workspace = Array.isArray(day.perWorkspace) ? day.perWorkspace.find((entry) => entry.workspaceId === selectedWorkspace) : undefined
            if (workspace !== undefined) count = workspace.turns
          }
        }
        const dim = selectedWorkspace !== null && day !== undefined && day.turns > 0 && count === 0
        const style = { background: cellBg(levelOf(count)), opacity: dim ? 0.22 : 1, animationDelay: (index * 1.2) + 'ms' }
        if (cell.date === props.todayKey) style.animation = 'uh-cell-in .45s ease both, uh-glow 3s ease-in-out .7s infinite'
        return React.createElement('div', { key: cell.date, className: 'uh-cell', style,
          onMouseEnter: (event) => activateCell(cell.date, event),
          onMouseMove: moveTooltip,
          onMouseLeave: clearHover,
          onClick: () => { if (typeof dateClickRef.current === 'function') dateClickRef.current(cell.date) },
        })
      }), [calendar.cells, heatmapMap, props.queryUsable, props.todayKey, selectedWorkspace, activateCell, moveTooltip, clearHover])
      const hoverDay = hoverDate === null ? undefined : heatmapMap.get(hoverDate)
      return React.createElement('div', { className: 'uh-panel' },
        React.createElement('div', { className: 'uh-section-title' }, React.createElement(LineIcon, { name: 'calendar', size: 16 }), tr('使用热力图', 'Usage Heatmap')),
        React.createElement('div', { className: 'uh-hm-head' },
          React.createElement('div', { className: 'uh-chips' }, workspaces.map((workspace, index) => React.createElement('button', { key: workspace.id, className: 'uh-chip' + (selectedWorkspace === workspace.id ? ' uh-on' : ''), onClick: () => selectWorkspace(workspace.id), title: workspace.path },
            React.createElement('span', { className: 'uh-dot', style: { background: wsColor(index) } }),
            React.createElement('span', { className: 'uh-chip-title' }, workspaceLookup.titles.get(workspace.id)),
          ))),
          React.createElement('div', { className: 'uh-legend' },
            React.createElement('span', {}, tr('少', 'Less')),
            [0, 1, 2, 3, 4].map((level) => React.createElement('span', { key: level, className: 'uh-cell', style: { background: cellBg(level) } })),
            React.createElement('span', {}, tr('多', 'More')),
          ),
        ),
        React.createElement('div', { className: 'uh-hm-scroll' },
          React.createElement('div', { className: 'uh-months' }, calendar.months.map((month, index) => React.createElement('span', { key: index, style: { left: month.left } }, month.text))),
          React.createElement('div', { className: 'uh-hm-body' },
            React.createElement('div', { className: 'uh-wdays' }, calendar.weekdays.map((weekday, index) => React.createElement('span', { key: index }, weekday))),
            React.createElement('div', { className: 'uh-grid' }, cellElements),
          ),
        ),
        React.createElement('div', { className: 'uh-note', style: { marginTop: 10 } }, tr('口径：每完成一个回合点亮一次（含子代理会话）；悬停查看按工作区明细，点击工作区可筛选热力图与明细表。日期按本地时区。', 'Methodology: one cell lights up for each completed turn, including subagent sessions. Hover to view workspace details; click a workspace to filter the heatmap and detail tables. English dates and day boundaries use UTC.')),
        hoverDate !== null ? React.createElement(MemoUsageHeatmapTooltip, { date: hoverDate, day: hoverDay, language, tooltipRef, workspaceTitles: workspaceLookup.titles, workspaceIndexes: workspaceLookup.indexes, onWorkspaceSelect: selectWorkspace }) : null,
      )
    }
    const MemoUsageHeatmap = React.memo(UsageHeatmap)

    function auditToken(row, key) {
      return Number(row && row.values && row.values[key]) || 0
    }
    function auditTotal(row) {
      return auditToken(row, 'input') + auditToken(row, 'cacheRead') + auditToken(row, 'cacheWrite') + auditToken(row, 'output') + auditToken(row, 'reasoning')
    }
    function UsagePricingDialog(props) {
      return props.render()
    }
    const MemoUsagePricingDialog = React.memo(UsagePricingDialog, (previous, next) => previous.revision === next.revision)

    function ModelIcon(props) {
      const size = Number.isFinite(props.size) ? props.size : 18
      // An explicit null iconKey means the caller already resolved 'no brand'
      // (e.g. a provider aggregate for a reseller): never fall back to guessing
      // a brand from the row's model namespace in that case.
      const icon = props.iconKey === null ? null : props.iconKey !== undefined ? MODEL_ICON_BY_KEY.get(props.iconKey) || null : resolveModelIcon(props.row)
      const [failed, setFailed] = React.useState(false)
      const style = { width: size, height: size, minWidth: size }
      if (icon === null || failed) {
        return React.createElement('span', { className: 'uh-model-icon uh-model-icon-fallback' + (props.className ? ' ' + props.className : ''), style, 'aria-hidden': true })
      }
      return React.createElement('span', { className: 'uh-model-icon' + (props.className ? ' ' + props.className : ''), style, 'aria-hidden': true, title: props.showTitle === true ? icon.label : undefined },
        React.createElement('img', { src: icon.href, alt: '', width: size, height: size, loading: 'lazy', decoding: 'async', draggable: false, onError: () => setFailed(true) }),
      )
    }
    const MemoModelIcon = React.memo(ModelIcon)
    function UsageRecordsPanel(props) {
      const language = props.language === 'en' ? 'en' : 'zh'
      const tr = (zh, en) => language === 'en' ? en : zh
      const rows = Array.isArray(props.rows) ? props.rows : []
      const selected = React.useMemo(() => rows.find((row) => row.id === props.selectedId) || rows[0] || null, [rows, props.selectedId])
      const auditSource = (row) => row && row.materialization === 'ledger-recovery' ? tr('账本恢复', 'Ledger recovery') : row && row.materialization === 'ledger-reuse' ? tr('账本复用', 'Ledger reuse') : row && row.materialization === 'scan' ? tr('扫描', 'Scan') : row && row.materialization === 'live' ? tr('实时', 'Live') : tr('未知', 'Unknown')
      const auditTime = (row, detailed) => row && Number.isFinite(row.time) ? new Date(row.time).toLocaleString(language === 'en' ? 'en-US' : 'zh-CN', language === 'en' ? (detailed ? { timeZone: 'UTC' } : { timeZone: 'UTC', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : (detailed ? undefined : { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })) : '—'
      const select = (rowId) => { if (typeof props.onSelect === 'function') props.onSelect(rowId) }
      return React.createElement('div', { className: 'uh-panel uh-records-panel', ref: props.panelRef, style: { display: props.visible ? 'block' : 'none' } },
        React.createElement('div', { className: 'uh-records-head' },
          React.createElement('div', {},
            React.createElement('h3', { className: 'uh-tbl-title uh-title-with-icon' }, React.createElement(LineIcon, { name: 'list', size: 16 }), tr('请求日志', 'Request Logs')),
            React.createElement('div', { className: 'uh-note' }, props.scopeLabel + (props.scopeUtc ? ' · UTC' : '')),
          ),
          React.createElement('div', { className: 'uh-actions' },
            props.loading ? React.createElement('span', { className: 'uh-query-note' }, tr('同步中…', 'Refreshing…')) : null,
            React.createElement('button', { type: 'button', className: 'uh-refresh', title: tr('导出当前日志', 'Export current logs'), onClick: props.onExport, disabled: props.exporting || !props.scopeAvailable }, React.createElement(LineIcon, { name: 'export', size: 13 }), props.exporting ? tr('导出中…', 'Exporting…') : tr('导出日志', 'Export logs')),
          ),
        ),
        props.error !== '' ? React.createElement('div', { className: 'uh-records-error', role: 'alert' }, props.error === 'stale' ? tr('数据已更新，正在重新加载日志…', 'Data changed; reloading logs…') : props.error === 'audit-export' ? tr('日志导出失败', 'Unable to export logs') : tr('日志加载失败，请重试', 'Unable to load logs')) : null,
        React.createElement('div', { className: 'uh-records-note' }, tr('按时间倒序显示可审计的 Token 调用；选择一行查看 turn / step 和完整 Token 分桶。', 'Token calls are newest first; select a row to inspect its turn / step and token buckets.')),
        rows.length === 0 && !props.loading ? React.createElement('div', { className: 'uh-empty' }, tr('当前范围没有可审计的 Token 调用', 'No auditable Token calls in this scope')) : React.createElement('div', { className: 'uh-records-scroll' },
          React.createElement('div', { className: 'uh-record-grid uh-record-header' },
            React.createElement('div', {}, tr('时间', 'Time')), React.createElement('div', {}, tr('Provider / 模型', 'Provider / Model')), React.createElement('div', { className: 'uh-record-num' }, 'turn / step'), React.createElement('div', { className: 'uh-record-num' }, tr('输入', 'Input')), React.createElement('div', { className: 'uh-record-num' }, tr('缓存命中', 'Cache read')), React.createElement('div', { className: 'uh-record-num' }, tr('缓存写入', 'Cache write')), React.createElement('div', { className: 'uh-record-num' }, tr('输出', 'Output')), React.createElement('div', { className: 'uh-record-num' }, tr('成本', 'Cost')), React.createElement('div', {}, tr('来源', 'Source')),
          ),
          rows.map((row) => React.createElement('div', { key: row.id, className: 'uh-record-grid uh-record-row' + (selected && selected.id === row.id ? ' uh-on' : ''), role: 'button', tabIndex: 0, 'aria-pressed': selected && selected.id === row.id, onClick: () => select(row.id), onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(row.id) } } },
            React.createElement('div', { className: 'uh-record-time' }, auditTime(row, false)),
            React.createElement('div', { className: 'uh-record-model', title: row.model || '' },
              React.createElement('span', { className: 'uh-model-label' }, React.createElement(MemoModelIcon, { row, size: 16 }), React.createElement('span', { className: 'uh-model-text' }, row.model || tr('未知模型', 'Unknown model'))),
              row.requestedModel && row.actualModel && row.requestedModel !== row.actualModel ? React.createElement('small', {}, row.requestedModel + ' → ' + row.actualModel) : null),
            React.createElement('div', { className: 'uh-record-num' }, (row.turn === null || row.turn === undefined ? '—' : row.turn) + ' / ' + (row.step === null || row.step === undefined ? '—' : row.step)),
            React.createElement('div', { className: 'uh-record-num' }, fmtCompact(auditToken(row, 'input'))),
            React.createElement('div', { className: 'uh-record-num' }, fmtCompact(auditToken(row, 'cacheRead'))),
            React.createElement('div', { className: 'uh-record-num' }, fmtCompact(auditToken(row, 'cacheWrite'))),
            React.createElement('div', { className: 'uh-record-num' }, fmtCompact(auditToken(row, 'output'))),
            React.createElement('div', { className: 'uh-record-num uh-cost-num' }, costDisplay(row, language), row.cost && (row.cost.pricingBand === 'peak' || row.cost.pricingBand === 'off-peak') ? React.createElement('small', { className: 'uh-record-band-badge' }, row.cost.pricingBand === 'peak' ? (language === 'en' ? 'Peak' : '峰') : (language === 'en' ? 'OFF' : '谷')) : null),
            React.createElement('div', { className: 'uh-record-source' }, auditSource(row)),
          )),
        ),
        React.createElement('div', { className: 'uh-records-footer' },
          React.createElement('span', { className: 'uh-note' }, rows.length > 0 ? (props.hasMore ? tr('已显示 ' + rows.length + ' 条，继续加载可查看更多', rows.length + ' shown; load more for additional records') : tr('共显示 ' + rows.length + ' 条', rows.length + ' records shown')) : ''),
          props.hasMore ? React.createElement('button', { type: 'button', className: 'uh-refresh', onClick: props.onLoadMore, disabled: props.loading }, props.loading ? tr('加载中…', 'Loading…') : tr('加载更多', 'Load more')) : null,
        ),
        selected ? React.createElement('div', { className: 'uh-record-detail' },
          React.createElement('div', { className: 'uh-record-detail-head' }, React.createElement('strong', {}, tr('选中调用', 'Selected call')), React.createElement('span', { className: 'uh-note' }, auditTime(selected, true))),
          React.createElement('div', { className: 'uh-record-detail-meta' },
            React.createElement('span', { className: 'uh-model-label' }, React.createElement(MemoModelIcon, { row: selected, size: 16, showTitle: true }), React.createElement('span', {}, (selected.provider || tr('未知供应商', 'Unknown provider')) + ' / ' + (selected.actualModel || selected.requestedModel || selected.model || tr('未知模型', 'Unknown model')))),
            React.createElement('span', {}, 'turn ' + (selected.turn === null || selected.turn === undefined ? '—' : selected.turn) + ' · step ' + (selected.step === null || selected.step === undefined ? '—' : selected.step)),
            React.createElement('span', {}, tr('来源：', 'Source: ') + auditSource(selected)),
            React.createElement('span', {}, tr('计价模型：', 'Pricing model: ') + (selected.cost && selected.cost.pricingModel ? selected.cost.pricingModel : tr('未计价', 'unpriced'))),
            React.createElement('span', { className: 'uh-record-band ' + (selected.cost && selected.cost.pricingBand ? 'uh-record-band-' + selected.cost.pricingBand : '') }, tr('计费档位：', 'Billing band: ') + costBandLabel(selected, language)),
            costPolicyLabel(selected, language) !== null ? React.createElement('span', { className: 'uh-record-band', title: (selected.cost && selected.cost.pricingPolicyHash) || '' }, tr('计费计划：', 'Plan: ') + costPolicyLabel(selected, language)) : null,
          ),
          React.createElement('div', { className: 'uh-record-token-strip' },
            ['input', 'cacheRead', 'cacheWrite', 'output', 'reasoning'].map((key) => React.createElement('div', { key }, React.createElement('span', {}, key === 'cacheRead' ? tr('缓存命中', 'Cache read') : key === 'cacheWrite' ? tr('缓存写入', 'Cache write') : key === 'reasoning' ? tr('推理', 'Reasoning') : key === 'input' ? tr('输入', 'Input') : tr('输出', 'Output')), React.createElement('strong', {}, fmtCompact(auditToken(selected, key))))),
            React.createElement('div', { className: 'uh-record-token-total' }, React.createElement('span', {}, tr('总处理', 'Total')), React.createElement('strong', {}, fmtCompact(auditTotal(selected)))),
            React.createElement('div', { className: 'uh-record-token-total' }, React.createElement('span', {}, tr('成本', 'Cost')), React.createElement('strong', {}, costDisplay(selected, language))),
          ),
        ) : null,
      )
    }
    function equalRecordsPanelProps(previous, next) {
      return previous.visible === next.visible && previous.scopeLabel === next.scopeLabel && previous.scopeUtc === next.scopeUtc && previous.scopeAvailable === next.scopeAvailable && previous.loading === next.loading && previous.exporting === next.exporting && previous.error === next.error && previous.rows === next.rows && previous.selectedId === next.selectedId && previous.hasMore === next.hasMore && previous.language === next.language && previous.actionKey === next.actionKey
    }
    const MemoUsageRecordsPanel = React.memo(UsageRecordsPanel, equalRecordsPanelProps)

    function UsageFilterMenu(props) {
      const options = Array.isArray(props.options) ? props.options : []
      const value = props.value === undefined || props.value === null ? '' : String(props.value)
      const selected = options.find((option) => String(option.value) === value)
      const [open, setOpen] = React.useState(false)
      const menuRef = React.useRef(null)
      React.useEffect(() => {
        if (!open || typeof document === 'undefined') return undefined
        const closeMenu = (event) => {
          if (menuRef.current && !menuRef.current.contains(event.target)) setOpen(false)
        }
        document.addEventListener('pointerdown', closeMenu)
        return () => document.removeEventListener('pointerdown', closeMenu)
      }, [open])
      const choose = (next) => {
        if (typeof props.onChange === 'function') props.onChange(next)
        setOpen(false)
      }
      return React.createElement('div', { className: 'uh-language-menu uh-filter-menu' + (props.className ? ' ' + props.className : '') + (open ? ' uh-open' : ''), ref: menuRef, onKeyDown: (event) => { if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false) } } },
        React.createElement('button', {
          type: 'button',
          className: 'uh-language-trigger uh-filter-trigger' + (open ? ' uh-open' : ''),
          title: selected ? selected.label : props.label,
          'aria-label': props.ariaLabel || props.label,
          'aria-haspopup': 'listbox',
          'aria-expanded': open,
          onClick: () => setOpen((current) => !current),
        },
          React.createElement(LineIcon, { name: props.icon || 'chart', size: 14 }),
          React.createElement('span', { className: 'uh-filter-label' }, selected ? selected.label : props.label),
          React.createElement(LineIcon, { name: 'chevron', size: 13, className: 'uh-language-caret' }),
        ),
        open ? React.createElement('div', { className: 'uh-language-options uh-filter-options', role: 'listbox', 'aria-label': props.ariaLabel || props.label },
          options.map((option) => {
            const optionValue = String(option.value)
            const active = optionValue === value
            return React.createElement('button', {
              key: optionValue,
              type: 'button',
              role: 'option',
              'aria-selected': active,
              className: 'uh-language-option' + (active ? ' uh-on' : ''),
              onClick: () => choose(optionValue),
            },
              React.createElement(LineIcon, { name: props.icon || 'chart', size: 14 }),
              React.createElement('span', { className: 'uh-filter-option-label' }, option.label),
              active ? React.createElement(LineIcon, { name: 'check', size: 14, className: 'uh-language-option-check' }) : null,
            )
          }),
        ) : null,
      )
    }

    const CSS = `
.uh-page { display:flex; flex-direction:column; gap:14px; padding:2px 2px 28px; font-family:inherit; }
.uh-head { position:relative; z-index:20; display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; }
.uh-title { margin:0; font-size:15px; font-weight:600; color:var(--dsw-alias-label-primary); }
.uh-actions { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.uh-language-menu, .uh-filter-menu { position:relative; z-index:12; }
.uh-filter-menu { flex:0 1 auto; min-width:0; }
.uh-filter-workspace { width:180px; }
.uh-filter-provider { width:180px; }
.uh-filter-model { width:260px; }
.uh-filter-menu.uh-open { z-index:14; }
.uh-language-trigger { display:inline-flex; align-items:center; gap:6px; min-height:30px; padding:4px 9px 4px 10px; border:1px solid transparent; border-radius:15px; background:color-mix(in srgb, var(--dsw-alias-label-primary) 7%, var(--dsw-alias-bg-layer-1)); color:var(--dsw-alias-label-primary); font:inherit; font-size:12px; font-weight:600; line-height:1; cursor:pointer; transition:border-color .15s ease, background-color .15s ease, transform .1s ease; }
.uh-filter-trigger { width:100%; min-width:0; justify-content:flex-start; }
.uh-language-trigger:hover, .uh-language-trigger.uh-open { border-color:color-mix(in srgb, var(--dsw-alias-brand-primary) 58%, var(--dsw-alias-border-l2)); background:color-mix(in srgb, var(--dsw-alias-brand-primary) 13%, var(--dsw-alias-bg-layer-1)); }
.uh-language-trigger:active { transform:scale(.96); }
.uh-language-label { min-width:26px; text-align:left; }
.uh-filter-label { min-width:0; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; text-align:left; }
.uh-language-caret { color:var(--dsw-alias-label-secondary); transition:transform .18s ease; }
.uh-language-trigger.uh-open .uh-language-caret { transform:rotate(180deg); }
.uh-language-menu.uh-open { z-index:30; }
.uh-language-options { position:absolute; top:calc(100% + 7px); right:0; min-width:142px; padding:5px; border:1px solid var(--dsw-alias-border-l2); border-radius:12px; background:var(--dsw-alias-bg-layer-1); box-shadow:0 14px 28px color-mix(in srgb, #000 24%, transparent); animation:uh-menu-in .16s ease both; }
.uh-filter-options { left:0; right:auto; min-width:100%; max-width:300px; }
.uh-language-option { display:flex; align-items:center; gap:8px; width:100%; min-height:32px; padding:6px 8px; border:0; border-radius:8px; background:transparent; color:var(--dsw-alias-label-primary); font:inherit; font-size:12px; text-align:left; cursor:pointer; transition:background-color .14s ease, color .14s ease; }
.uh-filter-option-label { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.uh-language-option:hover, .uh-language-option:focus-visible { background:color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, var(--dsw-alias-bg-layer-2)); outline:0; }
.uh-language-option.uh-on { background:color-mix(in srgb, var(--dsw-alias-brand-primary) 19%, var(--dsw-alias-bg-layer-2)); color:var(--dsw-alias-label-primary); font-weight:600; }
.uh-language-option-check { margin-left:auto; color:var(--dsw-alias-brand-primary); }
.uh-range { display:inline-flex; border:1px solid var(--dsw-alias-border-l2); border-radius:8px; overflow:hidden; }
.uh-range button { border:0; background:transparent; color:var(--dsw-alias-label-secondary); padding:4px 12px; font-size:12px; cursor:pointer; font-family:inherit; transition:background-color .15s ease, color .15s ease; }
.uh-range button + button { border-left:1px solid var(--dsw-alias-border-l2); }
.uh-range button.uh-on { background:color-mix(in srgb, var(--dsw-alias-brand-primary) 20%, var(--dsw-alias-bg-layer-2)); color:var(--dsw-alias-label-primary); font-weight:600; }
.uh-custom-range { display:grid; grid-template-columns:minmax(180px, 1fr) auto auto; gap:10px 14px; align-items:end; padding:12px; border:1px solid var(--dsw-alias-border-l1); border-radius:10px; background:var(--dsw-alias-bg-layer-1); }
.uh-custom-range-meta { min-width:0; }
.uh-custom-range-title { display:flex; align-items:center; gap:7px; color:var(--dsw-alias-label-primary); font-size:13px; font-weight:600; }
.uh-custom-range-note { margin-top:3px; color:var(--dsw-alias-label-secondary); font-size:11px; line-height:1.45; }
.uh-custom-range-fields { display:grid; grid-template-columns:repeat(2, minmax(136px, 1fr)); gap:8px; }
.uh-custom-range-field { display:flex; flex-direction:column; gap:4px; color:var(--dsw-alias-label-secondary); font-size:11px; }
.uh-custom-range-field input { min-width:0; min-height:30px; border:1px solid var(--dsw-alias-border-l2); border-radius:6px; padding:3px 7px; background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); font:inherit; font-size:12px; outline:none; }
.uh-custom-range-field input:focus { border-color:var(--dsw-alias-brand-primary); }
.uh-custom-range-actions { display:flex; gap:6px; }
.uh-custom-range-cancel, .uh-custom-range-apply { min-height:30px; border-radius:6px; padding:4px 10px; font:inherit; font-size:12px; cursor:pointer; }
.uh-custom-range-cancel { border:1px solid var(--dsw-alias-border-l2); background:transparent; color:var(--dsw-alias-label-primary); }
.uh-custom-range-apply { border:1px solid var(--dsw-alias-brand-primary); background:color-mix(in srgb, var(--dsw-alias-brand-primary) 16%, transparent); color:var(--dsw-alias-label-primary); }
.uh-custom-range-apply:disabled { opacity:.48; cursor:not-allowed; }
.uh-custom-range-error { grid-column:1 / -1; color:#d92d20; font-size:12px; }
.uh-refresh { border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); border-radius:8px; padding:4px 12px; font-size:12px; cursor:pointer; font-family:inherit; transition:border-color .15s ease, color .15s ease, transform .1s ease; }
.uh-refresh:hover { border-color:var(--dsw-alias-brand-primary); }
.uh-refresh:active, .uh-chip:active, .uh-range button:active { transform:scale(.96); }
.uh-alias-panel-head { display:flex; align-items:center; justify-content:space-between; margin-bottom:10px; font-size:13px; font-weight:600; color:var(--dsw-alias-label-primary); }
.uh-alias-close { border:0; background:transparent; color:var(--dsw-alias-label-secondary); font-size:12px; cursor:pointer; font-family:inherit; padding:0; transition:color .15s ease; }
.uh-alias-close:hover { color:var(--dsw-alias-brand-primary); }
.uh-alias-list { display:grid; grid-template-columns:repeat(auto-fill, minmax(250px, 1fr)); gap:8px 16px; max-height:240px; overflow-y:auto; }
.uh-alias-item { display:flex; align-items:center; gap:8px; min-width:0; }
.uh-alias-folder { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:11px; color:var(--dsw-alias-label-secondary); }
.uh-alias-input { flex:none; width:150px; border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); border-radius:6px; padding:3px 8px; font-size:12px; font-family:inherit; outline:none; transition:border-color .15s ease; }
.uh-alias-input:focus { border-color:var(--dsw-alias-brand-primary); }
.uh-alias-panel-foot { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-top:10px; padding-top:10px; border-top:1px solid var(--dsw-alias-border-l1); }
.uh-alias-ok { border:1px solid var(--dsw-alias-brand-primary); background:color-mix(in srgb, var(--dsw-alias-brand-primary) 16%, transparent); color:var(--dsw-alias-label-primary); border-radius:6px; font-size:12px; padding:3px 12px; cursor:pointer; font-family:inherit; flex:none; transition:transform .1s ease; }
.uh-alias-ok:active { transform:scale(.96); }
.uh-anim-panel { animation:uh-panel-in .28s ease both; }
.uh-pricing-panel { display:flex; flex-direction:column; gap:12px; }
.uh-pricing-head, .uh-pricing-toolbar, .uh-pricing-section-head, .uh-pricing-foot { display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap; }
.uh-pricing-note { color:var(--dsw-alias-label-secondary); font-size:12px; line-height:1.55; }
.uh-pricing-toolbar { padding:10px 0; border-top:1px solid var(--dsw-alias-border-l1); border-bottom:1px solid var(--dsw-alias-border-l1); }
.uh-pricing-switch { display:inline-flex; align-items:center; gap:7px; color:var(--dsw-alias-label-primary); font-size:12px; }
.uh-pricing-section { display:flex; flex-direction:column; gap:8px; }
.uh-pricing-table-wrap { max-height:392px; overflow-x:auto; overflow-y:scroll; scrollbar-gutter:stable; scrollbar-width:auto; scrollbar-color:#707780 #1d1f22; border:1px solid var(--dsw-alias-border-l1); border-radius:8px; background:var(--dsw-alias-bg-layer-2); }
.uh-pricing-model-table { width:100%; min-width:1080px; border-collapse:collapse; table-layout:fixed; font-size:11px; }
.uh-pricing-model-table th, .uh-pricing-model-table td { min-width:0; padding:8px 9px; border-bottom:1px solid var(--dsw-alias-border-l1); text-align:left; vertical-align:middle; }
.uh-pricing-model-table th { position:sticky; top:0; z-index:1; color:var(--dsw-alias-label-secondary); background:var(--dsw-alias-bg-layer-2); font-weight:650; white-space:nowrap; }
.uh-pricing-model-table th:nth-child(1) { width:24%; }
.uh-pricing-model-table th:nth-child(2) { width:84px; }
.uh-pricing-model-table th:nth-child(3) { width:20%; }
.uh-pricing-model-table th:nth-child(4) { width:96px; }
.uh-pricing-model-table th:nth-child(n+5) { width:100px; text-align:right; }
.uh-pricing-model-table td:nth-child(n+5) { text-align:right; }
.uh-pricing-model-table tbody tr:last-child td { border-bottom:0; }
.uh-pricing-model-table tbody tr:not(.uh-pricing-tier-row):hover { background:color-mix(in srgb, var(--dsw-alias-bg-layer-1) 65%, transparent); }
.uh-pricing-model-name, .uh-pricing-model-target { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--dsw-alias-label-primary); }
.uh-pricing-model-rate { color:var(--dsw-alias-label-secondary); font-variant-numeric:tabular-nums; white-space:nowrap; }
.uh-pricing-status, .uh-pricing-tier-badge { display:inline-flex; justify-content:center; padding:3px 6px; border-radius:6px; font-size:10px; font-weight:650; white-space:nowrap; }
.uh-pricing-status-priced { color:#157347; background:color-mix(in srgb, #30d158 22%, transparent); }
.uh-pricing-status-unpriced, .uh-pricing-status-ambiguous, .uh-pricing-status-unsupported { color:#9a5b00; background:color-mix(in srgb, #ff9f0a 20%, transparent); }
.uh-pricing-tier-badge { color:var(--dsw-alias-brand-primary); background:color-mix(in srgb, var(--dsw-alias-brand-primary) 15%, transparent); }
.uh-pricing-tier-badge.uh-flat { color:var(--dsw-alias-label-secondary); background:var(--dsw-alias-bg-layer-1); }
.uh-pricing-tier-row > td { padding:0 9px 8px; background:color-mix(in srgb, var(--dsw-alias-bg-layer-1) 36%, transparent); }
.uh-pricing-tier-details > summary { display:inline-flex; align-items:center; gap:6px; min-height:28px; color:var(--dsw-alias-label-secondary); cursor:pointer; list-style:none; font-size:11px; }
.uh-pricing-tier-details > summary::-webkit-details-marker { display:none; }
.uh-pricing-tier-caret { transition:transform .15s ease; }
.uh-pricing-tier-details[open] .uh-pricing-tier-caret { transform:rotate(180deg); }
.uh-pricing-tier-context { margin-left:6px; color:var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); }
.uh-pricing-tier-table { width:100%; margin:2px 0 5px; border:1px solid var(--dsw-alias-border-l1); border-radius:6px; border-collapse:separate; border-spacing:0; overflow:hidden; table-layout:fixed; background:var(--dsw-alias-bg-base); }
.uh-pricing-tier-table th, .uh-pricing-tier-table td { position:static; width:auto !important; padding:6px 8px; border-bottom:1px solid var(--dsw-alias-border-l1); text-align:right !important; background:transparent; font-size:10px; }
.uh-pricing-tier-table th:first-child, .uh-pricing-tier-table td:first-child { width:30% !important; text-align:left !important; }
.uh-pricing-tier-table tbody tr:last-child td { border-bottom:0; }
.uh-pricing-tier-table tbody tr:hover { background:color-mix(in srgb, var(--dsw-alias-brand-primary) 6%, transparent); }
.uh-pricing-used-model-picker { position:relative; z-index:2; min-width:0; }
.uh-pricing-used-model-picker:focus-within { z-index:30; }
.uh-pricing-used-model-input { box-sizing:border-box; width:100%; min-width:0; min-height:30px; border:1px solid var(--dsw-alias-border-l2); border-radius:6px; padding:4px 7px; background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); font:inherit; font-size:11px; outline:none; }
.uh-pricing-used-model-input:focus { border-color:var(--dsw-alias-brand-primary); }
.uh-pricing-used-model-options { top:calc(100% + 7px); left:0; right:auto; width:100%; min-width:280px; max-height:240px; overflow-y:auto; z-index:40; }
.uh-pricing-model-search { position:relative; z-index:2; min-width:0; }
.uh-pricing-model-search:focus-within { z-index:30; }
.uh-pricing-model-search-input { box-sizing:border-box; width:100%; min-width:0; min-height:30px; border:1px solid var(--dsw-alias-border-l2); border-radius:6px; padding:4px 7px; background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); font:inherit; font-size:11px; outline:none; }
.uh-pricing-model-search-input:focus { border-color:var(--dsw-alias-brand-primary); }
.uh-pricing-model-options { top:calc(100% + 7px); left:0; right:auto; width:100%; min-width:280px; max-height:240px; overflow-y:auto; z-index:40; }
.uh-pricing-model-option { align-items:flex-start; }
.uh-pricing-model-option-name { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.uh-pricing-model-option-id { margin-left:auto; padding-left:10px; color:var(--dsw-alias-label-secondary); font-size:10px; white-space:nowrap; }
.uh-pricing-edit-row { display:grid; grid-template-columns:minmax(240px,1.2fr) minmax(260px,1.3fr) minmax(78px,.45fr) 32px; gap:10px; align-items:center; min-width:650px; }
.uh-pricing-price-row { grid-template-columns:repeat(5,minmax(108px,1fr)) 32px; min-width:650px; }
.uh-pricing-price-head { display:grid; grid-template-columns:repeat(5,minmax(108px,1fr)) 32px; gap:10px; align-items:center; min-width:650px; color:var(--dsw-alias-label-secondary); font-size:10px; }
.uh-pricing-price-head span { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.uh-pricing-edit-row input, .uh-pricing-tier-edit-row input { box-sizing:border-box; min-width:0; min-height:30px; border:1px solid var(--dsw-alias-border-l2); border-radius:6px; padding:4px 7px; background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); font:inherit; font-size:11px; outline:none; }
.uh-pricing-edit-row input:focus, .uh-pricing-tier-edit-row input:focus { border-color:var(--dsw-alias-brand-primary); }
.uh-pricing-edit-row .uh-refresh, .uh-pricing-tier-edit-row .uh-refresh { min-height:30px; padding:0; }
.uh-pricing-overrides { display:flex; flex-direction:column; min-width:760px; }
.uh-pricing-override { display:flex; flex-direction:column; gap:8px; padding:10px 0; border-bottom:1px solid var(--dsw-alias-border-l1); }
.uh-pricing-override:last-child { border-bottom:0; }
.uh-pricing-tier-editor { margin-left:10px; padding-left:12px; border-left:2px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 34%, var(--dsw-alias-border-l1)); }
.uh-pricing-tier-editor-head { display:flex; align-items:center; justify-content:space-between; gap:10px; min-height:30px; }
.uh-pricing-tier-editor-title { display:flex; align-items:baseline; gap:8px; min-width:0; }
.uh-pricing-tier-editor-title strong { font-size:11px; }
.uh-pricing-tier-editor-title span { color:var(--dsw-alias-label-secondary); font-size:10px; }
.uh-pricing-tier-edit-head, .uh-pricing-tier-edit-row { display:grid; grid-template-columns:minmax(132px,.85fr) repeat(4,minmax(108px,1fr)) 32px; gap:10px; align-items:center; min-width:690px; }
.uh-pricing-tier-edit-head { margin:5px 0; color:var(--dsw-alias-label-secondary); font-size:10px; }
.uh-pricing-tier-edit-row { margin-top:7px; }
.uh-pricing-tier-edit-row.uh-invalid input { border-color:var(--dsw-alias-warning, #a55b00); }
.uh-pricing-tier-empty { padding:5px 0; color:var(--dsw-alias-label-secondary); font-size:10px; }
.uh-pricing-error { color:var(--dsw-alias-warning, #a55b00); font-size:12px; line-height:1.45; }
.uh-pricing-foot { padding-top:4px; }
.uh-cost-num { color:var(--dsw-alias-label-primary); }
.uh-progress { font-size:12px; color:var(--dsw-alias-label-secondary); display:flex; align-items:center; gap:10px; }
.uh-sync-health { margin-top:8px; padding:8px 12px; display:flex; align-items:center; flex-wrap:wrap; gap:6px; border:1px solid var(--dsw-alias-border-l1); border-radius:10px; color:var(--dsw-alias-label-secondary); background:var(--dsw-alias-bg-layer-1); font-size:11px; line-height:1.45; }
.uh-sync-health.uh-stale { color:var(--dsw-alias-warning, #a55b00); border-color:color-mix(in srgb, var(--dsw-alias-warning, #d9822b) 45%, var(--dsw-alias-border-l1)); }
.uh-sync-retry { border:0; background:transparent; color:inherit; font:inherit; text-decoration:underline; cursor:pointer; padding:0 2px; }
.uh-trend-panel { min-height:300px; animation:uh-panel-in .38s ease both; }
.uh-trend-head { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; margin-bottom:10px; }
.uh-trend-chart-wrap { position:relative; min-height:250px; width:100%; overflow:hidden; }
.uh-trend-stage { display:grid; place-items:center; min-height:250px; width:100%; }
.uh-trend-message { color:var(--dsw-alias-label-secondary); font-size:12px; }
.uh-trend-spinner { width:24px; height:24px; border:2px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 22%, var(--dsw-alias-border-l2)); border-top-color:var(--dsw-alias-brand-primary); border-radius:50%; animation:uh-spinner-turn .78s linear infinite; }
.uh-trend-svg { display:block; width:100%; height:auto; min-height:220px; }
.uh-trend-grid { stroke:var(--dsw-alias-border-l1); stroke-width:1; stroke-dasharray:3 4; opacity:.8; }
.uh-trend-cursor { stroke:var(--dsw-alias-label-secondary); stroke-width:1; stroke-dasharray:3 4; opacity:.65; pointer-events:none; }
.uh-trend-point { stroke:var(--dsw-alias-bg-layer-1); stroke-width:2; vector-effect:non-scaling-stroke; pointer-events:none; }
.uh-trend-axis-label { fill:var(--dsw-alias-label-secondary); font-size:11px; font-family:inherit; }
.uh-trend-line { fill:none; stroke-width:2.2; vector-effect:non-scaling-stroke; stroke-linecap:round; stroke-linejoin:round; opacity:.22; }
.uh-trend-line-draw { fill:none; stroke-width:2.2; vector-effect:non-scaling-stroke; stroke-linecap:round; stroke-linejoin:round; stroke-dasharray:var(--uh-draw-length); stroke-dashoffset:var(--uh-draw-length); opacity:.96; pointer-events:none; animation:uh-trend-draw .95s cubic-bezier(.22,.61,.36,1) both; }
.uh-trend-area { opacity:1; animation:uh-trend-fill .8s ease; }
.uh-trend-hit { fill:transparent; cursor:crosshair; outline:none; }
.uh-trend-hit:focus { fill:color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, transparent); outline:1px solid var(--dsw-alias-brand-primary); outline-offset:2px; }
.uh-trend-tooltip { position:absolute; z-index:4; min-width:166px; padding:10px 11px; border:1px solid color-mix(in srgb, var(--dsw-alias-border-l2) 88%, transparent); border-radius:8px; background:color-mix(in srgb, var(--dsw-alias-bg-layer-1) 94%, transparent); box-shadow:0 10px 24px rgba(0,0,0,.22); backdrop-filter:blur(10px); color:var(--dsw-alias-label-primary); font-size:12px; line-height:1.45; pointer-events:none; opacity:0; visibility:hidden; transform:translate(14px,-50%) scale(.985); transform-origin:left center; transition:left .16s cubic-bezier(.22,.61,.36,1), top .16s cubic-bezier(.22,.61,.36,1), opacity .12s ease, transform .16s cubic-bezier(.22,.61,.36,1), visibility 0s linear .16s; }
.uh-trend-tooltip.uh-left { transform:translate(calc(-100% - 14px),-50%) scale(.985); transform-origin:right center; }
.uh-trend-tooltip.uh-visible { opacity:1; visibility:visible; transform:translate(14px,-50%) scale(1); transition-delay:0s; }
.uh-trend-tooltip.uh-left.uh-visible { transform:translate(calc(-100% - 14px),-50%) scale(1); }
.uh-trend-tooltip-title { display:block; margin-bottom:6px; color:var(--dsw-alias-label-primary); font-size:12px; font-weight:650; }
.uh-trend-tooltip-row { display:grid; grid-template-columns:8px minmax(0,1fr) auto; align-items:center; gap:7px; min-width:0; margin-top:3px; font-size:11px; }
.uh-trend-tooltip-row .uh-trend-dot { width:8px; height:8px; margin:0; }
.uh-trend-tooltip-label { overflow:hidden; font-weight:600; text-overflow:ellipsis; white-space:nowrap; }
.uh-trend-tooltip-value { color:inherit; font-weight:600; font-variant-numeric:tabular-nums; white-space:nowrap; }
.uh-trend-dot { display:inline-block; width:7px; height:7px; margin-right:5px; border-radius:50%; vertical-align:1px; }
.uh-trend-legend { display:flex; flex-wrap:wrap; gap:5px 8px; margin-top:5px; }
.uh-trend-legend-item { display:inline-flex; align-items:center; gap:3px; border:0; border-radius:7px; padding:3px 6px; background:transparent; color:var(--dsw-alias-label-secondary); font:inherit; font-size:11px; cursor:pointer; transition:color .15s ease; }
.uh-trend-legend-item:hover { background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); }
.uh-trend-legend-item.uh-on { background:var(--dsw-alias-interactive-bg-hover); color:var(--dsw-alias-label-primary); }
.uh-filter-bar { position:relative; z-index:10; display:flex; align-items:center; flex-wrap:wrap; gap:7px; }
.uh-filter-clear { border:0; background:transparent; color:var(--dsw-alias-label-secondary); font:inherit; font-size:11px; cursor:pointer; text-decoration:underline; }
.uh-query-note { color:var(--dsw-alias-label-secondary); font-size:11px; }
.uh-detail-tabs { display:flex; align-items:center; flex-wrap:wrap; gap:4px; padding:4px; border:1px solid var(--dsw-alias-border-l1); border-radius:9px; background:color-mix(in srgb, var(--dsw-alias-bg-layer-2) 58%, transparent); }
.uh-detail-tab { display:inline-flex; align-items:center; gap:6px; min-height:32px; padding:5px 11px; border:0; border-radius:7px; background:transparent; color:var(--dsw-alias-label-secondary); font:inherit; font-size:12px; cursor:pointer; transition:background-color .15s ease, color .15s ease, transform .12s ease; }
.uh-detail-tab:hover { color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-layer-2); }
.uh-detail-tab.uh-on { color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-layer-1); box-shadow:0 1px 3px rgba(0,0,0,.14); }
.uh-records-panel { animation:uh-panel-in .28s ease both; }
.uh-records-head { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; margin-bottom:7px; }
.uh-records-note { margin:8px 0 10px; color:var(--dsw-alias-label-secondary); font-size:11px; line-height:1.45; }
.uh-records-error { margin:7px 0; color:var(--dsw-alias-warning, #a55b00); font-size:11px; }
.uh-records-scroll { overflow:auto; border:1px solid var(--dsw-alias-border-l1); border-radius:8px; }
.uh-record-grid { display:grid; grid-template-columns:112px minmax(190px,1.45fr) 78px repeat(4,minmax(76px,.72fr)) 96px 82px; gap:0; min-width:900px; align-items:center; }
.uh-record-grid > div { min-width:0; padding:8px 7px; border-bottom:1px solid var(--dsw-alias-border-l1); font-size:11px; }
.uh-record-header { color:var(--dsw-alias-label-secondary); background:var(--dsw-alias-bg-layer-2); font-weight:600; }
.uh-record-header > div { white-space:nowrap; }
.uh-record-row { color:var(--dsw-alias-label-primary); cursor:pointer; outline:none; transition:background-color .14s ease, box-shadow .14s ease; }
.uh-record-row:hover { background:color-mix(in srgb, var(--dsw-alias-bg-layer-2) 68%, transparent); }
.uh-record-row.uh-on { background:color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, var(--dsw-alias-bg-layer-1)); box-shadow:inset 3px 0 var(--dsw-alias-brand-primary); }
.uh-record-row:focus-visible { box-shadow:inset 0 0 0 1px var(--dsw-alias-brand-primary); }
.uh-record-row:last-child > div { border-bottom:0; }
.uh-record-time, .uh-record-num { color:var(--dsw-alias-label-secondary); font-variant-numeric:tabular-nums; white-space:nowrap; }
.uh-record-num { text-align:right; }
.uh-model-icon { display:inline-flex; align-items:center; justify-content:center; flex:none; vertical-align:middle; }
.uh-model-icon img { display:block; width:100%; height:100%; object-fit:contain; }
.uh-model-icon-fallback { border-radius:50%; background:var(--dsw-alias-fill-tertiary, rgba(128,128,128,.22)); box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l1, rgba(128,128,128,.3)); }
.uh-model-label { display:flex; align-items:center; gap:7px; min-width:0; }
.uh-model-label .uh-model-text { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; }
.uh-record-model { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:550; }
.uh-record-model small { display:block; overflow:hidden; color:var(--dsw-alias-label-secondary); font-size:10px; font-weight:400; text-overflow:ellipsis; white-space:nowrap; }
.uh-record-source { color:var(--dsw-alias-label-secondary); white-space:nowrap; }
.uh-record-band { white-space:nowrap; }
.uh-record-band-badge { margin-left:6px; color:var(--dsw-alias-label-secondary); font-size:10px; }
.uh-record-band-peak { color:var(--dsw-alias-warning, #a55b00); font-weight:600; }
.uh-record-band-off-peak { color:#2e7d32; }
.uh-records-footer { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-top:9px; }
.uh-record-detail { margin-top:12px; padding:10px 11px; border-top:1px solid var(--dsw-alias-border-l2); background:color-mix(in srgb, var(--dsw-alias-bg-layer-2) 42%, transparent); animation:uh-detail-in .24s ease both; }
.uh-record-detail-head, .uh-record-detail-meta { display:flex; align-items:center; flex-wrap:wrap; gap:7px 14px; }
.uh-record-detail-head { justify-content:space-between; margin-bottom:5px; color:var(--dsw-alias-label-primary); font-size:12px; }
.uh-record-detail-meta { color:var(--dsw-alias-label-secondary); font-size:11px; }
.uh-record-token-strip { display:grid; grid-template-columns:repeat(5,minmax(72px,1fr)) repeat(2,minmax(82px,1.1fr)); gap:6px; margin-top:9px; }
.uh-record-token-strip > div { display:flex; flex-direction:column; gap:2px; min-width:0; padding:6px 7px; border-radius:6px; background:var(--dsw-alias-bg-layer-2); }
.uh-record-token-strip span { color:var(--dsw-alias-label-secondary); font-size:10px; }
.uh-record-token-strip strong { color:var(--dsw-alias-label-primary); font-size:12px; font-variant-numeric:tabular-nums; }
.uh-record-token-total { border:1px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 38%, var(--dsw-alias-border-l1)) !important; }
@keyframes uh-detail-in { from { opacity:0; transform:translateY(-4px); } to { opacity:1; transform:translateY(0); } }
@media (max-width:640px) {
  .uh-trend-head { flex-direction:column; }
  .uh-filter-menu { flex:1 1 130px; width:auto; }
  .uh-filter-trigger { max-width:100%; }
  .uh-trend-tooltip { min-width:116px; }
  .uh-records-head { flex-direction:column; }
  .uh-record-token-strip { grid-template-columns:repeat(2,minmax(0,1fr)); }
  .uh-record-token-total { grid-column:1 / -1; }
  .uh-pricing-head { align-items:flex-start; }
  .uh-pricing-toolbar { align-items:flex-start; }
  .uh-pricing-section-head { align-items:center; }
  .uh-pricing-edit-row { grid-template-columns:minmax(0,1fr) 36px; min-width:0; width:100%; }
  .uh-pricing-edit-row > .uh-pricing-used-model-picker,
  .uh-pricing-edit-row > .uh-pricing-model-search,
  .uh-pricing-price-row > input { grid-column:1 / -1; }
  .uh-pricing-edit-row > input[type='number'] { grid-column:1; }
  .uh-pricing-edit-row > .uh-icon-button { grid-column:2; }
  .uh-pricing-price-head { display:none; }
  .uh-pricing-overrides { min-width:0; width:100%; }
  .uh-pricing-override { min-width:0; }
  .uh-pricing-price-row { grid-template-columns:minmax(0,1fr) 36px; min-width:0; }
  .uh-pricing-price-row > input[type='number'] { grid-column:1 / -1; }
  .uh-pricing-tier-editor { margin-left:0; padding-left:0; border-left:0; }
  .uh-pricing-tier-editor-head { align-items:flex-start; flex-wrap:wrap; }
  .uh-pricing-tier-editor-title { flex-direction:column; gap:2px; }
  .uh-pricing-tier-edit-head { display:none; }
  .uh-pricing-tier-edit-row { grid-template-columns:minmax(0,1fr) 36px; min-width:0; padding:8px; border:1px solid var(--dsw-alias-border-l1); border-radius:6px; }
  .uh-pricing-tier-edit-row > input { grid-column:1 / -1; }
  .uh-pricing-tier-edit-row > .uh-icon-button { grid-column:2; }
  .uh-pricing-tier-context { display:block; margin:2px 0 0; }
}
.uh-bar { flex:1; height:6px; border-radius:3px; background:var(--dsw-alias-bg-layer-2); overflow:hidden; max-width:340px; }
.uh-fill { height:100%; background:var(--dsw-alias-brand-primary); border-radius:3px; transition:width .3s ease; }
.uh-cards { display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:10px; }
.uh-card { background:var(--dsw-alias-bg-layer-1); border:1px solid var(--dsw-alias-border-l1); border-radius:12px; padding:12px 14px; display:flex; flex-direction:column; gap:6px; min-height:86px; animation:uh-card-in .45s ease both; transition:transform .18s ease, border-color .18s ease, box-shadow .18s ease; }
.uh-card:hover { transform:translateY(-2px); border-color:var(--dsw-alias-border-l2); box-shadow:0 6px 18px rgba(0,0,0,.10); }
.uh-card-label { font-size:12px; color:var(--dsw-alias-label-secondary); }
.uh-card-value { font-size:20px; font-weight:650; color:var(--dsw-alias-label-primary); line-height:1.2; }
.uh-card-sub { font-size:11px; color:var(--dsw-alias-label-secondary); line-height:1.55; }
.uh-wsbars { display:flex; flex-direction:column; gap:6px; margin-top:2px; }
.uh-wsbar { display:flex; flex-direction:column; gap:3px; cursor:pointer; padding:2px 6px; margin:0 -6px; border-radius:8px; transition:background-color .15s ease; }
.uh-wsbar:hover { background:var(--dsw-alias-bg-layer-2); }
.uh-wsbar.uh-sel { outline:1px solid var(--dsw-alias-brand-primary); }
.uh-wsbar-top { display:flex; align-items:center; gap:6px; min-width:0; }
.uh-wsbar-title { font-size:12px; color:var(--dsw-alias-label-primary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; min-width:0; }
.uh-wsbar-num { font-size:11px; font-variant-numeric:tabular-nums; color:var(--dsw-alias-label-secondary); flex:none; }
.uh-panel { background:var(--dsw-alias-bg-layer-1); border:1px solid var(--dsw-alias-border-l1); border-radius:12px; padding:14px; }
.uh-hm-head { display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap; margin-bottom:10px; }
.uh-chips { display:flex; flex-wrap:wrap; gap:6px; }
.uh-chip { display:inline-flex; align-items:center; gap:6px; border:1px solid var(--dsw-alias-border-l2); background:transparent; color:var(--dsw-alias-label-primary); border-radius:999px; padding:2px 10px; font-size:11px; cursor:pointer; font-family:inherit; max-width:190px; transition:border-color .15s ease, background-color .15s ease, color .15s ease, transform .1s ease; }
.uh-chip .uh-chip-title { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.uh-chip.uh-on { border-color:var(--dsw-alias-brand-primary); background:color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent); }
.uh-dot { width:8px; height:8px; border-radius:50%; flex:none; }
.uh-legend { display:flex; align-items:center; gap:4px; font-size:11px; color:var(--dsw-alias-label-secondary); }
.uh-legend .uh-cell { width:10px; height:10px; border-radius:2px; animation:none; }
.uh-hm-scroll { overflow-x:auto; padding-bottom:2px; }
.uh-months { position:relative; height:16px; margin-left:30px; width:calc(100% - 30px); min-width:686px; font-size:10px; color:var(--dsw-alias-label-secondary); }
.uh-months span { position:absolute; top:0; }
.uh-hm-body { display:flex; gap:6px; min-width:0; }
.uh-wdays { display:grid; grid-template-rows:repeat(7,10px); gap:3px; font-size:10px; color:var(--dsw-alias-label-secondary); text-align:right; width:24px; }
.uh-wdays span { line-height:10px; }
.uh-grid { flex:1 1 auto; min-width:686px; display:grid; grid-auto-flow:column; grid-template-columns:repeat(53,minmax(10px,1fr)); grid-template-rows:repeat(7,minmax(10px,auto)); gap:3px; }
.uh-cell { width:100%; height:auto; min-width:10px; aspect-ratio:1; border-radius:2px; background:var(--dsw-alias-bg-layer-2); animation:uh-cell-in .45s ease both; transition:transform .12s ease, box-shadow .12s ease; }
.uh-cell:hover { transform:scale(1.35); box-shadow:0 1px 6px rgba(0,0,0,.28); position:relative; z-index:2; }
.uh-tip { position:fixed; z-index:1200; background:var(--dsw-alias-bg-overlay); border:1px solid var(--dsw-alias-border-l2); border-radius:10px; padding:10px 12px; box-shadow:0 8px 24px rgba(0,0,0,.18); pointer-events:auto; min-width:200px; max-width:290px; animation:uh-tip-in .16s ease both; }
.uh-tip-date { font-size:12px; font-weight:600; color:var(--dsw-alias-label-primary); margin-bottom:6px; }
.uh-tip-row { display:flex; align-items:center; gap:6px; font-size:12px; color:var(--dsw-alias-label-primary); padding:3px 6px; margin:0 -6px; border-radius:6px; cursor:pointer; transition:background-color .12s ease; }
.uh-tip-row:hover { background:color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent); }
.uh-tip-row .uh-n { margin-left:auto; font-variant-numeric:tabular-nums; color:var(--dsw-alias-label-secondary); }
.uh-tip-tokens { font-size:11px; color:var(--dsw-alias-label-secondary); margin-top:6px; border-top:1px solid var(--dsw-alias-border-l1); padding-top:6px; }
.uh-tbl-title { font-size:13px; font-weight:600; color:var(--dsw-alias-label-primary); margin:0 0 10px; }
.uh-tbl-scroll { overflow-x:auto; }
.uh-hrow, .uh-row { display:grid; grid-template-columns:minmax(160px,2.2fr) .7fr .9fr .9fr .9fr .9fr 1.1fr .9fr .8fr 1fr; gap:8px; align-items:center; min-width:900px; padding:7px 10px; border-radius:8px; font-size:12px; }
.uh-model-hrow, .uh-model-row { display:grid; grid-template-columns:minmax(190px,2.2fr) .7fr .9fr .9fr .9fr .9fr 1.1fr .9fr .8fr; gap:8px; align-items:center; min-width:860px; padding:7px 10px; border-radius:8px; font-size:12px; }
.uh-hrow { color:var(--dsw-alias-label-secondary); font-size:11px; }
.uh-row { cursor:pointer; border:1px solid transparent; transition:background-color .15s ease, border-color .15s ease; }
.uh-row:hover { background:var(--dsw-alias-bg-layer-2); }
.uh-row.uh-sel { border-color:var(--dsw-alias-brand-primary); }
.uh-num { text-align:right; font-variant-numeric:tabular-nums; color:var(--dsw-alias-label-primary); }
.uh-hrow .uh-num { color:var(--dsw-alias-label-secondary); }
.uh-ws-title { color:var(--dsw-alias-label-primary); font-weight:550; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.uh-row-title-wrap { min-width:0; }
.uh-ws-path { color:var(--dsw-alias-label-secondary); font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.uh-barwrap { height:5px; border-radius:3px; background:var(--dsw-alias-bg-layer-2); overflow:hidden; margin-top:3px; }
.uh-barwrap.uh-bar-thin { height:3px; margin-top:1px; }
.uh-barfill { height:100%; border-radius:3px; transform-origin:left center; animation:uh-bar-grow .7s cubic-bezier(.22,.61,.36,1) both; transition:width .5s cubic-bezier(.22,.61,.36,1); }
.uh-empty { color:var(--dsw-alias-label-secondary); font-size:12px; text-align:center; padding:26px 0; }
.uh-note { font-size:11px; color:var(--dsw-alias-label-secondary); line-height:1.6; }
.uh-side-entry { width:100%; border:0; background:transparent; color:var(--dsw-alias-label-secondary); border-radius:8px; min-height:36px; padding:7px 10px; display:flex; align-items:center; gap:9px; font:inherit; font-size:13px; cursor:pointer; text-align:left; }
.uh-side-entry:hover { background:var(--dsw-alias-interactive-bg-hover); color:var(--dsw-alias-label-primary); }
.uh-side-entry-icon { width:18px; text-align:center; flex:none; font-size:15px; }
.uh-side-entry-label { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.uh-boundary-fallback { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:12px; min-height:360px; padding:24px; border:1px solid var(--dsw-alias-border-l1); border-radius:12px; background:var(--dsw-alias-bg-layer-1); text-align:center; }
.uh-boundary-title { color:var(--dsw-alias-label-primary); font-size:15px; font-weight:650; }
.uh-boundary-note { max-width:420px; color:var(--dsw-alias-label-secondary); font-size:12px; line-height:1.6; }
.uh-side-modal { position:fixed; inset:0; z-index:1100; background:color-mix(in srgb, #000 44%, transparent); display:flex; align-items:stretch; justify-content:center; padding:26px; }
.uh-side-dialog { width:min(1120px, 100%); overflow-x:hidden; overflow-y:scroll; scrollbar-gutter:stable; scrollbar-width:auto; scrollbar-color:#707780 #1d1f22; background:var(--dsw-alias-bg-base); border:1px solid var(--dsw-alias-border-l2); border-radius:14px; box-shadow:0 18px 52px rgba(0,0,0,.35); padding:18px; }
.uh-side-dialog::-webkit-scrollbar, .uh-pricing-table-wrap::-webkit-scrollbar { width:12px; height:12px; }
.uh-side-dialog::-webkit-scrollbar-track, .uh-pricing-table-wrap::-webkit-scrollbar-track { background:#1d1f22; border-left:1px solid #363a40; }
.uh-side-dialog::-webkit-scrollbar-thumb, .uh-pricing-table-wrap::-webkit-scrollbar-thumb { background:#707780; border:3px solid #1d1f22; border-radius:6px; }
.uh-side-dialog::-webkit-scrollbar-thumb:hover, .uh-pricing-table-wrap::-webkit-scrollbar-thumb:hover { background:#9aa1aa; }
.uh-side-dialog-head { display:flex; justify-content:flex-end; margin-bottom:8px; }
@media (max-width: 640px) { .uh-side-modal { padding:0; } .uh-side-dialog { border-radius:0; border:0; padding:14px; } }
/* iOS-style dashboard: grouped surfaces, tactile controls, and an elevated sheet. */
.uh-page { gap:18px; max-width:1160px; margin:0 auto; padding:4px 2px 34px; font-family:-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", sans-serif; }
.uh-head { position:sticky; top:-18px; z-index:20; margin:0 -2px; padding:18px 2px 14px; background:color-mix(in srgb, var(--dsw-alias-bg-base) 88%, transparent); backdrop-filter:blur(18px) saturate(150%); border-bottom:1px solid color-mix(in srgb, var(--dsw-alias-border-l1) 76%, transparent); }
.uh-title { font-size:22px; line-height:1.2; font-weight:700; letter-spacing:0; }
.uh-actions { gap:8px; }
.uh-range { padding:2px; gap:2px; border:0; border-radius:9px; background:color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent); overflow:visible; }
.uh-range button, .uh-range button + button { min-height:28px; border:0; border-radius:7px; padding:4px 10px; }
.uh-range button.uh-on { background:var(--dsw-alias-bg-layer-1); box-shadow:0 1px 3px rgba(0,0,0,.16); }
.uh-refresh { min-height:30px; border:0; border-radius:15px; padding:5px 12px; display:inline-flex; align-items:center; justify-content:center; gap:6px; background:color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, var(--dsw-alias-bg-layer-1)); color:var(--dsw-alias-brand-primary); font-weight:600; }
.uh-line-icon { flex:none; }
.uh-icon-button { width:30px; padding:0; }
.uh-refresh:hover { border:0; background:color-mix(in srgb, var(--dsw-alias-brand-primary) 22%, var(--dsw-alias-bg-layer-1)); }
.uh-progress { padding:10px 12px; background:color-mix(in srgb, var(--dsw-alias-brand-primary) 9%, var(--dsw-alias-bg-layer-1)); border:0; border-radius:12px; }
.uh-cards { grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:10px; border:0; border-radius:0; overflow:visible; background:transparent; }
.uh-card { min-height:84px; padding:12px 14px; gap:4px; border:0; border-radius:18px; background:var(--dsw-alias-bg-layer-1); box-shadow:0 1px 2px rgba(0,0,0,.07), 0 8px 22px rgba(0,0,0,.05); animation:none; }
.uh-card:first-child { border:0; background:color-mix(in srgb, #0a84ff 15%, var(--dsw-alias-bg-layer-1)); }
.uh-card:nth-child(2) { background:color-mix(in srgb, #30d158 13%, var(--dsw-alias-bg-layer-1)); }
.uh-card:nth-child(3) { background:color-mix(in srgb, #ff9f0a 14%, var(--dsw-alias-bg-layer-1)); }
.uh-card:hover { transform:translateY(-2px); box-shadow:0 12px 28px rgba(0,0,0,.12); }
.uh-card-label { display:flex; align-items:center; gap:6px; font-size:12px; font-weight:600; letter-spacing:0; }
.uh-ios-summary-label, .uh-section-title, .uh-title-with-icon { display:flex; align-items:center; gap:7px; }
.uh-section-title { margin-bottom:12px; color:var(--dsw-alias-label-primary); font-size:14px; font-weight:650; }
/* Raise the complete reading scale without changing the data grid geometry. */
.uh-page { font-size:14px; }
.uh-range button, .uh-refresh { font-size:13px; }
.uh-card-label, .uh-ios-summary-label { font-size:13px; }
.uh-card-sub, .uh-ios-summary-caption, .uh-note { font-size:12px; }
.uh-hrow, .uh-row, .uh-model-hrow, .uh-model-row { font-size:13px; }
.uh-tbl-title { font-size:15px; }
.uh-num { font-variant-numeric:tabular-nums; }
.uh-card-value { font-size:23px; font-weight:700; letter-spacing:0; }
.uh-card-sub { font-size:11px; line-height:1.45; }
.uh-panel { padding:16px; border:0; border-radius:18px; background:var(--dsw-alias-bg-layer-1); box-shadow:0 1px 2px rgba(0,0,0,.06), 0 6px 18px rgba(0,0,0,.04); }
.uh-hm-head { margin-bottom:12px; }
.uh-chip { border:0; border-radius:14px; padding:5px 10px; background:color-mix(in srgb, var(--dsw-alias-label-primary) 7%, transparent); }
.uh-chip.uh-on { border:0; background:color-mix(in srgb, var(--dsw-alias-brand-primary) 18%, transparent); color:var(--dsw-alias-brand-primary); }
.uh-hrow, .uh-row, .uh-model-hrow, .uh-model-row { border-radius:10px; }
.uh-hrow, .uh-model-hrow { position:sticky; top:66px; z-index:2; background:var(--dsw-alias-bg-layer-1); border-bottom:1px solid var(--dsw-alias-border-l1); }
.uh-row, .uh-model-row { padding-top:9px; padding-bottom:9px; }
.uh-row:nth-child(even) { background:color-mix(in srgb, var(--dsw-alias-bg-layer-2) 52%, transparent); }
.uh-side-entry { min-height:40px; border:0; border-radius:12px; padding:8px 10px; background:color-mix(in srgb, var(--dsw-alias-brand-primary) 9%, transparent); color:var(--dsw-alias-brand-primary); font-weight:600; }
.uh-side-entry:hover { border:0; background:color-mix(in srgb, var(--dsw-alias-brand-primary) 17%, transparent); }
.uh-side-entry-icon { color:var(--dsw-alias-brand-primary); font-weight:700; }
.uh-side-modal { align-items:flex-end; padding:0; background:rgba(0,0,0,.34); backdrop-filter:blur(8px); }
.uh-side-dialog { width:min(1260px, 100%); max-height:calc(100vh - 44px); border:0; border-radius:24px 24px 0 0; padding:22px 24px 28px; background:color-mix(in srgb, var(--dsw-alias-bg-base) 94%, transparent); box-shadow:0 -10px 44px rgba(0,0,0,.25); }
.uh-side-dialog-head { position:sticky; top:-22px; z-index:8; justify-content:center; height:22px; margin:-22px -24px 8px; padding:8px 24px; background:color-mix(in srgb, var(--dsw-alias-bg-base) 94%, transparent); border:0; }
.uh-side-dialog-head::before { content:""; width:36px; height:5px; border-radius:3px; background:color-mix(in srgb, var(--dsw-alias-label-primary) 24%, transparent); }
.uh-side-dialog-head .uh-refresh { position:absolute; right:20px; top:7px; min-height:28px; background:transparent; }
.uh-close-button { width:30px; padding:0; font-size:22px; line-height:1; color:var(--dsw-alias-label-secondary); }
.uh-close-button:hover { color:var(--dsw-alias-label-primary); background:color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent); }
@media (max-width:640px) { .uh-page { gap:14px; padding-bottom:20px; } .uh-head { position:static; padding:4px 0 10px; } .uh-title { font-size:20px; } .uh-custom-range { grid-template-columns:1fr; align-items:stretch; } .uh-custom-range-fields { grid-template-columns:repeat(2, minmax(0, 1fr)); } .uh-custom-range-actions { justify-content:flex-end; } .uh-side-dialog { max-height:calc(100vh - 8px); border-radius:20px 20px 0 0; padding:18px 14px 24px; } .uh-side-dialog-head { top:-18px; margin:-18px -14px 8px; padding:7px 14px; } .uh-card-value { font-size:22px; } }
/* Navigation separates the dashboard into three focused iOS-style surfaces. */
.uh-ios-tabs { display:grid; grid-template-columns:repeat(3, 1fr); gap:4px; padding:4px; border-radius:14px; background:color-mix(in srgb, var(--dsw-alias-label-primary) 9%, transparent); }
.uh-ios-tab { min-height:32px; border:0; border-radius:10px; background:transparent; color:var(--dsw-alias-label-secondary); font:inherit; font-size:13px; font-weight:600; cursor:pointer; }
.uh-ios-tab.uh-on { color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-layer-1); box-shadow:0 1px 4px rgba(0,0,0,.16); }
.uh-ios-summary { display:flex; flex-direction:column; gap:12px; background:transparent; box-shadow:none; }
.uh-ios-summary-hero { display:grid; grid-template-columns:minmax(0,1fr) minmax(320px,.48fr); min-height:142px; padding:20px 22px; border:1px solid var(--dsw-alias-border-l1); border-radius:18px; background:var(--dsw-alias-bg-layer-1); box-shadow:0 1px 2px rgba(0,0,0,.06), 0 8px 22px rgba(0,0,0,.06); }
.uh-ios-summary-total { min-width:0; min-height:0; padding:0; border-radius:0; display:flex; align-items:center; justify-content:flex-start; gap:16px; background:transparent; box-shadow:none; }
.uh-ios-summary-total-icon { display:grid; place-items:center; flex:none; width:54px; height:54px; border-radius:16px; background:color-mix(in srgb,#0a84ff 18%,var(--dsw-alias-bg-layer-2)); color:#0a84ff; }
.uh-ios-summary-total-copy { min-width:0; }
.uh-ios-summary-label { font-size:13px; font-weight:600; color:var(--dsw-alias-label-secondary); }
.uh-ios-summary-total .uh-ios-summary-label { font-size:14px; }
.uh-ios-summary-value { margin-top:7px; font-size:40px; line-height:1; font-weight:750; letter-spacing:0; color:var(--dsw-alias-label-primary); }
.uh-unit { margin-left:6px; color:var(--dsw-alias-label-secondary); font-size:.4em; font-weight:650; white-space:nowrap; vertical-align:baseline; }
.uh-wsbar-num .uh-unit { font-size:.78em; margin-left:3px; }
.uh-ios-summary-caption { margin-top:8px; font-size:12px; color:var(--dsw-alias-label-secondary); }
.uh-ios-summary-meta { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); align-items:center; min-width:0; gap:0; padding:0 0 0 22px; border-left:1px solid var(--dsw-alias-border-l1); background:transparent; font-size:12px; color:var(--dsw-alias-label-secondary); }
.uh-ios-summary-meta-stat { min-width:0; padding:4px 22px; }
.uh-ios-summary-meta-stat + .uh-ios-summary-meta-stat { border-left:1px solid var(--dsw-alias-border-l1); }
.uh-ios-summary-meta-label { display:flex; align-items:center; gap:7px; color:var(--dsw-alias-label-secondary); font-size:12px; font-weight:600; white-space:nowrap; }
.uh-ios-summary-meta-value { margin-top:7px; color:var(--dsw-alias-label-primary); font-size:24px; line-height:1; font-weight:700; font-variant-numeric:tabular-nums; white-space:nowrap; }
.uh-ios-summary-meta-cost .uh-ios-summary-meta-value { color:#30d158; }
.uh-ios-summary-meta-caption { margin-top:7px; color:var(--dsw-alias-label-secondary); font-size:11px; white-space:nowrap; }
.uh-ios-metrics { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:10px; }
.uh-ios-metric { min-width:0; min-height:108px; padding:16px 18px; border:1px solid var(--dsw-alias-border-l1); border-radius:18px; display:flex; flex-direction:column; justify-content:center; gap:10px; background:var(--dsw-alias-bg-layer-1); box-shadow:0 1px 2px rgba(0,0,0,.06), 0 8px 20px rgba(0,0,0,.05); animation:uh-card-in .35s ease both; }
.uh-ios-metrics > .uh-card { min-width:0; min-height:141px; padding:16px 18px; gap:4px; border:0; border-radius:18px; }
.uh-ios-metrics > .uh-card .uh-card-value { min-width:0; font-size:23px; line-height:1.2; font-weight:700; white-space:nowrap; }
.uh-ios-metrics > .uh-card .uh-card-sub { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.uh-ios-metrics > .uh-card:nth-child(-n+3) { justify-content:center; }
.uh-ios-metric-label { display:flex; align-items:center; gap:8px; min-width:0; color:var(--dsw-alias-label-secondary); font-size:13px; font-weight:600; white-space:nowrap; }
.uh-ios-metric-label .uh-line-icon { flex:none; }
.uh-ios-metric-value { min-width:0; color:var(--dsw-alias-label-primary); font-size:26px; line-height:1.05; font-weight:700; font-variant-numeric:tabular-nums; white-space:nowrap; }
.uh-ios-metric-input { background:color-mix(in srgb,#0a84ff 11%,var(--dsw-alias-bg-layer-1)); }
.uh-ios-metric-input .uh-line-icon { color:#0a84ff; }
.uh-ios-metric-output { background:color-mix(in srgb,#bf5af2 10%,var(--dsw-alias-bg-layer-1)); }
.uh-ios-metric-output .uh-line-icon { color:#bf5af2; }
.uh-ios-metric-write { background:color-mix(in srgb,#ff9f0a 11%,var(--dsw-alias-bg-layer-1)); }
.uh-ios-metric-write .uh-line-icon { color:#ff9f0a; }
.uh-ios-metric-read { background:color-mix(in srgb,#30d158 11%,var(--dsw-alias-bg-layer-1)); }
.uh-ios-metric-read .uh-line-icon { color:#30d158; }
.uh-ios-metric-rate { background:var(--dsw-alias-bg-layer-1); }
.uh-ios-metric-rate .uh-line-icon { color:#30d158; }
.uh-ios-metric-rate-head { display:flex; align-items:baseline; justify-content:space-between; gap:8px; min-width:0; }
.uh-ios-metric-rate-value { flex:none; color:#30d158; font-size:24px; line-height:1; font-weight:700; font-variant-numeric:tabular-nums; }
.uh-ios-metric-rate-detail { min-width:0; overflow:hidden; color:var(--dsw-alias-label-secondary); font-size:14px; line-height:1.2; font-weight:600; font-variant-numeric:tabular-nums; text-overflow:ellipsis; white-space:nowrap; }
.uh-ios-metric-bar { height:7px; border-radius:4px; background:var(--dsw-alias-bg-layer-2); overflow:hidden; }
.uh-ios-metric-fill { height:100%; border-radius:inherit; background:#30d158; transition:width .35s ease; }
.uh-token-semantics { display:flex; align-items:flex-start; gap:8px; padding:10px 12px; border-radius:12px; background:color-mix(in srgb, var(--dsw-alias-brand-primary) 8%, var(--dsw-alias-bg-layer-1)); color:var(--dsw-alias-label-secondary); font-size:12px; line-height:1.55; }
.uh-token-semantics .uh-line-icon { margin-top:1px; color:var(--dsw-alias-brand-primary); }
.uh-ios-list-panel { min-height:360px; }
.uh-donut-chart { margin:0 0 18px; }
.uh-donut-title { display:flex; align-items:center; gap:7px; margin-bottom:12px; color:var(--dsw-alias-label-primary); font-size:14px; font-weight:650; }
.uh-donut-layout { display:grid; grid-template-columns:minmax(220px,300px) minmax(0,1fr); gap:24px; align-items:center; }
.uh-donut-visual { position:relative; width:min(100%,280px); aspect-ratio:1; margin:0 auto; }
.uh-donut-svg { display:block; width:100%; height:100%; overflow:visible; }
.uh-donut-track { opacity:.78; }
.uh-donut-segment { fill:none; stroke-dasharray:1; stroke-dashoffset:1; animation:uh-donut-draw .95s cubic-bezier(.22,.61,.36,1) both; cursor:pointer; outline:none; transition:filter .15s ease, opacity .15s ease; }
.uh-donut-segment:hover, .uh-donut-segment:focus-visible, .uh-donut-segment.uh-active { filter:brightness(1.12); }
.uh-donut-tooltip { position:absolute; top:0; left:0; z-index:3; display:flex; align-items:flex-start; gap:8px; max-width:190px; padding:9px 10px; border:1px solid var(--dsw-alias-border-l2); border-radius:8px; background:color-mix(in srgb, var(--dsw-alias-bg-base) 94%, transparent); box-shadow:0 10px 24px rgba(0,0,0,.22); backdrop-filter:blur(10px); color:var(--dsw-alias-label-primary); pointer-events:none; font-size:12px; line-height:1.4; transition:left .12s cubic-bezier(.22,.61,.36,1), top .12s cubic-bezier(.22,.61,.36,1); }
.uh-donut-tooltip > div { min-width:0; display:flex; flex-direction:column; gap:4px; }
.uh-donut-tooltip strong { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12px; }
.uh-donut-tooltip span:not(.uh-donut-dot):not(.uh-model-icon) { color:var(--dsw-alias-label-secondary); font-size:11px; }
.uh-donut-tooltip-cost { color:var(--dsw-alias-label-primary) !important; font-variant-numeric:tabular-nums; }
.uh-donut-center { position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; pointer-events:none; }
.uh-donut-center strong { color:var(--dsw-alias-label-primary); font-size:28px; line-height:1; font-weight:750; font-variant-numeric:tabular-nums; }
.uh-donut-center span { margin-top:5px; color:var(--dsw-alias-label-secondary); font-size:13px; }
.uh-donut-legend { min-width:0; }
.uh-donut-legend-row { display:grid; grid-template-columns:36px minmax(180px,1fr) minmax(250px,.8fr) 54px; gap:10px; align-items:center; min-height:58px; padding:8px 0; border-bottom:1px solid color-mix(in srgb, var(--dsw-alias-border-l1) 78%, transparent); }
.uh-donut-legend-row:last-child { border-bottom:0; }
.uh-donut-dot { width:12px; height:12px; border-radius:50%; }
.uh-donut-legend-mark { display:flex; align-items:center; gap:8px; min-width:0; }
.uh-donut-legend-copy { min-width:0; display:flex; flex-direction:column; gap:5px; }
.uh-donut-legend-copy strong { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--dsw-alias-label-primary); font-size:13px; font-weight:650; }
.uh-donut-legend-metrics { display:grid; grid-template-columns:minmax(120px,1fr) minmax(92px,auto); align-items:center; gap:14px; min-width:0; }
.uh-donut-legend-metrics span { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--dsw-alias-label-secondary); font-size:12px; font-variant-numeric:tabular-nums; text-align:right; }
.uh-donut-legend-metrics .uh-donut-cost { color:var(--dsw-alias-label-secondary); font-size:12px; }
.uh-donut-percent { min-width:48px; color:var(--dsw-alias-label-secondary); font-size:12px; font-variant-numeric:tabular-nums; text-align:right; }
/* Each detail table owns its scrolling and sticky header; sections must not overlap in the page scroll. */
.uh-tbl-scroll { max-height:360px; overflow:auto; border-radius:12px; background:color-mix(in srgb, var(--dsw-alias-bg-layer-2) 55%, transparent); }
.uh-hrow, .uh-model-hrow { position:sticky; top:0; z-index:3; border-bottom:1px solid var(--dsw-alias-border-l1); box-shadow:0 1px 0 color-mix(in srgb, var(--dsw-alias-bg-base) 70%, transparent); }
.uh-row, .uh-model-row { min-height:48px; border-bottom:1px solid color-mix(in srgb, var(--dsw-alias-border-l1) 72%, transparent); }
.uh-row:last-child, .uh-model-row:last-child { border-bottom:0; }
@media (max-width:640px) { .uh-tbl-scroll { max-height:300px; border-radius:10px; } }
@media (max-width:640px) { .uh-hm-body { min-width:720px; } .uh-donut-legend-row { grid-template-columns:36px minmax(0,1fr) 48px; gap:8px; } .uh-donut-legend-copy { grid-column:2; grid-row:1; } .uh-donut-legend-metrics { grid-column:2 / -1; grid-row:2; grid-template-columns:minmax(0,1fr) minmax(0,auto); gap:8px; } .uh-donut-percent { grid-column:3; grid-row:1; } .uh-ios-summary-hero { grid-template-columns:1fr; min-height:0; gap:18px; padding:18px; } .uh-ios-summary-total { align-items:flex-start; } .uh-ios-summary-meta { grid-template-columns:repeat(2,minmax(0,1fr)); padding:16px 0 0; border-left:0; border-top:1px solid var(--dsw-alias-border-l1); } .uh-ios-summary-meta-stat { padding:0 12px; } .uh-ios-summary-meta-stat:first-child { padding-left:0; } .uh-ios-summary-meta-stat:last-child { padding-right:0; } .uh-ios-summary-value { font-size:31px; } .uh-ios-metrics { grid-template-columns:repeat(2,minmax(0,1fr)); } .uh-ios-metric:last-child { grid-column:1 / -1; } .uh-ios-metric-value { font-size:24px; } .uh-donut-layout { grid-template-columns:1fr; gap:12px; } .uh-donut-visual { width:min(100%,250px); } }
@keyframes uh-cell-in { from { opacity:0; transform:scale(.4); } to { opacity:1; transform:scale(1); } }
@keyframes uh-glow { 0% { box-shadow:0 0 0 0 rgba(46,160,67,.5); } 70% { box-shadow:0 0 0 5px rgba(46,160,67,0); } 100% { box-shadow:0 0 0 0 rgba(46,160,67,0); } }
@keyframes uh-card-in { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:translateY(0); } }
@keyframes uh-bar-grow { from { transform:scaleX(0); } to { transform:scaleX(1); } }
@keyframes uh-panel-in { from { opacity:0; transform:translateY(-6px); } to { opacity:1; transform:translateY(0); } }
@keyframes uh-trend-draw { from { stroke-dashoffset:var(--uh-draw-length); opacity:.2; } to { stroke-dashoffset:0; opacity:1; } }
@keyframes uh-trend-fill { from { opacity:0; } to { opacity:1; } }
@keyframes uh-donut-draw { from { stroke-dashoffset:1; opacity:.25; } to { stroke-dashoffset:0; opacity:1; } }
@keyframes uh-spinner-turn { to { transform:rotate(360deg); } }
@keyframes uh-menu-in { from { opacity:0; transform:translateY(-4px) scale(.97); } to { opacity:1; transform:translateY(0) scale(1); } }
@keyframes uh-tip-in { from { opacity:0; } to { opacity:1; } }
@media (prefers-reduced-motion: reduce) {
  .uh-cell, .uh-card, .uh-ios-metric, .uh-barfill, .uh-anim-panel, .uh-trend-panel, .uh-trend-line-draw, .uh-trend-area, .uh-trend-point, .uh-trend-spinner, .uh-donut-segment, .uh-records-panel, .uh-record-detail, .uh-tip, .uh-language-options { animation:none !important; stroke-dashoffset:0 !important; opacity:1 !important; }
  .uh-card, .uh-cell, .uh-ios-metric-fill, .uh-barfill, .uh-fill, .uh-refresh, .uh-chip, .uh-row, .uh-tip-row, .uh-trend-tooltip, .uh-language-trigger, .uh-language-caret, .uh-language-option { transition:none !important; }
}
`
    const cssTagId = "dsh-all-usage/styles.css"
    if (typeof document !== "undefined") {
      let tag = document.querySelector("style[data-plugin-css=" + JSON.stringify(cssTagId) + "]")
      if (tag === null) {
        tag = document.createElement("style")
        tag.dataset.plugin = "dsh-all-usage"
        tag.dataset.pluginCss = cssTagId
        document.head.appendChild(tag)
      }
      tag.textContent = CSS
    }

    // 与 Host 半的数据接口（webServer 路由）
    const getStats = () => fetch('/api/all-usage', { headers: { accept: 'application/json' } }).then((r) => {
      if (!r.ok) throw new Error('HTTP ' + r.status)
      return r.json()
    })
    const getStatus = () => fetch('/api/all-usage/status', { headers: { accept: 'application/json' } }).then((r) => {
      if (!r.ok) throw new Error('HTTP ' + r.status)
      return r.json()
    })
    const getUsageQuery = (scope) => {
      const params = new URLSearchParams({ start: scope.start, end: scope.end, utc: scope.utc ? '1' : '0' })
      if (scope.workspaceId) params.set('workspaceId', scope.workspaceId)
      if (scope.provider) params.set('provider', scope.provider)
      if (scope.modelKey) params.set('modelKey', scope.modelKey)
      return fetch('/api/all-usage/query?' + params.toString(), { headers: { accept: 'application/json' } }).then((r) => {
        if (!r.ok) throw new Error('HTTP ' + r.status)
        return r.json()
      })
    }
    const getUsageRecords = (scope, cursor, limit) => {
      const params = new URLSearchParams({ start: scope.start, end: scope.end, utc: scope.utc ? '1' : '0', limit: String(limit || 100) })
      if (scope.workspaceId) params.set('workspaceId', scope.workspaceId)
      if (scope.provider) params.set('provider', scope.provider)
      if (scope.modelKey) params.set('modelKey', scope.modelKey)
      if (cursor) params.set('cursor', cursor)
      return fetch('/api/all-usage/records?' + params.toString(), { headers: { accept: 'application/json' } }).then((r) => {
        if (!r.ok) { const error = new Error('HTTP ' + r.status); error.status = r.status; throw error }
        return r.json()
      })
    }
    const getBalance = (force, requestToken) => fetch('/api/all-usage/balance' + (force ? '?force=1' : ''), { headers: { accept: 'application/json', 'x-all-usage-request-token': requestToken } }).then((r) => {
      if (!r.ok) throw new Error('HTTP ' + r.status)
      return r.json()
    })
    const setAliasRpc = (workspaceId, alias, writeToken) => fetch('/api/all-usage/alias', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-all-usage-request-token': writeToken },
      body: JSON.stringify({ workspaceId, alias }),
    }).then((r) => {
      if (!r.ok) throw new Error('HTTP ' + r.status)
      return r.json()
    })
    const getPricing = () => fetch('/api/all-usage/pricing', { headers: { accept: 'application/json' } }).then((r) => {
      if (!r.ok) throw new Error('HTTP ' + r.status)
      return r.json()
    })
    const getPricingModels = (query) => {
      const params = new URLSearchParams({ q: String(query || '').slice(0, 120), limit: '30' })
      return fetch('/api/all-usage/pricing/models?' + params.toString(), { headers: { accept: 'application/json' } }).then((r) => {
        if (!r.ok) throw new Error('HTTP ' + r.status)
        return r.json()
      })
    }
    const setPricingRpc = (pricing, backfill, writeToken) => fetch('/api/all-usage/pricing', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-all-usage-request-token': writeToken },
      body: JSON.stringify({ pricing, backfill: backfill === true }),
    }).then((r) => {
      if (!r.ok) { const error = new Error('HTTP ' + r.status); error.status = r.status; throw error }
      return r.json()
    })
    const syncPricingRpc = (writeToken) => fetch('/api/all-usage/pricing/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-all-usage-request-token': writeToken },
      body: '{}',
    }).then((r) => {
      if (!r.ok) { const error = new Error('HTTP ' + r.status); error.status = r.status; throw error }
      return r.json()
    })

    const LANGUAGE_STORAGE_KEY = 'dsh-all-usage.language'
    function storedLanguage() {
      try { return window.localStorage.getItem(LANGUAGE_STORAGE_KEY) === 'en' ? 'en' : 'zh' } catch (_) { return 'zh' }
    }
    function persistLanguage(language) {
      try { window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language) } catch (_) {}
    }
    const USAGE_UI_STATE_KEY = 'dsh-all-usage.ui-state'
    function storedUsageUiState() {
      try {
        const raw = window.localStorage.getItem(USAGE_UI_STATE_KEY)
        const value = raw ? JSON.parse(raw) : {}
        if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
        const state = {}
        if (['logs', 'model', 'workspace'].includes(value.detailView)) state.detailView = value.detailView
        if (['route', 'model', 'provider'].includes(value.modelView)) state.modelView = value.modelView
        if (['today', '30d', '90d', 'all'].includes(value.range)) state.range = value.range
        if (typeof value.pricingAutoSync === 'boolean') state.pricingAutoSync = value.pricingAutoSync
        return state
      } catch (_) { return {} }
    }
    function persistUsageUiState(patch) {
      try {
        const current = storedUsageUiState()
        window.localStorage.setItem(USAGE_UI_STATE_KEY, JSON.stringify(Object.assign({}, current, patch)))
      } catch (_) {}
    }

    function UsagePage(props) {
      const timer = props.timerCtx
      const language = props.language === 'en' ? 'en' : 'zh'
      const tr = (zh, en) => language === 'en' ? en : zh
      const useUtc = language === 'en'
      const usageUiStateRef = React.useRef(null)
      if (usageUiStateRef.current === null) usageUiStateRef.current = storedUsageUiState()
      const usageUiState = usageUiStateRef.current
      const calendarNow = new Date()
      const latestCalendarDate = fmtDate(calendarNow, useUtc)
      const [stats, setStats] = React.useState(null)
      const [status, setStatus] = React.useState(null)
      const [statsError, setStatsError] = React.useState('')
      const [lastStatsAt, setLastStatsAt] = React.useState(0)
      const [balance, setBalance] = React.useState(null)
      const [range, setRange] = React.useState(() => usageUiState.range || 'today')
      const [customRange, setCustomRange] = React.useState({ start: '', end: '' })
      const [customDraft, setCustomDraft] = React.useState({ start: '', end: '' })
      const [customRangeOpen, setCustomRangeOpen] = React.useState(false)
      const [modelView, setModelView] = React.useState(() => usageUiState.modelView || 'route')
      const [wsFilter, setWsFilter] = React.useState(null)
      const [providerFilter, setProviderFilter] = React.useState(null)
      const [modelFilter, setModelFilter] = React.useState(null)
      const [queryResult, setQueryResult] = React.useState(null)
      const [queryResultKey, setQueryResultKey] = React.useState('')
      const [queryLoading, setQueryLoading] = React.useState(false)
      const [queryError, setQueryError] = React.useState('')
      const [trendVisible, setTrendVisible] = React.useState(['total', 'input', 'cacheRead', 'output'])
      const [detailView, setDetailView] = React.useState(() => usageUiState.detailView || 'logs')
      const [detailSelection, setDetailSelection] = React.useState(null)
      const [auditSelectedId, setAuditSelectedId] = React.useState(null)
      const [auditRows, setAuditRows] = React.useState([])
      const [auditCursor, setAuditCursor] = React.useState(null)
      const [auditHasMore, setAuditHasMore] = React.useState(false)
      const [auditReload, setAuditReload] = React.useState(0)
      const [auditLoading, setAuditLoading] = React.useState(false)
      const [auditExporting, setAuditExporting] = React.useState(false)
      const [auditError, setAuditError] = React.useState('')
      const [aliasOpen, setAliasOpen] = React.useState(false)
      const [aliasDrafts, setAliasDrafts] = React.useState({})
      const [pricingOpen, setPricingOpen] = React.useState(false)
      const [pricingDetails, setPricingDetails] = React.useState(null)
      const [pricingDraft, setPricingDraft] = React.useState(null)
      const [pricingLoading, setPricingLoading] = React.useState(false)
      const [pricingSaving, setPricingSaving] = React.useState(false)
      const [pricingSyncing, setPricingSyncing] = React.useState(false)
      const [pricingSyncSaving, setPricingSyncSaving] = React.useState(false)
      const [pricingError, setPricingError] = React.useState('')
      const [pricingModelSearchOptions, setPricingModelSearchOptions] = React.useState({})
      const [pricingModelSearchOpen, setPricingModelSearchOpen] = React.useState(null)
      const [pricingUsedModelSearchText, setPricingUsedModelSearchText] = React.useState({})
      const [pricingUsedModelOpen, setPricingUsedModelOpen] = React.useState(null)
      const [pricingOverrideSearchText, setPricingOverrideSearchText] = React.useState({})
      const [pricingOverrideOpen, setPricingOverrideOpen] = React.useState(null)
      const pricingModelSearchSeqRef = React.useRef({})
      const pricingSearchEpochRef = React.useRef(0)
      const pricingModelSearchTimerRef = React.useRef({})
      const pricingOpenRef = React.useRef(false)
      const refreshPricingPanelRef = React.useRef(() => {})
      const invalidatePricingSearches = () => {
        // Any catalog replacement (sync, refresh, close/reopen) invalidates all
        // in-flight official-model searches: bump the row generation and cancel
        // pending timers so stale responses cannot reach current rows.
        pricingSearchEpochRef.current += 1
        const timers = pricingModelSearchTimerRef.current
        for (const key of Object.keys(timers)) clearTimeout(timers[key])
        pricingModelSearchTimerRef.current = {}
        pricingModelSearchSeqRef.current = {}
        setPricingModelSearchOptions({})
      }
      const [languageMenuOpen, setLanguageMenuOpen] = React.useState(false)
      const languageMenuRef = React.useRef(null)
      const recordsPanelRef = React.useRef(null)
      const statsGateRef = React.useRef(null)
      if (statsGateRef.current === null) statsGateRef.current = createRequestGate()
      const statusGateRef = React.useRef(null)
      if (statusGateRef.current === null) statusGateRef.current = createRequestGate()
      const balanceGateRef = React.useRef(null)
      if (balanceGateRef.current === null) balanceGateRef.current = createRequestGate()
      const queryGateRef = React.useRef(null)
      if (queryGateRef.current === null) queryGateRef.current = createRequestGate()
      const recordsGateRef = React.useRef(null)
      if (recordsGateRef.current === null) recordsGateRef.current = createRequestGate()
      const pricingGateRef = React.useRef(null)
      if (pricingGateRef.current === null) pricingGateRef.current = createRequestGate()
      const statsGate = statsGateRef.current
      const statusGate = statusGateRef.current
      const balanceGate = balanceGateRef.current
      const queryGate = queryGateRef.current
      const recordsGate = recordsGateRef.current
      const pricingGate = pricingGateRef.current
      const refreshRef = React.useRef(() => {})
      // All hooks must run before the stats-null early return below; keep this
      // callback (and the ref sync effect) in the hook region of the component.
      const refreshOpenPricing = React.useCallback(() => {
        if (!pricingOpenRef.current || pricingSaving || pricingSyncing || pricingSyncSaving) return
        const seq = pricingGate.next()
        setPricingLoading(true)
        getPricing().then((pricing) => {
          if (!pricingGate.isCurrent(seq)) return
          if (!pricing || typeof pricing !== 'object' || !pricing.config) { setPricingError('load'); setPricingLoading(false); return }
          // A refreshed catalog invalidates searches issued against the old one.
          invalidatePricingSearches()
          setPricingDetails(pricing)
          setPricingDraft((prev) => pricingDraftAfterSync(prev, pricing))
          setPricingError('')
          setPricingLoading(false)
        }, () => {
          if (pricingGate.isCurrent(seq)) { setPricingError('load'); setPricingLoading(false) }
        })
      }, [pricingSaving, pricingSyncing, pricingSyncSaving])
      React.useEffect(() => { refreshPricingPanelRef.current = refreshOpenPricing })
      const setLanguage = (next) => { if (typeof props.onLanguageChange === 'function') props.onLanguageChange(next === 'en' ? 'en' : 'zh') }
      const chooseLanguage = (next) => { setLanguage(next); setLanguageMenuOpen(false) }
      React.useEffect(() => { persistUsageUiState({ detailView }) }, [detailView])
      React.useEffect(() => { persistUsageUiState({ modelView }) }, [modelView])
      React.useEffect(() => { if (range !== 'custom') persistUsageUiState({ range }) }, [range])

      const queryScope = React.useMemo(() => stats === null ? null : makeUsageScope(stats, range, useUtc, customRange, wsFilter, providerFilter, modelFilter), [stats, range, useUtc, customRange.start, customRange.end, wsFilter, providerFilter, modelFilter])
      const queryKey = usageScopeKey(queryScope)
      const liveRevisionSource = status !== null && typeof status === 'object' ? status : stats
      const liveQueryVersion = queryVersion(liveRevisionSource)
      const selectedDetailScope = detailSelection !== null && detailSelection.baseKey === queryKey ? detailSelection.scope : queryScope
      const detailKey = usageScopeKey(selectedDetailScope)
      const previousQueryKeyRef = React.useRef(queryKey)
      React.useEffect(() => {
        if (previousQueryKeyRef.current !== queryKey) {
          previousQueryKeyRef.current = queryKey
          setDetailSelection(null)
          setAuditSelectedId(null)
        }
      }, [queryKey])

      React.useEffect(() => {
        let alive = true
        let scanDone = false
        let requestToken = ''
        let appliedSnapshot = null
        let fullFailures = 0
        let statusFailures = 0
        let retryTimer = null
        const clearRetry = () => {
          if (retryTimer !== null) {
            clearTimeout(retryTimer)
            retryTimer = null
          }
        }
        const refreshBalance = (force) => {
          if (requestToken === '') return
          const seq = balanceGate.next()
          getBalance(force === true, requestToken).then((data) => {
            if (!alive || !balanceGate.isCurrent(seq)) return
            if (data) setBalance(data)
          }, () => {})
        }
        const scheduleRetry = (kind) => {
          if (!alive || retryTimer !== null) return
          const failures = kind === 'full' ? (fullFailures += 1) : (statusFailures += 1)
          retryTimer = setTimeout(() => {
            retryTimer = null
            if (!alive) return
            if (kind === 'full') refreshStats()
            else refreshStatus()
          }, retryDelayFor(failures))
        }
        const refreshStats = () => {
          statusGate.next()
          const seq = statsGate.next()
          getStats().then((data) => {
            if (!alive || !statsGate.isCurrent(seq)) return
            if (data === null || typeof data !== 'object') {
              setStatsError('full')
              scheduleRetry('full')
              return
            }
            appliedSnapshot = data
            if (data.scan) scanDone = !!data.scan.done
            const nextToken = typeof data.requestToken === 'string' ? data.requestToken : ''
            const tokenChanged = nextToken !== '' && nextToken !== requestToken
            requestToken = nextToken
            fullFailures = 0
            clearRetry()
            setStatsError('')
            setLastStatsAt(Date.now())
            setStatus(data)
            setStats(data)
            if (tokenChanged) refreshBalance(false)
          }, () => {
            if (!alive || !statsGate.isCurrent(seq)) return
            setStatsError('full')
            scheduleRetry('full')
          })
        }
        const refreshStatus = () => {
          if (appliedSnapshot === null) { refreshStats(); return }
          const seq = statusGate.next()
          getStatus().then((data) => {
            if (!alive || !statusGate.isCurrent(seq)) return
            if (data === null || typeof data !== 'object') {
              setStatsError('status')
              scheduleRetry('status')
              return
            }
            statusFailures = 0
            const refreshKind = statusRefreshKind(data, appliedSnapshot)
            if (data.scan) scanDone = !!data.scan.done
            // Full data owns metadata transitions; data and pricing transitions
            // are consumed by the scoped query effect below.
            if (refreshKind === 'full') {
              // A pricing revision change means the open settings panel is
              // showing a stale catalog; re-fetch it and keep local edits.
              const pricingTouched = typeof data.pricingRevision === 'number' && typeof appliedSnapshot.pricingRevision === 'number' && data.pricingRevision !== appliedSnapshot.pricingRevision
              if (pricingTouched) refreshPricingPanelRef.current()
              refreshStats()
              return
            }
            // Advance the freshness baseline without replacing the full payload.
            appliedSnapshot = Object.assign({}, appliedSnapshot, data)
            setStatus(data)
            clearRetry()
            setStatsError('')
          }, () => {
            if (!alive || !statusGate.isCurrent(seq)) return
            setStatsError('status')
            scheduleRetry('status')
          })
        }
        refreshStats()
        const fast = timer.interval(() => { if (!scanDone && retryTimer === null) refreshStatus() }, 2000)
        const slow = timer.interval(() => { if (scanDone && retryTimer === null) refreshStatus() }, 15000)
        const bal = timer.interval(() => { refreshBalance(false) }, 60000)
        refreshRef.current = () => {
          clearRetry()
          fullFailures = 0
          statusFailures = 0
          refreshStats()
          refreshBalance(true)
        }
        return () => {
          alive = false
          clearRetry()
          fast(); slow(); bal()
          for (const timerId of Object.values(pricingModelSearchTimerRef.current)) clearTimeout(timerId)
          pricingModelSearchTimerRef.current = {}
        }
      }, [])

      React.useEffect(() => {
        if (!languageMenuOpen || typeof document === 'undefined') return undefined
        const closeLanguageMenu = (event) => {
          if (languageMenuRef.current && !languageMenuRef.current.contains(event.target)) setLanguageMenuOpen(false)
        }
        document.addEventListener('pointerdown', closeLanguageMenu)
        return () => document.removeEventListener('pointerdown', closeLanguageMenu)
      }, [languageMenuOpen])

      React.useEffect(() => {
        if (queryScope === null || queryKey === '') return undefined
        const seq = queryGate.next()
        const expectedQueryVersion = liveQueryVersion
        setQueryLoading(true)
        setQueryError('')
        getUsageQuery(queryScope).then((data) => {
          if (!queryGate.isCurrent(seq)) return
          if (data === null || typeof data !== 'object' || expectedQueryVersion === null || queryVersion(data) !== expectedQueryVersion) {
            setQueryError('stale')
            setQueryLoading(false)
            return
          }
          setQueryResult(data)
          setQueryResultKey(queryKey)
          setQueryLoading(false)
          setQueryError('')
        }, () => {
          if (!queryGate.isCurrent(seq)) return
          setQueryLoading(false)
          setQueryError('query')
        })
        return undefined
      }, [queryKey, liveQueryVersion])

      const openAuditForScope = React.useCallback((scope) => {
        if (scope === null || queryKey === '') return
        setDetailSelection({ baseKey: queryKey, scope: { ...scope } })
        setDetailView('logs')
        setAuditSelectedId(null)
        setAuditError('')
      }, [queryKey])
      const openAuditForDate = React.useCallback((date) => {
        if (queryScope === null || typeof date !== 'string') return
        openAuditForScope({ ...queryScope, start: date, end: date })
      }, [queryScope, openAuditForScope])
      const recordsVisible = detailView === 'logs' && selectedDetailScope !== null && detailKey !== ''
      React.useEffect(() => {
        if (!recordsVisible) {
          recordsGate.next()
          setAuditLoading(false)
          return undefined
        }
        const seq = recordsGate.next()
        const expectedQueryVersion = liveQueryVersion
        setAuditLoading(true)
        setAuditError('')
        // Keep the previous page visible until the replacement arrives.
        setAuditCursor(null)
        setAuditHasMore(false)
        getUsageRecords(selectedDetailScope, null, 20).then((data) => {
          if (!recordsGate.isCurrent(seq)) return
          if (data === null || typeof data !== 'object' || !Array.isArray(data.items)) {
            setAuditError('audit')
            setAuditLoading(false)
            return
          }
          if (expectedQueryVersion === null || queryVersion(data) !== expectedQueryVersion) {
            setAuditError('stale')
            setAuditLoading(false)
            return
          }
          setAuditRows(data.items)
          setAuditSelectedId((previous) => data.items.some((row) => row && row.id === previous) ? previous : (data.items[0] ? data.items[0].id : null))
          setAuditCursor(data.nextCursor || null)
          setAuditHasMore(data.hasMore === true)
          setAuditLoading(false)
          setAuditError('')
        }, (reason) => {
          if (!recordsGate.isCurrent(seq)) return
          if (reason && reason.status === 409) {
            setAuditLoading(false)
            setAuditError('stale')
            setAuditReload((value) => value + 1)
            return
          }
          setAuditLoading(false)
          setAuditError('audit')
        })
        return () => { recordsGate.next() }
      }, [detailKey, detailView, liveQueryVersion, auditReload])
      const loadMoreAudit = () => {
        if (detailView !== 'logs' || selectedDetailScope === null || auditCursor === null || auditLoading) return
        const seq = recordsGate.next()
        const expectedQueryVersion = liveQueryVersion
        setAuditLoading(true)
        getUsageRecords(selectedDetailScope, auditCursor, 20).then((data) => {
          if (!recordsGate.isCurrent(seq)) return
          if (data === null || typeof data !== 'object' || !Array.isArray(data.items) || expectedQueryVersion === null || queryVersion(data) !== expectedQueryVersion) {
            setAuditError('stale')
            setAuditLoading(false)
            setAuditReload((value) => value + 1)
            return
          }
          setAuditRows((prev) => prev.concat(data.items))
          setAuditCursor(data.nextCursor || null)
          setAuditHasMore(data.hasMore === true)
          setAuditLoading(false)
          setAuditError('')
        }, (reason) => {
          if (!recordsGate.isCurrent(seq)) return
          if (reason && reason.status === 409) {
            setAuditLoading(false)
            setAuditCursor(null)
            setAuditHasMore(false)
            setAuditError('stale')
            setAuditReload((value) => value + 1)
            return
          }
          setAuditLoading(false)
          setAuditError('audit')
        })
      }
      React.useEffect(() => {
        if (detailSelection === null || detailView !== 'logs' || recordsPanelRef.current === null) return undefined
        recordsPanelRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' })
        return undefined
      }, [detailSelection && usageScopeKey(detailSelection.scope), detailView])
      const onRefresh = React.useCallback(() => { refreshRef.current() }, [])
      const toggleFilter = React.useCallback((id) => {
        setWsFilter((prev) => (prev === id ? null : id))
      }, [])
      const clearFilters = React.useCallback(() => {
        setWsFilter(null)
        setProviderFilter(null)
        setModelFilter(null)
      }, [])
      const chooseProvider = React.useCallback((value) => {
        setProviderFilter(value || null)
      }, [])
      const chooseModel = React.useCallback((value) => {
        setModelFilter(value || null)
      }, [])
      const activeDayRows = useUtc && Array.isArray(stats && stats.byDayUtc) ? stats.byDayUtc : (Array.isArray(stats && stats.byDay) ? stats.byDay : [])
      const availableDateRange = availableDateBounds(activeDayRows, latestCalendarDate)
      const earliestAvailableDate = availableDateRange.min
      const activeCustomRange = normalizeCustomRange(customRange, useUtc)
      const customDraftIssue = customRangeIssue(customDraft, earliestAvailableDate, latestCalendarDate, useUtc)
      const openCustomRange = () => {
        const current = normalizeCustomRange(customRange, useUtc)
        const defaultStart = fmtDate(shiftCalendarDate(calendarNow, -89, useUtc), useUtc)
        setCustomDraft(current || { start: defaultStart < earliestAvailableDate ? earliestAvailableDate : defaultStart, end: latestCalendarDate })
        setCustomRangeOpen(true)
      }
      const applyCustomRange = () => {
        if (customDraftIssue !== '') return
        const next = normalizeCustomRange(customDraft, useUtc)
        if (next === null) return
        setCustomRange(next)
        setRange('custom')
        setCustomRangeOpen(false)
      }
      const chooseRange = (next) => {
        setRange(next)
        setCustomRangeOpen(false)
      }

      const queryHasResult = queryResult !== null && queryResultKey === queryKey
      const queryReady = queryHasResult && liveQueryVersion !== null && queryVersion(queryResult) === liveQueryVersion
      // Keep the last successful query visible while a newer revision loads.
      const queryUsable = queryHasResult && (queryReady || queryError === '')
      const displayedDays = queryUsable && Array.isArray(queryResult.daily) ? queryResult.daily : activeDayRows
      const displayedHeatmap = queryUsable && Array.isArray(queryResult.heatmap) ? queryResult.heatmap : activeDayRows
      const activeCustomRangeKey = activeCustomRange === null ? '' : activeCustomRange.start + ':' + activeCustomRange.end
      const rangeOnlyAgg = React.useMemo(() => rangeAgg(stats, range, useUtc, activeCustomRange), [stats, range, useUtc, activeCustomRangeKey])
      const agg = React.useMemo(() => queryUsable
        ? { totals: queryResult.totals, perWs: queryResult.perWorkspace || [], perModel: queryResult.perModel || [] }
        : rangeOnlyAgg, [queryUsable, queryResult, rangeOnlyAgg])
      const animatedTotal = useCountUp(agg.totals.input + agg.totals.output + agg.totals.cacheRead + agg.totals.cacheWrite + agg.totals.reasoning, timer)
      const animatedRate = useCountUp(Math.round(rateOf(agg.totals.input, agg.totals.cacheRead) * 10), timer)
      const scopedCountIsCalls = providerFilter !== null || modelFilter !== null
      const requestCount = Number.isFinite(agg.totals.calls) && agg.totals.calls > 0 ? agg.totals.calls : agg.totals.turns
      const displayedCount = scopedCountIsCalls ? requestCount : agg.totals.turns
      const animatedTurns = useCountUp(displayedCount, timer)
      const animatedRequests = useCountUp(requestCount, timer)
      const wsTotal = (w) => w.input + w.output + w.cacheRead + w.cacheWrite + w.reasoning
      const rows = React.useMemo(() => (Array.isArray(agg.perWs) ? agg.perWs : []).slice().sort((a, b) => wsTotal(b) - wsTotal(a)), [agg.perWs])
      const modelRows = React.useMemo(() => aggregateModelRows(agg.perModel || [], modelView, tr('未知供应商', 'Unknown provider'), tr('未知模型', 'Unknown model')).sort((a, b) => wsTotal(b) - wsTotal(a)), [agg.perModel, modelView, language])
      const workspaces = stats && Array.isArray(stats.workspaces) ? stats.workspaces : []
      const aliases = stats && stats.aliases && typeof stats.aliases === 'object' ? stats.aliases : {}
      const filterOptions = React.useMemo(() => {
        const rangeModelOptions = Array.isArray(rangeOnlyAgg.perModel) ? rangeOnlyAgg.perModel.filter((row) => row && typeof row === 'object') : []
        const providerOptions = Array.from(new Set(rangeModelOptions.map((row) => typeof row.provider === 'string' && row.provider !== '' ? row.provider : null).filter((value) => value !== null))).sort()
        const modelFilterValue = (row) => {
          const structured = typeof row.actualModel === 'string' && row.actualModel !== '' ? row.actualModel : typeof row.requestedModel === 'string' && row.requestedModel !== '' ? row.requestedModel : null
          if (structured !== null) return structured
          const display = typeof row.model === 'string' && row.model !== '' ? row.model : (language === 'en' ? 'Unknown model' : '未知模型')
          const separator = display.indexOf(' / ')
          const legacyProvider = separator > 0 ? display.slice(0, separator) : ''
          return separator > 0 && providerOptions.includes(legacyProvider) ? display.slice(separator + 3) : display
        }
        const modelOptions = Array.from(new Set(rangeModelOptions.map(modelFilterValue))).sort((left, right) => left.localeCompare(right))
        const rangeWorkspaceTotals = new Map((Array.isArray(rangeOnlyAgg.perWs) ? rangeOnlyAgg.perWs : []).map((row) => [row.workspaceId, row]))
        const workspaceHasUsage = (row) => row !== undefined && (Number(row.turns) > 0 || Number(row.calls) > 0 || Number(row.input) > 0 || Number(row.output) > 0 || Number(row.cacheRead) > 0 || Number(row.cacheWrite) > 0 || Number(row.reasoning) > 0)
        const rangeWorkspaceOptions = workspaces.filter((workspace) => workspaceHasUsage(rangeWorkspaceTotals.get(workspace.id)))
        return { providerOptions, modelOptions, rangeWorkspaceOptions, rangeWorkspaceIds: new Set(rangeWorkspaceOptions.map((workspace) => workspace.id)) }
      }, [rangeOnlyAgg.perModel, rangeOnlyAgg.perWs, workspaces, language])
      const { providerOptions, modelOptions, rangeWorkspaceOptions, rangeWorkspaceIds } = filterOptions
      const workspaceLookup = React.useMemo(() => {
        const byId = new Map()
        const indexes = new Map()
        workspaces.forEach((workspace, index) => { byId.set(workspace.id, workspace); indexes.set(workspace.id, index) })
        return { byId, indexes }
      }, [workspaces])
      const wsById = workspaceLookup.byId
      const wsIndex = workspaceLookup.indexes
      const wsTitle = React.useCallback((id) => {
        const alias = aliases[id]
        if (typeof alias === 'string' && alias !== '') return alias
        const meta = wsById.get(id)
        return meta ? meta.title : (language === 'en' ? 'Unknown workspace' : '未知工作区')
      }, [aliases, wsById, language])
      const fullHistoryDayMap = React.useMemo(() => {
        const result = new Map()
        for (const day of activeDayRows) result.set(day.date, day)
        return result
      }, [activeDayRows])
      const st = React.useMemo(() => streaks(fullHistoryDayMap, useUtc), [fullHistoryDayMap, useUtc, latestCalendarDate])
      const pricingSummary = stats && stats.pricing && typeof stats.pricing === 'object' ? stats.pricing : {}
      const currentPricing = pricingDetails && typeof pricingDetails === 'object' ? pricingDetails : pricingSummary
      const pricingUsedModels = React.useMemo(() => pricingOpen ? pricingUsedModelsOf(currentPricing) : [], [pricingOpen, currentPricing])
      const pricingUsedModelOptions = React.useMemo(() => pricingUsedModels.slice().sort((left, right) => {
        const rank = { unpriced: 0, ambiguous: 1, unsupported: 2, priced: 3 }
        return (rank[left.status] === undefined ? 9 : rank[left.status]) - (rank[right.status] === undefined ? 9 : rank[right.status]) || String(left.model || '').localeCompare(String(right.model || ''))
      }).map((model) => ({
        value: String(model.identityKey || model.model || ''),
        label: (model.model || (language === 'en' ? 'Unknown model' : '未知模型')) + ' · ' + pricingStatusLabel(model.status, language),
        model: pricingModelKey(model.actualModel || model.requestedModel || model.pricingModel),
        officialModel: pricingModelKey(model.pricingModel),
      })).filter((option) => option.value !== ''), [pricingUsedModels, language])
      const trendRows = React.useMemo(() => {
        const bounds = queryScope !== null ? { start: queryScope.start, end: queryScope.end } : resolveRangeBounds(stats, range, useUtc, activeCustomRange)
        const hourlyRows = queryUsable && queryScope !== null && queryScope.start === queryScope.end && queryResult && Array.isArray(queryResult.hourly) ? buildTrendHourlyRows(queryResult.hourly, useUtc) : []
        return hourlyRows.length > 0 ? hourlyRows : buildTrendRows(queryUsable && queryResult && Array.isArray(queryResult.daily) ? queryResult.daily : activeDayRows, bounds, useUtc)
      }, [queryScope, queryUsable, queryResult, activeDayRows, stats, range, useUtc, activeCustomRangeKey])
      const trendAnimationKey = queryUsable && queryResult ? queryKey + ':' + (queryVersion(queryResult) || 'query') : queryKey
      const pricingRenderRevision = React.useMemo(() => ({}), [pricingOpen, pricingDraft, pricingLoading, pricingSaving, pricingSyncing, pricingSyncSaving, pricingError, currentPricing, pricingSummary, pricingUsedModels, pricingUsedModelOptions, pricingUsedModelOpen, pricingOverrideOpen, pricingUsedModelSearchText, pricingOverrideSearchText, pricingModelSearchOpen, pricingModelSearchOptions, stats, language])
      const modelDonutItems = React.useMemo(() => modelRows.map((row, index) => ({ label: row.model, value: wsTotal(row), cost: row.cost, color: DONUT_COLORS[index % DONUT_COLORS.length], iconKey: modelView === 'route' ? (() => { const icon = resolveModelIcon(row); return icon === null ? null : icon.key })() : (row.iconKey === undefined ? null : row.iconKey) })), [modelRows, modelView])
      const workspaceDonutItems = React.useMemo(() => rows.map((row, index) => ({ label: wsTitle(row.workspaceId), value: wsTotal(row), cost: row.cost, color: DONUT_COLORS[index % DONUT_COLORS.length] })), [rows, wsTitle])
      const toggleTrendSeries = React.useCallback((key) => {
        setTrendVisible((prev) => {
          if (prev.includes(key)) return prev.length <= 1 ? prev : prev.filter((item) => item !== key)
          return prev.concat(key)
        })
      }, [])
      React.useEffect(() => {
        if (wsFilter !== null && !rangeWorkspaceIds.has(wsFilter)) setWsFilter(null)
        if (providerFilter !== null && !providerOptions.includes(providerFilter)) setProviderFilter(null)
        if (modelFilter !== null && !modelOptions.includes(modelFilter)) setModelFilter(null)
      }, [wsFilter, providerFilter, modelFilter, rangeWorkspaceIds, providerOptions, modelOptions])

      if (stats === null) {
        const failed = statsError !== ''
        return React.createElement('div', { className: 'uh-page' },
          React.createElement('div', { className: 'uh-panel' },
            React.createElement('div', { className: 'uh-empty' }, failed
              ? tr('无法加载用量统计。请重试。', 'Unable to load usage statistics. Please retry.')
              : tr('正在加载用量统计…', 'Loading usage statistics…'),
            ),
            failed ? React.createElement('div', { style: { textAlign: 'center' } },
              React.createElement('button', { className: 'uh-refresh', onClick: onRefresh }, React.createElement(LineIcon, { name: 'refresh', size: 14 }), tr('重试', 'Retry')),
            ) : null,
          ),
        )
      }

      const statusPayload = status !== null && typeof status === 'object' ? status : stats
      const scan = statusPayload && statusPayload.scan ? statusPayload.scan : (stats.scan || { done: true, started: true, scanned: 0, total: 0, failed: 0 })
      const sync = statusPayload && statusPayload.sync ? statusPayload.sync : (stats.sync || {})
      const dayRows = displayedDays

      const saveAlias = (wsId, value) => {
        const requestToken = typeof stats.requestToken === 'string' ? stats.requestToken : ''
        if (requestToken === '') return
        setAliasRpc(wsId, String(value === undefined ? '' : value).trim(), requestToken).then((res) => {
          if (res && res.ok && res.aliases) {
            setStats((prev) => (prev === null ? prev : Object.assign({}, prev, { aliases: res.aliases })))
          }
        }, () => {})
      }
      const openAliasPanel = () => {
        const drafts = {}
        workspaces.forEach((w) => { drafts[w.id] = typeof aliases[w.id] === 'string' ? aliases[w.id] : '' })
        setAliasDrafts(drafts)
        setAliasOpen(true)
      }
      const saveAllAliases = () => {
        for (const id of Object.keys(aliasDrafts)) {
          const current = typeof aliases[id] === 'string' ? aliases[id] : ''
          if (aliasDrafts[id] !== current) saveAlias(id, aliasDrafts[id])
        }
        setAliasOpen(false)
      }
      const closePricingPanel = () => {
        if (pricingSaving || pricingSyncing || pricingSyncSaving) return
        // In-flight official-model searches must not reach a reopened panel.
        invalidatePricingSearches()
        pricingGate.next()
        setPricingLoading(false)
        setPricingOpen(false)
        pricingOpenRef.current = false
      }
      const openPricingPanel = () => {
        const seq = pricingGate.next()
        setPricingDetails(null)
        setPricingDraft(null)
        setPricingLoading(true)
        setPricingUsedModelSearchText({})
        setPricingOverrideSearchText({})
        setPricingUsedModelOpen(null)
        setPricingOverrideOpen(null)
        setPricingModelSearchOpen(null)
        invalidatePricingSearches()
        setPricingError('')
        setPricingOpen(true)
        pricingOpenRef.current = true
        setAliasOpen(false)
        getPricing().then((pricing) => {
          if (!pricingGate.isCurrent(seq)) return
          if (!pricing || typeof pricing !== 'object' || !pricing.config) { setPricingError('load'); return }
          // The auto-sync flag is server-persisted configuration; the local UI
          // state only mirrors what the server last acknowledged and must never
          // override the fetched draft, or saving unrelated settings would
          // silently revert the server value.
          const draft = pricingDraftOf(pricing)
          setPricingDetails(pricing)
          setPricingDraft(draft)
        }, () => {
          if (pricingGate.isCurrent(seq)) setPricingError('load')
        }).finally(() => {
          if (pricingGate.isCurrent(seq)) setPricingLoading(false)
        })
      }
      const savePricingSettings = (backfill) => {
        if (pricingDraft === null || pricingSaving || pricingSyncing || pricingSyncSaving) return
        const validationError = pricingDraftValidationError(pricingDraft)
        if (validationError !== '') { setPricingError(validationError); return }
        const requestToken = typeof stats.requestToken === 'string' ? stats.requestToken : ''
        if (requestToken === '') { setPricingError('token'); return }
        const seq = pricingGate.next()
        setPricingSaving(true)
        setPricingError('')
        setPricingRpc(pricingDraft, backfill, requestToken).then((data) => {
          if (!pricingGate.isCurrent(seq)) return
          if (!data || data.ok !== true || !data.pricing) { setPricingError('save'); return }
          setStats((prev) => prev === null ? prev : Object.assign({}, prev, { pricing: data.pricing }))
          setPricingDetails(data.pricing)
          setPricingDraft(pricingDraftOf(data.pricing))
          setPricingUsedModelSearchText({})
          setPricingOverrideSearchText({})
          setPricingUsedModelOpen(null)
          setPricingOverrideOpen(null)
          closePricingPanel()
          refreshRef.current()
        }, (reason) => { if (pricingGate.isCurrent(seq)) setPricingError(reason && reason.status === 403 ? 'forbidden' : 'save') }).finally(() => setPricingSaving(false))
      }
      const syncPricingNow = () => {
        if (pricingSaving || pricingSyncing || pricingSyncSaving) return
        const requestToken = typeof stats.requestToken === 'string' ? stats.requestToken : ''
        if (requestToken === '') { setPricingError('token'); return }
        setPricingSyncing(true)
        setPricingError('')
        syncPricingRpc(requestToken).then((data) => {
          if (!data || data.ok !== true || !data.pricing) { setPricingError('sync'); return }
          // The synced catalog replaces the search corpus; invalidate searches
          // issued against the previous one before updating the panel.
          invalidatePricingSearches()
          setStats((prev) => prev === null ? prev : Object.assign({}, prev, { pricing: data.pricing }))
          setPricingDetails(data.pricing)
          setPricingDraft((prev) => pricingDraftAfterSync(prev, data.pricing))
          setPricingUsedModelSearchText({})
          setPricingOverrideSearchText({})
          setPricingUsedModelOpen(null)
          setPricingOverrideOpen(null)
          refreshRef.current()
        }, (reason) => { setPricingError(reason && reason.status === 403 ? 'forbidden' : 'sync') }).finally(() => setPricingSyncing(false))
      }
      const updatePricingSync = (enabled) => {
        if (pricingDraft === null || pricingSyncSaving || pricingSaving || pricingSyncing) return
        const nextEnabled = enabled === true
        const previousEnabled = pricingDraft.sync && pricingDraft.sync.autoEnabled === true
        setPricingDraft((prev) => prev === null ? prev : Object.assign({}, prev, { sync: Object.assign({}, prev.sync, { autoEnabled: nextEnabled }) }))
        persistUsageUiState({ pricingAutoSync: nextEnabled })
        const requestToken = typeof stats.requestToken === 'string' ? stats.requestToken : ''
        if (requestToken === '') {
          setPricingDraft((prev) => prev === null ? prev : Object.assign({}, prev, { sync: Object.assign({}, prev.sync, { autoEnabled: previousEnabled }) }))
          persistUsageUiState({ pricingAutoSync: previousEnabled })
          setPricingError('token')
          return
        }
        const rollback = (error) => {
          setPricingDraft((prev) => prev === null ? prev : Object.assign({}, prev, { sync: Object.assign({}, prev.sync, { autoEnabled: previousEnabled }) }))
          persistUsageUiState({ pricingAutoSync: previousEnabled })
          setPricingError(error)
        }
        setPricingSyncSaving(true)
        setPricingError('')
        setPricingRpc({ sync: { autoEnabled: nextEnabled } }, false, requestToken).then((data) => {
          if (!data || data.ok !== true || !data.pricing) { rollback('save'); return }
          const savedEnabled = data.pricing.sync && data.pricing.sync.autoEnabled === true
          setStats((prev) => prev === null ? prev : Object.assign({}, prev, { pricing: data.pricing }))
          setPricingDetails(data.pricing)
          setPricingDraft((prev) => prev === null ? prev : Object.assign({}, prev, { sync: Object.assign({}, prev.sync, { autoEnabled: savedEnabled, intervalMs: data.pricing.sync && data.pricing.sync.intervalMs }) }))
          persistUsageUiState({ pricingAutoSync: savedEnabled })
        }, (reason) => rollback(reason && reason.status === 403 ? 'forbidden' : 'save')).finally(() => setPricingSyncSaving(false))
      }
      const updatePricingMapping = (index, field, value) => {
        setPricingDraft((prev) => {
          if (prev === null || !Array.isArray(prev.mappings) || !prev.mappings[index]) return prev
          const mappings = prev.mappings.slice()
          mappings[index] = Object.assign({}, mappings[index], { [field]: value })
          return Object.assign({}, prev, { mappings })
        })
      }
      const selectPricingUsedModel = (index, value) => {
        const selected = pricingUsedModels.find((model) => String(model.identityKey || model.model || '') === String(value))
        if (!selected) return
        const modelAlias = selected.actualModel || selected.requestedModel || selected.pricingModel || ''
        const officialModel = selected.status === 'priced' ? (selected.pricingModel || '') : ''
        setPricingDraft((prev) => {
          if (prev === null || !Array.isArray(prev.mappings) || !prev.mappings[index]) return prev
          const mappings = prev.mappings.slice()
          mappings[index] = Object.assign({}, mappings[index], { identityKey: value, model: modelAlias, catalogModelId: officialModel, catalogProviderId: selected.providerId || '' })
          return Object.assign({}, prev, { mappings })
        })
        setPricingUsedModelSearchText((prev) => Object.assign({}, prev, { [index]: selected.model || modelAlias }))
        setPricingUsedModelOpen(null)
        setPricingModelSearchOpen(null)
      }
      const searchUsedModels = (index, value) => {
        setPricingUsedModelSearchText((prev) => Object.assign({}, prev, { [index]: value }))
        setPricingUsedModelOpen(index)
        setPricingDraft((prev) => {
          if (prev === null || !Array.isArray(prev.mappings) || !prev.mappings[index]) return prev
          const mappings = prev.mappings.slice()
          mappings[index] = Object.assign({}, mappings[index], { identityKey: '', model: '', catalogModelId: '', catalogProviderId: '' })
          return Object.assign({}, prev, { mappings })
        })
      }
      const shiftIndexedMap = (map, removedIndex) => {
        const next = {}
        for (const key of Object.keys(map)) {
          const index = Number(key)
          if (!Number.isInteger(index) || index < 0 || index === removedIndex) continue
          next[String(index > removedIndex ? index - 1 : index)] = map[key]
        }
        return next
      }
      const searchOfficialModels = (index, value) => {
        const searchEpoch = pricingSearchEpochRef.current
        updatePricingMapping(index, 'catalogModelId', value)
        setPricingModelSearchOpen(index)
        const previousTimer = pricingModelSearchTimerRef.current[index]
        if (previousTimer !== undefined) {
          clearTimeout(previousTimer)
          delete pricingModelSearchTimerRef.current[index]
        }
        const nextSeq = (pricingModelSearchSeqRef.current[index] || 0) + 1
        pricingModelSearchSeqRef.current[index] = nextSeq
        if (String(value || '').trim() === '') {
          setPricingModelSearchOptions((prev) => Object.assign({}, prev, { [index]: [] }))
          return
        }
        const timerId = setTimeout(() => {
          delete pricingModelSearchTimerRef.current[index]
          getPricingModels(value).then((data) => {
            // A deleted mapping can shift every later row, so an in-flight response
            // must also prove the row-generation it was issued under is still the
            // current one; the per-index seq alone can collide after a shift.
            if (pricingSearchEpochRef.current !== searchEpoch) return
            if (pricingModelSearchSeqRef.current[index] !== nextSeq) return
            setPricingModelSearchOptions((prev) => Object.assign({}, prev, { [index]: Array.isArray(data && data.items) ? data.items : [] }))
          }, () => {
            if (pricingSearchEpochRef.current !== searchEpoch) return
            if (pricingModelSearchSeqRef.current[index] === nextSeq) setPricingModelSearchOptions((prev) => Object.assign({}, prev, { [index]: [] }))
          })
        }, 180)
        pricingModelSearchTimerRef.current[index] = timerId
      }
      const chooseOfficialModel = (index, option) => {
        if (!option || typeof option.value !== 'string') return
        const pendingTimer = pricingModelSearchTimerRef.current[index]
        if (pendingTimer !== undefined) {
          clearTimeout(pendingTimer)
          delete pricingModelSearchTimerRef.current[index]
        }
        pricingModelSearchSeqRef.current[index] = (pricingModelSearchSeqRef.current[index] || 0) + 1
        setPricingDraft((prev) => {
          if (prev === null || !Array.isArray(prev.mappings) || !prev.mappings[index]) return prev
          const mappings = prev.mappings.slice()
          mappings[index] = Object.assign({}, mappings[index], { catalogModelId: option.value, catalogProviderId: option.providerId || '' })
          return Object.assign({}, prev, { mappings })
        })
        setPricingModelSearchOpen(null)
      }
      const addPricingMapping = () => {
        setPricingDraft((prev) => prev === null ? prev : Object.assign({}, prev, { mappings: prev.mappings.concat([{ identityKey: '', model: '', catalogProviderId: '', catalogModelId: '', inputTokenSemantics: 'fresh', multiplier: '1' }]) }))
      }
      const removePricingMapping = (index) => {
        // Deleting a mapping shifts every later row: cancel pending searches,
        // move their async state down, and invalidate every in-flight response
        // with a row-generation bump so a stale response can never populate a
        // shifted row (the per-index sequence alone can collide after the shift).
        pricingSearchEpochRef.current += 1
        const timers = pricingModelSearchTimerRef.current
        for (const key of Object.keys(timers)) clearTimeout(timers[key])
        pricingModelSearchTimerRef.current = shiftIndexedMap(timers, index)
        pricingModelSearchSeqRef.current = shiftIndexedMap(pricingModelSearchSeqRef.current, index)
        setPricingModelSearchOptions((prev) => shiftIndexedMap(prev, index))
        setPricingUsedModelSearchText((prev) => shiftIndexedMap(prev, index))
        setPricingOverrideSearchText((prev) => shiftIndexedMap(prev, index))
        const shiftOpen = (current) => current === null || current === undefined ? current : current === index ? null : (Number.isInteger(current) && current > index ? current - 1 : current)
        setPricingModelSearchOpen((current) => shiftOpen(current))
        setPricingUsedModelOpen((current) => shiftOpen(current))
        setPricingOverrideOpen((current) => shiftOpen(current))
        setPricingDraft((prev) => prev === null ? prev : Object.assign({}, prev, { mappings: prev.mappings.filter((_, itemIndex) => itemIndex !== index) }))
      }
      const updatePricingOverride = (index, field, value) => {
        setPricingDraft((prev) => {
          if (prev === null || !Array.isArray(prev.overrides) || !prev.overrides[index]) return prev
          const overrides = prev.overrides.slice()
          overrides[index] = Object.assign({}, overrides[index], { [field]: value })
          return Object.assign({}, prev, { overrides })
        })
      }
      const addPricingOverrideTier = (index) => {
        setPricingDraft((prev) => {
          if (prev === null || !Array.isArray(prev.overrides) || !prev.overrides[index]) return prev
          const overrides = prev.overrides.slice()
          const entry = Object.assign({}, overrides[index])
          const tiers = Array.isArray(entry.tiers) ? entry.tiers.map((tier) => Object.assign({}, tier)) : []
          if (tiers.length >= 32) return prev
          const previous = tiers.length > 0 ? tiers[tiers.length - 1] : null
          const previousSize = previous && Number.isFinite(Number(previous.size)) ? Number(previous.size) : 100000
          const source = previous || entry
          tiers.push({
            type: 'context',
            size: Math.min(1000000000, previousSize + 100000),
            input: source.input === undefined ? '' : source.input,
            output: source.output === undefined ? '' : source.output,
            cacheRead: source.cacheRead === undefined ? '' : source.cacheRead,
            cacheWrite: source.cacheWrite === undefined ? '' : source.cacheWrite,
          })
          overrides[index] = Object.assign({}, entry, { tiered: true, tiers })
          return Object.assign({}, prev, { overrides })
        })
        setPricingError('')
      }
      const updatePricingOverrideTier = (overrideIndex, tierIndex, field, value) => {
        setPricingDraft((prev) => {
          if (prev === null || !Array.isArray(prev.overrides) || !prev.overrides[overrideIndex]) return prev
          const overrides = prev.overrides.slice()
          const entry = Object.assign({}, overrides[overrideIndex])
          const tiers = Array.isArray(entry.tiers) ? entry.tiers.map((tier) => Object.assign({}, tier)) : []
          if (!tiers[tierIndex]) return prev
          tiers[tierIndex] = Object.assign({}, tiers[tierIndex], { [field]: value })
          overrides[overrideIndex] = Object.assign({}, entry, { tiered: tiers.length > 0, tiers })
          return Object.assign({}, prev, { overrides })
        })
        setPricingError('')
      }
      const removePricingOverrideTier = (overrideIndex, tierIndex) => {
        setPricingDraft((prev) => {
          if (prev === null || !Array.isArray(prev.overrides) || !prev.overrides[overrideIndex]) return prev
          const overrides = prev.overrides.slice()
          const entry = Object.assign({}, overrides[overrideIndex])
          const tiers = (Array.isArray(entry.tiers) ? entry.tiers : []).filter((_, index) => index !== tierIndex).map((tier) => Object.assign({}, tier))
          overrides[overrideIndex] = Object.assign({}, entry, { tiered: tiers.length > 0, tiers })
          return Object.assign({}, prev, { overrides })
        })
        setPricingError('')
      }
      const selectPricingOverrideModel = (index, value) => {
        const selected = pricingUsedModels.find((model) => String(model.identityKey || model.model || '') === String(value))
        if (!selected) return
        const modelId = selected.pricingModel || selected.actualModel || selected.requestedModel || ''
        setPricingDraft((prev) => {
          if (prev === null || !Array.isArray(prev.overrides) || !prev.overrides[index]) return prev
          const overrides = prev.overrides.slice()
          const patch = { modelId }
          if (selected.status === 'priced' && selected.rates) {
            Object.assign(patch, selected.rates)
            patch.tiers = Array.isArray(selected.tiers) ? selected.tiers.map((tier) => Object.assign({}, tier)) : []
            patch.tiered = patch.tiers.length > 0
          }
          overrides[index] = Object.assign({}, overrides[index], patch)
          return Object.assign({}, prev, { overrides })
        })
        setPricingOverrideSearchText((prev) => Object.assign({}, prev, { [index]: modelId }))
        setPricingOverrideOpen(null)
      }
      const searchPricingOverrideModels = (index, value) => {
        setPricingOverrideSearchText((prev) => Object.assign({}, prev, { [index]: value }))
        setPricingOverrideOpen(index)
        updatePricingOverride(index, 'modelId', value)
      }
      const addPricingOverride = () => {
        setPricingDraft((prev) => prev === null ? prev : Object.assign({}, prev, { overrides: prev.overrides.concat([{ providerId: '', modelId: '', displayName: '', input: '', output: '', cacheRead: '', cacheWrite: '', tiered: false, tiers: [] }]) }))
        setPricingError('')
      }
      const removePricingOverride = (index) => {
        setPricingDraft((prev) => prev === null ? prev : Object.assign({}, prev, { overrides: prev.overrides.filter((_, itemIndex) => itemIndex !== index) }))
      }

      const totalTokens = agg.totals.input + agg.totals.output + agg.totals.cacheRead + agg.totals.cacheWrite + agg.totals.reasoning
      const cacheRate = rateOf(agg.totals.input, agg.totals.cacheRead)
      const scopedCost = costAggregate(agg.totals)
      const costValue = costDisplay(agg.totals, language)
      const costCoverage = costCoverageLabel(agg.totals, language)

      let balanceValue = '—'
      let balanceSub = tr('查询中…', 'Checking…')
      if (balance !== null && balance !== undefined) {
        if (balance.status === 'missing-key') {
          balanceValue = tr('未配置', 'Not configured')
          balanceSub = tr('在 设置 → 模型 中填写 DeepSeek API Key 后可见', 'Available after you enter a DeepSeek API key in Settings → Models')
        } else if (balance.status === 'unavailable') {
          balanceValue = tr('不可用', 'Unavailable')
          balanceSub = balance.message || tr('DeepSeek 接口返回余额不可用', 'The DeepSeek API reported that balance information is unavailable')
        } else if (balance.status === 'error') {
          balanceValue = tr('查询失败', 'Lookup failed')
          const detail = balance.detail ? (language === 'en' ? ' (' + String(balance.detail).slice(0, 90) + ')' : '（' + String(balance.detail).slice(0, 90) + '）') : ''
          balanceSub = (balance.message || '') + detail + tr(' 点“刷新”重试', ' Click Refresh to try again')
        } else if (balance.status === 'ok' && Array.isArray(balance.currencies) && balance.currencies.length > 0) {
          const list = balance.currencies
          const primary = list.find((c) => c.currency === 'CNY') || list[0]
          const others = list.filter((c) => c !== primary)
          balanceValue = money(primary.currency, primary.total, language)
          let sub = primary.total !== null ? tr('赠送 ', 'Granted ') + money(primary.currency, primary.granted, language) + ' · ' + tr('充值 ', 'Top-up ') + money(primary.currency, primary.toppedUp, language) : ''
          if (others.length > 0) sub += (sub ? ' ｜ ' : '') + others.map((c) => money(c.currency, c.total, language)).join(' ')
          balanceSub = sub
        } else {
          balanceValue = tr('无数据', 'No data')
          balanceSub = ''
        }
      }

      const card = (label, value, sub, delay, icon) => React.createElement('div', { className: 'uh-card', style: { animationDelay: (delay * 70) + 'ms' } },
        React.createElement('div', { className: 'uh-card-label' }, icon ? React.createElement(LineIcon, { name: icon, size: 14 }) : null, label),
        React.createElement('div', { className: 'uh-card-value' }, value),
        React.createElement('div', { className: 'uh-card-sub' }, sub),
      )
      const summaryRateMetric = React.createElement('div', { className: 'uh-ios-metric uh-ios-metric-rate', style: { animationDelay: '280ms' } },
        React.createElement('div', { className: 'uh-ios-metric-rate-head' },
          React.createElement('div', { className: 'uh-ios-metric-label' }, React.createElement(LineIcon, { name: 'cache', size: 18 }), tr('缓存命中率', 'Cache Hit Rate')),
          React.createElement('div', { className: 'uh-ios-metric-rate-value' }, (cacheRate).toFixed(1) + '%'),
        ),
        React.createElement('div', { className: 'uh-ios-metric-bar' }, React.createElement('div', { className: 'uh-ios-metric-fill', style: { width: Math.max(0, Math.min(100, cacheRate)) + '%' } })),
        React.createElement('div', { className: 'uh-ios-metric-rate-detail' }, language === 'en' ? 'Context reused ' + fmtCompact(agg.totals.cacheRead) + ' tokens' : '复用上下文 ' + fmtCompact(agg.totals.cacheRead) + ' Token'),
      )

      const maxTotal = rows.length > 0 ? wsTotal(rows[0]) : 0

      const tokenCardRows = rows.slice(0, 3).map((w) => {
        const total = wsTotal(w)
        const idx = wsIndex.get(w.workspaceId)
        const color = wsColor(idx === undefined ? 0 : idx)
        const selected = wsFilter === w.workspaceId
        return React.createElement('div', {
          key: w.workspaceId,
          className: 'uh-wsbar' + (selected ? ' uh-sel' : ''),
          onClick: () => toggleFilter(w.workspaceId),
        },
          React.createElement('div', { className: 'uh-wsbar-top' },
            React.createElement('span', { className: 'uh-dot', style: { background: color } }),
            React.createElement('span', { className: 'uh-wsbar-title' }, wsTitle(w.workspaceId)),
            React.createElement('span', { className: 'uh-wsbar-num' }, valueWithMagnitude(fmtCompact(total), total, language)),
          ),
          React.createElement('div', { className: 'uh-barwrap uh-bar-thin' },
            React.createElement('div', { className: 'uh-barfill', style: { width: maxTotal > 0 ? Math.max(2, (total / maxTotal) * 100) + '%' : '0%', background: color } }),
          ),
        )
      })
      const tokenCard = React.createElement('div', { className: 'uh-card', style: { animationDelay: '210ms' } },
        React.createElement('div', { className: 'uh-card-label' }, React.createElement(LineIcon, { name: 'folder', size: 14 }), tr('各工作区总处理量', 'Total Tokens Processed by Workspace')),
        rows.length === 0
          ? React.createElement('div', { className: 'uh-empty', style: { padding: '8px 0' } }, tr('暂无数据', 'No data yet'))
          : React.createElement('div', { className: 'uh-wsbars' },
            tokenCardRows,
            rows.length > 3 ? React.createElement('div', { className: 'uh-card-sub' }, language === 'en' ? 'See the details table for the other ' + (rows.length - 3) + ' workspaces' : '其余 ' + (rows.length - 3) + ' 个工作区见明细表') : null,
          ),
      )

      const rowElements = rows.map((w) => {
        const meta = wsById.get(w.workspaceId)
        const alias = typeof aliases[w.workspaceId] === 'string' ? aliases[w.workspaceId] : ''
        const folderTitle = meta ? meta.title : tr('未知工作区', 'Unknown workspace')
        const path = meta ? meta.path : ''
        const title = alias !== '' ? alias : folderTitle
        const subText = alias !== '' ? folderTitle + ' · ' + path : path
        const total = wsTotal(w)
        const rate = rateOf(w.input, w.cacheRead)
        const idx = wsIndex.get(w.workspaceId)
        const color = wsColor(idx === undefined ? 0 : idx)
        const selected = wsFilter === w.workspaceId
        return React.createElement('div', {
          key: w.workspaceId,
          className: 'uh-row' + (selected ? ' uh-sel' : ''),
          onClick: () => toggleFilter(w.workspaceId),
        },
          React.createElement('div', { className: 'uh-row-title-wrap' },
            React.createElement('div', { className: 'uh-ws-title' }, title),
            React.createElement('div', { className: 'uh-ws-path' }, subText),
          ),
          React.createElement('div', { className: 'uh-num' }, fmtCompact(w.turns)),
          React.createElement('div', { className: 'uh-num' }, fmtCompact(w.input)),
          React.createElement('div', { className: 'uh-num' }, fmtCompact(w.cacheRead)),
          React.createElement('div', { className: 'uh-num' }, fmtCompact(w.output)),
          React.createElement('div', { className: 'uh-num' }, fmtCompact(w.reasoning)),
          React.createElement('div', {},
            React.createElement('div', { className: 'uh-num' }, fmtCompact(total)),
            React.createElement('div', { className: 'uh-barwrap' },
              React.createElement('div', { className: 'uh-barfill', style: { width: maxTotal > 0 ? Math.max(2, (total / maxTotal) * 100) + '%' : '0%', background: color } }),
            ),
          ),
          React.createElement('div', { className: 'uh-num uh-cost-num' }, costDisplay(w, language)),
          React.createElement('div', { className: 'uh-num' }, rate.toFixed(1) + '%'),
          React.createElement('div', { className: 'uh-num' }, maxTotal > 0 ? ((total / maxTotal) * 100).toFixed(0) + '%' : '0%'),
        )
      })

      const modelViewLabel = modelView === 'route' ? tr('混合查看', 'Combined View') : modelView === 'model' ? tr('按模型合并', 'Grouped by Model') : tr('按供应商汇总', 'Grouped by Provider')
      const modelColumnLabel = modelView === 'route' ? tr('供应商 / 模型', 'Provider / Model') : modelView === 'model' ? tr('模型', 'Model') : tr('供应商', 'Provider')
      const modelDonutChart = detailView !== 'model' || modelRows.length === 0 ? null : React.createElement(MemoUsageDonutChart, {
        key: 'model-donut-' + detailView + ':' + queryKey + ':' + (liveQueryVersion || 'query') + ':' + modelView,
        title: modelView === 'provider' ? tr('供应商用量', 'Provider Usage') : tr('模型用量', 'Model Usage'),
        icon: 'chart',
        language,
        items: modelDonutItems,
      })
      const workspaceDonutChart = detailView !== 'workspace' || rows.length === 0 ? null : React.createElement(MemoUsageDonutChart, {
        key: 'workspace-donut-' + detailView + ':' + queryKey + ':' + (liveQueryVersion || 'query'),
        title: tr('工作区用量', 'Workspace Usage'),
        icon: 'folder',
        language,
        items: workspaceDonutItems,
      })
      const exportCsv = () => {
        const quote = (value) => '"' + String(value === undefined || value === null ? '' : value).replace(/"/g, '""') + '"'
        const line = (values) => values.map(quote).join(',')
        const allTokens = (entry) => entry.input + entry.output + entry.cacheRead + entry.cacheWrite + entry.reasoning
        const tokenHeaders = [tr('输入 Token', 'Input Tokens'), tr('缓存命中 Token', 'Cache-Hit Tokens'), tr('缓存写入 Token', 'Cache-Write Tokens'), tr('输出 Token', 'Output Tokens'), tr('推理 Token', 'Reasoning Tokens'), tr('总处理 Token', 'Total Tokens Processed'), tr('成本', 'Cost'), tr('缓存命中率', 'Cache Hit Rate')]
        const output = [
          line([tr('DSH 用量统计导出', 'DSH Usage Statistics Export')]),
          line([tr('导出时间', 'Exported At'), useUtc ? new Date().toLocaleString('en-US', { timeZone: 'UTC', timeZoneName: 'short' }) : new Date().toLocaleString('zh-CN')]),
          line([tr('时间范围', 'Time Range'), rangeLabel]),
          line([tr('时区', 'Timezone'), useUtc ? 'UTC' : tr('本地', 'Local')]),
          line([tr('工作区筛选', 'Workspace Filter'), wsFilter || tr('全部', 'All')]),
          line([tr('供应商筛选', 'Provider Filter'), providerFilter || tr('全部', 'All')]),
          line([tr('模型筛选', 'Model Filter'), modelFilter || tr('全部', 'All')]),
          line([tr('统计 revision', 'Stats Revision'), stats.revision || '']),
          line([tr('模型查看模式', 'Model View Mode'), modelViewLabel]),
          '',
          line([tr('汇总', 'Summary')]),
          line([tr('回合', 'Turns'), tr('会话', 'Sessions'), ...tokenHeaders]),
          line([agg.totals.turns, agg.totals.sessions, agg.totals.input, agg.totals.cacheRead, agg.totals.cacheWrite, agg.totals.output, agg.totals.reasoning, allTokens(agg.totals), costDisplay(agg.totals, language), rateOf(agg.totals.input, agg.totals.cacheRead).toFixed(2) + '%']),
          '',
          line([tr('模型用量明细', 'Model Usage Details')]),
          line([modelColumnLabel, tr('调用', 'Calls'), ...tokenHeaders]),
          ...modelRows.map((m) => line([m.model, m.calls, m.input, m.cacheRead, m.cacheWrite, m.output, m.reasoning, allTokens(m), costDisplay(m, language), rateOf(m.input, m.cacheRead).toFixed(2) + '%'])),
          '',
          line([tr('工作区明细', 'Workspace Details')]),
          line([tr('工作区', 'Workspace'), tr('路径', 'Path'), tr('回合', 'Turns'), ...tokenHeaders]),
          ...rows.map((w) => { const meta = wsById.get(w.workspaceId); return line([wsTitle(w.workspaceId), meta ? meta.path : '', w.turns, w.input, w.cacheRead, w.cacheWrite, w.output, w.reasoning, allTokens(w), costDisplay(w, language), rateOf(w.input, w.cacheRead).toFixed(2) + '%']) }),
        ]
        const blob = new Blob(['\uFEFF' + output.join('\r\n')], { type: 'text/csv;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = 'dsh-all-usage-' + rangeFilePart + '-' + modelView + '-' + fmtDate(new Date(), useUtc) + '.csv'
        document.body.appendChild(anchor); anchor.click(); anchor.remove()
        URL.revokeObjectURL(url)
      }

      const modelElements = detailView === 'model' ? modelRows.map((m) => {
        const total = wsTotal(m)
        const rate = rateOf(m.input, m.cacheRead)
        return React.createElement('div', { key: m.identityKey || m.model, className: 'uh-model-row uh-row' },
          React.createElement('div', { className: 'uh-row-title-wrap' },
            React.createElement('div', { className: 'uh-ws-title uh-model-label', title: m.model }, React.createElement(MemoModelIcon, { iconKey: m.iconKey, row: m, size: 18, showTitle: true }), React.createElement('span', { className: 'uh-model-text' }, m.model)),
          ),
          React.createElement('div', { className: 'uh-num' }, fmtCompact(m.calls)),
          React.createElement('div', { className: 'uh-num' }, fmtCompact(m.input)),
          React.createElement('div', { className: 'uh-num' }, fmtCompact(m.cacheRead)),
          React.createElement('div', { className: 'uh-num' }, fmtCompact(m.output)),
          React.createElement('div', { className: 'uh-num' }, fmtCompact(m.reasoning)),
          React.createElement('div', { className: 'uh-num' }, fmtCompact(total)),
          React.createElement('div', { className: 'uh-num uh-cost-num' }, costDisplay(m, language)),
          React.createElement('div', { className: 'uh-num' }, rate.toFixed(1) + '%'),
        )
      }) : []

      const aliasPanel = aliasOpen
        ? React.createElement('div', { className: 'uh-panel uh-anim-panel' },
          React.createElement('div', { className: 'uh-alias-panel-head' },
            React.createElement('span', {}, tr('工作区别名', 'Workspace Aliases')),
            React.createElement('button', { className: 'uh-alias-close', onClick: () => setAliasOpen(false) }, tr('关闭', 'Close')),
          ),
          workspaces.length === 0
            ? React.createElement('div', { className: 'uh-empty', style: { padding: '10px 0' } }, tr('暂无工作区', 'No workspaces yet'))
            : React.createElement('div', { className: 'uh-alias-list' },
              workspaces.map((w, i) => React.createElement('div', { key: w.id, className: 'uh-alias-item' },
                React.createElement('span', { className: 'uh-dot', style: { background: wsColor(i) } }),
                React.createElement('span', { className: 'uh-alias-folder', title: w.path }, w.title || w.path),
                React.createElement('input', {
                  className: 'uh-alias-input',
                  value: aliasDrafts[w.id] !== undefined ? aliasDrafts[w.id] : '',
                  placeholder: tr('项目别名', 'Project alias'),
                  onChange: (e) => setAliasDrafts((prev) => Object.assign({}, prev, { [w.id]: e.target.value })),
                  onKeyDown: (e) => { if (e.key === 'Enter') saveAlias(w.id, e.target.value) },
                }),
              )),
            ),
          React.createElement('div', { className: 'uh-alias-panel-foot' },
            React.createElement('span', { className: 'uh-note' }, tr('回车保存单个；清空别名还原文件夹名', 'Press Enter to save one; clear an alias to restore the folder name')),
            React.createElement('button', { className: 'uh-alias-ok', onClick: saveAllAliases }, tr('全部保存', 'Save All')),
          ),
        )
        : null


      const pricingSync = currentPricing.sync && typeof currentPricing.sync === 'object' ? currentPricing.sync : {}
      const renderPricingPanel = () => pricingDraft !== null ? React.createElement('div', { className: 'uh-panel uh-pricing-panel uh-anim-panel' },
        React.createElement('div', { className: 'uh-pricing-head' },
          React.createElement('div', { className: 'uh-title-with-icon' }, React.createElement(LineIcon, { name: 'wallet', size: 16 }), React.createElement('strong', {}, tr('成本统计设置', 'Cost Statistics'))),
          React.createElement('button', { type: 'button', className: 'uh-refresh uh-icon-button', title: tr('关闭成本设置', 'Close cost settings'), 'aria-label': tr('关闭成本设置', 'Close cost settings'), disabled: pricingSaving || pricingSyncing || pricingSyncSaving, onClick: closePricingPanel }, React.createElement(LineIcon, { name: 'close', size: 16 })),
        ),
        React.createElement('div', { className: 'uh-pricing-note' }, tr('价格单位为 USD / 1M Token。输入上下文严格超过档位阈值时，整次请求的输入、输出和缓存均使用该档费率；可展开查看 models.dev 档位，也可在价格覆盖中自定义。', 'Prices are USD per 1M tokens. When input context strictly exceeds a band threshold, that band’s input, output, and cache rates apply to the whole request. Expand models.dev schedules or define custom override bands below.')),
        React.createElement('div', { className: 'uh-pricing-toolbar' },
          React.createElement('label', { className: 'uh-pricing-switch' },
            React.createElement('input', { type: 'checkbox', checked: pricingDraft.sync.autoEnabled === true, disabled: pricingSaving || pricingSyncing || pricingSyncSaving, onChange: (event) => updatePricingSync(event.target.checked) }),
            React.createElement('span', {}, tr('启用 6 小时自动同步', 'Enable 6-hour automatic sync')),
          ),
          React.createElement('span', { className: 'uh-note' }, pricingSyncSaving ? tr('保存中…', 'Saving…') : (pricingSync.lastSuccessAt > 0 ? tr('上次成功：', 'Last success: ') + new Date(pricingSync.lastSuccessAt).toLocaleString() : tr('尚未同步', 'Not synced yet'))),
          React.createElement('button', { type: 'button', className: 'uh-refresh', onClick: syncPricingNow, disabled: pricingSyncing || pricingSaving || pricingSyncSaving }, React.createElement(LineIcon, { name: 'refresh', size: 14 }), pricingSyncing ? tr('同步中…', 'Syncing…') : tr('立即同步', 'Sync now')),
        ),
        pricingSync.lastError ? React.createElement('div', { className: 'uh-pricing-error', role: 'alert' }, tr('上次同步失败：', 'Last sync failed: ') + pricingSync.lastError) : null,
        React.createElement('div', { className: 'uh-pricing-section' },
          React.createElement('div', { className: 'uh-pricing-section-head' }, React.createElement('strong', {}, tr('当前用量匹配', 'Usage matches')), React.createElement('span', { className: 'uh-note' }, pricingUsedModels.length + ' ' + tr('个模型', 'models'))),
          pricingUsedModels.length === 0 ? React.createElement('div', { className: 'uh-empty', style: { padding: '12px 0' } }, tr('暂无模型用量', 'No model usage yet')) : React.createElement('div', { className: 'uh-pricing-table-wrap' },
            React.createElement('table', { className: 'uh-pricing-model-table' },
              React.createElement('thead', {}, React.createElement('tr', {},
                React.createElement('th', { scope: 'col' }, tr('当前模型', 'Usage model')),
                React.createElement('th', { scope: 'col' }, tr('状态', 'Status')),
                React.createElement('th', { scope: 'col' }, tr('官方模型', 'Official model')),
                React.createElement('th', { scope: 'col' }, tr('费率档位', 'Rate bands')),
                React.createElement('th', { scope: 'col', title: tr('基础输入价格（USD / 1M）', 'Base input price (USD / 1M)') }, tr('输入', 'Input')),
                React.createElement('th', { scope: 'col', title: tr('基础输出价格（USD / 1M）', 'Base output price (USD / 1M)') }, tr('输出', 'Output')),
                React.createElement('th', { scope: 'col', title: tr('基础缓存读取价格（USD / 1M）', 'Base cache read price (USD / 1M)') }, tr('缓存读', 'Cache read')),
                React.createElement('th', { scope: 'col', title: tr('基础缓存写入价格（USD / 1M）', 'Base cache write price (USD / 1M)') }, tr('缓存写', 'Cache write')),
              )),
              React.createElement('tbody', {}, pricingUsedModels.map((model) => {
                const tiers = Array.isArray(model.tiers) ? model.tiers : []
                const hasTierSchedule = model.tiered === true && model.tieredInvalid !== true && tiers.length > 0 && model.rates
                const tierLabel = model.tieredInvalid === true ? tr('档位异常', 'Invalid tiers') : model.tiered === true ? tr('分层 · ', 'Tiered · ') + tiers.length : tr('固定', 'Flat')
                const temporalLabel = model.temporalRoute === 'official' || model.temporalRoute === 'mapped' ? (language === 'en' ? '峰谷 · ' : 'Peak/off-peak · ') + 'UTC' : model.temporalRoute === 'other' ? (language === 'en' ? '静态价 · 非官方直连' : 'static · reseller') : ''
                const schedule = hasTierSchedule ? [Object.assign({ type: 'context', size: 0 }, model.rates)].concat(tiers) : []
                return React.createElement(React.Fragment, { key: model.identityKey },
                  React.createElement('tr', {},
                    React.createElement('td', { className: 'uh-pricing-model-name', title: model.model }, React.createElement('span', { className: 'uh-model-label' }, React.createElement(MemoModelIcon, { row: model, size: 16 }), React.createElement('span', { className: 'uh-model-text' }, model.model || tr('未知模型', 'Unknown model')))),
                    React.createElement('td', { title: model.reason || '' }, React.createElement('span', { className: 'uh-pricing-status uh-pricing-status-' + (model.status || 'unpriced') }, pricingStatusLabel(model.status || 'unpriced', language))),
                    React.createElement('td', { className: 'uh-pricing-model-target', title: model.pricingModel || '' }, model.pricingModel || tr('未匹配', 'No match')),
                    React.createElement('td', {}, React.createElement('span', { className: 'uh-pricing-tier-badge' + (model.tiered === true ? '' : ' uh-flat'), title: model.temporalPolicyId || '' }, tierLabel + (temporalLabel !== '' ? ' · ' + temporalLabel : ''))),
                    React.createElement('td', { className: 'uh-pricing-model-rate' }, model.status === 'priced' && model.rates ? model.rates.input : '—'),
                    React.createElement('td', { className: 'uh-pricing-model-rate' }, model.status === 'priced' && model.rates ? model.rates.output : '—'),
                    React.createElement('td', { className: 'uh-pricing-model-rate' }, model.status === 'priced' && model.rates ? model.rates.cacheRead : '—'),
                    React.createElement('td', { className: 'uh-pricing-model-rate' }, model.status === 'priced' && model.rates ? model.rates.cacheWrite : '—'),
                  ),
                  hasTierSchedule ? React.createElement('tr', { className: 'uh-pricing-tier-row' }, React.createElement('td', { colSpan: 8 },
                    React.createElement('details', { className: 'uh-pricing-tier-details' },
                      React.createElement('summary', {},
                        React.createElement(LineIcon, { name: 'chevron', size: 13, className: 'uh-pricing-tier-caret' }),
                        tr('查看完整费率表', 'View full rate table'),
                        React.createElement('span', { className: 'uh-pricing-tier-context' }, pricingSemanticsLabel(model.inputTokenSemantics, language) + (model.multiplier && model.multiplier !== '1' ? ' · ×' + model.multiplier : '')),
                      ),
                      React.createElement('table', { className: 'uh-pricing-tier-table' },
                        React.createElement('thead', {}, React.createElement('tr', {},
                          React.createElement('th', { scope: 'col' }, tr('输入上下文范围', 'Input context range')),
                          React.createElement('th', { scope: 'col' }, tr('输入', 'Input')),
                          React.createElement('th', { scope: 'col' }, tr('输出', 'Output')),
                          React.createElement('th', { scope: 'col' }, tr('缓存读', 'Cache read')),
                          React.createElement('th', { scope: 'col' }, tr('缓存写', 'Cache write')),
                        )),
                        React.createElement('tbody', {}, schedule.map((rate, index) => React.createElement('tr', { key: index },
                          React.createElement('td', {}, pricingTierBandLabel(tiers, index - 1, language)),
                          React.createElement('td', {}, rate.input),
                          React.createElement('td', {}, rate.output),
                          React.createElement('td', {}, rate.cacheRead),
                          React.createElement('td', {}, rate.cacheWrite),
                        ))),
                      ),
                    ),
                  )) : null,
                )
              })),
            ),
          ),
        ),
        React.createElement('div', { className: 'uh-pricing-section' },
          React.createElement('div', { className: 'uh-pricing-section-head' }, React.createElement('strong', {}, tr('模型映射', 'Model mappings')), React.createElement('button', { type: 'button', className: 'uh-refresh', onClick: addPricingMapping }, React.createElement(LineIcon, { name: 'plus', size: 13 }), tr('添加映射', 'Add mapping'))),
          pricingDraft.mappings.length === 0 ? React.createElement('div', { className: 'uh-empty', style: { padding: '12px 0' } }, tr('选择当前模型后，再指定对应的官方模型。DSH Provider 不参与计价。', 'Select a used model, then choose its official model. The DSH provider is ignored.')) : pricingDraft.mappings.map((mapping, index) => {
            const usedModelQuery = String(pricingUsedModelSearchText[index] || '').trim().toLowerCase()
            const mappingModelKey = pricingModelKey(mapping.model)
            const mappingOfficialModelKey = pricingModelKey(mapping.catalogModelId)
            const selectedUsedModel = pricingUsedModelOptions.find((option) => option.value === String(mapping.identityKey || mapping.usageIdentityKey || '')) || pricingUsedModelOptions.find((option) => mappingModelKey !== '' && option.model === mappingModelKey) || pricingUsedModelOptions.find((option) => mappingOfficialModelKey !== '' && option.officialModel === mappingOfficialModelKey)
            const usedModelOptions = pricingUsedModelOptions.filter((option) => usedModelQuery === '' || option.label.toLowerCase().includes(usedModelQuery))
            return React.createElement('div', { key: index, className: 'uh-pricing-edit-row' },
              React.createElement('div', { className: 'uh-pricing-used-model-picker' },
                React.createElement('input', { type: 'text', className: 'uh-pricing-used-model-input', placeholder: tr('选择当前用过的模型', 'Select a used model'), value: pricingUsedModelSearchText[index] !== undefined ? pricingUsedModelSearchText[index] : (selectedUsedModel ? selectedUsedModel.label : ''), 'aria-label': tr('当前用过的模型', 'Used model'), 'aria-haspopup': 'listbox', 'aria-expanded': pricingUsedModelOpen === index, onFocus: () => { setPricingUsedModelOpen(index); setPricingUsedModelSearchText((prev) => Object.assign({}, prev, { [index]: '' })) }, onClick: () => setPricingUsedModelOpen(index), onBlur: () => setTimeout(() => { setPricingUsedModelOpen((current) => current === index ? null : current); if (selectedUsedModel) setPricingUsedModelSearchText((prev) => Object.assign({}, prev, { [index]: selectedUsedModel.label })) }, 120), onKeyDown: (event) => { if (event.key === 'Escape') setPricingUsedModelOpen(null) }, onChange: (event) => searchUsedModels(index, event.target.value) }),
                pricingUsedModelOpen === index && usedModelOptions.length > 0 ? React.createElement('div', { className: 'uh-language-options uh-pricing-used-model-options', role: 'listbox', 'aria-label': tr('当前用过的模型', 'Used models') },
                  usedModelOptions.map((option) => React.createElement('button', { key: option.value, type: 'button', role: 'option', className: 'uh-language-option uh-pricing-model-option', onMouseDown: (event) => event.preventDefault(), onClick: () => selectPricingUsedModel(index, option.value) },
                    React.createElement(LineIcon, { name: 'list', size: 14 }),
                    React.createElement('span', { className: 'uh-pricing-model-option-name' }, option.label),
                  )),
                ) : null,
              ),
              React.createElement('div', { className: 'uh-pricing-model-search' },
                React.createElement('input', { type: 'text', className: 'uh-pricing-model-search-input', placeholder: tr('输入官方模型 ID 检索', 'Type official model ID to search'), value: mapping.catalogModelId || '', 'aria-label': tr('官方模型 ID', 'Official model ID'), 'aria-autocomplete': 'list', onFocus: () => setPricingModelSearchOpen(index), onBlur: () => setTimeout(() => setPricingModelSearchOpen((current) => current === index ? null : current), 120), onKeyDown: (event) => { if (event.key === 'Escape') setPricingModelSearchOpen(null) }, onChange: (event) => searchOfficialModels(index, event.target.value) }),
                pricingModelSearchOpen === index && Array.isArray(pricingModelSearchOptions[index]) && pricingModelSearchOptions[index].length > 0 ? React.createElement('div', { className: 'uh-language-options uh-pricing-model-options', role: 'listbox', 'aria-label': tr('官方模型匹配结果', 'Official model matches') },
                  pricingModelSearchOptions[index].map((option) => React.createElement('button', { key: option.value, type: 'button', role: 'option', className: 'uh-language-option uh-pricing-model-option', onMouseDown: (event) => event.preventDefault(), onClick: () => chooseOfficialModel(index, option) },
                    React.createElement(LineIcon, { name: 'list', size: 14 }),
                    React.createElement('span', { className: 'uh-pricing-model-option-name' }, option.label || option.value),
                    React.createElement('span', { className: 'uh-pricing-model-option-id' }, option.value + (option.tiered === true ? ' · ' + tr('分层 ', 'tiered ') + option.tierCount : '')),
                  )),
                ) : null,
              ),
              React.createElement('input', { type: 'number', min: '0', step: 'any', placeholder: tr('倍率', 'Multiplier'), title: tr('成本倍率', 'Cost multiplier'), 'aria-label': tr('成本倍率', 'Cost multiplier'), value: mapping.multiplier || '1', onChange: (event) => updatePricingMapping(index, 'multiplier', event.target.value) }),
              React.createElement('button', { type: 'button', className: 'uh-refresh uh-icon-button', title: tr('删除映射', 'Remove mapping'), 'aria-label': tr('删除映射', 'Remove mapping'), onClick: () => removePricingMapping(index) }, React.createElement(LineIcon, { name: 'close', size: 14 })),
            )
          }),
        ),
        React.createElement('div', { className: 'uh-pricing-section' },
          React.createElement('div', { className: 'uh-pricing-section-head' }, React.createElement('strong', {}, tr('显式价格覆盖', 'Explicit price overrides')), React.createElement('button', { type: 'button', className: 'uh-refresh', onClick: addPricingOverride }, React.createElement(LineIcon, { name: 'plus', size: 13 }), tr('添加价格', 'Add price'))),
          pricingDraft.overrides.length === 0 ? React.createElement('div', { className: 'uh-empty', style: { padding: '12px 0' } }, tr('仅在官方目录未覆盖或有明确官方账单时添加；可配置基础价格和上下文费率档位。', 'Add an override only when the official catalog lacks the model or you have an authoritative official price. Base rates and context tiers are supported.')) : React.createElement(React.Fragment, null,
            React.createElement('div', { className: 'uh-pricing-price-head' },
              React.createElement('span', {}, tr('官方模型 ID', 'Official model ID')),
              React.createElement('span', {}, tr('基础输入 / 1M', 'Base input / 1M')),
              React.createElement('span', {}, tr('基础输出 / 1M', 'Base output / 1M')),
              React.createElement('span', {}, tr('基础缓存读 / 1M', 'Base cache read / 1M')),
              React.createElement('span', {}, tr('基础缓存写 / 1M', 'Base cache write / 1M')),
              React.createElement('span', {}, ''),
            ),
            React.createElement('div', { className: 'uh-pricing-overrides' }, pricingDraft.overrides.map((entry, index) => {
              const overrideModelQuery = String(pricingOverrideSearchText[index] || '').trim().toLowerCase()
              const overrideModelOptions = pricingUsedModelOptions.filter((option) => overrideModelQuery === '' || option.label.toLowerCase().includes(overrideModelQuery))
              const tiers = Array.isArray(entry.tiers) ? entry.tiers : []
              let previousTierSize = 0
              const tierEditors = tiers.map((tier, tierIndex) => {
                const valid = pricingTierDraftValid(tier, previousTierSize)
                const numericSize = Number(tier && tier.size)
                if (Number.isSafeInteger(numericSize)) previousTierSize = numericSize
                return React.createElement('div', { key: tierIndex, className: 'uh-pricing-tier-edit-row' + (valid ? '' : ' uh-invalid') },
                  React.createElement('input', { type: 'number', min: '1', max: '1000000000', step: '1', placeholder: tr('阈值 Token', 'Token threshold'), title: tr('上下文超过此 Token 数时启用本档', 'Use this band when context exceeds this token count'), 'aria-label': tr('上下文阈值 Token', 'Context threshold tokens'), value: tier.size === undefined ? '' : tier.size, onChange: (event) => updatePricingOverrideTier(index, tierIndex, 'size', event.target.value) }),
                  React.createElement('input', { type: 'number', min: '0', step: 'any', placeholder: tr('输入价 / 1M', 'Input / 1M'), 'aria-label': tr('档位输入价格 / 1M', 'Tier input price / 1M'), value: tier.input === undefined ? '' : tier.input, onChange: (event) => updatePricingOverrideTier(index, tierIndex, 'input', event.target.value) }),
                  React.createElement('input', { type: 'number', min: '0', step: 'any', placeholder: tr('输出价 / 1M', 'Output / 1M'), 'aria-label': tr('档位输出价格 / 1M', 'Tier output price / 1M'), value: tier.output === undefined ? '' : tier.output, onChange: (event) => updatePricingOverrideTier(index, tierIndex, 'output', event.target.value) }),
                  React.createElement('input', { type: 'number', min: '0', step: 'any', placeholder: tr('缓存读 / 1M', 'Cache read / 1M'), 'aria-label': tr('档位缓存读取价格 / 1M', 'Tier cache read price / 1M'), value: tier.cacheRead === undefined ? '' : tier.cacheRead, onChange: (event) => updatePricingOverrideTier(index, tierIndex, 'cacheRead', event.target.value) }),
                  React.createElement('input', { type: 'number', min: '0', step: 'any', placeholder: tr('缓存写 / 1M', 'Cache write / 1M'), 'aria-label': tr('档位缓存写入价格 / 1M', 'Tier cache write price / 1M'), value: tier.cacheWrite === undefined ? '' : tier.cacheWrite, onChange: (event) => updatePricingOverrideTier(index, tierIndex, 'cacheWrite', event.target.value) }),
                  React.createElement('button', { type: 'button', className: 'uh-refresh uh-icon-button', title: tr('删除费率档位', 'Remove rate band'), 'aria-label': tr('删除费率档位', 'Remove rate band'), onClick: () => removePricingOverrideTier(index, tierIndex) }, React.createElement(LineIcon, { name: 'close', size: 14 })),
                )
              })
              return React.createElement('div', { key: index, className: 'uh-pricing-override' },
                React.createElement('div', { className: 'uh-pricing-edit-row uh-pricing-price-row' },
                  React.createElement('div', { className: 'uh-pricing-used-model-picker' },
                    React.createElement('input', { type: 'text', className: 'uh-pricing-used-model-input', placeholder: tr('选择当前用过的模型', 'Select a used model'), value: pricingOverrideSearchText[index] !== undefined ? pricingOverrideSearchText[index] : (entry.modelId || ''), 'aria-label': tr('覆盖模型 ID', 'Override model ID'), 'aria-haspopup': 'listbox', 'aria-expanded': pricingOverrideOpen === index, onFocus: () => { setPricingOverrideOpen(index); setPricingOverrideSearchText((prev) => Object.assign({}, prev, { [index]: '' })) }, onClick: () => setPricingOverrideOpen(index), onBlur: () => setTimeout(() => { setPricingOverrideOpen((current) => current === index ? null : current); if (entry.modelId) setPricingOverrideSearchText((prev) => Object.assign({}, prev, { [index]: entry.modelId })) }, 120), onKeyDown: (event) => { if (event.key === 'Escape') setPricingOverrideOpen(null) }, onChange: (event) => searchPricingOverrideModels(index, event.target.value) }),
                    pricingOverrideOpen === index && overrideModelOptions.length > 0 ? React.createElement('div', { className: 'uh-language-options uh-pricing-used-model-options', role: 'listbox', 'aria-label': tr('当前用过的模型', 'Used models') },
                      overrideModelOptions.map((option) => React.createElement('button', { key: option.value, type: 'button', role: 'option', className: 'uh-language-option uh-pricing-model-option', onMouseDown: (event) => event.preventDefault(), onClick: () => selectPricingOverrideModel(index, option.value) },
                        React.createElement(LineIcon, { name: 'list', size: 14 }),
                        React.createElement('span', { className: 'uh-pricing-model-option-name' }, option.label),
                      )),
                    ) : null,
                  ),
                  React.createElement('input', { type: 'number', min: '0', step: 'any', placeholder: tr('输入价 / 1M', 'Input / 1M'), title: tr('基础输入价格，美元 / 100 万 Token', 'Base input price, USD / 1M tokens'), 'aria-label': tr('基础输入价格 / 1M', 'Base input price / 1M'), value: entry.input === undefined ? '' : entry.input, onChange: (event) => updatePricingOverride(index, 'input', event.target.value) }),
                  React.createElement('input', { type: 'number', min: '0', step: 'any', placeholder: tr('输出价 / 1M', 'Output / 1M'), title: tr('基础输出价格，美元 / 100 万 Token', 'Base output price, USD / 1M tokens'), 'aria-label': tr('基础输出价格 / 1M', 'Base output price / 1M'), value: entry.output === undefined ? '' : entry.output, onChange: (event) => updatePricingOverride(index, 'output', event.target.value) }),
                  React.createElement('input', { type: 'number', min: '0', step: 'any', placeholder: tr('缓存读 / 1M', 'Cache read / 1M'), title: tr('基础缓存读取价格，美元 / 100 万 Token', 'Base cache read price, USD / 1M tokens'), 'aria-label': tr('基础缓存读取价格 / 1M', 'Base cache read price / 1M'), value: entry.cacheRead === undefined ? '' : entry.cacheRead, onChange: (event) => updatePricingOverride(index, 'cacheRead', event.target.value) }),
                  React.createElement('input', { type: 'number', min: '0', step: 'any', placeholder: tr('缓存写 / 1M', 'Cache write / 1M'), title: tr('基础缓存写入价格，美元 / 100 万 Token', 'Base cache write price, USD / 1M tokens'), 'aria-label': tr('基础缓存写入价格 / 1M', 'Base cache write price / 1M'), value: entry.cacheWrite === undefined ? '' : entry.cacheWrite, onChange: (event) => updatePricingOverride(index, 'cacheWrite', event.target.value) }),
                  React.createElement('button', { type: 'button', className: 'uh-refresh uh-icon-button', title: tr('删除价格覆盖', 'Remove price override'), 'aria-label': tr('删除价格覆盖', 'Remove price override'), onClick: () => removePricingOverride(index) }, React.createElement(LineIcon, { name: 'close', size: 14 })),
                ),
                React.createElement('div', { className: 'uh-pricing-tier-editor' },
                  React.createElement('div', { className: 'uh-pricing-tier-editor-head' },
                    React.createElement('div', { className: 'uh-pricing-tier-editor-title' },
                      React.createElement('strong', {}, tr('上下文费率档位', 'Context rate bands')),
                      React.createElement('span', {}, tr('超过阈值后，整次请求使用该档四项费率', 'Above a threshold, all four rates apply to the whole request')),
                    ),
                    React.createElement('button', { type: 'button', className: 'uh-refresh', disabled: tiers.length >= 32, title: tiers.length >= 32 ? tr('每个模型最多 32 个档位', 'Maximum 32 bands per model') : tr('添加上下文费率档位', 'Add context rate band'), onClick: () => addPricingOverrideTier(index) }, React.createElement(LineIcon, { name: 'plus', size: 13 }), tr('添加档位', 'Add band')),
                  ),
                  tiers.length === 0 ? React.createElement('div', { className: 'uh-pricing-tier-empty' }, tr('未配置档位，所有上下文使用基础费率。', 'No bands configured; base rates apply to every context.')) : React.createElement(React.Fragment, null,
                    React.createElement('div', { className: 'uh-pricing-tier-edit-head' },
                      React.createElement('span', {}, tr('超过 Token', 'Above tokens')),
                      React.createElement('span', {}, tr('输入 / 1M', 'Input / 1M')),
                      React.createElement('span', {}, tr('输出 / 1M', 'Output / 1M')),
                      React.createElement('span', {}, tr('缓存读 / 1M', 'Cache read / 1M')),
                      React.createElement('span', {}, tr('缓存写 / 1M', 'Cache write / 1M')),
                      React.createElement('span', {}, ''),
                    ),
                    tierEditors,
                  ),
                ),
              )
            })),
          ),
        ),
        pricingError !== '' ? React.createElement('div', { className: 'uh-pricing-error', role: 'alert' }, pricingError === 'forbidden' ? tr('没有权限保存成本设置', 'Not allowed to save cost settings') : pricingError === 'token' ? tr('当前进程令牌不可用，请刷新看板', 'The process capability is unavailable; refresh the dashboard') : pricingError === 'sync' ? tr('models.dev 同步失败，已保留上次成功目录和未保存编辑', 'models.dev sync failed; the last good catalog and unsaved edits were kept') : pricingError === 'mapping' ? tr('模型映射无效：请选择当前模型、官方模型并填写有效倍率', 'Invalid model mapping: select a used model, an official model, and a valid multiplier') : pricingError === 'tier' ? tr('费率档位无效：最多 32 档；阈值必须为递增的正整数，四项费率必须完整且非负', 'Invalid rate bands: maximum 32; thresholds must be increasing positive integers and all four rates must be complete and non-negative') : pricingError === 'override' ? tr('价格覆盖无效：请选择模型并填写完整的非负基础费率', 'Invalid price override: select a model and enter all non-negative base rates') : tr('成本设置保存失败，请检查输入', 'Cost settings could not be saved; check the inputs')) : null,
        React.createElement('div', { className: 'uh-pricing-foot' },
          React.createElement('span', { className: 'uh-note' }, tr('保存不会重算已有正成本；回填只处理未计价调用。', 'Saving does not recalculate existing positive costs; backfill only handles unpriced calls.')),
          React.createElement('div', { className: 'uh-actions' },
            React.createElement('button', { type: 'button', className: 'uh-refresh', disabled: pricingSaving || pricingSyncing || pricingSyncSaving, onClick: closePricingPanel }, tr('取消', 'Cancel')),
            React.createElement('button', { type: 'button', className: 'uh-refresh', disabled: pricingSaving || pricingSyncing || pricingSyncSaving, onClick: () => savePricingSettings(false) }, pricingSaving ? tr('保存中…', 'Saving…') : tr('保存', 'Save')),
            React.createElement('button', { type: 'button', className: 'uh-refresh uh-pricing-backfill', disabled: pricingSaving || pricingSyncing || pricingSyncSaving, onClick: () => savePricingSettings(true) }, tr('保存并回填', 'Save and backfill')),
          ),
        ),
      ) : React.createElement('div', { className: 'uh-panel uh-pricing-panel uh-anim-panel' },
        React.createElement('div', { className: 'uh-pricing-head' },
          React.createElement('div', { className: 'uh-title-with-icon' }, React.createElement(LineIcon, { name: 'wallet', size: 16 }), React.createElement('strong', {}, tr('成本统计设置', 'Cost Statistics'))),
          React.createElement('button', { type: 'button', className: 'uh-refresh uh-icon-button', title: tr('关闭成本设置', 'Close cost settings'), 'aria-label': tr('关闭成本设置', 'Close cost settings'), disabled: pricingSaving || pricingSyncing || pricingSyncSaving, onClick: closePricingPanel }, React.createElement(LineIcon, { name: 'close', size: 16 })),
        ),
        pricingLoading ? React.createElement('div', { className: 'uh-empty', role: 'status', style: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10 } },
          React.createElement('span', { className: 'uh-trend-spinner', 'aria-hidden': true }),
          React.createElement('span', {}, tr('正在加载完整费率设置…', 'Loading full pricing settings…')),
        ) : React.createElement('div', { className: 'uh-empty', role: 'alert' },
          React.createElement('div', {}, tr('完整费率设置加载失败', 'Full pricing settings could not be loaded')),
          React.createElement('button', { type: 'button', className: 'uh-refresh', style: { marginTop: 10 }, onClick: openPricingPanel }, React.createElement(LineIcon, { name: 'refresh', size: 14 }), tr('重试', 'Retry')),
        ),
      )
      const pricingPanel = pricingOpen ? React.createElement(MemoUsagePricingDialog, { revision: pricingRenderRevision, render: renderPricingPanel }) : null

      const rangeLabel = range === 'custom' && activeCustomRange !== null
        ? (language === 'en' ? activeCustomRange.start + ' to ' + activeCustomRange.end + ' (UTC)' : activeCustomRange.start + ' 至 ' + activeCustomRange.end)
        : range === 'today' ? tr('今日', 'Today') : range === '30d' ? tr('近 30 天', 'Last 30 Days') : range === '90d' ? tr('近 90 天', 'Last 90 Days') : tr('全部', 'All Time')
      const rangeFilePart = rangeFilenamePart(range, activeCustomRange, useUtc)
      const customRangeErrorText = customDraftIssue === 'invalid'
        ? tr('请选择有效的开始日期和结束日期', 'Choose valid start and end dates')
        : customDraftIssue === 'order'
          ? tr('结束日期不能早于开始日期', 'End date must be on or after the start date')
          : customDraftIssue === 'bounds'
            ? tr('可选范围为 ' + earliestAvailableDate + ' 至 ' + latestCalendarDate, 'Choose a date from ' + earliestAvailableDate + ' to ' + latestCalendarDate)
            : ''
      const customRangePanel = customRangeOpen ? React.createElement('div', { className: 'uh-custom-range', role: 'group', 'aria-label': tr('自定义时间范围', 'Custom date range') },
        React.createElement('div', { className: 'uh-custom-range-meta' },
          React.createElement('div', { className: 'uh-custom-range-title' }, React.createElement(LineIcon, { name: 'calendar', size: 15 }), tr('自定义时间范围', 'Custom date range')),
          React.createElement('div', { className: 'uh-custom-range-note' }, tr('可查看全部可扫描历史日数据；中文按本地日期，English 按 UTC。热力图始终展示最近 53 周。', 'All available historical daily data can be selected. Chinese uses local dates; English uses UTC. The heatmap always shows the latest 53 weeks.')),
        ),
        React.createElement('div', { className: 'uh-custom-range-fields' },
          React.createElement('label', { className: 'uh-custom-range-field' },
            React.createElement('span', {}, tr('开始日期', 'Start date')),
            React.createElement('input', { type: 'date', value: customDraft.start, min: earliestAvailableDate, max: latestCalendarDate, onChange: (event) => setCustomDraft((prev) => Object.assign({}, prev, { start: event.target.value })) }),
          ),
          React.createElement('label', { className: 'uh-custom-range-field' },
            React.createElement('span', {}, tr('结束日期', 'End date')),
            React.createElement('input', { type: 'date', value: customDraft.end, min: earliestAvailableDate, max: latestCalendarDate, onChange: (event) => setCustomDraft((prev) => Object.assign({}, prev, { end: event.target.value })) }),
          ),
        ),
        React.createElement('div', { className: 'uh-custom-range-actions' },
          React.createElement('button', { type: 'button', className: 'uh-custom-range-cancel', onClick: () => setCustomRangeOpen(false) }, tr('取消', 'Cancel')),
          React.createElement('button', { type: 'button', className: 'uh-custom-range-apply', disabled: customDraftIssue !== '', onClick: applyCustomRange }, tr('应用', 'Apply')),
        ),
        customRangeErrorText !== '' ? React.createElement('div', { className: 'uh-custom-range-error', role: 'alert' }, customRangeErrorText) : null,
      ) : null
      const trendPanel = React.createElement(MemoUsageTrendChart, {
        key: trendAnimationKey,
        rows: trendRows,
        visible: trendVisible,
        language,
        rangeLabel,
        loading: queryLoading && !queryReady,
        error: queryError !== '' && queryError !== 'stale' && !queryUsable ? tr('趋势数据加载失败', 'Trend data unavailable') : '',
        onToggle: toggleTrendSeries,
        onPointClick: openAuditForDate,
      })
      const detailScopeLabel = selectedDetailScope === null
        ? rangeLabel
        : selectedDetailScope.start === selectedDetailScope.end
          ? selectedDetailScope.start
          : selectedDetailScope.start + ' → ' + selectedDetailScope.end
      const exportAuditCsv = async () => {
        if (detailView !== 'logs' || selectedDetailScope === null || auditExporting) return
        const expectedQueryVersion = liveQueryVersion
        setAuditExporting(true)
        setAuditError('')
        try {
          let cursor = null
          const all = []
          for (let page = 0; page < 50; page += 1) {
            const data = await getUsageRecords(selectedDetailScope, cursor, 200)
            if (data === null || typeof data !== 'object' || !Array.isArray(data.items) || expectedQueryVersion === null || queryVersion(data) !== expectedQueryVersion) throw new Error('audit export stale')
            all.push(...data.items)
            if (!data.hasMore || !data.nextCursor) break
            cursor = data.nextCursor
          }
          const quote = (value) => '"' + String(value === undefined || value === null ? '' : value).replace(/"/g, '""') + '"'
          const line = (values) => values.map(quote).join(',')
          const headers = [tr('时间', 'Time'), tr('日期', 'Date'), tr('Provider', 'Provider'), tr('请求模型', 'Requested model'), tr('实际模型', 'Actual model'), tr('显示模型', 'Display model'), 'turn', 'step', 'seq', tr('输入', 'Input'), tr('缓存命中', 'Cache read'), tr('缓存写入', 'Cache write'), tr('输出', 'Output'), tr('推理', 'Reasoning'), tr('成本', 'Cost'), tr('计价状态', 'Cost status'), tr('计价模型', 'Pricing model'), tr('计费档位', 'Billing band'), tr('计费时刻(UTC)', 'Billing time (UTC)'), tr('计费时间来源', 'Billing time source'), tr('计费策略', 'Billing policy'), tr('策略哈希', 'Policy hash'), tr('来源', 'Source')]
          const lines = [line([tr('DSH 用量明细导出', 'DSH Usage Audit Export')]), line([tr('范围', 'Scope'), selectedDetailScope.start + ' → ' + selectedDetailScope.end]), line([tr('时区', 'Timezone'), selectedDetailScope.utc ? 'UTC' : tr('本地', 'Local')]), line(headers)]
          for (const row of all) lines.push(line([row.time, row.date, row.provider, row.requestedModel, row.actualModel, row.model, row.turn, row.step, row.seq, auditToken(row, 'input'), auditToken(row, 'cacheRead'), auditToken(row, 'cacheWrite'), auditToken(row, 'output'), auditToken(row, 'reasoning'), row.cost && row.cost.status === 'priced' ? row.cost.total : '', row.cost && row.cost.status ? row.cost.status : 'unpriced', row.cost && row.cost.pricingModel ? row.cost.pricingModel : '', row.cost && row.cost.pricingBand ? row.cost.pricingBand : '', row.cost && Number.isFinite(row.cost.pricingAt) ? new Date(row.cost.pricingAt).toISOString() : '', row.cost && row.cost.pricingTimeSource ? row.cost.pricingTimeSource : '', row.cost && row.cost.pricingPolicyId ? row.cost.pricingPolicyId : '', row.cost && row.cost.pricingPolicyHash ? row.cost.pricingPolicyHash : '', row.materialization || 'unknown']))
          const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' })
          const url = URL.createObjectURL(blob)
          const anchor = document.createElement('a')
          anchor.href = url
          anchor.download = 'dsh-all-usage-audit-' + selectedDetailScope.start + '-to-' + selectedDetailScope.end + '.csv'
          document.body.appendChild(anchor); anchor.click(); anchor.remove()
          URL.revokeObjectURL(url)
        } catch (err) {
          setAuditError('audit-export')
        } finally {
          setAuditExporting(false)
        }
      }
      const recordsPanel = React.createElement(MemoUsageRecordsPanel, {
        visible: detailView === 'logs',
        panelRef: recordsPanelRef,
        scopeLabel: detailScopeLabel,
        scopeUtc: !!(selectedDetailScope && selectedDetailScope.utc),
        scopeAvailable: selectedDetailScope !== null,
        loading: auditLoading,
        exporting: auditExporting,
        error: auditError,
        rows: auditRows,
        selectedId: auditSelectedId,
        hasMore: auditHasMore,
        language,
        actionKey: detailKey + ':' + (liveQueryVersion || '') + ':' + (auditCursor || ''),
        onExport: exportAuditCsv,
        onLoadMore: loadMoreAudit,
        onSelect: setAuditSelectedId,
      })
      const scanning = !scan.done
      const pct = scan.total > 0 ? Math.min(100, Math.round((scan.scanned / scan.total) * 100)) : 40
      const isEmpty = scan.done && dayRows.length === 0 && agg.totals.turns === 0 && agg.totals.calls === 0
      const syncCompletedAt = typeof sync.lastCompletedAt === 'number' && sync.lastCompletedAt > 0 ? new Date(sync.lastCompletedAt).toLocaleString(language === 'en' ? 'en-US' : 'zh-CN') : ''
      const lastStatsText = lastStatsAt > 0 ? new Date(lastStatsAt).toLocaleString(language === 'en' ? 'en-US' : 'zh-CN') : ''
      const healthTitle = syncCompletedAt === '' ? undefined : (language === 'en' ? 'Historical scan completed ' + syncCompletedAt : '历史扫描完成于 ' + syncCompletedAt)
      const healthText = language === 'en'
        ? (lastStatsText !== '' ? 'Updated ' + lastStatsText : (scanning ? 'Refreshing data' : 'Update state pending'))
          + ' · ' + (sync.sessionsSkippedByRevision || 0) + ' revision reused'
          + ' · ' + (sync.sessionsRead || 0) + ' read'
          + ((sync.sessionsRestoredFromLedger || 0) > 0 ? ' · ' + sync.sessionsRestoredFromLedger + ' ledger restored' : '')
          + ((sync.sessionsFailed || 0) > 0 ? ' · ' + sync.sessionsFailed + ' failed' : '')
          + ' · ' + (sync.persistenceSnapshotsAvailable === true ? 'revision optimization on' : 'full-read fallback')
        : (lastStatsText !== '' ? '已更新 ' + lastStatsText : (scanning ? '正在更新数据' : '数据更新准备中'))
          + ' · revision 复用 ' + (sync.sessionsSkippedByRevision || 0)
          + ' · 实际读取 ' + (sync.sessionsRead || 0)
          + ((sync.sessionsRestoredFromLedger || 0) > 0 ? ' · 账本恢复 ' + sync.sessionsRestoredFromLedger : '')
          + ((sync.sessionsFailed || 0) > 0 ? ' · 失败 ' + sync.sessionsFailed : '')
          + ' · ' + (sync.persistenceSnapshotsAvailable === true ? '免读优化已启用' : '全量读取回退')
      const staleText = statsError === '' ? '' : (language === 'en'
        ? 'Usage data may be stale' + (lastStatsText !== '' ? '; last full update ' + lastStatsText : '')
        : '用量数据可能已过期' + (lastStatsText !== '' ? '；上次完整更新 ' + lastStatsText : ''))

      return React.createElement('div', { className: 'uh-page' },
        React.createElement('div', { className: 'uh-head' },
          React.createElement('div', { className: 'uh-title-wrap' },
            React.createElement('h2', { className: 'uh-title' }, tr('用量统计', 'Usage Statistics')),
          ),
          React.createElement('div', { className: 'uh-actions' },
            React.createElement('button', {
              className: 'uh-refresh',
              title: tr('管理工作区别名', 'Manage workspace aliases'),
              onClick: () => { if (aliasOpen) setAliasOpen(false); else openAliasPanel() },
            }, React.createElement(LineIcon, { name: 'edit', size: 14 }), tr('工作区别名', 'Workspace Aliases')),
            React.createElement('button', {
              className: 'uh-refresh',
              title: tr('配置模型价格与同步', 'Configure model prices and sync'),
              disabled: pricingSaving || pricingSyncing || pricingSyncSaving,
              onClick: () => { if (pricingOpen) closePricingPanel(); else openPricingPanel() },
            }, React.createElement(LineIcon, { name: 'wallet', size: 14 }), tr('成本设置', 'Cost Settings')),
            React.createElement('div', {
              className: 'uh-language-menu' + (languageMenuOpen ? ' uh-open' : ''),
              ref: languageMenuRef,
              onKeyDown: (event) => { if (event.key === 'Escape') { event.preventDefault(); setLanguageMenuOpen(false) } },
            },
              React.createElement('button', {
                type: 'button',
                className: 'uh-language-trigger' + (languageMenuOpen ? ' uh-open' : ''),
                title: tr('切换界面语言', 'Change interface language'),
                'aria-label': tr('界面语言', 'Interface language'),
                'aria-haspopup': 'menu',
                'aria-expanded': languageMenuOpen,
                onClick: () => setLanguageMenuOpen((open) => !open),
              },
                React.createElement(LineIcon, { name: 'language', size: 14 }),
                React.createElement('span', { className: 'uh-language-label' }, language === 'en' ? 'English' : '中文'),
                React.createElement(LineIcon, { name: 'chevron', size: 13, className: 'uh-language-caret' }),
              ),
              languageMenuOpen ? React.createElement('div', { className: 'uh-language-options', role: 'menu', 'aria-label': tr('界面语言', 'Interface language') },
                [['zh', '中文'], ['en', 'English']].map((entry) => React.createElement('button', {
                  key: entry[0],
                  type: 'button',
                  role: 'menuitemradio',
                  'aria-checked': language === entry[0],
                  className: 'uh-language-option' + (language === entry[0] ? ' uh-on' : ''),
                  onClick: () => chooseLanguage(entry[0]),
                },
                  React.createElement(LineIcon, { name: 'language', size: 14 }),
                  React.createElement('span', {}, entry[1]),
                  language === entry[0] ? React.createElement(LineIcon, { name: 'check', size: 14, className: 'uh-language-option-check' }) : null,
                )),
              ) : null,
            ),
            React.createElement('div', { className: 'uh-range' },
              ['today', '30d', '90d', 'all', 'custom'].map((r) => React.createElement('button', {
                key: r,
                type: 'button',
                className: range === r ? 'uh-on' : '',
                title: r === 'custom' && range === 'custom' ? rangeLabel : undefined,
                onClick: () => { if (r === 'custom') openCustomRange(); else chooseRange(r) },
              }, r === 'today' ? tr('今日', 'Today') : r === '30d' ? tr('近 30 天', 'Last 30 Days') : r === '90d' ? tr('近 90 天', 'Last 90 Days') : r === 'all' ? tr('全部', 'All Time') : tr('自定义', 'Custom'))),
            ),
            React.createElement('button', { className: 'uh-refresh', title: tr('导出当前时间范围与模型查看模式的 CSV 数据', 'Export CSV data for the current time range and model view'), onClick: exportCsv }, React.createElement(LineIcon, { name: 'export', size: 14 }), tr('导出数据', 'Export Data')),
            React.createElement('button', { className: 'uh-refresh uh-icon-button', title: tr('刷新统计数据', 'Refresh usage statistics'), 'aria-label': tr('刷新统计数据', 'Refresh usage statistics'), onClick: onRefresh }, React.createElement(LineIcon, { name: 'refresh', size: 16 })),
          ),
        ),
        React.createElement('div', { className: 'uh-filter-bar', role: 'group', 'aria-label': tr('统一筛选', 'Unified filters') },
          React.createElement(UsageFilterMenu, {
            label: tr('全部工作区', 'All workspaces'),
            ariaLabel: tr('工作区筛选', 'Workspace filter'),
            className: 'uh-filter-workspace',
            icon: 'folder',
            value: wsFilter || '',
            options: [{ value: '', label: tr('全部工作区', 'All workspaces') }].concat(rangeWorkspaceOptions.map((w) => ({ value: w.id, label: wsTitle(w.id) }))),
            onChange: (value) => setWsFilter(value || null),
          }),
          React.createElement(UsageFilterMenu, {
            label: tr('全部供应商', 'All providers'),
            ariaLabel: tr('供应商筛选', 'Provider filter'),
            className: 'uh-filter-provider',
            icon: 'chart',
            value: providerFilter || '',
            options: [{ value: '', label: tr('全部供应商', 'All providers') }].concat(providerOptions.map((value) => ({ value, label: value }))),
            onChange: (value) => chooseProvider(value),
          }),
          React.createElement(UsageFilterMenu, {
            label: tr('全部模型', 'All models'),
            ariaLabel: tr('模型筛选', 'Model filter'),
            className: 'uh-filter-model',
            icon: 'cache',
            value: modelFilter || '',
            options: [{ value: '', label: tr('全部模型', 'All models') }].concat(modelOptions.map((value) => ({ value, label: value }))),
            onChange: (value) => chooseModel(value),
          }),
          (wsFilter !== null || providerFilter !== null || modelFilter !== null) ? React.createElement('button', { type: 'button', className: 'uh-filter-clear', onClick: clearFilters }, tr('清除筛选', 'Clear filters')) : null,
          queryLoading ? React.createElement('span', { className: 'uh-query-note' }, tr('正在更新筛选结果…', 'Updating filtered data…')) : null,
          queryError !== '' && queryError !== 'stale' ? React.createElement('span', { className: 'uh-query-note', role: 'alert' }, tr('筛选结果加载失败', 'Filtered data unavailable')) : null,
        ),
        aliasOpen ? aliasPanel : null,
        pricingPanel,
        customRangePanel,
        scanning ? React.createElement('div', { className: 'uh-progress' },
          React.createElement('span', {}, language === 'en' ? 'Scanning historical sessions: ' + scan.scanned + ' / ' + scan.total + (scan.failed > 0 ? ' (' + scan.failed + ' failed to read)' : '') : '正在统计历史会话 ' + scan.scanned + ' / ' + scan.total + (scan.failed > 0 ? '（' + scan.failed + ' 个读取失败）' : '')),
          React.createElement('div', { className: 'uh-bar' }, React.createElement('div', { className: 'uh-fill', style: { width: pct + '%' } })),
        ) : null,
        React.createElement('div', { className: 'uh-sync-health' + (staleText !== '' ? ' uh-stale' : ''), title: staleText !== '' ? undefined : healthTitle },
          React.createElement(LineIcon, { name: staleText !== '' ? 'refresh' : 'clock', size: 14 }),
          React.createElement('span', {}, staleText !== '' ? staleText : healthText),
          staleText !== '' ? React.createElement('button', { className: 'uh-sync-retry', onClick: onRefresh }, tr('重试', 'Retry')) : null,
        ),
        isEmpty ? React.createElement('div', { className: 'uh-panel' },
          React.createElement('div', { className: 'uh-empty' }, tr('还没有使用记录。开始对话后，这里会点亮。', 'No usage recorded yet. This area will light up after you start a conversation.')),
        ) : React.createElement(React.Fragment, null,
          React.createElement(React.Fragment, null,
          React.createElement('div', { className: 'uh-ios-summary' },
            React.createElement('div', { className: 'uh-ios-summary-hero' },
              React.createElement('div', { className: 'uh-ios-summary-total' },
                React.createElement('div', { className: 'uh-ios-summary-total-icon' }, React.createElement(LineIcon, { name: 'chart', size: 24 })),
                React.createElement('div', { className: 'uh-ios-summary-total-copy' },
                  React.createElement('div', { className: 'uh-ios-summary-label' }, tr('总处理 Token', 'Total Tokens Processed')),
                  React.createElement('div', { className: 'uh-ios-summary-value' }, valueWithMagnitude(fmtCompact(animatedTotal), totalTokens, language)),
                  React.createElement('div', { className: 'uh-ios-summary-caption' }, language === 'en' ? rangeLabel + ' · ' + fmtCompact(animatedTurns) + (scopedCountIsCalls ? ' calls' : ' uses') + ' · includes cache reads/writes and reasoning' : rangeLabel + ' · ' + fmtCompact(animatedTurns) + (scopedCountIsCalls ? ' 次调用' : ' 次使用') + ' · 含缓存读写与推理'),
                ),
              ),
              React.createElement('div', { className: 'uh-ios-summary-meta' },
                React.createElement('div', { className: 'uh-ios-summary-meta-stat' },
                  React.createElement('div', { className: 'uh-ios-summary-meta-label' }, React.createElement(LineIcon, { name: 'chart', size: 16 }), tr('总请求数', 'Total Requests')),
                  React.createElement('div', { className: 'uh-ios-summary-meta-value' }, fmtCount(animatedRequests, language)),
                ),
                React.createElement('div', { className: 'uh-ios-summary-meta-stat uh-ios-summary-meta-cost' },
                  React.createElement('div', { className: 'uh-ios-summary-meta-label' }, React.createElement(LineIcon, { name: 'wallet', size: 16 }), tr('估算成本', 'Estimated Cost')),
                  React.createElement('div', { className: 'uh-ios-summary-meta-value' }, costValue),
                  React.createElement('div', { className: 'uh-ios-summary-meta-caption' }, costCoverage),
                ),
              ),
            ),
            React.createElement('div', { className: 'uh-ios-metrics' },
              card(tr('DeepSeek 账户余额', 'DeepSeek Account Balance'), balanceValue, balanceSub, 0, 'wallet'),
              card(scopedCountIsCalls ? tr('匹配调用次数', 'Matching Calls') : tr('总使用次数', 'Total Uses'), fmtCompact(animatedTurns), range === 'all' && !scopedCountIsCalls ? (language === 'en' ? agg.totals.sessions + ' sessions' : agg.totals.sessions + ' 个会话') : (language === 'en' ? (scopedCountIsCalls ? 'Calls in ' : 'Turns in ') + rangeLabel : rangeLabel + (scopedCountIsCalls ? '内的调用数' : '内的回合数')), 1, 'chart'),
              card(tr('连续使用', 'Current Streak'), language === 'en' ? st.streak + ' days' : st.streak + ' 天', language === 'en' ? 'Longest streak: ' + st.best + ' days' : '最长连续 ' + st.best + ' 天', 2, 'clock'),
              tokenCard,
              summaryRateMetric,
            ),
          ),
          React.createElement('div', { className: 'uh-token-semantics' },
            React.createElement(LineIcon, { name: 'cache', size: 16 }),
            tr('总处理 Token = 输入 + 输出 + 缓存读写 + 推理。缓存命中代表复用上下文，不等于新生成 Token 或实际费用。成本按事件发生时刻与官方价目估算，不等同于供应商账单。', 'Total tokens processed = input + output + cache reads/writes + reasoning. Cache hits represent reused context; they are not newly generated tokens or actual cost. Costs are estimated at event time from official price lists and do not equal the provider invoice.'),
          ),
          trendPanel,
          React.createElement(MemoUsageHeatmap, {
            rows: displayedHeatmap,
            workspaces,
            aliases,
            workspaceId: wsFilter,
            queryUsable,
            todayKey: latestCalendarDate,
            utc: useUtc,
            language,
            onWorkspaceSelect: toggleFilter,
            onDateClick: openAuditForDate,
          }),
          React.createElement('div', { className: 'uh-detail-tabs', role: 'tablist', 'aria-label': tr('用量明细视图', 'Usage detail views') },
            [['logs', tr('请求日志', 'Request Logs'), 'list'], ['model', tr('模型统计', 'Model Stats'), 'chart'], ['workspace', tr('工作区统计', 'Workspace Stats'), 'folder']].map((entry) => React.createElement('button', { key: entry[0], type: 'button', role: 'tab', 'aria-selected': detailView === entry[0], className: 'uh-detail-tab' + (detailView === entry[0] ? ' uh-on' : ''), onClick: () => setDetailView(entry[0]) }, React.createElement(LineIcon, { name: entry[2], size: 14 }), entry[1])),
          ),
          recordsPanel,
          ),
          detailView === 'model' ? React.createElement('div', { className: 'uh-panel uh-ios-list-panel' },
            React.createElement('div', { className: 'uh-hm-head' },
              React.createElement('h3', { className: 'uh-tbl-title uh-title-with-icon', style: { margin: 0 } }, React.createElement(LineIcon, { name: 'chart', size: 16 }), language === 'en' ? 'Model Usage Details (' + rangeLabel + ')' : '模型用量明细（' + rangeLabel + '）'),
              React.createElement('div', { className: 'uh-range' },
                [['route', tr('混合查看', 'Combined View')], ['model', tr('按模型', 'By Model')], ['provider', tr('按供应商', 'By Provider')]].map((entry) => React.createElement('button', {
                  key: entry[0], className: modelView === entry[0] ? 'uh-on' : '', onClick: () => setModelView(entry[0]),
                }, entry[1])),
              ),
            ),
            modelRows.length === 0
              ? React.createElement('div', { className: 'uh-empty' }, tr('尚无带模型路由信息的用量记录', 'No usage records with model-routing information yet'))
              : React.createElement(React.Fragment, null,
                modelDonutChart,
                React.createElement('div', { className: 'uh-tbl-scroll' },
                  React.createElement('div', { className: 'uh-model-hrow uh-hrow' },
                    React.createElement('div', {}, modelColumnLabel),
                    React.createElement('div', { className: 'uh-num' }, tr('调用', 'Calls')),
                    React.createElement('div', { className: 'uh-num' }, tr('输入', 'Input')),
                    React.createElement('div', { className: 'uh-num' }, tr('缓存命中', 'Cache Hits')),
                    React.createElement('div', { className: 'uh-num' }, tr('输出', 'Output')),
                    React.createElement('div', { className: 'uh-num' }, tr('推理', 'Reasoning')),
                    React.createElement('div', { className: 'uh-num' }, tr('总处理', 'Total Processed')),
                    React.createElement('div', { className: 'uh-num' }, tr('成本', 'Cost')),
                    React.createElement('div', { className: 'uh-num' }, tr('命中率', 'Hit Rate')),
                  ),
                  modelElements,
                ),
              ),
            React.createElement('div', { className: 'uh-note', style: { marginTop: 10 } }, language === 'en' ? modelViewLabel + ': Combined View distinguishes “Provider / Model”; By Model merges identically named models across providers; By Provider aggregates all of a provider’s models. Historical records without routing information are grouped as “Unknown.”' : modelViewLabel + '：混合查看按“供应商 / 模型”区分；按模型会跨供应商合并同名模型；按供应商则汇总其全部模型。缺少路由信息的历史记录会归为“未知”。'),
          ) : null,
          detailView === 'workspace' ? React.createElement('div', { className: 'uh-panel uh-ios-list-panel' },
            React.createElement('h3', { className: 'uh-tbl-title uh-title-with-icon' }, React.createElement(LineIcon, { name: 'folder', size: 16 }), language === 'en' ? 'Workspace Details (' + rangeLabel + ')' : '工作区明细（' + rangeLabel + '）'),
            rows.length === 0
              ? React.createElement('div', { className: 'uh-empty' }, tr('该时间范围内没有使用记录', 'No usage records in this time range'))
              : React.createElement(React.Fragment, null,
                workspaceDonutChart,
                React.createElement('div', { className: 'uh-tbl-scroll' },
                  React.createElement('div', { className: 'uh-hrow' },
                    React.createElement('div', {}, tr('工作区', 'Workspace')),
                    React.createElement('div', { className: 'uh-num' }, tr('回合', 'Turns')),
                    React.createElement('div', { className: 'uh-num' }, tr('输入', 'Input')),
                    React.createElement('div', { className: 'uh-num' }, tr('缓存命中', 'Cache Hits')),
                    React.createElement('div', { className: 'uh-num' }, tr('输出', 'Output')),
                    React.createElement('div', { className: 'uh-num' }, tr('推理', 'Reasoning')),
                    React.createElement('div', { className: 'uh-num' }, tr('总处理', 'Total Processed')),
                    React.createElement('div', { className: 'uh-num' }, tr('成本', 'Cost')),
                    React.createElement('div', { className: 'uh-num' }, tr('命中率', 'Hit Rate')),
                    React.createElement('div', { className: 'uh-num' }, tr('占比', 'Share')),
                  ),
                  rowElements,
                ),
              ),
          ) : null,
        ),
      )
    }

    class UsageDashboardBoundary extends React.Component {
      constructor(props) { super(props); this.state = { error: null, resetKey: props.resetKey } }
      static getDerivedStateFromError(error) { return { error } }
      componentDidUpdate(prevProps) {
        if (prevProps.resetKey !== this.props.resetKey && this.state.error !== null) this.setState({ error: null, resetKey: this.props.resetKey })
      }
      render() {
        if (this.state.error !== null) return this.props.fallback(this.state.error)
        return this.props.children
      }
    }
    function UsageSidebarEntry(props) {
      const [open, setOpen] = React.useState(false)
      const [dashboardResetKey, setDashboardResetKey] = React.useState(0)
      const [language, setLanguage] = React.useState(storedLanguage)
      const tr = (zh, en) => language === 'en' ? en : zh
      const dashboardFallback = () => React.createElement('div', { className: 'uh-boundary-fallback', role: 'alert' },
        React.createElement('div', { className: 'uh-boundary-title' }, tr('用量统计暂时无法显示', 'Usage statistics is temporarily unavailable')),
        React.createElement('div', { className: 'uh-boundary-note' }, tr('当前范围加载失败，入口仍然可用。', 'The selected range failed to render; the sidebar entry is still available.')),
        React.createElement('div', { className: 'uh-actions' },
          React.createElement('button', { type: 'button', className: 'uh-refresh', onClick: () => setDashboardResetKey((value) => value + 1) }, React.createElement(LineIcon, { name: 'refresh', size: 14 }), tr('重试', 'Retry')),
          React.createElement('button', { type: 'button', className: 'uh-refresh', onClick: () => setOpen(false) }, React.createElement(LineIcon, { name: 'close', size: 14 }), tr('关闭', 'Close')),
        ),
      )
      const changeLanguage = (next) => {
        const value = next === 'en' ? 'en' : 'zh'
        setLanguage(value)
        persistLanguage(value)
      }
      React.useEffect(() => {
        if (!open) return undefined
        const closeOnEscape = (event) => { if (event.key === 'Escape') setOpen(false) }
        document.addEventListener('keydown', closeOnEscape)
        return () => document.removeEventListener('keydown', closeOnEscape)
      }, [open])
      return React.createElement(React.Fragment, null,
        React.createElement('button', {
          type: 'button', className: 'uh-side-entry', title: tr('用量统计', 'Usage Statistics'), 'aria-label': tr('用量统计', 'Usage Statistics'), onClick: () => setOpen(true),
        }, React.createElement('span', { className: 'uh-side-entry-icon' }, React.createElement(LineIcon, { name: 'chart', size: 17 })), props.wide ? React.createElement('span', { className: 'uh-side-entry-label' }, tr('用量统计', 'Usage Statistics')) : null),
        open ? React.createElement('div', { className: 'uh-side-modal', role: 'presentation', onMouseDown: (event) => { if (event.target === event.currentTarget) setOpen(false) } },
          React.createElement('div', { className: 'uh-side-dialog', role: 'dialog', 'aria-modal': true, 'aria-label': tr('用量统计', 'Usage Statistics') },
            React.createElement('div', { className: 'uh-side-dialog-head' },
              React.createElement('button', { className: 'uh-refresh uh-close-button', type: 'button', title: tr('关闭用量统计', 'Close Usage Statistics'), 'aria-label': tr('关闭用量统计', 'Close Usage Statistics'), onClick: () => setOpen(false) }, React.createElement(LineIcon, { name: 'close', size: 18 })),
            ),
            React.createElement(UsageDashboardBoundary, { resetKey: dashboardResetKey, fallback: dashboardFallback }, React.createElement(UsagePage, { timerCtx: props.timerCtx, language, onLanguageChange: changeLanguage })),
          ),
        ) : null,
      )
    }

    exports.inject = ['timer', 'slots']
    exports.apply = (ctx) => {
      const slots = ctx.get('slots')
      const timer = ctx.get('timer')
      if (slots === undefined || timer === undefined) return
      slots.inject('sidebar.footer.action', () => slots.register(
        { name: 'sidebar.footer.action', id: 'all-usage', order: 10 },
        (props) => React.createElement(UsageSidebarEntry, { wide: props.wide, timerCtx: timer }),
      ))
    }
    return module.exports;
  }
});
