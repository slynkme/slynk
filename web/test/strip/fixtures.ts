// Synthetic test files, built in code. Every value is invented: "Example
// Author", "ExampleCam X1", a location near 12.34° N, 56.78° E, and dates in
// June 2024 (UTC). No real photos or documents are involved.
import { zlibSync } from 'fflate'
import { crc32 } from '../../src/strip/bytes.ts'

export type Part = Uint8Array | number[] | string

/** Joins parts; strings are written one byte per character (Latin-1). */
export function cat(...parts: Part[]): Uint8Array {
  const arrays = parts.map((p) =>
    typeof p === 'string' ? Uint8Array.from(p, (c) => c.charCodeAt(0) & 0xff) : p instanceof Uint8Array ? p : Uint8Array.from(p),
  )
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0))
  let i = 0
  for (const a of arrays) {
    out.set(a, i)
    i += a.length
  }
  return out
}

export const be16 = (v: number) => [(v >> 8) & 255, v & 255]
export const be32 = (v: number) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]
export const le16 = (v: number) => [v & 255, (v >> 8) & 255]
export const le32 = (v: number) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255]
export const utf8 = (s: string) => new TextEncoder().encode(s)
export const text = (b: Uint8Array) => new TextDecoder().decode(b)
export const latin1 = (b: Uint8Array) => String.fromCharCode(...b)

export function contains(b: Uint8Array, s: string): boolean {
  return Buffer.from(b).includes(Buffer.from(s, 'latin1'))
}

// --- TIFF / EXIF ------------------------------------------------------------

export interface Tag {
  tag: number
  type: number // 1 BYTE, 2 ASCII, 3 SHORT, 4 LONG, 5 RATIONAL, 7 UNDEFINED
  value: string | number[] | Uint8Array
}

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1 }

function tagBytes(t: Tag): Uint8Array {
  if (t.type === 2) return cat(t.value as string, [0])
  if (t.value instanceof Uint8Array) return t.value
  const v = t.value as number[]
  if (t.type === 1 || t.type === 7) return Uint8Array.from(v)
  if (t.type === 3) return cat(...v.map(be16))
  if (t.type === 4) return cat(...v.map(be32))
  return cat(...v.map(be32)) // RATIONAL: numerator, denominator pairs
}

function tagCount(t: Tag, data: Uint8Array): number {
  return data.length / TYPE_SIZE[t.type]
}

/** A big-endian TIFF block with optional Exif, GPS and IFD1 (thumbnail) directories. */
export function tiff(ifd0: Tag[], sub: { exif?: Tag[]; gps?: Tag[]; ifd1?: Tag[]; thumbnail?: Uint8Array } = {}): Uint8Array {
  const dirs: { tags: Tag[]; key: string }[] = [{ tags: [...ifd0], key: 'ifd0' }]
  if (sub.exif) dirs[0].tags.push({ tag: 0x8769, type: 4, value: [0] })
  if (sub.gps) dirs[0].tags.push({ tag: 0x8825, type: 4, value: [0] })
  if (sub.exif) dirs.push({ tags: sub.exif, key: 'exif' })
  if (sub.gps) dirs.push({ tags: sub.gps, key: 'gps' })
  if (sub.ifd1) {
    const t = [...sub.ifd1]
    if (sub.thumbnail) t.push({ tag: 0x0201, type: 4, value: [0] }, { tag: 0x0202, type: 4, value: [sub.thumbnail.length] })
    dirs.push({ tags: t, key: 'ifd1' })
  }
  for (const d of dirs) d.tags.sort((a, b) => a.tag - b.tag)
  // Lay out: header, then each directory followed by its out-of-line data.
  const sizes = dirs.map((d) => 2 + d.tags.length * 12 + 4 + d.tags.reduce((n, t) => {
    const len = tagBytes(t).length
    return n + (len > 4 ? len + (len & 1) : 0)
  }, 0))
  const offsets: Record<string, number> = {}
  let at = 8
  dirs.forEach((d, i) => {
    offsets[d.key] = at
    at += sizes[i]
  })
  const thumbAt = at
  const out: Uint8Array[] = [Uint8Array.from([0x4d, 0x4d, 0, 42, ...be32(8)])]
  dirs.forEach((d, i) => {
    const start = offsets[d.key]
    let dataAt = start + 2 + d.tags.length * 12 + 4
    const head: Part[] = [be16(d.tags.length)]
    const data: Part[] = []
    for (const t of d.tags) {
      let value = tagBytes(t)
      if (t.tag === 0x8769) value = Uint8Array.from(be32(offsets.exif))
      if (t.tag === 0x8825) value = Uint8Array.from(be32(offsets.gps))
      if (t.tag === 0x0201) value = Uint8Array.from(be32(thumbAt))
      head.push(be16(t.tag), be16(t.type), be32(tagCount(t, value)))
      if (value.length <= 4) head.push(cat(value, new Uint8Array(4 - value.length)))
      else {
        head.push(be32(dataAt))
        data.push(value, value.length & 1 ? [0] : [])
        dataAt += value.length + (value.length & 1)
      }
    }
    const next = d.key === 'ifd0' && sub.ifd1 ? offsets.ifd1 : 0
    head.push(be32(next))
    out.push(cat(...head, ...data))
  })
  if (sub.thumbnail) out.push(sub.thumbnail)
  return cat(...out)
}

