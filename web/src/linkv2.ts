// Link format v2, for one-time and expiring links (docs/findings/link-and-envelope-format.md).
//
// An ordinary link is the core's 148-byte v1 link (core/transfer/link.go),
// unchanged. A v2 link wraps it and adds what the page needs to unlock the
// extra encryption layer in burn.ts:
//
//   version(1)=2  mode(1)  ttlHours(2)  v1 link without its version byte(147)  L(32)
//
// 183 bytes: exactly 244 base64url characters after the #, against 198 for v1.
// The v1 version byte is always 1, so it isn't repeated. The share ID that
// slynk.me knows is derived from L (burn.ts), so it isn't stored either.
// Numbers are big-endian, like the v1 link.
//
// Password links (password.ts) set the top bit of the first byte, in either
// format: 0x81 is an ordinary link and 0x82 a v2 link that needs a password.
// Nothing else changes, so the link stays the same length; the salt travels
// with the data. Pages from before passwords refuse both as damaged or newer.
//
// A v2 link whose envelope has Brotli items (payload.ts, since 2026-10-26) sets
// the top bit of its mode byte: 0x82 is a one-time link that needs a page that
// reads Brotli. A page from before refuses the mode as "made by a newer version"
// before it holds or claims anything, so it can't use up a one-time link it
// couldn't open (the review, 2026-10-26).
//
// One whose envelope has more items than pages before 200 files read
// (payload.ts ITEMS_BEFORE, 2026-10-26) sets the mode byte's next bit too: every
// page before it, those that read Brotli included, refuses it the same way.
import { LINK_LENGTH, linkTimes } from './payload.ts'
import { SITE_NAME } from './site.ts'

export const LINK_V2_VERSION = 2
/** Set on a link's first byte when it needs a password. */
export const PASSWORD_FLAG = 0x80
/** Set on a v2 link's mode byte when what it carries needs a page that reads Brotli. */
export const BROTLI_FLAG = 0x80
/** Set on a v2 link's mode byte when what it carries has more than 51 items (up to 201 since 2026-10-26). */
export const MANY_FLAG = 0x40
export const LINK_V2_LENGTH = 1 + 1 + 2 + (LINK_LENGTH - 1) + 32
export const SECRET_LENGTH = 32
/** The longest a link can last: about how long the mixnet keeps data. */
export const MAX_TTL_HOURS = 500
/** The sender's expiry choices: 1 hour, 1 day, 7 days, 3 weeks. */
export const EXPIRY_HOURS = [1, 24, 168, 500] as const

/** expiring: works until it expires or is cancelled. one-time: also used up by its first opening. */
export type LinkMode = 'expiring' | 'one-time'
/** What the sender picked. Ordinary links are plain v1 links and leave nothing on slynk.me. */
export type LinkKind = 'ordinary' | LinkMode

const MODE_BYTES: Record<LinkMode, number> = { expiring: 1, 'one-time': 2 }
const V1_VERSION = 1
const SENT_OFFSET = 66 // in a v1 link: unix nanoseconds, after version, file ID and recipient ID
const MAX_FRAGMENT = 1024 // characters; real links have 198 or 244

export interface LinkV2 {
  mode: LinkMode
  ttlHours: number
  /** The ordinary link inside, for core.download. */
  v1: Uint8Array
  /** L: half of the key. It lives only in the link. */
  secret: Uint8Array
  /** What it carries is locked with a password too. */
  password: boolean
  /** What it carries has Brotli in it: older pages refuse the link before using it. */
  brotli?: boolean
  /** What it carries has more than 51 items: older pages refuse the link before using it. */
  many?: boolean
}

/** password: what it carries is locked with a password (password.ts). */
export type ParsedLink =
  | { kind: 'ordinary'; v1: Uint8Array; password: boolean; sent: Date; expires: Date }
  | { kind: LinkMode; v1: Uint8Array; link: LinkV2; password: boolean; sent: Date; expires: Date }

export type LinkErrorCode = 'encoding' | 'length' | 'version' | 'mode' | 'ttl' | 'secret' | 'link'

/** A link that can't be used. `message` is fit to show; `code` says what was wrong. */
export class LinkError extends Error {
  readonly code: LinkErrorCode
  constructor(code: LinkErrorCode, message: string) {
    super(message)
    this.name = 'LinkError'
    this.code = code
  }
}

const DAMAGED = 'This link looks damaged or incomplete. Ask the sender to copy it again.'

/** Which kind of link a sender's choices make. A 3-week link that isn't one-time is ordinary. */
export function linkKindFor(expiryHours: number, oneTime: boolean): LinkKind {
  if (oneTime) return 'one-time'
  return expiryHours >= MAX_TTL_HOURS ? 'ordinary' : 'expiring'
}

