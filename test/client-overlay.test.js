import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

// Issue #4: the usage sheet used to be rendered inside the sidebar slot, right
// next to its entry button. A fixed overlay only keeps its own z-index inside the
// nearest stacking context, so a third-party theme that puts one on the sidebar
// column (dsh-wallpaper-engine's glass recipe does, with position:relative plus
// z-index:0) let the chat column paint over the whole panel. The sheet is portaled
// to <body> now, and the surfaces it paints get an opaque underlay so a theme that
// zeroes --dsw-alias-bg-base cannot hollow them out either. Both halves are
// asserted here: the portal behaviour by rendering the component against a stub
// React, the token rule at the source level.
const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')

const componentStart = source.indexOf('    function UsageSidebarEntry(props) {')
const componentEnd = source.indexOf('    exports.inject = ')
assert.notEqual(componentStart, -1, 'UsageSidebarEntry must exist')
assert.notEqual(componentEnd, -1, 'the slot registration must follow the entry component')
const component = source.slice(componentStart, componentEnd)

const LineIcon = (props) => ({ type: 'icon', props })
const Boundary = (props) => ({ type: 'boundary', props })
const Page = (props) => ({ type: 'page', props })

/** Render UsageSidebarEntry with a stub React and the given portal environment. */
function renderEntry({ open, reactDOM, documentValue }) {
  let stateIndex = 0
  const states = [open, 0, 'zh']
  const React = {
    Fragment: Symbol.for('react.fragment'),
    createElement: (type, props, ...children) => ({
      type,
      props: props === null || props === undefined ? {} : props,
      children,
    }),
    useState: (initial) => {
      const value = stateIndex < states.length ? states[stateIndex] : initial
      stateIndex += 1
      return [value, () => {}]
    },
    useEffect: () => {},
  }
  const portalCalls = []
  const portalModule = reactDOM === null || reactDOM === undefined ? undefined : {
    createPortal: (element, target) => {
      portalCalls.push({ element, target })
      return { type: 'portal', element, target }
    },
  }
  const evaluate = new Function(
    'React', 'ReactDOM', 'document', 'LineIcon', 'storedLanguage', 'persistLanguage',
    'uhWindowControlsInset', 'uhReportClientEnv', 'UsageDashboardBoundary', 'UsagePage',
    'globalThis',
    component + '\nglobalThis.__entry = UsageSidebarEntry',
  )
  const previous = globalThis.__entry
  try {
    evaluate(React, portalModule, documentValue, LineIcon, 'zh', () => {}, () => 0, () => {}, Boundary, Page, globalThis)
    const tree = globalThis.__entry({ timerCtx: {}, wide: false })
    return { tree, portalCalls }
  } finally {
    if (previous === undefined) delete globalThis.__entry
    else globalThis.__entry = previous
  }
}

test('the entry always renders its button into the sidebar slot', () => {
  const { tree } = renderEntry({ open: false, reactDOM: {}, documentValue: { body: { name: 'body' } } })
  assert.equal(tree.type, Symbol.for('react.fragment'))
  assert.equal(tree.children[0].props.className, 'uh-side-entry')
})

test('an open sheet leaves the sidebar subtree through a portal on <body>', () => {
  const body = { name: 'body' }
  const { tree, portalCalls } = renderEntry({ open: true, reactDOM: {}, documentValue: { body } })
  assert.equal(portalCalls.length, 1, 'the open sheet is portaled exactly once')
  assert.equal(portalCalls[0].target, body, 'the portal target is document.body')
  assert.equal(portalCalls[0].element.props.className, 'uh-side-modal', 'the portaled element is the sheet overlay')
  assert.equal(tree.children[1].type, 'portal', 'the slot renders the portal, not the sheet itself')
  assert.equal(tree.children[1].element, portalCalls[0].element, 'the portal wraps the sheet the component built')
})

test('a closed sheet renders nothing and asks for no portal', () => {
  const { tree, portalCalls } = renderEntry({ open: false, reactDOM: {}, documentValue: { body: {} } })
  assert.equal(tree.children[1], null)
  assert.equal(portalCalls.length, 0)
})

test('a host without react-dom or without a body keeps the inline sheet', () => {
  const noPortalModule = renderEntry({ open: true, reactDOM: null, documentValue: { body: {} } })
  assert.equal(noPortalModule.portalCalls.length, 0)
  assert.equal(noPortalModule.tree.children[1].props.className, 'uh-side-modal', 'fallback renders the sheet in place')
  const noBody = renderEntry({ open: true, reactDOM: {}, documentValue: undefined })
  assert.equal(noBody.portalCalls.length, 0)
  assert.equal(noBody.tree.children[1].props.className, 'uh-side-modal')
})

test('the source routes the sheet through the portal rather than returning it inline', () => {
  assert.match(component, /ReactDOM\.createPortal\(sheet, portalTarget\)/, 'the sheet must be portaled')
  assert.match(component, /const portalTarget = typeof ReactDOM !== 'undefined'/)
})

// A theme is free to zero the host's base background — the wallpaper plugin does
// exactly that to let the wallpaper through — so every surface the panel paints
// keeps an opaque layer underneath its translucent tint.
const surfaces = [
  ['.uh-side-dialog { width:min(1120px', false],
  ['.uh-head { position:sticky', true],
  ['.uh-side-dialog { width:min(1260px', true],
  ['.uh-side-dialog-head { position:sticky', true],
  ['.uh-donut-tooltip { position:absolute', true],
]

for (const [prefix, tinted] of surfaces) {
  test('surface ' + prefix.slice(0, 32) + ' keeps an opaque underlay', () => {
    const start = source.indexOf(prefix)
    assert.notEqual(start, -1, 'the rule must exist: ' + prefix)
    const rule = source.slice(start, source.indexOf('}', start))
    assert.match(rule, /var\(--dsw-alias-bg-layer-1, #1a1c20\)/, 'a zeroed token must not leave a transparent surface')
    if (tinted) assert.match(rule, /--dsw-alias-bg-base/, 'the surface keeps the host tint on top of the underlay')
  })
}
