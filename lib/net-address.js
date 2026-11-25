// Address and host-name literals the API boundary reasons about.
//
// Kept in its own module so the trusted-host set can be tested without loading
// the route table, and so `http.js` and `trusted-hosts.js` share exactly one
// definition of "loopback".

export function isLoopbackIpv4(address) {
  const parts = address.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

export function ipv6Words(address) {
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

export function isLoopbackAddress(address) {
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

/**
 * Canonical text of a host name or address literal: lower case, no IPv6
 * brackets, no trailing root dot. A port is never part of the result — callers
 * pass either a `Host` header name or a bare name, and both are compared as
 * names, because the port a proxy forwards is not the port the browser used.
 * @param value - raw host name, address literal or bracketed IPv6 literal.
 * @returns the normalized name, or '' when the input is not a string.
 */
export function normalizeHostname(value) {
  if (typeof value !== 'string') return ''
  let host = value.trim().toLowerCase()
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  if (host.endsWith('.')) host = host.slice(0, -1)
  return host
}

export function isLoopbackHostname(hostname) {
  const value = normalizeHostname(hostname)
  if (value === '' || value === undefined || hostname === null) return false
  if (value === 'localhost') return true
  return isLoopbackAddress(value)
}

/**
 * Read the host name out of an authority: a bare name, `name:port`, a bracketed
 * IPv6 literal, or a full URL.
 * @param value - authority text from configuration, a header or a service.
 * @returns the normalized host name, or '' when it cannot be read.
 */
export function hostnameFromAuthority(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') return ''
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//iu.test(text) ? text : `http://${text}`
  try {
    return normalizeHostname(new URL(withScheme).hostname)
  } catch (err) {
    return ''
  }
}
