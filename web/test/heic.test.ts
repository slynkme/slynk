// HEIC photos where the browser can't open them as pictures (all but
// Safari): the container read for the browser's own HEVC decoder
// (src/heic/read.ts), and where each tile's pixels land once the photo is
// cropped, turned and mirrored. Decoding needs a browser with an HEVC decoder
// (src/heic/decode.ts), so that's checked in one.
// Run from the repo root: npm --prefix web test
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { HeicError, codecChoices, looksLikeHeif, placement, readHeic, sizeAfter, type HeicPicture, type Step } from '../src/heic/read.ts'
import { streamColours, streamSize } from '../src/heic/vui.ts'
import { strip } from '../src/strip/isobmff.ts'
import { be16, be32, cat } from './strip/fixtures.ts'
import { TINY, box, clap, full, grid, heifFile, hvcC, imir, irot, ispe, nclx, phonePhoto, tileData, type Item } from './helpers/heic.ts'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

const throwsHeic = (b: Uint8Array, want?: 'primary' | 'thumbnail', message?: RegExp) =>
  assert.throws(() => readHeic(b, want), (e) => e instanceof HeicError && (!message || message.test(e.message)))

/** What a photo that says nothing of its colours gets: sRGB, with JPEG's full range and matrix (MIAF's, as libheif takes them). */
const PHOTO_COLOURS = { fullRange: true, primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'smpte170m' }

/** How long a call takes, in ms. */
function timed(f: () => void): number {
  const t = performance.now()
  f()
  return performance.now() - t
}

test('a real HEIC encoded with x265: its grid, configuration, tiles, turn, colours and thumbnail', () => {
  const b = new Uint8Array(TINY)
  assert.ok(looksLikeHeif(b))
  const p = readHeic(b)!
  assert.equal(p.codec, 'hvc1.1.6.L30.90')
  assert.deepEqual([p.columns, p.rows, p.tile, p.size], [2, 2, { width: 64, height: 64 }, { width: 120, height: 100 }])
  assert.deepEqual(p.steps, [{ turn: 270 }])
  assert.deepEqual(sizeAfter(p.size, p.steps), { width: 100, height: 120 })
  assert.deepEqual(p.colour, { fullRange: true, primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'smpte170m' })
  // The description is the hvcC record itself, with its parameter sets: VPS, SPS, PPS.
  const d = p.description
  const sets: number[] = []
  for (let i = 23, n = 0; n < d[22]; n++) {
    sets.push(d[i] & 0x3f)
    const count = (d[i + 1] << 8) | d[i + 2]
    i += 3
    for (let k = 0; k < count; k++) i += 2 + ((d[i] << 8) | d[i + 1])
  }
  assert.deepEqual([d[0], sets], [1, [32, 33, 34]])
  // Each tile is whole length-prefixed NAL units, the first a picture a decoder can start from.
  assert.equal(p.tiles.length, 4)
  for (const t of p.tiles) {
    let i = 0
    const types: number[] = []
    while (i < t.length) {
      types.push((t[i + 4] >> 1) & 0x3f)
      i += 4 + ((t[i] << 24) | (t[i + 1] << 16) | (t[i + 2] << 8) | t[i + 3])
    }
    assert.equal(i, t.length)
    assert.ok(types[0] >= 16 && types[0] <= 21, `NAL types ${types}`)
  }
  const thumb = readHeic(b, 'thumbnail')!
  assert.deepEqual([thumb.columns, thumb.rows, thumb.size, thumb.steps], [1, 1, { width: 64, height: 54 }, [{ turn: 270 }]])
})

test('a grid: its size from the grid itself, its tiles in the order it lists them, 32-bit sizes too', () => {
  const p = readHeic(phonePhoto({ tileIds: [15, 11, 14, 10, 13, 12] }))!
  assert.deepEqual([p.rows, p.columns, p.tile, p.size], [2, 3, { width: 512, height: 512 }, { width: 1524, height: 994 }])
  assert.deepEqual(p.tiles.map((t) => t[6]), [0, 1, 2, 3, 4, 5])
  assert.deepEqual(p.steps, [])
  assert.deepEqual(p.colour, PHOTO_COLOURS)

  const wide = heifFile({
    primary: 1,
    items: [{ id: 1, type: 'grid', data: grid(1, 2, 1000, 500, true), props: [ispe(1000, 500)] }, { id: 2, type: 'hvc1', data: tileData(0), props: [hvcC(), ispe(512, 512)] }, { id: 3, type: 'hvc1', data: tileData(1), props: [1 + 1, 1 + 2] }],
    refs: [['dimg', 1, [2, 3]]],
  })
  assert.deepEqual(readHeic(wide)!.size, { width: 1000, height: 500 })
})

test('a picture stored whole (one HEVC picture), and the codec named from its hvcC', () => {
  const b = heifFile({ primary: 7, items: [{ id: 7, type: 'hvc1', data: tileData(0), props: [hvcC(2, 0x20000000, 120), ispe(640, 480), irot(1)] }] })
  const p = readHeic(b)!
  assert.deepEqual([p.rows, p.columns, p.size, p.tile, p.steps], [1, 1, { width: 640, height: 480 }, { width: 640, height: 480 }, [{ turn: 90 }]])
  assert.equal(p.codec, 'hvc1.2.4.L120.90')
})

