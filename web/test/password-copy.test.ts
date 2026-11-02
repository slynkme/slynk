// The wording for password links must stay true (see passwordCopy.ts), and
// the screens stay plain: how it works is on the About page, which must keep
// saying it.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { SUGGESTED_WORDS } from '../src/password.ts'
import * as copy from '../src/passwordCopy.ts'
import { AVOID, WORDS } from '../src/ui/words.ts'
import { chipText } from '../src/ui/cleaning.ts'

const all: Array<[string, string]> = Object.entries(copy).map(([name, v]) => [
  name,
  typeof v === 'function' ? (v as (n: number) => string)(8) : String(v),
])

const about = readFileSync(new URL('../about/index.html', import.meta.url), 'utf8').replace(/\s+/g, ' ')
const page = readFileSync(new URL('../index.html', import.meta.url), 'utf8').replace(/\s+/g, ' ')

describe('password copy', () => {
  test('plain words on the screens: no mechanics, no “server”, no “hide”', () => {
    for (const [name, s] of all) {
      assert.doesNotMatch(s, /argon|salt|derive|hash|encrypt|server|\bhid(e|den)\b|slynk\.me/i, name)
    }
  })

  test('says to pass the password on separately; a wrong one gives nothing away', () => {
    assert.match(copy.PASSWORD_HELP, /separately/)
    assert.match(copy.PASSWORD_HELP, /type your own/, 'the suggested words can be swapped')
    assert.match(copy.SENT_NOTE, /separately from the link/)
    for (const [name, s] of all) assert.doesNotMatch(s, /different way|used up/, name)
  })

  test('the sent screen no longer says the link alone opens it', () => {
    assert.match(page, /Anyone with this link<span id="sent-and-pw" hidden> and its password<\/span> can open it/)
  })

  test('the About page explains it', () => {
    assert.doesNotMatch(about, /Coming soon/)
    assert.match(about, /How do password links work\?/)
    assert.match(about, /never leaves your browser and isn’t in the link, so slynk\.me never sees it/)
    assert.match(about, /a lost password can’t be recovered/)
    assert.doesNotMatch(about, /us included|we can’t help/)
    assert.match(about, /Argon2id/)
    assert.match(about, /a wrong password never uses up a one-time link/)
    assert.match(about, /Pass it on separately from the link/)
    assert.match(about, /Capitals and extra spaces don’t matter/)
  })

  test('the About page’s numbers for suggested passwords match the word list', () => {
    const pool = WORDS.filter((w) => !AVOID.has(w)).length
    const choices = pool ** SUGGESTED_WORDS
    assert.match(about, new RegExp(`from a list of ${pool.toLocaleString('en-GB')} words`))
    assert.equal(SUGGESTED_WORDS, 5)
    assert.match(about, /Are five ordinary words really a strong password\?/)
    // "about 25,000,000,000,000,000": the leading figure, rounded.
    const shown = about.match(/about ([\d,]{20,}) possible passwords/)
    assert.ok(shown, 'the number of possible passwords')
    const n = Number(shown[1].replace(/,/g, ''))
    assert.ok(Math.abs(n - choices) / choices < 0.05, `${n} vs ${choices}`)
    // "around 400 years on average" at a million guesses a second.
    const years = choices / 2 / 1e6 / (365.25 * 24 * 3600)
    const said = Number(about.match(/need around (\d+) years on average/)?.[1])
    assert.ok(Math.abs(said - years) / years < 0.1, `${said} vs ${years.toFixed(0)}`)
  })

  test('the About page explains removing hidden details, and its limits', () => {
    assert.match(about, /What hidden details does Slynk remove\?/)
    assert.match(about, /It can’t remove what you can see/)
    assert.match(about, /that’s the sender’s word, not proof/)
    // PDFs are cleaned like every other file, with no box to tick.
    assert.match(about, /and PDF, Word, Excel, PowerPoint, OpenDocument and RTF files/)
    assert.match(about, /Signed files are left as they are, since cleaning would break the signature, and so are password-protected ones/)
    assert.doesNotMatch(about + page, /Clean hidden data from this PDF|tick the box under it/)
    // The chip the About page names, its promise, and the way back to the original.
    assert.match(about, /Tap “Cleaned” under a file/)
    assert.equal(chipText(false).chip, 'Cleaned')
    assert.match(about, /Only you see that list: it’s never sent or saved/)
    assert.match(page, /class="pop"[\s\S]*Send original instead[\s\S]*<\/div>/, 'the box sits in the chip’s list')
  })
})

test('the recipient’s password box hides what’s typed, with the eye inside it to check', () => {
  assert.match(page, /<input id="in-pw-field" class="pw-input" type="password"/)
  assert.match(page, /<button class="field-btn eye-btn" id="in-pw-show" type="button" aria-pressed="false" aria-controls="in-pw-field">/)
  assert.equal(copy.SHOW, 'Show the password')
  assert.equal(copy.STOP_SHOWING, 'Stop showing the password')
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
  // Hidden again whenever the box is emptied for a new link.
  assert.equal(main.split("inPwField.value = ''\n").length - 1, main.split("inPwField.value = ''\n    showInPw(false)").length - 1 + main.split("inPwField.value = ''\n  showInPw(false)").length - 1)
})
