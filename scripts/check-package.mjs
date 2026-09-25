import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const dshCompatibility = packageJson.dsh && packageJson.dsh.compatibility
if (!packageJson.engines || packageJson.engines.node !== '>=22 <25') throw new Error('package.json must declare Node.js engines >=22 <25')
const EXPECTED_RUNTIME_RANGE = '>=0.1.1-rc.1 <0.1.5-0 || >=0.1.5-rc.1 <0.1.6-0 || >=0.1.7-rc.2 <0.1.8-0'
const REQUIRED_VERIFIED = ['0.1.7-rc.2', '0.1.5-rc.2', '0.1.5-rc.1', '0.1.1-rc.2', '0.1.1-rc.1']
if (!dshCompatibility || dshCompatibility.runtime !== EXPECTED_RUNTIME_RANGE || !Array.isArray(dshCompatibility.verified)) throw new Error('package.json must declare the verified DSH compatibility range')
const missingVerified = REQUIRED_VERIFIED.filter((version) => !dshCompatibility.verified.includes(version))
if (missingVerified.length > 0) throw new Error('package.json must list these verified DSH runtimes: ' + missingVerified.join(', '))
// A version may only be called verified when it is actually smoke-tested, so
// every verified runtime must appear in the CI matrix and carry a smoke profile.
const workflow = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8')
const smokeTest = readFileSync(join(root, 'test', 'dsh-runtime.test.js'), 'utf8')
for (const version of dshCompatibility.verified) {
  if (!workflow.includes("'" + version + "'")) throw new Error('the CI smoke matrix does not cover the verified runtime ' + version)
  if (!smokeTest.includes("'" + version + "':")) throw new Error('test/dsh-runtime.test.js has no profile for the verified runtime ' + version)
}
// The README quotes the declared range and lists the verified runtimes in both
// language sections. That drifted once already — v1.1.6 and v1.1.7 shipped a
// README still claiming `<0.1.2` while package.json had moved on — so the gate
// compares the documentation against the declaration it mirrors.
const readme = readFileSync(join(root, 'README.md'), 'utf8')
const quotedRanges = [...readme.matchAll(/DSH runtime `([^`]+)`/g)].map((match) => match[1])
if (quotedRanges.length < 2) throw new Error('README.md must quote the declared DSH runtime range in both the Chinese and the English section')
for (const range of quotedRanges) {
  if (range !== dshCompatibility.runtime) throw new Error(`README.md quotes DSH runtime "${range}" but package.json declares "${dshCompatibility.runtime}"`)
}
const undocumented = dshCompatibility.verified.filter((version) => !readme.includes(version))
if (undocumented.length > 0) throw new Error(`README.md does not mention the verified DSH runtime(s): ${undocumented.join(', ')}`)
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
  'assets/model-icons/LICENSE.upstream-lobe-icons.txt',
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
