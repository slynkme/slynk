// A small TIFF/EXIF reader. It answers three questions: what kinds of hidden
// info a block holds (for the list of what was removed), what the most telling
// of them say (location, camera, date taken, software, author), and which way
// up the picture goes (Orientation), which must survive so photos don't turn
// sideways.
import { LABEL } from './labels.ts'
import type { Found } from './types.ts'
import { addFound, cameraName, formatExifDate, formatGps, looseText } from './values.ts'

export interface ExifInfo {
  /** Plain-language labels; empty when the block holds only harmless layout tags. */
  labels: string[]
  /** What some of them say, for the sender to see. */
  values: Found[]
  /** EXIF Orientation (1-8), or null when absent or unreadable. */
  orientation: number | null
}

// Text tags whose values are shown: Make, Model, Software, DateTime, Artist,
// DateTimeOriginal, DateTimeDigitized and CameraOwnerName.
const TEXT_TAGS = new Set([0x010f, 0x0110, 0x0131, 0x0132, 0x013b, 0x9003, 0x9004, 0xa430])

// No shown value needs more than this; longer ones are cut short anyway.
const TEXT_CAP = 512

// Tags that only describe the pixels, never the person or the device.
const HARMLESS = new Set([
  0x0100, 0x0101, 0x0102, 0x0103, 0x0106, 0x0112, 0x0115, 0x011a, 0x011b, 0x011c, 0x0128, 0x013e, 0x013f, 0x0211,
  0x0212, 0x0213, 0x0214, 0x9000, 0x9101, 0xa000, 0xa001, 0xa002, 0xa003, 0xa500,
  // Interop IFD: InteropIndex and InteropVersion.
  0x0001, 0x0002,
])

const POINTERS = { exif: 0x8769, gps: 0x8825, interop: 0xa005 }

function tagLabel(tag: number): string {
  switch (tag) {
    case 0x010f:
    case 0x0110:
      return LABEL.camera
    case 0xa432:
    case 0xa433:
    case 0xa434:
      return LABEL.lens
    case 0xa420:
    case 0xa431:
    case 0xa435:
    case 0xc62f:
      return LABEL.serial
    case 0x0132:
    case 0x9003:
    case 0x9004:
    case 0x9010:
    case 0x9011:
    case 0x9012:
    case 0x9290:
    case 0x9291:
    case 0x9292:
      return LABEL.dateTaken
    case 0x013b:
    case 0xa430:
    case 0x9c9d:
      return LABEL.author
    case 0x8298:
      return LABEL.copyright
    case 0x010e:
    case 0x9286:
    case 0x9c9b:
    case 0x9c9c:
    case 0x9c9f:
      return LABEL.description
    case 0x9c9e:
      return LABEL.keywords
    case 0x000b:
    case 0x0131:
    case 0x013c:
      return LABEL.software
    case 0x927c:
      return LABEL.makerNotes
    case 0x02bc:
      return LABEL.otherPhoto // XMP inside TIFF
    case 0x83bb:
      return LABEL.iptc
  }
  return LABEL.settings
}