test('crop, turn and mirroring in the order the file lists them, each against the picture so far', () => {
  // As the test files: 1000 x 700, a 900 x 600 crop 20 right and 10 up of the middle, a quarter clockwise, mirrored left to right.
  const a = readHeic(phonePhoto({ rows: 2, columns: 2, width: 1000, height: 700, gridProps: [clap(900, 600, 20, -10), irot(3), imir(1)] }))!
  assert.deepEqual(a.steps, [{ crop: { x: 70, y: 40, width: 900, height: 600 } }, { turn: 270 }, { mirror: 'left-right' }])
  assert.deepEqual(sizeAfter(a.size, a.steps), { width: 600, height: 900 })
  // Turned first, the crop is measured on the turned picture.
  const b = readHeic(phonePhoto({ rows: 2, columns: 2, width: 1000, height: 700, gridProps: [irot(1), clap(600, 900, 0, 0), imir(0)] }))!
  assert.deepEqual(b.steps, [{ turn: 90 }, { crop: { x: 50, y: 50, width: 600, height: 900 } }, { mirror: 'top-bottom' }])
  // No turn at all, and a crop that doesn't fit the picture: left out.
  const c = readHeic(phonePhoto({ rows: 2, columns: 2, width: 1000, height: 700, gridProps: [irot(0), clap(1200, 600, 0, 0), clap(900, 600, 80, 0)] }))!
  assert.deepEqual(c.steps, [])
})

test('colours from an nclx box (code points WebCodecs has no name for left to the stream); an ICC profile is not used', () => {
  const colour = (...boxes: Uint8Array[]) => readHeic(phonePhoto({ gridProps: boxes }))!.colour
  assert.deepEqual(colour(nclx(12, 13, 6, true)), { fullRange: true, primaries: 'smpte432', transfer: 'iec61966-2-1', matrix: 'smpte170m' })
  assert.deepEqual(colour(nclx(9, 16, 9, false)), { fullRange: false, primaries: 'bt2020', transfer: 'pq', matrix: 'bt2020-ncl' })
  assert.deepEqual(colour(nclx(2, 2, 2, true)), { fullRange: true })
  const prof = box('colr', 'prof', new Array(64).fill(0))
  assert.deepEqual(colour(prof), PHOTO_COLOURS)
  // An ICC profile and an nclx box side by side, in either order: the nclx one.
  assert.deepEqual(colour(prof, nclx(9, 16, 9, false)), { fullRange: false, primaries: 'bt2020', transfer: 'pq', matrix: 'bt2020-ncl' })
  assert.deepEqual(colour(nclx(9, 16, 9, false), prof), { fullRange: false, primaries: 'bt2020', transfer: 'pq', matrix: 'bt2020-ncl' })
  // On a tile, when the grid has none.
  const b = heifFile({
    primary: 1,
    items: [{ id: 1, type: 'grid', data: grid(1, 1, 500, 500), props: [ispe(500, 500)] }, { id: 2, type: 'hvc1', data: tileData(0), props: [hvcC(), ispe(512, 512), nclx(1, 1, 1, false)] }],
    refs: [['dimg', 1, [2]]],
  })
  assert.deepEqual(readHeic(b)!.colour, { fullRange: false, primaries: 'bt709', transfer: 'bt709', matrix: 'bt709' })
})

// Parameter sets x265 wrote (as hvcC records), each with the colours GStreamer's h265parse read from the same stream.
const X265: [string, string, VideoColorSpaceInit][] = [
  [
    'full range BT.601, as a Samsung phone’s photos are',
    'AQFgAAAAkAAAAAAAP/AA/P34+AAADwOgAAEAGEABDAH//wFgAAADAJAAAAMAAAMAP5WYCaEAAQAvQgEBAWAAAAMAkAAAAwAAAwA/oCCBBZZWaSTK//AAEAAW4KAgoIAAAAMAgAAABQSiAAEAB0QBwXK0IkA=',
    { fullRange: true, primaries: 'bt470bg', transfer: 'bt709', matrix: 'bt470bg' },
  ],
  [
    'HLG',
    'AQFgAAAAkAAAAAAAP/AA/P34+AAADwOgAAEAGEABDAH//wFgAAADAJAAAAMAAAMAP5WYCaEAAQAvQgEBAWAAAAMAkAAAAwAAAwA/oCCBBZZWaSTK//AAEAAWoSJBIIAAAAMAgAAABQSiAAEAB0QBwXK0IkA=',
    { fullRange: false, primaries: 'bt2020', transfer: 'hlg' as VideoTransferCharacteristics, matrix: 'bt2020-ncl' as VideoMatrixCoefficients },
  ],
  [
    'PQ',
    'AQFgAAAAkAAAAAAAP/AA/P34+AAADwOgAAEAGEABDAH//wFgAAADAJAAAAMAAAMAP5WUCaEAAQAvQgEBAWAAAAMAkAAAAwAAAwA/oCCBBZZWWSTK//AAEAAWoYIAIIAAAAMAgAAABQSiAAEAB0QBwXK0IkA=',
    { fullRange: false, primaries: 'smpte432', transfer: 'pq', matrix: 'bt709' } as VideoColorSpaceInit,
  ],
  [
    'default scaling lists',
    'AQFgAAAAkAAAAAAAP/AA/P34+AAADwOgAAEAGEABDAH//wFgAAADAJAAAAMAAAMAP5WYCaEAAQAwQgEBAWAAAAMAkAAAAwAAAwA/oCCBBZZWaSTlf/gACAALcBAQEEAAAAMAQAAAAwKCogABAAdEAcFytCJA',
    { fullRange: true, primaries: 'bt709', transfer: 'bt709', matrix: 'bt709' },
  ],
  [
    'two temporal layers',
    'AQFgAAAAkAAAAAAAP/AA/P34+AAADwOgAAEAHEABDAL//wFgAAADAJAAAAMAAAMAPwAAlZSsoEihAAEANEIBAgFgAAADAJAAAAMAAAMAPwAAoCCBBZZWUrLJJlf/gACAALcBDQEEAAADAAQAAAMAKCCiAAEAB0QBwXK0IkA=',
    { fullRange: true, primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'bt709' },
  ],
  [
    'a cropped picture, a standard aspect ratio, RGB',
    'AQFgAAAAkAAAAAAAP/AA/P34+AAADwOgAAEAGEABDAH//wFgAAADAJAAAAMAAAMAP5WYCaEAAQAtQgEBAWAAAAMAkAAAAwAAAwA/oCCDHdZZWa5MrwJuAgIACAAAAwAIAAADAFBAogABAAZEAcFz0Ik=',
    { fullRange: true, primaries: 'bt709', transfer: 'bt709', matrix: 'rgb' },
  ],
]
const fromBase64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'))

