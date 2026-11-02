// "Make videos smaller to fit". The browser decodes the video (WebCodecs: the
// phone's own video hardware where it has it), each picture is drawn smaller
// on a canvas, and the browser encodes them again as H.264 at a bitrate chosen
// so the file fits (plan.ts). The sound is decoded, mixed to mono and encoded
// again as AAC, or as Opus where the browser has no AAC encoder, or left out
// when it can't be. The result is a new file (mux.ts): none of the original's
// hidden details (location, phone, dates) are in it. Runs in a worker
// (shrinkWorker.ts), reading the original a run of samples at a time.
import { forMp4 } from './avc.ts'
import { VideoError, aacConfig, demux, fileReader, readSamplesOf, showsAt, type Movie, type Read, type Track } from './demux.ts'
import { mux, type MuxAudio, type MuxSample } from './mux.ts'
import { AUDIO_BITRATE, BPP_GOOD, KEY_EVERY, leastTarget, planStep, planVideo, retryBitrate, smallerStep, type VideoPlan, type VideoStep } from './plan.ts'

export { VideoError }

/** H.264 at level 3.1, best compression first: High, Main, Constrained Baseline. */
const AVC = ['avc1.64001f', 'avc1.4d001f', 'avc1.42e01f']
/** Tries at a lower bitrate when the encoder overshoots. */
const MAX_PASSES = 3

export type Stage = 'reading' | 'sound' | 'pictures' | 'packing'
export interface Progress {
  stage: Stage
  pass: number
  /** 0 to 1, through this stage. */
  done: number
}

export interface Options {
  /**
   * As "Smallest" (the tray's setting) makes it, with target only a ceiling: at the first of these steps
   * whose size fits beside its sound, from the one the page planned for down (plan.ts, levelSteps).
   */
  steps?: readonly VideoStep[]
  /** How to draw each picture smaller: on a canvas (the default), or with createImageBitmap. */
  scaler?: 'canvas' | 'bitmap'
  /** Bits a second for the sound; 0 leaves it out. */
  audioBitrate?: number
  /** 'opus' makes the sound Opus whatever the browser offers: to test what plays it. */
  soundAs?: 'auto' | 'opus'
  /** For testing: whether the pictures are opened, and made again, with the video hardware or without, to find which one upsets a browser. */
  decoderHw?: HardwareAcceleration
  encoderHw?: HardwareAcceleration
  onProgress?: (p: Progress) => void
  signal?: AbortSignal
}

/** What a made video's report holds. */
export interface Report {
  source: {
    brand: string
    bytes: number
    seconds: number
    video: string
    width: number
    height: number
    rotation: number
    transfer: string
    fps: number
    frames: number
    audio: string
  }
  decoder: { codec: string; hardware?: string }
  /** How the pictures were drawn smaller: a canvas, or createImageBitmap (when a canvas didn't give back what was drawn), with what each way's check read back. */
  drawing?: string
  firstFrame?: { format: string | null; codedWidth: number; codedHeight: number; colorSpace: string }
  encoder?: { codec: string; latency: string; avcFormat: boolean | null; hardware: boolean | null; fixed: string; stalled: boolean }
  sound: { codec: 'aac' | 'opus' | 'none'; kind?: string; why?: string; bytes: number; bitrate: number; ms: number; fixed?: string; tries: string[] }
  plan?: VideoPlan
  passes: { bitrate: number; videoBytes: number; total: number; frames: number; ms: number; keys: number }[]
  ms: { reading: number; total: number }
  output?: { bytes: number; width: number; height: number; fps: number }
}

export interface Result {
  data: Uint8Array
  report: Report
}

const now = () => performance.now()

/**
 * Whether a codec says it takes a configuration: true, false, or null when
 * asking threw (iOS 26.1 throws a TypeError for some): then configure() and
 * its error callback are the real test.
 */
async function takes(ask: () => Promise<{ supported?: boolean }>): Promise<boolean | null> {
  try {
    return !!(await ask()).supported
  } catch {
    return null
  }
}

/** How long an encoder may go without handing anything back before it counts as stuck. */
const STALL_MS = 10_000

/** The track of this kind that's played: the first enabled one, else the first. */
const pick = (movie: Movie, kind: Track['kind']) => {
  const tracks = movie.tracks.filter((t) => t.kind === kind && t.samples.length)
  return tracks.find((t) => t.enabled) ?? tracks[0]
}

/**
 * A codec's configuration bytes, copied out of whatever buffer they came in.
 * It never names SharedArrayBuffer, which a page without cross-origin
 * isolation doesn't have (a copy of Slynk served by a plain file server, or
 * the dev server): there, `d instanceof SharedArrayBuffer` would throw.
 */
export const bytesOf = (d: AllowSharedBufferSource) =>
  ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength).slice() : new Uint8Array(d.slice(0))
const describe = (t?: Track) => (t ? `${t.codec || t.format}${t.kind === 'audio' ? `, ${t.channels} ch, ${t.sampleRate} Hz` : ''}` : 'none')

/** Seconds the track plays for. */
function trackSeconds(t: Track): number {
  let end = 0
  for (const s of t.samples) end = Math.max(end, s.cts + s.duration)
  return (end - t.mediaStart) / t.timescale
}

