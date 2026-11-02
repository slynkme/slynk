// An optional password for an inbox's remembered words:
// with one, the words are sealed on the device as a key file is,
// under a label of their own, and opening asks for it; without one, nothing
// changes. The warnings say what it changes as it's typed.
// Run: npm --prefix web test
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { KeyFileError, makeKeyFile, openSealedWords, readKeyFile, sealWords } from '../src/inbox/keyfile.ts'
import * as copy from '../src/inbox/inboxCopy.ts'
import { MIN_PASSWORD, type Derive } from '../src/password.ts'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const fastDerive: Derive = async (password, salt) => new Uint8Array(createHash('sha256').update(password).update(salt).digest())
const WORDS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const PW = 'Tidy Melon Orbit Seven Lamp'

describe('sealing the words', () => {
  test('opens with the password, however it’s typed, and never with another', async () => {
    const sealed = await sealWords(`  ${WORDS.toUpperCase()} `, PW, fastDerive)
    assert.ok(!new TextDecoder().decode(sealed).includes('abandon'), 'nothing readable')
    assert.equal(await openSealedWords(sealed, 'tidy  melon orbit seven lamp ', fastDerive), WORDS)
    await assert.rejects(openSealedWords(sealed, 'tidy melon orbit seven lamb', fastDerive), (e) => e instanceof KeyFileError && e.code === 'wrong')
    await assert.rejects(openSealedWords(sealed, '', fastDerive), (e) => e instanceof KeyFileError && e.code === 'wrong')
    // A fresh salt and nonce each time.
    assert.notDeepEqual(await sealWords(WORDS, PW, fastDerive), sealed)
    // Tampered: refused, never misread.
    const bad = sealed.slice()
    bad[bad.length - 1] ^= 1
    await assert.rejects(openSealedWords(bad, PW, fastDerive), (e) => e instanceof KeyFileError && e.code === 'wrong')
  })

  test('a sealed record and a key file can never be taken for each other', async () => {
    const sealed = await sealWords(WORDS, PW, fastDerive)
    const file = await makeKeyFile(WORDS, PW, fastDerive)
    const fileBlob = Buffer.from(file.split('\n')[2].slice(3), 'base64url')
    await assert.rejects(openSealedWords(new Uint8Array(fileBlob), PW, fastDerive), (e) => e instanceof KeyFileError && e.code === 'wrong')
    const asFile = ['Slynk inbox key file', '', `v1.${Buffer.from(sealed).toString('base64url')}`, ''].join('\n')
    await assert.rejects(readKeyFile(asFile, PW, fastDerive), (e) => e instanceof KeyFileError && e.code === 'wrong')
    // Key files still read as before.
    assert.deepEqual(await readKeyFile(file, PW, fastDerive), { words: WORDS, label: '' })
    assert.match(read('../src/inbox/keyfile.ts'), /const WORDS_AAD = new TextEncoder\(\)\.encode\('slynk\/remembered-words\/v1'\)/)
  })
})

