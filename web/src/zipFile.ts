// A zip read from its file a part at a time, as a video is (tray.ts), never
// whole, so it needs no size limit of its own: its index from the end of the
// file, the first bytes of a file inside to tell what it is, a photo or a
// document whole, and a video or a long recording unpacked by the browser
// into a file-like Blob that's read a run at a time, like one on its own.
// The rest of the zip becomes a small "skeleton" (everything but the files
// that are rows of their own, which are empty in their places), cleaned as
// any zip is and filled back in as they go (zipInside.ts).
import { Inflate } from 'fflate'
import { crc32, u16le, u32le } from './strip/bytes.ts'
import { inflateRaw, streamEnded } from './strip/inflate.ts'
import { SIGNED_PART } from './strip/sniff.ts'
import { type ZipEntry, extraIds, plausible } from './strip/zipdir.ts'

/** An entry as the zip's index lists it, with its index record's own bytes. dataOffset is -1 until its local header is read. */
export interface IndexEntry extends ZipEntry {
  record: Uint8Array
}

export interface ZipIndex {
  file: Blob
  entries: IndexEntry[]
  /** Where the index starts: every entry's bytes come before it. */
  cdOffset: number
  comment: Uint8Array
}

/** The index itself, at most: real ones are far smaller (0xffff entries with long names). */
const MAX_INDEX = 16_000_000

async function read(file: Blob, start: number, end: number): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(start, end).arrayBuffer())
}

const nameOf = (bytes: Uint8Array, utf8: boolean) => (utf8 ? new TextDecoder('utf-8', { fatal: true }).decode(bytes) : String.fromCharCode(...bytes))

/** A little-endian 64-bit number, which a zip of 4 GB or more uses (safe to 2^53, far past any file). */
const u64le = (b: Uint8Array, i: number) => u32le(b, i) + u32le(b, i + 4) * 0x1_0000_0000

/**
 * The real sizes and offset of an entry its index marks as ZIP64 (0xffffffff), from its ZIP64 extra
 * field (id 1), which holds only the ones so marked, in this order.
 */
function zip64Sizes(record: Uint8Array, nameLength: number, extra: number, sizes: { usize: number; csize: number; offset: number }) {
  for (let i = 46 + nameLength; i + 4 <= 46 + nameLength + extra; i += 4 + u16le(record, i + 2)) {
    if (u16le(record, i) !== 1) continue
    let at = i + 4
    for (const key of ['usize', 'csize', 'offset'] as const) {
      if (sizes[key] !== 0xffffffff) continue
      sizes[key] = u64le(record, at)
      at += 8
    }
    return
  }
  throw new Error('a ZIP64 entry without its sizes')
}

/**
 * A plain zip's index, or null for anything else: not a zip (a self-extracting program starts
 * with the program), split in parts, damaged, or a format of its own built as a zip (an e-book,
 * an Office file, a Java or Android program, a signed bundle). ZIP64 (4 GB or more, or more than
 * 65,535 files) is read too. Strict, as the cleaner is: duplicate names, sizes that can't be true
 * and entries that overlap (a zip-bomb trick) are refused, and every entry's local header is read
 * and checked against the index.
 */
