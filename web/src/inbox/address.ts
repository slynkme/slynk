// Anonymous inbox addresses (core/transfer/inbox.go). Every inbox has two,
// from the same 12 words: its compact address, a version
// byte (3, after the link versions 1 and 2) and its 32-byte public key, and
// its quantum-safe one, version 4, which adds an ML-KEM-768 key and the
// inbox's signature on it (1,281 bytes in all). Either is base64url in a
// slynk.me link's fragment; a quantum-safe one may also be written as a
// decimal number, which makes its QR code smaller. An address holds no
// secret: it's what an inbox's owner publishes, and opening one only lets
// people write to it. The core checks the keys and the signature
// (inboxAddress) before an address is taken for an inbox the page knows.
import { fromBase64url, toBase64url } from '../linkv2.ts'

export const INBOX_ADDRESS_VERSION = 3
export const INBOX_ADDRESS_LENGTH = 33
export const INBOX_ADDRESS4_VERSION = 4
export const INBOX_ADDRESS4_LENGTH = 1281

/**
 * The most a message to an inbox carries, in bytes, after compression
 * (pack.ts): to a compact address, one cMix message (926 bytes, and 62 more
 * in its fingerprint and MAC fields) less the seal (48) and the notice's
 * header (16); to a quantum-safe one, two messages less the bigger seal
 * (1,308, with the tag that pairs them) and the header. The core refuses
 * anything longer (MaxNoticeBody, MaxNoticeBody4); with INBOX_FILES on,
 * longer ones go as uploads.
 */
export const NOTICE_TEXT_MAX = 924
export const NOTICE_TEXT_MAX_QS = 652

/** The most text a compressed message may stand for, in bytes of UTF-8 (the core's MaxNoticeText). */
export const NOTICE_TEXT_UNPACKED_MAX = 8192

/**
 * What including the sender's own inbox takes of that, before its name
 * (the core's FromOverhead): the compact address, the name's
 * length, and the 32-byte proof.
 */
export const FROM_OVERHEAD = INBOX_ADDRESS_LENGTH + 1 + 32

/**
 * Reply keys (the core's reply.go): what an inbox gives another
 * with a quantum-safe message that lets them reply, so their answer can be
 * quantum-safe too: an 8-byte token and a 32-byte key. Every quantum-safe
 * message including its sender's inbox carries them, which takes this much
 * more of its room.
 */
export const REPLY_KEYS_LENGTH = 40

/**
 * The most a reply sealed with reply keys carries (the core's
 * MaxReplyBody): one cMix message, as a compact one, less its seal (56: the
 * one-time key, the hidden token, the AEAD's tag) and the header.
 */
export const NOTICE_TEXT_MAX_REPLY = 916

/** Whether an address is an inbox's quantum-safe one. */
export const isQuantumSafe = (address: Uint8Array): boolean => address.length === INBOX_ADDRESS4_LENGTH && address[0] === INBOX_ADDRESS4_VERSION

/** The room a message to this address has, before any included inbox. */
export const noticeTextMax = (address: Uint8Array): number => (isQuantumSafe(address) ? NOTICE_TEXT_MAX_QS : NOTICE_TEXT_MAX)

/**
 * The room a message to this address has for its text, packed (pack.ts):
 * with the sender's inbox included or not (its name taking nameBytes), and,
 * with reply, sealed as a reply with the keys that inbox gave,
 * which only goes with the sender's inbox included. A quantum-safe message
 * (to a quantum-safe address, or a reply) including the sender's inbox
 * carries their reply keys too.
 */
export function textRoom(address: Uint8Array, include?: { nameBytes: number; reply?: boolean }): number {
  if (!include) return noticeTextMax(address)
  const keys = include.reply || isQuantumSafe(address) ? REPLY_KEYS_LENGTH : 0
  return (include.reply ? NOTICE_TEXT_MAX_REPLY : noticeTextMax(address)) - FROM_OVERHEAD - keys - include.nameBytes
}

/**
 * The compact address of the same inbox: what tells inboxes apart, whichever
 * address someone used. A quantum-safe address starts with it, but for its
 * version byte.
 */
export function compactAddress(address: Uint8Array): Uint8Array {
  if (!isQuantumSafe(address)) return address
  const compact = address.slice(0, INBOX_ADDRESS_LENGTH)
  compact[0] = INBOX_ADDRESS_VERSION
  return compact
}

/** Whether two addresses are the same inbox's, of either kind. */
export function sameInbox(a: Uint8Array, b: Uint8Array): boolean {
  const x = compactAddress(a)
  const y = compactAddress(b)
  return x.length === y.length && x.every((v, i) => v === y[i])
}