interface SpsOptions {
  /** Each sub-layer's profile and level present flags. */
  subLayers?: [number, number][]
  /** 4:4:4, its colours coded apart. */
  chroma444?: boolean
  crop?: boolean
  ordering?: boolean
  scaling?: 'default' | 'data'
  pcm?: boolean
  /** Short-term reference picture sets: listed, or predicted from the set before (a flag pair for each of its pictures, and one more). */
  sets?: ({ negative: number; positive: number } | { flags: [number, number][] })[]
  longTerm?: number
  vui?: { sar?: number; overscan?: boolean; signal?: { full: boolean; colours?: [number, number, number] } }
}

/** An SPS written bit by bit (H.265 7.3.2.2), for the parts x265 doesn't write, in an hvcC record of its own. */
function spsRecord(o: SpsOptions): Uint8Array {
  const bits: number[] = []
  const u = (v: number, n: number) => {
    for (let i = n - 1; i >= 0; i--) bits.push(Math.floor(v / 2 ** i) % 2)
  }
  const ue = (v: number) => {
    const n = Math.floor(Math.log2(v + 1))
    u(0, n)
    u(v + 1, n + 1)
  }
  const profile = () => (u(0x01, 8), u(0x60000000, 32), u(0x90, 8), u(0, 40)) // Main, 88 bits
  const sub = o.subLayers ?? []
  u(0, 4), u(sub.length, 3), u(1, 1)
  profile(), u(93, 8)
  for (const [p, l] of sub) u(p, 1), u(l, 1)
  if (sub.length) u(0, 2 * (8 - sub.length))
  for (const [p, l] of sub) {
    if (p) profile()
    if (l) u(90, 8)
  }
  ue(5), ue(o.chroma444 ? 3 : 1)
  if (o.chroma444) u(1, 1)
  ue(1920), ue(1080)
  u(o.crop ? 1 : 0, 1)
  if (o.crop) ue(0), ue(2), ue(0), ue(1)
  ue(0), ue(0), ue(4) // 8 bits, 8-bit picture order counts
  u(o.ordering ? 1 : 0, 1)
  for (let i = o.ordering ? 0 : sub.length; i <= sub.length; i++) ue(4 + i), ue(i), ue(2 + i)
  for (const v of [0, 3, 0, 3, 1, 1]) ue(v)
  u(o.scaling ? 1 : 0, 1)
  if (o.scaling) {
    u(o.scaling === 'data' ? 1 : 0, 1)
    if (o.scaling === 'data')
      for (let size = 0; size < 4; size++)
        for (let m = 0; m < 6; m += size === 3 ? 3 : 1) {
          if (m % 2) {
            u(0, 1), ue(m === 1 ? 1 : 0) // predicted from a list before
            continue
          }
          u(1, 1)
          if (size > 1) ue(15)
          for (let i = Math.min(64, 1 << (4 + 2 * size)); i > 0; i--) ue(i % 5 === 0 ? 3 : 0)
        }
  }
  u(1, 1), u(1, 1) // amp, sao
  u(o.pcm ? 1 : 0, 1)
  if (o.pcm) u(7, 4), u(5, 4), ue(2), ue(1), u(0, 1)
  const sets = o.sets ?? []
  ue(sets.length)
  sets.forEach((s, i) => {
    if (i > 0) u('flags' in s ? 1 : 0, 1)
    if ('flags' in s) {
      u(1, 1), ue(0)
      for (const [used, delta] of s.flags) {
        u(used, 1)
        if (!used) u(delta, 1)
      }
    } else {
      ue(s.negative), ue(s.positive)
      for (let k = 0; k < s.negative + s.positive; k++) ue(k), u(1, 1)
    }
  })
  u(o.longTerm ? 1 : 0, 1)
  if (o.longTerm) {
    ue(o.longTerm)
    for (let k = 0; k < o.longTerm; k++) u((37 * k + 11) % 256, 8), u(k % 2, 1)
  }
  u(1, 1), u(1, 1)
  const v = o.vui
  u(v ? 1 : 0, 1)
  if (v) {
    u(v.sar === undefined ? 0 : 1, 1)
    if (v.sar !== undefined) u(v.sar, 8)
    if (v.sar === 255) u(4, 16), u(3, 16)
    u(v.overscan ? 1 : 0, 1)
    if (v.overscan) u(1, 1)
    u(v.signal ? 1 : 0, 1)
    if (v.signal) {
      u(5, 3), u(v.signal.full ? 1 : 0, 1), u(v.signal.colours ? 1 : 0, 1)
      for (const c of v.signal.colours ?? []) u(c, 8)
    }
    u(0, 7) // the rest of the VUI, all off
  }
  u(0, 1), u(1, 1) // no extensions; the stop bit
  while (bits.length % 8) bits.push(0)
  // Bytes, with emulation prevention: 00 00 then 03 before any byte up to 03.
  const nal = [0x42, 0x01]
  for (let i = 0, zeros = 0; i < bits.length; i += 8) {
    const byte = bits.slice(i, i + 8).reduce((a, b) => a * 2 + b, 0)
    if (zeros >= 2 && byte <= 3) {
      nal.push(3)
      zeros = 0
    }
    nal.push(byte)
    zeros = byte === 0 ? zeros + 1 : 0
  }
  return spsOnly(Uint8Array.from(nal))
}

