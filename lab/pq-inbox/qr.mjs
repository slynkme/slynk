// How big an inbox address's QR code gets, with the site's own QR library
// (lean-qr, as web/src/inbox/qr.ts uses it: auto mode, at least correction
// level M), for each address size, written two ways: base64url (today's
// links) and as decimal digits, which QR codes store more compactly.
// Also writes qr-sheet.html, a page to print and scan with a phone.
//
// Run from the repo root after `npm install` in web/:
//   node lab/pq-inbox/qr.mjs
import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(new URL('../../web/package.json', import.meta.url))
const { generate, correction } = await import(require.resolve('lean-qr'))
const { toSvgSource } = await import(require.resolve('lean-qr/extras/svg'))

const origin = 'https://slynk.me/#'
const b64url = (b) => Buffer.from(b).toString('base64url')
// The address as one big number, in decimal: its first byte is never 0.
const decimal = (b) => BigInt('0x' + Buffer.from(b).toString('hex')).toString(10)

const addresses = [
  ['v3 (today)', 3, 33],
  ['ML-KEM-512 + ed25519', 4, 1 + 32 + 800],
  ['v4: X-Wing + ed25519', 4, 1217],
  ['v4 as built (signed)', 4, 1281],
  ['ML-KEM-1024 + ed25519', 4, 1 + 32 + 1568],
]

const rows = []
const sheet = []
for (const [name, version, len] of addresses) {
  const b = randomBytes(len)
  b[0] = version
  for (const [how, text] of [
    ['base64url', origin + b64url(b)],
    ['digits', origin + decimal(b)],
  ]) {
    for (const [level, min] of [
      ['M', correction.M],
      ['L', correction.L],
    ]) {
      let code
      try {
        code = generate(text, { minCorrectionLevel: min, maxCorrectionLevel: min })
      } catch {
        rows.push({ name, how, level, chars: text.length, version: 'too big', modules: '' })
        continue
      }
      const modules = code.size
      const qrVersion = (modules - 17) / 4
      rows.push({ name, how, level, chars: text.length, version: qrVersion, modules })
      if (level === 'M' && (how === 'base64url' || name.startsWith('v4'))) sheet.push({ name, how, code })
    }
  }
}

console.log('| address | written as | correction | link characters | QR version | modules per side |')
console.log('|---|---|---|---|---|---|')
for (const r of rows) console.log(`| ${r.name} | ${r.how} | ${r.level} | ${r.chars} | ${r.version} | ${r.modules} |`)

// Module size when printed, with the 4-module quiet zone around it.
console.log('\nModule size in mm when the whole code (with its quiet zone) is printed this wide:')
console.log('| modules | 5 cm | 10 cm | 20 cm | 30 cm |')
console.log('|---|---|---|---|---|')
for (const m of [...new Set(rows.filter((r) => r.modules).map((r) => r.modules))].sort((a, b) => a - b)) {
  const mm = (cm) => ((cm * 10) / (m + 8)).toFixed(2)
  console.log(`| ${m} | ${mm(5)} | ${mm(10)} | ${mm(20)} | ${mm(30)} |`)
}

// A printable sheet: each code at 5, 8 and 12 cm, black on white.
const cells = []
for (const { name, how, code } of sheet) {
  const svg = toSvgSource(code, { on: '#000', off: '#fff', pad: 4, width: 600, height: 600 })
  for (const cm of [5, 8, 12]) {
    cells.push(
      `<figure><div class="c${cm}">${svg}</div><figcaption>${name}, ${how}, ${code.size} modules, ${cm} cm</figcaption></figure>`,
    )
  }
}
writeFileSync(
  new URL('qr-sheet.html', import.meta.url),
  `<!doctype html><meta charset="utf-8"><title>QR test sheet</title>
<style>
body { font: 11px sans-serif; background: #fff; color: #000; margin: 1cm }
figure { display: inline-block; margin: 0 0.6cm 0.6cm 0; vertical-align: top; break-inside: avoid }
figure svg { width: 100%; height: 100% }
.c5 { width: 5cm; height: 5cm } .c8 { width: 8cm; height: 8cm } .c12 { width: 12cm; height: 12cm }
</style>
<p>Inbox address QR codes at their printed sizes (print at 100%, no scaling). The addresses are random
test bytes: scanning shows a slynk.me link that leads nowhere useful; there's no need to open it.</p>
${cells.join('\n')}
`,
)
console.log('\nWrote lab/pq-inbox/qr-sheet.html')
