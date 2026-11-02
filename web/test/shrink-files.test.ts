// "Make a smaller copy": reading a photo's header without decoding it, and
// keeping only the picture data of a browser-made copy (bare.ts).
// Run from the repo root: npm --prefix web test
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { barePicture } from '../src/shrink/bare.ts'
import { photoInfo } from '../src/shrink/info.ts'
import {
  PNG_SIG,
  animatedPng,
  animatedWebp,
  be16,
  be32,
  box,
  cat,
  contains,
  exifApp1,
  fakeVp8l,
  fullBox,
  gifFrame,
  grayJpeg,
  heif,
  iccApp2,
  idat,
  ihdr,
  jfifApp0,
  jpegSegments,
  le16,
  phoneExif,
  pngChunk,
  privateGif,
  privatePng,
  riffChunk,
  seg,
  vp8x,
  webp,
  xmpApp1,
  PRIVATE_XMP,
} from './strip/fixtures.ts'

// --- photoInfo ------------------------------------------------------------------

function jpegSized(width: number, height: number, ...app: Uint8Array[]): Uint8Array {
  return cat([0xff, 0xd8], ...app, seg(0xdb, cat([0], new Array(64).fill(1))), seg(0xc2, [8, ...be16(height), ...be16(width), 1, 1, 0x11, 0]), [0xff, 0xd9])
}

test('JPEG: the size from the frame header, past EXIF and fill bytes', () => {
  assert.deepEqual(photoInfo(jpegSized(4032, 3024, exifApp1(phoneExif(6)), xmpApp1(PRIVATE_XMP))), {
    kind: 'jpeg',
    dims: { width: 4032, height: 3024 },
    still: true,
  })
  const filled = jpegSized(640, 480)
  const withFill = cat(filled.subarray(0, 2), [0xff, 0xff], filled.subarray(2))
  assert.deepEqual(photoInfo(withFill)?.dims, { width: 640, height: 480 })
  assert.equal(photoInfo(grayJpeg())?.dims?.width, 8)
  // Cut short before the frame header: still a photo, size unknown.
  assert.deepEqual(photoInfo(cat([0xff, 0xd8, 0xff], exifApp1(phoneExif(1)).subarray(1))), { kind: 'jpeg', dims: undefined, still: true })
})

test('PNG: the size from IHDR; APNG isn’t a still', () => {
  const png = cat(PNG_SIG, pngChunk('IHDR', [...be32(1920), ...be32(1080), 8, 6, 0, 0, 0]), idat(), pngChunk('IEND', []))
  assert.deepEqual(photoInfo(png), { kind: 'png', dims: { width: 1920, height: 1080 }, still: true })
  assert.equal(photoInfo(privatePng())?.still, true)
  assert.equal(photoInfo(animatedPng())?.still, false)
  // No image data where it should be: not offered.
  assert.equal(photoInfo(cat(PNG_SIG, ihdr(), pngChunk('tEXt', 'a\0b')))?.still, false)
})

test('GIF: one frame is a still; two are an animation; broken ones aren’t offered', () => {
  const head = cat('GIF89a', [...le16(300), ...le16(200), 0x80, 0, 0], [0, 0, 0, 255, 255, 255])
  assert.deepEqual(photoInfo(cat(head, gifFrame(1), [0x3b])), { kind: 'gif', dims: { width: 300, height: 200 }, still: true })
  assert.equal(photoInfo(cat(head, gifFrame(1), gifFrame(2), [0x3b]))?.still, false)
  assert.equal(photoInfo(privateGif())?.still, false)
  assert.equal(photoInfo(cat(head, [0x99, 1, 2, 3]))?.still, false)
  assert.equal(photoInfo(cat(head, gifFrame(1)).subarray(0, 30))?.still, false)
})

