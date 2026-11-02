// Audio tags. MP3: slice off ID3v2 tags at the start and APE, Lyrics3, ID3v1
// and ID3v2-footer tags at the end; the audio frames, including the first
// Xing/LAME frame that players need for the duration, are untouched. FLAC:
// keep STREAMINFO and SEEKTABLE and drop the other metadata blocks (tags,
// pictures, cue sheets, application data, padding).
import { concat, fromUtf8, indexOf, latin1, startsWith, u24be, u32be, u32le, u8 } from './bytes.ts'
import { LABEL } from './labels.ts'
import { id3Length, mpegStartsAt } from './sniff.ts'
import { type FormatOutcome, type Found, type Kind, fail } from './types.ts'
import { addAll, addFound } from './values.ts'

// Frame IDs (ID3v2.3/2.4, then the 3-letter ID3v2.2 ones), most specific first.
const ID3_LABELS: [RegExp, string][] = [
  [/^(APIC|PIC)$/, LABEL.coverArt],
  [/^(COMM|COM)$/, LABEL.comments],
  [/^(USLT|SYLT|ULT|SLT)$/, LABEL.lyrics],
  [/^(TDRC|TDRL|TDEN|TDOR|TDTG|TYER|TDAT|TIME|TORY|TRDA|TYE|TDA|TIM|TOR|TRD)$/, LABEL.dates],
  [/^(TSSE|TENC|TSS|TEN)$/, LABEL.encoder],
  [/^(TCOP|TPUB|TOWN|TCR|TPB)$/, LABEL.copyright],
  [/^(MCDI|TSRC|MCI|TRC)$/, LABEL.catalog],
  [/^(TXXX|TXX)$/, LABEL.otherAudio],
  [/^T[A-Z0-9]{2,3}$/, LABEL.songInfo],
  [/^W[A-Z0-9]{2,3}$/, LABEL.links],
]

// Text frames whose values are shown: the song's title, artist and album (in
// that order), and the encoding software or who encoded it.
const ID3_SHOWN: [RegExp, string, number][] = [
  [/^(TIT2|TT2)$/, LABEL.songInfo, 0],
  [/^(TPE1|TP1)$/, LABEL.songInfo, 1],
  [/^(TALB|TAL)$/, LABEL.songInfo, 2],
  [/^(TSSE|TSS)$/, LABEL.encoder, 3],
  [/^(TENC|TEN)$/, LABEL.encoder, 4],
]

// No shown value needs more than this; longer ones are cut short anyway.
const TEXT_CAP = 1024

/** An ID3v2 text frame's values (ID3v2.4 separates several with NULs). */
function id3Text(d: Uint8Array): string[] {
  if (d.length < 2) return []
  const enc = d[0]
  let body = d.subarray(1, 1 + TEXT_CAP)
  let text: string
  if (enc === 0) text = latin1(body)
  else if (enc === 3) text = fromUtf8(body)
  else if (enc === 1 || enc === 2) {
    // UTF-16, big-endian unless a byte order mark says otherwise.
    let le = false
    if (body[0] === 0xff && body[1] === 0xfe) [le, body] = [true, body.subarray(2)]
    else if (body[0] === 0xfe && body[1] === 0xff) body = body.subarray(2)
    else le = enc === 1
    text = new TextDecoder(le ? 'utf-16le' : 'utf-16be').decode(body)
  } else return []
  return text.split('\0')
}

function syncsafe(b: Uint8Array, i: number): number {
  const s = b.subarray(i, i + 4)
  if (s.length < 4 || s.some((v) => v & 0x80)) fail('bad ID3 size')
  return (s[0] << 21) | (s[1] << 14) | (s[2] << 7) | s[3]
}

