// "Make audio smaller to fit": an audio file
// (music, a voice memo, a talk) too big to go as it is is decoded by the browser (read.ts, or the
// page for kinds it decodes whole: page.ts), mixed to stereo or mono as the
// plan says (plan.ts), and encoded again as Opus at the bitrate that fills its
// share, a run at a time, so a long one is never in memory whole. The result is
// a new file (an M4A, video/mux.ts): none of the original's tags (title,
// artist, cover art, lyrics) or anything else about it are in it. Runs in the
// video worker (video/shrinkWorker.ts), which every visit fetches anyway.
import { mux, type MuxSample } from '../video/mux.ts'
import { bytesOf } from '../video/shrink.ts'
import { AUDIO_FLOOR, PEAKS, levels, planAt, planAudio, retryAudioBitrate, type AudioPlan } from './plan.ts'
import { decodeAudio, dequeued, AudioError, type AudioKind } from './read.ts'

export { CantDecode, AudioError } from './read.ts'

/** Tries in all, when one comes out over (Opus rarely does). */
const MAX_PASSES = 3

export type AudioInput = { file: Blob; kind: AudioKind; seconds: number; channels: number } | { planes: Float32Array[]; rate: number }

export interface AudioProgress {
  pass: number
  /** 0 to 1, through this try. */
  done: number
}

export interface AudioReport {
  seconds: number
  bitrate: number
  channels: 1 | 2
  /** The rate the encoder was given: the sound's own, or 48 kHz when it had to be changed first. */
  rate: number
  resampled: boolean
  bytes: number
  passes: { bitrate: number; channels: number; bytes: number; ms: number }[]
  /** PEAKS numbers, 0 to 1: how loud each stretch is, for its picture. */
  peaks: number[]
}

export interface AudioResult {
  data: Uint8Array
  report: AudioReport
}

export interface AudioOptions {
  onProgress?: (p: AudioProgress) => void
  signal?: AbortSignal
}

const now = () => performance.now()

/** Makes a sound file at most target bytes as an Opus M4A, or throws: 'too-long', 'no-opus-encoder', CantDecode, 'stopped'… */
export async function shrinkAudio(input: AudioInput, target: number, o: AudioOptions = {}): Promise<AudioResult> {
  if (typeof AudioEncoder === 'undefined' || typeof AudioData === 'undefined') throw new AudioError('no-webcodecs')
  const seconds = 'planes' in input ? input.planes[0].length / input.rate : input.seconds
  const channels = 'planes' in input ? input.planes.length : input.channels
  const first = planAudio({ seconds, channels }, target)
  if (!first) throw new AudioError('too-long')
  let plan: AudioPlan = first
  const passes: AudioReport['passes'] = []
  for (let pass = 1; ; pass++) {
    const started = now()
    const made = await encodePass(input, seconds, plan, (done) => o.onProgress?.({ pass, done }), o.signal)
    const data = mux(null, { codec: 'opus', sampleRate: made.rate, channels: plan.channels, description: made.description, samples: made.samples })
    passes.push({ bitrate: plan.bitrate, channels: plan.channels, bytes: data.length, ms: Math.round(now() - started) })
    if (data.length <= target) {
      const sound = made.samples.reduce((n, s) => n + s.data.length, 0)
      return {
        data,
        report: { seconds, bitrate: Math.round((sound * 8) / Math.max(0.001, seconds)), channels: plan.channels, rate: made.rate, resampled: made.resampled, bytes: data.length, passes, peaks: made.peaks },
      }
    }
    // A try over at the floor may go a little under it: 15 kbit/s sounds no different from 16.
    const next: AudioPlan | undefined = pass < MAX_PASSES ? planAt({ seconds, channels }, retryAudioBitrate(plan.bitrate, data.length, target), AUDIO_FLOOR * 0.9) : undefined
    if (!next) throw new AudioError('too-long')
    plan = next
  }
}

/** An outline never takes more than this much of the sound: a small file can claim, or hold, hours of silence. */
export const OUTLINE_MAX_SECONDS = 20 * 60

/**
 * An audio file's outline for its picture (PEAKS loudness levels: levels() in
 * plan.ts), decoded a run at a time as when it's made smaller, never more than
 * OUTLINE_MAX_SECONDS of it, whatever its header says: null past that, or if
 * this browser can't decode it. seconds: its length, as its header says.
 */
