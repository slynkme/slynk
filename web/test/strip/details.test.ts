// What the sender sees in the "Cleaned" popover: each removed label with the
// values it held. Every fixture is synthetic, with invented values only.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { unzipSync, zlibSync } from 'fflate'
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib'
import { stripBytes } from '../../src/strip/engine.ts'
import { IN_PICTURES, LABEL } from '../../src/strip/labels.ts'
import type { Detail } from '../../src/strip/types.ts'
import { MAX_FOUND, MAX_LENGTH, cameraName, describe, displayValue, formatExifDate, formatGps } from '../../src/strip/values.ts'
import { docx, odf, pptx, xlsx, zip } from './docfixtures.ts'
import {
  PRIVATE_XMP,
  cat,
  contains,
  exifApp1,
  flacBlock,
  FLAC_FRAMES,
  grayJpeg,
  heif,
  id3v2,
  mpegFrames,
  phoneExif,
  pngChunk,
  PNG_SIG,
  ihdr,
  idat,
  privateFlac,
  privateGif,
  privateMp3,
  privatePng,
  privateWebp,
  seg,
  STREAMINFO,
  tiff,
  utf8,
  vorbisComment,
  xmpApp1,
  xmpPacket,
} from './fixtures.ts'

async function details(b: Uint8Array, opts = {}): Promise<Detail[]> {
  const r = await stripBytes(b, opts)
  assert.equal(r.status, 'cleaned', JSON.stringify(r))
  if (r.status !== 'cleaned') throw new Error()
  // One detail per removed label, in the same order.
  assert.deepEqual(r.details.map((d) => d.label), r.removed)
  for (const d of r.details) {
    // A value that was removed must not still be in the cleaned file.
    for (const v of d.values) assert.ok(!contains(r.bytes, v), `${d.label}: "${v}" is still in the file`)
  }
  return r.details
}

/** The values shown under a label, or undefined when the label isn't there. */
function valuesOf(list: Detail[], label: string): string[] | undefined {
  return list.find((d) => d.label === label)?.values
}

const PHONE = {
  [LABEL.gps]: ['12.34° N, 56.78° E'],
  [LABEL.camera]: ['ExampleCam X1'],
  [LABEL.dateTaken]: ['12 Jun 2024, 18:30'],
  [LABEL.software]: ['ExampleOS 1.0'],
}

function hasPhone(list: Detail[], suffix = '') {
  for (const [label, values] of Object.entries(PHONE)) assert.deepEqual(valuesOf(list, label + suffix)?.slice(0, 1), values, label + suffix)
}

// --- The formatting helpers ------------------------------------------------

test('display values: one line, no control or reordering characters, cut short when long', () => {
  assert.equal(displayValue('ExampleCam\0garbage after the end'), 'ExampleCam')
  assert.equal(displayValue('  Example\r\n\tAuthor  '), 'Example Author')
  assert.equal(displayValue('Example\u202eAuthor\u200b'), 'Example Author')
  assert.equal(displayValue('\ufeffExample'), 'Example')
  // The zero-width non-joiner and joiner stay (Persian, Hindi, emoji); invisible tag characters go.
  const zwnj = String.fromCodePoint(0x200c)
  assert.equal(displayValue(`Example${zwnj}Name`), `Example${zwnj}Name`)
  const tags = String.fromCodePoint(0xe0041, 0xe0042, 0xe007f)
  assert.equal(displayValue(`Example${tags}`), 'Example')
  for (const blank of ['', '   ', '    :  :     :  :  ', '----', '\0\0\0']) assert.equal(displayValue(blank), '', JSON.stringify(blank))
  const long = displayValue('x'.repeat(500))
  assert.equal(Array.from(long).length, MAX_LENGTH)
  assert.ok(long.endsWith('…'))
  // Characters outside the BMP are never split in half.
  assert.equal(Array.from(displayValue('😀'.repeat(200))).length, MAX_LENGTH)
})

