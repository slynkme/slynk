// Brotli for what's sent ("Stronger compression"): the real helper module
// (core/cmd/tools-wasm) as the page runs it, against Node's own Brotli
// (Google's C library); envelopes with Brotli items; and the worker client.
// Run from the repo root: npm --prefix web test
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { after, before, describe, test } from 'node:test'
import { brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib'
import { unzipSync, zipSync } from 'fflate'
import { EnvelopeError, MAX_DECODED, UNPACK_TEXT, decode, encode, packItem, squeeze, store, type Item, type Stored } from '../src/payload.ts'
import { readZipDirectory } from '../src/strip/zipdir.ts'
import { MAX_UNPACKED_FILES, rebuildZip, repackZip, unpackedZip } from '../src/zipInside.ts'
import { BROTLI_FLAG, MANY_FLAG, buildLinkV2, parseLinkV2 } from '../src/linkv2.ts'
import {
  MAX_BROTLI,
  SqueezeError,
  makeSqueezer,
  qualityFor,
  useSqueezer,
  type SqueezeRequest,
  type SqueezeResponse,
  type SqueezeWorker,
  type Squeezer,
} from '../src/squeeze/index.ts'

const enc = new TextEncoder()

/** Something like a page's code: compressible, not too repetitive. */
function code(n: number): Uint8Array {
  let s = ''
  for (let i = 0; s.length < n; i++) s += `function row${i}(x) { return x.map((v) => v * ${i % 97} + ${(i * 7919) % 1000}) } // part ${i % 13}\n`
  return enc.encode(s.slice(0, n))
}

function random(n: number): Uint8Array {
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(out.subarray(i, i + 65536))
  return out
}

const nodeBrotli = (d: Uint8Array, quality = 11) => new Uint8Array(brotliCompressSync(d, { params: { [constants.BROTLI_PARAM_QUALITY]: quality } }))

type Tools = { brotli(d: Uint8Array, q: number): Promise<Uint8Array>; unbrotli(s: Uint8Array, n: number): Promise<Uint8Array> }
let tools: Tools

async function loadTools(): Promise<Tools> {
  const generated = new URL('../src/core/generated/', import.meta.url)
  const wasmPath = new URL('slynk-tools.wasm', generated)
  assert.ok(existsSync(wasmPath), 'run `npm run build:core` first')
  await import(new URL('wasm_exec.js', generated).href)
  const g = globalThis as unknown as {
    Go: new () => { importObject: WebAssembly.Imports; run(i: WebAssembly.Instance): Promise<void> }
    slynkTools?: Tools
    onSlynkToolsReady?: () => void
  }
  if (g.slynkTools) return g.slynkTools
  const ready = new Promise<void>((resolve) => (g.onSlynkToolsReady = resolve))
  const go = new g.Go()
  const { instance } = await WebAssembly.instantiate(readFileSync(wasmPath), go.importObject)
  void go.run(instance)
  await ready
  return g.slynkTools!
}

// The module itself, as the worker runs it, standing in for the worker.
const real: Squeezer = { brotli: (d, q) => tools.brotli(d, q), unbrotli: (s, n) => tools.unbrotli(s, n) }

before(async () => {
  tools = await loadTools()
  useSqueezer(real)
})
after(() => useSqueezer(null))

describe('the helper module', () => {
  test('its streams and Google’s read each other', async () => {
    for (const data of [new Uint8Array(0), enc.encode('a'), code(300_000), random(20_000)]) {
      const mine = await tools.brotli(data, 11)
      assert.deepEqual(new Uint8Array(brotliDecompressSync(mine)), data)
      for (const q of [1, 6, 11]) assert.deepEqual(await tools.unbrotli(nodeBrotli(data, q), data.length), data)
    }
  })

  test('it’s as good as Google’s best', async () => {
    const data = code(400_000)
    const mine = (await tools.brotli(data, 11)).length
    assert.ok(mine <= nodeBrotli(data).length * 1.01, `${mine} vs ${nodeBrotli(data).length}`)
  })

  test('it gives exactly the size asked for, or nothing', async () => {
    const data = code(50_000)
    const stream = nodeBrotli(data)
    for (const [s, n] of [
      [stream, data.length + 1],
      [stream, data.length - 1],
      [stream.subarray(0, stream.length - 2), data.length],
      [Uint8Array.from([...stream, 0]), data.length],
      [Uint8Array.from([0x11, 0, 0, 0]), 10], // "Large Window Brotli", windows up to 1 GB
      [random(500), 1000],
      [stream, MAX_DECODED + 1],
      [stream, -1],
    ] as const) {
      await assert.rejects(tools.unbrotli(s, n))
    }
    // A bomb: 50 MB of zeros in a few bytes, said to be 1 KB.
    await assert.rejects(tools.unbrotli(nodeBrotli(new Uint8Array(50_000_000), 5), 1000))
  })
})

describe('envelopes with Brotli', () => {
  const file = (data: Uint8Array): Item => ({ kind: 'file', name: 'app.js', type: 'text/javascript', data })

  test('Brotli is used when it’s smaller, and the item comes back whole', async () => {
    const data = code(200_000)
    const deflated = await store(data)
    assert.equal(deflated.method, 'deflate')
    const best = await squeeze(data, deflated, qualityFor(data.length))
    assert.equal(best.method, 'brotli')
    assert.ok(best.body.length < deflated.body.length * 0.95, `${best.body.length} vs ${deflated.body.length}`)
    const bytes = encode([packItem(file(data), best), packItem({ kind: 'text', name: '', type: '', data: enc.encode('hi') }, await store(enc.encode('hi')))])
    // Bit 0 and bit 4: a page from before Brotli skips its size check (bit 0) and then meets a
    // must-understand bit it doesn't know (bit 4), so it says "newer" rather than "damaged".
    assert.equal(bytes[6], 0x11)
    const [got, text] = await decode(bytes)
    assert.deepEqual(got.data, data)
    assert.equal(new TextDecoder().decode(text.data), 'hi')
  })

  test('what store() made is kept when Brotli can’t help, isn’t tried, or fails', async () => {
    const calls: number[] = []
    const counting: Squeezer = { brotli: (d, q) => (calls.push(d.length), real.brotli(d, q)), unbrotli: real.unbrotli }
    useSqueezer(counting)
    try {
      const jpegLike = code(10_000)
      jpegLike.set([0xff, 0xd8, 0xff, 0xe0])
      const big = new Uint8Array(MAX_BROTLI + 1)
      for (const data of [jpegLike, big]) {
        const stored = await store(data)
        assert.equal(await squeeze(data, stored, 11), stored)
      }
      assert.deepEqual(calls, [])
      // Tried whatever deflate managed, but no smaller.
      for (const noise of [random(10_000), random(1_000_000)]) {
        const stored = await store(noise)
        assert.equal(stored.method, 'as-is')
        assert.equal(await squeeze(noise, stored, 5), stored)
      }
      assert.deepEqual(calls, [10_000, 1_000_000])
    } finally {
      useSqueezer(real)
    }
    useSqueezer({ brotli: () => Promise.reject(new SqueezeError('the helper module didn’t load', true)), unbrotli: real.unbrotli })
    try {
      const data = code(20_000)
      const stored = await store(data)
      assert.equal(await squeeze(data, stored, 11), stored)
    } finally {
      useSqueezer(real)
    }
  })

  test('what deflate can’t touch, Brotli can: the same bytes twice, far apart (as in a PDF)', async () => {
    const part = random(300_000)
    const data = new Uint8Array(600_000)
    data.set(part)
    data.set(part, 300_000)
    const stored = await store(data) // deflate looks back 32 KB: its samples don't squeeze
    assert.equal(stored.method, 'as-is')
    const best = await squeeze(data, stored, 5)
    assert.equal(best.method, 'brotli')
    assert.ok(best.body.length < data.length * 0.55, `${best.body.length}`)
  })

  test('stopping it rejects as stopped', async () => {
    const stop = new AbortController()
    useSqueezer({ brotli: () => Promise.reject(new DOMException('Stopped', 'AbortError')), unbrotli: real.unbrotli })
    try {
      stop.abort()
      const data = code(20_000)
      await assert.rejects(squeeze(data, await store(data), 11, stop.signal), { name: 'AbortError' })
    } finally {
      useSqueezer(real)
    }
  })

  test('a Brotli item bigger than any page sends is from a newer one; one the wrong size is damaged', async () => {
    await assert.rejects(decode(envelope(nodeBrotli(enc.encode('x')), MAX_BROTLI + 1)), (e) => e instanceof EnvelopeError && e.newer)
    useSqueezer({ brotli: real.brotli, unbrotli: async () => new Uint8Array(3) })
    try {
      await assert.rejects(decode(envelope(nodeBrotli(code(100)), 100)), (e) => e instanceof EnvelopeError && !e.newer && !e.again)
    } finally {
      useSqueezer(real)
    }
  })

  // An envelope with one Brotli item.
  function envelope(body: Uint8Array, size: number): Uint8Array {
    const stored: Stored = { body, method: 'brotli' }
    return encode([packItem(file(new Uint8Array(size)), stored)])
  }

  test('a damaged Brotli body is damaged; one this tab couldn’t unpack can be tried again', async () => {
    await assert.rejects(decode(envelope(random(300), 1000)), (e) => e instanceof EnvelopeError && !e.newer && !e.again)
    const data = code(30_000)
    await assert.rejects(decode(envelope(nodeBrotli(data), data.length + 1)), (e) => e instanceof EnvelopeError && !e.again)
    useSqueezer({ brotli: real.brotli, unbrotli: () => Promise.reject(new SqueezeError('the helper module stopped', true)) })
    try {
      await assert.rejects(decode(envelope(nodeBrotli(data), data.length)), (e) => e instanceof EnvelopeError && e.again && e.message === UNPACK_TEXT)
    } finally {
      useSqueezer(real)
    }
    assert.deepEqual((await decode(envelope(nodeBrotli(data), data.length)))[0].data, data)
  })
})

describe('a zip sent unpacked', () => {
  // A folder of code as a zip tool makes it (its files deflated, or stored), with a script, a folder and a picture.
  function codeZip(level: 0 | 6) {
    const unix = (mode: number) => ({ os: 3, attrs: mode * 0x10000 })
    return zipSync(
      {
        'site/': [new Uint8Array(0), { ...unix(0o40755), level }],
        'site/index.html': [code(40_000), { ...unix(0o100644), level }],
        'site/app.js': [code(120_000), { ...unix(0o100644), level }],
        'site/build.sh': [enc.encode('#!/bin/sh\nnpm run build\n'), { ...unix(0o100755), level }],
        'site/logo.png': [random(5000), { ...unix(0o100644), level: 0 }],
      },
      { mtime: new Date('2026-01-02T03:04:05Z') },
    )
  }

  test('the recipient’s zip has the same files, folders and kinds as the sender’s', async () => {
    for (const level of [0, 6] as const) {
      const base = codeZip(level)
      const { data: rebuilt } = rebuildZip(base, [], new Set())
      const plain = unpackedZip(base, [], new Set(), MAX_BROTLI)!
      assert.ok(readZipDirectory(plain).every((e) => e.method === 0))
      const got = await repackZip(plain, MAX_BROTLI)
      assert.deepEqual(unzipSync(got), unzipSync(rebuilt))
      const kinds = (z: Uint8Array) => readZipDirectory(z).map((e) => [e.name, e.external >>> 16, e.dosDate])
      assert.deepEqual(kinds(got), kinds(rebuilt))
      // A zip that stored its files: the recipient's is the sender's, byte for byte (the same compressor, the same rule).
      if (level === 0) assert.deepEqual(got, rebuilt)
    }
  })

  test('it goes in one Brotli item, about a third smaller, and comes back whole', async () => {
    const base = codeZip(6)
    const { data: rebuilt } = rebuildZip(base, [], new Set())
    const plain = unpackedZip(base, [], new Set(), MAX_BROTLI)!
    const body = await tools.brotli(plain, qualityFor(plain.length))
    assert.ok(body.length < rebuilt.length * 0.9, `${body.length} vs ${rebuilt.length}`)
    const zipItem: Item = { kind: 'file', name: 'site.zip', type: 'application/zip', data: rebuilt }
    const p = packItem(zipItem, { body, method: 'brotli', unpacked: plain.length })
    assert.equal(p.size, rebuilt.length) // the zip's own size, for the sender's records
    const bytes = encode([p])
    assert.equal(bytes[6], 0x31) // compressed, Brotli, unpacked: all must-understand to a page from before
    const [got] = await decode(bytes)
    assert.deepEqual(unzipSync(got.data), unzipSync(rebuilt))
  })

  test('what isn’t an unpacked zip is given as it is', async () => {
    const deflated = codeZip(6)
    for (const bytes of [random(3000), deflated, enc.encode('PK not really a zip')]) assert.equal(await repackZip(bytes, MAX_BROTLI), bytes)
    const plain = unpackedZip(codeZip(0), [], new Set(), MAX_BROTLI)!
    assert.equal(await repackZip(plain, plain.length - 1), plain) // too big
    const broken = plain.slice()
    broken[200] ^= 0xff // in a file's bytes: its CRC no longer matches
    assert.equal(await repackZip(broken, MAX_BROTLI), broken)
  })

  // Thousands of tiny files, all stored: each is compressed again on arrival, so a crafted one could keep a page busy.
  const manyFiles = (n: number) => zipSync(Object.fromEntries(Array.from({ length: n }, (_, i) => [`f/${i}.txt`, [code(80), { level: 0 }]])))

  test('more files than a sender sends, or than the envelope has left, is given as it is', async () => {
    const tooMany = manyFiles(MAX_UNPACKED_FILES + 1)
    assert.equal(await repackZip(tooMany, MAX_BROTLI), tooMany)
    const some = manyFiles(6)
    const budget = { files: 10 }
    assert.notEqual(await repackZip(some, MAX_BROTLI, budget), some) // 6 of the 10
    assert.equal(budget.files, 4)
    assert.equal(await repackZip(some, MAX_BROTLI, budget), some) // 6 more than are left
    // Nor does a sender's page unpack one with more files than a recipient would repack.
    assert.equal(unpackedZip(tooMany, [], new Set(), MAX_BROTLI), null)
  })

  test('a zip isn’t unpacked when that comes out too big, headers and all, or hardly bigger than the zip', () => {
    const base = codeZip(6)
    assert.equal(unpackedZip(base, [], new Set(), 100_000), null)
    const plain = unpackedZip(base, [], new Set(), MAX_BROTLI)!
    // Its files alone fit under this; with their headers they don't.
    const files = Object.values(unzipSync(base)).reduce((n, f) => n + f.length, 0)
    assert.ok(files < plain.length)
    assert.equal(unpackedZip(base, [], new Set(), files), null)
    assert.equal(unpackedZip(base, [], new Set(), MAX_BROTLI, files + 1), null) // less than asked for
  })
})

test('a link that carries Brotli says so, so an older page refuses it before using it', () => {
  const v1 = new Uint8Array(148)
  v1[0] = 1
  new DataView(v1.buffer).setBigUint64(66, 1_793_000_000_000_000_000n)
  const secret = random(32)
  const plain = buildLinkV2(v1, 'one-time', 500, secret)
  const marked = buildLinkV2(v1, 'one-time', 500, secret, false, true)
  assert.equal(plain[1], 2)
  assert.equal(marked[1], 2 | BROTLI_FLAG)
  assert.deepEqual([parseLinkV2(plain).mode, parseLinkV2(plain).brotli], ['one-time', false])
  assert.deepEqual([parseLinkV2(marked).mode, parseLinkV2(marked).brotli], ['one-time', true])
  // A page from before knows only modes 1 and 2, and refuses any other "made by a newer version"
  // before it holds or claims anything (linkv2.ts parseLinkV2, burn.ts).
  assert.ok(![1, 2].includes(marked[1]))
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
  assert.match(main, /const brotli = usesBrotli\(c\.packed\)/)
  assert.match(main, /buildLinkV2\(v1, kind, hours, share\.L, !!password, brotli, many\)/)
})

test('a link with more than 51 items says so with a bit of its own, which every page before refuses (2026-10-26)', () => {
  const v1 = new Uint8Array(148)
  v1[0] = 1
  new DataView(v1.buffer).setBigUint64(66, 1_793_000_000_000_000_000n)
  const secret = random(32)
  const many = buildLinkV2(v1, 'one-time', 500, secret, false, false, true)
  const both = buildLinkV2(v1, 'one-time', 500, secret, false, true, true)
  assert.equal(many[1], 2 | MANY_FLAG)
  assert.equal(both[1], 2 | MANY_FLAG | BROTLI_FLAG)
  for (const link of [many, both]) assert.deepEqual([parseLinkV2(link).mode, parseLinkV2(link).many], ['one-time', true])
  assert.equal(parseLinkV2(buildLinkV2(v1, 'one-time', 500, secret, false, true)).many, false)
  // Pages before knew modes 1 and 2, those since Brotli with its bit masked off: both refuse these as newer.
  for (const link of [many, both]) {
    assert.ok(![1, 2].includes(link[1]))
    assert.ok(![1, 2].includes(link[1] & ~BROTLI_FLAG))
  }
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
  assert.match(main, /const many = usesMany\(c\.packed\)/)
})

test('Brotli’s setting by size', () => {
  assert.equal(qualityFor(1), 11)
  assert.equal(qualityFor(512_000), 11)
  assert.equal(qualityFor(512_001), 10)
  assert.equal(qualityFor(2_000_000), 10)
  assert.equal(qualityFor(2_000_001), 9)
})

// --- The worker client, with stand-in workers -------------------------------------------------

type Answer = (r: SqueezeRequest) => SqueezeResponse | 'crash' | 'never'

class FakeWorker implements SqueezeWorker {
  static made: FakeWorker[] = []
  terminated = false
  got: SqueezeRequest[] = []
  private messages = new Set<(e: MessageEvent<SqueezeResponse>) => void>()
  private errors = new Set<(e: Event) => void>()
  private answer: Answer
  constructor(answer: Answer) {
    this.answer = answer
    FakeWorker.made.push(this)
  }
  postMessage(m: SqueezeRequest) {
    this.got.push(m)
    setTimeout(() => {
      if (this.terminated) return
      const a = this.answer(m)
      if (a === 'never') return
      if (a === 'crash') return this.errors.forEach((l) => l(Object.assign(new Event('error'), { message: 'crashed' })))
      this.messages.forEach((l) => l({ data: a } as MessageEvent<SqueezeResponse>))
    }, 5)
  }
  terminate() {
    this.terminated = true
  }
  addEventListener(type: 'message' | 'error', l: never) {
    ;(type === 'message' ? this.messages : this.errors).add(l)
  }
  removeEventListener(type: 'message' | 'error', l: never) {
    ;(type === 'message' ? this.messages : this.errors).delete(l)
  }
}

const echo: Answer = (r) => ({ id: r.id, ok: true, data: r.data })

describe('the worker client', () => {
  test('unpacking tries a fresh worker when one fails, up to three, and not for damaged data', async () => {
    FakeWorker.made = []
    let n = 0
    const flaky = makeSqueezer(() => new FakeWorker((r) => (++n < 3 ? 'crash' : echo(r))), 50, 1)
    assert.deepEqual(await flaky.unbrotli(Uint8Array.from([1, 2]), 2), Uint8Array.from([1, 2]))
    assert.equal(FakeWorker.made.length, 3)
    assert.ok(FakeWorker.made[0].terminated && FakeWorker.made[1].terminated)

    FakeWorker.made = []
    const dead = makeSqueezer(() => new FakeWorker(() => 'crash'), 50, 1)
    await assert.rejects(dead.unbrotli(Uint8Array.from([1]), 1), (e) => e instanceof SqueezeError && e.broken)
    assert.equal(FakeWorker.made.length, 3)

    FakeWorker.made = []
    const damaged = makeSqueezer(() => new FakeWorker((r) => ({ id: r.id, ok: false, broken: false, message: 'squeeze: damaged' })), 50, 1)
    await assert.rejects(damaged.unbrotli(Uint8Array.from([1]), 1), (e) => e instanceof SqueezeError && !e.broken)
    assert.equal(FakeWorker.made.length, 1)
    assert.equal(FakeWorker.made[0].terminated, false) // a damaged stream says nothing against the worker
  })

  test('one job at a time, the caller’s data left whole, and the worker closed once idle', async () => {
    FakeWorker.made = []
    let busy = 0
    let most = 0
    const s = makeSqueezer(() => new FakeWorker((r) => (busy++, (most = Math.max(most, busy)), busy--, echo(r))), 30, 1)
    const data = Uint8Array.from([7, 8, 9])
    const outs = await Promise.all([s.brotli(data, 11), s.brotli(data, 10), s.brotli(data, 9)])
    assert.equal(most, 1)
    assert.deepEqual(outs, [data, data, data])
    assert.deepEqual(data, Uint8Array.from([7, 8, 9]))
    assert.equal(FakeWorker.made.length, 1)
    assert.deepEqual(FakeWorker.made[0].got.map((r) => (r.op === 'brotli' ? r.quality : 0)), [11, 10, 9])
    await new Promise((r) => setTimeout(r, 60))
    assert.equal(FakeWorker.made[0].terminated, true)
  })

  test('a job stopped while it waits its turn is settled at once, and never sent', async () => {
    FakeWorker.made = []
    const s = makeSqueezer(() => new FakeWorker((r) => (r.op === 'brotli' && r.quality === 11 ? 'never' : echo(r))), 1000, 1)
    void s.brotli(Uint8Array.from([1]), 11).catch(() => {}) // holds the lane
    const stop = new AbortController()
    const waiting = s.brotli(Uint8Array.from([2]), 10, stop.signal)
    await new Promise((r) => setTimeout(r, 20))
    const t = Date.now()
    stop.abort()
    await assert.rejects(waiting, { name: 'AbortError' })
    assert.ok(Date.now() - t < 50)
    assert.equal(FakeWorker.made[0].got.length, 1)
    FakeWorker.made[0].terminate()
  })

  test('stopping a job: before it starts nothing is sent, during it the worker goes', async () => {
    FakeWorker.made = []
    const s = makeSqueezer(() => new FakeWorker(() => 'never'), 1000, 1)
    const early = new AbortController()
    early.abort()
    await assert.rejects(s.brotli(Uint8Array.from([1]), 11, early.signal), { name: 'AbortError' })
    assert.equal(FakeWorker.made.length, 0)
    const late = new AbortController()
    const p = s.brotli(Uint8Array.from([1]), 11, late.signal)
    setTimeout(() => late.abort(), 10)
    await assert.rejects(p, { name: 'AbortError' })
    assert.equal(FakeWorker.made[0].terminated, true)
  })
})
