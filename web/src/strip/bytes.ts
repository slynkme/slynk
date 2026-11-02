// Small byte helpers shared by the format modules. Every read is bounds-checked
// so malformed files fail cleanly instead of reading garbage.
import { fail } from './types.ts'

export function u8(b: Uint8Array, i: number): number {
  if (i < 0 || i >= b.length) fail('unexpected end of file')
  return b[i]
}

export function u16be(b: Uint8Array, i: number): number {
  if (i < 0 || i + 2 > b.length) fail('unexpected end of file')
  return (b[i] << 8) | b[i + 1]
}

export function u16le(b: Uint8Array, i: number): number {
  if (i < 0 || i + 2 > b.length) fail('unexpected end of file')
  return b[i] | (b[i + 1] << 8)
}

export function u24be(b: Uint8Array, i: number): number {
  if (i < 0 || i + 3 > b.length) fail('unexpected end of file')
  return (b[i] << 16) | (b[i + 1] << 8) | b[i + 2]
}

export function u32be(b: Uint8Array, i: number): number {
  if (i < 0 || i + 4 > b.length) fail('unexpected end of file')
  return ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0
}

export function u32le(b: Uint8Array, i: number): number {
  if (i < 0 || i + 4 > b.length) fail('unexpected end of file')
  return (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0
}

export function u64be(b: Uint8Array, i: number): number {
  const hi = u32be(b, i)
  const lo = u32be(b, i + 4)
  const v = hi * 2 ** 32 + lo
  if (!Number.isSafeInteger(v)) fail('value too large')
  return v
}

/** Reads an unsigned big-endian integer of 0, 1, 2, 4 or 8 bytes. */
export function uintbe(b: Uint8Array, i: number, size: number): number {
  switch (size) {
    case 0:
      return 0
    case 1:
      return u8(b, i)
    case 2:
      return u16be(b, i)
    case 4:
      return u32be(b, i)
    case 8:
      return u64be(b, i)
  }
  return fail('bad field size')
}

export function putU16be(b: Uint8Array, i: number, v: number) {
  b[i] = (v >>> 8) & 0xff
  b[i + 1] = v & 0xff
}

export function putU32be(b: Uint8Array, i: number, v: number) {
  b[i] = (v >>> 24) & 0xff
  b[i + 1] = (v >>> 16) & 0xff
  b[i + 2] = (v >>> 8) & 0xff
  b[i + 3] = v & 0xff
}

export function putU16le(b: Uint8Array, i: number, v: number) {
  b[i] = v & 0xff
  b[i + 1] = (v >>> 8) & 0xff
}

export function putU32le(b: Uint8Array, i: number, v: number) {
  b[i] = v & 0xff
  b[i + 1] = (v >>> 8) & 0xff
  b[i + 2] = (v >>> 16) & 0xff
  b[i + 3] = (v >>> 24) & 0xff
}

/** Bytes as Latin-1 text: one character per byte, never throws. */
export function latin1(b: Uint8Array, start = 0, end = b.length): string {
  let s = ''
  const stop = Math.min(end, b.length)
  for (let i = Math.max(0, start); i < stop; i += 8192) {
    s += String.fromCharCode(...b.subarray(i, Math.min(stop, i + 8192)))
  }
  return s
}

export function ascii(s: string): Uint8Array {
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff
  return out
}

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

export function fromUtf8(b: Uint8Array): string {
  return new TextDecoder('utf-8').decode(b)
}

/** True when b holds the ASCII text s at offset i. */
export function startsWith(b: Uint8Array, s: string, i = 0): boolean {
  if (i < 0 || i + s.length > b.length) return false
  for (let k = 0; k < s.length; k++) if (b[i + k] !== s.charCodeAt(k)) return false
  return true
}

/** Finds ASCII text s in b, from offset `from`, or -1. */
export function indexOf(b: Uint8Array, s: string, from = 0, to = b.length): number {
  const first = s.charCodeAt(0)
  const stop = Math.min(to, b.length) - s.length
  for (let i = b.indexOf(first, from); i !== -1 && i <= stop; i = b.indexOf(first, i + 1)) {
    if (startsWith(b, s, i)) return i
  }
  return -1
}

export function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0
  for (const p of parts) n += p.length
  const out = new Uint8Array(n)
  let i = 0
  for (const p of parts) {
    out.set(p, i)
    i += p.length
  }
  return out
}

export function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

export function allZero(b: Uint8Array): boolean {
  for (let i = 0; i < b.length; i++) if (b[i] !== 0) return false
  return true
}

let crcTable: Uint32Array | undefined

/** CRC-32 as used by PNG and ZIP. */
export function crc32(b: Uint8Array, crc = 0): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let c = ~crc >>> 0
  for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8)
  return ~c >>> 0
}

/** A growable output buffer. */
export class Writer {
  private buf = new Uint8Array(1024)
  length = 0

  private room(n: number) {
    if (this.length + n <= this.buf.length) return
    let size = this.buf.length * 2
    while (size < this.length + n) size *= 2
    const next = new Uint8Array(size)
    next.set(this.buf.subarray(0, this.length))
    this.buf = next
  }

  bytes(b: Uint8Array) {
    this.room(b.length)
    this.buf.set(b, this.length)
    this.length += b.length
  }

  byte(v: number) {
    this.room(1)
    this.buf[this.length++] = v & 0xff
  }

  u16be(v: number) {
    this.room(2)
    putU16be(this.buf, this.length, v)
    this.length += 2
  }

  u32be(v: number) {
    this.room(4)
    putU32be(this.buf, this.length, v)
    this.length += 4
  }

  u16le(v: number) {
    this.room(2)
    putU16le(this.buf, this.length, v)
    this.length += 2
  }

  u32le(v: number) {
    this.room(4)
    putU32le(this.buf, this.length, v)
    this.length += 4
  }

  /** Overwrites four bytes already written (a box's size, once it's known). */
  setU32be(at: number, v: number) {
    putU32be(this.buf, at, v)
  }

  /** A copy of what's been written, in its own buffer. */
  finish(): Uint8Array {
    return this.buf.slice(0, this.length)
  }
}
