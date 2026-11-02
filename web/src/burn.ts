// One-time and expiring links: the extra encryption layer, and the client for
// slynk.me's key server (core/cmd/keyserver; site.ts KEY_SERVER). Background:
// docs/findings/one-time-links.md. WebCrypto only.
//
// The item is sealed with AES-GCM under K = HKDF-SHA256(L || S). L lives only in
// the link and S only on slynk.me, which never sees L, the link or the item.
// Deleting S burns the link, even though the sealed pieces stay on the mixnet
// until it sweeps them.
//
// Sender:     prepareShare() as soon as the composer has something to send:
//             it makes the next link's share and solves slynk.me's puzzle
//             (pow/) in the background while the person is still writing.
//             Nothing is sent until protect(envelope, mode, ttl), which
//             stores S on slynk.me and seals the envelope. Do that right
//             before uploading (once connected, so the link's sent time
//             follows within a few minutes: slynk.me counts the expiry from
//             the put), so a server that's down fails fast. Upload the sealed
//             bytes, then buildLinkV2(v1, mode, ttl, share.L). If the upload
//             fails, or for "Cancel this link": revoke(share). Show
//             CANCEL_EXPIRED rather than any answer once the link's own
//             expiry has passed.
// Recipient:  for a one-time link, on the opener's tap and before joining the
//             mixnet: reserve(link, nonce). It holds the link for 15 minutes
//             and hands nothing out, so others who have the link are turned
//             away ('held', or 'used-or-cancelled' once it's opened) without
//             downloading it. Then download the v1 link inside as usual, which
//             uses nothing up, and unlock(link, sealed, nonce). It claims
//             (one-time) or gets (expiring) S, opens the item and, for one-time
//             links, tells slynk.me it can delete S. Keep one nonce per tab
//             (newNonce()) and reuse it for retries: if a claim got through but
//             its answer was lost, only that nonce can ask again, for 10
//             minutes.
import { MAX_PAYLOAD, SEAL_OVERHEAD } from './payload.ts'
import { MAX_TTL_HOURS, fromBase64url, linkV2Times, toBase64url, type LinkMode, type LinkV2 } from './linkv2.ts'
import { solveInBackground } from './pow/index.ts'
import { ENDPOINT } from './home.ts'
import { MAX_BITS, NONCE_BYTES, WINDOW_S, windowAt } from './pow/puzzle.ts'

/** Every request and every response has exactly this many bytes (must match the key server's). */
export const REQUEST_BYTES = 256
export const RESPONSE_BYTES = 128

const SECRET_BYTES = 32 // L
const SHARE_BYTES = 32 // S
const ID_BYTES = 16
const TOKEN_BYTES = 16 // claim nonces and cancel tokens
const IV_BYTES = 12
const TAG_BYTES = 16

/** What sealing adds (IV_BYTES + TAG_BYTES): counted in payload.ts, beside the limit it comes out of. */
export { SEAL_OVERHEAD }
/** The largest envelope a one-time or expiring link can carry, for the size meter. */
export const MAX_PAYLOAD_SEALED = MAX_PAYLOAD - SEAL_OVERHEAD

// Fixed, versioned labels. Changing any of them breaks every existing link.
const enc = new TextEncoder()
const SALT = enc.encode('slynk/v2/salt')
const ID_INFO = enc.encode('slynk/v2/id')
const KEY_INFO = enc.encode('slynk/v2/key')
const AAD = enc.encode('slynk/v2/aad')

const MODE_NUMBERS: Record<LinkMode, number> = { expiring: 1, 'one-time': 2 }
const RETRY_DELAY_MS = 1000
/** ID and nonce of every claim this tab has sent (memory only, gone with the tab). */
const claimsSent = new Set<string>()
/** The mean gap between cover requests that slynk.me's latest answer asked for, in seconds (the key server's -cover-gap). */
let advised: number | undefined

/** The puzzle's difficulty until slynk.me's first answer says (the key server's -pow-bits, which every answer carries). */
export const DEFAULT_POW_BITS = 20
/**
 * A puzzle is solved for the window this long ago, so one solved just as a
 * new window starts is still taken if slynk.me's clock (as this page last
 * heard it) is a little behind. slynk.me takes a solution in its window and
 * the one after.
 */
