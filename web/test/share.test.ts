// Share (ui/share.ts): a file that arrived, straight to another app through the
// device's share sheet, offered only where the browser can share that file.
// Run from the repo root: npm --prefix web test
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { SHARE, SHARE_ALL, SHARE_FAILED, SHARE_ZIP_FAILED, asFile, canShare } from '../src/ui/share.ts'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

test('the file shared has the cleaned-up name and the sender’s type', () => {
  const f = asFile({ kind: 'file', name: 'beach.jpg', type: 'image/jpeg', data: Uint8Array.from([1, 2, 3]) })
  assert.equal(f.name, 'beach.jpg')
  assert.equal(f.type, 'image/jpeg')
  assert.equal(f.size, 3)
  // A name with a hidden direction mark is shared under the same safe name Save uses.
  const odd = asFile({ kind: 'file', name: 'fdp‮.exe', type: '', data: new Uint8Array(1) })
  assert.doesNotMatch(odd.name, /‮/)
  assert.equal(odd.type, 'application/octet-stream')
})

test('no share sheet, no button: a browser without one says it can’t', () => {
  // Node has no navigator.share, like Firefox or Chrome on Linux.
  assert.equal(canShare(new File([new Uint8Array(1)], 'x.jpg', { type: 'image/jpeg' })), false)
})

test('plain words', () => {
  assert.equal(SHARE('beach.jpg'), 'Share beach.jpg')
  assert.equal(SHARE_ALL, 'Share all (.zip)')
  assert.equal(SHARE_FAILED, 'Couldn’t share it. Save it instead.')
  assert.equal(SHARE_ZIP_FAILED, 'This browser can’t share a .zip. Use Save all instead.')
})

test('Share sits beside every Save of what arrived, and in the photo viewer, hidden until the browser can', () => {
  const html = read('../index.html')
  for (const id of ['share', 'share-all', 'pv-share']) assert.match(html, new RegExp(`id="${id}" type="button" hidden>`))
  assert.match(html, /<button class="icon-btn small share-mini" type="button" data-part="share" hidden>/)
  const items = read('../src/ui/items.ts')
  assert.match(items, /const onShare = canShare\(file\) \?/)
  assert.match(items, /previewRow\(li, item, name, \{ save: \(\) => save\(item, button\), share: onShare \}\)/)
  // "Share all (.zip)" (ui/zipButtons.ts): the zip is made when the list shows and kept ready, so a
  // tap shares it with nothing awaited (Safari refused even a wait), and only if the browser takes
  // that very zip (Chrome won't).
  const zip = read('../src/ui/zipButtons.ts')
  assert.match(zip, /let zipToShare: File \| undefined/)
  assert.match(zip, /if \(!canShare\(file\)\) return void \(share\.hidden = true\)/)
  assert.match(zip, /share\.addEventListener\('click', \(\) => \{\n\s+const zip = zipToShare\n\s+if \(!zip\) return/)
  assert.match(zip, /function clear\(\) \{\n\s+files = \[\]\n\s+zipToShare = undefined\n\s+zipRun\+\+/)
  // The received screen and an inbox's collected uploads both have it, and drop the zip with what arrived.
  const main = read('../src/main.ts')
  assert.match(main, /const receivedZip = zipButtons\(/)
  assert.match(main, /receivedZip\.clear\(\)\n\s+\$\('share'\)\.hidden = true/)
  assert.match(html, /<button class="btn share-btn" type="button" data-part="share-all" hidden>/)
  const owner = read('../src/inbox/owner.ts')
  assert.match(owner, /const zip = zipButtons\(part\(el, 'save-all'\)/)
  assert.match(owner, /drop\.zip\.clear\(\) \/\/ and the zip made for sharing them/)
})
