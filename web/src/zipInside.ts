// A zip written again with its files as the composer sends them (tray.ts): each
// photo, video, audio file or document that's a row of its own goes back in its
// place, under its new name if it has one (a photo made smaller can become a
// .jpg), and files taken off the list are left out. Everything else is copied
// as it is, names in their own bytes and each entry keeping its kind (strip/zip.ts).
// Each file is compressed as one on its own would be (compress.ts): by what it
// holds, when that saves at least 5%. A text file the zip stored uncompressed
// is compressed; a photo isn't tried.
//
// With "Stronger compression" on, such a zip can go unpacked instead (unpackedZip:
// every file stored), squeezed whole with Brotli, which finds what its files have in
// common as well as Brotli's own dictionary of web words: a zip of a folder of code
// goes about a third smaller. The recipient's page compresses its files again
// (repackZip), as rebuildZip does, so they get an ordinary zip.
import { deflateSync } from 'fflate'
import { samplesOf, squeezes, tryable } from './compress.ts'
import { Writer, concat, crc32, u16le } from './strip/bytes.ts'
import { type OutEntry, type Package, modeOf, openPackage, rawName, readEntry, writePackage } from './strip/zip.ts'
import { type ZipEntry, readZipDirectory, shownName, zipEnd } from './strip/zipdir.ts'

/**
 * One of the zip's files as it goes now. name: under its entry's own name (as the readers decode it)
 * if that's unchanged, else as it's shown. same: its bytes are the entry's own, unchanged in base.
 */
export interface Inside {
  entry: string
  name: string
  data: Uint8Array
  same: boolean
}

/** What a rebuilt zip holds, and the files in it that were compressed here: by their names in base, at their packed size. */
export interface Rebuilt {
  data: Uint8Array
  packed: Map<string, number>
}

// Each set of bytes is judged once, however often the zip is written again: a file's own (its
// array stays the same), or one copied from base (by its name in that base).
const judged = new WeakMap<Uint8Array, Uint8Array | null>()
const judgedIn = new WeakMap<Uint8Array, Map<string, Uint8Array | null>>()

/** Its deflated form when that saves at least 5%, judged as a file on its own is; null to store it. */
function pack(data: Uint8Array): Uint8Array | null {
  if (!tryable(data)) return null
  const samples = samplesOf(data)
  if (samples.length && !samples.some((s) => squeezes(s, deflateSync(s, { level: 6 })))) return null
  const packed = deflateSync(data, { level: 6 })
  return packed.length < data.length * 0.95 ? packed : null
}

/** A file's size in the zip once judged (packed, or as it is), for the space it takes; undefined until then. */
export function packedLength(data: Uint8Array): number | undefined {
  const known = judged.get(data)
  return known === undefined ? undefined : (known ?? data).length
}

function packOnce(data: Uint8Array, base?: Uint8Array, name?: string): Uint8Array | null {
  const cache = base && name !== undefined ? (judgedIn.get(base) ?? judgedIn.set(base, new Map()).get(base)!) : undefined
  const known = cache ? cache.get(name!) : judged.get(data)
  if (known !== undefined) return known
  const out = pack(data)
  if (cache) cache.set(name!, out)
  else judged.set(data, out)
  return out
}

/** Makes a name unique in a zip, ignoring case: "a/photo.jpg" → "a/photo (2).jpg". */
export function uniqueIn(taken: Set<string>, name: string): string {
  const slash = name.lastIndexOf('/')
  const dot = name.lastIndexOf('.')
  const stem = dot > slash + 1 ? name.slice(0, dot) : name
  const ext = dot > slash + 1 ? name.slice(dot) : ''
  let out = name
  for (let n = 2; taken.has(out.toLowerCase()); n++) out = `${stem} (${n})${ext}`
  taken.add(out.toLowerCase())
  return out
}

/**
 * Every kept entry's name in the zip that goes: its own for one that keeps it, so it's never taken
 * twice; a new one, unique among them all (as the readers decode names and as they're shown), for a
 * file with a new name, written in UTF-8 with its folders as they're shown.
 */
function finalNames(entries: ZipEntry[], at: Map<string, Inside>, dropped: Set<string>): Map<ZipEntry, string> {
  const kept = entries.filter((e) => !dropped.has(e.name))
  const dirOf = (e: ZipEntry) => e.name.slice(0, e.name.lastIndexOf('/') + 1)
  const renamed = (e: ZipEntry) => {
    const f = at.get(e.name)
    return !!f && dirOf(e) + f.name !== e.name
  }
  const taken = new Set(kept.filter((e) => !renamed(e)).flatMap((e) => [e.name, shownName(e.name, !!(e.flags & 0x800))].map((n) => n.toLowerCase())))
  return new Map(kept.map((e) => [e, renamed(e) ? uniqueIn(taken, shownName(dirOf(e), !!(e.flags & 0x800)) + at.get(e.name)!.name) : e.name]))
}

