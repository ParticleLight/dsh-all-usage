import { timingSafeEqual } from 'node:crypto'

// local and require a browser-originated capability for state-changing reads/writes.
function requestHeader(req, name) {
const headers = req && req.headers
if (headers === null || headers === undefined || typeof headers !== 'object') return undefined
const value = headers[name.toLowerCase()]
if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : undefined
return typeof value === 'string' ? value : undefined
}

function isLoopbackIpv4(address) {
const parts = address.split('.')
return parts.length === 4 && parts[0] === '127' && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

function ipv6Words(address) {
let value = address.toLowerCase()
if (value.includes('.')) {
  const separator = value.lastIndexOf(':')
  if (separator < 0) return null
  const ipv4 = value.slice(separator + 1)
  if (!isLoopbackIpv4(ipv4) && !ipv4.split('.').every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return null
  const parts = ipv4.split('.').map(Number)
  value = value.slice(0, separator + 1) + (((parts[0] << 8) | parts[1]).toString(16)) + ':' + (((parts[2] << 8) | parts[3]).toString(16))
}
const halves = value.split('::')
if (halves.length > 2) return null
const left = halves[0] === '' ? [] : halves[0].split(':')
const right = halves.length === 2 && halves[1] !== '' ? halves[1].split(':') : []
if (halves.length === 1 && left.length !== 8) return null
const zeroCount = halves.length === 2 ? 8 - left.length - right.length : 0
if (zeroCount < (halves.length === 2 ? 1 : 0)) return null
const groups = left.concat(Array.from({ length: zeroCount }, () => '0'), right)
if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null
return groups.map((group) => Number.parseInt(group, 16))
}

function isLoopbackAddress(address) {
if (typeof address !== 'string') return false
const value = address.trim().toLowerCase()
if (isLoopbackIpv4(value)) return true
const words = ipv6Words(value)
if (words === null) return false
if (words.slice(0, 7).every((word) => word === 0) && words[7] === 1) return true
if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
  const ipv4 = [(words[6] >> 8) & 255, words[6] & 255, (words[7] >> 8) & 255, words[7] & 255].join('.')
  return isLoopbackIpv4(ipv4)
}
return false
}

function isLoopbackHostname(hostname) {
if (typeof hostname !== 'string') return false
const value = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
if (value === 'localhost') return true
return isLoopbackAddress(value)
}

function isTrustedLocalApiRequest(req, requireOrigin) {
const remoteAddress = req && req.socket && req.socket.remoteAddress
if (!isLoopbackAddress(remoteAddress)) return false
const host = requestHeader(req, 'host')
if (host === undefined) return false
let hostUrl
try {
  hostUrl = new URL('http://' + host)
} catch (err) {
  return false
}
if (!isLoopbackHostname(hostUrl.hostname)) return false
if (requestHeader(req, 'sec-fetch-site') === 'cross-site') return false
const origin = requestHeader(req, 'origin')
if (origin === undefined) return requireOrigin !== true
try {
  const originUrl = new URL(origin)
  return originUrl.protocol === 'http:' && originUrl.host === hostUrl.host
} catch (err) {
  return false
}
}

function hasWriteToken(req, expected) {
const actual = requestHeader(req, 'x-all-usage-request-token')
if (typeof actual !== 'string' || typeof expected !== 'string') return false
const actualBytes = Buffer.from(actual)
const expectedBytes = Buffer.from(expected)
return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)
}

function sendJson(res, code, value) {
res.statusCode = code
res.setHeader('content-type', 'application/json; charset=utf-8')
res.setHeader('cache-control', 'no-store')
res.end(JSON.stringify(value))
}

