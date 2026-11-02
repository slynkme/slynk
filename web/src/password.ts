// Password links: an extra layer of encryption whose key
// comes from a password, so having the link isn't enough to open what it
// carries. The password never leaves the browser; slynk.me never sees it.
//
// The key is Argon2id(password, salt), worked out in its own worker (kdf/),
// and the layer is AES-256-GCM. What's uploaded, version 1:
//
//   version(1)=1  salt(16)  nonce(12)  AES-256-GCM(key, inner) with its 16-byte tag
//
// 45 bytes more than inner, whatever its size. The link only says that a
// password is needed (linkv2.ts), so it stays the same length; the salt
// isn't secret and travels with the data. inner is the envelope or, for a
// one-time or expiring link, the envelope sealed by burn.ts. The password
// layer goes outside that one, so the page checks the password before it
// asks slynk.me for its half of the key: a wrong password never uses up a
// one-time link.
//
// Argon2id for version 1: 3 passes over 64 MiB in one lane (RFC 9106's
// second recommendation, in one lane because the browser gives the work a
// single thread). About half a second on a laptop, a second or two on a
// phone. Changing them, the labels below or normalizePassword needs a new
// version byte, or every existing password link stops opening.
import { argon2id, type KdfParams } from './kdf/index.ts'
import { MAX_PAYLOAD, PASSWORD_OVERHEAD } from './payload.ts'
import { AVOID, WORDS } from './ui/words.ts'

export const PASSWORD_VERSION = 1
const SALT_BYTES = 16
const IV_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32
const HEADER_BYTES = 1 + SALT_BYTES

/** What the password layer adds (HEADER_BYTES + IV_BYTES + TAG_BYTES): counted in payload.ts, beside the limit it comes out of. */
export { PASSWORD_OVERHEAD }
/** The most a password can lock, so the upload still fits MAX_PAYLOAD. */
export const MAX_LOCKED = MAX_PAYLOAD - PASSWORD_OVERHEAD
/** Characters, for passwords people choose. Suggested ones are always longer. */
export const MIN_PASSWORD = 8
export const MAX_PASSWORD = 200
/** Words in a suggested password: about 54 bits from 1904 words. */
export const SUGGESTED_WORDS = 5

export const KDF_V1: KdfParams = { time: 3, memoryKiB: 64 * 1024, threads: 1 }
const AAD_LABEL = new TextEncoder().encode('slynk/pw/v1')

/** Works out a key from a password and salt. argon2id in the page; tests can pass another. */
export type Derive = (password: Uint8Array, salt: Uint8Array, params: KdfParams) => Promise<Uint8Array>

export interface PasswordKey {
  salt: Uint8Array
  key: CryptoKey
}

/**
 * wrong: the password doesn't open it (or the data was changed, which the
 *        core's own check makes all but impossible after a download)
 * damaged: too short to be anything lock made
 * newer: made by a later version of Slynk
 */
export type PasswordErrorCode = 'wrong' | 'damaged' | 'newer'

export class PasswordError extends Error {
  readonly code: PasswordErrorCode
  constructor(code: PasswordErrorCode) {
    super(`password layer: ${code}`)
    this.name = 'PasswordError'
    this.code = code
  }
}

// --- Passwords ------------------------------------------------------------------

/**
 * The form a password is used in, frozen with format version 1 (see above).
 * Passwords get retyped from chats and notes on other devices, and vary in
 * ways people don't notice, so none of these matter:
 * - capitals: phones capitalise the first word, and suggested words are
 *   lower case (costs a chosen password a bit or two, not the suggestions)
 * - accents typed one way or another, full-width letters (NFKC)
 * - curly quotes and long dashes that phones swap in for ' " and -
 * - invisible characters that come along when text is pasted
 * - spaces: extra ones, odd ones, or any at either end
 */