const WINDOW_MARGIN_MS = 30_000
/** A solution must stay good this much longer, or it's solved again before the put. */
const STILL_GOOD_MS = 60_000
/** The difficulty slynk.me's latest answer asked for ("d"). */
let advisedBits: number | undefined
/** Milliseconds to add to this device's clock for slynk.me's, from its latest answer ("t"). */
let clockOffset = 0
/** Each share's puzzle: the window and difficulty it's solved for, and its nonce once found. */
const work = new WeakMap<Share, { window: number; bits: number; nonce: Promise<Uint8Array> }>()
/** The next link's share, made early by prepareShare(), until protect() takes it. */
let pending: Promise<Share> | undefined
let refresh: ReturnType<typeof setTimeout> | undefined
/** What prepareShare() was last told about the page being busy, and whether a re-solve is waiting for it. */
let pageBusy: () => boolean = () => false
let resolveDue = false

export interface Share {
  /** Half of the key, for the link only. */
  L: Uint8Array
  /** The other half, for slynk.me only. */
  S: Uint8Array
  /** What slynk.me files S under, derived from L. */
  id: Uint8Array
  /** Lets this tab cancel the link. Never in the link; slynk.me keeps only its hash. */
  cancelToken: Uint8Array
}

/**
 * Why a call failed.
 * - used-or-cancelled: a one-time link was already opened, or the link was cancelled
 * - lost: as used-or-cancelled, but the key server restarted without its shares
 *   lately (a crash), so the link may have been lost then instead
 * - expired: the link is past its expiry
 * - unreachable: no usable answer (offline, timed out, slynk.me down or answering
 *   unexpectedly). A claim may still have got through: retry with the same nonce.
 * - malformed: slynk.me refused the request as malformed
 * - busy (put only): too many links being made right now, the store is full, or
 *   slynk.me refused the puzzle's solution even after it was solved again
 * - exists (put only): the ID is taken, which a fresh share never hits
 * - held (one-time): someone else tapped to open it in the last 15 minutes
 */
export type Failure = 'used-or-cancelled' | 'lost' | 'expired' | 'unreachable' | 'malformed' | 'busy' | 'exists' | 'held'
export type Result = { ok: true } | { ok: false; reason: Failure }
export type ShareResult = { ok: true; S: Uint8Array } | { ok: false; reason: Failure }
/**
 * deleted: for one-time links, settles once slynk.me has been told it can
 * delete S (which may wait for a cover slot), to whether it confirmed that.
 */
export type UnlockResult =
  | { ok: true; envelope: Uint8Array; deleted: Promise<boolean> }
  | { ok: false; reason: Failure | 'damaged' }
export type ProtectResult = { ok: true; share: Share; sealed: Uint8Array } | { ok: false; reason: Failure }

export interface NetOptions {
  /** Defaults to ENDPOINT on this site. */
  endpoint?: string
  /** Per attempt. Defaults to 10 s. */
  timeoutMs?: number
  /** Attempts when there's no usable answer. Defaults to 3. Every attempt sends the same body, which is safe. */
  attempts?: number
  /**
   * While cover requests run (burnCover.ts): 'now', or 'slot' to go in place of
   * the next cover request, so it adds nothing to a visit's count and makes no
   * pair with the request before it. Defaults to 'slot' for done, which nobody
   * waits on, and 'now' for the rest: someone is waiting on those, and a cancel
   * must take effect at once. In a hidden tab, 'now' waits for a slot too.
   */
  when?: 'now' | 'slot'
  /** Epoch ms: if the request waited for a slot until this time, it isn't sent, and the link counts as expired. */
  notAfter?: number
}

/** Decides when a request may go; burnCover.ts sets it. Without one, every request goes at once. */
export type Pacer = (when: 'now' | 'slot') => Promise<void>
let pacer: Pacer | undefined

export function setPacer(p: Pacer | undefined): void {
  pacer = p
}

// --- Keys and sealing -----------------------------------------------------------

export async function makeShare(): Promise<Share> {
  const L = random(SECRET_BYTES)
  return { L, S: random(SHARE_BYTES), id: await deriveId(L), cancelToken: random(TOKEN_BYTES) }
}

/** A claim nonce. Make one per tab and link, and reuse it for every retry. */
export function newNonce(): Uint8Array {
  return random(TOKEN_BYTES)
}

/** The share ID slynk.me knows: HKDF-SHA256(L), 16 bytes. */
export async function deriveId(L: Uint8Array): Promise<Uint8Array> {
  checkLength(L, SECRET_BYTES, 'L')
  const base = await crypto.subtle.importKey('raw', bytes(L), 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: SALT, info: ID_INFO }, base, ID_BYTES * 8)
  return new Uint8Array(bits)
}

