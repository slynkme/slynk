// "Show my passphrase…": from the inbox's menu,
// when its words are remembered on this device with a password, a card on
// top asks for that password and shows the words, so an owner who has lost
// their written copy can get them back. Without the password nothing shows.
// The words are on screen only while the card is open: closing it empties
// it, and the page keeps no copy.
import { $, copyText } from './dom'
import * as copy from './inboxCopy'
import { readWords } from './kept'
import { KeyFileError, numberedWords, openSealedWords } from './keyfile'
import { wireEye } from './rememberPw'

let wired = false
let record = '' // the kept record whose words the card is for, while it's open
let tries = 0 // bumps on every opening and closing, so a slow check never shows words in a later card

const dialog = () => $<HTMLDialogElement>('words-show')
const field = () => $<HTMLInputElement>('words-show-pw')

function say(text: string) {
  const el = $('words-show-error')
  el.textContent = text
  el.hidden = !text
}

/** Back as it starts: the password asked for, no words anywhere in the card. */
function clear() {
  tries++
  record = ''
  field().value = ''
  field().type = 'password'
  eyeRender?.()
  say('')
  $('words-show-list').replaceChildren()
  $('words-show-words').hidden = true
  $('words-show-ask').hidden = false
  $('words-show-go').textContent = copy.SHOW_WORDS_GO
  $<HTMLButtonElement>('words-show-go').disabled = false
  $('words-show-copy').textContent = copy.WORDS_COPY
}

let eyeRender: (() => void) | undefined

async function show() {
  const name = record
  const password = field().value
  if (!name) return
  if (!password) return field().focus()
  const go = $<HTMLButtonElement>('words-show-go')
  if (go.disabled) return
  const run = ++tries
  say('')
  go.disabled = true
  go.textContent = copy.SHOW_WORDS_CHECKING
  let words: string
  try {
    const found = await readWords(name)
    if (!found || !('sealed' in found)) throw new Error('none')
    words = await openSealedWords(found.sealed, password)
  } catch (e) {
    if (run !== tries) return
    go.disabled = false
    go.textContent = copy.SHOW_WORDS_GO
    say(e instanceof KeyFileError && e.code === 'wrong' ? copy.SHOW_WORDS_WRONG : copy.SHOW_WORDS_FAILED)
    return field().select()
  }
  if (run !== tries) return
  field().value = ''
  $('words-show-list').replaceChildren(...words.split(' ').map((w) => Object.assign(document.createElement('li'), { textContent: w })))
  $('words-show-ask').hidden = true
  $('words-show-words').hidden = false
  $('words-show-title').focus()
}

/** Closes the card and empties it at once, without waiting for the dialog's close event. */
function closeCard() {
  if (dialog().open) dialog().close()
  clear()
}

function wire() {
  if (wired) return
  wired = true
  const d = dialog()
  d.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeCard))
  d.addEventListener('click', (e) => {
    if (e.target === d) closeCard() // click on the backdrop
  })
  // Escape (cancel), and any other way it closes: the words leave the page.
  d.addEventListener('cancel', clear)
  d.addEventListener('close', clear)
  eyeRender = wireEye($<HTMLButtonElement>('words-show-eye'), field())
  $('words-show-go').addEventListener('click', () => void show())
  field().addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void show()
    }
  })
  field().addEventListener('input', () => say(''))
  const shown = () => [...$('words-show-list').querySelectorAll('li')].map((li) => li.textContent).join(' ')
  $('words-show-copy').addEventListener('click', async () => {
    const b = $('words-show-copy')
    // Numbered, one a line, as they're shown. Said on the button: a toast would sit behind the card.
    await copyText(numberedWords(shown()), copy.WORDS_COPIED, (text) => {
      b.textContent = text
      setTimeout(() => (b.textContent = copy.WORDS_COPY), 1500)
    })
  })
}

/** Opens the card for the kept inbox whose words are remembered here with a password. */
export function openShowWords(name: string) {
  wire()
  const d = dialog()
  if (d.open) return
  clear()
  record = name
  d.showModal()
  // The title takes the focus, not the close button: Safari rings a button focused on opening.
  $('words-show-title').focus()
}

/** The inbox locked or was forgotten: a card still open closes, and its words go. */
export function closeShowWords() {
  if (dialog().open) closeCard()
}
