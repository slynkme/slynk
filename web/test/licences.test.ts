// licenses.txt: every licence of the code and data the site serves, written
// by the build (scripts/licences.ts, core/build-wasm.sh), and the About page's
// and CREDITS.md's lists kept in step with it. Run: npm --prefix web test
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { ALLOWED, licensesText, packageOf } from '../scripts/licences.ts'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const flat = (path: string) => read(path).replace(/\s+/g, ' ')
const pkg = JSON.parse(read('../package.json'))

describe('which packages', () => {
  test('a module of the bundle belongs to its package, or to Slynk', () => {
    assert.equal(packageOf('/x/web/node_modules/pdf-lib/es/core/PDFContext.js'), 'pdf-lib')
    assert.equal(packageOf('/x/web/node_modules/@pdf-lib/upng/UPNG.js'), '@pdf-lib/upng')
    assert.equal(packageOf('/x/web/node_modules/pdf-lib/node_modules/tslib/tslib.es6.js'), 'tslib')
    assert.equal(packageOf('\0vite/preload-helper.js'), 'vite')
    assert.equal(packageOf('\0rolldown/runtime.js'), 'rolldown')
    assert.equal(packageOf('/x/web/src/main.ts'), '')
    assert.equal(packageOf('/x/web/src/core/generated/slynk-core.wasm?url'), '') // the Go licences cover it
  })

  test('every library Slynk depends on is allowed, under the licence its package names, all permissive', () => {
    const permissive = new Set(['MIT', 'Apache-2.0', '0BSD', '(MIT AND Zlib)', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC'])
    for (const name of Object.keys(pkg.dependencies)) assert.ok(name in ALLOWED, name)
    for (const [name, licence] of Object.entries(ALLOWED)) {
      assert.ok(permissive.has(licence), `${name}: ${licence}`)
      assert.equal(JSON.parse(read(`../node_modules/${name}/package.json`)).license, licence, name)
    }
  })
})

describe('the file', () => {
  const go = new URL('../src/core/generated/go-licences.txt', import.meta.url)

  test('Slynk’s licence, each package’s, the notices, then the Go code’s, with nothing local in it', { skip: !existsSync(go) && 'run npm --prefix web run build:core first' }, () => {
    const text = licensesText(['vite', 'rolldown', ...Object.keys(ALLOWED)])
    assert.ok(text.startsWith(String.fromCharCode(0xfeff) + 'The licences of the code and data in this website'))
    assert.ok(text.includes(read('../../LICENSE').trimEnd()))
    for (const name of [...Object.keys(ALLOWED), 'vite', 'rolldown']) assert.match(text, new RegExp(`^==== ${name.replace(/[/.]/g, '\\$&')} \\S+ ====$`, 'm'), name)
    // Vite's own licence, not those of the tools it's built with.
    assert.ok(text.includes('Copyright (c) 2019-present, VoidZero Inc. and Vite contributors'))
    assert.ok(!text.includes('# Licenses of bundled dependencies'))
    // What their own licence files don't say.
    const words = text.replace(/\s+/g, ' ')
    for (const s of ['UNICODE LICENSE V3', 'Jean-loup Gailly and Mark Adler', 'Go Cloud Development Kit', 'Arnold G. Reinhold', 'Electronic Frontier Foundation', 'Marek Palatinus', 'Cosmo Wolfe'])
      assert.ok(words.includes(s), s)
    assert.ok(text.includes('provided that all copyright notices are retained; that the AFM files are not distributed without this file'))
    assert.equal(text.match(/^(Courier|Helvetica|Times|Symbol|ZapfDingbats)[\w-]*: Copyright \(c\) [\d, ]+ Adobe Systems Incorporated\./gm)?.length, 14)
    // The Go code: the standard library, every module, and grpc's and yaml's NOTICE files (Apache-2.0 asks for them).
    assert.match(text, /^==== Go go[\d.]+: its standard library/m)
    for (const m of ['gitlab.com/elixxir/client/v4', 'gitlab.com/xx_network/crypto', 'golang.org/x/crypto', 'google.golang.org/grpc', 'github.com/sethvargo/go-diceware'])
      assert.match(text, new RegExp(`^==== ${m.replace(/[/.]/g, '\\$&')} `, 'm'), m)
    assert.match(text, /^-- NOTICE(\.txt)? --$/m)
    assert.ok(!/\/home\/|\/Users\/|\d{4}-\d\d-\d\dT\d\d:/.test(text), 'no local paths or build times')
  })

  test('the same code writes the same file', { skip: !existsSync(go) && 'run npm --prefix web run build:core first' }, () => {
    assert.equal(licensesText(['pdf-lib', 'jsqr', 'vite']), licensesText(['vite', 'jsqr', 'pdf-lib', 'jsqr']))
  })

  test('it says it’s UTF-8 itself, with a byte-order mark: the web host sends no charset for .txt', { skip: !existsSync(go) && 'run npm --prefix web run build:core first' }, () => {
    // Seen live (2026-10-22): text/plain with no charset, read as Windows-1252, every ’ and "Altı" garbled.
    const text = licensesText(['vite'])
    assert.equal(text.charCodeAt(0), 0xfeff)
    assert.equal(text.indexOf(String.fromCharCode(0xfeff), 1), -1)
    assert.equal([...Buffer.from(text, 'utf8').subarray(0, 3)].join(','), '239,187,191')
    assert.doesNotMatch(read('../public/.htaccess'), /AddCharset/)
  })
})

describe('the lists people read', () => {
  const about = flat('../about/index.html')
  const credits = about.slice(about.indexOf('<details id="credits">'), about.indexOf('</details>', about.indexOf('<details id="credits">')))

  test('the About page names every library and its licence, and links the full texts in a new tab', () => {
    for (const [name, licence] of [['lean-qr', 'MIT'], ['jsQR', 'Apache-2.0'], ['fflate', 'MIT'], ['@xmldom/xmldom', 'MIT'], ['pdf-lib', 'MIT'], ['pdf.js', 'Apache-2.0']])
      assert.match(credits, new RegExp(`${name.replace(/[/.]/g, '\\$&')} \\(${licence}`), name)
    for (const name of ['pako', 'tslib', 'Vite', 'Rolldown', 'BIP-39', 'diceware', 'Adobe', 'Unicode']) assert.ok(credits.includes(name), name)
    assert.match(credits, /<a href="\/licenses\.txt" target="_blank" rel="noopener">Every licence in full<\/a>/)
  })

  test('CREDITS.md names every package the site ships', () => {
    const md = read('../../CREDITS.md')
    for (const name of [...Object.keys(ALLOWED), 'Vite', 'Rolldown', 'go-diceware', 'grpc', 'Unicode', 'Adobe', 'licenses.txt'])
      assert.ok(md.toLowerCase().includes(name.replace('pdfjs-dist', 'pdf.js').toLowerCase()), name)
  })
})
