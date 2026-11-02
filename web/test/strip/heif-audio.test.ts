// HEIC/AVIF, MP3 and FLAC.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { stripBytes } from '../../src/strip/engine.ts'
import { LABEL } from '../../src/strip/labels.ts'
import {
  FLAC_FRAMES,
  PRIVATE_ID3,
  SEEKTABLE,
  STREAMINFO,
  apeTag,
  cat,
  contains,
  flacBlock,
  heif,
  id3v1,
  id3v2,
  mpegFrames,
  privateFlac,
  privateMp3,
  text,
} from './fixtures.ts'

async function clean(b: Uint8Array) {
  const r = await stripBytes(b)
  assert.equal(r.status, 'cleaned', JSON.stringify(r))
  if (r.status !== 'cleaned') throw new Error()
  return r
}

function topBoxes(b: Uint8Array) {
  const out: { type: string; start: number; end: number }[] = []
  for (let i = 0; i < b.length; ) {
    const size = new DataView(b.buffer, b.byteOffset + i).getUint32(0)
    out.push({ type: text(b.subarray(i + 4, i + 8)), start: i, end: i + size })
    i += size
  }
  return out
}

test('HEIC: Samsung\u2019s sefd box (when the photo was taken, to the millisecond) is blanked to a free box', async () => {
  // As a Samsung phone writes it after the meta box, with a made-up moment (14 Nov 2023).
  const sef = cat('\0\0\x01\x0a\x0e\0\0\0Image_UTC_Data1700000000000', '\0\0\x61\x0c\x18\0\0\0Camera_Capture_Mode_Info1', 'SEFH', 'SEFT')
  const sefd = cat(new Uint8Array([0, 0, 0, 8 + sef.length]), 'sefd', sef)
  const { bytes, image } = heif('heic')
  const withSef = cat(bytes, sefd)
  const r = await clean(withSef)
  assert.ok(contains(withSef, 'Image_UTC_Data'))
  assert.ok(!contains(r.bytes, 'Image_UTC_Data1700000000000'))
  assert.ok(!contains(r.bytes, 'Camera_Capture_Mode_Info'))
  for (const l of [LABEL.dateTaken, LABEL.otherPhoto]) assert.ok(r.removed.includes(l), l)
  // Where it was, a free box of the same size, all zeros; the picture untouched.
  const after = topBoxes(r.bytes)
  const last = after[after.length - 1]
  assert.deepEqual([last.type, last.end - last.start, last.end], ['free', sefd.length, withSef.length])
  assert.ok(r.bytes.subarray(last.start + 8, last.end).every((x) => x === 0))
  const at = Buffer.from(withSef).indexOf(Buffer.from(image))
  assert.deepEqual(r.bytes.subarray(at, at + image.length), image)
  assert.equal((await stripBytes(r.bytes)).status, 'unchanged')
  // A blank one is left alone, and says nothing.
  const blank = cat(bytes, new Uint8Array([0, 0, 0, 24]), 'sefd', new Uint8Array(16))
  assert.ok(!(await clean(blank)).removed.includes(LABEL.otherPhoto))
})

/** A 'sefd' box laid out as Samsung writes it: each entry (type, name length, name, value), then their directory. */
function sefd(entries: [string, string][]): Uint8Array {
  const le = (v: number) => new Uint8Array([v & 255, (v >> 8) & 255, (v >> 16) & 255, v >>> 24])
  const blocks = entries.map(([name, value]) => cat(new Uint8Array([0, 0, 1, 10]), le(name.length), name, value))
  let at = 0
  const starts = blocks.map((b) => ((at += b.length), at - b.length))
  const dir = cat('SEFH', le(107), le(entries.length), ...blocks.map((b, i) => cat(new Uint8Array([0, 0, 1, 10]), le(at - starts[i]), le(b.length))))
  const body = cat(...blocks, dir, le(dir.length), 'SEFT')
  return cat(new Uint8Array([0, 0, (8 + body.length) >> 8, (8 + body.length) & 255]), 'sefd', body)
}

