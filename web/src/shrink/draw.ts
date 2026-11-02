// Makes smaller copies of photos in this browser: decode the photo, draw it
// smaller on a canvas, save that as a new JPEG (WebP when it has
// transparency, or PNG where the browser can't save WebP), and keep only the
// picture data (bare.ts). The copy holds what the photo looks like and
// nothing else from the original file. plan.ts decides the sizes.
//
// It runs on the page, one photo at a time. Each photo is decoded once and
// drawn onto a working canvas, which every try is then drawn from: drawing
// from the decoded photo itself made Chrome decode it again each time (about
// a second for 12 megapixels). The photo and the canvas are let go before
// the next photo: 12 megapixels take about 48 MB.
import { barePicture } from './bare.ts'
import { decodeHeic } from '../heic/decode.ts'
import { MAX_EDGE, MAX_PIXELS, Q_FLOOR, Q_LOWEST, Q_MAX, type Dims, type Encoded, type PhotoLevel, type Sizes, fitDims, floorEdge, longEdge, searchCopy, topEdge } from './plan.ts'
import type { PhotoInfo } from './info.ts'

export type CopyType = 'image/jpeg' | 'image/webp' | 'image/png'

/** What a photo's smallest copies weigh (dims as decoded, upright; lowest is "Lower the quality"'s), measured once and kept for planning. */
export interface Measured extends Sizes {
  type: CopyType
  /** With "Smallest": its copy at that level, made as it was measured, so it needn't be made again (keptCopy). */
  kept?: Copy & { level: PhotoLevel }
}

export interface MeasureOptions {
  /** Its top size too, for "Good" ("Smallest photos"). */
  top?: boolean
  /** "Smallest": keep its copy at this level (checked that it opens). */
  keep?: PhotoLevel
  /** How far along it is, 0 to 1, as each step is done. */
  progress?: (done: number) => void
}

export interface Copy {
  data: Uint8Array
  type: CopyType
  dims: Dims
  quality: number
}

/** Why a photo couldn't be copied: 'open' this browser can't decode it, 'big' too many pixels to try. */
export class CopyError extends Error {
  constructor(readonly reason: 'open' | 'big' | 'failed') {
    super(reason)
  }
}

/** A decoded photo: a bitmap, or a canvas for a HEIC the browser opened with its video decoder (heic/decode.ts). */
type Decoded = ImageBitmap | HTMLCanvasElement

/** The working canvas's most pixels: iPhones before iOS 18 refuse canvases over 4096 x 4096. */
const BASE_PIXELS = 16_000_000

function canvas(d: Dims): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = d.width
  c.height = d.height
  return c
}

/** Lets go of a canvas's memory now rather than whenever it's collected (Safari needs this). */
function release(c: HTMLCanvasElement) {
  c.width = 0
  c.height = 0
}

function closeDecoded(d: Decoded) {
  if (d instanceof HTMLCanvasElement) release(d)
  else d.close()
}

function context(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = c.getContext('2d')
  if (!ctx) throw new CopyError('failed')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  return ctx
}

/**
 * Draws src at the given size. It halves in steps first: in one big step,
 * Firefox (which has no smoothing-quality setting) lets fine detail turn into
 * stripes. src is drawn from only once.
 */
function drawAt(src: Decoded, to: Dims): HTMLCanvasElement {
  let from: Decoded = src
  let step: HTMLCanvasElement | undefined
  const next = (d: Dims) => {
    const c = canvas(d)
    context(c).drawImage(from, 0, 0, d.width, d.height)
    if (step) release(step)
    step = c
    from = c
  }
  while (from.width >= to.width * 4 && from.height >= to.height * 4) next({ width: Math.round(from.width / 2), height: Math.round(from.height / 2) })
  if (from.width >= to.width * 2 && from.height >= to.height * 2) next({ width: to.width * 2, height: to.height * 2 })
  const out = canvas(to)
  context(out).drawImage(from, 0, 0, to.width, to.height)
  if (step) release(step)
  return out
}

/** The working canvas: the photo itself, or a little smaller when that's more than a copy can use or a phone allows. */
function baseDims(d: Dims): Dims {
  const b = fitDims(d, Math.min(longEdge(d), 2 * MAX_EDGE))
  const area = b.width * b.height
  return area <= BASE_PIXELS ? b : fitDims(b, Math.floor(longEdge(b) * Math.sqrt(BASE_PIXELS / area)))
}

/** How much of a photo's own size the working canvas takes. */
function baseScale(d: Dims): number {
  const b = baseDims(d)
  return Math.min(b.width / d.width, b.height / d.height)
}

