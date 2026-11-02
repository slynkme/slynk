// An inbox's passphrase saved to the device (“Save my passphrase”): its 12 words (and the owner's label for it,
// if they gave one), encrypted with a password of the owner's choosing, for organisations that keep secrets in a password vault
// and for phones, where typing 12 words is a chore. Nothing about the inbox
// (not even its name) is readable without the password, so a file found on
// a seized laptop says only that it's a Slynk inbox key.
//
// The key is Argon2id over the normalised password (password.ts: the same
// settings and normalising as password links), and the words are sealed
// with AES-256-GCM under a label of its own, so a passphrase file can never be
// taken for anything else. The file is plain text:
//
//   Your Slynk inbox passphrase backup   ("Slynk inbox key file" before 2026-10-22; only the v1 line is read)
//   (a line saying how to use it)
//   v1.base64url(salt(16) nonce(12) AES-256-GCM(words [newline label]))
//
// The label only names the inbox on its owner's screens; files
// made before it have none.
//
// A backup made from the open inbox's menu can hold its messages too:
// everything the inbox keeps on a device (kept.ts), so restoring it elsewhere
// brings them back. That's a v2 line, under a label
// of its own, and padded as kept records are, so its size says only roughly
// how much it holds (16 KB steps):
//
//   Your Slynk inbox backup
//   (the same line saying how to use it)
//   v2.base64url(salt(16) nonce(12) AES-256-GCM(length(4) JSON{words, label, inbox} zeros))
//
// Remembered words (kept.ts) with a password of the owner's are sealed the same
// way, under a label of their own ("slynk/remembered-words/v1"), so a sealed
// record and a passphrase file can never be taken for each other.
import { fromBase64url, toBase64url } from '../linkv2.ts'
import { normalizePassword, passwordKey, passwordLength, passwordProblem, type Derive } from '../password.ts'
import { argon2id } from '../kdf/index.ts'
import { cleanName, type KeptMailbox } from './mailbox.ts'
import { FILE_PREFIX, SITE_NAME } from '../site.ts'

const SALT_BYTES = 16
const IV_BYTES = 12
const TAG_BYTES = 16
const PREFIX = 'v1.'
const BACKUP_PREFIX = 'v2.'
const AAD = new TextEncoder().encode('slynk/inbox-key/v1')
const BACKUP_AAD = new TextEncoder().encode('slynk/inbox-backup/v2')
const WORDS_AAD = new TextEncoder().encode('slynk/remembered-words/v1')
/** Real passphrase files are under 400 bytes; nothing bigger is even read. */
export const MAX_KEY_FILE = 4096
/** A backup with messages: well over what the fullest inbox makes (mailbox.ts's limits), and nothing bigger is read. */
export const MAX_BACKUP_FILE = 64 * 1024 * 1024
/** A backup with messages is padded to a multiple of this, as kept records are (kept.ts). */
const BACKUP_PAD = 16384

/**
 * A passphrase file guards an inbox for as long as it's used, and can be attacked
 * offline wherever the file turns up, so its password must be longer than a
 * link's (which only has to hold for up to three weeks). The suggested five
 * words always are.
 */
export const MIN_KEY_FILE_PASSWORD = 12

/** For a passphrase file's password: '' if it will do, or what's wrong. */
export function keyFilePasswordProblem(text: string): '' | 'short' | 'long' {
  const problem = passwordProblem(text)
  if (problem) return problem
  return passwordLength(text) < MIN_KEY_FILE_PASSWORD ? 'short' : ''
}

export const KEY_FILE_NAME = `${FILE_PREFIX}-passphrase-backup.txt`
export const BACKUP_FILE_NAME = `${FILE_PREFIX}-inbox-backup.txt`
export const KEY_FILE_TYPE = 'text/plain'

export type KeyFileErrorCode = 'not-key-file' | 'newer' | 'wrong'

export class KeyFileError extends Error {
  readonly code: KeyFileErrorCode
  constructor(code: KeyFileErrorCode) {
    super(`passphrase file: ${code}`)
    this.name = 'KeyFileError'
    this.code = code
  }
}

/**
 * The words as the core reads them: lower case, single spaces. Anything but letters goes, so the
 * numbered list "Copy the words" gives (one a line, which a one-line box runs together when it's
 * pasted back) still reads as the 12 words.
 */
export const normalizeWords = (words: string): string => words.toLowerCase().replace(/[^a-z]+/g, ' ').trim()

