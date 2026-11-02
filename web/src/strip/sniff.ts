// File-type detection from the first bytes (never the name or MIME type,
// which the sender's system makes up). Small and synchronous, so the page can
// call it without starting the strip worker.
import { startsAsSvg } from './svgscan.ts'
import type { Kind } from './types.ts'
import { readZipDirectory } from './zipdir.ts'

function at(b: Uint8Array, i: number, s: string): boolean {
  if (i + s.length > b.length) return false
  for (let k = 0; k < s.length; k++) if (b[i + k] !== s.charCodeAt(k)) return false
  return true
}

const BITRATES = [
  // MPEG-1 layers I, II, III
  [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  // MPEG-2/2.5 layer I, then layers II and III
  [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
]
const RATES = [
  [11025, 12000, 8000], // MPEG 2.5
  [0, 0, 0],
  [22050, 24000, 16000], // MPEG 2
  [44100, 48000, 32000], // MPEG 1
]

/** Length of the MPEG audio frame starting at i, or 0 if there isn't a valid one. */
export function mpegFrameLength(b: Uint8Array, i: number): number {
  if (i + 4 > b.length || b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) return 0
  const version = (b[i + 1] >> 3) & 3
  const layer = (b[i + 1] >> 1) & 3 // 3 = layer I, 1 = layer III; 0 is ADTS AAC
  const bitrateIndex = b[i + 2] >> 4
  const rateIndex = (b[i + 2] >> 2) & 3
  const padding = (b[i + 2] >> 1) & 1
  if (version === 1 || layer === 0 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return 0
  if ((b[i + 3] & 3) === 2) return 0 // reserved emphasis
  const l = 4 - layer // 1, 2 or 3
  const table = version === 3 ? l - 1 : l === 1 ? 3 : 4
  const bitrate = BITRATES[table][bitrateIndex] * 1000
  const rate = RATES[version][rateIndex]
  if (l === 1) return (Math.floor((12 * bitrate) / rate) + padding) * 4
  const factor = l === 3 && version !== 3 ? 72 : 144
  return Math.floor((factor * bitrate) / rate) + padding
}

/** True when two MPEG audio frames follow each other from offset i. */
export function mpegStartsAt(b: Uint8Array, i: number): boolean {
  const n = mpegFrameLength(b, i)
  if (!n) return false
  return i + n >= b.length || mpegFrameLength(b, i + n) > 0
}

/** Total length of the ID3v2 tags stacked at the start, or 0. */
export function id3Length(b: Uint8Array): number {
  let pos = 0
  while (at(b, pos, 'ID3') && pos + 10 <= b.length) {
    const s = b.subarray(pos + 6, pos + 10)
    if (s.some((v) => v & 0x80)) break
    const size = (s[0] << 21) | (s[1] << 14) | (s[2] << 7) | s[3]
    pos += 10 + size + (b[pos + 5] & 0x10 ? 10 : 0)
  }
  return pos
}

function brands(b: Uint8Array): string[] {
  const size = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0
  // This runs on the page: a damaged size mustn't make it walk the whole file.
  const end = Math.min(b.length, size > 8 ? size : 8, 16 + 4 * 64)
  const out: string[] = []
  for (let i = 8; i + 4 <= end; i += 4) if (i !== 12) out.push(String.fromCharCode(...b.subarray(i, i + 4)))
  return out
}

/**
 * An Office or OpenDocument file, a plain zip ('zip'), another format built as a zip that Slynk
 * leaves alone ('package'), or null when its directory can't be read.
 */
function zipKind(b: Uint8Array): Kind | 'package' | null {
  let entries
  try {
    entries = readZipDirectory(b)
  } catch {
    return null
  }
  const first = entries[0]
  if (first?.name === 'mimetype' && first.method === 0) {
    const mime = String.fromCharCode(...b.subarray(first.dataOffset, first.dataOffset + Math.min(first.csize, 100)))
    const m = /^application\/vnd\.oasis\.opendocument\.(text|spreadsheet|presentation)(-template)?$/.exec(mime)
    if (m) return m[1] === 'text' ? 'odt' : m[1] === 'spreadsheet' ? 'ods' : 'odp'
    // E-books and other formats that name their type.
    return 'package'
  }
  const names = new Set(entries.map((e) => e.name))
  if (names.has('[Content_Types].xml')) {
    if (names.has('word/document.xml')) return 'docx'
    if (names.has('xl/workbook.xml')) return 'xlsx'
    if (names.has('ppt/presentation.xml')) return 'pptx'
    return 'package'
  }
  if (entries.some((e) => SIGNED_PART.test(e.name))) return 'package'
  return 'zip'
}

/**
 * Parts of Java and Android programs, signed add-ons, Python packages and signed app bundles:
 * their signatures or lists of hashes cover the files inside, so changing one would break them.
 */
export const SIGNED_PART = /^(META-INF\/|AndroidManifest\.xml$)|(^|\/)(_CodeSignature|[^/]+\.dist-info)\//

/** The kind of a file Slynk can clean, or null. */
export function detectKind(b: Uint8Array): Kind | null {
  if (b.length < 8) return null
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg'
  if (at(b, 0, '\x89PNG\r\n\x1a\n')) return 'png'
  if (at(b, 0, 'RIFF') && at(b, 8, 'WEBP')) return 'webp'
  if (at(b, 0, 'GIF87a') || at(b, 0, 'GIF89a')) return 'gif'
  if (at(b, 4, 'ftyp')) {
    const list = brands(b)
    if (list.some((x) => x === 'avif' || x === 'avis')) return 'avif'
    if (list.some((x) => ['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1'].includes(x))) return 'heic'
    // Phone and camera videos (video.ts): QuickTime's brand, or the usual MP4, M4V and 3GP ones. Not
    // audio (M4A, M4B), Canon raw photos (crx) or anything else built of boxes.
    if (list.includes('qt  ')) return 'mov'
    if (list.some((x) => /^(M4A |M4B |M4P |crx )$/.test(x)) && !list.some((x) => /^M4V/.test(x))) return null
    if (list.some((x) => /^(isom|iso[2-9]|mp41|mp42|avc1|M4V |M4VH|M4VP|3gp[4-9]|3g2[abc]|3ge[67]|3gg6|MSNV|XAVC|mmp4|f4v |dash)$/.test(x))) return 'mp4'
    return null
  }
  if (at(b, 0, 'fLaC')) return 'flac'
  if (at(b, 0, 'ID3')) {
    const n = id3Length(b)
    if (at(b, n, 'fLaC')) return 'flac'
    let i = n
    while (i < b.length && i < n + 4096 && b[i] === 0) i++
    return mpegStartsAt(b, i) ? 'mp3' : null
  }
  if (mpegStartsAt(b, 0)) return 'mp3'
  // Before the PDF check: a ZIP whose first entry is a stored PDF has
  // "%PDF-" near its start, and cleaning it as a PDF would throw the ZIP away.
  if (at(b, 0, 'PK\x03\x04')) {
    const k = zipKind(b)
    return k === 'package' ? null : k
  }
  if (at(b, 0, '%PDF-')) return 'pdf'
  if (at(b, 0, '{\\rtf')) return 'rtf'
  // An SVG drawing: XML whose first element is <svg> (svg.ts cleans it, if it can read it).
  if (startsAsSvg(b)) return 'svg'
  // Readers accept a PDF header anywhere in the first 1 KB, but only after
  // junk that isn't another format's signature.
  if (describeOther(b) === null) {
    for (let i = 1; i < Math.min(1024, b.length - 5); i++) if (at(b, i, '%PDF-') && /\d/.test(String.fromCharCode(b[i + 5]))) return 'pdf'
  }
  return null
}

const u16 = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8)
const u32 = (b: Uint8Array, i: number) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0

/**
 * The names in a Compound File's directory (the container of Office's older
 * files, and of password-protected new ones), or null if it can't be read.
 * Bounded, since it runs on the page.
 */
export function compoundNames(b: Uint8Array): string[] | null {
  const shift = u16(b, 0x1e)
  if (b.length < 512 || (shift !== 9 && shift !== 12)) return null
  const size = 1 << shift
  const at = (n: number) => (n + 1) * size
  // The allocation table's sectors: 109 listed in the header, any more in a chain of their own.
  const fat: number[] = []
  for (let i = 0; i < 109; i++) fat.push(u32(b, 0x4c + 4 * i))
  for (let n = u32(b, 0x44), hops = 0; n < 0xfffffffa && hops < 1000 && at(n) + size <= b.length; hops++) {
    for (let i = 0; i < size / 4 - 1; i++) fat.push(u32(b, at(n) + 4 * i))
    n = u32(b, at(n) + size - 4)
  }
  const next = (n: number): number => {
    const sector = fat[Math.floor(n / (size / 4))]
    if (sector === undefined || sector >= 0xfffffffa || at(sector) + size > b.length) return 0xfffffffe
    return u32(b, at(sector) + 4 * (n % (size / 4)))
  }
  const names: string[] = []
  for (let n = u32(b, 0x30), hops = 0; n < 0xfffffffa; n = next(n)) {
    if (++hops > 256 || at(n) + size > b.length) return names.length ? names : null
    for (let e = at(n); e < at(n) + size; e += 128) {
      const len = Math.min(u16(b, e + 0x40), 64)
      if (len < 2 || b[e + 0x42] === 0) continue
      let name = ''
      for (let i = 0; i + 2 < len; i += 2) name += String.fromCharCode(u16(b, e + i))
      names.push(name)
    }
  }
  return names
}

/** Which of Office's files a Compound File is: an older Word, Excel or PowerPoint one, a password-protected new one, or something else. */
function oleKind(b: Uint8Array): string {
  const names = compoundNames(b)
  if (!names) return 'ole'
  if (names.includes('EncryptionInfo') || names.includes('EncryptedPackage')) return 'locked-office'
  if (names.includes('WordDocument')) return 'doc'
  if (names.includes('Workbook') || names.includes('Book')) return 'xls'
  if (names.includes('PowerPoint Document')) return 'ppt'
  return 'ole'
}

/** A short name for a type Slynk recognises but can't clean, for the UI. */
export function describeOther(b: Uint8Array): string | null {
  if (b.length < 4) return null
  if (at(b, 4, 'ftyp')) {
    const list = brands(b)
    if (list.includes('qt  ')) return 'mov'
    if (list.some((x) => x.startsWith('M4A') || x.startsWith('M4B'))) return 'm4a'
    if (list.some((x) => x.startsWith('3g'))) return '3gp'
    if (list.includes('crx ')) return 'cr3'
    return 'mp4'
  }
  if (at(b, 4, 'moov') || at(b, 4, 'mdat') || at(b, 4, 'wide') || at(b, 4, 'free')) return 'mov'
  if (at(b, 0, 'PK\x03\x04') || at(b, 0, 'PK\x05\x06')) return 'zip'
  if (at(b, 0, 'II*\0') || at(b, 0, 'MM\0*')) return 'tiff'
  if (at(b, 0, 'OggS')) return 'ogg'
  if (at(b, 0, 'RIFF') && at(b, 8, 'WAVE')) return 'wav'
  if (at(b, 0, 'RIFF') && at(b, 8, 'AVI ')) return 'avi'
  if (at(b, 0, 'FORM') && (at(b, 8, 'AIFF') || at(b, 8, 'AIFC'))) return 'aiff'
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'mkv'
  if (b[0] === 0xff && (b[1] & 0xf6) === 0xf0) return 'aac'
  if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) return oleKind(b)
  if (at(b, 0, 'BM')) return 'bmp'
  if (b[0] === 0x1f && b[1] === 0x8b) return 'gzip'
  if (at(b, 0, '7z\xbc\xaf\x27\x1c')) return '7z'
  if (at(b, 0, 'Rar!')) return 'rar'
  if (at(b, 257, 'ustar')) return 'tar'
  if (at(b, 0, '!<arch>\n')) return 'ar'
  if (at(b, 0, '07070')) return 'cpio'
  // Text: valid UTF-8 without control characters in the first few KB. An SVG drawing by its first
  // element, as detectKind says (2026-10-26): a web page with an icon in it is text, as other pages are.
  if (isUtf8Text(b)) return startsAsSvg(b) ? 'svg' : 'text'
  return null
}

/** A byte that plain text doesn't have: a control character other than a tab, a line break, a form feed or escape. */
export const isControlByte = (v: number) => v < 9 || (v > 13 && v < 32 && v !== 27)

/** Whether a file is text by its first few KB: valid UTF-8 without control characters, whatever it starts with. */
export function isUtf8Text(b: Uint8Array): boolean {
  if (b.length < 4) return false
  const head = b.subarray(0, 4096)
  if (head.some(isControlByte)) return false
  try {
    // stream: a character cut off at the 4 KB mark isn't an error.
    new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: head.length < b.length })
    return true
  } catch {
    return false
  }
}
