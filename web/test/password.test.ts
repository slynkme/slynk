// Password links: the word list, suggested and typed passwords, the password
// layer (with a fast stand-in for Argon2id), the real Argon2id module checked
// against OpenSSL's, and the link's password flag.
import assert from 'node:assert/strict'
import { argon2Sync, createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import type { KdfParams } from '../src/kdf/index.ts'
import { LINK_V2_LENGTH, LinkError, buildLinkV2, parseLinkFragment, passwordLinkV1, toBase64url } from '../src/linkv2.ts'
import {
  KDF_V1,
  MAX_LOCKED,
  MAX_PASSWORD,
  MIN_PASSWORD,
  PASSWORD_OVERHEAD,
  PasswordError,
  lock,
  lockedSalt,
  normalizePassword,
  open,
  openWithPassword,
  passwordKey,
  passwordLength,
  passwordProblem,
  suggestPassword,
  type Derive,
} from '../src/password.ts'
import { LINK_LENGTH, MAX_PAYLOAD, linkToFragment } from '../src/payload.ts'
import { optionsSummary } from '../src/ui/linkText.ts'
import { AVOID, WORDS } from '../src/ui/words.ts'

/** A fast stand-in for Argon2id that records what it was given. */
function fakeDerive(calls: Array<{ password: string; salt: Uint8Array; params: KdfParams }> = []): Derive {
  return async (password, salt, params) => {
    calls.push({ password: new TextDecoder().decode(password), salt: salt.slice(), params })
    return new Uint8Array(createHash('sha256').update(password).update(salt).digest())
  }
}

async function lockWith(inner: Uint8Array, password: string, derive = fakeDerive()): Promise<Uint8Array> {
  return lock(inner, await passwordKey(password, undefined, derive))
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (e) {
    assert.ok(e instanceof PasswordError, `expected a PasswordError, got ${e}`)
    return e.code
  }
  assert.fail('expected it to throw')
}

describe('word list', () => {
  test('is the BIP-39 English list, complete and unchanged', () => {
    assert.equal(WORDS.length, 2048)
    assert.equal(new Set(WORDS).size, 2048)
    assert.equal(new Set(WORDS.map((w) => w.slice(0, 4))).size, 2048, 'first four letters all differ')
    for (const w of WORDS) assert.match(w, /^[a-z]{3,8}$/)
    // SHA-256 of the list joined by newlines, as go-bip39 ships it (CRC32 c1dbd296).
    const sha = createHash('sha256').update(WORDS.join('\n')).digest('hex')
    assert.equal(sha, '187db04a869dd9bc7be80d21a86497d692c0db6abd3aa8cb6be5d618ff757fae')
  })

  test('every word to avoid is on the list, leaving 1904', () => {
    for (const w of AVOID) assert.ok(WORDS.includes(w), w)
    assert.equal(WORDS.filter((w) => !AVOID.has(w)).length, 1904)
  })
})

describe('suggested passwords', () => {
  test('five words, never one to avoid', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 2000; i++) {
      const words = suggestPassword().split(' ')
      assert.equal(words.length, 5)
      for (const w of words) {
        assert.ok(WORDS.includes(w) && !AVOID.has(w), w)
        seen.add(w)
      }
    }
    // 10,000 draws from 1904 words reach nearly all of them if they're uniform.
    assert.ok(seen.size > 1850, `only ${seen.size} different words`)
    assert.equal(passwordProblem(suggestPassword()), '')
  })

  test('different every time', () => {
    const all = new Set(Array.from({ length: 200 }, () => suggestPassword()))
    assert.equal(all.size, 200)
  })
})