export function normalizePassword(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\u200b-\u200d\u2060\ufeff\u00ad]/g, '')
    .replace(/[\u2018\u2019\u201a\u201b\u2032]/g, "'")
    .replace(/[\u201c\u201d\u201e\u201f\u2033]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Length in Unicode code points: most emoji count as one, flags and some others as more. */
export function passwordLength(text: string): number {
  return [...normalizePassword(text)].length
}

/**
 * For a password the sender chose: '' if it will do, or what's wrong. Counted
 * after normalising, which can lengthen some characters a lot: 200 code
 * points are at most 800 bytes, within what the module accepts (1024).
 */
export function passwordProblem(text: string): '' | 'short' | 'long' {
  const n = passwordLength(text)
  if (n < MIN_PASSWORD) return 'short'
  if (n > MAX_PASSWORD) return 'long'
  return ''
}

let pool: string[] | undefined

/** Five random everyday words, separated by spaces. */
export function suggestPassword(count = SUGGESTED_WORDS): string {
  pool ??= WORDS.filter((w) => !AVOID.has(w))
  // Rejection sampling, so every word is equally likely.
  const limit = Math.floor(2 ** 32 / pool.length) * pool.length
  const n = new Uint32Array(1)
  const words: string[] = []
  while (words.length < count) {
    crypto.getRandomValues(n)
    if (n[0] < limit) words.push(pool[n[0] % pool.length])
  }
  return words.join(' ')
}

// --- The layer --------------------------------------------------------------------

/**
 * Works out the key (the slow part). Leave salt out to lock something new;
 * to open, pass lockedSalt(blob).
 */
export async function passwordKey(text: string, salt: Uint8Array = random(SALT_BYTES), derive: Derive = argon2id): Promise<PasswordKey> {
  if (salt.length !== SALT_BYTES) throw new TypeError('salt must be 16 bytes')
  const pw = new TextEncoder().encode(normalizePassword(text))
  if (pw.length === 0) throw new RangeError('empty password')
  let raw: Uint8Array | undefined
  try {
    raw = await derive(pw, salt, KDF_V1)
    if (raw.length !== KEY_BYTES) throw new TypeError('key must be 32 bytes')
    // Not extractable: the key never comes back into JavaScript.
    const key = await crypto.subtle.importKey('raw', bytes(raw), 'AES-GCM', false, ['encrypt', 'decrypt'])
    return { salt: salt.slice(), key }
  } finally {
    pw.fill(0)
    raw?.fill(0)
  }
}

/** version || salt || nonce || AES-256-GCM(inner). Adds PASSWORD_OVERHEAD bytes. */
export async function lock(inner: Uint8Array, pk: PasswordKey): Promise<Uint8Array> {
  if (inner.length > MAX_LOCKED) throw new RangeError('Too large to lock with a password.')
  const header = new Uint8Array(HEADER_BYTES)
  header[0] = PASSWORD_VERSION
  header.set(pk.salt, 1)
  const iv = random(IV_BYTES)
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(header), tagLength: TAG_BYTES * 8 }, pk.key, bytes(inner))
  const out = new Uint8Array(HEADER_BYTES + IV_BYTES + ct.byteLength)
  out.set(header)
  out.set(iv, HEADER_BYTES)
  out.set(new Uint8Array(ct), HEADER_BYTES + IV_BYTES)
  return out
}

/** The salt something was locked with, needed to work out its key. Throws PasswordError. */
export function lockedSalt(blob: Uint8Array): Uint8Array {
  if (blob.length < PASSWORD_OVERHEAD) throw new PasswordError('damaged')
  if (blob[0] !== PASSWORD_VERSION) throw new PasswordError(blob[0] > PASSWORD_VERSION ? 'newer' : 'damaged')
  return blob.slice(1, HEADER_BYTES)
}

/** Reverses lock. Throws PasswordError: 'wrong' when the password doesn't fit. */
export async function open(blob: Uint8Array, pk: PasswordKey): Promise<Uint8Array> {
  const salt = lockedSalt(blob)
  if (!salt.every((b, i) => b === pk.salt[i])) throw new TypeError('this key was made for another salt')
  try {
    const plain = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: bytes(blob.subarray(HEADER_BYTES, HEADER_BYTES + IV_BYTES)),
        additionalData: aad(blob.subarray(0, HEADER_BYTES)),
        tagLength: TAG_BYTES * 8,
      },
      pk.key,
      bytes(blob.subarray(HEADER_BYTES + IV_BYTES)),
    )
    return new Uint8Array(plain)
  } catch {
    throw new PasswordError('wrong')
  }
}

/**
 * Works out the key and opens the blob in one go. A typed password too long
 * for any sender to have chosen is wrong without working anything out (the
 * module would refuse it, which looks like a fault that Try again can't fix).
 */
export async function openWithPassword(blob: Uint8Array, text: string, derive: Derive = argon2id): Promise<Uint8Array> {
  const salt = lockedSalt(blob)
  if (passwordProblem(text) === 'long') throw new PasswordError('wrong')
  return open(blob, await passwordKey(text, salt, derive))
}

// --- Small helpers ------------------------------------------------------------------

/** The label, then the version and salt, so neither can be swapped unnoticed. */
function aad(header: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(AAD_LABEL.length + header.length)
  out.set(AAD_LABEL)
  out.set(header, AAD_LABEL.length)
  return out
}

function random(n: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(n))
}

// WebCrypto wants views over a plain ArrayBuffer; copy only when it isn't one.
function bytes(a: Uint8Array): Uint8Array<ArrayBuffer> {
  return a.buffer instanceof ArrayBuffer ? (a as Uint8Array<ArrayBuffer>) : new Uint8Array(a)
}
