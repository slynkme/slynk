// HEIC and AVIF (ISO base media "boxes"). Pictures are located by absolute
// byte offsets (the iloc box), so nothing may move: metadata is overwritten
// in place at the same length instead of being cut out.
//   - the Exif item becomes an empty TIFF block (rotation lives in the irot
//     and imir properties, so EXIF Orientation isn't needed)
//   - an XMP item becomes an empty XMP packet padded with spaces, unless it
//     only holds HDR gain-map parameters
//   - Content Credentials and other top-level uuid boxes become zeroed 'free'
//     boxes, a box type every reader skips
//   - so does Samsung's 'sefd' box (SEF): the moment the photo was taken, to
//     the millisecond, its camera mode, and after an edit in Samsung's Gallery
//     what it keeps to undo it
//   - a motion-photo video ('mpvd' box) and anything after the last box is cut
import { allZero, ascii, fromUtf8, indexOf, latin1, u16be, u32be, u32le, u64be, u8, uintbe } from './bytes.ts'
import { emptyTiff, readExif } from './exif.ts'
import { LABEL } from './labels.ts'
import { type FormatOutcome, type Found, fail } from './types.ts'
import { addAll } from './values.ts'
import { xmpLabels, xmpValues } from './xmp.ts'

const UUID_C2PA = 'd8fec3d61b0e483c92975828877ec481'
const UUID_XMP = 'be7acfcb97a942e89c71999491e3afac'
const EMPTY_XMP = '<x:xmpmeta xmlns:x="adobe:ns:meta/"/>'

export interface Box {
  type: string
  start: number
  body: number
  end: number
}

export function readBox(b: Uint8Array, pos: number, end: number): Box | null {
  if (pos + 8 > end) return null
  let size = u32be(b, pos)
  const type = latin1(b, pos + 4, pos + 8)
  if (!/^[\x20-\x7e\xa9]{4}$/.test(type)) return null
  let header = 8
  if (size === 1) {
    if (pos + 16 > end) return null
    size = u64be(b, pos + 8)
    header = 16
  } else if (size === 0) size = end - pos
  if (size < header || pos + size > end) return null
  return { type, start: pos, body: pos + header, end: pos + size }
}

