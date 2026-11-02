// Crafted and mutated envelopes: whatever a sender puts in a link, decoding
// either returns items or refuses with an EnvelopeError, quickly, and never
// hands the page anything a browser would run. Run: npm --prefix web test
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deflateRawSync } from 'node:zlib'
import { unzipSync } from 'fflate'
import { EnvelopeError, MAX_DECODED, MAX_ITEMS, MAX_PAYLOAD, decode, encode, envelopeSize, pack, packItem, safeType, store, type Item } from '../src/payload.ts'
import { safeName, uniqueNames, zipFiles } from '../src/zip.ts'

const enc = new TextEncoder()

// A small deterministic generator, so a failure can be replayed.
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    return (s >>> 0) / 2 ** 32
  }
}

function u32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
}

/** A v2 envelope by hand: header, then items of [kind, flags, name, type, size, body]. */
function v2(items: { kind?: number; flags?: number; name?: string; type?: string; size?: number; body: Uint8Array }[], ext: number[] = []): Uint8Array {
  const out: number[] = [2, 0, items.length, ext.length >> 8, ext.length & 0xff, ...ext]
  for (const it of items) {
    const name = enc.encode(it.name ?? '')
    const type = enc.encode(it.type ?? '')
    out.push(it.kind ?? 0, it.flags ?? 0, name.length, ...name, type.length, ...type, ...u32(it.size ?? it.body.length), ...u32(it.body.length))
    for (const b of it.body) out.push(b)
  }
  return Uint8Array.from(out)
}

async function outcome(bytes: Uint8Array): Promise<'ok' | 'refused'> {
  try {
    const items = await decode(bytes)
    assert.ok(items.length >= 1 && items.length <= MAX_ITEMS)
    for (const it of items) {
      assert.ok(it.kind === 'file' || it.kind === 'text')
      assert.ok(it.data instanceof Uint8Array)
      if (it.type) assert.equal(safeType(it.type), it.type, 'a decoded type is always a safe one')
    }
    return 'ok'
  } catch (e) {
    assert.ok(e instanceof EnvelopeError, `not an EnvelopeError: ${e}`)
    return 'refused'
  }
}

test('mutated envelopes are decoded or refused, never anything else', async () => {
  const items: Item[] = [
    { kind: 'text', name: '', type: '', data: enc.encode('the code is 0451 '.repeat(20)) },
    { kind: 'file', name: 'notes.txt', type: 'text/plain', data: enc.encode('compress me '.repeat(400)) },
    { kind: 'file', name: 'noise.bin', type: '', data: crypto.getRandomValues(new Uint8Array(300)) },
  ]
  const good = encode(await Promise.all(items.map(pack)))
  assert.equal(await outcome(good), 'ok')
  const next = rng(57)
  const t = performance.now()
  const seen = { ok: 0, refused: 0 }
  for (let n = 0; n < 600; n++) {
    const bad = good.slice()
    const hits = 1 + Math.floor(next() * 3)
    for (let h = 0; h < hits; h++) bad[Math.floor(next() * bad.length)] = Math.floor(next() * 256)
    seen[await outcome(bad)]++
  }
  assert.ok(seen.refused > 0)
  assert.ok(performance.now() - t < 5000, 'mutations are refused quickly')
})

test('random bytes after a valid version are decoded or refused', async () => {
  const next = rng(1980)
  for (let n = 0; n < 400; n++) {
    const len = 1 + Math.floor(next() * 64)
    const bytes = Uint8Array.from({ length: len }, () => Math.floor(next() * 256))
    bytes[0] = 1 + Math.floor(next() * 2)
    await outcome(bytes)
  }
})

