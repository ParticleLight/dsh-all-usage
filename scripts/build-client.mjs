import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { minify } from 'terser'

const sourceUrl = new URL('../src/client.js', import.meta.url)
const outputUrl = new URL('../lib/client.js', import.meta.url)
const source = await readFile(sourceUrl, 'utf8')
const result = await minify(source, {
  ecma: 2022,
  compress: { passes: 2 },
  mangle: true,
  format: { comments: false },
})
if (typeof result.code !== 'string' || result.code === '') throw new Error('Terser did not emit a client bundle')
await writeFile(outputUrl, result.code + '\n', 'utf8')
const sourceBytes = Buffer.byteLength(source)
const outputBytes = Buffer.byteLength(result.code + '\n')
console.error('client ' + sourceBytes + ' B -> ' + outputBytes + ' B (' + Math.round(outputBytes / sourceBytes * 1000) / 10 + '%)')
