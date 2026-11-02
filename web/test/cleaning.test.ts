// The composer's handling of the hidden-details stripper. Run: npm --prefix web test
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decode, encode, pack } from '../src/payload.ts'
import { cleanFile, suggestNeutralName, type StripResult } from '../src/stripHook.ts'
import { bytesToSend, chipText, cleaningNote, detailLine, isPdf } from '../src/ui/cleaning.ts'

const original = Uint8Array.from([1, 2, 3, 4])
const cleanedBytes = Uint8Array.from([1, 2])
const cleaned: StripResult = {
  status: 'cleaned',
  bytes: cleanedBytes,
  removed: ['GPS location', 'camera make and model'],
  details: [
    { label: 'GPS location', values: ['12.34° N, 56.78° E'], more: 0 },
    { label: 'camera make and model', values: ['ExampleCam X1'], more: 0 },
  ],
}
const as = (useOriginal = false, sendAsIs = false) => ({ useOriginal, sendAsIs })

test('the hook passes files and names through to the stripping engine', async () => {
  // Unrecognised bytes are 'unsupported' without starting the engine's worker.
  assert.deepEqual(await cleanFile(original, { pdf: false }), { status: 'unsupported', kind: null })
  assert.deepEqual(await cleanFile(original, { pdf: true }), { status: 'unsupported', kind: null })
  assert.equal(suggestNeutralName('IMG_20261014_120000.jpg'), 'photo.jpg')
  assert.equal(suggestNeutralName('holiday.jpg'), null)
})

test('a cleaned file sends the cleaned bytes, flagged, unless the original is asked for', () => {
  assert.deepEqual(bytesToSend(original, cleaned, as()), { data: cleanedBytes, stripped: true })
  assert.deepEqual(bytesToSend(original, cleaned, as(true)), { data: original, stripped: false })
  // A cleaned file shows its chip, not a line.
  assert.equal(cleaningNote(cleaned, as()), '')
  assert.equal(cleaningNote(cleaned, as(true)), '')
})

test('the chip and its list: what was removed, or kept, with the values', () => {
  assert.deepEqual(chipText(false), { chip: 'Cleaned', hint: ': see what was removed', title: 'Removed hidden data' })
  assert.deepEqual(chipText(true), { chip: 'Not cleaned', hint: ': see what it still holds', title: 'Kept hidden data' })
  assert.deepEqual(detailLine(cleaned.status === 'cleaned' ? cleaned.details[0] : assert.fail()), {
    label: 'GPS location',
    values: ['12.34° N, 56.78° E'],
    more: '',
  })
  assert.deepEqual(detailLine({ label: 'preview image', values: [], more: 0 }), { label: 'Preview image', values: [], more: '' })
  assert.deepEqual(detailLine({ label: 'author name (in pictures)', values: ['A', 'B', 'C'], more: 2 }), {
    label: 'Author name (in pictures)',
    values: ['A', 'B', 'C'],
    more: 'and 2 more',
  })
  // More than Slynk counted: no number that could be short.
  assert.equal(detailLine({ label: 'author name', values: ['A', 'B', 'C'], more: -1 }).more, 'and more')
})

test('unchanged, plain text, or the setting off: the original, with nothing to say', () => {
  for (const s of [{ status: 'unchanged', kind: 'jpeg' }, { status: 'unsupported', kind: 'text' }, undefined] as (StripResult | undefined)[]) {
    assert.deepEqual(bytesToSend(original, s, as()), { data: original, stripped: false })
    assert.equal(cleaningNote(s, as()), '')
  }
})

test('a type Slynk can’t check: the original, and the sender is told', () => {
  for (const kind of ['mp4', 'mov', 'zip', null]) {
    const s: StripResult = { status: 'unsupported', kind }
    assert.deepEqual(bytesToSend(original, s, as()), { data: original, stripped: false })
    assert.equal(cleaningNote(s, as()), 'Slynk can’t check this kind of file for hidden data, so it goes as it is')
  }
  // An SVG drawing the cleaner can't be sure of reading (2026-10-26).
  assert.equal(cleaningNote({ status: 'unsupported', kind: 'svg' }, as()), 'Slynk can’t read this drawing to check it for hidden data, so it goes as it is')
})

