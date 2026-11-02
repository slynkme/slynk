// Sound files: which kind, how long, how many channels and at what rate, read
// from their headers (an MP3's from every frame's header, a moment's work),
// and in the worker, their sound decoded a run at a time for shrink.ts. MP3,
// M4A (AAC, or Opus or MP3 in an MP4) and WAV are read here and decoded with
// the browser's own decoder (WebCodecs AudioDecoder), so a long one is never
// in memory whole. FLAC and Ogg (Opus, Vorbis) only have their length read
// here: the page decodes them whole (page.ts), as it does anything else a
// browser's AudioDecoder won't take.
import { latin1, u16le, u32be, u32le } from '../strip/bytes.ts'
import { id3Length, mpegFrameLength, mpegStartsAt } from '../strip/sniff.ts'
import { demux, readSamplesOf, showsAt, type Read, type Sample, type Track } from '../video/demux.ts'

export type AudioKind = 'mp3' | 'm4a' | 'wav' | 'flac' | 'ogg'
/** The kinds decoded in the worker, a run at a time; the others are decoded on the page. */
export const STREAMED: readonly AudioKind[] = ['mp3', 'm4a', 'wav']

export interface AudioInfo {
  kind: AudioKind
  seconds: number
  /** As the file says; a decoder may hand back another (HE-AAC's is twice its header's). */
  sampleRate: number
  channels: number
  /** Bytes of sound, without tags or cover art (the whole file, for FLAC and Ogg): its bitrate, as it is. */
  bytes: number
}

export class AudioError extends Error {}
const fail = (message: string): never => {
  throw new AudioError(message)
}

const at = (b: Uint8Array, i: number, s: string) => i >= 0 && i + s.length <= b.length && latin1(b, i, i + s.length) === s

/** Reads part of bytes already in memory, as a file would be read. */
export const bytesReader =
  (b: Uint8Array): Read =>
  async (offset, length) =>
    b.subarray(offset, offset + length)

/** A sound file's kind from its first bytes, or 'mp4' for an MP4 that may hold only sound, or null. */
export function soundKind(b: Uint8Array): AudioKind | 'mp4' | null {
  if (b.length < 12) return null
  if (at(b, 4, 'ftyp')) {
    const brand = latin1(b, 8, 12)
    // QuickTime (MOV) and HEIC photos are never sound files; anything else may be an M4A with another brand.
    return /^(M4A |M4B )$/.test(brand) ? 'm4a' : /^(qt  |heic|heix|mif1|msf1|avif|crx )$/.test(brand) ? null : 'mp4'
  }
  if (at(b, 0, 'RIFF') && at(b, 8, 'WAVE')) return 'wav'
  if (at(b, 0, 'OggS')) return 'ogg'
  const start = at(b, 0, 'ID3') ? id3Length(b) : 0
  if (at(b, start, 'fLaC')) return 'flac'
  let i = start
  while (i < b.length && i < start + 4096 && b[i] === 0) i++
  return mpegStartsAt(b, i) && layerOf(b, i) === 3 ? 'mp3' : null
}

// --- MP3 --------------------------------------------------------------------------------

const MPEG_RATES = [
  [11025, 12000, 8000], // MPEG 2.5
  [0, 0, 0],
  [22050, 24000, 16000], // MPEG 2
  [44100, 48000, 32000], // MPEG 1
]
const versionOf = (b: Uint8Array, i: number) => (b[i + 1] >> 3) & 3
/** 1, 2 or 3. */
const layerOf = (b: Uint8Array, i: number) => 4 - ((b[i + 1] >> 1) & 3)
const rateOf = (b: Uint8Array, i: number) => MPEG_RATES[versionOf(b, i)][(b[i + 2] >> 2) & 3]
const channelsOf = (b: Uint8Array, i: number) => ((b[i + 3] >> 6) === 3 ? 1 : 2)

export interface Mp3 {
  frames: Sample[]
  /** The first frame's: a file whose frames change rate (mixed) is decoded on the page instead. */
  sampleRate: number
  channels: number
  /** Samples in each frame: 1152, or 576 for MPEG 2 and 2.5. */
  perFrame: number
  /** Samples to drop at the start and the end: the encoder's and the decoder's delay, and the padding, when a LAME tag says (gapless). */
  skipStart: number
  skipEnd: number
  /** Some frames are at another rate (MP3s joined together, ads put into a podcast). */
  mixed: boolean
  /** How long it plays, in seconds, every frame at its own rate. */
  seconds: number
  /** Bytes of sound: its frames, without tags or anything between them. */
  bytes: number
}