test('WebP: the size from VP8X, VP8L or VP8; animations aren’t stills', () => {
  const x = riffChunk('VP8X', [0x10, 0, 0, 0, ...[0x7f, 0x07, 0], ...[0x37, 0x04, 0]]) // 1920 x 1080
  assert.deepEqual(photoInfo(webp([x, fakeVp8l()])), { kind: 'webp', dims: { width: 1920, height: 1080 }, still: true })
  assert.equal(photoInfo(animatedWebp())?.still, false)
  assert.deepEqual(photoInfo(webp([fakeVp8l()]))?.dims, { width: 1, height: 1 })
  const vp8 = riffChunk('VP8 ', [0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a, ...le16(800), ...le16(600), 0, 0])
  assert.deepEqual(photoInfo(webp([vp8])), { kind: 'webp', dims: { width: 800, height: 600 }, still: true })
  assert.equal(photoInfo(webp([riffChunk('ZZZZ', 'what')]))?.still, false)
})

test('HEIC and AVIF: the largest ispe; image sequences aren’t stills', () => {
  const ispe = (w: number, h: number) => fullBox('ispe', 0, 0, be32(w), be32(h))
  const still = cat(box('ftyp', 'heic', be32(0), 'mif1', 'heic'), fullBox('meta', 0, 0, box('iprp', box('ipco', ispe(512, 512), ispe(4032, 3024), ispe(512, 512)))))
  assert.deepEqual(photoInfo(still), { kind: 'heic', dims: { width: 4032, height: 3024 }, still: true })
  assert.equal(photoInfo(heif('avif').bytes)?.kind, 'avif')
  assert.equal(photoInfo(heif('heic').bytes)?.still, true)
  const sequence = cat(box('ftyp', 'avis', be32(0), 'avis', 'msf1', 'miaf'), fullBox('meta', 0, 0, ispe(640, 480)))
  assert.equal(photoInfo(sequence)?.still, false)
})

test('anything that isn’t a photo is null', () => {
  assert.equal(photoInfo(new TextEncoder().encode('just some text, not a photo')), null)
  assert.equal(photoInfo(cat('%PDF-1.7\n', new Array(40).fill(32))), null)
  assert.equal(photoInfo(new Uint8Array(3)), null)
  assert.equal(photoInfo(cat(box('ftyp', 'qt  ', be32(0), 'qt  '), box('moov'))), null) // a video
})

// --- barePicture -------------------------------------------------------------------

/** A JPEG the way a browser might save one: JFIF, a colour profile, maybe EXIF, then the picture. */
function browserJpeg(...extra: Uint8Array[]): Uint8Array {
  const core = grayJpeg().subarray(2) // tables, frame, scan, end
  return cat([0xff, 0xd8], jfifApp0(), iccApp2(), ...extra, core)
}

test('JPEG: keeps the tables, frame and scan; drops every APP segment and comment', () => {
  const input = browserJpeg(exifApp1(phoneExif(6)), seg(0xfe, 'a comment'), xmpApp1(PRIVATE_XMP))
  const out = barePicture(input, 'image/jpeg')
  const markers = jpegSegments(out).map((s) => s.marker)
  assert.deepEqual(markers, jpegSegments(grayJpeg()).map((s) => s.marker))
  assert.ok(!markers.some((m) => (m >= 0xe0 && m <= 0xef) || m === 0xfe))
  assert.deepEqual(out, grayJpeg())
  for (const s of ['JFIF', 'ICC_PROFILE', 'Exif', 'comment', 'xmp']) assert.ok(!contains(out, s), s)
})

