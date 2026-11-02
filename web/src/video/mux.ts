// Writes a small MP4: H.264 video and AAC or Opus sound, or sound alone (an
// M4A, for audio made smaller: audio/shrink.ts), the index (moov) first so it
// plays as soon as it starts arriving, the samples interleaved about a second
// at a time. It carries nothing about where or when it was made: no dates
// (every time field is zero), no device, no software name.
import { Writer, ascii } from '../strip/bytes.ts'

export interface MuxSample {
  data: Uint8Array
  /** Microseconds from the start. */
  pts: number
  duration: number
  key: boolean
}

export interface MuxVideo {
  width: number
  height: number
  /** Clockwise, as the original was turned when played. */
  rotation: 0 | 90 | 180 | 270
  /** avcC, from the encoder. */
  description: Uint8Array
  /** In decode order, as the encoder gave them. */
  samples: MuxSample[]
}

export interface MuxAudio {
  codec: 'aac' | 'opus'
  sampleRate: number
  channels: number
  /** The AudioSpecificConfig for AAC; for Opus, its identification header (OpusHead), if the encoder gave one. */
  description?: Uint8Array
  samples: MuxSample[]
}

/** About how long a chunk (a run of one track's samples) lasts, in microseconds. */
const CHUNK_US = 1_000_000
const VIDEO_SCALE = 90_000
const MOVIE_SCALE = 1000

type Body = (w: Writer) => void

function box(w: Writer, type: string, body: Body) {
  const start = w.length
  w.u32be(0)
  w.bytes(ascii(type))
  body(w)
  w.setU32be(start, w.length - start) // its size, now it's known
}

const fullBox = (w: Writer, type: string, version: number, flags: number, body: Body) =>
  box(w, type, (w) => {
    w.u32be(((version & 0xff) << 24) | (flags & 0xffffff))
    body(w)
  })

const zeros = (w: Writer, n: number) => {
  for (let i = 0; i < n; i++) w.byte(0)
}

/** The track's matrix: a turn, with the shift that keeps the picture in view. 16.16 and 2.30 fixed point. */
function matrix(w: Writer, rotation: number, width: number, height: number) {
  const one = 0x10000
  const [a, b, c, d, x, y] =
    rotation === 90
      ? [0, one, -one, 0, height * one, 0]
      : rotation === 180
        ? [-one, 0, 0, -one, width * one, height * one]
        : rotation === 270
          ? [0, -one, one, 0, 0, width * one]
          : [one, 0, 0, one, 0, 0]
  for (const v of [a, b, 0, c, d, 0, x, y, 0x40000000]) w.u32be(v >>> 0)
}

interface Plan {
  kind: 'video' | 'audio'
  id: number
  scale: number
  /** Decode-time deltas, composition offsets and sizes, per sample, in the track's scale. */
  deltas: number[]
  offsets: number[]
  sizes: number[]
  keys: number[] // 1-based, video only
  /** How the samples are grouped into chunks, and where each chunk will start in the file. */
  chunks: { first: number; count: number; at: number; startUs: number }[]
  duration: number // in the track's scale
  /** The edit list's start, when composition offsets had to be shifted up. */
  shift: number
  /** Where an Opus track alone starts, in its scale: its decoder's warm-up (pre-skip), which isn't played. */
  skip: number
  samples: MuxSample[]
}

function planTrack(kind: 'video' | 'audio', id: number, scale: number, samples: MuxSample[]): Plan {
  const toScale = (us: number) => Math.round((us * scale) / 1e6)
  // Decode times: the presentation times in order (no B-frames: the same times).
  // Sound: each piece follows the last for as long as it lasts, one run in the index.
  const pts = samples.map((s) => toScale(s.pts))
  const dts = [...pts].sort((a, b) => a - b)
  const raw = kind === 'audio' ? pts.map(() => 0) : pts.map((p, i) => p - dts[i])
  const shift = Math.max(0, -Math.min(0, ...raw))
  const offsets = raw.map((o) => o + shift)
  const last = samples.length - 1
  const deltas =
    kind === 'audio'
      ? samples.map((s) => Math.max(1, toScale(s.duration)))
      : dts.map((t, i) => (i < last ? dts[i + 1] - t : Math.max(1, toScale(samples[last].duration))))
  const keys = kind === 'video' ? samples.flatMap((s, i) => (s.key ? [i + 1] : [])) : []
  const chunks: Plan['chunks'] = []
  for (let i = 0; i < samples.length; i++) {
    const c = chunks[chunks.length - 1]
    if (c && samples[i].pts - c.startUs < CHUNK_US) c.count++
    else chunks.push({ first: i, count: 1, at: 0, startUs: samples[i].pts })
  }
  const duration = deltas.reduce((a, b) => a + b, 0)
  return { kind, id, scale, deltas, offsets, sizes: samples.map((s) => s.data.length), keys, chunks, duration, shift, skip: 0, samples }
}

/** Runs of equal values, as [count, value] pairs. */
function runs(values: number[]): [number, number][] {
  const out: [number, number][] = []
  for (const v of values) {
    const last = out[out.length - 1]
    if (last && last[1] === v) last[0]++
    else out.push([1, v])
  }
  return out
}

