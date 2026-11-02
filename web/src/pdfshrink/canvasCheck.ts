// Can this browser draw pictures and read them back as drawn? Some privacy
// settings change what a canvas hands back. Safari's usual protection nudges
// colours drawn with fillRect by up to 3 (alpha too) and leaves drawn images
// alone: harmless here. Its strictest hands back one random solid colour
// instead, and Firefox's resistFingerprinting a blank or random picture:
// every picture made would come out wrong, so Slynk stops. (WebKit's
// CanvasNoiseInjection.cpp.)
//
// The check draws four colours, saves them as a PNG, opens that and reads it
// back, the way the real work goes. It runs in the worker (shrink.ts).

export const PROBE = [
  [200, 30, 40],
  [20, 160, 60],
  [30, 60, 210],
  [90, 120, 150],
] as const

/** Off by this much at most: Safari's nudge of 3, plus rounding when its alpha nudge is undone. */
export const TOLERANCE = 8

export interface CanvasCheck {
  ok: boolean
  /** The largest difference from what was drawn, in any colour of any pixel. */
  worst: number
  /** What came back, as "r,g,b,a" for each pixel, for the report. */
  got: string
}

export function judge(px: ArrayLike<number>): CanvasCheck {
  let worst = 0
  PROBE.forEach((rgb, i) => rgb.forEach((v, k) => (worst = Math.max(worst, Math.abs((px[i * 4 + k] ?? 0) - v)))))
  const got = PROBE.map((_, i) => [0, 1, 2, 3].map((k) => px[i * 4 + k] ?? '?').join(',')).join(' ')
  return { ok: worst <= TOLERANCE, worst, got }
}

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement
type Ctx = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D

/** Runs the check with canvases from make, saved with toPng. */
export async function checkCanvas(make: (w: number, h: number) => AnyCanvas, toPng: (c: AnyCanvas) => Promise<Blob | null>): Promise<CanvasCheck> {
  try {
    const c = make(4, 1)
    const x = c.getContext('2d') as Ctx | null
    if (!x) return { ok: false, worst: 255, got: 'no 2D canvas' }
    PROBE.forEach(([r, g, b], i) => {
      x.fillStyle = `rgb(${r},${g},${b})`
      x.fillRect(i, 0, 1, 1)
    })
    const blob = await toPng(c)
    if (!blob) return { ok: false, worst: 255, got: 'no PNG' }
    const bitmap = await createImageBitmap(blob)
    const back = make(4, 1)
    const bx = back.getContext('2d') as Ctx | null
    if (!bx) return { ok: false, worst: 255, got: 'no 2D canvas' }
    bx.imageSmoothingEnabled = false
    bx.drawImage(bitmap, 0, 0)
    bitmap.close()
    return judge(bx.getImageData(0, 0, 4, 1).data)
  } catch (e) {
    return { ok: false, worst: 255, got: `error: ${e instanceof Error ? e.message : String(e)}` }
  }
}

/** With OffscreenCanvas: in a worker, or on a page. */
export const checkOffscreen = () =>
  checkCanvas(
    (w, h) => new OffscreenCanvas(w, h),
    (c) => (c as OffscreenCanvas).convertToBlob({ type: 'image/png' }),
  )
