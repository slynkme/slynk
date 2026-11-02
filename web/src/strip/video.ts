// MP4, MOV, M4V and 3GP videos (ISO base media / QuickTime "boxes"), the way
// phones and cameras write them. The pictures and sound are found by absolute
// byte offsets (each track's chunk offsets, stco/co64), so nothing may move:
// metadata is overwritten in place at the same length, never cut out.
//   - user data and metadata boxes (udta, meta) in the movie and its tracks
//     become zeroed 'free' boxes, a box type every player skips. That's where
//     an iPhone keeps its location, make, model, software and creation date
//     (moov/meta, Apple's "mdta" keys), and Android its location (©xyz) and
//     the rest (udta)
//   - creation and modification times in the movie, track and media headers
//     are zeroed (rotation, in the track header's matrix, is left alone)
//   - timed metadata tracks have their samples zeroed where they lie: action
//     cameras record location and motion as they film (GoPro "gpmd", Google
//     "camm", DJI), iPhones some details of their own ("mebx"), and timecode
//     tracks the time of day. The track itself stays, so the file still plays
//   - top-level uuid boxes (XMP and makers' own data) become zeroed 'free'
//     boxes; padding with leftovers in it is zeroed; anything after the last
//     box is cut
// Every byte a kept track's samples live in is checked against what would be
// blanked, and the file is refused rather than damaged if they overlap. What
// the removed details said (the location, the phone, the dates) is read for
// the sender's own "Cleaned" list, and never sent or kept.
import { allZero, ascii, concat, fromUtf8, latin1, u16be, u32be, u64be, u8 } from './bytes.ts'
import { LABEL } from './labels.ts'
import { type FormatOutcome, type Found, fail } from './types.ts'
import { addAll, addFound, cameraName, formatExifDate, formatGps } from './values.ts'
import { xmpLabels, xmpValues } from './xmp.ts'

const UUID_C2PA = 'd8fec3d61b0e483c92975828877ec481'
const UUID_XMP = 'be7acfcb97a942e89c71999491e3afac'

/** Tracks whose samples are metadata rather than pictures or sound: zeroed. */
const DATA_HANDLERS = new Set(['meta', 'camm', 'tmcd'])
/** Sample formats that record location and motion as the camera films. */
const SENSOR_FORMATS = new Set(['gpmd', 'camm', 'djmd', 'dbgi'])
/** More samples than any real phone video has: a table claiming more is refused. */
const MAX_SAMPLES = 20_000_000

interface Box {
  type: string
  start: number
  body: number
  end: number
}

type Extent = [number, number] // absolute start, end

function readBox(b: Uint8Array, pos: number, end: number, anyType = false): Box | null {
  if (pos + 8 > end) return null
  let size = u32be(b, pos)
  const type = latin1(b, pos + 4, pos + 8)
  // Apple's metadata lists name their items by number, so those types aren't letters.
  if (!anyType && !/^[\x20-\x7e\xa9]{4}$/.test(type)) return null
  let header = 8
  if (size === 1) {
    if (pos + 16 > end) return null
    size = u64be(b, pos + 8)
    header = 16
  } else if (size === 0) size = end - pos
  if (size < header || pos + size > end) return null
  return { type, start: pos, body: pos + header, end: pos + size }
}

function children(b: Uint8Array, start: number, end: number, anyType = false): Box[] {
  const out: Box[] = []
  for (let pos = start; pos < end; ) {
    const box = readBox(b, pos, end, anyType)
    if (!box) fail('bad box inside the video')
    out.push(box)
    pos = box.end
  }
  return out
}

/** Top-level boxes; whatever follows the last valid box is a trailer. */
function topLevel(b: Uint8Array): { list: Box[]; end: number } {
  const list: Box[] = []
  let pos = 0
  for (;;) {
    const box = readBox(b, pos, b.length)
    if (!box) break
    list.push(box)
    pos = box.end
  }
  if (!list.length || list[0].type !== 'ftyp') fail('not an ISO media file')
  if (!list.some((x) => x.type === 'moov')) fail('a video without its movie box')
  return { list, end: pos }
}

const child = (b: Uint8Array, parent: Box, type: string) => children(b, parent.body, parent.end).find((x) => x.type === type)

function hex(b: Uint8Array): string {
  return [...b].map((v) => v.toString(16).padStart(2, '0')).join('')
}

