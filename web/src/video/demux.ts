// Reads a phone video's index (MP4, MOV, M4V, 3GP: ISO base media "boxes")
// and lists each track's samples: where each picture or piece of sound lies in
// the file, and when it plays. Only the index (the movie box, a few hundred KB
// at most) is read whole; the pictures and sound are read a run at a time
// (File.slice) as the decoder needs them, so a 200 MB video never sits in
// memory.
import { latin1, u16be, u32be, u64be, u8 } from '../strip/bytes.ts'

export class VideoError extends Error {}
const fail = (message: string): never => {
  throw new VideoError(message)
}

/** The largest movie box Slynk reads: a 10-minute 4K video's is a few MB. */
const MAX_MOOV = 64_000_000

export interface Sample {
  offset: number // in the file
  size: number
  /** Decode and presentation times, in the track's timescale. */
  dts: number
  cts: number
  duration: number
  key: boolean
}

export interface Track {
  id: number
  /** Played (tkhd's flag): a Cinematic or spatial video has more video tracks than the one shown. */
  enabled: boolean
  kind: 'video' | 'audio'
  /** The sample entry's type: avc1, hvc1, mp4a… */
  format: string
  /** For WebCodecs ("avc1.640028", "hvc1.2.4.L153.B0", "mp4a.40.2"), or '' if unknown. */
  codec: string
  /** avcC or hvcC for video, the AudioSpecificConfig for AAC. */
  description?: Uint8Array
  timescale: number
  samples: Sample[]
  /** Where presentation starts, in the track's timescale (its edit list), and how long it waits first, in seconds. */
  mediaStart: number
  delay: number
  // Video
  width: number
  height: number
  /** Clockwise, from the track's matrix: how the picture is turned when played. */
  rotation: 0 | 90 | 180 | 270
  /** From the 'colr' box: 'hlg', 'pq' or 'sdr' (unknown counts as sdr). */
  transfer: 'hlg' | 'pq' | 'sdr'
  // Audio
  sampleRate: number
  channels: number
}

export interface Movie {
  brand: string
  /** Seconds. */
  duration: number
  tracks: Track[]
}

/** Reads part of the file. */
export type Read = (offset: number, length: number) => Promise<Uint8Array>

export const fileReader =
  (file: Blob): Read =>
  async (offset, length) =>
    new Uint8Array(await file.slice(offset, offset + length).arrayBuffer())

interface Box {
  type: string
  start: number
  body: number
  end: number
}

function readBox(b: Uint8Array, pos: number, end: number): Box | null {
  if (pos + 8 > end) return null
  let size = u32be(b, pos)
  const type = latin1(b, pos + 4, pos + 8)
  let header = 8
  if (size === 1) {
    if (pos + 16 > end) return null
    size = u64be(b, pos + 8)
    header = 16
  } else if (size === 0) size = end - pos
  if (size < header || pos + size > end) return null
  return { type, start: pos, body: pos + header, end: pos + size }
}

function children(b: Uint8Array, start: number, end: number): Box[] {
  const out: Box[] = []
  for (let pos = start; pos + 8 <= end; ) {
    const box = readBox(b, pos, end)
    if (!box) break // a short tail of padding: nothing more to read here
    out.push(box)
    pos = box.end
  }
  return out
}

const kid = (b: Uint8Array, parent: Box, type: string) => children(b, parent.body, parent.end).find((x) => x.type === type)
const path = (b: Uint8Array, parent: Box, ...types: string[]): Box | undefined => {
  let box: Box | undefined = parent
  for (const t of types) box = box && kid(b, box, t)
  return box
}

const hex = (v: number) => v.toString(16).padStart(2, '0')

