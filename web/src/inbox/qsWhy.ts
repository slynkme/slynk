// What a quantum-safe inbox is: one sheet, from the ready screen's
// quantum-safe tab, the (i) beside the two addresses' tabs (on the ready
// screen and in Share, where it says first what the two addresses and the
// markers are), a marker's note (marker.ts) and the card of someone writing
// to one: there, from the (i) beside the atom, a short explainer, the About
// page's answer for more. Any element marked data-qs-why="ready" | "inbox" |
// "sender" opens it, made with the page or later (a marker's note).
import { $ } from './dom'
import * as copy from './inboxCopy'
import { markIcon } from './marker'

type From = 'ready' | 'inbox' | 'sender'

let wired = false

export function openQsWhy(from: From) {
  const d = $<HTMLDialogElement>('qs-why')
  if (d.open) return
  const inbox = from === 'inbox'
  $('qs-why-title').textContent = inbox ? copy.TABS_TITLE : copy.QS_TITLE
  const p = (text: string) => Object.assign(document.createElement('p'), { textContent: text })
  const parts: HTMLElement[] = inbox ? copy.TABS_WHY.map(withMarks) : []
  if (inbox) parts.push(Object.assign(document.createElement('h3'), { textContent: copy.QS_TITLE }))
  parts.push(...(from === 'sender' ? copy.QS_SHORT : copy.QS_WHY).map(p))
  $('qs-why-body').replaceChildren(...parts)
  d.showModal()
  // The title takes the focus, not the close button: Safari rings a button focused on opening.
  $('qs-why-title').focus()
}

/** A paragraph with each marker it names shown after its name ("a padlock", "an atom"), so they're known on sight. */
function withMarks(text: string): HTMLElement {
  const para = document.createElement('p')
  for (const bit of text.split(/(a padlock|an atom)/)) {
    para.append(bit)
    if (bit === 'a padlock' || bit === 'an atom') para.append(' ', markIcon(bit === 'an atom'))
  }
  return para
}

/** Wires the sheet and every way to it, once. */
export function wireQsWhy() {
  if (wired) return
  wired = true
  const d = $<HTMLDialogElement>('qs-why')
  d.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => d.close()))
  d.addEventListener('click', (e) => {
    if (e.target === d) d.close() // click on the backdrop
  })
  document.addEventListener('click', (e) => {
    const b = (e.target as Element | null)?.closest?.<HTMLElement>('[data-qs-why]')
    if (b) openQsWhy(b.dataset.qsWhy as From)
  })
}
