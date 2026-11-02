// How Slynk decodes a HEIC's tiles with the browser's HEVC decoder (src/heic/decode.ts), against a stand-in for
// WebCodecs and the canvas that behaves as Chrome on Android did on a phone: a tile drawn on the canvas is painted
// only at a read-back (or when Chrome gets round to it), it holds one of the decoder's output buffers until then,
// and closing the decoder loses the picture of every tile not yet painted. Then what a crafted photo or a stuck
// decoder must not do (the adversarial review, 2026-10-28): wedge the photos after it, have a "no" remembered for
// good photos, be drawn from frames far bigger than its tiles, or come out blank.
// Run from the repo root: npm --prefix web test
import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { readHeic } from '../src/heic/read.ts'
import { TINY, box, clap, grid, heifFile, imir, irot, ispe, phonePhoto } from './helpers/heic.ts'

interface Behaviour {
  /** The browser's answer to isConfigSupported (a promise that never settles: no answer). Yes by default. */
  supported?: (c: VideoDecoderConfig) => boolean | Promise<boolean>
  /** How long each tile takes to decode, ms. */
  delay?: number
  /** The decoder's output buffers: tiles drawn but not yet painted hold one each. Unlimited by default. */
  buffers?: number
  /** The size of the frames it hands back, if not the tiles'. */
  frameSize?: [number, number]
  /** False: draws land nowhere (a canvas that couldn't be made). */
  drawWorks?: boolean
  /** The canvas's GPU context is lost at the first draw. */
  loseContext?: boolean
}

let B: Behaviour = {}
let run = { reads: 0, maxQueue: 0, lostAtClose: 0, closed: 0 }
let canvas: FakeCanvas | undefined
const decoders: FakeDecoder[] = []

interface FakeCanvas {
  width: number
  height: number
  options?: CanvasRenderingContext2DSettings
  pending: number[]
  painted: Set<number>
  /** Where each tile was drawn on the canvas, by its number: left, top, right, bottom. */
  rects: Map<number, number[]>
  smoothed: boolean[]
  listeners: Record<string, (() => void)[]>
  addEventListener(type: string, f: () => void): void
  getContext(type: string, options?: CanvasRenderingContext2DSettings): unknown
}

function fakeCanvas(): FakeCanvas {
  const c: FakeCanvas = {
    width: 0,
    height: 0,
    pending: [],
    painted: new Set(),
    rects: new Map(),
    smoothed: [],
    listeners: {},
    addEventListener(type, f) {
      ;(c.listeners[type] ??= []).push(f)
    },
    getContext(_type, options) {
      c.options = options
      let m = [1, 0, 0, 1, 0, 0]
      return {
        imageSmoothingEnabled: true,
        imageSmoothingQuality: 'low',
        setTransform(...t: number[]) {
          m = t
        },
        drawImage(this: { imageSmoothingEnabled: boolean }, frame: { timestamp: number }, x: number, y: number, w: number, h: number) {
          if (B.drawWorks === false) return
          const xs = [x, x + w].flatMap((X) => [y, y + h].map((Y) => m[0] * X + m[2] * Y + m[4]))
          const ys = [x, x + w].flatMap((X) => [y, y + h].map((Y) => m[1] * X + m[3] * Y + m[5]))
          c.rects.set(frame.timestamp, [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)])
          c.smoothed.push(this.imageSmoothingEnabled)
          c.pending.push(frame.timestamp)
          if (B.loseContext) for (const f of c.listeners.contextlost ?? []) f()
        },
        getImageData() {
          run.reads++
          for (const t of c.pending.splice(0)) c.painted.add(t)
          // Painting gives the decoder its buffers back.
          for (const d of decoders) d.pump()
          return { data: new Uint8ClampedArray([0, 0, 0, c.painted.size ? 255 : 0]) }
        },
      }
    },
  }
  canvas = c
  return c
}