/** Finds the movie box among the top-level boxes, reading only their headers. */
async function findMoov(read: Read, size: number): Promise<{ moov: Uint8Array; brand: string }> {
  let brand = ''
  let moov: Uint8Array | undefined
  for (let pos = 0; pos + 8 <= size; ) {
    const head = await read(pos, 16)
    let boxSize = u32be(head, 0)
    const type = latin1(head, 4, 8)
    if (boxSize === 1) boxSize = u64be(head, 8)
    else if (boxSize === 0) boxSize = size - pos
    if (boxSize < 8 || pos + boxSize > size) break // a trailer, or a file cut short
    if (pos === 0 && type !== 'ftyp') fail('not an MP4 or MOV video')
    if (type === 'ftyp') brand = latin1(head, 8, 12)
    if (type === 'moof') fail('a video in fragments')
    if (type === 'moov') {
      if (boxSize > MAX_MOOV) fail('a video with an index too large to read')
      moov = await read(pos, boxSize)
    }
    pos += boxSize
  }
  if (!moov) fail('a video without its index')
  return { moov: moov!, brand }
}

export async function demux(file: Blob, read: Read = fileReader(file)): Promise<Movie> {
  const { moov: b, brand } = await findMoov(read, file.size)
  const root = readBox(b, 0, b.length)!
  if (kid(b, root, 'mvex')) fail('a video in fragments')
  const mvhd = kid(b, root, 'mvhd')
  if (!mvhd) fail('a video without its header')
  const v1 = u8(b, mvhd!.body) === 1
  const movieScale = u32be(b, mvhd!.body + (v1 ? 20 : 12))
  const movieDuration = v1 ? u64be(b, mvhd!.body + 24) : u32be(b, mvhd!.body + 16)
  const tracks: Track[] = []
  for (const trak of children(b, root.body, root.end).filter((x) => x.type === 'trak')) {
    const t = readTrack(b, trak, movieScale)
    if (t) tracks.push(t)
  }
  return { brand, duration: movieScale ? movieDuration / movieScale : 0, tracks }
}

function readTrack(b: Uint8Array, trak: Box, movieScale: number): Track | null {
  const tkhd = kid(b, trak, 'tkhd')
  const mdia = kid(b, trak, 'mdia')
  const mdhd = mdia && kid(b, mdia, 'mdhd')
  const hdlr = mdia && kid(b, mdia, 'hdlr')
  const stbl = mdia && path(b, mdia, 'minf', 'stbl')
  if (!tkhd || !mdhd || !hdlr || !stbl) return null
  const handler = latin1(b, hdlr.body + 8, hdlr.body + 12)
  if (handler !== 'vide' && handler !== 'soun') return null
  const tv1 = u8(b, tkhd.body) === 1
  const id = u32be(b, tkhd.body + (tv1 ? 20 : 12))
  // The matrix's first four numbers (16.16) say how the picture turns: [a b; c d].
  const m = tkhd.body + (tv1 ? 52 : 40)
  const a = u32be(b, m) | 0
  const bb = u32be(b, m + 4) | 0
  const rotation: Track['rotation'] = a > 0 ? 0 : a < 0 ? 180 : bb > 0 ? 90 : 270
  const mv1 = u8(b, mdhd.body) === 1
  const timescale = u32be(b, mdhd.body + (mv1 ? 20 : 12))
  if (!timescale) return null

  const stsd = kid(b, stbl, 'stsd')
  if (!stsd || u32be(b, stsd.body + 4) < 1) return null
  const entry = readBox(b, stsd.body + 8, stsd.end)
  if (!entry) return null
  const track: Track = {
    id,
    enabled: !!(u32be(b, tkhd.body) & 1),
    kind: handler === 'vide' ? 'video' : 'audio',
    format: entry.type,
    codec: '',
    timescale,
    samples: readSamples(b, stbl),
    mediaStart: 0,
    delay: 0,
    width: 0,
    height: 0,
    rotation,
    transfer: 'sdr',
    sampleRate: 0,
    channels: 0,
  }
  if (track.kind === 'video') videoEntry(b, entry, track)
  else audioEntry(b, entry, track)
  editList(b, trak, track, movieScale)
  return track
}

// --- Sample entries: which codec, and what its decoder needs -------------------------------

