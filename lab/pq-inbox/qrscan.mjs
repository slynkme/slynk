// How few camera pixels per QR module jsQR needs: the decoder the site's own
// "Scan a QR code" uses (web/src/inbox/scanRead.ts), which reads the middle
// square of the camera's picture scaled down to at most 640 pixels
// (web/src/inbox/scan.ts, middleSquare). Each code is drawn at shrinking
// sizes, softened like a camera's picture (area sampling, a slight blur and
// noise), and handed to jsQR. A phone's own camera app uses other decoders and
// more pixels; this is only the in-page scanner, and only a simulation.
//
// Run from the repo root after `npm install` in web/:
//   node lab/pq-inbox/qrscan.mjs
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire(new URL('../../web/package.json', import.meta.url))
const { generate, correction } = await import(require.resolve('lean-qr'))
const jsQR = require('jsqr')

const origin = 'https://slynk.me/#'
const address = (version, len) => {
  const b = randomBytes(len)
  b[0] = version
  return b
}
const v3 = address(3, 33)
const v4 = address(4, 1217)
const codes = [
  ['v3 (today), M', origin + v3.toString('base64url'), correction.M],
  ['v4 as digits, M', origin + BigInt('0x' + v4.toString('hex')).toString(10), correction.M],
  ['v4 as base64url, M', origin + v4.toString('base64url'), correction.M],
  ['v4 as digits, L', origin + BigInt('0x' + v4.toString('hex')).toString(10), correction.L],
]

// A seeded generator, so runs repeat.
let seed = 1
const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32)

// Draws the code (with a 4-module quiet zone) at s pixels per module.
function draw(code, s, blur, noise) {
  const n = code.size + 8
  const w = Math.round(n * s)
  const grey = new Float32Array(w * w)
  const sub = 4
  for (let y = 0; y < w; y++)
    for (let x = 0; x < w; x++) {
      let dark = 0
      for (let j = 0; j < sub; j++)
        for (let i = 0; i < sub; i++) {
          const mx = Math.floor(((x + (i + 0.5) / sub) / s) - 4)
          const my = Math.floor(((y + (j + 0.5) / sub) / s) - 4)
          if (mx >= 0 && my >= 0 && mx < code.size && my < code.size && code.get(mx, my)) dark++
        }
      grey[y * w + x] = 255 * (1 - dark / (sub * sub))
    }
  // A [1 2 1]/4 blur, applied `blur` times in each direction.
  for (let b = 0; b < blur; b++) {
    const t = new Float32Array(grey)
    for (let y = 0; y < w; y++)
      for (let x = 1; x < w - 1; x++) grey[y * w + x] = (t[y * w + x - 1] + 2 * t[y * w + x] + t[y * w + x + 1]) / 4
    const u = new Float32Array(grey)
    for (let y = 1; y < w - 1; y++)
      for (let x = 0; x < w; x++) grey[y * w + x] = (u[(y - 1) * w + x] + 2 * u[y * w + x] + u[(y + 1) * w + x]) / 4
  }
  const rgba = new Uint8ClampedArray(w * w * 4)
  for (let p = 0; p < w * w; p++) {
    const v = grey[p] * 0.8 + 25 + (rand() + rand() + rand() - 1.5) * 2 * noise
    rgba[4 * p] = rgba[4 * p + 1] = rgba[4 * p + 2] = v
    rgba[4 * p + 3] = 255
  }
  return { rgba, w }
}

const reads = (code, text, s, blur, noise) => {
  for (let t = 0; t < 3; t++) {
    const { rgba, w } = draw(code, s, blur, noise)
    if (jsQR(rgba, w, w, { inversionAttempts: 'dontInvert' })?.data !== text) return false
  }
  return true
}

// The pixels per module a code needs, and how much of the scanner's 640-pixel
// square it must then fill (over 100%: it can't be read at that setting).
console.log('| code | modules | sharp | slight blur + noise | more blur + noise |')
console.log('|---|---|---|---|---|')
for (const [name, text, level] of codes) {
  const code = generate(text, { minCorrectionLevel: level, maxCorrectionLevel: level })
  const found = []
  for (const [blur, noise] of [
    [0, 0],
    [1, 8],
    [2, 12],
  ]) {
    let min = '> 6'
    for (let s = 1; s <= 6; s += 0.25)
      if (reads(code, text, s, blur, noise)) {
        min = s
        break
      }
    found.push(min)
  }
  const cell = (v) =>
    typeof v === 'number' ? `${v} px (${Math.round((100 * v * (code.size + 8)) / 640)}%)` : `${v} px`
  console.log(`| ${name} | ${code.size} | ${found.map(cell).join(' | ')} |`)
}