test('GPS: degrees, minutes and seconds become a short coordinate', () => {
  assert.equal(formatGps([12, 20, 24], 'N', [56, 46, 48], 'E'), '12.34° N, 56.78° E')
  assert.equal(formatGps([12, 20, 24], 's', [56, 46, 48], 'w'), '12.34° S, 56.78° W')
  assert.equal(formatGps([12.3456789], 'N', [56], 'E'), '12.3457° N, 56° E')
  assert.equal(formatGps([0, 0, 0], 'N', [0, 0, 0], 'E'), '0° N, 0° E')
  // No hemisphere, an impossible angle or a zero denominator: not shown.
  assert.equal(formatGps([12, 20, 24], '', [56, 46, 48], 'E'), null)
  assert.equal(formatGps([12, 20, 24], 'X', [56, 46, 48], 'E'), null)
  assert.equal(formatGps([95], 'N', [56], 'E'), null)
  assert.equal(formatGps([12], 'N', [190], 'E'), null)
  assert.equal(formatGps([12, NaN, 0], 'N', [56], 'E'), null)
  assert.equal(formatGps([12, 1 / 0, 0], 'N', [56], 'E'), null)
  assert.equal(formatGps([], 'N', [56], 'E'), null)
})

test('dates: as the camera wrote them, in words', () => {
  assert.equal(formatExifDate('2024:06:12 18:30:45'), '12 Jun 2024, 18:30')
  assert.equal(formatExifDate('2024:01:05 07:05:00\0'), '5 Jan 2024, 07:05')
  assert.equal(formatExifDate('2024-12-31T23:59:59Z'), '31 Dec 2024, 23:59')
  assert.equal(formatExifDate('2024:06:12'), '12 Jun 2024')
  assert.equal(formatExifDate('2024:06:12 25:00:00'), '12 Jun 2024')
  assert.equal(formatExifDate('0000:00:00 00:00:00'), '')
  assert.equal(formatExifDate('2024:13:12 18:30:00'), '')
  assert.equal(formatExifDate('    :  :     :  :  '), '')
  assert.equal(formatExifDate('June 2024'), 'June 2024')
  // Only real days: 29 February only in a leap year.
  assert.equal(formatExifDate('2024:02:31 10:00:00'), '')
  assert.equal(formatExifDate('2023:02:29'), '')
  assert.equal(formatExifDate('2024:02:29'), '29 Feb 2024')
  assert.equal(formatExifDate('2024:04:31'), '')
})

test('cameras: the maker is named once', () => {
  assert.equal(cameraName('ExampleCam', 'X1'), 'ExampleCam X1')
  assert.equal(cameraName('ExampleCam', 'ExampleCam X1'), 'ExampleCam X1')
  assert.equal(cameraName('EXAMPLECAM CORPORATION', 'EXAMPLECAM X1'), 'EXAMPLECAM X1')
  assert.equal(cameraName('ExampleCam', ''), 'ExampleCam')
  assert.equal(cameraName('', 'X1'), 'X1')
  assert.equal(cameraName('', ''), '')
  // Whole words only: a model that merely starts with the maker's letters keeps the maker.
  assert.equal(cameraName('ExampleCam', 'ExampleCamera 2'), 'ExampleCam ExampleCamera 2')
  assert.equal(cameraName('ExampleCam Corporation', 'ExampleCam-X1'), 'ExampleCam-X1')
})

test('describe: every label, in order, with up to three distinct values and a count of the rest', () => {
  const labels = [LABEL.gps, LABEL.author, LABEL.thumbnail]
  const found = [
    { label: LABEL.author, value: 'A' },
    { label: LABEL.author, value: 'B' },
    { label: LABEL.author, value: 'A' },
    { label: LABEL.author, value: 'C' },
    { label: LABEL.author, value: 'D' },
    { label: LABEL.author, value: 'E' },
    { label: LABEL.company, value: 'not a removed label' },
  ]
  assert.deepEqual(describe(labels, found), [
    { label: LABEL.gps, values: [], more: 0 },
    { label: LABEL.author, values: ['A', 'B', 'C'], more: 2 },
    { label: LABEL.thumbnail, values: [], more: 0 },
  ])
  assert.deepEqual(describe([LABEL.gps]), [{ label: LABEL.gps, values: [], more: 0 }])
  // When collecting stopped at the cap, a count could be short, so it isn't given.
  const many = Array.from({ length: MAX_FOUND }, (_, i) => ({ label: LABEL.author, value: `Name ${i}` }))
  assert.deepEqual(describe([LABEL.author, LABEL.gps], many), [
    { label: LABEL.author, values: ['Name 0', 'Name 1', 'Name 2'], more: -1 },
    { label: LABEL.gps, values: [], more: 0 },
  ])
})