/** EXIF a phone might write: camera, dates, GPS near 12.34° N 56.78° E, maker notes, a thumbnail. */
export function phoneExif(orientation = 6): Uint8Array {
  return tiff(
    [
      { tag: 0x010f, type: 2, value: 'ExampleCam' },
      { tag: 0x0110, type: 2, value: 'ExampleCam X1' },
      { tag: 0x0112, type: 3, value: [orientation] },
      { tag: 0x011a, type: 5, value: [72, 1] },
      { tag: 0x011b, type: 5, value: [72, 1] },
      { tag: 0x0128, type: 3, value: [2] },
      { tag: 0x0131, type: 2, value: 'ExampleOS 1.0' },
      { tag: 0x0132, type: 2, value: '2024:06:12 18:30:45' },
    ],
    {
      exif: [
        { tag: 0x829a, type: 5, value: [1, 100] },
        { tag: 0x9003, type: 2, value: '2024:06:12 18:30:45' },
        { tag: 0x927c, type: 7, value: utf8('EXAMPLEMAKERNOTE-0123456789') },
        { tag: 0xa001, type: 3, value: [1] },
        { tag: 0xa431, type: 2, value: 'SN-EXAMPLE-0001' },
      ],
      gps: [
        { tag: 0x0000, type: 1, value: [2, 3, 0, 0] },
        { tag: 0x0001, type: 2, value: 'N' },
        { tag: 0x0002, type: 5, value: [12, 1, 20, 1, 2400, 100] },
        { tag: 0x0003, type: 2, value: 'E' },
        { tag: 0x0004, type: 5, value: [56, 1, 46, 1, 4800, 100] },
      ],
      ifd1: [{ tag: 0x0103, type: 3, value: [6] }],
      thumbnail: grayJpeg(),
    },
  )
}

// --- JPEG -------------------------------------------------------------------

export function seg(marker: number, payload: Part): Uint8Array {
  const p = cat(payload)
  return cat([0xff, marker], be16(p.length + 2), p)
}

/** Quantisation and Huffman tables, an 8x8 grey frame, and one scan: a real, decodable JPEG body. */
export function jpegCore(): Uint8Array {
  return cat(
    seg(0xdb, cat([0x00], new Array(64).fill(1))),
    seg(0xc0, [8, ...be16(8), ...be16(8), 1, 1, 0x11, 0]),
    seg(0xc4, cat([0x00, 1], new Array(15).fill(0), [0x00])),
    seg(0xc4, cat([0x10, 1], new Array(15).fill(0), [0x00])),
    seg(0xda, [1, 1, 0x00, 0, 63, 0]),
    [0x3f],
  )
}

