// Web links in a message: an address someone
// pasted into a message becomes a link, so a Slynk link shared in an inbox
// message (to "attach" files, say) opens with a tap. Message text comes from
// anyone, so this only finds where the links are; linkWarn.ts makes them from
// text, never markup, and asks before opening one, always in a new tab.
//
// Only http:// and https:// addresses, written out in full: never another
// scheme (javascript:, data:, file:…), and never one with a name or password
// before its host ("https://slynk.me@example.com" goes to example.com). The
// host is the browser's own reading of it, so look-alike letters show as
// "xn--…". Nothing here fetches anything.

/** At most this many links in a message, each at most this long: the rest stays plain text. */
export const MAX_LINKS = 200
export const MAX_LINK_LENGTH = 4096
/** Addresses looked at in one message, links or not: a long message full of near-misses stays quick. */
const MAX_TRIES = 1000

export interface FoundLink {
  /** Where it is in the text: text.slice(start, end) is what was written. */
  start: number
  end: number
  /** Where it goes, as the browser reads it. */
  href: string
  /** Its host (and port, if not the usual), as the browser reads it. */
  host: string
  /** This site's own (a Slynk link, an inbox's address, the About page). */
  slynk: boolean
  /** It has a #: for this site, a link or an inbox's address, which opens with an identity of its own. */
  hash: boolean
}

// http:// or https:// after a non-word character (not "xhttp://"), up to a space or anything that
// can't be part of an address as written: <, >, ", `, \, and control, invisible or bidi characters.
const CANDIDATE = /\bhttps?:\/\/[^\s<>"`\\\p{Cc}\p{Cf}\p{Z}]+/giu

// What usually ends the sentence around an address, not the address: "see https://x.com." A
// base64url Slynk link can end in - or _, so those stay.
const TRAILING = new Set([...'.,:;!?\'*’”»…'])
const CLOSERS: Record<string, string> = { ')': '(', ']': '[', '}': '{' }

/** The address without what ends the sentence around it, or a bracket it doesn't open itself. */
function trimmed(raw: string): string {
  const count: Record<string, number> = {}
  for (const c of raw) if (c in CLOSERS || '([{'.includes(c)) count[c] = (count[c] ?? 0) + 1
  let end = raw.length
  while (end > 0) {
    const c = raw[end - 1]
    const open = CLOSERS[c]
    if (open ? (count[open] ?? 0) < count[c] : TRAILING.has(c)) {
      if (open) count[c]--
      end--
    } else break
  }
  return raw.slice(0, end)
}

/**
 * The web links in text, in order. homes are this site's own origins, to tell its links: where its links
 * point and where this page is (home.ts homeOrigins), which differ in a copy run from one's own computer.
 */
export function findLinks(text: string, ...homes: string[]): FoundLink[] {
  const here = homes.map((h) => new URL(h))
  const found: FoundLink[] = []
  let tries = 0
  for (const m of text.matchAll(CANDIDATE)) {
    if (found.length >= MAX_LINKS || ++tries > MAX_TRIES) break
    if (m[0].length > MAX_LINK_LENGTH) continue
    const written = trimmed(m[0])
    let url: URL
    try {
      url = new URL(written)
    } catch {
      continue
    }
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !url.hostname || url.username || url.password) continue
    // This site's own, even written as http:// (it's always https://, and the # never leaves the browser).
    const home = here.find((h) => url.host === h.host && (url.protocol === h.protocol || url.protocol === 'http:'))
    if (home) url.protocol = home.protocol
    found.push({ start: m.index, end: m.index + written.length, href: url.href, host: url.host, slynk: !!home, hash: url.hash.length > 1 })
  }
  return found
}
