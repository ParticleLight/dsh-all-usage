import assert from 'node:assert/strict'
import test from 'node:test'
import { cacheRecordsResult, deleteRecordsResult, getRecordsResult, recordKeyHash, recordPageReferences, recordsCacheStats } from '../lib/records-cache.js'

const rows = (count, sid = 's', start = 0) => Array.from({ length: count }, (_, index) => ({
  item: { sid, key: sid + ':step:' + (start + index) + ':0', values: { input: index }, cost: { total: String(index) } }, date: '2026-10-13',
}))
const repeated = (sid, key = sid + ':step:0:0') => new Array(24001).fill({ item: { sid, key, values: { input: 5 }, cost: { total: '0.000005' } }, date: '2026-10-13' })

test('full scopes share a total 24000-row budget without truncating compacted scopes', () => {
  const cache = new Map()
  const first = cacheRecordsResult(cache, 'a', rows(9000, 'a'))
  const second = cacheRecordsResult(cache, 'b', rows(9000, 'b'))
  assert.equal(getRecordsResult(cache, 'a'), first)
  cacheRecordsResult(cache, 'c', rows(9000, 'c'))
  assert.equal(first.kind, 'rows', 'a cache hit refreshes the full-scope retention order')
  assert.equal(second.kind, 'index')
  assert.equal(recordsCacheStats(cache).rows, 18000)
  assert.equal(second.ids.length, 9000, 'the entire result remains pageable')
  assert.deepEqual(recordPageReferences(second, 8998, 5), [{ sid: 'b', key: 'b:step:8998:0' }, { sid: 'b', key: 'b:step:8999:0' }])
  assert.deepEqual(recordPageReferences(second, 9000, 20), [])
})

test('oversized scopes preserve small full caches and share payload-free key storage', () => {
  const cache = new Map()
  cacheRecordsResult(cache, 'small', rows(100, 'small'))
  const a = cacheRecordsResult(cache, 'large-a', rows(24001))
  const b = cacheRecordsResult(cache, 'large-b', rows(24001))
  assert.equal(cache.get('small').kind, 'rows')
  assert.equal(recordsCacheStats(cache).rows, 100)
  assert.equal(a.kind, 'index'); assert.equal(b.kind, 'index')
  assert.equal(a.catalog, b.catalog)
  assert.equal(a.catalog.references.size, 24001, 'overlap shares keys, not reloaded row/value/cost objects')
  assert.equal('rows' in a, false)
  for (const reference of a.catalog.references.values()) assert.deepEqual(Object.keys(reference).sort(), ['key', 'sid', 'uses'])
  const directory = a.catalog
  cache.clear()
  const fresh = cacheRecordsResult(cache, 'new', repeated('new'))
  assert.notEqual(fresh.catalog, directory, 'no state-level catalog survives a cache clear')
})

test('LRU eviction releases unreferenced catalog keys and recycled ids preserve selected pages', () => {
  const cache = new Map()
  const anchor = cacheRecordsResult(cache, 'anchor', repeated('anchor'))
  let captured
  for (let index = 0; index < 30; index += 1) {
    getRecordsResult(cache, 'anchor')
    const entry = cacheRecordsResult(cache, 'range-' + index, repeated('sid-' + index))
    if (index === 0) captured = recordPageReferences(entry, 0, 2)
    assert.ok(cache.size <= 20)
    assert.ok(recordsCacheStats(cache).rows <= 24000)
  }
  assert.equal(cache.has('range-0'), false)
  assert.equal(anchor.catalog.bySession.has('sid-0'), false)
  assert.equal(anchor.catalog.references.size, 20, 'only the active index union retains key references')
  assert.equal(anchor.catalog.nextId, 20, 'freed identifiers are reused')
  assert.deepEqual(captured, [{ sid: 'sid-0', key: 'sid-0:step:0:0' }, { sid: 'sid-0', key: 'sid-0:step:0:0' }])
  const activeIds = new Set(Array.from(cache.values()).flatMap(entry => Array.from(entry.ids)))
  assert.deepEqual(new Set(anchor.catalog.references.keys()), activeIds)
  deleteRecordsResult(cache, 'anchor')
  assert.equal(anchor.catalog.bySession.has('anchor'), false)
  assert.equal(anchor.catalog.references.size, 19)
})

