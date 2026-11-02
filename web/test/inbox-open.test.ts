// A one-way message opens in place in the list:
// its row's box grows to show it, with what can be done to it, and a tap on
// the row again (or Escape) folds it. Share, Lock, New message and the folders
// stay in view above, so there's no separate reader. On a phone nothing jumps:
// the row tapped stays where it is. Run: npm --prefix web test
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const owner = read('../src/inbox/owner.ts')
const html = read('../index.html')
const css = read('../src/style.css')
const between = (s: string, from: string, to: string) => {
  const at = s.indexOf(from)
  assert.ok(at >= 0, from)
  return s.slice(at, s.indexOf(to, at + from.length))
}

describe('a message opens in place', () => {
  test('no reader screen: the list, with Share and the folders above, or a conversation’s chat', () => {
    for (const gone of ['id="ib-reader"', 'ib-r-back', 'ib-r-title"', 'ib-r-avatar', 'ib-r-from', 'ib-r-when']) assert.ok(!html.includes(gone), gone)
    assert.match(owner, /card\.dataset\.view = chatting \? 'chat' : 'list'/)
    assert.ok(!owner.includes("'reader'"))
    assert.ok(!/function (back|renderReader|openMessage)\(/.test(owner))
  })

  test('its box goes into its row, under the row’s head, and home again, hidden, when it folds', () => {
    assert.match(html, /<div class="mail-open" id="ib-open" hidden>/)
    const place = between(owner, 'function placeOpen()', 'function renderOpen()')
    assert.match(place, /if \(openBox\.parentElement !== openHome\) openHome\.append\(openBox\)\n {6}openBox\.hidden = true/)
    assert.match(place, /if \(openBox\.parentElement !== li\) li\.append\(openBox\)/)
    // Locking puts it home before the list is emptied: it's part of the page, not of the list.
    assert.match(between(owner, 'function wipeMessages()', '// --- Opening'), /placeOpen\(\)\n {4}closeOpenForms\(\)\n {4}\$\('ib-list'\)\.replaceChildren\(\)/)
  })

  test('one at a time: opening another folds the last; a tap on the open one folds it; opening marks it read', () => {
    const toggle = between(owner, 'function toggleMessage(', 'const START_SHOWN')
    assert.match(toggle, /const opening = openId !== id\n {4}const closing = !opening \? shrinking\(\) : undefined\n {4}openId = opening \? id : undefined\n {4}if \(opening && box\.setRead\(id, true\)\) changed\(\)/)
    // A conversation still opens its chat; folders and the chat fold whatever was open.
    assert.match(between(owner, 'function tapRow(', 'function fillRow('), /if \(r\?\.kind === 'message'\) toggleMessage\(r\.item\.id\)\n {4}else if \(r\) openChat\(r\.address\.slice\(\)\)/)
    assert.match(between(owner, 'function openChat(', 'function saveDraft('), /openId = undefined\n {4}closeOpenForms\(\)/)
    assert.match(between(owner, 'function showFolder(', 'let formMode'), /openId = undefined\n {4}closeOpenForms\(\)/)
  })

  test('the list never shows what a message says: only the open one’s box draws its text', () => {
    const row = between(owner, 'function fillRow(', '/** Redraws what')
    assert.ok(!/\.body\b|shownText|linkedText/.test(row), 'a row never reads the text')
    assert.match(owner, /function renderOpen\(\) \{\n {4}const i = box\.get\(openId!\)!/)
    // Drawn again only for another message, so a box being typed in, or the focus, isn't lost to a redraw.
    assert.match(between(owner, 'function renderOpen()', '/** A line of the welcome'), /if \(openShown !== i\.id\) \{\n {6}openShown = i\.id/)
  })

  test('rows are kept and drawn again in place, so the open message, and what’s typed in it, stay put', () => {
    const list = between(owner, 'function renderList()', 'function renderNotes()')
    assert.match(list, /let li = had\.get\(key\)\n {6}if \(li\) \{/)
    assert.match(list, /if \(li === at\) at = li\.nextElementSibling\n {6}else list\.insertBefore\(li, at\)/)
    assert.ok(!list.includes('replaceChildren'), 'never the whole list at once')
    // A message moved away by another tab closes.
    assert.match(list, /if \(openId && !items\.some\(\(r\) => r\.kind === 'message' && r\.item\.id === openId\)\) openId = undefined/)
  })

  test('for keyboards and screen readers: a disclosure on a message’s row, Escape folds it, and the focus goes somewhere sensible', () => {
    const row = between(owner, 'function fillRow(', '/** Redraws what')
    assert.match(row, /if \(r\.kind === 'message'\) button\.setAttribute\('aria-expanded', String\(open\)\)\n {4}\}\n {4}if \(open\) button\.setAttribute\('aria-controls', 'ib-open'\)/)
    assert.match(owner, /\$\('ib-list'\)\.addEventListener\('keydown', \(e\) => \{[\s\S]{0,260}if \(rows\.get\(openId\)\?\.contains\(t\)\) fold\(\)/)
    // Folded (Escape, Mark as unread): the focus on its row. Gone (archived, moved, removed): the row
    // that takes its place, the one before if it was the last, or the folder's button.
    assert.match(between(owner, 'function fold(', 'function gone('), /row\?\.focus\(\{ preventScroll: true \}\)/)
    assert.match(between(owner, 'function gone(', 'function closeOpenForms('), /keys\.slice\(at \+ 1\)\.find\(\(k\) => rows\.has\(k\)\) \?\? keys\.slice\(0, Math\.max\(at, 0\)\)\.reverse\(\)\.find/)
    // Close, first of its buttons, folds it as a tap on its row does.
    assert.match(html, /<div class="mail-open-actions">\s*<!--[^>]*-->\s*<button class="btn mini ghost" id="ib-r-close" type="button" data-copy="READ_CLOSE"><\/button>\s*<button class="btn mini grad-btn" id="ib-r-copy"/)
    assert.match(owner, /\$\('ib-r-close'\)\.addEventListener\('click', \(\) => fold\(\)\)/)
    for (const [handler, to] of [
      ["$('ib-r-archive').addEventListener('click'", 'gone(i.id'],
      ['function moveOpen(', 'gone(id, copy.MOVED'],
      ["$('ib-r-remove-yes').addEventListener('click'", 'gone(id, copy.REMOVED)'],
      ['function markUnread(', 'fold(copy.MARKED_UNREAD)'],
    ])
      assert.ok(between(owner, handler, '\n  }').includes(to) || between(owner, handler, '\n  })').includes(to), handler)
  })
})

describe('a little motion', () => {
  test('the box grows open and shrinks away as it folds, after the scrolling that keeps the row put; none where less motion is asked for', () => {
    assert.match(owner, /const lessMotion = \(\) => matchMedia\('\(prefers-reduced-motion: reduce\)'\)\.matches/)
    const grow = between(owner, 'function grow()', 'function shrinking()')
    assert.match(grow, /if \(lessMotion\(\) \|\| openBox\.hidden\) return/)
    assert.match(grow, /\.animate\(\[\{ height: '0px', opacity: 0 \}, \{ height: `\$\{height\}px`, opacity: 1 \}\]/)
    assert.match(between(owner, 'function toggleMessage(', 'const OPEN_MS'), /if \(row && top !== undefined\) keepInPlace\(row, top, opening\)\n {4}if \(opening\) grow\(\)\n {4}else closing\?\.\(\)/)
    // What shrinks is a copy, with no IDs and out of reach (the real box has gone home), and it goes once done.
    const shrink = between(owner, 'function shrinking()', 'function keepInPlace(')
    assert.match(shrink, /if \(lessMotion\(\) \|\| !li \|\| openBox\.hidden\) return undefined/)
    assert.match(shrink, /for \(const el of \[ghost, \.\.\.ghost\.querySelectorAll\('\[id\]'\)\]\) el\.removeAttribute\('id'\)\n {4}ghost\.inert = true\n {4}ghost\.setAttribute\('aria-hidden', 'true'\)/)
    assert.match(shrink, /\.finally\(\(\) => \{\n {10}ghost\.remove\(\)\n {10}li\.classList\.remove\('closing'\)/)
    // The selection's ticks and bar: CSS animations, which the site's rule for less motion turns off.
    assert.match(css, /\.mail\[data-selecting\] \.mail-check \{\n {2}animation: tick-in 0\.2s var\(--ease\);/)
    assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\n {2}\*,\n {2}\*::before,\n {2}\*::after \{\n {4}animation: none !important;/)
  })
})

describe('an empty folder', () => {
  test('says so where the list would be, Inbox too from the start (2026-10-24); the status line counts what’s left', () => {
    assert.match(owner, /\$\('ib-empty'\)\.hidden = !!items\.length\n/)
    assert.match(between(owner, 'function render() {', 'let renderTimer'), /renderNotes\(\)\n[^\n]*\n {4}status\(\)\n {2}\}/)
    assert.match(css, /#ib-empty \{\n {2}margin-top: 12px;\n {2}padding: 18px 12px;\n {2}border: 1px dashed var\(--line-strong\);/)
  })
})

describe('no jumping about on a phone', () => {
  test('the row tapped stays where it was, whatever folded above it', () => {
    const keep = between(owner, 'function keepInPlace(', 'function fold(')
    assert.match(keep, /const moved = row\.getBoundingClientRect\(\)\.top - top\n {4}if \(moved\) window\.scrollBy\(\{ top: moved, behavior: 'instant' \}\)/)
    assert.match(between(owner, 'function toggleMessage(', 'const START_SHOWN'), /const top = row\?\.getBoundingClientRect\(\)\.top[\s\S]*render\(\)\n {4}if \(row && top !== undefined\) keepInPlace\(row, top, opening\)/)
  })

  test('opened past the bottom of the screen, it comes up only enough to show its start, never taking its row off the top', () => {
    const keep = between(owner, 'function keepInPlace(', 'function fold(')
    assert.match(owner, /const START_SHOWN = 160/)
    assert.match(keep, /const up = Math\.min\(shown\.top \+ Math\.min\(shown\.height, START_SHOWN\) \+ 12 - screen, row\.getBoundingClientRect\(\)\.top - 8\)/)
    assert.match(keep, /if \(up > 0\) window\.scrollBy\(\{ top: up, behavior: matchMedia\('\(prefers-reduced-motion: reduce\)'\)\.matches \? 'instant' : 'smooth' \}\)/)
  })

  test('messages arriving above the one being read don’t push it down', () => {
    const list = between(owner, 'function renderList()', 'function renderNotes()')
    assert.match(list, /const readingAt = reading && onScreen\(reading\) \? reading\.getBoundingClientRect\(\)\.top : undefined/)
    assert.match(list, /const moved = reading\.getBoundingClientRect\(\)\.top - readingAt\n {6}if \(moved\) window\.scrollBy\(\{ top: moved, behavior: 'instant' \}\)/)
  })

  test('its box is the row’s, grown: the marker stays on the row’s head', () => {
    assert.match(css, /\.mail-item:is\(\[data-open\], \.closing\) \{\n {2}border-radius: 12px;/)
    assert.match(css, /\.mail-open-body \{\n {2}padding-top: 12px;\n {2}border-top: 1px solid var\(--line\);/)
  })
})
