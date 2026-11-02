// Keeping an inbox on this device (docs/findings/inbox.md), only when its owner asks
// ("Keep this inbox on this device", off by default). What's kept (messages,
// upload entries, read state, folders, titles, the label and the address
// book, never files, nor the words but as below) is one record in this browser's IndexedDB,
// sealed with AES-256-GCM under a key the core works out from the inbox's
// 12 words (its own label: transfer.InboxKey.StoreSecret). The record's name
// comes from the same secret, so the device doesn't say which inbox it is,
// and the sealed contents are padded, so their size says little about how
// many messages there are. Without the words (typed or saved) it can't be
// read. "Forget this device" deletes it.
//
// "Remember my passphrase on this device" (off unless the owner switches it on,
// after plain warnings) keeps the inbox's 12 words beside its record. Without a
// password they're kept as they are: a browser has nothing else to encrypt them
// with, and anyone using this browser can open the inbox. With an optional
// password of the owner's they're sealed as a passphrase file is (keyfile.ts,
// sealWords: Argon2id, AES-256-GCM), and opening asks for it; since the
// record's key comes from the words, the password guards everything kept, as
// strongly as it is hard to guess. They go with Forget my passphrase, Forget
// this device, or the front page's Forget it.
//
// Honest limits, on the About page rather than the screens: Safari clears a
// site's storage after seven days of use without a visit, private windows
// keep nothing, anyone using the device can tell Slynk keeps something here
// (not what), and someone with the device and the words reads everything
// kept, even past the network's three weeks.
import type { KeptMailbox } from './mailbox.ts'

const DB_NAME = 'slynk'
const DB_STORE = 'kept'
const AAD = new TextEncoder().encode('slynk/inbox-store/v1')
const IV_BYTES = 12
/** Sealed contents are padded to a multiple of this. */
export const PAD = 16384
export const STORE_SECRET_LENGTH = 48

/** The key for one inbox's record, and the record's name. */
export interface KeptKey {
  key: CryptoKey
  name: string
}

/** A sealed record as IndexedDB holds it. */
export interface KeptRecord {
  v: 1
  iv: Uint8Array
  data: Uint8Array
}

export class KeptError extends Error {
  readonly code: 'unavailable' | 'unreadable'
  constructor(code: 'unavailable' | 'unreadable', cause?: unknown) {
    super(`kept: ${code}`, { cause })
    this.name = 'KeptError'
    this.code = code
  }
}

/** The key and name from the core's store secret, which is wiped. The key can't be read back out. */
export async function keptKey(secret: Uint8Array): Promise<KeptKey> {
  if (secret.length !== STORE_SECRET_LENGTH) throw new Error('not a store secret')
  try {
    const key = await crypto.subtle.importKey('raw', secret.subarray(0, 32) as Uint8Array<ArrayBuffer>, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
    const name = Array.from(secret.subarray(32), (b) => b.toString(16).padStart(2, '0')).join('')
    return { key, name }
  } finally {
    secret.fill(0)
  }
}

/** Seals what's kept: its length, the JSON, and zeros up to a multiple of PAD. */
export async function seal(k: KeptKey, box: KeptMailbox): Promise<KeptRecord> {
  const json = new TextEncoder().encode(JSON.stringify(box))
  const plain = new Uint8Array(Math.ceil((4 + json.length) / PAD) * PAD)
  new DataView(plain.buffer).setUint32(0, json.length)
  plain.set(json, 4)
  json.fill(0)
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  try {
    const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AAD }, k.key, plain))
    return { v: 1, iv, data }
  } finally {
    plain.fill(0)
  }
}

/** Opens a sealed record. Throws KeptError('unreadable') if it isn't this inbox's or is damaged. */
export async function unseal(k: KeptKey, rec: unknown): Promise<unknown> {
  const r = rec as Partial<KeptRecord> | undefined
  if (r?.v !== 1 || !(r.iv instanceof Uint8Array) || !(r.data instanceof Uint8Array) || r.iv.length !== IV_BYTES) throw new KeptError('unreadable')
  let plain: Uint8Array
  try {
    plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: r.iv.slice(), additionalData: AAD }, k.key, r.data.slice()))
  } catch (e) {
    throw new KeptError('unreadable', e)
  }
  try {
    const length = plain.length >= 4 ? new DataView(plain.buffer).getUint32(0) : -1
    if (length < 0 || 4 + length > plain.length) throw new KeptError('unreadable')
    const data = JSON.parse(new TextDecoder().decode(plain.subarray(4, 4 + length)))
    // A newer layout inside the same seal is left as it is, never half-read and overwritten.
    if (data?.v !== 1) throw new KeptError('unreadable')
    return data
  } catch (e) {
    throw e instanceof KeptError ? e : new KeptError('unreadable', e)
  } finally {
    plain.fill(0)
  }
}

