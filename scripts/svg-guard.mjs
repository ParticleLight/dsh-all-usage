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

/** Consume one CSS escape and return its decoded value plus next index. */
function consumeCssEscape(source, index) {
  let next = index + 1
  if (next >= source.length) return { value: '', next }
  const first = source[next]
  if (first === '\r') return { value: '', next: next + (source[next + 1] === '\n' ? 2 : 1) }
  if (first === '\n' || first === '\f') return { value: '', next: next + 1 }
  const hex = source.slice(next).match(/^[0-9a-f]{1,6}/i)
  if (hex !== null) {
    next += hex[0].length
    if (source[next] === '\r') next += source[next + 1] === '\n' ? 2 : 1
    else if (/[\t\n\f\r ]/.test(source[next] || '')) next += 1
    const code = Number.parseInt(hex[0], 16)
    return { value: Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : String.fromCharCode(0xfffd), next }
  }
  return { value: first, next: next + 1 }
}

/** Read a CSS identifier (escapes allowed) and return the decoded value plus next index. */
function cssIdentifier(source, start) {
  let value = ''
  let index = start
  while (index < source.length) {
    const char = source[index]
    if (char === '\\') {
      const escaped = consumeCssEscape(source, index)
      if (escaped.value === '') { index = escaped.next; continue }
      value += escaped.value
      index = escaped.next
      continue
    }
    if (/[A-Za-z0-9_-]/.test(char) || char.charCodeAt(0) >= 0x80) {
      value += char
      index += 1
      continue
    }
    break
  }
  return { value, index }
}

/** End of a quoted CSS string the opening quote is at index. */
function cssStringEnd(source, index) {
  const quote = source[index]
  let next = index + 1
  while (next < source.length) {
    const char = source[next]
    if (char === '\\') { next = consumeCssEscape(source, next).next; continue }
    if (char === quote) return next + 1
    next += 1
  }
  return source.length
}

/** Index just after the closing parenthesis matching openParen. */
function cssFunctionEnd(source, openParen) {
  let depth = 0
  let index = openParen
  while (index < source.length) {
    const char = source[index]
    if (char === '"' || char === "'") { index = cssStringEnd(source, index); continue }
    if (char === '/' && source[index + 1] === '*') {
      const commentEnd = source.indexOf('*/', index + 2)
      index = commentEnd < 0 ? source.length : commentEnd + 2
      continue
    }
    if (char === '(') depth += 1
    else if (char === ')') { depth -= 1; if (depth === 0) return index + 1 }
    index += 1
  }
  return source.length
}

/** The first CSS function argument: quoted string (decoded) or bare token. */
function cssFunctionTarget(source, start) {
  let index = start
  while (index < source.length) {
    if (/[\t\n\f\r ]/.test(source[index])) { index += 1; continue }
    if (source[index] === '/' && source[index + 1] === '*') {
      const commentEnd = source.indexOf('*/', index + 2)
      index = commentEnd < 0 ? source.length : commentEnd + 2
      continue
    }
    break
  }
  if (index >= source.length) return null
  if (source[index] === '"' || source[index] === "'") {
    const quote = source[index]
    index += 1
    let value = ''
    while (index < source.length && source[index] !== quote) {
      if (source[index] === '\\') { const escaped = consumeCssEscape(source, index); value += escaped.value; index = escaped.next; continue }
      value += source[index]
      index += 1
    }
    return value
  }
  let value = ''
  while (index < source.length) {
    const char = source[index]
    if (char === ')' || /[\t\n\f\r]/.test(char)) break
    if (char === '/' && source[index + 1] === '*') break
    if (char === '\\') { const escaped = consumeCssEscape(source, index); value += escaped.value; index = escaped.next; continue }
    value += char
    index += 1
  }
  return value.trim()
}

/** External URL targets in one CSS source; decorates over CSS comments, strings
 *  and CDO/CDC tokens, and decodes escapes in the url( identifier itself. */
