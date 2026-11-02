// A zip's files as the composer sends them (src/zipInside.ts, tray.ts): each in
// its place, under its new name if it has one, the rest copied as they are.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { strToU8, unzipSync, zipSync } from 'fflate'
import { photoWithGps } from './strip/docfixtures.ts'
import { readZipDirectory } from '../src/strip/zipdir.ts'
import { shownName } from '../src/strip/zipdir.ts'
import { keepZip, rebuildZip, uniqueIn } from '../src/zipInside.ts'

const zip = (files: Record<string, string>) =>
  zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, [strToU8(v), { os: 3, attrs: (k.endsWith('.sh') ? 0o100755 : 0o100644) * 0x10000 }]])))
const text = (b: Uint8Array) => new TextDecoder().decode(b)

test('each file goes back in its place, renamed where it was; the rest as they were, in order', () => {
  const base = zip({ 'trip/IMG_1.HEIC': 'heic', 'trip/notes.txt': 'notes', 'trip/b.jpg': 'b', 'run.sh': 'echo' })
  const { data: out } = rebuildZip(
    base,
    [
      { entry: 'trip/IMG_1.HEIC', name: 'IMG_1.jpg', data: strToU8('small jpeg'), same: false },
      { entry: 'trip/b.jpg', name: 'b.jpg', data: strToU8('b'), same: true },
    ],
    new Set(),
  )
  const files = unzipSync(out)
  assert.deepEqual(Object.keys(files), ['trip/IMG_1.jpg', 'trip/notes.txt', 'trip/b.jpg', 'run.sh'])
  assert.equal(text(files['trip/IMG_1.jpg']), 'small jpeg')
  assert.equal(text(files['trip/notes.txt']), 'notes')
  // A script keeps running; every date is 1980's.
  const entries = readZipDirectory(out)
  assert.equal(entries.find((e) => e.name === 'run.sh')!.external >>> 16, 0o100755)
  assert.ok(entries.every((e) => e.dosDate === 33 && e.dosTime === 0 && e.extraIds.length === 0))
})

test('a new name that clashes gets a number; dropped files are left out', () => {
  const base = zip({ 'a/photo.HEIC': 'h', 'a/photo.jpg': 'j', 'a/gone.jpg': 'g' })
  const { data: out } = rebuildZip(base, [{ entry: 'a/photo.HEIC', name: 'photo.jpg', data: strToU8('made'), same: false }], new Set(['a/gone.jpg']))
  const files = unzipSync(out)
  assert.deepEqual(Object.keys(files).sort(), ['a/photo (2).jpg', 'a/photo.jpg'])
  assert.equal(text(files['a/photo (2).jpg']), 'made')
  assert.equal(text(files['a/photo.jpg']), 'j')
})

test('a file the zip stored uncompressed is compressed when that saves space, as on its own; a photo isn’t tried', () => {
  let log = ''
  for (let i = 0; i < 2000; i++) log += `2026-10-25T14:00:00Z INFO request ${i} handled\n`
  const photo = photoWithGps()
  const base = zipSync({ 'logs/app.log': [strToU8(log), { level: 0 }], 'logs/photo.jpg': [photo, { level: 0 }] })
  const { data, packed } = rebuildZip(base, [{ entry: 'logs/photo.jpg', name: 'photo.jpg', data: photo, same: false }], new Set())
  assert.ok(packed.has('logs/app.log') && packed.get('logs/app.log')! < log.length / 5)
  assert.ok(!packed.has('logs/photo.jpg'))
  assert.ok(data.length < base.length / 3)
  const entries = readZipDirectory(data)
  assert.deepEqual(entries.map((e) => [e.name, e.method]), [['logs/app.log', 8], ['logs/photo.jpg', 0]])
  assert.equal(text(unzipSync(data)['logs/app.log']), log)
})

test('uniqueIn ignores case and keeps the folder and ending', () => {
  const taken = new Set(['x/a.jpg'])
  assert.equal(uniqueIn(taken, 'x/A.JPG'), 'x/A (2).JPG')
  assert.equal(uniqueIn(taken, 'x/a.jpg'), 'x/a (3).jpg')
  assert.equal(uniqueIn(new Set(['x.d/readme']), 'x.d/readme'), 'x.d/readme (2)')
})

