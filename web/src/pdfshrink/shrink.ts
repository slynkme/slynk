// Makes a PDF smaller by making the pictures inside it smaller, in this
// browser, in a worker (docshrink/session.ts). Nothing else on the pages changes:
// text, fonts, links and layout stay as they are, and a picture keeps its
// place and size on the page, with fewer pixels.
//
//   1. Tidy, losslessly: drop what nothing uses any more (old revisions),
//      keep one copy of anything stored twice, and compress anything stored
//      uncompressed or in an older, bulkier way. If that fits, it's done.
//   2. Measure each picture that can be made smaller (images.ts) at the top
//      and bottom of the ladder (plan.ts), decoding it once.
//   3. Choose the first level predicted to fit, make the pictures, save, and
//      check; a step further down if it came out over.
//
// Sizes can be counted as the PDF is sent (Options.compressed): deflated, as
// Slynk compresses a file (compress.ts). Each new picture is deflated as it's
// measured, so a PDF of screenshots, whose JPEGs deflate by a seventh, is made
// for its share as it will go, not as it's saved.
//
// Photos become JPEGs; drawings and screenshots stored as raw pixels stay
// lossless (Flate) at fewer pixels, and become JPEGs too only when the PDF
// can't fit otherwise. A new picture replaces the old only when
// it saves at least 5%. Signed and encrypted PDFs are never touched.
import { deflate as deflateRaw, sentSize } from '../compress.ts'
import { EncryptedPDFError, PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, type PDFObject, PDFRawStream, PDFRef, PDFStreamWriter, PDFWriter, decodePDFRawStream } from 'pdf-lib'
import { barePicture } from '../shrink/bare.ts'
import { type Dims, Q_MAX, fitDims } from '../shrink/plan.ts'
import { indexOf, latin1 } from '../strip/bytes.ts'
import { looksSigned, reachable } from '../strip/pdf.ts'
import { type CanvasCheck, checkOffscreen } from './canvasCheck.ts'
import { type PdfImage, type Skip, findImages, predictRows, toRgba, undoFilters } from './images.ts'
import { type Shown, placements } from './place.ts'
import { GRAPHIC_FLOOR, type Level, MARGIN, type Measure, PPI_FLOOR, WORTH, chosen, dimsAt, fillPage, ladder, ppiOf, predict } from './plan.ts'

export interface Options {
  /** Bytes the PDF must fit in. */
  target: number
  /** Allow quality below 70%, down to 40%. */
  lower: boolean
  /** target counts the PDF as it's sent, deflated (compress.ts), not as it's saved. */
  compressed?: boolean
}

export type Stage = 'reading' | 'tidying' | 'measuring' | 'making' | 'saving'

export interface ImageLine {
  n: number
  pages: number[]
  width: number
  height: number
  bpc: number
  filter: string
  colour: string
  bytes: number
  maskBytes: number
  /** Pixels per inch where it's shown largest. */
  ppi?: number
  placed: boolean
  kind?: 'photo' | 'graphic'
  skip?: Skip
  /** What it became, when it changed. */
  out?: { width: number; height: number; as: 'jpeg' | 'flate'; quality?: number; bytes: number; ppi: number }
  /** Measured, but its own was kept: a new one wasn't smaller enough. */
  kept?: boolean
  error?: string
  /** For a CMYK JPEG: how its colours are stored (images.ts), and whether it was clear enough to convert. */
  cmyk?: string
}

export interface Report {
  source: { bytes: number; pages: number; header: string; objects: number; objectStreams: boolean; revisions: number; pdfa?: string }
  /** Stored bytes by what they are. */
  where: Where
  leftovers: { objects: number; bytes: number }
  /** Copies of the same thing stored more than once, now stored once. */
  merged: { objects: number; bytes: number }
  packed: { streams: number; saved: number }
  inline: number
  unreadPages: number
  resaved?: number
  images: ImageLine[]
  /**
   * Each level's predicted bytes, and the made PDF's at the level tried: as it's sent when
   * compressed, else as it's saved. file: as it's saved. exact: made and measured, not predicted.
   */
  levels: { ppi: number; quality: number; predicted: number; file: number; exact?: boolean; actual?: number }[]
  level?: Level
  output?: number
  /** Sizes counted as the PDF is sent, deflated (Options.compressed, when the PDF deflates at all). */
  compressed?: boolean
  /** The output's bytes as it's sent. */
  sent?: number
  outcome?: 'fits-already' | 'tidied' | 'shrunk' | 'no-fit'
  /** Whether this browser draws and reads back pictures as drawn (canvasCheck.ts), in the worker. */
  canvas?: CanvasCheck
  ms: Record<Stage | 'total', number>
}

export interface Where {
  pictures: number
  masks: number
  fonts: number
  /** Each page's own drawing: text, lines, shapes. */
  pages: number
  /** Drawings shared between pages or placed as one piece (forms), and patterns and shadings. */
  forms: number
  /** Colour profiles (ICC), for pictures and for printing. */
  profiles: number
  /** XMP metadata: details about the document or a picture. */
  metadata: number
  /** Files attached to the PDF. */
  attachments: number
  other: number
}

export interface Thumb {
  n: number
  before?: ImageBitmap
  after?: ImageBitmap
}

export type Reason = 'signed' | 'encrypted' | 'unreadable' | 'canvas' | 'stopped'
export class ShrinkError extends Error {
  readonly reason: Reason
  readonly report?: Report
  // Written out rather than as parameter properties, so Node's tests can load this file.
  constructor(reason: Reason, report?: Report) {
    super(reason)
    this.reason = reason
    this.report = report
  }
}