/** Decodes the photo and draws it onto the working canvas. dims: the photo's own size, upright. */
async function prepare(bytes: Uint8Array, info: PhotoInfo): Promise<{ base: HTMLCanvasElement; dims: Dims }> {
  const { picture, dims } = await open(bytes, info)
  const to = baseDims(dims)
  // A HEIC decoded no bigger than the working canvas is one already (a little smaller: its tiles meet on whole pixels).
  if (picture instanceof HTMLCanvasElement && picture.width <= to.width && picture.height <= to.height) return { base: picture, dims }
  try {
    return { base: drawAt(picture, to), dims }
  } finally {
    closeDecoded(picture)
  }
}

/** Some see-through parts. Not a pixel or two at 250+: privacy settings can add that much noise. */
function hasTransparency(c: HTMLCanvasElement): boolean {
  const px = context(c).getImageData(0, 0, c.width, c.height).data
  for (let i = 3; i < px.length; i += 4) if (px[i] < 250) return true
  return false
}

async function save(c: HTMLCanvasElement, type: CopyType, quality: number): Promise<{ type: CopyType; data: Uint8Array }> {
  const blob = await new Promise<Blob | null>((resolve) => c.toBlob(resolve, type, quality))
  if (!blob) throw new CopyError('failed') // e.g. a canvas over the browser's limit
  // A browser that can't save WebP saves PNG instead (Safari).
  const got = blob.type as CopyType
  if (got !== type && !(type === 'image/webp' && got === 'image/png')) throw new CopyError('failed')
  return { type: got, data: barePicture(new Uint8Array(await blob.arrayBuffer()), got) }
}

/** The photo decoded, and its own size, upright: a HEIC may be decoded smaller (at most the working canvas's size). */
async function open(bytes: Uint8Array, info: PhotoInfo): Promise<{ picture: Decoded; dims: Dims }> {
  if (info.dims && info.dims.width * info.dims.height > MAX_PIXELS) throw new CopyError('big')
  try {
    // No imageOrientation: every current browser turns the photo upright by
    // default, and older ones throw on 'from-image'.
    const bitmap = await createImageBitmap(new Blob([bytes as BlobPart]))
    return { picture: bitmap, dims: { width: bitmap.width, height: bitmap.height } }
  } catch {
    // A HEIC away from Apple's browsers: their own HEVC video decoder, where they have one.
    const heic = info.kind === 'heic' ? await decodeHeic(bytes, { scale: baseScale }) : undefined
    if (heic) return { picture: heic.canvas, dims: heic.size }
    throw new CopyError('open')
  }
}

let canvasWorks: Promise<boolean> | undefined

/**
 * Some privacy settings (Tor Browser, Firefox's resistFingerprinting) make a
 * canvas hand back a blank or random picture instead of what was drawn.
 * Draws a few known colours, saves and re-reads them, and checks they match.
 * A failure isn't remembered: the browser may ask the visitor and allow it.
 */
export function checkCanvas(): Promise<boolean> {
  canvasWorks ??= (async () => {
    const colours = [
      [200, 30, 40],
      [20, 160, 60],
      [30, 60, 210],
      [90, 120, 150],
    ]
    const c = canvas({ width: 4, height: 1 })
    const ctx = context(c)
    colours.forEach(([r, g, b], x) => {
      ctx.fillStyle = `rgb(${r},${g},${b})`
      ctx.fillRect(x, 0, 1, 1)
    })
    const blob = await new Promise<Blob | null>((resolve) => c.toBlob(resolve, 'image/png'))
    release(c)
    if (!blob) return false
    const bitmap = await createImageBitmap(blob)
    const back = canvas({ width: 4, height: 1 })
    const backCtx = context(back)
    backCtx.imageSmoothingEnabled = false
    backCtx.drawImage(bitmap, 0, 0)
    bitmap.close()
    const px = backCtx.getImageData(0, 0, 4, 1).data
    release(back)
    return colours.every((rgb, x) => rgb.every((v, k) => Math.abs(px[x * 4 + k] - v) <= 3))
  })().catch(() => false)
  const result = canvasWorks
  void result.then((ok) => {
    if (!ok) canvasWorks = undefined
  })
  return result
}

