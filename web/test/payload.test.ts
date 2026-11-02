// Envelope tests. Run from the repo root: node --test 'web/test/*.test.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  EnvelopeError,
  ITEMS_BEFORE,
  MAX_DECODED,
  MAX_FILES,
  MAX_ITEMS,
  decode,
  encode,
  envelopeSize,
  fitName,
  inflate,
  pack,
  safeType,
  store,
  type Item,
} from '../src/payload.ts'
import { sentSize } from '../src/compress.ts'

const enc = new TextEncoder()
const dec = new TextDecoder()

function random(n: number): Uint8Array {
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(out.subarray(i, i + 65536))
  return out
}

function text(n: number): Uint8Array {
  const words = 'the quick brown fox jumps over a lazy mixnet node while gateways keep pieces '
  return enc.encode(words.repeat(Math.ceil(n / words.length)).slice(0, n))
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const out = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(out).arrayBuffer())
}

const file = (name: string, data: Uint8Array, type = '', stripped = false): Item => ({ kind: 'file', name, type, data, stripped })
const message = (s: string): Item => ({ kind: 'text', name: '', type: '', data: enc.encode(s) })

async function roundTrip(items: Item[]): Promise<Item[]> {
  return decode(encode(await Promise.all(items.map(pack))))
}

// Builds a v2 envelope by hand, so tests can make malformed ones.
interface RawItem {
  kind?: number
  flags?: number
  name?: string
  type?: string
  size?: number
  stored?: number
  body?: Uint8Array
}
function raw(items: RawItem[], o: { flags?: number; count?: number; ext?: number[]; tail?: number[] } = {}): Uint8Array {
  const out: number[] = [2, o.flags ?? 0, o.count ?? items.length]
  const ext = o.ext ?? []
  out.push(ext.length >> 8, ext.length & 0xff, ...ext)
  const u32 = (n: number) => out.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff)
  for (const it of items) {
    const body = it.body ?? new Uint8Array(0)
    const name = enc.encode(it.name ?? '')
    const type = enc.encode(it.type ?? '')
    out.push(it.kind ?? 0, it.flags ?? 0, name.length, ...name, type.length, ...type)
    u32(it.size ?? body.length)
    u32(it.stored ?? body.length)
    out.push(...body)
  }
  out.push(...(o.tail ?? []))
  return Uint8Array.from(out)
}

async function refuses(bytes: Uint8Array, newer: boolean) {
  await assert.rejects(decode(bytes), (e: unknown) => e instanceof EnvelopeError && e.newer === newer)
}

// The v1 encoder as it shipped before v2, to make fixtures like real old links.
async function encodeV1(item: Item): Promise<Uint8Array> {
  const name = enc.encode(item.name.slice(0, 200))
  const type = enc.encode(item.type.slice(0, 100))
  let flags = item.kind === 'text' ? 1 : 0
  let body = item.data
  const packed = await deflate(item.data)
  if (packed.length < item.data.length * 0.95) {
    body = packed
    flags |= 2
  }
  const out = new Uint8Array(2 + 2 + name.length + 1 + type.length + body.length)
  let i = 0
  out[i++] = 1
  out[i++] = flags
  out[i++] = name.length >> 8
  out[i++] = name.length & 0xff
  out.set(name, i)
  i += name.length
  out[i++] = type.length
  out.set(type, i)
  i += type.length
  out.set(body, i)
  return out
}

test('round trip: a message and files keep their order, names, types and flags', async () => {
  const photo = random(3000)
  const items = [
    message('door code 4711, see you at 8'),
    file('notes.txt', text(5000), 'text/plain'),
    file('photo.jpg', photo, 'image/jpeg', true),
    file('empty', new Uint8Array(0)),
    file('päivä 🌞.md', text(70), 'text/markdown'),
  ]
  const got = await roundTrip(items)
  assert.equal(got.length, items.length)
  got.forEach((g, i) => {
    assert.equal(g.kind, items[i].kind)
    assert.equal(g.name, items[i].name)
    assert.equal(g.type, items[i].type)
    assert.deepEqual(g.data, items[i].data)
    assert.equal(g.stripped, !!items[i].stripped)
  })
  assert.equal(dec.decode(got[0].data), 'door code 4711, see you at 8')
})

test('round trip: a single message, and a single file', async () => {
  const [m] = await roundTrip([message('hi')])
  assert.deepEqual(m, { kind: 'text', name: '', type: '', data: enc.encode('hi'), stripped: false, smaller: false })
  const data = text(200_000)
  const [f] = await roundTrip([file('big.csv', data, 'text/csv')])
  assert.deepEqual(f.data, data)
})

