// The pictures inside a PDF: which ones a browser can make smaller, why the
// others are left as they are, and the pixels of those stored as raw pixels.
//
// A browser can open two kinds: JPEG (DCTDecode), which it decodes itself,
// and raw pixels (usually FlateDecode, often with a PNG predictor), which are
// unpacked here. Left alone: JPEG 2000 (no browser but old Safari opens it),
// black-and-white scans (JBIG2, CCITT: already tiny), spot colours, pictures
// that are another picture's transparency, and anything with unusual settings.
//
// Print colours (CMYK) are only converted to RGB when the JPEG says how its
// colours are stored the way Adobe's apps write them: an Adobe marker in the
// JPEG, which tells the browser its values are inverted, and a PDF Decode of
// [1 0 1 0 1 0 1 0], which tells PDF readers the same. Any other mix is read
// differently by different browsers and readers (Chromium takes every CMYK
// JPEG as inverted), so those stay as they are.
import { PDFArray, PDFBool, PDFDict, type PDFDocument, PDFHexString, PDFName, PDFNumber, type PDFObject, PDFRawStream, PDFRef, PDFString, decodePDFRawStream } from 'pdf-lib'

export type Skip =
  | 'jpx' // JPEG 2000
  | 'bw' // JBIG2 or CCITT: black-and-white scans
  | 'stencil' // a one-colour shape (ImageMask)
  | 'cmyk' // print colours
  | 'colour' // spot colours, Lab and the like
  | 'decode' // a Decode array that remaps the colours
  | 'colour-key' // a Mask array: exact colours made see-through, which a JPEG would blur
  | 'matte' // a soft mask with Matte, which must match its picture pixel for pixel
  | 'bits' // 16 bits a colour
  | 'small' // too few bytes to be worth it
  | 'mask' // it's another picture's transparency
  | 'thumb' // a page thumbnail
  | 'filter' // a compression this can't undo, or a JPEG setting it can't follow
  | 'big' // too many pixels to open
  | 'broken' // couldn't be read

export type Source = 'jpeg' | 'pixels'

export interface Colour {
  kind: 'gray' | 'rgb' | 'cmyk' | 'indexed' | 'other'
  /** For the report: "DeviceRGB", "ICC RGB", "Indexed DeviceRGB"… */
  label: string
  /** Components per pixel as stored (1 for indexed). */
  n: number
  base?: Colour
  hival?: number
  palette?: Uint8Array
}

export interface PdfImage {
  ref: PDFRef
  stream: PDFRawStream
  width: number
  height: number
  bpc: number
  filters: string[]
  colour: Colour
  /** Bytes as stored in the file. */
  bytes: number
  /** Bytes of its transparency (SMask), kept as it is. */
  maskBytes: number
  source?: Source
  skip?: Skip
  /** For a CMYK JPEG: how its colours are stored, and whether that's clear enough to convert to RGB. */
  cmyk?: { adobe?: number; decode: 'inverted' | 'none' | 'other'; convert: boolean }
}

/**
 * Pictures with fewer bytes than this are left alone: making one smaller saves a few hundred bytes
 * at most, and each takes as long to measure as a big one. 16 KB until 2026-11-01, when a manual's
 * 77 screenshots of 1-16 KB came to 300 KB, the difference between fitting and not.
 */
export const SMALL = 1024
/** As for photos (shrink/plan.ts): about as much as a phone's tab can spare. */
export const MAX_PIXELS = 50_000_000

const N = (s: string) => PDFName.of(s)
const ABBREV: Record<string, string> = {
  AHx: 'ASCIIHexDecode',
  A85: 'ASCII85Decode',
  LZW: 'LZWDecode',
  Fl: 'FlateDecode',
  RL: 'RunLengthDecode',
  CCF: 'CCITTFaxDecode',
  DCT: 'DCTDecode',
}
const UNDOABLE = new Set(['ASCIIHexDecode', 'ASCII85Decode', 'LZWDecode', 'FlateDecode', 'RunLengthDecode'])

function filtersOf(doc: PDFDocument, d: PDFDict): string[] {
  const f = doc.context.lookup(d.get(N('Filter')))
  const names = f instanceof PDFName ? [f] : f instanceof PDFArray ? f.asArray().map((x) => doc.context.lookup(x)) : []
  return names.map((x) => (x instanceof PDFName ? x.decodeText() : '?')).map((x) => ABBREV[x] ?? x)
}

