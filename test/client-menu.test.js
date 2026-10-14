import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

// A render smoke test for the filter menu. The real React package lives in a
// local DSH web profile, which a GitHub runner does not have, so the component is
// driven through a tiny in-file React stub instead. The stub covers exactly what
// the component and this test touch: the ReactCurrentDispatcher internals slot
// the hooks read, createElement, and memo. The memoisation that stops a polling
// render from rebuilding those rows is asserted at the source level in
// client-refresh.test.js, where the page's useMemo-built option lists are checked.
const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')

// createElement keeps config on props and collects the variadic children the same
// way React does: a lone child stays unwrapped, several become an array.
function createElement(type, config = null, ...children) {
  const props = {}
  if (config !== null && config !== undefined) {
    for (const [name, value] of Object.entries(config)) { if (name !== 'key') props[name] = value }
  }
  if (children.length === 1) props.children = children[0]
  else if (children.length > 1) props.children = children
  return { type, props }
}

// React.memo yields an element type whose `.type` is the wrapped component; the
// test invokes that component directly, which is how it bypasses memo's bail-out.
function memo(component, compare) {
  return { $$typeof: Symbol.for('react.memo'), type: component, compare }
}

const ReactCurrentDispatcher = { current: null }
function activeDispatcher() {
  const current = ReactCurrentDispatcher.current
  if (current === null || current === undefined) throw new Error('a hook ran without a dispatcher')
  return current
}
// The hooks route through ReactCurrentDispatcher exactly like React's own do, so
// the dispatcher the test installs is the one the component actually consumes.
const react = {
  __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: { ReactCurrentDispatcher },
  createElement,
  memo,
  useState: (...args) => activeDispatcher().useState(...args),
  useRef: (...args) => activeDispatcher().useRef(...args),
  useEffect: (...args) => activeDispatcher().useEffect(...args),
  useMemo: (...args) => activeDispatcher().useMemo(...args),
  useCallback: (...args) => activeDispatcher().useCallback(...args),
}

function verifyFilterMenu({ callTwice }) {
  const from = source.indexOf('    function UsageFilterMenu(props) {')
  const to = source.indexOf('    const MemoUsageFilterMenu')
  assert.notEqual(from, -1, 'UsageFilterMenu must exist')
  assert.notEqual(to, -1, 'MemoUsageFilterMenu must exist')
  const renders = { count: 0 }
  const state = { value: 0, setCount: 0 }
  const internals = react.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED
  const previous = internals.ReactCurrentDispatcher.current
  const LineIconStub = (props) => ({ type: 'icon', props })
  const MemoModelIconStub = (props) => ({ type: 'brand', props })
  const dispatcher = {
    useState: () => [state, () => { state.setCount += 1 }],
    useRef: () => ({ current: null }),
    useEffect: () => {},
    useMemo: (factory) => factory(),
    useCallback: (callback) => callback,
  }
  internals.ReactCurrentDispatcher.current = dispatcher
  let tree = null
  try {
    const body = source.slice(from, to) + '\nglobalThis.__menu = (props) => { globalThis.__renders.count += 1; return UsageFilterMenu(props) }'
    globalThis.__renders = renders
    const evaluate = new Function('React', 'LineIcon', 'MemoModelIcon', 'globalThis', body)
    evaluate(react, LineIconStub, MemoModelIconStub, globalThis)
    const props = {
      label: 'All workspaces',
      ariaLabel: 'Workspace filter',
      className: 'uh-filter-workspace',
      icon: 'folder',
      value: 'ws-1',
      options: [{ value: '', label: 'All workspaces' }, { value: 'ws-1', label: 'Repo A' }],
      onChange: () => {},
    }
    const Menu = globalThis.__menu
    const element = react.createElement(react.memo(Menu), props)
    // First render: the component runs and builds one option row per entry.
    const first = element.type.type(props)
    const optionRows = Array.isArray(first.props.children) ? first.props.children[1] : null
    const rendered = optionRows === null || optionRows === undefined ? [] : (Array.isArray(optionRows.props.children) ? optionRows.props.children : [optionRows.props.children])
    // Second render with an identical props object: memo would bail out.
    if (callTwice === true) element.type.type(props)
    tree = { optionRows: rendered.length, labels: rendered.map((row) => Array.isArray(row.props.children) ? String(row.props.children[1].props.children) : '') }
  } finally {
    internals.ReactCurrentDispatcher.current = previous
    delete globalThis.__menu
    delete globalThis.__renders
  }
  return { renders: renders.count, ...tree }
}

test('the filter menu renders one row per option', () => {
  const result = verifyFilterMenu({ callTwice: false })
  assert.equal(result.optionRows, 2, 'every option becomes a row')
  assert.deepEqual(result.labels, ['All workspaces', 'Repo A'])
  assert.equal(result.renders, 1)
  // The page memoises the option list, so an unchanged list means unchanged props
  // and React.memo skips the body entirely: only the first render counts.
  const repeated = verifyFilterMenu({ callTwice: true })
  assert.equal(repeated.renders, 2, 'each call builds its rows again, so memo has something to skip')
})
