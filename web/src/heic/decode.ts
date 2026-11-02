// Opens a HEIC photo where the browser can't open it as a picture (all but
// Safari: Chrome, Edge, Firefox, on Android phones too, whose cameras may save
// HEIC), with the browser's own HEVC video decoder (WebCodecs) instead of a
// library every visitor would have to fetch. Each tile is decoded as a
// picture of its own and drawn straight to its place on one canvas, cropped,
// turned and mirrored as the photo says (read.ts). Where the browser has no
// HEVC decoder (it depends on the device), the photo can't be opened, as
// before. It runs on the page, one photo at a time: a phone's hardware
// decoders are few. A caller that needs the photo smaller (a copy, the
// viewer, a small picture) has it drawn that size as its tiles come, so a big
// photo never takes a canvas its own size (a 48 MP one would be 195 MB).
import { codecChoices, looksLikeHeif, placement, readHeic, sizeAfter, type HeicPicture } from './read.ts'
import { MAX_PIXELS, type Dims } from '../shrink/plan.ts'

/** How long a decoder may go without handing back a tile before it's given up on: some phones' stall. */
const STALL_MS = 10_000
/** How long the browser may take to say whether it can decode a photo. */
const ASK_MS = 3_000
/** The most a photo may take in all, by its tiles: one that never finishes would hold up every photo after it. */
const budgetMs = (tiles: number) => 5_000 + 200 * tiles
/** How long without a tile before those drawn are painted, so a decoder short of output buffers gets them back. */
const NUDGE_MS = 400
/** Tiles waiting in the decoder at most: each is a copy of its data. */
const QUEUE = 4
/** How much bigger than its tile a decoded tile may be: not much, or a crafted photo could keep a decoder busy. */
const SLACK = 64
/** The smallest a tile is drawn, as a share of its size: shrunk much more in one step, fine detail turns into stripes. */
const MIN_SCALE = 0.5

let queue: Promise<unknown> = Promise.resolve()

export interface DecodedHeic {
  canvas: HTMLCanvasElement
  /** The picture's own size, upright: the canvas is that, or smaller if asked. */
  size: Dims
}

export interface DecodeOptions {
  /** The smallest shorter side that will do, to use the photo's own small picture when it has one at least that big. */
  thumbnail?: number
  /** For the picture's own size (upright), the most of it the caller needs: 0.5 for half its width and height. */
  scale?: (size: Dims) => number
}

/**
 * The photo drawn upright on a new canvas, or undefined when this browser
 * can't decode it (or it isn't a HEIC Slynk can read).
 */
export function decodeHeic(bytes: Uint8Array, o: DecodeOptions = {}): Promise<DecodedHeic | undefined> {
  const next = queue.then(() => decode(bytes, o))
  queue = next.catch(() => {})
  return next.catch(() => undefined)
}

async function decode(bytes: Uint8Array, { thumbnail, scale }: DecodeOptions): Promise<DecodedHeic | undefined> {
  if (typeof VideoDecoder === 'undefined' || !looksLikeHeif(bytes)) return undefined
  let p: HeicPicture
  try {
    p = (thumbnail && bigEnough(readHeic(bytes, 'thumbnail'), thumbnail)) || readHeic(bytes)!
  } catch {
    return undefined
  }
  // Not one bigger than Slynk opens at all: a canvas that size could take more memory than a phone has.
  if (p.size.width * p.size.height > MAX_PIXELS) return undefined
  // A limit on each step and on the whole photo: other photos, and other files' small pictures and copies, wait their
  // turn behind it.
  const deadline = performance.now() + budgetMs(p.tiles.length)
  let timer: ReturnType<typeof setTimeout> | undefined
  let nudger: ReturnType<typeof setTimeout> | undefined
  let giveUp!: (e: Error) => void
  const limit = new Promise<never>((_, reject) => (giveUp = reject))
  limit.catch(() => {})
  let nudge = () => {}
  const alive = () => {
    clearTimeout(timer)
    timer = setTimeout(() => giveUp(new Error('too slow')), Math.max(0, Math.min(STALL_MS, deadline - performance.now())))
    clearTimeout(nudger)
    nudger = setTimeout(() => nudge(), NUDGE_MS)
  }
  let canvas: HTMLCanvasElement | undefined
  let decoder: VideoDecoder | undefined
  let failed = false
  try {
    alive()
    const config = await Promise.race([configFor(p), limit])
    if (!config) return undefined
    const { size: own, matrix } = placement(p)
    const s = tileScale(p, scale?.(own) ?? 1)
    const [a, b, c, d, e, f] = matrix
    // Every tile's edges land on whole pixels when the picture is moved by under one; and the canvas is only what
    // the picture covers, with no part-covered row or column at its edges (it would be see-through).
    const ex = Math.floor(e * s + 1e-9)
    const fy = Math.floor(f * s + 1e-9)
    canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.floor(own.width * s + ex - e * s + 1e-9))
    canvas.height = Math.max(1, Math.floor(own.height * s + fy - f * s + 1e-9))
    // The GPU's canvas lost (a phone's graphics reset) leaves tiles undrawn: the photo fails rather than come out blank.
    canvas.addEventListener('contextlost', () => (failed = true))
    // Kept on the GPU: left unsaid, Chrome moves a canvas to the CPU at its second read-back (below), and then reads
    // each frame back from the GPU to draw it, which took a phone seconds a photo.
    const ctx = canvas.getContext('2d', { willReadFrequently: false })
    if (!ctx) return undefined
    // At full size every tile lands on whole pixels, a quarter turn at most: nothing to smooth, and smoothing would
    // blur their edges into each other. Smaller, each is smoothed on its own, and they still meet on whole pixels.
    ctx.imageSmoothingEnabled = s < 1
    ctx.imageSmoothingQuality = 'high'
    ctx.setTransform(a * s, b * s, c * s, d * s, ex, fy)
    const drawn = new Set<number>()
    // A GPU canvas paints what it's given when it next needs to (in Chrome, every 32 MB or so), and until then each
    // tile drawn holds one of the decoder's output buffers; a decoder that has run out stops. A pixel read back
    // paints them all, freeing the buffers: when tiles stop coming, and before the decoder closes, as Chrome on
    // Android loses the picture of a tile not yet painted once it does (the last ones came out as copies of one).
    let unpainted = 0
    const paint = () => {
      unpainted = 0
      return ctx.getImageData(0, 0, 1, 1).data
    }
    nudge = () => {
      try {
        if (unpainted && !failed) paint()
      } catch {
        failed = true
      }
    }
    // Each tile's timestamp is its number, so the order they come back in doesn't matter.
    decoder = new VideoDecoder({
      output: (frame) => {
        try {
          const i = frame.timestamp
          const width = frame.visibleRect?.width ?? frame.codedWidth
          const height = frame.visibleRect?.height ?? frame.codedHeight
          if (width > p.tile.width + SLACK || height > p.tile.height + SLACK) failed = true
          else if (Number.isInteger(i) && i >= 0 && i < p.tiles.length && !drawn.has(i)) {
            ctx.drawImage(frame, (i % p.columns) * p.tile.width, Math.floor(i / p.columns) * p.tile.height, p.tile.width, p.tile.height)
            drawn.add(i)
            unpainted++
          }
        } catch {
          failed = true
        } finally {
          frame.close()
          alive()
        }
      },
      error: () => {
        failed = true
      },
    })
    decoder.configure(config)
    for (const [i, data] of p.tiles.entries()) {
      // A few at a time: each tile waiting is a copy of its data.
      while (!failed && decoder.decodeQueueSize > QUEUE) await Promise.race([dequeued(decoder), limit])
      if (failed) break
      decoder.decode(new EncodedVideoChunk({ type: 'key', timestamp: i, data }))
    }
    const flushed = decoder.flush()
    flushed.catch(() => {}) // closed after a stall, it fails later, with no one waiting
    await Promise.race([flushed, limit])
    // Painted before the decoder closes; and a corner that isn't is a canvas that drew nothing.
    if (paint()[3] < 128) failed = true
    if (failed || drawn.size !== p.tiles.length) return undefined
    const done = canvas
    canvas = undefined
    return { canvas: done, size: own }
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
    clearTimeout(nudger)
    if (decoder && decoder.state !== 'closed') decoder.close()
    if (canvas) canvas.width = canvas.height = 0
  }
}

