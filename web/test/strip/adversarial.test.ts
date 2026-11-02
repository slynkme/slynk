// Metadata hidden in unusual places, files that look like one type but are
// another, and claims the "Removed: ..." list must not make. Every value is
// invented (see fixtures.ts).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { unzipSync } from 'fflate'
import { PDFDocument, PDFName, PDFString } from 'pdf-lib'
import { stripBytes } from '../../src/strip/engine.ts'
import { IN_PICTURES, LABEL } from '../../src/strip/labels.ts'
import { suggestNeutralName } from '../../src/strip/names.ts'
import { describeOther, detectKind } from '../../src/strip/sniff.ts'
import { SKIP } from '../../src/strip/types.ts'
import { parseXml, textOf } from '../../src/strip/xml.ts'
import { docx, odf, xlsx, zip } from './docfixtures.ts'
import {
  GAIN_MAP_PARAMS,
  PRIVATE_XMP,
  be16,
  be32,
  box,
  cat,
  contains,
  exifApp1,
  fakeVideo,
  fullBox,
  grayJpeg,
  heif,
  idat,
  ihdr,
  jpegCore,
  jpegSegments,
  phoneExif,
  PNG_SIG,
  pngChunk,
  seg,
  text,
  tiff,
  utf8,
  xmpApp1,
  xmpPacket,
} from './fixtures.ts'

async function clean(b: Uint8Array, opts = {}) {
  const r = await stripBytes(b, opts)
  assert.equal(r.status, 'cleaned', JSON.stringify(r).slice(0, 300))
  if (r.status !== 'cleaned') throw new Error()
  // Everything cleaned must come back clean, and cleaning is repeatable.
  assert.equal((await stripBytes(r.bytes, opts)).status, 'unchanged')
  const again = await stripBytes(b, opts)
  assert.ok(again.status === 'cleaned' && Buffer.from(again.bytes).equals(Buffer.from(r.bytes)), 'not deterministic')
  return r
}

const parts = (b: Uint8Array) => Object.fromEntries(Object.entries(unzipSync(b)).map(([k, v]) => [k, text(v)]))

// --- JPEG ---------------------------------------------------------------------