/** An hvcC record holding just an SPS. */
const spsOnly = (nal: Uint8Array) => Uint8Array.from([1, ...new Array(21).fill(0), 1, 0x21, 0, 1, nal.length >> 8, nal.length & 0xff, ...nal])

/** The SPS from an hvcC record's arrays. */
function spsOf(d: Uint8Array): Uint8Array {
  for (let i = 23, n = 0; n < d[22]; n++) {
    const type = d[i] & 0x3f
    i += 3
    const len = (d[i] << 8) | d[i + 1]
    if (type === 33) return d.subarray(i + 2, i + 2 + len)
    i += 2 + len
  }
  throw new Error('no SPS')
}

test('the stream’s own colours, read from its SPS as GStreamer reads them', () => {
  for (const [name, record, colours] of X265) assert.deepEqual(streamColours(fromBase64(record)), colours, name)
  // Written by hand, the parts before the colours x265 doesn't write (these too were checked against GStreamer, put in an x265 stream).
  const cases: [string, SpsOptions, VideoColorSpaceInit][] = [
    [
      'reference picture sets, listed and predicted',
      { sets: [{ negative: 2, positive: 1 }, { flags: [[1, 0], [0, 1], [0, 0], [1, 0]] }, { flags: [[0, 0], [1, 0], [1, 0], [0, 1]] }], vui: { sar: 1, signal: { full: true, colours: [5, 1, 5] } } },
      { fullRange: true, primaries: 'bt470bg', transfer: 'bt709', matrix: 'bt470bg' },
    ],
    ['long-term pictures and PCM', { longTerm: 3, pcm: true, vui: { signal: { full: false, colours: [1, 1, 1] } } }, { fullRange: false, primaries: 'bt709', transfer: 'bt709', matrix: 'bt709' }],
    [
      'sub-layers with their own profiles and levels, a crop, an aspect ratio of its own, overscan',
      { subLayers: [[1, 1], [0, 1], [1, 0]], ordering: true, crop: true, vui: { sar: 255, overscan: true, signal: { full: true, colours: [9, 16, 9] } } },
      { fullRange: true, primaries: 'bt2020', transfer: 'pq', matrix: 'bt2020-ncl' as VideoMatrixCoefficients },
    ],
    ['scaling lists given in full', { scaling: 'data', vui: { signal: { full: true, colours: [6, 6, 6] } } }, { fullRange: true, primaries: 'smpte170m', transfer: 'smpte170m', matrix: 'smpte170m' }],
    ['4:4:4, sub-layers ordered by the last alone', { chroma444: true, subLayers: [[0, 1], [0, 0]], vui: { signal: { full: false, colours: [1, 13, 0] } } }, { fullRange: false, primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'rgb' }],
    ['a range but no colours', { vui: { signal: { full: true } } }, { fullRange: true }],
    ['colours WebCodecs has no name for', { scaling: 'default', vui: { signal: { full: false, colours: [2, 4, 2] } } }, { fullRange: false }],
  ]
  for (const [name, o, colours] of cases) assert.deepEqual(streamColours(spsRecord(o)), colours, name)
})

test('a stream that says nothing of its colours, or can’t be read, gives none', () => {
  assert.equal(streamColours(spsRecord({})), undefined, 'no VUI')
  assert.equal(streamColours(spsRecord({ vui: { sar: 1, overscan: true } })), undefined, 'a VUI without a video signal type')
  // Cut short anywhere before its colours' last byte.
  const sps = spsOf(fromBase64(X265[0][1]))
  assert.deepEqual(streamColours(spsOnly(sps.subarray(0, 37))), X265[0][2])
  for (let cut = 0; cut < 37; cut++) assert.equal(streamColours(spsOnly(sps.subarray(0, cut))), undefined, `cut at ${cut}`)
  // An SPS whose length runs past the record's end.
  assert.equal(streamColours(spsOnly(sps).subarray(0, 40)), undefined)
  assert.equal(streamColours(hvcC().subarray(8)), undefined, 'no parameter sets')
  assert.equal(streamColours(new Uint8Array(0)), undefined)
  const noise = new Uint8Array(400).map((_, i) => (i * 151 + 7) % 256)
  noise.set([1, ...new Array(21).fill(0), 1, 0x21, 0, 1, 1, 100], 0)
  assert.doesNotThrow(() => streamColours(noise))
})

test('a photo without an nclx box takes its stream’s colours; an nclx box comes first', () => {
  const photo = (...props: Uint8Array[]) =>
    readHeic(heifFile({ primary: 1, items: [{ id: 1, type: 'hvc1', data: tileData(0), props: [box('hvcC', fromBase64(X265[0][1])), ispe(64, 64), ...props] }] }))!
  assert.deepEqual(photo().colour, X265[0][2])
  assert.deepEqual(photo(box('colr', 'prof', new Array(64).fill(0))).colour, X265[0][2])
  assert.deepEqual(photo(nclx(1, 13, 1, false)).colour, { fullRange: false, primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'bt709' })
})

