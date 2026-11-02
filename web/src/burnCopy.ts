// Wording for one-time and expiring links, and for collecting any link. Every
// line must stay literally true (see burn.ts, core/keyserver and
// docs/findings/one-time-links.md). In particular:
// - "used or cancelled" together: a cancelled link answers like a used one.
// - Never promise that nothing was used up when slynk.me couldn't be reached:
//   a claim may have got through with its answer lost.
// - Don't warn about IP addresses. Say only that slynk.me can see the feature
//   being used.
// - Keep the screens plain: how it works (slynk.me's half of the key, kept on
//   its key server in memory only, and what it can see) is explained on the
//   About page, not here, softly (2026-10-21: the
//   finer limits belong in docs/findings/one-time-links.md). burn-copy.test.ts
//   checks the About page says it.
//
// {when} and {date} are filled in by the page (see ui/linkText.ts).
import { ONE_TIME_ONLY, SITE_ADDRESS, SITE_NAME } from './site.ts'

// --- Sender: choosing --------------------------------------------------------------

export const OPTIONS_TITLE = 'Link options'
export const EXPIRY_LABEL = 'Link stops working after'
/** With "One-time link" on: the time is only a backstop, for a link nobody opens. Short enough for one line on a small phone. */
export const EXPIRY_LABEL_ONE_TIME = 'If not opened, it expires after'
/** Keys are hours, matching EXPIRY_HOURS in linkv2.ts. */
export const EXPIRY_OPTIONS: Record<number, string> = {
  1: '1 hour',
  24: '1 day',
  168: '7 days',
  500: 'Up to 3 weeks',
}

/** slynk.me's rule (site.ts): in place of the switch below, with a link to the About answer. */
export const ONE_TIME_RULE = `Every ${SITE_NAME} link opens once only.`
export const ONE_TIME_WHY = 'Why?'
/** Its popup: why, in plain words, with the About answer a link away. */
export const ONE_TIME_WHY_TITLE = 'Why does every link open only once?'
export const ONE_TIME_WHY_TEXT = [
  `${SITE_NAME} is made for passing something privately from one person to another, not for sharing with crowds.`,
  `A link anyone could open again and again could overwhelm the xx network that keeps ${SITE_NAME} private, and could spread things that should never be shared. Opening once is the responsible choice.`,
  'To send something to several people, give each of them their own link.',
]

/** Last in Link options, opening Settings. */
export const OPTIONS_MORE = 'More options are available in Settings'

export const ONE_TIME_LABEL = 'One-time, cancellable link'
/** Expiring links can be cancelled too; the sent screen offers it for both. */
export const ONE_TIME_HELP =
  'Opens once, then stops working for everyone. If someone else opens it first, your recipient will find it already used. You can also cancel it from the screen that shows your link.'

// --- Sender: failures before the upload ---------------------------------------------

export const PUT_FAILED_TITLE = 'Couldn’t set up this link'
/**
 * Too many links being made right now, or slynk.me's store is full: either way, later. With the
 * one-time rule (site.ts) every link needs the key server; without it, a link lasting the full
 * three weeks doesn't, so it's offered.
 */
export const putBusy = (oneTimeOnly: boolean) =>
  oneTimeOnly
    ? `${SITE_NAME} can’t set up new links right now. Try again later.`
    : 'One-time and expiring links aren’t available right now. Try again later, or send an ordinary link.'
export const putUnreachable = (oneTimeOnly: boolean) =>
  `Couldn’t reach ${SITE_ADDRESS} to set up this link. Check your connection and try again${oneTimeOnly ? '' : ', or send an ordinary link'}.`
export const PUT_BUSY = putBusy(ONE_TIME_ONLY)
export const PUT_UNREACHABLE = putUnreachable(ONE_TIME_ONLY)

// --- Sender: after sending -------------------------------------------------------------

export const SENT_ONE_TIME = 'One-time link. Don’t open it yourself: that uses it up.'
export const SENT_EXPIRING = (when: string) => `This link stops working ${when}, or sooner if you cancel it.`
// Short enough for one line on a computer (a lone "it" wrapped onto a second); cancelling
// is the button just below, with its own line.
export const SENT_ONE_TIME_EXPIRY = (when: string) => `If nobody opens it, it stops working ${when}.`
export const CANCEL_BUTTON = 'Cancel this link'
/** The cancel token lives only on this screen, in this tab's memory. */
export const CANCEL_HELP = 'You can cancel it from this screen until you leave it, or close or reload this tab.'
export const CANCEL_CONFIRM = 'Cancel this link? Nobody will be able to open it, and you can’t undo this.'
export const CANCEL_YES = 'Yes, cancel it'
export const CANCEL_NO = 'Keep it'
export const CANCEL_DONE = 'Cancelled. The link no longer opens.'
/**
 * One-time link, revoke answered used-or-cancelled before the link's expiry.
 * Almost always it was opened, but the same answer comes if slynk.me lost the
 * share (in a crash, or with a sender's clock far ahead), hence "or".
 */
