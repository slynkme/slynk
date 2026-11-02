// MP4/MOV/3GP videos (strip/video.ts): built in code, every value invented
// (a location near 12.34° N, 56.78° E, "Example Phone 15", dates in June
// 2024, UTC). The pictures and sound must stay byte for byte where the sample
// tables say; only the details around them are blanked.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { indexOf } from '../../src/strip/bytes.ts'
import { stripBytes } from '../../src/strip/engine.ts'
import { LABEL, orderLabels } from '../../src/strip/labels.ts'
import { detectKind } from '../../src/strip/sniff.ts'
import { describe as describeFound } from '../../src/strip/values.ts'
import { heldIn, iso6709 } from '../../src/strip/video.ts'
import { type Part, be16, be32, box, cat, contains, fullBox, text } from './fixtures.ts'

const VIDEO = cat('VIDEO-SAMPLE-ONE.', 'VIDEO-SAMPLE-TWO.', 'VIDEO-SAMPLE-THREE')
const AUDIO = cat('AUDIO-SAMPLE-A', 'AUDIO-SAMPLE-B')
const SIZES = { video: [17, 17, 18], audio: [14, 14] }

/** A sample entry: reserved bytes and a data reference index, then whatever the format adds. */
const entry = (format: string, extra: Part = []) => box(format, [0, 0, 0, 0, 0, 0, 0, 1], extra)

/** A track: its header (with times), its handler, one sample format, and one chunk at offset. */
function trak(handler: string, format: string, sizes: number[], offset: number, extra: Uint8Array[] = []): Uint8Array {
  const stbl = box(
    'stbl',
    fullBox('stsd', 0, 0, be32(1), entry(format)),
    fullBox('stsz', 0, 0, be32(0), be32(sizes.length), ...sizes.map(be32)),
    fullBox('stsc', 0, 0, be32(1), be32(1), be32(sizes.length), be32(1)),
    fullBox('stco', 0, 0, be32(1), be32(offset)),
  )
  const times = cat(be32(0xe2f3a4b5), be32(0xe2f3a4b6))
  // tkhd v0: times, track id, reserved, duration, then the rest, with a rotation matrix kept as it is.
  const tkhd = fullBox('tkhd', 0, 3, times, be32(1), be32(0), be32(100), new Array(8).fill(0), new Array(8).fill(0), be32(0), be32(0x10000), be32(0), be32(0xffff0000), be32(0), be32(0), be32(0), be32(0x40000000), be32(0), be32(0))
  const mdhd = fullBox('mdhd', 0, 0, times, be32(600), be32(100), be16(0x55c4), be16(0))
  const hdlr = fullBox('hdlr', 0, 0, be32(0), handler, new Array(12).fill(0), '\0')
  return box('trak', tkhd, box('mdia', mdhd, hdlr, box('minf', stbl)), ...extra)
}

const mvhd = () => fullBox('mvhd', 0, 0, be32(0xe2f3a4b5), be32(0xe2f3a4b6), be32(600), be32(100), new Array(80).fill(0))

/** Apple's metadata: a plain 'meta' box with mdta keys, and items named by number. */
function appleMeta(pairs: [string, string][]): Uint8Array {
  const keys = fullBox('keys', 0, 0, be32(pairs.length), ...pairs.map(([k]) => cat(be32(8 + k.length), 'mdta', k)))
  const items = pairs.map(([, v], i) => cat(be32(8 + 16 + v.length), be32(i + 1), box('data', be32(1), be32(0), v)))
  return box('meta', fullBox('hdlr', 0, 0, be32(0), 'mdta', new Array(12).fill(0), '\0'), keys, box('ilst', ...items))
}

/** A QuickTime user-data text box (©xyz, ©mak…): length, language, text. */
const qt = (type: string, value: string) => box(type, be16(value.length), be16(0x15c7), value)

/** Lays out ftyp, wide, mdat (the samples), then moov, built with the samples' real offsets. */
function video(brand: string, compat: string[], samples: Uint8Array[], moov: (offsets: number[]) => Uint8Array, trailer: Part = []): { bytes: Uint8Array; mdat: [number, number] } {
  const ftyp = box('ftyp', brand, be32(0), ...compat)
  const wide = box('wide')
  const start = ftyp.length + wide.length + 8
  const offsets: number[] = []
  let at = start
  for (const s of samples) {
    offsets.push(at)
    at += s.length
  }
  const mdat = box('mdat', ...samples)
  return { bytes: cat(ftyp, wide, mdat, moov(offsets), trailer), mdat: [start, at] }
}