class FakeDecoder extends EventTarget {
  static isConfigSupported(c: VideoDecoderConfig) {
    return Promise.resolve(B.supported ? B.supported(c) : true).then((supported) => ({ supported, config: c }))
  }
  state = 'unconfigured'
  decodeQueueSize = 0
  private queue: { timestamp: number }[] = []
  private busy = false
  private flushes: (() => void)[] = []
  private size: [number, number] = [0, 0]
  private init: VideoDecoderInit
  constructor(init: VideoDecoderInit) {
    super()
    this.init = init
    decoders.push(this)
  }
  configure(c: VideoDecoderConfig) {
    this.state = 'configured'
    this.size = [c.codedWidth!, c.codedHeight!]
  }
  decode(chunk: { timestamp: number }) {
    this.queue.push(chunk)
    this.decodeQueueSize = this.queue.length
    run.maxQueue = Math.max(run.maxQueue, this.queue.length)
    this.pump()
  }
  pump() {
    if (this.busy || this.state === 'closed') return
    const chunk = this.queue[0]
    if (!chunk) return this.settle()
    // Out of output buffers: nothing more until a paint frees some.
    if ((canvas?.pending.length ?? 0) >= (B.buffers ?? Infinity)) return
    this.busy = true
    setTimeout(() => {
      this.busy = false
      if (this.state === 'closed') return
      this.queue.shift()
      this.decodeQueueSize = this.queue.length
      this.dispatchEvent(new Event('dequeue'))
      const [width, height] = B.frameSize ?? this.size
      this.init.output({ timestamp: chunk.timestamp, codedWidth: width, codedHeight: height, visibleRect: { width, height }, close() {} } as unknown as VideoFrame)
      this.pump()
    }, B.delay ?? 1)
  }
  private settle() {
    if (!this.queue.length && !this.busy) for (const f of this.flushes.splice(0)) f()
  }
  flush() {
    return new Promise<void>((resolve) => {
      this.flushes.push(resolve)
      this.pump()
    })
  }
  close() {
    this.state = 'closed'
    run.closed++
    // What Chrome on Android loses: every tile drawn but not yet painted.
    run.lostAtClose += canvas?.pending.length ?? 0
  }
}

const g = globalThis as Record<string, unknown>
g.VideoDecoder = FakeDecoder
g.EncodedVideoChunk = class {
  timestamp: number
  constructor(o: { timestamp: number }) {
    this.timestamp = o.timestamp
  }
}
g.document = { createElement: () => fakeCanvas() }

type Decode = (bytes: Uint8Array, o?: { thumbnail?: number; scale?: (d: { width: number; height: number }) => number }) => Promise<{ canvas: FakeCanvas; size: { width: number; height: number } } | undefined>
let modules = 0
/** decode.ts afresh: its queue and what the browser said yes to start empty. */
const fresh = async (): Promise<Decode> => (await import(`../src/heic/decode.ts?${++modules}`)).decodeHeic

function reset(b: Behaviour = {}) {
  B = b
  run = { reads: 0, maxQueue: 0, lostAtClose: 0, closed: 0 }
  canvas = undefined
  decoders.length = 0
}

/** Runs the stand-in's timers forward until p settles (or limit ms pass): what it gave, and when. */
async function drive<T>(p: Promise<T>, limit = 30_000): Promise<{ value: T | 'pending'; ms: number }> {
  let settled = false
  let value: T | undefined
  p.then((v) => {
    settled = true
    value = v
  })
  let ms = 0
  while (ms <= limit) {
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
    if (settled) return { value: value as T, ms }
    mock.timers.tick(25)
    ms += 25
  }
  return { value: 'pending', ms }
}

async function withTimers(f: () => Promise<void>) {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    await f()
  } finally {
    mock.timers.reset()
  }
}

const GOOD = new Uint8Array(TINY)
const description = readHeic(GOOD)!.description
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i])
// The same photo with its tiles' decoder configuration damaged: the same codec name, tile size and colours.
const BAD = GOOD.slice()
{
  const at = Buffer.from(GOOD).indexOf(Buffer.from(description.subarray(0, 40)))
  BAD[at + 30] ^= 0xff
}

/** A 6 x 6 grid of 64 x 64 tiles (380 x 380), with the real photo's decoder configuration. */
const BIG = (() => {
  const ids = Array.from({ length: 36 }, (_, i) => 10 + i)
  return heifFile({
    primary: 1,
    items: [
      { id: 1, type: 'grid', data: grid(6, 6, 380, 380), props: [ispe(380, 380)] },
      ...ids.map((id, i) => ({ id, type: 'hvc1', data: Uint8Array.from([0, 0, 0, 4, 0x26, 0x01, i, i]), props: i === 0 ? [box('hvcC', description), ispe(64, 64)] : [2, 3] })),
    ],
    refs: [['dimg', 1, ids]],
  })
})()