const num = (doc: PDFDocument, o: PDFObject | undefined) => {
  const v = doc.context.lookup(o)
  return v instanceof PDFNumber ? v.asNumber() : undefined
}

function stringBytes(doc: PDFDocument, o: PDFObject | undefined): Uint8Array | undefined {
  const v = doc.context.lookup(o)
  if (v instanceof PDFString || v instanceof PDFHexString) return v.asBytes()
  if (v instanceof PDFRawStream) {
    try {
      return decodePDFRawStream(v).decode()
    } catch {
      return undefined
    }
  }
  return undefined
}

const OTHER = (label: string): Colour => ({ kind: 'other', label, n: 0 })

export function colourOf(doc: PDFDocument, o: PDFObject | undefined, depth = 0): Colour {
  const cs = doc.context.lookup(o)
  if (cs instanceof PDFName) {
    const name = cs.decodeText()
    if (name === 'DeviceGray' || name === 'G') return { kind: 'gray', label: 'DeviceGray', n: 1 }
    if (name === 'DeviceRGB' || name === 'RGB') return { kind: 'rgb', label: 'DeviceRGB', n: 3 }
    if (name === 'DeviceCMYK' || name === 'CMYK') return { kind: 'cmyk', label: 'DeviceCMYK', n: 4 }
    return OTHER(name)
  }
  if (!(cs instanceof PDFArray) || cs.size() === 0 || depth > 4) return OTHER(cs ? 'unknown' : 'none')
  const family = doc.context.lookup(cs.get(0))
  const name = family instanceof PDFName ? family.decodeText() : '?'
  if (name === 'ICCBased') {
    const profile = doc.context.lookup(cs.get(1))
    const n = profile instanceof PDFRawStream ? num(doc, profile.dict.get(N('N'))) : undefined
    if (n === 1) return { kind: 'gray', label: 'ICC grey', n: 1 }
    if (n === 3) return { kind: 'rgb', label: 'ICC RGB', n: 3 }
    if (n === 4) return { kind: 'cmyk', label: 'ICC CMYK', n: 4 }
    return OTHER('ICC')
  }
  if (name === 'CalGray') return { kind: 'gray', label: 'CalGray', n: 1 }
  if (name === 'CalRGB') return { kind: 'rgb', label: 'CalRGB', n: 3 }
  if (name === 'Indexed' || name === 'I') {
    const base = colourOf(doc, cs.get(1), depth + 1)
    const hival = num(doc, cs.get(2))
    const palette = stringBytes(doc, cs.get(3))
    if (hival === undefined || !palette) return OTHER('Indexed')
    return { kind: 'indexed', label: `Indexed ${base.label}`, n: 1, base, hival: Math.max(0, Math.min(255, Math.floor(hival))), palette }
  }
  return OTHER(name)
}

/** Every picture stored as its own object, with what can be done with it. */
export function findImages(doc: PDFDocument): PdfImage[] {
  const ctx = doc.context
  const objects = ctx.enumerateIndirectObjects()
  // Pictures that are another picture's transparency, and page thumbnails.
  const masks = new Set<PDFRef>()
  const thumbs = new Set<PDFRef>()
  for (const [, obj] of objects) {
    const d = obj instanceof PDFRawStream ? obj.dict : obj instanceof PDFDict ? obj : undefined
    if (!d) continue
    for (const k of ['SMask', 'Mask']) {
      const v = d.get(N(k))
      if (v instanceof PDFRef) masks.add(v)
    }
    const t = d.get(N('Thumb'))
    if (t instanceof PDFRef) thumbs.add(t)
  }
  const out: PdfImage[] = []
  for (const [ref, obj] of objects) {
    if (!(obj instanceof PDFRawStream) || obj.dict.get(N('Subtype')) !== N('Image')) continue
    const d = obj.dict
    const filters = filtersOf(doc, d)
    const im: PdfImage = {
      ref,
      stream: obj,
      width: num(doc, d.get(N('Width'))) ?? 0,
      height: num(doc, d.get(N('Height'))) ?? 0,
      bpc: num(doc, d.get(N('BitsPerComponent'))) ?? 0,
      filters,
      colour: colourOf(doc, d.get(N('ColorSpace'))),
      bytes: obj.contents.length,
      maskBytes: 0,
    }
    const smask = ctx.lookup(d.get(N('SMask')))
    if (smask instanceof PDFRawStream) im.maskBytes = smask.contents.length
    if (im.colour.kind === 'cmyk' && filters[filters.length - 1] === 'DCTDecode') im.cmyk = cmykOf(doc, im)
    im.skip = verdict(doc, im, masks, thumbs, smask)
    if (!im.skip) im.source = filters[filters.length - 1] === 'DCTDecode' ? 'jpeg' : 'pixels'
    out.push(im)
  }
  return out
}

