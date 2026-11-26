import { hostnameFromAuthority, isLoopbackAddress, isLoopbackHostname, normalizeHostname } from './net-address.js'

// The API answers same-origin panel calls only. "Same origin" used to mean
// loopback and nothing else, which also made the dashboard unreachable from the
// LAN address or a reverse-proxied domain the moment DSH stopped binding
// 127.0.0.1. These names are what the boundary trusts instead of the socket:
//
//   1. loopback names, always;
//   2. the Web invocation DSH publishes as `webStartup`: --public-url,
//      --trusted-host and --host (see DSH's dsh-web-app/lib/startup.js);
//   3. the same two flags read back from the launcher's `cmdlineArgs`, in case
//      `webStartup` is not visible from this context;
//   4. whatever `webApp.getAdvertisedUrl()` reports (its config publicUrl, or
//      the listener origin);
//   5. the origin the listener actually serves (webServer.getOrigin());
//   6. any host named in DSH_ALL_USAGE_TRUSTED_HOSTS.
//
// (2) matters: the CLI flag lands in `webStartup`, while `dsh-web-app` only
// reads its own config for the advertised URL, so `--public-url` does NOT reach
// getAdvertisedUrl(). Trusting that service is what makes a proxied deployment
// work without extra configuration.
//
// (3)-(5) cover the ways a deployment is reached without configuration: the
// bound interface address and the public URL in front of it. Because the set is
// built from configuration rather than from the request, DNS rebinding still
// fails: an attacker's name is never in it.
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
 * Resolution is lazy and cached for a short window: DSH applies plugins before it
 * binds the port, so `getOrigin()` throws during `apply` and only answers once
 * the listener is up. An answer that predates the listener is never cached, so
 * the bound address appears on the next request instead of a TTL later.
 *
 * @param options.getWebApp - reads the `webApp` service (optional; absent in a
 *   TUI-only host).
 * @param options.getWebServer - reads the `webServer` service.
 * @param options.env - environment to read; defaults to `process.env`.
 * @returns `{ strict, has(name), names(), describe(), refresh() }`.
 */
/**
 * Read the Web flags out of the launcher's argument snapshot.
 *
 * DSH hands the whole command line to the tree (`cmdlineArgs`), so a plugin can
 * see `dsh web --public-url … --trusted-host …` even when the `webStartup`
 * service is not reachable from its context. Both `--flag value` and
 * `--flag=value` are accepted, and `--trusted-host` may repeat.
 *
 * @param args - argument snapshot, e.g. `['web', '--public-url', 'https://x/']`.
 * @returns `{ publicUrl, trustedHosts }`; both empty when nothing matched.
 */
export function parseCmdlineHosts(args) {
  const result = { publicUrl: '', trustedHosts: [] }
  if (!Array.isArray(args)) return result
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (typeof token !== 'string') continue
    const equals = token.indexOf('=')
    const flag = equals > 0 ? token.slice(0, equals) : token
    if (flag !== '--public-url' && flag !== '--trusted-host') continue
    const inline = equals > 0 ? token.slice(equals + 1) : undefined
    const value = inline === undefined ? args[index + 1] : inline
    if (typeof value !== 'string' || value === '' || value.startsWith('--')) continue
    if (inline === undefined) index += 1
    if (flag === '--public-url') result.publicUrl = value
    else result.trustedHosts.push(value)
  }
  return result
}