export const CANCEL_TOO_LATE = 'Too late to cancel: this link has already been opened or no longer works.'
/** Expiring link, revoke answered used-or-cancelled: slynk.me no longer has the share. */
export const CANCEL_GONE = 'This link no longer works, so there’s nothing to cancel.'
/** Show whenever the link's expiry has passed, whatever slynk.me answered. */
export const CANCEL_EXPIRED = 'This link has already expired, so there’s nothing to cancel.'
export const CANCEL_UNREACHABLE = `Couldn’t reach ${SITE_ADDRESS} to cancel the link. Try again.`

// --- Recipient --------------------------------------------------------------------------

/** Every link waits for this tap before joining the mixnet. */
export const COLLECT_BUTTON = 'Collect it'

export const ONE_TIME_BEFORE =
  'This is a one-time link. Opening it uses it up for everyone, including you, so open it on the device where you want to keep it, and be ready to save it.'
export const OPEN_BUTTON = 'Open it now'
/** While the tap holds the link for this tab, before connecting. */
export const CHECKING = 'Checking the link…'

/** A link that isn't one-time, refused by slynk.me's rule (site.ts) before anything connects. */
export const NOT_ONE_TIME_TITLE = 'This link doesn’t open here'
export const NOT_ONE_TIME = `${SITE_NAME} opens one-time links only. Ask the sender to send it again.`

/** Someone else tapped to open this one-time link in the last 15 minutes (the key server's Hold). */
export const HELD_TITLE = 'Someone else is opening this link'
export const HELD =
  'It was tapped open somewhere else in the last 15 minutes. If that wasn’t you, someone else has the link: ask the sender. Otherwise, try again after that.'

/** On the received screen, after a one-time link is opened. */
export const ONE_TIME_AFTER =
  'This one-time link won’t open again, for anyone. Don’t close or reload this tab until you’ve saved what you need.'
/** Added to "Couldn't open it" when a one-time link unlocked but its contents were unreadable. */
export const ONE_TIME_UNREADABLE = 'This one-time link won’t open again.'

export const EXPIRING_BEFORE = (when: string) => `This link works until ${when}, unless the sender cancels it.`

export const USED_OR_CANCELLED_TITLE = 'This link has already been used or was cancelled'
export const USED_OR_CANCELLED =
  'One-time links open only once. If you didn’t open it yourself, on this or another device, someone else may have had the link, or the sender cancelled it. Ask the sender.'

/**
 * One-time or expiring link, answered used-or-cancelled while the key server
 * says it restarted without its shares lately (a crash): it may have been
 * lost then. Rare: the key server saves its shares when it stops cleanly.
 */
export const LOST_TITLE = 'This link can’t be opened'
export const LOST =
  `It has already been used or cancelled, or it was lost when ${SITE_ADDRESS}’s key server had to restart recently. Ask the sender to send it again.`

/** Expiring link, answered used-or-cancelled before its expiry. */
export const EXPIRING_GONE_TITLE = 'This link no longer works'
export const EXPIRING_GONE = 'The sender may have cancelled it. Ask them to send it again.'

export const EXPIRED_TITLE = 'This link has expired'
export const EXPIRED = (when: string) => `It stopped working ${when}. Ask the sender for a new one.`
/** slynk.me said expired, but by this device's clock the link's time hasn't come (a clock is off). */
export const EXPIRED_NO_TIME = 'It has stopped working. Ask the sender for a new one.'

export const SERVER_DOWN_TITLE = `Couldn’t reach ${SITE_ADDRESS}`
/** Must not promise nothing was used up: the claim may have got through. */
export const SERVER_DOWN_ONE_TIME =
  `${SITE_NAME} needs ${SITE_ADDRESS} to unlock this one-time link. Keep this tab open and try again. If your first try got through, only this tab can still open it, for about 10 minutes.`
export const SERVER_DOWN_EXPIRING = `${SITE_NAME} needs ${SITE_ADDRESS} to unlock this link. Try again in a moment.`
/** Before the download: nothing is used up, and a hold that got through is this tab's. */
export const SERVER_DOWN_HOLD = `${SITE_NAME} needs ${SITE_ADDRESS} to open this one-time link. Check your connection and try again.`

export const DAMAGED_TITLE = 'Couldn’t unlock it'
/** Expiring links: the link may just have been copied badly. */
export const DAMAGED = 'The link or the data looks damaged. Ask the sender to copy the link again.'
/** One-time links: the claim may already have used it up, so a fresh copy won't help. */
export const DAMAGED_ONE_TIME = 'The link or the data looks damaged, so this one-time link can’t be opened. Ask the sender to send a new one.'