export async function readZipIndex(file: Blob): Promise<ZipIndex | null> {
  try {
    const size = file.size
    if (size < 30) return null
    const head = await read(file, 0, 4)
    if (u32le(head, 0) !== 0x04034b50) return null
    const tailStart = Math.max(0, size - 22 - 0xffff)
    const tail = await read(file, tailStart, size)
    let at = -1
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 5 && tail[i + 3] === 6) {
        at = i
        break
      }
    }
    if (at < 0 || u16le(tail, at + 4) || u16le(tail, at + 6)) return null
    let count = u16le(tail, at + 10)
    let cdSize = u32le(tail, at + 12)
    let cdOffset = u32le(tail, at + 16)
    let end = tailStart + at
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      // ZIP64: its own end record, which a locator just before the usual one points at.
      const locator = await read(file, end - 20, end)
      if (end < 20 || u32le(locator, 0) !== 0x07064b50) return null
      const at64 = u64le(locator, 8)
      const record = await read(file, at64, at64 + 56)
      if (u32le(record, 0) !== 0x06064b50 || u32le(record, 16) || u32le(record, 20)) return null
      count = u64le(record, 32)
      cdSize = u64le(record, 40)
      cdOffset = u64le(record, 48)
      end = at64
    } else if (count !== u16le(tail, at + 8)) return null
    if (cdOffset + cdSize > end || cdSize > MAX_INDEX) return null
    const comment = tail.slice(at + 22, at + 22 + u16le(tail, at + 20))
    const cd = await read(file, cdOffset, cdOffset + cdSize)
    const entries: IndexEntry[] = []
    const names = new Set<string>()
    let p = 0
    for (let k = 0; k < count; k++) {
      if (u32le(cd, p) !== 0x02014b50) return null
      const flags = u16le(cd, p + 8)
      const nameLength = u16le(cd, p + 28)
      const extra = u16le(cd, p + 30)
      const commentLength = u16le(cd, p + 32)
      const length = 46 + nameLength + extra + commentLength
      if (p + length > cd.length) return null
      const name = nameOf(cd.subarray(p + 46, p + 46 + nameLength), !!(flags & 0x800))
      if (names.has(name)) return null
      names.add(name)
      const record = cd.slice(p, p + length)
      const sizes = { usize: u32le(cd, p + 24), csize: u32le(cd, p + 20), offset: u32le(cd, p + 42) }
      if (sizes.usize === 0xffffffff || sizes.csize === 0xffffffff || sizes.offset === 0xffffffff) zip64Sizes(record, nameLength, extra, sizes)
      const method = u16le(cd, p + 10)
      if (!plausible(flags, method, sizes.csize, sizes.usize)) return null
      entries.push({
        name,
        flags,
        method,
        dosTime: u16le(cd, p + 12),
        dosDate: u16le(cd, p + 14),
        crc: u32le(cd, p + 16),
        csize: sizes.csize,
        usize: sizes.usize,
        offset: sizes.offset,
        dataOffset: -1,
        centralExtra: extra,
        localExtra: -1,
        commentLength,
        extraIds: extraIds(cd, p + 46 + nameLength, extra),
        madeBy: u16le(cd, p + 4),
        external: u32le(cd, p + 38),
        central: cdOffset + p,
        record,
      })
      p += length
    }
    if (p !== cd.length) return null
    if (entries[0]?.name === 'mimetype' || names.has('[Content_Types].xml') || entries.some((e) => SIGNED_PART.test(e.name))) return null
    // Every local header agrees with the index, and each entry's bytes end before the next begins.
    const zip: ZipIndex = { file, entries, cdOffset, comment }
    for (const e of entries) await openEntry(zip, e)
    const sorted = [...entries].sort((x, y) => x.offset - y.offset)
    for (let i = 0; i < sorted.length; i++) {
      const next = i + 1 < sorted.length ? sorted[i + 1].offset : cdOffset
      if (sorted[i].dataOffset + sorted[i].csize > next) return null
    }
    return zip
  } catch {
    return null
  }
}

/** Reads an entry's local header, once: where its bytes start, and the ids of its own extra fields. Throws if it disagrees with the index. */
export async function openEntry(zip: ZipIndex, e: IndexEntry): Promise<IndexEntry> {
  if (e.dataOffset >= 0) return e
  const fixed = await read(zip.file, e.offset, e.offset + 30)
  if (fixed.length < 30 || u32le(fixed, 0) !== 0x04034b50) throw new Error('bad local header')
  const nameLength = u16le(fixed, 26)
  const extra = u16le(fixed, 28)
  const rest = await read(zip.file, e.offset + 30, e.offset + 30 + nameLength + extra)
  const central = e.record.subarray(46, 46 + u16le(e.record, 28))
  if (nameLength !== central.length || central.some((v, i) => rest[i] !== v)) throw new Error('names disagree')
  const dataOffset = e.offset + 30 + nameLength + extra
  if (dataOffset + e.csize > zip.cdOffset) throw new Error('runs past its data')
  e.dataOffset = dataOffset
  e.localExtra = extra
  e.extraIds = [...e.extraIds, ...extraIds(rest, nameLength, extra)]
  return e
}

/** Up to its first n bytes, unpacked, to tell what it is (unchecked: the whole is checked when it's read). */
export async function entryHead(zip: ZipIndex, e: IndexEntry, n: number): Promise<Uint8Array> {
  await openEntry(zip, e)
  if (e.method === 0) return read(zip.file, e.dataOffset, e.dataOffset + Math.min(n, e.csize))
  if (e.method !== 8) throw new Error('packed in an unsupported way')
  const parts: Uint8Array[] = []
  let got = 0
  const stream = new Inflate()
  stream.ondata = (chunk: Uint8Array) => {
    parts.push(chunk)
    got += chunk.length
  }
  // Read 64 KB at a time, pushed in small steps as inflate.ts does: one push can't unpack far past what's wanted.
  for (let at = 0; at < e.csize && got < n && !streamEnded(stream); at += 65_536) {
    const raw = await read(zip.file, e.dataOffset + at, e.dataOffset + Math.min(e.csize, at + 65_536))
    for (let i = 0; i < raw.length && got < n && !streamEnded(stream); i += 4096) stream.push(raw.subarray(i, i + 4096), at + i + 4096 >= e.csize)
  }
  const out = new Uint8Array(Math.min(n, got))
  let i = 0
  for (const part of parts) {
    if (i >= out.length) break
    out.set(part.subarray(0, out.length - i), i)
    i += part.length
  }
  return out
}

