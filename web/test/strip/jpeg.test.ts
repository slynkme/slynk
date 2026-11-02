import assert from 'node:assert/strict'
import { test } from 'node:test'
import { stripBytes } from '../../src/strip/engine.ts'
import { readExif } from '../../src/strip/exif.ts'
import { LABEL } from '../../src/strip/labels.ts'
import {
  GAIN_MAP_PARAMS,
  ISO_GAIN_MAP_PARAMS,
  ISO_GAIN_MAP_VERSION,
  PRIVATE_XMP,
  adobeApp14,
  cat,
  contains,
  exifApp1,
  fakeVideo,
  grayJpeg,
  iccApp2,
  jfifApp0,
  jpegCore,
  jpegSegments,
  mpfGainMap,
  phoneExif,
  seg,
  text,
  tiff,
  ultraHdrMotionPhoto,
  utf8,
  xmpApp1,
  xmpPacket,
} from './fixtures.ts'

async function clean(b: Uint8Array) {
  const r = await stripBytes(b)
  assert.equal(r.status, 'cleaned', JSON.stringify(r))
  if (r.status !== 'cleaned') throw new Error()
  return r
}

function privateJpeg(): Uint8Array {
  return cat(
    [0xff, 0xd8],
    jfifApp0(2),
    exifApp1(phoneExif(6)),
    xmpApp1(PRIVATE_XMP),
    iccApp2(),
    seg(0xed, cat('Photoshop 3.0\0', '8BIM', [0x04, 0x04], [0, 0], [0, 0, 0, 4], 'IPTC')),
    seg(0xeb, cat('JP', [0, 0], 'jumbc2pa')),
    seg(0xfe, 'Example comment'),
    adobeApp14(),
    seg(0xec, 'Ducky'),
    jpegCore(),
    [0xff, 0xd9],
    'SAMSUNG-TRAILER-MotionPhoto_Data',
  )
}

test('JPEG: removes EXIF, GPS, XMP, IPTC, C2PA, comments and trailers', async () => {
  const input = privateJpeg()
  for (const s of ['ExampleCam', 'Example Author', 'Example comment', 'jumbc2pa', 'MotionPhoto_Data', '12,20.4N']) assert.ok(contains(input, s))
  const r = await clean(input)
  for (const s of ['ExampleCam', 'Example Author', 'Example comment', 'jumbc2pa', 'MotionPhoto_Data', '12,20.4N', 'Photoshop', 'Ducky', 'SN-EXAMPLE']) {
    assert.ok(!contains(r.bytes, s), s)
  }
  for (const l of [LABEL.gps, LABEL.camera, LABEL.dateTaken, LABEL.serial, LABEL.makerNotes, LABEL.thumbnail, LABEL.c2pa, LABEL.iptc, LABEL.comments, LABEL.author, LABEL.software, LABEL.motion]) {
    assert.ok(r.removed.includes(l), l)
  }
  // Most telling first.
  assert.equal(r.removed[0], LABEL.gps)
})

test('JPEG: keeps Orientation, ICC, Adobe and JFIF (without its thumbnail) and the image data', async () => {
  const r = await clean(privateJpeg())
  const segs = jpegSegments(r.bytes)
  const exif = segs.filter((s) => s.marker === 0xe1)
  assert.equal(exif.length, 1)
  const info = readExif(exif[0].payload.subarray(6))
  assert.equal(info.orientation, 6)
  assert.deepEqual(info.labels, [])
  assert.equal(exif[0].payload.length, 32) // the 36-byte Orientation-only APP1
  const icc = segs.find((s) => s.marker === 0xe2)!
  assert.deepEqual(icc.payload, iccApp2().subarray(4))
  assert.ok(segs.some((s) => s.marker === 0xee && text(s.payload).startsWith('Adobe')))
  const jfif = segs.find((s) => s.marker === 0xe0)!
  assert.equal(jfif.payload.length, 14)
  assert.equal(jfif.payload[12], 0)
  // Tables, frame header, scan and entropy-coded data are byte for byte the same.
  const core = jpegCore()
  assert.ok(Buffer.from(r.bytes).includes(Buffer.from(core)))
  assert.deepEqual([...r.bytes.subarray(-2)], [0xff, 0xd9])
})

test('JPEG: Orientation 1 needs no EXIF at all', async () => {
  const r = await clean(grayJpeg(exifApp1(phoneExif(1))))
  assert.ok(!jpegSegments(r.bytes).some((s) => s.marker === 0xe1))
  assert.deepEqual(r.bytes, grayJpeg())
})