test('compresses what shrinks, stores the rest as it is, judged by what it holds', async () => {
  assert.equal((await store(text(10_000))).method, 'deflate')
  assert.equal((await store(random(10_000))).method, 'as-is') // tried, didn't save 5%
  const jpegLike = text(10_000)
  jpegLike.set([0xff, 0xd8, 0xff, 0xe0])
  assert.equal((await store(jpegLike)).method, 'as-is') // known by its first bytes
  for (const start of [[0x4f, 0x67, 0x67, 0x53], [0x66, 0x4c, 0x61, 0x43], [0x49, 0x44, 0x33], [0x1a, 0x45, 0xdf, 0xa3], [0x77, 0x4f, 0x46, 0x32]]) {
    const b = text(10_000)
    b.set(start)
    assert.equal((await store(b)).method, 'as-is', String(start)) // Ogg, FLAC, tagged MP3, WebM, WOFF2
  }
  assert.equal((await store(enc.encode('a'.repeat(63)))).method, 'as-is') // too small to bother
  // A big file that squeezes nowhere it's sampled isn't deflated whole; one that does somewhere is.
  assert.equal((await store(random(1_000_000))).method, 'as-is')
  const mostlyText = random(1_000_000)
  mostlyText.set(text(400_000), 600_000)
  assert.equal((await store(mostlyText)).method, 'deflate')
  // Names and types play no part: store is given only the bytes.
  assert.equal(store.length, 1)
  // What counts sizes as they're sent (the PDF shrinker, in its worker) gets exactly what store sends.
  for (const b of [text(10_000), random(10_000), jpegLike, random(1_000_000), mostlyText]) assert.equal(await sentSize(b), (await store(b)).body.length)

  // Mixed items each keep their own choice.
  const items = [file('a.txt', text(20_000)), file('b.bin', random(20_000)), file('c.txt', text(30_000))]
  const packed = await Promise.all(items.map(pack))
  assert.deepEqual(
    packed.map((p) => p.method),
    ['deflate', 'as-is', 'deflate'],
  )
  const got = await decode(encode(packed))
  got.forEach((g, i) => assert.deepEqual(g.data, items[i].data))
})

test('the meter size is exactly the encoded size', async () => {
  const items = [
    message('a message, compressed or not '.repeat(20)),
    file('x'.repeat(300) + '.pdf', text(4000), 'application/pdf'),
    file('ünïcødé-🌞.png', random(900), 'image/png', true),
    file('no-type', random(10)),
  ]
  const packed = await Promise.all(items.map(pack))
  assert.equal(envelopeSize(packed), encode(packed).length)
  // 5 bytes per envelope, 12 per item plus name, type and stored body.
  const sum = packed.reduce((n, p) => n + 12 + p.name.length + p.type.length + p.body.length, 5)
  assert.equal(envelopeSize(packed), sum)
})

test('v1 links made before v2 still decode', async () => {
  // A hand-written v1 message: version 1, flags = text, no name, no type, "hi".
  const [m] = await decode(Uint8Array.from([1, 1, 0, 0, 0, 0x68, 0x69]))
  assert.equal(m.kind, 'text')
  assert.equal(dec.decode(m.data), 'hi')

  // A v1 file with a name and type, stored as it is.
  const v1file = Uint8Array.from([1, 0, 0, 5, ...enc.encode('a.txt'), 10, ...enc.encode('text/plain'), 1, 2, 3])
  const [f] = await decode(v1file)
  assert.deepEqual(f, { kind: 'file', name: 'a.txt', type: 'text/plain', data: Uint8Array.from([1, 2, 3]), stripped: false, smaller: false })

  // Made by the old encoder, compressed.
  const data = text(50_000)
  const old = await encodeV1(file('report.txt', data, 'text/plain'))
  assert.equal(old[1] & 2, 2)
  const [g] = await decode(old)
  assert.equal(g.name, 'report.txt')
  assert.deepEqual(g.data, data)

  // Old links get the same type checks as new ones.
  const [h] = await decode(await encodeV1(file('page.html', enc.encode('<b>x</b>'), 'text/html')))
  assert.equal(h.type, 'application/octet-stream')
})

test('every truncated envelope is refused as damaged', async () => {
  const v2 = encode(await Promise.all([message('hello there'), file('a.txt', text(300), 'text/plain'), file('b', random(40))].map(pack)))
  for (let n = 0; n < v2.length; n++) await refuses(v2.subarray(0, n), false)

  // v1 has no declared body size, so only its header can be cut short detectably.
  const v1 = Uint8Array.from([1, 0, 0, 5, ...enc.encode('a.txt'), 10, ...enc.encode('text/plain')])
  for (let n = 0; n < v1.length; n++) await refuses(v1.subarray(0, n), false)
  await refuses(Uint8Array.from([1, 0, 0xff, 0xff, 1, 2, 3]), false) // name length past the end
})