function verdict(doc: PDFDocument, im: PdfImage, masks: Set<PDFRef>, thumbs: Set<PDFRef>, smask: PDFObject | undefined): Skip | undefined {
  const d = im.stream.dict
  if (masks.has(im.ref)) return 'mask'
  if (thumbs.has(im.ref)) return 'thumb'
  const stencil = doc.context.lookup(d.get(N('ImageMask')))
  if (stencil instanceof PDFBool && stencil.asBoolean()) return 'stencil'
  const last = im.filters[im.filters.length - 1]
  if (last === 'JPXDecode') return 'jpx'
  if (last === 'JBIG2Decode' || last === 'CCITTFaxDecode') return 'bw'
  const jpeg = last === 'DCTDecode'
  const before = jpeg ? im.filters.slice(0, -1) : im.filters
  if (!before.every((f) => UNDOABLE.has(f))) return 'filter'
  if (jpeg) {
    const parms = doc.context.lookup(d.get(N('DecodeParms')))
    const dct = parms instanceof PDFArray ? doc.context.lookup(parms.get(parms.size() - 1)) : parms
    if (dct instanceof PDFDict && dct.has(N('ColorTransform'))) return 'filter'
  }
  if (!(im.width > 0 && im.height > 0)) return 'broken'
  const c = im.colour
  if ((c.kind === 'cmyk' && !im.cmyk?.convert) || (c.kind === 'indexed' && c.base?.kind === 'cmyk')) return 'cmyk'
  if (c.kind === 'other' || (c.kind === 'indexed' && c.base?.kind !== 'gray' && c.base?.kind !== 'rgb')) return 'colour'
  if (jpeg ? im.bpc !== 8 || c.kind === 'indexed' : ![1, 2, 4, 8].includes(im.bpc)) return im.bpc === 16 ? 'bits' : 'broken'
  const decode = doc.context.lookup(d.get(N('Decode')))
  if (decode instanceof PDFArray && !im.cmyk?.convert) {
    const v = decode.asArray().map((x) => num(doc, x))
    const top = c.kind === 'indexed' ? (1 << im.bpc) - 1 : 1
    if (!v.every((x, i) => x === (i % 2 ? top : 0))) return 'decode'
  }
  if (doc.context.lookup(d.get(N('Mask'))) instanceof PDFArray) return 'colour-key'
  if (smask instanceof PDFRawStream && smask.dict.has(N('Matte'))) return 'matte'
  if (im.width * im.height > MAX_PIXELS) return 'big'
  if (im.bytes < SMALL) return 'small'
  return undefined
}

/**
 * The transform byte of a JPEG's Adobe marker (APP14): 0 plain (CMYK), 1
 * YCbCr, 2 YCCK. Undefined when it has none. Only the headers are read.
 */
export function adobeTransform(b: Uint8Array): number | undefined {
  if (b[0] !== 0xff || b[1] !== 0xd8) return undefined
  let i = 2
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return undefined
    const m = b[i + 1]
    if (m === 0xff) {
      i++
      continue
    }
    if (m === 0xda || m === 0xd9) return undefined // the picture itself starts: no marker came before it
    const n = (b[i + 2] << 8) | b[i + 3]
    if (m === 0xee && n >= 14 && String.fromCharCode(...b.subarray(i + 4, i + 9)) === 'Adobe') return b[i + 4 + 11]
    i += 2 + n
  }
  return undefined
}

