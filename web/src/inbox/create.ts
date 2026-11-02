// Creating an anonymous inbox: what it's for, a name for the owner's own
// screens (optional, and never an address), its 12 words, a check that
// they're saved, and its address to share (with the words remembered on this
// device, or saved to it, if the owner likes). All of it
// works offline: an inbox is only a key, so nothing joins the mixnet and
// nothing is stored anywhere until its owner opens it. The new inbox's words
// come to this page only to be shown, and are dropped when the flow ends.
//
// There's no codename to choose: a name worked out from the key can't be a
// point of contact without a directory, so the link is the address and the
// owner labels it themselves.
import type { Core, InboxInfo } from '../core/client'
import { saveBlob } from '../ui/save'
import { LINK_ORIGIN } from '../home'
import { inboxLink, inboxQrText } from './address'
import { $, copyText, selectTab, wireTabs } from './dom'
import * as copy from './inboxCopy'
import { normalizeWords, numberedWords } from './keyfile'
import { keyFileBox } from './keyFileBox'
import { MAX_NAME, cleanName } from './mailbox'
import { markIcon } from './marker'
import { drawQr, qrSvgFile } from './qr'
import { rememberPassword, resetRememberPassword } from './rememberPw'

export interface CreateDeps {
  core(): Core
  toast(text: string): void
  /**
   * Opens the new inbox with its words and label: the flow is over.
   * remember: keep it here, with its words (the owner asked, after the
   * warnings), encrypted with password if they gave one. qs: the
   * quantum-safe address's tab was left selected, so the inbox's Share opens
   * on it.
   */
  openInbox(words: string, label: string, remember: boolean, password: string, qs: boolean): void
}

type Step = 'purpose' | 'label' | 'words' | 'check' | 'ready'
const STEPS: Step[] = ['purpose', 'label', 'words', 'check', 'ready']
const CHECKED = 3 // words typed back

