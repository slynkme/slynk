// Type detection, file-name hints, and the engine's never-throw promise.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { stripBytes } from '../../src/strip/engine.ts'
import { orderLabels } from '../../src/strip/labels.ts'
import { suggestNeutralName } from '../../src/strip/names.ts'
import { describeOther, detectKind } from '../../src/strip/sniff.ts'
import { compound, docx, odf, pptx, privateRtf, xlsx, zip } from './docfixtures.ts'
import {
  animatedPng,
  animatedWebp,
  be32,
  cat,
  fakeVideo,
  heif,
  id3v2,
  privateFlac,
  privateGif,
  privateMp3,
  privatePng,
  privateWebp,
  ultraHdrMotionPhoto,
  utf8,
} from './fixtures.ts'

const samples = (): [string, Uint8Array][] => [
  ['jpeg', ultraHdrMotionPhoto().bytes],
  ['png', privatePng()],
  ['png', animatedPng()],
  ['webp', privateWebp()],
  ['webp', animatedWebp()],
  ['gif', privateGif()],
  ['heic', heif('heic').bytes],
  ['avif', heif('avif').bytes],
  ['mp3', privateMp3()],
  ['flac', privateFlac()],
  ['docx', docx()],
  ['xlsx', xlsx()],
  ['pptx', pptx()],
  ['odt', odf('text')],
  ['ods', odf('spreadsheet')],
  ['odp', odf('presentation')],
  ['rtf', privateRtf()],
]

test('detectKind reads magic bytes, not names', () => {
  for (const [kind, b] of samples()) assert.equal(detectKind(b), kind)
  assert.equal(detectKind(utf8('%PDF-1.7\n%...')), 'pdf')
  assert.equal(detectKind(cat(id3v2([['TIT2', '\0x']]), 'fLaC', new Array(40).fill(0))), 'flac')
  // Videos are cleaned too (video.ts); audio-only M4A isn't.
  assert.equal(detectKind(fakeVideo()), 'mp4')
  assert.equal(detectKind(cat(be32(24), 'ftypM4A ', be32(0), 'M4A mp42', be32(8), 'mdat')), null)
  assert.equal(detectKind(utf8('just some text, not a file format')), null)
  assert.equal(detectKind(zip({ 'hello.txt': 'hi' })), 'zip')
  assert.equal(detectKind(new Uint8Array([0xff, 0xf1, 0x50, 0x80, 0, 0x1f, 0xfc, 0])), null) // ADTS AAC, not MP3
  assert.equal(describeOther(fakeVideo()), 'mp4')
  assert.equal(describeOther(cat(be32(24), 'ftypM4A ', be32(0), 'M4A mp42', be32(8), 'mdat')), 'm4a')
  assert.equal(describeOther(zip({ 'hello.txt': 'hi' })), 'zip')
  assert.equal(describeOther(utf8('plain text\n')), 'text')
  assert.equal(describeOther(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])), 'ole')
})

test('unsupported types are reported, not touched', async () => {
  assert.deepEqual(await stripBytes(cat(be32(24), 'ftypM4A ', be32(0), 'M4A mp42', be32(8), 'mdat')), { status: 'unsupported', kind: 'm4a' })
  // A video Slynk can't make sense of (no movie box here) fails, so the sender is asked before it goes as it is.
  assert.equal((await stripBytes(fakeVideo())).status, 'failed')
  assert.deepEqual(await stripBytes(new Uint8Array([1, 2, 3, 4, 5])), { status: 'unsupported', kind: null })
  assert.deepEqual(await stripBytes(utf8('hello there, this is a note')), { status: 'unsupported', kind: 'text' })
  assert.deepEqual(await stripBytes(new Uint8Array(0)), { status: 'unsupported', kind: null })
})