/** Whether a layer III frame starts at i, with another after it. */
const frameAt = (b: Uint8Array, i: number) => mpegStartsAt(b, i) && layerOf(b, i) === 3

/**
 * An MP3's frames (MPEG audio layer III), after any ID3 tags, to the end:
 * past anything between them (a tag in the middle, a few stray bytes where
 * files were joined), as far as the next two frames in a row; whatever
 * trails them (ID3v1, APE) has none. A first frame that's only a Xing, Info
 * or VBRI header is left out, and its LAME tag's delay and padding are kept
 * to trim.
 */
export function scanMp3(b: Uint8Array): Mp3 {
  let i = id3Length(b)
  const limit = Math.min(b.length, i + 65_536)
  while (i < limit && !frameAt(b, i)) i++
  if (i >= limit) fail('no MP3 frames')
  const version = versionOf(b, i)
  const sampleRate = rateOf(b, i)
  const perFrame = version === 3 ? 1152 : 576
  const frames: Sample[] = []
  let mixed = false
  let seconds = 0
  let bytes = 0
  while (i < b.length) {
    const n = mpegFrameLength(b, i)
    if (n && i + n <= b.length && layerOf(b, i) === 3) {
      const each = versionOf(b, i) === 3 ? 1152 : 576
      if (versionOf(b, i) !== version || rateOf(b, i) !== sampleRate) mixed = true
      frames.push({ offset: i, size: n, dts: 0, cts: 0, duration: each, key: true })
      seconds += each / rateOf(b, i)
      bytes += n
      i += n
      continue
    }
    // Not a frame: a tag (skipped whole, so a picture in it can't pass for frames), or bytes to pass over.
    if (at(b, i, 'ID3')) {
      const tag = id3Length(b.subarray(i))
      if (tag) {
        i += tag
        continue
      }
    }
    i++
    while (i < b.length && !frameAt(b, i) && !(b[i] === 0x49 && b[i + 1] === 0x44 && b[i + 2] === 0x33)) i++
  }
  if (!frames.length) fail('no MP3 frames')
  const first = frames[0].offset
  const channels = channelsOf(b, first)
  let skipStart = 0
  let skipEnd = 0
  const side = version === 3 ? (channels === 2 ? 32 : 17) : channels === 2 ? 17 : 9
  const xing = first + 4 + side
  if (at(b, xing, 'Xing') || at(b, xing, 'Info') || at(b, first + 36, 'VBRI')) {
    if (at(b, xing, 'Xing') || at(b, xing, 'Info')) {
      const flags = u32be(b, xing + 4)
      const lame = xing + 8 + (flags & 1 ? 4 : 0) + (flags & 2 ? 4 : 0) + (flags & 4 ? 100 : 0) + (flags & 8 ? 4 : 0)
      if ((at(b, lame, 'LAME') || at(b, lame, 'Lav')) && lame + 24 <= first + frames[0].size) {
        const delay = (b[lame + 21] << 4) | (b[lame + 22] >> 4)
        const padding = ((b[lame + 22] & 15) << 8) | b[lame + 23]
        // 529: what an MP3 decoder itself adds at the start.
        if (delay <= 3000 && padding <= 3000) {
          skipStart = delay + 529
          skipEnd = Math.max(0, padding - 529)
        }
      }
    }
    const info = frames.shift()!
    seconds -= info.duration / sampleRate
    bytes -= info.size
    if (!frames.length) fail('no MP3 frames')
  }
  seconds -= (skipStart + skipEnd) / sampleRate
  return { frames, sampleRate, channels, perFrame, skipStart, skipEnd, mixed, seconds, bytes }
}

// --- WAV --------------------------------------------------------------------------------

export interface Wav {
  /** 1: whole numbers (8 bits unsigned, else signed), 3: floating point. */
  format: 1 | 3
  bits: number
  channels: number
  sampleRate: number
  /** Where the samples are, and how many bytes. */
  offset: number
  bytes: number
}

/**
 * A WAV's format and where its samples lie, from its chunks, read one header
 * at a time wherever they are in the file (a long one of other chunks can come
 * first); the samples themselves aren't read.
 */