export interface Hooks {
  progress(stage: Stage, done: number): void
  stopped(): boolean
}

const N = (s: string) => PDFName.of(s)
const LOAD = { updateMetadata: false, ignoreEncryption: false, throwOnInvalidObject: true, parseSpeed: Infinity }
/** A replaced picture's dictionary grows a little. */
const DICT_BYTES = 40
const THUMB_EDGE = 320
const OBJECTS_PER_STREAM = 400
/** Raw pixels stay lossless unless a JPEG is at most this share of the lossless picture's bytes. */
const PHOTO_SHARE = 0.5
const MAX_THUMBS = 30

// --- Drawing, as photos do (shrink/draw.ts), on canvases a worker can use ----------------

function canvas(d: Dims): OffscreenCanvas {
  return new OffscreenCanvas(d.width, d.height)
}

function release(c: OffscreenCanvas) {
  c.width = 0
  c.height = 0
}

function ctx2d(c: OffscreenCanvas): OffscreenCanvasRenderingContext2D {
  const x = c.getContext('2d')
  if (!x) throw new Error('no 2D canvas')
  x.imageSmoothingEnabled = true
  x.imageSmoothingQuality = 'high'
  return x
}

/** Draws src at the given size, halving in steps first (one big step turns fine detail into stripes in Firefox). */
function drawAt(src: ImageBitmap | OffscreenCanvas, to: Dims): OffscreenCanvas {
  let from: ImageBitmap | OffscreenCanvas = src
  let step: OffscreenCanvas | undefined
  const next = (d: Dims) => {
    const c = canvas(d)
    ctx2d(c).drawImage(from, 0, 0, d.width, d.height)
    if (step) release(step)
    step = c
    from = c
  }
  while (from.width >= to.width * 4 && from.height >= to.height * 4) next({ width: Math.round(from.width / 2), height: Math.round(from.height / 2) })
  if (from.width >= to.width * 2 && from.height >= to.height * 2) next({ width: to.width * 2, height: to.height * 2 })
  const out = canvas(to)
  ctx2d(out).drawImage(from, 0, 0, to.width, to.height)
  if (step) release(step)
  return out
}

async function jpeg(c: OffscreenCanvas, quality: number): Promise<Uint8Array> {
  const blob = await c.convertToBlob({ type: 'image/jpeg', quality })
  if (blob.type !== 'image/jpeg') throw new Error('this browser saved no JPEG')
  return barePicture(new Uint8Array(await blob.arrayBuffer()), 'image/jpeg')
}

