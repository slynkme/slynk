// The puzzle every new link must solve (the key server's put; web/src/pow/): the
// solver against Node's own SHA-256, and burn.ts following what slynk.me's
// answers say. The key server's checks are tested in Go (core/keyserver).
// Nothing here is random in a way that could make it fail: every nonce meant
// to be refused is checked to be refused.
// Run: node --test 'web/test/*.test.ts'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { DEFAULT_POW_BITS, RESPONSE_BYTES, get, makeShare, prepareShare, protect, put, puzzleBits, requestBody, serverNow } from '../src/burn.ts'
import { putProblem } from '../src/ui/linkText.ts'
import * as copy from '../src/burnCopy.ts'
import { solveInBackground } from '../src/pow/index.ts'
import { LABEL, MAX_BITS, NONCE_BYTES, WINDOW_S, leadingZeroBits, message, nonceBytes, search, solve, windowAt } from '../src/pow/puzzle.ts'
import { goConst, goDefault } from './helpers/keyserver.ts'

const POW_BITS = goDefault('PowBits')
const POW_WINDOW = goConst('PowWindow')

const rnd = (n: number) => randomBytes(n).toString('base64url')
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64url')
const now = () => Math.floor(Date.now() / 1000)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const sha = (b: Uint8Array) => new Uint8Array(createHash('sha256').update(b).digest())
/** How many zero bits this nonce's hash starts with, by Node's SHA-256. */
const zeros = (id: Uint8Array, window: number, nonce: Uint8Array) => leadingZeroBits(sha(message(id, window, nonce)))
const newId = () => new Uint8Array(randomBytes(16))

/**
 * The first nonce from try `from` on with at least `bits` zero bits in
 * `window`, and fewer than `under` in each of `refused`: a solution the key server must
 * refuse whichever two windows it checks.
 */
function nonceWith(id: Uint8Array, window: number, bits: number, under: number, refused: number[], from = 0): Uint8Array {
  for (;;) {
    const n = search(id, window, bits, from, 2 ** 32)
    const nonce = nonceBytes(n)
    if (refused.every((w) => zeros(id, w, nonce) < under)) return nonce
    from = n + 1
  }
}

/** Waits, if need be, so the next few seconds are well inside one window on this machine's clock (the key server's too). */
async function awayFromEdge() {
  const into = (Date.now() / 1000) % POW_WINDOW
  if (into > POW_WINDOW - 5) await sleep((POW_WINDOW - into + 0.3) * 1000)
}

// --- The solver -------------------------------------------------------------------------

