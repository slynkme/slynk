// Tab title and favicon signals, so a background tab shows progress and a
// dot when something is ready. Everything is local to the page.
import { SITE_NAME } from '../site.ts'

const COIL = `<g fill="none" stroke="url(#g)" stroke-width="4.5" stroke-linecap="round">${[19, 27, 35, 43]
  .map((x) => `<ellipse cx="${x}" cy="32" rx="5.5" ry="16" transform="rotate(-18 ${x} 32)"/>`)
  .join('')}</g>`

function icon(dot: boolean): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="#b69cff"/><stop offset="1" stop-color="#2ee6ff"/></linearGradient></defs>` +
    `<rect width="64" height="64" rx="16" fill="#0b0d17"/>${COIL}` +
    (dot ? `<circle cx="51" cy="13" r="11" fill="#34d399" stroke="#0b0d17" stroke-width="3"/>` : '') +
    `</svg>`
  return 'data:image/svg+xml,' + encodeURIComponent(svg)
}

const PLAIN = icon(false)
const DOTTED = icon(true)
const BASE_TITLE = SITE_NAME

let flagged = false

function setIcon(href: string) {
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
  if (!link) {
    link = document.createElement('link')
    link.rel = 'icon'
    document.head.append(link)
  }
  link.href = href
}

/** Shows progress in the tab title, e.g. "42% Sending". Pass nothing to reset. */
export function titleProgress(text?: string) {
  if (flagged) return
  document.title = text ? `${text} · ${BASE_TITLE}` : BASE_TITLE
}

/** Marks the tab (dot on the icon, title prefix) until the user looks at it. */
export function flagTab(text: string) {
  if (document.visibilityState === 'visible' && document.hasFocus()) {
    titleProgress()
    return
  }
  flagged = true
  setIcon(DOTTED)
  document.title = `● ${text} · ${BASE_TITLE}`
}

function clearFlag() {
  if (!flagged || document.visibilityState !== 'visible') return
  flagged = false
  setIcon(PLAIN)
  document.title = BASE_TITLE
}

export function initTabSignals() {
  setIcon(PLAIN)
  document.addEventListener('visibilitychange', clearFlag)
  window.addEventListener('focus', clearFlag)
}