test('HEIC: Samsung’s sefd box is listed by what its entries hold: an edit in Samsung’s Gallery is editing history', async () => {
  // A photo already cleaned, so that all it lists is the box's.
  const bytes = (await clean(heif('heic').bytes)).bytes
  /** What's listed as removed, sorted. */
  const lists = async (entries: [string, string][]) => {
    const r = await clean(cat(bytes, sefd(entries)))
    // Gone, names and values (all but a one-character value, which turns up anywhere).
    for (const [name, value] of entries) assert.ok(!contains(r.bytes, name) && (value.length < 2 || !contains(r.bytes, value)), name)
    return r.removed.sort()
  }
  const taken: [string, string] = ['Image_UTC_Data', '1700000000000']
  const mode: [string, string] = ['Camera_Capture_Mode_Info', '1']
  // Made up, as a plain Save in the Gallery writes them: where the original is kept, and the crop, to undo it.
  const edit: [string, string][] = [
    ['PhotoEditor_Re_Edit_Data', '{"originalPath":"\\/data\\/sec\\/photoeditor\\/0\\/example_1.heic","clipInfoValue":"{\\"mCenterX\\":0.25}"}'],
    ['Original_Path_Hash_Key', 'example-hash/1'],
  ]
  assert.deepEqual(await lists([taken, mode]), [LABEL.dateTaken, LABEL.settings].sort())
  assert.deepEqual(await lists([taken, mode, ...edit]), [LABEL.dateTaken, LABEL.history, LABEL.settings].sort())
  // A copy saved from the Gallery keeps only the original's moment.
  assert.deepEqual(await lists([taken]), [LABEL.dateTaken])
  // An entry Slynk doesn't know is still removed, and said to be.
  assert.deepEqual(await lists([taken, ['Some_New_Data', 'secret']]), [LABEL.dateTaken, LABEL.otherPhoto].sort())
})

for (const brand of ['heic', 'avif'] as const) {
  test(`${brand.toUpperCase()}: blanks Exif and XMP in place, removes C2PA and the motion video`, async () => {
    const { bytes, image } = heif(brand)
    const r = await clean(bytes)
    for (const s of ['ExampleCam', 'Example Author', 'Example description', 'c2pa manifest', 'VIDEOFRAMES']) {
      assert.ok(contains(bytes, s), s)
      assert.ok(!contains(r.bytes, s), s)
    }
    for (const l of [LABEL.gps, LABEL.camera, LABEL.author, LABEL.description, LABEL.c2pa, LABEL.motion]) assert.ok(r.removed.includes(l), l)
    const before = topBoxes(bytes)
    const after = topBoxes(r.bytes)
    // Same boxes at the same offsets (uuid became free), minus the final mpvd.
    assert.deepEqual(after.map((b) => b.type), ['ftyp', 'meta', 'free', 'mdat'])
    assert.deepEqual(after.map((b) => [b.start, b.end]), before.slice(0, 4).map((b) => [b.start, b.end]))
    assert.equal(r.bytes.length, before[4].start)
    // The picture's bytes sit exactly where iloc says, untouched; so does the meta box outside the blanked items.
    const at = Buffer.from(bytes).indexOf(Buffer.from(image))
    assert.deepEqual(r.bytes.subarray(at, at + image.length), image)
    assert.ok(contains(r.bytes, 'irot'))
    // Exif item: offset 0, then an empty big-endian TIFF block.
    const exifAt = Buffer.from(r.bytes).indexOf(Buffer.from([0, 0, 0, 0, 0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 0]))
    assert.ok(exifAt > 0)
    assert.ok(contains(r.bytes, '<x:xmpmeta xmlns:x="adobe:ns:meta/"/>'))
    assert.equal(r.bytes.length < bytes.length, true)
    assert.equal((await stripBytes(r.bytes)).status, 'unchanged')
    assert.deepEqual((await clean(heif(brand).bytes)).bytes, r.bytes)
  })
}

