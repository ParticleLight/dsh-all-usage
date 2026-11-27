import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')
function between(start, end) {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from)
  assert.ok(from >= 0 && to > from, 'client export function boundaries must exist')
  return source.slice(from, to)
}
const helpers = between('    function createRequestGate', '    function rangeFilenamePart')
const exporter = between('      const exportAuditCsv = async () => {', '      const recordsPanel =')
const version = { instanceId: 'host-a', dataRevision: 7, pricingRevision: 2, queryRevision: '7:2' }
const scope = { start: '2026-11-01', end: '2026-11-27', utc: false, workspaceId: 'workspace-a', provider: 'provider-a', modelKey: 'model-a' }
function row(index) {
  return { id: 'record-' + index, time: 'time-' + index, date: '2026-11-27', provider: 'provider-a', requestedModel: 'record-' + index, actualModel: 'actual', model: 'display', turn: 1, step: 2, seq: index, tokens: { input: 3 }, cost: { status: 'priced', total: '0.000001' } }
}
function harness(page, overrides = {}) {
  const state = { error: '', exporting: false, clicks: 0, calls: [], blob: null }
  const context = {
    detailView: 'logs', selectedDetailScope: scope, auditExporting: false, liveQueryVersion: 'host-a:7:2',
    setAuditExporting: (value) => { state.exporting = value },
    setAuditError: (value) => { state.error = value },
    getUsageRecords: async (selected, cursor, limit) => {
      state.calls.push({ scope: selected, cursor, limit })
      return page(cursor, state.calls.length)
    },
    tr: (zh, en) => en,
    auditToken: (item, key) => item.tokens?.[key] || 0,
    Blob,
    URL: { createObjectURL: (blob) => { state.blob = blob; return 'blob:export' }, revokeObjectURL() {} },
    document: { body: { appendChild() {} }, createElement: () => ({ click: () => { state.clicks += 1 }, remove() {} }) },
    ...overrides,
  }
  vm.runInNewContext(helpers + '\n' + exporter + '\nglobalThis.runExport = exportAuditCsv', context)
  return { state, run: context.runExport }
}
function pages(total) {
  return (cursor) => {
    const start = cursor === null ? 0 : Number(cursor)
    const end = Math.min(start + 200, total)
    return { ...version, items: Array.from({ length: end - start }, (_, index) => row(start + index)), hasMore: end < total, nextCursor: end < total ? String(end) : null }
  }
}
for (const total of [0, 1, 199, 200, 201, 9999, 10000, 10001, 16001]) {
  test('audit CSV exports the complete unique record set for ' + total + ' records', async () => {
    const h = harness(pages(total))
    await h.run()
    assert.equal(h.state.error, '')
    assert.equal(h.state.exporting, false)
    assert.equal(h.state.clicks, 1)
    const lines = (await h.state.blob.text()).split('\r\n').slice(4)
    assert.equal(lines.length, total)
    const exported = lines.map((line) => line.split(',')[3])
    assert.deepEqual(exported, Array.from({ length: total }, (_, index) => '"record-' + index + '"'))
    assert.equal(new Set(exported).size, total)
    assert.ok(h.state.calls.every((call) => call.limit === 200 && call.scope === scope))
    assert.equal(h.state.calls.length, Math.max(1, Math.ceil(total / 200)))
  })
}
for (const [name, page] of [
  ['continuation without a cursor', () => ({ ...version, items: [row(0)], hasMore: true, nextCursor: null })],
  ['a terminal page with a continuation cursor', () => ({ ...version, items: [row(0)], hasMore: false, nextCursor: 'again' })],
  ['a missing hasMore flag', () => ({ ...version, items: [row(0)], nextCursor: null })],
  ['an empty continuing page', () => ({ ...version, items: [], hasMore: true, nextCursor: 'again' })],
  ['a repeating cursor', () => ({ ...version, items: [row(0)], hasMore: true, nextCursor: 'again' })],
  ['a revision change after the first page', (_, count) => ({ ...version, dataRevision: count === 1 ? 7 : 8, queryRevision: count === 1 ? '7:2' : '8:2', items: [row(count)], hasMore: count === 1, nextCursor: count === 1 ? 'next' : null })],
  ['a stale cursor rejection', (_, count) => { if (count > 1) throw Object.assign(new Error('HTTP 409'), { status: 409 }); return { ...version, items: [row(0)], hasMore: true, nextCursor: 'next' } }],
  ['a malformed items array', () => ({ ...version, items: null, hasMore: false, nextCursor: null })],
]) {
  test('audit CSV reports ' + name + ' without downloading a partial file', async () => {
    const h = harness(page)
    await h.run()
    assert.equal(h.state.clicks, 0)
    assert.equal(h.state.blob, null)
    assert.equal(h.state.error, 'audit-export')
    assert.equal(h.state.exporting, false)
  })
}
test('audit CSV retains RFC-style quote escaping', async () => {
  const record = { ...row(0), requestedModel: 'a,"quoted" model' }
  const h = harness(() => ({ ...version, items: [record], hasMore: false, nextCursor: null }))
  await h.run()
  assert.match(await h.state.blob.text(), /"a,""quoted"" model"/)
})
