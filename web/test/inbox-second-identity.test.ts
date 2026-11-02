// The tab's second identity, which messages to inboxes go from while the
// first makes links or checks an inbox: it connects as soon
// as someone starts writing (a second connect at
// Send, after "Connected", felt like one too many), and the sending screen
// says it's being made only when it is. Also the inbox's status card.
// Run: npm --prefix web test
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import * as copy from '../src/inbox/inboxCopy.ts'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const main = read('../src/main.ts')
const owner = read('../src/inbox/owner.ts')
const bridge = read('../../core/cmd/wasm/inbox.go')
const html = read('../index.html')
const css = read('../src/style.css')

describe('the second identity connects when writing starts', () => {
  test('only for a tab whose identity makes links or checks an inbox, once per core', () => {
    assert.match(main, /function warmNotices\(\) \{\n  if \(noticeWarm \|\| coreUse !== 'links'\) return\n  noticeWarm = true/)
    // A fresh core (Lock, or after writing to inboxes) starts again; a failed connect is left to Send.
    assert.match(main, /core = new Core\(\)\n  coreUse = 'none'\n  noticeWarm = false/)
    assert.match(main, /if \(c === core\) noticeWarm = false/)
  })

  test('on typing to an inbox in the composer, on typing a reply or adding files in a conversation', () => {
    assert.match(main, /textBox\.addEventListener\('input', \(\) => \{\n  ensureConnected\(\)\n  if \(addressed\) warmNotices\(\)/)
    assert.match(main, /warm: warmNotices,/)
    assert.match(owner, /chatText\.addEventListener\('input', \(\) => \{\n    growText\(\)\n    renderChatCompose\(\)\n    deps\.warm\(\)/)
    assert.match(owner, /if \(!INBOX_FILES \|\| !chatWith \|\| !files\.length\) return\n    deps\.warm\(\)/)
  })

  test('the core connects it once; a send that finds it connecting says so, then sends', () => {
    assert.match(read('../../core/cmd/wasm/main.go'), /"noticeConnect": +js\.FuncOf\(noticeConnect\)/)
    assert.match(bridge, /func noticeConnect\(_ js\.Value, args \[\]js\.Value\) any \{\n\tprogress := progressFn\(args, 0\)\n\treturn promise\(func\(\) \(any, error\) \{\n\t\t_, err := noticeIdentity\(progress\)/)
    assert.match(bridge, /if !waited \{\n\t\t\t\tprogress\("identity", 0, 0\)\n\t\t\t\twaited = true\n\t\t\t\}\n\t\t\t<-wait/)
    assert.match(bridge, /if waited \{\n\t\t\t\tprogress\("ready", 0, 0\)\n\t\t\t\}\n\t\t\treturn c, nil/)
    assert.match(read('../src/core/worker.ts'), /case 'noticeConnect':\n        await c\.noticeConnect\(progress\)/)
  })
})

describe('what the sending screen says', () => {
  test('a separate identity only while one is being made; then sending', () => {
    const send = main.slice(main.indexOf('async function sendToInbox()'), main.indexOf('function delivered('))
    assert.match(send, /const next = apart \? inboxCopy\.SENDING_APART : inboxCopy\.SENDING_NOW\n  startProgress\('Sending', next, replyKeys \? INBOX_FACTS_REPLY : apart \? INBOX_FACTS_QS : INBOX_FACTS\)/)
    assert.match(send, /if \(stage === 'network' \|\| stage === 'identity'\) \$\('p-detail'\)\.textContent = inboxCopy\.SENDING_SEPARATE/)
    assert.match(send, /else if \(stage === 'ready'\) \$\('p-detail'\)\.textContent = next/)
    assert.ok(!/separate \? inboxCopy\.SENDING_SEPARATE/.test(send))
    assert.equal(copy.SENDING_NOW, 'Sending it…')
  })
})

describe('the inbox’s status card', () => {
  test('an icon for each state: a spinner while it works, a tick when done, "!" if it couldn’t open', () => {
    assert.match(html, /<div class="ib-status-card" id="ib-status-card" data-state="busy">/)
    assert.match(html, /<p class="ib-status" id="ib-status" tabindex="-1"><\/p>\n\s+<button class="btn mini" id="ib-retry"/)
    assert.match(owner, /\$\('ib-status-card'\)\.dataset\.state = failed \|\| \(opening && net\.state === 'error'\) \? 'failed' : lookback\?\.finished \? 'done' : 'busy'/)
    assert.match(css, /\.ib-status-card\[data-state='busy'\] \.ib-status-icon::before \{/)
    assert.match(css, /\.ib-status-card\[data-state='done'\] \.si-done,\n\.ib-status-card\[data-state='failed'\] \.si-failed \{\n  display: block;/)
  })
})