test('JPEG: scan data with stuffed bytes and restart markers passes through untouched, and trailing bytes go', () => {
  const scan = [0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0xff, 0xd7, 0x78]
  const picture = [
    seg(0xdb, cat([0], new Array(64).fill(1))),
    seg(0xc2, [8, ...be16(8), ...be16(8), 1, 1, 0x11, 0]),
    seg(0xc4, cat([0x00, 1], new Array(15).fill(0), [0])),
    seg(0xda, [1, 1, 0x00, 0, 0, 0]),
    cat(scan),
    seg(0xc4, cat([0x10, 1], new Array(15).fill(0), [0])),
  ]
  const second = [seg(0xda, [1, 1, 0x00, 1, 63, 0]), cat(scan), cat([0xff, 0xd9])]
  const progressive = cat([0xff, 0xd8], jfifApp0(), ...picture, seg(0xe1, 'Exif\0\0between scans'), ...second, 'TRAILING')
  assert.deepEqual(barePicture(progressive, 'image/jpeg'), cat([0xff, 0xd8], ...picture, ...second))
})

test('JPEG: fill bytes before a marker are allowed', () => {
  const core = grayJpeg().subarray(2)
  assert.deepEqual(barePicture(cat([0xff, 0xd8], jfifApp0(), [0xff, 0xff, 0xff], core), 'image/jpeg'), grayJpeg())
})

test('JPEG: refuses anything broken rather than guess', () => {
  const good = browserJpeg()
  assert.throws(() => barePicture(good.subarray(0, good.length - 2), 'image/jpeg'))
  assert.throws(() => barePicture(good.subarray(0, 30), 'image/jpeg'))
  assert.throws(() => barePicture(cat([0xff, 0xd8, 0x00, 0x00]), 'image/jpeg'))
  assert.throws(() => barePicture(cat(PNG_SIG), 'image/jpeg'))
})

test('WebP: keeps the picture and alpha, with VP8X saying only "alpha"', () => {
  const input = webp([vp8x(0x20 | 0x10 | 0x08 | 0x04), riffChunk('ICCP', 'a colour profile'), riffChunk('ALPH', [0, 1, 2]), fakeVp8l(), riffChunk('EXIF', 'Exif data')])
  const out = barePicture(input, 'image/webp')
  assert.deepEqual(out, webp([vp8x(0x10), riffChunk('ALPH', [0, 1, 2]), fakeVp8l()]))
  // RIFF size is right.
  assert.equal(new DataView(out.buffer).getUint32(4, true), out.length - 8)
  // Without alpha, the plain form.
  assert.deepEqual(barePicture(webp([vp8x(0x20), riffChunk('ICCP', 'profile'), fakeVp8l()]), 'image/webp'), webp([fakeVp8l()]))
  assert.deepEqual(barePicture(webp([fakeVp8l()]), 'image/webp'), webp([fakeVp8l()]))
  assert.throws(() => barePicture(webp([riffChunk('ICCP', 'profile')]), 'image/webp'))
  assert.throws(() => barePicture(webp([riffChunk('ALPH', [1]), fakeVp8l()]), 'image/webp')) // alpha needs VP8X
  assert.throws(() => barePicture(webp([fakeVp8l()]).subarray(0, 20), 'image/webp'))
})

test('PNG: keeps IHDR, PLTE, tRNS, IDAT and IEND only', () => {
  const firefoxish = cat(PNG_SIG, ihdr(), pngChunk('deBG', '0123456789abcdef'), pngChunk('iCCP', 'p\0\0x'), pngChunk('tRNS', [0, 1]), idat(), pngChunk('IEND', []))
  assert.deepEqual(barePicture(firefoxish, 'image/png'), cat(PNG_SIG, ihdr(), pngChunk('tRNS', [0, 1]), idat(), pngChunk('IEND', [])))
  const bare = barePicture(privatePng(), 'image/png')
  assert.deepEqual(bare, cat(PNG_SIG, ihdr(), idat(), pngChunk('IEND', [])))
  for (const s of ['Example', 'exif', 'TRAILING', 'c2pa']) assert.ok(!contains(bare, s), s)
  assert.throws(() => barePicture(cat(PNG_SIG, ihdr(), idat()), 'image/png')) // no IEND
})

test('only the three types a copy can be', () => {
  assert.throws(() => barePicture(grayJpeg(), 'image/gif'), /unexpected/)
})