// --- Each format -----------------------------------------------------------

test('JPEG: location, camera, date taken and software from EXIF; the creator tool from XMP', async () => {
  const list = await details(grayJpeg(exifApp1(phoneExif(6)), xmpApp1(PRIVATE_XMP)))
  hasPhone(list)
  assert.deepEqual(valuesOf(list, LABEL.software), ['ExampleOS 1.0', 'ExampleEditor 2.0'])
  assert.deepEqual(valuesOf(list, LABEL.author), ['Example Author'])
  // Labels with nothing worth showing are listed all the same.
  assert.deepEqual(valuesOf(list, LABEL.serial), [])
  assert.deepEqual(valuesOf(list, LABEL.thumbnail), [])
  assert.deepEqual(valuesOf(list, LABEL.makerNotes), [])
})

test('JPEG: the photo time wins over the file time; authors and owners are shown', async () => {
  const exif = tiff(
    [
      { tag: 0x0110, type: 2, value: 'X1' },
      { tag: 0x010f, type: 2, value: 'ExampleCam' },
      { tag: 0x0132, type: 2, value: '2025:01:02 03:04:05' },
      { tag: 0x013b, type: 2, value: 'Example Author' },
    ],
    { exif: [{ tag: 0x9004, type: 2, value: '2024:06:12 18:30:45' }, { tag: 0xa430, type: 2, value: 'Example Owner' }] },
  )
  const list = await details(grayJpeg(exifApp1(exif)))
  assert.deepEqual(valuesOf(list, LABEL.camera), ['ExampleCam X1'])
  assert.deepEqual(valuesOf(list, LABEL.dateTaken), ['12 Jun 2024, 18:30'])
  assert.deepEqual(valuesOf(list, LABEL.author), ['Example Author', 'Example Owner'])
})

test('JPEG: a short value stored inside its entry, and broken values, are handled', async () => {
  // "X1" fits in the entry's 4 bytes; GPS with no hemisphere and a zero denominator isn't shown.
  const exif = tiff([{ tag: 0x0110, type: 2, value: 'X1' }], {
    gps: [
      { tag: 0x0002, type: 5, value: [12, 0, 20, 1, 24, 1] },
      { tag: 0x0004, type: 5, value: [56, 1, 46, 1, 48, 1] },
    ],
  })
  const list = await details(grayJpeg(exifApp1(exif)))
  assert.deepEqual(valuesOf(list, LABEL.camera), ['X1'])
  assert.deepEqual(valuesOf(list, LABEL.gps), [])
  // An entry pointing outside the block: the label stays, without a value.
  const broken = exifApp1(tiff([{ tag: 0x0131, type: 2, value: 'ExampleEditor 2.0' }]))
  const at = broken.length - 'ExampleEditor 2.0'.length - 1 - 8 // the entry's offset field
  broken.set([0x7f, 0xff, 0xff, 0xff], at)
  const list2 = await details(grayJpeg(broken))
  assert.deepEqual(valuesOf(list2, LABEL.software), [])
})

test('JPEG: values inside Photoshop blocks are shown too', async () => {
  const exif = phoneExif(1)
  const block = cat('8BIM', [0x04, 0x22], [0, 0], [(exif.length >>> 24) & 255, (exif.length >>> 16) & 255, (exif.length >>> 8) & 255, exif.length & 255], exif, exif.length & 1 ? [0] : [])
  const list = await details(grayJpeg(seg(0xed, cat('Photoshop 3.0\0', block))))
  hasPhone(list)
})

test('PNG: EXIF, XMP and text chunks', async () => {
  const list = await details(privatePng())
  hasPhone(list)
  assert.deepEqual(valuesOf(list, LABEL.author), ['Example Author'])
  assert.ok(valuesOf(list, LABEL.software)?.includes('ExampleEditor 2.0'))
  // Generation prompts are listed, not shown: they can be very long.
  assert.deepEqual(valuesOf(list, LABEL.prompt), [])
  const titled = cat(PNG_SIG, ihdr(), pngChunk('tEXt', 'Title\0Example Title'), pngChunk('tEXt', 'Software\0ExampleEditor 2.0'), idat(), pngChunk('IEND', []))
  const list2 = await details(titled)
  assert.deepEqual(valuesOf(list2, LABEL.title), ['Example Title'])
  assert.deepEqual(valuesOf(list2, LABEL.software), ['ExampleEditor 2.0'])
  // A keyword like "constructor" is just text, not a label.
  const odd = cat(PNG_SIG, ihdr(), pngChunk('tEXt', 'constructor\0Example'), idat(), pngChunk('IEND', []))
  assert.deepEqual(await details(odd), [{ label: LABEL.embeddedText, values: [], more: 0 }])
})