/** Waits for a codec's queue to go down (or a moment, if the browser has no dequeue event). */
function dequeued(...codecs: EventTarget[]): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      for (const c of codecs) c.removeEventListener('dequeue', done)
      clearTimeout(timer)
      resolve()
    }
    for (const c of codecs) c.addEventListener('dequeue', done)
    const timer = setTimeout(done, 10)
  })
}

function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw new VideoError('stopped')
}

/** Makes the video at most target bytes, or throws (with what was learnt so far as the error's report). */
export async function shrinkVideo(file: Blob, target: number, o: Options = {}): Promise<Result> {
  const so: { report?: Report } = {}
  try {
    return await run(file, target, o, so)
  } catch (e) {
    throw Object.assign(e instanceof Error ? e : new Error(String(e)), { report: so.report })
  }
}

async function run(file: Blob, target: number, o: Options, so: { report?: Report }): Promise<Result> {
  const t0 = now()
  if (typeof VideoDecoder === 'undefined' || typeof VideoEncoder === 'undefined') throw new VideoError('no-webcodecs')
  o.onProgress?.({ stage: 'reading', pass: 0, done: 0 })
  const read = fileReader(file)
  const movie: Movie = await demux(file, read)
  const video = pick(movie, 'video')
  const sound = pick(movie, 'audio')
  if (!video) throw new VideoError('a video without pictures')
  const seconds = trackSeconds(video)
  const report: Report = {
    source: {
      brand: movie.brand,
      bytes: file.size,
      seconds,
      video: describe(video),
      width: video.width,
      height: video.height,
      rotation: video.rotation,
      transfer: video.transfer,
      fps: video.samples.length / seconds,
      frames: video.samples.length,
      audio: describe(sound),
    },
    decoder: { codec: video.codec },
    sound: { codec: 'none', bytes: 0, bitrate: 0, ms: 0, tries: [] },
    passes: [],
    ms: { reading: now() - t0, total: 0 },
  }
  so.report = report
  if (!video.codec) throw new VideoError(`can't-decode ${video.format}`)
  const decoderConfig: VideoDecoderConfig = { codec: video.codec, description: video.description, codedWidth: video.width, codedHeight: video.height }
  if (o.decoderHw) decoderConfig.hardwareAcceleration = o.decoderHw
  if ((await takes(() => VideoDecoder.isConfigSupported(decoderConfig))) === false) throw new VideoError(`can't-decode ${video.codec}`)
  const hw = await takes(() => VideoDecoder.isConfigSupported({ ...decoderConfig, hardwareAcceleration: 'prefer-hardware' }))
  report.decoder.hardware = hw === null ? 'unknown' : hw ? 'yes' : 'no'

  // Too long even with no sound at all: said before any decoding.
  if (!planVideo(video, seconds, report.source.fps, target, 0)) throw new VideoError('too-long')

  // The sound first: its size is known before the pictures' bitrate is chosen.
  const t1 = now()
  const audioBitrate = o.audioBitrate ?? AUDIO_BITRATE
  const soundOf = async (as: Options['soundAs']) => {
    const s = sound && audioBitrate ? await encodeSound(read, sound, audioBitrate, { ...o, soundAs: as }) : { why: sound ? 'left out' : 'no sound' }
    const audio = 'audio' in s ? s.audio : undefined
    const bytes = audio ? audio.samples.reduce((n, x) => n + x.data.length, 0) : 0
    const audioSeconds = audio ? audio.samples.reduce((n, x) => n + x.duration, 0) / 1e6 : 0
    const fps = audio ? audio.samples.length / Math.max(seconds, 0.001) : 0
    report.sound = {
      codec: audio?.codec ?? 'none',
      why: 'why' in s ? s.why : undefined,
      bytes,
      bitrate: audioSeconds ? Math.round((bytes * 8) / audioSeconds) : 0,
      ms: now() - t1,
      fixed: 'fixed' in s ? s.fixed : undefined,
      tries: 'tries' in s ? s.tries : [],
      kind: 'kind' in s ? s.kind : undefined,
    }
    checkAbort(o.signal)
    // "Smallest": the first of its steps that fits beside this sound, which only now is known, made at
    // just that size. Never below the last: with too little room for that, it doesn't fit.
    if (!o.steps) return { audio, sound: report.sound, at: 0, plan: planVideo(video, seconds, report.source.fps, target, bytes, fps) }
    const at = o.steps.findIndex((step) => leastTarget(video, seconds, report.source.fps, bytes, fps, step) <= target)
    return { audio, sound: report.sound, at, plan: at < 0 ? undefined : planStep(video, seconds, report.source.fps, bytes, fps, o.steps[at]) }
  }
  let made = await soundOf(o.soundAs)
  // Safari's AAC comes out far bigger than asked (47-65 kbit/s for 32). If that's what makes it too long,
  // or takes it a step down, Opus, made at the size asked and played on iPhones, may fit better: kept
  // only if it does, as AAC plays everywhere.
  if ((!made.plan || made.at > 0) && made.audio?.codec === 'aac') {
    const aac = made
    const opus = await soundOf('opus')
    if (opus.plan && (!aac.plan || opus.at < aac.at)) made = opus
    report.sound = { ...made.sound, tries: [...aac.sound.tries, ...opus.sound.tries] }
  }
  const { audio, plan: planned } = made
  if (!planned) throw new VideoError('too-long')
  let plan: VideoPlan = planned
  report.plan = plan
  const encoder = await pickEncoder(plan)
  if (!encoder) throw new VideoError('no-h264-encoder')
  let bitrate = plan.bitrate
  let config: VideoEncoderConfig = o.encoderHw ? { ...encoder.config, hardwareAcceleration: o.encoderHw } : encoder.config
  let stalled = false
  let lost = false
  let raised = false
  let overs = 0 // tries that came out too big
  let smaller = 0 // steps down the ladder taken because of them (each allows one more try)
  let best: Uint8Array | undefined // the largest that fits so far
  const done = (data: Uint8Array) => {
    report.ms.total = now() - t0
    report.output = { bytes: data.length, width: plan.width, height: plan.height, fps: plan.fps }
    return { data, report }
  }
  for (let pass = 1; ; pass++) {
    const t = now()
    let pictures: Awaited<ReturnType<typeof encodePictures>>
    try {
      pictures = await encodePictures(read, video, decoderConfig, { ...config, bitrate }, plan, pass, report, o)
    } catch (e) {
      // The canvas was lost partway: once, the same pass again, on a fresh canvas.
      if (e instanceof VideoError && e.message === 'canvas-lost' && !lost) {
        lost = true
        pass--
        continue
      }
      // Safari 27.0 on a Mac never hands back High or Main pictures in 'quality'
      // mode (WebKit bug 324827): once, try Baseline in 'realtime' instead.
      if (!(e instanceof VideoError && e.message === 'encoder-stalled') || stalled) throw e
      stalled = true
      config = { ...config, codec: 'avc1.42e01f', latencyMode: 'realtime' }
      continue
    }
    o.onProgress?.({ stage: 'packing', pass, done: 0 })
    report.encoder = { codec: config.codec, latency: config.latencyMode ?? '', avcFormat: encoder.avcFormat, hardware: encoder.hardware, fixed: pictures.fixed, stalled }
    const data = mux({ width: plan.width, height: plan.height, rotation: video.rotation, description: pictures.description, samples: pictures.samples }, audio)
    const videoBytes = pictures.samples.reduce((n, x) => n + x.data.length, 0)
    report.passes.push({ bitrate, videoBytes, total: data.length, frames: pictures.samples.length, ms: now() - t, keys: pictures.samples.filter((x) => x.key).length })
    if (data.length <= target && (!best || data.length > best.length)) best = data
    const room = target - (data.length - videoBytes)
    const last = pass >= MAX_PASSES + (stalled ? 1 : 0) + smaller
    if (data.length > target) {
      overs++
      const asked = bitrate
      bitrate = retryBitrate(bitrate, videoBytes, room)
      // Some hardware encoders can't get as low as asked at this size (Android's came out
      // over, then over again, then gave up: a 25 MB video, 2026-10-19). Far
      // over the first time, or over a second time: a smaller picture, which brings the file
      // down whatever the encoder does, up to twice. And its steadiest rate control, where
      // the browser has one.
      const far = (videoBytes * 8) / seconds > asked * 1.25
      const step = (far || overs >= 2) && smaller < 2 ? smallerStep(plan, video, report.source.fps) : undefined
      if (step) {
        smaller++
        const pixels = step.width * step.height * step.fps
        plan = { ...step, bitrate, bpp: bitrate / pixels }
        report.plan = plan
        config = { ...config, width: step.width, height: step.height, framerate: step.fps }
      } else if (last) {
        if (best) return done(best)
        throw new VideoError('still-too-big')
      }
      if (config.bitrateMode !== 'constant' && (await takes(() => VideoEncoder.isConfigSupported({ ...config, bitrate, bitrateMode: 'constant' })))) config = { ...config, bitrateMode: 'constant' }
      continue
    }
    // Well under, though the plan wanted more than it got (the iPhone's encoder gave 121
    // kbit/s for 194): once, ask for more, but never more than would really give BPP_GOOD.
    const got = (videoBytes * 8) / seconds
    const short = plan.bpp < BPP_GOOD * 0.99 && data.length < target * 0.85
    // Not after stepping down: the encoder couldn't go lower at the bigger size, so it won't
    // reach a higher target either; another try would only cost the time.
    // Nor when it's to be as small as "Smallest" makes it.
    if (!short || raised || last || smaller || o.steps) return done(best!)
    raised = true
    const goodAsked = plan.width * plan.height * plan.fps * BPP_GOOD * (bitrate / Math.max(1, got))
    bitrate = Math.min(retryBitrate(bitrate, videoBytes, room), Math.floor(goodAsked))
  }
}