test('JPEG: harmless EXIF and nothing else means unchanged', async () => {
  const harmless = tiff([{ tag: 0x0112, type: 3, value: [3] }, { tag: 0x011a, type: 5, value: [72, 1] }])
  assert.equal((await stripBytes(grayJpeg(exifApp1(harmless), iccApp2()))).status, 'unchanged')
  assert.equal((await stripBytes(grayJpeg())).status, 'unchanged')
})

test('JPEG: stripping twice gives identical bytes', async () => {
  const input = privateJpeg()
  const a = await clean(input)
  const b = await clean(privateJpeg())
  assert.deepEqual(a.bytes, b.bytes)
  const again = await stripBytes(a.bytes)
  assert.equal(again.status, 'unchanged')
})

test('JPEG: progressive files with segments between scans', async () => {
  const scan = (data: number[]) => cat(seg(0xda, [1, 1, 0x00, 0, 63, 0]), data)
  const input = cat(
    [0xff, 0xd8],
    exifApp1(phoneExif(3)),
    seg(0xdb, cat([0x00], new Array(64).fill(1))),
    seg(0xc2, [8, 0, 8, 0, 8, 1, 1, 0x11, 0]),
    seg(0xc4, cat([0x00, 1], new Array(15).fill(0), [0x00])),
    scan([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56]),
    seg(0xe1, cat('http://ns.adobe.com/xap/1.0/\0', PRIVATE_XMP)),
    seg(0xc4, cat([0x10, 1], new Array(15).fill(0), [0x00])),
    scan([0x78, 0xff, 0x00, 0x9a]),
    seg(0xfe, 'between scans'),
    scan([0xbc]),
    [0xff, 0xd9],
  )
  const r = await clean(input)
  assert.ok(!contains(r.bytes, 'between scans'))
  assert.ok(!contains(r.bytes, 'Example Author'))
  // All three scans and their data survive, stuffed bytes and restart markers included.
  assert.ok(Buffer.from(r.bytes).includes(Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56])))
  assert.equal(Buffer.from(r.bytes).filter((_, i, a) => a[i] === 0xff && a[i + 1] === 0xda).length, 3)
  assert.equal(readExif(jpegSegments(r.bytes).find((s) => s.marker === 0xe1)!.payload.subarray(6)).orientation, 3)
})

test('JPEG: Ultra HDR gain map is kept and cleaned; the motion video is cut', async () => {
  const { bytes, gainMapCore } = ultraHdrMotionPhoto()
  assert.ok(contains(bytes, 'VIDEOFRAMES'))
  const r = await clean(bytes)
  assert.ok(r.removed.includes(LABEL.motion))
  assert.ok(r.removed.includes(LABEL.gps))
  assert.ok(!contains(r.bytes, 'VIDEOFRAMES'))
  assert.ok(!contains(r.bytes, 'ExampleCam'))
  assert.ok(!contains(r.bytes, 'ExampleCamera App'))
  assert.ok(!contains(r.bytes, 'Example Author'))
  assert.ok(!contains(r.bytes, 'MotionPhoto'))

  // The primary: Orientation-only EXIF, gain-map XMP, ICC and an MPF index.
  const segs = jpegSegments(r.bytes)
  const xmp = text(segs.find((s) => s.marker === 0xe1 && text(s.payload.subarray(0, 29)).startsWith('http://ns.adobe.com/xap'))!.payload)
  assert.match(xmp, /hdrgm:Version="1.0"/)
  const mpfSeg = segs.find((s) => s.marker === 0xe2 && text(s.payload.subarray(0, 4)) === 'MPF\0')!
  const t = mpfSeg.payload.subarray(4)
  const dv = new DataView(t.buffer, t.byteOffset)
  assert.equal(dv.getUint32(50), 0x00030000) // primary attributes copied over
  const primarySize = dv.getUint32(54)
  const gmSize = dv.getUint32(54 + 16)
  const gmOffset = dv.getUint32(58 + 16)
  const tiffStart = mpfSeg.start + 8
  assert.equal(tiffStart + gmOffset, primarySize)
  assert.equal(primarySize + gmSize, r.bytes.length)
  assert.match(xmp, new RegExp(`Item:Semantic="GainMap" Item:Mime="image/jpeg" Item:Length="${gmSize}"`))

  // The gain map: its parameters survive, its EXIF and app name don't.
  const gm = r.bytes.subarray(primarySize)
  assert.deepEqual([...gm.subarray(0, 2)], [0xff, 0xd8])
  const gmSegs = jpegSegments(gm)
  assert.ok(!gmSegs.some((s) => s.marker === 0xe1 && text(s.payload.subarray(0, 4)) === 'Exif'))
  const gmXmp = text(gmSegs.find((s) => s.marker === 0xe1)!.payload)
  for (const p of GAIN_MAP_PARAMS.split(' ')) assert.ok(gmXmp.includes(p), p)
  assert.ok(Buffer.from(gm).includes(Buffer.from(gainMapCore)))

  // A second pass finds nothing to do.
  assert.equal((await stripBytes(r.bytes)).status, 'unchanged')
})

