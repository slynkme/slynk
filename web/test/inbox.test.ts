// The anonymous inbox's page code: addresses and routes,
// the key file, the wording's rules and the order the page reads a fragment
// in. Run: npm --prefix web test
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import {
  INBOX_ADDRESS_LENGTH,
  INBOX_ADDRESS_VERSION,
  NEW_INBOX_ROUTE,
  NOTICE_TEXT_MAX,
  OPEN_INBOX_ROUTE,
  addressFromInput,
  inboxLink,
  inboxRoute,
  textBytes,
} from '../src/inbox/address.ts'
import * as copy from '../src/inbox/inboxCopy.ts'
import { KEY_FILE_NAME, KeyFileError, MAX_KEY_FILE, isKeyFile, makeKeyFile, normalizeWords, numberedWords, readKeyFile } from '../src/inbox/keyfile.ts'
import { buildLinkV2, parseLinkFragment, toBase64url } from '../src/linkv2.ts'
import { LINK_LENGTH, linkToFragment } from '../src/payload.ts'
import type { Derive } from '../src/password.ts'
import { FACTS, INBOX_FACTS } from '../src/ui/facts.ts'
import { seenOn } from './helpers/pages.ts'

// The golden inbox of core/transfer/inbox_test.go ("abandon" x11, "about").
const GOLDEN = Buffer.from('03398330eaeb0a19e6abcfe411c31a0f2c3ef90a5b3cb7511a67177161bd919955', 'hex')
const goldenFragment = `#${toBase64url(GOLDEN)}`
const WORDS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

// A fast stand-in for Argon2id: the real one is checked in password.test.ts.
const fastDerive: Derive = async (password, salt) => new Uint8Array(createHash('sha256').update(password).update(salt).digest())

const v1Link = () => {
  const v1 = new Uint8Array(LINK_LENGTH)
  v1[0] = 1
  crypto.getRandomValues(v1.subarray(1))
  new DataView(v1.buffer).setBigUint64(1 + 32 + 33, BigInt(Date.now()) * 1_000_000n)
  return v1
}

describe('inbox addresses and routes', () => {
  test('an address is a version byte and a key, 44 characters in the fragment', () => {
    assert.equal(INBOX_ADDRESS_LENGTH, 33)
    assert.equal(INBOX_ADDRESS_VERSION, 3)
    assert.equal(goldenFragment.length, 45)
    const route = inboxRoute(goldenFragment)
    assert.equal(route?.kind, 'inbox')
    assert.deepEqual(route.kind === 'inbox' && [...route.address], [...GOLDEN])
    assert.equal(inboxRoute(goldenFragment.slice(1))?.kind, 'inbox', 'with or without the #')
  })

  test('the inbox pages have routes no link can be mistaken for', () => {
    assert.equal(inboxRoute(NEW_INBOX_ROUTE)?.kind, 'new-inbox')
    assert.equal(inboxRoute(OPEN_INBOX_ROUTE)?.kind, 'open-inbox')
    for (const route of [NEW_INBOX_ROUTE, OPEN_INBOX_ROUTE]) {
      assert.throws(() => parseLinkFragment(route), 'a route is never a link')
    }
  })

  test('anything that is not an address is left for the link code to judge', () => {
    const v1 = v1Link()
    const cases = [
      '',
      '#',
      `#${linkToFragment(v1)}`, // an ordinary link
      `#${toBase64url(buildLinkV2(v1, 'one-time', 24, crypto.getRandomValues(new Uint8Array(32))))}`, // a one-time link
      `#${toBase64url(Uint8Array.from([0x83, ...GOLDEN.subarray(1)]))}`, // the password flag on version 3
      `#${toBase64url(Uint8Array.from([2, ...GOLDEN.subarray(1)]))}`, // another version
      `#${toBase64url(GOLDEN.subarray(0, 32))}`, // too short
      `#${toBase64url(Buffer.concat([GOLDEN, Buffer.from([0])]))}`, // too long
      `${goldenFragment}=`, // padding
      goldenFragment.replace(/.$/, '+'), // not base64url
    ]
    for (const c of cases) assert.equal(inboxRoute(c), undefined, c)
  })

  test('an address fails the link parser, so the page must read inboxes first', () => {
    assert.throws(() => parseLinkFragment(goldenFragment))
    // readLinkFromAddress asks inboxRoute before parseLinkFragment and before
    // the one-time rule's refusal (opensHere), whatever ONE_TIME_ONLY says.
    const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
    const body = main.slice(main.indexOf('function readLinkFromAddress'))
    const route = body.indexOf('inboxRoute(fragment)')
    assert.ok(route > 0, 'readLinkFromAddress reads inbox routes')
    assert.ok(route < body.indexOf('parseLinkFragment(fragment)'), 'before parsing a link')
    assert.ok(route < body.indexOf('opensHere('), 'before the one-time refusal')
    assert.ok(!/ONE_TIME_ONLY|opensHere/.test(readFileSync(new URL('../src/inbox/address.ts', import.meta.url), 'utf8')), 'the rule never applies to addresses')
  })

  test('a link to an address, and an address pasted in any form', () => {
    const link = inboxLink('https://slynk.example', GOLDEN)
    assert.equal(link, `https://slynk.example/${goldenFragment}`)
    for (const pasted of [link, ` ${link} `, goldenFragment, goldenFragment.slice(1), `see ${link}`]) {
      assert.deepEqual(addressFromInput(pasted) && [...addressFromInput(pasted)!], [...GOLDEN], pasted)
    }
    for (const pasted of ['', 'hello', `#${linkToFragment(v1Link())}`, NEW_INBOX_ROUTE]) assert.equal(addressFromInput(pasted), undefined, pasted)
  })

  test('a message to an inbox fits one cMix message', () => {
    // 926 bytes of contents and 62 in the fingerprint and MAC fields, less
    // HPKE's encoded key and tag (48) and the notice's header (16):
    // MaxNoticeBody in core/transfer/inbox.go.
    assert.equal(NOTICE_TEXT_MAX, 926 + 62 - 48 - 16)
    assert.equal(textBytes('abc'), 3)
    assert.equal(textBytes('é'), 2)
    assert.equal(textBytes('🏠'), 4)
  })
})

