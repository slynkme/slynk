// burn.ts end to end against the Go key server (core/cmd/keyserver) run with
// -dev: the links as a sender and a recipient use them, a clean restart (the
// shares saved and read back), a crash (lost, and the opener told so), and
// the answers' shape. The protocol's details are tested in Go
// (core/keyserver), and the page's side in the burn-*.test.ts files.
import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { after, before, describe, test } from 'node:test'
import { LINK_LENGTH, linkToFragment } from '../src/payload.ts'
import { buildLinkV2, parseLinkFragment, type LinkMode, type LinkV2 } from '../src/linkv2.ts'
import { RESPONSE_BYTES, coverHold, newNonce, protect, requestBody, revoke, unlock, type NetOptions } from '../src/burn.ts'
import { unlockProblem } from '../src/ui/linkText.ts'
import * as copy from '../src/burnCopy.ts'
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
  const parsed = parseLinkFragment(linkToFragment(buildLinkV2(fakeV1(), mode, ttl, r.share.L)))
  return { share: r.share, sealed: r.sealed, link: (parsed as { link: LinkV2 }).link }
}

describe('burn client against the key server', { skip }, () => {
  let srv: KeyServer
  let net: NetOptions
  before(async () => {
    srv = await startKeyServer({ oneTimeOnly: false, allowOrigin: 'https://slynk.me' })
    net = { endpoint: srv.endpoint, attempts: 1, timeoutMs: 5000 }
  })
  after(() => srv.stop())

  test('one-time link: opens once, then used or cancelled for everyone', async () => {
    const envelope = new Uint8Array(randomBytes(5000))
    const { link, sealed } = await send(net, envelope, 'one-time', 24)
    const mine = newNonce()
    const first = await unlock(link, sealed, mine, net)
    assert.ok(first.ok)
    assert.deepEqual(first.envelope, envelope)
    assert.equal(await first.deleted, true, 'the key server confirmed it deleted S')
    for (const nonce of [mine, newNonce()]) {
      assert.deepEqual(await unlock(link, sealed, nonce, net), { ok: false, reason: 'used-or-cancelled' })
    }
  })

  test('expiring link (a copy of Slynk without the one-time rule): opens again and again until cancelled', async () => {
    const envelope = new Uint8Array(randomBytes(300))
    const { link, sealed, share } = await send(net, envelope, 'expiring', 24)
    for (let i = 0; i < 2; i++) {
      const r = await unlock(link, sealed, undefined, net)
      assert.ok(r.ok)
      assert.deepEqual(r.envelope, envelope)
    }
    assert.deepEqual(await revoke(share, net), { ok: true })
    assert.deepEqual(await unlock(link, sealed, undefined, net), { ok: false, reason: 'used-or-cancelled' })
  })

  test('cancel, then open: used or cancelled', async () => {
    const { link, sealed, share } = await send(net, new Uint8Array([1, 2, 3]), 'one-time', 1)
    assert.deepEqual(await revoke(share, net), { ok: true })
    assert.deepEqual(await unlock(link, sealed, newNonce(), net), { ok: false, reason: 'used-or-cancelled' })
  })

  test('a clean restart keeps a waiting link, and destroys the shutdown file before answering', async () => {
    const envelope = new Uint8Array(randomBytes(100))
    const { link, sealed } = await send(net, envelope, 'one-time', 24)
    await srv.restart()
    assert.deepEqual(readdirSync(srv.state), [], 'nothing left on disk once it is running again')
    const r = await unlock(link, sealed, newNonce(), net)
    assert.ok(r.ok, 'the link still opens')
    assert.deepEqual(r.envelope, envelope)
  })

  test('a crash loses waiting links, and their openers are told they may have been lost', async () => {
    const { link, sealed } = await send(net, new Uint8Array([4, 5, 6]), 'one-time', 24)
    await srv.crash()
    const r = await unlock(link, sealed, newNonce(), net)
    assert.deepEqual(r, { ok: false, reason: 'lost' })
    const problem = unlockProblem('lost', 'one-time', new Date(Date.now() + 3600_000))
    assert.deepEqual(problem, { title: copy.LOST_TITLE, message: copy.LOST, retry: false })
    // A clean restart afterwards keeps saying so, as a link from before the crash may still be opened.
    await srv.restart()
    assert.deepEqual(await unlock(link, sealed, newNonce(), net), { ok: false, reason: 'lost' })
    assert.equal(existsSync(srv.state), true)
  })

  test('a cover request is answered "gone", as text/plain, in the fixed format', async () => {
    await coverHold(net) // resolves once answered, whatever the answer
    const res = await fetch(srv.endpoint, { method: 'POST', body: requestBody('hold', { id: rnd(16), c: rnd(16) }) })
    const text = await res.text()
    assert.equal(res.status, 200)
    assert.equal(Buffer.byteLength(text), RESPONSE_BYTES)
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://slynk.me', 'so the page on slynk.me can read it')
    assert.equal(res.headers.get('content-type'), 'application/json')
    const j = JSON.parse(text)
    assert.deepEqual(Object.keys(j), ['v', 'st', 's', 'g', 'd', 't', 'r', 'p'])
    assert.equal(j.st, 'gone')
  })
})

const rnd = (n: number) => randomBytes(n).toString('base64url')