export function grayJpeg(...app: Uint8Array[]): Uint8Array {
  return cat([0xff, 0xd8], ...app, jpegCore(), [0xff, 0xd9])
}

export const exifApp1 = (t: Uint8Array) => seg(0xe1, cat('Exif\0\0', t))
export const xmpApp1 = (x: string) => seg(0xe1, cat('http://ns.adobe.com/xap/1.0/\0', utf8(x)))
export const jfifApp0 = (thumb = 0) => seg(0xe0, cat('JFIF\0', [1, 2, 0, 0, 1, 0, 1, thumb, thumb], new Array(thumb * thumb * 3).fill(7)))
export const iccProfile = () => cat(be32(132), 'exam', [2, 0x10, 0, 0], 'mntrRGB XYZ ', new Array(12).fill(0), 'acsp', new Array(96).fill(0))
export const iccApp2 = () => seg(0xe2, cat('ICC_PROFILE\0', [1, 1], iccProfile()))
export const adobeApp14 = () => seg(0xee, cat('Adobe', [0, 100, 0, 0, 0, 0, 1]))

export function xmpPacket(body: string, ns = ''): string {
  return (
    '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>' +
    '<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Example XMP Core 1.0"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
    `<rdf:Description rdf:about=""${ns}>${body}</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`
  )
}

export const PRIVATE_XMP = xmpPacket(
  '<dc:creator><rdf:Seq><rdf:li>Example Author</rdf:li></rdf:Seq></dc:creator><xmp:CreatorTool>ExampleEditor 2.0</xmp:CreatorTool>' +
    '<exif:GPSLatitude>12,20.4N</exif:GPSLatitude><xmpMM:History>edited</xmpMM:History>',
  ' xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:exif="http://ns.adobe.com/exif/1.0/" xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/"',
)

/** A fake MP4 video, as a motion photo appends after the picture. */
export function fakeVideo(): Uint8Array {
  return cat(be32(24), 'ftypmp42', be32(0), 'isommp42', be32(16), 'mdat', 'VIDEOFRAMES!')
}

function mpf(entries: [number, number, number][]): Uint8Array {
  const n = entries.length
  return seg(
    0xe2,
    cat(
      'MPF\0',
      [0x4d, 0x4d, 0, 42, ...be32(8)],
      be16(3),
      [0xb0, 0, 0, 7, ...be32(4), 0x30, 0x31, 0x30, 0x30],
      [0xb0, 1, 0, 4, ...be32(1), ...be32(n)],
      [0xb0, 2, 0, 7, ...be32(16 * n), ...be32(50)],
      be32(0),
      ...entries.map(([attr, size, offset]) => cat(be32(attr), be32(size), be32(offset), [0, 0, 0, 0])),
    ),
  )
}

export const GAIN_MAP_PARAMS =
  'hdrgm:Version="1.0" hdrgm:GainMapMin="0" hdrgm:GainMapMax="2.3" hdrgm:Gamma="1" hdrgm:OffsetSDR="0" ' +
  'hdrgm:OffsetHDR="0" hdrgm:HDRCapacityMin="0" hdrgm:HDRCapacityMax="2.3" hdrgm:BaseRenditionIsHDR="False"'

/**
 * An Ultra HDR motion photo: a primary JPEG with private EXIF/XMP, an MPF
 * index and a container directory; a gain-map JPEG with its own EXIF; then a
 * motion-photo video.
 */
