// WebP: a RIFF file of chunks. Keep the image, alpha, ICC colour and
// animation chunks; drop EXIF (bar a re-created Orientation), XMP, Content
// Credentials and unknown chunks; then fix the VP8X flags and the RIFF size.
import { ascii, concat, fromUtf8, latin1, putU32le, u32le } from './bytes.ts'
import { orientationTiff, readExif } from './exif.ts'
import { LABEL } from './labels.ts'
import { type FormatOutcome, type Found, fail } from './types.ts'
import { addAll } from './values.ts'
import { xmpLabels, xmpValues } from './xmp.ts'

const KEEP = new Set(['VP8X', 'ICCP', 'ANIM', 'ANMF', 'ALPH', 'VP8 ', 'VP8L'])
const FLAG_EXIF = 0x08
const FLAG_XMP = 0x04

interface Chunk {
  id: string
  start: number
  /** End of the data, before any padding byte. */
  dataEnd: number
  end: number
}

function riff(b: Uint8Array): { list: Chunk[]; end: number } {
  if (latin1(b, 0, 4) !== 'RIFF' || latin1(b, 8, 12) !== 'WEBP') fail('not a WebP')
  const end = 8 + u32le(b, 4)
  if (end > b.length || end < 12) fail('the WebP is cut short')
  const list: Chunk[] = []
  let pos = 12
  while (pos < end) {
    const id = latin1(b, pos, pos + 4)
    const size = u32le(b, pos + 4)
    const dataEnd = pos + 8 + size
    if (dataEnd > end) fail('bad WebP chunk size')
    list.push({ id, start: pos, dataEnd, end: Math.min(end, dataEnd + (size & 1)) })
    pos = dataEnd + (size & 1)
  }
  if (!list.length || !['VP8 ', 'VP8L', 'VP8X'].includes(list[0].id)) fail('the WebP has no image chunk first')
  return { list, end }
}

function chunk(id: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + data.length + (data.length & 1))
  out.set(ascii(id), 0)
  putU32le(out, 4, data.length)
  out.set(data, 8)
  return out
}

function analyse(b: Uint8Array) {
  const { list, end } = riff(b)
  const labels = new Set<string>()
  const values: Found[] = []
  const parts: Uint8Array[] = []
  const extended = list[0].id === 'VP8X'
  let exifKept = false
  for (const c of list) {
    const data = b.subarray(c.start + 8, c.dataEnd)
    if (KEEP.has(c.id)) {
      parts.push(b.subarray(c.start, c.end))
      continue
    }
    if (c.id === 'EXIF') {
      const tiff = latin1(data, 0, 6) === 'Exif\0\0' ? data.subarray(6) : data
      const info = readExif(tiff)
      if (info.labels.length === 0 && extended && !exifKept) {
        parts.push(b.subarray(c.start, c.end))
        exifKept = true
      } else {
        info.labels.forEach((l) => labels.add(l))
        addAll(values, info.values)
        if (extended && !exifKept && info.orientation && info.orientation !== 1) {
          parts.push(chunk('EXIF', orientationTiff(info.orientation)))
          exifKept = true
        }
      }
    } else if (c.id === 'XMP ') {
      const text = fromUtf8(data)
      const found = xmpLabels(text)
      ;(found.length ? found : [LABEL.otherPhoto]).forEach((l) => labels.add(l))
      addAll(values, xmpValues(text))
    } else if (c.id === 'C2PA') {
      labels.add(LABEL.c2pa)
    } else labels.add(LABEL.other)
  }
  if (end < b.length && b.subarray(end).some((v) => v !== 0)) labels.add(LABEL.trailing)
  return { labels, values, parts, extended, exifKept }
}

export function strip(b: Uint8Array): FormatOutcome {
  const a = analyse(b)
  if (a.labels.size === 0) return { status: 'unchanged' }
  if (a.extended) {
    // Copy VP8X so the flags can change, then match them to what's left.
    const vp8x = a.parts[0].slice()
    vp8x[8] = (vp8x[8] & ~(FLAG_EXIF | FLAG_XMP)) | (a.exifKept ? FLAG_EXIF : 0)
    a.parts[0] = vp8x
  }
  const body = concat(a.parts)
  const out = new Uint8Array(12 + body.length)
  out.set(ascii('RIFF'), 0)
  putU32le(out, 4, 4 + body.length)
  out.set(ascii('WEBP'), 8)
  out.set(body, 12)
  return { status: 'cleaned', bytes: out, removed: [...a.labels], values: a.values }
}

export function verify(b: Uint8Array): void {
  const { list, end } = riff(b)
  if (end !== b.length) fail('data after the WebP end')
  const hasExif = list.some((c) => c.id === 'EXIF')
  for (const c of list) if (!KEEP.has(c.id) && c.id !== 'EXIF') fail(`unexpected WebP chunk ${c.id}`)
  if (list[0].id === 'VP8X') {
    const flags = b[list[0].start + 8]
    if (Boolean(flags & FLAG_EXIF) !== hasExif || flags & FLAG_XMP) fail('VP8X flags do not match the chunks')
  } else if (hasExif) fail('EXIF in a simple WebP')
  const a = analyse(b)
  if (a.labels.size) fail(`still holds: ${[...a.labels].join(', ')}`)
}