/** A zip whose names have the byte b where they have '_', in both its headers, unmarked as UTF-8 (as Windows writes one). */
function oldNames(files: Record<string, string>, b: number): Uint8Array {
  const z = zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])))
  for (let i = 0; i < z.length; i++) if (z[i] === 0x5f) z[i] = b
  return z
}

test('a name shown as the zip meant it: UTF-8 when it reads as that, else the DOS code page', () => {
  assert.equal(shownName('caf\x82.jpg', false), 'café.jpg')
  assert.equal(shownName('caf\xc3\xa9.jpg', false), 'café.jpg') // UTF-8, unmarked (as some Mac tools write)
  assert.equal(shownName('plain.txt', false), 'plain.txt')
  assert.equal(shownName('café.jpg', true), 'café.jpg')
})

test('a renamed file in an old-style folder is written in UTF-8, folder and all; an unchanged one keeps its own bytes', () => {
  const base = oldNames({ 'Caf_/IMG.HEIC': 'h', 'Caf_/note_.txt': 'n' }, 0x82)
  const [heic, note] = readZipDirectory(base)
  assert.equal(heic.name, 'Caf\x82/IMG.HEIC')
  const { data } = rebuildZip(base, [
    { entry: heic.name, name: 'IMG.jpg', data: strToU8('made'), same: false },
    { entry: note.name, name: 'note\x82.txt', data: strToU8('n'), same: false },
  ], new Set())
  const out = readZipDirectory(data)
  assert.deepEqual(out.map((e) => [e.name, e.flags & 0x800]), [['Café/IMG.jpg', 0x800], ['Caf\x82/note\x82.txt', 0]])
})

test('a renamed file never takes a name another file keeps, members included, whatever its case', () => {
  const base = zipSync({ 'a/photo.png': strToU8('p'), 'a/photo.jpg': strToU8('j'), 'a/IMG.JPG': strToU8('i'), 'a/img.heic': strToU8('h') })
  const { data } = rebuildZip(base, [
    { entry: 'a/photo.png', name: 'photo.jpg', data: strToU8('made from png'), same: false },
    { entry: 'a/photo.jpg', name: 'photo.jpg', data: strToU8('j'), same: false },
    { entry: 'a/img.heic', name: 'img.jpg', data: strToU8('made from heic'), same: false },
  ], new Set())
  const names = readZipDirectory(data).map((e) => e.name)
  assert.deepEqual(names, ['a/photo (2).jpg', 'a/photo.jpg', 'a/IMG.JPG', 'a/img (2).jpg'])
})

test('kept as it was (Send original instead): every other file byte for byte, dates and extra fields and all; changed ones in place', () => {
  const base = zipSync({ 'trip/IMG.HEIC': strToU8('heic bytes'), 'trip/notes.txt': strToU8('notes '.repeat(30)), 'trip/old.txt': strToU8('old') }, { mtime: new Date(Date.UTC(2024, 5, 12, 18, 30, 44)) })
  const before = readZipDirectory(base)
  const { data } = keepZip(base, [{ entry: 'trip/IMG.HEIC', name: 'IMG.jpg', data: strToU8('a small jpeg'), same: false }], new Set(['trip/old.txt']))
  const after = readZipDirectory(data)
  assert.deepEqual(after.map((e) => e.name), ['trip/IMG.jpg', 'trip/notes.txt'])
  // The note goes exactly as it was: same date, packed the same, its bytes unchanged.
  const note = (z: Uint8Array, e: ReturnType<typeof readZipDirectory>[number]) => z.subarray(e.offset, e.dataOffset + e.csize)
  assert.deepEqual(note(data, after[1]), note(base, before[1]))
  // The changed one keeps its own header's date, with its new bytes and name (in UTF-8).
  assert.equal(after[0].dosDate, before[0].dosDate)
  assert.equal(after[0].dosTime, before[0].dosTime)
  assert.equal(text(unzipSync(data)['trip/IMG.jpg']), 'a small jpeg')
})
