import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { localeHelperSource } from './support/locale-helpers.js'

// Cold-ledger maintenance: the panel may only ask the host to fold old sessions into
// monthly files after showing what that plan contains, and the apply needs a second
// click. The wording and the number rules are pure functions, so they are sliced out of
// the client and evaluated here; only the last group of tests reads the source itself.
const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')
const start = source.indexOf('    // ---------- archive ----------')
const end = source.indexOf('    // ---------- archive end ----------')
assert.notEqual(start, -1, 'the archive helper start marker must exist')
assert.notEqual(end, -1, 'the archive helper end marker must exist')
assert.ok(end > start, 'the archive helpers must sit in one contiguous block')
const block = source.slice(start, end)

const snippet = localeHelperSource(source) + '\n' + block +
  '\nglobalThis.__archive = { ARCHIVE_DAYS_MIN, ARCHIVE_DAYS_MAX, validArchiveDays, archivePayload, archiveSizeText, archivePlanSummary, archiveResultSummary, archiveErrorCodeOf, archiveErrorMessage, archiveLedgerRpc }'

function load(fetchImpl) {
  const context = fetchImpl === undefined ? {} : { fetch: fetchImpl }
  vm.runInNewContext(snippet, context)
  return context.__archive
}

const archive = load()
// Values built inside the sandbox carry another realm's prototypes, and deepEqual
// compares prototypes: copy them through JSON before comparing structure.
const plain = (value) => JSON.parse(JSON.stringify(value))
const {
  ARCHIVE_DAYS_MIN,
  ARCHIVE_DAYS_MAX,
  validArchiveDays,
  archivePayload,
  archiveSizeText,
  archivePlanSummary,
  archiveResultSummary,
  archiveErrorCodeOf,
  archiveErrorMessage,
  archiveLedgerRpc,
} = archive

test('accepts an integer day count inside 1..3650 and nothing else', () => {
  assert.equal(ARCHIVE_DAYS_MIN, 1)
  assert.equal(ARCHIVE_DAYS_MAX, 3650)
  // The field is <input type="number">, so the value arrives as a string.
  assert.equal(validArchiveDays('90'), 90)
  assert.equal(validArchiveDays('1'), 1)
  assert.equal(validArchiveDays('3650'), 3650)
  assert.equal(validArchiveDays(' 90 '), 90, 'a padded value is still the number the reader typed')
  assert.equal(validArchiveDays(90), 90, 'a number from a test or a future caller is accepted too')
  // The box reports an empty string when it is cleared, and the browser leaves the
  // rejected text in place: neither may reach the wire as NaN or as a float.
  assert.equal(validArchiveDays(''), null)
  assert.equal(validArchiveDays('   '), null)
  assert.equal(validArchiveDays('abc'), null)
  assert.equal(validArchiveDays('1.5'), null)
  assert.equal(validArchiveDays('1e3'), null)
  assert.equal(validArchiveDays('-5'), null)
  assert.equal(validArchiveDays('0'), null, 'zero days would archive everything')
  assert.equal(validArchiveDays('3651'), null)
  assert.equal(validArchiveDays(0), null)
  assert.equal(validArchiveDays(1.5), null)
  assert.equal(validArchiveDays(3651), null)
  assert.equal(validArchiveDays(null), null)
  assert.equal(validArchiveDays(undefined), null)
})

test('sends the same body for the plan and for the apply', () => {
  assert.deepEqual(plain(archivePayload(90, true)), { days: 90, dryRun: true })
  assert.deepEqual(plain(archivePayload(90, false)), { days: 90, dryRun: false })
  // Only a real true counts: a truthy value must never turn a preview into a write.
  assert.deepEqual(plain(archivePayload(30, 'yes')), { days: 30, dryRun: false })
  assert.deepEqual(plain(archivePayload(30, undefined)), { days: 30, dryRun: false })
})

