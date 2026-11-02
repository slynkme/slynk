// The size meter under the composer: exactly what the envelope will weigh on
// the wire, and roughly how long sending it takes.
import { MAX_PAYLOAD_SEALED } from '../burn.ts'
import { PASSWORD_OVERHEAD } from '../password.ts'
import { MAX_FILES, MAX_PAYLOAD } from '../payload.ts'
import { capitalize, countLabel, roughly, size } from './format.ts'

// Upload rates measured on mainnet, in the browser: about 8 KB a second with
// the default batches (8.2 for a full 2 MB on 2026-10-15, 8.7 for 250 KB on
// 2026-10-14; the native CLI manages about 10). "Uneven uploads" ran at about 6
// in the CLI and is untested in the browser, where it's probably nearer 5.
export const SEND_RATE = 8_200
export const SEND_RATE_VARIED = 6_000

/** The limit as people see it: "2 MB". */
export const LIMIT_TEXT = `${MAX_PAYLOAD / 1_000_000} MB`

/**
 * The most a link can carry. Each extra layer adds a few bytes inside the
 * limit (one-time and expiring 28, a password 45), so the upload never
 * exceeds MAX_PAYLOAD.
 */
export function limitFor(sealed: boolean, password: boolean): number {
  return (sealed ? MAX_PAYLOAD_SEALED : MAX_PAYLOAD) - (password ? PASSWORD_OVERHEAD : 0)
}

export interface MeterInput {
  wire: number // bytes on the wire (the whole envelope), 0 for nothing
  files: number
  messages: number
  varied: boolean
  pending: boolean // something is still being read or compressed
  limit?: number // bytes allowed for this kind of link: limitFor(…)
  /** Photos or videos are being made smaller to fit (the tray's run): over now, but not for long. */
  working?: boolean
}

export interface Meter {
  fill: number // percent of the limit
  over: boolean
  /** Over, but being made smaller to fit: shown calmly, not in red (a red "over by 137.63 MB" felt wrong for a video Slynk was already making fit). */
  working: boolean
  text: string
  eta: string
}

const WORKING_OUT = 'Working out the size…'

export function sendSeconds(wire: number, varied: boolean): number {
  return wire / (varied ? SEND_RATE_VARIED : SEND_RATE)
}

export function meter(m: MeterInput): Meter {
  const limit = m.limit ?? MAX_PAYLOAD
  const tooMany = m.files > MAX_FILES
  const over = m.wire > limit
  const fill = Math.min(100, (m.wire / limit) * 100)
  const count = m.files + m.messages
  let text = `0 KB of ${LIMIT_TEXT}`
  let eta = ''
  if (!tooMany && over && m.working) return { fill: 100, over: false, working: true, text: WORKING_OUT, eta: '' }
  if (tooMany) text = `${m.files} files: ${MAX_FILES} at most`
  else if (over) text = `${size(m.wire)}: over the ${LIMIT_TEXT} limit by ${size(m.wire - limit)}`
  else if (count) {
    text = `${size(m.wire)} of ${LIMIT_TEXT}`
    if (count > 1) text = `${capitalize(countLabel(m.files, m.messages))} · ${text}`
    eta = m.pending ? WORKING_OUT : `${roughly(sendSeconds(m.wire, m.varied))} to send`
  }
  return { fill, over: over || tooMany, working: false, text, eta }
}