/** The words as "Copy the words" puts them on the clipboard: numbered, one a line. */
export const numberedWords = (words: string): string =>
  normalizeWords(words)
    .split(' ')
    .map((w, i) => `${i + 1}. ${w}`)
    .join('\n')

/** Seals text with a key from the password: salt(16) nonce(12) AES-256-GCM(text), under aad. */
const sealText = (text: string, password: string, aad: Uint8Array<ArrayBuffer>, derive: Derive): Promise<Uint8Array> =>
  sealBytes(new TextEncoder().encode(text), password, aad, derive)

/** The same for bytes, which are wiped once sealed. */
async function sealBytes(plain: Uint8Array<ArrayBuffer>, password: string, aad: Uint8Array<ArrayBuffer>, derive: Derive): Promise<Uint8Array> {
  try {
    const pk = await passwordKey(password, undefined, derive)
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: TAG_BYTES * 8 }, pk.key, plain))
    const blob = new Uint8Array(SALT_BYTES + IV_BYTES + ct.length)
    blob.set(pk.salt)
    blob.set(iv, SALT_BYTES)
    blob.set(ct, SALT_BYTES + IV_BYTES)
    return blob
  } finally {
    plain.fill(0)
  }
}

/** What sealText sealed. Throws KeyFileError 'wrong' when the password doesn't open it. */
async function openText(blob: Uint8Array, password: string, aad: Uint8Array<ArrayBuffer>, derive: Derive): Promise<string> {
  const bytes = await openBytes(blob, password, aad, derive)
  const text = new TextDecoder().decode(bytes)
  bytes.fill(0)
  return text
}

/** What sealBytes sealed, for the caller to wipe. Throws KeyFileError 'wrong' when the password doesn't open it. */
async function openBytes(blob: Uint8Array, password: string, aad: Uint8Array<ArrayBuffer>, derive: Derive): Promise<Uint8Array> {
  if (!normalizePassword(password) || blob.length < SALT_BYTES + IV_BYTES + TAG_BYTES + 1) throw new KeyFileError('wrong')
  const pk = await passwordKey(password, blob.slice(0, SALT_BYTES), derive)
  let plain: ArrayBuffer
  try {
    plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: blob.slice(SALT_BYTES, SALT_BYTES + IV_BYTES), additionalData: aad, tagLength: TAG_BYTES * 8 },
      pk.key,
      blob.slice(SALT_BYTES + IV_BYTES),
    )
  } catch {
    throw new KeyFileError('wrong')
  }
  return new Uint8Array(plain)
}

/** How to use a backup file, said in it: the open screen's own words (inboxCopy.ts's OPEN_USE_FILE). */
const HOW_TO = `To use it, choose “Unlock my inbox” on the ${SITE_NAME} page, then “Restore from a backup file”. It needs the password you chose for it.`

/**
 * Encrypts an inbox's 12 words (and its label) with a password, as the text of a backup file: with
 * what the inbox keeps (Mailbox.toKept), a backup of its messages too.
 */
export async function makeKeyFile(words: string, password: string, derive: Derive = argon2id, label = '', inbox?: KeptMailbox): Promise<string> {
  const name = cleanName(label)
  if (!inbox) {
    const blob = await sealText(normalizeWords(words) + (name ? `\n${name}` : ''), password, AAD, derive)
    return [`Your ${SITE_NAME} inbox passphrase backup`, HOW_TO, PREFIX + toBase64url(blob), ''].join('\n')
  }
  const json = new TextEncoder().encode(JSON.stringify({ words: normalizeWords(words), label: name, inbox }))
  const plain = new Uint8Array(Math.ceil((4 + json.length) / BACKUP_PAD) * BACKUP_PAD)
  new DataView(plain.buffer).setUint32(0, json.length)
  plain.set(json, 4)
  json.fill(0)
  const blob = await sealBytes(plain, password, BACKUP_AAD, derive)
  const text = [`Your ${SITE_NAME} inbox backup`, HOW_TO, BACKUP_PREFIX + toBase64url(blob), ''].join('\n')
  // Never a file this page wouldn't read back (mailbox.ts's limits keep a full inbox well under it).
  if (text.length > MAX_BACKUP_FILE) throw new Error('backup too big')
  return text
}