/**
 * The zip (base: as cleaned) with these of its files as they go, and without the dropped ones,
 * written afresh (strip/zip.ts writePackage: 1980 dates, no extra fields or comments). packed: the
 * files compressed here, by their names in base, at their packed size.
 */
export function rebuildZip(base: Uint8Array, files: Inside[], dropped: Set<string>): Rebuilt {
  const { pkg, list, packed } = zipList(base, files, dropped)
  return { data: writePackage(pkg, list), packed }
}

/** What rebuildZip writes: the zip's entries as they go, and the files compressed here. */
function zipList(base: Uint8Array, files: Inside[], dropped: Set<string>): { pkg: Package; list: OutEntry[]; packed: Map<string, number> } {
  // It copies the files it doesn't change, never unpacking them, so how big they'd unpack to doesn't matter.
  const pkg = openPackage(base, true, Infinity)
  const at = new Map(files.map((f) => [f.entry, f]))
  const names = finalNames(pkg.entries, at, dropped)
  const list: OutEntry[] = []
  const packed = new Map<string, number>()
  for (const e of pkg.entries) {
    const name = names.get(e)
    if (name === undefined) continue
    const f = at.get(e.name)
    const kept = { name: e.name, raw: rawName(base, e), mode: modeOf(e) }
    if (!f) {
      // Stored uncompressed in the zip: compressed now if that's worth it, as on its own.
      const raw = e.method === 0 ? base.subarray(e.dataOffset, e.dataOffset + e.csize) : undefined
      const p = raw && packOnce(raw, base, e.name)
      if (raw && p) {
        list.push({ ...kept, data: raw, packed: p })
        packed.set(e.name, p.length)
      } else list.push({ ...kept, from: e })
      continue
    }
    if (f.same && name === e.name) {
      list.push({ ...kept, from: e })
      continue
    }
    const p = packOnce(f.data)
    if (p) packed.set(e.name, p.length)
    list.push({ ...(name === e.name ? kept : { name, mode: kept.mode }), data: f.data, ...(p ? { packed: p } : { store: true }) })
  }
  return { pkg, list, packed }
}

/** The most files a zip sent unpacked may hold, as the cleaner's own limit (strip/archive.ts): the recipient's page compresses each again. */
export const MAX_UNPACKED_FILES = 10_000
/** And in all the zips of one envelope: past it, the rest are given as they arrived (the review, 2026-10-26). */
export const MAX_REPACKED_FILES = 20_000

/**
 * The zip rebuildZip writes, with every file stored as it is (each copied one unpacked), for
 * sending squeezed whole; null if it would hold more than MAX_UNPACKED_FILES or be bigger than
 * max, if its files come to less than atLeast (a zip of photos, which unpacked is hardly bigger:
 * judged before anything is unpacked), or if a file in it is packed in a way Slynk can't unpack.
 * repackZip turns it back into an ordinary zip.
 */
export function unpackedZip(base: Uint8Array, files: Inside[], dropped: Set<string>, max: number, atLeast = 0): Uint8Array | null {
  const { pkg, list } = zipList(base, files, dropped)
  if (list.length > MAX_UNPACKED_FILES) return null
  let total = 0
  for (const item of list) total += 'from' in item ? item.from.usize : item.data.length
  if (total > max || total < atLeast) return null
  const stored: OutEntry[] = []
  for (const item of list) {
    if (!('from' in item)) {
      stored.push({ name: item.name, raw: item.raw, mode: item.mode, data: item.data, store: true })
      continue
    }
    if (item.from.method !== 0 && item.from.method !== 8) return null
    try {
      stored.push({ name: item.name, raw: item.raw, mode: item.mode, data: readEntry(pkg, item.from), store: true })
    } catch {
      return null // damaged: it goes as rebuildZip writes it, copied as it is
    }
  }
  // Its headers count too: past max, the recipient would give it as it arrived, unpacked.
  const out = writePackage(pkg, stored)
  return out.length > max ? null : out
}

/**
 * A zip that arrived unpacked (unpackedZip), with each file compressed again where that saves at
 * least 5%, as rebuildZip compresses the files it writes. Anything else (bigger than max, more
 * files than a sender's page sends or than budget has left, a file that isn't stored, a damaged
 * zip) is given as it is: whatever it holds came from the sender. It gives the page a turn now and
 * then: a crafted zip of thousands of tiny files froze it for half a minute (the review, 2026-10-26).
 */
