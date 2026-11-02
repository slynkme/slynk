// JPEG: walk the marker segments, keep what affects how the picture looks
// (quantisation and Huffman tables, frame and scan headers, ICC colour,
// Adobe's colour transform, JFIF without its thumbnail, EXIF Orientation) and
// drop the rest. Pixels are copied byte for byte; nothing is re-encoded.
//
// Anything after the image's end marker is cut (motion-photo videos, extra
// previews, vendor trailers), except an HDR gain map that the photo declares:
// that is kept, cleaned of its own metadata, and re-linked with fresh MPF and
// container entries so HDR screens still show the brighter version.
import { ascii, concat, fromUtf8, indexOf, putU16be, putU32be, startsWith, u16be, u32be, u8, utf8 } from './bytes.ts'
import { orientationTiff, readExif } from './exif.ts'
import { LABEL } from './labels.ts'
import { type FormatOutcome, type Found, fail } from './types.ts'
import { addAll } from './values.ts'
import type { Element as XmlElement } from './xml.ts'
import { NS, onlyRendering, xmpLabels, xmpValues } from './xmp.ts'

const SOI = 0xd8
const SOS = 0xda
const APP0 = 0xe0
const APP15 = 0xef
const COM = 0xfe

const SIG = {
  jfif: 'JFIF\0',
  jfxx: 'JFXX\0',
  exif: 'Exif\0',
  xmp: 'http://ns.adobe.com/xap/1.0/\0',
  xmpExt: 'http://ns.adobe.com/xmp/extension/\0',
  icc: 'ICC_PROFILE\0',
  mpf: 'MPF\0',
  iso: 'urn:iso:std:iso:ts:21496:-1\0',
  adobe: 'Adobe',
  photoshop: 'Photoshop 3.0\0',
}

interface Seg {
  marker: number
  start: number // offset of the 0xFF
  end: number
}

interface Walked {
  /** Marker segments and entropy-coded data (marker -1), in file order. */
  parts: Seg[]
  /** Offset just past the end-of-image marker. */
  end: number
  /** Bytes skipped between segments that weren't padding. */
  garbage: boolean
}

/** Walks one JPEG from its start marker to its end marker. */
function walk(b: Uint8Array, start: number): Walked {
  if (u8(b, start) !== 0xff || u8(b, start + 1) !== SOI) fail('not a JPEG')
  const parts: Seg[] = []
  let garbage = false
  let pos = start + 2
  for (;;) {
    // Like libjpeg, skip stray bytes and fill bytes before a marker.
    while (pos < b.length && b[pos] !== 0xff) {
      if (b[pos] !== 0) garbage = true
      pos++
    }
    while (pos + 1 < b.length && b[pos + 1] === 0xff) pos++
    if (pos + 1 >= b.length) fail('the JPEG ends before its end marker')
    const marker = b[pos + 1]
    if (marker === 0x00) {
      pos += 2
      continue
    }
    if (marker === 0xd9) return { parts, end: pos + 2, garbage }
    if (marker === SOI) fail('unexpected start marker inside the JPEG')
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      parts.push({ marker, start: pos, end: pos + 2 })
      pos += 2
      continue
    }
    const len = u16be(b, pos + 2)
    if (len < 2 || pos + 2 + len > b.length) fail('bad JPEG segment length')
    parts.push({ marker, start: pos, end: pos + 2 + len })
    pos += 2 + len
    if (marker === SOS) {
      // Entropy-coded data runs to the next marker that isn't a stuffed zero
      // or a restart marker.
      let i = pos
      for (;;) {
        i = b.indexOf(0xff, i)
        if (i === -1) fail('the JPEG ends inside its image data')
        let j = i + 1
        while (j < b.length && b[j] === 0xff) j++
        if (j >= b.length) fail('the JPEG ends inside its image data')
        if (b[j] === 0x00 || (b[j] >= 0xd0 && b[j] <= 0xd7)) {
          i = j + 1
          continue
        }
        break
      }
      parts.push({ marker: -1, start: pos, end: i })
      pos = i
    }
  }
}

