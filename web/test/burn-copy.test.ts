// The proposed wording for one-time and expiring links must stay literally true
// (docs/findings/one-time-links.md). These checks catch mistakes found in
// review, should anyone edit the copy later.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import * as copy from '../src/burnCopy.ts'
import { EXPIRY_HOURS } from '../src/linkv2.ts'
import { goConst } from './helpers/keyserver.ts'
import { sitePage, seenOn } from './helpers/pages.ts'

/** Every piece of copy, with placeholders filled in. */
const all: Array<[string, string]> = Object.entries(copy).flatMap(([name, v]): Array<[string, string]> => {
  if (typeof v === 'string') return [[name, v]]
  if (typeof v === 'function') return [[name, (v as (s: string) => string)('{x}')]]
  return Object.entries(v as Record<string, string>).map(([k, s]) => [`${name}.${k}`, s])
})

describe('burn copy', () => {
  test('the required lines, word for word', () => {
    assert.equal(copy.SENT_ONE_TIME, 'One-time link. Don’t open it yourself: that uses it up.')
    assert.equal(copy.CANCEL_BUTTON, 'Cancel this link')
    assert.match(copy.USED_OR_CANCELLED_TITLE, /used or was cancelled/)
    assert.match(copy.ONE_TIME_AFTER, /close or reload/)
  })

  test('a server that can’t be reached never promises nothing was used up', () => {
    for (const s of [copy.SERVER_DOWN_TITLE, copy.SERVER_DOWN_ONE_TIME, copy.SERVER_DOWN_EXPIRING]) {
      assert.doesNotMatch(s, /nothing/i)
      assert.doesNotMatch(s, /(not|n’t) (been )?used/i)
    }
    // The retry window it mentions is the server's.
    assert.match(copy.SERVER_DOWN_ONE_TIME, /10 minutes/)
    assert.equal(goConst('ClaimRetry'), 600)
  })

  test('no IP-address warnings, no overclaims, no unconfirmed backup period', () => {
    for (const [name, s] of all) {
      assert.doesNotMatch(s, /\bIP\b|address/i, name)
      assert.doesNotMatch(s, /can never|never be (read|decrypted|opened)|cryptographically|forever|permanently/i, name)
    }

  })

  test('the cancel token is lost on leaving the screen, on reload and on close', () => {
    assert.match(copy.CANCEL_HELP, /leave/)
    assert.match(copy.CANCEL_HELP, /close or reload/)
  })

  test('the screens stay plain; the About page explains how these links work', () => {
    for (const [name, s] of all) assert.doesNotMatch(s, /half of the key|half-key|backup/i, name)
    const about = seenOn(sitePage('about/index.html')).replace(/\s+/g, ' ')
    // Held, not stored: a computer set up for nothing else, in its memory only.
    assert.match(about, /a key in two random halves\. One goes in the link\. The other is held by slynk\.me’s key server, a separate computer set up for nothing else: it holds that half in its memory only, never your data or the link, and never writes it to its disk while it runs\./)
    assert.match(about, /deletes it after the link is used up, cancelled or expired/)
    assert.match(about, /stay on the mixnet for up to three weeks, but can’t be read without it/)
    // Who opens which link: what slynk.me keeps, and where (its key server, memory only).
    assert.match(about, /slynk\.me never knows what’s in a link, and keeps no record of who opens which one\. Its half of the key lives on slynk\.me’s own key server, only in its memory: never logged, not written to its disk while it runs/)
    assert.match(about, /It stores no internet addresses, and files each half under a code that can’t be turned back into the link/)
    // Cover requests (burnCover.ts): the page sends them, and they look like real ones.
    assert.match(about, /Your page also sends it the odd empty request, which looks just like a real one, so nobody watching can tell which visitors sent or opened a link\. \(You can turn these off in Settings, under Cover requests\.\)/)
    // Keeping the link safe is what matters most now.
    assert.match(about, /so the link itself is what matters most\. Treat it like a key: share it in person or through an encrypted app you trust/)
    assert.match(about, /While few people use Slynk, the times of visits to the website could still hint at who sent something to whom, and a VPN adds an extra layer of privacy\./)
    // The website keeps no visit logs (VISIT_LOGS, site-rules.test.ts); and no backups of halves to mention any more.
    assert.match(about, /No visit logs\.<\/strong> When you use slynk\.me’s website, it keeps no record of visits/)
    assert.doesNotMatch(about, /backups may still hold a deleted half/)
    assert.doesNotMatch(about, /It can tell that a link is being opened/)
    assert.match(about, /Only slynk\.me, for the page itself and, for one-time links, its key server; and the xx network/)
    // A one-time link is used up by the button, never by opening the link.
    assert.match(about, /Opening the link does nothing by itself/)
  })

  test('the expiry choices match the link format', () => {
    assert.deepEqual(Object.keys(copy.EXPIRY_OPTIONS).map(Number), [...EXPIRY_HOURS])
  })

  test('consistent typography: curly apostrophes, no empty strings', () => {
    for (const [name, s] of all) {
      assert.ok(s.trim().length > 0, name)
      assert.doesNotMatch(s, /'/, `${name} uses ’`)
    }
  })
})
