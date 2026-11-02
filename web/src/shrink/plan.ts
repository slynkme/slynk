// "Make a smaller copy": the sizing decisions, kept apart from the drawing
// (draw.ts) so they can be tested without a browser.
//
// A copy is the photo re-drawn smaller and saved as a new picture, never
// bigger than MAX_EDGE: every byte is pieces the mixnet carries, and 500 KB
// takes about a minute to send, so a copy doesn't fill the space just
// because it's there. To fit, it keeps the quality at Q_MAX and lowers the
// resolution first, down to FLOOR_EDGE pixels on the long side, and only
// then lowers the quality, down to Q_FLOOR.
// Below that size photos start to look like thumbnails, so it never goes
// smaller. If that still doesn't fit, the sender can choose a lower quality
// (Q_LOWER, down to Q_LOWEST, where blocks start to show); after that, Slynk
// says how many fit.

/**
 * The longest side a copy may have: about 4 megapixels, enough to look good
 * on a phone or computer screen (since 2026-10-17; it was 4096, and
 * a 5 MB phone photo's copy came out at about 1.7 MB).
 */
export const MAX_EDGE = 2048
/** The smallest long side Slynk goes to (a smaller photo keeps its own). */
export const FLOOR_EDGE = 1280
/** Quality while the resolution comes down. */
export const Q_MAX = 0.85
/** Then, at the floor, these in turn. The last is the lowest Slynk goes. */
export const Q_STEPS = [0.8, 0.75, 0.7] as const
export const Q_FLOOR = Q_STEPS[Q_STEPS.length - 1]
/** Only when the sender chooses "Lower the quality": then these, at the floor size. */
export const Q_LOWER = [0.6, 0.5, 0.4] as const
export const Q_LOWEST = Q_LOWER[Q_LOWER.length - 1]
/**
 * Photos with more pixels than this aren't opened: decoding one takes 4 bytes
 * a pixel, 200 MB here, which is about as much as a phone's tab can spare.
 */
export const MAX_PIXELS = 50_000_000
/** Tries at Q_MAX before settling on a resolution. */
const MAX_TRIES = 5

/**
 * What "Smallest" makes a photo ("Smallest photos" in Settings → Advanced, so
 * people can say what smallest means). 'least': the
 * floor size at Q_LOWEST, as small as Slynk goes (the default); 'medium': the
 * floor size at Q_FLOOR, where "To fit" stops before lowering the quality;
 * 'good': as good as copies get, the top size at Q_MAX. Never smaller: if they
 * don't all fit, the sender is told how many do, as at the least.
 */
export const PHOTO_LEVELS = ['least', 'medium', 'good'] as const
export type PhotoLevel = (typeof PHOTO_LEVELS)[number]

export interface Dims {
  width: number
  height: number
}

export const longEdge = (d: Dims) => Math.max(d.width, d.height)
/** The largest long side a copy of d may have. */
export const topEdge = (d: Dims) => Math.min(longEdge(d), MAX_EDGE)
/** The smallest long side a copy of d may have. */
export const floorEdge = (d: Dims) => Math.min(longEdge(d), FLOOR_EDGE)

/** d scaled so its long side is at most edge, keeping its shape. Never larger than d. */
export function fitDims(d: Dims, edge: number): Dims {
  const long = longEdge(d)
  if (long <= edge) return { width: d.width, height: d.height }
  const s = edge / long
  return { width: Math.max(1, Math.round(d.width * s)), height: Math.max(1, Math.round(d.height * s)) }
}

/** How much of the space a photo should get: its pixels at the largest copy size. */
export function weight(d: Dims): number {
  const top = fitDims(d, MAX_EDGE)
  return Math.max(1, top.width * top.height)
}

// --- Sharing the space between photos -------------------------------------------

export interface Share {
  /** Its wire size as it is now (the original, or the cleaned original). */
  full: number
  /** Its wire size as the smallest copy Slynk would make. */
  least: number
  /** weight(dims): bigger photos get more of the space. */
  weight: number
}

export type Allocation =
  /** sizes[i]: the most photo i may take on the wire; at least full[i] means it goes as it is. */
  | { fits: true; sizes: number[] }
  /** Even the smallest copies don't fit; count is how many photos would. */
  | { fits: false; count: number }