/** The best H.264 encoder setup this browser takes for the plan, if any. */
async function pickEncoder(plan: VideoPlan): Promise<{ config: VideoEncoderConfig; avcFormat: boolean | null; hardware: boolean | null } | undefined> {
  const configs = AVC.map(
    (codec): VideoEncoderConfig => ({
      codec,
      width: plan.width,
      height: plan.height,
      bitrate: plan.bitrate,
      framerate: plan.fps,
      bitrateMode: 'variable',
      latencyMode: 'quality',
      avc: { format: 'avc' },
    }),
  )
  for (const config of configs) {
    let answer: VideoEncoderSupport | undefined
    try {
      answer = await VideoEncoder.isConfigSupported(config)
    } catch {
      // It threw rather than answer (iOS 26.1): try the simplest, and let configure() decide.
      return { config: configs[configs.length - 1], avcFormat: null, hardware: null }
    }
    if (!answer.supported) continue
    const hardware = await takes(() => VideoEncoder.isConfigSupported({ ...config, hardwareAcceleration: 'prefer-hardware' }))
    return { config, avcFormat: !!answer.config?.avc, hardware }
  }
  return undefined
}

async function encodePictures(
  read: Read,
  track: Track,
  decoderConfig: VideoDecoderConfig,
  config: VideoEncoderConfig,
  plan: VideoPlan,
  pass: number,
  report: Report,
  o: Options,
): Promise<{ samples: MuxSample[]; description: Uint8Array; fixed: string }> {
  const out: MuxSample[] = []
  let description: Uint8Array | undefined
  let failure: unknown
  let heard = now() // when the encoder last handed a picture back, or was given one with none owed
  let given = 0 // pictures given to the encoder
  const step = 1e6 / plan.fps
  const fail = (e: unknown) => {
    failure ??= e
  }

  const encoder = new VideoEncoder({
    output(chunk, meta) {
      const desc = meta?.decoderConfig?.description
      if (desc && !description) description = bytesOf(desc)
      const data = new Uint8Array(chunk.byteLength)
      chunk.copyTo(data)
      out.push({ data, pts: chunk.timestamp, duration: chunk.duration ?? step, key: chunk.type === 'key' })
      heard = now()
    },
    error: fail,
  })
  encoder.configure(config)
  /** Fails the pass if the encoder owes pictures and has handed nothing back for a while. */
  const stuck = () => {
    if (given > out.length && now() - heard > STALL_MS) fail(new VideoError('encoder-stalled'))
  }
  /** Waits for a flush, unless the encoder is stuck. */
  const flushed = (p: Promise<void>) =>
    new Promise<void>((resolve, reject) => {
      const timer = setInterval(() => {
        stuck()
        if (failure) {
          clearInterval(timer)
          reject(failure)
        }
      }, 500)
      p.then(
        () => (clearInterval(timer), resolve()),
        (e) => (clearInterval(timer), reject(e)),
      )
    })

  const canvas = typeof OffscreenCanvas === 'undefined' ? undefined : new OffscreenCanvas(plan.width, plan.height)
  const ctx = canvas?.getContext('2d', { alpha: false }) ?? undefined
  if (ctx) ctx.imageSmoothingQuality = 'high'
  // The browser's graphics process restarted (the screen flashes): pictures drawn around then
  // may be blank, so this pass is thrown away and made again (run()).
  canvas?.addEventListener('contextlost', () => fail(new VideoError('canvas-lost')))
  // The way of drawing that gives back what was drawn: Safari's Private Browsing can hand back one
  // random colour for a canvas read-back, which would make a flat-colour video with no error.
  const scaler = await drawingWay(o.scaler ?? (ctx ? 'canvas' : 'bitmap'), report)
  let lastSlot = -1
  let lastKey = -Infinity
  // Pictures are drawn and encoded in order; createImageBitmap is asynchronous, so they queue.
  let drawing = Promise.resolve()

  const encodeFrame = (frame: VideoFrame, image: CanvasImageSource | ImageBitmap) => {
    const t = frame.timestamp
    const vf = new VideoFrame(image, { timestamp: t, duration: step })
    const key = t - lastKey >= KEY_EVERY * 1e6
    if (key) lastKey = t
    if (given <= out.length) heard = now() // nothing owed until now: the clock starts here
    given++
    encoder.encode(vf, { keyFrame: key })
    vf.close()
  }

  const decoder = new VideoDecoder({
    output(frame) {
      // Fewer frames a second: keep one per slot of the new rate.
      const t = frame.timestamp
      const slot = Math.floor((t + step / 4) / step)
      if (t < 0 || slot <= lastSlot || failure) {
        frame.close()
        return
      }
      lastSlot = slot
      if (!report.firstFrame) {
        const c = frame.colorSpace
        report.firstFrame = {
          format: frame.format,
          codedWidth: frame.codedWidth,
          codedHeight: frame.codedHeight,
          colorSpace: `${c.primaries ?? '?'}/${c.transfer ?? '?'}/${c.matrix ?? '?'}/${c.fullRange ? 'full' : 'limited'}`,
        }
      }
      if (scaler === 'canvas' && ctx) {
        try {
          ctx.drawImage(frame, 0, 0, plan.width, plan.height)
          encodeFrame(frame, canvas!)
        } catch (e) {
          fail(e)
        } finally {
          frame.close()
        }
        return
      }
      drawing = drawing.then(async () => {
        try {
          const bitmap = await createImageBitmap(frame, { resizeWidth: plan.width, resizeHeight: plan.height, resizeQuality: 'high' })
          encodeFrame(frame, bitmap)
          bitmap.close()
        } catch (e) {
          fail(e)
        } finally {
          frame.close()
        }
      })
    },
    error: fail,
  })
  decoder.configure(decoderConfig)

  const total = track.samples.length
  let fed = 0
  try {
    for await (const { index, data } of readSamplesOf(read, track.samples)) {
      checkAbort(o.signal)
      if (failure) throw failure
      const s = track.samples[index]
      decoder.decode(new EncodedVideoChunk({ type: s.key ? 'key' : 'delta', timestamp: showsAt(track, s), duration: Math.round((s.duration / track.timescale) * 1e6), data }))
      fed++
      stuck()
      if (fed % 15 === 0) o.onProgress?.({ stage: 'pictures', pass, done: fed / total })
      // Keep only a few pictures in flight: a phone's decoder has few to lend.
      while (!failure && (decoder.decodeQueueSize > 4 || encoder.encodeQueueSize > 4)) {
        await dequeued(decoder, encoder)
        stuck()
      }
    }
    await flushed(decoder.flush())
    await drawing
    await flushed(encoder.flush())
    if (failure) throw failure
  } finally {
    if (decoder.state !== 'closed') decoder.close()
    if (encoder.state !== 'closed') encoder.close()
  }
  o.onProgress?.({ stage: 'pictures', pass, done: 1 })
  if (!out.length) throw new VideoError('encoder-stalled') // it took every picture and gave none back
  // Made right for MP4 whatever form it came in (Annex B, or a broken avcC).
  const mp4 = forMp4(description, out.map((x) => x.data))
  return { samples: out.map((x, i) => ({ ...x, data: mp4.pictures[i] })), description: mp4.description, fixed: mp4.fixed }
}

