import { readFile, readdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { minify } from 'terser'

const sourceUrl = new URL('../src/client.js', import.meta.url)
const outputUrl = new URL('../lib/client.js', import.meta.url)
const iconsUrl = new URL('../assets/model-icons/', import.meta.url)
const MAX_ICON_BYTES = 24 * 1024
const ICON_PLACEHOLDER = '/* __MODEL_ICON_DATA__ */ null'

/** Reject anything that is not a self-contained, script-free, local SVG. */
function assertSafeSvg(name, svg) {
  const bytes = Buffer.byteLength(svg)
  if (bytes === 0 || bytes > MAX_ICON_BYTES) throw new Error('model icon ' + name + ' has an unsupported size: ' + bytes + ' B')
  if (!/^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(svg)) throw new Error('model icon ' + name + ' is not a valid SVG document (no <svg> root)')
  if (!/<\/svg>\s*$/i.test(svg.trim())) throw new Error('model icon ' + name + ' is missing its closing </svg> tag')
  if (/404|not found/i.test(svg.slice(0, 200)) && !/<svg[\s>]/i.test(svg.slice(0, 200))) throw new Error('model icon ' + name + ' looks like an error page, not an SVG')
  if (/<script|<foreignObject|javascript:|on[a-z]+\s*=/i.test(svg)) throw new Error('model icon ' + name + ' contains scripting constructs')
  if (/(?:xlink:)?href\s*=\s*["'](?!#)/i.test(svg) || /url\(\s*['"]?(?:https?:|\/\/)/i.test(svg) || /<(?:image|use)[\s>]/i.test(svg)) throw new Error('model icon ' + name + ' references external resources')
  if (/currentColor/i.test(svg)) throw new Error('model icon ' + name + ' uses currentColor, which does not inherit inside <img>; bake an explicit colour instead')
  return svg
}

/** Build the icon table that the client bundle embeds (data: URIs only). */
async function buildIconTable() {
  let manifestRaw
  try {
    manifestRaw = await readFile(new URL('manifest.json', iconsUrl), 'utf8')
  } catch (error) {
    throw new Error('assets/model-icons/manifest.json is required to embed model icons: ' + error.message)
  }
  const manifest = JSON.parse(manifestRaw)
  if (manifest === null || typeof manifest !== 'object' || !Array.isArray(manifest.icons) || manifest.icons.length === 0) throw new Error('model icon manifest must list at least one icon')
  const present = new Set((await readdir(fileURLToPath(iconsUrl))).filter((name) => name.toLowerCase().endsWith('.svg')))
  const icons = []
  const seen = new Set()
  for (const entry of manifest.icons) {
    if (entry === null || typeof entry !== 'object' || typeof entry.key !== 'string' || entry.key === '' || typeof entry.file !== 'string' || entry.file === '') throw new Error('model icon manifest entries need a key and a file')
    if (seen.has(entry.key)) throw new Error('duplicate model icon key: ' + entry.key)
    seen.add(entry.key)
    if (!present.has(entry.file)) throw new Error('model icon file is missing: ' + entry.file)
    present.delete(entry.file)
    const svg = assertSafeSvg(entry.file, await readFile(new URL(entry.file, iconsUrl), 'utf8'))
    const compact = svg.replace(/>\s+</g, '><').trim()
    icons.push({
      key: entry.key,
      label: typeof entry.label === 'string' && entry.label !== '' ? entry.label : entry.key,
      providers: Array.isArray(entry.providers) ? entry.providers.map((value) => String(value).toLowerCase()) : [],
      prefixes: Array.isArray(entry.prefixes) ? entry.prefixes.map((value) => String(value).toLowerCase()) : [],
      exact: Array.isArray(entry.exact) ? entry.exact.map((value) => String(value).toLowerCase()) : [],
      href: 'data:image/svg+xml;base64,' + Buffer.from(compact, 'utf8').toString('base64'),
    })
  }
  if (present.size > 0) throw new Error('model icon files are not referenced by the manifest: ' + Array.from(present).sort().join(', '))
  return icons
}

const rawSource = await readFile(sourceUrl, 'utf8')
if (!rawSource.includes(ICON_PLACEHOLDER)) throw new Error('src/client.js must contain the model icon placeholder: ' + ICON_PLACEHOLDER)
const iconTable = await buildIconTable()
const source = rawSource.replace(ICON_PLACEHOLDER, JSON.stringify(iconTable))
const result = await minify(source, {
  ecma: 2022,
  compress: { passes: 2 },
  mangle: true,
  format: { comments: false },
})
if (typeof result.code !== 'string' || result.code === '') throw new Error('Terser did not emit a client bundle')
await writeFile(outputUrl, result.code + '\n', 'utf8')
const sourceBytes = Buffer.byteLength(rawSource)
const outputBytes = Buffer.byteLength(result.code + '\n')
console.error('client ' + sourceBytes + ' B -> ' + outputBytes + ' B (' + Math.round(outputBytes / sourceBytes * 1000) / 10 + '%), ' + iconTable.length + ' model icons embedded')
