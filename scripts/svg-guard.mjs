const MAX_ICON_BYTES = 24 * 1024
const NAMED_ENTITIES = new Map([
  ['quot', '"'], ['apos', "'"], ['lt', '<'], ['gt', '>'], ['amp', '&'], ['nbsp', ' '], ['#39', "'"],
])
const FORBIDDEN_ELEMENTS = ['script', 'foreignobject', 'iframe', 'embed', 'object', 'image', 'use', 'audio', 'video', 'animate', 'set', 'handler', 'listener']

/**
 * Decode XML/HTML entities repeatedly so an obfuscated payload
 * (&quot;https://... or &#x68;ref) is checked in its decoded form. The loop is
 * bounded because each pass must shrink the text.
 */
export function decodeEntities(text) {
  let current = String(text)
  for (let pass = 0; pass < 5; pass += 1) {
    const next = current.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9#]+);?/gi, (match, body) => {
      const token = String(body)
      if (token.startsWith('#x') || token.startsWith('#X')) {
        const code = Number.parseInt(token.slice(2), 16)
        return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
      }
      if (token.startsWith('#')) {
        const code = Number.parseInt(token.slice(1), 10)
        return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
      }
      const named = NAMED_ENTITIES.get(token.toLowerCase())
      return named === undefined ? match : named
    })
    if (next === current) return current
    current = next
  }
  return current
}

/** Every attribute value in the document, quoted or unquoted. */
function attributeValues(decoded, names) {
  const pattern = new RegExp('(?:^|[\\s"\'/])((?:[a-z][a-z0-9]*:)?(?:' + names.join('|') + '))\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'gi')
  const values = []
  let match = pattern.exec(decoded)
  while (match !== null) {
    values.push({ name: match[1].toLowerCase(), value: (match[2] !== undefined ? match[2] : match[3] !== undefined ? match[3] : match[4] || '').trim() })
    match = pattern.exec(decoded)
  }
  return values
}

/** Every CSS url(...) target in the document. */
function cssUrlTargets(decoded) {
  const pattern = /url\(\s*("([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi
  const targets = []
  let match = pattern.exec(decoded)
  while (match !== null) {
    targets.push((match[2] !== undefined ? match[2] : match[3] !== undefined ? match[3] : match[4] || '').trim())
    match = pattern.exec(decoded)
  }
  return targets
}

/**
 * Reject anything that is not a self-contained, script-free, offline SVG.
 * Checks run on the entity-decoded document so encoded payloads cannot slip
 * past, and URI attributes are matched with or without quotes.
 */
export function assertSafeSvg(name, svg) {
  const fail = (reason) => { throw new Error('model icon ' + name + ' ' + reason) }
  const bytes = Buffer.byteLength(svg)
  if (bytes === 0 || bytes > MAX_ICON_BYTES) fail('has an unsupported size: ' + bytes + ' B')
  if (!/^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(svg)) fail('is not a valid SVG document (no <svg> root)')
  if (!/<\/svg>\s*$/i.test(svg.trim())) fail('is missing its closing </svg> tag')
  const decoded = decodeEntities(svg)
  if (/<!doctype|<!entity|<!\[cdata\[/i.test(decoded)) fail('contains a DOCTYPE, entity or CDATA declaration')
  if (/<\?(?!xml[\s?])/i.test(decoded)) fail('contains a processing instruction')
  if (/javascript:|vbscript:|\bon[a-z]+\s*=/i.test(decoded)) fail('contains scripting constructs')
  for (const element of FORBIDDEN_ELEMENTS) {
    if (new RegExp('<\\s*' + element + '[\\s/>]', 'i').test(decoded)) fail('contains the disallowed <' + element + '> element')
  }
  for (const attribute of attributeValues(decoded, ['href', 'src', 'srcset', 'from', 'to', 'values', 'begin', 'end', 'filter', 'mask', 'clip-path', 'fill', 'stroke', 'style'])) {
    const value = attribute.value
    if (attribute.name.endsWith('href') || attribute.name === 'src' || attribute.name === 'srcset') {
      if (!value.startsWith('#')) fail('references an external resource through ' + attribute.name + '="' + value.slice(0, 60) + '"')
      continue
    }
    if (/(?:https?:|ftp:|file:|data:|\/\/)/i.test(value)) fail('references an external URI in ' + attribute.name + '="' + value.slice(0, 60) + '"')
  }
  for (const target of cssUrlTargets(decoded)) {
    if (!target.startsWith('#')) fail('references an external CSS resource: url(' + target.slice(0, 60) + ')')
  }
  if (/currentColor/i.test(decoded)) fail('uses currentColor, which does not inherit inside <img>; bake an explicit colour instead')
  if (/404|not found/i.test(decoded.slice(0, 200)) && !/<svg[\s>]/i.test(decoded.slice(0, 200))) fail('looks like an error page, not an SVG')
  return svg
}

export { MAX_ICON_BYTES }
