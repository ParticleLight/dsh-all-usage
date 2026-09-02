import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const dshCompatibility = packageJson.dsh && packageJson.dsh.compatibility
if (!packageJson.engines || packageJson.engines.node !== '>=22 <25') throw new Error('package.json must declare Node.js engines >=22 <25')
if (!dshCompatibility || dshCompatibility.runtime !== '>=0.1.1-rc.1 <0.1.2' || !Array.isArray(dshCompatibility.verified) || !dshCompatibility.verified.includes('0.1.1-rc.2') || !dshCompatibility.verified.includes('0.1.1-rc.1')) throw new Error('package.json must declare the verified DSH compatibility range')
const packPath = process.argv[2]
const raw = packPath === undefined
  ? execFileSync(process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'npm', process.platform === 'win32' ? ['/d', '/s', '/c', 'npm.cmd pack --dry-run --json'] : ['pack', '--dry-run', '--json'], { cwd: root, encoding: 'utf8' })
  : readFileSync(packPath, 'utf8')
const results = JSON.parse(raw)
if (!Array.isArray(results) || results.length !== 1 || results[0] === null || typeof results[0] !== 'object') throw new Error('npm pack must return exactly one package record')
const metadata = results[0]
const expected = [
  'CHANGELOG.md',
  'LICENSE',
  'README.md',
  'assets/model-icons/claude-color.svg',
  'assets/model-icons/deepseek-color.svg',
  'assets/model-icons/doubao-color.svg',
  'assets/model-icons/gemini-color.svg',
  'assets/model-icons/grok.svg',
  'assets/model-icons/kimi-color.svg',
  'assets/model-icons/manifest.json',
  'assets/model-icons/meta-color.svg',
  'assets/model-icons/minimax-color.svg',
  'assets/model-icons/openai-color.svg',
  'assets/model-icons/qwen-color.svg',
  'assets/model-icons/zhipu-color.svg',
  'assets/screenshot-1.png',
  'assets/screenshot-2.png',
  'assets/screenshot-3.png',
  'cordis.patch.yml',
  'lib/aggregation.js',
  'lib/balance.js',
  'lib/client.js',
  'lib/http.js',
  'lib/index.js',
  'lib/ledger.js',
  'lib/plugin.js',
  'lib/pricing-runtime.js',
  'lib/pricing.js',
  'lib/session-sync.js',
  'lib/usage-core.js',
  'package.json',
  'screenshots.json',
  'fixtures/usage-events.json',
  'scripts/replay-fixture.mjs',
]
const expectedSet = new Set(expected)
const actual = metadata.files.map((entry) => String(entry.path).replaceAll('\\\\', '/')).sort()
if (new Set(actual).size !== actual.length) throw new Error('npm pack returned duplicate file paths')
const missing = expected.filter((path) => !actual.includes(path))
const unexpected = actual.filter((path) => !expectedSet.has(path))
const physicalMissing = expected.filter((path) => !existsSync(join(root, ...path.split('/'))))
if (metadata.id !== packageJson.name + '@' + packageJson.version) throw new Error('package id does not match package.json version: ' + metadata.id)
if (metadata.filename !== packageJson.name + '-' + packageJson.version + '.tgz') throw new Error('package filename does not match package.json version: ' + metadata.filename)
if (missing.length > 0 || unexpected.length > 0 || physicalMissing.length > 0) {
  throw new Error(JSON.stringify({ missing, unexpected, physicalMissing, actual }))
}
const rootLeaks = actual.filter((path) => path.startsWith('docs/') || path.startsWith('test/') || path.endsWith('.tgz'))
if (rootLeaks.length > 0) throw new Error('development files leaked into package: ' + rootLeaks.join(', '))
console.log(packageJson.name + '@' + packageJson.version + ' package content check passed (' + actual.length + ' files)')