export async function findWav(read: Read, fileSize: number): Promise<Wav> {
  let fmt: Omit<Wav, 'offset' | 'bytes'> | undefined
  for (let p = 12, chunks = 0; p + 8 <= fileSize && chunks < 10_000; chunks++) {
    const head = await read(p, 8)
    if (head.length < 8) break
    const id = latin1(head, 0, 4)
    const size = u32le(head, 4)
    if (id === 'fmt ' && size >= 16) {
      const b = await read(p + 8, Math.min(size, 40))
      let format = u16le(b, 0)
      // WAVE_FORMAT_EXTENSIBLE: the real format is the first two bytes of its sub-format.
      if (format === 0xfffe && size >= 40) format = u16le(b, 24)
      const bits = u16le(b, 14)
      if (!((format === 1 && [8, 16, 24, 32].includes(bits)) || (format === 3 && (bits === 32 || bits === 64)))) fail(`WAV format ${format}, ${bits} bits`)
      fmt = { format: format as 1 | 3, bits, channels: u16le(b, 2), sampleRate: u32le(b, 4) }
      if (!fmt.channels || !fmt.sampleRate) fail('a WAV without channels or rate')
    } else if (id === 'data') {
      if (!fmt) fail('a WAV with its samples before its format')
      const frame = fmt!.channels * (fmt!.bits / 8)
      // A size of 0 or more than is there: one written while recording, never finished.
      const room = fileSize - (p + 8)
      const bytes = size && size <= room ? size : room
      return { ...fmt!, offset: p + 8, bytes: bytes - (bytes % frame) }
    }
    p += 8 + size + (size & 1)
  }
  return fail('a WAV without samples')
}

/** Samples of a WAV as one Float32Array a channel, from its raw bytes (whole frames). */
export function wavPlanes(w: Wav, raw: Uint8Array): Float32Array[] {
  const step = w.bits / 8
  const frames = Math.floor(raw.length / (step * w.channels))
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
  const planes = Array.from({ length: w.channels }, () => new Float32Array(frames))
  for (let f = 0, p = 0; f < frames; f++) {
    for (let c = 0; c < w.channels; c++, p += step) {
      let v: number
      if (w.format === 3) v = step === 4 ? view.getFloat32(p, true) : view.getFloat64(p, true)
      else if (step === 1) v = (raw[p] - 128) / 128
      else if (step === 2) v = view.getInt16(p, true) / 32768
      else if (step === 3) v = ((raw[p] | (raw[p + 1] << 8) | (raw[p + 2] << 16)) << 8 >> 8) / 8388608
      else v = view.getInt32(p, true) / 2147483648
      planes[c][f] = v
    }
  }
  return planes
}

// --- FLAC and Ogg: their length only ---------------------------------------------------

/** A FLAC's rate, channels and length, from its STREAMINFO block. */
export function readFlac(b: Uint8Array): Omit<AudioInfo, 'kind' | 'bytes'> {
  const p = id3Length(b)
  if (!at(b, p, 'fLaC') || (b[p + 4] & 0x7f) !== 0) fail('a FLAC without its STREAMINFO')
  const s = p + 8
  const sampleRate = (b[s + 10] << 12) | (b[s + 11] << 4) | (b[s + 12] >> 4)
  const channels = ((b[s + 12] >> 1) & 7) + 1
  const total = (b[s + 13] & 15) * 2 ** 32 + u32be(b, s + 14)
  if (!sampleRate) fail('a FLAC without a rate')
  return { sampleRate, channels, seconds: total / sampleRate }
}

/** An Ogg Opus or Vorbis file's rate, channels and length: its first packet, and the last page's position. */
export function readOgg(b: Uint8Array): Omit<AudioInfo, 'kind' | 'bytes'> {
  if (!at(b, 0, 'OggS')) fail('not an Ogg file')
  const segments = b[26]
  const first = 27 + segments
  let sampleRate: number
  let channels: number
  let preSkip = 0
  let perSecond: number
  if (at(b, first, 'OpusHead')) {
    channels = b[first + 9]
    preSkip = u16le(b, first + 10)
    sampleRate = u32le(b, first + 12) || 48000
    perSecond = 48000 // Opus's positions count at 48 kHz, whatever it was made from
  } else if (b[first] === 1 && at(b, first + 1, 'vorbis')) {
    channels = b[first + 11]
    sampleRate = u32le(b, first + 12)
    perSecond = sampleRate
  } else return fail('an Ogg file that isn’t Opus or Vorbis')
  // The last page with a position: its granule is where the sound ends.
  let granule = -1
  for (let i = b.length - 27; i >= Math.max(0, b.length - 65_536); i--) {
    if (b[i] !== 0x4f || !at(b, i, 'OggS') || b[i + 4] !== 0) continue
    const lo = u32le(b, i + 6)
    const hi = u32le(b, i + 10)
    if (hi === 0xffffffff && lo === 0xffffffff) continue // a page with no position
    granule = hi * 2 ** 32 + lo
    break
  }
  if (granule < 0 || !channels || !perSecond) fail('an Ogg file without its length')
  return { sampleRate, channels, seconds: Math.max(0, granule - preSkip) / perSecond }
}