// --- Is a drawn picture what reaches the encoder? ----------------------------------------
// WebKit's strictest fingerprinting protection (Safari's Private Browsing) returns one random
// solid colour for every canvas read-back (CanvasNoiseInjection); its usual mode nudges drawn
// rectangles' pixels by a few levels (the PDF session read the source, 2026-10-19). If making
// a VideoFrame from a canvas counts as a read-back there, a private tab would make a video of
// one flat colour without an error. So a small picture, red on the left and blue on the
// right, is drawn each way, made into a VideoFrame and read back; a way that doesn't give
// back a red half and a blue half isn't used.
//
// It asks only that: which half is redder, not exact colours, and either way round. The
// first version wanted each colour within 24 levels, read as RGBA, and failed in an ordinary
// Safari window on an iPhone (Safari 27, 2026-10-21) though videos had been made
// there two days before: a browser may hand the pixels back in its own layout (BGRA, or
// brightness and colour planes) when asked for RGBA, or in other colours than were drawn
// (another colour space). A random solid colour still fails, as both halves come back alike.

/** What a way of drawing gave back, for the report. */
interface DrawCheck {
  ok: boolean
  seen: string
}

const ways: Partial<Record<'canvas' | 'bitmap', Promise<DrawCheck>>> = {}

/**
 * The first way of drawing, starting with the one wanted, that gives back what
 * was drawn; throws when none does. The report says what each way gave back.
 */