function cmykOf(doc: PDFDocument, im: PdfImage): PdfImage['cmyk'] {
  const decode = doc.context.lookup(im.stream.dict.get(N('Decode')))
  const values = decode instanceof PDFArray ? decode.asArray().map((x) => num(doc, x)) : undefined
  const kind = !values ? 'none' : values.length === 8 && values.every((v, i) => v === (i % 2 ? 0 : 1)) ? 'inverted' : 'other'
  let adobe: number | undefined
  try {
    adobe = adobeTransform(undoFilters(doc, { ...im, source: 'jpeg' }))
  } catch {
    adobe = undefined
  }
  return { adobe, decode: kind, convert: adobe !== undefined && adobe !== 1 && kind === 'inverted' }
}

// --- Raw pixels ------------------------------------------------------------------------

/** The stored bytes with every compression before the picture itself undone (all of them for raw pixels). */
export function undoFilters(doc: PDFDocument, im: Pick<PdfImage, 'stream' | 'filters' | 'source'>): Uint8Array {
  const d = im.stream.dict
  const keep = im.source === 'jpeg' ? im.filters.length - 1 : im.filters.length
  if (keep === 0) return im.stream.contents
  const f = doc.context.lookup(d.get(N('Filter')))
  const p = doc.context.lookup(d.get(N('DecodeParms')))
  const tmp = PDFDict.withContext(doc.context)
  if (f instanceof PDFArray) {
    tmp.set(N('Filter'), doc.context.obj(f.asArray().slice(0, keep)))
    if (p instanceof PDFArray) tmp.set(N('DecodeParms'), doc.context.obj(p.asArray().slice(0, keep)))
  } else if (f) {
    tmp.set(N('Filter'), f)
    if (p) tmp.set(N('DecodeParms'), p)
  }
  const data = decodePDFRawStream(PDFRawStream.of(tmp, im.stream.contents)).decode()
  if (im.source === 'jpeg') return data
  // The predictor belongs to the last compression.
  const parms = p instanceof PDFArray ? doc.context.lookup(p.get(keep - 1)) : p
  if (!(parms instanceof PDFDict)) return data
  const predictor = num(doc, parms.get(N('Predictor'))) ?? 1
  if (predictor === 1) return data
  return unpredict(data, {
    predictor,
    colors: num(doc, parms.get(N('Colors'))) ?? 1,
    bpc: num(doc, parms.get(N('BitsPerComponent'))) ?? 8,
    columns: num(doc, parms.get(N('Columns'))) ?? 1,
  })
}

export interface Predictor {
  predictor: number
  colors: number
  bpc: number
  columns: number
}

/** Undoes a PNG (10-15) or TIFF (2) predictor. */
export function unpredict(data: Uint8Array, p: Predictor): Uint8Array {
  const rowBytes = Math.ceil((p.colors * p.bpc * p.columns) / 8)
  const bpp = Math.max(1, Math.ceil((p.colors * p.bpc) / 8))
  if (p.predictor === 2) {
    if (p.bpc !== 8) throw new Error('TIFF predictor with other than 8 bits')
    const out = data.slice()
    for (let row = 0; row + rowBytes <= out.length; row += rowBytes)
      for (let i = row + p.colors; i < row + rowBytes; i++) out[i] = (out[i] + out[i - p.colors]) & 255
    return out
  }
  if (p.predictor < 10) throw new Error(`predictor ${p.predictor}`)
  const rows = Math.floor(data.length / (rowBytes + 1))
  const out = new Uint8Array(rows * rowBytes)
  for (let r = 0; r < rows; r++) {
    const type = data[r * (rowBytes + 1)]
    const src = r * (rowBytes + 1) + 1
    const at = r * rowBytes
    const up = at - rowBytes
    for (let i = 0; i < rowBytes; i++) {
      const raw = data[src + i]
      const a = i >= bpp ? out[at + i - bpp] : 0
      const b = r > 0 ? out[up + i] : 0
      const c = r > 0 && i >= bpp ? out[up + i - bpp] : 0
      let v: number
      if (type === 0) v = raw
      else if (type === 1) v = raw + a
      else if (type === 2) v = raw + b
      else if (type === 3) v = raw + ((a + b) >> 1)
      else if (type === 4) {
        const pa = Math.abs(b - c)
        const pb = Math.abs(a - c)
        const pc = Math.abs(a + b - 2 * c)
        v = raw + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)
      } else throw new Error(`PNG filter ${type}`)
      out[at + i] = v & 255
    }
  }
  return out
}

