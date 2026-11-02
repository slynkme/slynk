// "Make videos smaller to fit": the sizing decisions, kept apart from the
// encoding (shrink.ts) so they can be tested without a browser.
//
// A smaller video is drawn at most SHORT_EDGE pixels on its short side and
// FPS_MAX frames a second, at a bitrate that fits the space left. Like a
// photo, it doesn't fill the space just because it's there: every byte is
// pieces the mixnet carries, so it stops at a good quality (BPP_GOOD). Short
// of room, it steps down the ladder to keep each picture from going blocky:
// fewer pixels first, keeping 30 frames a second (24 looked jerky on a
// phone, 2026-10-19, and phones film at 30), and only as the
// last step, for the longest videos, 15. Past the
// last step it's too long.

/** The short side of a smaller video, in pixels: 360p. */
export const SHORT_EDGE = 360
export const FPS_MAX = 30
/** Bits per pixel per frame: enough for a clean picture, the most it gets. */
export const BPP_GOOD = 0.1
/**
 * The least each step of the ladder allows before the next step down. 0.05 put
 * a minute of 4K at 240p, a little soft but passable; a little lower
 * (2026-10-19) gives that minute 288p.
 */
export const BPP_OK = 0.045
/** Below this even the last step looks too blocky: the video is too long. */
export const BPP_FLOOR = 0.025
/** Sound: mono, at this many bits a second. */
export const AUDIO_BITRATE = 32_000
/** A key frame (a full picture to start from) this often, in seconds: each costs several ordinary ones. */
export const KEY_EVERY = 5

/** Short side and frame rate, best first. A video filmed at fewer frames a second keeps its own. */
export const LADDER: readonly { short: number; fps: number }[] = [
  { short: 360, fps: 30 },
  { short: 288, fps: 30 },
  { short: 240, fps: 30 },
  { short: 180, fps: 30 },
  { short: 180, fps: 15 },
]

/**
 * What "Smallest" makes a video ("Smallest videos" in Settings → Advanced): 180,
 * as small as Slynk goes; 240 (the default: 180p looked awful) or 360, made at that
 * size and stepped down only when it doesn't fit (levelSteps).
 */
export const VIDEO_LEVELS = [180, 240, 360] as const
export type VideoLevel = (typeof VIDEO_LEVELS)[number]

/** A step "Smallest" makes a video at: its short side, frames a second (a video filmed at fewer keeps its own), and bits per pixel. */
export interface VideoStep {
  short: number
  fps: number
  bpp: number
}

/** The last step, as small as Slynk goes: the ladder's last at BPP_FLOOR. */
const LAST_STEP: VideoStep = { ...LADDER[LADDER.length - 1], bpp: BPP_FLOOR }

/**
 * The steps "Smallest" makes a video at for a level, best first: the level's
 * size at 30 frames a second, then at 15, then the next size down the same
 * way, each at BPP_OK, and last 180p at 15 at BPP_FLOOR (180 is that alone).
 * Videos are made at the first step at which everything fits, all at the same
 * one: too long for its level, a video steps down rather than being refused
 * (since 2026-11-01). Unlike "To fit"'s ladder, which keeps 30
 * frames a second and drops pixels first (2026-10-19), it halves the frames
 * before it drops a size.
 */
export function levelSteps(level: VideoLevel): VideoStep[] {
  if (level === LAST_STEP.short) return [LAST_STEP]
  const sizes = VIDEO_LEVELS.filter((short) => short <= level).reverse()
  const steps: VideoStep[] = sizes.flatMap((short) => [FPS_MAX, LAST_STEP.fps].map((fps) => ({ short, fps, bpp: BPP_OK })))
  steps[steps.length - 1] = LAST_STEP
  return steps
}

/** The frame rate a step makes a video at: its own, or the video's when that's fewer. */
const stepFps = (step: { fps: number }, srcFps: number) => Math.min(step.fps, Math.max(1, Math.round(srcFps)) || step.fps)

export interface Dims {
  width: number
  height: number
}

/**
 * d scaled so its short side is at most short and its long side at most the
 * 16:9 width that goes with it (640 for 360), keeping its shape; even numbers,
 * as H.264 wants. So "at most 640 × 360" holds for a phone's tall screen
 * recording or a wide video too, not only for the usual shape.
 */
export function fitShort(d: Dims, short: number): Dims {
  const long = Math.round((short * 16) / 9)
  const s = Math.min(1, short / Math.min(d.width, d.height), long / Math.max(d.width, d.height))
  const even = (v: number) => Math.max(2, 2 * Math.round((v * s) / 2))
  return { width: even(d.width), height: even(d.height) }
}

/** The bytes the index (moov) and headers take, about: each sample's size and time, and the boxes. */
export function overhead(seconds: number, fps: number, audioFramesPerSecond: number): number {
  return 3000 + Math.ceil(seconds * (fps * 12 + audioFramesPerSecond * 4))
}

export interface VideoPlan {
  width: number
  height: number
  fps: number
  /** Bits a second for the pictures. */
  bitrate: number
  /** Bits per pixel per frame it works out at. */
  bpp: number
}

/**
 * How to make a video of this size, length and frame rate fit target bytes,
 * with audioBytes of sound beside it: the first step of the ladder that keeps
 * BPP_OK, or else the last if it keeps BPP_FLOOR; undefined when it's too long.
 */