export function ultraHdrMotionPhoto(): { bytes: Uint8Array; gainMapCore: Uint8Array } {
  const gainMapCore = jpegCore()
  const gainMap = cat(
    [0xff, 0xd8],
    exifApp1(tiff([{ tag: 0x0110, type: 2, value: 'ExampleCam X1' }])),
    xmpApp1(
      xmpPacket(
        '<xmp:CreatorTool>ExampleCamera App</xmp:CreatorTool>',
        ` xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" ${GAIN_MAP_PARAMS}`,
      ),
    ),
    gainMapCore,
    [0xff, 0xd9],
  )
  const video = fakeVideo()
  const primaryXmp = xmpApp1(
    xmpPacket(
      '<Container:Directory><rdf:Seq>' +
        '<rdf:li rdf:parseType="Resource"><Container:Item Item:Semantic="Primary" Item:Mime="image/jpeg"/></rdf:li>' +
        `<rdf:li rdf:parseType="Resource"><Container:Item Item:Semantic="GainMap" Item:Mime="image/jpeg" Item:Length="${gainMap.length}"/></rdf:li>` +
        `<rdf:li rdf:parseType="Resource"><Container:Item Item:Semantic="MotionPhoto" Item:Mime="video/mp4" Item:Length="${video.length}" Item:Padding="0"/></rdf:li>` +
        '</rdf:Seq></Container:Directory><dc:creator><rdf:Seq><rdf:li>Example Author</rdf:li></rdf:Seq></dc:creator>',
      ' xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/" xmlns:Container="http://ns.google.com/photos/1.0/container/"' +
        ' xmlns:Item="http://ns.google.com/photos/1.0/container/item/" xmlns:GCamera="http://ns.google.com/photos/1.0/camera/"' +
        ' xmlns:dc="http://purl.org/dc/elements/1.1/" hdrgm:Version="1.0" GCamera:MotionPhoto="1"',
    ),
  )
  const build = (primaryLen: number) => {
    const before = cat([0xff, 0xd8], exifApp1(phoneExif(6)), primaryXmp, iccApp2())
    const tiffStart = before.length + 8
    return cat(before, mpf([[0x00030000, primaryLen, 0], [0, gainMap.length, primaryLen - tiffStart]]), jpegCore(), [0xff, 0xd9])
  }
  const primary = build(build(0).length)
  return { bytes: cat(primary, gainMap, video), gainMapCore }
}

export const ISO_GAIN_MAP_VERSION = seg(0xe2, cat('urn:iso:std:iso:ts:21496:-1\0', [0, 0, 0, 0]))
export const ISO_GAIN_MAP_PARAMS = seg(0xe2, cat('urn:iso:std:iso:ts:21496:-1\0', [0, 0, 0, 0, 0x80, 1, 2, 3, 4, 5, 6, 7]))

/** A primary JPEG and a gain map linked only by MPF, with the gain map described by `gainMapApps`. */
export function mpfGainMap(primaryApps: Uint8Array[], gainMapApps: Uint8Array[]): Uint8Array {
  const gainMap = cat([0xff, 0xd8], ...gainMapApps, jpegCore(), [0xff, 0xd9])
  const build = (primaryLen: number) => {
    const before = cat([0xff, 0xd8], exifApp1(phoneExif(1)), ...primaryApps)
    const tiffStart = before.length + 8
    return cat(before, mpf([[0x00030000, primaryLen, 0], [0, gainMap.length, primaryLen - tiffStart]]), jpegCore(), [0xff, 0xd9])
  }
  return cat(build(build(0).length), gainMap)
}

/** Reads JPEG marker segments up to the first scan (test-side, independent of the stripper). */
export function jpegSegments(b: Uint8Array, start = 0): { marker: number; payload: Uint8Array; start: number }[] {
  const out = []
  let i = start + 2
  while (i < b.length) {
    const marker = b[i + 1]
    const len = (b[i + 2] << 8) | b[i + 3]
    out.push({ marker, payload: b.subarray(i + 4, i + 2 + len), start: i })
    if (marker === 0xda) break
    i += 2 + len
  }
  return out
}

// --- PNG --------------------------------------------------------------------

export function pngChunk(type: string, data: Part): Uint8Array {
  const d = cat(data)
  const body = cat(type, d)
  return cat(be32(d.length), body, be32(crc32(body)))
}

export const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
export const ihdr = () => pngChunk('IHDR', [...be32(1), ...be32(1), 8, 0, 0, 0, 0])
export const idat = () => pngChunk('IDAT', zlibSync(Uint8Array.from([0, 128])))

function hexProfile(t: Uint8Array): string {
  const hex = Buffer.from(cat('Exif\0\0', t)).toString('hex')
  return `\nexif\n${String(hex.length / 2).padStart(8)}\n${hex.match(/.{1,72}/g)!.join('\n')}\n`
}