test('formats archive sizes in binary units with one decimal from KB up', () => {
  assert.equal(archiveSizeText(0), '0 B')
  assert.equal(archiveSizeText(820), '820 B')
  assert.equal(archiveSizeText(1023), '1023 B')
  assert.equal(archiveSizeText(1024), '1.0 KB')
  assert.equal(archiveSizeText(12700), '12.4 KB', '12700 / 1024 = 12.40')
  assert.equal(archiveSizeText(1536), '1.5 KB')
  assert.equal(archiveSizeText(1048576), '1.0 MB')
  // 142.5e6 / 1048576 = 135.9; 142.6e6 = 135.98 rounds up to 136.0.
  assert.equal(archiveSizeText(142.5e6), '135.9 MB')
  assert.equal(archiveSizeText(142.6e6), '136.0 MB')
  assert.equal(archiveSizeText(1.2 * 1024 ** 3), '1.2 GB')
  assert.equal(archiveSizeText(1024 ** 4), '1024.0 GB', 'the unit stops at GB')
  // A missing or broken byte count must not print NaN into the panel.
  assert.equal(archiveSizeText(-1), '0 B')
  assert.equal(archiveSizeText(Number.NaN), '0 B')
  assert.equal(archiveSizeText('12'), '0 B')
  assert.equal(archiveSizeText(undefined), '0 B')
})

test('describes a plan by its records, its size and its months', () => {
  const plan = { archived: 120, bytes: 12700, months: ['2026-01', '2025-12'] }
  const english = archivePlanSummary(plan, 'en')
  assert.deepEqual(plain(english.months), ['2025-12', '2026-01'], 'month keys sort chronologically')
  assert.equal(english.records, 120)
  assert.equal(english.size, '12.4 KB')
  assert.equal(english.text, 'Archive 120 records (12.4 KB) across 2 months: 2025-12, 2026-01')
  const chinese = archivePlanSummary(plan, 'zh')
  assert.equal(chinese.text, '将归档 120 条记录（12.4 KB），涉及 2 个月份：2025-12、2026-01')
  // A dictionary this page does not carry falls back to English, like every other row.
  assert.equal(archivePlanSummary(plan, 'ja').text, english.text)
  // One month reads the same template with a list of one.
  assert.equal(archivePlanSummary({ archived: 2, bytes: 2048, months: ['2026-02'] }, 'en').text, 'Archive 2 records (2.0 KB) across 1 months: 2026-02')
})

test("reads the host's own field name for the count", () => {
  // lib/archive.js returns { months, archived, bytes, compressed, dryRun, errors } and the
  // route hands that object over untouched. Reading 'records' off the wire made every
  // preview look empty and kept the apply button from ever appearing, so the contract is
  // pinned from both sides: the real field counts, the panel's own name does not.
  const hostPayload = { dryRun: true, days: 90, months: ['2026-01'], archived: 2, bytes: 1024, compressed: 512, errors: [] }
  assert.equal(archivePlanSummary(hostPayload, 'en').records, 2)
  assert.equal(archivePlanSummary(hostPayload, 'en').text, 'Archive 2 records (1.0 KB) across 1 months: 2026-01')
  assert.equal(archiveResultSummary(hostPayload, 'en'), 'Archived 2 records: 512 B on disk (was 1.0 KB)')
  // The returned object keeps the panel's name, but the wire never carries it.
  assert.equal(archivePlanSummary({ records: 2 }, 'en').records, 0, 'a payload without the host field counts nothing')
  assert.equal(archiveResultSummary({ records: 2 }, 'en'), 'Archived 0 records: 0 B on disk (was 0 B)')
  assert.ok(!/source\.records/.test(block), 'the helpers must read the host field, not an invented one')
})

test('says so when nothing is old enough instead of asking a question', () => {
  const empty = archivePlanSummary({ archived: 0, bytes: 0, months: [] }, 'en')
  assert.equal(empty.records, 0)
  assert.equal(empty.text, 'No records are old enough to archive')
  assert.equal(archivePlanSummary({ archived: 0, bytes: 0, months: [] }, 'zh').text, '没有需要归档的旧记录')
  // A failed read has no plan at all, and the panel still renders a line for it.
  assert.equal(archivePlanSummary(null, 'en').text, 'No records are old enough to archive')
  assert.equal(archivePlanSummary(undefined, 'en').records, 0)
})

