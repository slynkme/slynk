// What a picture inside an Office file is, read from its first bytes without
// decoding it: its kind and size, and what decides whether Slynk may make it
// smaller (print colours, an animation, a rotation tag). Also the two small
// edits a JPEG needs around the canvas: its EXIF taken out before decoding,
// and its rotation put back afterwards.
import { concat, u16be, u16le, u32be, u32le } from '../strip/bytes.ts'
import type { Dims } from '../shrink/plan.ts'

export type PicKind = 'jpeg' | 'png' | 'bmp' | 'gif' | 'tiff' | 'webp' | 'emf' | 'wmf' | 'svg' | 'wdp' | 'other'

export interface PicInfo {
  kind: PicKind
  /** As stored, before any rotation; undefined when the header couldn't be read. */
  dims?: Dims
  /** A JPEG in print colours (CMYK or YCCK): browsers turn those into the wrong colours. */
  cmyk?: boolean
  /** EXIF orientation, when a JPEG has one other than 1 (upright). */
  orientation?: number
  /** A PNG with an eXIf chunk: its rotation would be lost. */
  pngExif?: boolean
  /** An animated PNG. */
  animated?: boolean
}

const at = (b: Uint8Array, i: number, s: string) => i + s.length <= b.length && [...s].every((c, k) => b[i + k] === c.charCodeAt(0))
const dims = (width: number, height: number): Dims | undefined => (width > 0 && height > 0 ? { width, height } : undefined)

export function pictureInfo(b: Uint8Array): PicInfo {
  try {
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return jpegInfo(b)
    if (at(b, 0, '\x89PNG\r\n\x1a\n')) return pngInfo(b)
    if (at(b, 0, 'BM') && b.length > 30) {
      const height = Math.abs(u32le(b, 22) | 0)
      return { kind: 'bmp', dims: dims(u32le(b, 18) | 0, height) }
    }
    if (at(b, 0, 'GIF8')) return { kind: 'gif', dims: dims(u16le(b, 6), u16le(b, 8)) }
    if (at(b, 0, 'II*\0') || at(b, 0, 'MM\0*')) return { kind: 'tiff' }
    if (at(b, 0, 'II\xbc')) return { kind: 'wdp' }
    if (at(b, 0, 'RIFF') && at(b, 8, 'WEBP')) return { kind: 'webp' }
    if (u32le(b, 0) === 1 && at(b, 40, ' EMF')) return { kind: 'emf' }
    if (u32le(b, 0) === 0x9ac6cdd7 || (u16le(b, 0) === 1 && u16le(b, 2) === 9)) return { kind: 'wmf' }
    if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(new TextDecoder().decode(b.subarray(0, 1024)))) return { kind: 'svg' }
  } catch {
    // A header cut short: something Slynk leaves alone.
  }
  return { kind: 'other' }
}

/** JPEG markers up to the scan, with their payload's start and end. */
function* jpegSegments(b: Uint8Array): Generator<{ m: number; start: number; end: number }> {
  let i = 2
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return
    const m = b[i + 1]
    if (m === 0xff) {
      i++ // fill byte
      continue
    }
    if (m === 0xd9 || m === 0xda) return
    if ((m >= 0xd0 && m <= 0xd7) || m === 0x01) {
      i += 2
      continue
    }
    const len = u16be(b, i + 2)
    if (len < 2 || i + 2 + len > b.length) return
    yield { m, start: i, end: i + 2 + len }
    i += 2 + len
  }
}

function jpegInfo(b: Uint8Array): PicInfo {
  const info: PicInfo = { kind: 'jpeg' }
  for (const s of jpegSegments(b)) {
    if (s.m >= 0xc0 && s.m <= 0xcf && s.m !== 0xc4 && s.m !== 0xc8 && s.m !== 0xcc) {
      info.dims = dims(u16be(b, s.start + 7), u16be(b, s.start + 5))
      if (b[s.start + 9] === 4) info.cmyk = true
      break
    }
    if (s.m === 0xe1 && at(b, s.start + 4, 'Exif\0\0')) {
      const o = exifOrientation(b.subarray(s.start + 10, s.end))
      if (o && o !== 1) info.orientation = o
    }
  }
  return info
}

/** IFD0's Orientation tag (0x0112) in a TIFF header, or undefined. */
function exifOrientation(t: Uint8Array): number | undefined {
  if (t.length < 8) return undefined
  const le = t[0] === 0x49
  const r16 = (i: number) => (le ? u16le(t, i) : u16be(t, i))
  const r32 = (i: number) => (le ? u32le(t, i) : u32be(t, i))
  const ifd = r32(4)
  if (ifd + 2 > t.length) return undefined
  const n = r16(ifd)
  for (let k = 0; k < n; k++) {
    const e = ifd + 2 + k * 12
    if (e + 12 > t.length) return undefined
    if (r16(e) === 0x0112) {
      const v = r16(e + 8)
      return v >= 1 && v <= 8 ? v : undefined
    }
  }
  return undefined
}

function pngInfo(b: Uint8Array): PicInfo {
  const info: PicInfo = { kind: 'png', dims: dims(u32be(b, 16), u32be(b, 20)) }
  for (let i = 8; i + 8 <= b.length; ) {
    const len = u32be(b, i)
    if (at(b, i + 4, 'acTL')) info.animated = true
    if (at(b, i + 4, 'eXIf')) info.pngExif = true
    if (at(b, i + 4, 'IEND')) break
    i += 12 + len
  }
  return info
}

/**
 * The JPEG without its APP1 segments (EXIF and XMP), so a browser decodes the
 * pixels as stored instead of turning them by the EXIF rotation. Its colour
 * profile (APP2) and Adobe colour flag (APP14) stay: they say what the colours mean.
 */
export function withoutApp1(b: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [b.subarray(0, 2)]
  let from = 2
  let last = 2
  for (const s of jpegSegments(b)) {
    if (s.m === 0xe1) {
      parts.push(b.subarray(from, s.start))
      from = s.end
    }
    last = s.end
  }
  if (last === 2) throw new Error('not a JPEG')
  parts.push(b.subarray(from))
  return concat(parts)
}

/**
 * A new JPEG with the original's rotation tag put back, so whatever turned
 * the original turns it the same way (and whatever didn't, doesn't). It holds
 * nothing else: no camera, no date, no place.
 */
export function withOrientation(jpeg: Uint8Array, orientation: number): Uint8Array {
  // "Exif\0\0", a big-endian TIFF header, and IFD0 with the one tag.
  const app1 = Uint8Array.from([
    0xff, 0xe1, 0, 34,
    0x45, 0x78, 0x69, 0x66, 0, 0,
    0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8,
    0, 1,
    0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0,
    0, 0, 0, 0,
  ])
  return concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)])
}

/** Orientations 5-8 turn a picture a quarter, swapping its width and height. */
export const turnsQuarter = (orientation?: number) => orientation !== undefined && orientation >= 5