describe('the puzzle', () => {
  test('its numbers match the key server', () => {
    assert.equal(WINDOW_S, POW_WINDOW)
    assert.match(readFileSync(new URL('../../core/keyserver/protocol.go', import.meta.url), 'utf8'), new RegExp(`PowLabel\\s*= "${LABEL}"`))
    assert.match(readFileSync(new URL('../../deploy/keyserver/keyserver.service', import.meta.url), 'utf8'), new RegExp(`-pow-bits ${POW_BITS}\\b`), 'and slynk.me runs it so')
    assert.equal(DEFAULT_POW_BITS, POW_BITS, "the page's default before slynk.me's first answer is slynk.me's own")
    assert.ok(POW_BITS >= 1 && POW_BITS <= MAX_BITS)
  })

  test('the 40 bytes hashed: label, ID, window (big-endian), nonce', () => {
    const id = newId()
    const nonce = new Uint8Array(randomBytes(NONCE_BYTES))
    const m = message(id, 0x01020304, nonce)
    assert.equal(m.length, 40)
    assert.equal(Buffer.from(m.subarray(0, 12)).toString(), 'slynk/v1/pow')
    assert.deepEqual(m.subarray(12, 28), id)
    assert.deepEqual([...m.subarray(28, 32)], [1, 2, 3, 4])
    assert.deepEqual(m.subarray(32), nonce)
    assert.deepEqual([...nonceBytes(2 ** 32 + 5)], [0, 0, 0, 1, 0, 0, 0, 5])
    assert.equal(windowAt(WINDOW_S * 1000 * 7 + 1), 7)
  })

  test('rounds.ts is what scripts/pow-rounds.mjs makes (nobody edited it by hand)', async () => {
    const { source } = await import('../scripts/pow-rounds.mjs')
    assert.equal(readFileSync(new URL('../src/pow/rounds.ts', import.meta.url), 'utf8'), source())
  })

  test('leading zero bits are counted right', () => {
    assert.equal(leadingZeroBits(new Uint8Array([0x80, 0])), 0)
    assert.equal(leadingZeroBits(new Uint8Array([0x01, 0xff])), 7)
    assert.equal(leadingZeroBits(new Uint8Array([0, 0x10])), 11)
    assert.equal(leadingZeroBits(new Uint8Array(4)), 32)
  })

  test('the solver finds the first solution, by Node’s SHA-256, for any ID, window and difficulty', () => {
    for (let k = 0; k < 120; k++) {
      const id = newId()
      const window = randomBytes(4).readUInt32BE()
      const bits = 1 + (k % 12)
      const nonce = solve(id, window, bits)
      assert.ok(zeros(id, window, nonce) >= bits, `${bits} bits`)
      const n = Number(Buffer.from(nonce).readBigUInt64BE())
      for (let j = 0; j < n; j++) assert.ok(zeros(id, window, nonceBytes(j)) < bits, `try ${j} solved it already`)
    }
  })

  test('search looks only where it’s told, across the nonce’s two words too; 0 bits is solved at once; bad input is refused', () => {
    const id = newId()
    // Tries on both sides of 2^32, where the nonce's high word changes: the same answers as Node's SHA-256.
    const edge = 2 ** 32 - 300
    const found = search(id, 9, 8, edge, 2 ** 20)
    assert.ok(zeros(id, 9, nonceBytes(found)) >= 8)
    for (let j = edge; j < found; j++) assert.ok(zeros(id, 9, nonceBytes(j)) < 8, `try ${j}`)
    const past = search(id, 9, 8, 2 ** 32, 2 ** 20)
    assert.ok(past >= 2 ** 32 && zeros(id, 9, nonceBytes(past)) >= 8)
    const first = search(id, 9, 8, 0, 2 ** 32)
    assert.equal(search(id, 9, 8, 0, first), -1, 'not in the tries before it')
    assert.equal(search(id, 9, 8, first, 1), first)
    assert.equal(search(id, 9, 0, 12345, 1), 12345)
    assert.throws(() => search(new Uint8Array(15), 9, 8, 0, 1), TypeError)
    assert.throws(() => search(id, -1, 8, 0, 1), RangeError)
    assert.throws(() => search(id, 2 ** 32, 8, 0, 1), RangeError)
    assert.throws(() => search(id, 9, MAX_BITS + 1, 0, 1), RangeError)
    assert.throws(() => search(id, 9, 1.5, 0, 1), RangeError)
  })

  test('without workers (here, in Node) it’s solved on the page, in slices', async () => {
    const id = newId()
    const nonce = await solveInBackground(id, 77, 12)
    assert.ok(zeros(id, 77, nonce) >= 12)
    assert.deepEqual(await solveInBackground(id, 77, 0), nonceBytes(0))
    await assert.rejects(solveInBackground(id, 77, MAX_BITS + 1), RangeError)
  })
})

// --- burn.ts following slynk.me ---------------------------------------------------------
// A stand-in for the key server whose clock is hours ahead of this machine's, which
// checks each put's solution against its own window and difficulty.

