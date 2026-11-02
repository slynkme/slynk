// Settings → Advanced → Connection → Restart: a join that stalls short of
// ready (often "99%") starts again with a fresh identity, without reloading
// the page, so what's written and whatever waits for the join carry on.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const main = read('../src/main.ts')
const html = read('../index.html')

describe('Restart a stalled join', () => {
  test('is offered only once a join is slow (it usually takes 12-27 s) or has failed', () => {
    assert.match(main, /const SLOW_JOIN_MS = 30_000/)
    assert.match(main, /if \(netState === 'error'\) return 'main'/)
    assert.match(main, /if \(netState === 'connecting'\) return Date\.now\(\) - joinStarted > SLOW_JOIN_MS \? 'main' : undefined/)
    assert.match(html, /<button class="btn small" id="s-restart" type="button" hidden>Restart<\/button>/)
  })

  test('the tab’s own join: a fresh identity, with whatever waited for the join kept, for the same use', () => {
    const fn = main.slice(main.indexOf('async function restartConnection'), main.indexOf('/** Readies the identity for links'))
    assert.match(fn, /const waiting = onReadyQueue\.splice\(0\)\n\s+const use = coreUse\n\s+replaceCore\(\)\n\s+coreUse = use\n\s+onReadyQueue\.push\(\.\.\.waiting\)\n\s+void connect\(\)/)
  })

  test('the second identity’s join: only it starts again, so an open inbox stays open', () => {
    assert.match(main, /const since = netStatus\?\.noticeJoining/)
    assert.match(main, /await core\.noticeRestart\(\)/)
    const inbox = read('../../core/cmd/wasm/inbox.go')
    assert.match(inbox, /if errors\.Is\(err, transfer\.ErrConnectStopped\) \{\n\s+continue \/\/ restarted from the page/)
  })
})

// The core starts a stalled join again by itself (2026-10-24: one sat at 19% for minutes).
describe('A stalled join starts again by itself', () => {
  const transfer = read('../../core/transfer/transfer.go')
  const inboxCopy = read('../src/inbox/inboxCopy.ts')

  test('in the core: no new node for 30 s, or not ready 90 s in, up to 3 fresh identities, within 5 minutes', () => {
    assert.match(transfer, /joinStall {4}= 30 \* time\.Second\n\tjoinAttempt {2}= 90 \* time\.Second\n\tjoinRestarts = 3/)
    assert.match(transfer, /connectTimeout = 5 \* time\.Minute/)
    assert.match(transfer, /return retryJoin\(progress, stop, time\.Now\(\)\.Add\(connectTimeout\), joinOnce\)/)
    assert.match(read('../../core/cmd/wasm/inbox.go'), /case errors\.Is\(err, transfer\.ErrConnectStalled\):\n\t\treturn "stalled"/)
  })

  test('the page says it’s trying again, and why it gave up in the end', () => {
    assert.match(main, /const JOIN_RETRYING = 'Trying again…'/)
    assert.match(main, /\} else if \(stage === 'restart'\) \{\n\s+retrying = true\n\s+joinPct = undefined\n\s+setNet\('connecting', JOIN_RETRYING\)/)
    assert.match(main, /setNet\('connecting', retrying \? JOIN_RETRYING : STAGES\[stage\]\)/)
    assert.match(main, /if \(errorCode\(e\) === 'stalled'\) return JOIN_STALLED/)
    // The number in the wording is the core's.
    assert.match(main, /even after starting again with a fresh identity 3 times\. Check your internet connection, then try again\./)
    assert.match(main, /else if \(stage === 'restart'\) \$\('p-detail'\)\.textContent = inboxCopy\.JOIN_SLOW/)
    assert.match(main, /else if \(stage === 'restart'\) \$\('p-detail'\)\.textContent = inboxCopy\.UPLOAD_JOIN_SLOW/)
    assert.match(inboxCopy, /export const JOIN_SLOW = 'Joining the mixnet is slow, so trying again with a fresh identity…'/)
  })
})
