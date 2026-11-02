// Writes licenses.txt into the built site: every licence and notice of the
// third-party code and data it serves. The minified files keep no notices of
// their own, and most of these licences ask for them to go with the code
// (linked from the About page's credits).
//
// - Slynk's own LICENSE first.
// - The npm packages actually in the page and its workers (each chunk's
//   modules that left code in it), with their LICENSE and NOTICE files. Only
//   packages on ALLOWED, with the licence it names: a new one is a choice.
// - scripts/notices.txt, by hand: data and code inside those packages that
//   their own licence files don't mention, and the Adobe font notices read from
//   the font data itself.
// - The Go code in the WebAssembly: src/core/generated/go-licences.txt, written
//   by core/build-wasm.sh.
//
// Sorted, with no dates or local paths: the same code builds the same file.
// No new dependencies: Node's own fs and zlib.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import type { Plugin } from 'vite'

/** Every package the site may ship, and the licence its package.json must name. */
export const ALLOWED: Readonly<Record<string, string>> = {
  '@pdf-lib/standard-fonts': 'MIT',
  '@pdf-lib/upng': 'MIT',
  '@xmldom/xmldom': 'MIT',
  fflate: 'MIT',
  jsqr: 'Apache-2.0',
  'lean-qr': 'MIT',
  pako: '(MIT AND Zlib)',
  'pdf-lib': 'MIT',
  'pdfjs-dist': 'Apache-2.0',
  tslib: '0BSD',
}

const web = new URL('../', import.meta.url)
const read = (path: string) => readFileSync(new URL(path, web), 'utf8')
const LICENCE_FILE = /^(licen[cs]e|copying|notice|third-party-license)([.-].*)?$/i

/** The package a module of the bundle comes from, or '' for Slynk's own code. */
export function packageOf(id: string): string {
  const clean = id.replace(/^\0/, '').replace(/\?.*$/, '')
  if (/^vite\//.test(clean)) return 'vite' // its preload helpers
  if (/^rolldown\//.test(clean)) return 'rolldown' // its runtime helpers
  const at = clean.lastIndexOf('/node_modules/')
  if (at < 0) return ''
  const [scope, name] = clean.slice(at + '/node_modules/'.length).split('/')
  return scope.startsWith('@') ? `${scope}/${name}` : scope
}

function section(title: string, files: [string, string][]): string {
  return `\n\n==== ${title} ====\n` + files.map(([name, text]) => `\n-- ${name} --\n${text.trimEnd()}\n`).join('')
}

/** A package's licence and notice files (Vite's: only its own licence, not those of its build tools). */
function packageFiles(name: string): [string, string][] {
  const dir = new URL(`node_modules/${name}/`, web)
  const files = readdirSync(dir)
    .filter((f) => LICENCE_FILE.test(f))
    .sort()
    .map((f): [string, string] => [f, readFileSync(new URL(f, dir), 'utf8')])
  if (name === 'vite') return files.map(([f, t]) => [f, t.slice(0, t.indexOf('# Licenses of bundled dependencies'))])
  return files
}

/** Adobe's notice for the standard PDF fonts' metrics, with each font's own copyright line from its data. */
function fontNotices(): string {
  const dir = new URL('node_modules/@pdf-lib/standard-fonts/es/', web)
  const lines = readdirSync(dir)
    .filter((f) => f.endsWith('.compressed.json') && !f.startsWith('all-'))
    .sort()
    .map((f) => {
      const font = JSON.parse(inflateSync(Buffer.from(JSON.parse(readFileSync(new URL(f, dir), 'utf8')), 'base64')).toString())
      return `${f.replace('.compressed.json', '')}: ${font.Notice}`
    })
  return (
    `\n-- Adobe's font metrics, in @pdf-lib/standard-fonts --\n` +
    `The metrics of the 14 standard PDF fonts come from Adobe's Core 14 AFM files, compressed,\n` +
    `each with its copyright notice:\n${lines.join('\n')}\n\n` +
    `Adobe's notice that goes with them:\n` +
    `This file and the 14 PostScript(R) AFM files it accompanies may be used, copied, and distributed for any purpose and without charge, with or without modification, provided that all copyright notices are retained; that the AFM files are not distributed without this file; that all modifications to this file or any of the AFM files are prominently noted in the modified file(s); and that this paragraph is not modified. Adobe Systems has no responsibility or obligation to support the use of the AFM files.\n`
  )
}

/**
 * A byte-order mark first: slynk.me's web server sends .txt files without a
 * charset (it ignores AddCharset), so browsers read the file as Windows-1252
 * and garble every ’, © and name like "Altı" (seen live, 2026-10-22). With the
 * mark, every browser reads it as UTF-8, on any server.
 */
export const BOM = String.fromCharCode(0xfeff)

/** The whole file, from the packages the bundle used. */
export function licensesText(packages: Iterable<string>): string {
  const npm = [...new Set(packages)].sort()
  const go = new URL('src/core/generated/go-licences.txt', web)
  if (!existsSync(go)) throw new Error('licenses.txt: no src/core/generated/go-licences.txt (run npm run build:core)')
  return (
    BOM +
    'The licences of the code and data in this website\n\n' +
    'Slynk’s own code is under the BSD 2-Clause licence, below. Everything else keeps its own\n' +
    'licence: the libraries in the page and its workers, notices for what’s inside them, and the\n' +
    'Go code in its WebAssembly files (the mixnet engine and the password-key module).' +
    section('Slynk', [['LICENSE', readFileSync(new URL('../LICENSE', web), 'utf8')]]) +
    npm
      .map((name) => {
        const pkg = JSON.parse(read(`node_modules/${name}/package.json`))
        return section(`${name} ${pkg.version}`, packageFiles(name))
      })
      .join('') +
    `\n\n==== Notices for data and code inside them ====\n\n${read('scripts/notices.txt').trimEnd()}\n` +
    fontNotices() +
    '\n\n' +
    readFileSync(go, 'utf8')
  )
}

/**
 * Two plugins sharing what they see: one for each worker's build, and one for
 * the page's, which writes licenses.txt. Workers are built while the page is,
 * so their bundles are all seen by then; a package found only in a worker
 * (jsQR, in the scanner's) proves it.
 */
export function licences(): { page: Plugin; worker: () => Plugin } {
  const seen = new Set<string>()
  const collect: Plugin['generateBundle'] = (_options, bundle) => {
    for (const chunk of Object.values(bundle)) {
      if (chunk.type !== 'chunk') continue
      for (const [id, m] of Object.entries(chunk.modules)) {
        const name = m.renderedLength > 0 ? packageOf(id) : ''
        if (!name || name === 'vite' || name === 'rolldown') {
          if (name) seen.add(name)
          continue
        }
        const licence = JSON.parse(read(`node_modules/${name}/package.json`)).license
        if (ALLOWED[name] !== licence) {
          throw new Error(`licenses.txt: ${name} (${licence}) isn’t on scripts/licences.ts ALLOWED; check its licence first`)
        }
        seen.add(name)
      }
    }
  }
  return {
    worker: () => ({ name: 'slynk-licences-worker', apply: 'build', generateBundle: collect }),
    page: {
      name: 'slynk-licences',
      apply: 'build',
      generateBundle(options, bundle, isWrite) {
        ;(collect as (...a: unknown[]) => void).call(this, options, bundle, isWrite)
        if (!seen.has('jsqr')) throw new Error('licenses.txt: the workers’ packages weren’t seen')
        this.emitFile({ type: 'asset', fileName: 'licenses.txt', source: licensesText(seen) })
      },
    },
  }
}