/** What an ID3v2 tag holds, read from its frame IDs; shown text goes into values. Never throws. */
function id3Labels(b: Uint8Array, start: number, end: number, values: Found[]): string[] {
  const labels = new Set<string>()
  const shown: [number, Found[]][] = []
  try {
    const version = u8(b, start + 3)
    const flags = u8(b, start + 5)
    // Unsynchronised tags hide extra bytes in the text, and an ID3v2.2 tag can
    // be compressed as a whole (flag 0x40); their values aren't shown.
    const plain = !(flags & 0x80) && !(version === 2 && flags & 0x40)
    let p = start + 10
    if (flags & 0x40) p += version === 4 ? syncsafe(b, p) : 4 + u32be(b, p)
    while (p + 6 <= end) {
      if (b[p] === 0) break // padding
      let id: string
      let size: number
      let format = 0 // compressed, encrypted, grouped or otherwise transformed frames
      if (version === 2) {
        id = latin1(b, p, p + 3)
        size = u24be(b, p + 3)
        p += 6
      } else {
        id = latin1(b, p, p + 4)
        size = version === 4 ? syncsafe(b, p + 4) : u32be(b, p + 4)
        format = u8(b, p + 9)
        p += 10
      }
      if (!/^[A-Z0-9]{3,4}$/.test(id) || p + size > end) break
      const rule = ID3_LABELS.find(([re]) => re.test(id))
      const show = plain && !format ? ID3_SHOWN.find(([re]) => re.test(id)) : undefined
      if (show) {
        const list: Found[] = []
        for (const v of id3Text(b.subarray(p, p + size))) addFound(list, show[1], v)
        shown.push([show[2], list])
      }
      if (rule) labels.add(rule[1])
      else if ((id === 'GEOB' || id === 'GEO') && indexOf(b, 'c2pa', p, p + size) !== -1) labels.add(LABEL.c2pa)
      else labels.add(LABEL.otherAudio)
      p += size
    }
  } catch {
    // Unreadable frames are removed with the rest of the tag.
  }
  if (labels.size === 0) labels.add(LABEL.otherAudio)
  for (const [, list] of shown.sort((x, y) => x[0] - y[0])) addAll(values, list)
  return [...labels]
}

/** ID3v1's title, artist and album: fixed 30-byte fields after "TAG". */
function id3v1(b: Uint8Array, at: number, values: Found[]) {
  for (const field of [3, 33, 63]) addFound(values, LABEL.songInfo, latin1(b, at + field, at + field + 30))
}

/** Strips tags from the end of [start, end); returns the new end. */
function trailingTags(b: Uint8Array, start: number, end: number, labels: Set<string>, values: Found[]): number {
  for (;;) {
    if (end - start >= 128 && startsWith(b, 'TAG', end - 128)) {
      labels.add(LABEL.songInfo)
      id3v1(b, end - 128, values)
      end -= 128
      if (end - start >= 227 && startsWith(b, 'TAG+', end - 227)) end -= 227
      continue
    }
    if (end - start >= 32 && startsWith(b, 'APETAGEX', end - 32)) {
      const size = u32le(b, end - 20)
      const flags = u32le(b, end - 12)
      const tagStart = end - size - (flags & 0x80000000 ? 32 : 0)
      if (size < 32 || tagStart < start) fail('bad APE tag')
      const text = latin1(b, tagStart, end).toLowerCase()
      labels.add(text.includes('cover art') ? LABEL.coverArt : LABEL.songInfo)
      end = tagStart
      continue
    }
    if (end - start >= 15 && startsWith(b, 'LYRICS200', end - 9)) {
      const size = Number(latin1(b, end - 15, end - 9))
      const tagStart = end - 15 - size
      if (!Number.isInteger(size) || tagStart < start || !startsWith(b, 'LYRICSBEGIN', tagStart)) fail('bad Lyrics3 tag')
      labels.add(LABEL.lyrics)
      end = tagStart
      continue
    }
    if (end - start >= 20 && startsWith(b, 'LYRICSEND', end - 9)) {
      const from = Math.max(start, end - 5100 - 20)
      const tagStart = indexOf(b, 'LYRICSBEGIN', from, end)
      if (tagStart === -1) fail('bad Lyrics3 tag')
      labels.add(LABEL.lyrics)
      end = tagStart
      continue
    }
    if (end - start >= 20 && startsWith(b, '3DI', end - 10)) {
      const tagStart = end - 20 - syncsafe(b, end - 4)
      if (tagStart < start || !startsWith(b, 'ID3', tagStart)) fail('bad ID3 footer')
      id3Labels(b, tagStart, end, values).forEach((l) => labels.add(l))
      end = tagStart
      continue
    }
    return end
  }
}