test('WebP and GIF: EXIF and XMP', async () => {
  const webp = await details(privateWebp())
  hasPhone(webp)
  assert.ok(valuesOf(webp, LABEL.software)?.includes('ExampleEditor 2.0'))
  const gif = await details(privateGif())
  assert.deepEqual(valuesOf(gif, LABEL.software), ['ExampleEditor 2.0'])
  assert.deepEqual(valuesOf(gif, LABEL.comments), [])
})

for (const brand of ['heic', 'avif'] as const) {
  test(`${brand.toUpperCase()}: EXIF and XMP items`, async () => {
    const list = await details(heif(brand).bytes)
    hasPhone(list)
    assert.ok(valuesOf(list, LABEL.software)?.includes('ExampleEditor 2.0'))
  })
}

test('MP3: title, artist and album from ID3v2 and ID3v1, without repeats', async () => {
  const list = await details(privateMp3())
  assert.deepEqual(valuesOf(list, LABEL.songInfo), ['Example Title', 'Example Artist', 'Example Album'])
  assert.deepEqual(valuesOf(list, LABEL.dates), [])
  assert.deepEqual(valuesOf(list, LABEL.coverArt), [])
})

test('MP3: every ID3 text encoding; transformed frames and unsynchronised tags aren’t shown', async () => {
  const utf16le = (s: string) => cat([1, 0xff, 0xfe], Buffer.from(s + '\0', 'utf16le'))
  const utf16be = (s: string) => cat([2], Buffer.from(s, 'utf16le').swap16())
  const tag = id3v2([
    ['TALB', utf16le('Example Album')],
    ['TPE1', utf16be('Example Artist')],
    ['TIT2', cat([3], utf8('Example Title ✓'))],
    ['TSSE', '\0ExampleEncoder 1.0'],
    ['TENC', '\0Example Person'],
  ])
  const list = await details(cat(tag, mpegFrames(4)))
  assert.deepEqual(valuesOf(list, LABEL.songInfo), ['Example Title ✓', 'Example Artist', 'Example Album'])
  assert.deepEqual(valuesOf(list, LABEL.encoder), ['ExampleEncoder 1.0', 'Example Person'])
  // ID3v2.4 may hold several values in one frame.
  const v24 = cat('ID3', [4, 0, 0], [0, 0, 0, 40], 'TPE1', [0, 0, 0, 27], [0, 0], [3], 'Example Artist\0Example Two', [0, 0, 0])
  assert.deepEqual(valuesOf(await details(cat(v24, mpegFrames(4))), LABEL.songInfo), ['Example Artist', 'Example Two'])
  // A compressed frame (v2.3 flag) and a whole unsynchronised tag: labels only.
  const compressed = cat('ID3', [3, 0, 0], [0, 0, 0, 24], 'TIT2', [0, 0, 0, 14], [0, 0x80], '\0Example Title')
  assert.deepEqual(valuesOf(await details(cat(compressed, mpegFrames(4))), LABEL.songInfo), [])
  const unsync = cat('ID3', [3, 0, 0x80], [0, 0, 0, 24], 'TIT2', [0, 0, 0, 14], [0, 0], '\0Example Title')
  assert.deepEqual(valuesOf(await details(cat(unsync, mpegFrames(4))), LABEL.songInfo), [])
})

test('FLAC: Vorbis comments and the encoder', async () => {
  const list = await details(privateFlac())
  assert.deepEqual(valuesOf(list, LABEL.songInfo), ['Example Title', 'Example Artist'])
  assert.deepEqual(valuesOf(list, LABEL.encoder), ['reference libFLAC 1.4.3 20230623'])
  const tags = vorbisComment('ExampleFLAC 1.0', ['ALBUM=Example Album', 'title=Example Title', 'ENCODED_BY=Example Person', 'ENCODER=ExampleEncoder 2.0', 'NOEQUALS'])
  const list2 = await details(cat('fLaC', flacBlock(0, STREAMINFO), flacBlock(4, tags, true), FLAC_FRAMES))
  assert.deepEqual(valuesOf(list2, LABEL.songInfo), ['Example Title', 'Example Album'])
  assert.deepEqual(valuesOf(list2, LABEL.encoder), ['ExampleEncoder 2.0', 'Example Person', 'ExampleFLAC 1.0'])
})

