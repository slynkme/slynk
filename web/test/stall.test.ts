// Wording for a download that has gone quiet. Run: npm --prefix web test
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { stallText, stoppedText } from '../src/ui/stall.ts'

test('a quiet download says how much has arrived, in plain words', () => {
  assert.equal(stallText(0, 5), 'Nothing has arrived yet. This is taking longer than usual.')
  assert.equal(
    stallText(216, 217),
    '216 of 217 pieces have arrived. The rest are taking longer than usual, so the link may be incomplete.',
  )
})

test('a stopped download says what to do next', () => {
  assert.match(stoppedText(0), /^Nothing arrived\./)
  assert.match(stoppedText(3), /^Some pieces never arrived/)
  for (const s of [stallText(0, 1), stallText(1, 2), stoppedText(0), stoppedText(1)]) {
    assert.doesNotMatch(s, /server|hide/i)
  }
})
