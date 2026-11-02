// "Check its address is correct": from under the
// composer's Send, a sender pastes the inbox's address from where its owner
// published it (their website, a poster, a leaflet) or scans its QR code, and
// the page says whether it's the one they're writing to: the very same, the
// same inbox by its other address, or another inbox. A quantum-safe address
// counts as the same inbox only once the core has checked the inbox's
// signature on it. The full address shows only if
// asked, with Copy. Nothing leaves the page.
import { LINK_ORIGIN } from '../home'
import { addressFromInput, compareAddresses, inboxLink, isQuantumSafe } from './address'
import { $ } from './dom'
import * as copy from './inboxCopy'
import { openScan } from './scan'

export interface CheckDeps {
  /** Whether the core takes this address: a quantum-safe one's signature checks out. */
  works(address: Uint8Array): Promise<boolean>
}

/** A tick, or a cross, beside what the check found. */
const TICK_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5 9.5 17 19 7.5" /></svg>'
const CROSS_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17" /></svg>'

let writing: Uint8Array | undefined // the address the composer is writing to, while the popup is open
let deps: CheckDeps | undefined
let checks = 0 // bumps on every check and every opening, so a slow answer never speaks over a newer one
let wired = false

const field = () => $<HTMLInputElement>('addr-check-field')

/** What the check found, with its tick or cross; '' hides it. */
function say(text: string, good = false) {
  const el = $('addr-check-result')
  el.hidden = !text
  el.dataset.good = String(good)
  const icon = Object.assign(document.createElement('span'), { className: 'check-icon', innerHTML: good ? TICK_SVG : CROSS_SVG }) // fixed markup
  el.replaceChildren(...(text ? [icon, Object.assign(document.createElement('span'), { textContent: text })] : []))
}

async function check() {
  const to = writing
  const value = field().value.trim()
  if (!to || !deps) return
  if (!value) return field().focus()
  const given = addressFromInput(value)
  if (!given) return say(copy.SEND_TO_BAD(false))
  const run = ++checks
  const found = compareAddresses(to, given)
  // The same inbox's other address: a quantum-safe one only if its signature checks out.
  if (found === 'same-inbox' && isQuantumSafe(given) && !(await deps.works(given))) {
    if (run === checks) say(copy.ADDR_CHECK_BAD)
    return
  }
  if (run !== checks) return
  if (found === 'same') say(copy.ADDR_CHECK_SAME, true)
  else if (found === 'same-inbox') say(copy.ADDR_CHECK_SAME_INBOX(isQuantumSafe(given)), true)
  else say(copy.ADDR_CHECK_OTHER)
}

/** The full address, shown only when asked for, with Copy: its chevron says which. */
function showFull(show: boolean) {
  $('addr-check-full').hidden = !show
  $('addr-check-full-go').setAttribute('aria-expanded', String(show))
}

function wire() {
  if (wired) return
  wired = true
  const d = $<HTMLDialogElement>('addr-check')
  d.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => d.close()))
  d.addEventListener('click', (e) => {
    if (e.target === d) d.close() // click on the backdrop
  })
  d.addEventListener('close', () => {
    writing = undefined
    checks++
  })
  $('addr-check-go').addEventListener('click', () => void check())
  field().addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void check()
    }
  })
  // A new address to check: what was found about the last one goes.
  field().addEventListener('input', () => say(''))
  const scan = $('addr-check-scan')
  scan.setAttribute('aria-label', copy.SCAN_LABEL)
  scan.title = copy.SCAN_LABEL
  // A code read is checked at once, its link in the box to see.
  scan.addEventListener('click', () =>
    openScan((address) => {
      if (!writing) return
      field().value = inboxLink(LINK_ORIGIN, address)
      void check()
    }),
  )
  $('addr-check-full-go').addEventListener('click', () => showFull($('addr-check-full').hidden === true))
  $('addr-check-copy').addEventListener('click', async () => {
    const b = $<HTMLButtonElement>('addr-check-copy')
    try {
      await navigator.clipboard.writeText($('addr-check-text').textContent ?? '')
      // Said on the button: a toast would sit behind the popup.
      b.textContent = copy.ADDR_CHECK_COPIED
      setTimeout(() => (b.textContent = copy.ADDR_CHECK_COPY), 1500)
    } catch {
      // Selected instead, to copy by hand.
      getSelection()?.selectAllChildren($('addr-check-text'))
    }
  })
}

/** Opens the popup for the address the composer is writing to. */
export function openCheck(address: Uint8Array, d: CheckDeps) {
  wire()
  const dialog = $<HTMLDialogElement>('addr-check')
  if (dialog.open) return
  writing = address.slice()
  deps = d
  checks++
  field().value = ''
  say('')
  showFull(false)
  $('addr-check-text').textContent = inboxLink(LINK_ORIGIN, writing)
  $('addr-check-text').classList.toggle('long', isQuantumSafe(writing))
  $('addr-check-copy').textContent = copy.ADDR_CHECK_COPY
  dialog.showModal()
  // The title takes the focus, not the close button: Safari rings a button focused on opening.
  $('addr-check-title').focus()
}