async function deriveKey(L: Uint8Array, S: Uint8Array): Promise<CryptoKey> {
  checkLength(L, SECRET_BYTES, 'L')
  checkLength(S, SHARE_BYTES, 'S')
  const ikm = new Uint8Array(SECRET_BYTES + SHARE_BYTES)
  ikm.set(L)
  ikm.set(S, SECRET_BYTES)
  try {
    const base = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveKey'])
    return await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: SALT, info: KEY_INFO },
      base,
      { name: 'AES-GCM', length: 256 },
      false, // not extractable: the key never comes back into JavaScript
      ['encrypt', 'decrypt'],
    )
  } finally {
    ikm.fill(0)
  }
}

/** nonce(12) || AES-256-GCM(K, envelope). Adds SEAL_OVERHEAD bytes. */
export async function seal(envelope: Uint8Array, L: Uint8Array, S: Uint8Array): Promise<Uint8Array> {
  if (envelope.length > MAX_PAYLOAD_SEALED) throw new RangeError('Too large for a one-time or expiring link.')
  const key = await deriveKey(L, S)
  const iv = random(IV_BYTES)
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AAD, tagLength: TAG_BYTES * 8 }, key, bytes(envelope))
  const out = new Uint8Array(IV_BYTES + ct.byteLength)
  out.set(iv)
  out.set(new Uint8Array(ct), IV_BYTES)
  return out
}

/** Reverses seal. Throws SealError if anything was changed or a half of the key is wrong. */
export async function open(sealed: Uint8Array, L: Uint8Array, S: Uint8Array): Promise<Uint8Array> {
  if (sealed.length < SEAL_OVERHEAD) throw new SealError()
  const key = await deriveKey(L, S)
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes(sealed.subarray(0, IV_BYTES)), additionalData: AAD, tagLength: TAG_BYTES * 8 },
      key,
      bytes(sealed.subarray(IV_BYTES)),
    )
    return new Uint8Array(plain)
  } catch {
    throw new SealError()
  }
}

export class SealError extends Error {
  constructor() {
    super('This item couldn’t be unlocked: the link or the data is damaged.')
    this.name = 'SealError'
  }
}

/** Overwrites key material with zeros once it's no longer needed. */
export function wipe(...arrays: Uint8Array[]) {
  for (const a of arrays) a.fill(0)
}

// --- Sender -----------------------------------------------------------------------

/**
 * Readies the next link's share and starts on its puzzle, while the person is
 * still writing, so Send rarely waits for it. Call it whenever the composer
 * gets something to send: until protect() takes the share, calling it again
 * does nothing new. Nothing goes to slynk.me until then. While it waits, the
 * puzzle is solved again as each window passes (about 1 s of work every 10
 * minutes), so the solution is always good when Send comes. busy: whether
 * the page is doing heavy work (main.ts: making a video smaller); a re-solve
 * that falls due meanwhile waits for the next call, which the page makes
 * once it's idle. Returns the share protect() will use, for tests.
 */
export function prepareShare(busy: () => boolean = () => false): Promise<Share> {
  pageBusy = busy
  if (pending) {
    const p = pending
    if (resolveDue) {
      resolveDue = false
      void p.then((share) => pending === p && keepSolved(share, p))
    }
    return p
  }
  const p: Promise<Share> = makeShare().then((share) => {
    keepSolved(share, p)
    return share
  })
  pending = p
  p.catch(() => {
    if (pending === p) pending = undefined
  })
  return p
}

function keepSolved(share: Share, p: Promise<Share>) {
  const w = solveFor(share, WINDOW_S * 1000)
  clearTimeout(refresh)
  // When it becomes the window before, so there's always a whole window left.
  const at = (w.window + 1) * WINDOW_S * 1000 + WINDOW_MARGIN_MS
  refresh = setTimeout(() => {
    if (pending !== p) return
    if (pageBusy()) resolveDue = true // the next prepareShare() solves it, once the page is idle
    else keepSolved(share, p)
  }, Math.min(Math.max(0, at - serverNow()), WINDOW_S * 1000))
  ;(refresh as { unref?: () => void }).unref?.() // in tests (Node), so it never keeps a finished test running
}

/** The share prepareShare() made, or a fresh one. */
async function takeShare(): Promise<Share> {
  const p = pending
  pending = undefined
  resolveDue = false
  clearTimeout(refresh)
  return (p && (await p.catch(() => undefined))) || makeShare()
}