// --- What the removed details said, for the sender's "Cleaned" list ----------------------
// Read leniently: a detail that can't be read is still removed, just not shown.

/** "12.34° N, 56.78° E" from an ISO 6709 string ("+12.3456+056.7890+010.000/"), as phones write it. */
export function iso6709(raw: string): string | null {
  const m = /^([+-])(\d+(?:\.\d+)?)([+-])(\d+(?:\.\d+)?)/.exec(raw.trim())
  if (!m) return null
  // Degrees, or degrees and minutes (DDMM.M), or with seconds too (DDMMSS.S), by the digits before the point.
  const part = (digits: string, degreeDigits: number): number[] => {
    const whole = digits.split('.')[0].length
    const n = Number(digits)
    if (whole <= degreeDigits) return [n]
    if (whole === degreeDigits + 2) return [Math.floor(n / 100), n % 100]
    if (whole === degreeDigits + 4) return [Math.floor(n / 10000), Math.floor(n / 100) % 100, n % 100]
    return [NaN]
  }
  return formatGps(part(m[2], 2), m[1] === '-' ? 'S' : 'N', part(m[4], 3), m[3] === '-' ? 'W' : 'E')
}

/** A 3GPP 'loci' box's coordinates, as a location. */
function loci(b: Uint8Array, box: Box): string | null {
  let p = box.body + 6 // version and flags, then the language
  while (p < box.end && b[p] !== 0) p++ // the place's name
  p += 2 // its end, and the role
  if (p + 8 > box.end) return null
  const fixed = (i: number) => (u32be(b, i) | 0) / 65536
  const lon = fixed(p)
  const lat = fixed(p + 4)
  return formatGps([Math.abs(lat)], lat < 0 ? 'S' : 'N', [Math.abs(lon)], lon < 0 ? 'W' : 'E')
}

/** The first string of a QuickTime user-data text box (©xyz, ©mak…): a 2-byte length, a language, the text. */
function qtText(b: Uint8Array, box: Box): string {
  if (box.body + 4 > box.end) return ''
  const n = u16be(b, box.body)
  const start = box.body + 4
  return fromUtf8(b.subarray(start, Math.min(box.end, start + n)))
}

/** A 3GPP text box (auth, titl, dscp…): version and flags, a language, then the text. */
function gppText(b: Uint8Array, box: Box): string {
  return fromUtf8(b.subarray(Math.min(box.end, box.body + 6), box.end))
}

/** What a metadata key (an Apple "mdta" key, or a user-data box's type) reveals. */
function keyLabel(key: string): string {
  const k = key.toLowerCase()
  if (k.includes('location') || k === '\xa9xyz' || k === 'loci') return LABEL.gps
  if (k.endsWith('.make') || k.endsWith('.model') || k === '\xa9mak' || k === '\xa9mod') return LABEL.camera
  if (k.includes('lens')) return LABEL.lens
  if (k.includes('creationdate') || k === '\xa9day' || k === 'yrrc') return LABEL.dates
  if (k.includes('software') || k.includes('android.version') || k === '\xa9swr' || k === '\xa9too' || k === '\xa9enc') return LABEL.software
  if (k.includes('author') || k === '\xa9aut' || k === '\xa9art' || k === 'auth' || k === 'perf') return LABEL.author
  if (k.includes('title') || k === '\xa9nam' || k === 'titl') return LABEL.title
  if (k.includes('description') || k.includes('comment') || k === '\xa9des' || k === '\xa9cmt' || k === '\xa9inf' || k === 'dscp') return LABEL.description
  if (k.includes('keywords') || k === 'kywd') return LABEL.keywords
  if (k.includes('copyright') || k === '\xa9cpy' || k === 'cprt') return LABEL.copyright
  if (k.includes('identifier') || k.includes('signature')) return LABEL.ids
  if (k.includes('camera.') || k.includes('capture.')) return LABEL.settings
  return LABEL.other
}

/** The labels and values of whatever a metadata key held. */
function noteKey(key: string, value: string, labels: Set<string>, values: Found[], camera: { make: string; model: string }) {
  const label = keyLabel(key)
  labels.add(label)
  const k = key.toLowerCase()
  // A place's name (location.name) shows as written; coordinates as degrees; an accuracy not at all.
  if (label === LABEL.gps) addFound(values, label, k.includes('accuracy') ? null : k.includes('name') ? value : iso6709(value))
  else if (label === LABEL.camera) {
    if (k.endsWith('make') || k === '\xa9mak') camera.make = value
    else camera.model = value
  } else if (label === LABEL.dates) addFound(values, label, formatExifDate(value))
  else if (label !== LABEL.ids && label !== LABEL.other) addFound(values, label, value)
}

