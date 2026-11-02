// Making a PDF's pictures smaller: the sizing decisions, kept apart from the
// drawing (shrink.ts) so they can be tested without a browser.
//
// As with photos (shrink/plan.ts), resolution comes down first, then quality.
// For a PDF, resolution means pixels per inch where the picture is shown on
// the page (place.ts): every picture comes down to the same sharpness, so a
// photo shown small loses more pixels than one filling a page. The steps go
// from 200 pixels per inch (sharp on any screen, and fine printed) to 100
// (still readable; scanned text starts to look soft below that), then the
// quality goes from 85% to 70%, and with lower quality allowed (as "Make
// photos smaller to fit" does) down to 40%. Drawings and screenshots are kept
// lossless down to 150 pixels per inch (their edges blur sooner); past that,
// reached only when the PDF doesn't fit otherwise, they may become JPEGs too.
import { type Dims, Q_LOWER, Q_MAX, Q_STEPS } from '../shrink/plan.ts'
import type { Shown } from './place.ts'

export const PPI_STEPS = [200, 170, 150, 130, 115, 100] as const
export const PPI_FLOOR = PPI_STEPS[PPI_STEPS.length - 1]
/** The lowest for drawings and screenshots kept lossless. */
export const GRAPHIC_FLOOR = 150
/** A new picture must save at least this share of the old one's bytes, or the old one stays. */
export const WORTH = 0.05
/** A level is chosen when its predicted size is this far under the target, for predictions that come out a little big. */
export const MARGIN = 0.97

export interface Level {
  ppi: number
  quality: number
}

/** The steps in order, best first. */
export function ladder(lower: boolean): Level[] {
  return [
    ...PPI_STEPS.map((ppi) => ({ ppi, quality: Q_MAX })),
    ...Q_STEPS.map((quality) => ({ ppi: PPI_FLOOR, quality })),
    ...(lower ? Q_LOWER.map((quality) => ({ ppi: PPI_FLOOR, quality })) : []),
  ]
}

/** Its sharpness where it's shown largest: pixels per inch. */
export function ppiOf(d: Dims, shown: Pick<Shown, 'w' | 'h'>): number {
  return Math.min(d.width / shown.w, d.height / shown.h)
}

/**
 * The pixels a picture needs to show at ppi where it's shown largest: never
 * more than it has, keeping its shape, and none taken off when it would be
 * less than a tenth (not worth a new picture).
 */
export function dimsAt(d: Dims, shown: Pick<Shown, 'w' | 'h'>, ppi: number): Dims {
  const s = Math.min(1, Math.max((shown.w * ppi) / d.width, (shown.h * ppi) / d.height))
  if (s > 0.9) return { width: d.width, height: d.height }
  return { width: Math.max(1, Math.round(d.width * s)), height: Math.max(1, Math.round(d.height * s)) }
}

/** A picture's size where none was found on a page: as if it filled the largest page. */
export function fillPage(d: Dims, page: { w: number; h: number }): Pick<Shown, 'w' | 'h'> {
  const s = Math.min(page.w / d.width, page.h / d.height)
  return { w: d.width * s, h: d.height * s }
}

// --- Predicting sizes ------------------------------------------------------------------

export interface Measure {
  pixels: number
  quality: number
  bytes: number
  /** Its bytes deflated, as they go when the whole PDF is sent compressed (compress.ts). */
  sent?: number
}

/**
 * The bytes a picture would take at this many pixels and this quality: the
 * one measured if there is one, or else from the two measured at Q_MAX, as
 * bytes grow roughly as pixels^k (k is about 0.7-1: fewer pixels each carry
 * more detail). of 'sent': as they'd go deflated.
 */
export function predict(seen: Measure[], pixels: number, quality: number, of: 'bytes' | 'sent' = 'bytes'): number | undefined {
  const bytes = (m: Measure) => (of === 'sent' ? (m.sent ?? m.bytes) : m.bytes)
  const exact = seen.find((m) => m.pixels === pixels && m.quality === quality)
  if (exact) return bytes(exact)
  if (quality !== Q_MAX) return undefined
  const at = seen.filter((m) => m.quality === Q_MAX).sort((a, b) => b.pixels - a.pixels)
  if (!at.length) return undefined
  const hi = at[0]
  const lo = at[at.length - 1]
  let k = hi.pixels !== lo.pixels ? Math.log(bytes(hi) / bytes(lo)) / Math.log(hi.pixels / lo.pixels) : 0.85
  if (!Number.isFinite(k)) k = 0.85
  k = Math.min(1.3, Math.max(0.5, k))
  const ref = pixels >= lo.pixels ? hi : lo
  return Math.round(bytes(ref) * Math.pow(pixels / ref.pixels, k))
}

/** What a picture becomes at a level: its new bytes, or its own when a new one isn't worth it. */
export function chosen(original: number, made: number | undefined): number {
  return made !== undefined && made < original * (1 - WORTH) ? made : original
}

/**
 * The first level whose pictures, with everything else (rest), fit in target
 * bytes. sizes(level) gives each picture's bytes at that level. Undefined if
 * none does.
 */
export function firstFit(levels: Level[], rest: number, target: number, sizes: (l: Level) => number[]): number | undefined {
  for (let i = 0; i < levels.length; i++) {
    const total = rest + sizes(levels[i]).reduce((a, b) => a + b, 0)
    if (total <= target) return i
  }
  return undefined
}