// --- What the page needs to know ---------------------------------------------------------

/**
 * A sound file's kind, length, rate and channels, or null if it isn't one
 * Slynk can make smaller (or can't read it). bytes: all of it.
 */
export async function audioInfo(bytes: Uint8Array): Promise<AudioInfo | null> {
  try {
    const kind = soundKind(bytes)
    if (!kind) return null
    if (kind === 'mp3') {
      const m = scanMp3(bytes)
      return m.seconds > 0 ? { kind, seconds: m.seconds, sampleRate: m.sampleRate, channels: m.channels, bytes: m.bytes } : null
    }
    if (kind === 'wav') {
      const w = await findWav(bytesReader(bytes), bytes.length)
      const seconds = w.bytes / (w.channels * (w.bits / 8)) / w.sampleRate
      return seconds > 0 ? { kind, seconds, sampleRate: w.sampleRate, channels: w.channels, bytes: w.bytes } : null
    }
    if (kind === 'flac' || kind === 'ogg') {
      const r = kind === 'flac' ? readFlac(bytes) : readOgg(bytes)
      return r.seconds > 0 && r.channels ? { kind, ...r, bytes: bytes.length } : null
    }
    // An MP4 (M4A): only sound, no pictures, or it's a video.
    const movie = await demux({ size: bytes.length } as Blob, bytesReader(bytes))
    if (movie.tracks.some((t) => t.kind === 'video' && t.samples.length)) return null
    const t = soundTrack(movie.tracks)
    if (!t) return null
    const seconds = trackSeconds(t)
    return seconds > 0 && t.channels ? { kind: 'm4a', seconds, sampleRate: t.sampleRate, channels: t.channels, bytes: t.samples.reduce((n, x) => n + x.size, 0) } : null
  } catch {
    return null // not one Slynk can read: it's treated as any other file
  }
}

/** A WAV's kind, length, rate and channels from its file, reading only its header (its chunks before the sound); null if it isn't one Slynk can make smaller. */
export async function wavInfo(file: Blob): Promise<AudioInfo | null> {
  const read: Read = async (offset, length) => new Uint8Array(await file.slice(offset, offset + length).arrayBuffer())
  try {
    if (soundKind(await read(0, 64)) !== 'wav') return null
    const w = await findWav(read, file.size)
    const seconds = w.bytes / (w.channels * (w.bits / 8)) / w.sampleRate
    return seconds > 0 ? { kind: 'wav', seconds, sampleRate: w.sampleRate, channels: w.channels, bytes: w.bytes } : null
  } catch {
    return null
  }
}

/** The sound track that plays: the first enabled one, else the first. */
export function soundTrack(tracks: Track[]): Track | undefined {
  const sound = tracks.filter((t) => t.kind === 'audio' && t.samples.length)
  return sound.find((t) => t.enabled) ?? sound[0]
}

function trackSeconds(t: Track): number {
  let end = 0
  for (const s of t.samples) end = Math.max(end, s.cts + s.duration)
  return (end - t.mediaStart) / t.timescale
}

// --- Decoding, in the worker --------------------------------------------------------------

/** Sound decoded so far: one array a channel, at rate samples a second. */
export type Take = (planes: Float32Array[], rate: number) => void

export interface DecodeOptions {
  signal?: AbortSignal
  /** Called after each run, to wait while what takes the sound falls behind. */
  wait?: () => Promise<void>
}

/** Thrown when this browser's decoder won't take the file: the page decodes it instead. */
export class CantDecode extends Error {}

/** Whether a codec says it takes a configuration: false only when it says no (iOS 26.1 throws for some: then the attempt tells). */
async function offered(config: AudioDecoderConfig): Promise<boolean> {
  try {
    return (await AudioDecoder.isConfigSupported(config)).supported !== false
  } catch {
    return true
  }
}

/** Resolves when a codec has taken something from its queue, or after 10 ms where a browser doesn't say. */
export function dequeued(...codecs: EventTarget[]): Promise<void> {
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

const stopped = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new AudioError('stopped')
}

/**
 * Decodes a sound file a run at a time, handing each piece to take, in
 * order, with the encoder's priming and padding cut off where the file says.
 * Resolves with the samples handed over (at the decoder's rate).
 */