function videoEntry(b: Uint8Array, entry: Box, t: Track) {
  t.width = u16be(b, entry.body + 24)
  t.height = u16be(b, entry.body + 26)
  for (const box of children(b, entry.body + 78, entry.end)) {
    const body = b.slice(box.body, box.end)
    if (box.type === 'avcC' && body.length >= 4) {
      t.description = body
      t.codec = `${t.format}.${hex(body[1])}${hex(body[2])}${hex(body[3])}`
    } else if (box.type === 'hvcC' && body.length >= 23) {
      t.description = body
      t.codec = hevcCodec(t.format, body)
    } else if (box.type === 'colr' && latin1(b, box.body, box.body + 4).match(/^nclx|nclc$/)) {
      const transfer = u16be(b, box.body + 6)
      t.transfer = transfer === 18 ? 'hlg' : transfer === 16 ? 'pq' : 'sdr'
    }
  }
}

/** The RFC 6381 name of an HEVC stream, from its hvcC (ISO/IEC 14496-15, annex E). */
export function hevcCodec(format: string, c: Uint8Array): string {
  const space = c[1] >> 6
  const tier = (c[1] >> 5) & 1
  const profile = c[1] & 0x1f
  let compat = u32be(c, 2)
  let reversed = 0
  for (let i = 0; i < 32; i++) {
    reversed = (reversed << 1) | (compat & 1)
    compat >>>= 1
  }
  const constraints = [...c.subarray(6, 12)]
  while (constraints.length && constraints[constraints.length - 1] === 0) constraints.pop()
  const parts = [format, `${space ? 'ABC'[space - 1] : ''}${profile}`, (reversed >>> 0).toString(16), `${tier ? 'H' : 'L'}${c[12]}`]
  return [...parts, ...constraints.map((v) => v.toString(16).toUpperCase())].join('.')
}

function audioEntry(b: Uint8Array, entry: Box, t: Track) {
  // QuickTime sound descriptions come in three versions, longer each time.
  const version = u16be(b, entry.body + 8)
  t.channels = u16be(b, entry.body + 16)
  t.sampleRate = u32be(b, entry.body + 24) >>> 16
  const start = entry.body + 28 + (version === 1 ? 16 : version === 2 ? 36 : 0)
  if (version === 2) {
    t.sampleRate = new DataView(b.buffer, b.byteOffset + entry.body + 32, 8).getFloat64(0)
    t.channels = u32be(b, entry.body + 40)
  }
  if (entry.type === 'Opus') {
    t.codec = 'opus'
    return
  }
  // mp4a's details are in an esds box, in MOV sometimes inside a 'wave' box.
  const kids = children(b, start, entry.end)
  const wave = kids.find((x) => x.type === 'wave')
  const esds = kids.find((x) => x.type === 'esds') ?? (wave && kid(b, wave, 'esds'))
  if (!esds || entry.type !== 'mp4a') return
  const es = readEsds(b.subarray(esds.body + 4, esds.end))
  if (!es) return
  if (es.objectType === 0x40 && es.config && es.config.length >= 2) {
    let aot = es.config[0] >> 3
    if (aot === 31) aot = 32 + (((es.config[0] & 7) << 3) | (es.config[1] >> 5))
    t.codec = `mp4a.40.${aot}`
    t.description = es.config
    const asc = audioConfig(es.config)
    if (asc.sampleRate) t.sampleRate = asc.sampleRate
    if (asc.channels) t.channels = asc.channels
  } else if (es.objectType === 0x6b || es.objectType === 0x69) t.codec = 'mp3'
}

/** An ES descriptor's object type and decoder-specific bytes (for AAC, the AudioSpecificConfig). */
function readEsds(d: Uint8Array): { objectType: number; config?: Uint8Array } | null {
  let p = 0
  const descriptor = (): { tag: number; end: number } | null => {
    if (p >= d.length) return null
    const tag = d[p++]
    let length = 0
    for (let i = 0; i < 4 && p < d.length; i++) {
      const v = d[p++]
      length = (length << 7) | (v & 0x7f)
      if (!(v & 0x80)) break
    }
    return { tag, end: Math.min(d.length, p + length) }
  }
  const es = descriptor()
  if (!es || es.tag !== 3) return null
  const flags = d[p + 2]
  p += 3
  if (flags & 0x80) p += 2
  if (flags & 0x40) p += 1 + d[p]
  if (flags & 0x20) p += 2
  const dc = descriptor()
  if (!dc || dc.tag !== 4) return null
  const objectType = d[p]
  p += 13
  const info = p < dc.end ? descriptor() : null
  return { objectType, config: info?.tag === 5 ? d.slice(p, info.end) : undefined }
}