/** As an iPhone writes one: location, make, model, software and date in Apple's keys, and its own data track. */
function iphone() {
  return video('qt  ', ['qt  '], [VIDEO, AUDIO, cat('STILL-IMAGE-TIME')], ([v, a, m]) =>
    box(
      'moov',
      mvhd(),
      trak('vide', 'hvc1', SIZES.video, v),
      trak('soun', 'mp4a', SIZES.audio, a),
      trak('meta', 'mebx', [16], m),
      appleMeta([
        ['com.apple.quicktime.location.ISO6709', '+12.3456+056.7890+010.000/'],
        ['com.apple.quicktime.make', 'Example'],
        ['com.apple.quicktime.model', 'Example Phone 15'],
        ['com.apple.quicktime.software', '17.5.1'],
        ['com.apple.quicktime.creationdate', '2024-06-12T18:30:00Z'],
      ]),
    ),
  )
}

/** As an Android phone writes one: location in user data, an encoder in an iTunes-style list. */
function android(trailer: Part = []) {
  return video(
    'mp42',
    ['isom', 'mp42'],
    [VIDEO, AUDIO],
    ([v, a]) =>
      box(
        'moov',
        mvhd(),
        trak('vide', 'avc1', SIZES.video, v),
        trak('soun', 'mp4a', SIZES.audio, a),
        box(
          'udta',
          qt('\xa9xyz', '-12.3456-056.7890/'),
          fullBox('meta', 0, 0, fullBox('hdlr', 0, 0, be32(0), 'mdir', new Array(12).fill(0), '\0'), box('ilst', box('\xa9too', box('data', be32(1), be32(0), 'ExampleEncoder 2.1')))),
        ),
      ),
    trailer,
  )
}

/** As an action camera writes one: a track recording where it was as it filmed, and a serial in user data. */
function actionCam() {
  return video('mp41', ['mp41', 'isom'], [VIDEO, cat('GPS5-LAT-LON-ALT-RECORDING')], ([v, g]) =>
    box('moov', mvhd(), trak('vide', 'avc1', SIZES.video, v), trak('meta', 'gpmd', [26], g), box('udta', box('GPMF', 'CAMERA-SERIAL-EXAMPLE123'))),
  )
}

async function clean(b: Uint8Array) {
  const r = await stripBytes(b)
  assert.equal(r.status, 'cleaned', JSON.stringify(r))
  if (r.status !== 'cleaned') throw new Error()
  return r
}

const valuesOf = (r: Awaited<ReturnType<typeof clean>>, label: string) => r.details.find((d) => d.label === label)?.values ?? []

