// Cover requests (src/burnCover.ts): the gaps between a tab's requests, the
// loop itself, and the page. What the key server does with them is tested in
// Go (core/keyserver): every answer is 200 and 128 bytes, a request about an
// unknown ID changes nothing, and every answer takes at least its minimum
// time. The statistical tests draw fresh randomness each run, and
// each states its odds of failing by chance (under 1e-8).
// Run: npm --prefix web test
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, test } from 'node:test'
import { RESPONSE_BYTES, REQUEST_BYTES, advisedGap, claim, done, hold, makeShare, newNonce, protect, put, requestBody, reserve, revoke, seal, unlock, type ProtectResult } from '../src/burn.ts'
import { BURST_S, BURST_SPEEDUP, DEFAULT_GAP_S, MAX_GAP_S, MAX_WAIT_S, MIN_GAP_S, expGap, meanGap, nextGap, startCover, stopCover, uniform } from '../src/burnCover.ts'
import { buildLinkV2, parseLinkFragment, parseLinkV2, type LinkV2 } from '../src/linkv2.ts'
import { LINK_LENGTH, linkToFragment } from '../src/payload.ts'
import { goDefault } from './helpers/keyserver.ts'

const HOUR = 3600
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const now = () => Math.floor(Date.now() / 1000)
const rnd = (n: number) => new Uint8Array(randomBytes(n))
const b64 = (a: Uint8Array) => Buffer.from(a).toString('base64url')

/** The largest gap between n draws' empirical distribution and the CDF F (the Kolmogorov-Smirnov statistic). */
function ksDistance(draws: number[], F: (x: number) => number): number {
  const xs = [...draws].sort((a, b) => a - b)
  let d = 0
  xs.forEach((x, i) => (d = Math.max(d, Math.abs((i + 1) / xs.length - F(x)), Math.abs(i / xs.length - F(x)))))
  return d
}
/** By the Dvoretzky-Kiefer-Wolfowitz inequality, a true sample exceeds this distance with odds at most alpha. */
const ksBound = (n: number, alpha: number) => Math.sqrt(Math.log(2 / alpha) / (2 * n))

describe('cover requests: the gaps', () => {
  const N = 20_000

  test('uniform() is uniform on (0, 1]', () => {
    const us = Array.from({ length: N }, uniform)
    assert.ok(us.every((u) => u > 0 && u <= 1))
    // Odds of a false failure: at most 1e-9 (DKW).
    assert.ok(ksDistance(us, (x) => x) < ksBound(N, 1e-9))
  })

  test('exponentially distributed, with the mean asked for, and no floor or ceiling', () => {
    const mean = 25
    const gaps = Array.from({ length: N }, () => expGap(mean))
    // Odds of a false failure: at most 5e-9 (DKW), and below 1e-21 for each of the two others.
    assert.ok(ksDistance(gaps, (x) => 1 - Math.exp(-x / mean)) < ksBound(N, 5e-9), 'exponential')
    assert.ok(Math.min(...gaps) < 0.01 * mean, 'some gaps are tiny: none is kept back to a minimum')
    assert.ok(Math.max(...gaps) > 6 * mean, 'some are long: none is cut short to a maximum')
    // A fixed or merely jittered gap would fail by far: a constant's distance is at least 0.39.
    assert.ok(ksDistance(Array(N).fill(mean), (x) => 1 - Math.exp(-x / mean)) > 0.3)
  })

  test('expGap at the ends of uniform()', () => {
    assert.ok(expGap(25, 1) === 0, 'no wait at all') // -0, which is fine for a timer
    assert.ok(Number.isFinite(expGap(25, 2 ** -53)) && expGap(25, 2 ** -53) < 25 * 37)
  })

  test('the burst: the wait spends its exponential draw at the burst’s rate, then the usual one', () => {
    const mean = 25_000
    const burst = BURST_S * 1000
    // The cumulative rate: how many slots are due, on average, by t.
    const due = (t: number) => Math.min(t, burst) / (mean / BURST_SPEEDUP) + Math.max(0, t - burst) / mean
    for (let i = 0; i < 10_000; i++) {
      const elapsed = uniform() * 2 * burst
      const e = expGap(1)
      const gap = nextGap(elapsed, mean, burst, e)
      assert.ok(gap >= 0)
      assert.ok(Math.abs(due(elapsed + gap) - due(elapsed) - e) < 1e-9 * (1 + e), `elapsed ${elapsed}, e ${e}`)
    }
    assert.equal(nextGap(0, mean, burst, 1), mean / BURST_SPEEDUP)
    assert.equal(nextGap(burst, mean, burst, 1), mean)
    assert.equal(nextGap(burst - 1000, mean, burst, 2), 1000 + (2 - 1000 / (mean / BURST_SPEEDUP)) * mean)
  })

  test('the burst: about 14 slots in a page’s first minute, then one every 25 s', () => {
    const N = 20_000
    let first = 0
    let next = 0
    for (let i = 0; i < N; i++) {
      for (let t = nextGap(0, 25_000); t < 160_000; t += nextGap(t, 25_000)) {
        if (t < 60_000) first++
        else next++
      }
    }
    // Poisson totals: 20,000 x 14.4 and 20,000 x 4. By the Chernoff bound, each falls outside
    // these bands with odds under 1e-9.
    assert.ok(Math.abs(first / N - 14.4) < 14.4 * 0.015, `first minute: ${first / N}`)
    assert.ok(Math.abs(next / N - 4) < 4 * 0.029, `next 100 s: ${next / N}`)
    assert.deepEqual([BURST_S, BURST_SPEEDUP, MAX_WAIT_S], [60, 6, 8])
  })

  test('the mean gap: slynk.me’s, kept between 10 seconds and an hour', () => {
    assert.equal(DEFAULT_GAP_S, goDefault('CoverGap'), 'the page starts with what the key server will say')
    assert.deepEqual([MIN_GAP_S, MAX_GAP_S], [10, 3600])
    assert.equal(meanGap(undefined), DEFAULT_GAP_S)
    assert.equal(meanGap(Number.NaN), DEFAULT_GAP_S)
    assert.equal(meanGap(40), 40)
    assert.equal(meanGap(1), 10)
    assert.equal(meanGap(-5), 10)
    assert.equal(meanGap(1e9), 3600)
  })
})

