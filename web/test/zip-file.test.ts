// A zip read from its file a part at a time (src/zipFile.ts): never whole, so a zip needs no
// size limit of its own. Its index, a file's first bytes, a file whole or as a Blob unpacked by
// the browser, and the "skeleton" the cleaner sees, filled back in by zipInside.ts.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Zip, ZipDeflate, ZipPassThrough, strToU8, unzipSync, zipSync, type Zippable } from 'fflate'
import { stripBytes } from '../src/strip/engine.ts'
import { LABEL } from '../src/strip/labels.ts'
import { readZipDirectory, zipEnd } from '../src/strip/zipdir.ts'
import { entryBlob, entryBytes, entryHead, readZipIndex, skeleton } from '../src/zipFile.ts'
import { rebuildZip } from '../src/zipInside.ts'
import { photoWithGps } from './strip/docfixtures.ts'

const MTIME = new Date(Date.UTC(2024, 5, 12, 18, 30, 44))
const blob = (b: Uint8Array) => new Blob([b as BlobPart])
const zip = (files: Record<string, Uint8Array | string>, store: string[] = []) =>
  zipSync(
    Object.fromEntries(
      Object.entries(files).map(([k, v]) => [k, [typeof v === 'string' ? strToU8(v) : v, { level: store.includes(k) ? 0 : 6, mtime: MTIME }]]),
    ) as Zippable,
  )

/** Bytes that deflate well but aren't all the same: a sound-like wave. */
function wave(n: number): Uint8Array {
  const b = new Uint8Array(n)
  for (let i = 0; i < n; i++) b[i] = Math.round(128 + 100 * Math.sin(i / 40)) & 255
  return b
}