test('the thumbnail: the largest that can be read, or none', () => {
  const b = heifFile({
    primary: 1,
    items: [
      { id: 1, type: 'hvc1', data: tileData(0), props: [hvcC(), ispe(4000, 3000), irot(3)] },
      { id: 2, type: 'hvc1', data: tileData(1), props: [1, ispe(320, 240), 3] },
      { id: 3, type: 'hvc1', data: tileData(2), props: [1, ispe(160, 120)] },
      { id: 4, type: 'av01', data: tileData(3), props: [ispe(1024, 768)] },
    ],
    refs: [['thmb', 2, [1]], ['thmb', 3, [1]], ['thmb', 4, [1]]],
  })
  const t = readHeic(b, 'thumbnail')!
  assert.deepEqual([t.size, t.steps, t.tiles[0][6]], [{ width: 320, height: 240 }, [{ turn: 270 }], 1])
  assert.equal(readHeic(phonePhoto(), 'thumbnail'), undefined)
})

test('derived pictures: an identity item adds its steps to its source’s; a tone map shows its ordinary picture', () => {
  const b = heifFile({
    primary: 5,
    items: [
      { id: 1, type: 'hvc1', data: tileData(0), props: [hvcC(), ispe(800, 600), imir(1)] },
      { id: 5, type: 'iden', props: [ispe(600, 800), irot(1)] },
    ],
    refs: [['dimg', 5, [1]]],
  })
  assert.deepEqual(readHeic(b)!.steps, [{ mirror: 'left-right' }, { turn: 90 }])
  const hdr = heifFile({
    primary: 9,
    items: [
      { id: 1, type: 'hvc1', data: tileData(0), props: [hvcC(), ispe(800, 600)] },
      { id: 2, type: 'hvc1', data: tileData(1), props: [1, ispe(400, 300)] },
      { id: 9, type: 'tmap', data: new Uint8Array(8), props: [ispe(800, 600)] },
    ],
    refs: [['dimg', 9, [1, 2]]],
  })
  assert.deepEqual(readHeic(hdr)!.size, { width: 800, height: 600 })
})

test('tiles in separate but identical hvcC boxes are fine; anything Slynk can’t put together is refused', () => {
  const tiles = (second: Uint8Array) =>
    heifFile({
      primary: 1,
      items: [{ id: 1, type: 'grid', data: grid(1, 2, 1000, 500), props: [ispe(1000, 500)] }, { id: 2, type: 'hvc1', data: tileData(0), props: [hvcC(), ispe(512, 512)] }, { id: 3, type: 'hvc1', data: tileData(1), props: [second, 3] }],
      refs: [['dimg', 1, [2, 3]]],
    })
  assert.equal(readHeic(tiles(hvcC()))!.tiles.length, 2)
  throwsHeic(tiles(hvcC(1, 0x60000000, 93, 1)))
  // A grid with a tile missing, tiles of different sizes, a tile with no hvcC, a picture too big for its tiles.
  const ids = [10, 11, 12, 13, 14, 15]
  const b = phonePhoto({ tileIds: ids })
  throwsHeic(heifFile({ primary: 1, items: [{ id: 1, type: 'grid', data: grid(2, 3, 1500, 1000), props: [ispe(1500, 1000)] }, ...ids.slice(0, 5).map((id, i) => ({ id, type: 'hvc1', data: tileData(i), props: i ? [2, 3] : [hvcC(), ispe(512, 512)] }))], refs: [['dimg', 1, ids.slice(0, 5)]] }))
  throwsHeic(heifFile({ primary: 1, items: [{ id: 1, type: 'grid', data: grid(1, 2, 900, 500), props: [ispe(900, 500)] }, { id: 2, type: 'hvc1', data: tileData(0), props: [hvcC(), ispe(512, 512)] }, { id: 3, type: 'hvc1', data: tileData(1), props: [2, ispe(400, 512)] }], refs: [['dimg', 1, [2, 3]]] }))
  throwsHeic(heifFile({ primary: 1, items: [{ id: 1, type: 'hvc1', data: tileData(0), props: [ispe(512, 512)] }] }))
  throwsHeic(phonePhoto({ rows: 1, columns: 2, width: 1100, height: 500 }))
  // Not HEVC (AVIF), not HEIF, a file cut short, an item pointing past the end.
  throwsHeic(heifFile({ primary: 1, items: [{ id: 1, type: 'av01', data: tileData(0), props: [ispe(512, 512)] }], brands: ['avif', 'mif1', 'avif'] }))
  throwsHeic(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16]))
  throwsHeic(b.subarray(0, b.length - 40))
  const past = b.slice()
  const at = Buffer.from(past).indexOf('iloc') + 4 + 4 + 2 + 2 + 2 + 2 + 2 + 2 // the first location's offset
  past.set(be32(1 << 20), at)
  throwsHeic(past)
  // Only the thumbnail is looked for: one that can't be read is skipped, not thrown.
  assert.equal(readHeic(heifFile({ primary: 1, items: [{ id: 1, type: 'hvc1', data: tileData(0), props: [hvcC(), ispe(512, 512)] }, { id: 2, type: 'hvc1', data: tileData(1), props: [ispe(64, 64)] }], refs: [['thmb', 2, [1]]] }), 'thumbnail'), undefined)
})

// --- Crafted files (the adversarial review, 2026-10-28): a received HEIC's small picture is drawn on its own, on
// the page, so a file made to take all the memory or time there is refused at once instead.

/** A file of an ftyp box and a meta box holding these. */
const metaFile = (...boxes: Uint8Array[]) => cat(box('ftyp', 'heic', be32(0), 'mif1', 'heic'), full('meta', 0, 0, ...boxes))
const infe = (id: number, type: string) => full('infe', 2, 0, be16(id), be16(0), type, '\0')

