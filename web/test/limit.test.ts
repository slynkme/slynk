// The size limit: one number (MAX_PAYLOAD), the network's own cap, with every
// extra layer inside it, and the same figure wherever people read it.
// Run from the repo root: npm --prefix web test
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { MAX_PAYLOAD_SEALED, SEAL_OVERHEAD, makeShare, seal } from '../src/burn.ts'
import { PASSWORD_OVERHEAD, lock, passwordKey } from '../src/password.ts'
import { MAX_PAYLOAD } from '../src/payload.ts'
import { LIMIT_TEXT, SEND_RATE, limitFor, meter } from '../src/ui/meter.ts'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const flat = (path: string) => read(path).replace(/\s+/g, ' ')

test('the limit is the core’s own cap, exactly', () => {
  // The core refuses anything bigger than xxDK's fileMaxSize (core/transfer Upload).
  const go = read('../../third_party/xxdk-client/channelsFileTransfer/manager.go')
  const cap = go.match(/^\s*fileMaxSize\s*=\s*([\d_]+)\s*(\/\/.*)?$/m)
  assert.ok(cap, 'fileMaxSize in manager.go')
  assert.equal(MAX_PAYLOAD, Number(cap[1].replace(/_/g, '')))
  assert.equal(LIMIT_TEXT, '2 MB')
})

test('each kind of link fits its extra bytes inside the limit', () => {
  assert.equal(SEAL_OVERHEAD, 28)
  assert.equal(PASSWORD_OVERHEAD, 45)
  assert.equal(limitFor(false, false), MAX_PAYLOAD)
  assert.equal(limitFor(true, false), MAX_PAYLOAD - 28)
  assert.equal(limitFor(false, true), MAX_PAYLOAD - 45)
  assert.equal(limitFor(true, true), MAX_PAYLOAD - 73)
  assert.equal(limitFor(true, false), MAX_PAYLOAD_SEALED)
})

test('the fullest one-time link with a password uploads at exactly the limit', async () => {
  const most = limitFor(true, true)
  const { L, S } = await makeShare()
  const sealed = await seal(new Uint8Array(most), L, S)
  const pk = await passwordKey('password1', undefined, async () => new Uint8Array(32).fill(7))
  assert.equal((await lock(sealed, pk)).length, MAX_PAYLOAD)
  // Any more and the meter says so before anything is sent.
  assert.equal(meter({ wire: most, files: 1, messages: 0, varied: false, pending: false, limit: most }).over, false)
  const over = meter({ wire: most + 1, files: 1, messages: 0, varied: false, pending: false, limit: most })
  assert.equal(over.over, true)
  assert.equal(over.text, '2.00 MB: over the 2 MB limit by 1 byte')
  await assert.rejects(seal(new Uint8Array(MAX_PAYLOAD_SEALED + 1), L, S), RangeError)
})

test('the page says the same limit', () => {
  const page = flat('../index.html')
  // "2 MB in total" opens a short answer in a popup, so nothing added is lost, with the About page's
  // longer one a link away.
  assert.match(page, new RegExp(`Up to 200 files, <button class="soft-link" id="size-why-go" type="button" aria-haspopup="dialog">${LIMIT_TEXT} in total</button> after compression`))
  const popup = page.slice(page.indexOf('<dialog id="size-why"'), page.indexOf('</dialog>', page.indexOf('<dialog id="size-why"')))
  assert.match(popup, new RegExp(`<h2 id="size-why-title" tabindex="-1" autofocus>Why only ${LIMIT_TEXT}\\?</h2>`))
  assert.match(popup, new RegExp(`That keeps it private, but it’s slow: ${LIMIT_TEXT} takes about four minutes\\.`))
  assert.match(popup, /Slynk compresses what it can first, and can make photos, videos and documents smaller\./)
  assert.match(popup, /<p class="sheet-note"><a href="\/about\/#size-limit" target="_blank" rel="noopener">More on the About page<\/a><\/p>/)
  const main = read('../src/main.ts')
  // A tap on it opens the popup, and never the file picker (it's inside the drop zone's label).
  assert.match(main, /\$\(opener\)\.addEventListener\('click', \(e\) => \{\n {6}e\.preventDefault\(\)[^\n]*\n {6}if \(sheet\.open\) return\n {6}sheet\.showModal\(\)/)
  assert.match(main, /infoSheet\('size-why', 'size-why-go', 'meter-why'\)/)
  // A soft, dotted underline: more to know, not a link away.
  assert.match(read('../src/style.css'), /\.soft-link \{[^}]*text-decoration: underline dotted;/)
  assert.match(page, new RegExp(`id="meter-text">0 KB of ${LIMIT_TEXT}<`))
  // Once files are listed that line is hidden, so the meter offers the same popup when it's too large
  // (every "why" opens a popup first).
  assert.match(page, new RegExp(`<button class="soft-link meter-why" id="meter-why" type="button" aria-haspopup="dialog" hidden>Why only ${LIMIT_TEXT}\\?</button>`))
  assert.doesNotMatch(page, /(?<![\d.])1 MB\b/)
})

test('the About page says the same limit and time as the meter', () => {
  const about = flat('../about/index.html')
  assert.doesNotMatch(about, /(?<![\d.])1 MB\b/)
  assert.match(about, new RegExp(`<details id="size-limit"> <summary>Why only ${LIMIT_TEXT}\\?</summary>`))
  assert.match(about, /About 8 KB a second, so the full 2 MB takes about four minutes\./)
  assert.match(about, /about 8 KB a second, so 2 MB takes about four minutes\./)
  // The same figures as the meter's estimate (a full 2 MB took 4 min 4 s in the browser).
  assert.equal(Math.round(SEND_RATE / 1000), 8)
  assert.equal(Math.round(MAX_PAYLOAD / SEND_RATE / 60), 4)
})

test('the README says it too', () => {
  const readme = flat('../../README.md')
  assert.doesNotMatch(readme, /(?<![\d.])1 MB\b/)
  assert.match(readme, /at most 2 MB after compression/)
})