/** A zip written as streaming tools write one: each file's sizes and CRC in a record after its bytes. */
async function streamedZip(files: Record<string, Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  const done = new Promise<void>((resolve, reject) => {
    const z = new Zip((err, chunk, final) => {
      if (err) return reject(err)
      parts.push(chunk)
      if (final) resolve()
    })
    for (const [name, data] of Object.entries(files)) {
      const f = name.endsWith('.txt') ? new ZipPassThrough(name) : new ZipDeflate(name, { level: 6 })
      z.add(f)
      f.push(data, true)
    }
    z.end()
  })
  await done
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

test('the index of a plain zip; nothing for anything else built as one, or a program with a zip inside', async () => {
  const z = await readZipIndex(blob(zip({ 'a/b.jpg': photoWithGps(), 'a/notes.txt': 'hi' })))
  assert.deepEqual(z?.entries.map((e) => [e.name, e.usize]), [['a/b.jpg', photoWithGps().length], ['a/notes.txt', 2]])
  assert.equal(await readZipIndex(blob(strToU8('just text, not a zip at all'))), null)
  // A self-extracting program: a program first, then the zip.
  const sfx = zip({ 'a.txt': 'x' })
  const program = new Uint8Array(100 + sfx.length)
  program.set(strToU8('MZ'))
  program.set(sfx, 100)
  assert.equal(await readZipIndex(blob(program)), null)
  assert.equal(await readZipIndex(blob(zip({ mimetype: 'application/epub+zip', 'a.xhtml': '<p/>' }, ['mimetype']))), null)
  assert.equal(await readZipIndex(blob(zip({ 'META-INF/MANIFEST.MF': 'x', 'A.class': 'x' }))), null)
  assert.equal(await readZipIndex(blob(zip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': '<w/>' }))), null)
})

test('a file’s first bytes, the whole of it, and a damaged one refused', async () => {
  const photo = photoWithGps()
  const bytes = zip({ 'p.jpg': photo, 's.jpg': photo }, ['s.jpg'])
  const z = (await readZipIndex(blob(bytes)))!
  const [packed, stored] = z.entries
  assert.deepEqual(await entryHead(z, packed, 10), photo.subarray(0, 10))
  assert.deepEqual(await entryHead(z, stored, 10), photo.subarray(0, 10))
  assert.deepEqual(await entryBytes(z, packed), photo)
  assert.deepEqual(await entryBytes(z, stored), photo)
  // One byte of the stored photo changed: its CRC no longer agrees.
  const bad = bytes.slice()
  bad[stored.dataOffset + 20] ^= 0xff
  const z2 = (await readZipIndex(blob(bad)))!
  await assert.rejects(entryBytes(z2, z2.entries[1]), /damaged/)
})

test('a big file unpacked by the browser into a Blob, checked as it goes; a stored one is a slice', async () => {
  const big = wave(30_000_000)
  const bytes = zip({ 'voice.wav': big, 'clip.mp4': wave(1_000_000) }, ['clip.mp4'])
  assert.ok(bytes.length < 5_000_000)
  const z = (await readZipIndex(blob(bytes)))!
  const out = await entryBlob(z, z.entries[0], 'audio/wav')
  assert.equal(out.size, big.length)
  assert.equal(out.type, 'audio/wav')
  assert.deepEqual(new Uint8Array(await out.slice(12_345_678, 12_345_778).arrayBuffer()), big.subarray(12_345_678, 12_345_778))
  const slice = await entryBlob(z, z.entries[1], 'video/mp4')
  assert.deepEqual(new Uint8Array(await slice.arrayBuffer()), wave(1_000_000))
  // Damaged on the way: refused once it's all through.
  const bad = bytes.slice()
  bad[z.entries[0].dataOffset + 1000] ^= 0x55
  const z2 = (await readZipIndex(blob(bad)))!
  await assert.rejects(entryBlob(z2, z2.entries[0], 'audio/wav'))
})

test('the skeleton: the zip’s own details intact, its members empty; cleaned, then filled back in', async () => {
  const photo = photoWithGps()
  const bytes = zip({ 'trip/IMG_1.jpg': photo, 'trip/.DS_Store': 'Bud1', 'trip/notes.txt': 'notes', 'trip/IMG_2.jpg': photo })
  const z = (await readZipIndex(blob(bytes)))!
  const members = new Set(['trip/IMG_1.jpg', 'trip/IMG_2.jpg'])
  const bones = await skeleton(z, members, 1_000_000)
  assert.ok(bones.length < bytes.length - 2 * photo.length + 1000)
  const entries = readZipDirectory(bones)
  assert.deepEqual(entries.map((e) => [e.name, e.usize]), [['trip/IMG_1.jpg', 0], ['trip/.DS_Store', 4], ['trip/notes.txt', 5], ['trip/IMG_2.jpg', 0]])
  // Its dates are still the zip's own, for the cleaner to find.
  assert.ok(entries.every((e) => e.dosDate === readZipDirectory(bytes)[0].dosDate))
  const cleaned = await stripBytes(bones, { skip: [...members] })
  assert.equal(cleaned.status, 'cleaned')
  if (cleaned.status !== 'cleaned') return
  assert.ok(cleaned.removed.includes(LABEL.saveTimes) && cleaned.removed.includes(LABEL.systemFiles))
  const { data: out } = rebuildZip(
    cleaned.bytes,
    [
      { entry: 'trip/IMG_1.jpg', name: 'IMG_1.jpg', data: strToU8('small one'), same: false },
      { entry: 'trip/IMG_2.jpg', name: 'IMG_2.jpg', data: strToU8('small two'), same: false },
    ],
    new Set(),
  )
  const files = unzipSync(out)
  assert.deepEqual(Object.keys(files), ['trip/IMG_1.jpg', 'trip/notes.txt', 'trip/IMG_2.jpg'])
  assert.equal(new TextDecoder().decode(files['trip/IMG_2.jpg']), 'small two')
  assert.equal(new TextDecoder().decode(files['trip/notes.txt']), 'notes')
})

test('a zip written as streaming tools write one (sizes after each file) reads and skeletons the same', async () => {
  const photo = photoWithGps()
  const bytes = await streamedZip({ 'a.jpg': photo, 'b.txt': strToU8('hello'), 'c.jpg': photo })
  assert.ok(readZipDirectory(bytes).some((e) => e.flags & 8))
  const z = (await readZipIndex(blob(bytes)))!
  assert.deepEqual(await entryBytes(z, z.entries[0]), photo)
  const bones = await skeleton(z, new Set(['a.jpg', 'c.jpg']), 1_000_000)
  const entries = readZipDirectory(bones)
  assert.deepEqual(entries.map((e) => [e.name, e.usize, e.flags & 8]), [['a.jpg', 0, 0], ['b.txt', 5, 8], ['c.jpg', 0, 0]])
  assert.equal(new TextDecoder().decode(unzipSync(bones)['b.txt']), 'hello')
})

test('a skeleton with more left in it than allowed is refused', async () => {
  const z = (await readZipIndex(blob(zip({ 'a.jpg': photoWithGps(), 'big.bin': wave(200_000) }, ['big.bin']))))!
  await assert.rejects(skeleton(z, new Set(['a.jpg']), 100_000), /too-big/)
})

/** The same zip in ZIP64 form, as tools write one of 4 GB or more: its index's sizes and offsets in extra fields, and its own end record. */
function toZip64(z: Uint8Array): Uint8Array {
  const entries = readZipDirectory(z)
  const { cdOffset } = zipEnd(z)
  const records = entries.map((e) => {
    const nameLength = z[e.central + 28] | (z[e.central + 29] << 8)
    const extra = new Uint8Array(28)
    const x = new DataView(extra.buffer)
    x.setUint16(0, 1, true)
    x.setUint16(2, 24, true)
    x.setBigUint64(4, BigInt(e.usize), true)
    x.setBigUint64(12, BigInt(e.csize), true)
    x.setBigUint64(20, BigInt(e.offset), true)
    const record = new Uint8Array(46 + nameLength + 28)
    record.set(z.subarray(e.central, e.central + 46 + nameLength))
    record.set(extra, 46 + nameLength)
    const v = new DataView(record.buffer)
    for (const at of [20, 24, 42]) v.setUint32(at, 0xffffffff, true)
    v.setUint16(30, 28, true)
    v.setUint16(32, 0, true)
    return record
  })
  const cdSize = records.reduce((n, r) => n + r.length, 0)
  const end64 = new Uint8Array(56)
  const a = new DataView(end64.buffer)
  a.setUint32(0, 0x06064b50, true)
  a.setBigUint64(4, 44n, true)
  a.setBigUint64(24, BigInt(entries.length), true)
  a.setBigUint64(32, BigInt(entries.length), true)
  a.setBigUint64(40, BigInt(cdSize), true)
  a.setBigUint64(48, BigInt(cdOffset), true)
  const locator = new Uint8Array(20)
  const l = new DataView(locator.buffer)
  l.setUint32(0, 0x07064b50, true)
  l.setBigUint64(8, BigInt(cdOffset + cdSize), true)
  l.setUint32(16, 1, true)
  const end = new Uint8Array(22)
  const d = new DataView(end.buffer)
  d.setUint32(0, 0x06054b50, true)
  d.setUint16(8, 0xffff, true)
  d.setUint16(10, 0xffff, true)
  d.setUint32(12, 0xffffffff, true)
  d.setUint32(16, 0xffffffff, true)
  const parts = [z.subarray(0, cdOffset), ...records, end64, locator, end]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

test('a ZIP64 zip (4 GB or more, as some tools write any) is read, and its skeleton is one the cleaner reads', async () => {
  const photo = photoWithGps()
  const z64 = toZip64(zip({ 'a/IMG.jpg': photo, 'a/notes.txt': 'notes' }))
  assert.throws(() => readZipDirectory(z64)) // the cleaner's reader doesn't know ZIP64
  const z = (await readZipIndex(blob(z64)))!
  assert.deepEqual(z.entries.map((e) => [e.name, e.usize]), [['a/IMG.jpg', photo.length], ['a/notes.txt', 5]])
  assert.deepEqual(await entryBytes(z, z.entries[0]), photo)
  const bones = await skeleton(z, new Set(['a/IMG.jpg']), 1_000_000)
  assert.deepEqual(readZipDirectory(bones).map((e) => [e.name, e.usize]), [['a/IMG.jpg', 0], ['a/notes.txt', 5]])
})

test('an entry whose sizes can’t be true is refused, so it can’t hide junk after its data', async () => {
  const bytes = zip({ 'a.txt': 'hello there' }, ['a.txt'])
  const [e] = readZipDirectory(bytes)
  const bad = bytes.slice()
  new DataView(bad.buffer).setUint32(e.central + 24, 3, true) // stored, but unpacked "3 bytes"
  assert.equal(await readZipIndex(blob(bad)), null)
  assert.throws(() => readZipDirectory(bad), /sizes disagree/)
})
