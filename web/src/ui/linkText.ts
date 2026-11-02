// What the page says about one-time and expiring links: times in words, and
// which wording fits each answer from slynk.me (burn.ts). Kept out of main.ts
// so it can be tested.
import type { Failure, Result } from '../burn.ts'
import * as copy from '../burnCopy.ts'
import * as pwCopy from '../passwordCopy.ts'
import { MAX_TTL_HOURS, type LinkMode } from '../linkv2.ts'
import { ago, day } from './format.ts'

/** "14:05", in the visitor's own clock format. */
function clock(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

/** Calendar days from now to date, in local time: 0 is today, 1 tomorrow. */
function daysAhead(date: Date, now: Date): number {
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  return Math.round((midnight(date) - midnight(now)) / 86_400_000)
}

/** For "stops working …": "at 14:05", "tomorrow at 14:05", "on Thu 22 Oct at 14:05". */
export function atTime(date: Date, now = new Date()): string {
  const days = daysAhead(date, now)
  if (days === 0) return `at ${clock(date)}`
  if (days === 1) return `tomorrow at ${clock(date)}`
  return `on ${day(date)} at ${clock(date)}`
}

/** For "works until …": "14:05", "tomorrow at 14:05", "Thu 22 Oct at 14:05". */
export function untilTime(date: Date, now = new Date()): string {
  const days = daysAhead(date, now)
  if (days === 0) return clock(date)
  if (days === 1) return `tomorrow at ${clock(date)}`
  return `${day(date)} at ${clock(date)}`
}

/** The "Link options" line while it's closed: what the next link will be. */
export function optionsSummary(hours: number, oneTime: boolean, password = false): string {
  const lasts = hours >= MAX_TTL_HOURS ? 'up to 3 weeks' : copy.EXPIRY_OPTIONS[hours]
  let line = `One-time · ${lasts}`
  if (!oneTime) line = hours >= MAX_TTL_HOURS ? 'Lasts up to 3 weeks' : `Stops after ${lasts}`
  return password ? `${line} · ${pwCopy.SUMMARY}` : line
}

/** A failure screen: its title, message, and whether Try again can help. */
export interface Problem {
  title: string
  message: string
  retry: boolean
}

/** Setting up the link on slynk.me failed, before anything was uploaded. */
export function putProblem(reason: Failure): Problem {
  return { title: copy.PUT_FAILED_TITLE, message: reason === 'busy' ? copy.PUT_BUSY : copy.PUT_UNREACHABLE, retry: true }
}

/** Holding a one-time link for this tab, before the download, failed. Nothing was used up. */
export function reserveProblem(reason: Failure, expires: Date, now = new Date()): Problem {
  switch (reason) {
    case 'used-or-cancelled':
    case 'lost':
    case 'expired':
      return unlockProblem(reason, 'one-time', expires, now)
    case 'held':
      return { title: copy.HELD_TITLE, message: copy.HELD, retry: true }
    default:
      // If the hold got through with its answer lost, this tab's retry holds it again.
      return { title: copy.SERVER_DOWN_TITLE, message: copy.SERVER_DOWN_HOLD, retry: true }
  }
}

/** Unlocking a downloaded one-time or expiring link failed. */
export function unlockProblem(reason: Failure | 'damaged', mode: LinkMode, expires: Date, now = new Date()): Problem {
  const oneTime = mode === 'one-time'
  switch (reason) {
    case 'used-or-cancelled':
      return oneTime
        ? { title: copy.USED_OR_CANCELLED_TITLE, message: copy.USED_OR_CANCELLED, retry: false }
        : { title: copy.EXPIRING_GONE_TITLE, message: copy.EXPIRING_GONE, retry: false }
    case 'lost':
      return { title: copy.LOST_TITLE, message: copy.LOST, retry: false }
    case 'expired':
      // slynk.me can say so a little before this device's clock does.
      return {
        title: copy.EXPIRED_TITLE,
        message: now >= expires ? copy.EXPIRED(ago(expires)) : copy.EXPIRED_NO_TIME,
        retry: false,
      }
    case 'damaged':
      return { title: copy.DAMAGED_TITLE, message: oneTime ? copy.DAMAGED_ONE_TIME : copy.DAMAGED, retry: false }
    case 'held':
      // This tab's hold lapsed during a long download, and someone else tapped since.
      return { title: copy.HELD_TITLE, message: copy.HELD, retry: true }
    default:
      // No usable answer. A one-time claim may have got through, so only this
      // tab's retry (same nonce) can still open it.
      return { title: copy.SERVER_DOWN_TITLE, message: oneTime ? copy.SERVER_DOWN_ONE_TIME : copy.SERVER_DOWN_EXPIRING, retry: true }
  }
}

/** What "Cancel this link" achieved. */
export interface CancelOutcome {
  text: string
  /** slynk.me confirmed the cancel. */
  cancelled: boolean
  /** The button stays, so the sender can try again. */
  retry: boolean
}

export function cancelOutcome(result: Result, mode: LinkMode, expires: Date, now = new Date()): CancelOutcome {
  // Past its stated expiry the link no longer opens, whatever slynk.me said.
  if (now >= expires) return { text: copy.CANCEL_EXPIRED, cancelled: false, retry: false }
  if (result.ok) return { text: copy.CANCEL_DONE, cancelled: true, retry: false }
  switch (result.reason) {
    case 'used-or-cancelled':
    case 'lost':
      return { text: mode === 'one-time' ? copy.CANCEL_TOO_LATE : copy.CANCEL_GONE, cancelled: false, retry: false }
    case 'expired':
      return { text: copy.CANCEL_EXPIRED, cancelled: false, retry: false }
    default:
      return { text: copy.CANCEL_UNREACHABLE, cancelled: false, retry: true }
  }
}