export async function decodeAudio(file: Blob, kind: AudioKind, take: Take, o: DecodeOptions = {}): Promise<number> {
  const read: Read = async (offset, length) => new Uint8Array(await file.slice(offset, offset + length).arrayBuffer())
  if (kind === 'wav') {
    const w = await findWav(read, file.size)
    const frame = w.channels * (w.bits / 8)
    const run = frame * 65_536
    let given = 0
    for (let p = 0; p < w.bytes; p += run) {
      stopped(o.signal)
      const raw = await read(w.offset + p, Math.min(run, w.bytes - p))
      const planes = wavPlanes(w, raw.subarray(0, raw.length - (raw.length % frame)))
      if (!planes[0].length) break
      take(planes, w.sampleRate)
      given += planes[0].length
      await o.wait?.()
    }
    return given
  }
  if (kind === 'mp3') {
    // Read whole to find its frames: small beside its sound decoded (a tenth of it, or less).
    const whole = new Uint8Array(await file.arrayBuffer())
    const m = scanMp3(whole)
    // Frames at more than one rate: one decoder can't take them all, but the page's decoding can.
    if (m.mixed) throw new CantDecode('an MP3 whose rate changes')
    const keep = m.frames.length * m.perFrame - m.skipStart - m.skipEnd
    return decodeSamples(bytesReader(whole), { codec: 'mp3', sampleRate: m.sampleRate, numberOfChannels: m.channels }, m.frames, (_s, i) => Math.round((i * m.perFrame * 1e6) / m.sampleRate), m.skipStart, keep, take, o)
  }
  if (kind === 'm4a') {
    const movie = await demux(file, read)
    const t = soundTrack(movie.tracks)
    if (!t || !t.codec) throw new CantDecode(`sound in ${t?.format ?? 'nothing'}`)
    return decodeSamples(read, { codec: t.codec, sampleRate: t.sampleRate, numberOfChannels: t.channels, description: t.description }, t.samples, (s) => showsAt(t, s), 0, Infinity, take, o)
  }
  throw new CantDecode(kind)
}

/**
 * Feeds samples to an AudioDecoder and hands on what comes out. Pieces timed
 * before the start (AAC's priming, from its edit list) are cut, as are the
 * first skip samples and any after the first keep.
 */
async function decodeSamples(read: Read, config: AudioDecoderConfig, samples: Sample[], timeOf: (s: Sample, i: number) => number, skip: number, keep: number, take: Take, o: DecodeOptions): Promise<number> {
  if (typeof AudioDecoder === 'undefined') throw new CantDecode('no AudioDecoder')
  if (!(await offered(config))) throw new CantDecode(`can't decode ${config.codec}`)
  let failure: unknown
  let given = 0
  let dropped = 0
  const decoder = new AudioDecoder({
    output(data) {
      try {
        if (failure || given >= keep) return
        let planes = planesOf(data)
        // Before the start (an encoder's priming, as its edit list says): cut.
        if (data.timestamp < 0) planes = planes.map((p) => p.subarray(Math.min(p.length, Math.round((-data.timestamp * data.sampleRate) / 1e6))))
        if (dropped < skip) {
          const cut = Math.min(skip - dropped, planes[0].length)
          dropped += cut
          planes = planes.map((p) => p.subarray(cut))
        }
        if (given + planes[0].length > keep) planes = planes.map((p) => p.subarray(0, keep - given))
        if (!planes[0].length) return
        given += planes[0].length
        take(planes, data.sampleRate)
      } catch (e) {
        failure ??= e
      } finally {
        data.close()
      }
    },
    error: (e) => (failure ??= e),
  })
  try {
    decoder.configure(config)
    for await (const { index, data } of readSamplesOf(read, samples)) {
      stopped(o.signal)
      if (failure) break
      const s = samples[index]
      decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: timeOf(s, index), data }))
      while (!failure && decoder.decodeQueueSize > 20) {
        stopped(o.signal) // a stalled decoder mustn't hold a stop up
        await dequeued(decoder)
      }
      if (index % 50 === 0) await o.wait?.()
    }
    if (!failure) await decoder.flush()
  } catch (e) {
    failure ??= e
  } finally {
    if (decoder.state !== 'closed') decoder.close()
  }
  if (failure instanceof AudioError) throw failure
  // Nothing came out at all: this decoder can't, so the page may.
  if (failure) throw given ? failure : new CantDecode(`failed: ${failure instanceof Error ? failure.message : String(failure)}`)
  if (!given) throw new CantDecode('no sound came out')
  return given
}

/** Each channel of a piece of decoded sound, as floating point. */
function planesOf(data: AudioData): Float32Array[] {
  const planes: Float32Array[] = []
  for (let c = 0; c < data.numberOfChannels; c++) {
    const p = new Float32Array(data.numberOfFrames)
    data.copyTo(p, { planeIndex: c, format: 'f32-planar' })
    planes.push(p)
  }
  return planes
}