test('drops months it cannot print', () => {
  const summary = archivePlanSummary({ archived: 3, bytes: 100, months: ['2026-01', '', 7, null, '2025-11'] }, 'en')
  assert.deepEqual(plain(summary.months), ['2025-11', '2026-01'])
  assert.equal(summary.text, 'Archive 3 records (100 B) across 2 months: 2025-11, 2026-01')
  assert.deepEqual(plain(archivePlanSummary({ archived: 1, bytes: 1 }, 'en').months), [], 'a payload without months is not a crash')
})

test('reports what landed on disk, and names the months that failed', () => {
  const result = { archived: 120, bytes: 142.5e6, compressed: 12700, months: ['2025-12'], errors: [] }
  assert.equal(archiveResultSummary(result, 'en'), 'Archived 120 records: 12.4 KB on disk (was 135.9 MB)')
  assert.equal(archiveResultSummary(result, 'zh'), '已归档 120 条记录，压缩后 12.4 KB（原 135.9 MB）')
  // A failed month is part of the same line: its records are still in the tree and the
  // next run picks them up, while the rest of the run already happened.
  const partial = { archived: 80, bytes: 2048, compressed: 1024, errors: [{ month: '2025-12', message: 'locked' }, { key: '2026-01' }, {}] }
  assert.equal(archiveResultSummary(partial, 'en'), 'Archived 80 records: 1.0 KB on disk (was 2.0 KB) · Some months could not be archived: 2025-12, 2026-01, ?')
  assert.equal(archiveResultSummary(partial, 'zh'), '已归档 80 条记录，压缩后 1.0 KB（原 2.0 KB） · 部分月份归档失败：2025-12、2026-01、?')
  assert.equal(archiveResultSummary({ ...result, errors: 'locked' }, 'en'), 'Archived 120 records: 12.4 KB on disk (was 135.9 MB)', 'a non-list error field is ignored')
  assert.equal(archiveResultSummary(null, 'en'), 'Archived 0 records: 0 B on disk (was 0 B)')
})

test('maps a refusal to a message code, falling back to the status', () => {
  // writeWithFreshToken hands the failure straight through, and a missing capability
  // arrives as null.
  assert.equal(archiveErrorCodeOf(null), 'token')
  assert.equal(archiveErrorCodeOf(undefined), 'token')
  // The host's body carries the code; a body that could not be read leaves the status.
  assert.equal(archiveErrorCodeOf({ code: 'no-root', status: 400 }), 'no-root')
  assert.equal(archiveErrorCodeOf({ code: 'invalid-days', status: 400 }), 'invalid-days')
  assert.equal(archiveErrorCodeOf({ code: '', status: 403 }), 'forbidden')
  assert.equal(archiveErrorCodeOf({ status: 403 }), 'forbidden')
  assert.equal(archiveErrorCodeOf({ status: 409 }), 'busy')
  assert.equal(archiveErrorCodeOf({ status: 413 }), 'archive-failed', 'an oversized request is a failed archive')
  assert.equal(archiveErrorCodeOf({ status: 500 }), 'archive-failed')
  assert.equal(archiveErrorCodeOf({ status: 503 }), 'ledger-unavailable')
  assert.equal(archiveErrorCodeOf(new Error('network down')), 'archive-failed')
  assert.equal(archiveErrorCodeOf('busy'), 'archive-failed')
})