async function deflate(b: Uint8Array): Promise<Uint8Array> {
  const s = new Blob([b as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'))
  return new Uint8Array(await new Response(s).arrayBuffer())
}

/** Lossless: the canvas's pixels, grey or RGB, with PNG predictors, compressed as Flate (see replacement). */
async function flate(c: OffscreenCanvas, channels: 1 | 3): Promise<Uint8Array> {
  const px = ctx2d(c).getImageData(0, 0, c.width, c.height).data
  const raw = new Uint8Array(c.width * c.height * channels)
  for (let i = 0, o = 0; i < px.length; i += 4) {
    raw[o++] = px[i]
    if (channels === 3) {
      raw[o++] = px[i + 1]
      raw[o++] = px[i + 2]
    }
  }
  return deflate(predictRows(raw, c.width, channels))
}

function thumb(src: ImageBitmap | OffscreenCanvas): ImageBitmap {
  const c = drawAt(src, fitDims(src, THUMB_EDGE))
  return c.transferToImageBitmap()
}

/** Opens a picture as the browser's own bitmap, colours as stored (no profile applied: the PDF's colour space says what they mean). */
async function open(doc: PDFDocument, im: PdfImage): Promise<ImageBitmap> {
  const data = undoFilters(doc, im)
  let bitmap: ImageBitmap
  if (im.source === 'jpeg') {
    // Print colours: the browser converts them to screen colours, using the JPEG's own colour profile if it has one.
    const colorSpaceConversion = im.colour.kind === 'cmyk' ? 'default' : 'none'
    bitmap = await createImageBitmap(new Blob([data as BlobPart], { type: 'image/jpeg' }), { colorSpaceConversion })
  } else {
    bitmap = await createImageBitmap(new ImageData(toRgba(data, im), im.width, im.height), { colorSpaceConversion: 'none' })
  }
  if (bitmap.width !== im.width || bitmap.height !== im.height) {
    bitmap.close()
    throw new Error(`the picture is ${bitmap.width}×${bitmap.height}, its dictionary says ${im.width}×${im.height}`)
  }
  return bitmap
}

// --- The PDF ---------------------------------------------------------------------------

function pdfaPart(doc: PDFDocument): string | undefined {
  const m = doc.context.lookup(doc.catalog.get(N('Metadata')))
  if (!(m instanceof PDFRawStream) || m.dict.has(N('Filter'))) return undefined
  return /pdfaid:part\s*(?:=\s*["']|>)\s*(\d)/.exec(latin1(m.contents))?.[1]
}

/** As doc.save does (nothing to add or update here), with bigger object streams. */
async function save(doc: PDFDocument, pdfa?: string): Promise<Uint8Array> {
  await doc.flush()
  // PDF/A-1 forbids object streams. Bigger ones than pdf-lib's 50 objects
  // compress better: with 50, re-saving a PDF of 11,000 small objects made it
  // 3% bigger; with 400 it came out a little smaller than it was.
  const writer = pdfa === '1' ? PDFWriter.forContext(doc.context, Infinity) : PDFStreamWriter.forContext(doc.context, Infinity, true, OBJECTS_PER_STREAM)
  return writer.serializeToBuffer()
}

/** Stored bytes by what they are, for the report. (Exported for the tests, as are pack and merge.) */
export function where(doc: PDFDocument, images: PdfImage[]): Where {
  const ctx = doc.context
  const kinds = new Map<PDFRef, keyof Where>()
  for (const im of images) kinds.set(im.ref, im.skip === 'mask' ? 'masks' : 'pictures')
  const mark = (v: PDFObject | undefined, k: keyof Where) => {
    if (v instanceof PDFRef && !kinds.has(v)) kinds.set(v, k)
  }
  const visit = (o: PDFObject) => {
    if (o instanceof PDFArray) {
      if (o.get(0) === N('ICCBased')) mark(o.get(1), 'profiles')
      for (const v of o.asArray()) if (v instanceof PDFArray || v instanceof PDFDict) visit(v)
      return
    }
    if (!(o instanceof PDFDict)) return
    const type = o.get(N('Type'))
    if (type === N('FontDescriptor')) for (const k of ['FontFile', 'FontFile2', 'FontFile3', 'CIDSet']) mark(o.get(N(k)), 'fonts')
    if (type === N('Font')) for (const k of ['ToUnicode', 'CIDToGIDMap', 'Encoding']) mark(o.get(N(k)), 'fonts')
    if (type === N('Page')) {
      const c = o.get(N('Contents'))
      for (const r of c instanceof PDFArray ? c.asArray() : [c]) mark(r, 'pages')
    }
    mark(o.get(N('DestOutputProfile')), 'profiles')
    for (const [, v] of o.entries()) if (v instanceof PDFArray || v instanceof PDFDict) visit(v)
  }
  for (const [, obj] of ctx.enumerateIndirectObjects()) visit(obj instanceof PDFRawStream ? obj.dict : obj)
  const out: Where = { pictures: 0, masks: 0, fonts: 0, pages: 0, forms: 0, profiles: 0, metadata: 0, attachments: 0, other: 0 }
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue
    const d = obj.dict
    const k =
      kinds.get(ref) ??
      (d.get(N('Type')) === N('Metadata')
        ? 'metadata'
        : d.get(N('Type')) === N('EmbeddedFile')
          ? 'attachments'
          : d.get(N('Type')) === N('CMap')
            ? 'fonts'
            : d.get(N('Subtype')) === N('Form') || d.has(N('PatternType')) || d.has(N('ShadingType'))
              ? 'forms'
              : 'other')
    out[k] += obj.contents.length
  }
  return out
}

/**
 * Drops what nothing uses any more: old revisions and what they replaced,
 * and (before saving) what the old pictures used alone. Returns what went,
 * to put back if a try is undone.
 */
function sweep(doc: PDFDocument): [PDFRef, PDFObject][] {
  const ctx = doc.context
  // Lengths are written inline on save, so an indirect /Length would be left over: inline them first.
  for (const [, obj] of ctx.enumerateIndirectObjects()) if (obj instanceof PDFRawStream) obj.updateDict()
  const keep = reachable(doc, [ctx.trailerInfo.Root, ctx.trailerInfo.Info])
  const gone = ctx.enumerateIndirectObjects().filter(([ref]) => !keep.has(ref))
  for (const [ref] of gone) ctx.delete(ref)
  ctx.largestObjectNumber = ctx.enumerateIndirectObjects().reduce((n, [ref]) => Math.max(n, ref.objectNumber), 0)
  return gone
}

function dropLeftovers(doc: PDFDocument): Report['leftovers'] {
  let objects = 0
  let bytes = 0
  for (const [, obj] of sweep(doc)) {
    // Cross-reference and object streams are rewritten anyway: not leftovers.
    const d = obj instanceof PDFRawStream ? obj.dict : undefined
    if (d?.get(N('Type')) === N('XRef') || d?.get(N('Type')) === N('ObjStm')) continue
    objects++
    if (obj instanceof PDFRawStream) bytes += obj.contents.length
  }
  return { objects, bytes }
}

const ASCII = new Set(['ASCIIHexDecode', 'ASCII85Decode', 'AHx', 'A85'])
const OLD = new Set(['LZWDecode', 'RunLengthDecode', 'LZW', 'RL'])

/**
 * Compresses what's stored uncompressed (not XMP, which PDF/A wants
 * readable), takes off ASCII wrappings (which make a stream a quarter to
 * twice as big, to survive old email), and stores LZW and RunLength streams
 * as Flate, which is smaller. Kept only when smaller.
 */
export async function pack(doc: PDFDocument): Promise<Report['packed']> {
  const ctx = doc.context
  let streams = 0
  let saved = 0
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream) || obj.contents.length < 1024) continue
    const d = obj.dict
    if (d.get(N('Type')) === N('Metadata')) continue
    const f = ctx.lookup(d.get(N('Filter')))
    const p = ctx.lookup(d.get(N('DecodeParms')))
    const names = (f instanceof PDFName ? [f] : f instanceof PDFArray ? f.asArray().map((x) => ctx.lookup(x)) : []).map((x) => (x instanceof PDFName ? x.decodeText() : '?'))
    const parms = names.map((_, i) => (p instanceof PDFArray ? p.get(i) : i === 0 ? p : undefined))
    // How many filters from the start to undo: the ASCII wrappings, then an LZW or RunLength under them.
    let undo = 0
    while (undo < names.length && ASCII.has(names[undo])) undo++
    const old = undo < names.length && OLD.has(names[undo]) && undo === names.length - 1
    if (old) undo++
    if (!names.length && (d.has(N('DecodeParms')) || d.has(N('Filter')))) continue
    if (names.length && !undo) continue
    let data: Uint8Array
    try {
      const tmp = PDFDict.withContext(ctx)
      if (undo) {
        tmp.set(N('Filter'), ctx.obj(names.slice(0, undo).map((n) => N(n))))
        tmp.set(N('DecodeParms'), ctx.obj(parms.slice(0, undo).map((x) => x ?? ctx.obj(null as never))))
      }
      data = undo ? decodePDFRawStream(PDFRawStream.of(tmp, obj.contents)).decode() : obj.contents
    } catch {
      continue
    }
    // What's left: nothing (then Flate), or the filters under the ASCII wrappings, as they were.
    let rest = names.slice(undo)
    let restParms = parms.slice(undo)
    if (!rest.length || old) {
      data = await deflate(data)
      rest = ['FlateDecode']
      // An LZW stream's predictor (DecodeParms) carries over: Flate takes the same one.
      const lzw = old ? ctx.lookup(parms[names.length - 1]) : undefined
      const kept = lzw instanceof PDFDict ? lzw.clone(ctx) : undefined
      kept?.delete(N('EarlyChange'))
      restParms = [kept]
    }
    if (data.length > obj.contents.length * 0.9 || obj.contents.length - data.length < 256) continue
    const dict = d.clone(ctx)
    dict.delete(N('Filter'))
    dict.delete(N('DecodeParms'))
    dict.set(N('Filter'), rest.length === 1 ? N(rest[0]) : ctx.obj(rest.map((n) => N(n))))
    if (restParms.some((x) => x)) dict.set(N('DecodeParms'), rest.length === 1 ? restParms[0]! : ctx.obj(restParms.map((x) => x ?? ctx.obj(null as never))))
    ctx.assign(ref, PDFRawStream.of(dict, data))
    streams++
    saved += obj.contents.length - data.length
  }
  return { streams, saved }
}