const legacyRange = (sid, key) => [{ item: { sid, key } }, ...new Array(24000).fill({ item: { sid, key: sid + ':step:0:0' } })]

test('legacy payload keys stay fixed-size and identical keys from different sessions do not alias', () => {
  const cache = new Map()
  const payloadKey = 'legacy:event:' + JSON.stringify({ secret: 'private-payload-' + 'x'.repeat(10000), usage: { inputTokens: 500 } })
  const a = cacheRecordsResult(cache, 'a', legacyRange('a\0b', payloadKey))
  const b = cacheRecordsResult(cache, 'b', legacyRange('a', payloadKey))
  assert.notEqual(a.ids[0], b.ids[0])
  assert.equal(a.catalog.references.size, 4)
  const refs = recordPageReferences(a, 0, 1)
  assert.equal(refs[0].key, undefined)
  assert.equal(refs[0].keyHash.length, 43)
  assert.equal(JSON.stringify(Array.from(a.catalog.references.values())).includes('private-payload'), false)
  assert.deepEqual(recordPageReferences(b, 0, 1), [{ sid: 'a', keyHash: refs[0].keyHash }])
})

test('different legacy UTF16 code units retain distinct numeric indices', () => {
  const cache = new Map()
  const keyA = 's:legacy:\ud800', keyB = 's:legacy:\ud801'
  const a = cacheRecordsResult(cache, 'a', legacyRange('s', keyA))
  const b = cacheRecordsResult(cache, 'b', legacyRange('s', keyB))
  assert.notEqual(a.ids[0], b.ids[0], 'lone surrogates must not alias through UTF8 replacement characters')
  assert.equal(a.ids[1], b.ids[1], 'the canonical overlap still shares its identifier')
  assert.deepEqual(recordPageReferences(a, 0, 1), [{ sid: 's', keyHash: recordKeyHash(keyA) }])
  assert.deepEqual(recordPageReferences(b, 0, 1), [{ sid: 's', keyHash: recordKeyHash(keyB) }])
  assert.equal(a.catalog.references.size, 3)
})

test('partially overlapping compact ranges release only their exclusive identifiers', () => {
  const cache = new Map()
  const a = cacheRecordsResult(cache, 'a', rows(24001, 's', 0))
  const b = cacheRecordsResult(cache, 'b', rows(24001, 's', 12000))
  const saved = recordPageReferences(a, 0, 2)
  const shared = a.ids[12000]
  assert.equal(a.catalog.references.size, 36001)
  assert.equal(a.catalog.references.get(shared).uses, 2)
  deleteRecordsResult(cache, 'a')
  assert.equal(b.catalog.references.size, 24001)
  assert.equal(b.catalog.references.get(shared).uses, 1)
  assert.equal(b.catalog.bySession.get('s').has('raw:s:step:0:0'), false)
  assert.deepEqual(recordPageReferences(b, 0, 1), [{ sid: 's', key: 's:step:12000:0' }])
  cacheRecordsResult(cache, 'c', legacyRange('new', 'new:logical:only'))
  assert.deepEqual(saved, [{ sid: 's', key: 's:step:0:0' }, { sid: 's', key: 's:step:1:0' }])
})

test('forceIndex compacts a small scope and never retains metadata rows', () => {
  const cache = new Map()
  const metadata = Array.from({ length: 2 }, (_, index) => ({ item: { sid: 's', key: 's:step:' + index + ':0' }, date: '2026-10-13' }))
  const forced = cacheRecordsResult(cache, 'forced', metadata, true)
  assert.equal(forced.kind, 'index')
  assert.equal('rows' in forced, false, 'metadata stand-ins must never be held as real rows')
  assert.equal(recordsCacheStats(cache).rows, 0)
  assert.deepEqual(recordPageReferences(forced, 0, 5), [{ sid: 's', key: 's:step:0:0' }, { sid: 's', key: 's:step:1:0' }])
  const resident = cacheRecordsResult(cache, 'resident', rows(2, 'r'))
  assert.equal(resident.kind, 'rows')
  const small = cacheRecordsResult(cache, 'small', rows(2, 't'))
  assert.equal(small.kind, 'rows', 'without forceIndex a small scope keeps its payloads')
})