test('tells a busy ledger apart from a failed one in both languages', () => {
  assert.equal(archiveErrorMessage('busy', 'en'), 'Another DSH process is maintaining the ledger; try again in a moment')
  assert.equal(archiveErrorMessage('busy', 'zh'), '另一个 DSH 进程正在维护账本，请稍后再试')
  assert.equal(archiveErrorMessage('no-root', 'en'), 'This storage does not support archiving')
  assert.equal(archiveErrorMessage('no-root', 'zh'), '当前存储不支持归档')
  assert.equal(archiveErrorMessage('ledger-unavailable', 'en'), 'The ledger is not ready yet; try again in a moment')
  assert.equal(archiveErrorMessage('ledger-unavailable', 'zh'), '账本尚未就绪，请稍后再试')
  assert.equal(archiveErrorMessage('days', 'en'), 'Enter a number of days between 1 and 3650')
  assert.equal(archiveErrorMessage('days', 'zh'), '请输入 1 到 3650 之间的天数')
  // The capability is shared with the cost panel, so a rotated token reads the same in
  // both places instead of inventing a second wording.
  assert.equal(archiveErrorMessage('token', 'en'), 'The process capability is unavailable; refresh the dashboard')
  assert.equal(archiveErrorMessage('forbidden', 'en'), 'Write rejected: the permission check failed (a stale process capability is also possible); refresh the dashboard and retry')
  assert.equal(archiveErrorMessage('archive-failed', 'en'), 'Archiving failed; try again.')
  assert.equal(archiveErrorMessage('archive-failed', 'zh'), '归档失败，请重试')
  // A code this page has never heard of still says something actionable.
  assert.equal(archiveErrorMessage('some-future-code', 'en'), 'Archiving failed; try again.')
  assert.equal(archiveErrorMessage('', 'zh'), '归档失败，请重试')
})

test('posts the plan and the apply to the archive route with the write capability', async () => {
  const calls = []
  const helpers = load((url, init) => {
    calls.push({ url, init })
    return Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: true, dryRun: true, days: 90, archived: 3, bytes: 512, compressed: 256, months: ['2026-01'], errors: [] }) })
  })
  const data = await helpers.archiveLedgerRpc(90, true, 'cap-1')
  // The RPC hands the host payload over untouched, and the summary reads its count: this
  // pair is what broke the panel when the two sides used different field names.
  assert.equal(data.archived, 3)
  assert.equal(helpers.archivePlanSummary(data, 'en').records, 3)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, '/api/all-usage/archive')
  assert.equal(calls[0].init.method, 'POST')
  // The headers object is built inside the sandbox, so copy it into this realm first.
  assert.deepEqual(plain(calls[0].init.headers), { 'content-type': 'application/json', 'x-all-usage-request-token': 'cap-1' })
  assert.deepEqual(JSON.parse(calls[0].init.body), { days: 90, dryRun: true })
})

test('carries the refusal status and the message code out of the response', async () => {
  const busy = load(() => Promise.resolve({ status: 409, json: () => Promise.resolve({ ok: false, message: 'busy' }) }))
  await assert.rejects(() => busy.archiveLedgerRpc(90, false, 'cap'), (error) => error.status === 409 && error.code === 'busy' && archiveErrorCodeOf(error) === 'busy')
  // A 403 that writeWithFreshToken did not heal has no readable body here.
  const unreadable = load(() => Promise.resolve({ status: 403, json: () => Promise.reject(new Error('not json')) }))
  await assert.rejects(() => unreadable.archiveLedgerRpc(90, false, 'cap'), (error) => error.status === 403 && error.code === '' && archiveErrorCodeOf(error) === 'forbidden')
  // ok:true is the only success: a 200 with anything else is still a refusal.
  const odd = load(() => Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: false, message: 'ledger-unavailable' }) }))
  await assert.rejects(() => odd.archiveLedgerRpc(90, false, 'cap'), (error) => error.code === 'ledger-unavailable' && archiveErrorCodeOf(error) === 'ledger-unavailable')
})