export function privatePng(): Uint8Array {
  return cat(
    PNG_SIG,
    ihdr(),
    pngChunk('iCCP', cat('Example ICC\0', [0], zlibSync(iccProfile()))),
    pngChunk('gAMA', be32(45455)),
    pngChunk('eXIf', phoneExif(6)),
    pngChunk('tEXt', 'Author\0Example Author'),
    pngChunk('zTXt', cat('Raw profile type exif\0', [0], zlibSync(utf8(hexProfile(phoneExif(1)))))),
    pngChunk('iTXt', cat('XML:com.adobe.xmp\0', [0, 0], '\0\0', utf8(PRIVATE_XMP))),
    pngChunk('tEXt', 'parameters\0an example prompt'),
    pngChunk('tIME', [0x07, 0xe8, 6, 12, 18, 30, 45]),
    pngChunk('caBX', 'c2pa manifest bytes'),
    pngChunk('prVt', 'private data'),
    idat(),
    pngChunk('IEND', []),
    'TRAILING-SECRET',
  )
}

export function animatedPng(): Uint8Array {
  const fctl = (seq: number) => pngChunk('fcTL', [...be32(seq), ...be32(1), ...be32(1), ...be32(0), ...be32(0), 0, 1, 0, 10, 0, 0])
  return cat(
    PNG_SIG,
    ihdr(),
    pngChunk('acTL', [...be32(2), ...be32(0)]),
    fctl(0),
    idat(),
    pngChunk('tEXt', 'Comment\0an example comment'),
    fctl(1),
    pngChunk('fdAT', cat(be32(2), zlibSync(Uint8Array.from([0, 64])))),
    pngChunk('IEND', []),
  )
}

// --- WebP -------------------------------------------------------------------

export function riffChunk(id: string, data: Part): Uint8Array {
  const d = cat(data)
  return cat(id, le32(d.length), d, d.length & 1 ? [0] : [])
}

export function webp(chunks: Uint8Array[], trailing: Part = []): Uint8Array {
  const body = cat(...chunks)
  return cat('RIFF', le32(4 + body.length), 'WEBP', body, trailing)
}

export function vp8x(flags: number): Uint8Array {
  return riffChunk('VP8X', [flags, 0, 0, 0, 0, 0, 0, 0, 0, 0])
}

export const fakeVp8l = () => riffChunk('VP8L', [0x2f, 0, 0, 0, 0x10, 0x07, 0x10, 0x11, 0x11, 0x88, 0x88, 0xfe, 0x07, 0x00])

export function privateWebp(): Uint8Array {
  return webp(
    [
      vp8x(0x20 | 0x10 | 0x08 | 0x04),
      riffChunk('ICCP', iccProfile()),
      riffChunk('ALPH', [0, 1, 2]),
      fakeVp8l(),
      riffChunk('EXIF', phoneExif(8)),
      riffChunk('XMP ', utf8(PRIVATE_XMP)),
      riffChunk('C2PA', 'manifest'),
      riffChunk('ZZZZ', 'unknown'),
    ],
    'TRAILING',
  )
}

export function animatedWebp(): Uint8Array {
  const frame = (n: number) => riffChunk('ANMF', cat(new Array(16).fill(n), fakeVp8l()))
  return webp([
    vp8x(0x02 | 0x08),
    riffChunk('ANIM', [0, 0, 0, 0, 0, 0]),
    frame(1),
    frame(2),
    riffChunk('EXIF', cat('Exif\0\0', phoneExif(1))),
  ])
}

// --- GIF --------------------------------------------------------------------

export function subBlocks(data: Part): Uint8Array {
  const d = cat(data)
  const out: Part[] = []
  for (let i = 0; i < d.length; i += 255) {
    const piece = d.subarray(i, i + 255)
    out.push([piece.length], piece)
  }
  return cat(...out, [0])
}