/** The puzzle's difficulty now: slynk.me's latest, kept within what this page will try. */
export function puzzleBits(): number {
  const d = advisedBits ?? DEFAULT_POW_BITS
  return Math.min(MAX_BITS, Math.max(0, d))
}

/** slynk.me's time as this page last heard it, in epoch ms. */
export function serverNow(): number {
  return Date.now() + clockOffset
}

/** The last moment slynk.me takes a solution for this window: the end of the next one. */
const goodUntil = (window: number) => (window + 2) * WINDOW_S * 1000

/** This share's puzzle, solved or being solved: the one in hand if it's still good for minGoodMs, or a new one. */
function solveFor(share: Share, minGoodMs: number) {
  const bits = puzzleBits()
  const now = serverNow()
  const have = work.get(share)
  if (have && have.bits >= bits && goodUntil(have.window) - now >= minGoodMs) return have
  const window = windowAt(now - WINDOW_MARGIN_MS)
  const w = { window, bits, nonce: solveInBackground(share.id, window, bits) }
  work.set(share, w)
  return w
}

/** Stores a share on slynk.me (the one prepareShare() readied, or a fresh one), then seals the envelope with it. S is wiped afterwards. */
export async function protect(envelope: Uint8Array, mode: LinkMode, ttlHours: number, net?: NetOptions): Promise<ProtectResult> {
  if (envelope.length > MAX_PAYLOAD_SEALED) throw new RangeError('Too large for a one-time or expiring link.')
  const share = await takeShare()
  const stored = result(await putAnswer(share, mode, ttlHours, net))
  if (!stored.ok) {
    wipe(share.L, share.S, share.cancelToken)
    return stored
  }
  const sealed = await seal(envelope, share.L, share.S)
  wipe(share.S) // only L (for the link), the ID and the cancel token are still needed
  return { ok: true, share, sealed }
}

export async function put(share: Share, mode: LinkMode, ttlHours: number, net?: NetOptions): Promise<Result> {
  return result(await putAnswer(share, mode, ttlHours, net))
}

/** put's answer from slynk.me, as it came (protect() needs to tell "full" from the rest of "busy"). */
async function putAnswer(share: Share, mode: LinkMode, ttlHours: number, net?: NetOptions): Promise<Answer | null> {
  if (!Object.hasOwn(MODE_NUMBERS, mode)) throw new TypeError(`Unknown link mode: ${String(mode)}`)
  if (!Number.isInteger(ttlHours) || ttlHours < 1 || ttlHours > MAX_TTL_HOURS) throw new RangeError('ttlHours must be 1 to 500')
  const fields = {
    id: b64(share.id, ID_BYTES),
    s: b64(share.S, SHARE_BYTES),
    r: b64(share.cancelToken, TOKEN_BYTES),
    m: MODE_NUMBERS[mode],
    t: ttlHours,
  }
  let answer: Answer | null = null
  for (let i = 0; i < 2; i++) {
    // Solved before asking the cover pacer for a slot, so the wait for a slot
    // is the same as ever. A second time only if slynk.me refused the
    // solution: its answer said how hard, and its time, so solve that.
    const nonce = await solveFor(share, i === 0 ? STILL_GOOD_MS : Infinity).nonce
    answer = await call('put', { ...fields, w: b64(nonce, NONCE_BYTES) }, net)
    if (answer?.st !== 'work') break
  }
  return answer
}

/** "Cancel this link". Needs the cancel token, which only the sender's tab has. */
export async function revoke(share: Pick<Share, 'id' | 'cancelToken'>, net?: NetOptions): Promise<Result> {
  return result(await call('revoke', { id: b64(share.id, ID_BYTES), r: b64(share.cancelToken, TOKEN_BYTES) }, net))
}

// --- Recipient --------------------------------------------------------------------

/** One-time links: keeps others out for 15 minutes while this nonce downloads. Hands nothing out. */
export async function hold(id: Uint8Array, nonce: Uint8Array, net?: NetOptions): Promise<Result> {
  return result(await call('hold', { id: b64(id, ID_BYTES), c: b64(nonce, TOKEN_BYTES) }, net))
}

/**
 * The opener's tap on a one-time link, before the download: holds it for this
 * tab's nonce, or says why it can't be opened. A link past its own expiry is
 * refused without asking slynk.me, as in unlock.
 */
