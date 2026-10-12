import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

// Brand marks are served on demand instead of being embedded in the client
// bundle: the page asks only for the icons it actually renders (and the browser
// caches them), so adding a brand costs nothing in the bundle. The manifest stays
// the single source of truth - it is what the build validates and what this reads.
const ICONS_URL = new URL('../assets/model-icons/', import.meta.url)
let cache = null

async function loadIcons() {
  if (cache !== null) return cache
  const manifest = JSON.parse(await readFile(new URL('manifest.json', ICONS_URL), 'utf8'))
  const entries = []
  for (const icon of manifest.icons) {
    if (icon === null || typeof icon !== 'object' || typeof icon.key !== 'string' || icon.key === '') continue
    if (typeof icon.file !== 'string' || icon.file === '') continue
    const svg = await readFile(new URL(icon.file, ICONS_URL), 'utf8')
    const compact = svg.replace(/>\s+</g, '><').trim()
    const body = Buffer.from(compact, 'utf8')
    entries.push({
      key: icon.key,
      label: typeof icon.label === 'string' && icon.label !== '' ? icon.label : icon.key,
      body,
      etag: '"' + createHash('sha256').update(body).digest('base64url').slice(0, 16) + '"',
    })
  }
  cache = { entries, byKey: new Map(entries.map((entry) => [entry.key, entry])) }
  return cache
}

/** One icon by key, or null. Unknown keys never touch the filesystem. */
export async function findModelIcon(key) {
  if (typeof key !== 'string' || key === '') return null
  const { byKey } = await loadIcons()
  return byKey.get(key) || null
}

/** Every icon (used by tests and diagnostics). */
export async function listModelIcons() {
  const { entries } = await loadIcons()
  return entries
}
