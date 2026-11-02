// Link format v2: round trips, sizes, times, and refusing damaged links.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { describe, test } from 'node:test'
import { LINK_LENGTH, linkToFragment } from '../src/payload.ts'
import {
  EXPIRY_HOURS,
  LINK_V2_LENGTH,
  LinkError,
  buildLinkV2,
  fromBase64url,
  linkKindFor,
  linkV2Times,
  linkV2ToV1,
  parseLinkFragment,
  parseLinkV2,
  toBase64url,
  type LinkMode,
} from '../src/linkv2.ts'

const SENT = new Date('2026-10-14T12:00:00Z')

/** A stand-in v1 link: version 1, random fields, a real sent time at bytes 66-73. */
function fakeV1(sent = SENT): Uint8Array {
  const v1 = new Uint8Array(randomBytes(LINK_LENGTH))
  v1[0] = 1
  new DataView(v1.buffer).setBigUint64(66, BigInt(sent.getTime()) * 1_000_000n)
  return v1
}
const secret = () => new Uint8Array(randomBytes(32))

function code(fn: () => unknown): string {
  try {
    fn()
  } catch (e) {
    assert.ok(e instanceof LinkError, `expected a LinkError, got ${e}`)
    assert.ok(e.message.length > 10, 'with a message fit to show')
    return e.code
  }
  assert.fail('expected it to throw')
}

