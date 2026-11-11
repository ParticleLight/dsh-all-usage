import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { localeHelperSource } from './support/locale-helpers.js'

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
    localeHelperSource(source) + '\n' + component + '\nglobalThis.__entry = UsageSidebarEntry',
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
  ['.uh-side-modal .uh-side-dialog { width:min(1260px', true],
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
// The sheet used to be a bottom sheet: square bottom corners because it sat flush
// against the window edge, and a second set of rules zeroed the radius again below
// 640px, so the panel read as a plain rectangle in a narrow window. It now floats as
// a rounded card with a margin on every side.
test('the usage sheet floats as a rounded card instead of sitting flush on the window edge', () => {
  const glass = source.indexOf('.uh-side-modal .uh-side-dialog { width:min(1260px')
  assert.notEqual(glass, -1, 'the sheet rule must exist and carry two classes')
  const glassRule = source.slice(glass, source.indexOf('}', glass))
  assert.match(glassRule, /border-radius:24px;/, 'all four corners carry the sheet radius')
  assert.doesNotMatch(glassRule, /24px 24px 0 0/, 'the bottom corners are rounded as well')
  // Measured in the running app: the host skin ships
  //   [data-dsh-float] [role="dialog"] { border-radius: 14px; }
  // which is specificity (0,2,0) and therefore beat the single-class rule, so the card
  // still rendered with a 14px radius even after the radius was raised to 24px. The
  // sheet selector has to carry two classes to win that fight.
  assert.ok(
    source.includes('.uh-side-modal .uh-side-dialog {'),
    'the sheet selector outranks the host "[data-dsh-float] [role=dialog]" skin rule',
  )
  assert.match(
    glassRule,
    /box-sizing:border-box;/,
    'border-box keeps the dialog padding inside max-height: content-box made the sheet 50px taller than the viewport',
  )

  const modal = source.indexOf('.uh-side-modal { align-items:flex-end')
  assert.notEqual(modal, -1, 'the sheet overlay rule must exist')
  const modalRule = source.slice(modal, source.indexOf('}', modal))
  assert.match(modalRule, /padding:14px 16px 16px;/, 'the card keeps a gap on every side so its corners stay visible')

  assert.ok(
    source.includes('.uh-side-modal .uh-side-dialog { max-height:calc(100vh - 16px); border-radius:20px;'),
    'the compact sheet keeps rounded corners instead of falling back to a square edge',
  )
  assert.ok(
    source.includes('.uh-side-modal { padding:8px; }'),
    'the compact sheet keeps a gap around the card',
  )
})

// The toolbar used to be a full-bleed rectangle with a hard bottom border, so inside the
// rounded sheet it still read as a square white block (the reported bug). It is now a
// rounded card of its own that parks under the drag strip while the page scrolls.
test('the toolbar is a rounded card instead of a full-bleed square strip', () => {
  const head = source.indexOf('.uh-head { position:sticky')
  assert.notEqual(head, -1, 'the toolbar rule must exist')
  const headRule = source.slice(head, source.indexOf('}', head))
  assert.match(headRule, /border-radius:18px;/, 'the toolbar carries its own radius')
  assert.doesNotMatch(headRule, /border-bottom:/, 'the straight bottom border is gone')
  assert.match(headRule, /top:16px;/, 'the sticky toolbar parks below the 22px drag strip (measured at y=78 with the sheet top at y=40)')
  assert.match(headRule, /box-shadow:/, 'the card needs an edge once the border is gone')
  // Measured in the running app at the panel's own width: the action row is wider than
  // the space left beside the title, so it wraps onto a second line and used to start at
  // the left edge, leaving a gap on the right. The auto margin keeps it right-aligned.
  assert.ok(
    source.includes('.uh-head > .uh-actions { margin-left:auto; }'),
    'a wrapped action row stays flush with the right edge of the toolbar',
  )
})

