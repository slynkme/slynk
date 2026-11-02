// "Save QR code" on the sent screen: a link's code saved as a picture only when the sender asks,
// with a note on what that picture is (index.html, main.ts, inbox/qr.ts qrPngFile).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const page = read('../index.html').replace(/\s+/g, ' ')
const main = read('../src/main.ts')
const qr = read('../src/inbox/qr.ts')

test('the button sits in the QR box, drawn only on request, with its note', () => {
  const box = page.slice(page.indexOf('<div class="qr-box" id="qr-box" hidden>'), page.indexOf('<div class="sent-pw" id="sent-pw" hidden>'))
  assert.match(box, /<button class="btn small center" id="save-qr" type="button">Save QR code<\/button>/)
  assert.match(box, /A saved code is the link itself: anyone who sees the picture can open it, and phones may copy pictures to the cloud\. Delete it once it’s done its job\./)
})

test('it saves a PNG of the link shown, named by the site, and says so if it can’t', () => {
  assert.match(main, /saveBlob\(await qrPngFile\(link\), `\$\{FILE_PREFIX\}-link-qr\.png`\)/)
  assert.match(main, /toast\(`Couldn’t save the QR code: \$\{errorText\(e\)\}`\)/)
})

test('the PNG: black on white, a four-module quiet zone, whole pixels a module, about 1,024 a side', () => {
  assert.match(qr, /export async function qrPngFile\(text: string\): Promise<Blob>/)
  assert.match(qr, /const pad = 4/)
  assert.match(qr, /const scale = Math\.max\(1, Math\.floor\(1024 \/ side\)\)/)
  assert.match(qr, /g\.fillStyle = '#fff'/)
  assert.match(qr, /'image\/png'/)
})
