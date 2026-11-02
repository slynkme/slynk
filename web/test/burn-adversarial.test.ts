// Adversarial tests for one-time and expiring links: races between operations,
// a link holder probing for state, crash leftovers, broken stores, sloppy
// input, and the client refusing what it shouldn't send. The key server's
// side (races, probing, crashes, sloppy input) is tested in Go (core/keyserver).
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { LINK_LENGTH } from '../src/payload.ts'
import { LinkError, buildLinkV2, parseLinkFragment, parseLinkV2, type LinkV2 } from '../src/linkv2.ts'
import { REQUEST_BYTES, RESPONSE_BYTES, makeShare, newNonce, protect, put as putShare, requestBody, seal, unlock } from '../src/burn.ts'
import { hasGo, startKeyServer, type KeyServer } from './helpers/keyserver.ts'

const skip = hasGo() ? false : 'needs the Go toolchain'
const STATUSES = new Set(['ok', 'bad', 'work', 'method', 'exists', 'gone', 'expired', 'slow', 'full', 'down'])

const rnd = (n: number) => randomBytes(n).toString('base64url')
const unb64 = (s: string) => Buffer.from(s, 'base64url')
const now = () => Math.floor(Date.now() / 1000)

describe('crafted links', () => {
  test('a huge fragment is refused before decoding', () => {
    // Decoding would fail on the "!" with code "encoding"; the length check comes first.
    for (const n of [1025, 4_000_000]) {
      assert.throws(
        () => parseLinkFragment('#' + 'A'.repeat(n) + '!'),
        (e: unknown) => e instanceof LinkError && e.code === 'length',
      )
    }
  })
})

// --- The client -------------------------------------------------------------------------

function v1At(sentMs: number): Uint8Array {
  const v1 = new Uint8Array(randomBytes(LINK_LENGTH))
  v1[0] = 1
  new DataView(v1.buffer).setBigUint64(66, BigInt(sentMs) * 1_000_000n)
  return v1
}

