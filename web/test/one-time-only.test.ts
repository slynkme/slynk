// slynk.me's rule (site.ts, and the key server's -one-time-only, on by
// default): every link opens once only, and the first opener's tap holds it so
// anyone else with the link is turned away before joining the mixnet. The key
// server's side is tested in Go (core/keyserver). Run: npm --prefix web test
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { after, before, describe, test } from 'node:test'
import * as copy from '../src/burnCopy.ts'
import { newNonce, protect, reserve, unlock, type NetOptions } from '../src/burn.ts'
import { buildLinkV2, parseLinkFragment, type LinkV2 } from '../src/linkv2.ts'
import { LINK_LENGTH, linkToFragment } from '../src/payload.ts'
import { ONE_TIME_ONLY, opensHere } from '../src/site.ts'
import { reserveProblem, unlockProblem } from '../src/ui/linkText.ts'
import { goConst, hasGo, startKeyServer, type KeyServer } from './helpers/keyserver.ts'

const skip = hasGo() ? false : 'needs the Go toolchain'
const HOLD = goConst('Hold')

test('the page opens one-time links only, holds them before connecting, and never connects on load for a link', () => {
  assert.deepEqual(['ordinary', 'expiring', 'one-time'].map((k) => opensHere(k as 'one-time')), [false, false, true])
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
  const collect = main.slice(main.indexOf('async function collect()'), main.indexOf('// A download that goes quiet'))
  assert.ok(collect.indexOf('await reserve(') > 0 && collect.indexOf('await reserve(') < collect.indexOf('whenReady(receive)'), 'holds before it connects')
  assert.match(collect, /if \(inc\.kind === 'one-time'\) \{/, 'every one-time link, failing closed without its link or nonce')
  assert.match(main, /if \(!opensHere\(link\.kind\)\) \{/)
  assert.match(main, /if \(settings\(\)\.connectOnLoad && !openedOnLink\) ensureConnected\(\)/)
  // Retrying a one-time download goes through a fresh tap, which holds it again.
  assert.match(main, /const retry = inc\.kind === 'one-time' \? \(\) => tapAgain\(inc\) : receive/)
})

test('the rule is on, in the page and in the key server alike', () => {
  assert.equal(ONE_TIME_ONLY, true)
  assert.match(readFileSync(new URL('../../core/keyserver/server.go', import.meta.url), 'utf8'), /^\s*OneTimeOnly: true,$/m)
  assert.doesNotMatch(readFileSync(new URL('../../deploy/keyserver/keyserver.service', import.meta.url), 'utf8'), /one-time-only=false/, 'slynk.me runs it so')
  assert.ok(HOLD >= 600 && HOLD <= 1800, 'long enough to connect and download 2 MB, short enough to free a failed one')
})

function fakeV1(): Uint8Array {
  const v1 = new Uint8Array(randomBytes(LINK_LENGTH))
  v1[0] = 1
  new DataView(v1.buffer).setBigUint64(66, BigInt(Date.now()) * 1_000_000n)
  return v1
}

describe('burn client with slynk.me’s rule', { skip }, () => {
  let srv: KeyServer
  let net: NetOptions
  before(async () => {
    srv = await startKeyServer()
    net = { endpoint: srv.endpoint, attempts: 1, timeoutMs: 5000 }
  })
  after(() => srv.stop())

  async function oneTime(envelope: Uint8Array) {
    const r = await protect(envelope, 'one-time', 24, net)
    assert.ok(r.ok)
    const parsed = parseLinkFragment(linkToFragment(buildLinkV2(fakeV1(), 'one-time', 24, r.share.L)))
    return { link: (parsed as { link: LinkV2 }).link, sealed: r.sealed }
  }

  test('the opener’s tap holds it; a second opener is turned away before downloading, then finds it used', async () => {
    const envelope = new Uint8Array(randomBytes(500))
    const { link, sealed } = await oneTime(envelope)
    const mine = newNonce()
    const theirs = newNonce()
    assert.deepEqual(await reserve(link, mine, net), { ok: true })
    assert.deepEqual(await reserve(link, theirs, net), { ok: false, reason: 'held' })
    assert.deepEqual(await unlock(link, sealed, theirs, net), { ok: false, reason: 'held' })
    const opened = await unlock(link, sealed, mine, net)
    assert.ok(opened.ok)
    assert.deepEqual(opened.envelope, envelope)
    assert.deepEqual(await reserve(link, theirs, net), { ok: false, reason: 'used-or-cancelled' })
  })

  test('the page can’t make an expiring link here', async () => {
    assert.deepEqual(await protect(new Uint8Array(10), 'expiring', 24, net), { ok: false, reason: 'malformed' })
  })

  test('a link past its own expiry is refused without asking slynk.me', async () => {
    const r = await protect(new Uint8Array(10), 'one-time', 1, net)
    assert.ok(r.ok)
    const v1 = fakeV1()
    new DataView(v1.buffer).setBigUint64(66, BigInt(Date.now() - 2 * 3_600_000) * 1_000_000n)
    const link = (parseLinkFragment(linkToFragment(buildLinkV2(v1, 'one-time', 1, r.share.L))) as { link: LinkV2 }).link
    assert.deepEqual(await reserve(link, newNonce(), { endpoint: 'http://127.0.0.1:9/nowhere', attempts: 1 }), { ok: false, reason: 'expired' })
  })
})

describe('wording for slynk.me’s rule', () => {
  const later = new Date(Date.now() + 3_600_000)

  test('turned away by a hold: say so, and allow a later try', () => {
    const held = reserveProblem('held', later)
    assert.deepEqual(held, { title: copy.HELD_TITLE, message: copy.HELD, retry: true })
    assert.match(copy.HELD, /15 minutes/)
    assert.equal(HOLD, 15 * 60)
    assert.deepEqual(unlockProblem('held', 'one-time', later), held)
  })

  test('used, cancelled or expired before the download: no retry; unreachable: retry, nothing promised', () => {
    assert.equal(reserveProblem('used-or-cancelled', later).title, copy.USED_OR_CANCELLED_TITLE)
    assert.equal(reserveProblem('used-or-cancelled', later).retry, false)
    assert.equal(reserveProblem('expired', new Date(Date.now() - 1000)).title, copy.EXPIRED_TITLE)
    const down = reserveProblem('unreachable', later)
    assert.equal(down.retry, true)
    assert.equal(down.message, copy.SERVER_DOWN_HOLD)
    assert.doesNotMatch(copy.SERVER_DOWN_HOLD, /nothing|used/i)
  })

  test('the rule line and the busy message promise nothing the page can’t keep', () => {
    assert.equal(copy.ONE_TIME_RULE, 'Every Slynk link opens once only.')
    assert.doesNotMatch(copy.PUT_BUSY, /minute/, 'a full store lasts longer than a minute')
  })

  test('no "ordinary link" fallback is offered any more', () => {
    for (const s of [copy.PUT_BUSY, copy.PUT_UNREACHABLE, copy.NOT_ONE_TIME]) assert.doesNotMatch(s, /ordinary/i)
  })

  test('the About page explains the rule, and the composer’s popup links to it', () => {
    const about = readFileSync(new URL('../about/index.html', import.meta.url), 'utf8').replace(/\s+/g, ' ')
    const page = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
    // "Why?" opens a short answer in a popup, the About answer a link away.
    assert.match(page, /<button class="soft-link" id="one-time-why" type="button" aria-haspopup="dialog"><\/button>/)
    const popup = page.slice(page.indexOf('<dialog id="once-why"'), page.indexOf('</dialog>', page.indexOf('<dialog id="once-why"')))
    assert.match(popup, /<a href="\/about\/#one-time-only" target="_blank" rel="noopener">More on the About page<\/a>/)
    assert.equal(copy.ONE_TIME_WHY_TITLE, 'Why does every link open only once?')
    // Below the password option, the one-time switch too when the rule is off; then a faint link to
    // Settings under a faint rule.
    const opts = page.slice(page.indexOf('<details class="link-opts" id="link-opts">'), page.indexOf('</details>', page.indexOf('<details class="link-opts" id="link-opts">')))
    assert.ok(opts.indexOf('id="pw-box"') < opts.indexOf('id="one-time"') && opts.indexOf('id="one-time"') < opts.indexOf('id="one-time-rule"'))
    assert.match(opts, /<p class="opts-more"><button class="soft-link" id="opts-settings" type="button" aria-haspopup="dialog"><\/button><\/p>\s*<\/div>\s*$/)
    assert.equal(copy.OPTIONS_MORE, 'More options are available in Settings')
    assert.match(readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8'), /\$\('opts-settings'\)\.addEventListener\('click', \(\) => openSettings\(\)\)/)
    assert.match(copy.ONE_TIME_WHY_TEXT.join(' '), /from one person to another/)
    assert.match(copy.ONE_TIME_WHY_TEXT.join(' '), /overwhelm the xx network/)
    assert.match(copy.ONE_TIME_WHY_TEXT.join(' '), /responsible/)
    for (const t of copy.ONE_TIME_WHY_TEXT) assert.ok(!/\b(we|us|our)\b/i.test(t), t)
    assert.match(about, /<details id="one-time-only"> <summary>Why does every link open only once\?<\/summary>/)
    assert.doesNotMatch(about, /An ordinary link can’t be taken back/)
    assert.doesNotMatch(about, /How do one-time and expiring links work\?/)
    assert.match(about, /turned away before they download it/)
    assert.match(about, /find out whether it’s still waiting to be opened, but only by starting to open it themselves, which holds it for 15 minutes/)
    // Forks may switch it off: the code must keep that a setting (src/site.ts makes it one switch).
    assert.match(about, /Any developer who wants to launch a similar service with their own version of Slynk’s code can switch that on/)
  })
})