async function drawingWay(wanted: 'canvas' | 'bitmap', report: Report): Promise<'canvas' | 'bitmap'> {
  const seen: string[] = []
  for (const way of wanted === 'canvas' ? (['canvas', 'bitmap'] as const) : (['bitmap', 'canvas'] as const)) {
    ways[way] ??= drawsTrue(way)
    const r = await ways[way]
    seen.push(`${way}: ${r.seen}`)
    if (r.ok) {
      report.drawing = `${way} (${seen.join('; ')})`
      return way
    }
  }
  report.drawing = `none (${seen.join('; ')})`
  throw new VideoError('canvas-blocked')
}

/** Whether a picture drawn this way comes back as drawn: a red half on the left, a blue half on the right. */
async function drawsTrue(way: 'canvas' | 'bitmap'): Promise<DrawCheck> {
  const W = 16
  const H = 8
  let frame: VideoFrame | undefined
  try {
    if (way === 'canvas') {
      if (typeof OffscreenCanvas === 'undefined') return { ok: false, seen: 'no OffscreenCanvas' }
      const c = new OffscreenCanvas(W, H)
      const ctx = c.getContext('2d', { alpha: false })!
      ctx.fillStyle = '#ff0000'
      ctx.fillRect(0, 0, W / 2, H)
      ctx.fillStyle = '#0000ff'
      ctx.fillRect(W / 2, 0, W / 2, H)
      frame = new VideoFrame(c, { timestamp: 0 })
    } else {
      // As the real thing does: a decoded picture (here, raw pixels) through createImageBitmap.
      const raw = new Uint8Array(W * H * 4)
      for (let i = 0; i < W * H; i++) raw.set(i % W < W / 2 ? [255, 0, 0, 255] : [0, 0, 255, 255], i * 4)
      const source = new VideoFrame(raw, { format: 'RGBA', codedWidth: W, codedHeight: H, timestamp: 0 })
      const bitmap = await createImageBitmap(source, { resizeWidth: W, resizeHeight: H })
      source.close()
      frame = new VideoFrame(bitmap, { timestamp: 0 })
      bitmap.close()
    }
    const back = await halves(frame)
    // A frame this check can't read isn't refused for that: the drawing itself worked.
    if (!('left' in back)) return { ok: true, seen: back.how }
    return { ok: redAndBlue(back.left, back.right), seen: `${back.how}, left ${back.left.join(',')}, right ${back.right.join(',')}` }
  } catch (e) {
    return { ok: false, seen: `failed: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}` }
  } finally {
    frame?.close()
  }
}

