import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

// A render smoke test for the filter menu: it drives the component through a fake
// hooks dispatcher (React itself is not installed here, only in the web profile)
// and asserts the option rows it builds. The memoisation that stops a polling
// render from rebuilding those rows is asserted at the source level in
// client-refresh.test.js, where the page's useMemo-built option lists are checked.
const require = createRequire(import.meta.url)
const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')

function verifyFilterMenu({ callTwice }) {
  const react = require(join(homedir(), '.dsh', 'profiles', 'web', 'node_modules', 'react'))
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