test('lengths that point past the end, or disagree, are refused', async () => {
  const body = Uint8Array.from([1, 2, 3])
  await refuses(raw([{ body, stored: 1000 }]), false) // stored length past the end
  await refuses(raw([{ body, size: 4 }]), false) // size and stored length disagree, not compressed
  await refuses(raw([{ body }], { tail: [0] }), false) // trailing byte
  await refuses(raw([{ body }], { ext: [1, 0, 9, 0] }), false) // extension record past its block
  const bad = raw([{ body, name: 'abc' }])
  bad[7] = 200 // name length past the end
  await refuses(bad, false)
  assert.equal((await decode(raw([{ body }])))[0].data.length, 3) // the unbroken version is fine
})

test('declared sizes over the cap are refused before inflating anything', async () => {
  const t = performance.now()
  await refuses(raw([{ flags: 1, size: 0xffffffff, body: Uint8Array.from([3, 0]) }]), false)
  const half = MAX_DECODED / 2 + 1
  await refuses(
    raw([
      { flags: 1, size: half, body: Uint8Array.from([3, 0]) },
      { flags: 1, size: half, body: Uint8Array.from([3, 0]) },
    ]),
    false,
  )
  assert.ok(performance.now() - t < 500, 'no buffer was allocated or inflated')
})

test('a deflate bomb stops at the declared size', async () => {
  const bomb = await deflate(new Uint8Array(20_000_000)) // about 20 KB that inflates to 20 MB
  assert.ok(bomb.length < 40_000)
  await refuses(raw([{ flags: 1, size: 1000, body: bomb }]), false)
  // Declared bigger than it really is: exact sizes only.
  await refuses(raw([{ flags: 1, size: 20_000_001, body: bomb }]), false)
  // The guard on its own, as v1 uses it (a cap rather than an exact size).
  await assert.rejects(inflate(bomb, 5_000_000, false), EnvelopeError)
  assert.equal((await inflate(bomb, 20_000_000, false)).length, 20_000_000)
  assert.equal((await inflate(bomb, 20_000_000, true)).length, 20_000_000)
})

test('corrupt compressed data is refused', async () => {
  await refuses(raw([{ flags: 1, size: 100, body: Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0xff]) }]), false)
  const good = await deflate(text(5000))
  await refuses(raw([{ flags: 1, size: 5000, body: good.subarray(0, good.length - 4) }]), false) // cut short
  await refuses(Uint8Array.from([1, 2, 0, 0, 0, 0xff, 0xff, 0xff]), false) // v1, compressed flag
})

test('unknown kinds: must-understand ones refuse the link, optional ones are skipped', async () => {
  const body = enc.encode('hi')
  await refuses(raw([{ kind: 2, body }]), true)
  await refuses(raw([{ kind: 1, body }, { kind: 0x7f, body }]), true)
  const got = await decode(raw([{ kind: 0x80, body }, { kind: 1, body }, { kind: 0xff, name: 'x', body }]))
  assert.equal(got.length, 1)
  assert.equal(got[0].kind, 'text')
  await refuses(raw([{ kind: 0x80, body }]), true) // nothing left this page understands
  // An optional item is still bounds-checked.
  await refuses(raw([{ kind: 0x80, body, stored: 50 }, { kind: 1, body }]), false)
})

test('item counts of 0 or over the limit are refused', async () => {
  const one: RawItem = { body: Uint8Array.from([7]) }
  await refuses(raw([], { count: 0 }), false)
  await refuses(raw(Array(MAX_ITEMS + 1).fill(one)), false)
  assert.equal((await decode(raw(Array(MAX_ITEMS).fill(one)))).length, MAX_ITEMS)
  const p = await pack(file('a', Uint8Array.from([7])))
  assert.throws(() => encode([]))
  assert.throws(() => encode(Array(MAX_ITEMS + 1).fill(p)))
})

test('up to 200 files; more than pages before read sets a must-understand header flag (2026-10-26)', async () => {
  assert.equal(MAX_FILES, 200)
  assert.equal(MAX_ITEMS, 201)
  assert.ok(MAX_ITEMS <= 255, 'the count is one byte')
  assert.equal(ITEMS_BEFORE, 51)
  const p = await pack(file('a', Uint8Array.from([7])))
  assert.equal(encode(Array(ITEMS_BEFORE).fill(p))[1], 0, 'as many as before: as before')
  const many = encode(Array(ITEMS_BEFORE + 1).fill(p))
  assert.equal(many[1], 0x10)
  assert.equal((await decode(many)).length, ITEMS_BEFORE + 1)
  assert.equal((await decode(encode(Array(MAX_ITEMS).fill(p)))).length, MAX_ITEMS)
  // A page from before refused any header flag in bits 4-7 as "newer", before its count check called it "damaged".
  assert.notEqual(many[1] & 0xf0, 0)
})