export function planVideo(src: Dims, seconds: number, srcFps: number, target: number, audioBytes: number, audioFramesPerSecond = 0): VideoPlan | undefined {
  if (!(seconds > 0)) return undefined
  let last: VideoPlan | undefined
  for (const step of LADDER) {
    const fps = Math.min(step.fps, Math.max(1, Math.round(srcFps)) || step.fps)
    const d = fitShort(src, step.short)
    const room = target - audioBytes - overhead(seconds, fps, audioFramesPerSecond)
    // No room at this frame rate's index: a later step, at fewer frames a second, may have some.
    if (room <= 0) continue
    const pixels = d.width * d.height * fps
    const bitrate = Math.min((room * 8) / seconds, pixels * BPP_GOOD)
    last = { ...d, fps, bitrate: Math.floor(bitrate), bpp: bitrate / pixels }
    if (last.bpp >= BPP_OK) return last
  }
  return last && last.bpp >= BPP_FLOOR ? last : undefined
}

/**
 * The next step down the ladder from a plan's size and frame rate (a smaller
 * picture, or fewer frames at the last), or undefined at the bottom. For when
 * an encoder can't get as low as asked at this size: fewer pixels bring the
 * file down whatever its rate control does (Android's came out over, twice).
 */
export function smallerStep(plan: Dims & { fps: number }, src: Dims, srcFps: number): (Dims & { fps: number }) | undefined {
  const rate = plan.width * plan.height * plan.fps
  for (const step of LADDER) {
    const fps = Math.min(step.fps, Math.max(1, Math.round(srcFps)) || step.fps)
    const d = fitShort(src, step.short)
    if (d.width * d.height * fps < rate) return { ...d, fps }
  }
  return undefined
}

/**
 * The bitrate to try again with when the last try came out at got bytes of
 * pictures and the pictures may have room bytes: encoders overshoot, more so
 * at low bitrates, so it aims a little under.
 */
export const retryBitrate = (bitrate: number, got: number, room: number) => Math.floor((bitrate * room * 0.95) / Math.max(1, got))

// --- Sharing the space with photos (tray.ts) ---------------------------------------------
// Photos and videos share the space in one calculation (shrink/plan.ts, allocate):
// each gets the same share of what it would take at a good quality, none less
// than its smallest. A photo's weight is its pixels, so a video's is what it
// would take at a good quality in photo pixels' worth, at about what a good
// JPEG costs a pixel. Videos bend furthest: their smallest is far below good.

/** About what a photo made smaller costs a pixel at its usual quality (a 2048-pixel copy is about 470 KB). */
export const PHOTO_BYTES_PER_PIXEL = 0.15
/**
 * Bits a second the sound is counted at before it's made. Safari's AAC comes
 * out at 47 kbit/s at best (half the rate), whatever it's asked; other
 * browsers give the 32 asked. If the real sound makes a video too long for its
 * share, the worker tries Opus, and the row says it's too much (shrink.ts).
 */
export const SOUND_GUESS = 48_000

export interface VideoShape {
  /** As stored: a phone's portrait video is stored on its side. */
  width: number
  height: number
  seconds: number
  fps: number
  sound: boolean
}

const soundBytes = (v: VideoShape) => (v.sound ? Math.ceil((SOUND_GUESS * v.seconds) / 8) : 0)

/** What a video takes at a good quality: the ladder's first step at BPP_GOOD, with its sound. */
export function goodBytes(v: VideoShape): number {
  const step = LADDER[0]
  const fps = Math.min(step.fps, Math.max(1, Math.round(v.fps)) || step.fps)
  const d = fitShort(v, step.short)
  return Math.ceil((d.width * d.height * fps * BPP_GOOD * v.seconds) / 8) + soundBytes(v) + overhead(v.seconds, fps, 47)
}

/** The least a video can take: the ladder's last step at BPP_FLOOR, with its sound; or what a step of "Smallest" makes it. */
export function leastBytes(v: VideoShape, step: VideoStep = LAST_STEP): number {
  return leastTarget(v, v.seconds, v.fps, soundBytes(v), 47, step)
}

/**
 * The same with the sound known (audioBytes, in audioFramesPerSecond pieces): the target that
 * planVideo makes the ladder's last step at BPP_FLOOR, for a video made as small as it goes;
 * or what a step of "Smallest" takes at its bits per pixel (planStep).
 */
export function leastTarget(src: Dims, seconds: number, srcFps: number, audioBytes: number, audioFramesPerSecond: number, step: VideoStep = LAST_STEP): number {
  const fps = stepFps(step, srcFps)
  const d = fitShort(src, step.short)
  // A byte over, so rounding can't bring planVideo's bits per pixel a hair under BPP_FLOOR (the review, 2026-10-26).
  return Math.ceil((d.width * d.height * fps * step.bpp * seconds) / 8) + 1 + audioBytes + overhead(seconds, fps, audioFramesPerSecond)
}

/** How "Smallest" makes a video at a step, beside audioBytes of sound: that size and frame rate, at just above its bits per pixel (leastTarget's bytes). */
export function planStep(src: Dims, seconds: number, srcFps: number, audioBytes: number, audioFramesPerSecond: number, step: VideoStep): VideoPlan {
  const fps = stepFps(step, srcFps)
  const d = fitShort(src, step.short)
  const room = leastTarget(src, seconds, srcFps, audioBytes, audioFramesPerSecond, step) - audioBytes - overhead(seconds, fps, audioFramesPerSecond)
  const pixels = d.width * d.height * fps
  const bitrate = (room * 8) / seconds
  return { ...d, fps, bitrate: Math.floor(bitrate), bpp: bitrate / pixels }
}

/** A video's weight beside photos' pixels. */
export const videoWeight = (v: VideoShape) => Math.max(1, goodBytes(v) / PHOTO_BYTES_PER_PIXEL)