// --- IndexedDB -------------------------------------------------------------------
// Private windows, blocked site data or an old browser can refuse; then
// nothing is kept, and the owner is told.
//
// Only keeping creates the database: looking for a kept inbox (every open)
// must leave no trace on a device where nothing is kept, so a read never
// creates it, and Forget deletes it once it holds nothing.

/** The database, or undefined if create is false and there isn't one. */
async function openDb(create: boolean): Promise<IDBDatabase | undefined> {
  if (!create) {
    try {
      const all = await indexedDB.databases?.()
      if (all && !all.some((d) => d.name === DB_NAME)) return undefined
    } catch {
      // Older browsers: the upgrade check below still stops it being created.
    }
  }
  return new Promise((resolve, reject) => {
    let req: IDBOpenDBRequest
    try {
      req = indexedDB.open(DB_NAME, 1)
    } catch (e) {
      return reject(new KeptError('unavailable', e))
    }
    let absent = false
    req.onupgradeneeded = (e) => {
      // Aborting the first upgrade leaves no database behind.
      if (!create && e.oldVersion === 0) {
        absent = true
        req.transaction?.abort()
        return
      }
      req.result.createObjectStore(DB_STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = (e) => {
      if (!absent) return reject(new KeptError('unavailable', req.error))
      e.preventDefault()
      resolve(undefined)
    }
    req.onblocked = () => reject(new KeptError('unavailable'))
  })
}

/**
 * A phone's browser can lose its storage while the page sleeps (Safari: "Connection to Indexed
 * Database server lost"): the first step after the screen comes back on fails, though a fresh one
 * works (seen 2026-10-25: a kept inbox said it couldn't be kept, until a reload). So a
 * step that fails is tried twice more, each time on a connection of its own, before it counts as
 * failed. A transaction is all or nothing, so trying one again never half-writes anything.
 */
const RETRY_MS = [400, 1500]

async function again<T>(step: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await step()
    } catch (e) {
      if (!(e instanceof KeptError && e.code === 'unavailable') || i >= RETRY_MS.length) throw e
      await new Promise((r) => setTimeout(r, RETRY_MS[i]))
    }
  }
}

/** One transaction on the store, settled when it has all been done; a connection that's gone fails it as unavailable. */
function transact(db: IDBDatabase, mode: IDBTransactionMode, fn: (store: IDBObjectStore) => void): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let tx: IDBTransaction
    try {
      tx = db.transaction(DB_STORE, mode)
      fn(tx.objectStore(DB_STORE))
    } catch (e) {
      return reject(new KeptError('unavailable', e))
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(new KeptError('unavailable', tx.error))
    tx.onabort = () => reject(new KeptError('unavailable', tx.error))
  })
}

function withStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>, create = mode === 'readwrite'): Promise<T | undefined> {
  return again(async () => {
    const db = await openDb(create)
    if (!db) return undefined
    try {
      let req: IDBRequest<T> | undefined
      await transact(db, mode, (s) => (req = fn(s)))
      return req!.result
    } finally {
      db.close()
    }
  })
}

/** Runs fn's requests on the store in one transaction, resolving once it has all been written (false: no database). */
function inTx(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => void, create = mode === 'readwrite'): Promise<boolean> {
  return again(async () => {
    const db = await openDb(create)
    if (!db) return false
    try {
      await transact(db, mode, fn)
      return true
    } finally {
      db.close()
    }
  })
}

/**
 * Remembered words are kept under this prefix and the inbox record's name
 * (as they are), or under SEALED (sealed with the owner's password), and the
 * owner's label for the inbox apart from them, so naming remembered inboxes,
 * and telling which need a password, never reads anyone's words into the page.
 */
const WORDS = 'words:'
const SEALED = 'sealed:'
const LABEL = 'label:'
const isRecord = (k: string) => !k.startsWith(WORDS) && !k.startsWith(SEALED) && !k.startsWith(LABEL)

/** Every key in the store: records, remembered words and labels. Never creates the database. */
const allKeys = async (): Promise<string[]> => ((await withStore('readonly', (s) => s.getAllKeys())) ?? []).map(String)

/**
 * Remembers an inbox's words beside its record (the owner asked, after the warnings), with its label:
 * as they are, or sealed with the owner's password (keyfile.ts, sealWords). Either replaces the other.
 */
export async function rememberWords(name: string, words: string | Uint8Array, label: string): Promise<void> {
  await inTx('readwrite', (s) => {
    if (typeof words === 'string') {
      s.put({ v: 1, words }, WORDS + name)
      s.delete(SEALED + name)
    } else {
      s.put({ v: 1, sealed: words }, SEALED + name)
      s.delete(WORDS + name)
    }
    s.put(label, LABEL + name)
  })
}

/** A remembered inbox: its record's name, its label, and whether opening it needs the owner's password. */
export interface Remembered {
  name: string
  label: string
  password: boolean
}