function leadingTags(b: Uint8Array, labels: Set<string>, values: Found[]): number {
  let pos = 0
  while (startsWith(b, 'ID3', pos)) {
    const size = syncsafe(b, pos + 6)
    const end = pos + 10 + size + (u8(b, pos + 5) & 0x10 ? 10 : 0)
    if (end > b.length) fail('the ID3 tag runs past the end of the file')
    id3Labels(b, pos, end, values).forEach((l) => labels.add(l))
    pos = end
  }
  if (pos !== id3Length(b)) fail('bad ID3 tag')
  return pos
}

function mp3(b: Uint8Array) {
  const labels = new Set<string>()
  const values: Found[] = []
  const start = leadingTags(b, labels, values)
  let first = start
  while (first < b.length && b[first] === 0 && first < start + 65536) first++
  if (!mpegStartsAt(b, first)) fail('no MPEG audio after the tags')
  const end = trailingTags(b, first, b.length, labels, values)
  return { labels, values, start, end }
}

// --- FLAC -------------------------------------------------------------------

const STREAMINFO = 0
const PADDING = 1
const APPLICATION = 2
const SEEKTABLE = 3
const VORBIS_COMMENT = 4
const CUESHEET = 5
const PICTURE = 6

// Vorbis comments whose values are shown, in this order.
const VORBIS_SHOWN = ['TITLE', 'ARTIST', 'ALBUM', 'ENCODER', 'ENCODED_BY', 'ENCODED-BY']

function vorbisLabels(d: Uint8Array, values: Found[]): string[] {
  const labels = new Set<string>()
  const shown: [number, string][] = []
  let vendorText = ''
  try {
    const vendor = u32le(d, 0)
    if (vendor) {
      labels.add(LABEL.encoder)
      vendorText = fromUtf8(d.subarray(4, 4 + Math.min(vendor, TEXT_CAP)))
    }
    let p = 4 + vendor
    const n = u32le(d, p)
    p += 4
    for (let i = 0; i < n; i++) {
      const len = u32le(d, p)
      const entry = fromUtf8(d.subarray(p + 4, p + 4 + Math.min(len, TEXT_CAP)))
      p += 4 + len
      if (p > d.length) break
      const eq = entry.indexOf('=')
      const key = (eq === -1 ? entry : entry.slice(0, eq)).toUpperCase()
      const rank = VORBIS_SHOWN.indexOf(key)
      if (rank !== -1 && eq !== -1) shown.push([rank, entry.slice(eq + 1)])
      if (/^(TITLE|ARTIST|ALBUM|ALBUMARTIST|ALBUM ARTIST|TRACKNUMBER|TRACKTOTAL|DISCNUMBER|DISCTOTAL|GENRE|COMPOSER|PERFORMER|CONDUCTOR|VERSION)$/.test(key)) labels.add(LABEL.songInfo)
      else if (/^(DATE|YEAR|ORIGINALDATE)$/.test(key)) labels.add(LABEL.dates)
      else if (/^(COMMENT|DESCRIPTION)$/.test(key)) labels.add(LABEL.comments)
      else if (/LYRICS/.test(key)) labels.add(LABEL.lyrics)
      else if (/^(METADATA_BLOCK_PICTURE|COVERART)$/.test(key)) labels.add(LABEL.coverArt)
      else if (/^(COPYRIGHT|LICENSE|ORGANIZATION|LABEL)$/.test(key)) labels.add(LABEL.copyright)
      else if (/^(ENCODER|ENCODED[_ ]?BY|ENCODING)$/.test(key)) labels.add(LABEL.encoder)
      else if (/^(ISRC|CATALOGNUMBER|BARCODE|UPC|EAN)$/.test(key)) labels.add(LABEL.catalog)
      else labels.add(LABEL.otherAudio)
    }
  } catch {
    labels.add(LABEL.otherAudio)
  }
  for (const [rank, v] of shown.sort((x, y) => x[0] - y[0])) addFound(values, rank < 3 ? LABEL.songInfo : LABEL.encoder, v)
  addFound(values, LABEL.encoder, vendorText)
  return [...labels]
}