/**
 * PNG predictors for a lossless picture (Flate with /Predictor 15): each row
 * stored as its difference from its neighbours, which compresses better. For
 * each row, whichever of None, Sub, Up, Average and Paeth gives the smallest
 * sum of differences (libpng's guess at what compresses best). 8 bits a
 * component; undone by unpredict.
 */
export function predictRows(raw: Uint8Array, columns: number, colors: number): Uint8Array {
  const rowBytes = columns * colors
  const rows = Math.floor(raw.length / rowBytes)
  const out = new Uint8Array(rows * (rowBytes + 1))
  const guess = (type: number, at: number, i: number, first: boolean) => {
    const a = i >= colors ? raw[at + i - colors] : 0
    const b = first ? 0 : raw[at + i - rowBytes]
    if (type === 1) return a
    if (type === 2) return b
    if (type === 3) return (a + b) >> 1
    if (type === 4) {
      const c = !first && i >= colors ? raw[at + i - rowBytes - colors] : 0
      const pa = Math.abs(b - c)
      const pb = Math.abs(a - c)
      const pc = Math.abs(a + b - 2 * c)
      return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
    }
    return 0
  }
  for (let r = 0; r < rows; r++) {
    const at = r * rowBytes
    const first = r === 0
    let best = 0
    let bestSum = Infinity
    for (let type = 0; type < 5; type++) {
      let sum = 0
      for (let i = 0; i < rowBytes && sum < bestSum; i++) {
        const v = (raw[at + i] - guess(type, at, i, first)) & 255
        sum += v < 128 ? v : 256 - v
      }
      if (sum < bestSum) {
        bestSum = sum
        best = type
      }
    }
    const o = r * (rowBytes + 1)
    out[o] = best
    for (let i = 0; i < rowBytes; i++) out[o + 1 + i] = (raw[at + i] - guess(best, at, i, first)) & 255
  }
  return out
}

/**
 * Raw pixels as RGBA, opaque (a picture's transparency is a separate
 * picture). Grey, RGB and indexed, 1, 2, 4 or 8 bits. Rows short of data are
 * left black, as PDF readers do.
 */
export function toRgba(data: Uint8Array, im: Pick<PdfImage, 'width' | 'height' | 'bpc' | 'colour'>): Uint8ClampedArray<ArrayBuffer> {
  const { width: w, height: h, bpc, colour: c } = im
  const n = c.kind === 'indexed' ? 1 : c.n
  const rowBytes = Math.ceil((n * bpc * w) / 8)
  const out = new Uint8ClampedArray(w * h * 4)
  const max = (1 << bpc) - 1
  const sample = (row: number, k: number) => {
    if (bpc === 8) return data[row + k] ?? 0
    const bit = k * bpc
    const byte = data[row + (bit >> 3)] ?? 0
    return (byte >> (8 - bpc - (bit & 7))) & max
  }
  const pal = c.palette
  const baseN = c.base?.n ?? 1
  for (let y = 0; y < h; y++) {
    const row = y * rowBytes
    let o = y * w * 4
    for (let x = 0; x < w; x++, o += 4) {
      if (c.kind === 'indexed') {
        const idx = Math.min(sample(row, x), c.hival ?? 0) * baseN
        if (baseN === 1) out[o] = out[o + 1] = out[o + 2] = pal![idx] ?? 0
        else {
          out[o] = pal![idx] ?? 0
          out[o + 1] = pal![idx + 1] ?? 0
          out[o + 2] = pal![idx + 2] ?? 0
        }
      } else if (n === 1) {
        out[o] = out[o + 1] = out[o + 2] = bpc === 8 ? sample(row, x) : Math.round((sample(row, x) * 255) / max)
      } else {
        const k = x * 3
        if (bpc === 8) {
          out[o] = data[row + k] ?? 0
          out[o + 1] = data[row + k + 1] ?? 0
          out[o + 2] = data[row + k + 2] ?? 0
        } else
          for (let j = 0; j < 3; j++) out[o + j] = Math.round((sample(row, k + j) * 255) / max)
      }
      out[o + 3] = 255
    }
  }
  return out
}
