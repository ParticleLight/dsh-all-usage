import { hostnameFromAuthority, isLoopbackAddress, isLoopbackHostname, normalizeHostname } from './net-address.js'

// The API answers same-origin panel calls only. "Same origin" used to mean
// loopback and nothing else, which also made the dashboard unreachable from the
// LAN address or a reverse-proxied domain the moment DSH stopped binding
// 127.0.0.1. These names are what the boundary trusts instead of the socket:
//
//   1. loopback names, always;
//   2. whatever DSH advertises as its own URL (webApp.getAdvertisedUrl(), i.e.
//      --public-url or the listener origin);
//   3. the origin the listener actually serves (webServer.getOrigin());
//   4. any host named in DSH_ALL_USAGE_TRUSTED_HOSTS.
//
// (2) and (3) cover the two ways a deployment is reached without configuration:
// the bound interface address and the public URL in front of it. Because the
// set is built from configuration rather than from the request, DNS rebinding
// still fails: an attacker's name is never in it.
//
// DSH_ALL_USAGE_STRICT_LOCAL=1 restores the old boundary (loopback only) for
// operators who would rather not publish the API at all.

const ENV_TRUSTED_HOSTS = 'DSH_ALL_USAGE_TRUSTED_HOSTS'
const ENV_STRICT_LOCAL = 'DSH_ALL_USAGE_STRICT_LOCAL'

/**
 * Parse a comma/space/semicolon separated list of hosts. Entries may be bare
 * names, `name:port`, bracketed IPv6 literals or full URLs; loopback entries are
 * dropped because loopback is always trusted and never listed.
 * @param value - raw environment value.
 * @returns the non-loopback names the list names.
 */
export function parseTrustedHostList(value) {
  const names = new Set()
  if (typeof value !== 'string' || value.trim() === '') return names
  for (const entry of value.split(/[\s,;]+/u)) {
    const name = hostnameFromAuthority(entry)
    if (name === '' || isLoopbackHostname(name)) continue
    names.add(name)
  }
  return names
}

/**
 * Build the trusted-host set for one plugin instance.
 *
 * Resolution is lazy and cached for a short window: DSH loads plugins before it
 * binds the port, so `getOrigin()` throws during `apply` and only answers once
 * the listener is up. The cache is short enough that a late bind is picked up by
 * the next request and long enough that the work happens a handful of times.
 *
 * @param options.getWebApp - reads the `webApp` service (optional; absent in a
 *   TUI-only host).
 * @param options.getWebServer - reads the `webServer` service.
 * @param options.env - environment to read; defaults to `process.env`.
 * @returns `{ strict, has(name), names(), refresh() }`.
 */
export function createTrustedHosts({
  getWebApp,
  getWebServer,
  env = process.env,
  ttlMilliseconds = 30 * 1000,
} = {}) {
  const strict = Boolean(env && env[ENV_STRICT_LOCAL] === '1')
  const configured = strict ? new Set() : parseTrustedHostList(env && env[ENV_TRUSTED_HOSTS])
  // DSH applies plugins before it binds the port, so the first resolutions can
  // only see the advertised URL. Those answers are not cached at all — otherwise
  // the bound address would stay invisible for a whole TTL after it appears.
  let cachedAt = 0
  let cached = new Set()
  let cachedSettled = false
  let announcedSignature = ''

  function resolve() {
    if (strict) return { hosts: new Set(), settled: false }
    const hosts = new Set(configured)
    let settled = false
    const add = (value) => {
      const name = hostnameFromAuthority(value)
      if (name === '' || isLoopbackHostname(name)) return
      hosts.add(name)
    }
    try {
      const app = typeof getWebApp === 'function' ? getWebApp() : undefined
      if (app !== null && app !== undefined && typeof app.getAdvertisedUrl === 'function') add(app.getAdvertisedUrl())
    } catch (err) {
      // The web app is not mounted yet; the next resolution retries.
    }
    try {
      const server = typeof getWebServer === 'function' ? getWebServer() : undefined
      if (server !== null && server !== undefined && typeof server.getOrigin === 'function') {
        add(server.getOrigin())
        settled = true
      }
    } catch (err) {
      // Before `listen` binds, the listener has no origin; retry shortly.
    }
    return { hosts, settled }
  }

  function current() {
    if (cachedSettled && Date.now() - cachedAt < ttlMilliseconds) return cached
    const resolved = resolve()
    cached = resolved.hosts
    cachedSettled = resolved.settled
    cachedAt = cachedSettled ? Date.now() : 0
    return cached
  }

  // Announce the allowlist, and announce it again whenever it grows or shrinks:
  // the advertised URL is known before the port is bound and the bound address
  // only afterwards, so one line would hide part of what is actually reachable.
  function announce(value) {
    const signature = value.slice().sort().join(', ')
    if (signature === '' || signature === announcedSignature) return value
    announcedSignature = signature
    console.warn(`[dsh-all-usage] API also accepts these non-loopback hosts: ${signature}`)
    return value
  }

  function names() {
    return announce([...current()])
  }

  return {
    strict,
    /**
     * Whether a Host name may be used to reach the API.
     * @param name - host name from the `Host` header.
     * @returns true for a configured non-loopback name.
     */
    has(name) {
      const host = normalizeHostname(name)
      if (host === '' || isLoopbackAddress(host) || host === 'localhost') return false
      const hosts = current()
      announce([...hosts])
      return hosts.has(host)
    },
    names,
    refresh() {
      cachedAt = 0
      return names()
    },
  }
}

export const EMPTY_TRUSTED_HOSTS = {
  strict: true,
  has: () => false,
  names: () => [],
  refresh: () => [],
}
