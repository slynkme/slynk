// Scanning an inbox's QR code: what the scan sheet reads, and the
// promises around the camera. Codes are drawn with lean-qr, as the inbox's
// Share box draws them, and read back with the sheet's reader.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { generate, correction } from 'lean-qr'
import { INBOX_ADDRESS_VERSION, addressFromInput, inboxLink } from '../src/inbox/address.ts'
import * as copy from '../src/inbox/inboxCopy.ts'
import { toBase64url } from '../src/linkv2.ts'
import { readQr } from '../src/inbox/scanRead.ts'
import { seenOn } from './helpers/pages.ts'

const address = Uint8Array.from({ length: 33 }, (_, i) => (i === 0 ? INBOX_ADDRESS_VERSION : (i * 37 + 11) % 256))

/** text's QR code as RGBA pixels, as a camera might see a poster: a quiet zone, on a grey background. */
function picture(text: string, { scale = 6, light = 255, dark = 0, background = 128 } = {}) {
  const code = generate(text, { minCorrectionLevel: correction.M })
  const modules = code.size + 8 // with a quiet zone of 4 a side
  const width = modules * scale + 80
  const height = width
  const data = new Uint8ClampedArray(width * height * 4).fill(background)
  for (let y = 0; y < modules * scale; y++) {
    for (let x = 0; x < modules * scale; x++) {
      const mx = Math.floor(x / scale) - 4
      const my = Math.floor(y / scale) - 4
      const on = mx >= 0 && my >= 0 && mx < code.size && my < code.size && code.get(mx, my)
      const v = on ? dark : light
      const i = ((y + 40) * width + x + 40) * 4
      data[i] = data[i + 1] = data[i + 2] = v
    }
  }
  for (let i = 3; i < data.length; i += 4) data[i] = 255
  return { data, width, height }
}

const read = (text: string, opts?: Parameters<typeof picture>[1], invert = false) => {
  const p = picture(text, opts)
  return readQr(p.data, p.width, p.height, invert)
}

const src = fileURLToPath(new URL('../src/', import.meta.url))
function sources(dir = src): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'generated' ? [] : sources(path)
    return /\.ts$/.test(name) ? [path] : []
  })
}
const using = (pattern: RegExp) => sources().filter((f) => pattern.test(readFileSync(f, 'utf8'))).map((f) => relative(src, f))

describe('scanning an inbox’s QR code', () => {
  test('an inbox’s code, as the Share box draws it, reads back as its address', () => {
    const link = inboxLink('https://slynk.me', address)
    const text = read(link)
    assert.equal(text, link)
    assert.deepEqual(addressFromInput(text!), address)
  })

  test('a code holding just the address, or another copy of Slynk’s link, works as pasting it does', () => {
    assert.deepEqual(addressFromInput(read(toBase64url(address))!), address)
    assert.deepEqual(addressFromInput(read(inboxLink('https://slynk.example', address))!), address)
  })

  test('anything else is read but isn’t an inbox’s address', () => {
    for (const other of ['https://slynk.me/#' + 'A'.repeat(244), 'https://example.com/', 'hello']) {
      assert.equal(read(other), other)
      assert.equal(addressFromInput(other), undefined)
    }
  })

  test('a picture without a code holds nothing', () => {
    const width = 320
    const data = new Uint8ClampedArray(width * width * 4).fill(200)
    assert.equal(readQr(data, width, width), undefined)
  })

  test('a photo of a light-on-dark code is read too; camera frames are read as dark on light only', () => {
    const link = inboxLink('https://slynk.me', address)
    const inverted = { light: 0, dark: 255, background: 60 }
    assert.equal(read(link, inverted, true), link)
    assert.equal(read(link, inverted, false), undefined)
  })

  test('the wording', () => {
    assert.equal(copy.SCAN_LABEL, 'Scan a QR code')
    assert.equal(copy.SCAN_PHOTO, 'Use a photo instead')
    assert.match(copy.SCAN_NOT_INBOX, /isn’t an inbox’s address/)
    assert.equal(copy.SCAN_FOUND, 'Inbox found.')
    for (const s of [copy.SCAN_REFUSED, copy.SCAN_NO_CAMERA, copy.SCAN_CAMERA_FAILED]) assert.match(s, /Use a photo instead/)
    assert.match(copy.SCAN_BROKEN, /Paste the address instead/)
    assert.match(copy.SCAN_FAILED, /Paste the address instead/)
    assert.match(copy.SCAN_PHOTO_BIG, /Try a screenshot/)
  })
})