/** An MPF segment listing [attributes, size, offset] entries (offsets from the MPF's TIFF header). */
function mpfSegment(entries: [number, number, number][]): Uint8Array {
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

/** A primary JPEG whose MPF lists `after` (JPEGs appended in order); returns the whole file. */
function withMpf(primaryApps: Uint8Array[], after: Uint8Array[]): Uint8Array {
  const build = (primaryLen: number) => {
    const before = cat([0xff, 0xd8], ...primaryApps)
    const tiffStart = before.length + 8
    let at = primaryLen
    const entries: [number, number, number][] = [[0x00030000, primaryLen, 0]]
    for (const a of after) {
      entries.push([0, a.length, at - tiffStart])
      at += a.length
    }
    return cat(before, mpfSegment(entries), jpegCore(), [0xff, 0xd9])
  }
  return cat(build(build(0).length), ...after)
}

const HDRGM = ' xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/"'

test('JPEG: C2PA spread over several APP11 segments is one "content credentials"', async () => {
  // JUMBF: the first segment names the manifest store "c2pa"; continuations don't.
  const first = seg(0xeb, cat('JP', [0, 1], be32(1), be32(60), 'jumb', be32(17), 'jumd', 'c2pa', [0, 0, 0, 0, 0], 'Example signer'))
  const more = seg(0xeb, cat('JP', [0, 1], be32(2), be32(60), 'jumb', 'Example Author claim'))
  const r = await clean(grayJpeg(first, more))
  assert.deepEqual(r.removed, [LABEL.c2pa])
  assert.ok(!contains(r.bytes, 'Example'))
  assert.ok(!jpegSegments(r.bytes).some((s) => s.marker === 0xeb))
})

test('JPEG: JUMBF that is not C2PA is not called content credentials', async () => {
  const other = seg(0xeb, cat('JP', [0, 1], be32(1), be32(30), 'jumb', be32(22), 'jumd', 'Example 360 data'))
  const r = await clean(grayJpeg(other))
  assert.deepEqual(r.removed, [LABEL.other])
})

test('JPEG: Google motion photo (XMP plus appended MP4) loses the video; a stale flag claims nothing', async () => {
  const xmp = xmpApp1(
    xmpPacket(
      '<Container:Directory><rdf:Seq><rdf:li rdf:parseType="Resource"><Container:Item Item:Semantic="Primary" Item:Mime="image/jpeg"/></rdf:li>' +
        `<rdf:li rdf:parseType="Resource"><Container:Item Item:Semantic="MotionPhoto" Item:Mime="video/mp4" Item:Length="${fakeVideo().length}"/></rdf:li></rdf:Seq></Container:Directory>`,
      ' xmlns:GCamera="http://ns.google.com/photos/1.0/camera/" xmlns:Container="http://ns.google.com/photos/1.0/container/" xmlns:Item="http://ns.google.com/photos/1.0/container/item/" GCamera:MotionPhoto="1"',
    ),
  )
  const r = await clean(cat(grayJpeg(exifApp1(phoneExif(1)), xmp), fakeVideo()))
  assert.deepEqual(r.bytes, grayJpeg())
  assert.ok(r.removed.includes(LABEL.motion) && r.removed.includes(LABEL.gps))
  // The flag says "motion photo" but there is no video: only a trailer was cut.
  const stale = xmpApp1(xmpPacket('', ' xmlns:GCamera="http://ns.google.com/photos/1.0/camera/" GCamera:MotionPhoto="0"'))
  const s = await clean(cat(grayJpeg(stale), 'EXAMPLE TRAILER'))
  assert.ok(!s.removed.includes(LABEL.motion), s.removed.join())
  assert.ok(s.removed.includes(LABEL.trailing))
})

test('JPEG: Samsung trailer with an embedded video is cut', async () => {
  const trailer = cat('MotionPhoto_Data', fakeVideo(), 'SEFHexample', be32(0), 'SEFT')
  const r = await clean(cat(grayJpeg(), trailer))
  assert.deepEqual(r.bytes, grayJpeg())
  assert.deepEqual(r.removed, [LABEL.motion])
})

test('JPEG: Ultra HDR keeps the gain map, cuts an extra preview, and strips GPS from both images', async () => {
  const gainMap = cat([0xff, 0xd8], exifApp1(phoneExif(1)), xmpApp1(xmpPacket('', `${HDRGM} ${GAIN_MAP_PARAMS}`)), jpegCore(), [0xff, 0xd9])
  const preview = grayJpeg(exifApp1(tiff([{ tag: 0x0110, type: 2, value: 'ExampleCam X1 preview' }])))
  const input = withMpf([exifApp1(phoneExif(6)), xmpApp1(xmpPacket('', `${HDRGM} hdrgm:Version="1.0"`))], [gainMap, preview])
  const r = await clean(input)
  assert.ok(!contains(r.bytes, 'ExampleCam'))
  assert.ok(r.removed.includes(LABEL.extraImages) && r.removed.includes(LABEL.gps))
  assert.ok(!r.removed.includes(LABEL.trailing))
  // Primary, then exactly one gain map holding its parameters.
  const segs = jpegSegments(r.bytes)
  const mpf = segs.find((s) => s.marker === 0xe2 && text(s.payload.subarray(0, 4)) === 'MPF\0')!
  const dv = new DataView(mpf.payload.buffer, mpf.payload.byteOffset + 4)
  assert.equal(dv.getUint32(30), 2) // NumberOfImages
  const primarySize = dv.getUint32(54)
  const gm = r.bytes.subarray(primarySize)
  assert.equal(primarySize + dv.getUint32(54 + 16), r.bytes.length)
  assert.ok(text(gm).includes('hdrgm:GainMapMax="2.3"'))
  // Orientation 6 survives on the primary.
  const exif = segs.find((s) => s.marker === 0xe1 && text(s.payload.subarray(0, 4)) === 'Exif')!
  assert.ok(Buffer.from(exif.payload).includes(Buffer.from([0x01, 0x12, 0x00, 0x03, 0, 0, 0, 1, 0, 6])))
})

test('JPEG: an MPF index whose images are gone claims no extra images', async () => {
  const input = cat([0xff, 0xd8], exifApp1(phoneExif(1)), mpfSegment([[0x00030000, 1000, 0], [0, 500, 900]]), jpegCore(), [0xff, 0xd9])
  const r = await clean(input)
  assert.ok(!r.removed.includes(LABEL.extraImages), r.removed.join())
  assert.ok(!jpegSegments(r.bytes).some((s) => s.marker === 0xe2))
})

test('JPEG: Orientation written as a LONG still survives', async () => {
  const t = tiff([{ tag: 0x0110, type: 2, value: 'ExampleCam X1' }, { tag: 0x0112, type: 4, value: [8] }])
  const r = await clean(grayJpeg(exifApp1(t)))
  const exif = jpegSegments(r.bytes).find((s) => s.marker === 0xe1)!
  assert.ok(Buffer.from(exif.payload).includes(Buffer.from([0x01, 0x12, 0x00, 0x03, 0, 0, 0, 1, 0, 8])))
  assert.ok(!contains(r.bytes, 'ExampleCam'))
})

test('JPEG: Photoshop data without IPTC is not called captions and credits', async () => {
  const irb = seg(0xed, cat('Photoshop 3.0\0', '8BIM', [0x03, 0xed], [0, 0], be32(16), new Array(16).fill(0)))
  assert.deepEqual((await clean(grayJpeg(irb))).removed, [LABEL.appData])
  // EXIF and a thumbnail hidden inside Photoshop's block are named.
  const exif = phoneExif(1)
  const nested = seg(0xed, cat('Photoshop 3.0\0', '8BIM', [0x04, 0x22], [0, 0], be32(exif.length), exif, exif.length % 2 ? [0] : [], '8BIM', [0x04, 0x0c], [0, 0], be32(4), 'JPEG'))
  const r = await clean(grayJpeg(nested))
  for (const l of [LABEL.gps, LABEL.camera, LABEL.thumbnail]) assert.ok(r.removed.includes(l), l)
  assert.ok(!r.removed.includes(LABEL.iptc))
})

test('JPEG: Extended XMP, a second EXIF block and metadata after the scan all go', async () => {
  const ext = seg(0xe1, cat('http://ns.adobe.com/xmp/extension/\0', '0123456789ABCDEF0123456789ABCDEF', be32(PRIVATE_XMP.length), be32(0), utf8(PRIVATE_XMP)))
  const second = exifApp1(tiff([{ tag: 0x013b, type: 2, value: 'Example Author' }]))
  const input = cat([0xff, 0xd8], exifApp1(tiff([{ tag: 0x0112, type: 3, value: [1] }])), ext, second, jpegCore(), seg(0xfe, 'Example comment'), seg(0xe1, cat('Exif\0\0', phoneExif(1))), [0xff, 0xd9])
  const r = await clean(input)
  for (const s of ['Example Author', 'Example comment', 'ExampleCam', '12,20.4N']) assert.ok(!contains(r.bytes, s), s)
  for (const l of [LABEL.gps, LABEL.author, LABEL.comments, LABEL.other]) assert.ok(r.removed.includes(l), l)
})

// --- PNG, WebP, GIF -----------------------------------------------------------

test('PNG: text and EXIF after the image data, and data after IEND, go; the picture stays', async () => {
  const input = cat(
    PNG_SIG,
    ihdr(),
    idat(),
    pngChunk('eXIf', phoneExif(1)),
    pngChunk('iTXt', cat('Description\0', [0, 0], 'en\0', '\0', utf8('Example description'))),
    pngChunk('tEXt', 'Software\0ExampleEditor 2.0'),
    pngChunk('IEND', []),
    pngChunk('tEXt', 'Author\0Example Author'),
  )
  const r = await clean(input)
  assert.deepEqual(r.bytes, cat(PNG_SIG, ihdr(), idat(), pngChunk('IEND', [])))
  for (const l of [LABEL.gps, LABEL.description, LABEL.software, LABEL.trailing]) assert.ok(r.removed.includes(l), l)
})

test('GIF: an unknown application extension between frames goes; frames and looping stay', async () => {
  const frame = cat([0x21, 0xf9, 4, 0x04, 10, 0, 0, 0], [0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0], [2, 3, 0x44, 1, 0x05, 0])
  const loop = cat([0x21, 0xff, 11], 'NETSCAPE2.0', [3, 1, 0, 0, 0])
  const app = cat([0x21, 0xff, 11], 'EXAMPLE1.0\0', [14], 'Example Author', [0])
  const head = cat('GIF89a', [1, 0, 1, 0, 0x80, 0, 0], [0, 0, 0, 255, 255, 255])
  const r = await clean(cat(head, loop, frame, app, frame, [0x3b]))
  assert.deepEqual(r.bytes, cat(head, loop, frame, frame, [0x3b]))
  assert.deepEqual(r.removed, [LABEL.other])
})

test('PNG and GIF: Photoshop resource blocks are "private app data", IPTC is "captions and credits"', async () => {
  const png = (keyword: string) => cat(PNG_SIG, ihdr(), pngChunk('tEXt', `${keyword}\0\nexample\n       4\n00000000\n`), idat(), pngChunk('IEND', []))
  assert.deepEqual((await clean(png('Raw profile type 8bim'))).removed, [LABEL.appData])
  assert.deepEqual((await clean(png('Raw profile type iptc'))).removed, [LABEL.iptc])
  const head = cat('GIF89a', [1, 0, 1, 0, 0x80, 0, 0], [0, 0, 0, 255, 255, 255])
  const frame = cat([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0], [2, 3, 0x44, 1, 0x05, 0])
  const gif = (id: string) => cat(head, [0x21, 0xff, 11], id, [4], 'data', [0], frame, [0x3b])
  assert.deepEqual((await clean(gif('MGK8BIM0000'))).removed, [LABEL.appData])
  assert.deepEqual((await clean(gif('MGKIPTC0000'))).removed, [LABEL.iptc])
})

// --- HEIF / AVIF ----------------------------------------------------------------

/** A HEIF image sequence: a track with GPS and dates in moov, a padding box with leftovers. */
function heifSequence(): { bytes: Uint8Array; samples: Uint8Array } {
  const samples = utf8('SEQUENCE-SAMPLES')
  const ftyp = box('ftyp', 'msf1', be32(0), 'msf1', 'hevc', 'iso8')
  const time = be32(0xe3000000) // seconds since 1904: a 2024 date
  const build = (mdatAt: number) => {
    const mvhd = fullBox('mvhd', 0, 0, time, time, be32(1000), be32(1000), new Array(80).fill(0))
    const tkhd = fullBox('tkhd', 0, 3, time, time, be32(1), be32(0), be32(1000), new Array(60).fill(0))
    const mdhd = fullBox('mdhd', 0, 0, time, time, be32(1000), be32(1000), [0x55, 0xc4, 0, 0])
    const stco = fullBox('stco', 0, 0, be32(1), be32(mdatAt + 8))
    const trak = box('trak', tkhd, box('mdia', mdhd, box('minf', box('stbl', stco))), box('udta', box('\xa9too', 'ExampleEncoder')))
    const udta = box('udta', box('\xa9xyz', be16(18), be16(0x15c7), '+12.3400+056.7800/'), box('\xa9mak', be16(10), be16(0), 'ExampleCam'))
    const moov = box('moov', mvhd, trak, udta)
    const free = box('free', 'leftover Example Author')
    return { head: cat(ftyp, moov, free), samples }
  }
  const first = build(0)
  const { head } = build(first.head.length)
  return { bytes: cat(head, box('mdat', samples)), samples }
}

test('HEIF sequence: moov metadata and times are blanked in place; samples stay put', async () => {
  const { bytes, samples } = heifSequence()
  assert.equal(detectKind(bytes), 'heic')
  const r = await clean(bytes)
  assert.equal(r.bytes.length, bytes.length)
  for (const s of ['12.3400', 'ExampleCam', 'ExampleEncoder', 'Example Author']) assert.ok(!contains(r.bytes, s), s)
  for (const l of [LABEL.gps, LABEL.camera, LABEL.software, LABEL.dates, LABEL.other]) assert.ok(r.removed.includes(l), l)
  const at = Buffer.from(bytes).indexOf(Buffer.from(samples))
  assert.deepEqual(r.bytes.subarray(at, at + samples.length), samples)
  // stco still points at the samples.
  const stco = Buffer.from(r.bytes).indexOf(Buffer.from('stco'))
  assert.equal(new DataView(r.bytes.buffer, r.bytes.byteOffset).getUint32(stco + 12), at)
  assert.ok(!contains(r.bytes, 'udta'))
})

test('HEIC: a picture that shares bytes with its Exif item is refused, not damaged', async () => {
  const payload = cat(be32(0), phoneExif(1))
  const infe = (id: number, type: string) => fullBox('infe', 2, 0, be16(id), be16(0), type, '\0')
  const iinf = fullBox('iinf', 0, 0, be16(2), infe(1, 'hvc1'), infe(2, 'Exif'))
  const build = (at: number) => {
    const loc = (id: number) => cat(be16(id), be16(0), be16(0), be16(1), be32(at), be32(payload.length))
    const meta = fullBox('meta', 0, 0, fullBox('hdlr', 0, 0, be32(0), 'pict', new Array(12).fill(0), '\0'), fullBox('pitm', 0, 0, be16(1)), iinf, fullBox('iloc', 1, 0, [0x44, 0x00], be16(2), loc(1), loc(2)))
    return cat(box('ftyp', 'heic', be32(0), 'mif1', 'heic'), meta)
  }
  const head = build(build(0).length + 8)
  const r = await stripBytes(cat(head, box('mdat', payload)))
  assert.equal(r.status, 'failed')
})

// --- Office -------------------------------------------------------------------

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
const CT = (overrides: string) =>
  XML +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
  overrides +
  '</Types>'
const RELS = (r: string) => XML + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${r}</Relationships>`
const OFFICE_DOC = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument'

function miniDocx(documentXml: string, extra: Record<string, string | Uint8Array> = {}, wordNs = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'): Uint8Array {
  return zip({
    '[Content_Types].xml': CT('<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'),
    '_rels/.rels': RELS(`<Relationship Id="rId1" Type="${OFFICE_DOC}" Target="word/document.xml"/>`),
    'word/document.xml': XML + `<w:document xmlns:w="${wordNs}">${documentXml}</w:document>`,
    ...extra,
  })
}

test('DOCX: UTC copies of change and comment times (w16du, w16cex) go too', async () => {
  const du = 'xmlns:w16du="http://schemas.microsoft.com/office/word/2023/wordml/word16du"'
  const doc = miniDocx(
    `<w:body ${du}><w:p><w:ins w:id="1" w:author="Example Author" w:date="2024-06-12T20:30:00Z" w16du:dateUtc="2024-06-12T18:30:00Z"><w:r><w:t>new</w:t></w:r></w:ins></w:p></w:body>`,
    {
      'word/commentsExtensible.xml':
        XML + '<w16cex:commentsExtensible xmlns:w16cex="http://schemas.microsoft.com/office/word/2018/wordml/cex"><w16cex:commentExtensible w16cex:durableId="1A2B3C4D" w16cex:dateUtc="2024-06-12T18:30:00Z"/></w16cex:commentsExtensible>',
    },
  )
  const r = await clean(doc)
  const p = parts(r.bytes)
  assert.ok(!Object.values(p).some((x) => x.includes('2024-06-12') || x.includes('Example Author')))
  assert.ok(p['word/document.xml'].includes('<w:t>new</w:t>'))
  assert.ok(r.removed.includes(LABEL.changeAuthors) && r.removed.includes(LABEL.commentAuthors))
})

test('DOCX: Strict Open XML comments and changes are anonymised too', async () => {
  const strict = 'http://purl.oclc.org/ooxml/wordprocessingml/main'
  const doc = miniDocx(
    '<w:body><w:p w:rsidR="00A1B2C3"><w:del w:id="1" w:author="Example Author" w:date="2024-06-12T18:30:00Z"><w:r><w:delText>gone</w:delText></w:r></w:del></w:p></w:body>',
    { 'word/comments.xml': XML + `<w:comments xmlns:w="${strict}"><w:comment w:id="0" w:author="Example Editor" w:initials="EE" w:date="2024-06-12T18:30:00Z"><w:p><w:r><w:t>Note</w:t></w:r></w:p></w:comment></w:comments>` },
    strict,
  )
  const r = await clean(doc)
  const p = parts(r.bytes)
  assert.ok(!Object.values(p).some((x) => /Example (Author|Editor)|2024-06-12|rsid|"EE"/.test(x)))
  assert.match(p['word/comments.xml'], /w:author="Author"/)
  assert.match(p['word/document.xml'], /<w:delText>gone<\/w:delText>/)
})

test('DOCX: a chart’s embedded workbook is cleaned too', async () => {
  const outer = zip({ ...unzipSync(docx()), 'word/embeddings/Microsoft_Excel_Worksheet.xlsx': xlsx() })
  const r = await clean(outer)
  const nested = unzipSync(unzipSync(r.bytes)['word/embeddings/Microsoft_Excel_Worksheet.xlsx'])
  const all = Object.values(nested).map(text).join('\n')
  for (const s of ['Example Author', 'Example Editor', 'ExampleUser', 'author@example.com']) assert.ok(!all.includes(s), s)
  assert.ok(all.includes('Visible cell'))
})

test('DOCX: a HEIC picture inside is cleaned like a HEIC file', async () => {
  const { bytes } = heif('heic')
  const r = await clean(zip({ ...unzipSync(docx()), 'word/media/image2.heic': bytes }))
  const pic = unzipSync(r.bytes)['word/media/image2.heic']
  assert.equal(detectKind(pic), 'heic')
  for (const s of ['ExampleCam', 'Example Author', 'VIDEOFRAMES']) assert.ok(!contains(pic, s), s)
  assert.ok(r.removed.includes(`${LABEL.motion}${IN_PICTURES}`))
})

test('DOCX: digitally signed files are left alone', async () => {
  const signed = zip({ ...unzipSync(docx()), '_xmlsignatures/sig1.xml': XML + '<Signature xmlns="http://www.w3.org/2000/09/xmldsig#"/>' })
  assert.deepEqual(await stripBytes(signed), { status: 'skipped', kind: 'docx', reason: SKIP.signedDocument })
})

test('DOCX: rewritten parts keep unusual characters exactly', async () => {
  // A line separator, a next-line character and an escaped carriage return in text.
  const body = '<w:body><w:p w:rsidR="00A1B2C3"><w:r><w:t>a\u2028b\u0085c&#13;d&#x2028;e</w:t></w:r></w:p></w:body>'
  const input = miniDocx(body)
  const r = await clean(input)
  const out = text(unzipSync(r.bytes)['word/document.xml'])
  assert.ok(!out.includes('rsid'))
  const read = (s: string) => textOf(parseXml(s))
  assert.equal(read(out), read(text(unzipSync(input)['word/document.xml'])))
  assert.equal(read(out), '\na\u2028b\u0085c\rd\u2028e')
})

test('DOCX: an empty custom-properties part is not reported', async () => {
  const doc = miniDocx('<w:body><w:p w:rsidR="00A1B2C3"/></w:body>', {
    'docProps/custom.xml': XML + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties"/>',
  })
  const r = await clean(doc)
  assert.ok(!r.removed.includes(LABEL.custom), r.removed.join())
})

test('XLSX: pivot-table refresh names and dates and the shared-file user name go', async () => {
  const X = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
  const book = zip({
    '[Content_Types].xml': CT('<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'),
    '_rels/.rels': RELS(`<Relationship Id="rId1" Type="${OFFICE_DOC}" Target="xl/workbook.xml"/>`),
    'xl/workbook.xml': XML + `<workbook ${X}><fileSharing readOnlyRecommended="1" userName="Example Author"/><sheets><sheet name="Data" sheetId="1" r:id="rId2"/></sheets></workbook>`,
    'xl/pivotCache/pivotCacheDefinition1.xml': XML + `<pivotCacheDefinition ${X} r:id="rId1" refreshedBy="Example Editor" refreshedDate="45455.77" createdVersion="8" recordCount="1"><cacheSource type="worksheet"/><cacheFields count="0"/></pivotCacheDefinition>`,
    'xl/pivotCache/pivotCacheRecords1.xml': XML + `<pivotCacheRecords ${X} count="0"/>`,
  })
  const r = await clean(book)
  const p = parts(r.bytes)
  assert.ok(!Object.values(p).some((x) => /Example (Author|Editor)|45455/.test(x)))
  assert.match(p['xl/workbook.xml'], /readOnlyRecommended="1" userName="Author"/)
  assert.match(p['xl/pivotCache/pivotCacheDefinition1.xml'], /refreshedBy="Author"/)
  for (const l of [LABEL.author, LABEL.lastEditor, LABEL.dates]) assert.ok(r.removed.includes(l), l)
})

test('PPTX: the co-authoring change log goes, with its links', async () => {
  const P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
  const deck = zip({
    '[Content_Types].xml': CT(
      '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
        '<Override PartName="/ppt/changesInfos/changesInfo1.xml" ContentType="application/vnd.ms-powerpoint.changesinfo+xml"/>',
    ),
    '_rels/.rels': RELS(`<Relationship Id="rId1" Type="${OFFICE_DOC}" Target="ppt/presentation.xml"/>`),
    'ppt/presentation.xml': XML + `<p:presentation ${P}/>`,
    'ppt/_rels/presentation.xml.rels': RELS('<Relationship Id="rId9" Type="http://schemas.microsoft.com/office/2016/11/relationships/changesInfo" Target="changesInfos/changesInfo1.xml"/>'),
    'ppt/changesInfos/changesInfo1.xml':
      XML + '<pc:chgInfo xmlns:pc="http://schemas.microsoft.com/office/powerpoint/2013/main/command"><pc:docChgLst><pc:chgData name="Example Author" userId="author@example.com" providerId="AD"/></pc:docChgLst></pc:chgInfo>',
  })
  const r = await clean(deck)
  const p = parts(r.bytes)
  assert.ok(!('ppt/changesInfos/changesInfo1.xml' in p))
  assert.ok(!p['[Content_Types].xml'].includes('changesInfo') && !p['ppt/_rels/presentation.xml.rels'].includes('changesInfo'))
  assert.ok(r.removed.includes(LABEL.history))
})

test('ODF: signed files are left alone; embedded objects lose their meta.xml details', async () => {
  const base = unzipSync(odf('text'))
  const signed = zip({ ...base, 'META-INF/documentsignatures.xml': '<?xml version="1.0"?><document-signatures xmlns="urn:oasis:names:tc:opendocument:xmlns:digitalsignature:1.0"/>' }, ['mimetype'])
  assert.deepEqual(await stripBytes(signed), { status: 'skipped', kind: 'odt', reason: SKIP.signedDocument })
  const chartMeta =
    '<?xml version="1.0" encoding="UTF-8"?>\n<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" office:version="1.3"><office:meta><meta:generator>ExampleOffice/1.0$ExampleOS</meta:generator><meta:initial-creator>Example Author</meta:initial-creator></office:meta></office:document-meta>'
  const withChart = zip({ ...base, 'Object 1/meta.xml': chartMeta, 'Object 1/content.xml': '<?xml version="1.0"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"/>' }, ['mimetype'])
  const r = await clean(withChart)
  const p = parts(r.bytes)
  assert.ok(!p['Object 1/meta.xml'].includes('Example'))
  assert.equal(readZip(r.bytes)[0], 'mimetype')
})

test('ODF: "printed by" is named as such, not as the last editor', async () => {
  const base = unzipSync(odf('text'))
  const meta =
    '<?xml version="1.0" encoding="UTF-8"?>\n<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" office:version="1.3"><office:meta><meta:printed-by>Example Author</meta:printed-by></office:meta></office:document-meta>'
  const r = await clean(zip({ ...base, 'meta.xml': meta }, ['mimetype']))
  assert.ok(r.removed.includes(LABEL.printedBy))
  assert.ok(!r.removed.includes(LABEL.lastEditor))
})

function readZip(b: Uint8Array): string[] {
  return Object.keys(unzipSync(b))
}

// --- PDF and type detection -----------------------------------------------------

test('Detection: a ZIP or TAR holding a PDF is not a PDF', async () => {
  const doc = await PDFDocument.create({ updateMetadata: false })
  doc.addPage([100, 100])
  doc.setAuthor('Example Author')
  const pdf = await doc.save({ useObjectStreams: false })
  const zipped = zip({ 'a.pdf': pdf }, ['a.pdf'])
  // A plain zip: its dates go, and the PDF inside goes as it is.
  assert.equal(detectKind(zipped), 'zip')
  const r = await stripBytes(zipped, { pdf: true })
  assert.equal(r.status, 'cleaned')
  if (r.status !== 'cleaned') return
  assert.deepEqual(r.unchecked, { pdf: 1 })
  assert.deepEqual(readZip(r.bytes), ['a.pdf'])
  const header = new Uint8Array(512)
  header.set(utf8('a.pdf'))
  header.set(utf8('ustar\x0000'), 257)
  const tarred = cat(header, pdf)
  assert.equal(detectKind(tarred), null)
  assert.equal(describeOther(tarred), 'tar')
  // A PDF with a little junk in front is still one.
  assert.equal(detectKind(cat([0x00, 0x0d, 0x0a], pdf)), 'pdf')
})

test('PDF: Info and annotations in compressed object streams are cleaned', async () => {
  const doc = await PDFDocument.create({ updateMetadata: false })
  doc.setAuthor('Example Author')
  doc.setTitle('Example Title')
  const page = doc.addPage([100, 100])
  const ctx = doc.context
  const note = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Highlight', Rect: [0, 0, 10, 10], T: PDFString.of('Example Editor'), M: PDFString.of('D:20240612183000Z') }))
  page.node.set(PDFName.of('Annots'), ctx.obj([note]))
  const input = await doc.save({ useObjectStreams: true })
  assert.ok(contains(input, '/ObjStm'))
  const r = await clean(input, { pdf: true })
  const out = await PDFDocument.load(r.bytes, { updateMetadata: false })
  assert.equal(out.context.trailerInfo.Info, undefined)
  assert.ok(!contains(r.bytes, 'Example'))
  for (const l of [LABEL.author, LABEL.title, LABEL.commentAuthors]) assert.ok(r.removed.includes(l), l)
})

test('PDF: a form with signature flags is treated as signed', async () => {
  const doc = await PDFDocument.create({ updateMetadata: false })
  doc.addPage([100, 100])
  doc.setAuthor('Example Author')
  doc.catalog.set(PDFName.of('AcroForm'), doc.context.obj({ Fields: [], SigFlags: 1 }))
  const input = await doc.save({ useObjectStreams: false })
  assert.deepEqual(await stripBytes(input, { pdf: true }), { status: 'skipped', kind: 'pdf', reason: SKIP.signed })
})

// --- File names ---------------------------------------------------------------

test('suggestNeutralName: more camera and app patterns, fewer false alarms', () => {
  const cases: [string, string | null][] = [
    ['WIN_20240612_18_30_45_Pro.jpg', 'photo.jpg'],
    ['IMG_E1234.JPG', 'photo.JPG'],
    ['DOC-20240612-WA0001.pdf', 'document.pdf'],
    ['Photo on 12-06-2024 at 18.30.jpg', 'photo.jpg'],
    ['WP_20240612_18_30_45_Pro.jpg', 'photo.jpg'],
    ['SAM_1234.JPG', 'photo.JPG'],
    ['SAM 2 notes.docx', null],
    ['WP 2020 budget.xlsx', null],
  ]
  for (const [name, want] of cases) assert.equal(suggestNeutralName(name), want, name)
})

test('suggestNeutralName: scanners, scanner apps and office printers', () => {
  const cases: [string, string | null][] = [
    ['Scan 2024-06-12 at 18.30.42.pdf', 'document.pdf'],
    ['Scanned_20240612-1830.pdf', 'document.pdf'],
    ['CamScanner 06-12-2024 18.30.pdf', 'document.pdf'],
    ['Adobe Scan 12 Jun 2024.pdf', 'document.pdf'],
    ['Adobe Scan Jun 12, 2024.pdf', 'document.pdf'],
    ['Scan 12 June 2024 at 18.30.jpg', 'photo.jpg'],
    ['Xerox Scan_06122024183045.pdf', 'document.pdf'],
    ['Office Lens 20240612-183045.pdf', 'document.pdf'],
    ['SKM_C28724061218300.pdf', 'document.pdf'],
    ['SKMBT_C55024061218300.pdf', 'document.pdf'],
    ['Doc20240612183045_00001.pdf', 'document.pdf'],
    ['BRN3C2AF4A1B2C3_000123.pdf', 'document.pdf'],
    ['Screenshot 12 Jun 2024 at 18.30.png', 'screenshot.png'],
    ['Scan.pdf', null],
    ['Scan 1.pdf', null],
    ['Scanned Document.pdf', null],
    ['Scan of passport.pdf', null],
    ['Scan 2024 budget.pdf', null],
    ['Scanner manual.pdf', null],
    ['Doctor letter.pdf', null],
    ['SKM notes.pdf', null],
    ['June 12, 2024 minutes.pdf', null],
    ['Brown bag 2024.pdf', null],
  ]
  for (const [name, want] of cases) assert.equal(suggestNeutralName(name), want, name)
})

// --- Robustness ---------------------------------------------------------------

test('New fixtures: damaged copies never throw and never come back half-cleaned', async () => {
  let seed = 4242
  const random = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  const samples = [heifSequence().bytes, withMpf([exifApp1(phoneExif(6))], [grayJpeg(xmpApp1(xmpPacket('', `${HDRGM} ${GAIN_MAP_PARAMS}`)))]), miniDocx('<w:body><w:p w:rsidR="1"/></w:body>')]
  for (const good of samples) {
    for (let k = 0; k < 40; k++) {
      const b = k < 10 ? good.subarray(0, Math.floor((good.length * (k + 1)) / 11)) : good.slice()
      if (k >= 10) for (let j = 0; j < 3; j++) b[Math.floor(random() * b.length)] = Math.floor(random() * 256)
      const r = await stripBytes(b, { pdf: true })
      assert.ok(['cleaned', 'unchanged', 'unsupported', 'skipped', 'failed'].includes(r.status))
      if (r.status === 'cleaned') assert.equal((await stripBytes(r.bytes, { pdf: true })).status, 'unchanged')
    }
  }
})

test('Engine: output owns its buffer even when the input is a view into a larger one', async () => {
  const jpeg = grayJpeg(exifApp1(phoneExif(1)))
  const big = new Uint8Array(jpeg.length + 64)
  big.set(jpeg, 32)
  const r = await stripBytes(big.subarray(32, 32 + jpeg.length))
  assert.equal(r.status, 'cleaned')
  if (r.status === 'cleaned') {
    assert.equal(r.bytes.byteOffset, 0)
    assert.equal(r.bytes.byteLength, r.bytes.buffer.byteLength)
    assert.notEqual(r.bytes.buffer, big.buffer)
  }
})