test('an envelope bigger than any Slynk page sends is refused', async () => {
  // Exactly MAX_PAYLOAD is fine: 5 header + 12 item + body.
  const body = new Uint8Array(MAX_PAYLOAD - 17)
  const atLimit = v2([{ body }])
  assert.equal(atLimit.length, MAX_PAYLOAD)
  assert.equal((await decode(atLimit))[0].data.length, body.length)
  await assert.rejects(decode(v2([{ body: new Uint8Array(MAX_PAYLOAD - 16) }])), EnvelopeError)
  // v1 too.
  const v1 = new Uint8Array(MAX_PAYLOAD + 1)
  v1[0] = 1
  await assert.rejects(decode(v1), EnvelopeError)
})

test('a v1 deflate bomb stops at the cap instead of filling memory', async () => {
  const bomb = deflateRawSync(new Uint8Array(MAX_DECODED + 1), { level: 9 }) // about 97 KB
  assert.ok(bomb.length < MAX_PAYLOAD / 10)
  const v1 = Uint8Array.from([1, 2, 0, 0, 0, ...bomb]) // flags: compressed file, no name, no type
  const t = performance.now()
  await assert.rejects(decode(v1), (e: unknown) => e instanceof EnvelopeError && !e.newer)
  assert.ok(performance.now() - t < 5000)
})

test('every item of a many-item bomb is held to its declared size', async () => {
  const bomb = deflateRawSync(new Uint8Array(5_000_000))
  // Each declares a small size; the first one that overruns refuses the lot.
  const items = Array.from({ length: MAX_ITEMS }, () => ({ flags: 1, size: 1000, body: bomb }))
  await assert.rejects(decode(v2(items.slice(0, 10))), EnvelopeError)
  // Honest declarations that add up to more than the cap are refused before inflating.
  const honest = Array.from({ length: 21 }, () => ({ flags: 1, size: 5_000_000, body: bomb.subarray(0, 8) }))
  const t = performance.now()
  await assert.rejects(decode(v2(honest)), EnvelopeError)
  assert.ok(performance.now() - t < 200, 'refused from the headers alone')
})

test('a message never carries a name or type, whatever the sender wrote', async () => {
  const [m2] = await decode(v2([{ kind: 1, name: 'evil.html', type: 'text/html', body: enc.encode('hi') }]))
  assert.deepEqual([m2.kind, m2.name, m2.type, m2.stripped], ['text', '', '', false])
  // v1: flags = text, with a name and type.
  const v1 = Uint8Array.from([1, 1, 0, 9, ...enc.encode('evil.html'), 9, ...enc.encode('text/html'), 0x68, 0x69])
  const [m1] = await decode(v1)
  assert.deepEqual([m1.kind, m1.name, m1.type], ['text', '', ''])
})

test('every HTML, SVG, XML or script flavour is saved as plain bytes', async () => {
  for (const t of [
    'application/x-xml',
    'application/xml-dtd',
    'text/xml-external-parsed-entity',
    'image/svg',
    'image/svg+xml-compressed',
    'APPLICATION/XHTML+XML',
    'application/vnd.wap.xhtml+xml',
    'text/x-javascript',
    'application/ecmascript',
    'text/html-sandboxed',
    'application/vnd.mozilla.xul+xml',
  ])
    assert.equal(safeType(t), 'application/octet-stream', t)
  // Ordinary types keep their label, including Office ones whose names contain "xml".
  for (const t of [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/json',
    'text/csv',
    'image/jpeg',
    'application/zip',
    'application/pdf',
    'audio/mpeg',
  ])
    assert.equal(safeType(t), t, t)
  const [f] = await decode(v2([{ type: 'Image/SVG+XML', name: 'logo.svg', body: enc.encode('<svg onload="x()"/>') }]))
  assert.equal(f.type, 'application/octet-stream')
})