test('HEIC: malformed input fails cleanly', async () => {
  const { bytes } = heif('heic')
  for (const cut of [20, 60, 120, 200, 300]) {
    const r = await stripBytes(bytes.subarray(0, cut))
    assert.ok(['failed', 'unsupported', 'unchanged', 'cleaned'].includes(r.status), r.status)
    if (r.status === 'cleaned') assert.ok(r.bytes.length <= cut)
  }
  // An iloc pointing outside the file.
  const broken = bytes.slice()
  const iloc = Buffer.from(broken).indexOf(Buffer.from('iloc'))
  broken.set([0x7f, 0xff, 0xff, 0xff], iloc + 4 + 4 + 2 + 2 + 2 + 2 + 2 + 2 + 2 + 4 + 4 + 2 + 2 + 2)
  const r = await stripBytes(broken)
  assert.ok(r.status === 'failed' || r.status === 'cleaned', r.status)
})

test('MP3: removes ID3v2, APE and ID3v1 tags; audio frames are untouched', async () => {
  const input = privateMp3()
  const r = await clean(input)
  assert.deepEqual(r.bytes, mpegFrames(6))
  assert.ok(contains(r.bytes, 'Info')) // the LAME/Info frame stays
  for (const l of [LABEL.songInfo, LABEL.coverArt, LABEL.comments, LABEL.dates, LABEL.otherAudio]) assert.ok(r.removed.includes(l), l)
  assert.equal((await stripBytes(r.bytes)).status, 'unchanged')
  assert.deepEqual((await clean(privateMp3())).bytes, r.bytes)
})

test('MP3: stacked and trailing-only tags', async () => {
  const stacked = cat(id3v2(PRIVATE_ID3.slice(0, 2)), id3v2(PRIVATE_ID3.slice(3, 4)), mpegFrames(3))
  assert.deepEqual((await clean(stacked)).bytes, mpegFrames(3))
  const trailing = cat(mpegFrames(3), apeTag())
  assert.deepEqual((await clean(trailing)).bytes, mpegFrames(3))
  const v1 = cat(mpegFrames(3), id3v1())
  assert.deepEqual((await clean(v1)).bytes, mpegFrames(3))
})

test('MP3: malformed input fails cleanly', async () => {
  const input = privateMp3()
  const tag = id3v2(PRIVATE_ID3)
  for (const b of [input.subarray(0, 8), input.subarray(0, tag.length - 5), cat(tag, 'not audio at all, just text'), cat(mpegFrames(2), 'APETAGEX', new Array(24).fill(0xff))]) {
    const r = await stripBytes(b)
    assert.ok(r.status === 'failed' || r.status === 'unsupported', `${r.status} ${b.length}`)
  }
})

test('FLAC: keeps STREAMINFO and SEEKTABLE, drops tags, pictures and padding', async () => {
  const input = privateFlac()
  const r = await clean(input)
  assert.deepEqual(r.bytes, cat('fLaC', flacBlock(0, STREAMINFO), flacBlock(3, SEEKTABLE, true), FLAC_FRAMES))
  for (const l of [LABEL.songInfo, LABEL.dates, LABEL.comments, LABEL.coverArt, LABEL.encoder]) assert.ok(r.removed.includes(l), l)
  assert.equal((await stripBytes(r.bytes)).status, 'unchanged')
  assert.deepEqual((await clean(privateFlac())).bytes, r.bytes)
})

test('FLAC: a leading ID3 tag and trailing ID3v1 go too; padding alone is not worth a rewrite', async () => {
  const input = cat(id3v2(PRIVATE_ID3.slice(0, 2)), privateFlac(), id3v1())
  const r = await clean(input)
  assert.ok(text(r.bytes.subarray(0, 4)) === 'fLaC')
  assert.ok(!contains(r.bytes, 'Example'))
  const padded = cat('fLaC', flacBlock(0, STREAMINFO), flacBlock(1, new Array(32).fill(0), true), FLAC_FRAMES)
  assert.equal((await stripBytes(padded)).status, 'unchanged')
})

test('FLAC: malformed input fails cleanly', async () => {
  const good = privateFlac()
  for (const b of [good.subarray(0, 10), good.subarray(0, 60), cat('fLaC', flacBlock(4, [1, 2, 3], true), FLAC_FRAMES), cat('fLaC', flacBlock(0, STREAMINFO, true), 'no frames')]) {
    const r = await stripBytes(b)
    assert.ok(r.status === 'failed' || r.status === 'unsupported', r.status)
  }
})
