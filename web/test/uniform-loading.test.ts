// Every visit fetches the same files (since
// 2026-10-19; docs/findings/decisions.md and src/preload.ts): a web host's visit logs record
// which files a visit fetched (slynk.me's keeps none, but a fork's host may),
// and the sizes of what a visit fetches show to anyone watching, so code
// loaded only when it's needed would show what someone did. This fails when code that loads on demand (a
// dynamic import, a worker, a WebAssembly file) is added without also being
// fetched at the start for everyone.
// Run from the repo root: npm --prefix web test
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('../src/', import.meta.url))

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? (f === 'generated' ? [] : files(p)) : /\.ts$/.test(f) ? [p] : []
  })
}

/** The code without comments, so a comment mentioning import() doesn't count. */
const code = (p: string) =>
  readFileSync(p, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1')

const sources = files(SRC).map((p) => ({ path: relative(SRC, p), text: code(p) }))
const preload = code(join(SRC, 'preload.ts'))
const everyFormat = /function loadEveryFormat[\s\S]*?\n}/.exec(code(join(SRC, 'strip/formats.ts')))?.[0] ?? ''

test('every dynamic import is loaded at the start too', () => {
  for (const { path, text } of sources) {
    for (const m of text.matchAll(/\bimport\(\s*'([^']+)'\s*\)/g)) {
      const target = m[1]
      const ok = path.startsWith('strip/')
        ? everyFormat.includes(`import('${target}')`)
        : (path === 'zip.ts' && target === 'fflate' && /export function warmZip[\s\S]*?import\('fflate'\)/.test(text) && preload.includes('warmZip()')) ||
          (path === 'ui/pdfView.ts' && target === 'pdfjs-dist' && /export function warmPdf[\s\S]*?import\('pdfjs-dist'\)/.test(text) && preload.includes('warmPdf()'))
      assert.ok(ok, `${path} loads ${target} only when needed: load it at the start too (src/preload.ts, or loadEveryFormat in strip/formats.ts)`)
    }
  }
})

test('every worker is started or fetched at the start', () => {
  for (const { path, text } of sources) {
    for (const m of text.matchAll(/new Worker\(\s*new URL\(\s*'([^']+)'/g)) {
      const worker = join(path, '..', m[1]).replace(/\\/g, '/')
      const ok =
        worker === 'core/worker.ts' // the mixnet core: started as the page loads (main.ts, new Core())
          ? /^let core = new Core\(\)/m.test(code(join(SRC, 'main.ts')))
          : worker === 'strip/stripWorker.ts'
            ? preload.includes('startCleaner()')
            : preload.includes(`'./${worker}?worker&url'`)
      assert.ok(ok, `${path} starts ${worker} only when needed: fetch it in src/preload.ts`)
    }
  }
})

test('every WebAssembly file is fetched at the start', () => {
  for (const { path, text } of sources) {
    for (const m of text.matchAll(/from '([^']+\.wasm)\?url'/g)) {
      const wasm = join(path, '..', m[1]).replace(/\\/g, '/')
      const ok = path === 'core/worker.ts' || path === 'preload.ts' || preload.includes(`'./${wasm}?url'`)
      assert.ok(ok, `${path} fetches ${wasm} only when needed: fetch it in src/preload.ts`)
    }
  }
})

test('the page runs the preload, after it loads and the engine is in (or two minutes)', () => {
  const main = code(join(SRC, 'main.ts'))
  assert.match(main, /import \{ preloadEverything \} from '\.\/preload'/)
  assert.match(main, /core\.ready\(\)\.catch\(\(\) => \{\}\)/)
  assert.match(main, /pageLoaded\.then\(\(\) => engineIn\)\.then\(preloadEverything\)/)
})

test('the strip worker loads every format as it starts, and every format is in the list', () => {
  assert.match(code(join(SRC, 'strip/stripWorker.ts')), /^loadEveryFormat\(\)/m)
  const formats = code(join(SRC, 'strip/formats.ts'))
  for (const m of formats.matchAll(/return import\('([^']+)'\)/g)) assert.ok(everyFormat.includes(`import('${m[1]}')`), m[1])
})

test('pdf.js (PDF previews) is fetched for every visitor: its code and its worker', () => {
  assert.match(preload, /warmPdf\(\)\.catch/)
  assert.match(preload, /export const FETCHED = \[[^\]]*PDF_WORKER_URL\]/)
  const pdf = code(join(SRC, 'ui/pdfView.ts'))
  assert.match(pdf, /import pdfWorkerUrl from '\.\/pdfWorker\.ts\?worker&url'/)
  assert.match(code(join(SRC, 'ui/pdfWorker.ts')), /import 'pdfjs-dist\/build\/pdf\.worker\.min\.mjs'/)
  // Nothing fetched on demand: no fonts, character maps, colour profiles or WebAssembly.
  assert.match(pdf, /useWasm: false,\n\s+useWorkerFetch: false,/)
  assert.doesNotMatch(pdf, /cMapUrl|standardFontDataUrl|wasmUrl|iccUrl/)
})