describe('videos: what’s found and removed', () => {
  test('an iPhone video: location, phone, software and date go; the pictures and sound stay where they were', async () => {
    const { bytes, mdat } = iphone()
    assert.equal(detectKind(bytes), 'mov')
    const r = await clean(bytes)
    for (const l of [LABEL.gps, LABEL.camera, LABEL.software, LABEL.dates, LABEL.other]) assert.ok(r.removed.includes(l), l)
    assert.deepEqual(valuesOf(r, LABEL.gps), ['12.3456° N, 56.789° E'])
    assert.deepEqual(valuesOf(r, LABEL.camera), ['Example Phone 15'])
    assert.deepEqual(valuesOf(r, LABEL.software), ['17.5.1'])
    assert.deepEqual(valuesOf(r, LABEL.dates), ['12 Jun 2024, 18:30'])
    for (const s of ['+12.3456', 'Example Phone', '17.5.1', '2024-06-12', 'STILL-IMAGE-TIME', 'com.apple.quicktime']) {
      assert.ok(contains(bytes, s), s)
      assert.ok(!contains(r.bytes, s), s)
    }
    // Same length; the video and audio samples untouched, byte for byte, where the sample tables point.
    assert.equal(r.bytes.length, bytes.length)
    assert.deepEqual(r.bytes.subarray(mdat[0], mdat[0] + VIDEO.length + AUDIO.length), cat(VIDEO, AUDIO))
    // The metadata box became a free box of the same size; the data track's sample is zeros, its track still there.
    assert.ok(contains(r.bytes, 'free'))
    assert.ok(contains(r.bytes, 'mebx'))
    assert.ok(!contains(r.bytes, 'mdta'))
    // Rotation (the track header's matrix) is kept.
    assert.ok(contains(r.bytes, String.fromCharCode(0xff, 0xff, 0, 0)))
  })

  test('an Android video: the location in user data, and the encoder, go', async () => {
    const { bytes, mdat } = android()
    assert.equal(detectKind(bytes), 'mp4')
    const r = await clean(bytes)
    assert.ok(r.removed.includes(LABEL.gps) && r.removed.includes(LABEL.software) && r.removed.includes(LABEL.dates))
    assert.deepEqual(valuesOf(r, LABEL.gps), ['12.3456° S, 56.789° W'])
    assert.deepEqual(valuesOf(r, LABEL.software), ['ExampleEncoder 2.1'])
    assert.ok(!contains(r.bytes, '-12.3456') && !contains(r.bytes, 'ExampleEncoder'))
    assert.equal(r.bytes.length, bytes.length)
    assert.deepEqual(r.bytes.subarray(mdat[0], mdat[1]), bytes.subarray(mdat[0], mdat[1]))
  })

  test('an action camera’s track of where it was is zeroed in place, and its serial goes', async () => {
    const { bytes, mdat } = actionCam()
    const r = await clean(bytes)
    assert.ok(r.removed.includes(LABEL.sensors))
    assert.ok(!contains(r.bytes, 'GPS5-LAT-LON') && !contains(r.bytes, 'CAMERA-SERIAL'))
    assert.deepEqual(r.bytes.subarray(mdat[0], mdat[0] + VIDEO.length), VIDEO)
    assert.ok(r.bytes.subarray(mdat[0] + VIDEO.length, mdat[1]).every((v) => v === 0))
    assert.ok(contains(r.bytes, 'gpmd'), 'the track itself stays, so the file still plays')
  })

  test('cleaned once, there’s nothing left: cleaning again changes nothing', async () => {
    for (const { bytes } of [iphone(), android(), actionCam()]) {
      const once = await clean(bytes)
      assert.deepEqual(await stripBytes(once.bytes), { status: 'unchanged', kind: detectKind(bytes) })
    }
  })

  test('whatever follows the last box is cut', async () => {
    const { bytes } = android('SAMSUNG-TRAILER-WITH-DETAILS')
    const r = await clean(bytes)
    assert.ok(r.removed.includes(LABEL.trailing))
    assert.ok(!contains(r.bytes, 'SAMSUNG-TRAILER'))
    assert.equal(r.bytes.length, bytes.length - 'SAMSUNG-TRAILER-WITH-DETAILS'.length)
  })
})

describe('videos too big to go: what they hold, read without their pictures and sound', () => {
  /** heldIn over the file's bytes, with every read kept to look at. */
  async function held(bytes: Uint8Array) {
    const reads: Uint8Array[] = []
    const read = async (offset: number, length: number) => {
      const r = bytes.slice(offset, offset + length)
      reads.push(r)
      return r
    }
    const h = await heldIn(read, bytes.length)
    const removed = orderLabels(h.labels)
    return { removed, details: describeFound(removed, h.values), reads }
  }

  test('the same list as cleaning gives: an iPhone’s, an Android phone’s with a trailer, an action camera’s', async () => {
    for (const { bytes } of [iphone(), android('SAMSUNG-TRAILER-WITH-DETAILS'), actionCam()]) {
      const r = await clean(bytes)
      const h = await held(bytes)
      assert.deepEqual(h.removed, r.removed)
      assert.deepEqual(h.details, r.details)
    }
  })

  test('the pictures and sound are never read', async () => {
    for (const { bytes } of [iphone(), android('SAMSUNG-TRAILER-WITH-DETAILS'), actionCam()]) {
      const { reads } = await held(bytes)
      assert.ok(reads.length > 0)
      for (const r of reads) for (const s of ['VIDEO-SAMPLE', 'AUDIO-SAMPLE']) assert.ok(!contains(r, s), s)
    }
  })

  test('a metadata track of nothing but zeros, and a cleaned video, hold nothing', async () => {
    const { bytes } = actionCam()
    const at = indexOf(bytes, 'GPS5-LAT-LON-ALT-RECORDING')
    const blanked = bytes.slice()
    blanked.fill(0, at, at + 26)
    assert.ok(!(await held(blanked)).removed.includes(LABEL.sensors))
    for (const { bytes } of [iphone(), android('SAMSUNG-TRAILER-WITH-DETAILS'), actionCam()]) assert.deepEqual((await held((await clean(bytes)).bytes)).removed, [])
  })
})