export function buildLinkV2(v1: Uint8Array, mode: LinkMode, ttlHours: number, secret: Uint8Array, password = false, brotli = false, many = false): Uint8Array {
  checkV1(v1)
  if (!Object.hasOwn(MODE_BYTES, mode)) throw new LinkError('mode', `Unknown link mode: ${String(mode)}`)
  checkTtl(ttlHours)
  checkSecret(secret)
  const out = new Uint8Array(LINK_V2_LENGTH)
  out[0] = LINK_V2_VERSION | (password ? PASSWORD_FLAG : 0)
  out[1] = MODE_BYTES[mode] | (brotli ? BROTLI_FLAG : 0) | (many ? MANY_FLAG : 0)
  out[2] = ttlHours >> 8
  out[3] = ttlHours & 0xff
  out.set(v1.subarray(1), 4)
  out.set(secret, 4 + LINK_LENGTH - 1)
  return out
}

/** An ordinary link that needs a password: the core's v1 link with the password flag set. */
export function passwordLinkV1(v1: Uint8Array): Uint8Array {
  checkV1(v1)
  const out = v1.slice()
  out[0] |= PASSWORD_FLAG
  return out
}

/** Reads a v2 link. The returned arrays are copies. Throws LinkError. */
export function parseLinkV2(bytes: Uint8Array): LinkV2 {
  if (bytes.length !== LINK_V2_LENGTH) throw new LinkError('length', DAMAGED)
  if ((bytes[0] & ~PASSWORD_FLAG) !== LINK_V2_VERSION) throw new LinkError('version', `This isn’t a one-time or expiring ${SITE_NAME} link.`)
  const mode = (Object.keys(MODE_BYTES) as LinkMode[]).find((m) => MODE_BYTES[m] === (bytes[1] & ~(BROTLI_FLAG | MANY_FLAG)))
  if (!mode) throw new LinkError('mode', `This link was made by a newer version of ${SITE_NAME}.`)
  const ttlHours = (bytes[2] << 8) | bytes[3]
  checkTtl(ttlHours)
  const v1 = new Uint8Array(LINK_LENGTH)
  v1[0] = V1_VERSION
  v1.set(bytes.subarray(4, 4 + LINK_LENGTH - 1), 1)
  checkV1(v1)
  const secret = bytes.slice(4 + LINK_LENGTH - 1)
  checkSecret(secret)
  return { mode, ttlHours, v1, secret, password: (bytes[0] & PASSWORD_FLAG) !== 0, brotli: (bytes[1] & BROTLI_FLAG) !== 0, many: (bytes[1] & MANY_FLAG) !== 0 }
}

/** The ordinary link inside a v2 link: what core.download takes. */
export function linkV2ToV1(link: LinkV2 | Uint8Array): Uint8Array {
  return (link instanceof Uint8Array ? parseLinkV2(link) : link).v1.slice()
}

/** When a v2 link was sent, and when it stops working (sent + its TTL). */
export function linkV2Times(link: LinkV2): { sent: Date; expires: Date } {
  const { sent } = linkTimes(link.v1)
  return { sent, expires: new Date(sent.getTime() + link.ttlHours * 3_600_000) }
}

/** Reads the fragment of any Slynk link, ordinary (v1) or v2. Throws LinkError. */
export function parseLinkFragment(fragment: string): ParsedLink {
  const text = fragment.replace(/^#/, '')
  // Anyone can craft a link: don't decode megabytes just to refuse them.
  if (text.length > MAX_FRAGMENT) throw new LinkError('length', DAMAGED)
  let bytes: Uint8Array
  try {
    bytes = fromBase64url(text)
  } catch {
    throw new LinkError('encoding', DAMAGED)
  }
  const version = bytes.length ? bytes[0] & ~PASSWORD_FLAG : 0
  const password = (bytes[0] & PASSWORD_FLAG) !== 0
  if (version === LINK_V2_VERSION) {
    const link = parseLinkV2(bytes)
    return { kind: link.mode, v1: link.v1, link, password, ...linkV2Times(link) }
  }
  if (bytes.length !== LINK_LENGTH) throw new LinkError('length', DAMAGED)
  if (version !== V1_VERSION) throw new LinkError('version', `This link was made by a newer version of ${SITE_NAME}.`)
  const v1 = bytes.slice()
  v1[0] = V1_VERSION
  checkV1(v1)
  return { kind: 'ordinary', v1, password, ...linkTimes(v1) }
}

function checkV1(v1: Uint8Array) {
  if (v1.length !== LINK_LENGTH || v1[0] !== V1_VERSION) throw new LinkError('link', DAMAGED)
  const sent = new DataView(v1.buffer, v1.byteOffset + SENT_OFFSET, 8).getBigUint64(0)
  if (sent === 0n) throw new LinkError('link', DAMAGED)
}

function checkTtl(ttlHours: number) {
  if (!Number.isInteger(ttlHours) || ttlHours < 1 || ttlHours > MAX_TTL_HOURS) {
    throw new LinkError('ttl', DAMAGED)
  }
}

function checkSecret(secret: Uint8Array) {
  if (secret.length !== SECRET_LENGTH || secret.every((b) => b === 0)) throw new LinkError('secret', DAMAGED)
}

// --- base64url, strict: no padding, no stray characters, one spelling per value ---

export function toBase64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromBase64url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) throw new Error('not base64url')
  const bytes = Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
  if (toBase64url(bytes) !== text) throw new Error('not canonical base64url')
  return bytes
}