function payload(b: Uint8Array, s: Seg): Uint8Array {
  return b.subarray(s.start + 4, s.end)
}

function segment(marker: number, data: Uint8Array): Uint8Array {
  if (data.length + 2 > 0xffff) fail('segment too large')
  const out = new Uint8Array(4 + data.length)
  out[0] = 0xff
  out[1] = marker
  putU16be(out, 2, data.length + 2)
  out.set(data, 4)
  return out
}

function exifSegment(tiff: Uint8Array): Uint8Array {
  return segment(0xe1, concat([ascii('Exif\0\0'), tiff]))
}

interface MpEntry {
  attr: number
  size: number
  offset: number
}

/** Reads the image list of an MPF (multi-picture) segment. */
function readMpf(b: Uint8Array, s: Seg): { tiffStart: number; entries: MpEntry[] } | null {
  const t = payload(b, s).subarray(SIG.mpf.length)
  try {
    const le = t[0] === 0x49 && t[1] === 0x49
    const r16 = (i: number) => (le ? t[i] | (u8(t, i + 1) << 8) : u16be(t, i))
    const r32 = (i: number) => (le ? (t[i] | (t[i + 1] << 8) | (t[i + 2] << 16) | (u8(t, i + 3) << 24)) >>> 0 : u32be(t, i))
    if (r16(2) !== 42) return null
    const ifd = r32(4)
    const count = r16(ifd)
    let entries: MpEntry[] = []
    for (let k = 0; k < count && k < 64; k++) {
      const e = ifd + 2 + k * 12
      if (r16(e) !== 0xb002) continue
      const n = r32(e + 4)
      const at = r32(e + 8)
      entries = []
      for (let i = 0; i + 16 <= n && i < 16 * 64; i += 16) {
        entries.push({ attr: r32(at + i), size: r32(at + i + 4), offset: r32(at + i + 8) })
      }
    }
    return { tiffStart: s.start + 4 + SIG.mpf.length, entries }
  } catch {
    return null
  }
}

/** A fresh two-image MPF segment; offsets are filled in once the layout is known. */
function mpfSegment(primary: MpEntry, gainMap: MpEntry): Uint8Array {
  const t = new Uint8Array(4 + 50 + 32)
  t.set(ascii('MPF\0'), 0)
  const tiff = t.subarray(4)
  tiff.set([0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8])
  putU16be(tiff, 8, 3)
  // MPFVersion "0100", NumberOfImages 2, MPEntry (32 bytes at offset 50).
  tiff.set([0xb0, 0x00, 0x00, 0x07, 0, 0, 0, 4, 0x30, 0x31, 0x30, 0x30], 10)
  tiff.set([0xb0, 0x01, 0x00, 0x04, 0, 0, 0, 1, 0, 0, 0, 2], 22)
  tiff.set([0xb0, 0x02, 0x00, 0x07, 0, 0, 0, 32, 0, 0, 0, 50], 34)
  putU32be(tiff, 46, 0)
  for (const [i, e] of [primary, gainMap].entries()) {
    putU32be(tiff, 50 + i * 16, e.attr)
    putU32be(tiff, 54 + i * 16, e.size)
    putU32be(tiff, 58 + i * 16, e.offset)
  }
  return segment(0xe2, t)
}

function photoshop(data: Uint8Array, values: Found[]): string[] {
  const labels = new Set<string>()
  try {
    let i = SIG.photoshop.length
    while (i + 12 <= data.length && startsWith(data, '8BIM', i)) {
      const id = u16be(data, i + 4)
      const nameLen = u8(data, i + 6)
      // The name is a Pascal string padded to an even length.
      let j = i + 6 + 1 + nameLen
      if ((1 + nameLen) % 2) j++
      const size = u32be(data, j)
      if (id === 0x0404) labels.add(LABEL.iptc)
      else if (id === 0x0409 || id === 0x040c) labels.add(LABEL.thumbnail)
      else if (id === 0x0422) {
        const info = readExif(data.subarray(j + 4, j + 4 + size))
        info.labels.forEach((l) => labels.add(l))
        addAll(values, info.values)
      } else if (id === 0x0424) {
        const text = fromUtf8(data.subarray(j + 4, j + 4 + size))
        xmpLabels(text).forEach((l) => labels.add(l))
        addAll(values, xmpValues(text))
      }
      else if (id !== 0x0425) labels.add(LABEL.appData) // 0x0425 is only a checksum of the IPTC block
      i = j + 4 + size + (size % 2)
    }
  } catch {
    // The whole block goes anyway.
  }
  // Photoshop's own block, even when nothing in it could be read.
  if (labels.size === 0) labels.add(LABEL.appData)
  return [...labels]
}