interface FlacBlock {
  type: number
  start: number
  end: number
}

function flac(b: Uint8Array) {
  const labels = new Set<string>()
  const values: Found[] = []
  const start = leadingTags(b, labels, values)
  if (!startsWith(b, 'fLaC', start)) fail('not a FLAC file')
  const blocks: FlacBlock[] = []
  let p = start + 4
  for (;;) {
    const header = u8(b, p)
    const type = header & 0x7f
    const end = p + 4 + u24be(b, p + 1)
    if (type === 127 || end > b.length) fail('bad FLAC metadata block')
    if (blocks.length === 0 && (type !== STREAMINFO || end - p !== 38)) fail('FLAC must start with STREAMINFO')
    blocks.push({ type, start: p, end })
    p = end
    if (header & 0x80) break
  }
  // Audio frames start with a 14-bit sync code.
  if (!(u8(b, p) === 0xff && (u8(b, p + 1) & 0xfe) === 0xf8)) fail('no FLAC audio after the metadata')
  for (const blk of blocks) {
    const d = b.subarray(blk.start + 4, blk.end)
    switch (blk.type) {
      case STREAMINFO:
      case SEEKTABLE:
        break
      case PADDING:
        if (d.some((v) => v !== 0)) labels.add(LABEL.other)
        break
      case VORBIS_COMMENT:
        vorbisLabels(d, values).forEach((l) => labels.add(l))
        break
      case PICTURE:
        labels.add(LABEL.coverArt)
        break
      case CUESHEET:
        labels.add(LABEL.catalog)
        break
      case APPLICATION:
      default:
        labels.add(LABEL.otherAudio)
    }
  }
  const end = trailingTags(b, p, b.length, labels, values)
  return { labels, values, blocks, audio: p, end }
}

function flacOut(b: Uint8Array, f: ReturnType<typeof flac>): Uint8Array {
  const kept = f.blocks.filter((x) => x.type === STREAMINFO || x.type === SEEKTABLE).map((x) => b.slice(x.start, x.end))
  for (const [i, blk] of kept.entries()) blk[0] = (blk[0] & 0x7f) | (i === kept.length - 1 ? 0x80 : 0)
  return concat([new TextEncoder().encode('fLaC'), ...kept, b.subarray(f.audio, f.end)])
}

export function strip(b: Uint8Array, kind: Kind): FormatOutcome {
  if (kind === 'mp3') {
    const m = mp3(b)
    if (m.labels.size === 0) return { status: 'unchanged' }
    return { status: 'cleaned', bytes: b.slice(m.start, m.end), removed: [...m.labels], values: m.values }
  }
  const f = flac(b)
  if (f.labels.size === 0) return { status: 'unchanged' }
  return { status: 'cleaned', bytes: flacOut(b, f), removed: [...f.labels], values: f.values }
}

export function verify(b: Uint8Array, kind: Kind): void {
  if (kind === 'mp3') {
    const m = mp3(b)
    if (m.labels.size || m.start !== 0 || m.end !== b.length) fail('tags are still there')
    return
  }
  const f = flac(b)
  if (f.labels.size || f.end !== b.length) fail('tags are still there')
  if (f.blocks.some((x) => x.type !== STREAMINFO && x.type !== SEEKTABLE)) fail('extra FLAC blocks are still there')
}