/**
 * Shares space (bytes) between photos in proportion to their pixels, so they
 * all come out at about the same quality. None gets less than its smallest
 * copy, or more than it needs as it is.
 */
export function allocate(space: number, photos: Share[]): Allocation {
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
  // A photo whose smallest copy is no smaller than itself can always go as it is.
  const least = photos.map((p) => Math.min(p.least, p.full))
  if (sum(least) > space) {
    let count = 0
    let used = 0
    for (const n of [...least].sort((a, b) => a - b)) {
      if (used + n > space) break
      used += n
      count++
    }
    return { fits: false, count }
  }
  const at = (level: number) => photos.map((p, i) => Math.min(p.full, Math.max(least[i], level * p.weight)))
  // The highest level whose shares add up to no more than the space.
  let lo = 0
  let hi = Math.max(0, ...photos.map((p) => p.full / p.weight))
  if (sum(at(hi)) <= space) return { fits: true, sizes: photos.map((p) => p.full) }
  for (let k = 0; k < 64; k++) {
    const mid = (lo + hi) / 2
    if (sum(at(mid)) <= space) lo = mid
    else hi = mid
  }
  return { fits: true, sizes: at(lo).map(Math.floor) }
}

/**
 * With "Smallest": a file's claim on the space when it's made at aim bytes (what its level
 * makes it), and whether it goes as it is. Never smaller than its level (the
 * level chosen is what smallest means), so the claim is fixed: if they don't
 * all fit, the sender is told how many do. When aim would save under `saves` of full it isn't
 * worth its quality, and goes as it is.
 */
export function smallestShare(share: Share, full: number, aim: number, saves: number): { share: Share; asIs: boolean } {
  if (aim >= full * (1 - saves)) return { share: { ...share, full, least: full }, asIs: true }
  return { share: { ...share, full: aim, least: aim }, asIs: false }
}

/**
 * Room nobody claimed, given in turn to those with a ceiling above their size, up to it.
 * With "Smallest" a video claims only its level's size, with its sound guessed, and the
 * room left is its ceiling, as it was before the levels: a sound or an encoder that comes
 * out bigger than guessed still fits (the review, 2026-10-27).
 */
export function giveRoom(space: number, sizes: number[], ceilings: (number | undefined)[]): number[] {
  let left = space - sizes.reduce((a, b) => a + b, 0)
  return sizes.map((s, i) => {
    const c = ceilings[i]
    if (c === undefined || left <= 0 || c <= s) return s
    const more = Math.min(left, c - s)
    left -= more
    return s + more
  })
}

// --- Finding the best copy that fits -------------------------------------------------

export interface Encoded {
  edge: number // the copy's long side
  quality: number
  size: number // bytes
}

/** A photo's measured copies (draw.ts, measure). */
export interface Sizes {
  dims: Dims
  least: number // the floor size at Q_FLOOR
  lowest: number // the floor size at Q_LOWEST
  hint: Encoded // the floor size at Q_MAX
  top?: Encoded // the top size at Q_MAX: measured only for "Good"
}

/** Its copy's size at a "Smallest photos" level; for "Good" before it's measured, guessed from the floor size's (as edge²). */
export function levelBytes(m: Sizes, level: PhotoLevel): number {
  if (level === 'least') return m.lowest
  if (level === 'medium') return m.least
  return m.top?.size ?? Math.ceil(m.hint.size * (topEdge(m.dims) / m.hint.edge) ** 2)
}

/** Whether a copy is all its level makes it: one made smaller for want of room is made again when there's room. */
export function atLevel(copy: { quality: number; dims: Dims }, d: Dims, level: PhotoLevel): boolean {
  if (level === 'least') return true
  // A PNG copy (no quality setting) counts as 1.
  if (level === 'medium') return copy.quality >= Q_FLOOR
  return copy.quality >= Q_MAX && longEdge(copy.dims) === topEdge(d)
}

/** Encodes the photo with this long side and quality, and returns its size in bytes. */
export type Encoder = (edge: number, quality: number) => Promise<number>

/**
 * The long side to try next. Copies grow roughly as edge^k, where k is about
 * 2 but varies (noisier photos grow faster), so k is worked out from the two
 * measurements nearest the target when there are two. Aims slightly under.
 */
