// A quantum-safe message spread over two rounds
// (2026-10-18, first as the composer's "Spread over several
// rounds"; 2026-10-19: always, with no switch, and no more than about 30 s
// between the pieces): every message to an inbox that goes as two pieces goes
// apart, the sending screen says when its first piece is delivered, and the
// wording says only that it takes a bit longer. The sending and pairing
// themselves are the core's (core/transfer/apart.go, inbox4.go), tested in Go.
// Run: npm --prefix web test
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import * as copy from '../src/inbox/inboxCopy.ts'
import * as facts from '../src/ui/facts.ts'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const between = (s: string, from: string, to: string) => {
  const i = s.indexOf(from)
  assert.ok(i >= 0, `missing ${from}`)
  const j = s.indexOf(to, i)
  assert.ok(j > i, `missing ${to} after ${from}`)
  return s.slice(i, j)
}
const main = read('../src/main.ts')
const html = read('../index.html')
const about = read('../about/index.html').replace(/\s+/g, ' ')

describe('no switch', () => {
  test('the composer offers nothing to choose, and nothing is kept', async () => {
    for (const gone of ['id="spread"', 'id="spread-on"', 'SPREAD_LABEL', 'id="s-apart"', 'id="to-apart"', 'id="s-random"', 'id="to-random"']) assert.ok(!html.includes(gone), gone)
    assert.ok(!/spreadOn|spreadBox/.test(main))
    assert.ok(!('SPREAD_LABEL' in copy) && !('SPREAD_HELP' in copy))
    const { settings } = await import('../src/ui/settings.ts')
    assert.ok(!('apartSend' in settings()) && !('randomSend' in settings()))
    for (const t of [...copy.QS_SHORT, ...copy.QS_WHY, ...Object.values(facts).flat()]) assert.ok(!/several rounds|a minute apart/.test(String(t)), String(t))
  })

  test('every message to an inbox asks the core to send apart; the core does so only for what goes as two', () => {
    const client = read('../src/core/client.ts')
    assert.match(client, /onProgress\?: OnProgress, include\?: Include\): Promise<number> \{\n    return \(await this\.call\(\{ op: 'sendNotice', [^}]*separate, include \}/)
    assert.match(client, /onProgress\?: OnProgress, include\?: Include\): Promise<number> \{\n    return \(await this\.call\(\{ op: 'sendFileNotice', address, link, since, include \}/)
    assert.ok(!/apart\?: boolean/.test(read('../src/core/protocol.ts')))
    const worker = read('../src/core/worker.ts')
    assert.match(worker, /req\.include\?\.replyKeys \?\? null, true\)\n {8}reply\(\{ id: req\.id, kind: 'result', value: at \}\)\n {8}break\n {6}\}\n {6}case 'sendFileNotice'/)
    assert.match(worker, /c\.sendFileNotice\([^\n]*req\.include\?\.replyKeys \?\? null, true\)/)
    assert.ok(!/req\.apart/.test(worker))
    const bridge = read('../../core/cmd/wasm/inbox.go')
    assert.match(bridge, /when := transfer\.NoticeTiming\{AtRandom: atRandom, Apart: len\(args\) > 9 && args\[9\]\.Truthy\(\)\}/)
    assert.match(bridge, /when := transfer\.NoticeTiming\{AtRandom: true, Apart: len\(args\) > 7 && args\[7\]\.Truthy\(\)\}/)
    assert.match(read('../../core/transfer/inbox.go'), /if apart && mode == modeQS \{/)
    // The chat's messages go the same way: no "whole" path any more.
    assert.match(main, /return await core\.sendNotice\(address, pack\(text\), true, \(stage\) => onStage\(stage\), \{ name, replyKeys \}\)/)
  })

  test('the core tells the page when the first piece is delivered, before the pause', () => {
    const apart = read('../../core/transfer/apart.go')
    assert.match(apart, /a\.streams, a\.first = sealed, r\n[^\n]*\n\t\tif job\.progress != nil \{\n\t\t\tjob\.progress\("apart", 1, 2\)\n\t\t\}\n\t\treturn noticeResult\{\}, false/)
    assert.match(apart, /apartPauseMin = 2 \* time\.Second\n\tapartPauseMax = 15 \* time\.Second/)
    assert.match(read('../../core/transfer/inbox.go'), /\tjob\.progress = progress\n/)
  })
})

describe('the composer and the sending screen', () => {
  test('say a first or anonymous message takes a bit longer, and what is happening', () => {
    assert.equal(copy.TO_SIZE(false, true), 'Room for about 200 words. To a quantum-safe inbox, an anonymous or first message takes a bit longer.')
    assert.equal(copy.TO_SIZE(true, true), 'Up to about 200 words fit in one message. To a quantum-safe inbox, an anonymous or first message takes a bit longer.')
    assert.equal(copy.TO_SIZE(false, false), 'Room for about 300 words. A message this size travels as a single piece, the hardest kind to trace.')
    const size = between(main, 'function renderSize() {', '\n}\n')
    // Two pieces: to a quantum-safe address, and not a reply sealed with keys (one piece).
    assert.match(size, /const two = isQuantumSafe\(addressed\.address\) && !replyWithKeys\(\)\n  \$\('to-size'\)\.textContent = inboxCopy\.TO_SIZE\(INBOX_FILES, two\)\n  \$\('to-honest-qs'\)\.hidden = !two\n/)
    assert.equal(copy.SENDING_APART, 'Sending it in two parts…')
    assert.equal(copy.SENDING_APART_FIRST, 'First part delivered. The second follows shortly…')
    const send = between(main, 'async function sendToInbox() {', '/** The Delivered screen')
    assert.match(send, /const apart = isQuantumSafe\(to\.address\) && !replyKeys\n/)
    assert.match(send, /const next = apart \? inboxCopy\.SENDING_APART : inboxCopy\.SENDING_NOW\n/)
    assert.match(send, /else if \(stage === 'apart'\) \$\('p-detail'\)\.textContent = inboxCopy\.SENDING_APART_FIRST\n/)
    assert.match(send, /startProgress\('Sending', next, replyKeys \? INBOX_FACTS_REPLY : apart \? INBOX_FACTS_QS : INBOX_FACTS\)/)
  })

  test('the facts while it sends: two pieces a few seconds apart, or one with reply keys', () => {
    assert.ok(!('INBOX_FACTS_QS_APART' in facts))
    assert.match(facts.INBOX_FACTS_QS[1], /^It travels as two pieces a few seconds apart, each exactly the same size as every other/)
    assert.ok(!facts.INBOX_FACTS_REPLY.some((f) => /two pieces/.test(f)))
  })
})

describe('"How it compares"', () => {
  test('says quantum-safe for a message that goes quantum-safe, as its marker does', () => {
    assert.deepEqual(copy.COMPARE_SENDER_QS.find(([what]) => what === 'Your message'), [
      'Your message',
      'Encrypted end to end in the best ones',
      'Encrypted end to end with quantum-safe cryptography: sealed in your browser, opened only in the owner’s',
    ])
    const others = (rows: [string, string, string][]) => rows.filter(([what]) => what !== 'Your message')
    assert.deepEqual(others(copy.COMPARE_SENDER_QS), others(copy.COMPARE_SENDER))
    assert.match(main, /openCompare\(addressed && \(isQuantumSafe\(addressed\.address\) \|\| replyWithKeys\(\)\) \? inboxCopy\.COMPARE_SENDER_QS : inboxCopy\.COMPARE_SENDER\)/)
  })
})

describe('the wording', () => {
  test('the explainers: slower on purpose, the honest line and the VPN, with no "we"', () => {
    assert.equal(copy.QS_SHORT[1], 'Sending can take a little longer when you write to them for the first time, or anonymously: that adds a little more privacy.')
    assert.equal(
      copy.QS_WHY[3],
      'Initial messages to a quantum-safe inbox, or those not in a conversation, are intentionally slower to send, to add a small amount of extra privacy. Not many people send quantum-safe messages yet, so the way they’re sent could stand out. Senders can safeguard their network privacy further, for example by using a VPN.',
    )
    // The sender's Good to know keeps the honest line, after the one about a VPN.
    assert.equal(copy.TO_HONEST_QS, 'Not many people send quantum-safe messages yet, so the way yours is sent could stand out.')
    assert.match(between(html, 'data-copy="TO_HONEST_IP"', '</details>'), /<p class="note" id="to-honest-qs" data-copy="TO_HONEST_QS" hidden><\/p>/)
    for (const t of [copy.QS_WHY[3], ...copy.QS_SHORT, copy.SENDING_APART, copy.SENDING_APART_FIRST, copy.TO_SIZE(false, true), copy.TO_HONEST_QS, facts.INBOX_FACTS_QS[1]]) {
      assert.ok(!/\b(we|us|our)\b/i.test(t), t)
    }
  })

  test('the About page says it, and keeps the honest lines', () => {
    const answer = between(about, '<details id="inbox-quantum">', '</details>')
    assert.match(answer, /a few seconds apart/)
    assert.match(answer, /VPN/)
    assert.ok(!/several rounds|a minute apart|random moment/.test(about))
    assert.ok(!/can’t be traced|untraceable|invisible|hidden from/i.test(answer))
  })
})
