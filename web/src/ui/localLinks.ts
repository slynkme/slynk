// Links in a copy of Slynk run from one's own computer (lab/run-locally),
// which opens in a window of its own, with no tabs:
// Slynk's own pages (the About page, say) open in that window
// when nothing would be lost, and in a second Slynk window when something
// would (a message being written, an inbox open, a transfer); links to other
// sites, once "Leave Slynk?" has asked, open in the person's own browser. The
// program opens those windows for the page (POST /api/open), for its own page
// only. A link to the site itself (https://slynk.me/#…, made here or anywhere)
// opens in the copy too, as Slynk's own. On slynk.me none of this applies:
// links open in new tabs as ever.
import { LOCAL_ORIGIN, SITE_NAME, SITE_URL } from '../site.ts'

/** "Received a Slynk link? Paste it here." (index.html, #open-link): what it says when it can't open what's pasted. */
export const PASTE_NOT_A_LINK = `That isn’t a ${SITE_NAME} link. Copy the whole link and paste it again.`
export const PASTE_INBOX_OPEN = 'Your inbox is unlocked in this window. Lock it first, then paste the link again.'
/** Its camera button's scan (inbox/scan.ts): a link to collect or an inbox's address, either. */
export const SCAN_LINK_WORDS = {
  point: 'Point your camera at the QR code.',
  notIt: `That QR code isn’t a ${SITE_NAME} link or an inbox’s address.`,
  found: 'Found it.',
  pick: 'Choose a photo or screenshot of the QR code.',
  broken: 'This browser won’t let the page read pictures, so it can’t scan. Paste the link instead.',
  failed: 'Scanning didn’t work this time. Paste the link instead.',
}

/**
 * The part of a pasted link the page reads (its # and what follows), from the
 * whole link, whichever site it names, or from that part copied on its own;
 * undefined for anything else. Spaces and line breaks a message app adds are
 * dropped: a link has none.
 */
export function pastedFragment(text: string): string | undefined {
  const t = text.replace(/\s+/g, '')
  const at = t.indexOf('#')
  if (at >= 0) return t.length > at + 1 ? t.slice(at) : undefined
  return /^[A-Za-z0-9_-]{40,}$/.test(t) ? `#${t}` : undefined
}

/** Whether this page is a copy run from one's own computer. */
export const localCopy = typeof location !== 'undefined' && location.origin === LOCAL_ORIGIN

/** Whether leaving this page now loses nothing; the app's page says (main.ts). */
let mayLeave: () => boolean = () => true

export function setMayLeave(fn: () => boolean) {
  mayLeave = fn
}

/** Asks the program to open href in a window of its own (Slynk's) or the person's browser (another site's). */
async function openElsewhere(href: string): Promise<boolean> {
  try {
    const res = await fetch('/api/open', { method: 'POST', body: href, credentials: 'omit', referrerPolicy: 'no-referrer' })
    return res.ok
  } catch {
    return false
  }
}

/** Opens href as a local copy should. */
function openLocally(href: string) {
  let to = new URL(href, location.href)
  // The site's own page, its link or an inbox's address: the same, from this computer.
  if (to.origin === SITE_URL) to = new URL(to.pathname + to.search + to.hash, location.origin)
  if (to.origin === location.origin && mayLeave()) {
    location.assign(to.href)
    return
  }
  // An older program without /api/open: a new window, as the browser would.
  void openElsewhere(to.href).then((ok) => ok || window.open(to.href, '_blank', 'noopener,noreferrer'))
}

/**
 * The program stops on its own once Slynk's last window closes (so
 * there's no Terminal or black window to close instead).
 * While this page is open it holds a connection to the program, and as it
 * goes it says so, so a reload or a move to the About page doesn't count as
 * closing, while a page the browser put to sleep keeps it running. Both stay
 * on this computer.
 */
function keepProgramRunning() {
  try {
    new EventSource('/api/alive')
  } catch {
    // Not in this browser: the program then stops when the browser it started closes.
  }
  addEventListener('pagehide', () => {
    void fetch('/api/bye', { method: 'POST', keepalive: true, credentials: 'omit', referrerPolicy: 'no-referrer' }).catch(() => {})
  })
}

/**
 * In a local copy, every link that would open a new tab opens as above
 * instead. Links to other sites still ask first (ui/linkWarn.ts), and its
 * popup's own link then opens here. Slynk's own pages lose the new-tab arrow
 * and "(opens in new tab)".
 */
export function wireLocalLinks() {
  if (!localCopy) return
  document.documentElement.dataset.local = ''
  keepProgramRunning()
  const follow = (e: MouseEvent) => {
    if (e.defaultPrevented || (e.type === 'auxclick' && e.button !== 1)) return
    const a = e.target instanceof Element ? e.target.closest<HTMLAnchorElement>('a[target="_blank"][href]') : null
    if (!a) return
    e.preventDefault()
    openLocally(a.href)
  }
  document.addEventListener('click', follow)
  document.addEventListener('auxclick', follow)
}
