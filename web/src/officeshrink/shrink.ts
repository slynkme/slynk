// Makes a Word, PowerPoint, Excel, LibreOffice or RTF file smaller by making
// the pictures inside it smaller, in this browser, in a worker
// (docshrink/session.ts). Nothing else changes: text, fonts, layout and
// every other file in the package stay as they are, and a picture keeps its
// place and size in the document, with fewer pixels.
//
// Their pictures are plain JPEG and PNG files inside a zip (or written out in
// hex, in RTF), so this is the PDF prototype's method (pdfshrink/) with less
// to undo:
//
//   1. Read where each picture is shown and how big (place.ts). If simply
//      re-zipping fits (some apps store parts uncompressed), that's it.
//   2. Measure each picture that can be made smaller at the top and bottom of
//      the same ladder as PDFs (pdfshrink/plan.ts), decoding it once.
//   3. Choose the first level predicted to fit, make the pictures, write the
//      zip, and check it; a step further down if it came out over.
//
// Photos become JPEGs; drawings, screenshots and anything see-through stay
// PNG, with fewer pixels, and a drawing becomes a JPEG too only when the
// file can't fit otherwise (as for PDFs). A PNG (or BMP) that becomes a JPEG is renamed,
// and what names it follows (rename.ts). A new picture replaces the old only
// when it saves at least 5%. Left alone: vector pictures (EMF, WMF, SVG),
// GIF, TIFF, print colours, pictures under 16 KB, textures and backgrounds,
// and signed or password-locked files.
import { type Dims, MAX_PIXELS, Q_MAX } from '../shrink/plan.ts'
import { type CanvasCheck, checkOffscreen } from '../pdfshrink/canvasCheck.ts'
import { GRAPHIC_FLOOR, type Level, MARGIN, type Measure, PPI_FLOOR, WORTH, chosen, dimsAt, fillPage, ladder, ppiOf, predict } from '../pdfshrink/plan.ts'
import { type RtfPicture, isRtf, rtfPictures, withPictures } from '../strip/rtf.ts'
import { describeOther, detectKind } from '../strip/sniff.ts'
import type { Kind } from '../strip/types.ts'
import { type OutEntry, type Package, openPackage, readEntry, writePackage } from '../strip/zip.ts'
import type { ZipEntry } from '../strip/zipdir.ts'
import { checkOffice } from './check.ts'
import { drawAt, hasTransparency, jpeg, png, release, thumb } from './draw.ts'
import { type PicInfo, type PicKind, pictureInfo, turnsQuarter, withOrientation, withoutApp1 } from './picture.ts'
import { type Family, type Placement, type Shown, placements } from './place.ts'
import { type Rename, extFits, newName, renameParts } from './rename.ts'

export interface Options {
  /** Bytes the file must fit in. */
  target: number
  /** Allow quality below 70%, down to 40%. */
  lower: boolean
}

export type Stage = 'reading' | 'tidying' | 'measuring' | 'making' | 'saving'

export type Skip =
  | 'vector'
  | 'gif'
  | 'tiff'
  | 'webp'
  | 'wdp'
  | 'other'
  | 'small'
  | 'big'
  | 'cmyk'
  | 'animated'
  | 'rotated'
  | 'fill'
  | 'clipped'
  | 'unreadable'

export interface PictureLine {
  n: number
  /** Its name in the package ("word/media/image3.png", or "picture 3" in an RTF file): never in the report. */
  name: string
  places: string[]
  kind: PicKind
  width?: number
  height?: number
  /** Bytes it takes in the zip (an RTF file's are its own bytes; in the file they're written twice as long, in hex). */
  bytes: number
  /** Pixels per inch where it's shown largest. */
  ppi?: number
  /** Its size was read from the document (or else it's sized as if it filled the page). */
  placed: boolean
  as?: 'photo' | 'graphic'
  skip?: Skip
  /** What it became, when it changed. */
  out?: { width: number; height: number; as: 'jpeg' | 'png'; quality?: number; bytes: number; ppi: number; renamed: boolean }
  /** Measured, but its own was kept: a new one wasn't smaller enough. */
  kept?: boolean
  error?: string
}