/** A 'data' box's value, when it's text: Apple's and iTunes' metadata lists hold their values in these. */
function dataText(b: Uint8Array, item: Box): string | null {
  for (const d of children(b, item.body, item.end)) {
    if (d.type !== 'data' || d.body + 8 > d.end) continue
    const kind = u32be(b, d.body) & 0xffffff
    if (kind === 1) return fromUtf8(b.subarray(d.body + 8, d.end)) // UTF-8 text
  }
  return null
}

/** The boxes inside a 'meta' box: an ISO full box (four bytes of version and flags first) or QuickTime's plain one. */
function metaKids(b: Uint8Array, meta: Box): Box[] {
  if (meta.body + 12 <= meta.end && u32be(b, meta.body) === 0 && readBox(b, meta.body + 4, meta.end)) return children(b, meta.body + 4, meta.end)
  return children(b, meta.body, meta.end)
}

/** Reads what a metadata box (Apple's keys, or an iTunes-style list) held, leniently. */
function readMeta(b: Uint8Array, meta: Box, labels: Set<string>, values: Found[], camera: { make: string; model: string }) {
  const kids = metaKids(b, meta)
  const keysBox = kids.find((x) => x.type === 'keys')
  const ilst = kids.find((x) => x.type === 'ilst')
  if (!ilst) return
  const keys: string[] = []
  if (keysBox) {
    const count = u32be(b, keysBox.body + 4)
    let p = keysBox.body + 8
    for (let i = 0; i < count && p + 8 <= keysBox.end; i++) {
      const size = u32be(b, p)
      if (size < 8 || p + size > keysBox.end) break
      keys.push(latin1(b, p + 8, p + size))
      p += size
    }
  }
  for (const item of children(b, ilst.body, ilst.end, true)) {
    // Apple's list names each item by its 1-based place in the keys; iTunes' by a four-letter code.
    const index = u32be(b, item.start + 4)
    const key = keysBox ? (keys[index - 1] ?? '') : item.type
    noteKey(key, dataText(b, item) ?? '', labels, values, camera)
  }
}

/** Reads what a user-data box held, leniently: QuickTime's ©-boxes, 3GPP's, and an iTunes list inside. */
function readUdta(b: Uint8Array, udta: Box, labels: Set<string>, values: Found[], camera: { make: string; model: string }) {
  for (const box of children(b, udta.body, udta.end)) {
    if (box.type === 'meta') readMeta(b, box, labels, values, camera)
    else if (box.type === 'loci') {
      labels.add(LABEL.gps)
      addFound(values, LABEL.gps, loci(b, box))
    } else if (box.type.startsWith('\xa9')) noteKey(box.type, qtText(b, box), labels, values, camera)
    else if (['auth', 'titl', 'dscp', 'perf', 'cprt', 'kywd', 'yrrc'].includes(box.type)) noteKey(box.type, gppText(b, box), labels, values, camera)
    else if (!allZero(b.subarray(box.body, box.end))) labels.add(LABEL.other)
  }
}

/** The labels (and values) for a user-data or metadata box about to be blanked. */
function boxLabels(b: Uint8Array, box: Box, labels: Set<string>, values: Found[]) {
  const found = new Set<string>()
  const camera = { make: '', model: '' }
  try {
    if (box.type === 'udta') readUdta(b, box, found, values, camera)
    else readMeta(b, box, found, values, camera)
  } catch {
    // Unreadable inside: it goes all the same.
  }
  addFound(values, LABEL.camera, cameraName(camera.make, camera.model))
  if (!found.size) found.add(LABEL.other)
  found.forEach((l) => labels.add(l))
}

function uuidLabels(b: Uint8Array, box: Box, values: Found[]): string[] {
  const id = hex(b.subarray(box.body, box.body + 16))
  if (id === UUID_C2PA) return [LABEL.c2pa]
  if (id === UUID_XMP) {
    const text = fromUtf8(b.subarray(box.body + 16, box.end))
    addAll(values, xmpValues(text))
    const found = xmpLabels(text)
    return found.length ? found : [LABEL.other]
  }
  return [LABEL.other]
}