/**
 * A 2 x 2 grid of 64 x 64 tiles (100 x 100) whose tiles' data is wherever pieces says, in the file itself (iloc
 * construction method 0; a length of 0 runs to the file's end), the grid's own in idat.
 */
function pointedGrid(pieces: (tile: number) => [number, number][]): Uint8Array {
  const tiles = [2, 3, 4, 5]
  const loc = (id: number, method: number, extents: [number, number][]) => cat(be16(id), be16(method), be16(0), be16(extents.length), ...extents.map(([o, l]) => cat(be32(o), be32(l))))
  return metaFile(
    full('pitm', 0, 0, be16(1)),
    full('iinf', 0, 0, be16(5), infe(1, 'grid'), ...tiles.map((id) => infe(id, 'hvc1'))),
    full('iref', 0, 0, box('dimg', be16(1), be16(4), ...tiles.map(be16))),
    box('iprp', box('ipco', ispe(100, 100), hvcC(), ispe(64, 64)), full('ipma', 0, 0, be32(5), cat(be16(1), [1, 1]), ...tiles.map((id) => cat(be16(id), [2, 2, 3])))),
    full('iloc', 1, 0, [0x44, 0x00], be16(5), loc(1, 1, [[0, 8]]), ...tiles.map((id, i) => loc(id, 0, pieces(i)))),
    box('idat', grid(2, 2, 100, 100)),
  )
}

test('item locations that cost nothing to list, or point outside their idat box, are refused at once (and by the cleaner)', () => {
  // Fields of no size: a 6 KB file could list 65,535 pieces of the whole file for each of 1,000 items.
  const entries = Array.from({ length: 1000 }, (_, i) => cat(be16(i + 1), be16(0), be16(65535)))
  const zero = metaFile(full('pitm', 0, 0, be16(1)), full('iinf', 0, 0, be16(1), infe(1, 'hvc1')), full('iloc', 0, 0, [0x00, 0x00], be16(1000), ...entries))
  assert.ok(timed(() => throwsHeic(zero, 'primary', /no size/)) < 500)
  assert.throws(() => strip(zero), /no size/)
  // Too many pieces in all: two items of 33,000 one-byte pieces.
  const one = (id: number) => cat(be16(id), be16(0), be16(33000), new Uint8Array(33000))
  const many = metaFile(full('pitm', 0, 0, be16(1)), full('iinf', 0, 0, be16(1), infe(1, 'hvc1')), full('iloc', 0, 0, [0x10, 0x00], be16(2), one(1), one(2)))
  throwsHeic(many, 'primary', /too many pieces/)
  // A piece of idat that runs past it.
  const past = metaFile(
    full('pitm', 0, 0, be16(1)),
    full('iinf', 0, 0, be16(1), infe(1, 'hvc1')),
    box('iprp', box('ipco', hvcC(), ispe(64, 64)), full('ipma', 0, 0, be32(1), cat(be16(1), [2, 1, 2]))),
    full('iloc', 1, 0, [0x44, 0x00], be16(1), cat(be16(1), be16(1), be16(0), be16(1), be32(0), be32(100))),
    box('idat', tileData(0)),
  )
  throwsHeic(past, 'primary', /outside its idat/)
})

test('tile data that repeats or overlaps, or a grid that lists a tile twice, is refused before it takes the memory', () => {
  const ok = pointedGrid((i) => [[0, 8 + i]])
  assert.equal(readHeic(ok)!.tiles.length, 4)
  // Every tile the whole file: four copies of it.
  throwsHeic(pointedGrid(() => [[0, 0]]), 'primary', /overlap/)
  // One tile made of its pieces twice over.
  throwsHeic(pointedGrid(() => [[0, 0], [0, 0]]), 'primary', /bigger than the file/)
  // The same tile listed twice in the grid.
  const ids = [10, 11, 12, 13, 14, 15]
  const twice = heifFile({
    primary: 1,
    items: [{ id: 1, type: 'grid', data: grid(2, 3, 1524, 994), props: [ispe(1524, 994)] }, ...ids.map((id, i) => ({ id, type: 'hvc1', data: tileData(i), props: i === 0 ? [hvcC(), ispe(512, 512)] : [2, 3] }))],
    refs: [['dimg', 1, [10, 10, 12, 13, 14, 15]]],
  })
  throwsHeic(twice, 'primary', /listed twice/)
})

test('a picture too big to open, or with whole tiles outside it, is refused before anything is copied', () => {
  const big = heifFile({
    primary: 1,
    items: [{ id: 1, type: 'grid', data: grid(1, 1, 100_000, 100_000, true), props: [ispe(100_000, 100_000)] }, { id: 2, type: 'hvc1', data: tileData(0), props: [hvcC(), ispe(100_000, 100_000)] }],
    refs: [['dimg', 1, [2]]],
  })
  throwsHeic(big, 'primary', /too big/)
  throwsHeic(heifFile({ primary: 7, items: [{ id: 7, type: 'hvc1', data: tileData(0), props: [hvcC(), ispe(10_000, 10_000)] }] }), 'primary', /too big/)
  // A 512 x 512 picture can't need a third column of 512-pixel tiles.
  throwsHeic(phonePhoto({ rows: 2, columns: 3, width: 512, height: 600 }), 'primary', /outside the picture/)
  throwsHeic(phonePhoto({ rows: 3, columns: 2, width: 600, height: 512 }), 'primary', /outside the picture/)
})