async function digest(b: Uint8Array): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource))
  return [...h].map((v) => v.toString(16).padStart(2, '0')).join('')
}

/**
 * Keeps one copy of any stream stored more than once with the same
 * dictionary (PDFs put together from others often carry the same font or
 * picture twice), and points every reference at it. Sharing is what PDF's
 * references are for, so nothing that's shown changes.
 */
export async function merge(doc: PDFDocument): Promise<Report['merged']> {
  const ctx = doc.context
  const byLength = new Map<number, [PDFRef, PDFRawStream][]>()
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream) || obj.contents.length < 256) continue
    const list = byLength.get(obj.contents.length) ?? []
    list.push([ref, obj])
    byLength.set(obj.contents.length, list)
  }
  const same = new Map<PDFRef, PDFRef>()
  let bytes = 0
  for (const list of byLength.values()) {
    if (list.length < 2) continue
    const seen = new Map<string, PDFRef>()
    for (const [ref, obj] of list) {
      const dict = obj.dict.clone(ctx)
      dict.delete(N('Length'))
      const id = `${dict.toString()}\n${await digest(obj.contents)}`
      const first = seen.get(id)
      if (first) {
        same.set(ref, first)
        bytes += obj.contents.length
      } else seen.set(id, ref)
    }
  }
  if (!same.size) return { objects: 0, bytes: 0 }
  const fix = (o: PDFObject) => {
    if (o instanceof PDFRawStream) fix(o.dict)
    else if (o instanceof PDFDict) {
      for (const [k, v] of o.entries()) {
        if (v instanceof PDFRef && same.has(v)) o.set(k, same.get(v)!)
        else if (v instanceof PDFDict || v instanceof PDFArray) fix(v)
      }
    } else if (o instanceof PDFArray) {
      for (let i = 0; i < o.size(); i++) {
        const v = o.get(i)
        if (v instanceof PDFRef && same.has(v)) o.set(i, same.get(v)!)
        else if (v instanceof PDFDict || v instanceof PDFArray) fix(v)
      }
    }
  }
  for (const [, obj] of ctx.enumerateIndirectObjects()) fix(obj)
  sweep(doc)
  return { objects: same.size, bytes }
}

/**
 * The new picture's stream: the old dictionary with the new size, compression
 * and colours. The old picture's own XMP goes: it described the original (its
 * camera, its place), not the new picture, which holds no hidden details.
 */
function replacement(doc: PDFDocument, im: PdfImage, bytes: Uint8Array, d: Dims, as: 'jpeg' | 'flate'): PDFRawStream {
  const ctx = doc.context
  const dict = im.stream.dict.clone(ctx)
  for (const k of ['Filter', 'DecodeParms', 'Decode', 'Length', 'Width', 'Height', 'BitsPerComponent', 'ColorSpace', 'Metadata']) dict.delete(N(k))
  dict.set(N('Width'), PDFNumber.of(d.width))
  dict.set(N('Height'), PDFNumber.of(d.height))
  dict.set(N('BitsPerComponent'), PDFNumber.of(8))
  dict.set(N('Filter'), N(as === 'jpeg' ? 'DCTDecode' : 'FlateDecode'))
  if (as === 'flate') dict.set(N('DecodeParms'), ctx.obj({ Predictor: 15, Colors: channelsOf(im), BitsPerComponent: 8, Columns: d.width }))
  dict.set(N('ColorSpace'), colourFor(doc, im, as))
  return PDFRawStream.of(dict, bytes)
}