export async function outlineOf(file: Blob, kind: AudioKind, seconds: number): Promise<number[] | null> {
  const squares = new Float64Array(PEAKS)
  const counts = new Float64Array(PEAKS)
  let expected = 0
  let limit = 0
  let seen = 0
  try {
    await decodeAudio(file, kind, (planes, rate) => {
      if (!expected) {
        expected = Math.max(1, Math.round(seconds * rate))
        limit = OUTLINE_MAX_SECONDS * rate
      }
      const n = planes[0].length
      if (seen + n > limit) throw new AudioError('too-long')
      for (let i = 0; i < n; i++) {
        const b = Math.min(PEAKS - 1, Math.floor(((seen + i) * PEAKS) / expected))
        for (const p of planes) squares[b] += p[i] * p[i]
        counts[b] += planes.length
      }
      seen += n
    })
  } catch {
    return null
  }
  return seen ? levels(squares, counts) : null
}

interface Made {
  samples: MuxSample[]
  description?: Uint8Array
  rate: number
  resampled: boolean
  peaks: number[]
}

/** How often progress is said while a try runs, whatever the codecs are doing. */
const PROGRESS_MS = 250

/**
 * One try: the whole sound, decoded and encoded at the plan's bitrate and
 * channels. Its progress is said on a clock, from what the encoder has
 * given back (OpusOut.progress): a browser's codecs may do much of the work
 * in bursts, at the end (seen on an iPhone, 2026-10-25: the bar stood
 * still, then jumped), and between the pieces handed over nothing was said.
 */
async function encodePass(input: AudioInput, seconds: number, plan: AudioPlan, progress: (done: number) => void, signal?: AbortSignal): Promise<Made> {
  const out = new OpusOut(plan, seconds, signal)
  // Only when it has moved: a codec that stalls then goes quiet, so the page's watchdog
  // (a minute's silence, video/client.ts) still ends the job and starts a fresh worker.
  let said = -1
  const clock = setInterval(() => {
    const done = out.progress()
    if (done <= said) return
    said = done
    progress(done)
  }, PROGRESS_MS)
  try {
    if ('planes' in input) {
      // Decoded on the page already: handed over a second at a time.
      const step = input.rate
      for (let i = 0; i < input.planes[0].length; i += step) {
        if (signal?.aborted) throw new AudioError('stopped')
        out.take(
          input.planes.map((p) => p.subarray(i, i + step)),
          input.rate,
        )
        await out.drained()
      }
    } else {
      await decodeAudio(input.file, input.kind, (planes, rate) => out.take(planes, rate), { signal, wait: () => out.drained() })
    }
    return await out.finish()
  } finally {
    clearInterval(clock)
    out.close()
  }
}

/** Opus at the plan's bitrate and channels, from sound handed over in pieces at any rate; the encoder is set up from the first. */
class OpusOut {
  private encoder?: AudioEncoder
  private resampler?: Resampler
  private rate = 0
  private resampled = false
  private written = 0 // samples given to the encoder, at its rate
  private seen = 0 // samples taken, at the sound's rate
  private encodedUs = 0 // how far into the sound the encoder has given back, in microseconds
  private expected = 0
  private failure: unknown
  private samples: MuxSample[] = []
  private description?: Uint8Array
  private squares = new Float64Array(PEAKS)
  private counts = new Float64Array(PEAKS)
  private setup?: Promise<void>
  private pending: { planes: Float32Array[]; rate: number }[] = []

  private readonly plan: AudioPlan
  private readonly seconds: number
  private readonly signal?: AbortSignal

  constructor(plan: AudioPlan, seconds: number, signal?: AbortSignal) {
    this.plan = plan
    this.seconds = seconds
    this.signal = signal
  }

  /** A piece of the sound: one array a channel. Mixed, measured for its picture, and queued for the encoder. */
  take(planes: Float32Array[], rate: number) {
    if (this.failure) return
    const mixed = mix(planes, this.plan.channels)
    if (!this.rate) {
      this.rate = rate
      this.expected = Math.max(1, Math.round(this.seconds * rate))
      this.setup = this.open(rate).catch((e) => {
        this.failure ??= e
      })
    }
    if (rate !== this.rate) throw new AudioError(`the rate changed from ${this.rate} to ${rate}`)
    this.measure(mixed)
    this.pending.push({ planes: mixed, rate })
    if (this.encoder) this.flushPending()
  }

  /**
   * How far through, 0 to 1: how much the encoder has given back, or half
   * of how much has been handed to it if that's further, so the bar still
   * moves where a browser's encoder holds its output back until the end.
   */
  progress() {
    if (!this.expected) return 0
    const handed = Math.min(1, this.seen / this.expected)
    const encoded = Math.min(1, this.encodedUs / (this.seconds * 1e6))
    return Math.max(encoded, 0.5 * handed)
  }

