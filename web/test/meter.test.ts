// The composer's size meter. Run from the repo root: npm --prefix web test
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MAX_FILES, MAX_PAYLOAD, encode, envelopeSize, pack, type Item } from '../src/payload.ts'
import { countLabel } from '../src/ui/format.ts'
import { SEND_RATE, SEND_RATE_VARIED, meter, sendSeconds } from '../src/ui/meter.ts'

const base = { files: 0, messages: 0, varied: false, pending: false }

test('nothing to send', () => {
  assert.deepEqual(meter({ ...base, wire: 0 }), { fill: 0, over: false, working: false, text: '0 KB of 2 MB', eta: '' })
})

test('over, but being made smaller to fit: calm, not red', () => {
  const m = meter({ ...base, wire: 139_630_000, files: 1, working: true })
  assert.deepEqual(m, { fill: 100, over: false, working: true, text: 'Working out the size…', eta: '' })
  // Not when it fits already (a run making copies better), and not with too many files.
  assert.equal(meter({ ...base, wire: 900_000, files: 1, working: true }).working, false)
  assert.equal(meter({ ...base, wire: 139_630_000, files: MAX_FILES + 1, working: true }).over, true)
})

test('one item: size and an estimated send time', () => {
  const m = meter({ ...base, wire: 812_000, files: 1 })
  assert.equal(m.text, '812 KB of 2 MB')
  assert.equal(m.eta, 'about 2 min to send') // 99 s at about 8 KB/s
  assert.equal(m.over, false)
  assert.ok(Math.abs(m.fill - 40.6) < 1e-9)
  assert.equal(meter({ ...base, wire: 2_000, messages: 1 }).eta, 'a few seconds to send')
  assert.equal(meter({ ...base, wire: 300_000, files: 1 }).eta, 'about 40 s to send') // 37 s
  assert.equal(meter({ ...base, wire: MAX_PAYLOAD, files: 1 }).eta, 'about 4 min to send') // 244 s, as measured
})

test('varied batch sizes are slower', () => {
  assert.equal(sendSeconds(600_000, false), 600_000 / SEND_RATE)
  assert.equal(sendSeconds(600_000, true), 600_000 / SEND_RATE_VARIED)
  assert.equal(meter({ ...base, wire: 812_000, files: 1, varied: true }).eta, 'about 2 min to send') // 135 s
  assert.equal(meter({ ...base, wire: MAX_PAYLOAD, files: 1, varied: true }).eta, 'about 6 min to send') // 333 s
})

test('several items are counted', () => {
  assert.equal(meter({ ...base, wire: 812_000, files: 3, messages: 1 }).text, '3 files and a message · 812 KB of 2 MB')
  assert.equal(meter({ ...base, wire: 20_000, files: 1, messages: 1 }).text, 'A file and a message · 20 KB of 2 MB')
  assert.equal(meter({ ...base, wire: 20_000, files: 2 }).text, '2 files · 20 KB of 2 MB')
  assert.equal(countLabel(0, 2), '2 messages')
  assert.equal(countLabel(2, 2), '2 files and 2 messages')
})

test('while something is still being prepared', () => {
  assert.equal(meter({ ...base, wire: 5_000, files: 2, pending: true }).eta, 'Working out the size…')
})

test('over the limit', () => {
  const m = meter({ ...base, wire: MAX_PAYLOAD + 120_000, files: 2 })
  assert.equal(m.over, true)
  assert.equal(m.fill, 100)
  assert.equal(m.text, '2.12 MB: over the 2 MB limit by 120 KB')
  assert.equal(m.eta, '')
  assert.equal(meter({ ...base, wire: MAX_PAYLOAD, files: 1 }).over, false) // exactly 2 MB is fine
})

test('too many files', () => {
  const m = meter({ ...base, wire: 1000, files: MAX_FILES + 1, messages: 1 })
  assert.equal(m.over, true)
  assert.equal(m.text, `${MAX_FILES + 1} files: ${MAX_FILES} at most`)
  assert.equal(meter({ ...base, wire: 1000, files: MAX_FILES, messages: 1 }).over, false) // a message plus 200 files is fine
})

test('the meter is fed the exact envelope size', async () => {
  const enc = new TextEncoder()
  const items: Item[] = [
    { kind: 'text', name: '', type: '', data: enc.encode('see attached') },
    { kind: 'file', name: 'a.txt', type: 'text/plain', data: enc.encode('hello '.repeat(5000)) },
    { kind: 'file', name: 'b.bin', type: '', data: crypto.getRandomValues(new Uint8Array(4000)) },
  ]
  const packed = await Promise.all(items.map((i) => pack(i)))
  const wire = envelopeSize(packed)
  assert.equal(wire, encode(packed).length)
  // Removing an item takes off exactly its own share.
  assert.equal(envelopeSize(packed.slice(0, 2)), wire - (12 + 5 + packed[2].body.length))
  assert.match(meter({ ...base, wire, files: 2, messages: 1 }).text, /^2 files and a message · \d/)
})

test('one-time and expiring links leave a little less room', async () => {
  const { MAX_PAYLOAD_SEALED, SEAL_OVERHEAD } = await import('../src/burn.ts')
  assert.equal(MAX_PAYLOAD_SEALED, MAX_PAYLOAD - SEAL_OVERHEAD)
  const fits = meter({ ...base, wire: MAX_PAYLOAD_SEALED, files: 1, limit: MAX_PAYLOAD_SEALED })
  assert.equal(fits.over, false)
  assert.equal(fits.fill, 100)
  const over = meter({ ...base, wire: MAX_PAYLOAD, files: 1, limit: MAX_PAYLOAD_SEALED })
  assert.equal(over.over, true)
  assert.equal(over.text, `2.00 MB: over the 2 MB limit by ${SEAL_OVERHEAD} bytes`)
  // Without a limit, the ordinary one applies.
  assert.equal(meter({ ...base, wire: MAX_PAYLOAD, files: 1 }).over, false)
})
