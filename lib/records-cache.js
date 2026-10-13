import { createHash } from 'node:crypto'

// Preserve every JavaScript key code unit, including legacy lone surrogates.
export const recordKeyHash = key => createHash('sha256').update(key, 'utf16le').digest('base64url')

// Complete rows also retain costs and their parsed decimals. Compact scopes
// share only a key directory and sorted numeric ids after this total is reached.
export function recordKeyLocator(sid, key) {
  const canonical = key.length <= 256 && key.startsWith(sid + ':') && /^(?:step:\d+:\d+|event:\d+)$/.test(key.slice(sid.length + 1))
  return canonical ? 'raw:' + key : 'hash:' + recordKeyHash(key)
}

export const RECORDS_CACHE_ROW_LIMIT = 24000
export const RECORDS_CACHE_ENTRY_LIMIT = 20

export function getRecordsResult(cache, key) {
  const entry = cache.get(key)
  if (entry !== undefined) { cache.delete(key); cache.set(key, entry) }
  return entry
}

export function deleteRecordsResult(cache, key) {
  const entry = cache.get(key)
  if (entry === undefined) return
  cache.delete(key)
  if (entry.kind !== 'index') return
  const { catalog } = entry
  for (const id of entry.ids) {
    const reference = catalog.references.get(id)
    reference.uses -= 1
    if (reference.uses !== 0) continue
    const keys = catalog.bySession.get(reference.sid)
    keys.delete(reference.key === undefined ? 'hash:' + reference.keyHash : 'raw:' + reference.key)
    if (keys.size === 0) catalog.bySession.delete(reference.sid)
    catalog.references.delete(id)
    catalog.freeIds.push(id)
  }
}

function compactResult(entry, catalog) {
  const ids = new Uint32Array(entry.rows.length)
  for (let index = 0; index < entry.rows.length; index += 1) {
    const { item } = entry.rows[index]
    // Legacy event keys may contain serialized event data. Only retain bounded
    // canonical step/event keys; all other keys use a fixed-size digest.
    const lookup = recordKeyLocator(item.sid, item.key)
    const locator = lookup.startsWith('raw:') ? { key: item.key } : { keyHash: lookup.slice(5) }
    let keys = catalog.bySession.get(item.sid)
    if (keys === undefined) { keys = new Map(); catalog.bySession.set(item.sid, keys) }
    let id = keys.get(lookup)
    if (id === undefined) {
      id = catalog.freeIds.pop() ?? catalog.nextId++
      keys.set(lookup, id)
      catalog.references.set(id, { ...locator, sid: item.sid, uses: 0 })
    }
    catalog.references.get(id).uses += 1
    ids[index] = id
  }
  entry.kind = 'index'
  entry.ids = ids
  entry.catalog = catalog
  delete entry.rows
}


export function cacheRecordsResult(cache, key, rows, forceIndex = false) {
  deleteRecordsResult(cache, key)
  const entry = { kind: 'rows', rows }
  cache.set(key, entry)
  while (cache.size > RECORDS_CACHE_ENTRY_LIMIT) deleteRecordsResult(cache, cache.keys().next().value)
  let fullRows = 0
  let catalog
  for (const result of cache.values()) {
    if (result.kind === 'rows') fullRows += result.rows.length
    else catalog = result.catalog
  }
  const compact = result => {
    // The directory is owned only by compact entries; clearing the cache drops
    // it too. Eviction releases that entry's keys even while other scopes live.
    catalog ||= { bySession: new Map(), references: new Map(), nextId: 0, freeIds: [] }
    fullRows -= result.rows.length
    compactResult(result, catalog)
  }
  // An oversized new range must not push useful small ranges out of the budget.
  // A forced index describes metadata that was never fully materialized (the
  // digest path), so it must never be retained as if it were a real row scope.
  if (forceIndex || entry.rows.length > RECORDS_CACHE_ROW_LIMIT) compact(entry)
  for (const result of cache.values()) {
    if (fullRows <= RECORDS_CACHE_ROW_LIMIT) break
    if (result.kind === 'rows') compact(result)
  }
  return entry
}

export function recordPageReferences(entry, offset, limit) {
  // Copy keys before the caller awaits I/O: eviction can recycle numeric ids
  // during that await, while this page must still refer to its selected keys.
  return Array.from(entry.ids.slice(offset, offset + limit), id => {
    const { sid, key, keyHash } = entry.catalog.references.get(id)
    return key === undefined ? { sid, keyHash } : { sid, key }
  })
}

export function recordsCacheStats(cache) {
  let rows = 0, indices = 0, indexedRows = 0
  const catalogs = new Set()
  for (const entry of cache.values()) {
    if (entry.kind === 'rows') rows += entry.rows.length
    else { indices += 1; indexedRows += entry.ids.length; catalogs.add(entry.catalog) }
  }
  return { entries: cache.size, rows, rowLimit: RECORDS_CACHE_ROW_LIMIT, indices, indexedRows,
    indexKeys: Array.from(catalogs).reduce((sum, catalog) => sum + catalog.references.size, 0) }
}
