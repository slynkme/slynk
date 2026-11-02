// Makes web/src/pow/rounds.ts: the SHA-256 rounds the puzzle repeats for
// every try (web/src/pow/puzzle.ts), written out in full, with the message
// schedule in local variables and the round constants inline, so everything
// can stay in the processor's registers. In Chrome, the same rounds as a loop
// over arrays ran about 3 times slower (0.95 against 3.2 million tries a
// second on a 2020 desktop, 2026-10-20; in Node, 2.9 against 4.3).
//
//   node scripts/pow-rounds.mjs
//
// burn-puzzle.test.ts checks that rounds.ts is what this makes, and that its
// hashes are SHA-256's.
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const OUT = new URL('../src/pow/rounds.ts', import.meta.url)

// SHA-256's round constants (FIPS 180-4, 4.2.2).
const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
  0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
  0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]

const rotr = (v, n) => `((${v} >>> ${n}) | (${v} << ${32 - n}))`

/** The source of rounds.ts. */
export function source() {
  const words = Array.from({ length: 16 }, (_, i) => i)
  const out = []
  out.push(
    '// Made by web/scripts/pow-rounds.mjs (see there for why it is written out): do not edit by hand.',
    '',
    '/**',
    ' * Rounds 8 to 63 of SHA-256 over the puzzle’s one block (puzzle.ts), for',
    ' * `count` tries of the nonce’s low word from `lo`, its high word `hi`. m holds',
    ' * the block’s 16 words (8 and 9, the nonce, are set here), s the state after',
    ' * rounds 0 to 7, which only involve the label and the ID. Returns the first',
    ' * low word whose hash starts with `bits` zero bits (1 to 32), or -1. Only the',
    ' * hash’s first word is worked out. The round constants are SHA-256’s, as',
    ' * signed 32-bit numbers, so the sums stay whole 32-bit numbers.',
    ' */',
    'export function tries(m: Int32Array, s: Int32Array, hi: number, lo: number, count: number, bits: number): number {',
    '  const shift = 32 - bits',
    `  ${words.filter((i) => i !== 8 && i !== 9).map((i) => `const m${i} = m[${i}] | 0`).join('\n  ')}`,
    `  ${['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((v, i) => `const ${v}0 = s[${i}] | 0`).join('\n  ')}`,
    '  const end = lo + count',
    '  for (let n = lo; n < end; n++) {',
    `    ${words.map((i) => `let w${i} = ${i === 8 ? 'hi | 0' : i === 9 ? 'n | 0' : `m${i}`}`).join('\n    ')}`,
    '    let a = a0, b = b0, c = c0, d = d0, e = e0, f = f0, g = g0, h = h0',
    '    let t1 = 0, t2 = 0, x = 0, y = 0',
  )
  for (let i = 8; i < 64; i++) {
    const j = i % 16
    if (i >= 16) {
      out.push(
        `    x = w${(i - 15) % 16}`,
        `    y = w${(i - 2) % 16}`,
        `    w${j} = (${rotr('y', 17)} ^ ${rotr('y', 19)} ^ (y >>> 10)) + w${(i - 7) % 16} + (${rotr('x', 7)} ^ ${rotr('x', 18)} ^ (x >>> 3)) + w${j} | 0`,
      )
    }
    out.push(
      `    t1 = h + (${rotr('e', 6)} ^ ${rotr('e', 11)} ^ ${rotr('e', 25)}) + ((e & f) ^ (~e & g)) + ${K[i] | 0} + w${j} | 0`,
      `    t2 = (${rotr('a', 2)} ^ ${rotr('a', 13)} ^ ${rotr('a', 22)}) + ((a & b) ^ (a & c) ^ (b & c)) | 0`,
      '    h = g',
      '    g = f',
      '    f = e',
      '    e = d + t1 | 0',
      '    d = c',
      '    c = b',
      '    b = a',
      '    a = t1 + t2 | 0',
    )
  }
  out.push(
    '    if ((0x6a09e667 + a | 0) >>> shift === 0) return n // the hash’s first word: the initial value plus a',
    '  }',
    '  return -1',
    '}',
    '',
  )
  return out.join('\n')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(OUT, source())
  console.log(`wrote ${fileURLToPath(OUT)}`)
}