export function children(b: Uint8Array, start: number, end: number): Box[] {
  const out: Box[] = []
  for (let pos = start; pos < end; ) {
    const box = readBox(b, pos, end)
    if (!box) fail('bad box inside the image')
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
  return { list, end: pos }
}

function cstring(b: Uint8Array, i: number, end: number): [string, number] {
  let j = i
  while (j < end && b[j] !== 0) j++
  return [fromUtf8(b.subarray(i, j)), Math.min(end, j + 1)]
}

export interface Item {
  id: number
  type: string
  contentType: string
}

export function readItems(b: Uint8Array, iinf: Box): Item[] {
  const v = u8(b, iinf.body)
  const first = iinf.body + 4 + (v === 0 ? 2 : 4)
  const items: Item[] = []
  for (const infe of children(b, first, iinf.end)) {
    if (infe.type !== 'infe') continue
    const ver = u8(b, infe.body)
    let p = infe.body + 4
    if (ver >= 2) {
      const id = ver === 2 ? u16be(b, p) : u32be(b, p)
      p += (ver === 2 ? 2 : 4) + 2
      const type = latin1(b, p, p + 4)
      p += 4
      let contentType = ''
      ;[, p] = cstring(b, p, infe.end)
      if (type === 'mime') [contentType] = cstring(b, p, infe.end)
      items.push({ id, type, contentType })
    } else {
      const id = u16be(b, p)
      p += 4
      ;[, p] = cstring(b, p, infe.end)
      const [contentType] = cstring(b, p, infe.end)
      items.push({ id, type: 'mime', contentType })
    }
  }
  return items
}

export type Extent = [number, number] // absolute start, end

/** The most extents an iloc box may list in all: real files have one an item, and a few thousand items at most. */
const MAX_EXTENTS = 65_536

export function readLocations(b: Uint8Array, iloc: Box, idat: Box | undefined): Map<number, Extent[] | string> {
  const ver = u8(b, iloc.body)
  if (ver > 2) fail('unknown iloc version')
  let p = iloc.body + 4
  const offsetSize = u8(b, p) >> 4
  const lengthSize = u8(b, p) & 15
  const baseSize = u8(b, p + 1) >> 4
  const indexSize = ver >= 1 ? u8(b, p + 1) & 15 : 0
  p += 2
  const count = ver < 2 ? u16be(b, p) : u32be(b, p)
  p += ver < 2 ? 2 : 4
  const out = new Map<number, Extent[] | string>()
  let extentsSeen = 0
  for (let i = 0; i < count; i++) {
    const id = ver < 2 ? u16be(b, p) : u32be(b, p)
    p += ver < 2 ? 2 : 4
    let method = 0
    if (ver >= 1) {
      method = u16be(b, p) & 15
      p += 2
    }
    const dataRef = u16be(b, p)
    p += 2
    const base = uintbe(b, p, baseSize)
    p += baseSize
    const n = u16be(b, p)
    p += 2
    // Extents whose fields are all 0 bytes long cost nothing to list, so a tiny box could list billions.
    if (n > 1 && indexSize + offsetSize + lengthSize === 0) fail('an item listed in pieces of no size')
    if ((extentsSeen += n) > MAX_EXTENTS) fail('too many pieces in the iloc box')
    const extents: Extent[] = []
    for (let k = 0; k < n; k++) {
      p += indexSize
      const off = uintbe(b, p, offsetSize)
      p += offsetSize
      const len = uintbe(b, p, lengthSize)
      p += lengthSize
      if (method === 0) extents.push([base + off, len ? base + off + len : b.length])
      else if (method === 1 && idat) {
        const extent: Extent = [idat.body + base + off, len ? idat.body + base + off + len : idat.end]
        if (extent[1] > idat.end) fail('an item points outside its idat box')
        extents.push(extent)
      }
    }
    if (p > iloc.end) fail('the iloc box is cut short')
    // Items built from other items, or stored in another file, are left alone.
    out.set(id, dataRef !== 0 || method > 1 || (method === 1 && !idat) ? 'elsewhere' : extents)
  }
  return out
}

export function gather(b: Uint8Array, extents: Extent[]): Uint8Array {
  let n = 0
  for (const [s, e] of extents) {
    if (s < 0 || e > b.length || e < s) fail('an item points outside the file')
    n += e - s
  }
  // Bigger than the file only if its pieces repeat or overlap, as no real file's do.
  if (n > b.length) fail('an item bigger than the file')
  const out = new Uint8Array(n)
  let i = 0
  for (const [s, e] of extents) {
    out.set(b.subarray(s, e), i)
    i += e - s
  }
  return out
}

/** Writes data back over the extents; whatever lies past a cut output is gone anyway. */
function scatter(b: Uint8Array, extents: Extent[], data: Uint8Array) {
  let i = 0
  for (const [s, e] of extents) {
    if (s < b.length) b.set(data.subarray(i, i + Math.min(e, b.length) - s), s)
    i += e - s
  }
}

function hex(b: Uint8Array): string {
  return [...b].map((v) => v.toString(16).padStart(2, '0')).join('')
}

interface Edit {
  /** Apply to the output copy. */
  apply(out: Uint8Array): void
}

/** Turns a box into a zeroed 'free' box of the same size, which every reader skips. */
function toFree(box: Box): Edit {
  return {
    apply(out) {
      out.set(ascii('free'), box.start + 4)
      out.fill(0, box.body, box.end)
    },
  }
}

// Samsung's SEF entries, by name, and what each reveals. An edit saved in Samsung's Gallery adds the last two:
// where on the phone it keeps the original, and the crop and adjustments, to undo them.
const SEF_NAMES: Record<string, string> = {
  Image_UTC_Data: LABEL.dateTaken,
  Camera_Capture_Mode_Info: LABEL.settings,
  PhotoEditor_Re_Edit_Data: LABEL.history,
  Original_Path_Hash_Key: LABEL.history,
}

/** What a Samsung 'sefd' box holds, by the names of its entries (any other is "other photo details"); nothing if it's blank. */
function sefLabels(b: Uint8Array, box: Box): string[] {
  const body = b.subarray(box.body, box.end)
  if (allZero(body)) return []
  // Unreadable: the entries it seems to hold, and something else too.
  const found = sefNames(body)?.map((name) => SEF_NAMES[name] ?? LABEL.otherPhoto) ?? [
    ...Object.keys(SEF_NAMES).filter((name) => indexOf(body, name) !== -1).map((name) => SEF_NAMES[name]),
    LABEL.otherPhoto,
  ]
  return [...new Set(found.length ? found : [LABEL.otherPhoto])]
}

/**
 * The names of a SEF block's entries, from its directory at the end: 'SEFH', a version, a count, then for each
 * entry where it starts (counted back from 'SEFH') and its length; then the directory's size and 'SEFT'. Each entry
 * starts with its type, the length of its name and the name. Undefined if it isn't laid out so.
 */
function sefNames(body: Uint8Array): string[] | undefined {
  const n = body.length
  if (n < 32 || latin1(body, n - 4, n) !== 'SEFT') return undefined
  const size = u32le(body, n - 8)
  const dir = n - 8 - size
  if (size < 12 || dir < 0 || latin1(body, dir, dir + 4) !== 'SEFH') return undefined
  const count = u32le(body, dir + 8)
  if (dir + 12 + 12 * count > n - 8) return undefined
  const names: string[] = []
  for (let i = 0; i < count; i++) {
    const e = dir + 12 + 12 * i
    const at = dir - u32le(body, e + 4)
    const length = u32le(body, e + 8)
    if (at < 0 || length < 8 || at + length > dir) return undefined
    const nameLength = u32le(body, at + 4)
    if (8 + nameLength > length) return undefined
    names.push(latin1(body, at + 8, at + 8 + nameLength))
  }
  return names
}

function uuidLabels(b: Uint8Array, box: Box, values: Found[]): string[] {
  const id = hex(b.subarray(box.body, box.body + 16))
  if (id === UUID_C2PA) return [LABEL.c2pa]
  if (id === UUID_XMP) {
    const text = fromUtf8(b.subarray(box.body + 16, box.end))
    addAll(values, xmpValues(text))
    return xmpLabels(text)
  }
  return [LABEL.other]
}

// QuickTime-style keys in user data and metadata boxes, and what they reveal.
const MOVIE_KEYS: [string, string][] = [
  ['\xa9xyz', LABEL.gps],
  ['loci', LABEL.gps],
  ['location', LABEL.gps],
  ['\xa9mak', LABEL.camera],
  ['\xa9mod', LABEL.camera],
  ['.make', LABEL.camera],
  ['.model', LABEL.camera],
  ['\xa9day', LABEL.dates],
  ['creationdate', LABEL.dates],
  ['\xa9too', LABEL.software],
  ['\xa9swr', LABEL.software],
  ['.software', LABEL.software],
]

/**
 * Image sequences (and HEIF files with a track) keep QuickTime-style metadata
 * in 'moov': user data and metadata boxes, which become zeroed 'free' boxes,
 * and creation and modification times in the movie, track and media headers,
 * which are zeroed. Nothing moves, so sample offsets stay valid.
 */
function movie(b: Uint8Array, moov: Box, labels: Set<string>, values: Found[], edits: Edit[], zeroed: Extent[]) {
  const times = (box: Box) => {
    // FullBox: version 1 has 64-bit times, version 0 32-bit ones.
    const size = u8(b, box.body) === 1 ? 8 : 4
    const from = box.body + 4
    const to = from + 2 * size
    if (to > box.end) fail('a media header is cut short')
    if (allZero(b.subarray(from, to))) return
    labels.add(LABEL.dates)
    edits.push({ apply: (out) => out.fill(0, from, to) })
  }
  const blank = (box: Box) => {
    if (allZero(b.subarray(box.body, box.end))) return
    if (box.type === 'uuid') uuidLabels(b, box, values).forEach((l) => labels.add(l))
    else {
      const text = latin1(b, box.body, box.end)
      const found = MOVIE_KEYS.filter(([key]) => text.includes(key)).map(([, label]) => label)
      ;(found.length ? found : [LABEL.other]).forEach((l) => labels.add(l))
    }
    zeroed.push([box.start, box.end])
    edits.push(toFree(box))
  }
  const walk = (parent: Box) => {
    for (const box of children(b, parent.body, parent.end)) {
      if (box.type === 'mvhd' || box.type === 'tkhd' || box.type === 'mdhd') times(box)
      else if (box.type === 'udta' || box.type === 'meta' || box.type === 'uuid') blank(box)
      else if (box.type === 'trak' || box.type === 'mdia') walk(box)
    }
  }
  walk(moov)
}

function analyse(b: Uint8Array) {
  const { list, end } = topLevel(b)
  const labels = new Set<string>()
  const values: Found[] = []
  const edits: Edit[] = []
  const protectedRanges: Extent[] = [] // bytes that pictures live in
  const zeroed: Extent[] = []
  let cut = end

  const meta = list.find((x) => x.type === 'meta')
  if (meta) {
    const kids = children(b, meta.body + 4, meta.end)
    const iinf = kids.find((x) => x.type === 'iinf')
    const iloc = kids.find((x) => x.type === 'iloc')
    const idat = kids.find((x) => x.type === 'idat')
    const locations = iloc ? readLocations(b, iloc, idat) : new Map<number, Extent[] | string>()
    const items = iinf ? readItems(b, iinf) : []
    const metaIds = new Set<number>()
    for (const item of items) {
      const ext = locations.get(item.id)
      const isExif = item.type === 'Exif'
      const ct = item.contentType.toLowerCase()
      const isXmp = item.type === 'mime' && ct.includes('rdf+xml')
      const isC2pa = item.type === 'mime' && ct.includes('c2pa')
      if (!isExif && !isXmp && !isC2pa) continue
      metaIds.add(item.id)
      if (ext === undefined) continue
      if (typeof ext === 'string') fail('metadata stored in a way Slynk cannot rewrite')
      zeroed.push(...ext)
      const data = gather(b, ext)
      if (isExif) {
        if (data.length < 4) continue
        const at = u32be(data, 0)
        const info = readExif(data.subarray(Math.min(data.length, 4 + at)))
        if (!info.labels.length) continue
        info.labels.forEach((l) => labels.add(l))
        addAll(values, info.values)
        edits.push({
          apply(out) {
            const blank = new Uint8Array(data.length)
            // exif_tiff_header_offset 0, then a TIFF header with no entries.
            if (blank.length >= 18) blank.set(emptyTiff(), 4)
            scatter(out, ext, blank)
          },
        })
      } else if (isXmp) {
        const text = fromUtf8(data).replace(/\0+$/, '')
        const found = xmpLabels(text)
        if (!found.length || allZero(data)) continue
        found.forEach((l) => labels.add(l))
        addAll(values, xmpValues(text))
        edits.push({
          apply(out) {
            const blank = new Uint8Array(data.length)
            if (blank.length >= EMPTY_XMP.length) {
              blank.fill(0x20)
              blank.set(ascii(EMPTY_XMP))
            }
            scatter(out, ext, blank)
          },
        })
      } else {
        if (allZero(data)) continue
        labels.add(LABEL.c2pa)
        edits.push({ apply: (out) => scatter(out, ext, new Uint8Array(data.length)) })
      }
    }
    for (const [id, ext] of locations) if (!metaIds.has(id) && typeof ext !== 'string') protectedRanges.push(...ext)

    // A 'udes' property holds a user-written title, description and tags.
    const iprp = kids.find((x) => x.type === 'iprp')
    const ipco = iprp && children(b, iprp.body, iprp.end).find((x) => x.type === 'ipco')
    if (ipco) {
      for (const prop of children(b, ipco.body, ipco.end)) {
        if (prop.type !== 'udes' || allZero(b.subarray(prop.body + 4, prop.end))) continue
        labels.add(LABEL.description)
        edits.push({ apply: (out) => out.fill(0, prop.body + 4, prop.end) })
      }
    }
  }

  const freeBoxes: Box[] = []
  for (const box of list) {
    if (box.type === 'uuid') {
      uuidLabels(b, box, values).forEach((l) => labels.add(l))
      zeroed.push([box.start, box.end])
      edits.push(toFree(box))
    } else if (box.type === 'sefd') {
      const found = sefLabels(b, box)
      if (!found.length) continue
      found.forEach((l) => labels.add(l))
      zeroed.push([box.start, box.end])
      edits.push(toFree(box))
    } else if (box.type === 'moov') {
      movie(b, box, labels, values, edits, zeroed)
    } else if ((box.type === 'free' || box.type === 'skip') && !allZero(b.subarray(box.body, box.end))) {
      freeBoxes.push(box)
    } else if (box.type === 'mpvd') {
      labels.add(LABEL.motion)
      zeroed.push([box.start, box.end])
      if (box === list[list.length - 1]) cut = box.start
      else edits.push(toFree(box))
    }
  }
  if (end < b.length) {
    const tail = b.subarray(end)
    if (indexOf(tail, 'MotionPhoto_Data') !== -1 || indexOf(tail, 'ftyp') !== -1) labels.add(LABEL.motion)
    else if (!allZero(tail)) labels.add(LABEL.trailing)
    zeroed.push([end, b.length])
  }
  // Padding boxes can hold whatever an editor left behind. Zeroing them is
  // optional, so one that a picture happens to point into is left alone.
  for (const box of freeBoxes) {
    if (protectedRanges.some(([s, e]) => s < box.end && box.body < e)) continue
    labels.add(LABEL.other)
    edits.push({ apply: (out) => out.fill(0, box.body, box.end) })
  }
  // Never blank or cut bytes that a picture item points into (metadata items
  // count as blanked, so one that shares bytes with a picture fails too).
  for (const [s, e] of protectedRanges) {
    for (const [zs, ze] of zeroed) if (s < ze && zs < e) fail('image data overlaps a box Slynk would remove')
    if (e > cut) fail('image data lies after the cut')
  }
  return { labels, values, edits, cut }
}

export function strip(b: Uint8Array): FormatOutcome {
  const a = analyse(b)
  if (a.labels.size === 0) return { status: 'unchanged' }
  // Every edit lies before the cut (what follows it is dropped, not edited).
  const out = b.slice(0, a.cut)
  for (const e of a.edits) e.apply(out)
  return { status: 'cleaned', bytes: out, removed: [...a.labels], values: a.values }
}

export function verify(b: Uint8Array): void {
  const { list, end } = topLevel(b)
  if (end !== b.length) fail('data after the last box')
  if (list.some((x) => x.type === 'uuid' || x.type === 'mpvd')) fail('a removable box is still there')
  const a = analyse(b)
  if (a.labels.size) fail(`still holds: ${[...a.labels].join(', ')}`)
}
