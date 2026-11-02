// Files and longer messages to an anonymous inbox, behind
// INBOX_FILES (site.ts). What fits one cMix message still goes as a single
// notice, as it always has. Anything else goes as an ordinary upload to a random
// pickup address, just as a link's would, and a notice to the inbox carries
// its plain v1 link: never a v2 one, so inboxes never depend on the key server. The
// owner's page collects it straight from the notice, never through a URL,
// so slynk.me's one-time rule still stops it being shared on as a link.
import { LINK_LENGTH, MAX_PAYLOAD, linkTimes } from '../payload.ts'
import { NOTICE_TEXT_MAX } from './address.ts'
import { fits } from './pack.ts'

/** A notice's kinds (core/transfer/inbox.go): a text message, or an upload's v1 link. */
export const NOTICE_TEXT = 1
export const NOTICE_FILE = 2

/** An upload to an inbox carries no one-time or password layer, so it has the whole limit. */
export const DROP_LIMIT = MAX_PAYLOAD

/**
 * Whether what's in the composer needs an upload, because it won't fit one
 * notice, packed (room: the address's, noticeTextMax, less any included
 * inbox). The notice announcing an upload carries its 148-byte link, which
 * fits either kind.
 */
export const needsUpload = (files: number, text: string, room = NOTICE_TEXT_MAX): boolean => files > 0 || !fits(text, room)

/** An upload announced to an inbox, as its owner's page reads it. */
export interface FileNotice {
  v1: Uint8Array // the upload's link: its key, so keep it in memory only
  size: number // bytes uploaded, as the sender's link says
  sent: Date
  expires: Date
}

/** The notice body that announces an upload: its v1 link and nothing else. */
export function fileNoticeBody(v1: Uint8Array): Uint8Array {
  if (v1.length !== LINK_LENGTH || v1[0] !== 1) throw new Error('not a plain v1 link')
  return v1.slice()
}

/**
 * Reads a file notice's body: a v1 link (148 bytes, version 1, with no
 * password flag), or undefined for anything else. The core already refuses
 * other bodies; anything after the link is ignored, so a later version may
 * add to it.
 */
export function readFileNotice(body: Uint8Array): FileNotice | undefined {
  if (body.length < LINK_LENGTH || body[0] !== 1) return undefined
  const v1 = body.slice(0, LINK_LENGTH)
  const size = new DataView(v1.buffer).getUint32(1 + 32 + 33 + 8 + 32 + 32)
  return { v1, size, ...linkTimes(v1) }
}

/**
 * What tells one announced upload from another: its random pickup address
 * (the link's recipient ID), so a notice sent again after an unconfirmed
 * send shows once. It holds nothing of the link's key, so a page that
 * doesn't collect uploads can keep it after wiping the link.
 */
export function uploadKey(body: Uint8Array): string | undefined {
  if (body.length < LINK_LENGTH || body[0] !== 1) return undefined
  let hex = ''
  for (const b of body.subarray(1 + 32, 1 + 32 + 33)) hex += b.toString(16).padStart(2, '0')
  return hex
}