test('Office’s older files: the original, and how to have it cleaned', () => {
  for (const [kind, line] of [
    ['doc', 'Slynk can’t check older Word files for hidden data, so it goes as it is. Save it as .docx to have it cleaned.'],
    ['xls', 'Slynk can’t check older Excel files for hidden data, so it goes as it is. Save it as .xlsx to have it cleaned.'],
    ['ppt', 'Slynk can’t check older PowerPoint files for hidden data, so it goes as it is. Save it as .pptx to have it cleaned.'],
    ['locked-office', 'This file is password-protected or encrypted, so Slynk can’t look inside it.'],
    ['ole', 'Slynk can’t check this kind of file for hidden data, so it goes as it is'],
  ]) {
    const s: StripResult = { status: 'unsupported', kind }
    assert.deepEqual(bytesToSend(original, s, as()), { data: original, stripped: false })
    assert.equal(cleaningNote(s, as()), line)
  }
})

test('a zip: what inside went unchecked, by kind, unless the original goes anyway', () => {
  const zipped: StripResult = { ...cleaned, unchecked: { pdf: 2, ole: 1, wav: 1, doc: 1, failed: 1 } }
  const line = 'Some files inside weren’t checked for hidden data, so they go as they are: 2 PDFs, 1 older Word file, 1 audio file, 1 file it couldn’t clean and 1 other file.'
  assert.equal(cleaningNote(zipped, as()), line)
  assert.equal(cleaningNote(zipped, as(true)), '')
  assert.equal(cleaningNote({ status: 'unchanged', kind: 'zip', unchecked: { zip: 1 } }, as()), 'Some files inside weren’t checked for hidden data, so they go as they are: 1 zip or other archive.')
  assert.equal(cleaningNote({ status: 'unchanged', kind: 'zip', unchecked: { pdf: 1, mov: 2 } }, as()), 'Some files inside weren’t checked for hidden data, so they go as they are: 1 PDF and 2 videos.')
  assert.equal(cleaningNote({ ...cleaned, unchecked: {} }, as()), '')
})

test('skipped: the original, with the reason', () => {
  const s: StripResult = { status: 'skipped', kind: 'pdf', reason: 'Signed PDFs are left as they are' }
  assert.deepEqual(bytesToSend(original, s, as()), { data: original, stripped: false })
  assert.equal(cleaningNote(s, as()), 'Signed PDFs are left as they are')
})

test('failed: nothing is sent until the sender agrees', () => {
  const s: StripResult = { status: 'failed', kind: 'jpeg', error: 'bad segment' }
  assert.equal(bytesToSend(original, s, as()), undefined)
  assert.equal(cleaningNote(s, as()), '')
  assert.deepEqual(bytesToSend(original, s, as(false, true)), { data: original, stripped: false })
  assert.equal(cleaningNote(s, as(false, true)), 'Couldn’t clean its hidden data, so it goes as it is')
})

test('the cleaned flag reaches the recipient, and the values shown to the sender don’t', async () => {
  const pick = bytesToSend(original, cleaned, as())!
  // Only the bytes and the flag go on to be packed.
  assert.deepEqual(Object.keys(pick).sort(), ['data', 'stripped'])
  const p = await pack({ kind: 'file', name: 'photo.jpg', type: 'image/jpeg', data: pick.data, stripped: pick.stripped })
  const wire = encode([p])
  const [got] = await decode(wire)
  assert.equal(got.stripped, true)
  assert.deepEqual(got.data, cleanedBytes)
  const text = new TextDecoder('latin1').decode(wire)
  for (const v of ['ExampleCam', '12.34', 'GPS']) assert.ok(!text.includes(v), v)
})

test('PDFs are recognised by their header', () => {
  const enc = new TextEncoder()
  assert.equal(isPdf(enc.encode('%PDF-1.7\n...')), true)
  assert.equal(isPdf(enc.encode('junk before the header %PDF-1.4')), true)
  assert.equal(isPdf(new Uint8Array([...new Uint8Array(1030), ...enc.encode('%PDF-1.4')])), false) // too late
  assert.equal(isPdf(enc.encode('%PDF')), false)
  assert.equal(isPdf(enc.encode('%PNG and 100% not a PDF')), false)
  assert.equal(isPdf(new Uint8Array(0)), false)
})