test('a photo opens with one read-back: every tile painted before the decoder closes, fed a few at a time', async () => {
  await withTimers(async () => {
    reset()
    const decode = await fresh()
    const { value } = await drive(decode(BIG))
    assert.ok(value && value !== 'pending')
    assert.deepEqual([value.canvas.width, value.canvas.height, value.canvas.painted.size], [380, 380, 36])
    assert.deepEqual([run.reads, run.lostAtClose, run.closed], [1, 0, 1])
    // Kept on the GPU (left unsaid, Chrome moves it to the CPU at a second read-back), and at most 5 tiles queued.
    assert.equal(value.canvas.options?.willReadFrequently, false)
    assert.ok(run.maxQueue <= 5, `${run.maxQueue} queued`)
  })
})

test('a decoder short of output buffers: the tiles drawn are painted when tiles stop coming, and the photo opens', async () => {
  await withTimers(async () => {
    reset({ buffers: 4 })
    const decode = await fresh()
    const { value, ms } = await drive(decode(BIG))
    assert.ok(value && value !== 'pending', 'the photo opens')
    assert.equal(value.canvas.painted.size, 36)
    assert.equal(run.lostAtClose, 0)
    // Nine waits of 0.4 s for 36 tiles 4 at a time, give or take.
    assert.ok(ms < 6_000, `${ms} ms`)
  })
})

test('a decoder that runs out of buffers before the first paint: had the tiles waited for the end, nothing would come', async () => {
  await withTimers(async () => {
    reset({ buffers: 2 })
    const decode = await fresh()
    const { value } = await drive(decode(new Uint8Array(TINY)))
    assert.ok(value && value !== 'pending')
    assert.equal(value.canvas.painted.size, 4)
  })
})

test('a browser’s no for a broken photo isn’t remembered for a good one', async () => {
  await withTimers(async () => {
    // As Chrome does: an hvcC it can't read gets supported: false.
    reset({ supported: (c) => sameBytes(new Uint8Array(c.description as ArrayBuffer), description) })
    const decode = await fresh()
    assert.equal((await drive(decode(BAD))).value, undefined)
    const good = (await drive(decode(GOOD))).value
    assert.ok(good && good !== 'pending', 'the good photo still opens')
  })
})

test('a browser that never says whether it can decode a photo is given up on, and the next photo still opens', async () => {
  await withTimers(async () => {
    let answering = false
    reset({ supported: () => (answering ? true : new Promise<boolean>(() => {})) })
    const decode = await fresh()
    const first = decode(GOOD)
    const second = decode(GOOD)
    const a = await drive(first)
    assert.equal(a.value, undefined)
    assert.ok(a.ms <= 7_000, `gave up after ${a.ms} ms`)
    answering = true
    const b = await drive(second)
    assert.ok(b.value && b.value !== 'pending', 'the next photo opens')
  })
})

test('a decoder that trickles its tiles out is given up on within the photo’s budget, not held to for good', async () => {
  await withTimers(async () => {
    reset({ delay: 9_000 })
    const decode = await fresh()
    const first = decode(GOOD)
    const a = await drive(first)
    assert.equal(a.value, undefined)
    // 5 s and 0.2 s a tile (4): not the 36 s four tiles 9 s apart would take.
    assert.ok(a.ms <= 6_000, `gave up after ${a.ms} ms`)
    assert.equal(run.closed, 1)
  })
})

test('frames far bigger than their tiles are refused; a little bigger is fine', async () => {
  await withTimers(async () => {
    reset({ frameSize: [4096, 4096] })
    assert.equal((await drive((await fresh())(GOOD))).value, undefined)
    reset({ frameSize: [80, 80] })
    const ok = (await drive((await fresh())(GOOD))).value
    assert.ok(ok && ok !== 'pending')
  })
})

test('a canvas that draws nothing, or whose GPU context is lost, gives no photo rather than a blank one', async () => {
  await withTimers(async () => {
    reset({ drawWorks: false })
    assert.equal((await drive((await fresh())(GOOD))).value, undefined)
    reset({ loseContext: true })
    assert.equal((await drive((await fresh())(GOOD))).value, undefined)
  })
})

/** Decodes with the stand-in, at the scale asked (none: full size). */
async function decodeAt(bytes: Uint8Array, scale?: number) {
  reset()
  const { value } = await drive((await fresh())(bytes, scale === undefined ? {} : { scale: () => scale }))
  assert.ok(value && value !== 'pending', 'it opens')
  return value
}

const near = (a: number, b: number) => Math.abs(a - b) < 1e-6