export function gifFrame(color: number): Uint8Array {
  const gce = cat([0x21, 0xf9, 4, 0x04, 10, 0, 0, 0])
  const image = cat([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0], [2], subBlocks([0x44, color, 0x05]))
  return cat(gce, image)
}

export function privateGif(): Uint8Array {
  const xmpMagic = cat([1], Array.from({ length: 256 }, (_, i) => 255 - i), [0])
  return cat(
    'GIF89a',
    [1, 0, 1, 0, 0x80, 0, 0],
    [0, 0, 0, 255, 255, 255],
    cat([0x21, 0xff, 11], 'NETSCAPE2.0', [3, 1, 0, 0, 0]),
    cat([0x21, 0xfe], subBlocks('Example comment by Example Author')),
    cat([0x21, 0xff, 11], 'XMP DataXMP', utf8(PRIVATE_XMP), xmpMagic),
    gifFrame(1),
    gifFrame(2),
    cat([0x21, 0xff, 11], 'C2PA_GIF\0\0\0', subBlocks('manifest')),
    [0x3b],
    'TRAILING',
  )
}

// --- HEIC / AVIF ------------------------------------------------------------

export function box(type: string, ...body: Part[]): Uint8Array {
  const b = cat(...body)
  return cat(be32(8 + b.length), type, b)
}

export const fullBox = (type: string, version: number, flags: number, ...body: Part[]) =>
  box(type, [version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255], ...body)

export const C2PA_UUID = 'd8fec3d61b0e483c92975828877ec481'

/**
 * A HEIF still: an image item in mdat, an Exif item in idat (construction
 * method 1), an XMP item in mdat, irot and udes properties, a C2PA uuid box
 * and a trailing motion-photo 'mpvd' box.
 */
export function heif(brand: 'heic' | 'avif'): { bytes: Uint8Array; image: Uint8Array } {
  const codec = brand === 'heic' ? 'hvc1' : 'av01'
  const image = utf8('IMAGE-BITSTREAM-' + codec)
  const exif = cat(be32(6), 'Exif\0\0', phoneExif(1))
  const xmp = utf8(PRIVATE_XMP)
  const build = (imageAt: number, xmpAt: number) => {
    const infe = (id: number, type: string, extra: Part = []) => fullBox('infe', 2, 0, be16(id), be16(0), type, '\0', extra)
    const iinf = fullBox('iinf', 0, 0, be16(3), infe(1, codec), infe(2, 'Exif'), infe(3, 'mime', 'application/rdf+xml\0'))
    // iloc v1: offset 4, length 4, base 0, index 0.
    const loc = (id: number, method: number, off: number, len: number) => cat(be16(id), be16(method), be16(0), be16(1), be32(off), be32(len))
    const iloc = fullBox('iloc', 1, 0, [0x44, 0x00], be16(3), loc(1, 0, imageAt, image.length), loc(2, 1, 0, exif.length), loc(3, 0, xmpAt, xmp.length))
    const udes = fullBox('udes', 0, 0, 'en\0Example title\0Example description\0example,tags\0')
    const ipco = box('ipco', box('irot', [1]), udes)
    const ipma = fullBox('ipma', 0, 0, be32(1), be16(1), [2, 0x81, 0x02])
    const meta = fullBox(
      'meta', 0, 0,
      fullBox('hdlr', 0, 0, be32(0), 'pict', new Array(12).fill(0), '\0'),
      fullBox('pitm', 0, 0, be16(1)),
      iinf,
      iloc,
      box('iprp', ipco, ipma),
      box('idat', exif),
    )
    const ftyp = box('ftyp', brand, be32(0), 'mif1', brand, 'miaf')
    const uuid = box('uuid', Buffer.from(C2PA_UUID, 'hex'), 'c2pa manifest store')
    const mdatStart = ftyp.length + meta.length + uuid.length + 8
    const mdat = box('mdat', image, xmp)
    const mpvd = box('mpvd', fakeVideo())
    return { bytes: cat(ftyp, meta, uuid, mdat, mpvd), mdatStart }
  }
  const first = build(0, 0)
  return { bytes: build(first.mdatStart, first.mdatStart + image.length).bytes, image }
}

