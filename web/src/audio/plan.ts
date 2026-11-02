// "Make audio smaller to fit": the sizing decisions, kept apart from the
// encoding (shrink.ts) so they can be tested without a browser.
//
// An audio file that doesn't fit is made again as Opus,
// which comes out at the size it's asked for. Like a photo, it
// doesn't fill the space just because it's there: it stops at AUDIO_GOOD,
// hard to tell from the original. Short of room it goes lower, in stereo down
// to STEREO_FROM and then in mono, which needs about half the bits to sound
// as clear, down to AUDIO_FLOOR, still fine for speech but flat for music.
// Past that it's too long. Opus works at 48 kHz and narrows its own range of
// treble as the bitrate falls, so there's no sample rate to choose.
//
// Unlike a video, audio is made again whenever its share of the space
// changes enough (a photo added or taken away): it takes seconds, and Opus
// never comes out over, so it can't leave the others stuck.

/** Bits a second at which music sounds as good as it needs to: the most it gets. */
export const AUDIO_GOOD = 96_000
/** The same for a recording made in mono, which needs fewer. */
export const MONO_GOOD = 64_000
/** Below this, stereo goes in mono. */
export const STEREO_FROM = 40_000
/** Below this even mono sounds too poor: the recording is too long. */
export const AUDIO_FLOOR = 16_000
/** Points along the sound for its picture (a waveform): how loud each stretch is. */
export const PEAKS = 400

/**
 * Each stretch's loudness (its root mean square, which follows what the ear
 * hears better than its loudest moment: a mastered song peaks near the top all
 * the way through), from the sums of its samples' squares and how many there
 * were, as numbers from 0 to 1, the loudest stretch 1.
 */
export function levels(squares: Float64Array, counts: Float64Array): number[] {
  const rms = Array.from(squares, (s, i) => (counts[i] ? Math.sqrt(s / counts[i]) : 0))
  const top = Math.max(1e-9, ...rms)
  return rms.map((v) => Math.round((v / top) * 1000) / 1000)
}
/** How long each piece of Opus lasts, in microseconds, as the index is counted. Asked for 60 ms (fewer index entries), counted at 20, Opus's usual, which a browser may give instead. */
export const FRAME_US = 20_000

export interface AudioShape {
  seconds: number
  /** The original's: 1 for mono, 2 or more otherwise. */
  channels: number
}

export interface AudioPlan {
  /** Bits a second for the sound. */
  bitrate: number
  channels: 1 | 2
}

/** The bytes the index and headers take, about: four for each piece's size, a few for each second's chunk, and the boxes. */
export function audioOverhead(seconds: number): number {
  return 1500 + Math.ceil(seconds * ((1e6 / FRAME_US) * 4 + 8))
}

/** The most a recording of this shape gets: AUDIO_GOOD, or MONO_GOOD for a mono one. */
export const goodRate = (a: AudioShape) => (a.channels >= 2 ? AUDIO_GOOD : MONO_GOOD)

/**
 * How to make a recording fit target bytes: the bitrate that fills it, at
 * most a good one, in stereo from STEREO_FROM if it was stereo; undefined
 * when even AUDIO_FLOOR won't fit.
 */
export function planAudio(a: AudioShape, target: number): AudioPlan | undefined {
  if (!(a.seconds > 0)) return undefined
  const room = target - audioOverhead(a.seconds)
  return planAt(a, (room * 8) / a.seconds)
}

/**
 * A recording at this many bits a second (at most a good one): in stereo from
 * STEREO_FROM if it was stereo; undefined below floor (AUDIO_FLOOR, or a
 * little under for a second try that came out over at the floor).
 */
export function planAt(a: AudioShape, bits: number, floor = AUDIO_FLOOR): AudioPlan | undefined {
  const bitrate = Math.floor(Math.min(goodRate(a), bits))
  if (!(bitrate >= floor)) return undefined
  return { bitrate, channels: a.channels >= 2 && bitrate >= STEREO_FROM ? 2 : 1 }
}

/** What a recording takes at a good quality. */
export const audioGoodBytes = (a: AudioShape) => audioOverhead(a.seconds) + Math.ceil((goodRate(a) * a.seconds) / 8)

/**
 * Seconds the least allows beyond the header's length: a decoder may count a recording a little
 * longer (its delay and padding), and planAudio's floor must hold for that length too, and for
 * rounding at exactly AUDIO_FLOOR (the review, 2026-10-26: "Smallest" aims at exactly this).
 */
export const LEEWAY = 0.1

/** The least it can take: AUDIO_FLOOR, for a little longer than it is, and a byte over so rounding can't put it under. */
export const audioLeastBytes = (a: AudioShape) => {
  const seconds = a.seconds + LEEWAY
  return audioOverhead(seconds) + Math.ceil((AUDIO_FLOOR * seconds) / 8) + 1
}

/**
 * Its weight beside photos' pixels (video/plan.ts): what it takes at a good
 * quality, in photo pixels' worth, so a long recording takes more of the space and
 * the photos beside it are made smaller, as beside a video.
 */
export const audioWeight = (a: AudioShape, bytesPerPixel: number) => Math.max(1, audioGoodBytes(a) / bytesPerPixel)

/**
 * The bitrate to try again with when a try came out at got bytes against a
 * target: Opus lands within a percent or two, so this is rare; it aims a
 * little under.
 */
export const retryAudioBitrate = (bitrate: number, got: number, target: number) => Math.floor((bitrate * target * 0.97) / Math.max(1, got))