test('a photo needed smaller is drawn that size as its tiles come: on whole pixels, where full size puts them, all covered', async () => {
  await withTimers(async () => {
    // Turned, mirrored and cropped by odd amounts, so the crop's corner lands between pixels once it's scaled.
    const photos = [
      phonePhoto({ rows: 3, columns: 4, tile: 64, width: 250, height: 180 }),
      phonePhoto({ rows: 3, columns: 4, tile: 64, width: 250, height: 180, gridProps: [clap(201, 151, 7, -5), irot(1)] }),
      phonePhoto({ rows: 3, columns: 4, tile: 64, width: 250, height: 180, gridProps: [irot(3), clap(171, 233, 3, 2), imir(1)] }),
      phonePhoto({ rows: 3, columns: 4, tile: 64, width: 250, height: 180, gridProps: [imir(0), irot(2), clap(245, 177, -1, 1)] }),
    ]
    let checked = 0
    for (const photo of photos) {
      const full = await decodeAt(photo)
      const own = full.size
      assert.deepEqual([full.canvas.width, full.canvas.height], [own.width, own.height])
      assert.ok(full.canvas.smoothed.every((x) => !x), 'full size: nothing smoothed')
      for (const want of [0.9, 0.71, 0.5, 0.3]) {
        const small = await decodeAt(photo, want)
        const { canvas } = small
        assert.deepEqual(small.size, own, 'its own size, still')
        // Never under half; at most what was asked otherwise (in 64ths, a tile's whole pixels).
        const width = (r: number[]) => r[2] - r[0]
        const s = width(canvas.rects.get(0)!) / width(full.canvas.rects.get(0)!)
        assert.ok(s >= 0.5 && s <= Math.max(want, 0.5) && s > Math.max(want, 0.5) - 1 / 64, `${want}: ${s}`)
        assert.ok(near(s * 64, Math.round(s * 64)), 'a whole number of pixels a tile')
        assert.ok(canvas.smoothed.every((x) => x), 'smaller: smoothed')
        // Every tile where full size puts it, scaled, and moved by the same amount, under a pixel, up and left.
        const r0 = full.canvas.rects.get(0)!
        const shift = [canvas.rects.get(0)![0] - r0[0] * s, canvas.rects.get(0)![1] - r0[1] * s]
        assert.ok(shift.every((v) => v <= 1e-6 && v > -1), `moved ${shift}`)
        for (const [i, r] of full.canvas.rects) {
          const at = canvas.rects.get(i)!
          assert.ok(at.every((v, k) => near(v, r[k] * s + shift[k % 2])), `tile ${i}`)
          // Its edges on whole pixels: no seams.
          assert.ok(at.every((v) => near(v, Math.round(v))), `tile ${i} at ${at}`)
          checked++
        }
        // The canvas is only picture: inside where the photo's own edges land, and short of them by under a pixel.
        const [x0, y0] = shift
        const [x1, y1] = [x0 + own.width * s, y0 + own.height * s]
        assert.ok(x0 <= 1e-6 && y0 <= 1e-6 && canvas.width <= x1 + 1e-6 && canvas.height <= y1 + 1e-6, 'inside the picture')
        assert.ok(canvas.width > x1 - 1 && canvas.height > y1 - 1, 'not cut short')
      }
    }
    assert.equal(checked, 4 * 4 * 12)
  })
})

test('the scale tiles are drawn at: whole pixels a tile, never under half, the full size when nothing smaller is needed', async () => {
  const { tileScale } = await import('../src/heic/decode.ts')
  const iphone = { tile: { width: 640, height: 896 }, tiles: Array(45) }
  // 128 is the most both 640 and 896 divide by: 5 x 7 pixels a step.
  assert.equal(tileScale(iphone, 4096 / 5712), 91 / 128)
  assert.equal(tileScale(iphone, 0.2), 64 / 128)
  assert.equal(tileScale({ tile: { width: 512, height: 512 }, tiles: Array(48) }, 4096 / 8064), 260 / 512)
  // Tiles of 513 x 511 have no whole-pixel scale under 1: kept at full size.
  assert.equal(tileScale({ tile: { width: 513, height: 511 }, tiles: Array(4) }, 0.7), 1)
  // A single picture has no seams: any scale.
  assert.equal(tileScale({ tile: { width: 4032, height: 3024 }, tiles: Array(1) }, 0.6), 0.6)
  assert.equal(tileScale({ tile: { width: 4032, height: 3024 }, tiles: Array(1) }, 0.2), 0.5)
  for (const want of [1, 1.5, NaN, Infinity]) assert.equal(tileScale(iphone, want), 1)
})