test('Word: author, last editor, title, company, manager and app; and the photo inside', async () => {
  const list = await details(docx())
  assert.deepEqual(valuesOf(list, LABEL.author), ['Example Author'])
  assert.deepEqual(valuesOf(list, LABEL.lastEditor), ['Example Editor'])
  assert.deepEqual(valuesOf(list, LABEL.title), ['Example Title', 'Example Subject'])
  assert.deepEqual(valuesOf(list, LABEL.company), ['Example Corp'])
  assert.deepEqual(valuesOf(list, LABEL.manager), ['Example Manager'])
  assert.deepEqual(valuesOf(list, LABEL.app), ['Example Office'])
  // Keywords, dates, comment authors and custom properties are listed without values.
  for (const label of [LABEL.keywords, LABEL.dates, LABEL.commentAuthors, LABEL.custom]) assert.deepEqual(valuesOf(list, label), [], label)
  hasPhone(list, IN_PICTURES)
})

test('Excel and PowerPoint: the same properties, and their pictures', async () => {
  const sheet = await details(xlsx())
  assert.deepEqual(valuesOf(sheet, LABEL.company), ['Example Corp'])
  assert.deepEqual(valuesOf(sheet, LABEL.author + IN_PICTURES), ['Example Author'])
  const slides = await details(pptx())
  assert.deepEqual(valuesOf(slides, LABEL.author), ['Example Author'])
  hasPhone(slides, IN_PICTURES)
})

test('Word: a chart’s workbook inside a document adds its own names', async () => {
  const files: Record<string, Uint8Array> = unzipSync(docx())
  const book = Object.fromEntries(Object.entries(unzipSync(xlsx())).map(([n, d]) => [n, n === 'docProps/core.xml' ? utf8(new TextDecoder().decode(d).replace('Example Author', 'Example Chart Author')) : d]))
  files['word/embeddings/Microsoft_Excel_Worksheet.xlsx'] = zip(book)
  const list = await details(zip(files))
  assert.deepEqual(valuesOf(list, LABEL.author), ['Example Author', 'Example Chart Author'])
})

test('OpenDocument: author, last editor, title and generator; and the photo inside', async () => {
  for (const kind of ['text', 'spreadsheet', 'presentation'] as const) {
    const list = await details(odf(kind))
    assert.deepEqual(valuesOf(list, LABEL.author), ['Example Author'], kind)
    assert.deepEqual(valuesOf(list, LABEL.lastEditor), ['Example Editor'], kind)
    assert.deepEqual(valuesOf(list, LABEL.title), ['Example Title'], kind)
    assert.deepEqual(valuesOf(list, LABEL.app), ['ExampleOffice/1.0$ExampleOS'], kind)
    assert.deepEqual(valuesOf(list, LABEL.custom), [], kind)
    hasPhone(list, IN_PICTURES)
  }
})

test('PDF: author, title, creator and producer; the XMP creator tool; JPEG photos inside', async () => {
  const doc = await PDFDocument.create({ updateMetadata: false })
  doc.setTitle('Example Title')
  doc.setAuthor('Example Author')
  doc.setSubject('Example Subject')
  doc.setCreator('ExampleWriter 1.0')
  doc.setProducer('ExamplePDF 2.0')
  const page = doc.addPage([200, 200])
  page.drawText('Visible page text', { x: 10, y: 100, size: 12, font: await doc.embedFont(StandardFonts.Helvetica) })
  page.drawImage(await doc.embedJpg(grayJpeg(exifApp1(phoneExif(1)))), { x: 10, y: 10, width: 8, height: 8 })
  const xmp = xmpPacket(
    '<xmp:CreatorTool>ExampleWriter &amp; Co 1.0</xmp:CreatorTool><dc:creator><rdf:Seq><rdf:li>Example Author</rdf:li><rdf:li>Example Second Author</rdf:li></rdf:Seq></dc:creator>',
    ' xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/"',
  )
  doc.catalog.set(PDFName.of('Metadata'), doc.context.register(doc.context.stream(xmp, { Type: 'Metadata', Subtype: 'XML' })))
  const list = await details(await doc.save({ useObjectStreams: false }), { pdf: true })
  assert.deepEqual(valuesOf(list, LABEL.author), ['Example Author', 'Example Second Author'])
  assert.deepEqual(valuesOf(list, LABEL.title), ['Example Title', 'Example Subject'])
  assert.deepEqual(valuesOf(list, LABEL.app), ['ExampleWriter 1.0', 'ExamplePDF 2.0'])
  assert.deepEqual(valuesOf(list, LABEL.software), ['ExampleWriter & Co 1.0'])
  hasPhone(list, IN_PICTURES)
})

