// What the composer needs to know about a picture before offering a smaller
// copy, read from its first bytes without decoding it: what kind it is, how
// many pixels it has, and whether it's a single still picture (a copy keeps
// only the first frame of an animation, so those aren't offered).
import { detectKind } from '../strip/sniff.ts'
import type { Dims } from './plan.ts'

export type PhotoKind = 'jpeg' | 'png' | 'webp' | 'gif' | 'avif' | 'heic'
const PHOTO_KINDS: readonly string[] = ['jpeg', 'png', 'webp', 'gif', 'avif', 'heic']

export interface PhotoInfo {
  kind: PhotoKind
  /** As stored, before any rotation; undefined when the header couldn't be read. */
  dims?: Dims
  /** One picture, not an animation. False when it's animated or Slynk can't tell. */
  still: boolean
}

const u16be = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1]
const u16le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8)
const u24le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16)
const u32be = (b: Uint8Array, i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0
const at = (b: Uint8Array, i: number, s: string) => i + s.length <= b.length && [...s].every((c, k) => b[i + k] === c.charCodeAt(0))
const dims = (width: number, height: number): Dims | undefined => (width > 0 && height > 0 ? { width, height } : undefined)

/** A photo Slynk could make a smaller copy of, or null for anything else. */
export function photoInfo(b: Uint8Array): PhotoInfo | null {
  let kind: string | null
  try {
    kind = detectKind(b)
  } catch {
    return null
  }
  if (!kind || !PHOTO_KINDS.includes(kind)) return null
  const k = kind as PhotoKind
  try {
    if (k === 'jpeg') return { kind: k, dims: jpegDims(b), still: true }
    if (k === 'png') return { kind: k, dims: dims(u32be(b, 16), u32be(b, 20)), still: !pngAnimated(b) }
    if (k === 'gif') return { kind: k, dims: dims(u16le(b, 6), u16le(b, 8)), still: gifFrames(b) === 1 }
    if (k === 'webp') return { kind: k, ...webpInfo(b) }
    return { kind: k, dims: ispeDims(b), still: !isoSequence(b) }
  } catch {
    return { kind: k, still: false }
  }
}

// JPEG: the frame header (SOF0-15, bar DHT, JPG and DAC) holds the size.
function jpegDims(b: Uint8Array): Dims | undefined {
  let i = 2
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return undefined
    const m = b[i + 1]
    if (m === 0xff) {
      i++ // fill byte
      continue
    }
    if (m === 0xd9 || m === 0xda) return undefined // end of image, or the data, before a frame header
    if ((m >= 0xd0 && m <= 0xd7) || m === 0x01) {
      i += 2
      continue
    }
    const len = u16be(b, i + 2)
    if (len < 2) return undefined
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return i + 9 <= b.length ? dims(u16be(b, i + 7), u16be(b, i + 5)) : undefined
    }
    i += 2 + len
  }
  return undefined
}

// APNG: an acTL chunk before the image data.
function pngAnimated(b: Uint8Array): boolean {
  for (let i = 8; i + 8 <= b.length; ) {
    const len = u32be(b, i)
    if (at(b, i + 4, 'acTL')) return true
    if (at(b, i + 4, 'IDAT') || at(b, i + 4, 'IEND')) return false
    i += 12 + len
  }
  throw new Error('no image data')
}

/** Frames in a GIF, counted up to 2; throws if the blocks don't make sense. */
function gifFrames(b: Uint8Array): number {
  const sub = (i: number) => {
    for (;;) {
      if (i >= b.length) throw new Error('cut short')
      const n = b[i]
      i += 1 + n
      if (n === 0) return i
    }
  }
  const p = b[10]
  let i = 13 + (p & 0x80 ? 3 * 2 ** ((p & 7) + 1) : 0)
  let frames = 0
  while (i < b.length) {
    const t = b[i]
    if (t === 0x3b) break
    if (t === 0x2c) {
      if (++frames > 1) return frames
      const q = b[i + 9]
      i = sub(i + 10 + (q & 0x80 ? 3 * 2 ** ((q & 7) + 1) : 0) + 1)
    } else if (t === 0x21) i = sub(i + 2)
    else throw new Error('bad block')
  }
  if (!frames) throw new Error('no frames')
  return frames
}

function webpInfo(b: Uint8Array): { dims?: Dims; still: boolean } {
  if (at(b, 12, 'VP8X')) return { dims: dims(u24le(b, 24) + 1, u24le(b, 27) + 1), still: !(b[20] & 0x02) }
  if (at(b, 12, 'VP8L') && b[20] === 0x2f) {
    const width = 1 + (((b[22] & 0x3f) << 8) | b[21])
    const height = 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6))
    return { dims: dims(width, height), still: true }
  }
  if (at(b, 12, 'VP8 ') && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
    return { dims: dims(u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff), still: true }
  }
  return { still: false }
}

// HEIC and AVIF: the largest 'ispe' (image size) property. A photo split into
// tiles lists each tile's size and the whole picture's.
function ispeDims(b: Uint8Array): Dims | undefined {
  let best: Dims | undefined
  const end = Math.min(b.length, 1 << 20)
  for (let i = 0; i + 20 <= end; i++) {
    if (b[i + 4] !== 0x69 || !at(b, i + 4, 'ispe') || u32be(b, i) !== 20) continue
    const d = dims(u32be(b, i + 12), u32be(b, i + 16))
    if (d && (!best || d.width * d.height > best.width * best.height)) best = d
  }
  return best
}

// Image sequences (animations or bursts) list a sequence brand.
function isoSequence(b: Uint8Array): boolean {
  const size = u32be(b, 0)
  const end = Math.min(b.length, size > 8 ? size : 8, 16 + 4 * 64)
  for (let i = 8; i + 4 <= end; i += 4) {
    if (i === 12) continue // the minor version, not a brand
    const brand = String.fromCharCode(...b.subarray(i, i + 4))
    if (['avis', 'msf1', 'hevc', 'hevx', 'hevs'].includes(brand)) return true
  }
  return false
}