test('Office’s older files are told apart, from their directory', async () => {
  const S = '\x05SummaryInformation'
  const cases: [string[], string][] = [
    [['WordDocument', '1Table', 'Data', S], 'doc'],
    [['Workbook', S], 'xls'],
    [['Book'], 'xls'], // Excel 5 and 95
    [['Current User', 'Pictures', 'PowerPoint Document', S, '\x05DocumentSummaryInformation', '\x01CompObj', '\x01Ole'], 'ppt'],
    [['\x06DataSpaces', 'EncryptionInfo', 'EncryptedPackage'], 'locked-office'],
    [['__substg1.0_0037001F', '__properties_version1.0'], 'ole'], // an Outlook message
  ]
  for (const [names, kind] of cases) {
    assert.equal(describeOther(compound(names)), kind, names.join())
    assert.deepEqual(await stripBytes(compound(names)), { status: 'unsupported', kind })
  }
  // A directory cut short or pointing nowhere is just "ole".
  const broken = compound(['WordDocument']).slice(0, 700)
  assert.equal(describeOther(broken), 'ole')
})

test('labels are de-duplicated and ordered', () => {
  assert.deepEqual(orderLabels(['comments', 'GPS location (in pictures)', 'date taken', 'GPS location', 'comments', 'something new']), [
    'GPS location',
    'date taken',
    'comments',
    'something new',
    'GPS location (in pictures)',
  ])
})

test('suggestNeutralName flags names that leak a time or device', () => {
  const cases: [string, string | null][] = [
    ['IMG_20240612_183045.jpg', 'photo.jpg'],
    ['IMG_1234.HEIC', 'photo.HEIC'],
    ['PXL_20240612_183045123.MP.jpg', 'photo.jpg'],
    ['VID_20240612_183045.mp4', 'video.mp4'],
    ['IMG-20240612-WA0001.jpg', 'photo.jpg'],
    ['20240612_183045.jpg', 'photo.jpg'],
    ['DSC_0001.JPG', 'photo.JPG'],
    ['P1000123.JPG', 'photo.JPG'],
    ['Screenshot_2024-06-12-18-30-45-123_com.example.app.png', 'screenshot.png'],
    ['Screenshot 2024-06-12 at 18.30.45.png', 'screenshot.png'],
    ['Screen Recording 2024-06-12 at 18.30.45.mov', 'screen-recording.mov'],
    ['WhatsApp Image 2024-06-12 at 18.30.45.jpeg', 'photo.jpeg'],
    ['WhatsApp Audio 2024-06-12 at 18.30.45.ogg', 'audio.ogg'],
    ['signal-2024-06-12-183045.jpg', 'photo.jpg'],
    ['photo_2024-06-12_18-30-45.jpg', 'photo.jpg'],
    ['Recording 2024-06-12.m4a', 'audio.m4a'],
    ['path/to/IMG_20240612_183045.jpg', 'photo.jpg'],
    ['holiday by the sea.jpg', null],
    ['holiday 2024-06-12.jpg', null],
    ['report-final.docx', null],
    ['photo.jpg', null],
    ['Screenshot (12).png', null],
    ['SAMPLE.txt', null],
  ]
  for (const [name, want] of cases) assert.equal(suggestNeutralName(name), want, name)
})

// Seeded so failures reproduce.
function rng(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
}

test('damaged files never throw and never come back half-cleaned', async () => {
  const random = rng(57)
  const ok = new Set(['cleaned', 'unchanged', 'unsupported', 'skipped', 'failed'])
  let runs = 0
  for (const [kind, good] of samples()) {
    const variants: Uint8Array[] = []
    for (let k = 1; k <= 12; k++) variants.push(good.subarray(0, Math.floor((good.length * k) / 13)))
    for (let k = 0; k < 16; k++) {
      const b = good.slice()
      const n = 1 + Math.floor(random() * 4)
      for (let j = 0; j < n; j++) b[Math.floor(random() * b.length)] = Math.floor(random() * 256)
      variants.push(b)
    }
    for (const b of variants) {
      const r = await stripBytes(b, { pdf: true })
      runs++
      assert.ok(ok.has(r.status), `${kind}: ${r.status}`)
      // Anything reported as cleaned has passed the re-parse; check it again here.
      if (r.status === 'cleaned') {
        const again = await stripBytes(r.bytes, { pdf: true })
        assert.equal(again.status, 'unchanged', `${kind}: second pass gave ${JSON.stringify(again).slice(0, 200)}`)
      }
    }
  }
  assert.ok(runs > 400)
})