/**
 * One half clearly red and the other clearly blue, either way round (a
 * browser that hands back BGRA when asked for RGBA swaps them): red minus
 * blue far apart, with opposite signs. Exported for tests.
 */
export function redAndBlue(left: number[], right: number[]): boolean {
  const a = left[0] - left[2]
  const b = right[0] - right[2]
  return Math.abs(a - b) >= 200 && a * b < 0
}

const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)))

/**
 * The colours of a small frame at the middle of its left and right halves,
 * as RGB, read in whatever layout the browser gives: four bytes a pixel (RGB
 * or BGR), or a brightness plane and colour planes (I420, I422, I444, NV12),
 * turned roughly back into RGB. Or just a note of what it gave, when that's
 * none of those. Exported for tests.
 */
export async function halves(frame: VideoFrame): Promise<{ left: number[]; right: number[]; how: string } | { how: string }> {
  const W = frame.visibleRect?.width ?? frame.codedWidth
  const H = frame.visibleRect?.height ?? frame.codedHeight
  const size = (f: () => number) => {
    try {
      return f()
    } catch {
      return 0
    }
  }
  const buf = new Uint8Array(Math.max(W * H * 4, size(() => frame.allocationSize()), size(() => frame.allocationSize({ format: 'RGBA' }))))
  let layouts: PlaneLayout[]
  let asked = 'RGBA'
  try {
    layouts = await frame.copyTo(buf, { format: 'RGBA' })
  } catch {
    asked = 'its own'
    try {
      layouts = await frame.copyTo(buf)
    } catch (e) {
      return { how: `${frame.format ?? 'no format'}, unreadable (${e instanceof Error ? e.name : 'error'})` }
    }
  }
  const how = `${frame.format ?? 'no format'}, read as ${asked}, ${layouts.length} plane${layouts.length === 1 ? '' : 's'}`
  const y = H >> 1
  const xs = [W >> 3, W - 1 - (W >> 3)]
  if (layouts.length === 1) {
    const { offset, stride } = layouts[0]
    if (stride < W * 4) return { how: `${how}, ${stride} bytes a row` }
    const px = (x: number) => [...buf.subarray(offset + y * stride + x * 4, offset + y * stride + x * 4 + 3)]
    return { left: px(xs[0]), right: px(xs[1]), how }
  }
  // Brightness, then colour at half the width (and height) unless it's I444 or I422.
  const [sx, sy] = frame.format === 'I444' ? [1, 1] : frame.format === 'I422' ? [2, 1] : [2, 2]
  const [l0, l1, l2] = layouts
  const px = (x: number) => {
    const Y = buf[l0.offset + y * l0.stride + x]
    const cx = Math.floor(x / sx)
    const cy = Math.floor(y / sy)
    const U = layouts.length === 2 ? buf[l1.offset + cy * l1.stride + cx * 2] : buf[l1.offset + cy * l1.stride + cx]
    const V = layouts.length === 2 ? buf[l1.offset + cy * l1.stride + cx * 2 + 1] : buf[l2.offset + cy * l2.stride + cx]
    return [clamp(Y + 1.5748 * (V - 128)), clamp(Y - 0.1873 * (U - 128) - 0.4681 * (V - 128)), clamp(Y + 1.8556 * (U - 128))]
  }
  return { left: px(xs[0]), right: px(xs[1]), how }
}

/** Sound made smaller: its pieces, configuration and real bitrate. */
/** Plain AAC (LC), AAC made for low bitrates (HE: half the rate, with the highs rebuilt from hints), or Opus. */
type SoundKind = 'aac' | 'he-aac' | 'opus'
const CODEC_OF: Record<SoundKind, string> = { aac: 'mp4a.40.2', 'he-aac': 'mp4a.40.5', opus: 'opus' }

interface Sound {
  kind: SoundKind
  codec: 'aac' | 'opus'
  rate: number
  samples: MuxSample[]
  description?: Uint8Array
  bitrate: number
  fixed?: string
}

/**
 * The sound, mixed to mono and encoded again, or why it can't be. AAC at the
 * sound's own rate first; Safari's encoder gives far more than it's asked for
 * (63 kbit/s for 32 on an iPhone, 2026-10-19), so if it comes
 * out well over, as HE-AAC (made for low bitrates, played wherever AAC is),
 * then as plain AAC at half the rate (47 kbit/s on the iPhone), keeping the
 * smallest. Opus where there's no AAC encoder. tries: what each gave.
 */