test('asks the host for a plan before it archives anything', () => {
  assert.ok(source.includes("fetch('/api/all-usage/archive'"), 'the client must call the archive route')
  assert.equal((source.match(/archiveLedgerRpc\(days, true, token\)/g) || []).length, 1, 'the preview is the dry run')
  assert.equal((source.match(/archiveLedgerRpc\(days, false, token\)/g) || []).length, 1, 'the apply is the real run')
  const applyButton = source.split(/\r?\n/).filter((line) => line.includes("'开始归档'"))
  assert.equal(applyButton.length, 1, 'the apply button is rendered once')
  assert.match(applyButton[0], /archiveRecords > 0/, 'the apply button exists only for a plan that counted records')
  assert.match(applyButton[0], /!archiveConfirm/, 'the apply button gives way to the confirmation row')
})

test('keeps the panel open while a write is in flight and refreshes the dashboard after it', () => {
  const closeAt = source.indexOf('      const closeArchivePanel = () => {')
  const openAt = source.indexOf('      const openArchivePanel = () => {')
  assert.ok(closeAt > 0 && openAt > closeAt, 'the close and open handlers must exist in that order')
  assert.match(source.slice(closeAt, openAt), /if \(archiveBusy\) return/, 'a running archive is not aborted by closing the panel')

  const previewAt = source.indexOf('      const previewArchive = () => {')
  const requestAt = source.indexOf('      const requestArchive = () => {')
  const applyAt = source.indexOf('      const applyArchive = () => {')
  const totalsAt = source.indexOf('      const totalTokens =')
  assert.ok(previewAt > 0 && requestAt > previewAt && applyAt > requestAt && totalsAt > applyAt, 'the archive handlers must sit together')
  assert.match(source.slice(previewAt, requestAt), /validArchiveDays\(archiveDays\)/, 'the preview validates the day count before it calls the host')
  assert.match(source.slice(requestAt, applyAt), /records <= 0/, 'an empty plan is not worth a confirmation')
  const applySlice = source.slice(applyAt, totalsAt)
  assert.match(applySlice, /refreshRef\.current\(\)/, 'records left the trees, so the dashboard has to be read again')
  assert.match(applySlice, /setArchiveResult\(data\)/, 'a successful apply reports what landed on disk')
  assert.match(applySlice, /setArchivePlan\(null\)/, 'a successful apply drops the plan it just consumed')

  const openSlice = source.slice(openAt, previewAt)
  assert.match(openSlice, /closePricingPanel\(\)/, 'two panels never write the same capability on one page')
  assert.match(openSlice, /setAliasOpen\(false\)/)
})

test('drops a plan when the day count it was counted for changes', () => {
  const updateAt = source.indexOf('      const updateArchiveDays = (value) => {')
  const previewAt = source.indexOf('      const previewArchive = () => {')
  assert.ok(updateAt > 0 && previewAt > updateAt, 'the day-count handler must sit before the preview handler')
  const updateSlice = source.slice(updateAt, previewAt)
  assert.match(updateSlice, /setArchivePlan\(null\)/, 'a plan for another day count must not survive an edit')
  assert.match(updateSlice, /setArchiveConfirm\(false\)/, 'a pending confirmation must not survive an edit either')
  const inputLine = source.split(/\r?\n/).find((line) => line.includes("className: 'uh-archive-days-input'"))
  assert.ok(inputLine, 'the day-count input must exist')
  assert.match(inputLine, /onChange: \(event\) => updateArchiveDays\(event\.target\.value\)/, 'the input must go through that handler')
  assert.match(inputLine, /min: 1, max: 3650/, 'the browser offers the same range the host accepts')
})

test('never lets the cost dialog open on top of a running archive', () => {
  const openPricingAt = source.indexOf('      const openPricingPanel = () => {')
  const pricingLoadAt = source.indexOf('        getPricing().then((pricing) => {', openPricingAt)
  assert.ok(openPricingAt > 0 && pricingLoadAt > openPricingAt, 'the cost panel handler must exist')
  const slice = source.slice(openPricingAt, pricingLoadAt)
  assert.match(slice, /if \(archiveBusy\) return/, 'an apply that is rewriting the ledger is never covered by another panel')
  assert.match(slice, /closeArchivePanel\(\)/, 'the two panels are mutually exclusive')
  assert.match(slice, /setAliasOpen\(false\)/, 'the cost panel still closes the alias panel')
  // The button that would open it is disabled for the same reason, so the click never
  // reaches the handler in the first place.
  const costDisabled = source.split(/\r?\n/).find((line) => line.includes('disabled: pricingSaving || pricingSyncing || pricingSyncSaving'))
  assert.ok(costDisabled, 'the cost button must keep its own busy guard')
  assert.ok(costDisabled.includes('archiveBusy'), 'the cost button also waits for a running archive')
})