test('tiles whose stream would decode far bigger than they say are refused', () => {
  // spsRecord's stream is 1920 x 1080, cropped by 4 x 2 when its window is set.
  const photo = (w: number, h: number, o: SpsOptions = {}) =>
    heifFile({ primary: 7, items: [{ id: 7, type: 'hvc1', data: tileData(0), props: [box('hvcC', spsRecord(o)), ispe(w, h)] }] })
  assert.deepEqual(streamSize(spsRecord({})), { width: 1920, height: 1080 })
  assert.deepEqual(streamSize(spsRecord({ crop: true })), { width: 1916, height: 1078 })
  assert.deepEqual(streamSize(spsRecord({ chroma444: true, crop: true })), { width: 1918, height: 1079 })
  assert.deepEqual(readHeic(photo(1920, 1080))!.tile, { width: 1920, height: 1080 })
  throwsHeic(photo(64, 64), 'primary', /bigger than they say/)
  // The real one: its tiles' streams are just their size.
  const tiny = readHeic(new Uint8Array(TINY))!
  assert.deepEqual(streamSize(tiny.description), tiny.tile)
})

test('a file of thumbnails is looked at by their stated sizes: only the biggest is built', () => {
  // A 32 x 32 grid listed as the photo's thumbnail 1,000 times: built once, not 1,000 times (about 16 s, once).
  const tiles = Array.from({ length: 1024 }, (_, i) => 10 + i)
  const thumbGrid: Item[] = [
    { id: 2, type: 'grid', data: grid(32, 32, 2000, 2000), props: [ispe(2000, 2000)] },
    // 2 KB each, as a real tile's data is.
    ...tiles.map((id, i) => ({ id, type: 'hvc1', data: cat(be32(2044), [0x26, 0x01, i >> 8, i & 255], new Uint8Array(2040)), props: i === 0 ? [hvcC(), ispe(64, 64)] : [2, 3] })),
  ]
  const b = heifFile({
    primary: 1,
    items: [...thumbGrid, { id: 1, type: 'hvc1', data: tileData(0), props: [4, ispe(4000, 4000)] }],
    refs: [['dimg', 2, tiles], ...Array.from({ length: 1000 }, () => ['thmb', 2, [1]] as [string, number, number[]])],
  })
  let p: HeicPicture | undefined
  assert.ok(timed(() => (p = readHeic(b, 'thumbnail'))) < 1000)
  assert.deepEqual(p!.size, { width: 2000, height: 2000 })
})

test('an item with two property lists, oversized or broken boxes, and a huge ftyp are refused or cut short', () => {
  // Two ipma entries for one item: each could hold 255 properties, and every lookup would go through them all.
  const twice = metaFile(
    full('pitm', 0, 0, be16(1)),
    full('iinf', 0, 0, be16(1), infe(1, 'hvc1')),
    box('iprp', box('ipco', hvcC(), ispe(64, 64)), full('ipma', 0, 0, be32(1), cat(be16(1), [2, 1, 2])), full('ipma', 0, 0, be32(1), cat(be16(1), [1, 2]))),
    full('iloc', 1, 0, [0x44, 0x00], be16(1), cat(be16(1), be16(1), be16(0), be16(1), be32(0), be32(8))),
    box('idat', tileData(0)),
  )
  throwsHeic(twice, 'primary', /two property lists/)
  // 1,024 tiles sharing one big hvcC box: checked once, not copied and compared 1,024 times.
  const ids = Array.from({ length: 1024 }, (_, i) => 10 + i)
  const bigHvcC = box('hvcC', [1, 1], be32(0x60000000), [0x90, 0, 0, 0, 0, 0, 93, 0xf0, 0, 0xfc, 0xfd, 0xf8, 0xf8, 0, 0, 0x0f, 0], new Uint8Array(60_000))
  const shared = heifFile({
    primary: 1,
    items: [{ id: 1, type: 'grid', data: grid(32, 32, 2048, 2048), props: [ispe(2048, 2048)] }, ...ids.map((id, i) => ({ id, type: 'hvc1', data: tileData(i % 250), props: i === 0 ? [bigHvcC, ispe(64, 64)] : [2, 3] }))],
    refs: [['dimg', 1, ids]],
  })
  assert.ok(timed(() => assert.equal(readHeic(shared)!.tiles.length, 1024)) < 1000)
  // An hvcC far bigger than any real one.
  const huge = box('hvcC', [1, 1], be32(0x60000000), [0x90, 0, 0, 0, 0, 0, 93, 0xf0, 0, 0xfc, 0xfd, 0xf8, 0xf8, 0, 0, 0x0f, 0], new Uint8Array(70_000))
  throwsHeic(heifFile({ primary: 7, items: [{ id: 7, type: 'hvc1', data: tileData(0), props: [huge, ispe(64, 64)] }] }), 'primary', /too big/)
  // Boxes too short for their fields: refused, not read from the next box.
  throwsHeic(phonePhoto({ gridProps: [box('imir')] }), 'primary', /cut short/)
  throwsHeic(phonePhoto({ gridProps: [box('irot')] }), 'primary', /cut short/)
  throwsHeic(heifFile({ primary: 7, items: [{ id: 7, type: 'hvc1', data: tileData(0), props: [hvcC(), full('ispe', 0, 0, be32(64))] }] }), 'primary', /cut short/)
  throwsHeic(metaFile(full('pitm', 0, 0, [1])), 'primary', /cut short/)
  // An ftyp of 10 MB of brands: only its first ones are looked at.
  const ftyp = box('ftyp', 'isom', be32(0), new Uint8Array(10_000_000).fill(0x61), 'heic')
  let heif = true
  assert.ok(timed(() => (heif = looksLikeHeif(ftyp))) < 200)
  assert.equal(heif, false)
})

