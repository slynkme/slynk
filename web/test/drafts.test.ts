// Each recipient's own draft: text started on the front page for a
// link turned up, already written, in New message to an inbox, since both share one message box.
// Now the link and each inbox keep their own text as the box passes between them.
// Run: npm --prefix web test
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')

test('the box keeps one draft per recipient: the link’s, and each inbox’s by its key', () => {
  assert.match(main, /const draftKey = \(to: typeof addressed\): string => \(to \? inboxKey\(to\.address\) : ''\)/)
  assert.match(main, /function switchDraft\(from: string, to: string\) \{\n {2}if \(from === to\) return\n {2}if \(textBox\.value\) drafts\.set\(from, textBox\.value\)\n {2}else drafts\.delete\(from\)\n {2}textBox\.value = drafts\.get\(to\) \?\? ''\n {2}drafts\.delete\(to\)\n {2}void prepareMessage\(\)/)
})

test('writing to an inbox (New message, or its link) starts from that inbox’s draft, not the link’s', () => {
  assert.match(main, /switchDraft\(draftKey\(addressed\), inboxKey\(address\)\)\n {2}addressed = \{ address, checked: false \}/)
  // An address the core refuses: back to the link's text.
  assert.match(main, /if \(addressed !== to\) return\n {4}switchDraft\(draftKey\(to\), ''\)\n {4}addressed = undefined/)
})

test('back on the front page, or opening a link, the link’s message is there as it was left', () => {
  assert.match(main, /switchDraft\(draftKey\(addressed\), ''\) \/\/ the link's message, as it was left\n {4}addressed = undefined/)
  assert.match(main, /if \(addressed\) \{\n {4}switchDraft\(draftKey\(addressed\), ''\)\n {4}addressed = undefined\n {4}applyMode\(\)/)
})

test('"Make a link instead" takes what’s written along, as asked; with nothing written, the link’s draft comes back', () => {
  assert.match(main, /function clearAddress\(\) \{\n {2}const from = draftKey\(addressed\)\n {2}if \(textBox\.value\.trim\(\)\) \{\n {4}drafts\.delete\(from\)\n {4}drafts\.delete\(''\)\n {2}\} else switchDraft\(from, ''\)\n {2}addressed = undefined/)
})

test('drafts wait in memory only, and count as something to lose when leaving a local copy', () => {
  assert.match(main, /const drafts = new Map<string, string>\(\)/)
  assert.doesNotMatch(main, /localStorage|sessionStorage|indexedDB/)
  assert.match(main, /!textBox\.value\.trim\(\) && !draftsWaiting\(\) && !tray\.count\(\)\)/)
})
