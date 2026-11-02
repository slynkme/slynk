// PNG, WebP and GIF.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { crc32 } from '../../src/strip/bytes.ts'
import { stripBytes } from '../../src/strip/engine.ts'
import { readExif } from '../../src/strip/exif.ts'
import { LABEL } from '../../src/strip/labels.ts'
import {
  PNG_SIG,
  animatedPng,
  animatedWebp,
  cat,
  contains,
  fakeVp8l,
  gifFrame,
  iccProfile,
  idat,
  ihdr,
  phoneExif,
  pngChunk,
  privateGif,
  privatePng,
  privateWebp,
  riffChunk,
  vp8x,
  webp,
} from './fixtures.ts'

async function clean(b: Uint8Array) {
  const r = await stripBytes(b)
  assert.equal(r.status, 'cleaned', JSON.stringify(r))
  if (r.status !== 'cleaned') throw new Error()
  return r
}

function pngChunks(b: Uint8Array) {
  const out: { type: string; data: Uint8Array; crcOk: boolean }[] = []
  for (let i = 8; i < b.length; ) {
    const len = new DataView(b.buffer, b.byteOffset + i).getUint32(0)
    const type = String.fromCharCode(...b.subarray(i + 4, i + 8))
    const crc = new DataView(b.buffer, b.byteOffset + i + 8 + len).getUint32(0)
    out.push({ type, data: b.subarray(i + 8, i + 8 + len), crcOk: crc === crc32(b.subarray(i + 4, i + 8 + len)) })
    i += 12 + len
  }
  return out
}

function riffChunks(b: Uint8Array) {
  const out: { id: string; data: Uint8Array }[] = []
  for (let i = 12; i < b.length; ) {
    const size = new DataView(b.buffer, b.byteOffset + i + 4).getUint32(0, true)
    out.push({ id: String.fromCharCode(...b.subarray(i, i + 4)), data: b.subarray(i + 8, i + 8 + size) })
    i += 8 + size + (size & 1)
  }
  return out
}

// --- PNG ----------------------------------------------------------------------

test('PNG: removes text, EXIF, XMP, timestamps, C2PA, private chunks and trailers', async () => {
  const input = privatePng()
  const r = await clean(input)
  for (const s of ['Example Author', 'ExampleCam', 'an example prompt', 'c2pa manifest', 'private data', 'TRAILING-SECRET', 'Raw profile']) {
    assert.ok(contains(input, s) || s === 'ExampleCam', s)
    assert.ok(!contains(r.bytes, s), s)
  }
  for (const l of [LABEL.gps, LABEL.camera, LABEL.author, LABEL.prompt, LABEL.dates, LABEL.c2pa, LABEL.history, LABEL.trailing, LABEL.other]) {
    assert.ok(r.removed.includes(l), l)
  }
})

test('PNG: keeps ICC, gamma and image data, re-creates Orientation, CRCs valid', async () => {
  const r = await clean(privatePng())
  const chunks = pngChunks(r.bytes)
  assert.deepEqual(chunks.map((c) => c.type), ['IHDR', 'iCCP', 'gAMA', 'eXIf', 'IDAT', 'IEND'])
  assert.ok(chunks.every((c) => c.crcOk))
  const exif = readExif(chunks[3].data)
  assert.equal(exif.orientation, 6)
  assert.deepEqual(exif.labels, [])
  assert.deepEqual(chunks[4].data, pngChunks(cat(PNG_SIG, idat()))[0].data)
})

test('PNG: APNG animation chunks survive in order', async () => {
  const input = animatedPng()
  const r = await clean(input)
  assert.deepEqual(r.removed, [LABEL.comments])
  const before = pngChunks(input).filter((c) => c.type !== 'tEXt')
  assert.deepEqual(pngChunks(r.bytes), before)
})

test('PNG: idempotent, and a plain PNG is unchanged', async () => {
  const a = await clean(privatePng())
  const b = await clean(privatePng())
  assert.deepEqual(a.bytes, b.bytes)
  assert.equal((await stripBytes(a.bytes)).status, 'unchanged')
  assert.equal((await stripBytes(cat(PNG_SIG, ihdr(), idat(), pngChunk('IEND', [])))).status, 'unchanged')
})