function cssUrlTargets(css) {
  const source = String(css)
  const targets = []
  let index = 0
  while (index < source.length) {
    const char = source[index]
    if (/[\t\n\f\r ]/.test(char)) { index += 1; continue }
    if (char === '/' && source[index + 1] === '*') {
      const commentEnd = source.indexOf('*/', index + 2)
      index = commentEnd < 0 ? source.length : commentEnd + 2
      continue
    }
    if (source.startsWith('<!--', index)) { index += 4; continue }
    if (source.startsWith('-->', index)) { index += 3; continue }
    if (char === '"' || char === "'") { index = cssStringEnd(source, index); continue }
    if (char === '@') { index = cssIdentifier(source, index + 1).index; continue }
    if (char === '\\' || /[A-Za-z_-]/.test(char) || char.charCodeAt(0) >= 0x80) {
      const id = cssIdentifier(source, index)
      const name = id.value.toLowerCase()
      let next = id.index
      while (next < source.length && /[\t\n\f\r ]/.test(source[next])) next += 1
      if (next < source.length && source[next] === '(' && (name === 'url' || name === '-webkit-image-set' || name === 'image-set')) {
        const target = cssFunctionTarget(source, next + 1)
        // Nested url() inside image-set() is handled by the outer url() pass.
        if (target !== null && !/^url\(/i.test(target)) targets.push(target)
        index = cssFunctionEnd(source, next)
        continue
      }
      index = id.index
      continue
    }
    index += 1
  }
  return targets
}

/** Extract CSS-bearing content: style attributes, presentation attributes that
 *  can carry paint references, and <style> (or namespaced <svg:style>) bodies. */
function cssSources(decoded) {
  const sources = attributeValues(decoded, ['style', 'fill', 'stroke', 'filter', 'mask', 'clip-path']).map(({ value }) => value)
  const pattern = /<(?:[a-z][a-z0-9]*:)?style\b[^>]*>([\s\S]*?)(?:<\/[a-z][a-z0-9]*:style\s*>|$)/gi
  let match = pattern.exec(decoded)
  while (match !== null) {
    sources.push(match[1])
    match = pattern.exec(decoded)
  }
  return sources
}

/** An escaped @ is literal text; remove comments/strings and decode escapes so
 *  only a real @import at-rule remains visible. */
function normalizeCssForImportCheck(css) {
  let output = ''
  let quote = ''
  for (let index = 0; index < css.length;) {
    const char = css[index]
    if (quote !== '') {
      if (char === '\\') {
        index = consumeCssEscape(css, index).next
        output += ' '
        continue
      }
      if (char === quote) quote = ''
      output += ' '
      index += 1
      continue
    }
    if (char === '/' && css[index + 1] === '*') {
      const commentEnd = css.indexOf('*/', index + 2)
      index = commentEnd < 0 ? css.length : commentEnd + 2
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      output += ' '
      index += 1
      continue
    }
    if (char === '\\') {
      const escaped = consumeCssEscape(css, index)
      output += escaped.value === '@' ? ' ' : escaped.value
      index = escaped.next
      continue
    }
    output += char
    index += 1
  }
  return output
}

const IMPORT_BOUNDARY = /(?:^|[^a-z0-9_-])@import\b/i

/** Detect a real @import at-rule, including after CDO/CDC tokens. */
function hasCssImport(decoded) {
  for (const css of cssSources(decoded)) {
    // CSS CDO (<--) / CDC (-->) sit directly next to @import on legacy pages;
    // normalize them out so the trailing '-' cannot swallow the at-rule.
    const standardized = String(css).replace(/<!--|-->/g, ' ')
    if (IMPORT_BOUNDARY.test(normalizeCssForImportCheck(standardized))) return true
  }
  return false
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
  // CSS checks run on both the raw and the entity-decoded document: decoding
  // &quot; inside a style attribute would break the attribute quoting, while
  // entity-encoded @import only appears after decoding.
  if (hasCssImport(decoded)) fail('contains an external CSS @import rule')
  for (const sourceText of [svg, decoded]) {
    for (const css of cssSources(sourceText)) {
      for (const target of cssUrlTargets(css)) {
        if (!target.startsWith('#')) fail('references an external CSS resource: url(' + target.slice(0, 60) + ')')
      }
    }
  }
  if (/currentColor/i.test(decoded)) fail('uses currentColor, which does not inherit inside <img>; bake an explicit colour instead')
  if (/404|not found/i.test(decoded.slice(0, 200)) && !/<svg[\s>]/i.test(decoded.slice(0, 200))) fail('looks like an error page, not an SVG')
  return svg
}

export { MAX_ICON_BYTES }