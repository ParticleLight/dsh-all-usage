// Version check for the dashboard header. The running version is known locally;
// this only asks the npm registry for the newest published one, at most once per
// TTL and only while a dashboard is open (the page asks for it, the host never
// polls on its own). A plain GET of a small JSON document, no body, no cookies.
const VERSION_CHECK_URL = 'https://registry.npmjs.org/dsh-all-usage/latest'
const VERSION_CHECK_TTL_MS = 6 * 60 * 60 * 1000
const VERSION_CHECK_TIMEOUT_MS = 8000
const MAX_VERSION_BYTES = 64 * 1024

function parseVersion(text) {
  const value = String(text === undefined || text === null ? '' : text).trim().replace(/^v/, '')
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/)
  if (match === null) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? null : match[4].split('.'),
  }
}

/**
 * Compare two dotted versions the way semver orders them: numeric parts first,
 * then a prerelease ranks below its release and numeric identifiers rank below
 * alphanumeric ones ('1.1.18-rc.1' < '1.1.18' < '1.1.19'). Returns -1, 0 or 1,
 * and 0 for anything unparseable so a malformed tag never claims an update.
 */
export function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (a === null || b === null) return 0
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1
  }
  if (a.prerelease === null && b.prerelease === null) return 0
  if (a.prerelease === null) return 1
  if (b.prerelease === null) return -1
  const length = Math.max(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const leftPart = a.prerelease[index]
    const rightPart = b.prerelease[index]
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    if (leftPart === rightPart) continue
    const leftNumber = /^\d+$/.test(leftPart) ? Number(leftPart) : null
    const rightNumber = /^\d+$/.test(rightPart) ? Number(rightPart) : null
    if (leftNumber !== null && rightNumber !== null) return leftNumber < rightNumber ? -1 : 1
    if (leftNumber !== null) return -1
    if (rightNumber !== null) return 1
    return leftPart < rightPart ? -1 : 1
  }
  return 0
}

/** 'latest' when the running version is at least the published one, else 'outdated'. */
export function versionStatus(current, latest) {
  if (typeof current !== 'string' || current === '') return 'unknown'
  if (typeof latest !== 'string' || latest === '') return 'unknown'
  if (parseVersion(current) === null || parseVersion(latest) === null) return 'unknown'
  return compareVersions(current, latest) < 0 ? 'outdated' : 'latest'
}

export async function fetchLatestVersion(fetchImpl = globalThis.fetch, options = {}) {
  if (typeof fetchImpl !== 'function') return { ok: false, error: 'fetch-unavailable' }
  const url = typeof options.url === 'string' && options.url !== '' ? options.url : VERSION_CHECK_URL
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : VERSION_CHECK_TIMEOUT_MS
  let controller = null
  let timer = null
  try {
    if (typeof AbortController === 'function') {
      controller = new AbortController()
      timer = setTimeout(() => controller.abort(), timeoutMs)
    }
    const response = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: controller ? controller.signal : undefined })
    if (!response || response.ok !== true) return { ok: false, error: 'http-' + String((response && response.status) || 0) }
    const text = await response.text()
    if (new TextEncoder().encode(text).length > MAX_VERSION_BYTES) return { ok: false, error: 'version-too-large' }
    let parsed = null
    try { parsed = JSON.parse(text.replace(/^\uFEFF/, '')) } catch (err) { return { ok: false, error: 'version-invalid-json' } }
    const version = parsed !== null && typeof parsed === 'object' && typeof parsed.version === 'string' ? parsed.version.trim() : ''
    if (parseVersion(version) === null) return { ok: false, error: 'version-invalid' }
    return { ok: true, version, sourceUrl: url, fetchedAt: Date.now() }
  } catch (err) {
    return { ok: false, error: 'version-fetch-failed' }
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

export function createVersionCheck(options = {}) {
  const fetchImpl = options.fetchImpl === undefined ? globalThis.fetch : options.fetchImpl
  const currentVersion = typeof options.currentVersion === 'string' ? options.currentVersion : ''
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : VERSION_CHECK_TTL_MS
  let entry = null
  let failure = null
  function snapshot(cached) {
    return {
      current: currentVersion,
      latest: entry === null ? null : entry.version,
      status: entry === null ? 'unknown' : versionStatus(currentVersion, entry.version),
      checkedAt: entry === null ? null : entry.fetchedAt,
      sourceUrl: entry === null ? VERSION_CHECK_URL : entry.sourceUrl,
      error: failure === null ? null : failure.error,
      cached: cached === true,
    }
  }
  /** Read the cached verdict, or ask the registry again when it is stale or forced. */
  async function read(force) {
    if (!force && entry !== null && Date.now() - entry.fetchedAt < ttlMs) return snapshot(true)
    const result = await fetchLatestVersion(fetchImpl, options)
    if (result.ok) {
      entry = { version: result.version, fetchedAt: result.fetchedAt, sourceUrl: result.sourceUrl }
      failure = null
    } else {
      failure = { error: result.error, failedAt: Date.now() }
    }
    return snapshot(false)
  }
  return { read, snapshot: () => snapshot(true), currentVersion }
}

export { VERSION_CHECK_TTL_MS, VERSION_CHECK_URL }