test('unknown versions', async () => {
  await refuses(Uint8Array.from([3, 0, 1, 0, 0]), true)
  await refuses(Uint8Array.from([0xff]), true)
  await refuses(Uint8Array.from([0, 1, 2]), false)
  await refuses(new Uint8Array(0), false)
})

test('sender types a browser could run are saved as plain bytes', async () => {
  const active = [
    'text/html',
    'TEXT/HTML',
    'application/xhtml+xml',
    'image/svg+xml',
    'text/xml',
    'application/xml',
    'application/rss+xml',
    'text/xsl',
    'text/javascript',
    'application/javascript',
    'application/x-javascript',
    'text/ecmascript',
    'text/javascript1.5',
    'multipart/related',
    'message/rfc822',
    'text/x-html',
  ]
  for (const t of active) assert.equal(safeType(t), 'application/octet-stream', t)
  for (const t of ['image/png', 'application/pdf', 'text/plain', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
    assert.equal(safeType(t), t)
  for (const t of ['', 'text/plain; charset=utf-8', 'nonsense', 'a/b/c', 'x/' + 'y'.repeat(100), 'tëxt/plain']) assert.equal(safeType(t), '', t)

  const got = await decode(raw([{ type: 'image/svg+xml', body: enc.encode('<svg/>') }, { type: 'Image/PNG', body: random(10) }]))
  assert.equal(got[0].type, 'application/octet-stream')
  assert.equal(got[1].type, 'image/png')
})

test('flags and extensions: ignorable bits pass, must-understand ones refuse', async () => {
  const body = enc.encode('hi')
  assert.equal((await decode(raw([{ body }], { flags: 0x0f }))).length, 1)
  for (const f of [0x20, 0x80]) await refuses(raw([{ body }], { flags: f }), true)
  // Bit 4 (more than 51 items, 2026-10-26) is understood.
  assert.equal((await decode(raw([{ body }], { flags: 0x10 }))).length, 1)
  assert.equal((await decode(raw([{ body, flags: 0x0c }]))).length, 1)
  for (const f of [0x40, 0x80, 0x51]) await refuses(raw([{ body, flags: f }]), true)
  // Bit 4 (Brotli) is understood, and only ever comes with bit 0 (compressed); bit 5 (a zip sent unpacked), only with both.
  for (const f of [0x10, 0x20, 0x21]) await refuses(raw([{ body, flags: f }]), false)
  // Extension records: type, 2-byte length, value. Bit 7 of the type = must-understand.
  assert.equal((await decode(raw([{ body }], { ext: [0x05, 0, 2, 9, 9, 0x7f, 0, 0] }))).length, 1)
  await refuses(raw([{ body }], { ext: [0x05, 0, 1, 9, 0x85, 0, 0] }), true)
  // The stripped flag survives, but only for files.
  const [f, t] = await decode(raw([{ body, flags: 2 }, { kind: 1, body, flags: 2 }]))
  assert.equal(f.stripped, true)
  assert.equal(t.stripped, false)
  // So does "a smaller copy" (bit 2, once only ignorable, so older pages still open these), only for files.
  const [s, st] = await decode(raw([{ body, flags: 4 }, { kind: 1, body, flags: 4 }]))
  assert.equal(s.smaller, true)
  assert.equal(s.stripped, false)
  assert.equal(st.smaller, false)
})

test('a smaller copy is marked as one, end to end', async () => {
  const photo: Item = { kind: 'file', name: 'IMG_1.jpg', type: 'image/jpeg', data: Uint8Array.from([1, 2, 3]), smaller: true }
  const [got] = await decode(encode([await pack(photo), await pack(file('notes.txt', enc.encode('hi')))]).slice())
  assert.equal(got.smaller, true)
  const [, other] = await decode(encode([await pack(photo), await pack(file('notes.txt', enc.encode('hi')))]))
  assert.equal(other.smaller, false)
})

test('long names are cut on a code-point boundary and keep their extension', async () => {
  assert.equal(fitName('short.pdf'), 'short.pdf')
  const long = 'a'.repeat(400) + '.pdf'
  const cut = fitName(long)
  assert.ok(enc.encode(cut).length <= 255)
  assert.ok(cut.endsWith('….pdf'))
  assert.ok(cut.startsWith('aaaa'))
  const emoji = '🌞'.repeat(100) + '.txt' // 4 bytes each
  const e = fitName(emoji)
  assert.ok(enc.encode(e).length <= 255)
  assert.ok(!e.includes('�'))
  assert.match(e, /^(🌞)+….txt$/)
  // On the wire, too.
  const [g] = await roundTrip([file(long, Uint8Array.from([1]))])
  assert.equal(g.name, cut)
})