describe('the camera’s promises', () => {
  test('only this site’s own page may use the camera (and keep the screen on); the microphone and the rest stay off', () => {
    const htaccess = readFileSync(new URL('../public/.htaccess', import.meta.url), 'utf8')
    const policy = htaccess.match(/^Header always set Permissions-Policy "([^"]+)"$/m)?.[1]
    assert.ok(policy)
    const rules = policy.split(', ')
    assert.ok(rules.includes('camera=(self)'))
    assert.ok(rules.includes('microphone=()'))
    assert.deepEqual(
      rules.filter((r) => !r.endsWith('=()')),
      ['camera=(self)', 'screen-wake-lock=(self)'],
    )
  })

  test('only the progress screen’s helper keeps the screen on', () => {
    assert.deepEqual(using(/wakeLock\.request/), ['ui/wakeLock.ts'])
  })

  test('only the scan sheet asks for the camera', () => {
    assert.deepEqual(using(/getUserMedia|enumerateDevices/), ['inbox/scan.ts'])
  })

  test('jsQR stays in the sheet’s worker, out of the page’s own code', () => {
    assert.deepEqual(using(/from 'jsqr'|import\('jsqr'\)/), ['inbox/scanRead.ts'])
    // The page may import its types; only the worker loads the code.
    assert.deepEqual(using(/^import (?!type )[^\n]*from '\.\/scanRead(\.ts)?'/m), ['inbox/scanWorker.ts'])
    assert.match(readFileSync(join(src, 'inbox/scan.ts'), 'utf8'), /new Worker\(new URL\('\.\/scanWorker\.ts', import\.meta\.url\), \{ type: 'module' \}\)/)
  })

  test('the camera stops with the sheet: every track, when it closes, a code is read or the page is out of sight', () => {
    const scan = readFileSync(join(src, 'inbox/scan.ts'), 'utf8')
    assert.match(scan, /for \(const track of s\.stream\?\.getTracks\(\) \?\? \[\]\) track\.stop\(\)/)
    assert.match(scan, /addEventListener\('close', \(\) => d\.open \|\| end\(\)\)/)
    assert.match(scan, /visibilityState === 'hidden' && !current\?\.photo\) closeScan\(\)/)
    assert.match(scan, /closeScan\(\)\n\s+go\(\)/)
    // An inbox's code: the camera goes off before "Inbox found" shows, not when the sheet goes on.
    assert.match(scan, /if \(go\) \{\n\s+s\.done = true\n\s+stopCamera\(s\)\n\s+show\('found'\)/)
    // A camera that answers after the sheet closed, switched to a photo or broke is stopped at once.
    assert.match(scan, /if \(s\.closed \|\| s\.photo \|\| s\.broken\) \{\n\s+for \(const track of stream\.getTracks\(\)\) track\.stop\(\)/)
    assert.match(readFileSync(join(src, 'inbox/owner.ts'), 'utf8'), /closeRemember\(false\)\n\s+closeSaveFile\(false\)\n\s+closeBlocked\(false\)\n\s+closeScan\(\)/, 'Lock closes it too')
  })

  test('the reader says when it’s ready, and one that doesn’t start is tried once more before the sheet gives up (seen on an iPhone)', () => {
    const scan = readFileSync(new URL('../src/inbox/scan.ts', import.meta.url), 'utf8')
    const worker = readFileSync(new URL('../src/inbox/scanWorker.ts', import.meta.url), 'utf8')
    assert.match(worker, /\nscope\.postMessage\(SCAN_READY\)\n$/)
    assert.match(scan, /for \(let tries = 0; tries < 2; tries\+\+\) \{\n {6}if \(tries\) await new Promise\(\(r\) => setTimeout\(r, START_RETRY_MS\)\)/)
    // No picture goes to a reader before it's ready, so none is lost to one that didn't start.
    assert.match(scan, /const worker = await startWorker\(s\)\n {2}if \(s\.closed \|\| s\.broken\) return undefined\n {2}if \(!worker\) \{/)
    assert.match(scan, /if \(!\('ready' in e\.data\)\) return/)
    // A reader that fails later is replaced on the next read, but not forever.
    assert.match(scan, /if \(\+\+s\.crashes >= 2 && !s\.closed\) broken\(s, s\.words\.failed\)/)
  })

  test('on an iPhone or iPad the frame is smaller, and the hint says to move back', () => {
    const scan = readFileSync(new URL('../src/inbox/scan.ts', import.meta.url), 'utf8')
    const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8')
    assert.match(scan, /const IOS = \/iPhone\|iPad\|iPod\/\.test\(navigator\.userAgent\) \|\| \(\/Macintosh\/\.test\(navigator\.userAgent\) && navigator\.maxTouchPoints > 1\)/)
    assert.match(scan, /view\.classList\.toggle\('ios', IOS\)/)
    assert.match(css, /\.scan-view::after \{\n {2}content: '';\n {2}position: absolute;\n {2}inset: 7%;/)
    assert.match(css, /\.scan-view\.ios::after \{\n {2}inset: 25%;\n\}/)
    assert.match(scan, /IOS \? copy\.SCAN_HARD_IOS : copy\.SCAN_HARD/)
    assert.match(copy.SCAN_HARD_IOS, /move back a little until it’s sharp, or use a photo instead\.$/)
  })

  test('the QR library is part of the page, so the first code after loading draws as the later ones do (seen on an iPhone)', () => {
    const qr = readFileSync(new URL('../src/inbox/qr.ts', import.meta.url), 'utf8')
    assert.match(qr, /^import \{ correction, generate \} from 'lean-qr'$/m)
    assert.match(qr, /^import \{ toSvg, toSvgSource \} from 'lean-qr\/extras\/svg'$/m)
    const src = fileURLToPath(new URL('../src', import.meta.url))
    const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]))
    for (const f of files(src).filter((f) => f.endsWith('.ts'))) assert.ok(!/import\(['"`]lean-qr/.test(readFileSync(f, 'utf8')), relative(src, f))
  })

  test('a photo too large for a phone isn’t opened, by the composer’s own limit', () => {
    const scan = readFileSync(join(src, 'inbox/scan.ts'), 'utf8')
    assert.match(scan, /dims\.width \* dims\.height > MAX_PIXELS\) return say\(copy\.SCAN_PHOTO_BIG, true\)\n\s+bitmap = await createImageBitmap\(file\)/)
  })

  test('writing to an inbox from New message lands on the card, not the top of the page', () => {
    const main = readFileSync(join(src, 'main.ts'), 'utf8')
    assert.match(main, /writeTo: \(address\) => \{\n\s+void addressTo\(address\)\n\s+landOnCard\(\)/)
    assert.match(main, /\$\('card'\)\.scrollIntoView\(\{ block: 'start'/)
  })

  test('Send while typing on a phone: the progress comes into sight once the keyboard has closed', () => {
    const main = readFileSync(join(src, 'main.ts'), 'utf8')
    // Only on a real change of view, so a redraw never closes the keyboard mid-sentence.
    assert.match(main, /const keyboard = next !== view && typing && \$\('card'\)\.contains\(document\.activeElement\) && matchMedia\('\(pointer: coarse\)'\)\.matches/)
    assert.match(main, /if \(keyboard\) afterKeyboard\(\(\) => reveal\(\$\('card'\), false, true\)\)/)
  })

  test('the About page says what happens to the picture', () => {
    const about = seenOn(readFileSync(new URL('../about/index.html', import.meta.url), 'utf8')).replace(/\s+/g, ' ')
    assert.match(about, /<details id="inbox-scan"> <summary>Can I scan an inbox’s QR code\?<\/summary>/)
    assert.match(about, /The camera’s picture stays in your browser: the page reads the code right there, and nothing is recorded, saved or sent anywhere\./)
    assert.match(about, /The camera turns off as soon as it reads the code, you close it, or the page goes out of sight/)
    assert.match(about, /may offer to remember your answer for slynk\.me; if you let it, that stays in your browser’s site settings, where you can remove it\./)
  })
})
