// Drawing pictures smaller in a worker, on OffscreenCanvas: the same steps
// as for photos (shrink/draw.ts) and PDFs (pdfshrink/shrink.ts). Every new
// picture goes through barePicture, so it holds the picture and nothing else.
import { barePicture } from '../shrink/bare.ts'
import { type Dims, fitDims } from '../shrink/plan.ts'

const THUMB_EDGE = 320

export function canvas(d: Dims): OffscreenCanvas {
  return new OffscreenCanvas(d.width, d.height)
}

/** Lets go of a canvas's memory now rather than whenever it's collected (Safari needs this). */
export function release(c: OffscreenCanvas) {
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
export function drawAt(src: ImageBitmap | OffscreenCanvas, to: Dims): OffscreenCanvas {
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

export async function jpeg(c: OffscreenCanvas, quality: number): Promise<Uint8Array> {
  const blob = await c.convertToBlob({ type: 'image/jpeg', quality })
  if (blob.type !== 'image/jpeg') throw new Error('this browser saved no JPEG')
  return barePicture(new Uint8Array(await blob.arrayBuffer()), 'image/jpeg')
}

export async function png(c: OffscreenCanvas): Promise<Uint8Array> {
  const blob = await c.convertToBlob({ type: 'image/png' })
  if (blob.type !== 'image/png') throw new Error('this browser saved no PNG')
  return barePicture(new Uint8Array(await blob.arrayBuffer()), 'image/png')
}

/** Some see-through parts. Not a pixel or two at 250+: privacy settings can add that much noise. */
export function hasTransparency(c: OffscreenCanvas): boolean {
  const px = ctx2d(c).getImageData(0, 0, c.width, c.height).data
  for (let i = 3; i < px.length; i += 4) if (px[i] < 250) return true
  return false
}

export function thumb(src: ImageBitmap | OffscreenCanvas): ImageBitmap {
  const c = drawAt(src, fitDims(src, THUMB_EDGE))
  return c.transferToImageBitmap()
}
