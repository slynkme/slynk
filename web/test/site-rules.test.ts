// slynk.me's rules are one switch each in src/site.ts: ONE_TIME_ONLY (every
// link opens once), INBOX_FILES (inboxes take messages only, off) and
// VISIT_LOGS (the website keeps none, off). A fork may change any, so the
// wording follows it: the pages' parts are
// chosen at build time (scripts/rules.ts) and burnCopy.ts at run time, and
// both versions are checked true here. The page's links with the rule off are
// tested against a key server in burn-client.test.ts. Run: npm --prefix web test
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { fillRules, type Rules } from '../scripts/rules.ts'
import { fillSiteName } from '../scripts/site-name.ts'
import * as copy from '../src/burnCopy.ts'
import { putProblem } from '../src/ui/linkText.ts'
import { INBOX_FILES, ONE_TIME_ONLY, VISIT_LOGS } from '../src/site.ts'
import { seenOn } from './helpers/pages.ts'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const SITE: Rules = { ONE_TIME_ONLY: true, INBOX_FILES: false, VISIT_LOGS: false }
/** The About page's text with these rules, as one line. */
const about = (rules: Rules) => seenOn(fillRules(read('../about/index.html'), rules)).replace(/\s+/g, ' ')
const RULES: Rules[] = [true, false].flatMap((o) => [true, false].flatMap((f) => [true, false].map((v) => ({ ONE_TIME_ONLY: o, INBOX_FILES: f, VISIT_LOGS: v }))))

test('slynk.me’s rules: links open once, inboxes take messages, no visit logs', () => {
  assert.deepEqual({ ONE_TIME_ONLY, INBOX_FILES, VISIT_LOGS }, SITE)
  assert.match(read('../vite.config.ts'), /fillRules\(html, \{ ONE_TIME_ONLY, INBOX_FILES, VISIT_LOGS \}\)/)
})

describe('choosing a rule’s part', () => {
  const page = [
    '<p>A link<!-- when ONE_TIME_ONLY --> that opens once<!-- /when -->.</p>',
    '  <!-- when ONE_TIME_ONLY -->',
    '  <p>On</p>',
    '  <!-- else -->',
    '  <p>Off</p>',
    '  <!-- /when -->',
    '  <!-- when !INBOX_FILES -->',
    '  <p>Messages only</p>',
    '  <!-- /when -->',
    '<p>End</p>',
  ].join('\n')

  test('inside a line or around lines, with or without an else, and "!" for off', () => {
    assert.equal(fillRules(page, SITE), '<p>A link that opens once.</p>\n  <p>On</p>\n  <p>Messages only</p>\n<p>End</p>')
    assert.equal(fillRules(page, { ONE_TIME_ONLY: false, INBOX_FILES: true, VISIT_LOGS: true }), '<p>A link.</p>\n  <p>Off</p>\n<p>End</p>')
  })

  test('anything else stops the build rather than reach a page with both versions', () => {
    assert.throws(() => fillRules('<!-- when NO_SUCH -->x<!-- /when -->', SITE), /no such rule/)
    assert.throws(() => fillRules('<!-- when ONE_TIME_ONLY -->a<!-- when INBOX_FILES -->b<!-- /when -->c<!-- /when -->', SITE), /nested|isn’t written/)
    assert.throws(() => fillRules('<!-- when ONE_TIME_ONLY -->no end', SITE), /isn’t written/)
    assert.throws(() => fillRules('stray <!-- else --> marker', SITE), /isn’t written/)
    assert.throws(() => fillRules('<!--when ONE_TIME_ONLY-->x<!--/when-->', SITE), /isn’t written/)
  })

  test('every page builds with any rules, and slynk.me’s are what the page says without markers', () => {
    for (const p of ['../index.html', '../about/index.html', '../public/404.html']) {
      for (const rules of RULES) assert.doesNotMatch(fillRules(read(p), rules), /<!-- (when|else|\/when)/, p)
    }
  })
})

describe('the one-time rule, both ways', () => {
  const on = about(SITE)
  const off = about({ ...SITE, ONE_TIME_ONLY: false })

  test('with it on (slynk.me), the About page says every link opens once, and why', () => {
    assert.match(on, /<details id="one-time-only"> <summary>Why does every link open only once\?<\/summary>/)
    assert.match(on, /Turn a message or a few files into a link that opens once\./)
    assert.match(on, /Every link opens once\. If nobody opens it, it stops working after up to three weeks/)
    assert.match(on, /Yes, until it’s opened: press Cancel this link/)
    assert.match(on, /<summary>How do one-time links work\?<\/summary>/)
    assert.match(on, /sending at most 2 MB, and making links that open once\./)
    assert.doesNotMatch(on, /ordinary link|expiring|full three weeks/i)
  })

  test('with it off, nothing says every link opens once, and the other kinds are described', () => {
    assert.doesNotMatch(off, /id="one-time-only"|open only once|opens only once|every link opens|that opens once|links that open once/i)
    assert.match(off, /Turn a message or a few files into a link\./)
    assert.match(off, /Up to three weeks\. .* or a one-time link, which stops working once it’s opened\./)
    assert.match(off, /Yes, if it’s a one-time link or one set to stop working within 7 days: press Cancel this link/)
    assert.match(off, /A link that lasts the full three weeks can’t be taken back/)
    assert.match(off, /<summary>How do one-time and expiring links work\?<\/summary>/)
    assert.match(off, /needs no key server at all: its whole key is in the link\./)
    assert.match(off, /for one-time and expiring links, its key server;/)
    assert.match(off, /And if it’s a one-time link, whatever it holds reaches the owner alone\./)
    assert.match(off, /reusing a tab’s identity wherever it safely can, and sending at most 2 MB\./)
    // Links to the answer that's gone come only from the composer's popup, which needs the rule on.
    assert.doesNotMatch(off, /href="#one-time-only"/)
    assert.match(read('../src/main.ts'), /\$\('one-time-rule'\)\.hidden = !ONE_TIME_ONLY/)
  })

  test('the composer’s failures offer an ordinary link only when there is one', () => {
    assert.equal(copy.PUT_BUSY, copy.putBusy(ONE_TIME_ONLY))
    assert.equal(copy.PUT_UNREACHABLE, copy.putUnreachable(ONE_TIME_ONLY))
    for (const s of [copy.putBusy(true), copy.putUnreachable(true)]) assert.doesNotMatch(s, /ordinary/)
    for (const s of [copy.putBusy(false), copy.putUnreachable(false)]) assert.match(s, /, or send an ordinary link\.$/)
    assert.equal(copy.putUnreachable(true), 'Couldn’t reach slynk.me to set up this link. Check your connection and try again.')
    assert.equal(putProblem('busy').message, copy.PUT_BUSY)
  })
})