/** Decodes a photo and measures its smallest copies; its top size too for "Good", and with "Smallest" keeps its copy at the level. */
export async function measure(bytes: Uint8Array, info: PhotoInfo, o: MeasureOptions = {}): Promise<Measured> {
  const top = o.top || o.keep === 'good'
  // Its steps, for its progress: decoding it is about as much work as two savings.
  const steps = 5 + (top ? 2 : 0) + (o.keep ? 1 : 0)
  let done = 0
  const step = (n = 1) => o.progress?.(Math.min(1, (done += n) / steps))
  const { base, dims } = await prepare(bytes, info)
  step(2)
  try {
    const floor = fitDims(base, floorEdge(base))
    const c = drawAt(base, floor)
    try {
      // JPEG has no transparency, so only the others are checked.
      const alpha = info.kind !== 'jpeg' && hasTransparency(c)
      const atMax = await save(c, alpha ? 'image/webp' : 'image/jpeg', Q_MAX)
      step()
      // PNG has no quality setting: its smallest is its floor size.
      const png = atMax.type === 'image/png'
      const atFloor = png ? atMax : await save(c, atMax.type, Q_FLOOR)
      step()
      const atLowest = png ? atMax : await save(c, atMax.type, Q_LOWEST)
      step()
      const hint = { edge: longEdge(floor), quality: Q_MAX, size: atMax.data.length }
      const atTop = top ? await measureTop(base, atMax, hint) : undefined
      if (top) step(2)
      const m: Measured = { dims, type: atMax.type, least: atFloor.data.length, lowest: atLowest.data.length, hint, top: atTop?.top }
      if (o.keep) {
        // What makeCopy would make at the level: the same drawing, at the same quality.
        const at =
          o.keep === 'good' ? { ...atTop!.saved, dims: fitDims(base, atTop!.top.edge), quality: atTop!.top.quality } : { ...(o.keep === 'medium' ? atFloor : atLowest), dims: floor, quality: o.keep === 'medium' ? Q_FLOOR : Q_LOWEST }
        // Not one that doesn't open: makeCopy is then left to try, and say so.
        const copy = { ...at, quality: png ? 1 : at.quality }
        if (await checkDecodes(copy.data, copy.dims).then(() => true, () => false)) m.kept = { ...copy, level: o.keep }
        step()
      }
      return m
    } finally {
      release(c)
    }
  } finally {
    release(base)
  }
}

/** The top size at Q_MAX: one more drawing, at up to 4 megapixels, so measured only when it's wanted. */
async function measureTop(base: HTMLCanvasElement, atMax: { type: CopyType; data: Uint8Array }, hint: Encoded): Promise<{ top: Encoded; saved: { type: CopyType; data: Uint8Array } }> {
  const edge = topEdge(base)
  if (edge === hint.edge) return { top: hint, saved: atMax }
  const c = drawAt(base, fitDims(base, edge))
  try {
    const saved = await save(c, atMax.type, Q_MAX)
    return { top: { edge, quality: Q_MAX, size: saved.data.length }, saved }
  } finally {
    release(c)
  }
}

/** The copy made as it was measured, when it's at this level and no bigger than target: "Smallest" sends it as it is. */
export function keptCopy(m: Measured, level: PhotoLevel, target: number): Copy | undefined {
  const k = m.kept
  if (!k || k.level !== level || k.data.length > target) return undefined
  return { data: k.data, type: k.type, dims: k.dims, quality: k.quality }
}

/** The best copy of the photo no bigger than target bytes, or undefined if none is. lower: the sender chose "Lower the quality". */
export async function makeCopy(bytes: Uint8Array, info: PhotoInfo, m: Measured, target: number, lower: boolean, progress?: (done: number) => void): Promise<Copy | undefined> {
  const { base } = await prepare(bytes, info)
  // Its progress: decoding it, then each try, closer to the end each time (how many it takes isn't known).
  let tries = 0
  progress?.(0.3)
  let best: { edge: number; quality: number; data: Uint8Array } | undefined
  try {
    const sizes = new Map<string, number>()
    const encode = async (edge: number, quality: number) => {
      const q = m.type === 'image/png' ? 1 : quality // PNG ignores it
      const key = `${edge}/${q}`
      const known = sizes.get(key)
      if (known !== undefined) return known
      const c = drawAt(base, fitDims(base, edge))
      try {
        const { data } = await save(c, m.type, quality)
        progress?.(0.3 + 0.6 * (1 - 0.7 ** ++tries))
        sizes.set(key, data.length)
        if (data.length <= target && (!best || edge > best.edge || (edge === best.edge && quality > best.quality))) best = { edge, quality, data }
        return data.length
      } finally {
        release(c)
      }
    }
    // Room for its top size ("Good"): tried first, which is then all it takes.
    const found = await searchCopy(base, target, encode, m.top && m.top.size <= target ? m.top : m.hint, lower)
    if (!found || !best) return undefined
    const out = fitDims(base, best.edge)
    await checkDecodes(best.data, out)
    progress?.(1)
    return { data: best.data, type: m.type, dims: out, quality: m.type === 'image/png' ? 1 : best.quality }
  } finally {
    release(base)
  }
}

/** The copy must open as a picture of the expected size, or it isn't sent. */
async function checkDecodes(data: Uint8Array, d: Dims) {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(new Blob([data as BlobPart]))
  } catch {
    throw new CopyError('failed')
  }
  const ok = bitmap.width === d.width && bitmap.height === d.height
  bitmap.close()
  if (!ok) throw new CopyError('failed')
}