/** Its own colour space where the new picture keeps it, or the palette's base, or RGB for a grey JPEG (a canvas only saves colour ones). */
function colourFor(doc: PDFDocument, im: PdfImage, as: 'jpeg' | 'flate'): PDFObject {
  const cs = im.stream.dict.get(N('ColorSpace'))!
  const own = im.colour.kind === 'indexed' ? (doc.context.lookup(cs) as PDFArray).get(1) : cs
  const grey = (im.colour.kind === 'indexed' ? im.colour.base?.kind : im.colour.kind) === 'gray'
  // Print colours become screen colours: the browser converted them when it opened the picture.
  return (grey && as === 'jpeg') || im.colour.kind === 'cmyk' ? N('DeviceRGB') : own
}

const channelsOf = (im: PdfImage): 1 | 3 => ((im.colour.kind === 'indexed' ? im.colour.base?.kind : im.colour.kind) === 'gray' ? 1 : 3)

// --- Making it smaller ---------------------------------------------------------------

type As = 'jpeg' | 'flate'

interface Candidate {
  im: PdfImage
  line: ImageLine
  dims: Dims
  shown: Pick<Shown, 'w' | 'h'>
  kind: 'photo' | 'graphic'
  /** Sizes measured, by how they were saved (a lossless one's quality is Q_MAX). */
  seen: Record<As, Measure[]>
  /** Pictures made while measuring, by key(), kept if they could be used. */
  made: Map<string, Uint8Array>
  /** Its own bytes deflated, when sizes are counted as sent. */
  ownSent: number
}

/** A way to make a picture: its size, how it's saved, at what quality. */
interface Way {
  dims: Dims
  as: As
  quality: number
}

const key = (w: Way) => `${w.as}:${w.dims.width}×${w.dims.height}@${w.quality}`
const pixels = (d: Dims) => d.width * d.height

/**
 * The ways a candidate can be made at a level (none: it keeps its own). A
 * photo becomes a JPEG. A drawing or screenshot stays lossless down to
 * GRAPHIC_FLOOR; further down the ladder, which is only reached when the PDF
 * doesn't fit otherwise, it may have fewer pixels or become a JPEG, whichever
 * is smallest: soft edges are better than not fitting at all.
 */
function ways(c: Candidate, l: Level): Way[] {
  const out: Way[] = []
  const dims = dimsAt(c.dims, c.shown, l.ppi)
  if (c.kind === 'graphic') {
    const floor = dimsAt(c.dims, c.shown, Math.max(l.ppi, GRAPHIC_FLOOR))
    out.push({ dims: floor, as: 'flate', quality: Q_MAX })
    if (l.ppi >= GRAPHIC_FLOOR && l.quality === Q_MAX) return out
    if (dims.width !== floor.width) out.push({ dims, as: 'flate', quality: Q_MAX })
  }
  const same = dims.width === c.dims.width && dims.height === c.dims.height
  // A JPEG at its own size is only saved again once the quality comes down: each save loses a little.
  if (!(same && c.im.source === 'jpeg' && l.quality === Q_MAX)) out.push({ dims, as: 'jpeg', quality: l.quality })
  return out
}

/** The way that comes out smallest at a level, by what was measured, and its bytes. */
function best(c: Candidate, l: Level): { way: Way; bytes: number } | undefined {
  let found: { way: Way; bytes: number } | undefined
  for (const way of ways(c, l)) {
    const bytes = predict(c.seen[way.as], pixels(way.dims), way.quality)
    if (bytes !== undefined && (!found || bytes < found.bytes)) found = { way, bytes }
  }
  return found
}

function sizeAt(c: Candidate, l: Level): number {
  return chosen(c.im.bytes, best(c, l)?.bytes)
}

/** As sizeAt, deflated: its own, or the new picture's, as sizeAt chooses. */
function sentAt(c: Candidate, l: Level): number {
  const pick = best(c, l)
  if (!pick || chosen(c.im.bytes, pick.bytes) === c.im.bytes) return c.ownSent
  return predict(c.seen[pick.way.as], pixels(pick.way.dims), pick.way.quality, 'sent') ?? pick.bytes
}

/** Bytes deflated, never more than they are: a share of a whole that's deflated together. */
const deflatedLength = async (b: Uint8Array) => Math.min(b.length, (await deflateRaw(b)).length)

// --- Read, measure, make ------------------------------------------------------------------
// In three calls, so the composer can measure a PDF once and make it again for
// a different share of the space in seconds (docshrink/session.ts).

/** A PDF read and tidied, then measured: what making it for a size works from. */
export interface PdfSession {
  doc: PDFDocument
  pdfa?: string
  report: Report
  thumbs: Thumb[]
  keepThumbs: boolean
  placed: ReturnType<typeof placements>
  images: PdfImage[]
  /** The PDF tidied losslessly and saved (tidyPdf). */
  tidied?: Uint8Array
  /**
   * Sizes are counted as it's sent (measurePdf): tidied's bytes then, and everything but the
   * candidates, deflated; and smallest, the PDF made at the lowest level and deflated for real.
   */
  sent?: { tidied: number; fixed: number; smallest?: Smallest }
  candidates: Candidate[]
  /** The ladder it was measured for (with the lower qualities, or not). */
  levels: Level[]
  lap(stage: Stage): void
  finish(): Report
}

