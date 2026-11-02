// "Save all (.zip)": name cleaning and the zip itself. Run: npm --prefix web test
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { unzipSync } from 'fflate'
import { safeName, uniqueNames, zipFiles, zipName } from '../src/zip.ts'

const enc = new TextEncoder()

test('unsafe characters in names are replaced', () => {
  assert.equal(safeName('report.pdf', 'file-1'), 'report.pdf')
  assert.equal(safeName('../../etc/passwd', 'file-1'), '_.._etc_passwd')
  assert.equal(safeName('C:\\Users\\x.txt', 'file-1'), 'C__Users_x.txt')
  assert.equal(safeName('a*b?c"d<e>f|g:h.txt', 'file-1'), 'a_b_c_d_e_f_g_h.txt')
  assert.equal(safeName('line\nbreak\t\x00.txt', 'file-1'), 'line_break__.txt')
  assert.equal(safeName('invoice\u202Efdp.exe', 'file-1'), 'invoice_fdp.exe') // right-to-left override
  assert.equal(safeName('päivä 🌞.md', 'file-1'), 'päivä 🌞.md')
})

test('leading and trailing dots and spaces go; empty names get a fallback', () => {
  assert.equal(safeName('.bashrc', 'file-1'), 'bashrc')
  assert.equal(safeName('  .. notes.txt. ', 'file-1'), 'notes.txt')
  assert.equal(safeName('', 'file-3'), 'file-3')
  assert.equal(safeName('...', 'file-4'), 'file-4')
  assert.equal(safeName('///', 'file-5'), '___')
})

test('names Windows reserves, and __proto__, are prefixed', () => {
  assert.equal(safeName('CON', 'f'), '_CON')
  assert.equal(safeName('nul.txt', 'f'), '_nul.txt')
  assert.equal(safeName('com1.log', 'f'), '_com1.log')
  assert.equal(safeName('console.txt', 'f'), 'console.txt')
  assert.equal(safeName('__proto__', 'f'), '___proto__')
})

test('very long names stay within 255 bytes', () => {
  const s = safeName('x'.repeat(1000) + '.jpg', 'f')
  assert.ok(enc.encode(s).length <= 255)
  assert.ok(s.endsWith('.jpg'))
})

test('duplicate names are numbered, ignoring case', () => {
  assert.deepEqual(uniqueNames(['a.txt', 'A.txt', 'a.txt', 'b', 'b', 'a (2).txt']), [
    'a.txt',
    'A (2).txt',
    'a (3).txt',
    'b',
    'b (2)',
    'a (2) (2).txt',
  ])
  const long = 'y'.repeat(251) + '.pdf' // exactly 255 bytes
  const [first, second] = uniqueNames([long, long])
  assert.equal(first, long)
  assert.ok(enc.encode(second).length <= 255)
  assert.ok(second.endsWith(' (2).pdf'))
})

test('the zip is named by the local date', () => {
  assert.equal(zipName(new Date(2026, 9, 14, 23, 59)), 'slynk-2026-10-14.zip')
  assert.equal(zipName(new Date(2027, 0, 2)), 'slynk-2027-01-02.zip')
})

test('the zip holds every file, stored, under clean unique names, with a fixed date', async () => {
  const files = [
    { name: 'notes.txt', data: enc.encode('hello') },
    { name: 'Notes.txt', data: enc.encode('second') },
    { name: '../evil', data: Uint8Array.from([1, 2, 3]) },
    { name: '', data: new Uint8Array(0) },
  ]
  const zip = await zipFiles(files)
  const out = unzipSync(zip)
  assert.deepEqual(Object.keys(out), ['notes.txt', 'Notes (2).txt', '_evil', 'file-4'])
  assert.deepEqual(out['notes.txt'], files[0].data)
  assert.deepEqual(out['_evil'], files[2].data)

  // The first local header: method 0 (stored), DOS time 00:00:00, date 1980-01-01.
  const v = new DataView(zip.buffer, zip.byteOffset)
  assert.equal(v.getUint32(0, true), 0x04034b50)
  assert.equal(v.getUint16(8, true), 0)
  assert.equal(v.getUint16(10, true), 0)
  assert.equal(v.getUint16(12, true), (0 << 9) | (1 << 5) | 1)

  // Same files, same bytes: nothing about the moment it was made.
  assert.deepEqual(await zipFiles(files), zip)
})
