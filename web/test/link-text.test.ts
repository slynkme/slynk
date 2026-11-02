// What the page says about one-time and expiring links. Run: npm --prefix web test
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import * as copy from '../src/burnCopy.ts'
import { atTime, cancelOutcome, optionsSummary, putProblem, unlockProblem, untilTime } from '../src/ui/linkText.ts'

// Local times, so the day boundaries are the visitor's own.
const now = new Date(2026, 9, 15, 9, 30)
const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m)

describe('times in words', () => {
  test('later today, tomorrow and another day', () => {
    assert.match(atTime(at(15, 14, 5), now), /^at \S*\d/)
    assert.match(atTime(at(16, 9, 30), now), /^tomorrow at /)
    assert.match(atTime(at(22, 9, 30), now), /^on .+ at /)
    assert.match(untilTime(at(15, 14, 5), now), /^\d/)
    assert.match(untilTime(at(16, 9, 30), now), /^tomorrow at /)
    assert.match(untilTime(at(22, 9, 30), now), /^\D.* at /)
  })

  test('just before and after midnight', () => {
    const late = new Date(2026, 9, 15, 23, 50)
    assert.match(atTime(at(16, 0, 50), late), /^tomorrow at /)
    assert.match(atTime(at(15, 23, 59), late), /^at /)
  })

  test('the sentences read naturally', () => {
    assert.match(copy.SENT_EXPIRING(atTime(at(16, 9, 30), now)), /^This link stops working tomorrow at .+, or sooner if you cancel it\.$/)
    // A one-time link's time is a backstop for a link nobody opens.
    assert.match(copy.SENT_ONE_TIME_EXPIRY(atTime(at(15, 14, 5), now)), /^If nobody opens it, it stops working at [^,]+\.$/)
    assert.match(copy.EXPIRY_LABEL_ONE_TIME, /^If not opened/)
    assert.match(copy.EXPIRING_BEFORE(untilTime(at(15, 10, 30), now)), /^This link works until \d.*, unless the sender cancels it\.$/)
  })
})

test('the closed Link options line', () => {
  assert.equal(optionsSummary(500, false), 'Lasts up to 3 weeks')
  assert.equal(optionsSummary(24, false), 'Stops after 1 day')
  assert.equal(optionsSummary(1, false), 'Stops after 1 hour')
  assert.equal(optionsSummary(168, true), 'One-time · 7 days')
  assert.equal(optionsSummary(500, true), 'One-time · up to 3 weeks')
})

test('setting up a link fails before anything is sent', () => {
  assert.equal(putProblem('busy').message, copy.PUT_BUSY)
  for (const r of ['unreachable', 'malformed', 'exists'] as const) assert.equal(putProblem(r).message, copy.PUT_UNREACHABLE)
  assert.equal(putProblem('busy').retry, true)
})

describe('unlocking', () => {
  const later = at(16, 9, 30)
  test('used or cancelled: one-time and expiring links say different things, with no retry', () => {
    const once = unlockProblem('used-or-cancelled', 'one-time', later, now)
    assert.deepEqual(once, { title: copy.USED_OR_CANCELLED_TITLE, message: copy.USED_OR_CANCELLED, retry: false })
    const exp = unlockProblem('used-or-cancelled', 'expiring', later, now)
    assert.deepEqual(exp, { title: copy.EXPIRING_GONE_TITLE, message: copy.EXPIRING_GONE, retry: false })
  })

  test('expired: says when, unless this device thinks it hasn’t happened yet', () => {
    assert.equal(unlockProblem('expired', 'expiring', later, now).message, copy.EXPIRED_NO_TIME)
    const past = new Date(Date.now() - 3 * 3600_000)
    assert.equal(unlockProblem('expired', 'one-time', past).message, copy.EXPIRED('3 hours ago'))
    assert.equal(unlockProblem('expired', 'one-time', past).retry, false)
  })

  test('slynk.me unreachable: retry, without promising nothing was used up', () => {
    for (const r of ['unreachable', 'malformed', 'busy', 'exists'] as const) {
      const once = unlockProblem(r, 'one-time', later, now)
      assert.equal(once.retry, true)
      assert.equal(once.message, copy.SERVER_DOWN_ONE_TIME)
      assert.equal(unlockProblem(r, 'expiring', later, now).message, copy.SERVER_DOWN_EXPIRING)
    }
  })

  test('damaged: a one-time link asks for a new link, not a fresh copy', () => {
    assert.equal(unlockProblem('damaged', 'one-time', later, now).message, copy.DAMAGED_ONE_TIME)
    assert.equal(unlockProblem('damaged', 'expiring', later, now).message, copy.DAMAGED)
  })
})

describe('cancelling', () => {
  const later = at(16, 9, 30)
  test('done', () => {
    assert.deepEqual(cancelOutcome({ ok: true }, 'one-time', later, now), { text: copy.CANCEL_DONE, cancelled: true, retry: false })
  })

  test('too late, gone, expired', () => {
    assert.equal(cancelOutcome({ ok: false, reason: 'used-or-cancelled' }, 'one-time', later, now).text, copy.CANCEL_TOO_LATE)
    assert.equal(cancelOutcome({ ok: false, reason: 'used-or-cancelled' }, 'expiring', later, now).text, copy.CANCEL_GONE)
    assert.equal(cancelOutcome({ ok: false, reason: 'expired' }, 'expiring', later, now).text, copy.CANCEL_EXPIRED)
  })

  test('past the link’s own expiry, it says expired whatever slynk.me answered', () => {
    const past = at(15, 9, 0)
    for (const r of [{ ok: true } as const, { ok: false, reason: 'unreachable' } as const]) {
      assert.deepEqual(cancelOutcome(r, 'one-time', past, now), { text: copy.CANCEL_EXPIRED, cancelled: false, retry: false })
    }
  })

  test('unreachable: the button stays', () => {
    for (const r of ['unreachable', 'malformed', 'busy'] as const) {
      assert.deepEqual(cancelOutcome({ ok: false, reason: r }, 'expiring', later, now), {
        text: copy.CANCEL_UNREACHABLE,
        cancelled: false,
        retry: true,
      })
    }
  })
})
