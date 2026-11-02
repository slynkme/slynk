// The small puzzle (proof of work) slynk.me asks of every new link, so a
// script can't make links as fast as it likes (core/keyserver's protocol.go
// has the background). Hashcash with SHA-256: find a nonce such that
//
//   SHA-256(LABEL || id || window || nonce)
//
// starts with at least `bits` zero bits. id is the share's 16-byte ID, window
// the number of WINDOW_S-second spans since 1970 (4 bytes, big-endian) and
// nonce 8 bytes. That's 40 bytes, one SHA-256 block, so each try is one block,
// and the key server checks a solution with a single hash. It takes 2^bits tries on
// average, whoever solves it: about a second on a mid-range phone at slynk.me's
// setting, far less on a computer. It stops lazy scripts, not a determined
// attacker.
//
// Pure functions, no state: the page runs them in a worker (index.ts), the
// tests directly. SHA-256 is written out here (and in rounds.ts) because
// WebCrypto's is asynchronous, which costs far more per try than the hash
// itself.
import { tries } from './rounds.ts'

/** Fixed and versioned (the key server's PowLabel): changing it needs a new key server. */
export const LABEL = 'slynk/v1/pow'
/** Seconds per window (the key server's PowWindow), which accepts the current window and the one before. */
export const WINDOW_S = 600
export const ID_BYTES = 16
export const NONCE_BYTES = 8
/** The most the page will try (2^32 tries for one window, minutes on a phone): a mistake on slynk.me can't make it spin for ever. */
export const MAX_BITS = 28

const K = new Int32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
  0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
  0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])
const IV = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
const MESSAGE_BYTES = LABEL.length + ID_BYTES + 4 + NONCE_BYTES

/** The window a time falls in, from epoch milliseconds. */
export function windowAt(ms: number): number {
  return Math.floor(ms / 1000 / WINDOW_S)
}

/** The 40 bytes that are hashed. */
export function message(id: Uint8Array, window: number, nonce: Uint8Array): Uint8Array {
  check(id, window, 0)
  if (!(nonce instanceof Uint8Array) || nonce.length !== NONCE_BYTES) throw new TypeError(`nonce must be ${NONCE_BYTES} bytes`)
  const m = new Uint8Array(MESSAGE_BYTES)
  m.set(new TextEncoder().encode(LABEL))
  m.set(id, LABEL.length)
  new DataView(m.buffer).setUint32(LABEL.length + ID_BYTES, window)
  m.set(nonce, LABEL.length + ID_BYTES + 4)
  return m
}

/** The nonce for a try's number: big-endian, 8 bytes. */
export function nonceBytes(n: number): Uint8Array {
  const b = new Uint8Array(NONCE_BYTES)
  const v = new DataView(b.buffer)
  v.setUint32(0, Math.floor(n / 2 ** 32))
  v.setUint32(4, n >>> 0)
  return b
}

/** How many zero bits a hash starts with. */
export function leadingZeroBits(hash: Uint8Array): number {
  let n = 0
  for (const byte of hash) {
    if (byte === 0) {
      n += 8
      continue
    }
    return n + Math.clz32(byte) - 24
  }
  return n
}

/**
 * Tries `count` nonces from try number `from` on, and returns the first try
 * number that solves it, or -1. Each try is one SHA-256 block. Its first 8
 * rounds use only the label and the ID, so they're done here once; the rest
 * are written out in rounds.ts.
 */
export function search(id: Uint8Array, window: number, bits: number, from: number, count: number): number {
  check(id, window, bits)
  if (bits === 0) return from
  const m = new Int32Array(16)
  const bytes = new DataView(message(id, window, new Uint8Array(NONCE_BYTES)).buffer)
  for (let i = 0; i < 10; i++) m[i] = bytes.getInt32(i * 4)
  m[10] = 0x80000000 | 0 // padding: a 1 bit, zeros, then the length in bits
  m[15] = MESSAGE_BYTES * 8
  const s = new Int32Array(IV)
  for (let i = 0; i < 8; i++) {
    const [a, b, c, d, e, f, g, h] = s
    const t1 = (h + (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) + ((e & f) ^ (~e & g)) + K[i] + m[i]) | 0
    const t2 = ((((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) + ((a & b) ^ (a & c) ^ (b & c))) | 0
    s.set([t1 + t2, a, b, c, d + t1, e, f, g])
  }
  // A nonce is two 32-bit words: run through the low one, a high one at a time.
  const end = from + count
  for (let n = from; n < end; ) {
    const hi = Math.floor(n / 2 ** 32)
    const lo = n - hi * 2 ** 32
    const c = Math.min(end - n, 2 ** 32 - lo)
    const found = tries(m, s, hi, lo, c, bits)
    if (found >= 0) return hi * 2 ** 32 + found
    n += c
  }
  return -1
}

/** A nonce that solves it, found here and now (in a worker: it takes a while). */
export function solve(id: Uint8Array, window: number, bits: number): Uint8Array {
  for (let from = 0; ; from += 2 ** 20) {
    const n = search(id, window, bits, from, 2 ** 20)
    if (n >= 0) return nonceBytes(n)
  }
}

function check(id: Uint8Array, window: number, bits: number) {
  if (!(id instanceof Uint8Array) || id.length !== ID_BYTES) throw new TypeError(`id must be ${ID_BYTES} bytes`)
  if (!Number.isInteger(window) || window < 0 || window >= 2 ** 32) throw new RangeError('window must fit in 4 bytes')
  if (!Number.isInteger(bits) || bits < 0 || bits > MAX_BITS) throw new RangeError(`bits must be 0 to ${MAX_BITS}`)
}