describe('the saved passphrase', () => {
  test('locks the words with a password and opens with it, however it is typed', async () => {
    const text = await makeKeyFile(`  ${WORDS.toUpperCase()}  `, 'Tidy Melon Orbit Seven Lamp', fastDerive)
    assert.equal(isKeyFile(text), '')
    assert.ok(text.length < MAX_KEY_FILE)
    // Not a "key file" since 2026-10-22 (the name was confusing); older ones read the same.
    // "Restore from a backup file" since a backup can hold messages too (2026-10-24): every file says the open screen's words.
    assert.ok(text.startsWith('Your Slynk inbox passphrase backup\nTo use it, choose “Unlock my inbox” on the Slynk page, then “Restore from a backup file”.'))
    assert.equal(copy.OPEN_USE_FILE, 'Restore from a backup file')
    assert.deepEqual(await readKeyFile(text, 'tidy  melon orbit seven lamp ', fastDerive), { words: WORDS, label: '' })
    const old = text.replace('Your Slynk inbox passphrase backup', 'Slynk inbox key file')
    assert.deepEqual(await readKeyFile(old, 'tidy melon orbit seven lamp', fastDerive), { words: WORDS, label: '' }, 'one saved before the rename')
    assert.equal(KEY_FILE_NAME, 'slynk-passphrase-backup.txt')
  })

  test('carries the owner’s label for the inbox, cleaned, and only inside the lock', async () => {
    const text = await makeKeyFile(WORDS, 'tidy melon orbit seven lamp', fastDerive, '  Staff\u202e   concerns ')
    assert.ok(!/staff|concerns/i.test(text))
    assert.deepEqual(await readKeyFile(text, 'tidy melon orbit seven lamp', fastDerive), { words: WORDS, label: 'Staff concerns' })
  })

  test('says nothing about the inbox: no words and no name in the clear', async () => {
    const text = await makeKeyFile(WORDS, 'tidy melon orbit seven lamp', fastDerive)
    assert.ok(!text.includes('abandon'))
    assert.ok(!/architectonic/i.test(text))
    const again = await makeKeyFile(WORDS, 'tidy melon orbit seven lamp', fastDerive)
    assert.notEqual(text, again, 'a fresh salt and nonce every time')
  })

  test('a wrong password, another file, a newer one or a damaged one is refused', async () => {
    const text = await makeKeyFile(WORDS, 'tidy melon orbit seven lamp', fastDerive)
    const code = async (t: string, pw = 'tidy melon orbit seven lamp') => {
      try {
        await readKeyFile(t, pw, fastDerive)
        return 'opened'
      } catch (e) {
        assert.ok(e instanceof KeyFileError)
        return e.code
      }
    }
    assert.equal(await code(text, 'tidy melon orbit seven lamps'), 'wrong')
    assert.equal(await code(text, ''), 'wrong')
    assert.equal(await code('hello'), 'not-key-file')
    assert.equal(await code(text.replace('v1.', 'v3.')), 'newer')
    assert.equal(isKeyFile(text.replace('v1.', 'v3.')), 'newer')
    // A v1 line passed off as a backup with messages opens nothing: each is sealed under its own label.
    assert.equal(await code(text.replace('v1.', 'v2.')), 'wrong')
    assert.equal(await code(text.replace(/v1\.(.)/, (_, c) => `v1.${c === 'A' ? 'B' : 'A'}`)), 'wrong')
    assert.equal(await code(text.replace(/v1\..*/, 'v1.AAAA')), 'not-key-file')
    assert.equal(await code(text + 'x'.repeat(MAX_KEY_FILE)), 'not-key-file')
  })

  test('words are read the way the core reads them', () => {
    assert.equal(normalizeWords(' Abandon\tABOUT\n'), 'abandon about')
    assert.equal(normalizeWords('Abandon, about.'), 'abandon about')
  })

  test('"Copy the words" numbers them, one a line, and that list reads back as the words', () => {
    const words = 'abandon ability able about above absent absorb abstract absurd abuse access accident'
    const list = numberedWords(words)
    assert.equal(list.split('\n')[0], '1. abandon')
    assert.equal(list.split('\n')[11], '12. accident')
    assert.equal(normalizeWords(list), words)
    // Pasted into a one-line box, the line breaks go (HTML strips them from an input's value).
    assert.equal(normalizeWords(list.replace(/\n/g, '')), words)
    // Or a notes app turns them into spaces, or adds its own.
    assert.equal(normalizeWords(list.replace(/\n/g, '\r\n ')), words)
  })
})

