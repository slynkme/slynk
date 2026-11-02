// Reads a ZIP's central directory (the index at the end of the file). Strict:
// ZIP64, multi-disk archives, duplicate names and overlapping entries (a
// zip-bomb trick) are refused rather than guessed at.
import { latin1, startsWith, u16le, u32le } from './bytes.ts'
import { fail } from './types.ts'

export interface ZipEntry {
  name: string
  flags: number
  method: number
  dosTime: number
  dosDate: number
  crc: number
  csize: number
  usize: number
  /** Offset of the local header. */
  offset: number
  /** Offset of the (compressed) data. */
  dataOffset: number
  centralExtra: number
  localExtra: number
  commentLength: number
  /** Extra-field IDs found in the central and local headers. */
  extraIds: number[]
  /** "Version made by": its high byte names the system (3: Unix). */
  madeBy: number
  /** External attributes: on Unix, the file's mode in the high 16 bits. */
  external: number
  /** Offset of its record in the index. */
  central: number
}

/** At most this many extra-field ids are kept per header: real ones have a few, and a zip of empty ones would fill memory. */
const MAX_EXTRAS = 32

/**
 * Whether an entry's sizes can be true: a stored one is as big packed as unpacked, and deflate never
 * grows data by more than about an eighth. One that claims less than it holds can't hide junk after
 * its data, which made unpacking slow. (A locked entry carries its key's bytes, so isn't judged.)
 */
export function plausible(flags: number, method: number, csize: number, usize: number): boolean {
  if (flags & 1) return true
  if (method === 0) return csize === usize
  if (method === 8) return csize <= usize + usize / 8 + 1024
  return true
}

export function extraIds(b: Uint8Array, start: number, length: number): number[] {
  const ids: number[] = []
  for (let i = start; i + 4 <= start + length && ids.length < MAX_EXTRAS; ) {
    ids.push(u16le(b, i))
    i += 4 + u16le(b, i + 2)
  }
  return ids
}

export function readZipDirectory(b: Uint8Array): ZipEntry[] {
  // The end-of-central-directory record sits in the last 64 KB + 22 bytes.
  let eocd = -1
  for (let i = b.length - 22; i >= 0 && i >= b.length - 22 - 0xffff; i--) {
    if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 5 && b[i + 3] === 6) {
      eocd = i
      break
    }
  }
  if (eocd === -1) fail('no ZIP directory')
  if (u16le(b, eocd + 4) !== 0 || u16le(b, eocd + 6) !== 0) fail('multi-part ZIPs are not supported')
  const count = u16le(b, eocd + 10)
  const cdSize = u32le(b, eocd + 12)
  const cdOffset = u32le(b, eocd + 16)
  if (count === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) fail('ZIP64 is not supported')
  if (count !== u16le(b, eocd + 8)) fail('bad ZIP directory')
  if (cdOffset + cdSize > eocd) fail('bad ZIP directory')
  const entries: ZipEntry[] = []
  const names = new Set<string>()
  let p = cdOffset
  for (let k = 0; k < count; k++) {
    if (u32le(b, p) !== 0x02014b50) fail('bad ZIP directory entry')
    const flags = u16le(b, p + 8)
    const nameLen = u16le(b, p + 28)
    const centralExtra = u16le(b, p + 30)
    const commentLength = u16le(b, p + 32)
    const offset = u32le(b, p + 42)
    const nameBytes = b.subarray(p + 46, p + 46 + nameLen)
    let name: string
    try {
      name = flags & 0x800 ? new TextDecoder('utf-8', { fatal: true }).decode(nameBytes) : latin1(nameBytes)
    } catch {
      return fail('bad ZIP entry name')
    }
    if (names.has(name)) fail('duplicate ZIP entry')
    names.add(name)
    if (u32le(b, offset) !== 0x04034b50) fail('bad ZIP local header')
    const localName = u16le(b, offset + 26)
    const localExtra = u16le(b, offset + 28)
    if (localName !== nameLen || !startsWith(b, latin1(nameBytes), offset + 30)) fail('ZIP names disagree')
    const csize = u32le(b, p + 20)
    const dataOffset = offset + 30 + localName + localExtra
    if (dataOffset + csize > cdOffset) fail('a ZIP entry runs past its data')
    if (!plausible(flags, u16le(b, p + 10), csize, u32le(b, p + 24))) fail('a ZIP entry’s sizes disagree')
    entries.push({
      name,
      flags,
      method: u16le(b, p + 10),
      dosTime: u16le(b, p + 12),
      dosDate: u16le(b, p + 14),
      crc: u32le(b, p + 16),
      csize,
      usize: u32le(b, p + 24),
      offset,
      dataOffset,
      centralExtra,
      localExtra,
      commentLength,
      extraIds: [...extraIds(b, p + 46 + nameLen, centralExtra), ...extraIds(b, offset + 30 + localName, localExtra)],
      madeBy: u16le(b, p + 4),
      external: u32le(b, p + 38),
      central: p,
    })
    p += 46 + nameLen + centralExtra + commentLength
  }
  if (p !== cdOffset + cdSize) fail('bad ZIP directory size')
  const sorted = [...entries].sort((x, y) => x.offset - y.offset)
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].offset < sorted[i - 1].dataOffset + sorted[i - 1].csize) fail('ZIP entries overlap')
  }
  return entries
}

// The DOS code page (437) that a zip's names are in when they aren't marked as UTF-8: its upper half.
const CP437 = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ '

/**
 * An entry's name fit to show, from the name as the readers decode it (byte for byte when it isn't
 * marked as UTF-8): as UTF-8 when it reads as that (tools on Macs and Linux often don't mark it),
 * else in the DOS code page the zip format names. Only for showing: the zip keeps its own bytes.
 */
export function shownName(name: string, utf8: boolean): string {
  if (utf8 || !/[\x80-\xff]/.test(name)) return name
  const bytes = Uint8Array.from(name, (c) => c.charCodeAt(0))
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return Array.from(bytes, (b) => (b < 0x80 ? String.fromCharCode(b) : CP437[b - 0x80])).join('')
  }
}

/** Where the index starts and its end record is, from the end record: for a writer that keeps the rest as it was. */
export function zipEnd(b: Uint8Array): { cdOffset: number; eocd: number } {
  for (let i = b.length - 22; i >= 0 && i >= b.length - 22 - 0xffff; i--) {
    if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 5 && b[i + 3] === 6) return { cdOffset: u32le(b, i + 16), eocd: i }
  }
  return fail('no ZIP directory')
}

/** The archive comment's length (from the end record). */
export function zipCommentLength(b: Uint8Array): number {
  for (let i = b.length - 22; i >= 0 && i >= b.length - 22 - 0xffff; i--) {
    if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 5 && b[i + 3] === 6) return u16le(b, i + 20)
  }
  return 0
}