export function createTrustedHosts({
  getWebApp,
  getWebServer,
  getWebStartup,
  getCmdlineArgs,
  env = process.env,
  ttlMilliseconds = 30 * 1000,
} = {}) {
  const strict = Boolean(env && env[ENV_STRICT_LOCAL] === '1')
  const configured = strict ? new Set() : parseTrustedHostList(env && env[ENV_TRUSTED_HOSTS])
  let cachedAt = 0
  let cached = { hosts: new Set(), sources: emptySources() }
  let cachedSettled = false
  let announcedSignature = ''

  function emptySources() {
    return { env: [], advertised: '', trusted: [], listener: '', strict }
  }

  function resolve() {
    if (strict) return { hosts: new Set(), settled: false, sources: emptySources() }
    const hosts = new Set(configured)
    const sources = emptySources()
    sources.env = [...configured]
    let settled = false
    // Returns the name it accepted so the caller can record which source named
    // it; loopback (and anything unreadable) reports '' instead.
    const add = (value) => {
      const name = hostnameFromAuthority(value)
      if (name === '' || isLoopbackHostname(name)) return ''
      hosts.add(name)
      return name
    }
    // DSH publishes the Web invocation as `webStartup`. `dsh-web-app` only reads
    // its own config for the advertised URL, so a CLI `--public-url` never
    // reaches getAdvertisedUrl() — this service is where the flag lands.
    let startup = null
    try {
      const service = typeof getWebStartup === 'function' ? getWebStartup() : undefined
      if (service !== null && service !== undefined && typeof service === 'object') {
        startup = service
        settled = true
      }
    } catch (err) {
      // The Web command has not published its invocation yet.
    }

    let args = null
    try {
      const service = typeof getCmdlineArgs === 'function' ? getCmdlineArgs() : undefined
      if (service !== null && service !== undefined && typeof service.get === 'function') {
        const snapshot = service.get()
        if (Array.isArray(snapshot)) {
          args = snapshot
          settled = true
        }
      }
    } catch (err) {
      // A launcher without a command line publishes nothing here.
    }

    const parsed = parseCmdlineHosts(args)
    const startupUrl = startup !== null && typeof startup.publicUrl === 'string' ? startup.publicUrl : ''
    const advertisedUrl = startupUrl !== '' ? startupUrl : parsed.publicUrl
    if (advertisedUrl !== '') sources.advertised = add(advertisedUrl)

    const trusted = []
    if (startup !== null && Array.isArray(startup.trustedHosts)) trusted.push(...startup.trustedHosts)
    trusted.push(...parsed.trustedHosts)
    for (const entry of trusted) add(entry)
    sources.trusted = [...new Set(trusted.map((entry) => hostnameFromAuthority(entry)).filter((name) => name !== ''))]

    // A bind address is already a legal Host for any deployment that reaches the
    // machine directly; --host is the same value webServer.getOrigin() reports.
    if (startup !== null) add(startup.host)

    if (sources.advertised === '') {
      try {
        const app = typeof getWebApp === 'function' ? getWebApp() : undefined
        if (app !== null && app !== undefined && typeof app.getAdvertisedUrl === 'function') {
          sources.advertised = add(app.getAdvertisedUrl())
        }
      } catch (err) {
        // The web app is not mounted yet; the next resolution retries.
      }
    }
    try {
      const server = typeof getWebServer === 'function' ? getWebServer() : undefined
      if (server !== null && server !== undefined && typeof server.getOrigin === 'function') {
        sources.listener = add(server.getOrigin())
        settled = true
      }
    } catch (err) {
      // Before `listen` binds, the listener has no origin; retry shortly.
    }
    return { hosts, settled, sources }
  }

  function current() {
    if (cachedSettled && Date.now() - cachedAt < ttlMilliseconds) return cached
    const resolved = resolve()
    cached = { hosts: resolved.hosts, sources: resolved.sources }
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
    return announce([...current().hosts])
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
      const value = current()
      announce([...value.hosts])
      return value.hosts.has(host)
    },
    names,
    /**
     * Everything the panel and the status route need to explain the boundary:
     * which names are accepted, where each one came from, and whether strict
     * mode replaced them all with loopback.
     * @returns `{ strict, hosts, sources: { env, advertised, listener } }`.
     */
    describe() {
      const value = current()
      announce([...value.hosts])
      return {
        strict,
        hosts: [...value.hosts].sort(),
        sources: {
          env: value.sources.env.slice(),
          advertised: value.sources.advertised,
          trusted: Array.isArray(value.sources.trusted) ? value.sources.trusted.slice() : [],
          listener: value.sources.listener,
        },
      }
    },
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
  describe: () => ({ strict: true, hosts: [], sources: { env: [], advertised: '', trusted: [], listener: '' } }),
  refresh: () => [],
}