  /** Resolves once the encoder isn't far behind, so pieces don't pile up in memory. */
  async drained() {
    await this.setup
    if (this.failure) throw this.failure
    this.flushPending()
    while (this.encoder && !this.failure && this.encoder.encodeQueueSize > 8) {
      if (this.signal?.aborted) throw new AudioError('stopped') // a stalled encoder mustn't hold a stop up
      await dequeued(this.encoder)
    }
    if (this.failure) throw this.failure
  }

  async finish(): Promise<Made> {
    await this.drained()
    if (!this.encoder) throw new AudioError('no sound came out')
    if (this.resampler) this.encode(this.resampler.flush())
    await this.encoder.flush()
    if (this.failure) throw this.failure
    if (!this.samples.length) throw new AudioError('no sound came out')
    const first = Math.max(0, this.samples[0].pts)
    return {
      samples: this.samples.map((s) => ({ ...s, pts: s.pts - first })),
      description: this.description,
      rate: this.resampler ? 48000 : this.rate,
      resampled: this.resampled,
      peaks: levels(this.squares, this.counts),
    }
  }

  close() {
    if (this.encoder && this.encoder.state !== 'closed') this.encoder.close()
  }

  /** The encoder, at the sound's own rate if it takes it, else at 48 kHz with the sound changed to that first. */
  private async open(rate: number) {
    const config = (r: number): AudioEncoderConfig => ({
      codec: 'opus',
      sampleRate: r,
      numberOfChannels: this.plan.channels,
      bitrate: this.plan.bitrate,
      // 60 ms pieces: a third of the entries in the index (Chrome; others keep their own, 20 ms).
      opus: { frameDuration: 60_000 },
    } as AudioEncoderConfig)
    // Opus's own rates (8, 12, 16, 24, 48 kHz) are usually taken as they are; any the encoder refuses go at 48 kHz.
    let use = rate
    if (!(await takes(config(rate)))) use = 48000
    if (!(await takes(config(use)))) throw new AudioError('no-opus-encoder')
    if (use !== rate) {
      this.resampler = new Resampler(rate, use, this.plan.channels)
      this.resampled = true
    }
    this.encoder = new AudioEncoder({
      output: (chunk, meta) => {
        const desc = meta?.decoderConfig?.description
        if (desc && !this.description) this.description = bytesOf(desc)
        const data = new Uint8Array(chunk.byteLength)
        chunk.copyTo(data)
        this.samples.push({ data, pts: chunk.timestamp, duration: chunk.duration ?? 0, key: true })
        this.encodedUs = Math.max(this.encodedUs, chunk.timestamp + (chunk.duration ?? 0))
      },
      error: (e) => (this.failure ??= e),
    })
    this.encoder.configure(config(use))
  }

  private flushPending() {
    for (const { planes } of this.pending.splice(0)) {
      this.seen += planes[0].length
      this.encode(this.resampler ? this.resampler.push(planes) : planes)
    }
  }

  private encode(planes: Float32Array[]) {
    const n = planes[0]?.length ?? 0
    if (!n || this.failure || !this.encoder) return
    const rate = this.resampler ? 48000 : this.rate
    const data = new Float32Array(n * planes.length)
    planes.forEach((p, c) => data.set(p, c * n))
    const audio = new AudioData({ format: 'f32-planar', sampleRate: rate, numberOfFrames: n, numberOfChannels: planes.length, timestamp: Math.round((this.written / rate) * 1e6), data })
    try {
      this.encoder.encode(audio)
    } catch (e) {
      this.failure ??= e
    } finally {
      audio.close()
    }
    this.written += n
  }

  /** How loud each stretch is, for the waveform: its samples' squares added up (levels() in plan.ts). */
  private measure(planes: Float32Array[]) {
    const start = this.seen + this.pending.reduce((n, p) => n + p.planes[0].length, 0)
    const n = planes[0].length
    for (let i = 0; i < n; i++) {
      const b = Math.min(PEAKS - 1, Math.floor(((start + i) * PEAKS) / this.expected))
      for (const p of planes) this.squares[b] += p[i] * p[i]
      this.counts[b] += planes.length
    }
  }
}

/** Whether the encoder says it takes a configuration (asking can throw on iOS 26.1: then configure() is the test, so yes). */
async function takes(config: AudioEncoderConfig): Promise<boolean> {
  try {
    return (await AudioEncoder.isConfigSupported(config)).supported !== false
  } catch {
    return true
  }
}

