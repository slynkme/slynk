// Plain zips (src/strip/archive.ts): the files inside cleaned, the zip's own details gone.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PDFDocument } from 'pdf-lib'
import { unzipSync, zipSync, type Zippable } from 'fflate'
import { stripBytes } from '../../src/strip/engine.ts'
import { IN_FILES, LABEL } from '../../src/strip/labels.ts'
import { detectKind } from '../../src/strip/sniff.ts'
import { SKIP } from '../../src/strip/types.ts'
import { readZipDirectory } from '../../src/strip/zipdir.ts'
import { docx, photoWithGps, pngWithAuthor, zip } from './docfixtures.ts'
import { contains, utf8 } from './fixtures.ts'

const MTIME = new Date(Date.UTC(2024, 5, 12, 18, 30, 44))
const DOS_DATE_1980 = (0 << 9) | (1 << 5) | 1

/** A zip as a Mac or Linux machine makes one: each file's mode, made on Unix. */
function unixZip(files: Record<string, [string | Uint8Array, number]>): Uint8Array {
  const z: Zippable = {}
  for (const [name, [data, mode]] of Object.entries(files)) {
    z[name] = [typeof data === 'string' ? utf8(data) : data, { mtime: MTIME, os: 3, attrs: mode * 0x10000 }]
  }
  return zipSync(z)
}

// macOS's "._" companion of a file: the AppleDouble header, then its attributes.
const appleDouble = () => Uint8Array.from([0, 5, 0x16, 7, 0, 2, 0, 0, ...new Array(16).fill(0), 0, 0, ...utf8('com.apple.metadata:kMDItemWhereFroms https://example.com/a.jpg')])

async function pdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false })
  doc.addPage([100, 100])
  doc.setAuthor('Example Author')
  return doc.save({ useObjectStreams: false })
}

async function clean(b: Uint8Array) {
  const r = await stripBytes(b)
  assert.equal(r.status, 'cleaned', JSON.stringify(r))
  if (r.status !== 'cleaned') throw new Error()
  return r
}

/** Every entry's date is 1980's, with no extra fields or comments. */
function neutral(b: Uint8Array) {
  for (const e of readZipDirectory(b)) {
    assert.equal(e.dosDate, DOS_DATE_1980, e.name)
    assert.equal(e.dosTime, 0, e.name)
    assert.deepEqual(e.extraIds, [], e.name)
    assert.equal(e.commentLength, 0, e.name)
  }
}

test('Detection: a plain zip is a zip; formats built as zips that sign or list their files are not', () => {
  assert.equal(detectKind(zip({ 'a.txt': 'hi' })), 'zip')
  assert.equal(detectKind(zip({ 'photos/a.jpg': photoWithGps() })), 'zip')
  // An e-book names its type first, uncompressed.
  assert.equal(detectKind(zip({ mimetype: 'application/epub+zip', 'OEBPS/a.xhtml': '<p/>' }, ['mimetype'])), null)
  assert.equal(detectKind(zip({ 'META-INF/MANIFEST.MF': 'Manifest-Version: 1.0', 'a/B.class': 'x' })), null)
  assert.equal(detectKind(zip({ 'AndroidManifest.xml': 'x', 'classes.dex': 'x' })), null)
  assert.equal(detectKind(zip({ 'pkg/__init__.py': '', 'pkg-1.0.dist-info/RECORD': 'pkg/__init__.py,sha256=x,0' })), null)
  assert.equal(detectKind(zip({ 'Example.app/Contents/_CodeSignature/CodeResources': 'x', 'Example.app/Contents/Resources/a.png': pngWithAuthor() })), null)
  // Visio, XPS and the like: Office's packaging, but not a kind Slynk cleans.
  assert.equal(detectKind(zip({ '[Content_Types].xml': '<Types/>', 'visio/document.xml': '<x/>' })), null)
})