test('PNG: malformed input fails cleanly', async () => {
  const good = privatePng()
  for (const b of [good.subarray(0, 20), good.subarray(0, good.length - 30), cat(PNG_SIG, pngChunk('IDAT', [1]), pngChunk('IEND', [])), cat(PNG_SIG, [0xff, 0xff, 0xff, 0xff])]) {
    const r = await stripBytes(b)
    assert.ok(r.status === 'failed' || r.status === 'unsupported', r.status)
  }
})

// --- WebP ---------------------------------------------------------------------

test('WebP: removes EXIF, XMP, C2PA and unknown chunks; fixes flags and size', async () => {
  const input = privateWebp()
  const r = await clean(input)
  for (const s of ['Example Author', 'ExampleCam', 'manifest', 'unknown', 'TRAILING']) assert.ok(!contains(r.bytes, s), s)
  const chunks = riffChunks(r.bytes)
  assert.deepEqual(chunks.map((c) => c.id), ['VP8X', 'ICCP', 'ALPH', 'VP8L', 'EXIF'])
  // ICC and alpha bits stay; EXIF stays (Orientation 8 only); XMP goes.
  assert.equal(chunks[0].data[0], 0x20 | 0x10 | 0x08)
  assert.deepEqual(chunks[1].data, iccProfile())
  assert.equal(readExif(chunks[4].data).orientation, 8)
  assert.equal(new DataView(r.bytes.buffer, r.bytes.byteOffset + 4).getUint32(0, true), r.bytes.length - 8)
  for (const l of [LABEL.gps, LABEL.author, LABEL.c2pa, LABEL.other, LABEL.trailing]) assert.ok(r.removed.includes(l), l)
  assert.equal((await stripBytes(r.bytes)).status, 'unchanged')
})

test('WebP: animation frames are kept byte for byte', async () => {
  const input = animatedWebp()
  const r = await clean(input)
  const before = riffChunks(input).filter((c) => c.id === 'ANIM' || c.id === 'ANMF')
  const after = riffChunks(r.bytes)
  assert.deepEqual(after.map((c) => c.id), ['VP8X', 'ANIM', 'ANMF', 'ANMF'])
  assert.deepEqual(after.slice(1), before)
  assert.equal(after[0].data[0], 0x02) // animation flag kept, EXIF flag cleared
})

test('WebP: a simple lossless file is unchanged; malformed input fails', async () => {
  assert.equal((await stripBytes(webp([fakeVp8l()]))).status, 'unchanged')
  const good = privateWebp()
  for (const b of [good.subarray(0, 30), cat('RIFF', [0xff, 0xff, 0, 0], 'WEBP', riffChunk('VP8L', [1]))]) {
    const r = await stripBytes(b)
    assert.ok(r.status === 'failed' || r.status === 'unsupported', r.status)
  }
  const exifOnly = webp([vp8x(0x08), fakeVp8l(), riffChunk('EXIF', phoneExif(1))])
  const r = await clean(exifOnly)
  assert.deepEqual(riffChunks(r.bytes).map((c) => c.id), ['VP8X', 'VP8L'])
})

// --- GIF ----------------------------------------------------------------------

test('GIF: removes comments, XMP, C2PA and trailers; keeps frames and looping', async () => {
  const input = privateGif()
  const r = await clean(input)
  for (const s of ['Example comment', 'Example Author', 'XMP DataXMP', 'C2PA_GIF', 'TRAILING']) assert.ok(!contains(r.bytes, s), s)
  assert.ok(contains(r.bytes, 'NETSCAPE2.0'))
  const frames = cat(gifFrame(1), gifFrame(2))
  assert.ok(Buffer.from(r.bytes).includes(Buffer.from(frames)))
  assert.equal(r.bytes[r.bytes.length - 1], 0x3b)
  for (const l of [LABEL.comments, LABEL.author, LABEL.c2pa, LABEL.trailing]) assert.ok(r.removed.includes(l), l)
  assert.equal((await stripBytes(r.bytes)).status, 'unchanged')
  const again = await clean(privateGif())
  assert.deepEqual(again.bytes, r.bytes)
})

test('GIF: malformed input fails cleanly', async () => {
  const good = privateGif()
  for (const b of [good.subarray(0, 12), good.subarray(0, 60), cat('GIF89a', [1, 0, 1, 0, 0, 0, 0], [0x99])]) {
    const r = await stripBytes(b)
    assert.ok(r.status === 'failed' || r.status === 'unsupported', r.status)
  }
})
