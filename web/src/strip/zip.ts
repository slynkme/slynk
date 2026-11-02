// ZIP packages (Office and OpenDocument files, and plain zips: archive.ts):
// read entries, then write a fresh archive. Untouched entries keep their compressed bytes as they are;
// changed ones are deflated again. Every entry gets the same fixed date
// (1980-01-01 00:00, the earliest a ZIP can hold), no extra fields and no
// comments, so the output doesn't reveal when or on what it was made, and the
// same input always gives the same bytes.
import { deflateSync } from 'fflate'
import { Writer, crc32 } from './bytes.ts'
import { inflateRaw } from './inflate.ts'
import { LABEL } from './labels.ts'
import { fail } from './types.ts'
import { type ZipEntry, readZipDirectory, zipCommentLength } from './zipdir.ts'

/** The most a package may expand to in total. */
export const ZIP_CAP = 300_000_000

const DOS_DATE_1980 = (0 << 9) | (1 << 5) | 1
// Extra fields that carry timestamps, and ones with only the owner's user/group IDs.
const TIME_EXTRAS = new Set([0x5455, 0x000a, 0x5855, 0x000d])
// Extra fields that say nothing of the sender: ZIP64's sizes, a name or comment in UTF-8, Java's
// marker. Every other one (owners' user and group ids, Windows' access lists, a tool's own data) is
// "other hidden data"; a zip written afresh keeps none of them.
const PLAIN_EXTRAS = new Set([0x0001, 0x7075, 0x6375, 0xcafe])

export interface Package {
  bytes: Uint8Array
  entries: ZipEntry[]
  /** Package-level labels: entry timestamps and the like. */
  labels: Set<string>
  /** Some entry is password-protected. */
  encrypted: boolean
}

/**
 * anyMethod: entries packed in ways Slynk can't unpack are allowed, to be copied as they are (plain
 * zips). cap: the most its entries may unpack to in all (a writer that copies them needn't care).
 */
export function openPackage(bytes: Uint8Array, anyMethod = false, cap = ZIP_CAP): Package {
  const entries = readZipDirectory(bytes)
  let total = 0
  const labels = new Set<string>()
  let encrypted = false
  for (const e of entries) {
    if (e.flags & 1) encrypted = true
    else if (e.method !== 0 && e.method !== 8 && !anyMethod) fail('unsupported ZIP compression')
    total += e.usize
    if (e.dosDate !== DOS_DATE_1980 || e.dosTime !== 0) labels.add(LABEL.saveTimes)
    if (e.extraIds.some((id) => TIME_EXTRAS.has(id))) labels.add(LABEL.saveTimes)
    if (e.extraIds.some((id) => !TIME_EXTRAS.has(id) && !PLAIN_EXTRAS.has(id))) labels.add(LABEL.other)
    if (e.commentLength) labels.add(LABEL.other)
  }
  if (total > cap) fail('the document is too large to check')
  if (zipCommentLength(bytes)) labels.add(LABEL.other)
  return { bytes, entries, labels, encrypted }
}

// Folders and files that macOS, Windows, Linux and apps add by themselves: Finder's view settings,
// Explorer's thumbnails of the pictures in a folder (some long since deleted), a folder's custom
// icon and name, Picasa's notes on a folder (face names among them), recycle bins and trash (with
// where each file was and when it went), and what Office and LibreOffice leave beside an open
// document (the name, user name and computer of whoever has it open).
const SYSTEM_FOLDER = /(^|\/)(__MACOSX|\.Spotlight-V100|\.fseventsd|\.Trashes|\$RECYCLE\.BIN|\.Trash-[^/]*)\//i
const SYSTEM_FILE = /(^|\/)(\.DS_Store|Thumbs\.db|ehthumbs(_vista)?\.db|desktop\.ini|\.picasa\.ini)$/i
const LOCK_FILE = /(^|\/)\.~lock\.[^/]*#$/
// Windows' "where it came from" mark, kept as a file of its own when copied off an NTFS disk.
const ZONE_MARK = /:Zone\.Identifier$/i

/**
 * What a computer or an app added to a zip by itself, by its name (the folder's, for one in such a
 * folder), or null. size: Office's "~$" owner files are only a few hundred bytes; a bigger file
 * named so is someone's own.
 */
export function systemName(name: string, size?: number): string | null {
  const named = SYSTEM_FOLDER.exec(name)?.[2] ?? SYSTEM_FILE.exec(name)?.[2]
  if (named) return named
  if (LOCK_FILE.test(name)) return '.~lock files'
  if (ZONE_MARK.test(name)) return 'Zone.Identifier'
  const base = name.slice(name.lastIndexOf('/') + 1)
  return base.startsWith('~$') && size !== undefined && size <= 4096 ? '~$ files' : null
}

const S_IFMT = 0o170000
const S_IFDIR = 0o040000
const S_IFLNK = 0o120000

/** The mode a plain zip's entry is written with: only what it is (a folder, a link, a file), and whether it runs. */
export function modeOf(e: ZipEntry): number {
  const os = e.madeBy >> 8
  const unix = os === 3 || os === 19 ? e.external >>> 16 : 0
  if ((unix & S_IFMT) === S_IFLNK) return S_IFLNK | 0o777
  if (e.name.endsWith('/') || (unix & S_IFMT) === S_IFDIR) return S_IFDIR | 0o755
  return 0o100000 | (unix & 0o111 ? 0o755 : 0o644)
}