interface Image {
  labels: Set<string>
  /** What some of the removed details say. */
  values: Found[]
  /** Segments to write right after SOI, then `rest`, in this order. */
  jfif: Uint8Array | null
  exif: Uint8Array | null
  xmpText: string | null
  icc: Uint8Array[]
  iso: Uint8Array | null
  mpf: { tiffStart: number; entries: MpEntry[] } | null
  adobe: Uint8Array | null
  rest: Uint8Array[]
  end: number
}

/** Sorts one JPEG's segments into kept and removed, collecting labels. */
function analyse(b: Uint8Array, start: number, gainMap: boolean): Image {
  const w = walk(b, start)
  const img: Image = {
    labels: new Set(),
    values: [],
    jfif: null,
    exif: null,
    xmpText: null,
    icc: [],
    iso: null,
    mpf: null,
    adobe: null,
    rest: [],
    end: w.end,
  }
  if (w.garbage) img.labels.add(LABEL.other)
  let exifSeen = false
  let scanned = false
  let app11 = false
  let c2pa = false
  const add = (ls: Iterable<string>) => {
    for (const l of ls) img.labels.add(l)
  }
  for (const s of w.parts) {
    const m = s.marker
    const isApp = m >= APP0 && m <= APP15
    if (!isApp && m !== COM) {
      if (m === SOS) scanned = true
      img.rest.push(b.subarray(s.start, s.end))
      continue
    }
    const p = payload(b, s)
    if (m === COM) {
      img.labels.add(LABEL.comments)
      continue
    }
    if (scanned) {
      // APPn between progressive scans: nothing a decoder needs.
      if (!(m === 0xe2 && startsWith(p, SIG.icc))) img.labels.add(LABEL.other)
      continue
    }
    switch (m) {
      case 0xe0:
        if (startsWith(p, SIG.jfif) && !img.jfif && p.length >= 14) {
          if (p.length > 14 || p[12] || p[13]) {
            const jfif = p.slice(0, 14)
            jfif[12] = 0
            jfif[13] = 0
            img.jfif = segment(0xe0, jfif)
            img.labels.add(LABEL.thumbnail)
          } else img.jfif = b.subarray(s.start, s.end)
        } else img.labels.add(startsWith(p, SIG.jfxx) ? LABEL.thumbnail : LABEL.other)
        break
      case 0xe1:
        if (startsWith(p, SIG.exif)) {
          const info = readExif(p.subarray(6))
          if (exifSeen || gainMap) {
            add(info.labels)
            addAll(img.values, info.values)
          } else if (info.labels.length === 0) {
            img.exif = b.subarray(s.start, s.end)
          } else {
            add(info.labels)
            addAll(img.values, info.values)
            const o = info.orientation
            if (o && o !== 1) img.exif = exifSegment(orientationTiff(o))
          }
          exifSeen = true
        } else if (startsWith(p, SIG.xmp)) {
          const text = fromUtf8(p.subarray(SIG.xmp.length))
          if (img.xmpText === null) img.xmpText = text
          add(xmpLabels(text))
          addAll(img.values, xmpValues(text))
        } else if (startsWith(p, SIG.xmpExt)) {
          // GUID(32) + full length(4) + offset(4), then a slice of the packet.
          const slice = fromUtf8(p.subarray(SIG.xmpExt.length + 40))
          const labels = xmpLabels(slice)
          add(labels.length ? labels : [LABEL.otherPhoto])
          addAll(img.values, xmpValues(slice))
        } else img.labels.add(LABEL.other)
        break
      case 0xe2:
        if (startsWith(p, SIG.icc)) img.icc.push(b.subarray(s.start, s.end))
        else if (startsWith(p, SIG.mpf)) img.mpf = img.mpf ?? readMpf(b, s)
        else if (startsWith(p, SIG.iso)) img.iso = img.iso ?? b.subarray(s.start, s.end)
        else img.labels.add(LABEL.other)
        break
      case 0xeb:
        // APP11 carries JUMBF boxes. A C2PA manifest (Content Credentials)
        // spans several segments, but only the first names itself "c2pa".
        app11 = true
        if (indexOf(p, 'c2pa') !== -1) c2pa = true
        break
      case 0xed:
        add(startsWith(p, SIG.photoshop) ? photoshop(p, img.values) : [LABEL.other])
        break
      case 0xee:
        if (startsWith(p, SIG.adobe) && !img.adobe) img.adobe = b.subarray(s.start, s.end)
        else img.labels.add(LABEL.other)
        break
      default:
        img.labels.add(LABEL.other)
    }
  }
  if (app11) img.labels.add(c2pa ? LABEL.c2pa : LABEL.other)
  return img
}