test('HEIF is recognised by its brands, not other ISO media files', () => {
  assert.ok(looksLikeHeif(phonePhoto()))
  assert.ok(looksLikeHeif(cat(box('ftyp', 'mif1', be32(0), 'mif1', 'heic'))))
  assert.ok(!looksLikeHeif(cat(box('ftyp', 'isom', be32(0), 'isom', 'iso2', 'mp41'))))
  // 'heic' as the minor version (a number), not a brand.
  assert.ok(!looksLikeHeif(cat(box('ftyp', 'qt  ', 'heic', 'qt  '))))
  assert.ok(!looksLikeHeif(new Uint8Array([0xff, 0xd8, 0xff])))
})

test('a Main Still Picture photo is also asked about as Main', () => {
  assert.deepEqual(codecChoices('hvc1.3.e.L90.90'), ['hvc1.3.e.L90.90', 'hvc1.1.6.L90.90'])
  assert.deepEqual(codecChoices('hvc1.3.E.L120.B0'), ['hvc1.3.E.L120.B0', 'hvc1.1.6.L120.B0'])
  assert.deepEqual(codecChoices('hvc1.1.6.L93.B0'), ['hvc1.1.6.L93.B0'])
  assert.deepEqual(codecChoices('hvc1.2.4.L120.90'), ['hvc1.2.4.L120.90'])
})

/** Where a pixel goes, worked out step by step without a matrix. */
function byHand(x: number, y: number, size: { width: number; height: number }, steps: Step[]): [number, number] | undefined {
  let { width: W, height: H } = size
  for (const s of steps) {
    if ('crop' in s) {
      x -= s.crop.x
      y -= s.crop.y
      if (x < 0 || y < 0 || x >= s.crop.width || y >= s.crop.height) return undefined
      W = s.crop.width
      H = s.crop.height
    } else if ('mirror' in s) {
      if (s.mirror === 'left-right') x = W - 1 - x
      else y = H - 1 - y
    } else if (s.turn === 180) {
      x = W - 1 - x
      y = H - 1 - y
    } else {
      // Anticlockwise a quarter: the top row becomes the left column, read upwards.
      ;[x, y] = s.turn === 90 ? [y, W - 1 - x] : [H - 1 - y, x]
      ;[W, H] = [H, W]
    }
  }
  return [x, y]
}

test('every pixel lands where the steps put it, for every turn and mirroring, cropped or not', () => {
  const size = { width: 5, height: 3 }
  const turns: Step[][] = [[], [{ turn: 90 }], [{ turn: 180 }], [{ turn: 270 }]]
  const mirrors: Step[][] = [[], [{ mirror: 'left-right' }], [{ mirror: 'top-bottom' }]]
  // A crop inside the picture as it is at that point: 5 x 3, or 3 x 5 once turned a quarter.
  const crop = (at: { width: number; height: number }): Step[] => [{ crop: { x: 1, y: 1, width: at.width - 2, height: at.height - 1 } }]
  let checked = 0
  for (const cropped of [false, true])
    for (const turn of turns)
      for (const mirror of mirrors)
        for (const steps of [[...(cropped ? crop(size) : []), ...turn, ...mirror], [...turn, ...mirror, ...(cropped ? crop(sizeAfter(size, turn)) : [])]]) {
          const out = sizeAfter(size, steps)
          const { size: got, matrix: [a, b, c, d, e, f] } = placement({ size, steps })
          assert.deepEqual(got, out)
          for (let y = 0; y < size.height; y++)
            for (let x = 0; x < size.width; x++) {
              const X = x + 0.5
              const Y = y + 0.5
              const at = [Math.floor(a * X + c * Y + e), Math.floor(b * X + d * Y + f)]
              const inside = at[0] >= 0 && at[1] >= 0 && at[0] < got.width && at[1] < got.height
              assert.deepEqual(inside ? at : undefined, byHand(x, y, size, steps), JSON.stringify({ steps, x, y }))
              checked++
            }
        }
  assert.ok(checked > 300)
  // As a phone held upright writes it (irot 3, a quarter clockwise): the top left corner ends up top right.
  const { matrix: m } = placement({ size: { width: 4000, height: 3000 }, steps: [{ turn: 270 }] })
  assert.deepEqual([m[0] * 0.5 + m[2] * 0.5 + m[4], m[1] * 0.5 + m[3] * 0.5 + m[5]], [2999.5, 0.5])
})

test('photos fall back to the HEVC decoder only after the browser’s own decoding fails, so Safari is unchanged', () => {
  const draw = read('../src/shrink/draw.ts')
  const view = read('../src/ui/photoView.ts')
  assert.match(draw, /const bitmap = await createImageBitmap\(new Blob\(\[bytes as BlobPart\]\)\)\n    return \{ picture: bitmap, [^\n]*\n  \} catch \{\n[^\n]*\n    const heic = info\.kind === 'heic' \? await decodeHeic\(bytes, \{ scale: baseScale \}\) : undefined\n    if \(heic\) return \{ picture: heic\.canvas, dims: heic\.size \}\n    throw new CopyError\('open'\)/)
  assert.match(view, /const bitmap = await createImageBitmap\(new Blob\(\[data as BlobPart\], \{ type \}\)\)\n    return \{ picture: bitmap, [^\n]*\n  \} catch \(e\) \{\n[^\n]*\n[^\n]*\n    const heic = await decodeHeic\(data, \{ thumbnail, scale \}\)/)
  // Code in the page's own bundle: no worker, nothing fetched when it's needed. (How it decodes: heic-decode.test.ts.)
  const decode = read('../src/heic/decode.ts')
  assert.doesNotMatch(decode + read('../src/heic/read.ts') + read('../src/heic/vui.ts'), /import\(|new Worker|fetch\(/)
  // One photo at a time.
  assert.match(decode, /const next = queue\.then\(\(\) => decode\(bytes, o\)\)/)
})
