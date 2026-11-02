// The extra encryption layer: key derivation (checked against node:crypto, so the
// format is pinned independently of WebCrypto), sealing, tamper detection, padding.
import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { describe, test } from 'node:test'
import { MAX_PAYLOAD } from '../src/payload.ts'
import {
  MAX_PAYLOAD_SEALED,
  REQUEST_BYTES,
  SEAL_OVERHEAD,
  SealError,
  deriveId,
  makeShare,
  newNonce,
  open,
  requestBody,
  seal,
  wipe,
} from '../src/burn.ts'

const bytes = (n: number) => new Uint8Array(randomBytes(n))
const hkdf = (ikm: Uint8Array, info: string, n: number) => Buffer.from(hkdfSync('sha256', ikm, 'slynk/v2/salt', info, n))
const keyOf = (L: Uint8Array, S: Uint8Array) => hkdf(Buffer.concat([L, S]), 'slynk/v2/key', 32)

describe('burn crypto', () => {
  test('sizes', () => {
    assert.equal(SEAL_OVERHEAD, 28)
    assert.equal(MAX_PAYLOAD_SEALED, MAX_PAYLOAD - 28)
  })

  test('makeShare: fresh random halves, ID derived from L', async () => {
    const a = await makeShare()
    const b = await makeShare()
    assert.equal(a.L.length, 32)
    assert.equal(a.S.length, 32)
    assert.equal(a.id.length, 16)
    assert.equal(a.cancelToken.length, 16)
    assert.notDeepEqual(a.L, b.L)
    assert.notDeepEqual(a.S, b.S)
    assert.deepEqual(a.id, new Uint8Array(hkdf(a.L, 'slynk/v2/id', 16)))
    assert.deepEqual(await deriveId(a.L), a.id)
    assert.equal(newNonce().length, 16)
  })

  test('ID test vector', async () => {
    const id = await deriveId(new Uint8Array(32).fill(1))
    assert.equal(Buffer.from(id).toString('hex'), hkdf(new Uint8Array(32).fill(1), 'slynk/v2/id', 16).toString('hex'))
    assert.equal(Buffer.from(id).toString('hex'), '89a43b3b9505823c13d6fad4cac8d177')
  })

  test('seal: nonce || AES-256-GCM(HKDF(L||S)) with the versioned AAD', async () => {
    const { L, S } = await makeShare()
    const msg = bytes(1000)
    const sealed = await seal(msg, L, S)
    assert.equal(sealed.length, msg.length + SEAL_OVERHEAD)
    // Decrypt independently with node:crypto.
    const d = createDecipheriv('aes-256-gcm', keyOf(L, S), sealed.subarray(0, 12))
    d.setAAD(Buffer.from('slynk/v2/aad'))
    d.setAuthTag(sealed.subarray(sealed.length - 16))
    const plain = Buffer.concat([d.update(sealed.subarray(12, sealed.length - 16)), d.final()])
    assert.deepEqual(new Uint8Array(plain), msg)
    // And the other way: something node:crypto sealed opens.
    const iv = bytes(12)
    const c = createCipheriv('aes-256-gcm', keyOf(L, S), iv)
    c.setAAD(Buffer.from('slynk/v2/aad'))
    const ct = Buffer.concat([c.update(msg), c.final(), c.getAuthTag()])
    assert.deepEqual(await open(new Uint8Array(Buffer.concat([iv, ct])), L, S), msg)
  })

  test('round trip, from empty to the largest allowed', async () => {
    const { L, S } = await makeShare()
    for (const n of [0, 1, 4096, MAX_PAYLOAD_SEALED]) {
      const msg = bytes(n)
      assert.deepEqual(await open(await seal(msg, L, S), L, S), msg, `${n} bytes`)
    }
    await assert.rejects(seal(bytes(MAX_PAYLOAD_SEALED + 1), L, S), RangeError)
  })

  test('every seal uses a fresh nonce', async () => {
    const { L, S } = await makeShare()
    const msg = bytes(64)
    const a = await seal(msg, L, S)
    const b = await seal(msg, L, S)
    assert.notDeepEqual(a.subarray(0, 12), b.subarray(0, 12))
    assert.notDeepEqual(a, b)
  })

  test('tampering, a wrong half or truncation is detected', async () => {
    const { L, S } = await makeShare()
    const sealed = await seal(bytes(200), L, S)
    for (const i of [0, 11, 12, 100, sealed.length - 17, sealed.length - 16, sealed.length - 1]) {
      const t = sealed.slice()
      t[i] ^= 1
      await assert.rejects(open(t, L, S), SealError, `bit flipped at ${i}`)
    }
    const otherL = L.slice()
    otherL[0] ^= 1
    const otherS = S.slice()
    otherS[31] ^= 0x80
    await assert.rejects(open(sealed, otherL, S), SealError)
    await assert.rejects(open(sealed, L, otherS), SealError)
    await assert.rejects(open(sealed, S, L), SealError, 'halves swapped')
    await assert.rejects(open(sealed.subarray(0, sealed.length - 1), L, S), SealError)
    await assert.rejects(open(sealed.subarray(0, 27), L, S), SealError)
    await assert.rejects(open(new Uint8Array(0), L, S), SealError)
  })

  test('halves of the wrong size are refused', async () => {
    const { L, S } = await makeShare()
    await assert.rejects(seal(bytes(10), L.subarray(1), S), TypeError)
    await assert.rejects(seal(bytes(10), L, new Uint8Array(33)), TypeError)
    await assert.rejects(deriveId(new Uint8Array(16)), TypeError)
  })

  test('wipe zeroes key material', async () => {
    const share = await makeShare()
    wipe(share.L, share.S, share.cancelToken)
    assert.ok([...share.L, ...share.S, ...share.cancelToken].every((b) => b === 0))
  })

  test('every request body is exactly REQUEST_BYTES of JSON, padded with dots', () => {
    const id = Buffer.from(bytes(16)).toString('base64url')
    const bodies = [
      requestBody('put', { id, s: Buffer.from(bytes(32)).toString('base64url'), r: id, m: 2, t: 500, w: Buffer.from(bytes(8)).toString('base64url') }),
      requestBody('claim', { id, c: id }),
      requestBody('get', { id }),
      requestBody('done', { id, c: id }),
      requestBody('revoke', { id, r: id }),
    ]
    for (const b of bodies) {
      assert.equal(Buffer.byteLength(b), REQUEST_BYTES)
      const j = JSON.parse(b)
      assert.equal(j.v, 1)
      assert.match(j.p, /^\.+$/)
    }
    assert.throws(() => requestBody('get', { id: 'x'.repeat(300) }), RangeError)
  })
})
