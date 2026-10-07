// dsh-all-usage 插件 Client 半（永久版，浏览器 bundle）
// 客户端模块工厂格式：window.__ModuleLoader__.load({ id, factory })
window.__ModuleLoader__.load({
  id: "dsh-all-usage",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");

    // Replaced at build time by scripts/build-client.mjs with the package
    // version, so the page can tell the user when the running host is older
    // than the bundle it is serving (DSH only imports the plugin at startup).
    const clientPluginVersion = /* __PLUGIN_VERSION__ */ "0.0.0"

    function pad2(n) {
      return String(n).padStart(2, '0')
    }
    // The desktop client keeps its own window buttons (minimise / maximise /
    // close) in a caption strip across the top of the window and marks the
    // document with `data-windows-titlebar` plus `--dsh-windows-titlebar-height`.
    // Anything the usage panel paints into that strip — the sheet, its grabber,
    // its close button — hides the desktop client's own close button, so the
    // panel keeps the whole strip clear. The host's marker is authoritative and
    // is therefore consulted first; a user agent never gets the last word.
    // Override for tuning without a rebuild:
    //   localStorage.setItem('dsh-all-usage:topInset', '72') // px, then reload
    let uhInsetSource = 'none'
    function uhWindowControlsInset() {
      uhInsetSource = 'none'
      try {
        // An unset key must never read as the number 0: Number(null) is 0, which
        // passes the range check below and silently reserves nothing at all.
        const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem('dsh-all-usage:topInset')
        if (raw !== null && raw !== '') {
          const stored = Number(raw)
          if (Number.isFinite(stored) && stored >= 0) { uhInsetSource = 'stored'; return Math.round(stored) }
        }
      } catch (error) { /* storage unavailable: fall through */ }
      try {
        const root = typeof document === 'undefined' ? null : document.documentElement
        if (root !== null && root.hasAttribute('data-windows-titlebar')) {
          const declared = Number.parseFloat(window.getComputedStyle(root).getPropertyValue('--dsh-windows-titlebar-height'))
          uhInsetSource = 'titlebar-marker'
          return Number.isFinite(declared) && declared > 0 ? Math.round(declared) : 40
        }
      } catch (error) { /* no host marker: fall through */ }
      try {
        const overlay = typeof navigator === 'undefined' ? undefined : navigator.windowControlsOverlay
        if (overlay !== undefined && overlay !== null && overlay.visible === true) {
          const rect = overlay.getTitlebarAreaRect()
          if (rect !== null && rect !== undefined && Number.isFinite(rect.height) && rect.height > 0) { uhInsetSource = 'overlay'; return Math.round(rect.height) }
        }
      } catch (error) { /* no overlay geometry: fall through */ }
      const agent = typeof navigator === 'undefined' ? '' : String(navigator.userAgent || '')
      // The DSH desktop shell is an Electron app that builds its main window with
      // titleBarStyle: 'hidden' and titleBarOverlay: { height: 40 } on Windows, so
      // the page is expected to keep that strip clear. When the window does not
      // expose the overlay geometry, fall back to the height it was built with.
      if (/Electron/i.test(agent)) { uhInsetSource = 'electron-ua'; return 40 }
      if (/QtWebEngine/i.test(agent)) { uhInsetSource = 'qtwebengine-ua'; return 40 }
      return 0
    }
    // Diagnostic: a desktop host cannot be inspected from outside, so report what
    // this page sees — user agent, overlay geometry, the strip the panel reserved
    // and where that number came from, plus the panel's own rectangles — and
    // surface it through /api/all-usage/status. It runs at load and again whenever
    // the sheet opens, so a report always describes an open panel.
    function uhReportClientEnv() {
      try {
        const overlay = typeof navigator === 'undefined' ? undefined : navigator.windowControlsOverlay
        let overlayReport = 'none'
        if (overlay !== undefined && overlay !== null) {
          overlayReport = overlay.visible === true ? String((overlay.getTitlebarAreaRect() || {}).height) : 'hidden'
        }
        const agentReport = typeof navigator === 'undefined' ? '' : String(navigator.userAgent || '').slice(0, 180)
        const readRect = (selector) => {
          try {
            const node = document.querySelector(selector)
            if (node === null) return 'none'
            const rect = node.getBoundingClientRect()
            return [rect.top, rect.left, rect.width, rect.height].map((value) => Math.round(value)).join('/')
          } catch (error) { return 'none' }
        }
        const rootNode = typeof document === 'undefined' ? null : document.documentElement
        const markerReport = rootNode !== null && rootNode.hasAttribute('data-windows-titlebar')
          ? (String(window.getComputedStyle(rootNode).getPropertyValue('--dsh-windows-titlebar-height')).trim() || 'set')
          : 'none'
        const viewportReport = typeof window === 'undefined' ? '' : Math.round(window.innerWidth) + 'x' + Math.round(window.innerHeight)
        const query = 'ua=' + encodeURIComponent(agentReport) + '&wco=' + encodeURIComponent(overlayReport)
          + '&inset=' + String(uhWindowControlsInset()) + '&src=' + encodeURIComponent(uhInsetSource)
          + '&tb=' + encodeURIComponent(markerReport) + '&vp=' + encodeURIComponent(viewportReport)
          + '&modal=' + encodeURIComponent(readRect('.uh-side-modal'))
          + '&dlg=' + encodeURIComponent(readRect('.uh-side-dialog'))
          + '&head=' + encodeURIComponent(readRect('.uh-side-dialog-head'))
          + '&close=' + encodeURIComponent(readRect('.uh-close-button'))
        void fetch('/api/all-usage/client-env?' + query, { headers: { accept: 'application/json' } }).catch(() => {})
      } catch (error) { /* diagnostics only */ }
    }
    uhReportClientEnv()
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
      // The write capability rotates whenever the host re-applies the plugin,
      // which can leave the instance id and every revision untouched. The status
      // payload carries only its derived id (never the capability itself), which
      // is enough to notice the rotation and pull a full snapshot.
      const statusCapability = typeof status.capabilityId === 'string' ? status.capabilityId : ''
      const snapshotCapability = typeof snapshot.capabilityId === 'string' ? snapshot.capabilityId : ''
      if (statusCapability !== '' && statusCapability !== snapshotCapability) return 'full'
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
    const MAX_MODEL_ICON_CACHE = 2000
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
    /**
     * A prefix matches only on a token boundary: a prefix that already ends in a
     * separator matches directly, otherwise the next character must be a
     * separator or a digit-to-letter style break. This keeps 'o3-mini' on
     * OpenAI while 'o3x' and 'o10-preview' stay neutral.
     */
    function modelPrefixMatches(model, prefix) {
      if (prefix === '' || !model.startsWith(prefix)) return false
      if (model.length === prefix.length) return true
      if (/[-_.:\/]$/.test(prefix)) return true
      const next = model.charAt(prefix.length)
      if (next === '-' || next === '_' || next === '.' || next === ':' || next === '/') return true
      // A bare alphabetic prefix (qwen, abab) may be followed by its version
      // digits, but never by more letters that form a different word.
      return /[a-z]$/.test(prefix) && /[0-9]/.test(next)
    }
    function iconForModel(model) {
      const normalized = normalizeIconModel(model)
      if (normalized === '') return null
      for (const icon of MODEL_ICON_TABLE) if (icon.exact.includes(normalized)) return icon
      let best = null
      let bestLength = 0
      for (const icon of MODEL_ICON_TABLE) {
        for (const prefix of icon.prefixes) {
          if (modelPrefixMatches(normalized, prefix) && prefix.length > bestLength) { best = icon; bestLength = prefix.length }
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
      // The served model decides the brand. When actualModel is present but
      // unrecognised (a gateway's private model id), the row stays neutral
      // instead of inheriting the requested model's brand: attributing an
      // unknown model to OpenAI/DeepSeek would be a false claim.
      let icon = actual !== '' ? iconForModel(actual) : iconForModel(requested)
      if (icon === null && actual === '' && requested === '') {
        const providerIcon = iconForProvider(provider)
        const labelIcon = iconForModel(labelModel)
        // A provider-only match must not contradict the model namespace.
        icon = providerIcon !== null && (labelIcon === null || labelIcon === providerIcon) ? providerIcon : labelIcon
      }
      if (MODEL_ICON_CACHE.size >= MAX_MODEL_ICON_CACHE) MODEL_ICON_CACHE.clear()
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
      if (cost.pricingBand === 'off-peak') return cost.pricingHoliday === true ? (language === 'en' ? 'Holiday off-peak' : '节假日谷时') : (language === 'en' ? 'Off-peak' : '谷时')
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
    function pricingDraftValidationError(draft, temporalDrafts) {
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
      // Loose peak/off-peak drafts are validated too: a half-typed time or
      // rate must block the save instead of being silently dropped.
      const loose = temporalDrafts !== null && temporalDrafts !== undefined && typeof temporalDrafts === 'object' ? temporalDrafts : {}
      for (const key of Object.keys(loose)) {
        if (pricingTemporalDraftValidationError(loose[key]) !== '') return 'temporal'
      }
      return ''
    }
    // ---------- merged price table: pure row/draft helpers ----------
    // Everything below is side-effect free: the panel derives its rows from the
    // server snapshot plus the local draft, and every edit returns a new draft
    // object, so the same functions can be exercised in isolation by the tests.

    function pricingRateText(value) {
      if (value === undefined || value === null || value === '') return '0'
      return String(value)
    }
    function pricingRateLabel(key, language) {
      const labels = {
        input: ['输入 / 1M', 'Input / 1M'],
        output: ['输出 / 1M', 'Output / 1M'],
        cacheRead: ['缓存读 / 1M', 'Cache read / 1M'],
        cacheWrite: ['缓存写 / 1M', 'Cache write / 1M'],
      }
      const pair = labels[key] || labels.input
      return language === 'en' ? pair[1] : pair[0]
    }
    function pricingRowKey(row) {
      if (row === null || typeof row !== 'object') return ''
      const identity = typeof row.identityKey === 'string' ? row.identityKey.trim() : ''
      if (identity !== '') return identity
      const model = row.pricingModel || row.actualModel || row.requestedModel || row.model || ''
      return 'price|' + String(row.providerId || '').trim().toLowerCase() + '|' + String(model).trim().toLowerCase()
    }
    function pricingRowBasis(row, mapping) {
      const target = mapping !== null && typeof mapping === 'object' && typeof mapping.catalogModelId === 'string' ? mapping.catalogModelId.trim() : ''
      if (target !== '') return { providerId: String(mapping.catalogProviderId || '').trim().toLowerCase(), modelId: target }
      const priced = row !== null && typeof row === 'object' && row.status === 'priced' && typeof row.pricingModel === 'string' && row.pricingModel.trim() !== ''
      const modelId = priced ? row.pricingModel : (row !== null && typeof row === 'object' ? (row.actualModel || row.requestedModel || row.pricingModel || row.model) : '')
      return { providerId: priced ? String(row.providerId || '').trim().toLowerCase() : '', modelId: String(modelId || '').trim() }
    }
    function pricingBasisKey(basis) {
      const value = basis !== null && typeof basis === 'object' ? basis : {}
      return String(value.providerId || '').trim().toLowerCase() + '|' + String(value.modelId || '').trim().toLowerCase()
    }
    function pricingOverrideIndex(overrides, basis) {
      const list = Array.isArray(overrides) ? overrides : []
      const key = pricingBasisKey(basis)
      for (let index = 0; index < list.length; index += 1) {
        const entry = list[index]
        if (entry === null || typeof entry !== 'object') continue
        if (pricingBasisKey({ providerId: entry.providerId, modelId: entry.modelId }) === key) return index
      }
      return -1
    }
    function pricingMappingIndex(mappings, identityKey) {
      const list = Array.isArray(mappings) ? mappings : []
      const key = String(identityKey || '').trim()
      if (key === '') return -1
      for (let index = 0; index < list.length; index += 1) {
        const mapping = list[index]
        if (mapping === null || typeof mapping !== 'object') continue
        const value = String(mapping.identityKey || mapping.usageIdentityKey || '').trim()
        if (value === key) return index
      }
      return -1
    }
    // Rows feed memoized children (model icons), so a keystroke in a price box
    // must not rebuild them: the payload object is the cache key and it only
    // changes when a fresh snapshot arrives.
    const pricingUsedModelsCache = new WeakMap()
    function pricingUsedModelsFor(source) {
      if (source === null || typeof source !== 'object') return pricingUsedModelsOf(source)
      const cached = pricingUsedModelsCache.get(source)
      if (cached !== undefined) return cached
      const rows = pricingUsedModelsOf(source)
      pricingUsedModelsCache.set(source, rows)
      return rows
    }
    function pricingRowsOf(pricing, draft, pickedTargets) {
      const source = pricing !== null && typeof pricing === 'object' ? pricing : {}
      const models = pricingUsedModelsFor(source)
      const schedules = new Map()
      for (const schedule of (Array.isArray(source.temporalSchedules) ? source.temporalSchedules : [])) {
        if (schedule === null || typeof schedule !== 'object' || typeof schedule.id !== 'string' || !Array.isArray(schedule.policies)) continue
        schedules.set(schedule.id, schedule.policies)
      }
      const mappings = draft !== null && typeof draft === 'object' && Array.isArray(draft.mappings) ? draft.mappings : []
      const overrides = draft !== null && typeof draft === 'object' && Array.isArray(draft.overrides) ? draft.overrides : []
      const targets = pickedTargets !== null && typeof pickedTargets === 'object' ? pickedTargets : {}
      // This runs on every draft edit (each keystroke in a price box), so row
      // lookups are indexed: a full configuration (500 mappings and 500
      // overrides) must not cost rows × configuration per render.
      const mappingByKey = new Map()
      for (let index = 0; index < mappings.length; index += 1) {
        const candidate = mappings[index]
        if (candidate === null || typeof candidate !== 'object') continue
        const identityText = String(candidate.identityKey || candidate.usageIdentityKey || '').trim()
        if (identityText !== '' && !mappingByKey.has(identityText)) mappingByKey.set(identityText, index)
      }
      const overrideByBasis = new Map()
      for (let index = 0; index < overrides.length; index += 1) {
        const candidate = overrides[index]
        if (candidate === null || typeof candidate !== 'object') continue
        const basisText = pricingBasisKey({ providerId: candidate.providerId, modelId: candidate.modelId })
        if (!overrideByBasis.has(basisText)) overrideByBasis.set(basisText, index)
      }
      return models.map((model) => {
        const key = pricingRowKey(model)
        const identityText = typeof model.identityKey === 'string' ? model.identityKey.trim() : ''
        const mappingIndex = identityText !== '' && mappingByKey.has(identityText) ? mappingByKey.get(identityText) : -1
        const mapping = mappingIndex >= 0 ? mappings[mappingIndex] : null
        const mapped = mapping !== null && String(mapping.catalogModelId || '').trim() !== ''
        const basis = pricingRowBasis(model, mapping)
        const basisText = pricingBasisKey(basis)
        const overrideIndex = overrideByBasis.has(basisText) ? overrideByBasis.get(basisText) : -1
        const override = overrideIndex >= 0 ? overrides[overrideIndex] : null
        const target = mapped && targets[key] !== null && typeof targets[key] === 'object' ? targets[key] : null
        const preview = target !== null && target.rates !== null && typeof target.rates === 'object' ? target : null
        const rates = override !== null && override !== undefined
          ? { input: override.input, output: override.output, cacheRead: override.cacheRead, cacheWrite: override.cacheWrite }
          : preview !== null
            ? { input: preview.rates.input, output: preview.rates.output, cacheRead: preview.rates.cacheRead, cacheWrite: preview.rates.cacheWrite }
            : (model.rates !== null && typeof model.rates === 'object' ? { input: model.rates.input, output: model.rates.output, cacheRead: model.rates.cacheRead, cacheWrite: model.rates.cacheWrite } : null)
        const serverTiers = Array.isArray(model.tiers) ? model.tiers.map((tier) => Object.assign({}, tier)) : []
        const tiers = override !== null && override !== undefined && Array.isArray(override.tiers) ? override.tiers.map((tier) => Object.assign({}, tier)) : (preview !== null ? [] : serverTiers)
        const tiered = override !== null && override !== undefined
          ? override.tiered === true && tiers.length > 0
          : preview !== null
            ? preview.tiered === true
            : model.tiered === true
        const tierCount = override !== null && override !== undefined
          ? tiers.length
          : preview !== null
            ? (Number.isFinite(Number(preview.tierCount)) ? Number(preview.tierCount) : 0)
            : (Number.isFinite(Number(model.tierCount)) ? Number(model.tierCount) : tiers.length)
        const schedule = typeof model.temporalScheduleId === 'string' ? schedules.get(model.temporalScheduleId) : null
        const plan = override !== null && override !== undefined && override.temporalPricing !== undefined
          ? override.temporalPricing
          : (Array.isArray(schedule) ? { policies: schedule } : null)
        const rules = plan !== null && plan !== undefined && Array.isArray(plan.policies)
          ? plan.policies.reduce((total, policy) => total + (policy !== null && Array.isArray(policy.rules) ? policy.rules.length : 0), 0)
          : 0
        const explicit = override !== null && override !== undefined && override.temporalPricing !== undefined
        // A payload from a host that predates this panel carries only the
        // policy id and the route (no schedule): the row must still report a
        // peak plan instead of claiming the model has none.
        const serverPolicyId = typeof model.temporalPolicyId === 'string' ? model.temporalPolicyId : ''
        const serverTemporalRoute = model.temporalRoute === 'official' || model.temporalRoute === 'mapped'
        const rulesUnavailable = plan === null && serverTemporalRoute && serverPolicyId !== ''
        return {
          key,
          row: model,
          identityKey: typeof model.identityKey === 'string' ? model.identityKey : '',
          // A host that predates this field says nothing about ledger usage;
          // "unknown" must not be rendered as either verdict (see the row
          // flags), and only an explicit false means "no ledger usage".
          usageBacked: model.usageBacked === true ? true : model.usageBacked === false ? false : null,
          model: typeof model.model === 'string' ? model.model : '',
          status: typeof model.status === 'string' ? model.status : 'unpriced',
          reason: typeof model.reason === 'string' ? model.reason : '',
          mapped,
          mapping,
          mappingIndex,
          basis,
          overrideIndex,
          override,
          source: override !== null && override !== undefined ? 'manual' : (typeof model.source === 'string' ? model.source : 'none'),
          rates,
          tiers,
          tiered,
          tierCount,
          tieredInvalid: model.tieredInvalid === true,
          multiplier: mapping !== null && mapping.multiplier !== undefined ? String(mapping.multiplier) : '1',
          inputTokenSemantics: mapping !== null && typeof mapping.inputTokenSemantics === 'string' ? mapping.inputTokenSemantics : 'fresh',
          pricingModel: mapped ? String(mapping.catalogModelId) : (typeof model.pricingModel === 'string' ? model.pricingModel : ''),
          providerId: basis.providerId,
          temporalPlan: plan === undefined ? null : plan,
          temporalRuleCount: rules,
          temporalPolicyId: serverPolicyId,
          temporalRoute: typeof model.temporalRoute === 'string' ? model.temporalRoute : '',
          temporalRulesUnavailable: rulesUnavailable,
          temporalExplicit: explicit ? true : model.temporalExplicit === true,
          temporalBuiltin: explicit ? false : (rulesUnavailable || model.temporalBuiltin === true),
          temporalConfigInvalid: model.temporalConfigInvalid === true || (override !== null && override !== undefined && override.temporalPricingInvalid === true),
          targetPreview: target,
          mappable: typeof model.identityKey === 'string' && model.identityKey.trim() !== '',
        }
      })
    }
    function pricingDraftUpsertOverride(draft, view, patch) {
      const base = draft !== null && typeof draft === 'object' ? draft : { sync: {}, mappings: [], overrides: [] }
      const overrides = Array.isArray(base.overrides) ? base.overrides.map((entry) => Object.assign({}, entry)) : []
      let index = pricingOverrideIndex(overrides, view.basis)
      if (index < 0) {
        const rates = view.rates !== null && typeof view.rates === 'object' ? view.rates : {}
        const tiers = Array.isArray(view.tiers) ? view.tiers.map((tier) => Object.assign({}, tier)) : []
        overrides.push({
          providerId: view.basis.providerId || '',
          modelId: view.basis.modelId,
          displayName: view.model || view.basis.modelId,
          input: pricingRateText(rates.input),
          output: pricingRateText(rates.output),
          cacheRead: pricingRateText(rates.cacheRead),
          cacheWrite: pricingRateText(rates.cacheWrite),
          tiered: tiers.length > 0,
          tiers,
        })
        index = overrides.length - 1
      }
      overrides[index] = Object.assign({}, overrides[index], patch)
      return Object.assign({}, base, { overrides })
    }
    function pricingDraftSetRate(draft, view, field, value) {
      const patch = {}
      patch[field] = value
      return pricingDraftUpsertOverride(draft, view, patch)
    }
    function pricingDraftWithoutOverride(draft, basis) {
      if (draft === null || typeof draft !== 'object') return draft
      const index = pricingOverrideIndex(draft.overrides, basis)
      if (index < 0) return draft
      const overrides = draft.overrides.slice()
      overrides.splice(index, 1)
      return Object.assign({}, draft, { overrides })
    }
    function pricingDraftSetMapping(draft, view, option) {
      const base = draft !== null && typeof draft === 'object' ? draft : { sync: {}, mappings: [], overrides: [] }
      if (view.mappable !== true || option === null || option === undefined || typeof option.value !== 'string') return base
      const mappings = Array.isArray(base.mappings) ? base.mappings.map((entry) => Object.assign({}, entry)) : []
      const index = pricingMappingIndex(mappings, view.identityKey)
      const patch = {
        identityKey: view.identityKey,
        provider: view.row !== null && typeof view.row === 'object' && typeof view.row.provider === 'string' ? view.row.provider : '',
        model: view.row !== null && typeof view.row === 'object' ? (view.row.actualModel || view.row.requestedModel || '') : '',
        catalogProviderId: typeof option.providerId === 'string' ? option.providerId : '',
        catalogModelId: option.value,
      }
      if (index < 0) mappings.push(Object.assign({ inputTokenSemantics: 'fresh', multiplier: '1' }, patch))
      else mappings[index] = Object.assign({}, mappings[index], patch)
      return Object.assign({}, base, { mappings })
    }
    function pricingDraftWithoutMapping(draft, identityKey) {
      if (draft === null || typeof draft !== 'object') return draft
      const index = pricingMappingIndex(draft.mappings, identityKey)
      if (index < 0) return draft
      const mappings = draft.mappings.slice()
      mappings.splice(index, 1)
      return Object.assign({}, draft, { mappings })
    }
    function pricingDraftSetMappingField(draft, view, field, value) {
      if (draft === null || typeof draft !== 'object') return draft
      const index = pricingMappingIndex(draft.mappings, view.identityKey)
      if (index < 0) return draft
      const mappings = draft.mappings.slice()
      const patch = {}
      patch[field] = value
      mappings[index] = Object.assign({}, mappings[index], patch)
      return Object.assign({}, draft, { mappings })
    }
    function pricingTierDraftAdd(tiers, rates) {
      const list = Array.isArray(tiers) ? tiers.map((tier) => Object.assign({}, tier)) : []
      if (list.length >= 32) return list
      const previous = list.length > 0 ? list[list.length - 1] : null
      const previousSize = previous !== null && Number.isFinite(Number(previous.size)) ? Number(previous.size) : 100000
      const source = previous !== null ? previous : (rates !== null && typeof rates === 'object' ? rates : {})
      list.push({
        type: 'context',
        size: Math.min(1000000000, previousSize + 100000),
        input: pricingRateText(source.input),
        output: pricingRateText(source.output),
        cacheRead: pricingRateText(source.cacheRead),
        cacheWrite: pricingRateText(source.cacheWrite),
      })
      return list
    }
    function pricingTierDraftUpdate(tiers, index, field, value) {
      const list = Array.isArray(tiers) ? tiers.map((tier) => Object.assign({}, tier)) : []
      if (list[index] === undefined) return list
      const patch = {}
      patch[field] = value
      list[index] = Object.assign({}, list[index], patch)
      return list
    }
    function pricingTierDraftRemove(tiers, index) {
      return (Array.isArray(tiers) ? tiers : []).filter((_, itemIndex) => itemIndex !== index).map((tier) => Object.assign({}, tier))
    }
    function pricingTimeTextToMinute(value) {
      const text = String(value === undefined || value === null ? '' : value).trim()
      const match = text.match(/^([0-9]{1,2}):([0-9]{1,2})$/)
      if (match === null) return null
      const hours = Number(match[1])
      const minutes = Number(match[2])
      if (!Number.isInteger(hours) || !Number.isInteger(minutes) || minutes < 0 || minutes > 59) return null
      const total = hours * 60 + minutes
      if (total < 0 || total > 1440) return null
      return total
    }
    function pricingMinuteToTimeText(minute) {
      const value = Number(minute)
      if (!Number.isFinite(value) || value < 0 || value > 1440) return ''
      return String(Math.floor(value / 60)).padStart(2, '0') + ':' + String(value % 60).padStart(2, '0')
    }
    function pricingDateTextToUtc(value) {
      const text = String(value === undefined || value === null ? '' : value).trim()
      if (text === '') return 0
      const match = text.match(/^([0-9]{4})-([0-9]{2})-([0-9]{2})$/)
      if (match === null) return null
      const year = Number(match[1])
      const month = Number(match[2])
      const day = Number(match[3])
      const at = Date.UTC(year, month - 1, day)
      const date = new Date(at)
      if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null
      return at
    }
    function pricingUtcToDateText(value) {
      const at = Number(value)
      if (!Number.isFinite(at) || at <= 0) return ''
      return new Date(at).toISOString().slice(0, 10)
    }
    // Statutory holidays are stored as an explicit date list: one date per line
    // or a `start..end` range, following the China Standard Time calendar day.
    function pricingHolidayDatesFromText(value) {
      const text = String(value === undefined || value === null ? '' : value)
      const dates = []
      const seen = new Set()
      for (const rawLine of text.split('\n')) {
        const line = rawLine.trim()
        if (line === '') continue
        const parts = line.split('..')
        if (parts.length > 2) return null
        const startText = parts[0].trim()
        const endText = parts.length === 2 ? parts[1].trim() : startText
        if (startText === '' || endText === '') return null
        const start = pricingDateTextToUtc(startText)
        const end = pricingDateTextToUtc(endText)
        if (start === null || end === null || start > end) return null
        const days = Math.round((end - start) / 86400000) + 1
        if (days > 366 || seen.size + days > 400) return null
        for (let offset = 0; offset < days; offset += 1) {
          const key = new Date(start + offset * 86400000).toISOString().slice(0, 10)
          if (seen.has(key)) continue
          seen.add(key)
          dates.push(key)
        }
      }
      dates.sort()
      return dates
    }
    /** Union of the existing holiday text and a freshly fetched date list. */
    function pricingHolidayTextMerge(text, dates) {
      const existing = pricingHolidayDatesFromText(text)
      const list = existing === null ? [] : existing.slice()
      const seen = new Set(list)
      for (const date of Array.isArray(dates) ? dates : []) {
        const text2 = String(date === undefined || date === null ? '' : date).trim()
        if (text2 === '' || seen.has(text2)) continue
        seen.add(text2)
        list.push(text2)
      }
      list.sort()
      return list.length === 0 ? '' : list.join('\n')
    }
    function pricingTemporalDraftOfPlan(plan) {
      const policies = plan !== null && plan !== undefined && Array.isArray(plan.policies) ? plan.policies : []
      const policy = policies.length > 0 && policies[0] !== null && typeof policies[0] === 'object' ? policies[0] : null
      if (policy === null) return null
      const rules = Array.isArray(policy.rules) ? policy.rules : []
      if (rules.length === 0) return null
      return {
        policyId: typeof policy.policyId === 'string' && policy.policyId !== '' ? policy.policyId : 'custom-peak',
        effectiveFromText: pricingUtcToDateText(policy.effectiveFrom),
        holidaysEnabled: Array.isArray(policy.holidays) && policy.holidays.length > 0,
        holidaysText: Array.isArray(policy.holidays) ? policy.holidays.join('\n') : '',
        holidaysSourceText: typeof policy.holidaysSource === 'string' ? policy.holidaysSource : '',
        rules: rules.map((rule, index) => ({
          id: typeof rule.id === 'string' && rule.id !== '' ? rule.id : 'peak-' + (index + 1),
          weekdays: Array.isArray(rule.weekdays) ? rule.weekdays.slice().sort((left, right) => left - right) : [],
          windows: (Array.isArray(rule.windows) ? rule.windows : []).map((window) => ({ start: pricingMinuteToTimeText(window.startMinute), end: pricingMinuteToTimeText(window.endMinute) })),
          rates: {
            input: pricingRateText(rule.rates !== null && rule.rates !== undefined ? rule.rates.input : ''),
            output: pricingRateText(rule.rates !== null && rule.rates !== undefined ? rule.rates.output : ''),
            cacheRead: pricingRateText(rule.rates !== null && rule.rates !== undefined ? rule.rates.cacheRead : ''),
            cacheWrite: pricingRateText(rule.rates !== null && rule.rates !== undefined ? rule.rates.cacheWrite : ''),
          },
        })),
      }
    }
    function pricingTemporalDraftDefault(rates) {
      const base = rates !== null && typeof rates === 'object' ? rates : {}
      return {
        policyId: 'custom-peak',
        effectiveFromText: '',
        holidaysEnabled: false,
        holidaysText: '',
        holidaysSourceText: '',
        rules: [{
          id: 'peak-1',
          weekdays: [1, 2, 3, 4, 5],
          windows: [{ start: '01:00', end: '04:00' }],
          rates: {
            input: pricingRateText(base.input),
            output: pricingRateText(base.output),
            cacheRead: pricingRateText(base.cacheRead),
            cacheWrite: pricingRateText(base.cacheWrite),
          },
        }],
      }
    }
    function pricingTemporalDraftClone(draft) {
      if (draft === null || typeof draft !== 'object') return null
      return {
        policyId: String(draft.policyId === undefined ? '' : draft.policyId),
        effectiveFromText: String(draft.effectiveFromText === undefined ? '' : draft.effectiveFromText),
        holidaysEnabled: draft.holidaysEnabled === true,
        holidaysText: String(draft.holidaysText === undefined || draft.holidaysText === null ? '' : draft.holidaysText),
        holidaysSourceText: String(draft.holidaysSourceText === undefined || draft.holidaysSourceText === null ? '' : draft.holidaysSourceText),
        rules: (Array.isArray(draft.rules) ? draft.rules : []).map((rule, index) => ({
          id: typeof rule.id === 'string' && rule.id !== '' ? rule.id : 'peak-' + (index + 1),
          weekdays: (Array.isArray(rule.weekdays) ? rule.weekdays : []).map(Number),
          windows: (Array.isArray(rule.windows) ? rule.windows : []).map((window) => ({ start: String(window.start === undefined ? '' : window.start), end: String(window.end === undefined ? '' : window.end) })),
          rates: {
            input: String(rule.rates === undefined || rule.rates === null || rule.rates.input === undefined ? '' : rule.rates.input),
            output: String(rule.rates === undefined || rule.rates === null || rule.rates.output === undefined ? '' : rule.rates.output),
            cacheRead: String(rule.rates === undefined || rule.rates === null || rule.rates.cacheRead === undefined ? '' : rule.rates.cacheRead),
            cacheWrite: String(rule.rates === undefined || rule.rates === null || rule.rates.cacheWrite === undefined ? '' : rule.rates.cacheWrite),
          },
        })),
      }
    }
    function pricingTemporalDraftWithRule(draft) {
      const next = pricingTemporalDraftClone(draft)
      if (next === null || next.rules.length >= 16) return next
      const previous = next.rules.length > 0 ? next.rules[next.rules.length - 1] : null
      next.rules.push({
        id: 'peak-' + (next.rules.length + 1),
        weekdays: previous !== null ? previous.weekdays.slice(0, 1) : [1, 2, 3, 4, 5],
        windows: [{ start: '06:00', end: '10:00' }],
        rates: previous !== null ? Object.assign({}, previous.rates) : { input: '', output: '', cacheRead: '', cacheWrite: '' },
      })
      return next
    }
    function pricingTemporalDraftWithoutRule(draft, index) {
      const next = pricingTemporalDraftClone(draft)
      if (next === null || next.rules.length <= 1) return next
      next.rules = next.rules.filter((_, itemIndex) => itemIndex !== index)
      return next
    }
    function pricingTemporalDraftRulePatch(draft, index, patch) {
      const next = pricingTemporalDraftClone(draft)
      if (next === null || next.rules[index] === undefined) return next
      next.rules[index] = Object.assign({}, next.rules[index], patch)
      return next
    }
    function pricingTemporalDraftToggleWeekday(draft, index, weekday) {
      const next = pricingTemporalDraftClone(draft)
      if (next === null || next.rules[index] === undefined) return next
      const rule = next.rules[index]
      const day = Number(weekday)
      rule.weekdays = (rule.weekdays.includes(day) ? rule.weekdays.filter((item) => item !== day) : rule.weekdays.concat([day])).sort((left, right) => left - right)
      return next
    }
    function pricingTemporalDraftWindows(draft, index, windows) {
      return pricingTemporalDraftRulePatch(draft, index, { windows })
    }
    function pricingTemporalDraftRates(draft, index, rates) {
      return pricingTemporalDraftRulePatch(draft, index, { rates })
    }
    function pricingTemporalPlanFromDraft(draft) {
      const effectiveFrom = pricingDateTextToUtc(draft !== null && typeof draft === 'object' ? draft.effectiveFromText : '')
      const rules = (draft !== null && typeof draft === 'object' && Array.isArray(draft.rules) ? draft.rules : []).map((rule, index) => ({
        id: typeof rule.id === 'string' && rule.id !== '' ? rule.id : 'peak-' + (index + 1),
        weekdays: (Array.isArray(rule.weekdays) ? rule.weekdays : []).slice().sort((left, right) => left - right),
        windows: (Array.isArray(rule.windows) ? rule.windows : []).map((window) => ({ startMinute: pricingTimeTextToMinute(window.start), endMinute: pricingTimeTextToMinute(window.end) })),
        rates: {
          input: pricingRateText(rule.rates !== null && rule.rates !== undefined ? rule.rates.input : ''),
          output: pricingRateText(rule.rates !== null && rule.rates !== undefined ? rule.rates.output : ''),
          cacheRead: pricingRateText(rule.rates !== null && rule.rates !== undefined ? rule.rates.cacheRead : ''),
          cacheWrite: pricingRateText(rule.rates !== null && rule.rates !== undefined ? rule.rates.cacheWrite : ''),
        },
      }))
      return {
        policies: [{
          policyId: String(draft !== null && typeof draft === 'object' && draft.policyId !== undefined ? draft.policyId : '').trim(),
          timezone: 'UTC',
          effectiveFrom: effectiveFrom === null ? 0 : effectiveFrom,
          effectiveUntil: null,
          defaultPlan: null,
          holidays: draft !== null && typeof draft === 'object' && draft.holidaysEnabled === true ? (pricingHolidayDatesFromText(draft.holidaysText) || []) : [],
          holidaysSource: draft !== null && typeof draft === 'object' ? String(draft.holidaysSourceText === undefined || draft.holidaysSourceText === null ? '' : draft.holidaysSourceText).trim().slice(0, 512) : '',
          rules,
        }],
      }
    }
    function pricingTemporalDraftValidationError(draft) {
      if (draft === null || typeof draft !== 'object') return 'temporal'
      const policyId = String(draft.policyId === undefined ? '' : draft.policyId).trim()
      if (policyId === '' || policyId.length > 128) return 'temporal'
      if (pricingDateTextToUtc(draft.effectiveFromText) === null) return 'temporal'
      if (draft.holidaysEnabled === true && pricingHolidayDatesFromText(draft.holidaysText) === null) return 'temporal'
      const rules = Array.isArray(draft.rules) ? draft.rules : []
      if (rules.length === 0 || rules.length > 16) return 'temporal'
      const perDay = new Map()
      for (const rule of rules) {
        const weekdays = Array.isArray(rule.weekdays) ? rule.weekdays.map(Number) : []
        if (weekdays.length === 0 || weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) return 'temporal'
        const windows = Array.isArray(rule.windows) ? rule.windows : []
        if (windows.length === 0 || windows.length > 16) return 'temporal'
        for (const window of windows) {
          const start = pricingTimeTextToMinute(window.start)
          const end = pricingTimeTextToMinute(window.end)
          if (start === null || end === null || end <= start) return 'temporal'
          for (const day of weekdays) {
            const list = perDay.get(day) === undefined ? [] : perDay.get(day)
            list.push({ start, end })
            perDay.set(day, list)
          }
        }
        if (!['input', 'output', 'cacheRead', 'cacheWrite'].every((key) => validPricingRateDraft(rule.rates !== null && rule.rates !== undefined ? rule.rates[key] : ''))) return 'temporal'
      }
      for (const list of perDay.values()) {
        list.sort((left, right) => left.start - right.start)
        for (let index = 1; index < list.length; index += 1) {
          if (list[index].start < list[index - 1].end) return 'temporal'
        }
      }
      return ''
    }
    function pricingDraftPayloadTooLarge(draft) {
      try {
        return JSON.stringify({ pricing: draft }).length > 200 * 1024
      } catch (err) {
        return true
      }
    }
    function pricingRatesEqual(left, right) {
      if (left === right) return true
      if (left === null || left === undefined || right === null || right === undefined) return false
      return left.input === right.input && left.output === right.output && left.cacheRead === right.cacheRead && left.cacheWrite === right.cacheWrite
    }
    function pricingTiersEqual(left, right) {
      if (left === right) return true
      const leftTiers = Array.isArray(left) ? left : []
      const rightTiers = Array.isArray(right) ? right : []
      if (leftTiers.length !== rightTiers.length) return false
      for (let index = 0; index < leftTiers.length; index += 1) {
        const a = leftTiers[index]
        const b = rightTiers[index]
        if (a === b) continue
        if (a === null || a === undefined || b === null || b === undefined) return false
        if (a.size !== b.size || a.input !== b.input || a.output !== b.output || a.cacheRead !== b.cacheRead || a.cacheWrite !== b.cacheWrite) return false
      }
      return true
    }
    function pricingRowViewEqual(left, right) {
      if (left === right) return true
      if (left === null || left === undefined || right === null || right === undefined) return false
      return left.key === right.key
        && left.model === right.model
        && left.status === right.status
        && left.reason === right.reason
        && left.source === right.source
        && left.mapped === right.mapped
        && left.usageBacked === right.usageBacked
        && left.mappable === right.mappable
        && left.pricingModel === right.pricingModel
        && left.providerId === right.providerId
        && left.tiered === right.tiered
        && left.tierCount === right.tierCount
        && left.tieredInvalid === right.tieredInvalid
        && left.multiplier === right.multiplier
        && left.inputTokenSemantics === right.inputTokenSemantics
        && left.temporalExplicit === right.temporalExplicit
        && left.temporalBuiltin === right.temporalBuiltin
        && left.temporalConfigInvalid === right.temporalConfigInvalid
        && left.temporalRulesUnavailable === right.temporalRulesUnavailable
        && left.temporalPolicyId === right.temporalPolicyId
        && left.temporalRuleCount === right.temporalRuleCount
        && left.overrideIndex === right.overrideIndex
        && left.mappingIndex === right.mappingIndex
        && pricingRatesEqual(left.rates, right.rates)
        && pricingTiersEqual(left.tiers, right.tiers)
        && pricingBasisKey(left.basis) === pricingBasisKey(right.basis)
    }
    // The row comparator is what keeps a keystroke in one price box from
    // rebuilding every other row: a table at the 500-row cap would otherwise
    // reconcile thousands of elements per keystroke.
    function pricingRowPropsEqual(previous, next) {
      if (previous === next) return true
      if (previous.busy !== next.busy) return false
      if (previous.language !== next.language) return false
      if (previous.openSection !== next.openSection) return false
      if (previous.searchText !== next.searchText) return false
      if (previous.searchOpen !== next.searchOpen) return false
      if (previous.searchOptions !== next.searchOptions) return false
      // The expanded editors read the loose peak draft and the resolved plan.
      if (previous.temporalDraft !== next.temporalDraft) return false
      if (previous.temporalPlan !== next.temporalPlan) return false
      if (previous.holidayStatus !== next.holidayStatus) return false
      if (previous.holidayLoading !== next.holidayLoading) return false
      return pricingRowViewEqual(previous.view, next.view)
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
    // The grid is built from whole weeks, so a span is a column count: 53 covers
    // about a year, 13 about 90 days and 5 about 30. Fewer columns means wider
    // cells, and the cell keeps aspect-ratio 1, so a shorter span is also a
    // taller one - which is what a reader wants when 53 weeks of squares are too
    // small to read.
    const HEATMAP_SPANS = { '30d': 5, '90d': 13, '12m': 53 }
    const HEATMAP_SPAN_KEYS = ['30d', '90d', '12m']
    const HEATMAP_SPAN_DEFAULT = '12m'
    function normalizeHeatmapSpan(value) {
      return HEATMAP_SPAN_KEYS.includes(value) ? value : HEATMAP_SPAN_DEFAULT
    }
    function heatmapWeeksOf(span) {
      return HEATMAP_SPANS[normalizeHeatmapSpan(span)]
    }
    function buildCalendarModel(todayKey, utc, language, weeks) {
      const count = Number.isSafeInteger(weeks) && weeks > 0 && weeks <= 53 ? weeks : HEATMAP_SPANS[HEATMAP_SPAN_DEFAULT]
      const parts = String(todayKey || '').split('-').map(Number)
      const today = utc ? new Date(Date.UTC(parts[0], parts[1] - 1, parts[2])) : new Date(parts[0], parts[1] - 1, parts[2])
      const weekday = utc ? today.getUTCDay() : today.getDay()
      const sunday = shiftCalendarDate(today, -weekday, utc)
      const start = shiftCalendarDate(sunday, -(count - 1) * 7, utc)
      const cells = []
      for (let index = 0; index < count * 7; index += 1) {
        const date = shiftCalendarDate(start, index, utc)
        cells.push({ date: fmtDate(date, utc), month: utc ? date.getUTCMonth() : date.getMonth(), year: utc ? date.getUTCFullYear() : date.getFullYear() })
      }
      const months = []
      for (let week = 0; week < count; week += 1) {
        const first = cells[week * 7]
        const previous = week > 0 ? cells[(week - 1) * 7] : null
        if (previous === null || first.month !== previous.month) months.push({ left: (week * 100 / count) + '%', text: monthLabel(first.year, first.month, language) })
      }
      return { cells, months, weekdays: language === 'en' ? ['', 'Mon', '', 'Wed', '', 'Fri', ''] : ['', '周一', '', '周三', '', '周五', ''] }
    }
    // The header chip shows the running version and what the registry says. A
    // missing or failed check degrades to 'unknown' rather than claiming either
    // verdict, and an unparseable tag never claims an update.
    function versionSummaryOf(fallbackVersion, info) {
      const payload = info !== null && typeof info === 'object' ? info : {}
      const current = typeof payload.current === 'string' && payload.current !== ''
        ? payload.current
        : (typeof fallbackVersion === 'string' ? fallbackVersion : '')
      const latest = typeof payload.latest === 'string' && payload.latest !== '' ? payload.latest : null
      const raw = payload.status === 'outdated' || payload.status === 'latest' ? payload.status : 'unknown'
      const checkedAt = Number(payload.checkedAt)
      return {
        current,
        latest,
        status: latest === null ? 'unknown' : raw,
        checkedAt: Number.isFinite(checkedAt) && checkedAt > 0 ? checkedAt : null,
        sourceUrl: typeof payload.sourceUrl === 'string' ? payload.sourceUrl : '',
        error: typeof payload.error === 'string' ? payload.error : '',
      }
    }
    const GITHUB_REPOSITORY_URL = 'https://github.com/ParticleLight/dsh-all-usage'
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
      } else if (range === '7d') {
        start = fmtDate(shiftCalendarDate(new Date(), -6, utc), utc)
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
      if (range === '7d') return { start: fmtDate(shiftCalendarDate(new Date(), -6, utc), utc), end: latest }
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
      const weeks = heatmapWeeksOf(props.span)
      // A short span must not stretch a handful of columns across the whole card:
      // five full-width columns would be 200px squares. Cap the strip so the cells
      // stop growing at a readable size and the grid stays left-aligned under its
      // month labels (which share the same width).
      const heatmapCap = weeks < HEATMAP_SPANS[HEATMAP_SPAN_DEFAULT] ? (weeks * 34 + (weeks - 1) * 3) + 'px' : null
      const monthsStyle = { minWidth: (weeks * 13) + 'px' }
      const gridStyle = { gridTemplateColumns: 'repeat(' + weeks + ', minmax(10px, 1fr))', minWidth: (weeks * 13) + 'px' }
      if (heatmapCap !== null) {
        monthsStyle.maxWidth = heatmapCap
        gridStyle.maxWidth = heatmapCap
      }
      const calendar = React.useMemo(() => buildCalendarModel(props.todayKey, props.utc === true, language, weeks), [props.todayKey, props.utc, language, weeks])
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
          const isBucket = workspace.retiredBucket === true
          const workspaceLabel = isBucket ? tr('已删除', 'Deleted') : (typeof alias === 'string' && alias !== '' ? alias : (workspace.title || tr('未知工作区', 'Unknown workspace')))
          titles.set(workspace.id, workspace.deleted === true && !isBucket ? workspaceLabel + tr('（已删除）', ' (deleted)') : workspaceLabel)
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
          React.createElement('div', { className: 'uh-chips' }, workspaces.map((workspace, index) => React.createElement('button', { key: workspace.id, className: 'uh-chip' + (selectedWorkspace === workspace.id ? ' uh-on' : ''), onClick: () => selectWorkspace(workspace.id), title: workspace.path || (workspace.retiredBucket === true ? tr('已删除', 'Deleted') : '') },
            React.createElement('span', { className: 'uh-dot', style: { background: wsColor(index) } }),
            React.createElement('span', { className: 'uh-chip-title' }, workspaceLookup.titles.get(workspace.id)),
          ))),
          React.createElement('div', { className: 'uh-hm-tools' },
            React.createElement('div', { className: 'uh-range uh-heatmap-spans', role: 'group', 'aria-label': tr('热力图范围', 'Heatmap span') },
              HEATMAP_SPAN_KEYS.map((key) => React.createElement('button', {
                key,
                type: 'button',
                className: normalizeHeatmapSpan(props.span) === key ? 'uh-on' : '',
                'aria-pressed': normalizeHeatmapSpan(props.span) === key,
                title: key === '30d' ? tr('最近 30 天（格子更大）', 'Last 30 days (larger cells)') : key === '90d' ? tr('最近 90 天', 'Last 90 days') : tr('最近 12 个月', 'Last 12 months'),
                onClick: () => { if (typeof props.onSpanChange === 'function') props.onSpanChange(key) },
              }, key === '30d' ? tr('30 天', '30 days') : key === '90d' ? tr('90 天', '90 days') : tr('12 个月', '12 months'))),
            ),
            React.createElement('div', { className: 'uh-legend' },
              React.createElement('span', {}, tr('少', 'Less')),
              [0, 1, 2, 3, 4].map((level) => React.createElement('span', { key: level, className: 'uh-cell', style: { background: cellBg(level) } })),
              React.createElement('span', {}, tr('多', 'More')),
            ),
          ),
        ),
        React.createElement('div', { className: 'uh-hm-scroll' },
          React.createElement('div', { className: 'uh-months', style: monthsStyle }, calendar.months.map((month, index) => React.createElement('span', { key: index, style: { left: month.left } }, month.text))),
          React.createElement('div', { className: 'uh-hm-body' },
            React.createElement('div', { className: 'uh-wdays' }, calendar.weekdays.map((weekday, index) => React.createElement('span', { key: index }, weekday))),
            React.createElement('div', { className: 'uh-grid', style: gridStyle }, cellElements),
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
    // One memoized row per model: the comparator decides from the row's props
    // (see pricingRowPropsEqual), so unrelated rows bail out of the render.
    const MemoUsagePricingRow = React.memo(function UsagePricingRow(props) {
      return props.render(props.view)
    }, pricingRowPropsEqual)

    function ModelIcon(props) {
      const size = Number.isFinite(props.size) ? props.size : 18
      // An explicit null iconKey means the caller already resolved 'no brand'
      // (e.g. a provider aggregate for a reseller): never fall back to guessing
      // a brand from the row's model namespace in that case.
      const icon = props.iconKey === null ? null : props.iconKey !== undefined ? MODEL_ICON_BY_KEY.get(props.iconKey) || null : resolveModelIcon(props.row)
      // The load-failure flag belongs to one icon identity: a shared component
      // instance (records detail, donut legend slot) that later renders another
      // brand must retry instead of staying on the neutral fallback forever.
      const identity = icon === null ? '' : icon.key + '\u0000' + icon.href
      const [failedIdentity, setFailedIdentity] = React.useState(null)
      const failed = failedIdentity !== null && failedIdentity === identity
      const style = { width: size, height: size, minWidth: size }
      if (icon === null || failed) {
        return React.createElement('span', { className: 'uh-model-icon uh-model-icon-fallback' + (props.className ? ' ' + props.className : ''), style, 'aria-hidden': true })
      }
      // showTitle exposes the brand through the image's accessible name; the
      // decorative default stays fully hidden because the adjacent text already
      // names the model (a title on an aria-hidden host is not announced).
      const labelled = props.showTitle === true
      return React.createElement('span', { className: 'uh-model-icon' + (props.className ? ' ' + props.className : ''), style, ...(labelled ? {} : { 'aria-hidden': true }) },
        React.createElement('img', { key: identity, src: icon.href, alt: labelled ? icon.label : '', title: labelled ? icon.label : undefined, width: size, height: size, loading: 'lazy', decoding: 'async', draggable: false, onError: () => setFailedIdentity(identity) }),
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
      const renderIcon = (option) => {
        const iconKey = option === undefined || option === null || option.iconKey === undefined || option.iconKey === null ? null : option.iconKey
        return iconKey === null
          ? React.createElement(LineIcon, { name: props.icon || 'chart', size: 14 })
          : React.createElement(MemoModelIcon, { iconKey, size: 14 })
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
          renderIcon(selected),
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
              renderIcon(option),
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
.uh-title-wrap { display:flex; align-items:center; gap:10px; flex-wrap:wrap; min-width:0; }
/* Version chip: the running version plus the registry verdict, clickable to the repo. */
.uh-version { display:inline-flex; align-items:center; gap:6px; border:1px solid var(--dsw-alias-border-l1); background:transparent; color:var(--dsw-alias-label-secondary); border-radius:999px; padding:2px 9px; font:inherit; font-size:12px; cursor:pointer; transition:background-color .15s ease, border-color .15s ease, color .15s ease; }
.uh-version:hover { background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); }
.uh-version-number { font-variant-numeric:tabular-nums; }
.uh-version-status { color:var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); }
.uh-version-outdated { border-color:color-mix(in srgb, var(--dsw-alias-brand-primary) 55%, transparent); color:var(--dsw-alias-brand-primary); }
.uh-version-outdated .uh-version-status { color:inherit; font-weight:600; }
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
.uh-pricing-table-wrap { max-height:392px; overflow-x:hidden; overflow-y:scroll; scrollbar-gutter:stable; scrollbar-width:auto; scrollbar-color:#707780 #1d1f22; border:1px solid var(--dsw-alias-border-l1); border-radius:8px; background:var(--dsw-alias-bg-layer-2); }
.uh-pricing-model-table { width:100%; min-width:1080px; border-collapse:collapse; table-layout:fixed; font-size:11px; }
.uh-pricing-model-table th, .uh-pricing-model-table td { min-width:0; padding:8px 9px; border-bottom:1px solid var(--dsw-alias-border-l1); text-align:left; vertical-align:middle; }
.uh-pricing-model-table th { position:sticky; top:0; z-index:40; color:var(--dsw-alias-label-secondary); background:var(--dsw-alias-bg-layer-2); font-weight:650; white-space:nowrap; }
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
.uh-pricing-model-search { position:relative; z-index:2; min-width:0; display:flex; align-items:center; gap:6px; }
.uh-pricing-model-search .uh-pricing-model-search-input { flex:1 1 auto; width:auto; }
.uh-pricing-clear-mapping { flex:none; white-space:nowrap; }
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
.uh-pricing-tier-edit-head, .uh-pricing-tier-edit-row { display:grid; grid-template-columns:minmax(120px,.85fr) repeat(4,minmax(72px,1fr)) 30px; gap:10px; align-items:center; min-width:0; }
.uh-pricing-tier-edit-head { margin:5px 0; color:var(--dsw-alias-label-secondary); font-size:10px; }
.uh-pricing-tier-edit-row { margin-top:7px; }
.uh-pricing-tier-edit-row.uh-invalid input { border-color:var(--dsw-alias-warning, #a55b00); }
.uh-pricing-tier-empty { padding:5px 0; color:var(--dsw-alias-label-secondary); font-size:10px; }
.uh-pricing-error { color:var(--dsw-alias-warning, #a55b00); font-size:12px; line-height:1.45; }
.uh-pricing-foot { padding-top:4px; }

.uh-pricing-table-note { color:var(--dsw-alias-label-secondary); font-size:11px; line-height:1.5; }
.uh-pricing-price-table { width:100%; min-width:0; }
.uh-pricing-price-table th:nth-child(1) { width:20%; }
.uh-pricing-price-table th:nth-child(2) { width:24%; }
.uh-pricing-price-table th:nth-child(3), .uh-pricing-price-table th:nth-child(4), .uh-pricing-price-table th:nth-child(5), .uh-pricing-price-table th:nth-child(6) { width:11%; }
.uh-pricing-price-table th:nth-child(7) { width:12%; }
.uh-pricing-table-wrap .uh-pricing-price-table th, .uh-pricing-table-wrap .uh-pricing-price-table td { text-align:left; }
.uh-pricing-price-table th, .uh-pricing-price-table td { padding:8px 8px; }
.uh-pricing-price-table td { vertical-align:top; }
.uh-pricing-row-flags { display:flex; align-items:center; flex-wrap:wrap; gap:4px; margin-top:5px; }
.uh-pricing-flag { padding:2px 6px; border-radius:999px; background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-secondary); font-size:10px; white-space:nowrap; }
.uh-pricing-configured-row { background:color-mix(in srgb, var(--dsw-alias-bg-layer-1) 42%, transparent); }
/* Unknown usage (the host did not label the row) is not the same verdict as
   "no ledger usage", so it must not read like one. */
.uh-pricing-unknown-row { background:color-mix(in srgb, var(--dsw-alias-bg-layer-1) 24%, transparent); }
.uh-pricing-flag-unknown { border-style:dashed; opacity:.75; }
.uh-pricing-rate-input { box-sizing:border-box; width:100%; min-width:0; min-height:30px; border:1px solid var(--dsw-alias-border-l2); border-radius:6px; padding:4px 7px; background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); font:inherit; font-size:11px; font-variant-numeric:tabular-nums; outline:none; }
.uh-pricing-rate-input:focus { border-color:var(--dsw-alias-brand-primary); }
.uh-pricing-map-cell { display:flex; flex-direction:column; gap:6px; }
.uh-pricing-map-sub { display:flex; align-items:center; flex-wrap:wrap; gap:8px; }
.uh-pricing-map-field { display:inline-flex; align-items:center; gap:5px; color:var(--dsw-alias-label-secondary); font-size:10px; }
.uh-pricing-map-field input, .uh-pricing-map-field select { box-sizing:border-box; min-height:26px; border:1px solid var(--dsw-alias-border-l2); border-radius:6px; padding:2px 6px; background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); font:inherit; font-size:11px; outline:none; }
.uh-pricing-map-field input { width:70px; }
.uh-pricing-link { border:0; background:transparent; color:var(--dsw-alias-brand-primary); font:inherit; font-size:11px; cursor:pointer; padding:2px 0; text-decoration:underline; }
.uh-pricing-link:disabled { color:var(--dsw-alias-label-secondary); cursor:default; text-decoration:none; }
.uh-pricing-chip { min-height:28px; padding:3px 9px; border:1px solid var(--dsw-alias-border-l2); border-radius:999px; background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-secondary); font:inherit; font-size:10px; cursor:pointer; white-space:nowrap; }
.uh-pricing-chip.uh-on, .uh-pricing-chip.uh-strong { border-color:var(--dsw-alias-brand-primary); color:var(--dsw-alias-label-primary); background:color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent); }
.uh-pricing-action-cell { white-space:nowrap; }
.uh-pricing-row-actions { display:flex; align-items:center; flex-wrap:wrap; gap:5px; white-space:nowrap; }
.uh-pricing-editor-row > td { padding:0 9px 10px; background:color-mix(in srgb, var(--dsw-alias-bg-layer-1) 36%, transparent); }
.uh-pricing-editor { display:flex; flex-direction:column; gap:10px; min-width:0; overflow-x:auto; }
.uh-pricing-editor-foot { display:flex; justify-content:flex-end; }
.uh-pricing-temporal-fields { display:flex; align-items:flex-end; flex-wrap:wrap; gap:10px; margin-top:6px; }
.uh-pricing-temporal-fields label { display:inline-flex; flex-direction:column; gap:4px; color:var(--dsw-alias-label-secondary); font-size:10px; }
.uh-pricing-temporal-fields input { box-sizing:border-box; min-height:28px; border:1px solid var(--dsw-alias-border-l2); border-radius:6px; padding:3px 7px; background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); font:inherit; font-size:11px; outline:none; }
.uh-pricing-temporal-fields input:focus { border-color:var(--dsw-alias-brand-primary); }
.uh-pricing-temporal-rule { margin-top:8px; padding:8px 10px; border:1px solid var(--dsw-alias-border-l1); border-radius:8px; background:var(--dsw-alias-bg-base); }
.uh-pricing-temporal-rule-head { display:flex; align-items:center; flex-wrap:wrap; gap:8px; }
.uh-pricing-temporal-rule-name { color:var(--dsw-alias-label-secondary); font-size:10px; font-variant-numeric:tabular-nums; }
.uh-pricing-weekdays { display:inline-flex; gap:3px; }
.uh-pricing-weekday { width:26px; height:26px; border:1px solid var(--dsw-alias-border-l2); border-radius:6px; background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-secondary); font:inherit; font-size:10px; cursor:pointer; }
.uh-pricing-weekday.uh-on { border-color:var(--dsw-alias-brand-primary); color:var(--dsw-alias-label-primary); background:color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent); }
.uh-pricing-temporal-windows { display:flex; align-items:center; flex-wrap:wrap; gap:7px; margin-top:7px; }
.uh-pricing-temporal-window { display:inline-flex; align-items:center; gap:5px; }
.uh-pricing-time-input { box-sizing:border-box; width:66px; min-height:28px; border:1px solid var(--dsw-alias-border-l2); border-radius:6px; padding:3px 6px; background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); font:inherit; font-size:11px; font-variant-numeric:tabular-nums; text-align:center; outline:none; }
.uh-pricing-time-input:focus { border-color:var(--dsw-alias-brand-primary); }
.uh-pricing-time-sep { color:var(--dsw-alias-label-secondary); }
.uh-pricing-temporal-rates { display:flex; flex-wrap:wrap; gap:9px; margin-top:8px; }
.uh-pricing-temporal-rate { display:inline-flex; align-items:center; gap:5px; color:var(--dsw-alias-label-secondary); font-size:10px; }
.uh-pricing-temporal-rate input { box-sizing:border-box; width:86px; min-height:28px; border:1px solid var(--dsw-alias-border-l2); border-radius:6px; padding:3px 7px; background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); font:inherit; font-size:11px; font-variant-numeric:tabular-nums; outline:none; }
.uh-pricing-temporal-foot { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-top:8px; }
.uh-pricing-temporal-holidays { display:flex; flex-direction:column; gap:6px; margin-top:8px; padding:8px 10px; border:1px solid var(--dsw-alias-border-l1); border-radius:8px; background:var(--dsw-alias-bg-base); }
.uh-pricing-holiday-load { display:flex; align-items:center; flex-wrap:wrap; gap:8px; }
.uh-pricing-holiday-load input[type='number'] { box-sizing:border-box; width:82px; min-height:28px; border:1px solid var(--dsw-alias-border-l2); border-radius:6px; padding:3px 7px; background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); font:inherit; font-size:11px; outline:none; }
.uh-pricing-holiday-input { box-sizing:border-box; width:100%; min-height:74px; resize:vertical; border:1px solid var(--dsw-alias-border-l2); border-radius:6px; padding:6px 8px; background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); font:inherit; font-size:11px; font-variant-numeric:tabular-nums; outline:none; }
.uh-pricing-holiday-input:focus { border-color:var(--dsw-alias-brand-primary); }
.uh-pricing-warning { margin-top:7px; padding:7px 9px; border-radius:7px; border:1px solid color-mix(in srgb, var(--dsw-alias-warning, #d9822b) 40%, var(--dsw-alias-border-l1)); color:var(--dsw-alias-warning, #a55b00); font-size:11px; line-height:1.45; }
@media (max-width:640px) {
  .uh-pricing-table-wrap { overflow-x:auto; }
  .uh-pricing-price-table { min-width:820px; }
  .uh-pricing-map-cell { min-width:170px; }
}

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
.uh-hm-tools { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.uh-heatmap-spans button { white-space:nowrap; }
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
.uh-side-modal { position:fixed; inset:var(--uh-top-inset, 0px) 0 0 0; z-index:1100; background:color-mix(in srgb, #000 44%, transparent); display:flex; align-items:stretch; justify-content:center; padding:26px; }
.uh-side-dialog { width:min(1120px, 100%); overflow-x:hidden; overflow-y:scroll; scrollbar-gutter:stable; scrollbar-width:auto; scrollbar-color:#707780 #1d1f22; background:var(--dsw-alias-bg-base); border:1px solid var(--dsw-alias-border-l2); border-radius:14px; box-shadow:0 18px 52px rgba(0,0,0,.35); padding:18px; }
.uh-side-dialog::-webkit-scrollbar, .uh-pricing-table-wrap::-webkit-scrollbar { width:12px; height:12px; }
.uh-side-dialog::-webkit-scrollbar-track, .uh-pricing-table-wrap::-webkit-scrollbar-track { background:#1d1f22; border-left:1px solid #363a40; }
.uh-side-dialog::-webkit-scrollbar-thumb, .uh-pricing-table-wrap::-webkit-scrollbar-thumb { background:#707780; border:3px solid #1d1f22; border-radius:6px; }
.uh-side-dialog::-webkit-scrollbar-thumb:hover, .uh-pricing-table-wrap::-webkit-scrollbar-thumb:hover { background:#9aa1aa; }
.uh-side-dialog-head { display:flex; justify-content:flex-end; margin-bottom:8px; }
@media (max-width: 640px) { .uh-side-modal { padding:0; } .uh-side-dialog { border-radius:0; border:0; padding:14px; } }
/* iOS-style dashboard: grouped surfaces, tactile controls, and an elevated sheet. */
.uh-page { gap:18px; max-width:1160px; margin:0 auto; padding:12px 2px 34px; font-family:-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", sans-serif; }
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
.uh-side-dialog { width:min(1260px, 100%); max-height:calc(100vh - var(--uh-top-inset, 0px) - 44px); border:0; border-radius:24px 24px 0 0; padding:22px 24px 28px; background:color-mix(in srgb, var(--dsw-alias-bg-base) 94%, transparent); box-shadow:0 -10px 44px rgba(0,0,0,.25); }
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
    // The host asks the registry (the page cannot reach it from the desktop shell)
    // and caches the verdict; force only comes from the refresh button.
    const getVersionCheck = (force) => fetch('/api/all-usage/version' + (force === true ? '?force=1' : ''), { headers: { accept: 'application/json' } }).then((r) => {
      if (!r.ok) {
        // The status distinguishes a host that predates this route (401/404 - DSH
        // answers unknown API paths itself) from a registry that could not be read.
        const error = new Error('HTTP ' + r.status)
        error.status = r.status
        throw error
      }
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
    // Fetches one year of the Chinese holiday arrangement; nothing is stored
    // until the user saves, which is what freezes the dates into the policy.
    const loadHolidayCalendarRpc = (year, writeToken) => fetch('/api/all-usage/pricing/holidays', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-all-usage-request-token': writeToken },
      body: JSON.stringify({ year, backfill: false }),
    }).then((r) => r.json().catch(() => ({ ok: false, message: 'bad-response' })).then((data) => {
      if (data !== null && typeof data === 'object') return data
      return { ok: false, message: 'HTTP ' + r.status }
    }))

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
        if (['today', '7d', '30d', '90d', 'all'].includes(value.range)) state.range = value.range
        if (HEATMAP_SPAN_KEYS.includes(value.heatmapSpan)) state.heatmapSpan = value.heatmapSpan
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
      const [heatmapSpan, setHeatmapSpan] = React.useState(() => normalizeHeatmapSpan(usageUiState.heatmapSpan))
      // The registry verdict for the header chip. The host caches it for hours, so
      // opening the dashboard asks at most once per cache window.
      const [versionInfo, setVersionInfo] = React.useState(null)
      const [versionError, setVersionError] = React.useState('')
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
      // Search, preview and editor state is keyed by pricingRowKey (a stable
      // string) instead of a row index: deleting or shifting rows can no longer
      // misroute an in-flight search or an open editor.
      const [pricingModelSearchOptions, setPricingModelSearchOptions] = React.useState({})
      const [pricingModelSearchText, setPricingModelSearchText] = React.useState({})
      const [pricingModelSearchOpen, setPricingModelSearchOpen] = React.useState(null)
      const [pricingPickedTargets, setPricingPickedTargets] = React.useState({})
      const [pricingOpenEditor, setPricingOpenEditor] = React.useState(null)
      const [pricingTemporalDrafts, setPricingTemporalDrafts] = React.useState({})
      const [pricingHolidayYear, setPricingHolidayYear] = React.useState(() => new Date().getFullYear())
      const [pricingHolidayLoading, setPricingHolidayLoading] = React.useState(false)
      const [pricingHolidayStatus, setPricingHolidayStatus] = React.useState('')
      const pricingModelSearchSeqRef = React.useRef({})
      const pricingSearchEpochRef = React.useRef(0)
      const pricingModelSearchTimerRef = React.useRef({})
      const pricingOpenRef = React.useRef(false)
      const refreshPricingPanelRef = React.useRef(() => {})
      const refreshVersionRef = React.useRef(() => {})
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
        setPricingModelSearchText({})
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
  // Latest write capability seen by the poller: the host rotates it on every
  // plugin apply, and writes must not keep using the one the page loaded with.
  const requestTokenRef = React.useRef('')
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
      React.useEffect(() => { persistUsageUiState({ heatmapSpan }) }, [heatmapSpan])
      React.useEffect(() => {
        let alive = true
        const load = (force) => getVersionCheck(force).then(
          (data) => { if (alive) { setVersionInfo(data); setVersionError('') } },
          (reason) => { if (alive) setVersionError(reason && (reason.status === 401 || reason.status === 404) ? 'endpoint' : 'failed') },
        )
        refreshVersionRef.current = () => load(false)
        load(false)
        return () => {
          alive = false
          refreshVersionRef.current = () => {}
        }
      }, [])

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
            const previousHostVersion = appliedSnapshot !== null && typeof appliedSnapshot.pluginVersion === 'string' ? appliedSnapshot.pluginVersion : ''
            appliedSnapshot = data
            if (data.scan) scanDone = !!data.scan.done
            // A restarted host runs a different version, so a verdict cached for the
            // previous one no longer applies (the new host also has a fresh cache).
            const nextHostVersion = typeof data.pluginVersion === 'string' ? data.pluginVersion : ''
            if (nextHostVersion !== '' && nextHostVersion !== previousHostVersion) refreshVersionRef.current()
            const nextToken = typeof data.requestToken === 'string' ? data.requestToken : ''
            const tokenChanged = nextToken !== '' && nextToken !== requestToken
            requestToken = nextToken
            if (nextToken !== '') requestTokenRef.current = nextToken
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
      const onRefresh = React.useCallback(() => {
        refreshRef.current()
        // The refresh button is the one place allowed to bypass the host cache: it is
        // an explicit user action, so "is there a newer release" is answered fresh.
        getVersionCheck(true).then(
          (data) => { if (data) { setVersionInfo(data); setVersionError('') } },
          (reason) => setVersionError(reason && (reason.status === 401 || reason.status === 404) ? 'endpoint' : 'failed'),
        )
      }, [])
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
      const chooseHeatmapSpan = (next) => { setHeatmapSpan(normalizeHeatmapSpan(next)) }
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
        const meta = wsById.get(id)
        if (meta !== undefined && meta.retiredBucket === true) return language === 'en' ? 'Deleted' : '已删除'
        const base = typeof alias === 'string' && alias !== '' ? alias : (meta && meta.title ? meta.title : (language === 'en' ? 'Unknown workspace' : '未知工作区'))
        return meta !== undefined && meta.deleted === true ? base + (language === 'en' ? ' (deleted)' : '（已删除）') : base
      }, [aliases, wsById, language])
      const fullHistoryDayMap = React.useMemo(() => {
        const result = new Map()
        for (const day of activeDayRows) result.set(day.date, day)
        return result
      }, [activeDayRows])
      const st = React.useMemo(() => streaks(fullHistoryDayMap, useUtc), [fullHistoryDayMap, useUtc, latestCalendarDate])
      const pricingSummary = stats && stats.pricing && typeof stats.pricing === 'object' ? stats.pricing : {}
      const currentPricing = pricingDetails && typeof pricingDetails === 'object' ? pricingDetails : pricingSummary
      // One editable row per ledger price route plus the rows that only exist in
      // the saved configuration (they stay visible, editable and removable).
      const pricingRows = React.useMemo(() => pricingOpen ? pricingRowsOf(currentPricing, pricingDraft, pricingPickedTargets) : [], [pricingOpen, currentPricing, pricingDraft, pricingPickedTargets])
      const trendRows = React.useMemo(() => {
        const bounds = queryScope !== null ? { start: queryScope.start, end: queryScope.end } : resolveRangeBounds(stats, range, useUtc, activeCustomRange)
        const hourlyRows = queryUsable && queryScope !== null && queryScope.start === queryScope.end && queryResult && Array.isArray(queryResult.hourly) ? buildTrendHourlyRows(queryResult.hourly, useUtc) : []
        return hourlyRows.length > 0 ? hourlyRows : buildTrendRows(queryUsable && queryResult && Array.isArray(queryResult.daily) ? queryResult.daily : activeDayRows, bounds, useUtc)
      }, [queryScope, queryUsable, queryResult, activeDayRows, stats, range, useUtc, activeCustomRangeKey])
      const trendAnimationKey = queryUsable && queryResult ? queryKey + ':' + (queryVersion(queryResult) || 'query') : queryKey
      const pricingRenderRevision = React.useMemo(() => ({}), [pricingOpen, pricingDraft, pricingLoading, pricingSaving, pricingSyncing, pricingSyncSaving, pricingError, currentPricing, pricingSummary, pricingRows, pricingOpenEditor, pricingTemporalDrafts, pricingModelSearchText, pricingModelSearchOpen, pricingModelSearchOptions, stats, language])
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

      // A rejected write usually means the host rotated its write capability
      // (the plugin was re-applied) while this page stayed open. Re-read the
      // capability from the status endpoint and retry once, so an open panel
      // heals itself instead of reporting a permission error the user cannot act
      // on. Only a 403 is retried; every other failure is surfaced as-is.
      const writeWithFreshToken = (send, onSuccess, onFailure) => {
        const token = requestTokenRef.current
        if (token === '') { onFailure(null); return Promise.resolve() }
        const retry = (reason) => {
          if (reason === null || typeof reason !== 'object' || reason.status !== 403) { onFailure(reason); return Promise.resolve() }
          // The capability only travels in the full snapshot (the status poll
          // carries its derived id), so re-read it from there.
          return getStats().then((data) => {
            const next = data !== null && typeof data === 'object' && typeof data.requestToken === 'string' ? data.requestToken : ''
            if (next === '' || next === token) { onFailure(reason); return undefined }
            requestTokenRef.current = next
            return send(next).then(onSuccess, () => { onFailure(reason) })
          }, () => { onFailure(reason) })
        }
        return send(token).then(onSuccess, retry)
      }
      const saveAlias = (wsId, value) => {
        if (requestTokenRef.current === '') return
        writeWithFreshToken(
          (token) => setAliasRpc(wsId, String(value === undefined ? '' : value).trim(), token),
          (res) => {
            if (res && res.ok && res.aliases) {
              setStats((prev) => (prev === null ? prev : Object.assign({}, prev, { aliases: res.aliases })))
            }
          },
          () => {}
        )
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
      // ---------- cost settings: one editable price table ----------
      const resetPricingTransients = () => {
        setPricingModelSearchOptions({})
        setPricingModelSearchText({})
        setPricingModelSearchOpen(null)
        setPricingPickedTargets({})
        setPricingOpenEditor(null)
        setPricingTemporalDrafts({})
        setPricingHolidayStatus('')
      }
      const closePricingPanel = () => {
        if (pricingSaving || pricingSyncing || pricingSyncSaving) return
        // In-flight official-model searches must not reach a reopened panel.
        invalidatePricingSearches()
        pricingGate.next()
        setPricingLoading(false)
        setPricingOpen(false)
        pricingOpenRef.current = false
        resetPricingTransients()
        setPricingError('')
      }
      const openPricingPanel = () => {
        const seq = pricingGate.next()
        setPricingDetails(null)
        setPricingDraft(null)
        setPricingLoading(true)
        resetPricingTransients()
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
        const validationError = pricingDraftValidationError(pricingDraft, pricingTemporalDrafts)
        if (validationError !== '') { setPricingError(validationError); return }
        if (pricingDraftPayloadTooLarge(pricingDraft)) { setPricingError('too-large'); return }
        if (requestTokenRef.current === '') { setPricingError('token'); return }
        const seq = pricingGate.next()
        setPricingSaving(true)
        setPricingError('')
        writeWithFreshToken(
          (token) => setPricingRpc(pricingDraft, backfill, token),
          (data) => {
            if (!pricingGate.isCurrent(seq)) return
            if (!data || data.ok !== true || !data.pricing) { setPricingError('save'); return }
            setStats((prev) => prev === null ? prev : Object.assign({}, prev, { pricing: data.pricing }))
            setPricingDetails(data.pricing)
            setPricingDraft(pricingDraftOf(data.pricing))
            resetPricingTransients()
            closePricingPanel()
            refreshRef.current()
          },
          (reason) => { if (pricingGate.isCurrent(seq)) setPricingError(reason && reason.status === 403 ? 'stale' : 'save') }
        ).finally(() => setPricingSaving(false))
      }
      const syncPricingNow = () => {
        if (pricingSaving || pricingSyncing || pricingSyncSaving) return
        if (requestTokenRef.current === '') { setPricingError('token'); return }
        setPricingSyncing(true)
        setPricingError('')
        writeWithFreshToken(
          (token) => syncPricingRpc(token),
          (data) => {
          if (!data || data.ok !== true || !data.pricing) { setPricingError('sync'); return }
          // The synced catalog replaces the search corpus; invalidate searches
          // issued against the previous one before updating the panel.
          invalidatePricingSearches()
          setStats((prev) => prev === null ? prev : Object.assign({}, prev, { pricing: data.pricing }))
          setPricingDetails(data.pricing)
          setPricingDraft((prev) => pricingDraftAfterSync(prev, data.pricing))
          setPricingModelSearchOptions({})
          setPricingModelSearchText({})
          setPricingModelSearchOpen(null)
          setPricingPickedTargets({})
            setPricingTemporalDrafts({})
            refreshRef.current()
          },
          (reason) => { setPricingError(reason && reason.status === 403 ? 'stale' : 'sync') }
        ).finally(() => setPricingSyncing(false))
      }
      const updatePricingSync = (enabled) => {
        if (pricingDraft === null || pricingSyncSaving || pricingSaving || pricingSyncing) return
        const nextEnabled = enabled === true
        const previousEnabled = pricingDraft.sync && pricingDraft.sync.autoEnabled === true
        setPricingDraft((prev) => prev === null ? prev : Object.assign({}, prev, { sync: Object.assign({}, prev.sync, { autoEnabled: nextEnabled }) }))
        persistUsageUiState({ pricingAutoSync: nextEnabled })
        if (requestTokenRef.current === '') {
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
        writeWithFreshToken(
          (token) => setPricingRpc({ sync: { autoEnabled: nextEnabled } }, false, token),
          (data) => {
            if (!data || data.ok !== true || !data.pricing) { rollback('save'); return }
            const savedEnabled = data.pricing.sync && data.pricing.sync.autoEnabled === true
            setStats((prev) => prev === null ? prev : Object.assign({}, prev, { pricing: data.pricing }))
            setPricingDetails(data.pricing)
            setPricingDraft((prev) => prev === null ? prev : Object.assign({}, prev, { sync: Object.assign({}, prev.sync, { autoEnabled: savedEnabled, intervalMs: data.pricing.sync && data.pricing.sync.intervalMs }) }))
            persistUsageUiState({ pricingAutoSync: savedEnabled })
          },
          (reason) => rollback(reason && reason.status === 403 ? 'stale' : 'save')
        ).finally(() => setPricingSyncSaving(false))
      }
      const updateRowRate = (view, field, value) => {
        setPricingDraft((prev) => prev === null ? prev : pricingDraftSetRate(prev, view, field, value))
        setPricingError('')
      }
      const updateRowMappingField = (view, field, value) => {
        setPricingDraft((prev) => prev === null ? prev : pricingDraftSetMappingField(prev, view, field, value))
        setPricingError('')
      }
      const chooseRowTarget = (view, option) => {
        if (!option || typeof option.value !== 'string') return
        const pendingTimer = pricingModelSearchTimerRef.current[view.key]
        if (pendingTimer !== undefined) {
          clearTimeout(pendingTimer)
          delete pricingModelSearchTimerRef.current[view.key]
        }
        pricingModelSearchSeqRef.current[view.key] = (pricingModelSearchSeqRef.current[view.key] || 0) + 1
        setPricingDraft((prev) => prev === null ? prev : pricingDraftSetMapping(prev, view, option))
        // The picked entry's rates drive the row preview until the save returns
        // the authoritative resolution from the host.
        setPricingPickedTargets((prev) => Object.assign({}, prev, { [view.key]: option }))
        setPricingModelSearchText((prev) => Object.assign({}, prev, { [view.key]: option.label || option.value }))
        setPricingModelSearchOpen(null)
        setPricingError('')
      }
      const clearRowMapping = (view) => {
        setPricingDraft((prev) => prev === null ? prev : pricingDraftWithoutMapping(prev, view.identityKey))
        setPricingPickedTargets((prev) => { const next = Object.assign({}, prev); delete next[view.key]; return next })
        setPricingModelSearchText((prev) => { const next = Object.assign({}, prev); delete next[view.key]; return next })
        setPricingError('')
      }
      const resetRowOverride = (view) => {
        setPricingDraft((prev) => prev === null ? prev : pricingDraftWithoutOverride(prev, view.basis))
        setPricingTemporalDrafts((prev) => { const next = Object.assign({}, prev); delete next[view.key]; return next })
        setPricingError('')
      }
      const searchRowTargets = (view, value) => {
        const key = view.key
        const searchEpoch = pricingSearchEpochRef.current
        setPricingModelSearchText((prev) => Object.assign({}, prev, { [key]: value }))
        setPricingModelSearchOpen(key)
        const previousTimer = pricingModelSearchTimerRef.current[key]
        if (previousTimer !== undefined) {
          clearTimeout(previousTimer)
          delete pricingModelSearchTimerRef.current[key]
        }
        const nextSeq = (pricingModelSearchSeqRef.current[key] || 0) + 1
        pricingModelSearchSeqRef.current[key] = nextSeq
        if (String(value || '').trim() === '') {
          setPricingModelSearchOptions((prev) => Object.assign({}, prev, { [key]: [] }))
          return
        }
        const timerId = setTimeout(() => {
          delete pricingModelSearchTimerRef.current[key]
          getPricingModels(value).then((data) => {
            // The catalog can be replaced by a sync while a search is in flight;
            // the epoch plus the per-row sequence keeps stale answers out.
            if (pricingSearchEpochRef.current !== searchEpoch) return
            if (pricingModelSearchSeqRef.current[key] !== nextSeq) return
            setPricingModelSearchOptions((prev) => Object.assign({}, prev, { [key]: Array.isArray(data && data.items) ? data.items : [] }))
          }, () => {
            if (pricingSearchEpochRef.current !== searchEpoch) return
            if (pricingModelSearchSeqRef.current[key] === nextSeq) setPricingModelSearchOptions((prev) => Object.assign({}, prev, { [key]: [] }))
          })
        }, 180)
        pricingModelSearchTimerRef.current[key] = timerId
      }
      const addRowTier = (view) => {
        const tiers = pricingTierDraftAdd(view.tiers, view.rates)
        setPricingDraft((prev) => prev === null ? prev : pricingDraftUpsertOverride(prev, view, { tiered: tiers.length > 0, tiers }))
        setPricingError('')
      }
      const updateRowTier = (view, index, field, value) => {
        const tiers = pricingTierDraftUpdate(view.tiers, index, field, value)
        setPricingDraft((prev) => prev === null ? prev : pricingDraftUpsertOverride(prev, view, { tiered: tiers.length > 0, tiers }))
        setPricingError('')
      }
      const removeRowTier = (view, index) => {
        const tiers = pricingTierDraftRemove(view.tiers, index)
        setPricingDraft((prev) => prev === null ? prev : pricingDraftUpsertOverride(prev, view, { tiered: tiers.length > 0, tiers }))
        setPricingError('')
      }
      const applyTemporalDraft = (view, next) => {
        setPricingTemporalDrafts((prev) => Object.assign({}, prev, { [view.key]: next }))
        // Only a complete, valid plan is written into the draft: a half-typed
        // time or rate stays local until it parses, and the save validation
        // still sees the loose draft and refuses to drop the edit silently.
        if (pricingTemporalDraftValidationError(next) === '') {
          setPricingDraft((prev) => prev === null ? prev : pricingDraftUpsertOverride(prev, view, { temporalPricing: pricingTemporalPlanFromDraft(next), temporalPricingInvalid: undefined }))
        }
        setPricingError('')
      }
      const startTemporalRules = (view) => {
        const draft = pricingTemporalDraftOfPlan(view.temporalPlan) || pricingTemporalDraftDefault(view.rates)
        applyTemporalDraft(view, draft)
      }
      const resetTemporalPlan = (view) => {
        setPricingTemporalDrafts((prev) => { const next = Object.assign({}, prev); delete next[view.key]; return next })
        if (view.overrideIndex < 0) return
        // Removing the explicit plan re-attaches the built-in DeepSeek table
        // (or leaves the row on static pricing) without dropping the manual price.
        setPricingDraft((prev) => prev === null ? prev : pricingDraftUpsertOverride(prev, view, { temporalPricing: undefined, temporalPricingInvalid: undefined }))
        setPricingError('')
      }
      const loadRowHolidays = (view) => {
        if (pricingHolidayLoading === true) return
        if (requestTokenRef.current === '') {
          setPricingHolidayStatus(tr('当前进程令牌不可用，请刷新看板', 'The process capability is unavailable; refresh the dashboard'))
          return
        }
        const year = Number(pricingHolidayYear)
        if (!Number.isSafeInteger(year) || year < 2000 || year > 2100) {
          setPricingHolidayStatus(tr('年份无效（2000–2100）', 'Invalid year (2000-2100)'))
          return
        }
        setPricingHolidayLoading(true)
        setPricingHolidayStatus('')
        writeWithFreshToken(
          (token) => loadHolidayCalendarRpc(year, token),
          (data) => {
          if (data === null || typeof data !== 'object' || data.ok !== true || !Array.isArray(data.dates)) {
            const reason = data && typeof data === 'object' && typeof data.message === 'string' && data.message !== '' ? data.message : 'unavailable'
            setPricingHolidayStatus(tr('抓取失败：', 'Fetch failed: ') + reason)
            return
          }
          const draft = pricingTemporalDrafts[view.key] !== undefined
            ? pricingTemporalDrafts[view.key]
            : (pricingTemporalDraftOfPlan(view.temporalPlan) || pricingTemporalDraftDefault(view.rates))
          const merged = pricingHolidayTextMerge(draft.holidaysText, data.dates)
          const fetchedAt = Number(data.fetchedAt)
          const origin = typeof data.paperUrl === 'string' && data.paperUrl !== '' ? data.paperUrl : String(data.sourceUrl || '')
          const stamp = Number.isFinite(fetchedAt) && fetchedAt > 0 ? new Date(fetchedAt).toISOString().slice(0, 16).replace('T', ' ') : ''
          const next = Object.assign(pricingTemporalDraftClone(draft), {
            holidaysEnabled: true,
            holidaysText: merged,
            holidaysSourceText: (origin + (stamp === '' ? '' : ' · ' + stamp) + (data.cached === true ? ' · cached' : '')).slice(0, 512),
          })
          setPricingHolidayStatus(tr('已载入 ', 'Loaded ') + data.dates.length + tr(' 天', ' days') + (data.cached === true ? tr('（缓存）', ' (cached)') : ''))
          // applyTemporalDraft freezes the merged list into the plan draft; the
          // actual freeze happens when the user saves the panel.
          applyTemporalDraft(view, next)
          },
          () => {
            setPricingHolidayStatus(tr('抓取失败：网络不可用', 'Fetch failed: network unavailable'))
          }
        ).finally(() => setPricingHolidayLoading(false))
      }
      const toggleRowEditor = (view, section) => {
        const key = view.key + '|' + section
        setPricingOpenEditor((current) => current === key ? null : key)
        if (section === 'temporal') {
          setPricingTemporalDrafts((prev) => {
            if (prev[view.key] !== undefined) return prev
            const draft = pricingTemporalDraftOfPlan(view.temporalPlan)
            return draft === null ? prev : Object.assign({}, prev, { [view.key]: draft })
          })
        }
        setPricingError('')
      }
      const closeRowEditor = () => setPricingOpenEditor(null)


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

      // brandKey renders the vendor logo (DeepSeek balance) instead of a line icon.
      const card = (label, value, sub, delay, icon, brandKey) => React.createElement('div', { className: 'uh-card', style: { animationDelay: (delay * 70) + 'ms' } },
        React.createElement('div', { className: 'uh-card-label' }, brandKey ? React.createElement(MemoModelIcon, { iconKey: brandKey, size: 15, showTitle: true }) : icon ? React.createElement(LineIcon, { name: icon, size: 14 }) : null, label),
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
                React.createElement('span', { className: 'uh-alias-folder', title: w.path || w.id }, (w.retiredBucket === true ? tr('已删除', 'Deleted') : (w.title || w.path || w.id)) + (w.deleted === true && w.retiredBucket !== true ? tr('（已删除）', ' (deleted)') : '')),
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
      const pricingBusy = pricingSaving || pricingSyncing || pricingSyncSaving
      const pricingWeekdayLabels = language === 'en' ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] : ['日', '一', '二', '三', '四', '五', '六']
      const pricingConfiguredCount = pricingRows.filter((view) => view.usageBacked === false).length
      const pricingUnknownCount = pricingRows.filter((view) => view.usageBacked === null).length
      // The page is served from the same package as the host, so a version
      // difference means DSH still runs the plugin it imported at startup while
      // the browser already has a newer bundle. Say it, instead of letting the
      // user guess why a new panel behaves oddly.
      const pricingHostVersion = typeof statusPayload.pluginVersion === 'string' ? statusPayload.pluginVersion : ''
      const pricingHostMismatch = pricingHostVersion !== '' && clientPluginVersion !== '' && pricingHostVersion !== clientPluginVersion
      // A payload without `usedModels` comes from a host that predates the merged
      // panel: the table is empty because no model list was sent, not because the
      // ledger has no usage.
      const pricingModelsMissing = !Array.isArray(currentPricing.usedModels)
      // The host rotates its write capability whenever the plugin is applied, so
      // a rejected write is a stale capability far more often than a permission
      // problem. Say both, and report the automatic retry when it already failed.
      const pricingErrorMessage = (code) => code === 'stale'
        ? tr('写入被拒绝：进程令牌已失效，自动重取令牌后仍失败，请刷新看板', 'Write rejected: the process capability had rotated and the automatic retry still failed; refresh the dashboard')
        : code === 'forbidden'
          ? tr('写入被拒绝：权限校验未通过（也可能是进程令牌已失效），请刷新看板后重试', 'Write rejected: the permission check failed (a stale process capability is also possible); refresh the dashboard and retry')
          : code === 'token'
            ? tr('当前进程令牌不可用，请刷新看板', 'The process capability is unavailable; refresh the dashboard')
          : code === 'load'
            ? tr('完整费率设置加载失败', 'Full pricing settings could not be loaded')
            : code === 'sync'
              ? tr('models.dev 同步失败，已保留上次成功目录和未保存编辑', 'models.dev sync failed; the last good catalog and unsaved edits were kept')
              : code === 'mapping'
                ? tr('模型映射无效：请选择官方模型并填写有效倍率', 'Invalid mapping: pick an official model and enter a valid multiplier')
                : code === 'tier'
                  ? tr('费率档位无效：最多 32 档；阈值必须为递增的正整数，四项费率必须完整且非负', 'Invalid rate bands: maximum 32; thresholds must be increasing positive integers and all four rates must be complete and non-negative')
                  : code === 'temporal'
                    ? tr('分时计费无效：需要策略 ID，每规则至少一个周几与一个时段，时间格式 HH:MM 且结束大于开始，同周几的时段不得重叠，四项费率必须完整', 'Invalid time-of-day rules: a policy ID, at least one weekday and window per rule, HH:MM times with the end after the start, no overlapping windows on the same weekday, and all four rates filled in')
                    : code === 'override'
                      ? tr('价格无效：请填写完整的非负基础费率', 'Invalid price: enter all non-negative base rates')
                      : code === 'too-large'
                        ? tr('成本设置过大，无法保存：请精简档位或时段规则', 'The cost settings are too large to save: trim bands or peak rules')
                        : tr('成本设置保存失败，请检查输入', 'Cost settings could not be saved; check the inputs')
      const pricingSourceLabel = (view) => {
        if (view.temporalConfigInvalid === true) return tr('时段配置异常', 'Peak plan invalid')
        if (view.tieredInvalid === true) return tr('档位异常', 'Bands invalid')
        if (view.source === 'manual') return tr('手工价', 'Manual')
        if (view.temporalExplicit === true) return tr('自定义峰谷', 'Custom peak')
        if (view.temporalBuiltin === true) return tr('内置峰谷', 'Built-in peak')
        if (view.status === 'priced') return tr('目录价', 'Catalog')
        return pricingStatusLabel(view.status, language)
      }
      const pricingTemporalChipLabel = (view) => {
        if (view.temporalConfigInvalid === true) return tr('时段异常', 'Peak invalid')
        if (view.temporalRulesUnavailable === true) return tr('峰谷计划 ', 'peak plan ') + view.temporalPolicyId
        const planLabel = view.temporalExplicit === true
          ? (view.temporalRuleCount > 0 ? tr('自定义 ', 'custom ') + view.temporalRuleCount + tr(' 条规则', ' rules') : tr('自定义规则', 'custom rules'))
          : view.temporalBuiltin === true ? tr('内置 DeepSeek 峰谷表', 'built-in DeepSeek peak table') : null
        if (planLabel === null) return tr('未启用', 'not enabled')
        // A reseller route is priced statically: the peak plan (and its holiday
        // list) only applies to first-party routes, or after the row is mapped to
        // the official entry — the same distinction the old rate-band badge made.
        if (view.temporalRoute !== 'official' && view.temporalRoute !== 'mapped') {
          return planLabel + tr('（该行非官方直连，暂按静态价；映射到官方条目后生效）', ' (reseller route: static pricing until this row is mapped to the official entry)')
        }
        return planLabel
      }
      const pricingRateInput = (view, field) => React.createElement('input', {
        type: 'number',
        min: '0',
        step: 'any',
        className: 'uh-pricing-rate-input',
        'aria-label': pricingRateLabel(field, language) + ' · ' + (view.model || view.pricingModel || ''),
        title: tr('价格单位为 USD / 1M Token', 'Price per 1M tokens in USD'),
        value: view.rates !== null && view.rates[field] !== undefined ? view.rates[field] : '',
        disabled: pricingBusy,
        onChange: (event) => updateRowRate(view, field, event.target.value),
      })
      const pricingRateCell = (view, field) => React.createElement('td', { className: 'uh-pricing-rate-cell' }, pricingRateInput(view, field))
      const renderTierEditor = (view) => {
        const tiers = view.tiers
        let previousTierSize = 0
        const rows = tiers.map((tier, tierIndex) => {
          const valid = pricingTierDraftValid(tier, previousTierSize)
          const numericSize = Number(tier !== null && tier !== undefined && tier.size !== undefined ? tier.size : NaN)
          if (Number.isSafeInteger(numericSize)) previousTierSize = numericSize
          return React.createElement('div', { key: tierIndex, className: 'uh-pricing-tier-edit-row' + (valid ? '' : ' uh-invalid') },
            React.createElement('input', { type: 'number', min: '1', max: '1000000000', step: '1', placeholder: tr('阈值 Token', 'Token threshold'), title: tr('本档覆盖范围：', 'This band covers ') + pricingTierBandLabel(tiers, tierIndex, language), 'aria-label': tr('上下文阈值 Token', 'Context threshold tokens'), value: tier === null || tier === undefined || tier.size === undefined ? '' : tier.size, disabled: pricingBusy, onChange: (event) => updateRowTier(view, tierIndex, 'size', event.target.value) }),
            ['input', 'output', 'cacheRead', 'cacheWrite'].map((key) => React.createElement('input', { key, type: 'number', min: '0', step: 'any', placeholder: pricingRateLabel(key, language), 'aria-label': tr('档位', 'Band') + ' ' + pricingRateLabel(key, language), value: tier === null || tier === undefined || tier[key] === undefined ? '' : tier[key], disabled: pricingBusy, onChange: (event) => updateRowTier(view, tierIndex, key, event.target.value) })),
            React.createElement('button', { type: 'button', className: 'uh-refresh uh-icon-button', title: tr('删除费率档位', 'Remove rate band'), 'aria-label': tr('删除费率档位', 'Remove rate band'), disabled: pricingBusy, onClick: () => removeRowTier(view, tierIndex) }, React.createElement(LineIcon, { name: 'close', size: 14 })),
          )
        })
        return React.createElement('div', { className: 'uh-pricing-tier-editor' },
          React.createElement('div', { className: 'uh-pricing-tier-editor-head' },
            React.createElement('div', { className: 'uh-pricing-tier-editor-title' },
              React.createElement('strong', {}, tr('上下文费率档位', 'Context rate bands')),
              React.createElement('span', {}, tr('输入上下文超过阈值后，整次请求使用该档四项费率', 'Above a threshold, all four rates apply to the whole request')),
            ),
            React.createElement('button', { type: 'button', className: 'uh-refresh', disabled: pricingBusy || tiers.length >= 32, title: tiers.length >= 32 ? tr('每个模型最多 32 个档位', 'Maximum 32 bands per model') : tr('添加上下文费率档位', 'Add context rate band'), onClick: () => addRowTier(view) }, React.createElement(LineIcon, { name: 'plus', size: 13 }), tr('添加档位', 'Add band')),
          ),
          tiers.length === 0
            ? React.createElement('div', { className: 'uh-pricing-tier-empty' }, tr('未配置档位，所有上下文使用基础费率。', 'No bands configured; base rates apply to every context.'))
            : React.createElement(React.Fragment, null,
              React.createElement('div', { className: 'uh-pricing-tier-edit-head' },
                React.createElement('span', {}, tr('超过 Token', 'Above tokens')),
                React.createElement('span', {}, tr('输入 / 1M', 'Input / 1M')),
                React.createElement('span', {}, tr('输出 / 1M', 'Output / 1M')),
                React.createElement('span', {}, tr('缓存读 / 1M', 'Cache read / 1M')),
                React.createElement('span', {}, tr('缓存写 / 1M', 'Cache write / 1M')),
                React.createElement('span', {}, ''),
              ),
              rows,
            ),
        )
      }
      const renderTemporalEditor = (view) => {
        const draft = pricingTemporalDrafts[view.key] !== undefined ? pricingTemporalDrafts[view.key] : pricingTemporalDraftOfPlan(view.temporalPlan)
        const issue = draft === null || draft === undefined ? '' : pricingTemporalDraftValidationError(draft)
        const header = React.createElement('div', { className: 'uh-pricing-tier-editor-head' },
          React.createElement('div', { className: 'uh-pricing-tier-editor-title' },
            React.createElement('strong', {}, tr('分时段计费（UTC）', 'Time-of-day pricing (UTC)')),
            React.createElement('span', {}, view.temporalExplicit === true ? tr('自定义规则', 'Custom rules') : view.temporalRulesUnavailable === true ? tr('峰谷计划 ', 'Peak plan ') + view.temporalPolicyId : view.temporalBuiltin === true ? tr('当前使用内置 DeepSeek 峰谷表', 'Using the built-in DeepSeek peak table') : tr('未启用时段规则', 'No time-of-day rules')),
          ),
          React.createElement('div', { className: 'uh-actions' },
            view.temporalBuiltin === true && view.temporalExplicit !== true ? React.createElement('button', { type: 'button', className: 'uh-refresh', disabled: pricingBusy, onClick: () => startTemporalRules(view) }, view.temporalRulesUnavailable === true ? tr('改为自定义规则', 'Replace with custom rules') : tr('复制内置表并自定义', 'Copy built-in table')) : null,
            view.temporalExplicit === true ? React.createElement('button', { type: 'button', className: 'uh-refresh', disabled: pricingBusy, onClick: () => resetTemporalPlan(view) }, view.temporalBuiltin === true ? tr('恢复内置', 'Restore built-in') : tr('清除时段规则', 'Remove rules')) : null,
            view.temporalBuiltin !== true && view.temporalExplicit !== true ? React.createElement('button', { type: 'button', className: 'uh-refresh', disabled: pricingBusy, onClick: () => startTemporalRules(view) }, React.createElement(LineIcon, { name: 'plus', size: 13 }), tr('启用分时计费', 'Enable time-of-day pricing')) : null,
          ),
        )
        if (draft === null || draft === undefined) {
          return React.createElement('div', { className: 'uh-pricing-tier-editor uh-pricing-temporal-editor' }, header,
            React.createElement('div', { className: 'uh-pricing-tier-empty' }, view.temporalRulesUnavailable === true ? tr('该行已启用峰谷计划（', 'This row already uses a peak plan (') + view.temporalPolicyId + tr('），但运行中的宿主尚未提供规则内容；重启 DSH 后即可查看与编辑。', '), but the running host does not expose its rules yet; restart DSH to view and edit them.') : tr('未启用时段规则：所有请求都使用该行基础价。', 'No time-of-day rules: every request uses the row base rates.')))
        }
        const effectiveFrom = pricingDateTextToUtc(draft.effectiveFromText)
        const holidayDates = draft.holidaysEnabled === true ? pricingHolidayDatesFromText(draft.holidaysText) : null
        const rules = draft.rules.map((rule, ruleIndex) => {
          const windows = rule.windows.map((window, windowIndex) => React.createElement('div', { key: windowIndex, className: 'uh-pricing-temporal-window' },
            React.createElement('input', { type: 'text', className: 'uh-pricing-time-input', placeholder: 'HH:MM', 'aria-label': tr('开始时间', 'Start time'), value: window.start, disabled: pricingBusy, onChange: (event) => applyTemporalDraft(view, pricingTemporalDraftWindows(draft, ruleIndex, rule.windows.map((item, itemIndex) => itemIndex === windowIndex ? { start: event.target.value, end: item.end } : item))) }),
            React.createElement('span', { className: 'uh-pricing-time-sep' }, '–'),
            React.createElement('input', { type: 'text', className: 'uh-pricing-time-input', placeholder: 'HH:MM', 'aria-label': tr('结束时间', 'End time'), value: window.end, disabled: pricingBusy, onChange: (event) => applyTemporalDraft(view, pricingTemporalDraftWindows(draft, ruleIndex, rule.windows.map((item, itemIndex) => itemIndex === windowIndex ? { start: item.start, end: event.target.value } : item))) }),
            rule.windows.length > 1 ? React.createElement('button', { type: 'button', className: 'uh-refresh uh-icon-button', title: tr('删除时段', 'Remove window'), 'aria-label': tr('删除时段', 'Remove window'), disabled: pricingBusy, onClick: () => applyTemporalDraft(view, pricingTemporalDraftWindows(draft, ruleIndex, rule.windows.filter((_, itemIndex) => itemIndex !== windowIndex))) }, React.createElement(LineIcon, { name: 'close', size: 13 })) : null,
          ))
          return React.createElement('div', { key: rule.id + ':' + ruleIndex, className: 'uh-pricing-temporal-rule' },
            React.createElement('div', { className: 'uh-pricing-temporal-rule-head' },
              React.createElement('span', { className: 'uh-pricing-temporal-rule-name' }, rule.id),
              React.createElement('div', { className: 'uh-pricing-weekdays' },
                pricingWeekdayLabels.map((label, day) => React.createElement('button', { key: day, type: 'button', className: 'uh-pricing-weekday' + (rule.weekdays.includes(day) ? ' uh-on' : ''), 'aria-pressed': rule.weekdays.includes(day), disabled: pricingBusy, onClick: () => applyTemporalDraft(view, pricingTemporalDraftToggleWeekday(draft, ruleIndex, day)) }, label)),
              ),
              React.createElement('button', { type: 'button', className: 'uh-refresh uh-icon-button', disabled: pricingBusy || draft.rules.length <= 1, title: tr('删除规则', 'Remove rule'), 'aria-label': tr('删除规则', 'Remove rule'), onClick: () => applyTemporalDraft(view, pricingTemporalDraftWithoutRule(draft, ruleIndex)) }, React.createElement(LineIcon, { name: 'close', size: 14 })),
            ),
            React.createElement('div', { className: 'uh-pricing-temporal-windows' },
              windows,
              rule.windows.length < 16 ? React.createElement('button', { type: 'button', className: 'uh-pricing-link', disabled: pricingBusy, onClick: () => applyTemporalDraft(view, pricingTemporalDraftWindows(draft, ruleIndex, rule.windows.concat([{ start: '06:00', end: '10:00' }]))) }, tr('添加时段', 'Add window')) : null,
            ),
            React.createElement('div', { className: 'uh-pricing-temporal-rates' },
              ['input', 'output', 'cacheRead', 'cacheWrite'].map((key) => React.createElement('label', { key, className: 'uh-pricing-temporal-rate' },
                React.createElement('span', {}, tr('峰时·', 'Peak ·') + pricingRateLabel(key, language).split(' / ')[0]),
                React.createElement('input', { type: 'number', min: '0', step: 'any', value: rule.rates[key], disabled: pricingBusy, onChange: (event) => applyTemporalDraft(view, pricingTemporalDraftRates(draft, ruleIndex, Object.assign({}, rule.rates, { [key]: event.target.value }))) }),
              )),
            ),
          )
        })
        return React.createElement('div', { className: 'uh-pricing-tier-editor uh-pricing-temporal-editor' },
          header,
          React.createElement('div', { className: 'uh-pricing-tier-empty' }, tr('谷时段（未命中规则）使用该行基础价，峰时段使用规则费率；周几与时间均为 UTC。', 'Off-peak (no rule match) uses the row base rates, peak uses the rule rates. Weekdays and times are UTC.')),
          React.createElement('div', { className: 'uh-pricing-temporal-fields' },
            React.createElement('label', {}, React.createElement('span', {}, tr('策略 ID', 'Policy ID')), React.createElement('input', { type: 'text', value: draft.policyId, disabled: pricingBusy, onChange: (event) => applyTemporalDraft(view, Object.assign(pricingTemporalDraftClone(draft), { policyId: event.target.value })) })),
            React.createElement('label', {}, React.createElement('span', {}, tr('生效起点（UTC，留空 = 全部历史）', 'Effective from (UTC, empty = all history)')), React.createElement('input', { type: 'date', value: draft.effectiveFromText, disabled: pricingBusy, onChange: (event) => applyTemporalDraft(view, Object.assign(pricingTemporalDraftClone(draft), { effectiveFromText: event.target.value })) })),
          ),
          effectiveFrom !== null && effectiveFrom > 0 ? React.createElement('div', { className: 'uh-pricing-warning' }, tr('该时刻之前的用量没有可用档位，会失败关闭为未计价。', 'Usage before this instant has no applicable band and fails closed as unpriced.')) : null,
          React.createElement('div', { className: 'uh-pricing-temporal-holidays' },
            React.createElement('label', { className: 'uh-pricing-switch' },
              React.createElement('input', { type: 'checkbox', checked: draft.holidaysEnabled === true, disabled: pricingBusy, onChange: (event) => applyTemporalDraft(view, Object.assign(pricingTemporalDraftClone(draft), { holidaysEnabled: event.target.checked })) }),
              React.createElement('span', {}, tr('中国法定节假日全天按谷时计价', 'Chinese statutory holidays price as off-peak all day')),
            ),
            draft.holidaysEnabled === true ? React.createElement(React.Fragment, null,
              React.createElement('div', { className: 'uh-pricing-tier-empty' }, tr('每行一个日期（YYYY-MM-DD），支持区间写法 2026-10-01..2026-10-07。按北京时间（UTC+8）日历日判定；调休上班日不会被自动识别，需要你自己从列表里去掉。', 'One date per line (YYYY-MM-DD); ranges such as 2026-10-01..2026-10-07 are expanded. Days follow the China Standard Time (UTC+8) calendar; swapped-in working weekends are not detected, so remove them yourself.')),
              React.createElement('textarea', { className: 'uh-pricing-holiday-input', rows: 4, spellCheck: false, disabled: pricingBusy, placeholder: '2026-10-01\n2026-10-02', 'aria-label': tr('法定节假日日期', 'Statutory holiday dates'), value: draft.holidaysText, onChange: (event) => applyTemporalDraft(view, Object.assign(pricingTemporalDraftClone(draft), { holidaysText: event.target.value })) }),
              holidayDates === null
                ? React.createElement('span', { className: 'uh-pricing-error' }, tr('日期格式无效：请使用 YYYY-MM-DD，或 start..end 区间', 'Invalid dates: use YYYY-MM-DD, or a start..end range'))
                : React.createElement('span', { className: 'uh-pricing-tier-empty' }, tr('已解析 ', 'parsed ') + holidayDates.length + tr(' 天节假日', ' holiday days')),
              React.createElement('div', { className: 'uh-pricing-holiday-load' },
                React.createElement('label', { className: 'uh-pricing-map-field' },
                  React.createElement('span', {}, tr('年份', 'Year')),
                  React.createElement('input', { type: 'number', min: '2000', max: '2100', step: '1', value: pricingHolidayYear, disabled: pricingBusy || pricingHolidayLoading, 'aria-label': tr('要载入的年份', 'Year to load'), onChange: (event) => setPricingHolidayYear(Number(event.target.value)) }),
                ),
                React.createElement('button', { type: 'button', className: 'uh-refresh', disabled: pricingBusy || pricingHolidayLoading, onClick: () => loadRowHolidays(view) }, React.createElement(LineIcon, { name: 'refresh', size: 13 }), pricingHolidayLoading ? tr('抓取中…', 'Fetching…') : tr('从公开日历载入', 'Load from public calendar')),
                pricingHolidayStatus !== '' ? React.createElement('span', { className: 'uh-pricing-tier-empty' }, pricingHolidayStatus) : null,
              ),
              draft.holidaysSourceText !== '' ? React.createElement('span', { className: 'uh-pricing-tier-empty', title: draft.holidaysSourceText }, tr('来源：', 'Source: ') + draft.holidaysSourceText) : null,
            ) : null,
          ),
          rules,
          React.createElement('div', { className: 'uh-pricing-temporal-foot' },
            draft.rules.length < 16 ? React.createElement('button', { type: 'button', className: 'uh-refresh', disabled: pricingBusy, onClick: () => applyTemporalDraft(view, pricingTemporalDraftWithRule(draft)) }, React.createElement(LineIcon, { name: 'plus', size: 13 }), tr('添加规则', 'Add rule')) : null,
            issue !== '' ? React.createElement('span', { className: 'uh-pricing-error' }, tr('时段规则尚未完成，保存前需修正。', 'The rules are incomplete; fix them before saving.')) : null,
          ),
        )
      }
      const renderRowEditor = (view) => {
        const section = pricingOpenEditor !== null && pricingOpenEditor.indexOf(view.key + '|') === 0 ? pricingOpenEditor.slice(view.key.length + 1) : ''
        return React.createElement('div', { className: 'uh-pricing-editor' },
          section === 'tiers' ? renderTierEditor(view) : null,
          section === 'temporal' ? renderTemporalEditor(view) : null,
          React.createElement('div', { className: 'uh-pricing-editor-foot' },
            React.createElement('button', { type: 'button', className: 'uh-pricing-link', onClick: closeRowEditor }, tr('收起', 'Collapse')),
          ),
        )
      }
      const pricingSearchTextFor = (view) => pricingModelSearchText[view.key]
      const renderPricingRow = (view) => {
        const openSection = pricingOpenEditor !== null && pricingOpenEditor.indexOf(view.key + '|') === 0 ? pricingOpenEditor : null
        const searchText = pricingSearchTextFor(view)
        const options = Array.isArray(pricingModelSearchOptions[view.key]) ? pricingModelSearchOptions[view.key] : []
        return React.createElement(React.Fragment, { key: view.key },
          React.createElement('tr', { className: 'uh-pricing-model-row' + (view.usageBacked === true ? '' : view.usageBacked === false ? ' uh-pricing-configured-row' : ' uh-pricing-unknown-row') },
            React.createElement('td', { className: 'uh-pricing-model-name' },
              React.createElement('span', { className: 'uh-model-label', title: view.model }, React.createElement(MemoModelIcon, { row: view.row, size: 16 }), React.createElement('span', { className: 'uh-model-text' }, view.model || tr('未知模型', 'Unknown model'))),
              React.createElement('div', { className: 'uh-pricing-row-flags' },
                React.createElement('span', { className: 'uh-pricing-status uh-pricing-status-' + view.status, title: view.reason || '' }, pricingStatusLabel(view.status, language)),
                React.createElement('span', { className: 'uh-pricing-tier-badge uh-flat' }, pricingSourceLabel(view)),
                view.mapped ? React.createElement('span', { className: 'uh-pricing-flag' }, tr('已映射', 'Mapped')) : null,
                view.usageBacked === true
                  ? null
                  : view.usageBacked === false
                    ? React.createElement('span', { className: 'uh-pricing-flag' }, tr('账本无用量', 'No ledger usage'))
                    : React.createElement('span', { className: 'uh-pricing-flag uh-pricing-flag-unknown', title: tr('宿主未在模型清单里标注账本用量（通常是宿主插件版本较旧）；这不代表没有用量', 'The host did not label ledger usage for this row (usually an older host plugin); it does not mean the row has none') }, tr('用量未知', 'Usage unknown')),
              ),
            ),
            React.createElement('td', { className: 'uh-pricing-map-cell' },
              React.createElement('div', { className: 'uh-pricing-model-search' },
                React.createElement('input', {
                  type: 'text',
                  className: 'uh-pricing-model-search-input',
                  placeholder: view.mappable === true ? tr('输入官方模型 ID 检索', 'Type an official model ID') : tr('该行不是账本路线', 'Not a ledger route'),
                  value: searchText !== undefined ? searchText : (view.pricingModel || ''),
                  disabled: pricingBusy || view.mappable !== true,
                  'aria-label': tr('官方模型 ID', 'Official model ID'),
                  'aria-autocomplete': 'list',
                  onFocus: (event) => {
                    if (view.mappable !== true || pricingBusy === true) return
                    setPricingModelSearchOpen(view.key)
                    // Focusing must never clear the row's current model: keep the
                    // text visible and select it, so typing replaces it instead.
                    const field = event.target
                    if (field === null || field === undefined || typeof field.select !== 'function') return
                    try { field.select() } catch (err) { /* a detached field is harmless */ }
                    // The click that focused the field places the caret after this
                    // event, so re-apply the selection on the next frame.
                    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => { try { field.select() } catch (err) { /* ignore */ } })
                  },
                  onBlur: () => setTimeout(() => { setPricingModelSearchOpen((current) => current === view.key ? null : current); setPricingModelSearchText((prev) => { const next = Object.assign({}, prev); delete next[view.key]; return next }) }, 140),
                  onKeyDown: (event) => { if (event.key === 'Escape') setPricingModelSearchOpen(null) },
                  onChange: (event) => searchRowTargets(view, event.target.value),
                }),
                pricingModelSearchOpen === view.key && options.length > 0 ? React.createElement('div', { className: 'uh-language-options uh-pricing-model-options', role: 'listbox', 'aria-label': tr('官方模型匹配结果', 'Official model matches') },
                  options.map((option) => React.createElement('button', { key: option.value, type: 'button', role: 'option', className: 'uh-language-option uh-pricing-model-option', onMouseDown: (event) => event.preventDefault(), onClick: () => chooseRowTarget(view, option) },
                    React.createElement(LineIcon, { name: 'list', size: 14 }),
                    React.createElement('span', { className: 'uh-pricing-model-option-name' }, option.label || option.value),
                    React.createElement('span', { className: 'uh-pricing-model-option-id' }, option.value + (option.tiered === true ? ' · ' + tr('分层 ', 'tiered ') + option.tierCount : '') + (option.builtinTemporal === true ? ' · ' + tr('峰谷', 'peak') : '')),
                  )),
                ) : null,
                view.mapped ? React.createElement('button', { type: 'button', className: 'uh-pricing-link uh-pricing-clear-mapping', disabled: pricingBusy, title: tr('删除该行的官方模型映射，回到按模型自动匹配', 'Remove this row mapping and fall back to automatic model matching'), onClick: () => clearRowMapping(view) }, tr('清除映射', 'Clear mapping')) : null,
              ),
              React.createElement('div', { className: 'uh-pricing-map-sub' },
                React.createElement('label', { className: 'uh-pricing-map-field' },
                  React.createElement('span', {}, tr('倍率', 'Multiplier')),
                  React.createElement('input', { type: 'number', min: '0', step: 'any', value: view.multiplier, disabled: pricingBusy || view.mapped !== true, title: view.mapped === true ? tr('成本倍率，只作用于最终总价', 'Cost multiplier; applied to the final total only') : tr('设置映射后生效', 'Effective after a mapping is set'), 'aria-label': tr('成本倍率', 'Cost multiplier'), onChange: (event) => updateRowMappingField(view, 'multiplier', event.target.value) }),
                ),
                React.createElement('label', { className: 'uh-pricing-map-field' },
                  React.createElement('span', {}, tr('输入口径', 'Input semantics')),
                  React.createElement('select', { value: view.inputTokenSemantics, disabled: pricingBusy || view.mapped !== true, 'aria-label': tr('输入口径', 'Input semantics'), title: pricingSemanticsLabel(view.inputTokenSemantics, language), onChange: (event) => updateRowMappingField(view, 'inputTokenSemantics', event.target.value) },
                    React.createElement('option', { value: 'fresh' }, 'Fresh'),
                    React.createElement('option', { value: 'total' }, 'Total'),
                    React.createElement('option', { value: 'legacy' }, 'Legacy'),
                  ),
                ),
              ),
            ),
            pricingRateCell(view, 'input'),
            pricingRateCell(view, 'output'),
            pricingRateCell(view, 'cacheRead'),
            pricingRateCell(view, 'cacheWrite'),

            React.createElement('td', { className: 'uh-pricing-row-actions' },
              React.createElement('button', { type: 'button', className: 'uh-pricing-chip' + (openSection !== null && openSection.slice(view.key.length + 1) === 'tiers' ? ' uh-on' : '') + (view.tierCount > 0 ? ' uh-strong' : ''), disabled: pricingBusy, title: view.tierCount > 0 ? tr('上下文分层：已配置 ', 'Context tiers: ') + view.tierCount + tr(' 个档位', ' bands') : tr('上下文分层：未配置，所有上下文使用基础费率', 'Context tiers: none, base rates apply to every context'), onClick: () => toggleRowEditor(view, 'tiers') }, tr('上下文分层', 'Context tiers')),
              React.createElement('button', { type: 'button', className: 'uh-pricing-chip' + (openSection !== null && openSection.slice(view.key.length + 1) === 'temporal' ? ' uh-on' : '') + (view.temporalBuiltin === true || view.temporalExplicit === true ? ' uh-strong' : ''), disabled: pricingBusy, title: tr('时间分层：', 'Time tiers: ') + pricingTemporalChipLabel(view), onClick: () => toggleRowEditor(view, 'temporal') }, tr('时间分层', 'Time tiers')),
              view.source === 'manual' ? React.createElement('button', { type: 'button', className: 'uh-pricing-link', disabled: pricingBusy, title: tr('删除手工价，回落到目录价或内置峰谷', 'Remove the manual price and fall back to the catalog or the built-in peak table'), onClick: () => resetRowOverride(view) }, tr('恢复默认', 'Reset')) : null,
            ),
          ),
          openSection === null ? null : React.createElement('tr', { className: 'uh-pricing-editor-row' },
            React.createElement('td', { colSpan: 7 }, renderRowEditor(view)),
          ),
        )
      }
      const renderPricingPanel = () => pricingDraft !== null ? React.createElement('div', { className: 'uh-panel uh-pricing-panel uh-anim-panel' },
        React.createElement('div', { className: 'uh-pricing-head' },
          React.createElement('div', { className: 'uh-title-with-icon' }, React.createElement(LineIcon, { name: 'wallet', size: 16 }), React.createElement('strong', {}, tr('成本统计设置', 'Cost Statistics'))),
          React.createElement('button', { type: 'button', className: 'uh-refresh uh-icon-button', title: tr('关闭成本设置', 'Close cost settings'), 'aria-label': tr('关闭成本设置', 'Close cost settings'), disabled: pricingBusy, onClick: closePricingPanel }, React.createElement(LineIcon, { name: 'close', size: 16 })),
        ),
        React.createElement('div', { className: 'uh-pricing-note' }, tr('价格单位为 USD / 1M Token。直接改价格框即创建或更新手工价（同一官方模型的所有行共享同一价格）；「官方模型」列选定映射后该行自动改用官方目录价；「档位」配置上下文费率档，「分时计费」配置 UTC 峰谷规则。', 'Prices are USD per 1M tokens. Editing a price box creates or updates a manual price (every row priced from the same official model shares it). Picking an official model in the mapping column switches the row to the catalog price. Bands add context-dependent rates; Time-of-day adds UTC peak rules.')),
        React.createElement('div', { className: 'uh-pricing-toolbar' },
          React.createElement('label', { className: 'uh-pricing-switch' },
            React.createElement('input', { type: 'checkbox', checked: pricingDraft.sync.autoEnabled === true, disabled: pricingBusy, onChange: (event) => updatePricingSync(event.target.checked) }),
            React.createElement('span', {}, tr('启用 6 小时自动同步', 'Enable 6-hour automatic sync')),
          ),
          React.createElement('span', { className: 'uh-note' }, pricingSyncSaving ? tr('保存中…', 'Saving…') : (pricingSync.lastSuccessAt > 0 ? tr('上次成功：', 'Last success: ') + new Date(pricingSync.lastSuccessAt).toLocaleString() : tr('尚未同步', 'Not synced yet'))),
          React.createElement('button', { type: 'button', className: 'uh-refresh', onClick: syncPricingNow, disabled: pricingBusy }, React.createElement(LineIcon, { name: 'refresh', size: 14 }), pricingSyncing ? tr('同步中…', 'Syncing…') : tr('立即同步', 'Sync now')),
        ),
        pricingSync.lastError ? React.createElement('div', { className: 'uh-pricing-error', role: 'alert' }, tr('上次同步失败：', 'Last sync failed: ') + pricingSync.lastError) : null,
        pricingHostMismatch ? React.createElement('div', { className: 'uh-pricing-error', role: 'status' }, tr('宿主插件 v', 'Host plugin v') + pricingHostVersion + tr(' 与当前页面 v', ' and this page v') + clientPluginVersion + tr(' 不一致：DSH 只在启动时加载插件，请重启 DSH 让新版本生效（本面板正按旧宿主的数据降级显示）', ' differ: DSH imports the plugin only at startup, so restart DSH for the new version (this panel is showing the older host payload)')) : null,
        pricingModelsMissing ? React.createElement('div', { className: 'uh-pricing-error', role: 'status' }, tr('宿主未提供模型清单（插件版本较旧）：无法列出账本模型；请重启 DSH 后重新打开本面板', 'The host sent no model list (older plugin): the ledger models cannot be listed; restart DSH and reopen this panel')) : null,
        React.createElement('div', { className: 'uh-pricing-table-note' },
          tr('共 ', '') + pricingRows.length + tr(' 个模型', ' models') + (pricingConfiguredCount > 0 ? tr('（', ' (') + pricingConfiguredCount + tr(' 项仅存在于配置中，账本暂无用量）', ' configured rows have no ledger usage)') : '') + (pricingUnknownCount > 0 ? tr('（其中 ', ' (') + pricingUnknownCount + tr(' 项用量未知：宿主未标注账本用量）', ' rows have unknown usage: the host did not label ledger usage)') : '') + (pricingRows.length >= 500 ? tr(' · 已达 500 行上限', ' · capped at 500 rows') : ''),
        ),
        React.createElement('div', { className: 'uh-pricing-table-wrap' },
          React.createElement('table', { className: 'uh-pricing-model-table uh-pricing-price-table' },
            React.createElement('thead', {}, React.createElement('tr', {},
              React.createElement('th', { scope: 'col' }, tr('模型', 'Model')),
              React.createElement('th', { scope: 'col' }, tr('官方模型 / 映射', 'Official model / mapping')),
              React.createElement('th', { scope: 'col' }, tr('输入 / 1M', 'Input / 1M')),
              React.createElement('th', { scope: 'col' }, tr('输出 / 1M', 'Output / 1M')),
              React.createElement('th', { scope: 'col' }, tr('缓存读 / 1M', 'Cache read / 1M')),
              React.createElement('th', { scope: 'col' }, tr('缓存写 / 1M', 'Cache write / 1M')),
              React.createElement('th', { scope: 'col' }, tr('操作', 'Actions')),
            )),
            React.createElement('tbody', {}, pricingRows.length === 0
              ? React.createElement('tr', {}, React.createElement('td', { colSpan: 7 }, React.createElement('div', { className: 'uh-empty', style: { padding: '12px 0' } }, tr('暂无模型用量', 'No model usage yet'))))
              : pricingRows.map((view) => React.createElement(MemoUsagePricingRow, {
                key: view.key,
                view,
                busy: pricingBusy,
                language,
                openSection: pricingOpenEditor !== null && pricingOpenEditor.indexOf(view.key + '|') === 0 ? pricingOpenEditor : null,
                searchText: pricingSearchTextFor(view) === undefined ? null : pricingSearchTextFor(view),
                searchOpen: pricingModelSearchOpen === view.key,
                searchOptions: Array.isArray(pricingModelSearchOptions[view.key]) ? pricingModelSearchOptions[view.key] : null,
                temporalDraft: pricingTemporalDrafts[view.key] === undefined ? null : pricingTemporalDrafts[view.key],
                temporalPlan: view.temporalPlan,
                holidayStatus: pricingHolidayStatus,
                holidayLoading: pricingHolidayLoading,
                render: renderPricingRow,
              }))),
          ),
        ),
        pricingError !== '' ? React.createElement('div', { className: 'uh-pricing-error', role: 'alert' }, pricingErrorMessage(pricingError)) : null,
        React.createElement('div', { className: 'uh-pricing-foot' },
          React.createElement('span', { className: 'uh-note' }, tr('保存只影响未计价调用与之后的调用，已有正成本不会重算；改动时段规则会按新政策重新对账该模型历史。', 'Saving affects unpriced and future calls only; existing positive costs are never recalculated. Changing a peak plan reconciles that model history against the new rules.')),
          React.createElement('div', { className: 'uh-actions' },
            React.createElement('button', { type: 'button', className: 'uh-refresh', disabled: pricingBusy, onClick: closePricingPanel }, tr('取消', 'Cancel')),
            React.createElement('button', { type: 'button', className: 'uh-refresh', disabled: pricingBusy, onClick: () => savePricingSettings(false) }, pricingSaving ? tr('保存中…', 'Saving…') : tr('保存', 'Save')),
            React.createElement('button', { type: 'button', className: 'uh-refresh uh-pricing-backfill', disabled: pricingBusy, onClick: () => savePricingSettings(true) }, tr('保存并回填', 'Save and backfill')),
          ),
        ),
      ) : React.createElement('div', { className: 'uh-panel uh-pricing-panel uh-anim-panel' },
        React.createElement('div', { className: 'uh-pricing-head' },
          React.createElement('div', { className: 'uh-title-with-icon' }, React.createElement(LineIcon, { name: 'wallet', size: 16 }), React.createElement('strong', {}, tr('成本统计设置', 'Cost Statistics'))),
          React.createElement('button', { type: 'button', className: 'uh-refresh uh-icon-button', title: tr('关闭成本设置', 'Close cost settings'), 'aria-label': tr('关闭成本设置', 'Close cost settings'), disabled: pricingBusy, onClick: closePricingPanel }, React.createElement(LineIcon, { name: 'close', size: 16 })),
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

      const versionView = versionSummaryOf(stats !== null && typeof stats.pluginVersion === 'string' ? stats.pluginVersion : clientPluginVersion, versionInfo)
      const versionStatusText = versionView.status === 'latest'
        ? tr('已是最新', 'Up to date')
        : versionView.status === 'outdated' && versionView.latest !== null
          ? tr('最新 v', 'Latest v') + versionView.latest
          : ''
      const versionTip = tr('当前版本 v', 'Running version v') + versionView.current
        + (versionView.status === 'latest' ? tr('\n已是最新版本', '\nThis is the newest release') : '')
        + (versionView.status === 'outdated' && versionView.latest !== null ? tr('\n最新版本 v', '\nNewest release v') + versionView.latest : '')
        + (versionView.status === 'unknown' && versionError === 'endpoint'
          ? tr('\n宿主尚未提供版本检查（运行中的插件较早）：重启 DSH 后可用', '\nThe host does not provide the version check yet (an older plugin is running): restart DSH')
          : versionView.status === 'unknown'
            ? tr('\n尚未确认是否有新版本', '\nWhether a newer release exists is not confirmed')
            : '')
        + (versionView.checkedAt !== null ? tr('\n检查时间：', '\nChecked: ') + new Date(versionView.checkedAt).toLocaleString() : '')
        + (versionView.error !== '' ? tr('\n版本检查失败：', '\nVersion check failed: ') + versionView.error : '')
        + tr('\n点击打开 GitHub 仓库', '\nClick to open the GitHub repository')
      const versionBadge = React.createElement('button', {
        type: 'button',
        className: 'uh-version' + (versionView.status === 'outdated' ? ' uh-version-outdated' : ''),
        title: versionTip,
        'aria-label': versionTip,
        onClick: () => {
          try { window.open(GITHUB_REPOSITORY_URL, '_blank', 'noopener,noreferrer') } catch (err) { /* popup blocked */ }
        },
      },
        React.createElement('span', { className: 'uh-version-number' }, 'v' + versionView.current),
        versionStatusText === '' ? null : React.createElement('span', { className: 'uh-version-status' }, versionStatusText),
      )
      const rangeLabel = range === 'custom' && activeCustomRange !== null
        ? (language === 'en' ? activeCustomRange.start + ' to ' + activeCustomRange.end + ' (UTC)' : activeCustomRange.start + ' 至 ' + activeCustomRange.end)
        : range === 'today' ? tr('今日', 'Today') : range === '7d' ? tr('近 7 天', 'Last 7 Days') : range === '30d' ? tr('近 30 天', 'Last 30 Days') : range === '90d' ? tr('近 90 天', 'Last 90 Days') : tr('全部', 'All Time')
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
          React.createElement('div', { className: 'uh-custom-range-note' }, tr('可查看全部可扫描历史日数据；中文按本地日期，English 按 UTC。热力图可切换最近 30 天 / 90 天 / 12 个月。', 'All available historical daily data can be selected. Chinese uses local dates; English uses UTC. The heatmap switches between the last 30 days, 90 days and 12 months.')),
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
            versionBadge,
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
              ['today', '7d', '30d', '90d', 'all', 'custom'].map((r) => React.createElement('button', {
                key: r,
                type: 'button',
                className: range === r ? 'uh-on' : '',
                title: r === 'custom' && range === 'custom' ? rangeLabel : undefined,
                onClick: () => { if (r === 'custom') openCustomRange(); else chooseRange(r) },
              }, r === 'today' ? tr('今日', 'Today') : r === '7d' ? tr('近 7 天', 'Last 7 Days') : r === '30d' ? tr('近 30 天', 'Last 30 Days') : r === '90d' ? tr('近 90 天', 'Last 90 Days') : r === 'all' ? tr('全部', 'All Time') : tr('自定义', 'Custom'))),
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
            options: [{ value: '', label: tr('全部模型', 'All models') }].concat(modelOptions.map((value) => { const icon = resolveModelIcon({ actualModel: value, requestedModel: value }); return { value, label: value, iconKey: icon === null ? null : icon.key } })),
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
              card(tr('DeepSeek 账户余额', 'DeepSeek Account Balance'), balanceValue, balanceSub, 0, 'wallet', 'deepseek'),
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
            span: heatmapSpan,
            onSpanChange: chooseHeatmapSpan,
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
      // The sheet, its grabber strip and its close button all start below the
      // caption strip the desktop client keeps for its own window buttons.
      const captionInset = uhWindowControlsInset()
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
        uhReportClientEnv()
        const closeOnEscape = (event) => { if (event.key === 'Escape') setOpen(false) }
        document.addEventListener('keydown', closeOnEscape)
        return () => document.removeEventListener('keydown', closeOnEscape)
      }, [open])
      return React.createElement(React.Fragment, null,
        React.createElement('button', {
          type: 'button', className: 'uh-side-entry', title: tr('用量统计', 'Usage Statistics'), 'aria-label': tr('用量统计', 'Usage Statistics'), onClick: () => setOpen(true),
        }, React.createElement('span', { className: 'uh-side-entry-icon' }, React.createElement(LineIcon, { name: 'chart', size: 17 })), props.wide ? React.createElement('span', { className: 'uh-side-entry-label' }, tr('用量统计', 'Usage Statistics')) : null),
        open ? React.createElement('div', { className: 'uh-side-modal', role: 'presentation', style: captionInset > 0 ? { '--uh-top-inset': captionInset + 'px' } : undefined, onMouseDown: (event) => { if (event.target === event.currentTarget) setOpen(false) } },
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