/** The inboxes whose words are remembered here (never their words), in label order. */
export async function rememberedInboxes(): Promise<Remembered[]> {
  const keys = await allKeys()
  const found = [
    ...keys.filter((k) => k.startsWith(WORDS)).map((k) => ({ name: k.slice(WORDS.length), password: false })),
    ...keys.filter((k) => k.startsWith(SEALED)).map((k) => ({ name: k.slice(SEALED.length), password: true })),
  ]
  const labels = new Map<string, string>()
  if (found.length)
    await inTx('readonly', (s) => {
      for (const { name } of found) {
        const req = s.get(LABEL + name)
        req.onsuccess = () => labels.set(name, typeof req.result === 'string' ? req.result : '')
      }
    })
  return found
    .map((r) => ({ ...r, label: labels.get(r.name) ?? '' }))
    .sort((x, y) => x.label.localeCompare(y.label) || x.name.localeCompare(y.name))
}

/** One remembered inbox's words, read only to open it: as they are, or sealed with the owner's password. */
export async function readWords(name: string): Promise<{ words: string } | { sealed: Uint8Array } | undefined> {
  const plain = (await withStore('readonly', (s) => s.get(WORDS + name))) as { v?: unknown; words?: unknown } | undefined
  if (plain?.v === 1 && typeof plain.words === 'string') return { words: plain.words }
  const sealed = (await withStore('readonly', (s) => s.get(SEALED + name))) as { v?: unknown; sealed?: unknown } | undefined
  if (sealed?.v === 1 && sealed.sealed instanceof Uint8Array) return { sealed: sealed.sealed }
  return undefined
}

/** Whether this inbox's words are remembered here, and if so whether with a password. */
export async function wordsRemembered(name: string): Promise<false | 'plain' | 'password'> {
  const keys = await allKeys()
  return keys.includes(WORDS + name) ? 'plain' : keys.includes(SEALED + name) ? 'password' : false
}

/** Keeps a remembered inbox's label up to date (the owner renamed it); never brings forgotten words back. */
export async function relabelWords(name: string, label: string): Promise<void> {
  await inTx(
    'readwrite',
    (s) => {
      const req = s.getAllKeys(IDBKeyRange.only(WORDS + name))
      const sealed = s.getAllKeys(IDBKeyRange.only(SEALED + name))
      sealed.onsuccess = () => {
        if ((req.result?.length ?? 0) + (sealed.result?.length ?? 0) > 0) s.put(label, LABEL + name)
      }
    },
    false,
  )
}

/** Forgets an inbox's remembered words (sealed or not) and label, together; what's kept of it stays. */
export async function forgetWords(name: string): Promise<void> {
  await inTx(
    'readwrite',
    (s) => {
      s.delete(WORDS + name)
      s.delete(SEALED + name)
      s.delete(LABEL + name)
    },
    false,
  )
}

/** The sealed record kept under this name, if any. Never creates the database. */
export const readKept = (name: string): Promise<unknown> => withStore('readonly', (s) => s.get(name))

export const writeKept = async (name: string, rec: KeptRecord): Promise<void> => {
  await withStore('readwrite', (s) => s.put(rec, name))
}

/**
 * How many inboxes this device keeps. Needs nothing secret, says nothing about
 * which inboxes they are, and never creates the database.
 */
export async function countKept(): Promise<number> {
  return (await allKeys()).filter(isRecord).length
}

/** Deletes everything kept on this device, remembered words too, without needing them: the owner's "Forget it". */
export function forgetAllKept(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(new KeptError('unavailable', req.error))
    req.onblocked = () => resolve() // done once the other tab lets go
  })
}

/** Deletes this inbox's record and its remembered words, and the database too once nothing else is kept in it. */
export async function deleteKept(name: string): Promise<void> {
  // All together, so remembered words can never outlive the inbox they open.
  await inTx(
    'readwrite',
    (s) => {
      s.delete(name)
      s.delete(WORDS + name)
      s.delete(SEALED + name)
      s.delete(LABEL + name)
    },
    false,
  )
  const left = await withStore('readonly', (s) => s.count())
  if (left === 0) {
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(DB_NAME)
      req.onsuccess = req.onerror = req.onblocked = () => resolve()
    })
  }
}

/**
 * Holds the right to save this inbox's record, so two tabs with the same
 * inbox open can't overwrite each other's changes. Resolves with a release
 * function, or undefined if another tab holds it. Browsers without Web Locks
 * just carry on.
 */
export function holdKept(name: string): Promise<(() => void) | undefined> {
  const locks = (navigator as Navigator & { locks?: LockManager }).locks
  if (!locks) return Promise.resolve(() => {})
  return new Promise((resolve) => {
    locks
      .request(`slynk-kept-${name}`, { ifAvailable: true }, (lock) => {
        if (!lock) return resolve(undefined)
        return new Promise<void>((release) => resolve(() => release()))
      })
      .catch(() => resolve(() => {}))
  })
}