export interface Report {
  source: { bytes: number; kind: Kind; family: Family | 'rtf'; parts: number }
  /** Stored bytes by what they are. */
  where: { pictures: number; media: number; embedded: number; fonts: number; text: number; other: number }
  /** Parts stored uncompressed, compressed when re-zipped. */
  packed: number
  unread: number
  resaved?: number
  pictures: PictureLine[]
  levels: { ppi: number; quality: number; predicted: number; actual?: number }[]
  level?: Level
  output?: number
  outcome?: 'fits-already' | 'tidied' | 'shrunk' | 'no-fit'
  /** Whether this browser draws and reads back pictures as drawn (pdfshrink/canvasCheck.ts), in the worker. */
  canvas?: CanvasCheck
  ms: Record<Stage | 'total', number>
}

export interface Thumb {
  n: number
  before?: ImageBitmap
  after?: ImageBitmap
}

export type Reason = 'signed' | 'encrypted' | 'older' | 'unreadable' | 'canvas' | 'stopped'
export class ShrinkError extends Error {
  readonly reason: Reason
  readonly report?: Report
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

/** As for photos and PDFs: smaller pictures aren't worth it. */
const SMALL = 16_000
/** A PNG becomes a JPEG only if the JPEG is at most this share of the PNG's bytes. */
const PHOTO_SHARE = 0.5
const MAX_THUMBS = 30
const FAMILY: Partial<Record<Kind, Family>> = { docx: 'ooxml', xlsx: 'ooxml', pptx: 'ooxml', odt: 'odf', ods: 'odf', odp: 'odf' }
/** Already compressed: not worth compressing again when re-zipping. */
const PACKED = /\.(jpe?g|png|gif|tiff?|wdp|jxr|webp|emf|wmf|bmp|mp[34]|m4[av]|mov|wmv|avi|wav|zip|docx|xlsx|pptx|odt|ods|odp|bin)$/i

// --- Reading -----------------------------------------------------------------------------

const has = (b: Uint8Array, s: string) => {
  const t = new TextDecoder('latin1').decode(b)
  return t.includes(s)
}

/** An encrypted Word, Excel or PowerPoint file is an older-style container (CFB) holding an EncryptionInfo stream. */
function lockedOoxml(b: Uint8Array): boolean | undefined {
  if (!(b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0)) return undefined
  return has(b.subarray(0, Math.min(b.length, 1 << 20)), 'E\0n\0c\0r\0y\0p\0t\0i\0o\0n\0I\0n\0f\0o')
}

/** What the stored bytes are, for the report. */
function whereOf(pkg: Package, pictures: Map<string, Placement>): Report['where'] {
  const out = { pictures: 0, media: 0, embedded: 0, fonts: 0, text: 0, other: 0 }
  for (const e of pkg.entries) {
    const n = e.name
    const k: keyof Report['where'] = pictures.has(n)
      ? 'pictures'
      : /\/media\/|\.(mp[34]|m4[av]|mov|wmv|avi|wav)$/i.test(n)
        ? 'media'
        : /\/embeddings\/|^Object \d+\/|^ObjectReplacements\/|\.bin$/i.test(n)
          ? 'embedded'
          : /(^|\/)fonts\/|\.(odttf|fntdata|ttf|otf)$/i.test(n)
            ? 'fonts'
            : /\.(xml|rels|vml)$/i.test(n)
              ? 'text'
              : 'other'
    out[k] += e.csize
  }
  return out
}

function skipOf(info: PicInfo, bytes: number, p: Placement): Skip | undefined {
  const k = info.kind
  if (k === 'emf' || k === 'wmf' || k === 'svg') return 'vector'
  if (k === 'gif' || k === 'tiff' || k === 'webp' || k === 'wdp' || k === 'other') return k
  if (!info.dims) return 'unreadable'
  if (p.fill) return 'fill'
  if (p.clipped) return 'clipped'
  if (bytes < SMALL) return 'small'
  if (info.dims.width * info.dims.height > MAX_PIXELS) return 'big'
  if (info.cmyk) return 'cmyk'
  if (info.animated) return 'animated'
  if (info.pngExif) return 'rotated'
  return undefined
}

/** The size to aim for: where it's shown, or the whole page when that's unknown; either way round when it's turned by EXIF. */
function shownFor(d: Dims, p: Placement, page: Shown, orientation?: number): Shown {
  const side = Math.max(page.w, page.h)
  let s: Shown = p.shown ?? fillPage(d, { w: side, h: side })
  if (p.unsized && p.shown) {
    const f = fillPage(d, { w: side, h: side })
    s = { w: Math.max(s.w, f.w), h: Math.max(s.h, f.h) }
  }
  if (turnsQuarter(orientation)) {
    // Whichever way an app turns it, it needs this many pixels on its shorter side.
    const m = Math.max(s.w, s.h)
    s = { w: m, h: m }
  }
  return s
}

// --- Making it smaller ---------------------------------------------------------------

type As = 'jpeg' | 'png'

interface Candidate {
  /** Its line's name. */
  name: string
  /** Its bytes now, to compare a new one's with. */
  was: number
  line: PictureLine
  source: 'jpeg' | 'png' | 'bmp'
  orientation?: number
  dims: Dims
  shown: Shown
  kind: 'photo' | 'graphic'
  /** See-through: only ever a PNG. */
  alpha: boolean
  /** Sizes measured, by how they were saved (a PNG's quality counts as Q_MAX). */
  seen: Record<As, Measure[]>
  /** Pictures made while measuring, by key(), kept if they could be used. */
  made: Map<string, Uint8Array>
}

/** A way to make a picture: its size, how it's saved, at what quality. */
interface Way {
  dims: Dims
  as: As
  quality: number
}

const key = (w: Way) => `${w.as}:${w.dims.width}×${w.dims.height}@${w.quality}`
const pixels = (d: Dims) => d.width * d.height
const same = (a: Dims, b: Dims) => a.width === b.width && a.height === b.height

/**
 * The ways a candidate can be made at a level (none: it keeps its own). A
 * photo becomes a JPEG. A drawing, screenshot or see-through picture stays
 * PNG down to GRAPHIC_FLOOR; further down the ladder, which is only reached
 * when the file doesn't fit otherwise, it may have fewer pixels, or become a
 * JPEG unless it's see-through, whichever is smallest (as for PDFs).
 */
function ways(c: Candidate, l: Level): Way[] {
  const out: Way[] = []
  const dims = dimsAt(c.dims, c.shown, l.ppi)
  if (c.kind === 'graphic') {
    const floor = dimsAt(c.dims, c.shown, Math.max(l.ppi, GRAPHIC_FLOOR))
    // A PNG at its own size would only be saved again as it is.
    if (!(same(floor, c.dims) && c.source === 'png')) out.push({ dims: floor, as: 'png', quality: Q_MAX })
    if (l.ppi >= GRAPHIC_FLOOR && l.quality === Q_MAX) return out
    if (!same(dims, floor)) out.push({ dims, as: 'png', quality: Q_MAX })
    if (c.alpha) return out
  }
  // A JPEG at its own size is only saved again once the quality comes down: each save loses a little.
  if (!(same(dims, c.dims) && c.source === 'jpeg' && l.quality === Q_MAX)) out.push({ dims, as: 'jpeg', quality: l.quality })
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
  return chosen(c.was, best(c, l)?.bytes)
}

/** Opens a picture as the browser's own bitmap: a JPEG without its EXIF, so it isn't turned (its rotation tag goes back on the new one). */
async function open(data: Uint8Array, c: Pick<Candidate, 'source' | 'dims'>): Promise<ImageBitmap> {
  const blob = c.source === 'jpeg' ? new Blob([withoutApp1(data) as BlobPart], { type: 'image/jpeg' }) : new Blob([data as BlobPart])
  const bitmap = await createImageBitmap(blob)
  if (bitmap.width !== c.dims.width || bitmap.height !== c.dims.height) {
    bitmap.close()
    throw new Error(`the picture opened at ${bitmap.width}×${bitmap.height}, its header says ${c.dims.width}×${c.dims.height}`)
  }
  return bitmap
}

async function encode(c: Candidate, way: Way, from: OffscreenCanvas): Promise<Uint8Array> {
  if (way.as === 'png') return png(from)
  const out = await jpeg(from, way.quality)
  return c.orientation ? withOrientation(out, c.orientation) : out
}

// --- Files: where their pictures are, and how they're written again ------------------------

interface Made {
  bytes: Uint8Array
  type: string
  dims: Dims
}

/** What the shared steps need from a file, whatever holds its pictures. */
interface Doc {
  report: Report
  /** What's known of each picture, by its line's name. */
  infos: Map<string, PicInfo>
  /** Where each is shown, for those with a known size. */
  shown: Map<string, Shown>
  data(name: string): Uint8Array
  /** What a picture takes in the file now, and what one of n bytes would take in its place. */
  size(name: string): number
  cost(n: number): number
  /** The file as it is, made as small as it goes without changing a picture (a package re-zipped). */
  tidy(): Uint8Array
  /** The file with new pictures in place of these. */
  write(made: Map<string, Made>, lines: Map<string, PictureLine>): Uint8Array
  /** What an app would find wrong with a file. */
  check(b: Uint8Array): string[]
}

/** Word, PowerPoint, Excel and LibreOffice files: a zip of parts. */
function zipDoc(input: Uint8Array, ms: Report['ms']): { report: Report; find(): Doc } {
  // Word, Excel and PowerPoint's older files (.doc, .xls, .ppt) are another kind altogether.
  const locked = lockedOoxml(input)
  if (locked) throw new ShrinkError('encrypted')
  if (locked === false) throw new ShrinkError(['doc', 'xls', 'ppt'].includes(describeOther(input) ?? '') ? 'older' : 'unreadable')
  let kind: Kind | null = null
  try {
    kind = detectKind(input)
  } catch {
    // Not a zip it can read.
  }
  const family = kind ? FAMILY[kind] : undefined
  if (!kind || !family) throw new ShrinkError('unreadable')
  let pkg: Package
  try {
    pkg = openPackage(input)
  } catch {
    throw new ShrinkError('unreadable')
  }
  if (pkg.encrypted) throw new ShrinkError('encrypted')
  // Signatures cover the package's parts, so any change breaks them (as the cleaner leaves them alone).
  if (family === 'ooxml' && pkg.entries.some((e) => e.name.startsWith('_xmlsignatures/'))) throw new ShrinkError('signed')
  if (family === 'odf') {
    if (pkg.entries.some((e) => /^META-INF\/[^/]*signatures[^/]*\.xml$/i.test(e.name))) throw new ShrinkError('signed')
    const manifest = pkg.entries.find((e) => e.name === 'META-INF/manifest.xml')
    if (!manifest) throw new ShrinkError('unreadable')
    if (has(readEntry(pkg, manifest), 'encryption-data')) throw new ShrinkError('encrypted')
  }

  const report: Report = {
    source: { bytes: input.length, kind, family, parts: pkg.entries.length },
    where: { pictures: 0, media: 0, embedded: 0, fonts: 0, text: 0, other: 0 },
    packed: 0,
    unread: 0,
    pictures: [],
    levels: [],
    ms,
  }
  const find = (): Doc => {
    const placed = placements(pkg, family)
    report.unread = placed.unread
    report.where = whereOf(pkg, placed.pictures)
    const byName = new Map(pkg.entries.map((e) => [e.name, e]))
    const infos = new Map<string, PicInfo>()
    const shown = new Map<string, Shown>()
    let n = 0
    for (const [name, p] of placed.pictures) {
      const e = byName.get(name)!
      let info: PicInfo
      try {
        info = pictureInfo(readEntry(pkg, e))
      } catch {
        info = { kind: 'other' }
      }
      infos.set(name, info)
      const s = info.dims ? shownFor(info.dims, p, placed.page, info.orientation) : undefined
      if (s) shown.set(name, s)
      report.pictures.push({
        n: ++n,
        name,
        places: p.places,
        kind: info.kind,
        width: info.dims?.width,
        height: info.dims?.height,
        bytes: e.csize,
        ppi: info.dims && s ? Math.round(ppiOf(info.dims, s)) : undefined,
        placed: !p.unsized,
        skip: skipOf(info, e.csize, p),
      })
    }
    // Parts stored uncompressed are compressed when re-zipped.
    const repack = (e: ZipEntry): OutEntry => {
      if (e.method !== 0 || e.usize < 1024 || e.name === 'mimetype' || PACKED.test(e.name)) return { name: e.name, from: e }
      return { name: e.name, data: readEntry(pkg, e) }
    }
    report.packed = pkg.entries.filter((e) => 'data' in repack(e)).length
    return {
      report,
      infos,
      shown,
      data: (name) => readEntry(pkg, byName.get(name)!),
      size: (name) => byName.get(name)!.csize,
      cost: (bytes) => bytes,
      tidy: () => writePackage(pkg, pkg.entries.map(repack)),
      write(made, lines) {
        // A picture whose kind changed gets a name to match.
        const taken = new Set(pkg.entries.map((e) => e.name.toLowerCase()))
        const renames: Rename[] = []
        for (const [name, m] of made) {
          if (extFits(name, m.type)) continue
          renames.push({ from: name, to: newName(name, m.type, family, taken), type: m.type })
          lines.get(name)!.out!.renamed = true
        }
        const xml = renameParts(pkg, family, renames)
        const list = pkg.entries.map((e): OutEntry => {
          const m = made.get(e.name)
          if (m) return { name: renames.find((r) => r.from === e.name)?.to ?? e.name, data: m.bytes, store: true }
          const x = xml.get(e.name)
          return x ? { name: e.name, data: x } : repack(e)
        })
        return writePackage(pkg, list)
      },
      check: (b) => checkOffice(b, family),
    }
  }
  return { report, find }
}

const RTF_KINDS: Record<string, PicKind> = { emfblip: 'emf', wmetafile: 'wmf', pmmetafile: 'wmf' }

/**
 * RTF documents: text, with each picture written out in hex at the place it's
 * shown, and its size there (\picwgoal, in twips, times \picscalex).
 */
function rtfDoc(input: Uint8Array, ms: Report['ms']): { report: Report; find(): Doc } {
  let pictures: RtfPicture[]
  try {
    pictures = rtfPictures(input)
  } catch {
    throw new ShrinkError('unreadable')
  }
  const report: Report = {
    source: { bytes: input.length, kind: 'rtf', family: 'rtf', parts: pictures.length },
    where: { pictures: 0, media: 0, embedded: 0, fonts: 0, text: 0, other: 0 },
    packed: 0,
    unread: 0,
    pictures: [],
    levels: [],
    ms,
  }
  const byName = new Map<string, RtfPicture>()
  const find = (): Doc => {
    // The page's size, for pictures without one of their own.
    const head = new TextDecoder('latin1').decode(input.subarray(0, 1 << 16))
    const twips = (w: string) => Number(new RegExp(`\\\\${w}(\\d+)`).exec(head)?.[1] ?? 0)
    const page: Shown = twips('paperw') > 0 && twips('paperh') > 0 ? { w: twips('paperw') / 1440, h: twips('paperh') / 1440 } : { w: 8.5, h: 11 }
    const infos = new Map<string, PicInfo>()
    const shown = new Map<string, Shown>()
    for (const [i, p] of pictures.entries()) {
      const name = `picture ${i + 1}`
      byName.set(name, p)
      let info: PicInfo = { kind: RTF_KINDS[p.blip] ?? 'other' }
      if (p.blip === 'jpegblip' || p.blip === 'pngblip') {
        try {
          info = pictureInfo(p.data)
        } catch {
          // Left as 'other'.
        }
      }
      infos.set(name, info)
      const word = (w: string) => p.words.get(w)?.param ?? 0
      const scale = (w: string) => (p.words.has(w) ? word(w) / 100 : 1)
      const sized = word('picwgoal') > 0 && word('pichgoal') > 0
      const place: Placement = {
        shown: sized ? { w: (word('picwgoal') * scale('picscalex')) / 1440, h: (word('pichgoal') * scale('picscaley')) / 1440 } : undefined,
        unsized: !sized,
        fill: false,
        clipped: false,
        places: ['document'],
      }
      const s = info.dims ? shownFor(info.dims, place, page, info.orientation) : undefined
      if (s) shown.set(name, s)
      report.where.pictures += p.to - p.from
      report.pictures.push({
        n: i + 1,
        name,
        places: place.places,
        kind: info.kind,
        width: info.dims?.width,
        height: info.dims?.height,
        bytes: p.data.length,
        ppi: info.dims && s ? Math.round(ppiOf(info.dims, s)) : undefined,
        placed: sized,
        skip: skipOf(info, p.data.length, place),
      })
    }
    report.where.text = input.length - report.where.pictures
    return {
      report,
      infos,
      shown,
      data: (name) => byName.get(name)!.data,
      size: (name) => byName.get(name)!.to - byName.get(name)!.from,
      // Two hex digits a byte, and a line break every 64 bytes.
      cost: (bytes) => bytes * 2 + Math.ceil(bytes / 64),
      tidy: () => input,
      write(made, lines) {
        const changes = [...made].map(([name, m]) => {
          const blip = m.type === 'image/png' ? 'pngblip' : 'jpegblip'
          const picture = byName.get(name)!
          if (blip !== picture.blip) lines.get(name)!.out!.renamed = true
          return { picture, bytes: m.bytes, was: infos.get(name)!.dims!, now: m.dims, blip }
        })
        return withPictures(input, changes)
      },
      check: checkRtf,
    }
  }
  return { report, find }
}

/** What's wrong with an RTF file: a picture that doesn't open as what it says, or one that can't be found at all. */
function checkRtf(b: Uint8Array): string[] {
  let pictures: RtfPicture[]
  try {
    pictures = rtfPictures(b)
  } catch (e) {
    return [`the file can't be read: ${e instanceof Error ? e.message : String(e)}`]
  }
  const out: string[] = []
  for (const [i, p] of pictures.entries()) {
    if (p.blip !== 'jpegblip' && p.blip !== 'pngblip') continue
    let info: PicInfo | undefined
    try {
      info = pictureInfo(p.data)
    } catch {
      info = undefined
    }
    if (!info?.dims || info.kind !== (p.blip === 'jpegblip' ? 'jpeg' : 'png')) out.push(`picture ${i + 1} isn't the ${p.blip === 'jpegblip' ? 'JPEG' : 'PNG'} it says it is`)
  }
  return out
}

// --- Read, measure, make ------------------------------------------------------------------
// In three calls, so the composer can measure a file once and make it again for
// a different share of the space in seconds (docshrink/session.ts).

/** A file read, then measured: what making it for a size works from. */
export interface OfficeSession {
  input: Uint8Array
  doc: Doc
  report: Report
  thumbs: Thumb[]
  keepThumbs: boolean
  /** The file re-zipped (tidyOffice): the same bytes when that didn't help. */
  tidied?: Uint8Array
  /** What an app would already find wrong with the file as it came. */
  before?: Set<string>
  candidates: Candidate[]
  levels: Level[]
  lap(stage: Stage): void
  finish(): Report
}

/** Reads the file and where each picture is shown, and how big. */
export function openOffice(input: Uint8Array, hooks: Hooks, keepThumbs = true): OfficeSession {
  const t0 = performance.now()
  const ms: Report['ms'] = { reading: 0, tidying: 0, measuring: 0, making: 0, saving: 0, total: 0 }
  let mark = t0
  const lap = (stage: Stage) => {
    const now = performance.now()
    ms[stage] += now - mark
    mark = now
  }
  hooks.progress('reading', 0)
  const opened = isRtf(input) ? rtfDoc(input, ms) : zipDoc(input, ms)
  const report = opened.report
  const finish = () => {
    ms.total = performance.now() - t0
    return report
  }
  lap('reading')
  hooks.progress('tidying', 0)
  let doc: Doc
  try {
    doc = opened.find()
  } catch (e) {
    if (e instanceof ShrinkError) throw new ShrinkError(e.reason, finish())
    throw Object.assign(e instanceof Error ? e : new Error(String(e)), { report: finish() })
  }
  return { input, doc, report, thumbs: [], keepThumbs, candidates: [], levels: [], lap, finish }
}

/** Re-zips the file, as a lossless first try (some apps store parts uncompressed). */
export function tidyOffice(s: OfficeSession): Uint8Array {
  s.tidied = s.doc.tidy()
  if (s.tidied !== s.input) s.report.resaved = s.tidied.length
  s.lap('tidying')
  return s.tidied
}

/**
 * Measures each picture that can be made smaller, decoding it once, at the top
 * and bottom of the ladder (with the lower qualities if lower). Pictures made
 * along the way are kept when they're no bigger than cap, to be used as they are.
 */
export async function measureOffice(s: OfficeSession, lower: boolean, cap: number, hooks: Hooks): Promise<void> {
  const stop = () => {
    if (hooks.stopped()) throw new ShrinkError('stopped')
  }
  const { doc, report, thumbs } = s
  const tidied = s.tidied ?? tidyOffice(s)
  stop()
  report.canvas = await checkOffscreen()
  if (!report.canvas.ok) throw new ShrinkError('canvas')
  s.before = new Set(doc.check(s.input))

  // 2. Measure each picture, decoding it once.
  const levels = ladder(lower)
  const top = levels[0]
  const candidates: Candidate[] = []
  const work = report.pictures.filter((l) => !l.skip && (l.kind === 'jpeg' || l.kind === 'png' || l.kind === 'bmp'))
  for (const [i, line] of work.entries()) {
    stop()
    hooks.progress('measuring', i / work.length)
    const info = doc.infos.get(line.name)!
    const dims = info.dims!
    const c: Candidate = {
      name: line.name,
      was: line.bytes,
      line,
      source: info.kind as Candidate['source'],
      orientation: info.orientation,
      dims,
      shown: doc.shown.get(line.name)!,
      kind: 'photo',
      alpha: false,
      seen: { jpeg: [], png: [] },
      made: new Map(),
    }
    let bitmap: ImageBitmap
    try {
      bitmap = await open(doc.data(line.name), c)
    } catch (e) {
      line.error = e instanceof Error ? e.message : String(e)
      continue
    }
    const topDims = dimsAt(dims, c.shown, top.ppi)
    const base = drawAt(bitmap, topDims)
    bitmap.close()
    try {
      const keep = (way: Way, bytes: Uint8Array) => {
        c.seen[way.as].push({ pixels: pixels(way.dims), quality: way.quality, bytes: bytes.length })
        if (bytes.length <= cap) c.made.set(key(way), bytes)
      }
      // PNG and BMP: a photo if a JPEG is much smaller than a PNG of the same
      // pixels, or else a drawing or screenshot, kept PNG while it can be
      // (its edges would blur). Anything see-through stays PNG: JPEG has no
      // transparency.
      if (c.source !== 'jpeg') {
        c.alpha = hasTransparency(base)
        const lossless = await png(base)
        keep({ dims: topDims, as: 'png', quality: Q_MAX }, lossless)
        if (c.alpha) c.kind = 'graphic'
        else {
          const asJpeg = await jpeg(base, Q_MAX)
          keep({ dims: topDims, as: 'jpeg', quality: Q_MAX }, asJpeg)
          if (asJpeg.length > lossless.length * PHOTO_SHARE) c.kind = 'graphic'
        }
      }
      line.as = c.kind
      if (s.keepThumbs && thumbs.length < MAX_THUMBS) thumbs.push({ n: line.n, before: thumb(base) })
      const measure = async (way: Way) => {
        if (c.seen[way.as].some((m) => m.pixels === pixels(way.dims) && m.quality === way.quality)) return
        const small = same(way.dims, base) ? undefined : drawAt(base, way.dims)
        try {
          keep(way, await encode(c, way, small ?? base))
        } finally {
          if (small) release(small)
        }
      }
      // The top, the bottom of the resolution steps (and a drawing's own
      // bottom), and every lower quality; sizes in between are predicted.
      for (const l of levels)
        if (l === top || l.ppi === PPI_FLOOR || (c.kind === 'graphic' && l.ppi === GRAPHIC_FLOOR)) for (const way of ways(c, l)) await measure(way)
      candidates.push(c)
    } catch (e) {
      line.error = e instanceof Error ? e.message : String(e)
    } finally {
      release(base)
    }
  }
  s.candidates = candidates
  s.levels = levels
  report.levels = levels.map((l) => ({ ...l, predicted: officePredicted(s, tidied, l) }))
  s.lap('measuring')
}

/** The bytes the file is predicted to take at a level. */
function officePredicted(s: OfficeSession, tidied: Uint8Array, l: Level): number {
  const fixed = tidied.length - s.candidates.reduce((n, c) => n + s.doc.size(c.name), 0)
  return fixed + s.candidates.reduce((n, c) => n + s.doc.cost(sizeAt(c, l)), 0)
}

/**
 * Makes the file at the first level predicted to fit opts.target (measureOffice
 * first, with the lower qualities if opts.lower), writes it and checks it; a
 * step further down if it came out over. Nothing in the session changes, so
 * it can be made again for another size.
 */
export async function makeOffice(s: OfficeSession, opts: Options, hooks: Hooks): Promise<{ data?: Uint8Array; report: Report }> {
  const stop = () => {
    if (hooks.stopped()) throw new ShrinkError('stopped')
  }
  const { doc, report, candidates, thumbs } = s
  const levels = ladder(opts.lower)
  report.levels = levels.map((l) => ({ ...l, predicted: officePredicted(s, s.tidied!, l) }))
  report.level = report.output = report.outcome = undefined
  let at = report.levels.findIndex((l) => l.predicted <= opts.target * MARGIN)
  if (at === -1) {
    report.outcome = 'no-fit'
    return { report: s.finish() }
  }
  for (let tries = 0; tries < 3 && at < levels.length; tries++, at++) {
    const l = levels[at]
    const made = new Map<string, Made>()
    for (const [i, c] of candidates.entries()) {
      stop()
      hooks.progress('making', i / candidates.length)
      c.line.out = undefined
      c.line.kept = false
      c.line.error = undefined
      const pick = best(c, l)
      if (!pick) continue
      const w = pick.way
      const exact = c.seen[w.as].find((m) => m.pixels === pixels(w.dims) && m.quality === w.quality)
      if (exact && exact.bytes >= c.was * (1 - WORTH)) {
        c.line.kept = true
        continue
      }
      let bytes = c.made.get(key(w))
      let after: OffscreenCanvas | undefined
      try {
        if (!bytes) {
          const bitmap = await open(doc.data(c.name), c)
          after = drawAt(bitmap, w.dims)
          bitmap.close()
          bytes = await encode(c, w, after)
        }
        if (bytes.length >= c.was * (1 - WORTH)) {
          c.line.kept = true
          continue
        }
        // The new picture must open, at its size, or the old one stays. A
        // browser turns one with a rotation tag as it opens it.
        const type = w.as === 'png' ? 'image/png' : 'image/jpeg'
        const check = await createImageBitmap(new Blob([bytes as BlobPart], { type }))
        const ok =
          same(check, w.dims) || (w.as === 'jpeg' && turnsQuarter(c.orientation) && check.width === w.dims.height && check.height === w.dims.width)
        const t = s.keepThumbs ? thumbs.find((x) => x.n === c.line.n) : undefined
        if (ok && t) {
          t.after?.close()
          t.after = thumb(check)
        }
        check.close()
        if (!ok) throw new Error('the new picture came out the wrong size')
        made.set(c.name, { bytes, type, dims: w.dims })
      } catch (e) {
        c.line.error = e instanceof Error ? e.message : String(e)
        continue
      } finally {
        if (after) release(after)
      }
      c.line.out = {
        ...w.dims,
        as: w.as,
        quality: w.as === 'png' ? undefined : w.quality,
        bytes: bytes.length,
        ppi: Math.round(ppiOf(w.dims, c.shown)),
        renamed: false,
      }
    }
    s.lap('making')
    hooks.progress('saving', 0)
    const out = doc.write(made, new Map(candidates.map((c) => [c.name, c.line])))
    report.levels[at].actual = out.length
    s.lap('saving')
    if (out.length <= opts.target) {
      const broke = doc.check(out).filter((p) => !s.before!.has(p))
      if (broke.length) throw new Error(`the smaller file would be damaged: ${broke[0]}`)
      report.level = l
      report.outcome = 'shrunk'
      report.output = out.length
      return { data: out, report: s.finish() }
    }
  }
  report.outcome = 'no-fit'
  return { report: s.finish() }
}

/** Lets go of the session's pictures. */
export function closeOffice(s: OfficeSession) {
  for (const t of s.thumbs) {
    t.before?.close()
    t.after?.close()
  }
  s.thumbs.length = 0
  for (const c of s.candidates) c.made.clear()
}