// --- Where each track's samples lie ----------------------------------------------------

/** Each chunk of a track's samples, from its sample table, in file offsets (within a file of size bytes). */
function chunks(b: Uint8Array, stbl: Box, size = b.length): Extent[] {
  const kids = children(b, stbl.body, stbl.end)
  const stsz = kids.find((x) => x.type === 'stsz')
  const stz2 = kids.find((x) => x.type === 'stz2')
  const stsc = kids.find((x) => x.type === 'stsc')
  const stco = kids.find((x) => x.type === 'stco' || x.type === 'co64')
  if (!stco || !stsc || (!stsz && !stz2)) {
    // A track with no samples at all (no chunk offsets) has nothing in the file.
    if (!stco) return []
    fail('a track’s sample table is incomplete')
  }
  const wide = stco.type === 'co64'
  const chunkCount = u32be(b, stco.body + 4)
  if (stco.body + 8 + chunkCount * (wide ? 8 : 4) > stco.end) fail('the chunk offsets are cut short')
  const offset = (i: number) => (wide ? u64be(b, stco.body + 8 + i * 8) : u32be(b, stco.body + 8 + i * 4))

  // Sample sizes: one for all, or one each (stsz), or packed (stz2).
  let uniform = 0
  let sampleCount: number
  let sizeOf: (i: number) => number
  if (stsz) {
    uniform = u32be(b, stsz.body + 4)
    sampleCount = u32be(b, stsz.body + 8)
    if (!uniform && stsz.body + 12 + sampleCount * 4 > stsz.end) fail('the sample sizes are cut short')
    sizeOf = (i) => u32be(b, stsz.body + 12 + i * 4)
  } else {
    const field = u8(b, stz2!.body + 7)
    sampleCount = u32be(b, stz2!.body + 8)
    if (field !== 4 && field !== 8 && field !== 16) fail('an unknown sample size field')
    if (stz2!.body + 12 + Math.ceil((sampleCount * field) / 8) > stz2!.end) fail('the sample sizes are cut short')
    sizeOf = (i) => {
      const p = stz2!.body + 12
      if (field === 16) return u16be(b, p + i * 2)
      if (field === 8) return u8(b, p + i)
      const v = u8(b, p + (i >> 1))
      return i & 1 ? v & 15 : v >> 4
    }
  }
  if (sampleCount > MAX_SAMPLES) fail('more samples than a video holds')

  const runs = u32be(b, stsc.body + 4)
  if (stsc.body + 8 + runs * 12 > stsc.end) fail('the sample-to-chunk table is cut short')
  const out: Extent[] = []
  let sample = 0
  for (let r = 0; r < runs && sample < sampleCount; r++) {
    const first = u32be(b, stsc.body + 8 + r * 12)
    const perChunk = u32be(b, stsc.body + 12 + r * 12)
    const next = r + 1 < runs ? u32be(b, stsc.body + 8 + (r + 1) * 12) : chunkCount + 1
    if (first < 1 || next <= first) fail('the sample-to-chunk table is out of order')
    for (let c = first; c < next && c <= chunkCount && sample < sampleCount; c++) {
      const n = Math.min(perChunk, sampleCount - sample)
      let length = 0
      if (uniform) length = n * uniform
      else for (let k = 0; k < n; k++) length += sizeOf(sample + k)
      sample += n
      const start = offset(c - 1)
      if (start + length > size) fail('a track’s samples lie outside the file')
      if (length) out.push([start, start + length])
    }
  }
  return out
}

/** A track's handler ('vide', 'soun', 'meta'…) and its first sample format ('avc1', 'gpmd'…). */
function trackKind(b: Uint8Array, mdia: Box): { handler: string; format: string; stbl?: Box } {
  const hdlr = child(b, mdia, 'hdlr')
  const handler = hdlr && hdlr.body + 12 <= hdlr.end ? latin1(b, hdlr.body + 8, hdlr.body + 12) : ''
  const minf = child(b, mdia, 'minf')
  const stbl = minf && child(b, minf, 'stbl')
  const stsd = stbl && child(b, stbl, 'stsd')
  const format = stsd && stsd.body + 16 <= stsd.end ? latin1(b, stsd.body + 12, stsd.body + 16) : ''
  return { handler, format, stbl }
}