test('JPEG: gain-map parameters written as elements (Adobe style) survive', async () => {
  const hdrgm = ' xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/"'
  const params =
    '<hdrgm:GainMapMax><rdf:Seq><rdf:li>2.1</rdf:li><rdf:li>2.2</rdf:li><rdf:li>2.3</rdf:li></rdf:Seq></hdrgm:GainMapMax>' +
    '<hdrgm:HDRCapacityMax>2.3</hdrgm:HDRCapacityMax><xmp:CreatorTool>ExampleEditor 2.0</xmp:CreatorTool>'
  const input = mpfGainMap(
    [xmpApp1(xmpPacket('', `${hdrgm} hdrgm:Version="1.0"`))],
    [xmpApp1(xmpPacket(params, `${hdrgm} xmlns:xmp="http://ns.adobe.com/xap/1.0/" hdrgm:Version="1.0"`))],
  )
  const r = await clean(input)
  assert.ok(!contains(r.bytes, 'ExampleEditor'))
  const xmp = text(r.bytes)
  for (const v of ['<rdf:li>2.1</rdf:li>', '<rdf:li>2.3</rdf:li>', 'hdrgm:Version="1.0"']) assert.ok(xmp.includes(v), v)
  assert.match(xmp, /<hdrgm:HDRCapacityMax[^>]*>2\.3<\/hdrgm:HDRCapacityMax>/)
  assert.equal((await stripBytes(r.bytes)).status, 'unchanged')
})

test('JPEG: an ISO 21496-1 gain map (no XMP) is kept through MPF', async () => {
  const input = mpfGainMap([ISO_GAIN_MAP_VERSION], [exifApp1(phoneExif(1)), ISO_GAIN_MAP_PARAMS])
  const r = await clean(input)
  assert.ok(!contains(r.bytes, 'ExampleCam'))
  const segs = jpegSegments(r.bytes)
  assert.ok(segs.some((s) => s.marker === 0xe2 && text(s.payload).startsWith('MPF')))
  assert.ok(segs.some((s) => s.marker === 0xe2 && text(s.payload).startsWith('urn:iso:std:iso:ts:21496:-1')))
  assert.ok(Buffer.from(r.bytes).includes(Buffer.from(ISO_GAIN_MAP_PARAMS)))
  assert.equal((await stripBytes(r.bytes)).status, 'unchanged')
})

test('JPEG: a gain map the photo does not declare is cut like any trailer', async () => {
  const input = cat(grayJpeg(exifApp1(phoneExif(1))), grayJpeg(xmpApp1(xmpPacket('', ` xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/" ${GAIN_MAP_PARAMS}`))))
  const r = await clean(input)
  assert.deepEqual(r.bytes, grayJpeg())
  assert.ok(r.removed.includes(LABEL.trailing))
})

test('JPEG: motion photo video after a plain JPEG is cut', async () => {
  const r = await clean(cat(grayJpeg(), fakeVideo()))
  assert.deepEqual(r.bytes, grayJpeg())
  assert.deepEqual(r.removed, [LABEL.motion])
})

test('JPEG: malformed input fails cleanly', async () => {
  const good = privateJpeg()
  const cases = [
    good.subarray(0, 3),
    good.subarray(0, 40),
    good.subarray(0, good.indexOf(0xda) + 8),
    cat([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff], utf8('short')),
    cat([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x01]),
    cat([0xff, 0xd8], jpegCore()), // no end marker
  ]
  for (const b of cases) {
    const r = await stripBytes(b)
    assert.ok(r.status === 'failed' || r.status === 'unsupported', `${r.status} for ${b.length} bytes`)
  }
})