/**
 * An AAC encoder's configuration as MP4 wants it, the AudioSpecificConfig.
 * Safari 26 hands back a whole esds box instead (WebKit bug 302253), which
 * written as it is gives a file with no sound: its config is dug out of it.
 */
export function aacConfig(d: Uint8Array): Uint8Array | undefined {
  const sound = (c?: Uint8Array) => (c && c.length >= 2 && audioConfig(c).sampleRate && audioConfig(c).channels ? c : undefined)
  if (d.length > 12 && latin1(d, 4, 8) === 'esds') return sound(readEsds(d.subarray(12))?.config)
  if (d.length > 6 && d[0] === 3) return sound(readEsds(d)?.config) // an ES descriptor on its own
  if (d.length > 6 && d[4] === 3 && !d[0] && !d[1] && !d[2] && !d[3]) return sound(readEsds(d.subarray(4))?.config) // an esds body
  return sound(d)
}

const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350]

/** The sample rate and channels an AudioSpecificConfig gives. */
export function audioConfig(c: Uint8Array): { sampleRate: number; channels: number } {
  // 5 bits of object type (or 11 when it's 31), then 4 of rate index (or 24 of rate when it's 15), then 4 of channels.
  let bit = 0
  const bits = (n: number) => {
    let v = 0
    for (let i = 0; i < n; i++, bit++) v = (v << 1) | ((c[bit >> 3] >> (7 - (bit & 7))) & 1)
    return v
  }
  if (bits(5) === 31) bits(6)
  const index = bits(4)
  const sampleRate = index === 15 ? bits(24) : (AAC_RATES[index] ?? 0)
  return { sampleRate, channels: bits(4) }
}

// --- The sample tables --------------------------------------------------------------------