async function encodeSound(read: Read, track: Track, bitrate: number, o: Options): Promise<{ audio: MuxAudio; kind: SoundKind; fixed?: string; tries: string[] } | { why: string }> {
  if (typeof AudioDecoder === 'undefined' || typeof AudioEncoder === 'undefined') return { why: 'no AudioDecoder/AudioEncoder' }
  if (!track.codec.startsWith('mp4a') && track.codec !== 'opus') return { why: `sound in ${track.format}` }
  // Progress through the sound, never back: decoding is its first half, and each try at
  // making it goes most of the way on from wherever the last one left it. On a phone this
  // takes a few seconds, which the bar would otherwise sit through.
  let at = 0
  const say = (done: number) => {
    at = Math.max(at, done)
    o.onProgress?.({ stage: 'sound', pass: 0, done: at })
  }
  const pcm = await decodeMono(read, track, { ...o, onProgress: (p) => say(p.done / 2) })
  if ('why' in pcm) return pcm
  const tries: string[] = []
  const attempt = async (kind: SoundKind, half: boolean): Promise<Sound | undefined> => {
    const rate = half ? pcm.rate / 2 : pcm.rate
    const from = Math.max(at, 0.5)
    const to = from + (1 - from) * 0.7
    const r = await encodePcm(half ? halve(pcm.data) : pcm.data, rate, kind, bitrate, (done) => say(from + (to - from) * done))
    tries.push(`${kind} ${rate} Hz: ${'why' in r ? r.why : `${Math.round(r.bitrate / 1000)} kbit/s`}`)
    return 'why' in r ? undefined : r
  }
  const over = (x?: Sound) => !!x && x.bitrate > bitrate * 1.3
  const smaller = (a: Sound | undefined, b: Sound | undefined) => (b && (!a || b.bitrate < a.bitrate) ? b : a)
  let best: Sound | undefined
  if (o.soundAs !== 'opus') {
    best = await attempt('aac', false)
    if (over(best)) best = smaller(best, await attempt('he-aac', false))
    if (over(best) && pcm.rate >= 32000) best = smaller(best, await attempt('aac', true))
  }
  best ??= await attempt('opus', false)
  if (!best) return { why: `no AAC or Opus encoder at ${pcm.rate} Hz` }
  return {
    kind: best.kind,
    fixed: best.fixed,
    tries,
    audio: { codec: best.codec, sampleRate: best.codec === 'opus' ? 48000 : best.rate, channels: 1, description: best.description, samples: best.samples },
  }
}

/** The whole sound track decoded and mixed to one channel, from the movie's start. */
async function decodeMono(read: Read, track: Track, o: Options): Promise<{ data: Float32Array; rate: number } | { why: string }> {
  const decoderConfig: AudioDecoderConfig = { codec: track.codec, sampleRate: track.sampleRate, numberOfChannels: track.channels, description: track.description }
  if ((await takes(() => AudioDecoder.isConfigSupported(decoderConfig))) === false) return { why: `can't decode ${track.codec}` }
  const parts: Float32Array[] = []
  let rate = 0
  let failure: unknown
  const decoder = new AudioDecoder({
    output(data) {
      try {
        rate ||= data.sampleRate
        let mono = monoOf(data)
        // Before the start (an encoder's priming): cut.
        if (data.timestamp < 0) mono = mono.subarray(Math.min(mono.length, Math.round((-data.timestamp * data.sampleRate) / 1e6)))
        if (mono.length) parts.push(mono)
      } catch (e) {
        failure ??= e
      } finally {
        data.close()
      }
    },
    error: (e) => (failure ??= e),
  })
  decoder.configure(decoderConfig)
  try {
    for await (const { index, data } of readSamplesOf(read, track.samples)) {
      checkAbort(o.signal)
      if (failure) break
      const s = track.samples[index]
      decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: showsAt(track, s), duration: Math.round((s.duration / track.timescale) * 1e6), data }))
      if (index % 100 === 0) o.onProgress?.({ stage: 'sound', pass: 0, done: index / track.samples.length })
      while (!failure && decoder.decodeQueueSize > 20) await dequeued(decoder)
    }
    if (!failure) await decoder.flush()
  } catch (e) {
    failure ??= e
  } finally {
    if (decoder.state !== 'closed') decoder.close()
  }
  if (failure) return { why: `failed: ${failure instanceof Error ? failure.message : String(failure)}` }
  if (!parts.length || !rate) return { why: 'no sound came out' }
  const data = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    data.set(p, at)
    at += p.length
  }
  return { data, rate }
}

/** Mono sound encoded with this codec, or why it can't be. */
async function encodePcm(pcm: Float32Array, rate: number, kind: SoundKind, bitrate: number, onDone?: (done: number) => void): Promise<Sound | { why: string }> {
  const codec = kind === 'opus' ? 'opus' : 'aac'
  const config: AudioEncoderConfig = { codec: CODEC_OF[kind], sampleRate: rate, numberOfChannels: 1, bitrate }
  if ((await takes(() => AudioEncoder.isConfigSupported(config))) === false) return { why: 'not offered' }
  const samples: MuxSample[] = []
  let description: Uint8Array | undefined
  let failure: unknown
  const encoder = new AudioEncoder({
    output(chunk, meta) {
      const desc = meta?.decoderConfig?.description
      if (desc && !description) description = bytesOf(desc)
      const data = new Uint8Array(chunk.byteLength)
      chunk.copyTo(data)
      samples.push({ data, pts: chunk.timestamp, duration: chunk.duration ?? 0, key: true })
    },
    error: (e) => (failure ??= e),
  })
  try {
    encoder.configure(config)
    const block = 4096
    for (let i = 0; i < pcm.length && !failure; i += block) {
      const n = Math.min(block, pcm.length - i)
      const data = new AudioData({ format: 'f32-planar', sampleRate: rate, numberOfFrames: n, numberOfChannels: 1, timestamp: Math.round((i / rate) * 1e6), data: pcm.slice(i, i + n) })
      encoder.encode(data)
      data.close()
      if ((i / block) % 8 === 0) onDone?.(i / pcm.length)
      while (!failure && encoder.encodeQueueSize > 20) await dequeued(encoder)
    }
    if (!failure) await encoder.flush()
    onDone?.(1)
  } catch (e) {
    failure ??= e
  } finally {
    if (encoder.state !== 'closed') encoder.close()
  }
  if (failure) return { why: `failed: ${failure instanceof Error ? failure.message : String(failure)}` }
  if (!samples.length) return { why: 'no sound came out' }
  let fixed: string | undefined
  if (codec === 'aac') {
    const asc = description && aacConfig(description)
    if (!asc) return { why: 'no usable configuration' }
    if (asc.length !== description!.length) fixed = `config taken out of a ${description!.length}-byte esds`
    description = asc
  }
  // Times from the start, as the pictures' are.
  const first = Math.max(0, samples[0].pts)
  const bytes = samples.reduce((n, x) => n + x.data.length, 0)
  return {
    kind,
    codec,
    rate,
    description,
    fixed,
    samples: samples.map((x) => ({ ...x, pts: x.pts - first })),
    bitrate: (bytes * 8 * rate) / Math.max(1, pcm.length),
  }
}