describe('videos: refused rather than damaged', () => {
  test('a picture that lies inside a box Slynk would blank fails, and nothing is sent unasked', async () => {
    // The video track's chunk points into the user data box.
    const ftyp = box('ftyp', 'mp42', be32(0), 'isom')
    const udta = box('udta', qt('\xa9xyz', '+12.3456+056.7890/'))
    const build = (at: number) => cat(ftyp, box('moov', mvhd(), trak('vide', 'avc1', [10], at), udta), box('mdat', VIDEO))
    const first = build(0)
    const at = text(first).indexOf('+12.3456')
    const r = await stripBytes(build(at))
    assert.equal(r.status, 'failed')
  })

  test('damaged or contrived sample tables fail cleanly, never hang or throw', async () => {
    const ftyp = box('ftyp', 'mp42', be32(0), 'isom')
    // A sample count far past what the table holds.
    const bogus = box(
      'trak',
      box(
        'mdia',
        fullBox('hdlr', 0, 0, be32(0), 'vide', new Array(12).fill(0), '\0'),
        box('minf', box('stbl', fullBox('stsz', 0, 0, be32(0), be32(0xffffffff)), fullBox('stsc', 0, 0, be32(0)), fullBox('stco', 0, 0, be32(0)))),
      ),
    )
    for (const b of [
      cat(ftyp, box('moov', mvhd(), bogus), box('mdat', VIDEO)),
      cat(ftyp, box('moov', mvhd(), trak('vide', 'avc1', [10], 1_000_000)), box('mdat', VIDEO)), // samples beyond the file
      cat(ftyp, box('moov', mvhd(), box('trak', box('mdia', [1, 2, 3]))), box('mdat', VIDEO)), // a box cut short
      cat(ftyp, box('mdat', VIDEO)), // no movie box at all
    ]) {
      const r = await stripBytes(b)
      assert.equal(r.status, 'failed', JSON.stringify(r))
    }
  })

  test('a video in fragments with a data track Slynk can’t locate is refused; one without is cleaned', async () => {
    const ftyp = box('ftyp', 'iso6', be32(0), 'iso6', 'dash')
    const moof = box('moof', box('mfhd', [0, 0, 0, 0, 0, 0, 0, 1]))
    const withData = cat(ftyp, box('moov', mvhd(), trak('meta', 'gpmd', [], 0)), moof, box('mdat', 'GPS5'))
    assert.equal((await stripBytes(withData)).status, 'failed')
    const plain = cat(ftyp, box('moov', mvhd(), box('udta', qt('\xa9xyz', '+12.3456+056.7890/'))), moof, box('mdat', 'FRAMES'))
    const r = await clean(plain)
    assert.ok(r.removed.includes(LABEL.gps))
  })
})

describe('videos: detection and reading', () => {
  test('phone and camera videos are recognised; audio-only M4A and Canon raw photos aren’t', () => {
    const ftyp = (major: string, ...compat: string[]) => cat(box('ftyp', major, be32(0), ...compat), box('mdat', 'x'))
    assert.equal(detectKind(ftyp('qt  ', 'qt  ')), 'mov')
    assert.equal(detectKind(ftyp('mp42', 'isom', 'mp42')), 'mp4')
    assert.equal(detectKind(ftyp('3gp4', '3gp4', 'isom')), 'mp4')
    assert.equal(detectKind(ftyp('M4V ', 'M4V ', 'M4A ', 'mp42', 'isom')), 'mp4')
    assert.equal(detectKind(ftyp('M4A ', 'M4A ', 'mp42', 'isom')), null)
    assert.equal(detectKind(ftyp('crx ', 'crx ', 'isom')), null)
    assert.equal(detectKind(ftyp('heic', 'mif1', 'heic')), 'heic', 'photos stay photos')
  })

  test('ISO 6709 locations read as degrees, in the forms phones and cameras write', () => {
    assert.equal(iso6709('+12.3456+056.7890+010.000/'), '12.3456° N, 56.789° E')
    assert.equal(iso6709('-12.3456-056.7890/'), '12.3456° S, 56.789° W')
    assert.equal(iso6709('+1220.736+05647.34/'), '12.3456° N, 56.789° E') // degrees and minutes
    assert.equal(iso6709('not a place'), null)
    assert.equal(iso6709('+95.0+056.0/'), null, 'no latitude past the pole')
  })
})

describe('videos: what the page says', () => {
  test('the About answer, Settings and the protected list name videos', () => {
    const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\s+/g, ' ')
    const about = read('../../about/index.html')
    assert.match(about, /It works on most photos, phone and camera videos \(MP4 and MOV\), MP3 and FLAC audio/)
    assert.match(about, /From a video it removes the location, the phone or camera, the dates, and the track of where an action camera went\./)
    assert.match(about, /Slynk removes hidden details from most photos, videos and documents before sending/)
    assert.match(read('../../index.html'), /<strong>Remove hidden details from files<\/strong><span>From most photos, videos and documents, like where one was taken/)
  })
})