export async function reserve(link: LinkV2, nonce: Uint8Array, net?: NetOptions): Promise<Result> {
  if (link.mode !== 'one-time') throw new TypeError('Only one-time links are reserved.')
  // Copies first: the page may wipe the originals if another link arrives meanwhile.
  const c = nonce.slice()
  const secret = link.secret.slice()
  const expires = linkV2Times(link).expires.getTime()
  if (Date.now() >= expires) return { ok: false, reason: 'expired' }
  try {
    return await hold(await deriveId(secret), c, { ...net, notAfter: expires })
  } finally {
    wipe(c, secret)
  }
}

/** One-time links: hands S over once, to this nonce. Only call it after a click. */
export async function claim(id: Uint8Array, nonce: Uint8Array, net?: NetOptions): Promise<ShareResult> {
  return shareResult(await call('claim', { id: b64(id, ID_BYTES), c: b64(nonce, TOKEN_BYTES) }, net))
}

/** Expiring links: hands S over without using it up. */
export async function get(id: Uint8Array, net?: NetOptions): Promise<ShareResult> {
  return shareResult(await call('get', { id: b64(id, ID_BYTES) }, net))
}

/** One-time links: the claimer has S, so slynk.me can delete it now rather than at its next clean-up. */
export async function done(id: Uint8Array, nonce: Uint8Array, net?: NetOptions): Promise<Result> {
  return result(await call('done', { id: b64(id, ID_BYTES), c: b64(nonce, TOKEN_BYTES) }, net))
}

/**
 * Fetches S for a downloaded v2 link and opens the sealed item. For a one-time
 * link this uses it up, so call it only from a click after the download, with
 * this tab's nonce.
 *
 * A link past its own expiry (sent + ttl, by this device's clock) is refused
 * here without asking slynk.me, which keeps the share a few minutes longer to
 * allow for the sender's clock (ExpiryGrace in core/keyserver). So the page never opens
 * a link after the time the sender was shown, and never uses up an expired one.
 */
export async function unlock(link: LinkV2, sealed: Uint8Array, nonce?: Uint8Array, net?: NetOptions): Promise<UnlockResult> {
  if (link.mode === 'one-time' && !nonce) throw new TypeError('A one-time link needs this tab’s claim nonce.')
  const id = await deriveId(link.secret)
  const claimKey = nonce ? toBase64url(id) + toBase64url(nonce) : ''
  // A claim this tab already sent may have used the link up with its answer
  // lost, so its retry goes ahead even if the expiry has passed meanwhile.
  const retrying = link.mode === 'one-time' && claimsSent.has(claimKey)
  const expires = linkV2Times(link).expires.getTime()
  if (!retrying && Date.now() >= expires) return { ok: false, reason: 'expired' }
  // Checked again if the claim waits for a cover slot (in a hidden tab).
  const deadline = { ...net, notAfter: retrying ? undefined : expires }
  // Too short to be anything seal made: don't use the link up finding that out.
  if (sealed.length < SEAL_OVERHEAD) return { ok: false, reason: 'damaged' }
  let got: ShareResult
  if (link.mode === 'one-time' && nonce) {
    claimsSent.add(claimKey)
    got = await claim(id, nonce, deadline)
    // "held" and "expired" are definite noes (or it was never sent, its slot coming too late):
    // this claim used nothing, so its retry gets no expiry leeway.
    if (!got.ok && (got.reason === 'held' || got.reason === 'expired')) claimsSent.delete(claimKey)
  } else {
    got = await get(id, deadline)
  }
  if (!got.ok) return got
  let envelope: Uint8Array
  try {
    envelope = await open(sealed, link.secret, got.S)
  } catch {
    return { ok: false, reason: 'damaged' }
  } finally {
    wipe(got.S)
  }
  let deleted = Promise.resolve(false)
  if (link.mode === 'one-time' && nonce) {
    // Not awaited: done may wait for a cover slot, and the item is open already.
    // A copy of the nonce, as the page wipes its own once this returns. "gone"
    // here means there's no claim under our nonce any more, though we made one:
    // an earlier done got through with its answer lost, or the clean-up retired
    // the claim. Either way S has been deleted.
    const c = nonce.slice()
    deleted = done(id, c, net)
      .then((d) => d.ok || d.reason === 'used-or-cancelled' || d.reason === 'lost')
      .finally(() => wipe(c))
  }
  return { ok: true, envelope, deleted }
}

// --- Talking to the key server --------------------------------------------------------

/** r: the key server restarted without its shares lately (a crash), so a link may have been lost. */
type Answer = { st: string; s: string; r: boolean }

