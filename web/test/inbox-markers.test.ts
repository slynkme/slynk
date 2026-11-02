// One inbox, two addresses: every
// message in the list, every conversation and the inbox being written to has
// a marker, a padlock (secure) or an atom (quantum-safe), that says what it
// means in one line when tapped; the two addresses are tabs only where one is
// shared. What a message or conversation is marked as is the mailbox's,
// tested in inbox-quantum.test.ts and inbox-reply-keys.test.ts; this pins
// where the markers are drawn, and their words. Run: npm --prefix web test
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import * as copy from '../src/inbox/inboxCopy.ts'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const html = read('../index.html')
const owner = read('../src/inbox/owner.ts')
const marker = read('../src/inbox/marker.ts')
const main = read('../src/main.ts')
const css = read('../src/style.css')

describe('where the markers are', () => {
  test('on every row, beside its button (a button can’t hold another): a message as it came, a conversation as its row is marked', () => {
    assert.match(
      html,
      /<template id="tpl-mail-row">\s*<li class="mail-item">\s*<div class="mail-head">\s*<button class="mail-row" type="button">[\s\S]*?<\/button>\s*<!--[^>]*-->\s*<span class="mail-mark" data-part="mark"><\/span>\s*<\/div>\s*<\/li>\s*<\/template>/,
    )
    assert.match(owner, /setMarker\(part\(li, 'mark'\), r\.kind === 'thread' \? r\.qs : !!r\.item\.qs, 'inbox'\)/)
    // Drawn over the end of the row's second line, which leaves it room; on the row's head, so a
    // message opened under it doesn't carry it down.
    assert.match(css, /\.mail-head \{\n {2}position: relative;\n\}/)
    assert.match(css, /\.mail-meta \{\n {2}padding-right: 22px;\n\}/)
    assert.match(css, /\.mail-mark \{\n {2}position: absolute;/)
  })

  test('on every message in a chat: theirs as it came, the owner’s once it has gone, as it went', () => {
    assert.match(owner, /if \(e\.kind === 'in'\) meta\.append\(marker\(!!e\.item\.qs, 'inbox'\)\)\n {4}else if \(e\.sent\.state === 'sent'\) meta\.append\(marker\(sentQs\(e\.sent\), 'inbox'\)\)/)
    // A message that changes state is drawn again (its marker shows once it has gone).
    assert.match(owner, /`\$\{e\.sent\.id\}\$\{e\.sent\.state\}/)
  })

  test('at the top of a chat, as its row is marked; a message opened in place keeps its row’s', () => {
    assert.match(html, /<span class="chat-name-row"><h3 class="chat-name" id="ib-c-name" tabindex="-1"><\/h3><span class="chat-mark" id="ib-c-mark"><\/span><\/span>/)
    assert.match(owner, /setMarker\(\$\('ib-c-mark'\), box\.threadQs\(address\), 'inbox'\)/)
    // Opened, it's in its row's box, under the row's head and its marker: no second one.
    assert.match(owner, /if \(openBox\.parentElement !== li\) li\.append\(openBox\)/)
    assert.ok(!html.includes('ib-r-mark'))
  })

  test('the composer stays as it is, and says which kind it writes to: the sender’s card and New message', () => {
    // The sender's card: after "To an anonymous inbox", a marker; an atom when it would go quantum-safe.
    // After "To a quantum-safe anonymous inbox", which says so, the atom alone, and an (i) explains
    // (in place of the "What's a quantum-safe inbox?" link).
    assert.match(html, /<span class="to-kind"><span class="opts-label" id="to-label" data-copy="TO_LABEL"><\/span><span class="to-mark" id="to-mark"><\/span><button class="to-what" id="to-qs" type="button" data-qs-why="sender" data-copy-label="QS_WHAT" hidden><svg [^>]*><circle cx="12" cy="12" r="9" \/>/)
    assert.match(main, /if \(isQuantumSafe\(addressed\.address\)\) setIcon\(\$\('to-mark'\), true\)\n {2}else setMarker\(\$\('to-mark'\), replyWithKeys\(\), 'sender'\)/)
    assert.match(main, /\$\('to-qs'\)\.hidden = !qs\n/)
    assert.ok(!/<button class="link-btn" id="to-qs"/.test(html), 'the text link is gone')
    // New message: once the box holds an inbox's address (or a name from the book), which kind it is.
    assert.match(html, /<p class="new-kind" id="ib-new-kind" role="status" hidden><\/p>/)
    assert.match(owner, /const el = \$\('ib-new-kind'\)\n {4}const address = addressFromInput\(newField\.value\) \?\? \(withBook\(\) \? box\.contactNamed\(newField\.value\)\?\.address : undefined\)/)
    assert.match(owner, /el\.replaceChildren\(markIcon\(qs\), qs \? copy\.KIND_QS : copy\.KIND_SECURE\)/)
    assert.equal(copy.KIND_SECURE, 'Secure inbox')
    assert.equal(copy.KIND_QS, 'Quantum-safe inbox')
    assert.match(owner, /newField\.addEventListener\('input', renderNewKind\)/)
    // Emptied as the step closes.
    assert.match(owner, /newField\.value = ''\n {4}renderNewKind\(\)/)
  })

  test('one unread count, and the usual note for a new message', () => {
    assert.match(owner, /const elsewhere = !!chatWith && i\.from\?\.key !== inboxKey\(chatWith\)\n {4}if \(deps\.onScreen\(\) && elsewhere\) deps\.toast\(i\.from \? copy\.NEW_FROM\(isolate\(plain\(whoIs\(i\.from\.address\)\)\)\) : copy\.NEW_MESSAGE\)/)
    assert.match(owner, /unread: box\.unread\(\), state/)
  })

  test('a note open on a marker closes when what it’s on is redrawn, or the screen changes', () => {
    assert.match(owner, /for \(const li of had\.values\(\)\) \{\n {6}closeMarksIn\(li\)\n {6}li\.remove\(\)/)
    assert.match(owner, /closeMenus\(\)\n {4}closeMarksIn\(log\)/)
    assert.match(owner, /closeMarks\(\) \/\/ a marker's note too\n {2}\}/)
  })
})

describe('the markers themselves', () => {
  test('a padlock and an atom, drawn as SVGs with no styles in them (the page’s rules forbid inline styles)', () => {
    assert.match(marker, /export const LOCK_SVG =\n {2}'<svg viewBox="0 0 24 24"[^']*<rect [^']*<\/svg>'/)
    assert.match(marker, /export const ATOM_SVG =\n {2}'<svg viewBox="0 0 24 24"[^']*(<ellipse [^']*){3}<circle [^']*<\/svg>'/)
    assert.ok(!/style=|setAttribute\('style'/.test(marker), 'no style attributes')
    assert.ok(!/style=/.test(html), 'none in the page either')
    // Which one, by the flag only.
    assert.match(marker, /button\.innerHTML = qs \? ATOM_SVG : LOCK_SVG \/\/ fixed markup/)
    assert.match(marker, /s\.innerHTML = qs \? ATOM_SVG : LOCK_SVG \/\/ fixed markup/)
  })

  test('tapped, it says what it means in one line, with a link to the explainer; its name for screen readers', () => {
    assert.match(marker, /button\.setAttribute\('aria-label', qs \? copy\.MARK_QS : copy\.MARK_SECURE\)/)
    assert.match(marker, /textContent: qs \? copy\.MARK_QS_NOTE : copy\.MARK_SECURE_NOTE/)
    assert.match(marker, /textContent: from === 'inbox' \? copy\.TABS_WHAT : copy\.QS_WHAT/)
    assert.match(marker, /button\.setAttribute\('aria-expanded', 'true'\)/)
    // Closed by a tap elsewhere, Escape, or another marker.
    assert.match(marker, /document\.addEventListener\('pointerdown'/)
    assert.match(marker, /if \(e\.key === 'Escape' && shown\)/)
    // A redraw keeps a marker that hasn't changed, and with it an open note.
    assert.match(marker, /if \(have\?\.classList\.contains\('mark'\) && have\.dataset\.qs === String\(qs\)\) return/)
  })

  test('a note opens towards the middle of the screen and stays on it: never cut off, never scrolling the page sideways', () => {
    // Placed once it shows (it has a size then), towards the side with more room...
    assert.match(marker, /note\.hidden = false\n {4}place\(wrap, note\)/)
    assert.match(marker, /wrap\.dataset\.side = w\.left \+ w\.width \/ 2 < width \/ 2 \? 'start' : 'end'/)
    // ...then moved in from an edge it would cross (found on a phone: a marker mid-screen).
    assert.match(marker, /const shift = n\.right > width - EDGE \? width - EDGE - n\.right : n\.left < EDGE \? EDGE - n\.left : 0/)
    assert.match(marker, /if \(!shift\) return\n {2}note\.style\.left = `\$\{Math\.round\(n\.left - w\.left \+ shift\)\}px`\n {2}note\.style\.right = 'auto'/)
    assert.match(marker, /const width = document\.documentElement\.clientWidth/)
    // Each time afresh.
    assert.match(marker, /function place\(wrap: HTMLElement, note: HTMLElement\) \{\n {2}note\.style\.left = ''\n {2}note\.style\.right = ''/)
  })

  test('the words: short, plain, and never "we"', () => {
    assert.equal(copy.MARK_SECURE, 'Secure')
    assert.equal(copy.MARK_QS, 'Quantum-safe')
    for (const t of [copy.MARK_SECURE_NOTE, copy.MARK_QS_NOTE]) {
      assert.ok(t.length <= 100, t)
      assert.equal(t.split(/[.!?](\s|$)/).filter((x) => x && x.trim()).length, 1, `one sentence: ${t}`)
      assert.ok(!/\b(we|us|our)\b/i.test(t), t)
    }
    assert.match(copy.MARK_SECURE_NOTE, /^Secure: /)
    assert.match(copy.MARK_QS_NOTE, /^Quantum-safe: .*quantum computer/)
    assert.ok(!/quantum-proof|unbreakable|guarantee/i.test(copy.MARK_QS_NOTE))
  })

  test('the explainer shows each marker after its name, so the two are known on sight', () => {
    const why = read('../src/inbox/qsWhy.ts')
    assert.match(why, /text\.split\(\/\(a padlock\|an atom\)\/\)/)
    assert.match(why, /copy\.TABS_WHY\.map\(withMarks\)/)
    // The words the icons follow are there to be found.
    assert.match(copy.TABS_WHY[0], /a padlock \(secure\) or an atom \(quantum-safe\)/)
  })

  test('styled: the atom in the accent colour, the note above what follows', () => {
    assert.match(css, /\.mark\[data-qs='true'\] \.mark-btn,\n\.mark-icon\[data-qs='true'\] \{\n {2}color: var\(--accent\);/)
    assert.match(css, /\.mark-note \{\n {2}position: absolute;[\s\S]*?z-index: 25;/)
    assert.match(css, /\.card\.note-open \{\n {2}z-index: 10;/)
    // A target a finger can hit, larger than the icon.
    assert.match(css, /\.mark-btn::after \{\n {2}content: '';\n {2}position: absolute;\n {2}inset: -8px;/)
  })
})