/** The whole of it, unpacked and checked against its CRC. */
export async function entryBytes(zip: ZipIndex, e: IndexEntry): Promise<Uint8Array> {
  await openEntry(zip, e)
  if (e.method !== 0 && e.method !== 8) throw new Error('packed in an unsupported way')
  const raw = await read(zip.file, e.dataOffset, e.dataOffset + e.csize)
  const data = e.method === 0 ? raw : inflateRaw(raw, e.usize)
  if (data.length !== e.usize || crc32(data) !== e.crc) throw new Error(`a damaged file: ${e.name}`)
  return data
}

/**
 * The whole of it as a Blob, never held whole here: a stored file is a slice of the zip's own,
 * and a packed one is unpacked by the browser as it goes (which keeps a big one on disk where it
 * can), checked against its CRC and its size on the way.
 */
export async function entryBlob(zip: ZipIndex, e: IndexEntry, type: string): Promise<Blob> {
  await openEntry(zip, e)
  if (e.method === 0) return zip.file.slice(e.dataOffset, e.dataOffset + e.csize, type)
  if (e.method !== 8) throw new Error('packed in an unsupported way')
  let crc = 0
  let got = 0
  const check = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, out) {
      got += chunk.length
      if (got > e.usize) throw new Error('unpacks to more than it says')
      crc = crc32(chunk, crc)
      out.enqueue(chunk)
    },
  })
  const packed = zip.file.slice(e.dataOffset, e.dataOffset + e.csize).stream()
  const blob = await new Response(packed.pipeThrough(new DecompressionStream('deflate-raw')).pipeThrough(check), { headers: { 'content-type': type } }).blob()
  if (got !== e.usize || crc !== e.crc) throw new Error(`a damaged file: ${e.name}`)
  return blob
}

/**
 * The zip without the bytes of these files (each an empty entry in its place, stored, to be filled
 * back in as it goes), everything else byte for byte as it was, index and all, so the cleaner sees
 * the zip's own details. Throws if what's left is more than cap.
 */
export async function skeleton(zip: ZipIndex, members: Set<string>, cap: number): Promise<Uint8Array> {
  const sorted = [...zip.entries].sort((x, y) => x.offset - y.offset)
  const parts: Uint8Array[] = []
  const placed = new Map<IndexEntry, number>()
  let pos = 0
  let kept = 0
  for (const [i, e] of sorted.entries()) {
    const end = i + 1 < sorted.length ? sorted[i + 1].offset : zip.cdOffset
    placed.set(e, pos)
    let part: Uint8Array
    if (members.has(e.name)) {
      await openEntry(zip, e)
      // Its local header, empty: stored, no CRC or sizes, no trailing record of them.
      part = await read(zip.file, e.offset, e.dataOffset)
      const v = new DataView(part.buffer, part.byteOffset, part.byteLength)
      v.setUint16(6, v.getUint16(6, true) & ~8, true)
      v.setUint16(8, 0, true)
      for (const at of [14, 18, 22]) v.setUint32(at, 0, true)
    } else {
      kept += end - e.offset
      if (kept > cap) throw new Error('too-big')
      part = await read(zip.file, e.offset, end)
    }
    parts.push(part)
    pos += part.length
  }
  const cdOffset = pos
  if (zip.entries.length > 0xfffe) throw new Error('too many files')
  for (const e of zip.entries) {
    const record = e.record.slice()
    const v = new DataView(record.buffer)
    v.setUint32(42, placed.get(e)!, true)
    if (members.has(e.name)) {
      v.setUint16(8, v.getUint16(8, true) & ~8, true)
      v.setUint16(10, 0, true)
      for (const at of [16, 20, 24]) v.setUint32(at, 0, true)
    } else {
      // A ZIP64 entry's sizes, where they fit (what's kept is small): the cleaner reads only these.
      v.setUint32(20, e.csize, true)
      v.setUint32(24, e.usize, true)
    }
    parts.push(record)
    pos += record.length
  }
  const end = new Uint8Array(22 + zip.comment.length)
  const v = new DataView(end.buffer)
  v.setUint32(0, 0x06054b50, true)
  v.setUint16(8, zip.entries.length, true)
  v.setUint16(10, zip.entries.length, true)
  v.setUint32(12, pos - cdOffset, true)
  v.setUint32(16, cdOffset, true)
  v.setUint16(20, zip.comment.length, true)
  end.set(zip.comment, 22)
  parts.push(end)
  const out = new Uint8Array(pos + end.length)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}