/** A stand-in for a browser tab's document, for the hidden-tab tests (one, as a page has). */
const page = Object.assign(new EventTarget(), { visibilityState: 'visible' })

describe('cover requests: the loop', () => {
  let server: Server
  let endpoint = ''
  let bodies: string[] = []
  const answer = (st = 'gone', extra = ',"g":25', s = b64(rnd(32))) => {
    const head = `{"v":1,"st":"${st}","s":"${s}"${extra},"p":"`
    return head + '.'.repeat(RESPONSE_BYTES - head.length - 2) + '"}'
  }
  const usual = () => ({ status: 200, body: answer() })
  let reply: (op: string) => { status: number; body: string } = usual
  const ops = () => bodies.map((b) => JSON.parse(b).op as string)
  before(async () => {
    server = createServer((req, res) => {
      let raw = ''
      req.on('data', (d: Buffer) => (raw += d))
      req.on('end', () => {
        bodies.push(raw)
        const r = reply(JSON.parse(raw).op)
        res.writeHead(r.status, { 'Content-Type': 'application/json' })
        res.end(r.body)
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const addr = server.address()
    endpoint = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/api/k`
  })
  after(() => new Promise<void>((r) => server.close(() => r())))

  test('sends holds on random IDs, sized and padded like real requests, until stopped', async () => {
    bodies = []
    startCover({ net: { endpoint, attempts: 1 }, meanMs: 30, burstMs: 0 })
    startCover({ net: { endpoint, attempts: 1 }, meanMs: 30, burstMs: 0 }) // already running: no second loop
    await sleep(1500)
    stopCover()
    const sent = bodies.length
    // About 50 expected. Odds of fewer than 5 by chance: about 1e-15.
    assert.ok(sent >= 5, `${sent} cover requests`)
    assert.ok(sent < 200, 'one loop, not two')
    await sleep(300)
    assert.ok(bodies.length <= sent + 1, 'stopped (one may have been on its way)')
    const ids = new Set<string>()
    const nonces = new Set<string>()
    for (const b of bodies) {
      assert.equal(b.length, REQUEST_BYTES)
      const j = JSON.parse(b)
      assert.deepEqual(Object.keys(j), ['v', 'op', 'id', 'c', 'p'])
      assert.equal(j.op, 'hold')
      assert.equal(Buffer.from(j.id, 'base64url').length, 16)
      assert.equal(Buffer.from(j.c, 'base64url').length, 16)
      assert.equal(b, requestBody('hold', { id: j.id, c: j.c }), 'exactly what a real hold sends')
      ids.add(j.id)
      nonces.add(j.c)
    }
    assert.equal(ids.size, bodies.length, 'a new ID every time')
    assert.equal(nonces.size, bodies.length, 'a new nonce every time')
  })

  test('every tab follows the mean gap in slynk.me’s latest answer', async () => {
    const net = { endpoint, attempts: 1 }
    const ask = async (status: number, body: string) => {
      reply = () => ({ status, body })
      await hold(rnd(16), newNonce(), net)
      return advisedGap()
    }
    assert.equal(await ask(200, answer('gone', ',"g":40')), 40)
    assert.equal(meanGap(advisedGap()), 40)
    assert.equal(await ask(200, answer('ok', ',"g":3')), 3, 'real answers say it too')
    assert.equal(meanGap(advisedGap()), 10, 'kept to at least 10 seconds')
    assert.equal(await ask(200, answer('gone', ',"g":99999')), 99999)
    assert.equal(meanGap(advisedGap()), 3600, 'and at most an hour')
    assert.equal(await ask(200, answer('gone', '')), 99999, 'an answer without one changes nothing')
    assert.equal(await ask(503, answer('gone', ',"g":12')), 99999, 'nor does anything that isn’t the key server’s answer')
    assert.equal(await ask(200, answer('gone', ',"g":"12"')), 99999)
    assert.equal(await ask(200, answer('gone', ',"g":25')), 25)
    reply = usual
  })

  test('done waits for the next cover slot and goes in place of its cover request; what someone waits on goes at once', async () => {
    const net = { endpoint, attempts: 1 }
    bodies = []
    startCover({ net, meanMs: 1e9, burstMs: 0 }) // after a page's first minute; no slot for a long while
    try {
      const later = done(rnd(16), newNonce(), net)
      await claim(rnd(16), newNonce(), net)
      await hold(rnd(16), newNonce(), net)
      await put(await makeShare(), 'one-time', 1, net)
      await revoke(await makeShare(), net) // "Cancel this link": it must take effect at once
      const housekeeping = revoke(await makeShare(), { ...net, when: 'slot' }) // a failed send's half-key
      await sleep(200)
      assert.deepEqual(ops(), ['claim', 'hold', 'put', 'revoke'])
      stopCover() // no more slots, so whatever waits goes now
      await Promise.all([later, housekeeping])
      assert.deepEqual(ops().slice(4).sort(), ['done', 'revoke'])
    } finally {
      stopCover()
    }
    // With slots coming, waiting requests take the next ones, before any cover request.
    startCover({ net, meanMs: 30, burstMs: 0 })
    try {
      await sleep(100)
      const from = bodies.length
      await Promise.all(Array.from({ length: 5 }, () => done(rnd(16), newNonce(), net)))
      const after = ops().slice(from)
      const lastDone = after.lastIndexOf('done')
      assert.equal(after.filter((op) => op === 'done').length, 5)
      assert.ok(after.slice(0, lastDone).filter((op) => op === 'hold').length <= 1, `${after.join(' ')}: at most one cover request already on its way`)
    } finally {
      stopCover()
    }
  })

  test('in a page’s first minute, what someone waits on waits for a slot, but only so long', async () => {
    const net = { endpoint, attempts: 1 }
    bodies = []
    startCover({ net, meanMs: 1e9, maxWaitMs: 300 }) // in the burst, but no slot comes
    try {
      const claimed = claim(rnd(16), newNonce(), net)
      const later = done(rnd(16), newNonce(), net)
      await sleep(150)
      assert.deepEqual(ops(), [], 'waiting for a slot')
      await claimed
      assert.deepEqual(ops(), ['claim'], 'its wait ran out: it goes anyway')
      await sleep(100)
      assert.deepEqual(ops(), ['claim'], 'done waits on, as nobody waits on it')
      stopCover()
      await later
    } finally {
      stopCover()
    }
  })

  test('a real request in a slot goes in place of its cover request, and what someone waits on goes first', async () => {
    const net = { endpoint, attempts: 1 }
    const gaps = [200, 1e9]
    bodies = []
    startCover({ net, gaps: () => gaps.shift() ?? 1e9, maxWaitMs: 60_000 })
    try {
      const later = done(rnd(16), newNonce(), net)
      const claimed = claim(rnd(16), newNonce(), net) // in the burst: waits for the slot at 200 ms
      await claimed
      await sleep(100)
      assert.deepEqual(ops(), ['claim'], 'the slot went to the claim, ahead of done, and no cover request went with it')
      stopCover()
      await later
      assert.deepEqual(ops(), ['claim', 'done'])
    } finally {
      stopCover()
    }
  })

  test('opening a one-time link doesn’t wait for done, which keeps its own copy of the nonce', async () => {
    const net = { endpoint, attempts: 1 }
    const share = await makeShare()
    const sealed = await seal(new TextEncoder().encode('hi'), share.L, share.S)
    const link = parseLinkV2(buildLinkV2(fakeV1(), 'one-time', 24, share.L))
    reply = (op) => ({ status: 200, body: op === 'claim' ? answer('ok', ',"g":25', b64(share.S)) : answer('ok') })
    bodies = []
    startCover({ net, meanMs: 1e9, burstMs: 0 })
    try {
      const nonce = newNonce()
      const mine = b64(nonce)
      const opened = await unlock(link, sealed, nonce, net)
      assert.ok(opened.ok)
      assert.deepEqual(opened.envelope, new TextEncoder().encode('hi'))
      nonce.fill(0) // as the page does, straight away
      assert.deepEqual(ops(), ['claim'], 'open before done has gone')
      stopCover()
      assert.equal(await opened.deleted, true)
      assert.deepEqual(ops(), ['claim', 'done'])
      assert.equal(JSON.parse(bodies[1]).c, mine)
    } finally {
      stopCover()
      reply = usual
    }
  })

  test('in a hidden tab every real request waits for a slot; what someone waits on goes once it’s back in view', async () => {
    const net = { endpoint, attempts: 1 }
    page.visibilityState = 'hidden'
    Object.assign(globalThis, { document: page })
    bodies = []
    startCover({ net, meanMs: 1e9, burstMs: 0 })
    try {
      const claimed = claim(rnd(16), newNonce(), net) // a download that finished in the background
      const stored = put(await makeShare(), 'one-time', 1, net) // a send whose joining took a while
      const later = done(rnd(16), newNonce(), net)
      await sleep(200)
      assert.deepEqual(ops(), [], 'nothing goes at once while hidden')
      page.visibilityState = 'visible'
      page.dispatchEvent(new Event('visibilitychange'))
      await Promise.all([claimed, stored])
      await sleep(100)
      assert.deepEqual(ops().sort(), ['claim', 'put'], 'back in view: those go now; done still waits for its slot')
      // Hidden again: what nobody waits on goes at once, before the browser slows the timers.
      page.visibilityState = 'hidden'
      page.dispatchEvent(new Event('visibilitychange'))
      await later
      assert.deepEqual(ops().sort(), ['claim', 'done', 'put'])
      // And one that started waiting in view goes the moment the tab is hidden.
      page.visibilityState = 'visible'
      page.dispatchEvent(new Event('visibilitychange'))
      const another = done(rnd(16), newNonce(), net)
      await sleep(100)
      assert.equal(bodies.length, 3)
      page.visibilityState = 'hidden'
      page.dispatchEvent(new Event('visibilitychange'))
      await another
      assert.equal(ops().filter((op) => op === 'done').length, 2)
    } finally {
      stopCover()
      Reflect.deleteProperty(globalThis, 'document')
    }
  })

  test('a claim that waited for a slot past the link’s expiry isn’t sent', async () => {
    const net = { endpoint, attempts: 1 }
    page.visibilityState = 'hidden'
    Object.assign(globalThis, { document: page })
    const share = await makeShare()
    const sealed = await seal(new TextEncoder().encode('hi'), share.L, share.S)
    // A 1-hour link sent an hour ago less 1.5 seconds.
    const link = parseLinkV2(buildLinkV2(fakeV1(Date.now() - 3_600_000 + 1500), 'one-time', 1, share.L))
    bodies = []
    startCover({ net, meanMs: 1e9, burstMs: 0 })
    try {
      const nonce = newNonce()
      const opening = unlock(link, sealed, nonce, net) // a download that finished in a hidden tab
      await sleep(2000)
      page.visibilityState = 'visible'
      page.dispatchEvent(new Event('visibilitychange'))
      assert.deepEqual(await opening, { ok: false, reason: 'expired' })
      assert.deepEqual(ops(), [], 'nothing sent: the page never opens a link after the time the sender was shown')
      assert.deepEqual(await unlock(link, sealed, nonce, net), { ok: false, reason: 'expired' }, 'nor on a retry')
      assert.deepEqual(ops(), [])
    } finally {
      stopCover()
      Reflect.deleteProperty(globalThis, 'document')
    }
  })
})

// --- Helpers ---------------------------------------------------------------------------

function fakeV1(sentMs = Date.now()): Uint8Array {
  const v1 = new Uint8Array(randomBytes(LINK_LENGTH))
  v1[0] = 1
  new DataView(v1.buffer).setBigUint64(66, BigInt(sentMs) * 1_000_000n)
  return v1
}

describe('cover requests in the page', () => {
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')

  /** Every module an entry point loads, following relative imports. */
  function reach(entry: string): Set<string> {
    const seen = new Set<string>()
    const walk = (path: string) => {
      if (seen.has(path)) return
      seen.add(path)
      for (const m of readFileSync(path, 'utf8').matchAll(/(?:from|import)\s+'(\.{1,2}\/[^']+)'/g)) {
        const target = join(path, '..', m[1])
        if (target.includes('?') || /\.(css|wasm|json|js)$/.test(target)) continue
        const file = [target, `${target}.ts`, join(target, 'index.ts')].find((f) => f.endsWith('.ts') && existsSync(f))
        assert.ok(file, `${path} imports ${m[1]}`)
        walk(file)
      }
    }
    walk(fileURLToPath(new URL(entry, import.meta.url)))
    return seen
  }

  test('on by default, and started as the page loads', () => {
    assert.match(read('../src/ui/settings.ts'), /\n {2}coverRequests: true,\n/)
    const main = read('../src/main.ts')
    assert.match(main, /\nloadSettings\(\)\n(\/\/.*\n)*if \(settings\(\)\.coverRequests\) startCover\(\)\n/)
    assert.match(main, /updateSettings\(\{ coverRequests: on \}\)\n {2}if \(on\) startCover\(\)\n {2}else stopCover\(\)/)
    assert.ok(reach('../src/main.ts').has(fileURLToPath(new URL('../src/burnCover.ts', import.meta.url))), 'in the main bundle, not loaded later')
  })

  test('a cancel goes at once; taking back a failed send’s half-key waits for a slot', () => {
    const main = read('../src/main.ts')
    assert.match(main, /const outcome = cancelOutcome\(await revoke\(link\), /)
    assert.match(main, /void revoke\(s, \{ when: 'slot' \}\)/)
    assert.equal((main.match(/\brevoke\(/g) ?? []).length, 2, 'no other revoke to classify')
  })

  test('a switch in Settings, under Extra privacy, apart from Cover messages', () => {
    const page = read('../index.html')
    const extra = page.slice(page.indexOf('<h3 class="setting-group">Extra privacy</h3>'), page.indexOf('<h3 class="setting-group">This browser</h3>'))
    assert.match(extra, /<strong>Cover requests<\/strong>[\s\S]*?<input type="checkbox" class="switch" id="s-kcover" \/>/)
    // They look like real ones (kept short for phones).
    assert.match(extra, /Empty requests to slynk\.me’s key server that look like real ones, so nobody watching can tell which visitors sent or opened a link\./)
    assert.match(extra, /id="s-cover"/)
  })

  test('only the app sends them: the About page has nothing to cover', () => {
    const cover = fileURLToPath(new URL('../src/burnCover.ts', import.meta.url))
    const burn = fileURLToPath(new URL('../src/burn.ts', import.meta.url))
    const mods = reach('../src/about.ts')
    assert.ok(!mods.has(cover) && !mods.has(burn), 'the About page never talks to the key server')
  })
})
