// Text boxes: none lights up when tapped into, and every box
// that hides what's typed has an eye to show it.
// Run: npm --prefix web test
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const css = read('../src/style.css')
const html = read('../index.html')
const owner = read('../src/inbox/owner.ts')

test('no text box glows when it has the focus: one rule turns off the focus ring for all of them', () => {
  assert.match(
    css,
    /:is\(textarea, input:not\(\[type='checkbox'\], \[type='radio'\], \[type='file'\], \[type='range'\], \[type='button'\], \[type='submit'\]\)\):is\(:focus, :focus-visible\) \{\n {2}outline: none;\n\}/,
  )
  // Nothing gives a text box a coloured border or glow on focus.
  for (const rule of css.matchAll(/([^{}]*(?:textarea|input)[^{}]*:focus[^{}]*)\{([^}]*)\}/g)) {
    assert.doesNotMatch(rule[2], /box-shadow|border-color/, `${rule[1].trim()} lights up`)
  }
})

test('every box with a button inside keeps room for it, so a long passphrase never runs under the eye', () => {
  assert.match(css, /\.linkbox \.field-wrap > input,\n\.field-wrap > input\.pw-input \{\n {2}width: 100%;\n {2}min-width: 0;\n {2}padding-right: 44px;/)
})

test('every box that hides what’s typed has an eye beside it', () => {
  const hidden = [...html.matchAll(/<input id="([^"]+)"[^>]*type="password"[^>]*>/g)].map((m) => m[1])
  assert.ok(hidden.length >= 10)
  for (const id of hidden) {
    assert.match(html, new RegExp(`<button class="field-btn eye-btn"[^>]*aria-controls="${id}"`), `${id} has no eye`)
  }
})

test('the eye on "Remember my passphrase" starts shut, and shuts again whenever the box opens or closes', () => {
  assert.match(owner, /const rememberEye = wireEye\(\$<HTMLButtonElement>\('ib-remember-words-eye'\), rememberField, copy\.OPEN_SHOW, copy\.OPEN_HIDE\)/)
  assert.match(owner, /function hideRememberWords\(\) \{\n {4}rememberField\.value = ''\n {4}rememberField\.type = 'password'\n {4}rememberEye\(\)/)
  assert.equal((owner.match(/hideRememberWords\(\)/g) ?? []).length, 3) // defined, and called on opening and closing
})
