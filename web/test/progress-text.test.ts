// The line under the progress bar. Run from the repo root: npm --prefix web test
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { piecesText } from '../src/ui/format.ts'

const NBSP = '\u00a0'

test('short, the same both ways; the time left wraps as one piece', () => {
  const s = piecesText(2155, 2165, 3, false)
  assert.equal(s, `2155 of 2165 pieces${NBSP}· a${NBSP}few${NBSP}seconds${NBSP}left`)
  // The only place a narrow screen can break near the end is after the dot.
  assert.equal(s.slice(s.indexOf('·')).split(' ').length, 2)
  assert.equal(piecesText(1304, 2165, 95, true), `1304 of 2165 pieces${NBSP}· about${NBSP}2${NBSP}min${NBSP}left`)
  assert.equal(piecesText(500, 2165, 35, false).endsWith(`about${NBSP}35${NBSP}s${NBSP}left`), true)
  // 263 px at the page's size, measured 2026-10-15: one line from 360 px wide.
  // Keep the longest case no longer than it is now.
  assert.ok(piecesText(2155, 2165, 3, true).length <= 40)
})

test('before there is an estimate, and for tiny items', () => {
  assert.equal(piecesText(0, 2165, undefined, false), '0 of 2165 pieces')
  assert.equal(piecesText(0, 2165, undefined, true), '0 of 2165 pieces')
  assert.equal(piecesText(0, 1, undefined, true), 'Mixing it through the mixnet… small items take a few seconds.')
  assert.equal(piecesText(0, 2, undefined, false), 'Collecting it from the mixnet…')
  assert.equal(piecesText(1, 2, undefined, false), 'Almost there…')
})
