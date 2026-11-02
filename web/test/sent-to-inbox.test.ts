// "Copy it and go to my inbox" on "Your link is ready": with an inbox
// open or kept on this device, the
// link is copied and the inbox opens, so it can be sent to someone from there.
// No message is started: it may be for someone already written to. The way
// back is the link's screen, with "Cancel this link" still there. The page
// needs a browser, so these read its source; the flow was checked in Chromium
// with a stand-in mixnet.
// Run from the repo root: npm --prefix web test
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import * as copy from '../src/inbox/inboxCopy.ts'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const main = read('../src/main.ts')
const html = read('../index.html')

test('offered only with an inbox open or kept here, and a link still alive', () => {
  assert.match(html, /<button class="btn ghost wide sent-to-inbox" id="sent-to-inbox" type="button" data-copy="SENT_TO_INBOX" hidden><\/button>/)
  assert.ok(html.indexOf('id="copy-link"') < html.indexOf('id="sent-to-inbox"'), 'under the link')
  assert.match(main, /\$\('sent-to-inbox'\)\.hidden = !\(owner\?\.isOpen\(\) \|\| keptCount > 0\) \|\| \$<HTMLInputElement>\('link'\)\.disabled/)
  assert.match(main, /if \(dead\) \$\('sent-to-inbox'\)\.hidden = true/)
  assert.equal(copy.SENT_TO_INBOX, 'Copy it and go to my inbox')
})

test('it copies the link first, goes to the inbox, and starts no message', () => {
  const handler = main.slice(main.indexOf("$('sent-to-inbox').addEventListener"), main.indexOf("$('copy-link').addEventListener"))
  assert.ok(handler.indexOf('navigator.clipboard.writeText') < handler.indexOf('showInbox()'), 'copied before leaving')
  // Not copied: it stays, so the link isn't lost from sight.
  assert.match(handler, /\} catch \{\n[^\n]*\n\s+\$<HTMLInputElement>\('link'\)\.select\(\)\n\s+toast\('Press Ctrl\+C to copy'\)\n\s+return\n\s+\}/)
  assert.doesNotMatch(handler, /startMessage|newMessage|chatText|compose/i)
  assert.match(handler, /location\.hash = OPEN_INBOX_ROUTE/)
})

test('the way back is the link’s screen, until something else is sent', () => {
  assert.match(main, /if \(backToLink && \$<HTMLInputElement>\('link'\)\.value\) \{\n\s+backToLink = false\n\s+return show\('sent'\)\n\s+\}/)
  assert.match(main, /function resetCompose\(\) \{\n\s+forgetPendingDrop\(\)\n\s+forgetSentLink\(\)\n\s+backToLink = false/)
})

test('the link’s screen says to pass it on: Slynk doesn’t deliver it', () => {
  assert.match(
    html,
    /<h2>Your link is ready<\/h2>\s*<p class="muted" id="sent-what"><\/p>\s*<!--[^>]*-->\s*<p class="sent-pass"><strong>Now pass it on to the person it’s for\.<\/strong> Slynk doesn’t deliver it for you\.<\/p>/,
  )
})
