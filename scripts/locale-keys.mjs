// Every string the panel renders is a literal in src/client.js, written as
// tr(zh, en), pick(language, zh, en) or pickFormat(language, zh, en, params). The six
// non-Chinese dictionaries are keyed by that English literal, so this module reads the
// literals out of the source with the acorn parser terser already brings along: the
// build refuses to inline a dictionary that misses one, and test/i18n.test.js proves
// the refusal works on a source with a hole.
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const acorn = require('acorn')

// call name -> index of the English argument
const CALLS = new Map([
  ['tr', 1],
  ['pick', 2],
  ['pickFormat', 2],
])

function literalStrings(node, out) {
  if (node === null || node === undefined) return false
  if (node.type === 'Literal' && typeof node.value === 'string') {
    out.push(node.value)
    return true
  }
  // Both branches of a literal choice are real strings the panel can show, so they
  // are collected too instead of being reported as untranslatable.
  if (node.type === 'ConditionalExpression') {
    const branches = []
    const consequent = literalStrings(node.consequent, branches)
    const alternate = literalStrings(node.alternate, branches)
    if (consequent && alternate) {
      out.push(...branches)
      return true
    }
  }
  return false
}

function walk(node, visit) {
  if (node === null || typeof node !== 'object' || typeof node.type !== 'string') return
  visit(node)
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end') continue
    const value = node[key]
    if (Array.isArray(value)) {
      for (const item of value) walk(item, visit)
    } else if (value !== null && typeof value === 'object' && typeof value.type === 'string') {
      walk(value, visit)
    }
  }
}

/**
 * Read every UI string out of the client source.
 * Returns { entries, dynamic }: entries maps each English literal to the Chinese
 * literal written beside it, dynamic lists the call sites whose English argument is
 * not a literal (they would escape translation, so callers treat them as errors).
 */
export function collectClientStrings(source) {
  const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script', locations: true, allowReturnOutsideFunction: true })
  const entries = new Map()
  const dynamic = []
  walk(ast, (node) => {
    if (node.type !== 'CallExpression' || node.callee.type !== 'Identifier') return
    if (!CALLS.has(node.callee.name)) return
    // `const tr = (zh, en) => pick(language, zh, en)` is the component-local wrapper,
    // not a string: its arguments are the wrapper's own parameters.
    if (node.arguments.some((argument) => argument.type === 'Identifier' && (argument.name === 'zh' || argument.name === 'en'))) return
    const englishIndex = CALLS.get(node.callee.name)
    const english = []
    if (!literalStrings(node.arguments[englishIndex], english)) {
      dynamic.push({ line: node.loc.start.line, call: node.callee.name })
      return
    }
    const chinese = []
    literalStrings(node.arguments[englishIndex - 1], chinese)
    for (const text of english) {
      if (!entries.has(text)) entries.set(text, { zh: chinese[english.indexOf(text)] ?? '', line: node.loc.start.line, call: node.callee.name })
    }
  })
  return { entries, dynamic }
}

const PLACEHOLDER = /\{[a-z]+\}/g

function placeholderSet(text) {
  return (String(text).match(PLACEHOLDER) || []).sort().join(',')
}

/**
 * Compare one dictionary against the source strings. Everything that would show
 * English (or a broken template) to a reader of another language is a failure:
 * a key the source does not use, a source string the dictionary misses, an empty
 * value, or a value whose placeholders do not match the English template.
 */
export function verifyDictionary(language, dictionary, entries) {
  const missing = []
  const extra = []
  const empty = []
  const placeholderMismatch = []
  for (const [english] of entries) {
    if (!Object.prototype.hasOwnProperty.call(dictionary, english)) { missing.push(english); continue }
    const value = dictionary[english]
    if (typeof value !== 'string' || value.trim() === '') { empty.push(english); continue }
    if (placeholderSet(value) !== placeholderSet(english)) placeholderMismatch.push(english)
  }
  for (const key of Object.keys(dictionary)) {
    if (!entries.has(key)) extra.push(key)
  }
  return { language, missing, extra, empty, placeholders: placeholderMismatch }
}