test('names with folders, controls and disguises are neutralised before saving', async () => {
  const tricky = ['../../.ssh/authorized_keys', 'C:\\Windows\\win.ini', 'invoice\u202Efdp.exe', 'a\u2066b\u2069.txt', 'zero\u200Bwidth\u200E.txt', 'line\u2028break.txt', 'CON', 'conin$', 'com\u00b9.txt', '\u0000\u0001', ' . ']
  const got = await decode(v2(tricky.map((name) => ({ name, body: Uint8Array.from([1]) }))))
  assert.deepEqual(
    got.map((g) => g.name),
    tricky,
    'decode keeps the names as sent; the page cleans them',
  )
  const safe = got.map((g) => safeName(g.name, 'file'))
  assert.deepEqual(safe, ['_.._.ssh_authorized_keys', 'C__Windows_win.ini', 'invoice_fdp.exe', 'a_b_.txt', 'zero_width_.txt', 'line_break.txt', '_CON', '_conin$', '_com\u00b9.txt', '__', 'file'])
  for (const s of safe) assert.doesNotMatch(s, /[/\\\x00-\x1f\u200b\u200e\u202e\u2028\u2066]/)
  // Emoji keep their joiners and variation selectors.
  assert.equal(safeName('👨‍👩‍👧 ❤️.txt', 'f'), '👨‍👩‍👧 ❤️.txt')
})

test('two spellings of the same name become two different zip entries', async () => {
  const nfc = 'caf\u00e9.txt'
  const nfd = 'cafe\u0301.txt'
  assert.equal(safeName(nfd, 'f'), nfc)
  assert.deepEqual(uniqueNames([safeName(nfc, 'f'), safeName(nfd, 'f')]), [nfc, 'caf\u00e9 (2).txt'])
  const out = unzipSync(await zipFiles([{ name: nfc, data: Uint8Array.from([1]) }, { name: nfd, data: Uint8Array.from([2]) }]))
  assert.deepEqual(Object.keys(out), [nfc, 'caf\u00e9 (2).txt'])
})

test('a message never ends up in the zip', async () => {
  const secret = 'the vault code is 8675309'
  const items: Item[] = [
    { kind: 'text', name: 'message.txt', type: '', data: enc.encode(secret) },
    { kind: 'file', name: 'a.txt', type: 'text/plain', data: enc.encode('first') },
    { kind: 'file', name: 'b.txt', type: 'text/plain', data: enc.encode('second') },
  ]
  const zip = await zipFiles(items)
  assert.deepEqual(Object.keys(unzipSync(zip)), ['a.txt', 'b.txt'])
  assert.ok(!Buffer.from(zip).includes(Buffer.from(secret)))
  await assert.rejects(zipFiles([items[0]]))
})

test('a zip entry called __proto__ or constructor is just a file', async () => {
  const out = unzipSync(
    await zipFiles([
      { name: '__proto__', data: Uint8Array.from([1]) },
      { name: 'constructor', data: Uint8Array.from([2]) },
      { name: 'toString', data: Uint8Array.from([3]) },
    ]),
  )
  assert.deepEqual(Object.keys(out).sort(), ['___proto__', 'constructor', 'toString'])
})

test('the composer path (store, then packItem) weighs exactly what encode sends', async () => {
  // As main.ts does it: a renamed file, cleaned bytes with the flag, a message.
  const items: Item[] = [
    { kind: 'text', name: '', type: '', data: enc.encode('see attached, 2 files') },
    { kind: 'file', name: 'photo-1.jpg', type: 'IMAGE/JPEG', data: crypto.getRandomValues(new Uint8Array(5000)), stripped: true },
    { kind: 'file', name: 'n'.repeat(400) + '.csv', type: 'text/csv', data: enc.encode('a,b,c\n'.repeat(3000)) },
  ]
  const packed = await Promise.all(items.map(async (item) => packItem(item, await store(item.data, item.kind === 'text' ? '' : item.type))))
  const wire = envelopeSize(packed)
  const bytes = encode(packed)
  assert.equal(wire, bytes.length)
  const got = await decode(bytes)
  assert.equal(got[1].stripped, true)
  assert.equal(got[1].type, 'image/jpeg')
  assert.ok(enc.encode(got[2].name).length <= 255)
  got.forEach((g, i) => assert.deepEqual(g.data, items[i].data))
})