describe('typed passwords', () => {
  test('accents, spaces, capitals and phones’ swapped punctuation don’t matter', () => {
    assert.equal(normalizePassword('  café  au\tlait \n'), 'café au lait')
    assert.equal(normalizePassword('café'), normalizePassword('café'))
    assert.equal(normalizePassword('Spider OCEAN'), 'spider ocean')
    assert.equal(normalizePassword('don’t “panic” — ok'), 'don\'t "panic" - ok')
    assert.equal(normalizePassword('zero​width﻿⁠'), 'zerowidth')
    assert.equal(normalizePassword('Ｓｐｉｄｅｒ'), 'spider', 'full-width letters')
    assert.notEqual(normalizePassword('spider ocean'), normalizePassword('spiderocean'))
  })

  // Frozen with format version 1: a change here stops existing links opening.
  test('the exact bytes are pinned', () => {
    const cases: Array<[string, string]> = [
      ['  Spider  Ocean Wagon ', '737069646572206f6365616e207761676f6e'],
      ['Café ’—Ａ', '636166c3a920272d61'],
      ['İstanbul ß ﬁ', '69cc877374616e62756c20c39f206669'],
      ['\u{1f511} Key‍', 'f09f9491206b6579'],
    ]
    for (const [typed, hex] of cases) {
      assert.equal(Buffer.from(normalizePassword(typed)).toString('hex'), hex, JSON.stringify(typed))
      // The page normalises what's typed, and the key normalises it again.
      assert.equal(normalizePassword(normalizePassword(typed)), normalizePassword(typed))
    }
  })

  test('at least 8 characters, at most 200, counted as people count them', () => {
    assert.equal(passwordProblem('1234567'), 'short')
    assert.equal(passwordProblem('   1234567   '), 'short')
    assert.equal(passwordProblem('12345678'), '')
    assert.equal(passwordLength('🔑🔑🔑🔑🔑🔑🔑🔑'), 8)
    assert.equal(passwordProblem('🔑🔑🔑🔑🔑🔑🔑🔑'), '')
    assert.equal(passwordProblem('x'.repeat(MAX_PASSWORD)), '')
    assert.equal(passwordProblem('x'.repeat(MAX_PASSWORD + 1)), 'long')
    assert.equal(MIN_PASSWORD, 8)
    // The longest allowed password fits what the module accepts (1024 bytes).
    assert.ok(new TextEncoder().encode('🔑'.repeat(MAX_PASSWORD)).length <= 1024)
  })
})

describe('password layer', () => {
  test('round trip, adding 45 bytes, with Argon2id settings for version 1', async () => {
    const calls: Parameters<typeof fakeDerive>[0] = []
    const inner = new Uint8Array(randomBytes(1000))
    const blob = await lockWith(inner, '  spider ocean  wagon ', fakeDerive(calls))
    assert.equal(PASSWORD_OVERHEAD, 45)
    assert.equal(blob.length, inner.length + 45)
    assert.equal(blob[0], 1)
    assert.deepEqual(await openWithPassword(blob, 'spider ocean wagon', fakeDerive(calls)), inner)
    assert.equal(calls.length, 2)
    for (const c of calls) {
      assert.equal(c.password, 'spider ocean wagon', 'the normalised password, as UTF-8')
      assert.deepEqual(c.params, { time: 3, memoryKiB: 65536, threads: 1 })
      assert.equal(c.salt.length, 16)
    }
    assert.deepEqual(calls[0].salt, calls[1].salt, 'the salt travels with the data')
    assert.deepEqual(KDF_V1, { time: 3, memoryKiB: 65536, threads: 1 })
  })

  test('an empty item locks and opens too', async () => {
    const blob = await lockWith(new Uint8Array(0), 'password1')
    assert.equal(blob.length, 45)
    assert.deepEqual(await openWithPassword(blob, 'password1', fakeDerive()), new Uint8Array(0))
  })

  test('fresh salt and nonce every time', async () => {
    const inner = new Uint8Array(32)
    const a = await lockWith(inner, 'password1')
    const b = await lockWith(inner, 'password1')
    assert.notDeepEqual(a.subarray(1, 17), b.subarray(1, 17))
    assert.notDeepEqual(a.subarray(17, 29), b.subarray(17, 29))
  })

  test('a wrong password is refused as wrong; capitals don’t count', async () => {
    const inner = new Uint8Array(randomBytes(50))
    const blob = await lockWith(inner, 'spider ocean wagon')
    assert.equal(await code(openWithPassword(blob, 'spider ocean wagons', fakeDerive())), 'wrong')
    assert.equal(await code(openWithPassword(blob, 'spider oceanwagon', fakeDerive())), 'wrong')
    assert.deepEqual(await openWithPassword(blob, 'Spider Ocean WAGON', fakeDerive()), inner)
  })

  test('a typed password longer than any sender could choose is wrong, with no key worked out', async () => {
    const blob = await lockWith(new Uint8Array(10), 'password1')
    const calls: Parameters<typeof fakeDerive>[0] = []
    assert.equal(await code(openWithPassword(blob, 'x'.repeat(MAX_PASSWORD + 1), fakeDerive(calls))), 'wrong')
    // Three-byte characters: 342 of them fit the box's 400 limit but not the module's 1024 bytes.
    assert.equal(await code(openWithPassword(blob, '漢'.repeat(342), fakeDerive(calls))), 'wrong')
    assert.equal(calls.length, 0)
    // NFKC turns U+FDFA into 18 characters: twelve are 216 once normalised.
    assert.equal(passwordProblem(String.fromCodePoint(0xfdfa).repeat(12)), 'long')
    // 200 code points after normalising always fit the module's 1024 bytes.
    assert.ok(new TextEncoder().encode(normalizePassword(String.fromCodePoint(0x1f511).repeat(MAX_PASSWORD))).length <= 1024)
  })

  test('any change to the data is caught', async () => {
    const inner = new Uint8Array(randomBytes(64))
    const blob = await lockWith(inner, 'password1')
    for (const at of [1, 16, 17, 28, 29, blob.length - 17, blob.length - 1]) {
      const bad = blob.slice()
      bad[at] ^= 1
      assert.equal(await code(openWithPassword(bad, 'password1', fakeDerive())), 'wrong', `byte ${at}`)
    }
    assert.equal(await code(openWithPassword(blob.slice(0, -1), 'password1', fakeDerive())), 'wrong')
  })

  test('too short, unknown or newer versions are refused before any key is worked out', async () => {
    const blob = await lockWith(new Uint8Array(10), 'password1')
    const calls: Parameters<typeof fakeDerive>[0] = []
    assert.equal(await code(openWithPassword(blob.slice(0, 44), 'password1', fakeDerive(calls))), 'damaged')
    assert.equal(await code(openWithPassword(new Uint8Array(0), 'password1', fakeDerive(calls))), 'damaged')
    const v0 = blob.slice()
    v0[0] = 0
    assert.equal(await code(openWithPassword(v0, 'password1', fakeDerive(calls))), 'damaged')
    const v2 = blob.slice()
    v2[0] = 2
    assert.equal(await code(openWithPassword(v2, 'password1', fakeDerive(calls))), 'newer')
    assert.equal(calls.length, 0)
    assert.throws(() => lockedSalt(v2), PasswordError)
  })

  test('a key made for another salt is a mistake, not a wrong password', async () => {
    const blob = await lockWith(new Uint8Array(10), 'password1')
    const other = await passwordKey('password1', undefined, fakeDerive())
    await assert.rejects(open(blob, other), TypeError)
  })

  test('an empty password, a bad salt or a bad key length are refused', async () => {
    await assert.rejects(passwordKey('   ', undefined, fakeDerive()), RangeError)
    await assert.rejects(passwordKey('password1', new Uint8Array(15), fakeDerive()), TypeError)
    await assert.rejects(passwordKey('password1', undefined, async () => new Uint8Array(16)), TypeError)
  })

  test('the derived key and password bytes are wiped', async () => {
    let given: Uint8Array | undefined
    let key: Uint8Array | undefined
    await passwordKey('password1', undefined, async (pw) => {
      given = pw
      key = new Uint8Array(32).fill(7)
      return key
    })
    assert.ok(given!.every((b) => b === 0))
    assert.ok(key!.every((b) => b === 0))
  })

  test('size: up to MAX_LOCKED, so the upload fits', async () => {
    assert.equal(MAX_LOCKED, MAX_PAYLOAD - 45)
    const pk = await passwordKey('password1', undefined, fakeDerive())
    assert.equal((await lock(new Uint8Array(MAX_LOCKED), pk)).length, MAX_PAYLOAD)
    await assert.rejects(lock(new Uint8Array(MAX_LOCKED + 1), pk), RangeError)
  })
})