// The glass theme puts backdrop-filter on .uh-side-modal and .uh-side-dialog, and a
// filter makes an element the containing block for its position:fixed descendants.
// The dialog scrolls as well, so the heatmap tooltip (fixed, viewport coordinates)
// was laid out against the dialog's content box: a left:782/top:413 style painted at
// y=-586, far above the viewport, and nobody ever saw the tooltip. Fixed layers are
// now handed to <body> through uhFixedLayer, so this file renders that helper against
// a stub react-dom and asserts both the portal and its fallback paths.
// Read the whole helper out of the source: the checkout keeps CRLF in src/, so the
// block is matched with a line-ending-agnostic pattern instead of two indexOf calls.
const fixedLayerMatch = /\r?\n    function uhFixedLayer\(node\) \{[\s\S]*?\r?\n    \}/.exec(source)
const fixedLayerStart = fixedLayerMatch === null ? -1 : fixedLayerMatch.index
const fixedLayerSource = fixedLayerMatch === null ? '' : fixedLayerMatch[0]
const offViewportTooltip = 'the tooltip is laid out against the scrolling .uh-side-dialog content box again and paints outside the viewport (measured: a left:782/top:413 tooltip rendered at y=-586)'

/** Load uhFixedLayer with a stub react-dom/document pair, exactly as the page would. */
function loadFixedLayer({ createPortal, documentValue }) {
  const calls = []
  const ReactDOM = createPortal === false
    ? null
    : createPortal === 'missing'
      ? {}
      : {
          createPortal: (element, target) => {
            calls.push({ element, target })
            return { type: 'portal', element, target }
          },
        }
  const factory = new Function('ReactDOM', 'document', fixedLayerSource + '\nreturn uhFixedLayer')
  const layer = factory(ReactDOM, documentValue)
  return { calls, run: (node) => layer(node) }
}

function stubDocument() {
  return { body: { name: 'body' } }
}

test('a fixed tooltip leaves the scrolling dialog and mounts on document.body', () => {
  assert.notEqual(fixedLayerStart, -1, 'uhFixedLayer is missing from the client: ' + offViewportTooltip)
  assert.ok(fixedLayerSource.trimEnd().endsWith('}'), 'uhFixedLayer must be read out whole, up to its closing brace')
  const body = stubDocument().body
  const node = { type: 'tooltip', props: { className: 'uh-tip' } }
  const { calls, run } = loadFixedLayer({ createPortal: true, documentValue: { body } })
  const layer = run(node)
  assert.equal(calls.length, 1, 'the tooltip is portaled exactly once: ' + offViewportTooltip)
  assert.equal(calls[0].target, body, 'the portal target must be document.body, not an ancestor inside the dialog: ' + offViewportTooltip)
  assert.equal(calls[0].element, node, 'the portal carries the tooltip element itself')
  assert.equal(layer.type, 'portal', 'uhFixedLayer returns whatever the portal returns, not the raw node')
  assert.equal(layer.element, node)
  assert.notEqual(layer, node, 'returning the node un-portaled leaves the tooltip inside the scrolling dialog: ' + offViewportTooltip)
})

test('a host without react-dom renders the tooltip in place instead of crashing', () => {
  assert.notEqual(fixedLayerStart, -1, 'uhFixedLayer is missing from the client: ' + offViewportTooltip)
  const node = { type: 'tooltip', props: { className: 'uh-tip' } }
  for (const [label, createPortal] of [['a null react-dom', false], ['a react-dom without createPortal', 'missing']]) {
    const { calls, run } = loadFixedLayer({ createPortal, documentValue: stubDocument() })
    assert.equal(run(node), node, label + ' must hand the tooltip back untouched so the panel still paints it: ' + offViewportTooltip)
    assert.equal(calls.length, 0, label + ' must not call createPortal')
  }
})

