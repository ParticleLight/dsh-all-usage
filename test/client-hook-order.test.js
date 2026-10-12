import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

// A dependency array is evaluated during render, so naming something that is
// declared later in the same component body is a temporal dead zone at runtime.
// That is how a memoised option list once crashed the panel while every source
// test stayed green, so the order is checked here.
const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')

/** Index of the bracket that closes the one opened at `open`. */
function matchBracket(text, open) {
  const opener = text[open]
  const closer = opener === '(' ? ')' : opener === '[' ? ']' : '}'
  let depth = 0
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === opener) depth += 1
    else if (text[index] === closer) { depth -= 1; if (depth === 0) return index }
  }
  return -1
}

function declarationLines(text, bodyStartLine) {
  const lines = text.split('\n')
  const declared = new Map()
  for (let index = bodyStartLine; index < lines.length; index += 1) {
    const match = /^      (?:const|let|function)\s+([A-Za-z_$][\w$]*)/.exec(lines[index])
    if (match !== null && !declared.has(match[1])) declared.set(match[1], index + 1)
  }
  return declared
}

/** Dependencies named in the last array of one hook call. */
function dependenciesOf(text, callStart) {
  const open = text.indexOf('(', callStart)
  const close = matchBracket(text, open)
  if (close < 0) return []
  const call = text.slice(open, close)
  const arrayStart = call.lastIndexOf('[')
  if (arrayStart < 0) return []
  const arrayEnd = matchBracket(call, arrayStart)
  if (arrayEnd < 0) return []
  return call.slice(arrayStart + 1, arrayEnd).split(',')
    .map((entry) => entry.trim().split('.')[0])
    .filter((entry) => /^[A-Za-z_$][\w$]*$/.test(entry))
}

/** Dependencies of a hook that read a name declared later in the same body. */
function violationsIn(text) {
  const start = text.split('\n').findIndex((line) => line.includes('function UsagePage(props) {'))
  if (start < 0) return []
  const declared = declarationLines(text, start)
  const violations = []
  for (const match of text.matchAll(/React\.(?:useMemo|useCallback|useEffect)\(/g)) {
    const lineNumber = text.slice(0, match.index).split('\n').length
    if (lineNumber < start) continue
    for (const dep of dependenciesOf(text, match.index)) {
      const declaredAt = declared.get(dep)
      if (declaredAt !== undefined && declaredAt > lineNumber) violations.push(dep + ' used at ' + lineNumber + ' but declared at ' + declaredAt)
    }
  }
  return violations
}

test('the dependency check catches a name declared after the hook that reads it', () => {
  const broken = [
    '    function UsagePage(props) {',
    '      const rows = React.useMemo(() => list(), [laterOptions])',
    '      const laterOptions = []',
    '    }',
  ].join('\n')
  const found = violationsIn(broken)
  assert.equal(found.length, 1, 'the checker must see the injected violation')
  assert.match(found[0], /laterOptions/)

  const ordered = [
    '    function UsagePage(props) {',
    '      const rowsOnly = []',
    '      const rows = React.useMemo(() => list(), [rowsOnly])',
    '    }',
  ].join('\n')
  assert.deepEqual(violationsIn(ordered), [])
})

test('every hook dependency in the page is declared before the hook that reads it', () => {
  assert.deepEqual(violationsIn(source), [])
})