/**
 * The sound in out channels: mono, the average of them all; stereo, the
 * first two (a mono recording in both). Surround sound keeps only its front
 * left and right, rare in what's sent.
 */
export function mix(planes: Float32Array[], out: 1 | 2): Float32Array[] {
  if (out === 2) return planes.length >= 2 ? [planes[0], planes[1]] : [planes[0], planes[0]]
  if (planes.length === 1) return [planes[0]]
  const n = planes[0].length
  const mono = new Float32Array(n)
  for (const p of planes) for (let i = 0; i < n; i++) mono[i] += p[i]
  for (let i = 0; i < n; i++) mono[i] /= planes.length
  return [mono]
}

/**
 * Sound changed from one rate to another (44.1 kHz to 48 kHz, for an Opus
 * encoder that takes only its own rates): each new sample is worked out from
 * its 32 nearest neighbours, weighted by a windowed sinc (a low-pass filter,
 * so nothing above the lower rate's highest frequency folds back), from a
 * table of 256 fractions of a sample. Taken a piece at a time, as it's decoded.
 */
export class Resampler {
  private static readonly HALF = 16
  private static readonly PHASES = 256
  private readonly table: Float32Array
  private readonly step: number
  private buffers: Float32Array[]
  private length: number
  private pos: number

  constructor(inRate: number, outRate: number, channels: number) {
    const { HALF, PHASES } = Resampler
    this.step = inRate / outRate
    // Cut a little below the lower rate's highest frequency, as a share of the input's.
    const cut = Math.min(1, outRate / inRate) * 0.92
    this.table = new Float32Array((PHASES + 1) * 2 * HALF)
    for (let ph = 0; ph <= PHASES; ph++) {
      const frac = ph / PHASES
      let sum = 0
      for (let k = 0; k < 2 * HALF; k++) {
        const t = k - (HALF - 1) - frac
        const x = Math.PI * cut * t
        const sinc = t === 0 ? 1 : Math.sin(x) / x
        const w = t / HALF
        const blackman = Math.abs(w) >= 1 ? 0 : 0.42 + 0.5 * Math.cos(Math.PI * w) + 0.08 * Math.cos(2 * Math.PI * w)
        const v = sinc * blackman
        this.table[ph * 2 * HALF + k] = v
        sum += v
      }
      for (let k = 0; k < 2 * HALF; k++) this.table[ph * 2 * HALF + k] /= sum
    }
    // HALF - 1 silent samples first, so the first sample out lines up with the first in.
    this.buffers = Array.from({ length: channels }, () => new Float32Array(4096))
    this.length = HALF - 1
    this.pos = HALF - 1
  }

  /** Takes a piece of sound and gives back as much as can be worked out so far. */
  push(planes: Float32Array[]): Float32Array[] {
    const n = planes[0].length
    if (this.length + n > this.buffers[0].length) {
      const size = Math.max(this.buffers[0].length * 2, this.length + n)
      this.buffers = this.buffers.map((b) => {
        const bigger = new Float32Array(size)
        bigger.set(b.subarray(0, this.length))
        return bigger
      })
    }
    this.buffers.forEach((b, c) => b.set(planes[c], this.length))
    this.length += n
    return this.drain()
  }

  /** The rest, once the sound has ended. */
  flush(): Float32Array[] {
    return this.push(this.buffers.map(() => new Float32Array(Resampler.HALF)))
  }

  private drain(): Float32Array[] {
    const { HALF, PHASES } = Resampler
    // Each sample out needs HALF in after it: every one whose place is before length - HALF.
    const count = Math.max(0, Math.ceil((this.length - HALF - this.pos) / this.step))
    const out = this.buffers.map(() => new Float32Array(count))
    let pos = this.pos
    for (let j = 0; j < count; j++, pos += this.step) {
      const i = Math.floor(pos)
      const row = Math.round((pos - i) * PHASES) * 2 * HALF
      const from = i - (HALF - 1)
      for (let c = 0; c < this.buffers.length; c++) {
        const b = this.buffers[c]
        let v = 0
        for (let k = 0; k < 2 * HALF; k++) v += b[from + k] * this.table[row + k]
        out[c][j] = v
      }
    }
    // Keep only what the next samples still need.
    const keep = Math.max(0, Math.floor(pos) - (HALF - 1))
    this.buffers.forEach((b) => b.copyWithin(0, keep, this.length))
    this.length -= keep
    this.pos = pos - keep
    return out
  }
}
