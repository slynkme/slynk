// PNG: keep the chunks that draw the picture (including colour, transparency
// and APNG animation chunks) and drop text, EXIF, timestamps, Content
// Credentials and private chunks. Whole chunks are copied, so their CRCs stay
// valid. A non-default EXIF Orientation is re-created on its own.
import { ascii, concat, crc32, fromUtf8, latin1, putU32be, u32be } from './bytes.ts'
import { orientationTiff, readExif } from './exif.ts'
import { inflateZlib } from './inflate.ts'
import { LABEL } from './labels.ts'
import { type FormatOutcome, type Found, fail } from './types.ts'
import { addAll, addFound } from './values.ts'
import { xmpLabels, xmpValues } from './xmp.ts'

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

// Chunks that affect how the image looks (APNG's acTL/fcTL/fdAT included).
const KEEP = new Set([
  'IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'cICP', 'mDCV', 'cLLI', 'sBIT', 'bKGD',
  'pHYs', 'hIST', 'acTL', 'fcTL', 'fdAT', 'oFFs', 'pCAL', 'sCAL', 'sTER',
])

// Decoding hints with nothing personal: dropped, but not worth reporting.
const SILENT = new Set(['iDOT', 'sPLT', 'vpAg'])

const TEXT_CAP = 4_000_000

interface Chunk {
  type: string
  start: number
  end: number
}