// --- The edits ---------------------------------------------------------------------------

interface Edit {
  apply(out: Uint8Array): void
}

/** Turns a box into a zeroed 'free' box of the same size, which every player skips. */
function toFree(box: Box): Edit {
  return {
    apply(out) {
      out.set(ascii('free'), box.start + 4)
      out.fill(0, box.body, box.end)
    },
  }
}

/**
 * A details-only look (heldIn): b is then the file's boxes laid end to end
 * without its pictures and sound, so a metadata track's samples, which lie
 * with them, are listed here for the caller to look at instead.
 */
interface Held {
  size: number
  data: { label: string; ranges: Extent[] }[]
}

function analyse(b: Uint8Array, held?: Held) {
  const { list, end } = topLevel(b)
  const labels = new Set<string>()
  const values: Found[] = []
  const edits: Edit[] = []
  const kept: Extent[] = [] // bytes the pictures and sound live in
  const zeroed: Extent[] = [] // bytes that will be blanked
  const fragmented = list.some((x) => x.type === 'moof')
  let dataTracks = 0

  /** Zeroes a full box's creation and modification times (version 1 has 64-bit ones). */
  const times = (box: Box) => {
    const size = u8(b, box.body) === 1 ? 8 : 4
    const from = box.body + 4
    const to = from + 2 * size
    if (to > box.end) fail('a header is cut short')
    if (allZero(b.subarray(from, to))) return
    labels.add(LABEL.dates)
    edits.push({ apply: (out) => out.fill(0, from, to) })
  }
  /** User data and metadata go whole: a zeroed 'free' box in their place. */
  const blank = (box: Box) => {
    if (allZero(b.subarray(box.body, box.end))) return
    if (box.type === 'uuid') uuidLabels(b, box, values).forEach((l) => labels.add(l))
    else boxLabels(b, box, labels, values)
    zeroed.push([box.start, box.end])
    edits.push(toFree(box))
  }
  /** Padding can hold whatever an editor left behind. */
  const pads: Box[] = []

  const track = (trak: Box) => {
    let mdia: Box | undefined
    for (const box of children(b, trak.body, trak.end)) {
      if (box.type === 'tkhd') times(box)
      else if (box.type === 'udta' || box.type === 'meta' || box.type === 'uuid') blank(box)
      else if (box.type === 'mdia') mdia = box
      else if ((box.type === 'free' || box.type === 'skip') && !allZero(b.subarray(box.body, box.end))) pads.push(box)
    }
    if (!mdia) return
    const mdhd = child(b, mdia, 'mdhd')
    if (mdhd) times(mdhd)
    const { handler, format, stbl } = trackKind(b, mdia)
    const data = DATA_HANDLERS.has(handler)
    if (held && !data) return // nothing is blanked, so where the pictures and sound lie doesn't matter
    const ranges = stbl ? chunks(b, stbl, held?.size) : []
    if (!data) {
      kept.push(...ranges)
      return
    }
    // A timed metadata track: its samples are zeroed where they lie.
    dataTracks++
    const label = handler === 'tmcd' ? LABEL.dates : SENSOR_FORMATS.has(format) || handler === 'camm' ? LABEL.sensors : LABEL.other
    if (held) {
      if (ranges.length) held.data.push({ label, ranges })
      return
    }
    const live = ranges.filter(([s, e]) => !allZero(b.subarray(s, e)))
    if (!live.length) return
    labels.add(label)
    for (const [s, e] of live) {
      zeroed.push([s, e])
      edits.push({ apply: (out) => out.fill(0, s, e) })
    }
  }

  for (const box of list) {
    if (box.type === 'moov') {
      for (const inner of children(b, box.body, box.end)) {
        if (inner.type === 'mvhd') times(inner)
        else if (inner.type === 'trak') track(inner)
        else if (inner.type === 'udta' || inner.type === 'meta' || inner.type === 'uuid') blank(inner)
        else if ((inner.type === 'free' || inner.type === 'skip') && !allZero(b.subarray(inner.body, inner.end))) pads.push(inner)
      }
    } else if (box.type === 'uuid' || box.type === 'udta' || box.type === 'meta') blank(box)
    else if ((box.type === 'free' || box.type === 'skip' || box.type === 'wide') && !allZero(b.subarray(box.body, box.end))) pads.push(box)
  }
  // A video in fragments describes its samples elsewhere (moof): a data track there can't be found to blank.
  if (fragmented && dataTracks) fail('a video in fragments with a metadata track Slynk can’t clean')

  let cut = end
  if (end < b.length) {
    if (!allZero(b.subarray(end))) labels.add(LABEL.trailing)
    zeroed.push([end, b.length])
  }
  // Padding is zeroed only where no picture or sound lies in it.
  for (const box of pads) {
    if (kept.some(([s, e]) => s < box.end && box.body < e)) continue
    labels.add(LABEL.other)
    edits.push({ apply: (out) => out.fill(0, box.body, box.end) })
  }
  // Never blank or cut a byte the pictures or sound live in.
  for (const [s, e] of kept) {
    for (const [zs, ze] of zeroed) if (s < ze && zs < e) fail('the video’s data overlaps details Slynk would remove')
    if (e > cut) fail('the video’s data lies after the cut')
  }
  return { labels, values, edits, cut }
}