test('a file whose removed details hold nothing worth showing lists labels only', async () => {
  const list = await details(grayJpeg(seg(0xfe, 'Example comment')))
  assert.deepEqual(list, [{ label: LABEL.comments, values: [], more: 0 }])
})

// --- Contrived files (from the independent review) -------------------------

/** A PNG whose XMP is compressed, so a big packet fits in a tiny file. */
function pngWithXmp(xmp: string): Uint8Array {
  return cat(PNG_SIG, ihdr(), pngChunk('iTXt', cat('XML:com.adobe.xmp\0', [1, 0], '\0\0', zlibSync(utf8(xmp), { level: 9 }))), idat(), pngChunk('IEND', []))
}

const DC = ' xmlns:x="adobe:ns:meta/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/"'

async function quick(b: Uint8Array, ms = 3000) {
  const t = performance.now()
  const r = await stripBytes(b)
  const took = performance.now() - t
  assert.ok(took < ms, `took ${took.toFixed(0)} ms`)
  assert.equal(r.status, 'cleaned', JSON.stringify(r).slice(0, 200))
  return r.status === 'cleaned' ? r : assert.fail()
}

test('unclosed tags in XMP can’t make reading values slow', async () => {
  // Tags that never close, each one would once have rescanned the rest of the packet.
  await quick(pngWithXmp(`<x:xmpmeta${DC}><dc:creator>${'<rdf:li '.repeat(80_000)}</dc:creator></x:xmpmeta>`))
  await quick(pngWithXmp(`<x:xmpmeta${DC}>${'<dc:creator>'.repeat(60_000)}</x:xmpmeta>`))
  await quick(pngWithXmp(`<x:xmpmeta${DC}>${'<xmp:CreatorTool '.repeat(60_000)}</x:xmpmeta>`))
  await quick(pngWithXmp(`<x:xmpmeta${DC}>${' xmp:CreatorTool="'.repeat(60_000)}</x:xmpmeta>`))
  await quick(pngWithXmp(`<x:xmpmeta${DC}>${'<?'.repeat(100_000)}${'<!--'.repeat(100_000)}<dc:title>x</dc:title></x:xmpmeta>`))
  // A JPEG made of many large XMP segments.
  const segment = xmpApp1(`<x:xmpmeta${DC}><dc:creator>${'<rdf:li '.repeat(7_000)}</dc:creator></x:xmpmeta>`)
  await quick(grayJpeg(...Array.from({ length: 20 }, () => segment)))
})

test('XMP listing a huge number of names is cleaned, showing three and "more"', async () => {
  // About 3.5 MB once unpacked, under PNG text's 4 MB limit.
  const names = Array.from({ length: 150_000 }, (_, i) => `<rdf:li>N${i}</rdf:li>`).join('')
  const r = await quick(pngWithXmp(`<x:xmpmeta${DC}><dc:creator><rdf:Seq>${names}</rdf:Seq></dc:creator></x:xmpmeta>`))
  const author = r.details.find((d) => d.label === LABEL.author)!
  assert.deepEqual(author.values, ['N0', 'N1', 'N2'])
  assert.equal(author.more, -1)
})

test('a compressed ID3v2.2 tag lists its labels without showing garbage', async () => {
  const frame = cat('TT2', [0, 0, 14], '\0Example Title')
  const tag = (flags: number) => cat('ID3', [2, 0, flags], [0, 0, 0, frame.length], frame)
  assert.deepEqual(valuesOf(await details(cat(tag(0), mpegFrames(4))), LABEL.songInfo), ['Example Title'])
  assert.deepEqual(valuesOf(await details(cat(tag(0x40), mpegFrames(4))), LABEL.songInfo) ?? [], [])
})