describe('burn client: refusing early', () => {
  let server: Server
  let endpoint = ''
  let requests: string[] = []
  let handler: (op: string, body: Record<string, unknown>) => { status: number; st: string; s?: string } = () => ({
    status: 200,
    st: 'down',
  })
  before(async () => {
    server = createServer((req, res) => {
      let raw = ''
      req.on('data', (d: Buffer) => (raw += d))
      req.on('end', () => {
        const body = JSON.parse(raw) as Record<string, unknown>
        requests.push(String(body.op))
        const a = handler(String(body.op), body)
        const head = `{"v":1,"st":"${a.st}","s":"${a.s ?? rnd(32)}","p":"`
        res.writeHead(a.status, { 'Content-Type': 'application/json' })
        res.end(head + '.'.repeat(RESPONSE_BYTES - head.length - 2) + '"}')
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const addr = server.address()
    endpoint = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/api/k`
  })
  after(() => new Promise<void>((r) => server.close(() => r())))

  async function sealedLink(mode: 'one-time' | 'expiring', ttl: number, sentMs: number) {
    const share = await makeShare()
    const sealed = await seal(new TextEncoder().encode('secret'), share.L, share.S)
    const link: LinkV2 = parseLinkV2(buildLinkV2(v1At(sentMs), mode, ttl, share.L))
    return { share, sealed, link }
  }

  test('a link past its own expiry is refused without asking slynk.me, so nothing is used up', async () => {
    requests = []
    handler = () => ({ status: 200, st: 'ok', s: rnd(32) })
    const net = { endpoint, attempts: 1 }
    for (const mode of ['one-time', 'expiring'] as const) {
      const { sealed, link } = await sealedLink(mode, 1, Date.now() - 3_600_000 - 1000)
      assert.deepEqual(await unlock(link, sealed, newNonce(), net), { ok: false, reason: 'expired' })
    }
    assert.deepEqual(requests, [], 'no claim or get was sent')
  })

  test('a claim sent just before the expiry can still be retried after it, with the same nonce only', async () => {
    const { share, sealed, link } = await sealedLink('one-time', 1, Date.now() - 3_600_000 + 1500)
    const S = Buffer.from(share.S).toString('base64url')
    let claims = 0
    requests = []
    // The first claim gets through but its answer is lost.
    handler = (op) => (op === 'claim' && ++claims > 1 ? { status: 200, st: 'ok', s: S } : op === 'done' ? { status: 200, st: 'ok' } : { status: 200, st: 'down' })
    const nonce = newNonce()
    assert.deepEqual(await unlock(link, sealed, nonce, { endpoint, attempts: 1 }), { ok: false, reason: 'unreachable' })
    await new Promise((r) => setTimeout(r, 2000)) // now past the link's expiry
    assert.deepEqual(await unlock(link, sealed, newNonce(), { endpoint, attempts: 1 }), { ok: false, reason: 'expired' })
    assert.deepEqual(requests, ['claim'], 'a new nonce asks nothing once expired')
    const r = await unlock(link, sealed, nonce, { endpoint, attempts: 1 })
    assert.ok(r.ok, 'the retry with the same nonce goes ahead')
    assert.deepEqual(r.envelope, new TextEncoder().encode('secret'))
    await r.deleted // its done, sent after unlock returns
  })

  test('an impossibly short item is refused before the claim, so the link isn’t used up', async () => {
    requests = []
    const { link } = await sealedLink('one-time', 24, Date.now())
    assert.deepEqual(await unlock(link, new Uint8Array(27), newNonce(), { endpoint, attempts: 1 }), { ok: false, reason: 'damaged' })
    assert.deepEqual(requests, [])
  })

  test('when done’s first answer was lost, its "gone" on retry still means S was deleted', async () => {
    const { share, sealed, link } = await sealedLink('one-time', 24, Date.now())
    const S = Buffer.from(share.S).toString('base64url')
    let dones = 0
    requests = []
    handler = (op) => {
      if (op === 'claim') return { status: 200, st: 'ok', s: S }
      dones++
      // The first done got through but its answer was lost; the retry finds nothing left.
      return dones === 1 ? { status: 200, st: 'down' } : { status: 200, st: 'gone' }
    }
    const r = await unlock(link, sealed, newNonce(), { endpoint, attempts: 2 })
    assert.ok(r.ok)
    assert.equal(await r.deleted, true)
    assert.deepEqual(requests, ['claim', 'done', 'done'])
  })

  test('a full store, or too many links at once: busy, without a retry', async () => {
    const ids: string[] = []
    handler = (op, body) => (ids.push(String(body.id)), { status: 200, st: 'full' })
    assert.deepEqual(await protect(new Uint8Array(10), 'one-time', 24, { endpoint, attempts: 1 }), { ok: false, reason: 'busy' })
    assert.equal(ids.length, 1, 'the key server has one store, so another ID would be refused too')
    ids.length = 0
    handler = (op, body) => (ids.push(String(body.id)), { status: 200, st: 'slow' })
    assert.deepEqual(await protect(new Uint8Array(10), 'one-time', 24, { endpoint, attempts: 1 }), { ok: false, reason: 'busy' })
    assert.equal(ids.length, 1, 'too many links at once: no retry')
  })

  test('done unreachable: opened, but deletion not confirmed', async () => {
    const { share, sealed, link } = await sealedLink('one-time', 24, Date.now())
    const S = Buffer.from(share.S).toString('base64url')
    handler = (op) => (op === 'claim' ? { status: 200, st: 'ok', s: S } : { status: 200, st: 'down' })
    const r = await unlock(link, sealed, newNonce(), { endpoint, attempts: 1 })
    assert.ok(r.ok)
    assert.equal(await r.deleted, false)
  })
})

describe('burn client against the key server: crafted links and expiry', { skip }, () => {
  let srv: KeyServer
  before(async () => {
    srv = await startKeyServer({ oneTimeOnly: false })
  })
  after(() => srv.stop())

  test('flipping a link’s mode byte gets nothing and uses nothing up', async () => {
    const net = { endpoint: srv.endpoint, attempts: 1 }
    // The mode byte isn't authenticated, but slynk.me files each share under the
    // sender's mode: get won't hand out a one-time share, and claim won't burn an
    // expiring one, so whoever forwards a link can't change what kind it is.
    const one = await protect(new Uint8Array(10), 'one-time', 24, net)
    const exp = await protect(new Uint8Array(10), 'expiring', 24, net)
    assert.ok(one.ok && exp.ok)
    const oneLink = buildLinkV2(v1At(Date.now()), 'one-time', 24, one.share.L)
    const expLink = buildLinkV2(v1At(Date.now()), 'expiring', 24, exp.share.L)
    const flip = (b: Uint8Array) => {
      const c = b.slice()
      c[1] = 3 - c[1]
      return parseLinkV2(c)
    }
    assert.deepEqual(await unlock(flip(oneLink), one.sealed, undefined, net), { ok: false, reason: 'used-or-cancelled' })
    assert.deepEqual(await unlock(flip(expLink), exp.sealed, newNonce(), net), { ok: false, reason: 'used-or-cancelled' })
    assert.ok((await unlock(parseLinkV2(oneLink), one.sealed, newNonce(), net)).ok, 'the one-time link still opens')
    for (let i = 0; i < 2; i++) assert.ok((await unlock(parseLinkV2(expLink), exp.sealed, undefined, net)).ok, 'the expiring link still opens')
  })

  test('an expired one-time link stays unclaimed on slynk.me (the client refuses first)', async () => {
    const net = { endpoint: srv.endpoint, attempts: 1 }
    const r = await protect(new Uint8Array(10), 'one-time', 1, net)
    assert.ok(r.ok)
    const link = parseLinkV2(buildLinkV2(v1At(Date.now() - 2 * 3_600_000), 'one-time', 1, r.share.L))
    assert.deepEqual(await unlock(link, r.sealed, newNonce(), net), { ok: false, reason: 'expired' })
    // Still waiting, not claimed: the same share opens through a link that hasn't expired.
    const fresh = parseLinkV2(buildLinkV2(v1At(Date.now()), 'one-time', 1, r.share.L))
    assert.ok((await unlock(fresh, r.sealed, newNonce(), net)).ok, 'nothing was used up')
  })

  test('put arguments are checked before anything is sent', async () => {
    const share = await makeShare()
    await assert.rejects(putShare(share, 'one-time', 1.5, { endpoint: srv.endpoint }), RangeError)
  })
})
