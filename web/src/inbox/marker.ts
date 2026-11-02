// The two markers: every message in an inbox, every conversation, and the
// inbox being written to carry a padlock if it came or goes the secure way,
// or an atom if quantum-safe. So there's one inbox rather than a tab for each
// address, with the two addresses as tabs only where one is shared. Tapped, a
// marker says what it means in one line, with a link to the explainer
// (qsWhy.ts). Beside words that already say which it is (a tab, New message's
// line), it's the icon alone.
// Styles only through classes (the page's rules forbid inline styles).
import * as copy from './inboxCopy'

/** The standard lock: a padlock. */
export const LOCK_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="10.5" width="14" height="10" rx="2.2" /><path d="M8.2 10.5V7.6a3.8 3.8 0 0 1 7.6 0v2.9" /></svg>'

/** Quantum-safe: an atom, three orbits round a nucleus. */
export const ATOM_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><ellipse cx="12" cy="12" rx="10" ry="3.9" /><ellipse cx="12" cy="12" rx="10" ry="3.9" transform="rotate(60 12 12)" /><ellipse cx="12" cy="12" rx="10" ry="3.9" transform="rotate(120 12 12)" /><circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" /></svg>'

/** Which explainer a marker's note links to: the owner's (the two addresses first) or a sender's. */
export type MarkFrom = 'inbox' | 'sender'

/** The icon alone, where words beside it already say which it is. */
export function markIcon(qs: boolean): HTMLElement {
  const s = document.createElement('span')
  s.className = 'mark-icon'
  s.dataset.qs = String(qs)
  s.setAttribute('aria-hidden', 'true')
  s.innerHTML = qs ? ATOM_SVG : LOCK_SVG // fixed markup
  return s
}

/** Puts the icon alone in slot, unless the same one is there already. */
export function setIcon(slot: HTMLElement, qs: boolean) {
  const have = slot.firstElementChild as HTMLElement | null
  if (have?.classList.contains('mark-icon') && have.dataset.qs === String(qs)) return
  if (shown && slot.contains(shown.button)) close(false)
  slot.replaceChildren(markIcon(qs))
}

let shown: { button: HTMLButtonElement; note: HTMLElement } | undefined
let made = 0

/** Closes the note that's open, if any; refocus: back to its marker. */
function close(refocus: boolean) {
  const s = shown
  if (!s) return
  shown = undefined
  s.note.hidden = true
  s.button.setAttribute('aria-expanded', 'false')
  s.note.closest('.card')?.classList.remove('note-open')
  if (refocus && s.button.isConnected) s.button.focus()
}

/** Closes whatever note is open: the screen changes. */
export const closeMarks = () => close(false)

/** Closes the open note if it's inside el, which is being redrawn. */
export function closeMarksIn(el: Element) {
  if (shown && el.contains(shown.button)) close(false)
}

document.addEventListener('pointerdown', (e) => {
  if (shown && !shown.note.contains(e.target as Node) && !shown.button.contains(e.target as Node)) close(false)
})
// Escape closes it, wherever the focus is (Safari doesn't focus a button that's clicked).
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && shown) close(document.activeElement === shown.button || shown.note.contains(document.activeElement))
})

/**
 * A marker that says what it means when tapped: a padlock, or an atom for
 * quantum-safe. from: whose explainer its note links to.
 */
export function marker(qs: boolean, from: MarkFrom): HTMLElement {
  const wrap = document.createElement('span')
  wrap.className = 'mark'
  wrap.dataset.qs = String(qs)
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'mark-btn'
  button.innerHTML = qs ? ATOM_SVG : LOCK_SVG // fixed markup
  button.setAttribute('aria-label', qs ? copy.MARK_QS : copy.MARK_SECURE)
  button.title = qs ? copy.MARK_QS : copy.MARK_SECURE
  button.setAttribute('aria-expanded', 'false')
  const note = document.createElement('span')
  note.className = 'mark-note'
  note.id = `mark-note-${++made}`
  note.hidden = true
  button.setAttribute('aria-controls', note.id)
  // The explainer opens from it as from any element marked so (qsWhy.ts); the note closes.
  const more = Object.assign(document.createElement('button'), { type: 'button', className: 'soft-link', textContent: from === 'inbox' ? copy.TABS_WHAT : copy.QS_WHAT })
  more.dataset.qsWhy = from
  more.setAttribute('aria-haspopup', 'dialog')
  more.addEventListener('click', () => close(false))
  note.append(Object.assign(document.createElement('span'), { textContent: qs ? copy.MARK_QS_NOTE : copy.MARK_SECURE_NOTE }), ' ', more)
  button.addEventListener('click', () => {
    if (shown?.button === button) return close(true)
    close(false)
    note.hidden = false
    place(wrap, note)
    button.setAttribute('aria-expanded', 'true')
    // Above the cards after this one, as an open menu is.
    note.closest('.card')?.classList.add('note-open')
    shown = { button, note }
  })
  // Escape here goes no further: a message open in the reader would close too.
  wrap.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && shown?.note === note) {
      e.stopPropagation()
      close(true)
    }
  })
  wrap.append(button, note)
  return wrap
}

/** The screen's own edges a note keeps clear of, in pixels. */
const EDGE = 12

/**
 * Opens the note towards the middle of the screen, then moves it in from an
 * edge it would cross (a marker mid-screen, on a phone): a note cut off, or
 * one that makes the page scroll sideways, is no good.
 */
function place(wrap: HTMLElement, note: HTMLElement) {
  note.style.left = ''
  note.style.right = ''
  const w = wrap.getBoundingClientRect()
  const width = document.documentElement.clientWidth
  wrap.dataset.side = w.left + w.width / 2 < width / 2 ? 'start' : 'end'
  const n = note.getBoundingClientRect()
  const shift = n.right > width - EDGE ? width - EDGE - n.right : n.left < EDGE ? EDGE - n.left : 0
  if (!shift) return
  note.style.left = `${Math.round(n.left - w.left + shift)}px`
  note.style.right = 'auto'
}

/**
 * Puts a marker in slot, unless one of the same kind is already there: a
 * redraw leaves an open note open.
 */
export function setMarker(slot: HTMLElement, qs: boolean, from: MarkFrom) {
  const have = slot.firstElementChild as HTMLElement | null
  if (have?.classList.contains('mark') && have.dataset.qs === String(qs)) return
  if (shown && slot.contains(shown.button)) close(false)
  slot.replaceChildren(marker(qs, from))
}