/** Reads the PDF and tidies it losslessly in memory: what's left unused, stored twice or stored bulkily. */
export async function openPdf(input: Uint8Array, hooks: Hooks, keepThumbs = true): Promise<PdfSession> {
  const t0 = performance.now()
  const ms: Report['ms'] = { reading: 0, tidying: 0, measuring: 0, making: 0, saving: 0, total: 0 }
  let mark = t0
  const lap = (stage: Stage) => {
    const now = performance.now()
    ms[stage] += now - mark
    mark = now
  }
  hooks.progress('reading', 0)
  if (indexOf(input, '/ByteRange') !== -1 || indexOf(input, '/SigFlags') !== -1 || indexOf(input, '/Perms') !== -1) throw new ShrinkError('signed')
  if (indexOf(input, '/Encrypt') !== -1) throw new ShrinkError('encrypted')
  let doc: PDFDocument
  try {
    doc = await PDFDocument.load(input, LOAD)
  } catch (e) {
    throw new ShrinkError(e instanceof EncryptedPDFError ? 'encrypted' : 'unreadable')
  }
  if (doc.isEncrypted) throw new ShrinkError('encrypted')
  if (looksSigned(doc)) throw new ShrinkError('signed')
  const pdfa = pdfaPart(doc)
  let revisions = 0
  for (let at = indexOf(input, '%%EOF'); at !== -1; at = indexOf(input, '%%EOF', at + 5)) revisions++
  const report: Report = {
    source: {
      bytes: input.length,
      pages: doc.getPageCount(),
      header: /%PDF-(\d\.\d)/.exec(latin1(input, 0, 16))?.[1] ?? '?',
      objects: doc.context.enumerateIndirectObjects().length,
      objectStreams: indexOf(input, '/ObjStm') !== -1,
      revisions,
      pdfa,
    },
    where: { pictures: 0, masks: 0, fonts: 0, pages: 0, forms: 0, profiles: 0, metadata: 0, attachments: 0, other: 0 },
    leftovers: { objects: 0, bytes: 0 },
    merged: { objects: 0, bytes: 0 },
    packed: { streams: 0, saved: 0 },
    inline: 0,
    unreadPages: 0,
    images: [],
    levels: [],
    ms,
  }
  lap('reading')
  const finish = () => {
    ms.total = performance.now() - t0
    return report
  }

  // 1. Tidy, losslessly.
  hooks.progress('tidying', 0)
  let placed: ReturnType<typeof placements>
  try {
    report.leftovers = dropLeftovers(doc)
    report.packed = await pack(doc)
    report.merged = await merge(doc)
    placed = placements(doc)
  } catch (e) {
    throw Object.assign(e instanceof Error ? e : new Error(String(e)), { report: finish() })
  }
  report.inline = placed.inline
  report.unreadPages = placed.unread
  const images = findImages(doc)
  report.where = where(doc, images)
  images.forEach((im, i) => {
    const shown = placed.shown.get(im.ref)
    report.images.push({
      n: i + 1,
      pages: shown?.pages ?? [],
      width: im.width,
      height: im.height,
      bpc: im.bpc,
      filter: im.filters.join('+') || 'none',
      colour: im.colour.label,
      bytes: im.bytes,
      maskBytes: im.maskBytes,
      ppi: shown && im.width ? Math.round(ppiOf(im, shown)) : undefined,
      placed: !!shown,
      skip: im.skip,
      cmyk: im.cmyk
        ? `${im.cmyk.adobe === undefined ? 'no Adobe marker' : `Adobe marker, transform ${im.cmyk.adobe}`}, Decode ${im.cmyk.decode}${im.cmyk.convert ? ': converted to RGB' : ': unclear, left alone'}`
        : undefined,
    })
  })
  lap('tidying')
  return {
    doc,
    pdfa,
    report,
    thumbs: [],
    keepThumbs,
    placed,
    images,
    candidates: [],
    levels: [],
    lap,
    finish,
  }
}

/** Saves the tidied PDF: often smaller by itself. */
export async function tidyPdf(s: PdfSession): Promise<Uint8Array> {
  s.tidied = await save(s.doc, s.pdfa)
  s.report.resaved = s.tidied.length
  s.lap('tidying')
  return s.tidied
}

/**
 * Measures each picture that can be made smaller, decoding it once, at the top
 * and bottom of the ladder (with the lower qualities if lower). Pictures made
 * along the way are kept when they're no bigger than cap, to be used as they are.
 * compressed: sizes counted as the PDF is sent, if it's sent deflated at all.
 */