function readBody(req, maxBytes) {
return new Promise((resolve) => {
  const chunks = []
  const declaredLength = Number(requestHeader(req, 'content-length'))
  let size = Number.isFinite(declaredLength) && declaredLength > maxBytes ? maxBytes + 1 : 0
  let tooLarge = size > maxBytes
  let settled = false
  const finish = (text, oversized) => {
    if (settled) return
    settled = true
    resolve({ text, tooLarge: oversized })
  }
  req.on('data', (chunk) => {
    if (tooLarge) return
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += value.length
    if (size > maxBytes) {
      tooLarge = true
      chunks.length = 0
      return
    }
    chunks.push(value)
  })
  req.on('end', () => finish(tooLarge ? '' : Buffer.concat(chunks).toString('utf8'), tooLarge))
  req.on('error', () => finish('', false))
})
}

export function registerRoutes(host) {
  const { ctx, webServer, state } = host
  const {
    queryScopeFromRequest,
    queryUsageScope,
    queryRecords,
    snapshot,
    statusSnapshot,
  } = host.aggregation
  const {
    pricingModelSearch,
    pricingSnapshot,
    updatePricingState,
    persistPricing,
    syncPricing,
  } = host.pricing
  const { runBaseline } = host.sessionSync
  const { fetchBalance } = host.balance
  const { setAlias } = host.aliases
  const { drainLedgerWrites } = host.ledger

  // ---------- HTTP data routes for the client half ----------
  if (webServer !== undefined) {
    const rejectRequest = (res) => sendJson(res, 403, { ok: false, message: 'forbidden' })
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/api/all-usage/query',
      handler: (req, res) => {
        if (req.method !== 'GET') { res.statusCode = 405; res.end(); return }
        if (!isTrustedLocalApiRequest(req, false)) { rejectRequest(res); return }
        const parsed = queryScopeFromRequest(req)
        if (!parsed.ok) { sendJson(res, 400, { ok: false, message: parsed.message }); return }
        sendJson(res, 200, queryUsageScope(parsed.scope))
      },
    }))
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/api/all-usage/records',
      handler: (req, res) => {
        if (req.method !== 'GET') { res.statusCode = 405; res.end(); return }
        if (!isTrustedLocalApiRequest(req, false)) { rejectRequest(res); return }
        const parsed = queryScopeFromRequest(req)
        if (!parsed.ok) { sendJson(res, 400, { ok: false, message: parsed.message }); return }
        let limit = 50
        let cursor
        try {
          const url = new URL(req.url || '/', 'http://all-usage.local')
          const rawLimit = url.searchParams.get('limit')
          if (rawLimit !== null && rawLimit !== '') limit = Number(rawLimit)
          cursor = url.searchParams.get('cursor') || undefined
        } catch (err) { sendJson(res, 400, { ok: false, message: 'bad-query' }); return }
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) { sendJson(res, 400, { ok: false, message: 'invalid-limit' }); return }
        const result = queryRecords(parsed.scope, cursor, limit)
        if (result.error !== undefined) { sendJson(res, result.error === 'stale-cursor' ? 409 : 400, { ok: false, message: result.error }); return }
        sendJson(res, 200, result)
      },
    }))
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/api/all-usage/pricing/models',
      handler: async (req, res) => {
        if (req.method !== 'GET') { res.statusCode = 405; res.end(); return }
        if (!isTrustedLocalApiRequest(req, false)) { rejectRequest(res); return }
        let query = ''
        let limit = 20
        try {
          const url = new URL(req.url || '/', 'http://all-usage.local')
          query = url.searchParams.get('q') || ''
          const rawLimit = url.searchParams.get('limit')
          if (rawLimit !== null && rawLimit !== '') limit = Number(rawLimit)
        } catch (err) { sendJson(res, 400, { ok: false, message: 'bad-query' }); return }
        if (query.length > 120 || !Number.isInteger(limit) || limit < 1 || limit > 50) { sendJson(res, 400, { ok: false, message: 'invalid-model-search' }); return }
        await state.pricingReady
        sendJson(res, 200, { items: pricingModelSearch(query, limit) })
      },
    }))
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/api/all-usage/pricing',
      handler: async (req, res) => {
        if (req.method === 'GET') {
          if (!isTrustedLocalApiRequest(req, false)) { rejectRequest(res); return }
          await state.pricingReady
          sendJson(res, 200, pricingSnapshot())
          return
        }
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return }
        if (!isTrustedLocalApiRequest(req, true) || !hasWriteToken(req, state.requestToken)) { rejectRequest(res); return }
        const body = await readBody(req, 256 * 1024)
        if (body.tooLarge) { sendJson(res, 413, { ok: false, message: 'request-too-large' }); return }
        let args = null
        try { args = JSON.parse(body.text) } catch (err) { /* invalid json */ }
        if (args === null || typeof args !== 'object' || Array.isArray(args)) { sendJson(res, 400, { ok: false, message: 'bad-pricing-request' }); return }
        // Wait for the persisted pricing state (and the ledger it backfills)
        // before mutating it: an early POST would otherwise be skipped because
        // pricingUnit is still null and then overwritten by the loaded state.
        await Promise.all([state.pricingReady, state.ledgerReady])
        const result = updatePricingState(args.pricing || args, args.backfill === true)
        await persistPricing()
        await drainLedgerWrites()
        sendJson(res, 200, { ok: true, backfill: result, pricing: pricingSnapshot() })
      },
    }))
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/api/all-usage/pricing/sync',
      handler: async (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return }
        if (!isTrustedLocalApiRequest(req, true) || !hasWriteToken(req, state.requestToken)) { rejectRequest(res); return }
        // Backfill iterates the loaded ledger, so wait for it like the pricing
        // POST does; otherwise an early sync answers with an empty backfill.
        await Promise.all([state.pricingReady, state.ledgerReady])
        const result = await syncPricing(true)
        sendJson(res, result.ok ? 200 : 502, result)
      },
    }))
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/api/all-usage/status',
      handler: (req, res) => {
        if (req.method !== 'GET') { res.statusCode = 405; res.end(); return }
        if (!isTrustedLocalApiRequest(req, false)) { rejectRequest(res); return }
        if (!state.scan.started) void runBaseline()
        sendJson(res, 200, statusSnapshot())
      },
    }))
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/api/all-usage',
      handler: async (req, res) => {
        if (req.method !== 'GET') { res.statusCode = 405; res.end(); return }
        if (!isTrustedLocalApiRequest(req, false)) { rejectRequest(res); return }
        // The snapshot embeds the pricing summary; wait for the persisted
        // configuration so the first response is never a default empty state
        // that the client would keep as its pricing baseline.
        await Promise.all([state.ledgerReady, state.pricingReady])
        if (!state.scan.started) void runBaseline()
        sendJson(res, 200, snapshot())
      },
    }))
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/api/all-usage/balance',
      handler: async (req, res) => {
        if (req.method !== 'GET') { res.statusCode = 405; res.end(); return }
        // Browsers may omit Origin on same-origin GET; the process token remains required.
        if (!isTrustedLocalApiRequest(req, false) || !hasWriteToken(req, state.requestToken)) { rejectRequest(res); return }
        let force = false
        try {
          const url = new URL(req.url ?? '/', 'http://x')
          force = url.searchParams.get('force') === '1'
        } catch (err) { /* default */ }
        sendJson(res, 200, await fetchBalance(force))
      },
    }))
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/api/all-usage/alias',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end()
          return
        }
        if (!isTrustedLocalApiRequest(req, true) || !hasWriteToken(req, state.requestToken)) { rejectRequest(res); return }
        const body = await readBody(req, 16 * 1024)
        if (body.tooLarge) { sendJson(res, 413, { ok: false, message: 'request-too-large' }); return }
        let args = null
        try {
          args = JSON.parse(body.text)
        } catch (err) { /* invalid json */ }
        const validAliasRequest = args !== null && args !== undefined && typeof args === 'object' && !Array.isArray(args) && typeof args.workspaceId === 'string' && args.workspaceId.length > 0 && args.workspaceId.length <= 256 && typeof args.alias === 'string'
        const result = validAliasRequest
          ? setAlias(args.workspaceId, args.alias)
          : { ok: false, message: 'bad-request', aliases: Object.assign({}, state.aliases) }
        sendJson(res, result.ok ? 200 : 400, result)
      },
    }))
  }
}