/**
 * The scale the tiles are drawn at, for a caller that needs `want` of the picture: that, but never under
 * MIN_SCALE, and a whole number of pixels for every tile's width and height, so tiles meet on whole pixels,
 * with no seams between them. Rounded down to that (the caller asked for at most `want`) unless that would go
 * under MIN_SCALE.
 */
export function tileScale(p: Pick<HeicPicture, 'tile' | 'tiles'>, want: number): number {
  if (!(want < 1)) return 1
  const s = Math.max(want, MIN_SCALE)
  if (p.tiles.length === 1) return s
  const g = gcd(p.tile.width, p.tile.height)
  const m = Math.floor(s * g + 1e-9)
  return Math.min(g, m / g >= MIN_SCALE ? m : Math.ceil(MIN_SCALE * g)) / g
}

function gcd(a: number, b: number): number {
  return b ? gcd(b, a % b) : a
}

/** Waits for the decoder's queue to go down (or a moment, if the browser has no dequeue event). */
function dequeued(decoder: VideoDecoder): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      decoder.removeEventListener('dequeue', done)
      clearTimeout(timer)
      resolve()
    }
    decoder.addEventListener('dequeue', done)
    const timer = setTimeout(done, 10)
  })
}

/** The thumbnail when its shorter side is at least edge. */
function bigEnough(p: HeicPicture | undefined, edge: number): HeicPicture | undefined {
  if (!p) return undefined
  const d = sizeAfter(p.size, p.steps)
  return Math.min(d.width, d.height) >= edge ? p : undefined
}

/** Configurations the browser has said yes to. Only yes is kept: a broken photo's no mustn't count against good ones. */
const supported = new Set<string>()

/**
 * A configuration this browser says it can decode, trying the photo's own
 * codec name first, and each with the photo's colours, then without (a
 * browser that doesn't know a colour's name refuses the lot); undefined if
 * none will do.
 */
async function configFor(p: HeicPicture): Promise<VideoDecoderConfig | undefined> {
  const base: VideoDecoderConfig = { codec: '', description: p.description, codedWidth: p.tile.width, codedHeight: p.tile.height, optimizeForLatency: true }
  for (const codec of codecChoices(p.codec)) {
    for (const colorSpace of p.colour ? [p.colour, undefined] : [undefined]) {
      const config = { ...base, codec, ...(colorSpace && { colorSpace }) }
      const key = JSON.stringify([codec, p.tile, colorSpace])
      if (supported.has(key) || (await ask(config))) {
        supported.add(key)
        return config
      }
    }
  }
  return undefined
}

/** Whether the browser says it can decode a configuration: no if it throws (as iOS 26.1 does) or takes too long to say. */
function ask(config: VideoDecoderConfig): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), ASK_MS)))
  const answer = VideoDecoder.isConfigSupported(config).then((r) => !!r.supported, () => false)
  return Promise.race([answer, late]).finally(() => clearTimeout(timer))
}