/** Reads a TIFF block that starts with "II*\0" or "MM\0*". Never throws. */
export function readExif(tiff: Uint8Array): ExifInfo {
  const labels = new Set<string>()
  let orientation: number | null = null
  const text = new Map<number, string>()
  const gps: { lat?: number[]; latRef?: string; lon?: number[]; lonRef?: string } = {}
  try {
    const le = tiff[0] === 0x49 && tiff[1] === 0x49
    if (!le && !(tiff[0] === 0x4d && tiff[1] === 0x4d)) throw new Error('no TIFF header')
    const u16 = (i: number) => {
      if (i < 0 || i + 2 > tiff.length) throw new Error('out of bounds')
      return le ? tiff[i] | (tiff[i + 1] << 8) : (tiff[i] << 8) | tiff[i + 1]
    }
    const u32 = (i: number) => {
      if (i < 0 || i + 4 > tiff.length) throw new Error('out of bounds')
      return le
        ? (tiff[i] | (tiff[i + 1] << 8) | (tiff[i + 2] << 16) | (tiff[i + 3] << 24)) >>> 0
        : ((tiff[i] << 24) | (tiff[i + 1] << 16) | (tiff[i + 2] << 8) | tiff[i + 3]) >>> 0
    }
    if (u16(2) !== 42) throw new Error('bad TIFF magic')
    const seen = new Set<number>()

    // Where an entry's value lives: in the entry itself when it fits in 4 bytes.
    const at = (e: number, bytes: number) => (bytes <= 4 ? e + 8 : u32(e + 8))
    const ascii = (e: number, type: number, n: number): string | undefined => {
      if (type !== 1 && type !== 2 && type !== 7) return undefined
      const start = at(e, n)
      return looseText(tiff.subarray(start, start + Math.min(n, TEXT_CAP)))
    }
    const rationals = (e: number, type: number, n: number): number[] | undefined => {
      if ((type !== 5 && type !== 10) || n < 1 || n > 3) return undefined
      const start = at(e, 8 * n)
      const out: number[] = []
      for (let i = 0; i < n; i++) {
        const num = u32(start + 8 * i)
        const den = u32(start + 8 * i + 4)
        out.push((type === 10 ? num | 0 : num) / (type === 10 ? den | 0 : den))
      }
      return out
    }

    const readIfd = (offset: number, kind: 'ifd0' | 'ifd1' | 'exif' | 'gps' | 'interop'): number => {
      if (seen.has(offset) || seen.size > 16) throw new Error('IFD loop')
      seen.add(offset)
      const count = u16(offset)
      if (count > 1000) throw new Error('too many entries')
      for (let k = 0; k < count; k++) {
        const e = offset + 2 + k * 12
        const tag = u16(e)
        const type = u16(e + 2)
        const n = u32(e + 4)
        if (kind === 'gps') {
          if (tag === 0x0007 || tag === 0x001d) labels.add(LABEL.dateTaken)
          else if (tag !== 0x0000) labels.add(LABEL.gps)
          try {
            if (tag === 0x0001) gps.latRef = ascii(e, type, n)
            else if (tag === 0x0002) gps.lat = rationals(e, type, n)
            else if (tag === 0x0003) gps.lonRef = ascii(e, type, n)
            else if (tag === 0x0004) gps.lon = rationals(e, type, n)
          } catch {
            // An unreadable value is removed all the same, just not shown.
          }
          continue
        }
        if (kind === 'ifd1') continue
        if (tag === POINTERS.exif || tag === POINTERS.gps || tag === POINTERS.interop) {
          const sub = u32(e + 8)
          readIfd(sub, tag === POINTERS.exif ? 'exif' : tag === POINTERS.gps ? 'gps' : 'interop')
          continue
        }
        if (kind === 'interop') {
          if (!HARMLESS.has(tag)) labels.add(LABEL.settings)
          continue
        }
        // Orientation is a SHORT, but some writers store it as a LONG.
        if (kind === 'ifd0' && tag === 0x0112 && (type === 3 || type === 4) && n >= 1) {
          const v = type === 3 ? u16(e + 8) : u32(e + 8)
          orientation = v >= 1 && v <= 8 ? v : null
          continue
        }
        if (kind === 'ifd0' && (tag === 0x0001 || tag === 0x0002)) {
          labels.add(LABEL.settings)
          continue
        }
        if (HARMLESS.has(tag)) continue
        labels.add(tagLabel(tag))
        if (TEXT_TAGS.has(tag) && !text.has(tag)) {
          try {
            const v = ascii(e, type, n)
            if (v !== undefined) text.set(tag, v)
          } catch {
            // As above: removed, just not shown.
          }
        }
      }
      return u32(offset + 2 + count * 12)
    }

    const next = readIfd(u32(4), 'ifd0')
    if (next !== 0) {
      // IFD1 holds the embedded preview, which can show the uncropped original.
      labels.add(LABEL.thumbnail)
      try {
        readIfd(next, 'ifd1')
      } catch {
        // A broken IFD1 is removed along with the rest.
      }
    }
  } catch {
    labels.add(LABEL.otherPhoto)
  }
  const values: Found[] = []
  if (gps.lat && gps.lon) addFound(values, LABEL.gps, formatGps(gps.lat, gps.latRef ?? '', gps.lon, gps.lonRef ?? ''))
  addFound(values, LABEL.camera, cameraName(text.get(0x010f) ?? '', text.get(0x0110) ?? ''))
  // The moment the photo was taken, else when it was scanned, else when the file was last changed.
  const dates = [0x9003, 0x9004, 0x0132].map((t) => formatExifDate(text.get(t) ?? ''))
  addFound(values, LABEL.dateTaken, dates.find((d) => d))
  addFound(values, LABEL.software, text.get(0x0131))
  addFound(values, LABEL.author, text.get(0x013b))
  addFound(values, LABEL.author, text.get(0xa430))
  return { labels: [...labels], values, orientation }
}

/**
 * A minimal big-endian TIFF block holding only Orientation: the 26 bytes that
 * keep a phone photo upright once the rest of its EXIF is gone.
 */
export function orientationTiff(orientation: number): Uint8Array {
  return new Uint8Array([
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, // header, IFD0 at 8
    0x00, 0x01, // one entry
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation & 0xff, 0x00, 0x00, // Orientation SHORT
    0x00, 0x00, 0x00, 0x00, // no IFD1
  ])
}

/** An empty TIFF block: header plus an IFD0 with no entries. */
export function emptyTiff(): Uint8Array {
  return new Uint8Array([0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
}