test('Zip: cleans the files inside, drops what the computer added, and makes every date 1980', async () => {
  const photo = photoWithGps()
  const doc = docx()
  const notes = 'Meeting notes, nothing hidden.'
  const input = zip({
    'trip/photo.jpg': photo,
    'trip/diagram.png': pngWithAuthor(),
    'trip/report.docx': doc,
    'trip/notes.txt': notes,
    'trip/.DS_Store': 'Bud1 view settings',
    'trip/Thumbs.db': 'thumbnails',
    '__MACOSX/trip/._photo.jpg': appleDouble(),
  })
  const r = await clean(input)
  assert.ok(r.removed.includes(LABEL.saveTimes))
  assert.ok(r.removed.includes(LABEL.systemFiles))
  assert.ok(r.removed.includes(LABEL.gps + IN_FILES))
  assert.ok(r.removed.includes(LABEL.author + IN_FILES))
  // The zip's own details come first, then what was in the files.
  assert.ok(r.removed.indexOf(LABEL.systemFiles) < r.removed.indexOf(LABEL.gps + IN_FILES))
  const system = r.details.find((d) => d.label === LABEL.systemFiles)
  assert.deepEqual(system?.values, ['.DS_Store', 'Thumbs.db', '__MACOSX'])
  assert.equal(r.unchecked, undefined)

  neutral(r.bytes)
  const out = unzipSync(r.bytes)
  assert.deepEqual(Object.keys(out), ['trip/photo.jpg', 'trip/diagram.png', 'trip/report.docx', 'trip/notes.txt'])
  assert.equal(new TextDecoder().decode(out['trip/notes.txt']), notes)
  assert.ok(contains(photo, 'Exif') && !contains(out['trip/photo.jpg'], 'Exif'))
  assert.ok(!contains(out['trip/diagram.png'], 'Example Author'))
  assert.equal(detectKind(out['trip/report.docx']), 'docx')
  assert.ok(!contains(unzipSync(out['trip/report.docx'])['docProps/core.xml'], 'Example Author'))
  // Nothing is left to remove the second time round.
  assert.deepEqual(await stripBytes(r.bytes), { status: 'unchanged', kind: 'zip' })
})

test('Zip: PDFs, older Office files and zips inside go as they are, and are counted', async () => {
  const p = await pdf()
  const older = new Uint8Array(1024)
  older.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
  const inner = zip({ 'a.jpg': photoWithGps() })
  const input = zip({ 'a.pdf': p, 'b.pdf': p, 'old.doc': older, 'more.zip': inner, 'c.jpg': photoWithGps(), 'empty.txt': '' })
  const r = await clean(input)
  assert.deepEqual(r.unchecked, { pdf: 2, ole: 1, zip: 1 })
  const out = unzipSync(r.bytes)
  assert.deepEqual(out['a.pdf'], p)
  assert.deepEqual(out['more.zip'], inner)
  assert.ok(!contains(out['c.jpg'], 'Exif'))
})

test('Zip: with nothing to remove it is unchanged, still saying what went unchecked', async () => {
  const p = await pdf()
  const plain = zipSync({ 'a.txt': [utf8('hi'), { mtime: new Date(1980, 0, 1) }] })
  assert.deepEqual(await stripBytes(plain), { status: 'unchanged', kind: 'zip' })
  const withPdf = zipSync({ 'a.pdf': [p, { mtime: new Date(1980, 0, 1) }] })
  assert.deepEqual(await stripBytes(withPdf), { status: 'unchanged', kind: 'zip', unchecked: { pdf: 1 } })
})

test('Zip: a file inside that can’t be cleaned goes as it is, and is counted', async () => {
  const broken = photoWithGps().slice(0, 40)
  const r = await clean(zip({ 'broken.jpg': broken, 'fine.jpg': photoWithGps() }))
  assert.deepEqual(r.unchecked, { failed: 1 })
  assert.deepEqual(unzipSync(r.bytes)['broken.jpg'], broken)
})

test('Zip: folders, links and programs keep their kind; nothing else of their modes', async () => {
  const input = unixZip({
    'tool/': ['', 0o040775],
    'tool/run.sh': ['#!/bin/sh\necho hi\n', 0o100775],
    'tool/readme.txt': ['hi', 0o100664],
    'tool/latest': ['run.sh', 0o120755],
  })
  const before = readZipDirectory(input)
  assert.equal(before[0].madeBy >> 8, 3)
  const r = await clean(input)
  const modes = Object.fromEntries(readZipDirectory(r.bytes).map((e) => [e.name, [e.madeBy >> 8, e.external >>> 16]]))
  assert.deepEqual(modes, {
    'tool/': [3, 0o040755],
    'tool/run.sh': [3, 0o100755],
    'tool/readme.txt': [3, 0o100644],
    'tool/latest': [3, 0o120777],
  })
  // A folder is marked as one for Windows too.
  assert.equal(readZipDirectory(r.bytes)[0].external & 0x10, 0x10)
  const out = unzipSync(r.bytes)
  assert.equal(new TextDecoder().decode(out['tool/latest']), 'run.sh')
})

test('Zip: a name in Windows’s older code page keeps its own bytes', async () => {
  // "café.jpg" as Windows's zip writes it: é is 0x82 in code page 437, with no UTF-8 flag.
  const input = zip({ 'caf_.jpg': photoWithGps() })
  for (const e of readZipDirectory(input)) {
    const local = e.offset + 30 + 3
    assert.equal(input[local], 0x5f)
    input[local] = 0x82
  }
  // The directory's copy of the name.
  const at = input.lastIndexOf(0x5f)
  input[at] = 0x82
  const r = await clean(input)
  const [e] = readZipDirectory(r.bytes)
  assert.equal(e.flags & 0x800, 0)
  assert.equal(e.name, 'caf\x82.jpg')
})

