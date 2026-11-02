// burn.ts end to end against the key server (core/cmd/keyserver, run with -dev): the three link kinds as a
// sender and a recipient would use them, plus how answers map to results.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { after, before, describe, test } from 'node:test'
import { LINK_LENGTH, MAX_PAYLOAD, linkToFragment } from '../src/payload.ts'
import { buildLinkV2, linkKindFor, parseLinkFragment, type LinkMode, type LinkV2 } from '../src/linkv2.ts'
import {
  RESPONSE_BYTES,
  claim,
  get,
  makeShare,
  newNonce,
  protect,
  put,
  revoke,
  unlock,
  type NetOptions,
} from '../src/burn.ts'
import { hasGo, startKeyServer, type KeyServer } from './helpers/keyserver.ts'

const skip = hasGo() ? false : 'needs the Go toolchain'

function fakeV1(): Uint8Array {
  const v1 = new Uint8Array(randomBytes(LINK_LENGTH))
  v1[0] = 1
  new DataView(v1.buffer).setBigUint64(66, BigInt(Date.now()) * 1_000_000n)
  return v1
}

/** What a sender does: protect, "upload", build the link. Returns what the recipient gets. */
async function send(net: NetOptions, envelope: Uint8Array, mode: LinkMode, ttl: number) {
  const r = await protect(envelope, mode, ttl, net)
  assert.ok(r.ok, `protect: ${!r.ok && r.reason}`)
  assert.ok(r.share.S.every((b) => b === 0), 'the sender wipes S once it has sealed')
  const fragment = linkToFragment(buildLinkV2(fakeV1(), mode, ttl, r.share.L))
  const parsed = parseLinkFragment(fragment)
  assert.equal(parsed.kind, mode)
  return { share: r.share, sealed: r.sealed, link: (parsed as { link: LinkV2 }).link }
}

describe('burn client against the key server', { skip }, () => {
  let srv: KeyServer
  let net: NetOptions
  before(async () => {
    // Expiring links too, as a copy of Slynk without slynk.me's rule would make them.
    srv = await startKeyServer({ oneTimeOnly: false })
    net = { endpoint: srv.endpoint, attempts: 1, timeoutMs: 5000 }
  })
  after(() => srv.stop())

  test('ordinary link: unchanged v1, nothing on slynk.me', () => {
    assert.equal(linkKindFor(500, false), 'ordinary')
    const v1 = fakeV1()
    const parsed = parseLinkFragment(linkToFragment(v1))
    assert.equal(parsed.kind, 'ordinary')
    assert.deepEqual(parsed.v1, v1)
  })

  test('one-time link: opens once, then used or cancelled for everyone', async () => {
    const envelope = new Uint8Array(randomBytes(5000))
    const { link, sealed } = await send(net, envelope, 'one-time', 24)
    const mine = newNonce()
    const first = await unlock(link, sealed, mine, net)
    assert.ok(first.ok)
    assert.deepEqual(first.envelope, envelope)
    assert.equal(await first.deleted, true, 'slynk.me confirmed it deleted S')
    for (const nonce of [mine, newNonce()]) {
      const again = await unlock(link, sealed, nonce, net)
      assert.deepEqual(again, { ok: false, reason: 'used-or-cancelled' })
    }
    await assert.rejects(unlock(link, sealed, undefined, net), TypeError, 'one-time links need a nonce')
  })

  test('one-time link: a lost claim answer can be retried with the same nonce only', async () => {
    const { link, sealed, share } = await send(net, new Uint8Array([1, 2, 3]), 'one-time', 1)
    const nonce = newNonce()
    const a = await claim(share.id, nonce, net) // pretend this answer never arrived
    const b = await claim(share.id, nonce, net)
    assert.ok(a.ok && b.ok)
    assert.deepEqual(a.S, b.S)
    assert.deepEqual(await claim(share.id, newNonce(), net), { ok: false, reason: 'used-or-cancelled' })
    const opened = await unlock(link, sealed, nonce, net)
    assert.ok(opened.ok)
    assert.deepEqual(opened.envelope, new Uint8Array([1, 2, 3]))
  })

  test('expiring link: opens any number of times until cancelled', async () => {
    const envelope = new TextEncoder().encode('hello')
    const { link, sealed, share } = await send(net, envelope, 'expiring', 168)
    for (let i = 0; i < 3; i++) {
      const r = await unlock(link, sealed, undefined, net)
      assert.ok(r.ok)
      assert.deepEqual(r.envelope, envelope)
    }
    assert.deepEqual(await revoke(share, net), { ok: true })
    assert.deepEqual(await revoke(share, net), { ok: true }, 'a repeated cancel is fine')
    assert.deepEqual(await unlock(link, sealed, undefined, net), { ok: false, reason: 'used-or-cancelled' })
  })

  test('cancel a one-time link before it is opened; too late after', async () => {
    const one = await send(net, new Uint8Array(10), 'one-time', 24)
    assert.deepEqual(await revoke(one.share, net), { ok: true })
    assert.deepEqual(await unlock(one.link, one.sealed, newNonce(), net), { ok: false, reason: 'used-or-cancelled' })
    const two = await send(net, new Uint8Array(10), 'one-time', 24)
    assert.ok((await unlock(two.link, two.sealed, newNonce(), net)).ok)
    assert.deepEqual(await revoke(two.share, net), { ok: false, reason: 'used-or-cancelled' })
  })

  test('only the sender’s cancel token cancels', async () => {
    const { link, sealed, share } = await send(net, new Uint8Array(10), 'expiring', 1)
    assert.deepEqual(await revoke({ id: share.id, cancelToken: newNonce() }, net), { ok: false, reason: 'used-or-cancelled' })
    assert.ok((await unlock(link, sealed, undefined, net)).ok)
  })

  test('a damaged item is reported as damaged', async () => {
    const { link, sealed } = await send(net, new Uint8Array(100), 'expiring', 24)
    sealed[50] ^= 1
    assert.deepEqual(await unlock(link, sealed, undefined, net), { ok: false, reason: 'damaged' })
  })

  test('a taken ID: exists', async () => {
    const share = await makeShare()
    assert.deepEqual(await put(share, 'one-time', 1, net), { ok: true })
    assert.deepEqual(await put(share, 'one-time', 1, net), { ok: true }, 'identical retry')
    assert.deepEqual(await put({ ...share, S: new Uint8Array(randomBytes(32)) }, 'one-time', 1, net), { ok: false, reason: 'exists' })
  })

  test('refuses bad arguments before sending anything', async () => {
    const share = await makeShare()
    await assert.rejects(put(share, 'one-time', 0, net), RangeError)
    await assert.rejects(put(share, 'one-time', 501, net), RangeError)
    await assert.rejects(put(share, 'forever' as LinkMode, 24, net), TypeError)
    await assert.rejects(claim(new Uint8Array(15), newNonce(), net), TypeError)
    await assert.rejects(protect(new Uint8Array(MAX_PAYLOAD), 'one-time', 24, net), RangeError)
  })
})