describe('the inbox wording', () => {
  // Text with names in it (copy.Part[]) is read as it shows, with a name in place.
  const shown = (r: unknown): string => (Array.isArray(r) ? r.map((p) => (typeof p === 'string' ? p : (p as { name?: string }).name ?? String(p))).join('') : String(r))
  const call = (f: (...a: unknown[]) => unknown) => {
    try {
      return shown(f(1, 2))
    } catch {
      return shown(f([{ name: 'Sam' }], 'Alex'))
    }
  }
  const texts = Object.values(copy).flatMap((v) =>
    typeof v === 'string' ? [v] : Array.isArray(v) ? v.flat() : typeof v === 'function' ? [call(v as (...a: unknown[]) => unknown)] : typeof v === 'object' ? Object.values(v as object).flat().map(String) : [],
  )

  test('never "tips", "server" or "hide", and no "us" standing for Slynk', () => {
    for (const t of texts) {
      assert.ok(!/\btips?\b/i.test(t), t)
      assert.ok(!/\bservers?\b/i.test(t), t)
      // Hiding revealed secrets (the Hide button, the eye's "Hide the words") is fine; the network never "hides".
      if (t !== 'Hide' && t !== copy.OPEN_HIDE && t !== copy.REMEMBER_PW_HIDE) assert.ok(!/\bhid(e|es|den|ing)\b/i.test(t), t)
      assert.ok(!/\b(us|we|our)\b/i.test(t.replace(/\byour?\b/gi, '')), t)
    }
  })

  test('the creation journey opens with what an inbox is for, led by the good causes', () => {
    assert.match(copy.PURPOSE_FOR, /organisations/)
    assert.deepEqual(copy.PURPOSE_USES.slice(0, 2), ['Refuges and support services', 'Charities'])
    // Each starts with a capital, and replying is what an inbox of one's own is also for.
    for (const u of copy.PURPOSE_USES) assert.match(u, /^[A-Z]/)
    assert.equal(copy.PURPOSE_REPLY, 'Writing to one of them? With your own inbox, they can reply to you.')
    // Under the list, not folded away.
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
    assert.match(html, /<ul class="uses" id="ni-uses"><\/ul>\n\s*<p class="lead-p" data-copy="PURPOSE_REPLY"><\/p>/)
    assert.equal((html.match(/data-copy="PURPOSE_REPLY"/g) ?? []).length, 1)
    assert.ok(copy.PURPOSE_USES.some((u) => /journalists/i.test(u)))
    assert.ok(copy.PURPOSE_USES.some((u) => /whistleblowing/i.test(u)))
  })

  test('back from "Show phrase again", the check asks for the same three words, keeping what was typed', () => {
    const create = readFileSync(new URL('../src/inbox/create.ts', import.meta.url), 'utf8')
    const show = create.slice(create.indexOf('function showCheck()'), create.indexOf("$('ni-saved').addEventListener"))
    assert.match(show, /if \(checkAt\.length\) \{\n {6}step\('check'\)/)
    assert.ok(show.indexOf('if (checkAt.length)') < show.indexOf('checkAt = pickPositions()'), 'chosen once')
    // Chosen afresh only for a new inbox: the flow's reset forgets them.
    assert.match(create, /function reset\(\) \{[\s\S]*?checkAt = \[\][\s\S]*?'ni-check-fields'/)
    assert.match(create, /\$\('ni-check-back'\)\.addEventListener\('click', \(\) => step\('words'\)\)/)
  })

  test('the words come first; copied words are numbered', () => {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
    const create = readFileSync(new URL('../src/inbox/create.ts', import.meta.url), 'utf8')
    assert.equal(copy.WORDS_TITLE, 'Your 12-word passphrase')
    // Kind, but clear it's all on them.
    assert.match(copy.WORDS_WARNING, /^It’s a lot to look after, but it’s what keeps your inbox yours: this passphrase is the only way in, and you alone hold it\./)
    // Short enough for "I’ve saved them" to stay in sight on a phone; the About page says the rest.
    assert.match(copy.WORDS_WARNING, /you alone hold it\. So keep it secret, and somewhere safe\.$/)
    assert.equal(copy.OPEN_WORDS_LABEL, 'Your 12-word passphrase')
    assert.ok(!Object.values(copy).some((v) => typeof v === 'string' && /key file|passphrase file/i.test(v)), 'no “key file” or “passphrase file” left in what people see')
    assert.match(create, /copyText\(numberedWords\(picked\?\.words \?\? ''\)/)
    // The three words to type back sit side by side, so the buttons stay in sight on a phone.
    const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8')
    assert.match(css, /\.check-words \{\n {2}display: grid;\n {2}grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/)
  })

  test('“Save passphrase as a file…” in the inbox’s menu: the passphrase typed again, checked as this inbox’s, then saved', () => {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
    const owner = readFileSync(new URL('../src/inbox/owner.ts', import.meta.url), 'utf8')
    // "Back up your inbox…" since it can hold the messages too (2026-10-24).
    assert.equal(copy.SAVEFILE_START, 'Back up your inbox…')
    assert.match(owner, /items\.splice\(1, 0, \{ label: copy\.SAVEFILE_START, run: askSaveFile \}\)/)
    // Its box hides what's typed, with an eye, and sits with the file's password and the same Save button as the last step's.
    assert.match(html, /<input id="ib-savefile-words" class="pw-input" type="password"/)
    assert.match(html, /aria-controls="ib-savefile-words" id="ib-savefile-words-eye"/)
    assert.match(html, /<div class="keyfile" id="ib-kf">[\s\S]*?id="ib-kf-save" type="button" data-copy="KEYFILE_SAVE"/)
    // Nothing is saved unless the words open this inbox.
    const check = owner.slice(owner.indexOf("const passphraseFile = keyFileBox('ib-kf'"), owner.indexOf('function askSaveFile()'))
    assert.match(check, /await deps\.core\(\)\.inboxCheckWords\(words\)/)
    assert.match(check, /checked\.address\.every\(\(b, i\) => b === at\[i\]\)\) return copy\.REMEMBER_WRONG/)
    // Closed with the other panels, and on Lock, it's emptied.
    assert.match(owner, /closeRemember\(false\)\n {4}closeSaveFile\(false\)\n {4}closeBlocked\(false\)\n {4}closeMarks\(\)/)
    assert.match(owner, /elsewhere = blocked = remembered = false\n {4}closeRemember\(false\)\n {4}closeSaveFile\(false\)\n {4}closeBlocked\(false\)/)
    assert.match(owner, /function closeSaveFile\(refocus = true\) \{\n {4}if \(\$\('ib-savefile-ask'\)\.hidden\) return\n {4}\$\('ib-savefile-ask'\)\.hidden = true\n {4}saveFileField\.value = ''/)
    assert.match(readFileSync(new URL('../about/index.html', import.meta.url), 'utf8'), /back it up as a file too if you want, then or later from your inbox’s menu\./)
  })

  test('the words, and the ready step with its link and QR code, start at the top of the card', () => {
    const create = readFileSync(new URL('../src/inbox/create.ts', import.meta.url), 'utf8')
    assert.match(create, /if \(next === 'words' \|\| next === 'ready'\) \$\('card'\)\.scrollIntoView\(\{ block: 'start', behavior: 'instant' \}\)/)
  })

  test('“Save my passphrase” is on the last step, under the remember switch, only while that’s off', () => {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
    const create = readFileSync(new URL('../src/inbox/create.ts', import.meta.url), 'utf8')
    const ready = html.slice(html.indexOf('<div class="step" id="ni-ready"'), html.indexOf('<!-- Opening an inbox'))
    assert.ok(ready.indexOf('id="ni-remember-row"') < ready.indexOf('id="ni-kf"'), 'under the switch')
    // Remembering, the way in, then backing up and the link and QR code (the order's own test is below).
    assert.ok(ready.indexOf('id="ni-remember-row"') < ready.indexOf('id="ni-open"'), 'remember, then open')
    assert.ok(html.indexOf('id="ni-kf"') > html.indexOf('id="ni-ready"'), 'not on the words step')
    // On the last step, and from the inbox's menu (2026-10-23), nowhere else.
    assert.equal((html.match(/data-copy="KEYFILE_SAVE"/g) ?? []).length, 2, 'the last step and the inbox’s menu')
    // A file, said so, unlike remembering it.
    assert.equal(copy.KEYFILE_SAVE, 'Save backup file')
    assert.equal(copy.KEYFILE_TITLE, 'Back up your passphrase (optional)')
    assert.equal(copy.KEYFILE_WHY, 'To unlock your inbox elsewhere, without this device remembering it')
    assert.match(html, /<summary><span data-copy="KEYFILE_TITLE"><\/span><span class="link-opts-now" data-copy="KEYFILE_WHY"><\/span><\/summary>/)
    assert.equal(copy.REMEMBER_LABEL, 'Remember my passphrase')
    assert.match(create, /\$\('ni-kf'\)\.hidden = on\n {4}if \(on\) \$<HTMLDetailsElement>\('ni-kf'\)\.open = false/)
    assert.match(create, /\$\('ni-remember-pw-box'\)\.hidden = true\n {4}\$\('ni-kf'\)\.hidden = false/)
  })

  test('the backup’s password box starts blank and hidden, with the eye, like the other password boxes', () => {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
    const box = readFileSync(new URL('../src/inbox/keyFileBox.ts', import.meta.url), 'utf8')
    for (const prefix of ['ni-kf', 'ib-kf']) {
      assert.match(html, new RegExp(`<span class="field-wrap">\\s*<input id="${prefix}-pw" class="pw-input" type="password"[^>]*>\\s*<button class="field-btn eye-btn" type="button" aria-pressed="false" aria-controls="${prefix}-pw" data-pw-eye>`), prefix)
      assert.match(html, new RegExp(`<p class="kf-actions">\\s*<button class="btn small" id="${prefix}-new" type="button"></button>\\s*<button class="btn small" id="${prefix}-save"`), prefix)
      // Typed again, to be sure, in a box of its own with its own eye.
      assert.match(html, new RegExp(`<div class="kf-again" id="${prefix}-pw2-box" hidden>\\s*<label class="opts-label" for="${prefix}-pw2" data-copy="REMEMBER_PW_AGAIN"></label>\\s*<span class="field-wrap">\\s*<input id="${prefix}-pw2" class="pw-input" type="password"[^>]*>\\s*<button class="field-btn eye-btn" type="button" aria-pressed="false" aria-controls="${prefix}-pw2" data-pw-eye>`), prefix)
    }
    assert.equal(copy.REMEMBER_PW_AGAIN, 'Confirm your password')
    assert.match(box, /if \(normalizePassword\(second\.value\) !== normalizePassword\(pw\.value\)\) \{\n {6}error\.textContent = copy\.REMEMBER_PW_MISMATCH/)
    // Shown once something's typed, gone (and emptied) when it isn't.
    assert.match(box, /secondBox\.hidden = !typed\n {4}if \(!typed\) second\.value = ''/)
    assert.match(box, /pw\.placeholder = pwCopy\.PLACEHOLDER/)
    assert.match(box, /const eyes = \[pw, second\]\.map\(\(field\) => wireEye\(field\.parentElement!\.querySelector<HTMLButtonElement>\('\[data-pw-eye\]'\)!, field\)\)/)
    // Blank and hidden whenever it starts; a suggestion fills it and shows it.
    assert.equal((box.match(/^ {6}fill\(''\)$/gm) ?? []).length, 2)
    assert.match(box, /fill\(suggestPassword\(\), true\)/)
    assert.doesNotMatch(box, /pw\.value = suggestPassword\(\)/)
    assert.equal(copy.KEYFILE_NEW, 'Suggest a password')
  })

  test('how long messages wait is "up to about three weeks", never a promise of more', () => {
    for (const t of texts.filter((t) => /week/.test(t))) assert.match(t, /up to about three weeks|at least once a week/i, t)
  })

  test('owners get one plain line on being seen using the network; senders one on that and one on timing', () => {
    // Plain words on screen: the About page names internet addresses.
    assert.equal(copy.OWNER_HONEST_IP, 'While your inbox is open, the mixnet gateways this tab connects through can see you using them. A VPN can add an extra layer of privacy.')
    // What anyone with the address can see stays on the About page.
    assert.ok(!('OWNER_HONEST_TIMING' in copy))
    assert.ok(!Object.values(copy).some((v) => typeof v === 'string' && /when messages arrive/.test(v)))
    assert.equal(copy.TO_HONEST_IP, 'The mixnet gateways can see you using them, but never what you write. A VPN can add an extra layer of privacy.')
    assert.match(copy.TO_HONEST_TIMING, /when you used Slynk/)
  })

  test('the link is the address: no codename on any screen, and the owner’s label is never one', () => {
    // A codename can't be a point of contact without a directory.
    assert.ok(!Object.keys(copy).some((k) => k.startsWith('NAME_')), 'the name picker is gone')
    assert.ok(!texts.some((t) => /name matches|codename|check (this|its) name/i.test(t)))
    assert.match(copy.TO_CHECK, /Make sure this link came from their own website, poster or leaflet/)
    assert.equal(copy.READY_SHARE, 'This is your inbox link. Share it or its QR code wherever people should find you.')
    // Where anyone people need to reach in confidence puts it, and a website, where people can check it's theirs.
    assert.equal(copy.READY_WHERE, 'If people need to reach you in confidence, put the code wherever they’ll see it: on posters, leaflets and notice boards, and on your website, where they can check it’s really yours.')
    assert.ok(!('READY_CHECK' in copy))
    // Not the only chance, said plainly, not bold, with the inbox's own Share button
    // named as it's labelled (2026-10-23).
    assert.equal(copy.READY_AGAIN, 'You don’t have to use it yet. To see it again, choose “Share” in your inbox.')
    assert.equal(copy.OWNER_SHARE, 'Share')
    assert.ok(!('READY_AGAIN_LEAD' in copy))
    // Top to bottom: remember, then Open my inbox now straight under it so it's
    // never out of sight, then backing up and the link and QR code folded away with all their text.
    const page = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
    const step = page.slice(page.indexOf('<div class="step" id="ni-ready"'), page.indexOf('<!-- Opening an inbox'))
    const order = ['id="ni-remember-row"', 'id="ni-remember-pw-box"', 'id="ni-open"', 'id="ni-kf"', 'id="ni-show"', 'data-copy="READY_KEEP"'].map((w) => step.indexOf(w))
    assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])), String(order))
    assert.equal(copy.READY_SHOW, 'Show inbox link / QR code')
    const fold = step.slice(step.indexOf('<details class="link-opts ready-share" id="ni-show">'), step.indexOf('data-copy="READY_KEEP"'))
    assert.match(fold, /^<details class="link-opts ready-share" id="ni-show">\s*<summary><span data-copy="READY_SHOW"><\/span><\/summary>/)
    for (const inside of ['id="ni-tabs"', 'id="ni-share-lead"', 'id="ni-link"', 'id="ni-qr"', 'id="ni-save-qr"', 'data-copy="READY_WHERE"', 'data-copy="READY_AGAIN"']) {
      assert.equal((step.match(new RegExp(inside, 'g')) ?? []).length, 1, inside)
      assert.ok(fold.includes(inside), inside)
    }
    assert.ok(fold.indexOf('id="ni-save-qr"') < fold.indexOf('data-copy="READY_WHERE"') && fold.indexOf('data-copy="READY_WHERE"') < fold.indexOf('data-copy="READY_AGAIN"'))
    assert.ok(!/<strong data-copy="READY_AGAIN"/.test(step), 'not bold')
    // Closed whenever the step starts again.
    const create = readFileSync(new URL('../src/inbox/create.ts', import.meta.url), 'utf8')
    assert.equal((create.match(/\$<HTMLDetailsElement>\('ni-show'\)\.open = false/g) ?? []).length, 2)
    assert.match(copy.LABEL_NOT_ADDRESS, /Only you see it/)
    assert.match(copy.LABEL_NOT_ADDRESS, /people can’t find or write to your inbox by this name, only through its link or QR code/)
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
    assert.ok(!/inbox-dot|tpl-inbox-name|ni-names|ni-find/.test(html), 'no name picker or colour dot in the page')
    const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
    assert.ok(!/inboxCandidates|inboxPick|inboxFindWord|showName|paintDot/.test(main + readFileSync(new URL('../src/inbox/create.ts', import.meta.url), 'utf8')))
  })

  test('making a link instead sits under the card, for someone else, never the inbox’s owner', () => {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
    const card = html.slice(html.indexOf('<section class="card" id="card">'), html.indexOf('<section class="how"'))
    const composer = card.slice(0, card.indexOf('</section>'))
    assert.ok(!composer.includes('id="to-clear"'), 'not under Send, inside the card')
    assert.match(html, /<p class="to-elsewhere" id="to-elsewhere" hidden><span id="to-elsewhere-text"><\/span> <button class="soft-link" id="to-clear"/)
    // With files to inboxes off, as on slynk.me, it's a file people come looking for.
    assert.equal(copy.TO_ELSEWHERE(true), 'Sending something to someone else?')
    assert.equal(copy.TO_ELSEWHERE(false), 'Sending a file?')
    const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
    assert.match(main, /\$\('to-elsewhere-text'\)\.textContent = inboxCopy\.TO_ELSEWHERE\(INBOX_FILES\)/)
  })

  test('the agreed expectations: a permanent address, what happens after it arrives, the size as the design', () => {
    assert.match(copy.PURPOSE_LEAD, /^An anonymous inbox is different to Slynk links: a permanent address you can publish/)
    assert.match(copy.PURPOSE_TRUST, /People will trust you with what they write/)
    assert.match(copy.TO_THEIRS, /^Only the inbox’s owner can read your message\. What happens to it after that is up to them/)
    // Compressed: about 350 words of English fit one piece, 235 two; said with room to spare.
    assert.match(copy.TO_SIZE(false), /^Room for about 300 words\. A message this size travels as a single piece, the hardest kind to trace\.$/)
    assert.match(copy.TO_SIZE(false, true), /^Room for about 200 words\. To a quantum-safe inbox, an anonymous or first message takes a bit longer\.$/)
    assert.ok(!/Room for/.test(copy.TO_SIZE(true)) && !/Room for/.test(copy.TO_SIZE(true, true)), 'no limit claimed where files and longer messages go')
  })

  test('the comparison never names an app, and promises senders nothing about their device that isn’t true', () => {
    const rows = [...copy.COMPARE_OWNER, ...copy.COMPARE_SENDER].flat()
    for (const t of rows) assert.ok(!/whatsapp|signal|telegram|messenger|imessage|instagram|facebook|snapchat|viber|wechat/i.test(t), t)
    assert.equal(copy.COMPARE_THEM, 'Most messaging apps')
    // Browser history keeps an inbox's link even after the page wipes it (checked in Firefox, 2026-10-16).
    const device = copy.COMPARE_SENDER.find(([what]) => what === 'On your device')!
    assert.match(device[2], /your browser’s history keeps the inbox’s link unless you use a private window/)
    assert.ok(!rows.some((t) => /keeps nothing on your device|nothing on your device/i.test(t)))
  })

  test('the facts shown while sending to an inbox say nothing about links or files', () => {
    assert.ok(INBOX_FACTS.length >= 8)
    for (const f of INBOX_FACTS) {
      assert.ok(FACTS.includes(f) || /single piece|only the inbox/.test(f), f)
      assert.ok(!/\blink\b|#|files?\b|photo|talking to whom/i.test(f), f)
    }
  })
})

describe('the About page on inboxes', () => {
  const about = seenOn(readFileSync(new URL('../about/index.html', import.meta.url), 'utf8')).replace(/\s+/g, ' ')
  // The inbox's own section, and its two answers under "In more depth" (the About rewrite, 2026-10-22).
  const section =
    about.slice(about.indexOf('id="inbox"'), about.indexOf('<details class="section" id="depth">')) +
    about.slice(about.indexOf('<details id="inbox-seen">'), about.indexOf('<details id="honest-node">'))

  test('leads with what an inbox is for, and the good causes', () => {
    assert.ok(section.indexOf('refuges and support services') < section.indexOf('How does an inbox work?'))
    assert.match(section, /made for organisations that people need to reach in confidence/)
  })

  test('says what others can see, plainly', () => {
    assert.match(section, /anyone who has it can work out its mailbox and ask the xx network when messages arrived there, and how many/)
    assert.match(section, /gateways their browser uses see their internet address alongside the inbox’s mailbox/)
    assert.match(section, /someone running one of its gateways could sometimes narrow down who sent a message to a particular inbox from its timing/)
    assert.match(section, /could see when you used Slynk/)
    assert.match(section, /isn’t a complete reporting channel/)
  })

  test('says slynk.me’s inboxes take short messages, and why', () => {
    assert.match(section, /Not on slynk\.me, for now: its inboxes take short messages/)
    assert.match(section, /could sometimes match a large upload to the internet address it came from, and to the inbox it was for/)
  })

  test('never "tips", and no promise past "about three weeks"', () => {
    assert.ok(!/\btips?\b/i.test(section))
    for (const m of section.matchAll(/[^.]*weeks?[^.]*\./g)) assert.match(m[0], /up to about three weeks|once a week/, m[0])
  })
})

describe('the key file password', () => {
  test('is longer than a link password needs, and the suggested words always pass', async () => {
    const { MIN_KEY_FILE_PASSWORD, keyFilePasswordProblem } = await import('../src/inbox/keyfile.ts')
    const { suggestPassword } = await import('../src/password.ts')
    assert.ok(MIN_KEY_FILE_PASSWORD >= 12)
    assert.equal(keyFilePasswordProblem('elevenchars'), 'short')
    assert.equal(keyFilePasswordProblem('twelve chars'), '')
    for (let i = 0; i < 200; i++) assert.equal(keyFilePasswordProblem(suggestPassword()), '')
    assert.equal(keyFilePasswordProblem('x'.repeat(201)), 'long')
  })
})

describe('the About page on hidden details', () => {
  const about = seenOn(readFileSync(new URL('../about/index.html', import.meta.url), 'utf8')).replace(/\s+/g, ' ')
  test('says cleaning happens on the visitor’s own device', () => {
    assert.match(about, /takes these out on your own device, in your browser\. Your files never go to slynk\.me, or anywhere else, to be cleaned/)
    assert.match(about, /like where a photo was taken, right on your own device/)
  })
})