/** The mean gap between cover requests that slynk.me last asked for, in seconds, if any answer has said yet. */
export function advisedGap(): number | undefined {
  return advised
}

/** The exact request body: the fields, padded with dots to REQUEST_BYTES. */
export function requestBody(op: string, fields: Record<string, string | number>): string {
  const head = JSON.stringify({ v: 1, op, ...fields }).slice(0, -1) + ',"p":"'
  const room = REQUEST_BYTES - head.length - 2
  if (room < 0) throw new RangeError('request too large')
  return head + '.'.repeat(room) + '"}'
}

/** A cover request (burnCover.ts): a hold on a random ID with a random nonce, sent as a real one is, at once. */
export async function coverHold(net?: NetOptions): Promise<void> {
  await call('hold', { id: b64(random(ID_BYTES), ID_BYTES), c: b64(random(TOKEN_BYTES), TOKEN_BYTES) }, net, false)
}

async function call(op: string, fields: Record<string, string | number>, net: NetOptions = {}, paced = true): Promise<Answer | null> {
  const body = requestBody(op, fields)
  const attempts = Math.max(1, net.attempts ?? 3)
  if (paced && pacer) await pacer(net.when ?? (op === 'done' ? 'slot' : 'now'))
  if (net.notAfter !== undefined && Date.now() >= net.notAfter) return { st: 'expired', s: '', r: false }
  let answer: Answer | null = null
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * i))
    answer = await post(net.endpoint ?? ENDPOINT, body, net.timeoutMs ?? 10_000)
    if (answer && answer.st !== 'down') break
  }
  return answer
}

async function post(endpoint: string, body: string, timeoutMs: number): Promise<Answer | null> {
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      // A string body goes as text/plain, which a browser sends to another
      // origin without first asking (a CORS preflight): one request, not two.
      body,
      credentials: 'omit',
      keepalive: true, // a done or a cancel still goes if the tab closes meanwhile
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await res.text()
    // The key server answers every POST with 200, the outcome only in "st", so
    // an access log can't tell outcomes apart. Anything else (an error page from
    // something in between) isn't the key server.
    if (res.status !== 200 || text.length !== RESPONSE_BYTES) return null
    const j: unknown = JSON.parse(text)
    if (typeof j !== 'object' || j === null) return null
    const { v, st, s, g, d, t, r } = j as Record<string, unknown>
    if (v !== 1 || typeof st !== 'string' || typeof s !== 'string') return null
    if (typeof g === 'number' && Number.isFinite(g)) advised = g
    if (typeof d === 'number' && Number.isInteger(d)) advisedBits = d
    if (typeof t === 'number' && Number.isFinite(t)) clockOffset = t * 1000 - Date.now()
    return { st, s, r: r === 1 }
  } catch {
    return null
  }
}

function result(a: Answer | null): Result {
  return a?.st === 'ok' ? { ok: true } : { ok: false, reason: failure(a) }
}

function shareResult(a: Answer | null): ShareResult {
  if (a?.st !== 'ok') return { ok: false, reason: failure(a) }
  try {
    const S = fromBase64url(a.s)
    if (S.length === SHARE_BYTES) return { ok: true, S }
  } catch {
    // fall through
  }
  return { ok: false, reason: 'unreachable' }
}

function failure(a: Answer | null): Failure {
  switch (a?.st) {
    case 'gone':
      return a?.r ? 'lost' : 'used-or-cancelled'
    case 'expired':
      return 'expired'
    case 'exists':
      return 'exists'
    case 'held':
      return 'held'
    case 'slow':
    case 'full':
    case 'work':
      return 'busy'
    case 'bad':
    case 'method':
      return 'malformed'
    default:
      return 'unreachable'
  }
}

// --- Small helpers ------------------------------------------------------------------

function random(n: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(n))
}

function b64(a: Uint8Array, n: number): string {
  checkLength(a, n, 'value')
  return toBase64url(a)
}

function checkLength(a: Uint8Array, n: number, what: string) {
  if (!(a instanceof Uint8Array) || a.length !== n) throw new TypeError(`${what} must be ${n} bytes`)
}

// WebCrypto wants views over a plain ArrayBuffer; copy only when it isn't one.
function bytes(a: Uint8Array): Uint8Array<ArrayBuffer> {
  return a.buffer instanceof ArrayBuffer ? (a as Uint8Array<ArrayBuffer>) : new Uint8Array(a)
}