function readSamples(b: Uint8Array, stbl: Box): Sample[] {
  const kids = children(b, stbl.body, stbl.end)
  const find = (type: string) => kids.find((x) => x.type === type)
  const stsz = find('stsz')
  const stz2 = find('stz2')
  const stsc = find('stsc')
  const stco = find('stco') ?? find('co64')
  const stts = find('stts')
  if (!stco || !stsc || !stts || (!stsz && !stz2)) return []

  // Sizes: one for all, or one each, or packed (stz2).
  let count: number
  let sizeOf: (i: number) => number
  if (stsz) {
    const uniform = u32be(b, stsz.body + 4)
    count = u32be(b, stsz.body + 8)
    sizeOf = uniform ? () => uniform : (i) => u32be(b, stsz.body + 12 + i * 4)
  } else {
    const field = u8(b, stz2!.body + 7)
    count = u32be(b, stz2!.body + 8)
    const p = stz2!.body + 12
    sizeOf = (i) => (field === 4 ? (i & 1 ? b[p + (i >> 1)] & 15 : b[p + (i >> 1)] >> 4) : field === 8 ? b[p + i] : u16be(b, p + i * 2))
  }
  const samples: Sample[] = new Array(count)

  // Offsets: chunks hold runs of samples, back to back.
  const wide = stco.type === 'co64'
  const chunkCount = u32be(b, stco.body + 4)
  const chunkAt = (i: number) => (wide ? u64be(b, stco.body + 8 + i * 8) : u32be(b, stco.body + 8 + i * 4))
  const runs = u32be(b, stsc.body + 4)
  let n = 0
  for (let r = 0; r < runs && n < count; r++) {
    const first = u32be(b, stsc.body + 8 + r * 12)
    const perChunk = u32be(b, stsc.body + 12 + r * 12)
    const next = r + 1 < runs ? u32be(b, stsc.body + 8 + (r + 1) * 12) : chunkCount + 1
    for (let c = first; c < next && c <= chunkCount && n < count; c++) {
      let offset = chunkAt(c - 1)
      for (let k = 0; k < perChunk && n < count; k++, n++) {
        const size = sizeOf(n)
        samples[n] = { offset, size, dts: 0, cts: 0, duration: 0, key: true }
        offset += size
      }
    }
  }
  if (n < count) fail('a track’s sample tables don’t agree')

  // Times: durations run by run (stts), then each one's offset to when it shows (ctts).
  let dts = 0
  n = 0
  const timeRuns = u32be(b, stts.body + 4)
  for (let r = 0; r < timeRuns && n < count; r++) {
    const runCount = u32be(b, stts.body + 8 + r * 8)
    const delta = u32be(b, stts.body + 12 + r * 8)
    for (let k = 0; k < runCount && n < count; k++, n++) {
      samples[n].dts = samples[n].cts = dts
      samples[n].duration = delta
      dts += delta
    }
  }
  const ctts = find('ctts')
  if (ctts) {
    n = 0
    const offsetRuns = u32be(b, ctts.body + 4)
    for (let r = 0; r < offsetRuns && n < count; r++) {
      const runCount = u32be(b, ctts.body + 8 + r * 8)
      const offset = u32be(b, ctts.body + 12 + r * 8) | 0 // signed in practice, whatever the version
      for (let k = 0; k < runCount && n < count; k++, n++) samples[n].cts = samples[n].dts + offset
    }
  }
  // Key frames: listed (stss), or every sample when there's no list.
  const stss = find('stss')
  if (stss) {
    for (const s of samples) s.key = false
    const keys = u32be(b, stss.body + 4)
    for (let i = 0; i < keys; i++) {
      const k = u32be(b, stss.body + 8 + i * 4) - 1
      if (k >= 0 && k < count) samples[k].key = true
    }
  }
  return samples
}

/** Where the track's edit list starts it: a wait first (an empty edit), then from mediaStart. */
function editList(b: Uint8Array, trak: Box, t: Track, movieScale: number) {
  const elst = path(b, trak, 'edts', 'elst')
  if (!elst || !movieScale) return
  const v1 = u8(b, elst.body) === 1
  const entries = u32be(b, elst.body + 4)
  let p = elst.body + 8
  for (let i = 0; i < entries; i++) {
    const duration = v1 ? u64be(b, p) : u32be(b, p)
    const hi = u32be(b, p + (v1 ? 8 : 4))
    const mediaTime = v1 ? (hi | 0) * 2 ** 32 + u32be(b, p + 12) : hi | 0
    p += v1 ? 20 : 12
    if (mediaTime === -1) t.delay += duration / movieScale
    else {
      t.mediaStart = mediaTime
      return // later edits (rare: cuts made in an editor) are ignored
    }
  }
}

/** When a sample shows, in microseconds from the start of the movie. */
export const showsAt = (t: Track, s: Sample) => Math.round(((s.cts - t.mediaStart) / t.timescale + t.delay) * 1e6)

/**
 * Reads samples in decode order, a run of neighbours at a time (one read for
 * samples that lie back to back, up to about 4 MB), so a long video isn't
 * thousands of small reads.
 */
export async function* readSamplesOf(read: Read, samples: Sample[], from = 0): AsyncGenerator<{ index: number; data: Uint8Array }> {
  const MAX_RUN = 4_000_000
  for (let i = from; i < samples.length; ) {
    let j = i + 1
    let end = samples[i].offset + samples[i].size
    while (j < samples.length && samples[j].offset === end && end - samples[i].offset + samples[j].size <= MAX_RUN) {
      end += samples[j].size
      j++
    }
    const run = await read(samples[i].offset, end - samples[i].offset)
    if (run.length < end - samples[i].offset) fail('the video is cut short')
    for (let k = i; k < j; k++) {
      const at = samples[k].offset - samples[i].offset
      yield { index: k, data: run.subarray(at, at + samples[k].size) }
    }
    i = j
  }
}