export function strip(b: Uint8Array): FormatOutcome {
  const a = analyse(b)
  if (a.labels.size === 0) return { status: 'unchanged' }
  const out = b.slice(0, a.cut)
  for (const e of a.edits) e.apply(out)
  return { status: 'cleaned', bytes: out, removed: [...a.labels], values: a.values }
}

// --- What a video holds, without reading its pictures and sound ----------------------
// A video too big to go as it is only goes as a new, smaller one (src/video/), which holds
// none of the original's details. Its "Cleaned" list comes from here: the boxes beside the
// pictures and sound (the index, user data, XMP), usually a few kilobytes even for a long
// video, and a look at the start of any padding, trailer or metadata track.

/** Reads length bytes of the file from offset. */
export type ReadAt = (offset: number, length: number) => Promise<Uint8Array>

/** The most a look reads of padding, a trailer or a metadata track's samples: enough to see whether they hold anything. */
const LOOK = 1 << 20

/** Whether any of these byte ranges holds something other than zeros, reading at most LOOK bytes. */
async function anyData(read: ReadAt, ranges: Extent[]): Promise<boolean> {
  let budget = LOOK
  for (const [s, e] of ranges) {
    const n = Math.min(e - s, budget)
    if (n <= 0) break
    if (!allZero(await read(s, n))) return true
    budget -= n
  }
  return false
}

/** Top-level boxes that hold details or describe them, read whole; the rest are looked at or left alone, as strip() does. */
const READ_WHOLE = new Set(['ftyp', 'moov', 'udta', 'meta', 'uuid'])

/**
 * The labels and values strip() would give for a video of size bytes, read
 * through read without its pictures and sound. Throws, as strip() would, for
 * a file it can't make sense of.
 */
export async function heldIn(read: ReadAt, size: number): Promise<{ labels: string[]; values: Found[] }> {
  const labels = new Set<string>()
  const parts: Uint8Array[] = []
  let pos = 0
  for (;;) {
    if (pos + 8 > size) break
    let head = await read(pos, 8)
    // A 64-bit size follows the type when the 32-bit one is 1.
    if (u32be(head, 0) === 1 && pos + 16 <= size) head = await read(pos, 16)
    const box = readBox(head, 0, size - pos)
    if (!box) break
    const length = box.end - box.start
    if (READ_WHOLE.has(box.type)) parts.push(await read(pos, length))
    else if ((box.type === 'free' || box.type === 'skip' || box.type === 'wide') && (await anyData(read, [[pos + box.body, pos + length]]))) labels.add(LABEL.other)
    pos += length
  }
  if (pos < size && (await anyData(read, [[pos, size]]))) labels.add(LABEL.trailing)
  const held: Held = { size, data: [] }
  const a = analyse(concat(parts), held)
  a.labels.forEach((l) => labels.add(l))
  for (const t of held.data) if (await anyData(read, t.ranges)) labels.add(t.label)
  return { labels: [...labels], values: a.values }
}

export function verify(b: Uint8Array): void {
  const { list, end } = topLevel(b)
  if (end !== b.length) fail('data after the last box')
  if (list.some((x) => x.type === 'uuid' || x.type === 'udta')) fail('a removable box is still there')
  const a = analyse(b)
  if (a.labels.size) fail(`still holds: ${[...a.labels].join(', ')}`)
}
