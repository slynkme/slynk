// The optional password for an inbox's remembered words: a box under the
// warnings wherever "Remember my passphrase on this device" is offered (the
// creation screen's last step, the open screen, the inbox's menu). With a
// password the words are sealed on the device (keyfile.ts, sealWords), and
// the warnings above it say what that changes, as it's typed. It's hidden as
// it's typed, with the usual eye to check it, and typed again in a second box
// that appears once a password is begun, so a slip doesn't leave words nobody
// can open here.
import * as pwCopy from '../passwordCopy'
import { MAX_PASSWORD, MIN_PASSWORD, normalizePassword, passwordProblem } from '../password'
import { $ } from './dom'
import * as copy from './inboxCopy'

/** Fills a warning's list of risks, as it reads with or without a password typed. */
export function fillRisks(warn: HTMLElement, password: boolean) {
  const ul = warn.querySelector<HTMLElement>('[data-risks]')
  ul?.replaceChildren(...copy.REMEMBER_RISKS(password).map((t) => Object.assign(document.createElement('li'), { textContent: t })))
}

/** A password eye: shows or hides the box it controls; its name stays the same, its tooltip says what a click does. */
export function wireEye(eye: HTMLButtonElement, input = $<HTMLInputElement>(eye.getAttribute('aria-controls')!), show = copy.REMEMBER_PW_SHOW, hide = copy.REMEMBER_PW_HIDE) {
  const render = () => {
    const shown = input.type === 'text'
    eye.setAttribute('aria-pressed', String(shown))
    eye.title = shown ? hide : show
  }
  eye.setAttribute('aria-label', show)
  render()
  eye.addEventListener('click', () => {
    input.type = input.type === 'text' ? 'password' : 'text'
    render()
    input.focus()
  })
  return render
}

function sayError(input: HTMLInputElement, text: string) {
  const el = $(`${input.id}-error`)
  el.textContent = text
  el.hidden = !text
}

const eyeRenders = new Map<string, () => void>()
/** The box a password is typed again in, beside each one. */
const again = (input: HTMLInputElement) => $<HTMLInputElement>(`${input.id}2`)

/** Wires every remembered-words password box on the page, once: its eyes, its second box, and the warnings it changes. */
export function wireRememberPasswords() {
  for (const warn of document.querySelectorAll<HTMLElement>('.remember-warn')) fillRisks(warn, false)
  for (const input of document.querySelectorAll<HTMLInputElement>('input[data-remember-pw]')) {
    const second = again(input)
    input.maxLength = second.maxLength = 400 // a longer one is refused with a message, never cut short
    input.addEventListener('input', () => {
      const typed = !!normalizePassword(input.value)
      fillRisks($(input.dataset.rememberPw!), typed)
      $(`${input.id}2-box`).hidden = !typed
      if (!typed) second.value = ''
      sayError(input, '')
    })
    second.addEventListener('input', () => sayError(input, ''))
    for (const box of [input, second]) eyeRenders.set(box.id, wireEye(box.parentElement!.querySelector<HTMLButtonElement>('[data-pw-eye]')!, box))
  }
}

/** The password typed in a box: '' for none, or undefined, saying why under it, when it won't do or isn't typed the same twice. */
export function rememberPassword(id: string): string | undefined {
  const input = $<HTMLInputElement>(id)
  if (!normalizePassword(input.value)) return ''
  const problem = passwordProblem(input.value)
  if (problem) {
    sayError(input, problem === 'short' ? pwCopy.TOO_SHORT(MIN_PASSWORD) : pwCopy.TOO_LONG(MAX_PASSWORD))
    input.focus()
    return undefined
  }
  // Compared as it will be used: capitals and extra spaces don't matter (password.ts).
  if (normalizePassword(again(input).value) !== normalizePassword(input.value)) {
    sayError(input, copy.REMEMBER_PW_MISMATCH)
    again(input).focus()
    return undefined
  }
  return input.value
}

/** A box back as it starts: empty and hidden, no second box, the warnings without a password. */
export function resetRememberPassword(id: string) {
  const input = $<HTMLInputElement>(id)
  for (const box of [input, again(input)]) {
    box.value = ''
    box.type = 'password'
    eyeRenders.get(box.id)?.()
  }
  $(`${id}2-box`).hidden = true
  sayError(input, '')
  fillRisks($(input.dataset.rememberPw!), false)
}