export function predictEdge(seen: Encoded[], target: number): number {
  const near = [...seen].sort((a, b) => Math.abs(Math.log(a.size / target)) - Math.abs(Math.log(b.size / target)))
  const ref = near[0]
  const other = near.find((p) => p.edge !== ref.edge)
  let k = other ? Math.log(ref.size / other.size) / Math.log(ref.edge / other.edge) : 2
  if (!Number.isFinite(k)) k = 2
  k = Math.min(3, Math.max(1.4, k))
  return Math.floor(ref.edge * Math.pow(target / ref.size, 1 / k) * 0.98)
}

/**
 * Finds the best copy no bigger than target bytes: the largest that fits at
 * Q_MAX, or else the floor size at the highest quality that fits, going down
 * to Q_FLOOR, or to Q_LOWEST when lower is true. hint: a copy measured earlier
 * at Q_MAX, for better guesses. Undefined when even the lowest is too big.
 */
export async function searchCopy(d: Dims, target: number, encode: Encoder, hint?: Encoded, lower = false): Promise<Encoded | undefined> {
  const top = topEdge(d)
  const bottom = floorEdge(d)
  const clamp = (e: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, e))
  const seen: Encoded[] = hint?.quality === Q_MAX ? [hint] : [] // sizes at Q_MAX, for guessing
  let fit: Encoded | undefined // the largest that fits so far
  let tooBig = top + 1 // the smallest long side known to be too big
  // The floor at Q_MAX was measured already and is too big: only lower quality can fit.
  if (hint?.quality === Q_MAX && hint.edge === bottom && hint.size > target) tooBig = bottom
  // The top size measured already and fitting ("Good"): tried as it is, not guessed a little under.
  let edge = hint?.quality === Q_MAX && hint.edge === top && hint.size <= target ? top : seen.length ? clamp(predictEdge(seen, target), bottom, top) : top
  for (let i = 0; i < MAX_TRIES && tooBig > bottom; i++) {
    const r = { edge, quality: Q_MAX, size: await encode(edge, Q_MAX) }
    seen.push(r)
    if (r.size <= target) {
      if (!fit || edge > fit.edge) fit = r
    } else tooBig = Math.min(tooBig, edge)
    const lo = fit ? fit.edge : bottom - 1
    // A good use of the space, as big as it gets, or close enough.
    if (fit && (fit.size >= target * 0.95 || fit.edge === top)) break
    if (tooBig - lo <= Math.max(8, Math.round(lo * 0.03))) break
    // The best guess is no bigger than one that fits already: that's as good as it gets.
    const guess = predictEdge(seen, target)
    if (fit && guess <= fit.edge) break
    const next = clamp(guess >= tooBig ? Math.floor((lo + tooBig) / 2) : guess, Math.max(bottom, lo + 1), Math.min(top, tooBig - 1))
    if (next === edge) break
    edge = next
  }
  if (!fit && tooBig > bottom) {
    const size = await encode(bottom, Q_MAX)
    if (size <= target) fit = { edge: bottom, quality: Q_MAX, size }
  }
  if (fit) return fit
  for (const quality of lower ? [...Q_STEPS, ...Q_LOWER] : Q_STEPS) {
    const size = await encode(bottom, quality)
    if (size <= target) return { edge: bottom, quality, size }
  }
  return undefined
}

// --- Names ------------------------------------------------------------------------

const EXT: Record<string, { ext: string; matches: RegExp }> = {
  'image/jpeg': { ext: '.jpg', matches: /\.jpe?g$/i },
  'image/webp': { ext: '.webp', matches: /\.webp$/i },
  'image/png': { ext: '.png', matches: /\.png$/i },
  'video/mp4': { ext: '.mp4', matches: /\.mp4$/i },
  'audio/mp4': { ext: '.m4a', matches: /\.m4a$/i },
}

/** The copy's file name: the same, with an extension for its new type ("IMG_1234.HEIC" → "IMG_1234.jpg", "IMG_1234.MOV" → "IMG_1234.mp4"). */
export function copyName(name: string, type: string): string {
  const e = EXT[type]
  if (!e || e.matches.test(name)) return name || `photo${e?.ext ?? ''}`
  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  return (base || 'photo') + e.ext
}