describe('burn.ts follows what slynk.me says', () => {
  let server: Server
  let endpoint = ''
  let skew = 3 * 3600 // seconds slynk.me's clock is ahead
  let bits = 6
  let refuse = 0 // how many puts to refuse, whatever their solution
  let say: number | string = 6 // what "d" says, if not bits
  let puts: Array<{ id: Uint8Array; w: Uint8Array; window: number }> = []
  const answer = (st: string) => {
    const head = `{"v":1,"st":"${st}","s":"${rnd(32)}","g":25,"d":${JSON.stringify(say)},"t":${now() + skew},"p":"`
    return head + '.'.repeat(RESPONSE_BYTES - head.length - 2) + '"}'
  }
  const net = () => ({ endpoint, attempts: 1, timeoutMs: 5000 })
  before(async () => {
    server = createServer((req, res) => {
      let raw = ''
      req.on('data', (d: Buffer) => (raw += d))
      req.on('end', () => {
        const j = JSON.parse(raw)
        let st = 'gone'
        if (j.op === 'put') {
          const id = new Uint8Array(Buffer.from(j.id, 'base64url'))
          const w = new Uint8Array(Buffer.from(j.w, 'base64url'))
          const window = Math.floor((now() + skew) / WINDOW_S)
          puts.push({ id, w, window })
          const solved = zeros(id, window, w) >= bits || zeros(id, window - 1, w) >= bits
          st = refuse > 0 ? 'work' : solved ? 'ok' : 'work'
          if (refuse > 0) refuse--
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(answer(st))
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const addr = server.address()
    endpoint = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/api/k`
  })
  after(() => new Promise<void>((r) => server.close(() => r())))

  test('before any answer, the default; then slynk.me’s difficulty and clock', async () => {
    assert.equal(puzzleBits(), DEFAULT_POW_BITS)
    await get(newId(), net())
    assert.equal(puzzleBits(), 6)
    assert.ok(Math.abs(serverNow() - (Date.now() + skew * 1000)) < 2000, 'slynk.me’s clock, hours ahead')
    for (const [d, want] of [[40, MAX_BITS], [-3, 0], [0, 0], [6, 6]] as const) {
      say = d
      await get(newId(), net())
      assert.equal(puzzleBits(), want, `d ${d}`)
    }
    say = 'lots'
    await get(newId(), net())
    assert.equal(puzzleBits(), 6, 'an answer that isn’t a whole number changes nothing')
    say = 6
  })

  test('a put is solved for slynk.me’s window, not this device’s', async () => {
    puts = []
    assert.deepEqual(await put(await makeShare(), 'one-time', 1, net()), { ok: true })
    assert.equal(puts.length, 1)
    const p = puts[0]
    assert.ok(zeros(p.id, p.window, p.w) >= 6 || zeros(p.id, p.window - 1, p.w) >= 6)
    assert.ok(p.window - windowAt(Date.now()) >= 17, 'three hours ahead is 18 windows')
  })

  test('refused once: solved again as the answer says (harder), and sent once more', async () => {
    puts = []
    refuse = 1
    say = bits = 10
    try {
      assert.deepEqual(await put(await makeShare(), 'one-time', 1, net()), { ok: true })
      assert.equal(puts.length, 2)
      const p = puts[1]
      assert.ok(zeros(p.id, p.window, p.w) >= 10 || zeros(p.id, p.window - 1, p.w) >= 10, 'the second solves the harder puzzle')
    } finally {
      say = bits = 6
    }
  })

  test('refused twice: "busy" (Try again later), after exactly two puts', async () => {
    puts = []
    refuse = 2
    assert.deepEqual(await put(await makeShare(), 'one-time', 1, net()), { ok: false, reason: 'busy' })
    assert.equal(puts.length, 2)
    assert.equal(putProblem('busy').message, copy.PUT_BUSY)
  })

  test('prepareShare: made early, solved in the background, and the share protect() then uses', async () => {
    puts = []
    const early = prepareShare()
    assert.equal(prepareShare(), early, 'calling it again changes nothing')
    const share = await early
    const sent = await protect(new Uint8Array(10), 'one-time', 1, net())
    assert.ok(sent.ok)
    assert.deepEqual(sent.share.id, share.id)
    assert.equal(puts.length, 1)
    assert.notEqual(prepareShare(), early, 'the next link gets a share of its own')
    assert.ok((await protect(new Uint8Array(10), 'one-time', 1, net())).ok)
  })

  test('prepareShare: solved again when slynk.me’s window moves on, before Send', async () => {
    // slynk.me's clock a moment before the solution's window becomes the one before (plus the margin).
    const at = (windowAt(Date.now() + skew * 1000) + 1) * WINDOW_S + 29
    skew += at - (now() + skew)
    await get(newId(), net()) // the page hears the new time
    puts = []
    const share = await prepareShare()
    const first = Math.floor((now() + skew - 30) / WINDOW_S)
    await sleep(3000) // the window moves on: it's solved again for the new one
    const sent = await protect(new Uint8Array(10), 'one-time', 1, net())
    assert.ok(sent.ok)
    assert.deepEqual(sent.share.id, share.id)
    assert.equal(puts.length, 1)
    assert.ok(zeros(share.id, first + 1, puts[0].w) >= 6, 'solved for the new window')
  })

  test('prepareShare: that re-solve waits while the page is busy (a video being made smaller), then goes on', async () => {
    for (const idleAgain of [false, true]) {
      const at = (windowAt(Date.now() + skew * 1000) + 1) * WINDOW_S + 29
      skew += at - (now() + skew)
      await get(newId(), net())
      puts = []
      let busy = true
      const share = await prepareShare(() => busy)
      const first = Math.floor((now() + skew - 30) / WINDOW_S)
      await sleep(3000) // the re-solve falls due while the page is busy: put off
      busy = false
      if (idleAgain) assert.equal(await prepareShare(() => busy), share, 'the page, idle again, says so: it goes on')
      const sent = await protect(new Uint8Array(10), 'one-time', 1, net())
      assert.ok(sent.ok)
      assert.equal(puts.length, 1)
      if (idleAgain) assert.ok(zeros(share.id, first + 1, puts[0].w) >= 6, 'solved for the new window once idle')
      else assert.ok(zeros(share.id, first, puts[0].w) >= 6, 'not solved again: the first solution, still good for minutes')
    }
  })

  test('a prepared solution too old by Send is solved again first, so the put goes once', async () => {
    const share = await prepareShare()
    skew += 2 * WINDOW_S // the person wrote for 20 minutes (and the page heard slynk.me's time meanwhile)
    await get(newId(), net())
    puts = []
    const sent = await protect(new Uint8Array(10), 'one-time', 1, net())
    assert.ok(sent.ok)
    assert.deepEqual(sent.share.id, share.id)
    assert.equal(puts.length, 1, 'no refusal and second try')
  })
})

