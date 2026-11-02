// Message text to an inbox, compressed as Haven compresses its messages:
// raw DEFLATE, when that's smaller. The core checks it
// unpacks before sending, and the owner's core unpacks it. Every notice is
// padded to the same size, so compression changes nothing anyone can see; it
// only fits more text. The meter and Send both use pack(), so what the meter
// says fits does.
import { deflateSync } from 'fflate'
import { NOTICE_TEXT_UNPACKED_MAX } from './address.ts'

export interface Packed {
  bytes: Uint8Array // what's sent
  compressed: boolean
  raw: number // the text's own bytes of UTF-8
}

/** The text as it would be sent: compressed when that's smaller. */
export function pack(text: string): Packed {
  const raw = new TextEncoder().encode(text)
  const packed = deflateSync(raw, { level: 9 })
  return packed.length < raw.length ? { bytes: packed, compressed: true, raw: raw.length } : { bytes: raw, compressed: false, raw: raw.length }
}

/**
 * Ordinary text packs to about this share of its bytes once there's enough
 * of it (an English letter of 1,800 characters packs into 924 bytes, Russian
 * likewise): what the meter reckons with until the message is long enough
 * to say for itself.
 */
const PACK_RATE = 0.55
/** From this many characters, the message's own rate, a little better since text packs better as it goes on. */
const OWN_RATE_FROM = 400

export interface Fill {
  used: number // bytes it takes, packed
  over: boolean // it doesn't fit
  chars: number // about how many more characters fit or, when over, how many too many
}

/** How full a message with room bytes is with this text, in characters of the script being typed. */
export function fill(text: string, room: number): Fill {
  const p = pack(text)
  const n = [...text].length
  const perRaw = n ? p.raw / n : 1 // bytes a character: 1 (English) to 4 (emoji)
  if (p.raw > NOTICE_TEXT_UNPACKED_MAX) return { used: p.bytes.length, over: true, chars: Math.ceil((p.raw - NOTICE_TEXT_UNPACKED_MAX) / perRaw) }
  const perChar = n >= OWN_RATE_FROM ? (p.bytes.length / n) * 0.85 : perRaw * PACK_RATE
  const left = room - p.bytes.length
  // However well it packs, no more than the core unpacks.
  const most = Math.floor((NOTICE_TEXT_UNPACKED_MAX - p.raw) / perRaw)
  return left >= 0
    ? { used: p.bytes.length, over: false, chars: Math.min(most, Math.floor(left / perChar)) }
    : { used: p.bytes.length, over: true, chars: Math.max(1, Math.ceil(-left / perChar)) }
}

/** Whether the text fits a message with room bytes. */
export const fits = (text: string, room: number): boolean => !fill(text, room).over