// The real module, as the page runs it (core/cmd/tools-wasm), against
// OpenSSL's Argon2id and the Go test's known answers.
describe('Argon2id module', () => {
  const generated = new URL('../src/core/generated/', import.meta.url)
  const wasmPath = new URL('slynk-tools.wasm', generated)

  async function loadKdf() {
    assert.ok(existsSync(wasmPath), 'run `npm run build:core` first')
    await import(new URL('wasm_exec.js', generated).href)
    const g = globalThis as unknown as {
      Go: new () => { importObject: WebAssembly.Imports; run(i: WebAssembly.Instance): Promise<void> }
      slynkTools?: { argon2id(pw: Uint8Array, salt: Uint8Array, t: number, m: number, p: number): Promise<Uint8Array> }
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

  const derive: Derive = async (pw, salt, p) => (await loadKdf()).argon2id(pw, salt, p.time, p.memoryKiB, p.threads)

  test('matches OpenSSL and the known answers', async () => {
    const seq = Uint8Array.from({ length: 16 }, (_, i) => i)
    const cases: Array<[string, Uint8Array, string]> = [
      ['spider ocean wagon trophy lunar', seq, 'df1888df579deb05d20193f0a75a61b1225372631cb196a01e04234c9ff473f1'],
      ['pässwörd ☃', new Uint8Array(16).fill(0xa5), '5d7ca6da107134c58541112d36f2b7102e70710e9945b8691ac37ee2dd8405d3'],
    ]
    for (const [pw, salt, want] of cases) {
      const bytes = new TextEncoder().encode(pw)
      const got = Buffer.from(await derive(bytes, salt, KDF_V1)).toString('hex')
      assert.equal(got, want)
      const openssl = argon2Sync('argon2id', { message: bytes, nonce: salt, parallelism: 1, tagLength: 32, memory: 65536, passes: 3 })
      assert.equal(got, openssl.toString('hex'))
    }
  })

  test('refuses settings a crafted link could use to exhaust memory', async () => {
    const kdf = await loadKdf()
    const pw = new TextEncoder().encode('password1')
    const salt = new Uint8Array(16)
    await assert.rejects(kdf.argon2id(pw, salt, 3, 1024 * 1024, 1), /memory/)
    await assert.rejects(kdf.argon2id(pw, salt, 11, 64, 1), /time/)
    await assert.rejects(kdf.argon2id(pw, salt, 1, 64, 5), /threads/)
    await assert.rejects(kdf.argon2id(pw, new Uint8Array(8), 1, 64, 1), /salt/)
    await assert.rejects(kdf.argon2id(new Uint8Array(0), salt, 1, 64, 1), /password/)
    await assert.rejects(kdf.argon2id(pw, salt, 1.5, 64, 1), /time/)
    await assert.rejects(kdf.argon2id(pw, salt, Number.NaN, 64, 1), /time/)
    await assert.rejects((kdf.argon2id as (...a: unknown[]) => Promise<Uint8Array>)('password1', salt, 1, 64, 1), /password/)
  })

  test('a whole lock and open with the real thing', async () => {
    const inner = new Uint8Array(randomBytes(300))
    const blob = await lock(inner, await passwordKey('ocean spider', undefined, derive))
    assert.deepEqual(await openWithPassword(blob, ' ocean   spider ', derive), inner)
    assert.equal(await code(openWithPassword(blob, 'ocean spiders', derive)), 'wrong')
  })
})

describe('link flag', () => {
  const SENT = new Date('2026-10-14T12:00:00Z')
  function fakeV1(): Uint8Array {
    const v1 = new Uint8Array(randomBytes(LINK_LENGTH))
    v1[0] = 1
    new DataView(v1.buffer).setBigUint64(66, BigInt(SENT.getTime()) * 1_000_000n)
    return v1
  }

  test('an ordinary link that needs a password: same length, flag in the first byte', () => {
    const v1 = fakeV1()
    const link = passwordLinkV1(v1)
    assert.equal(link[0], 0x81)
    assert.equal(v1[0], 1, 'the core’s link is left alone')
    const fragment = toBase64url(link)
    assert.equal(fragment.length, linkToFragment(v1).length)
    const parsed = parseLinkFragment(fragment)
    assert.equal(parsed.kind, 'ordinary')
    assert.equal(parsed.password, true)
    assert.deepEqual(parsed.v1, v1, 'core.download gets the plain v1 link back')
    assert.equal(parsed.sent.getTime(), SENT.getTime())
    assert.equal(parseLinkFragment(linkToFragment(v1)).password, false)
  })

  test('one-time and expiring links carry it too', () => {
    const v1 = fakeV1()
    const secret = new Uint8Array(randomBytes(32))
    for (const mode of ['one-time', 'expiring'] as const) {
      const plain = buildLinkV2(v1, mode, 24, secret)
      const locked = buildLinkV2(v1, mode, 24, secret, true)
      assert.equal(locked.length, LINK_V2_LENGTH)
      assert.equal(locked[0], 0x82)
      assert.deepEqual(locked.subarray(1), plain.subarray(1))
      const p = parseLinkFragment(toBase64url(locked))
      assert.equal(p.kind, mode)
      assert.equal(p.password, true)
      assert.ok(p.kind !== 'ordinary' && p.link.password)
      assert.deepEqual(p.v1, v1)
      const q = parseLinkFragment(toBase64url(plain))
      assert.equal(q.password, false)
      assert.ok(q.kind !== 'ordinary' && !q.link.password)
    }
  })

  test('unknown first bytes are still refused', () => {
    const v1 = fakeV1()
    for (const first of [0x80, 0x83, 0x03, 0xff]) {
      const bad = v1.slice()
      bad[0] = first
      assert.throws(() => parseLinkFragment(toBase64url(bad)), LinkError, `0x${first.toString(16)}`)
    }
  })

  test('the closed “Link options” line says when a password is on', () => {
    assert.equal(optionsSummary(500, false, true), 'Lasts up to 3 weeks · Password')
    assert.equal(optionsSummary(24, true, true), 'One-time · 1 day · Password')
    assert.equal(optionsSummary(1, false, true), 'Stops after 1 hour · Password')
    assert.equal(optionsSummary(1, false), 'Stops after 1 hour')
  })
})