export async function measurePdf(s: PdfSession, lower: boolean, cap: number, hooks: Hooks, compressed = false): Promise<void> {
  const stop = () => {
    if (hooks.stopped()) throw new ShrinkError('stopped')
  }
  const { doc, report, placed, thumbs } = s
  const tidied = s.tidied ?? (await tidyPdf(s))
  // Sent as it is (nothing in it deflates, by compress.ts's samples): its bytes are its bytes.
  const whole = compressed ? await sentSize(tidied) : tidied.length
  const counted = whole < tidied.length
  stop()
  report.canvas = await checkOffscreen()
  if (!report.canvas.ok) throw new ShrinkError('canvas')

  // 2. Measure each picture, decoding it once.
  const levels = ladder(lower)
  const top = levels[0]
  const candidates: Candidate[] = []
  const work = s.images.map((im, i) => ({ im, line: report.images[i] })).filter(({ im }) => im.source && !im.skip)
  for (const [i, { im, line }] of work.entries()) {
    stop()
    hooks.progress('measuring', i / work.length)
    const dims = { width: im.width, height: im.height }
    const shown = placed.shown.get(im.ref) ?? fillPage(dims, placed.page)
    let bitmap: ImageBitmap
    try {
      bitmap = await open(doc, im)
    } catch (e) {
      line.error = e instanceof Error ? e.message : String(e)
      continue
    }
    const topDims = dimsAt(dims, shown, top.ppi)
    const base = drawAt(bitmap, topDims)
    bitmap.close()
    try {
      // Raw pixels: a photo if a JPEG is much smaller than the same pixels
      // kept lossless, or else a drawing or screenshot, kept lossless while
      // it can be (its edges would blur). Measured, as see-through corners
      // or flat skies fool a look at the pixels.
      const ownSent = counted ? await deflatedLength(im.stream.contents) : im.bytes
      const c: Candidate = { im, line, dims, shown, kind: 'photo', seen: { jpeg: [], flate: [] }, made: new Map(), ownSent }
      const keep = async (way: Way, bytes: Uint8Array) => {
        c.seen[way.as].push({ pixels: pixels(way.dims), quality: way.quality, bytes: bytes.length, sent: counted ? await deflatedLength(bytes) : undefined })
        if (bytes.length <= cap) c.made.set(key(way), bytes)
      }
      if (im.source === 'pixels') {
        const lossless = await flate(base, channelsOf(im))
        const asJpeg = await jpeg(base, Q_MAX)
        if (asJpeg.length > lossless.length * PHOTO_SHARE) c.kind = 'graphic'
        await keep({ dims: topDims, as: 'flate', quality: Q_MAX }, lossless)
        await keep({ dims: topDims, as: 'jpeg', quality: Q_MAX }, asJpeg)
      }
      line.kind = c.kind
      if (s.keepThumbs && thumbs.length < MAX_THUMBS) thumbs.push({ n: line.n, before: thumb(base) })
      const encode = async (way: Way) => {
        if (c.seen[way.as].some((m) => m.pixels === pixels(way.dims) && m.quality === way.quality)) return
        const small = way.dims.width === base.width && way.dims.height === base.height ? undefined : drawAt(base, way.dims)
        try {
          await keep(way, way.as === 'jpeg' ? await jpeg(small ?? base, way.quality) : await flate(small ?? base, channelsOf(im)))
        } finally {
          if (small) release(small)
        }
      }
      // The top, the bottom of the resolution steps (and a drawing's own
      // bottom), and every lower quality; sizes in between are predicted.
      for (const l of levels)
        if (l === top || l.ppi === PPI_FLOOR || (c.kind === 'graphic' && l.ppi === GRAPHIC_FLOOR)) for (const way of ways(c, l)) await encode(way)
      candidates.push(c)
    } finally {
      release(base)
    }
  }
  s.candidates = candidates
  s.levels = levels
  // Everything but the candidates, deflated: the whole less theirs (deflate's 32 KB window
  // finds little between pieces this size, and the made PDF is checked as it's sent anyway).
  s.sent = counted ? { tidied: whole, fixed: whole - candidates.reduce((n, c) => n + c.ownSent, 0) } : undefined
  report.compressed = counted
  report.levels = levelsOf(s, levels)
  s.lap('measuring')
  if (s.sent) {
    // Made at its smallest for real, from the pictures just measured, and deflated: an exact
    // figure for the bottom of the ladder (whether it can fit at all), and what deflating the whole
    // finds that no picture's own deflating sees (the same JPEG tables, picture after picture).
    const least = levels[levels.length - 1]
    const out = await build(s, least, hooks, false)
    const bytes = await sentSize(out)
    const replaced = candidates.filter((c) => sizeAt(c, least) !== c.im.bytes).length
    s.sent.smallest = { level: least, bytes, off: bytes - report.levels[levels.length - 1].predicted, replaced }
    // Made again when it's made for a share: its lines say what that made.
    for (const c of candidates) {
      c.line.out = undefined
      c.line.kept = false
      c.line.error = undefined
    }
    report.levels = levelsOf(s, levels)
    s.lap('saving')
  }
}

/** The PDF made at its smallest during measuring, deflated: its bytes, how far off their prediction was, and the pictures replaced. */
interface Smallest {
  level: Level
  bytes: number
  off: number
  replaced: number
}

const same = (a: Level, b: Level) => a.ppi === b.ppi && a.quality === b.quality

/** The bytes the PDF is predicted to take at a level, as it's saved. */
function pdfPredicted(s: PdfSession, tidied: Uint8Array, l: Level): number {
  const fixed = tidied.length - s.candidates.reduce((n, c) => n + c.im.bytes, 0)
  return fixed + s.candidates.reduce((n, c) => n + sizeAt(c, l), 0) + s.candidates.filter((c) => sizeAt(c, l) !== c.im.bytes).length * DICT_BYTES
}

/**
 * The same, as it's sent: deflated, a new picture's dictionary counted whole. Once it's been made
 * at its smallest, that level is what it came to, and the others are put right by as much for
 * each picture replaced.
 */
function pdfSent(s: PdfSession, sent: NonNullable<PdfSession['sent']>, l: Level): number {
  const at = sent.smallest
  if (at && same(at.level, l)) return at.bytes
  const replaced = s.candidates.filter((c) => sizeAt(c, l) !== c.im.bytes).length
  const predicted = sent.fixed + s.candidates.reduce((n, c) => n + sentAt(c, l), 0) + replaced * DICT_BYTES
  return at?.replaced ? Math.round(predicted + (at.off * replaced) / at.replaced) : predicted
}