test('a host without a body renders the tooltip in place instead of crashing', () => {
  assert.notEqual(fixedLayerStart, -1, 'uhFixedLayer is missing from the client: ' + offViewportTooltip)
  const node = { type: 'tooltip', props: { className: 'uh-tip' } }
  for (const [label, documentValue] of [['no document', undefined], ['a document without body', {}], ['a null body', { body: null }]]) {
    const { calls, run } = loadFixedLayer({ createPortal: true, documentValue })
    assert.equal(run(node), node, label + ' must hand the tooltip back untouched so the panel still paints it')
    assert.equal(calls.length, 0, label + ' must not call createPortal with a missing target')
  }
})

test('a missing tooltip never reaches the portal', () => {
  assert.notEqual(fixedLayerStart, -1, 'uhFixedLayer is missing from the client: ' + offViewportTooltip)
  const { calls, run } = loadFixedLayer({ createPortal: true, documentValue: stubDocument() })
  assert.equal(run(null), null, 'a null tooltip stays null')
  assert.equal(run(undefined), undefined, 'an undefined tooltip stays undefined')
  assert.equal(calls.length, 0, 'nothing to portal means no portal call')
})

test('the heatmap renders its tooltip through uhFixedLayer and keeps both guards', () => {
  const heatmapStart = source.indexOf('    function UsageHeatmap(props) {')
  const heatmapEnd = source.indexOf('    const MemoUsageHeatmap = React.memo(UsageHeatmap)')
  assert.notEqual(heatmapStart, -1, 'UsageHeatmap must exist')
  assert.notEqual(heatmapEnd, -1, 'the memo wrapper must follow UsageHeatmap')
  const heatmap = source.slice(heatmapStart, heatmapEnd)
  const tooltipLines = heatmap.split('\n').filter((line) => line.includes('React.createElement(MemoUsageHeatmapTooltip'))
  assert.equal(tooltipLines.length, 1, 'the heatmap renders its tooltip from exactly one place')
  assert.match(tooltipLines[0], /uhFixedLayer\(\s*React\.createElement\(MemoUsageHeatmapTooltip\b/, 'the heatmap tooltip must be wrapped in uhFixedLayer(...): ' + offViewportTooltip)
  assert.doesNotMatch(heatmap, /\?\s*React\.createElement\(MemoUsageHeatmapTooltip/, 'a bare tooltip element is rendered again: ' + offViewportTooltip)
  assert.match(fixedLayerSource, /typeof ReactDOM\.createPortal !== 'function'/, 'uhFixedLayer must keep the createPortal feature check')
  assert.match(fixedLayerSource, /document\.body/, 'uhFixedLayer must keep the document.body check')
})

// Smoothness is cheap to lose: a backdrop blur on a sticky header or on a tooltip
// that follows the pointer re-rasters its backdrop on every frame, and a pulsing
// box-shadow repaints forever even when nothing moves. Both sat on surfaces that
// are already opaque, so neither bought anything visible.
test('the dashboard leaves no always-on paint work behind', () => {
  const ruleAt = (prefix) => {
    const start = source.indexOf(prefix)
    assert.notEqual(start, -1, 'the rule must exist: ' + prefix)
    return source.slice(start, source.indexOf('}', start))
  }
  for (const prefix of ['.uh-head { position:sticky', '.uh-trend-tooltip { position:absolute', '.uh-donut-tooltip { position:absolute']) {
    assert.doesNotMatch(ruleAt(prefix), /backdrop-filter/, 'no per-frame backdrop blur: ' + prefix)
  }
  assert.ok(source.includes('.uh-cell.uh-today { box-shadow:0 0 0 2px var(--uh-today); }'), 'today keeps a static ring instead of a pulse')
  assert.ok(source.includes("const cellClass = cell.date === props.todayKey ? 'uh-cell uh-today' : 'uh-cell'"), 'only today wears the ring')
  assert.equal(source.includes('uh-glow'), false, 'the endless box-shadow keyframes must be gone')
  assert.equal((source.match(/infinite/g) || []).length, 1, 'the spinner is the only endless animation left')
  assert.ok(source.includes('animation:uh-spinner-turn .78s linear infinite'), 'the spinner still turns while data loads')
})