/** One channel: the average of all of them. */
function monoOf(data: AudioData): Float32Array {
  const n = data.numberOfFrames
  const mixed = new Float32Array(n)
  const channel = new Float32Array(n)
  for (let c = 0; c < data.numberOfChannels; c++) {
    data.copyTo(channel, { planeIndex: c, format: 'f32-planar' })
    for (let i = 0; i < n; i++) mixed[i] += channel[i] / data.numberOfChannels
  }
  return mixed
}

/** Sound at half the rate: a low-pass filter (a windowed sinc) so nothing folds back, then every other sample. */
export function halve(x: Float32Array): Float32Array {
  const TAPS = 33
  const mid = (TAPS - 1) / 2
  const cutoff = 0.225 // of the old rate: 90% of the new one's highest frequency
  const h = new Float32Array(TAPS)
  let sum = 0
  for (let n = 0; n < TAPS; n++) {
    const t = n - mid
    const sinc = t === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * t) / (Math.PI * t)
    const blackman = 0.42 - 0.5 * Math.cos((2 * Math.PI * n) / (TAPS - 1)) + 0.08 * Math.cos((4 * Math.PI * n) / (TAPS - 1))
    h[n] = sinc * blackman
    sum += h[n]
  }
  for (let n = 0; n < TAPS; n++) h[n] /= sum
  const out = new Float32Array(Math.floor(x.length / 2))
  for (let k = 0; k < out.length; k++) {
    let v = 0
    for (let n = 0; n < TAPS; n++) {
      const i = 2 * k + n - mid
      if (i >= 0 && i < x.length) v += h[n] * x[i]
    }
    out[k] = v
  }
  return out
}

/**
 * Small pictures from a video, upright, at these points through it (0 to 1),
 * each at most edge pixels on its long side.
 */
export async function snapshots(file: Blob, points: number[], edge = 320, hardware?: HardwareAcceleration): Promise<ImageBitmap[]> {
  const read = fileReader(file)
  const movie = await demux(file, read)
  const track = pick(movie, 'video')
  if (!track?.codec) return []
  const out: ImageBitmap[] = []
  const config: VideoDecoderConfig = { codec: track.codec, description: track.description, codedWidth: track.width, codedHeight: track.height }
  if (hardware) config.hardwareAcceleration = hardware
  if ((await takes(() => VideoDecoder.isConfigSupported(config))) === false) return []
  // Samples in presentation order, to find the one at each point.
  const byTime = track.samples.map((s, i) => ({ i, t: showsAt(track, s) })).sort((a, b) => a.t - b.t)
  for (const p of points) {
    const want = byTime[Math.min(byTime.length - 1, Math.floor(p * byTime.length))]
    let from = want.i
    while (from > 0 && !track.samples[from].key) from--
    let found: VideoFrame | undefined
    const decoder = new VideoDecoder({
      output(frame) {
        if (frame.timestamp === want.t && !found) found = frame
        else frame.close()
      },
      error() {},
    })
    decoder.configure(config)
    // Up to a little past it: with reordered frames, it may come out after its successors are in.
    const until = Math.min(track.samples.length, want.i + 8)
    for await (const { index, data } of readSamplesOf(read, track.samples.slice(0, until), from)) {
      const s = track.samples[index]
      decoder.decode(new EncodedVideoChunk({ type: s.key ? 'key' : 'delta', timestamp: showsAt(track, s), data }))
    }
    await decoder.flush().catch(() => {})
    decoder.close()
    if (!found) continue
    out.push(await upright(found, track.rotation, edge))
    found.close()
  }
  return out
}

async function upright(frame: VideoFrame, rotation: number, edge: number): Promise<ImageBitmap> {
  const w = frame.displayWidth
  const h = frame.displayHeight
  const s = Math.min(1, edge / Math.max(w, h))
  const dw = Math.round(w * s)
  const dh = Math.round(h * s)
  const turned = rotation === 90 || rotation === 270
  const canvas = new OffscreenCanvas(turned ? dh : dw, turned ? dw : dh)
  const ctx = canvas.getContext('2d')!
  ctx.translate(canvas.width / 2, canvas.height / 2)
  ctx.rotate((rotation * Math.PI) / 180)
  ctx.drawImage(frame, -dw / 2, -dh / 2, dw, dh)
  return canvas.transferToImageBitmap()
}