export async function repackZip(bytes: Uint8Array, max: number, budget = { files: MAX_REPACKED_FILES }): Promise<Uint8Array> {
  if (bytes.length > max) return bytes
  try {
    const pkg = openPackage(bytes, false, max)
    if (pkg.encrypted || pkg.entries.length > Math.min(MAX_UNPACKED_FILES, budget.files) || pkg.entries.some((e) => e.method !== 0)) return bytes
    budget.files -= pkg.entries.length
    const list: OutEntry[] = []
    let since = performance.now()
    for (const e of pkg.entries) {
      const data = readEntry(pkg, e)
      const p = pack(data)
      list.push({ name: e.name, raw: rawName(bytes, e), mode: modeOf(e), data, ...(p ? { packed: p } : { store: true }) })
      if (performance.now() - since > 30) {
        await new Promise((r) => setTimeout(r, 0))
        since = performance.now()
      }
    }
    return writePackage(pkg, list)
  } catch {
    return bytes
  }
}

/**
 * The zip as it was, for a sender who keeps its own details ("Send original instead", or "Remove
 * hidden details" off): every file that isn't one of these copied byte for byte, header, dates,
 * extra fields and all, and each of these in its place under its own header, changed only for its
 * new bytes (and its name, if it has a new one). The index and its comment are kept too.
 */
export function keepZip(base: Uint8Array, files: Inside[], dropped: Set<string>): Rebuilt {
  const entries = readZipDirectory(base)
  const { cdOffset, eocd } = zipEnd(base)
  const at = new Map(files.map((f) => [f.entry, f]))
  const names = finalNames(entries, at, dropped)
  const sorted = [...entries].sort((x, y) => x.offset - y.offset)
  const out = new Writer()
  const records = new Map<ZipEntry, Uint8Array>()
  const packed = new Map<string, number>()
  for (const [i, e] of sorted.entries()) {
    const name = names.get(e)
    if (name === undefined) continue
    const f = at.get(e.name)
    const nameLength = e.dataOffset - e.offset - 30 - e.localExtra
    const recordName = u16le(base, e.central + 28)
    let record: Uint8Array = base.slice(e.central, e.central + 46 + recordName + e.centralExtra + e.commentLength)
    const offset = out.length
    if (!f || (f.same && name === e.name)) {
      // As it was: from its header to the next file's, any record of its sizes after its bytes included.
      out.bytes(base.subarray(e.offset, i + 1 < sorted.length ? sorted[i + 1].offset : cdOffset))
    } else {
      const p = packOnce(f.data)
      if (p) packed.set(e.name, p.length)
      const data = p ?? f.data
      const nameBytes = name === e.name ? base.subarray(e.offset + 30, e.offset + 30 + nameLength) : new TextEncoder().encode(name)
      // Its sizes in its header now (no record after its bytes); a new name is in UTF-8.
      const flags = (u16le(base, e.offset + 6) & ~8 & ~0x800) | (name === e.name ? u16le(base, e.offset + 6) & 0x800 : 0x800)
      const crc = crc32(f.data)
      const header = base.slice(e.offset, e.offset + 30)
      const h = new DataView(header.buffer)
      h.setUint16(6, flags, true)
      h.setUint16(8, p ? 8 : 0, true)
      h.setUint32(14, crc, true)
      h.setUint32(18, data.length, true)
      h.setUint32(22, f.data.length, true)
      h.setUint16(26, nameBytes.length, true)
      out.bytes(header)
      out.bytes(nameBytes)
      out.bytes(base.subarray(e.offset + 30 + nameLength, e.dataOffset))
      out.bytes(data)
      const fixed = record.slice(0, 46)
      const r = new DataView(fixed.buffer)
      r.setUint16(8, flags, true)
      r.setUint16(10, p ? 8 : 0, true)
      r.setUint32(16, crc, true)
      r.setUint32(20, data.length, true)
      r.setUint32(24, f.data.length, true)
      r.setUint16(28, nameBytes.length, true)
      record = concat([fixed, nameBytes, record.subarray(46 + recordName)])
    }
    new DataView(record.buffer, record.byteOffset).setUint32(42, offset, true)
    records.set(e, record)
  }
  // The index in its own order, then its end record with its comment.
  const start = out.length
  let count = 0
  for (const e of entries) {
    const record = records.get(e)
    if (!record) continue
    out.bytes(record)
    count++
  }
  const end = base.slice(eocd)
  const v = new DataView(end.buffer)
  v.setUint16(8, count, true)
  v.setUint16(10, count, true)
  v.setUint32(12, out.length - start, true)
  v.setUint32(16, start, true)
  out.bytes(end)
  return { data: out.finish(), packed }
}