function head(img: Image, xmp: Uint8Array | null, mpf: Uint8Array | null): Uint8Array[] {
  const parts: Uint8Array[] = [new Uint8Array([0xff, SOI])]
  if (img.jfif) parts.push(img.jfif)
  if (img.exif) parts.push(img.exif)
  if (xmp) parts.push(xmp)
  parts.push(...img.icc)
  if (img.iso && (mpf || xmp)) parts.push(img.iso)
  if (mpf) parts.push(mpf)
  if (img.adobe) parts.push(img.adobe)
  parts.push(...img.rest, new Uint8Array([0xff, 0xd9]))
  return parts
}

// --- HDR gain maps (Ultra HDR / ISO 21496-1) -------------------------------

function declaresGainMap(img: Image): boolean {
  const x = img.xmpText ?? ''
  return img.iso !== null || /hdrgm:Version/.test(x) || /Semantic\s*(=\s*["']|>)\s*GainMap/.test(x)
}

function gainMapParams(img: Image): boolean {
  return img.iso !== null || /hdrgm:(GainMapMax|HDRCapacityMax|Version)/.test(img.xmpText ?? '')
}

/** Container directory items after the primary, as [semantic, length]. */
function containerItems(xmp: string): [string, number][] {
  const items: [string, number][] = []
  for (const m of xmp.matchAll(/<Container:Item\b([^>]*)>/g)) {
    const attr = (name: string) => new RegExp(`Item:${name}\\s*=\\s*["']([^"']*)`).exec(m[1])?.[1]
    items.push([attr('Semantic') ?? '', Number(attr('Length') ?? 0) + Number(attr('Padding') ?? 0)])
  }
  return items
}

/** Finds the gain-map JPEG in the trailer, by MPF first, then by the container directory. */
function findGainMap(b: Uint8Array, img: Image): { start: number; image: Image; entry: MpEntry | null } | null {
  const tryAt = (start: number) => {
    if (start < img.end || start + 4 > b.length || b[start] !== 0xff || b[start + 1] !== SOI) return null
    try {
      const gm = analyse(b, start, true)
      return gainMapParams(gm) ? gm : null
    } catch {
      return null
    }
  }
  if (img.mpf) {
    for (const e of img.mpf.entries.slice(1)) {
      if (!e.offset) continue
      const gm = tryAt(img.mpf.tiffStart + e.offset)
      if (gm) return { start: img.mpf.tiffStart + e.offset, image: gm, entry: e }
    }
  }
  if (img.xmpText) {
    const items = containerItems(img.xmpText)
    let at = img.end
    for (const [semantic, length] of items.slice(1)) {
      if (semantic === 'GainMap') {
        const gm = tryAt(at)
        return gm ? { start: at, image: gm, entry: null } : null
      }
      at += length
    }
  }
  return null
}

async function gainMapXmp(text: string): Promise<Uint8Array | null> {
  // Loaded only for gain maps: most photos never need an XML parser.
  const { parseXml, serializeXml } = await import('./xml.ts')
  const doc = parseXml(text.replace(/<\?xpacket[\s\S]*?\?>/g, '').trim())
  const attrs: string[] = []
  const children: string[] = []
  const descs = doc.getElementsByTagNameNS(NS.rdf, 'Description')
  for (let i = 0; i < descs.length; i++) {
    const d = descs[i]
    for (let k = 0; k < d.attributes.length; k++) {
      const a = d.attributes[k]
      if (a.namespaceURI === NS.hdrgm) attrs.push(`hdrgm:${a.localName}="${escapeAttr(a.value)}"`)
    }
    for (let c = d.firstChild; c; c = c.nextSibling) {
      const el = c as XmlElement
      if (c.nodeType === 1 && el.namespaceURI === NS.hdrgm) children.push(serializeXml(el))
    }
  }
  if (!attrs.length && !children.length) return null
  return xmpSegment(
    `<rdf:Description rdf:about="" xmlns:hdrgm="${NS.hdrgm}"${attrs.map((a) => ' ' + a).join('')}` +
      (children.length ? `>${children.join('')}</rdf:Description>` : '/>'),
  )
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

function xmpSegment(description: string): Uint8Array {
  const packet =
    `<x:xmpmeta xmlns:x="${NS.x}"><rdf:RDF xmlns:rdf="${NS.rdf}">` + description + `</rdf:RDF></x:xmpmeta>`
  return segment(0xe1, concat([ascii(SIG.xmp), utf8(packet)]))
}

/** The primary's XMP: only the gain-map version and the container directory. */
function primaryXmp(img: Image, gainMapLength: number): Uint8Array {
  const x = img.xmpText ?? ''
  const version = /hdrgm:Version\s*(?:=\s*["']|>)\s*([^"'<]*)/.exec(x)?.[1]
  const v = version !== undefined ? ` xmlns:hdrgm="${NS.hdrgm}" hdrgm:Version="${escapeAttr(version)}"` : ''
  return xmpSegment(
    `<rdf:Description rdf:about=""${v} xmlns:Container="${NS.container}" xmlns:Item="${NS.item}">` +
      `<Container:Directory><rdf:Seq>` +
      `<rdf:li rdf:parseType="Resource"><Container:Item Item:Semantic="Primary" Item:Mime="image/jpeg"/></rdf:li>` +
      `<rdf:li rdf:parseType="Resource"><Container:Item Item:Semantic="GainMap" Item:Mime="image/jpeg" Item:Length="${gainMapLength}"/></rdf:li>` +
      `</rdf:Seq></Container:Directory></rdf:Description>`,
  )
}

/** The gain-map JPEG with only its rendering metadata left. */
async function cleanGainMap(gm: Image): Promise<Uint8Array> {
  let xmp: Uint8Array | null = null
  if (gm.xmpText !== null) {
    xmp = await gainMapXmp(gm.xmpText)
    if (!xmp && !gm.iso) fail('the HDR gain map has no readable parameters')
  }
  const parts: Uint8Array[] = [new Uint8Array([0xff, SOI])]
  if (gm.jfif) parts.push(gm.jfif)
  if (xmp) parts.push(xmp)
  parts.push(...gm.icc)
  if (gm.iso) parts.push(gm.iso)
  if (gm.adobe) parts.push(gm.adobe)
  parts.push(...gm.rest, new Uint8Array([0xff, 0xd9]))
  return concat(parts)
}

// --- Entry points -----------------------------------------------------------

// Labels go by what is actually cut, not by what the metadata claims: an
// MPF index or "MotionPhoto" flag can outlive the data it describes.
function trailerLabels(b: Uint8Array, img: Image, keep: { start: number; end: number } | null, labels: Set<string>) {
  const ranges = keep ? [[img.end, keep.start], [keep.end, b.length]] : [[img.end, b.length]]
  // Further pictures the MPF index points at (previews, depth maps).
  const pictures = (img.mpf?.entries.slice(1) ?? [])
    .map((e) => (e.offset ? img.mpf!.tiffStart + e.offset : -1))
    .filter((at) => at >= img.end && at !== keep?.start && at + 3 <= b.length && b[at] === 0xff && b[at + 1] === SOI && b[at + 2] === 0xff)
  if (pictures.length) labels.add(LABEL.extraImages)
  for (const [from, to] of ranges) {
    if (to <= from) continue
    const cut = b.subarray(from, to)
    if (cut.every((v) => v === 0)) continue
    if (indexOf(cut, 'ftyp') !== -1 || indexOf(cut, 'MotionPhoto_Data') !== -1) labels.add(LABEL.motion)
    else if (!pictures.some((at) => at >= from && at < to)) labels.add(LABEL.trailing)
  }
}

export async function strip(b: Uint8Array): Promise<FormatOutcome> {
  const img = analyse(b, 0, false)
  const labels = img.labels
  let gm: { start: number; end: number; bytes: Uint8Array; entry: MpEntry | null } | null = null
  if (img.end < b.length && declaresGainMap(img)) {
    const found = findGainMap(b, img)
    if (found) {
      // A gain map with nothing to remove is kept byte for byte.
      for (const l of found.image.labels) labels.add(l)
      addAll(img.values, found.image.values)
      const bytes = found.image.labels.size ? await cleanGainMap(found.image) : b.slice(found.start, found.image.end)
      gm = { start: found.start, end: found.image.end, bytes, entry: found.entry }
    }
  }
  trailerLabels(b, img, gm, labels)
  if (labels.size === 0) return { status: 'unchanged' }

  if (!gm) return { status: 'cleaned', bytes: concat(head(img, null, null)), removed: [...labels], values: img.values }

  // Lay out the primary with placeholder MPF numbers, then fill them in.
  const primaryEntry: MpEntry = { attr: img.mpf?.entries[0]?.attr ?? 0x00030000, size: 0, offset: 0 }
  const gainEntry: MpEntry = { attr: gm.entry?.attr ?? 0, size: gm.bytes.length, offset: 0 }
  const xmp = img.xmpText !== null && (/hdrgm:/.test(img.xmpText) || /Container:/.test(img.xmpText)) ? primaryXmp(img, gm.bytes.length) : null
  const placeholder = mpfSegment(primaryEntry, gainEntry)
  const parts = head(img, xmp, placeholder)
  let mpfAt = 0
  for (const p of parts) {
    if (p === placeholder) break
    mpfAt += p.length
  }
  const primaryLength = parts.reduce((n, p) => n + p.length, 0)
  const tiffStart = mpfAt + 4 + SIG.mpf.length
  primaryEntry.size = primaryLength
  gainEntry.offset = primaryLength - tiffStart
  parts[parts.indexOf(placeholder)] = mpfSegment(primaryEntry, gainEntry)
  return { status: 'cleaned', bytes: concat([...parts, gm.bytes]), removed: [...labels], values: img.values }
}

export async function verify(b: Uint8Array): Promise<void> {
  const img = analyse(b, 0, false)
  if (img.labels.size) fail(`still holds: ${[...img.labels].join(', ')}`)
  if (img.end === b.length) {
    if (img.mpf) fail('MPF without a second image')
    return
  }
  // The only thing allowed after the image is the gain map the MPF points to.
  const found = img.mpf && declaresGainMap(img) ? findGainMap(b, img) : null
  if (!found || found.start !== img.end || found.image.end !== b.length) fail('unexpected data after the image')
  if (found.image.labels.size) fail(`the gain map still holds: ${[...found.image.labels].join(', ')}`)
  if (img.mpf!.entries.length !== 2 || img.mpf!.entries[0].size !== img.end || found.entry?.size !== b.length - img.end) {
    fail('MPF sizes are wrong')
  }
  const items = img.xmpText ? containerItems(img.xmpText) : []
  const gainItem = items.find(([s]) => s === 'GainMap')
  if (gainItem && gainItem[1] !== b.length - img.end) fail('container length is wrong')
  if (img.xmpText && !onlyRendering(img.xmpText)) fail('XMP holds more than gain-map data')
}
