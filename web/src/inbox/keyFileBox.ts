// "Save passphrase as a file": the 12 words saved as a file (keyfile.ts),
// offered on the last step of making an inbox, under "Remember my passphrase",
// only while that's off, and from the open inbox's menu, with the passphrase
// typed once more. The password box starts blank, hidden as it's typed, with
// the eye to check it, like the site's other password boxes, and typed again to
// be sure; "Suggest a password" fills both and shows it. The file is encrypted
// with it and saved, named as every one is. From the menu, it can hold the
// inbox's messages too: a backup of the whole inbox.
import * as pwCopy from '../passwordCopy'
import { MAX_PASSWORD, normalizePassword, suggestPassword } from '../password'
import { coolKdf, warmKdf } from '../kdf'
import { saveBlob } from '../ui/save'
import { $ } from './dom'
import * as copy from './inboxCopy'
import { BACKUP_FILE_NAME, KEY_FILE_NAME, KEY_FILE_TYPE, MIN_KEY_FILE_PASSWORD, keyFilePasswordProblem, makeKeyFile } from './keyfile'
import type { KeptMailbox } from './mailbox'
import { wireEye } from './rememberPw'

/** What to back up: the words, the inbox's label, and what it keeps if its messages go too. */
export interface KeyFileContents {
  words: string
  label: string
  inbox?: KeptMailbox
}

/** What to back up, or why not (said under the box), or nothing yet. */
export type KeyFileSource = () => KeyFileContents | string | undefined | Promise<KeyFileContents | string | undefined>

export interface KeyFileBox {
  /** As it starts: closed, the password box blank and hidden, no error. */
  reset(): void
  /** Closed, with nothing typed left in it (the words' card closing). */
  empty(): void
}

/**
 * Wires the box whose ids start with prefix (`${prefix}`, `-pw`, `-pw2`, `-pw2-box`,
 * `-new`, `-save`, `-error`): a fold-out, or a panel that warms the password module itself.
 * source gives what to back up when Save is pressed, after checking the
 * words if it needs to.
 */
export function keyFileBox(prefix: string, source: KeyFileSource): KeyFileBox {
  const box = $(prefix)
  const details = box instanceof HTMLDetailsElement ? box : undefined
  const pw = $<HTMLInputElement>(`${prefix}-pw`)
  const save = $<HTMLButtonElement>(`${prefix}-save`)
  const error = $(`${prefix}-error`)
  const second = $<HTMLInputElement>(`${prefix}-pw2`)
  const secondBox = $(`${prefix}-pw2-box`)
  pw.placeholder = pwCopy.PLACEHOLDER
  const eyes = [pw, second].map((field) => wireEye(field.parentElement!.querySelector<HTMLButtonElement>('[data-pw-eye]')!, field))
  /** Both boxes filled (or emptied), the password hidden or shown, the second box there once there's one. */
  const fill = (value: string, shown = false) => {
    for (const field of [pw, second]) {
      field.value = value
      field.type = shown ? 'text' : 'password'
    }
    eyes.forEach((render) => render())
    secondBox.hidden = !value
    error.hidden = true
  }
  pw.addEventListener('input', () => {
    const typed = !!normalizePassword(pw.value)
    secondBox.hidden = !typed
    if (!typed) second.value = ''
    error.hidden = true
  })
  second.addEventListener('input', () => {
    error.hidden = true
  })
  $(`${prefix}-new`).textContent = copy.KEYFILE_NEW
  $(`${prefix}-new`).addEventListener('click', () => fill(suggestPassword(), true))
  // The password module is woken while the box is open, and let go after.
  details?.addEventListener('toggle', () => {
    if (details.open) warmKdf()
    else coolKdf()
  })
  save.addEventListener('click', async () => {
    const problem = keyFilePasswordProblem(pw.value)
    error.hidden = !problem
    if (problem) {
      error.textContent = problem === 'short' ? pwCopy.TOO_SHORT(MIN_KEY_FILE_PASSWORD) : pwCopy.TOO_LONG(MAX_PASSWORD)
      return
    }
    // Compared as it will be used: capitals and extra spaces don't matter (password.ts).
    if (normalizePassword(second.value) !== normalizePassword(pw.value)) {
      error.textContent = copy.REMEMBER_PW_MISMATCH
      error.hidden = false
      second.focus()
      return
    }
    if (save.disabled) return
    save.disabled = true
    try {
      const from = await source()
      if (typeof from === 'string') {
        error.textContent = from
        error.hidden = false
        return
      }
      if (!from?.words) return
      save.textContent = copy.KEYFILE_SAVING
      const text = await makeKeyFile(from.words, pw.value, undefined, from.label, from.inbox)
      saveBlob(new Blob([text], { type: KEY_FILE_TYPE }), from.inbox ? BACKUP_FILE_NAME : KEY_FILE_NAME)
      save.textContent = copy.KEYFILE_SAVED
    } catch {
      save.textContent = copy.KEYFILE_SAVE
      error.textContent = copy.KEYFILE_FAILED
      error.hidden = false
    } finally {
      save.disabled = false
    }
  })
  return {
    reset() {
      if (details) details.open = false
      fill('')
      save.textContent = copy.KEYFILE_SAVE
    },
    empty() {
      if (details) details.open = false
      fill('')
      save.textContent = copy.KEYFILE_SAVE
    },
  }
}