describe('link v2', () => {
  test('layout: 183 bytes, 244 characters after the #', () => {
    assert.equal(LINK_V2_LENGTH, 183)
    const link = buildLinkV2(fakeV1(), 'one-time', 24, secret())
    assert.equal(link.length, 183)
    assert.equal(linkToFragment(link).length, 244)
    assert.equal(`https://slynk.me/#${linkToFragment(link)}`.length, 262)
    assert.equal(linkToFragment(fakeV1()).length, 198, 'ordinary links are unchanged')
    assert.equal(link[0], 2)
    assert.equal(link[1], 2)
    assert.equal((link[2] << 8) | link[3], 24)
  })

  test('round trip for every mode and expiry choice', () => {
    for (const mode of ['expiring', 'one-time'] as LinkMode[]) {
      for (const ttl of [...EXPIRY_HOURS, 2, 499]) {
        const v1 = fakeV1()
        const L = secret()
        const bytes = buildLinkV2(v1, mode, ttl, L)
        const link = parseLinkV2(bytes)
        assert.equal(link.mode, mode)
        assert.equal(link.ttlHours, ttl)
        assert.deepEqual(link.v1, v1)
        assert.deepEqual(link.secret, L)
        assert.deepEqual(linkV2ToV1(bytes), v1, 'v2 -> v1 for core.download')
        assert.deepEqual(linkV2ToV1(link), v1)
        // Through the fragment, the way a recipient's page reads it.
        const parsed = parseLinkFragment('#' + linkToFragment(bytes))
        assert.equal(parsed.kind, mode)
        assert.deepEqual(parsed.v1, v1)
        assert.equal(parsed.sent.getTime(), SENT.getTime())
        assert.equal(parsed.expires.getTime(), SENT.getTime() + ttl * 3_600_000)
      }
    }
  })

  test('the parsed link is a copy', () => {
    const bytes = buildLinkV2(fakeV1(), 'expiring', 1, secret())
    const link = parseLinkV2(bytes)
    bytes.fill(0xaa, 4)
    assert.notEqual(link.secret[0], 0xaa)
    assert.equal(link.v1[0], 1)
  })

  test('times: expiry is sent + ttl', () => {
    const link = parseLinkV2(buildLinkV2(fakeV1(), 'one-time', 168, secret()))
    const { sent, expires } = linkV2Times(link)
    assert.equal(sent.toISOString(), '2026-10-14T12:00:00.000Z')
    assert.equal(expires.toISOString(), '2026-10-21T12:00:00.000Z')
  })

  test('ordinary links still parse, lasting up to 500 hours', () => {
    const v1 = fakeV1()
    const parsed = parseLinkFragment(linkToFragment(v1))
    assert.equal(parsed.kind, 'ordinary')
    assert.deepEqual(parsed.v1, v1)
    assert.equal(parsed.expires.getTime() - parsed.sent.getTime(), 500 * 3_600_000)
  })

  test('which kind the sender’s choices make', () => {
    assert.equal(linkKindFor(500, false), 'ordinary')
    for (const h of [1, 24, 168]) assert.equal(linkKindFor(h, false), 'expiring')
    for (const h of EXPIRY_HOURS) assert.equal(linkKindFor(h, true), 'one-time')
  })

  test('refuses damaged v2 links', () => {
    const good = buildLinkV2(fakeV1(), 'one-time', 24, secret())
    const edit = (f: (b: Uint8Array) => void) => {
      const b = good.slice()
      f(b)
      return b
    }
    assert.equal(code(() => parseLinkV2(good.subarray(0, 182))), 'length')
    assert.equal(code(() => parseLinkV2(new Uint8Array(184))), 'length')
    assert.equal(code(() => parseLinkV2(new Uint8Array(0))), 'length')
    assert.equal(code(() => parseLinkV2(edit((b) => (b[0] = 3)))), 'version')
    assert.equal(code(() => parseLinkV2(edit((b) => (b[1] = 0)))), 'mode')
    assert.equal(code(() => parseLinkV2(edit((b) => (b[1] = 3)))), 'mode')
    assert.equal(code(() => parseLinkV2(edit((b) => ((b[2] = 0), (b[3] = 0))))), 'ttl')
    assert.equal(code(() => parseLinkV2(edit((b) => ((b[2] = 1), (b[3] = 245))))), 'ttl') // 501
    assert.equal(code(() => parseLinkV2(edit((b) => ((b[2] = 255), (b[3] = 255))))), 'ttl')
    assert.equal(code(() => parseLinkV2(edit((b) => b.fill(0, 151)))), 'secret')
    assert.equal(code(() => parseLinkV2(edit((b) => b.fill(0, 69, 77)))), 'link') // no sent time
  })

  test('refuses damaged fragments', () => {
    const frag = linkToFragment(buildLinkV2(fakeV1(), 'expiring', 24, secret()))
    assert.equal(code(() => parseLinkFragment('')), 'length')
    assert.equal(code(() => parseLinkFragment('#')), 'length')
    assert.equal(code(() => parseLinkFragment(frag.slice(0, -4))), 'length')
    assert.equal(code(() => parseLinkFragment(frag + 'A')), 'encoding') // 245 characters
    for (const bad of ['+', '/', '=', ' ', '%', '.']) {
      assert.equal(code(() => parseLinkFragment(bad + frag.slice(1))), 'encoding', `character ${bad}`)
    }
    // A v1-length link with an unknown version byte.
    const v1 = fakeV1()
    v1[0] = 9
    assert.equal(code(() => parseLinkFragment(linkToFragment(v1))), 'version')
    // A v1-length link claiming to be v2.
    v1[0] = 2
    assert.equal(code(() => parseLinkFragment(linkToFragment(v1))), 'length')
  })

  test('build refuses bad input', () => {
    assert.equal(code(() => buildLinkV2(new Uint8Array(147), 'one-time', 24, secret())), 'link')
    const v2Inner = fakeV1()
    v2Inner[0] = 2
    assert.equal(code(() => buildLinkV2(v2Inner, 'one-time', 24, secret())), 'link')
    for (const ttl of [0, 501, 1.5, Number.NaN]) {
      assert.equal(code(() => buildLinkV2(fakeV1(), 'one-time', ttl, secret())), 'ttl', `ttl ${ttl}`)
    }
    assert.equal(code(() => buildLinkV2(fakeV1(), 'one-time', 24, new Uint8Array(32))), 'secret')
    assert.equal(code(() => buildLinkV2(fakeV1(), 'one-time', 24, new Uint8Array(31).fill(1))), 'secret')
    assert.equal(code(() => buildLinkV2(fakeV1(), 'toString' as LinkMode, 24, secret())), 'mode')
  })

  test('strict base64url', () => {
    for (let n = 0; n < 40; n++) {
      const b = new Uint8Array(randomBytes(n))
      const s = toBase64url(b)
      assert.equal(s, Buffer.from(b).toString('base64url'))
      assert.deepEqual(fromBase64url(s), b)
    }
    assert.throws(() => fromBase64url('AAAAAAAAAAAAAAAAAAAAAB')) // non-canonical last character
    assert.throws(() => fromBase64url('AAAA=')) // padding
    assert.throws(() => fromBase64url('A')) // impossible length
    assert.throws(() => fromBase64url('AA AA'))
  })
})
