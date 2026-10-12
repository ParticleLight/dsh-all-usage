#!/usr/bin/env node
// Reports code that nothing can reach: exported host symbols no other file
// mentions, client helpers that are declared but never called, and stylesheet
// classes whose markup no longer exists (checked against dynamic concatenation,
// which is why a class is only reported when its stem is unused too).
//
// Usage: node scripts/dead-code.mjs [--json]
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

const asJson = process.argv.includes('--json')
const libFiles = (await readdir('lib')).filter((name) => name.endsWith('.js'))
const sources = []
for (const name of libFiles) sources.push({ path: 'lib/' + name, text: await readFile(join('lib', name), 'utf8') })
for (const name of await readdir('test')) if (name.endsWith('.js')) sources.push({ path: 'test/' + name, text: await readFile(join('test', name), 'utf8') })
for (const name of await readdir('scripts')) sources.push({ path: 'scripts/' + name, text: await readFile(join('scripts', name), 'utf8') })
for (const name of await readdir('bench')) sources.push({ path: 'bench/' + name, text: await readFile(join('bench', name), 'utf8') })
const clientPath = 'src/client.js'
sources.push({ path: clientPath, text: await readFile(clientPath, 'utf8') })
const client = sources.find((item) => item.path === clientPath).text

// 1) Exported host symbols nothing else references.
const unusedExports = []
for (const item of sources.filter((entry) => entry.path.startsWith('lib/'))) {
  if (item.path === 'lib/client.js' || item.path === 'lib/index.js') continue
  const names = new Set()
  for (const match of item.text.matchAll(/export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(match[1])
  for (const match of item.text.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const piece of match[1].split(',')) {
      const name = piece.trim().split(/\s+as\s+/)[0]
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name)
    }
  }
  for (const name of names) {
    // A symbol used inside its own file and exported for tests still counts as used.
    const others = sources.filter((other) => other.path !== item.path)
    if (!others.some((other) => new RegExp('\\b' + name + '\\b').test(other.text))) unusedExports.push(item.path + ' -> ' + name)
  }
}

// 2) Client helpers declared but never called (their own declaration is the only hit).
const unusedHelpers = []
for (const match of client.matchAll(/^\s{4}(?:function|const)\s+([A-Za-z_$][\w$]*)/gm)) {
  const name = match[1]
  if (client.split(new RegExp('\\b' + name + '\\b')).length - 1 <= 1) unusedHelpers.push(name)
}

// 3) Stylesheet classes no markup can render.
const cssAt = client.indexOf('const CSS = ')
const cssTagAt = client.indexOf('const cssTagId')
const firstTick = client.indexOf(String.fromCharCode(96), cssAt)
const lastTick = client.lastIndexOf(String.fromCharCode(96), cssTagAt)
const css = client.slice(firstTick, lastTick)
const outside = client.slice(0, firstTick) + client.slice(lastTick)
const orphanedCss = []
for (const name of new Set(Array.from(css.matchAll(/\.(uh-[\w-]+)/g)).map((item) => item[1]))) {
  if (outside.split(name).length - 1 > 0) continue
  const stem = name.slice(0, name.lastIndexOf('-'))
  if (stem !== '' && outside.split(stem + '-').length - 1 > 0) continue
  orphanedCss.push(name)
}

// 4) Markers that usually mean unfinished work.
const markers = []
for (const item of sources) {
  for (const match of item.text.matchAll(/TODO|FIXME|XXX|HACK/g)) markers.push(item.path + ':' + (item.text.slice(0, match.index).split('\n').length))
}

const report = { unusedExports, unusedHelpers, orphanedCss, markers: markers.slice(0, 20) }
if (asJson) console.log(JSON.stringify(report, null, 1))
else {
  const line = (label, values) => console.log('  ' + label.padEnd(20) + (values.length === 0 ? 'none' : values.length + (values.length <= 8 ? ': ' + values.join(', ') : '')))
  console.log('dead code report')
  line('unused exports', report.unusedExports)
  line('unused helpers', report.unusedHelpers)
  line('orphaned CSS', report.orphanedCss)
  line('markers', report.markers)
}