test('Zip: entries packed in ways Slynk can’t unpack are copied as they are', async () => {
  const input = zip({ 'a.bin': new Uint8Array(200).fill(7), 'b.jpg': photoWithGps() })
  // Mark a.bin as bzip2-packed (12), in its local header and in the directory.
  const [a] = readZipDirectory(input)
  input[a.offset + 8] = 12
  const cd = input.findIndex((v, i) => v === 0x50 && input[i + 1] === 0x4b && input[i + 2] === 1 && input[i + 3] === 2)
  input[cd + 10] = 12
  const r = await clean(input)
  assert.deepEqual(r.unchecked, { failed: 1 })
  const [out] = readZipDirectory(r.bytes)
  assert.equal(out.method, 12)
  assert.deepEqual(r.bytes.subarray(out.dataOffset, out.dataOffset + out.csize), input.subarray(a.dataOffset, a.dataOffset + a.csize))
})

test('Zip: a password-protected zip is left alone', async () => {
  const input = zip({ 'a.jpg': photoWithGps() })
  const [e] = readZipDirectory(input)
  input[e.offset + 6] |= 1
  const cd = input.findIndex((v, i) => v === 0x50 && input[i + 1] === 0x4b && input[i + 2] === 1 && input[i + 3] === 2)
  input[cd + 8] |= 1
  assert.deepEqual(await stripBytes(input), { status: 'skipped', kind: 'zip', reason: SKIP.encrypted })
})

test('Zip: a "._" file that isn’t macOS’s companion stays', async () => {
  const r = await clean(zip({ '._notes.txt': 'my own file', 'a.jpg': photoWithGps() }))
  assert.deepEqual(Object.keys(unzipSync(r.bytes)), ['._notes.txt', 'a.jpg'])
  assert.ok(!r.removed.includes(LABEL.systemFiles))
})

test('Zip: files the composer cleans as files of their own are left as they are, and not counted', async () => {
  const photo = photoWithGps()
  const p = await pdf()
  const r = await clean(zip({ 'a.jpg': photo, 'b.jpg': photoWithGps(), 'c.pdf': p }))
  const skipped = await stripBytes(zip({ 'a.jpg': photo, 'b.jpg': photoWithGps(), 'c.pdf': p }), { skip: ['a.jpg', 'c.pdf'] })
  assert.equal(skipped.status, 'cleaned')
  if (skipped.status !== 'cleaned') return
  assert.deepEqual(r.unchecked, { pdf: 1 })
  assert.equal(skipped.unchecked, undefined)
  const out = unzipSync(skipped.bytes)
  assert.deepEqual(out['a.jpg'], photo)
  assert.ok(!contains(out['b.jpg'], 'Exif'))
})

test('Zip: what apps and computers leave behind goes too; photo sidecars and links are counted as unchecked', async () => {
  const sidecar = '<x:xmpmeta><rdf:Description exif:GPSLatitude="51,30N" tiff:Model="X1"/></x:xmpmeta>'
  const input = unixZip({
    'docs/report.docx': ['', 0o100644],
    'docs/.~lock.report.docx#': [',Alice Example,laptop,25.10.2026 14:00,file:///home/alice/.config/libreoffice;', 0o100644],
    'docs/~$report.docx': ['Alice Example', 0o100644],
    'docs/IMG_1.jpg:Zone.Identifier': ['[ZoneTransfer]\nZoneId=3\nHostUrl=https://example.com/a.jpg', 0o100644],
    '$RECYCLE.BIN/S-1-5-21/$IABCDEF.jpg': ['deleted', 0o100644],
    'photos/IMG_1.jpg.xmp': [sidecar, 0o100644],
    'photos/IMG_2.jpg.json': ['{"geoData":{"latitude":51.5},"people":[{"name":"Alice"}]}', 0o100644],
    'photos/latest': ['/Users/alice/Pictures/IMG_1.jpg', 0o120755],
    'photos/notes.txt': ['plain notes', 0o100644],
  })
  const r = await clean(input)
  assert.ok(r.removed.includes(LABEL.systemFiles))
  const left = Object.keys(unzipSync(r.bytes))
  assert.deepEqual(left, ['docs/report.docx', 'photos/IMG_1.jpg.xmp', 'photos/IMG_2.jpg.json', 'photos/latest', 'photos/notes.txt'])
  assert.deepEqual(r.unchecked, { sidecar: 2, link: 1 })
})