/** Seals words to be remembered on this device with the owner's password (kept.ts). */
export const sealWords = (words: string, password: string, derive: Derive = argon2id): Promise<Uint8Array> =>
  sealText(normalizeWords(words), password, WORDS_AAD, derive)

/** Remembered words sealed with sealWords. Throws KeyFileError 'wrong' when the password doesn't open them. */
export const openSealedWords = (blob: Uint8Array, password: string, derive: Derive = argon2id): Promise<string> => openText(blob, password, WORDS_AAD, derive)

/** A backup file's encrypted part, read from its text once, and its version (2: with messages). */
export interface ParsedKeyFile {
  v: 1 | 2
  blob: Uint8Array
}

/**
 * Base64url without fromBase64url's canonical check, which encodes it all again: a backup with
 * messages can be megabytes, and tampering with it is caught by its seal anyway.
 */
function decodeBig(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) throw new KeyFileError('not-key-file')
  const raw = atob(text.replace(/-/g, '+').replace(/_/g, '/'))
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes
}

/** The encrypted part of a backup file's text. Throws KeyFileError. */
function keyLine(text: string): ParsedKeyFile {
  if (text.length > MAX_BACKUP_FILE) throw new KeyFileError('not-key-file')
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => /^v\d+\./.test(l))
  if (!line) throw new KeyFileError('not-key-file')
  const v = line.startsWith(PREFIX) ? 1 : line.startsWith(BACKUP_PREFIX) ? 2 : 0
  if (!v) throw new KeyFileError('newer')
  if (v === 1 && text.length > MAX_KEY_FILE) throw new KeyFileError('not-key-file')
  let blob: Uint8Array
  try {
    blob = v === 1 ? fromBase64url(line.slice(PREFIX.length)) : decodeBig(line.slice(BACKUP_PREFIX.length))
  } catch {
    throw new KeyFileError('not-key-file')
  }
  if (blob.length < SALT_BYTES + IV_BYTES + TAG_BYTES + 1) throw new KeyFileError('not-key-file')
  return { v, blob }
}

/** A backup file's text, read once before asking for its password, or why this page can't use it. */
export function parseKeyFile(text: string): ParsedKeyFile | KeyFileErrorCode {
  try {
    return keyLine(text)
  } catch (e) {
    return e instanceof KeyFileError ? e.code : 'not-key-file'
  }
}

/** Checks that text is a backup file this page can read, before asking for its password. */
export function isKeyFile(text: string): KeyFileErrorCode | '' {
  const parsed = parseKeyFile(text)
  return typeof parsed === 'string' ? parsed : ''
}

/** Whether a backup file this page can read holds messages too (readable without its password). */
export function holdsMessages(text: string): boolean {
  const parsed = parseKeyFile(text)
  return typeof parsed !== 'string' && parsed.v === 2
}

/** What a backup file holds: the 12 words, the inbox's label, and (a backup with messages) what the inbox kept. */
export interface Backup {
  words: string
  label: string
  /** As Mailbox.toKept made it, for Mailbox.fromKept to check. */
  inbox?: unknown
}

/** What's in a backup file (its text, or as parseKeyFile read it). Throws KeyFileError: 'wrong' when the password doesn't open it. */
export async function readKeyFile(file: string | ParsedKeyFile, password: string, derive: Derive = argon2id): Promise<Backup> {
  const { v, blob } = typeof file === 'string' ? keyLine(file) : file
  if (v === 1) {
    const [words, label = ''] = (await openText(blob, password, AAD, derive)).split('\n')
    return { words, label: cleanName(label) }
  }
  const plain = await openBytes(blob, password, BACKUP_AAD, derive)
  try {
    const length = plain.length >= 4 ? new DataView(plain.buffer, plain.byteOffset).getUint32(0) : -1
    if (length < 0 || 4 + length > plain.length) throw new KeyFileError('not-key-file')
    const data: unknown = JSON.parse(new TextDecoder().decode(plain.subarray(4, 4 + length)))
    const d = data as Partial<Record<'words' | 'label' | 'inbox', unknown>> | null
    if (typeof d?.words !== 'string' || !d.inbox || typeof d.inbox !== 'object') throw new KeyFileError('not-key-file')
    return { words: normalizeWords(d.words), label: cleanName(typeof d.label === 'string' ? d.label : ''), inbox: d.inbox }
  } catch (e) {
    throw e instanceof KeyFileError ? e : new KeyFileError('not-key-file')
  } finally {
    plain.fill(0)
  }
}