/**
 * How an address someone has compares with the one they're writing to ("Check
 * its address is correct"): the very same, the same inbox by its
 * other address, or another inbox. A quantum-safe address counts as the same
 * inbox only once the core has checked the inbox's signature on it, which is
 * for the caller (inbox/check.ts).
 */
export function compareAddresses(writing: Uint8Array, given: Uint8Array): 'same' | 'same-inbox' | 'other' {
  if (given.length === writing.length && given.every((b, i) => b === writing[i])) return 'same'
  return sameInbox(given, writing) ? 'same-inbox' : 'other'
}

/** Whether these bytes are an inbox's address, of either kind (before the core checks its keys). */
export const isInboxAddress = (b: unknown): b is Uint8Array =>
  b instanceof Uint8Array && ((b.length === INBOX_ADDRESS_LENGTH && b[0] === INBOX_ADDRESS_VERSION) || isQuantumSafe(b))

/** A quantum-safe address as one decimal number: its first byte is 4, so it's always this long. */
export const ADDRESS4_DIGITS = 3084

/** A quantum-safe address written as digits, for a smaller QR code. */
export function addressDigits(address: Uint8Array): string {
  let h = ''
  for (const b of address) h += b.toString(16).padStart(2, '0')
  return BigInt(`0x${h}`).toString(10)
}

/** Reads a quantum-safe address written as digits, or undefined. */
function fromDigits(digits: string): Uint8Array | undefined {
  if (digits.length !== ADDRESS4_DIGITS || !/^[0-9]+$/.test(digits)) return undefined
  const h = BigInt(digits).toString(16)
  if (h.length !== INBOX_ADDRESS4_LENGTH * 2 - 1) return undefined // its first byte, 4, is one hex digit
  const bytes = Uint8Array.from(`0${h}`.match(/../g)!, (x) => parseInt(x, 16))
  return isQuantumSafe(bytes) ? bytes : undefined
}

/** Routes to the inbox pages, reached from the footer and the About page. */
export const NEW_INBOX_ROUTE = '#/new-inbox'
export const OPEN_INBOX_ROUTE = '#/open-inbox'

export type InboxRoute = { kind: 'new-inbox' } | { kind: 'open-inbox' } | { kind: 'inbox'; address: Uint8Array }

/**
 * What a fragment means for the inbox, or undefined when it's anything else
 * (a link, or rubbish, for parseLinkFragment to judge). Read before links,
 * so an address is never mistaken for a damaged link, and whatever the
 * one-time rule (site.ts) says: the rule is about links.
 */
export function inboxRoute(fragment: string): InboxRoute | undefined {
  const body = fragment.replace(/^#/, '')
  if (`#${body}` === NEW_INBOX_ROUTE) return { kind: 'new-inbox' }
  if (`#${body}` === OPEN_INBOX_ROUTE) return { kind: 'open-inbox' }
  if (body.length === ADDRESS4_DIGITS) {
    const bytes = fromDigits(body)
    return bytes ? { kind: 'inbox', address: bytes } : undefined
  }
  if (body.length !== 44 && body.length !== 1708) return undefined
  let bytes: Uint8Array
  try {
    bytes = fromBase64url(body)
  } catch {
    return undefined
  }
  if (!isInboxAddress(bytes)) return undefined
  return { kind: 'inbox', address: bytes }
}

/** The link that opens an inbox's address, on this site or a copy of it. */
export function inboxLink(origin: string, address: Uint8Array): string {
  return `${origin}/#${toBase64url(address)}`
}

/**
 * What an address's QR code holds: its link, with a quantum-safe address
 * written as digits, which QR codes store more compactly (version 30 rather
 * than 35). The page reads either.
 */
export function inboxQrText(origin: string, address: Uint8Array): string {
  return isQuantumSafe(address) ? `${origin}/#${addressDigits(address)}` : inboxLink(origin, address)
}

/** Bytes of UTF-8 the text takes. */
export const textBytes = (text: string): number => new TextEncoder().encode(text).length

/**
 * An address typed or pasted by an owner who wants to write to another
 * inbox, or read from a QR code: a whole link, or just what follows the #.
 */
export function addressFromInput(text: string): Uint8Array | undefined {
  // A long link may come wrapped over several lines by the app it travelled in.
  const t = text.replace(/\s+/g, '')
  const hash = t.lastIndexOf('#')
  const route = inboxRoute(hash >= 0 ? t.slice(hash) : `#${t}`)
  return route?.kind === 'inbox' ? route.address : undefined
}
