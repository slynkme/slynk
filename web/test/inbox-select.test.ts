// Selecting several at once: "Select" by the
// folders puts a tick box on every row, conversations too; a bar under the
// list archives, moves, marks or removes what's ticked, asking once before
// removing the lot, as honestly as for one. Run: npm --prefix web test
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import * as copy from '../src/inbox/inboxCopy.ts'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const owner = read('../src/inbox/owner.ts')
const html = read('../index.html')
const css = read('../src/style.css')
const between = (s: string, from: string, to: string) => {
  const at = s.indexOf(from)
  assert.ok(at >= 0, from)
  return s.slice(at, s.indexOf(to, at + from.length))
}

describe('the screen', () => {
  test('Select sits with the folders, at the end of their first line, and only when there’s something to select', () => {
    assert.match(html, /<div class="ib-folders-row">\s*<div class="ib-folders-line">\s*<div class="folders" id="ib-folders" role="group" aria-label="Folders"><\/div>\s*<!--[^>]*-->\s*<button class="btn mini ib-select" id="ib-select" type="button" aria-pressed="false" aria-controls="ib-list" data-copy-label="SELECT" hidden>/)
    // A tick box, with the word beside it on a computer; on a phone the tick box alone, so it shares the folders' line.
    assert.match(html, /<span class="ib-select-word" data-copy="SELECT"><\/span><\/button>/)
    assert.match(css, /@media \(max-width: 440px\) \{\n {2}\.btn\.ib-select \{\n {4}width: 32px;\n {4}padding: 0;\n {2}\}\n\n {2}\.ib-select-word \{\n {4}display: none;/)
    assert.match(owner, /\$\('ib-select'\)\.hidden = !items\.length/)
    assert.match(owner, /selectGo\.setAttribute\('aria-pressed', String\(selecting\)\)/)
    assert.equal(copy.SELECT, 'Select')
  })

  test('every row a tick box while selecting, conversations too; a tap ticks rather than opens', () => {
    assert.match(html, /<button class="mail-row" type="button">\s*<span class="mail-check" aria-hidden="true">/)
    assert.match(owner, /if \(selecting\) return tick\(key\)/)
    const row = between(owner, 'function fillRow(', '/** Redraws what')
    assert.match(row, /if \(selecting\) \{\n {6}button\.setAttribute\('role', 'checkbox'\)\n {6}button\.setAttribute\('aria-checked', String\(ticked\)\)\n {6}button\.removeAttribute\('aria-expanded'\)/)
    assert.match(css, /\.mail\[data-selecting\] \.mail-check \{\n {2}display: grid;/)
    // Starting folds a message that's open; a folder of its own, Lock, or an empty folder stops it.
    assert.match(between(owner, 'function setSelecting(', 'selectGo.addEventListener'), /if \(on\) \{\n {6}openId = undefined\n {6}closeOpenForms\(\)/)
    assert.match(between(owner, 'function showFolder(', 'let formMode'), /selecting = false\n {4}selected\.clear\(\)/)
    assert.match(between(owner, 'function wipeMessages()', '// --- Opening'), /selecting = false\n {4}selected\.clear\(\)/)
    assert.match(owner, /if \(!items\.length\) selecting = false/)
  })

  test('the bar: first for the keyboard and screen readers, shown under the list at the foot of the screen', () => {
    assert.match(html, /<div class="ib-listwrap">\s*<!--[^>]*-->\s*<div class="select-bar" id="ib-select-bar" role="region" data-copy-label="SELECT_BAR" hidden>[\s\S]*?<\/div>\s*<ul class="mail" id="ib-list"/)
    assert.match(css, /\.select-bar \{\n {2}order: 1;\n {2}position: sticky;\n {2}bottom: 12px;/)
    assert.match(html, /<p class="select-count" id="ib-sel-count" role="status"><\/p>/)
    // Its menu opens upwards, from the foot of the screen.
    assert.match(css, /\.select-bar \.menu \{\n {2}top: auto;\n {2}bottom: calc\(100% \+ 6px\);/)
    // Escape asks the question away first, then stops selecting.
    assert.match(owner, /selBar\.addEventListener\('keydown', \(e\) => \{\n {4}if \(e\.key !== 'Escape'\) return\n {4}if \(!\$\('ib-sel-remove-ask'\)\.hidden\) \$\('ib-sel-remove-no'\)\.click\(\)\n {4}else setSelecting\(false\)/)
  })

  test('what it does: archive (or back to Inbox), move to a folder, mark read or unread, remove; then selecting stops', () => {
    assert.match(owner, /\$\('ib-sel-archive'\)\.addEventListener\('click', \(\) => moveTicked\(folder === ARCHIVE \? INBOX : ARCHIVE\)\)/)
    assert.match(owner, /for \(const r of picked\) if \(r\.kind === 'message' \? box\.move\(r\.item\.id, to\) : box\.moveThread\(r\.address, to\)\) moved = true/)
    assert.match(owner, /for \(const r of picked\) if \(r\.kind === 'message' \? box\.setRead\(r\.item\.id, read\) : box\.readThread\(r\.address, read\)\) marked = true/)
    // Read and unread are for what came in: not the owner's own one-way messages.
    assert.match(owner, /const markable = \(r: ListRow\) => \(r\.kind === 'message' \? !r\.item\.mine : !!r\.latest\)/)
    // Move to… offers the folders the Archive button doesn't, and is left out when there are none.
    assert.match(owner, /const moveTargets = \(\) => box\.folders\(\)\.filter\(\(f\) => f\.id !== folder && f\.id !== \(folder === ARCHIVE \? INBOX : ARCHIVE\)\)/)
    assert.match(owner, /\$\('ib-sel-move-wrap'\)\.hidden = !moveTargets\(\)\.length/)
    assert.match(between(owner, 'function doneSelecting(', '\n  }'), /setSelecting\(false\)\n {4}deps\.toast\(toast\)/)
  })
})

describe('the owner’s own folders', () => {
  test('on a line of their own under a small “Your folders”, so Inbox, Archive and New folder keep the first', () => {
    assert.match(html, /<div class="own-folders" id="ib-own-folders" hidden>\s*<span class="own-folders-label" id="ib-own-folders-label" data-copy="FOLDERS_OWN"><\/span>\s*<div class="folders" id="ib-own-folders-list" role="group" aria-labelledby="ib-own-folders-label"><\/div>/)
    const render = between(owner, 'function renderFolders()', 'function showFolder(')
    assert.match(render, /\$\('ib-folders'\)\.replaceChildren\(\.\.\.\[INBOX, ARCHIVE\]\.map\(\(id\) => folderChip\(\{ id, name: '' \}, counts\)\), add\)/)
    assert.match(render, /\$\('ib-own-folders-list'\)\.replaceChildren\(\.\.\.mine\.map\(\(f\) => folderChip\(f, counts\)\)\)\n {4}\$\('ib-own-folders'\)\.hidden = !mine\.length/)
    // The focus finds a folder's button on either line.
    assert.match(owner, /return \$\('ib-folders'\)\.querySelector<HTMLElement>\(at\) \?\? \$\('ib-own-folders-list'\)\.querySelector<HTMLElement>\(at\)/)
    assert.equal(owner.match(/\$\('ib-folders'\)\.querySelector/g)?.length, 1, 'only through folderButton')
    assert.equal(copy.FOLDERS_OWN, 'Your folders')
    // A line of the card's own, under New message too (no hole beside them), before New message's step.
    assert.match(css, /\.ib-listbar > \.own-folders \{\n {2}flex: 1 0 100%;\n {2}order: 1;/)
    assert.match(css, /\.ib-listbar > \.ib-new \{\n {2}flex-basis: 100%;\n {2}min-width: 0;\n {2}order: 2;/)
  })
})

describe('removing several, honestly', () => {
  test('one alone is asked about as it would be on its own; several, once for the lot', () => {
    const ask = between(owner, 'function removeTickedAsk(', "$('ib-sel-remove').addEventListener")
    assert.match(ask, /if \(r\.kind === 'thread'\) return copy\.CHAT_REMOVE_ASK\(keeping\)\n {6}return r\.item\.id === WELCOME \? copy\.WELCOME_REMOVE_ASK\(keeping\) : r\.item\.mine \? copy\.MINE_REMOVE_ASK\(keeping\) : copy\.REMOVE_ASK\(keeping\)/)
    assert.match(ask, /kept: keeping,/)
  })

  test('kept on this device: gone from it for good, though the network still holds what was sent to the inbox', () => {
    const all = copy.REMOVE_MANY_ASK('3 messages', { kept: true, received: true, own: false, welcome: false })
    assert.equal(all, 'Remove 3 messages for good? They won’t come back on this device, though the xx network holds messages sent to you, sealed, for up to about three weeks.')
    // Only the owner's own (and the welcome): nothing on the network to mention, but they still have theirs.
    assert.equal(copy.REMOVE_MANY_ASK('2 messages', { kept: true, received: false, own: true, welcome: true }), 'Remove 2 messages for good? They won’t come back on this device. The people you wrote to still have your messages.')
  })

  test('not kept: what was sent to the inbox comes back, and so does the welcome', () => {
    assert.equal(
      copy.REMOVE_MANY_ASK('1 message and 1 conversation', { kept: false, received: true, own: false, welcome: true }),
      'Remove 1 message and 1 conversation from the list? Messages sent to you come back next time you open your inbox, while the xx network still holds them. The welcome message comes back each time you unlock your inbox.',
    )
    assert.ok(!/for good|won’t come back/.test(copy.REMOVE_MANY_ASK('2 messages', { kept: false, received: true, own: true, welcome: false })))
  })

  test('nothing goes while any of it is busy; a conversation goes as it would from its chat', () => {
    const yes = between(owner, "$('ib-sel-remove-yes').addEventListener('click'", 'doneSelecting(copy.MANY_REMOVED')
    assert.match(yes, /const busy = r\.kind === 'thread' \? threadBusy\(r\.address\) : collecting && collecting === drops\.get\(r\.item\.id\) \? copy\.DROP_ONE_AT_A_TIME : ''\n {6}if \(busy\) return deps\.toast\(busy\)/)
    assert.match(yes, /if \(r\.kind === 'message'\) removeItem\(r\.item\.id\)\n {6}else removeThreadNow\(r\.address\)/)
    // The chat's own Remove uses the same.
    assert.match(owner, /const busy = threadBusy\(address\)\n {6}if \(busy\) return deps\.toast\(busy\)/)
  })

  test('a conversation with nothing being collected can be removed (found while building this: an empty check counted as busy)', () => {
    assert.match(between(owner, 'function threadBusy(', 'function removeThreadNow('), /e\.kind === 'in' && !!collecting && collecting === drops\.get\(e\.item\.id\)/)
  })

  test('the words: what’s ticked, counted plainly', () => {
    assert.equal(copy.COUNT_TICKED(1, 0), '1 message')
    assert.equal(copy.COUNT_TICKED(3, 0), '3 messages')
    assert.equal(copy.COUNT_TICKED(0, 1), '1 conversation')
    assert.equal(copy.COUNT_TICKED(2, 1), '2 messages and 1 conversation')
    assert.equal(copy.SELECTED(0), 'Tap messages to select them')
    assert.equal(copy.SELECTED(4), '4 selected')
    assert.equal(copy.MANY_ARCHIVED('2 messages'), '2 messages archived')
    assert.equal(copy.MANY_MOVED('1 conversation', 'Work'), '1 conversation moved to Work')
    assert.equal(copy.MANY_MARKED('3 messages', false), '3 messages marked as unread')
    assert.equal(copy.MANY_REMOVED('1 message'), '1 message removed')
  })
})