describe('inbox files, both ways', () => {
  const off = about(SITE)
  const on = about({ ...SITE, INBOX_FILES: true })

  test('off (slynk.me): its inboxes take short messages, and a fork may switch files on', () => {
    assert.match(off, /Not on slynk\.me, for now: its inboxes take short messages\./)
    assert.match(off, /Slynk’s code can send files and longer messages to an inbox too, with one setting switched on\./)
    assert.match(off, /A message travels as a single piece/)
    assert.doesNotMatch(off, /Files and longer messages travel as many pieces/)
  })

  test('on: files are taken, and what that risks is said with what to do about it', () => {
    assert.doesNotMatch(on, /Not on slynk\.me|setting switched on|doesn’t collect files/)
    assert.match(on, /<summary>Can people send files to an inbox\?<\/summary> <p> Yes: files, and messages too long for one piece, up to 2 MB in all\./)
    assert.match(on, /A short message travels as a single piece/)
    assert.match(on, /Files and longer messages travel as many pieces\. .* A VPN keeps your address from them; a short message on its own is the most discreet way to write\./)
    assert.match(on, /but files travel as many pieces, .* could point at who wrote to them\. A VPN keeps your address from them\./)
  })
})

describe('visit logs, both ways', () => {
  const none = about(SITE)
  const kept = about({ ...SITE, VISIT_LOGS: true })

  test('none (slynk.me): said plainly, with what its hosting provider still sees', () => {
    assert.match(none, /<strong>No visit logs\.<\/strong> When you use slynk\.me’s website, it keeps no record of visits: not your internet address, not when you came, not what you loaded\. \(Its hosting provider can still see connections: see <a href="#honest-limits">The honest limits<\/a>\.\)/)
    assert.match(none, /<h3 id="honest-limits">The honest limits<\/h3>/)
    assert.match(none, /The website’s hosting provider can see connections\.<\/strong> slynk\.me’s website keeps no visit logs, but its hosting provider, like any network your connection passes through, can see that your internet address connected, and when\. Never what you send, or which links you open\./)
    assert.doesNotMatch(none, /keeps standard visit logs/)
    // The server really keeps none: no site has a log directive, and the error messages that name a request are left out.
    const caddy = read('../../deploy/webserver/Caddyfile')
    assert.doesNotMatch(caddy.replace(/#.*$/gm, ''), /^\s*log\s*(\{|$)/m)
    assert.match(caddy, /log default \{\s*exclude http\.log\.error\s*\}/)
  })

  test('kept: the About page says so, and claims none of the above', () => {
    assert.match(kept, /slynk\.me’s hosting provider keeps standard visit logs<\/strong> for the website itself \(internet address and time\), like any website’s\. They never include your link, what you send, or which visits made or opened a link\./)
    assert.doesNotMatch(kept, /No visit logs|keeps no visit logs|keeps no record of visits|can see connections/)
  })

  test('either way, the same files for every visit, and no "web host"', () => {
    for (const page of [none, kept]) {
      assert.match(page, /so what a visit loads can’t show what you did/)
      assert.doesNotMatch(page, /web host/)
    }
  })
})

test('the README says how a fork changes a rule, and what goes with it', () => {
  const readme = read('../../README.md')
  assert.match(readme, /web\/src\/site\.ts/)
  assert.match(readme, /-one-time-only=false/)
  assert.match(readme, /\*\*`VISIT_LOGS`:\*\* whether your website keeps visit logs/)
  assert.match(readme, /slynk\.me's website keeps no visit logs\./)
})

test('a fork’s name and address reach every page, with any rules', () => {
  for (const p of ['../index.html', '../about/index.html', '../public/404.html']) {
    for (const rules of RULES) {
      const page = fillSiteName(fillRules(read(p), rules), 'Parcel', 'parcel.example').replace(/<!--[\s\S]*?-->/g, '')
      assert.doesNotMatch(page, /\bSlynk\b|(?<![\w.-])slynk\.me(?![\w-])/, p)
    }
  }
})