/** The entry's name as its own bytes (the local header's copy, which zipdir.ts checked against the directory's). */
export function rawName(bytes: Uint8Array, e: ZipEntry): { name: Uint8Array; utf8: boolean } {
  const length = e.dataOffset - e.offset - 30 - e.localExtra
  return { name: bytes.subarray(e.offset + 30, e.offset + 30 + length), utf8: !!(e.flags & 0x800) }
}

/** An entry's uncompressed bytes, checked against its CRC. */
export function readEntry(pkg: Package, e: ZipEntry): Uint8Array {
  const raw = pkg.bytes.subarray(e.dataOffset, e.dataOffset + e.csize)
  const data = e.method === 0 ? raw : inflateRaw(raw, Math.min(ZIP_CAP, e.usize))
  if (data.length !== e.usize || crc32(data) !== e.crc) fail(`a damaged part: ${e.name}`)
  return data
}

/**
 * A plain zip's entry keeps its name's own bytes (Windows writes names in an older code page,
 * which re-encoding would garble) and its kind: a folder, a link, or a file that runs or doesn't.
 */
interface Kept {
  raw?: { name: Uint8Array; utf8: boolean }
  /** A Unix mode (a type, and 755 or 644), written with "made by Unix"; without one, "made by MS-DOS" and no attributes. */
  mode?: number
}

export type OutEntry = Kept &
  (
    /** Copy the original entry's compressed bytes. */
    | { name: string; from: ZipEntry }
    /** New contents; stored uncompressed when `store` is set (ODF's mimetype), or packed: deflated already. */
    | { name: string; data: Uint8Array; store?: boolean; packed?: Uint8Array }
  )

export function writePackage(pkg: Package, list: OutEntry[]): Uint8Array {
  const w = new Writer()
  const central = new Writer()
  for (const item of list) {
    const name = item.raw?.name ?? new TextEncoder().encode(item.name)
    const utf8 = item.raw ? item.raw.utf8 : /[^\x20-\x7e]/.test(item.name)
    let method: number
    let crc: number
    let usize: number
    let data: Uint8Array
    if ('from' in item) {
      const e = item.from
      method = e.method
      crc = e.crc
      usize = e.usize
      data = pkg.bytes.subarray(e.dataOffset, e.dataOffset + e.csize)
    } else {
      crc = crc32(item.data)
      usize = item.data.length
      method = item.store ? 0 : 8
      data = item.store ? item.data : (item.packed ?? deflateSync(item.data, { level: 6 }))
    }
    const offset = w.length
    const version = method === 8 ? 20 : 10
    const flags = utf8 ? 0x800 : 0
    // Local header
    w.u32le(0x04034b50)
    w.u16le(version)
    w.u16le(flags)
    w.u16le(method)
    w.u16le(0)
    w.u16le(DOS_DATE_1980)
    w.u32le(crc)
    w.u32le(data.length)
    w.u32le(usize)
    w.u16le(name.length)
    w.u16le(0)
    w.bytes(name)
    w.bytes(data)
    // Central directory entry
    central.u32le(0x02014b50)
    central.u16le(item.mode === undefined ? 20 : 0x0314) // made by: version 2.0, MS-DOS or Unix
    central.u16le(version)
    central.u16le(flags)
    central.u16le(method)
    central.u16le(0)
    central.u16le(DOS_DATE_1980)
    central.u32le(crc)
    central.u32le(data.length)
    central.u32le(usize)
    central.u16le(name.length)
    central.u16le(0) // extra
    central.u16le(0) // comment
    central.u16le(0) // disk
    central.u16le(0) // internal attributes
    // External attributes: the mode, and MS-DOS's folder flag for a folder.
    central.u32le(item.mode === undefined ? 0 : item.mode * 0x10000 + ((item.mode & 0o170000) === 0o040000 ? 0x10 : 0))
    central.u32le(offset)
    central.bytes(name)
  }
  if (list.length > 0xfffe || w.length > 0xfffffff0) fail('the document is too large')
  const cdOffset = w.length
  const cd = central.finish()
  w.bytes(cd)
  w.u32le(0x06054b50)
  w.u16le(0)
  w.u16le(0)
  w.u16le(list.length)
  w.u16le(list.length)
  w.u32le(cd.length)
  w.u32le(cdOffset)
  w.u16le(0)
  return w.finish()
}

/** Resolves a relationship target against the part that holds the .rels file. */
export function resolveTarget(relsName: string, target: string): string {
  // "word/_rels/document.xml.rels" describes "word/document.xml".
  const dir = relsName.replace(/(^|\/)_rels\/[^/]*$/, '$1')
  const parts = (target.startsWith('/') ? target.slice(1) : dir + target).split('/')
  const out: string[] = []
  for (const p of parts) {
    if (p === '..') out.pop()
    else if (p !== '.' && p !== '') out.push(p)
  }
  try {
    return decodeURIComponent(out.join('/'))
  } catch {
    return out.join('/')
  }
}
