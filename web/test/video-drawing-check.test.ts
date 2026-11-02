// "Make videos smaller to fit" checks, before making a video, that a picture
// drawn and made into a VideoFrame comes back as drawn (src/video/shrink.ts,
// halves and redAndBlue): Safari's Private Browsing may hand back one random
// colour. Browsers hand the pixels back in different layouts, so these fake
// frames give them each way a browser might. The first check, which wanted
// exact RGBA, refused an ordinary Safari window on an iPhone (2026-10-21).
// Run from the repo root: npm --prefix web test
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { halves, redAndBlue } from '../src/video/shrink.ts'

const W = 16
const H = 8
const RED = [255, 0, 0]
const BLUE = [0, 0, 255]

interface Layout {
  offset: number
  stride: number
}

/** A stand-in for a VideoFrame: copyTo writes what `write` gives, for the format asked or regardless. */
function fake(o: {
  format: string | null
  write: (buf: Uint8Array) => Layout[]
  /** Throws when asked to convert (an older browser), or always (one it can't read). */
  throws?: 'convert' | 'always'
  size?: number
}): VideoFrame {
  return {
    format: o.format,
    codedWidth: W,
    codedHeight: H,
    visibleRect: { x: 0, y: 0, width: W, height: H },
    allocationSize: () => o.size ?? W * H * 4,
    copyTo: async (buf: Uint8Array, opts?: { format?: string }) => {
      if (o.throws === 'always' || (o.throws === 'convert' && opts?.format)) throw new DOMException('no', 'NotSupportedError')
      return o.write(buf)
    },
  } as unknown as VideoFrame
}

/** Four bytes a pixel, left half one colour and right half another, in this order of channels. */
function packed(left: number[], right: number[], order: 'RGBA' | 'BGRA', stride = W * 4) {
  return (buf: Uint8Array): Layout[] => {
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const [r, g, b] = x < W / 2 ? left : right
        buf.set(order === 'RGBA' ? [r, g, b, 255] : [b, g, r, 255], y * stride + x * 4)
      }
    return [{ offset: 0, stride }]
  }
}

/** BT.709 full range, as a hardware decoder or GPU might hand back a frame. */
const yuv = ([r, g, b]: number[]) => {
  const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b
  const byte = (v: number) => Math.max(0, Math.min(255, Math.round(v)))
  return [byte(Y), byte((b - Y) / 1.8556 + 128), byte((r - Y) / 1.5748 + 128)]
}

/** A brightness plane, then colour at half size: two planes interleaved (NV12) or three (I420). */
function planar(left: number[], right: number[], kind: 'NV12' | 'I420') {
  return (buf: Uint8Array): Layout[] => {
    const at = (x: number) => yuv(x < W / 2 ? left : right)
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) buf[y * W + x] = at(x)[0]
    const c = W * H
    const cw = W / 2
    for (let y = 0; y < H / 2; y++)
      for (let x = 0; x < cw; x++) {
        const [, U, V] = at(x * 2)
        if (kind === 'NV12') buf.set([U, V], c + y * W + x * 2)
        else {
          buf[c + y * cw + x] = U
          buf[c + (cw * H) / 2 + y * cw + x] = V
        }
      }
    return kind === 'NV12'
      ? [
          { offset: 0, stride: W },
          { offset: c, stride: W },
        ]
      : [
          { offset: 0, stride: W },
          { offset: c, stride: cw },
          { offset: c + (cw * H) / 2, stride: cw },
        ]
  }
}

async function check(frame: VideoFrame) {
  const back = await halves(frame)
  return 'left' in back ? redAndBlue(back.left, back.right) : undefined
}

test('a picture handed back as asked passes, and one random colour fails', async () => {
  assert.equal(await check(fake({ format: 'RGBA', write: packed(RED, BLUE, 'RGBA') })), true)
  // Safari's Private Browsing: one solid colour for the whole picture.
  assert.equal(await check(fake({ format: 'RGBA', write: packed([93, 141, 27], [93, 141, 27], 'RGBA') })), false)
  // A nudge of a few levels, as Safari's usual protection makes, still passes.
  assert.equal(await check(fake({ format: 'RGBA', write: packed([252, 3, 2], [1, 3, 251], 'RGBA') })), true)
})

test('a browser that ignores the format asked for, or gives other colours, still passes', async () => {
  // Asked for RGBA, it hands back BGRA: the halves come back swapped.
  assert.equal(await check(fake({ format: 'BGRA', write: packed(RED, BLUE, 'BGRA') })), true)
  // Colours from another colour space (sRGB red seen as Display P3): the first check's 24 levels refused this.
  assert.equal(await check(fake({ format: 'RGBA', write: packed([234, 51, 35], [0, 0, 245], 'RGBA') })), true)
  // Rows padded wider than the picture.
  assert.equal(await check(fake({ format: 'RGBX', write: packed(RED, BLUE, 'RGBA', 128), size: 128 * H })), true)
})

test('brightness and colour planes are turned back into RGB', async () => {
  assert.equal(await check(fake({ format: 'NV12', write: planar(RED, BLUE, 'NV12'), throws: 'convert', size: (W * H * 3) / 2 })), true)
  assert.equal(await check(fake({ format: 'I420', write: planar(RED, BLUE, 'I420'), size: (W * H * 3) / 2 })), true)
  assert.equal(await check(fake({ format: 'I420', write: planar([120, 120, 120], [120, 120, 120], 'I420'), size: (W * H * 3) / 2 })), false)
})

test('a frame that can’t be read at all says so, rather than failing the check', async () => {
  const back = await halves(fake({ format: null, write: packed(RED, BLUE, 'RGBA'), throws: 'always' }))
  assert.ok(!('left' in back))
  assert.match(back.how, /no format, unreadable/)
})

test('red against blue: far apart, and opposite', () => {
  assert.ok(redAndBlue(RED, BLUE) && redAndBlue(BLUE, RED))
  assert.ok(!redAndBlue(RED, RED) && !redAndBlue([128, 128, 128], [130, 128, 126]))
  assert.ok(!redAndBlue([255, 0, 200], [200, 0, 255]), 'two purples are neither red nor blue')
})