/** An Opus track's pre-skip and input rate, from the identification header (OpusHead) its encoder gave, if any. */
function opusHead(a: MuxAudio): { preSkip: number; inputRate: number } {
  const head = a.description && a.description.length >= 19 ? new DataView(a.description.buffer, a.description.byteOffset) : undefined
  return { preSkip: head ? head.getUint16(10, true) : 312, inputRate: head ? head.getUint32(12, true) : a.sampleRate }
}

/** The file: video with or without sound, or (video null) sound alone. */
export function mux(video: MuxVideo | null, audio?: MuxAudio): Uint8Array {
  const plans = video ? [planTrack('video', 1, VIDEO_SCALE, video.samples)] : []
  if (audio?.samples.length) {
    const p = planTrack('audio', plans.length + 1, audio.codec === 'opus' ? 48000 : audio.sampleRate, audio.samples)
    // Sound alone starts where Opus says, as its mapping into MP4 asks; beside a video it's left as before.
    if (!video && audio.codec === 'opus') p.skip = Math.min(opusHead(audio).preSkip, Math.max(0, p.duration - 1))
    plans.push(p)
  }
  if (!plans.length) throw new Error('nothing to write')
  const shownOf = (p: Plan) => Math.round(((p.duration - p.shift - p.skip) * MOVIE_SCALE) / p.scale)
  const movieDuration = Math.max(...plans.map(shownOf))

  const ftyp = (w: Writer) =>
    box(w, 'ftyp', (w) => {
      // Sound alone is an M4A, as players expect of a .m4a file.
      w.bytes(ascii(video ? 'isom' : 'M4A '))
      w.u32be(0x200)
      for (const b of video ? ['isom', 'iso2', 'avc1', 'mp41'] : ['M4A ', 'isom', 'iso2', 'mp41']) w.bytes(ascii(b))
    })

  const moov = (w: Writer) =>
    box(w, 'moov', (w) => {
      fullBox(w, 'mvhd', 0, 0, (w) => {
        w.u32be(0) // created
        w.u32be(0) // modified
        w.u32be(MOVIE_SCALE)
        w.u32be(movieDuration)
        w.u32be(0x00010000) // rate
        w.u16be(0x0100) // volume
        zeros(w, 10)
        matrix(w, 0, 0, 0)
        zeros(w, 24)
        w.u32be(plans.length + 1) // next track ID
      })
      for (const p of plans) trak(w, p)
    })

  const trak = (w: Writer, p: Plan) =>
    box(w, 'trak', (w) => {
      const isVideo = p.kind === 'video'
      const shown = shownOf(p)
      fullBox(w, 'tkhd', 0, 3, (w) => {
        w.u32be(0) // created
        w.u32be(0) // modified
        w.u32be(p.id)
        w.u32be(0)
        w.u32be(shown)
        zeros(w, 8)
        w.u16be(0) // layer
        w.u16be(0) // alternate group
        w.u16be(isVideo ? 0 : 0x0100) // volume
        w.u16be(0)
        matrix(w, isVideo ? video!.rotation : 0, video?.width ?? 0, video?.height ?? 0)
        w.u32be(isVideo ? video!.width * 0x10000 : 0)
        w.u32be(isVideo ? video!.height * 0x10000 : 0)
      })
      if (p.shift || p.skip)
        box(w, 'edts', (w) =>
          fullBox(w, 'elst', 0, 0, (w) => {
            w.u32be(1)
            w.u32be(shown)
            w.u32be(p.shift || p.skip)
            w.u32be(0x00010000)
          }),
        )
      box(w, 'mdia', (w) => {
        fullBox(w, 'mdhd', 0, 0, (w) => {
          w.u32be(0)
          w.u32be(0)
          w.u32be(p.scale)
          w.u32be(p.duration)
          w.u16be(0x55c4) // language: undetermined
          w.u16be(0)
        })
        fullBox(w, 'hdlr', 0, 0, (w) => {
          w.u32be(0)
          w.bytes(ascii(isVideo ? 'vide' : 'soun'))
          zeros(w, 12)
          w.byte(0) // no name
        })
        box(w, 'minf', (w) => {
          if (isVideo)
            fullBox(w, 'vmhd', 0, 1, (w) => {
              zeros(w, 8)
            })
          else
            fullBox(w, 'smhd', 0, 0, (w) => {
              zeros(w, 4)
            })
          box(w, 'dinf', (w) =>
            fullBox(w, 'dref', 0, 0, (w) => {
              w.u32be(1)
              fullBox(w, 'url ', 0, 1, () => {})
            }),
          )
          box(w, 'stbl', (w) => stbl(w, p))
        })
      })
    })

  const stbl = (w: Writer, p: Plan) => {
    fullBox(w, 'stsd', 0, 0, (w) => {
      w.u32be(1)
      if (p.kind === 'video') avc1(w)
      else if (audio!.codec === 'aac') mp4a(w)
      else opus(w)
    })
    const timeRuns = runs(p.deltas)
    fullBox(w, 'stts', 0, 0, (w) => {
      w.u32be(timeRuns.length)
      for (const [n, v] of timeRuns) {
        w.u32be(n)
        w.u32be(v)
      }
    })
    if (p.offsets.some((o) => o)) {
      const offsetRuns = runs(p.offsets)
      fullBox(w, 'ctts', 0, 0, (w) => {
        w.u32be(offsetRuns.length)
        for (const [n, v] of offsetRuns) {
          w.u32be(n)
          w.u32be(v)
        }
      })
    }
    if (p.kind === 'video' && p.keys.length < p.sizes.length)
      fullBox(w, 'stss', 0, 0, (w) => {
        w.u32be(p.keys.length)
        for (const k of p.keys) w.u32be(k)
      })
    const perChunk = runs(p.chunks.map((c) => c.count))
    fullBox(w, 'stsc', 0, 0, (w) => {
      w.u32be(perChunk.length)
      let chunk = 1
      for (const [n, count] of perChunk) {
        w.u32be(chunk)
        w.u32be(count)
        w.u32be(1) // sample description
        chunk += n
      }
    })
    fullBox(w, 'stsz', 0, 0, (w) => {
      w.u32be(0)
      w.u32be(p.sizes.length)
      for (const s of p.sizes) w.u32be(s)
    })
    fullBox(w, 'stco', 0, 0, (w) => {
      w.u32be(p.chunks.length)
      for (const c of p.chunks) w.u32be(c.at)
    })
  }

  const avc1 = (w: Writer) =>
    box(w, 'avc1', (w) => {
      const pic = video!
      zeros(w, 6)
      w.u16be(1) // data reference
      zeros(w, 16)
      w.u16be(pic.width)
      w.u16be(pic.height)
      w.u32be(0x00480000) // 72 dpi
      w.u32be(0x00480000)
      w.u32be(0)
      w.u16be(1) // frames per sample
      zeros(w, 32) // no compressor name
      w.u16be(0x18) // depth
      w.u16be(0xffff)
      box(w, 'avcC', (w) => w.bytes(pic.description))
      // Plain SDR video in the usual HD colours (BT.709), whatever the original was.
      box(w, 'colr', (w) => {
        w.bytes(ascii('nclx'))
        w.u16be(1)
        w.u16be(1)
        w.u16be(1)
        w.byte(0) // limited range
      })
      box(w, 'pasp', (w) => {
        w.u32be(1)
        w.u32be(1)
      })
    })

  const soundEntry = (w: Writer, a: MuxAudio) => {
    zeros(w, 6)
    w.u16be(1)
    zeros(w, 8)
    w.u16be(a.channels)
    w.u16be(16)
    w.u32be(0)
    w.u32be((a.sampleRate * 0x10000) >>> 0)
  }

  const mp4a = (w: Writer) =>
    box(w, 'mp4a', (w) => {
      const a = audio!
      soundEntry(w, a)
      const asc = a.description!
      const bitrate = Math.round((a.samples.reduce((n, s) => n + s.data.length, 0) * 8 * 1e6) / Math.max(1, a.samples.reduce((n, s) => n + s.duration, 0)))
      const descriptor = (tag: number, body: number[]) => [tag, body.length, ...body]
      const config = descriptor(4, [0x40, 0x15, 0, 0x18, 0, ...u32(bitrate), ...u32(bitrate), ...descriptor(5, [...asc])])
      const es = descriptor(3, [0, 2, 0, ...config, ...descriptor(6, [2])])
      fullBox(w, 'esds', 0, 0, (w) => w.bytes(new Uint8Array(es)))
    })

  const opus = (w: Writer) =>
    box(w, 'Opus', (w) => {
      const a = audio!
      soundEntry(w, { ...a, sampleRate: 48000 })
      // dOps is OpusHead's fields, big-endian, without its magic.
      const { preSkip, inputRate } = opusHead(a)
      box(w, 'dOps', (w) => {
        w.byte(0)
        w.byte(a.channels)
        w.u16be(preSkip)
        w.u32be(inputRate)
        w.u16be(0) // gain
        w.byte(0) // mono or stereo
      })
    })

  // Lay out once to learn the index's size, then place the chunks after it and write it for real.
  const order = plans.flatMap((p) => p.chunks.map((c) => ({ p, c }))).sort((x, y) => x.c.startUs - y.c.startUs || x.p.id - y.p.id)
  const head = new Writer()
  ftyp(head)
  moov(head)
  const mdatSize = 8 + plans.reduce((n, p) => n + p.sizes.reduce((a, b) => a + b, 0), 0)
  let at = head.length + 8
  for (const { p, c } of order) {
    c.at = at
    for (let i = c.first; i < c.first + c.count; i++) at += p.sizes[i]
  }
  const w = new Writer()
  ftyp(w)
  moov(w)
  if (w.length !== head.length) throw new Error('the index changed size')
  w.u32be(mdatSize)
  w.bytes(ascii('mdat'))
  for (const { p, c } of order) for (let i = c.first; i < c.first + c.count; i++) w.bytes(p.samples[i].data)
  return w.finish()
}

const u32 = (v: number) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]
