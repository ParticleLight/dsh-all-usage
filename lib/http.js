import { timingSafeEqual } from 'node:crypto'
import { findModelIcon } from './icons.js'
import { isLoopbackAddress, isLoopbackHostname, normalizeHostname } from './net-address.js'
import { EMPTY_TRUSTED_HOSTS } from './trusted-hosts.js'

// The panel API is same-origin data, so a call has to prove three things: the
// Host name is one this deployment answers to (see `trusted-hosts.js`), a socket
// that is not loopback did not borrow a loopback-only name, and a state-changing
// call carries the per-apply process capability. Reads stay open to the same
// origin because they carry no capability — that is why the Host check, not the
// socket, is what stops a rebound DNS name.
function requestHeader(req, name) {
const headers = req && req.headers
if (headers === null || headers === undefined || typeof headers !== 'object') return undefined
const value = headers[name.toLowerCase()]
if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : undefined
return typeof value === 'string' ? value : undefined
}

// The DSH desktop shell serves the UI from its own scheme and forwards every
// request through Electron, which strips Origin (along with Cookie and
// Sec-Fetch-*) before the host sees it. A write therefore cannot present an
// Origin at all, and requiring one made every save from the desktop client fail
// with 403. What actually authorizes a write is the per-apply capability: it is
// unguessable and unreadable cross-origin (the read endpoints send no CORS
// headers), and a browser cannot attach it to a form POST. An Origin that is
// present must still be a trusted one.
//
// A reverse proxy terminates TLS and may rewrite Host, so the page's origin can
// legitimately be https://name while this hop is http and names something else.
// Names are therefore compared against the trusted set rather than as a
// scheme+authority pair; an origin naming a host outside that set is refused.
function isTrustedOrigin(origin, requestHostname, trust) {
  if (origin === 'dsh-app://app' || origin.startsWith('dsh-app://')) return true
  if (typeof origin !== 'string' || origin === '') return false
  let originUrl
  try {
    originUrl = new URL(origin)
  } catch (err) {
    return false
  }
  if (originUrl.protocol !== 'http:' && originUrl.protocol !== 'https:') return false
  const originHostname = normalizeHostname(originUrl.hostname)
  if (originHostname === '') return false
  if (originHostname === normalizeHostname(requestHostname)) return true
  return trust.has(originHostname)
}

// Why a call is refused, as a code the panel can act on. An empty string means
// the call may proceed. The codes name the rule that failed and never the
// allowlist itself, so a refused caller learns nothing about the deployment.
export const TRUST_FAILURES = Object.freeze({
  missingHost: 'missing-host',
  badHost: 'bad-host',
  hostNotTrusted: 'host-not-trusted',
  peerLoopbackHost: 'peer-loopback-host',
  crossSite: 'cross-site',
  missingOrigin: 'missing-origin',
  originNotTrusted: 'origin-not-trusted',
  capabilityInvalid: 'capability-invalid',
})