function chunks(b: Uint8Array): { list: Chunk[]; end: number } {
  for (let i = 0; i < 8; i++) if (b[i] !== SIGNATURE[i]) fail('not a PNG')
  const list: Chunk[] = []
  let pos = 8
  for (;;) {
    const len = u32be(b, pos)
    if (len > 0x7fffffff) fail('bad PNG chunk length')
    const type = latin1(b, pos + 4, pos + 8)
    if (!/^[A-Za-z]{4}$/.test(type)) fail('bad PNG chunk type')
    const end = pos + 12 + len
    if (end > b.length) fail('the PNG is cut short')
    if (list.length === 0 && type !== 'IHDR') fail('the PNG does not start with IHDR')
    list.push({ type, start: pos, end })
    pos = end
    if (type === 'IEND') return { list, end }
  }
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  putU32be(out, 0, data.length)
  out.set(ascii(type), 4)
  out.set(data, 8)
  putU32be(out, 8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

function hexExif(text: string, values: Found[]): string[] {
  // ImageMagick's "Raw profile type exif": a header line, a length, then hex.
  const hex = text.split('\n').slice(3).join('').replace(/\s+/g, '')
  const bytes = new Uint8Array(hex.length >> 1)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16)
  const info = readExif(latin1(bytes, 0, 6) === 'Exif\0\0' ? bytes.subarray(6) : bytes)
  addAll(values, info.values)
  return info.labels
}

// Text keywords whose values are shown.
const SHOWN = new Map([
  ['title', LABEL.title],
  ['author', LABEL.author],
  ['artist', LABEL.author],
  ['software', LABEL.software],
])

/** Labels for a text chunk; what it says goes into values when it's worth showing. */
function textLabels(type: string, data: Uint8Array, values: Found[]): string[] {
  const nul = data.indexOf(0)
  const keyword = latin1(data, 0, nul === -1 ? data.length : nul).toLowerCase()
  let value = ''
  try {
    if (type === 'tEXt') value = latin1(data, nul + 1)
    else if (type === 'zTXt') value = latin1(inflateZlib(data.subarray(nul + 2), TEXT_CAP))
    else {
      const compressed = data[nul + 1] === 1
      let i = data.indexOf(0, nul + 3)
      i = data.indexOf(0, i + 1)
      const raw = data.subarray(i + 1)
      value = fromUtf8(compressed ? inflateZlib(raw, TEXT_CAP) : raw)
    }
  } catch {
    // Unreadable text is removed all the same; label it by its keyword.
  }
  if (keyword === 'xml:com.adobe.xmp' || keyword === 'raw profile type xmp') {
    if (!value) return [LABEL.otherPhoto]
    addAll(values, xmpValues(value))
    return xmpLabels(value)
  }
  if (keyword === 'raw profile type exif' || keyword === 'raw profile type app1') {
    try {
      return hexExif(value, values)
    } catch {
      return [LABEL.otherPhoto]
    }
  }
  if (keyword.startsWith('raw profile type icc') || keyword.startsWith('raw profile type icm')) return []
  if (keyword === 'raw profile type iptc') return [LABEL.iptc]
  if (keyword.startsWith('raw profile type')) return [LABEL.appData] // 8bim (Photoshop) and others
  if (keyword.startsWith('exif:gps')) return [LABEL.gps]
  if (keyword === 'exif:make' || keyword === 'exif:model') return [LABEL.camera]
  if (keyword.startsWith('exif:datetime') || keyword.startsWith('date:') || keyword === 'creation time') return [LABEL.dates]
  if (keyword.startsWith('exif:')) return [LABEL.settings]
  const shown = SHOWN.get(keyword)
  if (shown) addFound(values, shown, value)
  switch (keyword) {
    case 'title':
      return [LABEL.title]
    case 'author':
    case 'artist':
      return [LABEL.author]
    case 'make':
    case 'model':
      return [LABEL.camera]
    case 'description':
      return [LABEL.description]
    case 'copyright':
      return [LABEL.copyright]
    case 'software':
      return [LABEL.software]
    case 'source':
      return [LABEL.camera]
    case 'comment':
      return [LABEL.comments]
    case 'parameters':
    case 'prompt':
    case 'workflow':
    case 'dream':
    case 'sd-metadata':
    case 'invokeai_metadata':
    case 'generation_data':
    case 'negative_prompt':
      return [LABEL.prompt]
  }
  return [LABEL.embeddedText]
}

interface Analysis {
  labels: Set<string>
  values: Found[]
  parts: Uint8Array[]
}

function analyse(b: Uint8Array): Analysis {
  const { list, end } = chunks(b)
  const labels = new Set<string>()
  const values: Found[] = []
  const parts: Uint8Array[] = [b.subarray(0, 8)]
  let exifSeen = false
  for (const c of list) {
    const data = b.subarray(c.start + 8, c.end - 4)
    if (KEEP.has(c.type)) {
      parts.push(b.subarray(c.start, c.end))
      continue
    }
    switch (c.type) {
      case 'eXIf': {
        const info = readExif(data)
        if (exifSeen || info.labels.length) addAll(values, info.values)
        if (exifSeen) info.labels.forEach((l) => labels.add(l))
        else if (info.labels.length === 0) parts.push(b.subarray(c.start, c.end))
        else {
          info.labels.forEach((l) => labels.add(l))
          if (info.orientation && info.orientation !== 1) parts.push(chunk('eXIf', orientationTiff(info.orientation)))
        }
        exifSeen = true
        break
      }
      case 'tEXt':
      case 'zTXt':
      case 'iTXt':
        textLabels(c.type, data, values).forEach((l) => labels.add(l))
        break
      case 'tIME':
        labels.add(LABEL.dates)
        break
      case 'caBX':
        labels.add(LABEL.c2pa)
        break
      default:
        if (!SILENT.has(c.type)) labels.add(LABEL.other)
    }
  }
  if (end < b.length && b.subarray(end).some((v) => v !== 0)) labels.add(LABEL.trailing)
  return { labels, values, parts }
}

export function strip(b: Uint8Array): FormatOutcome {
  const a = analyse(b)
  if (a.labels.size === 0) return { status: 'unchanged' }
  return { status: 'cleaned', bytes: concat(a.parts), removed: [...a.labels], values: a.values }
}

export function verify(b: Uint8Array): void {
  const { list, end } = chunks(b)
  if (end !== b.length) fail('data after the PNG end')
  for (const c of list) {
    if (!KEEP.has(c.type) && c.type !== 'eXIf') fail(`unexpected PNG chunk ${c.type}`)
    if (crc32(b.subarray(c.start + 4, c.end - 4)) !== u32be(b, c.end - 4) && c.type === 'eXIf') fail('bad eXIf CRC')
  }
  const a = analyse(b)
  if (a.labels.size) fail(`still holds: ${[...a.labels].join(', ')}`)
}