test('renders the maintenance panel in the page flow, not in a dialog', () => {
  const tree = source.indexOf('        pricingPanel,')
  assert.ok(tree > 0, 'the page tree must still place the cost panel')
  assert.equal(source.slice(tree, tree + 80).includes('archivePanel,'), true, 'the archive panel follows the cost panel in the same tree')
  assert.ok(source.includes("className: 'uh-panel uh-archive-panel uh-anim-panel'"), 'the panel reuses the shared panel classes')
  assert.ok(source.includes("React.createElement(LineIcon, { name: 'cache', size: 16 })"), 'the panel head carries the cache mark')
})

// One caution line sits between the note and the buttons, and its wording is pinned
// here: the dictionaries are keyed by the English sentence, so a reworded line would
// silently lose its translation.
const CAUTION_NOTE = "注意：归档后的记录仍能查看与统计，但一个月的记录第一次被读时要解压整月文件，首次启动变慢，之后常驻内存。"
const CAUTION_NOTE_EN = 'Note: archived records stay readable and countable, but the first read of a month unpacks the whole month file, so the first start is slower; afterwards it stays in memory.'

test('warns once about the cost of an archive, before the buttons', () => {
  const panelAt = source.indexOf('      const archivePanel = archiveOpen ?')
  const panelEnd = source.indexOf('\n      ) : null', panelAt)
  const noteAt = source.indexOf("className: 'uh-archive-note'")
  const cautionAt = source.indexOf("className: 'uh-archive-caution'")
  const controlsAt = source.indexOf("className: 'uh-archive-controls'")
  assert.ok(panelAt > 0 && panelEnd > panelAt, 'the panel definition must exist as one statement')
  assert.ok(noteAt > panelAt && cautionAt > noteAt, 'the caution follows the note')
  assert.ok(controlsAt > cautionAt && controlsAt < panelEnd, 'the caution sits before any button')

  // The whole line is one literal pair, so the collector can key on it and the reader
  // sees exactly this sentence: no concatenation, no second sentence around it.
  const cautionLine = source.split(/\r?\n/).find((line) => line.includes("className: 'uh-archive-caution'"))
  assert.ok(cautionLine, 'the caution line must be rendered')
  assert.ok(cautionLine.includes("tr('" + CAUTION_NOTE + "', '" + CAUTION_NOTE_EN + "')"), 'the caution keeps its exact wording')
  assert.ok(cautionLine.trimStart().startsWith("React.createElement('div', { className: 'uh-archive-caution' }, tr("), 'one small line, not a list or a card')

  // The four-row card was dropped by the user's decision; nothing of it may survive.
  for (const gone of ['What it costs', 'No undo', 'Slower reads', 'One copy', 'Ledger lock', 'uh-archive-cost']) {
    assert.equal(source.includes(gone), false, gone + ' must be gone from the client')
  }
})

test('paints the caution through the host tokens, not a warning colour', () => {
  const rule = source.split(/\r?\n/).find((line) => line.startsWith('.uh-archive-caution {'))
  assert.ok(rule, 'the stylesheet must declare .uh-archive-caution')
  assert.ok(rule.includes('var(--dsw-alias-label-secondary)'), 'the line is secondary text, not an alarm')
  assert.ok(!/#[0-9a-f]{3,8}/i.test(rule), 'the caution paints through the host token only: ' + rule)
  assert.ok(!rule.includes('--uh-'), 'the caution declares no new theme token')
})