function trustFailure(req, requireOrigin, trust) {
const trusted = trust === undefined || trust === null ? EMPTY_TRUSTED_HOSTS : trust
const host = requestHeader(req, 'host')
if (host === undefined || host === '') return TRUST_FAILURES.missingHost
let hostUrl
try {
  hostUrl = new URL('http://' + host)
} catch (err) {
  return TRUST_FAILURES.badHost
}
const hostname = normalizeHostname(hostUrl.hostname)
if (hostname === '') return TRUST_FAILURES.badHost
const loopbackHost = isLoopbackHostname(hostname)
const trustedHost = trusted.has(hostname)
if (!loopbackHost && !trustedHost) return TRUST_FAILURES.hostNotTrusted
// A socket that is not loopback may only address a name this deployment was
// configured to answer to. Pairing a remote socket with a loopback-only Host is
// not a combination a browser produces, so it is a forged header.
if (!isLoopbackAddress(req && req.socket && req.socket.remoteAddress) && !trustedHost) return TRUST_FAILURES.peerLoopbackHost
if (requestHeader(req, 'sec-fetch-site') === 'cross-site') return TRUST_FAILURES.crossSite
const origin = requestHeader(req, 'origin')
if (origin === undefined || origin === '') return requireOrigin === true ? TRUST_FAILURES.missingOrigin : ''
return isTrustedOrigin(origin, hostname, trusted) ? '' : TRUST_FAILURES.originNotTrusted
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
  // Absent only in a bare test harness: then no non-loopback name is trusted.
  const trust = host.trustedHosts === undefined || host.trustedHosts === null ? EMPTY_TRUSTED_HOSTS : host.trustedHosts
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
    loadHolidayCalendar,
  } = host.pricing
  const { runBaseline } = host.sessionSync
  const { fetchBalance } = host.balance
  const { setAlias } = host.aliases
  const { drainLedgerWrites, archiveLedger } = host.ledger

  // ---------- HTTP data routes for the client half ----------
  if (webServer !== undefined) {
    // The reason travels in the body and in a header: the body keeps `forbidden`
    // and names only the rule that failed, never the allowlist.
    const rejectRequest = (res, reason) => {
      res.setHeader('x-all-usage-forbidden-reason', reason)
      sendJson(res, 403, { ok: false, message: 'forbidden', reason })
    }
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/api/all-usage/query',
      handler: (req, res) => {
        if (req.method !== 'GET') { res.statusCode = 405; res.end(); return }
        const failure = trustFailure(req, false, trust)
        if (failure !== '') { rejectRequest(res, failure); return }
        const parsed = queryScopeFromRequest(req)
        if (!parsed.ok) { sendJson(res, 400, { ok: false, message: parsed.message }); return }
        sendJson(res, 200, queryUsageScope(parsed.scope))
      },
    }))
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/api/all-usage/records',
      // queryRecords may read a session document back from the ledger, so this
      // handler is async end to end.
      handler: async (req, res) => {
        if (req.method !== 'GET') { res.statusCode = 405; res.end(); return }
        const failure = trustFailure(req, false, trust)
        if (failure !== '') { rejectRequest(res, failure); return }
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
        const result = await queryRecords(parsed.scope, cursor, limit)
        if (result.error !== undefined) { sendJson(res, result.error === 'stale-cursor' ? 409 : 400, { ok: false, message: result.error }); return }
        sendJson(res, 200, result)
      },
    }))
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/api/all-usage/pricing/models',
      handler: async (req, res) => {
        if (req.method !== 'GET') { res.statusCode = 405; res.end(); return }
        const failure = trustFailure(req, false, trust)
        if (failure !== '') { rejectRequest(res, failure); return }
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
          const failure = trustFailure(req, false, trust)
        if (failure !== '') { rejectRequest(res, failure); return }
          await state.pricingReady
          sendJson(res, 200, pricingSnapshot())
          return
        }
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return }
        const failure = trustFailure(req, false, trust)
        if (failure !== '') { rejectRequest(res, failure); return }
        if (!hasWriteToken(req, state.requestToken)) { rejectRequest(res, TRUST_FAILURES.capabilityInvalid); return }
        const body = await readBody(req, 256 * 1024)
        if (body.tooLarge) { sendJson(res, 413, { ok: false, message: 'request-too-large' }); return }
        let args = null
        try { args = JSON.parse(body.text) } catch (err) { /* invalid json */ }
        if (args === null || typeof args !== 'object' || Array.isArray(args)) { sendJson(res, 400, { ok: false, message: 'bad-pricing-request' }); return }
        // Wait for the persisted pricing state (and the ledger it backfills)
        // before mutating it: an early POST would otherwise be skipped because
        // pricingUnit is still null and then overwritten by the loaded state.
        await Promise.all([state.pricingReady, state.ledgerReady])
        const result = await updatePricingState(args.pricing || args, args.backfill === true, args.repriceTemporal === true)
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
        const failure = trustFailure(req, false, trust)
        if (failure !== '') { rejectRequest(res, failure); return }
        if (!hasWriteToken(req, state.requestToken)) { rejectRequest(res, TRUST_FAILURES.capabilityInvalid); return }
        // Backfill iterates the loaded ledger, so wait for it like the pricing
        // POST does; otherwise an early sync answers with an empty backfill.
        await Promise.all([state.pricingReady, state.ledgerReady])
        const result = await syncPricing(true)
        sendJson(res, result.ok ? 200 : 502, result)
      },
    }))
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/api/all-usage/pricing/holidays',
      handler: async (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return }
        const failure = trustFailure(req, false, trust)
        if (failure !== '') { rejectRequest(res, failure); return }
        if (!hasWriteToken(req, state.requestToken)) { rejectRequest(res, TRUST_FAILURES.capabilityInvalid); return }
        const body = await readBody(req, 8 * 1024)
        if (body.tooLarge) { sendJson(res, 413, { ok: false, message: 'request-too-large' }); return }
        let args = null
        try { args = JSON.parse(body.text) } catch (err) { /* invalid json */ }
        const year = args !== null && typeof args === 'object' && !Array.isArray(args) ? Number(args.year) : NaN
        if (!Number.isSafeInteger(year) || year < 2000 || year > 2100) { sendJson(res, 400, { ok: false, message: 'bad-holiday-request' }); return }
        // Fetch only: the client freezes the returned dates into a pricing policy.
        const result = await loadHolidayCalendar(year)
        sendJson(res, result.ok ? 200 : 502, result)
      },
    }))
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/api/all-usage/archive',
      // The only route that deletes ledger documents, so it takes the same write
      // capability as the pricing writes and a body it does not otherwise need.
      handler: async (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return }
        const failure = trustFailure(req, false, trust)
        if (failure !== '') { rejectRequest(res, failure); return }
        if (!hasWriteToken(req, state.requestToken)) { rejectRequest(res, TRUST_FAILURES.capabilityInvalid); return }
        const body = await readBody(req, 8 * 1024)
        if (body.tooLarge) { sendJson(res, 413, { ok: false, message: 'request-too-large' }); return }
        let args = null
        try { args = JSON.parse(body.text) } catch (err) { /* invalid json */ }
        if (args === null || typeof args !== 'object' || Array.isArray(args)) { sendJson(res, 400, { ok: false, message: 'invalid-json' }); return }
        const days = args.days === undefined ? 90 : Number(args.days)
        if (!Number.isInteger(days) || days < 1 || days > 3650) { sendJson(res, 400, { ok: false, message: 'invalid-days' }); return }
        // Only an explicit false writes: the panel's first request has to show the
        // plan, and a client that forgets the flag must not delete anything.
        const dryRun = args.dryRun !== false
        await state.ledgerReady
        const result = await archiveLedger({ days, dryRun })
        // The body is the ledger's own answer, so the panel can show the plan (or
        // the reason there is none) without a second shape to keep in sync.
        const status = result.ok === true ? 200 : ({ busy: 409, 'no-root': 400, 'ledger-unavailable': 503 })[result.message] ?? 500
        sendJson(res, status, result)
      },
    }))
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/api/all-usage/status',
      handler: (req, res) => {
        if (req.method !== 'GET') { res.statusCode = 405; res.end(); return }
        const failure = trustFailure(req, false, trust)
        if (failure !== '') { rejectRequest(res, failure); return }
        if (!state.scan.started) void runBaseline()
        sendJson(res, 200, statusSnapshot())
      },
    }))
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/api/all-usage/client-env',
      handler: (req, res) => {
        if (req.method !== 'GET') { res.statusCode = 405; res.end(); return }
        const failure = trustFailure(req, false, trust)
        if (failure !== '') { rejectRequest(res, failure); return }
        // Diagnostics only: the client reports what the host exposes (user agent,
        // window-controls-overlay geometry, the strip it reserved). Truncated and
        // kept in memory for the life of the process.
        try {
          const url = new URL(req.url ?? '/', 'http://x')
          const read = (name, limit) => {
            const value = url.searchParams.get(name)
            return value === null ? null : value.slice(0, limit)
          }
          state.clientEnv = {
            reportedAt: Date.now(),
            ua: read('ua', 200),
            wco: read('wco', 40),
            inset: read('inset', 12),
            insetSource: read('src', 24),
            titlebar: read('tb', 24),
            viewport: read('vp', 24),
            modalRect: read('modal', 40),
            dialogRect: read('dlg', 40),
            headRect: read('head', 40),
            closeRect: read('close', 40),
          }
        } catch (err) { /* ignore a malformed diagnostic */ }
        sendJson(res, 200, { ok: true })
      },
    }))
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/api/all-usage',
      handler: async (req, res) => {
        if (req.method !== 'GET') { res.statusCode = 405; res.end(); return }
        const failure = trustFailure(req, false, trust)
        if (failure !== '') { rejectRequest(res, failure); return }
        // The snapshot embeds the pricing summary; wait for the persisted
        // configuration so the first response is never a default empty state
        // that the client would keep as its pricing baseline.
        await Promise.all([state.ledgerReady, state.pricingReady])
        if (!state.scan.started) void runBaseline()
        // The browser picks one timezone calendar for its whole session, so it
        // asks for that copy only: the other one was half of the payload.
        let utc = null
        try {
          const raw = new URL(req.url ?? '/', 'http://x').searchParams.get('utc')
          if (raw === '0' || raw === '1') utc = raw === '1'
        } catch (err) { /* default: both copies */ }
        sendJson(res, 200, snapshot(utc))
      },
    }))
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/api/all-usage/icon',
      handler: async (req, res) => {
        if (req.method !== 'GET') { res.statusCode = 405; res.end(); return }
        const failure = trustFailure(req, false, trust)
        if (failure !== '') { rejectRequest(res, failure); return }
        let key = ''
        try {
          key = new URL(req.url ?? '/', 'http://x').searchParams.get('key') ?? ''
        } catch (err) { /* default */ }
        // Resolution is by manifest key only, so a crafted value can never name a
        // path. The body is immutable per release, hence the long cache.
        const icon = await findModelIcon(key)
        if (icon === null) { sendJson(res, 404, { ok: false, message: 'icon-not-found' }); return }
        res.statusCode = 200
        res.setHeader('content-type', 'image/svg+xml; charset=utf-8')
        res.setHeader('cache-control', 'public, max-age=31536000, immutable')
        res.setHeader('etag', icon.etag)
        res.setHeader('content-length', String(icon.body.length))
        res.end(icon.body)
      },
    }))
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/api/all-usage/version',
      handler: async (req, res) => {
        if (req.method !== 'GET') { res.statusCode = 405; res.end(); return }
        const failure = trustFailure(req, false, trust)
        if (failure !== '') { rejectRequest(res, failure); return }
        let force = false
        try {
          force = new URL(req.url ?? '/', 'http://x').searchParams.get('force') === '1'
        } catch (err) { /* default */ }
        // The host caches the answer, so a dashboard left open does not hammer the
        // registry; force=1 only comes from the refresh button.
        sendJson(res, 200, await host.versionCheck.read(force))
      },
    }))
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/api/all-usage/balance',
      handler: async (req, res) => {
        if (req.method !== 'GET') { res.statusCode = 405; res.end(); return }
        // Browsers may omit Origin on same-origin GET; the process token remains required.
        const failure = trustFailure(req, false, trust)
        if (failure !== '') { rejectRequest(res, failure); return }
        if (!hasWriteToken(req, state.requestToken)) { rejectRequest(res, TRUST_FAILURES.capabilityInvalid); return }
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
        const failure = trustFailure(req, false, trust)
        if (failure !== '') { rejectRequest(res, failure); return }
        if (!hasWriteToken(req, state.requestToken)) { rejectRequest(res, TRUST_FAILURES.capabilityInvalid); return }
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