describe('burn client: unexpected answers', () => {
  let server: Server
  let base = ''
  let reply: { status: number; body: string } = { status: 200, body: '' }
  before(async () => {
    server = createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        res.writeHead(reply.status, { 'Content-Type': 'application/json' })
        res.end(reply.body)
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const addr = server.address()
    base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/api/k`
  })
  after(() => new Promise<void>((r) => server.close(() => r())))

  const answer = (st: string, s = Buffer.from(randomBytes(32)).toString('base64url')) => {
    const head = `{"v":1,"st":"${st}","s":"${s}","p":"`
    return head + '.'.repeat(RESPONSE_BYTES - head.length - 2) + '"}'
  }
  const id = () => new Uint8Array(randomBytes(16))

  test('maps each outcome to a result', async () => {
    const net = { endpoint: base, attempts: 1 }
    // The key server answers every POST with 200 and puts the outcome in "st" only.
    const cases: Array<[string, string]> = [
      ['gone', 'used-or-cancelled'],
      ['expired', 'expired'],
      ['exists', 'exists'],
      ['held', 'held'],
      ['slow', 'busy'],
      ['full', 'busy'],
      ['down', 'unreachable'],
      ['bad', 'malformed'],
      ['method', 'malformed'],
      ['teapot', 'unreachable'],
    ]
    for (const [st, reason] of cases) {
      reply = { status: 200, body: answer(st) }
      assert.deepEqual(await get(id(), net), { ok: false, reason }, st)
    }
    // "gone" from a key server that restarted without its shares lately: the link may have been lost.
    const head = `{"v":1,"st":"gone","s":"${Buffer.from(randomBytes(32)).toString('base64url')}","r":1,"p":"`
    reply = { status: 200, body: head + '.'.repeat(RESPONSE_BYTES - head.length - 2) + '"}' }
    assert.deepEqual(await get(id(), net), { ok: false, reason: 'lost' })
  })

  test('anything that isn’t a well-formed key server answer counts as unreachable', async () => {
    const net = { endpoint: base, attempts: 1 }
    const bad: Array<[number, string]> = [
      [200, ''],
      [403, '<!doctype html><title>Forbidden</title>'], // something else in the way
      [200, answer('ok') + ' '],
      [200, answer('ok').replace('"v":1', '"v":2')],
      [410, answer('ok')], // any status but 200 isn't the key server's
      [410, answer('gone')],
      [503, answer('down')], // the host's own error, say
      [200, answer('ok', 'A'.repeat(42) + 'B')], // a non-canonical share
      [200, answer('ok', Buffer.from(randomBytes(31)).toString('base64url') + 'AA')], // wrong length
      [200, 'x'.repeat(RESPONSE_BYTES)],
    ]
    for (const [status, body] of bad) {
      reply = { status, body }
      assert.deepEqual(await claim(id(), newNonce(), net), { ok: false, reason: 'unreachable' }, body.slice(0, 40))
    }
  })

  test('no server at all: unreachable, after retrying', async () => {
    const closed = { endpoint: 'http://127.0.0.1:9/api/k', attempts: 2, timeoutMs: 2000 }
    const started = Date.now()
    assert.deepEqual(await put(await makeShare(), 'one-time', 1, closed), { ok: false, reason: 'unreachable' })
    assert.ok(Date.now() - started >= 1000, 'waited before retrying')
    assert.deepEqual(await claim(id(), newNonce(), { ...closed, attempts: 1 }), { ok: false, reason: 'unreachable' })
  })
})