/** Each level's prediction, as the target counts it, and as it's saved. */
function levelsOf(s: PdfSession, levels: Level[]): Report['levels'] {
  return levels.map((l) => {
    const file = pdfPredicted(s, s.tidied!, l)
    const exact = !!s.sent?.smallest && same(s.sent.smallest.level, l)
    return { ...l, predicted: s.sent ? pdfSent(s, s.sent, l) : file, file, ...(exact ? { exact } : {}) }
  })
}

/**
 * Makes the PDF at the first level predicted to fit opts.target (measurePdf
 * first, with the lower qualities if opts.lower), saves it and checks it; a
 * step further down if it came out over. Sizes are counted as measurePdf was
 * told to. The session is left as it was, so it can be made again for another size.
 */
export async function makePdf(s: PdfSession, opts: Options, hooks: Hooks): Promise<{ data?: Uint8Array; report: Report }> {
  const { report } = s
  const levels = ladder(opts.lower)
  report.levels = levelsOf(s, levels)
  report.level = report.output = report.sent = report.outcome = undefined
  let at = report.levels.findIndex((l) => l.predicted <= opts.target * (l.exact ? 1 : MARGIN))
  if (at === -1) {
    report.outcome = 'no-fit'
    return { report: s.finish() }
  }
  for (let tries = 0; tries < 3 && at < levels.length; tries++, at++) {
    const l = levels[at]
    const out = await build(s, l, hooks, true)
    // As the composer will send it: the same rule (compress.ts), so what fits here fits there.
    const sent = s.sent ? await sentSize(out) : out.length
    report.levels[at].actual = sent
    s.lap('saving')
    if (sent <= opts.target) {
      const check = await PDFDocument.load(out, LOAD)
      if (check.getPageCount() !== report.source.pages) throw new Error('the page count changed')
      report.level = l
      report.outcome = 'shrunk'
      report.output = out.length
      report.sent = sent
      return { data: out, report: s.finish() }
    }
  }
  report.outcome = 'no-fit'
  return { report: s.finish() }
}

/**
 * The PDF with each picture as it is at level l: made from what was measured, or
 * afresh, saved; every picture its own again after. Each picture's report line
 * says what it became, and with thumbs, its thumbnail shows it.
 */
async function build(s: PdfSession, l: Level, hooks: Hooks, thumbs: boolean): Promise<Uint8Array> {
  const stop = () => {
    if (hooks.stopped()) throw new ShrinkError('stopped')
  }
  const { doc, candidates } = s
  try {
    for (const [i, c] of candidates.entries()) {
      stop()
      hooks.progress('making', i / candidates.length)
      doc.context.assign(c.im.ref, c.im.stream)
      c.line.out = undefined
      c.line.kept = false
      c.line.error = undefined
      const pick = best(c, l)
      if (!pick) continue
      const w = pick.way
      const exact = c.seen[w.as].find((m) => m.pixels === pixels(w.dims) && m.quality === w.quality)
      if (exact && exact.bytes >= c.im.bytes * (1 - WORTH)) {
        c.line.kept = true
        continue
      }
      let bytes = c.made.get(key(w))
      let canvasAfter: OffscreenCanvas | undefined
      try {
        if (!bytes) {
          const bitmap = await open(doc, c.im)
          canvasAfter = drawAt(bitmap, w.dims)
          bitmap.close()
          bytes = w.as === 'jpeg' ? await jpeg(canvasAfter, w.quality) : await flate(canvasAfter, channelsOf(c.im))
        }
        if (bytes.length >= c.im.bytes * (1 - WORTH)) {
          c.line.kept = true
          continue
        }
        // The new picture must open, at its size, or the old one stays.
        const t = thumbs && s.keepThumbs ? s.thumbs.find((x) => x.n === c.line.n) : undefined
        if (w.as === 'jpeg') {
          const check = await createImageBitmap(new Blob([bytes as BlobPart], { type: 'image/jpeg' }))
          const ok = check.width === w.dims.width && check.height === w.dims.height
          if (ok && t) {
            t.after?.close()
            t.after = thumb(check)
          }
          check.close()
          if (!ok) throw new Error('the new picture came out the wrong size')
        } else if (t) {
          // Lossless: the new picture is the canvas it was made from.
          if (!canvasAfter) {
            const bitmap = await open(doc, c.im)
            canvasAfter = drawAt(bitmap, w.dims)
            bitmap.close()
          }
          t.after?.close()
          t.after = thumb(canvasAfter)
        }
      } catch (e) {
        c.line.error = e instanceof Error ? e.message : String(e)
        continue
      } finally {
        if (canvasAfter) release(canvasAfter)
      }
      doc.context.assign(c.im.ref, replacement(doc, c.im, bytes, w.dims, w.as))
      c.line.out = {
        ...w.dims,
        as: w.as,
        quality: w.as === 'jpeg' ? w.quality : undefined,
        bytes: bytes.length,
        ppi: Math.round(ppiOf(w.dims, c.shown)),
      }
    }
    s.lap('making')
    hooks.progress('saving', 0)
    const gone = sweep(doc)
    try {
      return await save(doc, s.pdfa)
    } finally {
      // Back as measured, for another size: what the sweep took.
      for (const [ref, obj] of gone) doc.context.assign(ref, obj)
    }
  } finally {
    for (const c of candidates) doc.context.assign(c.im.ref, c.im.stream)
  }
}

/** Lets go of the session's pictures. */
export function closePdf(s: PdfSession) {
  for (const t of s.thumbs) {
    t.before?.close()
    t.after?.close()
  }
  s.thumbs.length = 0
  for (const c of s.candidates) c.made.clear()
}