describe('on the device', () => {
  const kept = read('../src/inbox/kept.ts')
  const owner = read('../src/inbox/owner.ts')

  test('sealed words have a prefix of their own, so a password is known to be needed without reading any words', () => {
    assert.match(kept, /const SEALED = 'sealed:'/)
    assert.match(kept, /s\.put\(\{ v: 1, sealed: words \}, SEALED \+ name\)\n      s\.delete\(WORDS \+ name\)/)
    assert.match(kept, /export async function wordsRemembered\(name: string\): Promise<false \| 'plain' \| 'password'>/)
    // Relabelling reads keys, never the words.
    const relabel = kept.slice(kept.indexOf('export async function relabelWords'), kept.indexOf('export async function forgetWords'))
    assert.ok(!/s\.get\(/.test(relabel))
  })

  test('opening needs the password, and a wrong one opens nothing', () => {
    assert.match(owner, /if \(!password\) return 'password'\n      try \{\n        words = await openSealedWords\(found\.sealed, password\)/)
    assert.match(owner, /if \(e instanceof KeyFileError && e\.code === 'wrong'\) return 'wrong'/)
    // From the front page, the open screen asks for it.
    assert.match(read('../src/main.ts'), /if \(result === 'password'\) owner\.askPassword\(name\)/)
    // Hidden as it's typed when opening, with the usual eye.
    assert.match(owner, /const input = Object\.assign\(document\.createElement\('input'\), \{ id, type: 'password'/)
    assert.match(owner, /wireEye\(eye, input\)/)
  })
})

describe('the boxes and the warnings', () => {
  const html = read('../index.html')

  test('one box under each set of warnings, hidden as it’s typed, with the eye, and a second to type it again', () => {
    for (const p of ['ni', 'oi', 'ib']) {
      assert.match(html, new RegExp(`<input id="${p}-remember-pw" class="pw-input" type="password" [^>]*data-remember-pw="${p}-remember-warn" />\\s*<button class="field-btn eye-btn" type="button" aria-pressed="false" aria-controls="${p}-remember-pw" data-pw-eye>`), p)
      assert.ok(html.indexOf(`id="${p}-remember-warn"`) < html.indexOf(`id="${p}-remember-pw"`), `${p}: under the warnings`)
      // The second box, hidden until a password is begun.
      assert.match(html, new RegExp(`<div class="remember-pw-again" id="${p}-remember-pw2-box" hidden>\\s*<label class="opts-label" for="${p}-remember-pw2" data-copy="REMEMBER_PW_AGAIN"></label>\\s*<span class="field-wrap">\\s*<input id="${p}-remember-pw2" class="pw-input" type="password"`), p)
    }
    const pw = read('../src/inbox/rememberPw.ts')
    assert.match(pw, /\$\(`\$\{input\.id\}2-box`\)\.hidden = !typed/)
    assert.match(pw, /if \(normalizePassword\(again\(input\)\.value\) !== normalizePassword\(input\.value\)\) \{\n    sayError\(input, copy\.REMEMBER_PW_MISMATCH\)/)
    assert.equal(copy.REMEMBER_PW_AGAIN, 'Confirm your password')
    // Shown with the switch, and reset when the flow ends.
    assert.match(read('../src/inbox/create.ts'), /\$\('ni-remember-pw-box'\)\.hidden = !on/)
    assert.match(read('../src/inbox/owner.ts'), /\$\('oi-remember-pw-box'\)\.hidden = !rememberBox\.checked/)
  })

  test('optional, but a password given must be long enough', async () => {
    const pw = read('../src/inbox/rememberPw.ts')
    assert.match(pw, /if \(!normalizePassword\(input\.value\)\) return ''/)
    assert.match(pw, /pwCopy\.TOO_SHORT\(MIN_PASSWORD\)/)
    assert.ok(MIN_PASSWORD >= 8)
  })

  test('the warnings say what a password changes, and what it doesn’t', () => {
    assert.deepEqual(copy.REMEMBER_RISKS(false), [copy.REMEMBER_RISK_ANYONE, copy.REMEMBER_RISK_PLAIN, copy.REMEMBER_RISK_FOREVER, copy.REMEMBER_RISK_LOCK])
    assert.deepEqual(copy.REMEMBER_RISKS(true), [copy.REMEMBER_RISK_ANYONE_PW, copy.REMEMBER_RISK_PLAIN_PW, copy.REMEMBER_RISK_FOREVER, copy.REMEMBER_RISK_LOCK])
    assert.match(copy.REMEMBER_RISK_PLAIN, /^Without a password, your passphrase is saved as it is, not encrypted\./)
    assert.match(copy.REMEMBER_RISK_PLAIN_PW, /encrypted with your password, and so is everything kept with it/)
    assert.match(copy.REMEMBER_RISK_PLAIN_PW, /could still try to guess the password, so make it long and unusual/)
    assert.match(copy.REMEMBER_PW_HELP, /Forget the password, and your passphrase still opens your inbox\./)
    for (const t of [...copy.REMEMBER_RISKS(true), ...copy.REMEMBER_RISKS(false), copy.REMEMBER_PW_HELP, copy.REMEMBER_PW_LABEL]) {
      assert.ok(!/\block(ed)?\b/i.test(t.replace('Lock this device', '')), `"encrypted", not "locked": ${t}`)
      assert.ok(!/\b(we|us|our)\b/i.test(t), t)
    }
  })

  test('the About page says it, honestly', () => {
    const about = read('../about/index.html').replace(/\s+/g, ' ')
    const answer = about.slice(about.indexOf('<details id="inbox-remember">'), about.indexOf('</details>', about.indexOf('<details id="inbox-remember">')))
    assert.match(answer, /You can give your passphrase a password as you do\. It’s then encrypted on the device, and so is everything kept with it/)
    assert.match(answer, /It’s only as strong as it is hard to guess/)
    assert.match(answer, /If you forget the password, your passphrase still opens your inbox\./)
    assert.match(answer, /Without a password, your inbox opens with a tap, and the passphrase is saved as it is/)
  })
})

describe('showing the words again', () => {
  const owner = read('../src/inbox/owner.ts')
  const show = read('../src/inbox/showWords.ts')
  const html = read('../index.html')

  test('offered in the inbox’s menu only when the words are remembered with a password', () => {
    assert.match(owner, /if \(remembered === 'password'\) items\.push\(\{ label: copy\.SHOW_WORDS, run: \(\) => key && openShowWords\(key\.name\) \}\)/)
    assert.equal(copy.SHOW_WORDS, 'Show my passphrase…')
  })

  test('a card on top asks for the password, and shows the words only once it opens them', () => {
    assert.match(html, /<dialog id="words-show" class="sheet" aria-labelledby="words-show-title">/)
    assert.match(html, /<input id="words-show-pw" class="pw-input" type="password"/)
    assert.match(html, /<div id="words-show-words" hidden>/)
    assert.match(show, /words = await openSealedWords\(found\.sealed, password\)/)
    assert.ok(show.indexOf('openSealedWords(found.sealed, password)') < show.indexOf("$('words-show-words').hidden = false"))
    assert.match(show, /e instanceof KeyFileError && e\.code === 'wrong' \? copy\.SHOW_WORDS_WRONG/)
  })

  test('the words leave the page when the card closes, by any means, or the inbox locks', () => {
    assert.match(show, /d\.addEventListener\('close', clear\)/)
    assert.match(show, /d\.addEventListener\('cancel', clear\)/)
    // Its own buttons and the backdrop empty it at once, not when the close event comes.
    assert.match(show, /function closeCard\(\) \{\n {2}if \(dialog\(\)\.open\) dialog\(\)\.close\(\)\n {2}clear\(\)/)
    assert.match(show, /b\.addEventListener\('click', closeCard\)/)
    assert.match(show, /\$\('words-show-list'\)\.replaceChildren\(\)\n {2}\$\('words-show-words'\)\.hidden = true/)
    assert.match(owner, /function lock\(\) \{\n {4}if \(!info\) return\n {4}opened\+\+\n[^\n]*\n {4}closeShowWords\(\)/)
    assert.match(copy.SHOW_WORDS_CAREFUL, /^Make sure nobody can see your screen\. This passphrase is yours alone to hold/)
  })

  test('the card doesn’t offer to save the passphrase: it’s remembered', () => {
    assert.ok(!html.includes('words-show-kf'))
    assert.ok(!/keyFile/.test(show))
    // Copied numbered, one a line, as shown.
    assert.match(show, /copyText\(numberedWords\(shown\(\)\)/)
  })

  test('the About page says so', () => {
    assert.match(read('../about/index.html').replace(/\s+/g, ' '), /“Show my passphrase” in your inbox’s menu shows it once you type the password/)
  })
})