export function setupCreate(deps: CreateDeps) {
  let picked: InboxInfo | undefined
  let making = 0 // bumps each time the flow starts over, so a late new inbox is dropped
  let checkAt: number[] = [] // the word positions to type back, from 1

  $('ni-uses').replaceChildren(...copy.PURPOSE_USES.map((use) => Object.assign(document.createElement('li'), { textContent: use })))

  function step(next: Step) {
    for (const s of STEPS) $(`ni-${s}`).hidden = s !== next
    // The 12 words, and the new inbox's link and QR code, are read from the top of the card, wherever the step
    // before left the page (on a phone the ready step began at the page's top).
    if (next === 'words' || next === 'ready') $('card').scrollIntoView({ block: 'start', behavior: 'instant' })
    // The heading takes the focus, so keyboard and screen-reader users start at the top.
    $(`ni-${next}`).querySelector<HTMLElement>('h2')?.focus({ preventScroll: true })
  }

  // --- A name for the owner's own screens ---------------------------------------------

  const labelBox = $<HTMLInputElement>('ni-label-field')
  labelBox.maxLength = MAX_NAME * 2 // cleanName has the last word
  const label = () => cleanName(labelBox.value)

  $('ni-to-label').addEventListener('click', () => {
    step('label')
    labelBox.focus()
  })
  labelBox.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      $('ni-label-next').click()
    }
  })
  $('ni-label-next').addEventListener('click', async () => {
    const next = $<HTMLButtonElement>('ni-label-next')
    if (next.disabled) return
    if (!picked) {
      const run = ++making
      next.disabled = true
      try {
        const made = await deps.core().inboxNew()
        if (run !== making) return
        picked = made
      } catch (e) {
        deps.toast(e instanceof Error ? e.message : String(e))
        return
      } finally {
        next.disabled = false
      }
    }
    showWords()
    step('words')
  })

  // --- The words ------------------------------------------------------------------

  function showWords() {
    const words = picked!.words!.split(' ')
    $('ni-word-list').replaceChildren(...words.map((w) => Object.assign(document.createElement('li'), { textContent: w })))
  }

  // Numbered, one a line, as they're shown.
  $('ni-copy-words').addEventListener('click', () => void copyText(numberedWords(picked?.words ?? ''), copy.WORDS_COPIED, deps.toast))

  // --- The check -------------------------------------------------------------------

  function pickPositions(): number[] {
    const all = Array.from({ length: 12 }, (_, i) => i + 1)
    const r = new Uint32Array(all.length)
    crypto.getRandomValues(r)
    for (let i = all.length - 1; i > 0; i--) {
      const j = r[i] % (i + 1)
      ;[all[i], all[j]] = [all[j], all[i]]
    }
    return all.slice(0, CHECKED).sort((a, b) => a - b)
  }

  function showCheck() {
    $('ni-check-error').hidden = true
    // Back from "Show phrase again": the same three words, and whatever was typed for them (new
    // ones each time made coming back feel like starting over).
    if (checkAt.length) {
      step('check')
      const inputs = [...$('ni-check-fields').querySelectorAll('input')]
      return (inputs.find((i) => !i.value) ?? inputs[0])?.focus()
    }
    checkAt = pickPositions()
    $('ni-check-lead').textContent = copy.CHECK_LEAD(checkAt)
    $('ni-check-fields').replaceChildren(
      ...checkAt.map((n) => {
        const label = document.createElement('label')
        label.className = 'check-word'
        const span = document.createElement('span')
        span.className = 'opts-label'
        span.textContent = copy.CHECK_LABEL(n)
        const input = document.createElement('input')
        input.className = 'pw-input'
        input.type = 'text'
        input.autocomplete = 'off'
        input.spellcheck = false
        input.setAttribute('autocapitalize', 'none')
        input.setAttribute('autocorrect', 'off')
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') $('ni-check-go').click()
        })
        label.append(span, input)
        return label
      }),
    )
    step('check')
    $('ni-check-fields').querySelector('input')?.focus()
  }

  $('ni-saved').addEventListener('click', showCheck)
  $('ni-check-back').addEventListener('click', () => step('words'))
  $('ni-check-go').addEventListener('click', () => {
    const words = picked!.words!.split(' ')
    const typed = [...$('ni-check-fields').querySelectorAll('input')].map((i) => normalizeWords(i.value))
    const right = typed.length === checkAt.length && checkAt.every((n, i) => typed[i] === words[n - 1])
    if (!right) {
      const error = $('ni-check-error')
      error.textContent = copy.CHECK_WRONG
      error.hidden = false
      return
    }
    void showReady()
  })

  // --- Ready to share: its two addresses, as tabs -------------------------------------
  // The secure (compact) address's tab first, each with its marker, as the
  // inbox's messages have them; the one left selected is where the inbox's
  // Share opens, until another is shared.

  for (const tab of $('ni-tabs').querySelectorAll<HTMLElement>('[role="tab"]')) tab.prepend(markIcon(tab.dataset.qs === 'true'))

  let readyQs = false // the quantum-safe address's tab is shown
  let drawn = 0 // bumps on every switch, so a slow QR code doesn't land on the other tab

  async function showReady() {
    $('ni-name-shown').textContent = label()
    $('ni-name-shown').hidden = !label()
    readyQs = false
    // Back here a second time: a password typed before stays.
    if (!$<HTMLInputElement>('ni-kf-pw').value) keyFile.reset()
    $<HTMLDetailsElement>('ni-show').open = false
    step('ready')
    await showAddress()
  }

  const shownAddress = () => (readyQs ? picked!.address4 : picked!.address)

  async function showAddress() {
    if (!picked) return
    const qs = readyQs
    const address = shownAddress()
    const tab = $(qs ? 'ni-tab-qs' : 'ni-tab-secure')
    selectTab($('ni-tabs'), tab)
    $('ni-share').setAttribute('aria-labelledby', tab.id)
    $('ni-share-lead').textContent = qs ? copy.READY_SHARE_QS : copy.READY_SHARE
    $('ni-qs-what').hidden = !qs
    $<HTMLInputElement>('ni-link').value = inboxLink(LINK_ORIGIN, address)
    const qr = $('ni-qr')
    qr.classList.toggle('dense', qs)
    const run = ++drawn
    try {
      await drawQr(qr, inboxQrText(LINK_ORIGIN, address), () => run === drawn)
    } catch {
      if (run === drawn) qr.replaceChildren()
    }
  }

  wireTabs($('ni-tabs'), (tab) => {
    const qs = tab.dataset.qs === 'true'
    if (qs === readyQs) return
    readyQs = qs
    void showAddress()
  })
  $('ni-copy-link').addEventListener('click', () => void copyText($<HTMLInputElement>('ni-link').value, 'Link copied', deps.toast, $<HTMLInputElement>('ni-link')))
  $('ni-link').addEventListener('focus', () => $<HTMLInputElement>('ni-link').select())
  $('ni-save-qr').addEventListener('click', async () => {
    if (!picked) return
    const qs = readyQs
    saveBlob(await qrSvgFile(inboxQrText(LINK_ORIGIN, shownAddress())), copy.READY_QR_FILE(qs))
  })
  $('ni-open').addEventListener('click', () => {
    const words = picked?.words
    const name = label()
    const remember = $<HTMLInputElement>('ni-remember').checked
    const password = remember ? rememberPassword('ni-remember-pw') : ''
    if (password === undefined) return // said why under the box
    const qs = readyQs
    reset()
    if (words) deps.openInbox(words, name, remember, password, qs)
  })
  // "Remember my passphrase on this device": the warnings, and the optional password, show as soon as it's switched on.
  // Saving it to the device is offered only while it's off: remembered, it needs no saving.
  $('ni-remember').addEventListener('change', () => {
    const on = $<HTMLInputElement>('ni-remember').checked
    $('ni-remember-warn').hidden = !on
    $('ni-remember-pw-box').hidden = !on
    $('ni-kf').hidden = on
    if (on) $<HTMLDetailsElement>('ni-kf').open = false
  })

  // --- Or saved to the device, as a file encrypted with a password ----------------------

  const keyFile = keyFileBox('ni-kf', () => (picked?.words ? { words: picked.words, label: label() } : undefined))
  // No Done button: it left for the front page with no inbox open, which puzzled; "Back to the front
  // page" at the top is the way out.

  /** Forgets everything about the new inbox this flow knew, and goes back to its start. */
  function reset() {
    making++
    picked = undefined
    readyQs = false
    drawn++
    checkAt = []
    keyFile.empty()
    $<HTMLDetailsElement>('ni-show').open = false
    for (const id of ['ni-word-list', 'ni-check-fields', 'ni-qr']) $(id).replaceChildren()
    for (const id of ['ni-link', 'ni-label-field']) $<HTMLInputElement>(id).value = ''
    $('ni-name-shown').textContent = ''
    $<HTMLInputElement>('ni-remember').checked = false
    $('ni-remember-warn').hidden = true
    $('ni-remember-pw-box').hidden = true
    $('ni-kf').hidden = false
    resetRememberPassword('ni-remember-pw')
    step('purpose')
  }

  return {
    /** Starts the flow from what an inbox is for. */
    start() {
      reset()
    },
    reset,
    /** The words are on screen (or held for the check): leaving loses them. */
    busy: () => !!picked,
  }
}