// --- Audio ------------------------------------------------------------------

function syncsafe(n: number): number[] {
  return [(n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127]
}

export function id3v2(frames: [string, Part][]): Uint8Array {
  const body = cat(...frames.map(([id, data]) => {
    const d = cat(data)
    return cat(id, be32(d.length), [0, 0], d)
  }), new Array(32).fill(0))
  return cat('ID3', [3, 0, 0], syncsafe(body.length), body)
}

export const PRIVATE_ID3: [string, Part][] = [
  ['TIT2', '\0Example Title'],
  ['TPE1', '\0Example Artist'],
  ['TDRC', '\x002024-06-12'],
  ['APIC', cat('\0image/jpeg\0', [3], 'cover\0', grayJpeg())],
  ['COMM', '\0eng\0An example comment'],
  ['PRIV', 'example.owner\0secret-id'],
]

/** MPEG-1 Layer III, 128 kbit/s, 44.1 kHz: 417-byte frames. The first one holds a LAME "Info" header. */
export function mpegFrames(n: number): Uint8Array {
  const frames: Uint8Array[] = []
  for (let i = 0; i < n; i++) {
    const f = new Uint8Array(417)
    f.set([0xff, 0xfb, 0x90, 0x00])
    if (i === 0) f.set(utf8('Info'), 36)
    else f.fill(i, 4)
    frames.push(f)
  }
  return cat(...frames)
}

export function apeTag(): Uint8Array {
  const item = cat(le32(13), le32(0), 'Artist\0', 'Example Artist')
  const size = item.length + 32
  const header = (isHeader: boolean) => cat('APETAGEX', le32(2000), le32(size), le32(1), le32(0x80000000 | (isHeader ? 0x20000000 : 0)), new Array(8).fill(0))
  return cat(header(true), item, header(false))
}

export function id3v1(): Uint8Array {
  const pad = (s: string, n: number) => s.padEnd(n, '\0')
  return cat('TAG', pad('Example Title', 30), pad('Example Artist', 30), pad('Example Album', 30), '2024', pad('', 30), [12])
}

export function privateMp3(): Uint8Array {
  return cat(id3v2(PRIVATE_ID3), mpegFrames(6), apeTag(), id3v1())
}

export function flacBlock(type: number, data: Part, last = false): Uint8Array {
  const d = cat(data)
  return cat([(last ? 0x80 : 0) | type, (d.length >> 16) & 255, (d.length >> 8) & 255, d.length & 255], d)
}

export const STREAMINFO = cat(be16(4096), be16(4096), [0, 0, 16], [0, 0, 32], [0x0a, 0xc4, 0x42, 0xf0, 0, 0, 0x10, 0], new Array(16).fill(0xab))
export const SEEKTABLE = cat(new Array(8).fill(0), new Array(8).fill(0), be16(4096))
export const FLAC_FRAMES = cat([0xff, 0xf8, 0x69, 0x08, 0x00, 0x0f], new Array(200).fill(0x5a), [0xff, 0xf8, 0x69, 0x08, 0x01], new Array(100).fill(0x3c))

export function vorbisComment(vendor: string, entries: string[]): Uint8Array {
  return cat(le32(vendor.length), vendor, le32(entries.length), ...entries.map((e) => cat(le32(utf8(e).length), utf8(e))))
}

export function privateFlac(): Uint8Array {
  return cat(
    'fLaC',
    flacBlock(0, STREAMINFO),
    flacBlock(3, SEEKTABLE),
    flacBlock(4, vorbisComment('reference libFLAC 1.4.3 20230623', ['TITLE=Example Title', 'ARTIST=Example Artist', 'DATE=2024-06-12', 'COMMENT=Example'])),
    flacBlock(6, cat(be32(3), be32(10), 'image/jpeg', be32(0), be32(1), be32(1), be32(24), be32(0), be32(4), 'JPEG')),
    flacBlock(1, new Array(64).fill(0), true),
    FLAC_FRAMES,
  )
}
