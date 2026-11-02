// Conversations: everything to and from one sender's inbox
// is one conversation, read as a chat, with the owner's own replies kept
// beside theirs; and the inbox's own screen, reached from the front page's
// inbox bar. Run: npm --prefix web test
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { NOTICE_TEXT } from '../src/inbox/drop.ts'
import * as copy from '../src/inbox/inboxCopy.ts'
import { ARCHIVE, INBOX, MAX_SENT, Mailbox, hex } from '../src/inbox/mailbox.ts'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

const id = (n: number) => n.toString(16).padStart(32, '0')
/** An inbox's address: version 3, then 32 bytes. */
function address(seed: number): Uint8Array {
  const a = new Uint8Array(33).fill(seed)
  a[0] = 3
  return a
}
const SAM = address(1)
const ALEX = address(2)
let clock = Date.UTC(2026, 9, 16, 12)
function msg(n: number, words: string, from?: Uint8Array, name = '', at = (clock += 60_000)) {
  return { id: id(n), kind: NOTICE_TEXT, body: new TextEncoder().encode(words), sent: at, at, quantumSafe: false, ...(from ? { from, fromName: name } : {}) }
}
const text = (b: Uint8Array) => new TextDecoder().decode(b)

describe('conversations in the mailbox', () => {
  test('messages from one inbox are one row; anonymous ones stay on their own; newest first', () => {
    const box = new Mailbox()
    box.add(msg(1, 'hello', SAM, 'Sam'), false)
    box.add(msg(2, 'anonymous note'), false)
    box.add(msg(3, 'again', SAM, 'Sam'), false)
    box.add(msg(4, 'hi', ALEX), false)
    const rows = box.rows(INBOX)
    assert.deepEqual(
      rows.map((r) => (r.kind === 'message' ? r.item.id : `t:${r.key}`)),
      [`t:${hex(ALEX)}`, `t:${hex(SAM)}`, id(2)],
    )
    const sam = rows[1]
    assert.ok(sam.kind === 'thread' && sam.count === 2 && sam.unread === 2 && sam.latest?.id === id(3))
    assert.equal(box.unread(), 4)
  })

  test('a conversation reads oldest first, theirs and the owner’s together', () => {
    const box = new Mailbox()
    box.add(msg(1, 'question', SAM, 'Sam', 1000), false)
    const x = box.addSent(SAM, new TextEncoder().encode('answer'), 'Advice line', undefined, 2000)
    box.sentDone(x.id, 2000)
    box.add(msg(2, 'thanks', SAM, 'Sam', 3000), false)
    const t = box.thread(SAM)
    assert.deepEqual(
      t.map((e) => (e.kind === 'in' ? `in:${text(e.item.body)}` : `out:${text(e.sent.body)}`)),
      ['in:question', 'out:answer', 'in:thanks'],
    )
    assert.equal(box.thread(ALEX).length, 0)
  })

  test('opening a conversation reads it; Mark as unread marks the newest of theirs', () => {
    const box = new Mailbox()
    box.add(msg(1, 'a', SAM), false)
    box.add(msg(2, 'b', SAM), false)
    assert.ok(box.readThread(SAM))
    assert.ok(!box.readThread(SAM), 'nothing changed, nothing to keep')
    assert.equal(box.unread(), 0)
    assert.ok(box.readThread(SAM, false))
    assert.ok(!box.get(id(2))!.read && box.get(id(1))!.read)
  })

  test('a conversation moves as a whole, and a new message from them brings it back to Inbox', () => {
    const box = new Mailbox()
    box.add(msg(1, 'a', SAM), false)
    const x = box.addSent(SAM, new TextEncoder().encode('b'), '')
    box.sentDone(x.id, clock + 1)
    assert.ok(box.moveThread(SAM, ARCHIVE))
    assert.equal(box.threadFolder(SAM), ARCHIVE)
    assert.equal(box.rows(INBOX).length, 0)
    assert.equal(box.rows(ARCHIVE).length, 1)
    assert.ok(box.get(id(1))!.folder === ARCHIVE && box.getSent(x.id)!.folder === ARCHIVE)
    // The owner writing again keeps it where it is.
    const y = box.addSent(SAM, new TextEncoder().encode('c'), '')
    assert.equal(y.folder, ARCHIVE)
    // They write again: back to Inbox, all of it.
    box.add(msg(2, 'd', SAM), false)
    assert.equal(box.threadFolder(SAM), INBOX)
    assert.ok(box.thread(SAM).every((e) => (e.kind === 'in' ? e.item.folder : e.sent.folder) === INBOX))
    assert.equal(box.rows(ARCHIVE).length, 0)
  })

  test('a folder deleted takes its conversations back to Inbox', () => {
    const box = new Mailbox()
    box.add(msg(1, 'a', SAM), false)
    const f = box.addFolder('Cases')
    assert.ok(typeof f === 'object')
    box.moveThread(SAM, f.id)
    box.deleteFolder(f.id)
    assert.equal(box.threadFolder(SAM), INBOX)
  })

  test('removing a conversation removes their messages for good and wipes the owner’s', () => {
    const box = new Mailbox()
    const m = msg(1, 'secret', SAM)
    box.add(m, false)
    const x = box.addSent(SAM, new TextEncoder().encode('reply'), '')
    box.sentDone(x.id, clock)
    const sentBody = box.getSent(x.id)!.body
    assert.ok(box.removeThread(SAM))
    assert.equal(box.thread(SAM).length, 0)
    assert.ok(sentBody.every((b) => b === 0), 'the owner’s reply is wiped')
    assert.equal(box.add(msg(1, 'secret', SAM), false), 'removed', 'the look-back doesn’t bring it back')
  })
})

describe('the owner’s replies', () => {
  test('one sending or one that failed is never kept; one the network took is, with its time and the name shown', () => {
    const box = new Mailbox()
    box.add(msg(1, 'a', SAM), false)
    const sending = box.addSent(SAM, new TextEncoder().encode('on its way'), 'Advice line')
    assert.equal(sending.state, 'sending')
    assert.equal(box.toKept().sent!.length, 0)
    assert.ok(box.sentFailed(sending.id))
    assert.equal(box.toKept().sent!.length, 0)
    assert.ok(box.sentRetry(sending.id))
    assert.ok(box.sentDone(sending.id, 123_456))
    assert.ok(!box.sentDone(sending.id, 999), 'once')
    const kept = box.toKept().sent!
    assert.equal(kept.length, 1)
    assert.equal(kept[0].round, 123_456, 'when it reached the network')
    assert.notEqual(kept[0].at, 123_456, 'where it was written stays its place')
    assert.equal(kept[0].name, 'Advice line')
    const back = Mailbox.fromKept(JSON.parse(JSON.stringify(box.toKept())), false)
    const t = back.thread(SAM)
    assert.equal(t.length, 2)
    const out = t.find((e) => e.kind === 'out')
    assert.ok(out && out.kind === 'out' && text(out.sent.body) === 'on its way' && out.sent.state === 'sent' && out.sent.name === 'Advice line')
  })

  test('files or a longer message sent as an upload keep only their size, never the text or link', () => {
    const box = new Mailbox()
    const x = box.addSent(ALEX, new Uint8Array(0), '', 40_000)
    box.sentDone(x.id, clock)
    const k = box.toKept().sent![0]
    assert.equal(k.upload, 40_000)
    assert.equal(k.body, '')
    const back = Mailbox.fromKept(box.toKept(), true)
    const e = back.thread(ALEX)[0]
    assert.ok(e.kind === 'out' && e.sent.upload === 40_000)
    // A conversation the owner started shows in the list before they reply.
    assert.equal(back.rows(INBOX)[0].kind, 'thread')
  })

  test('anything malformed in what was kept is skipped, and an older record without replies opens as before', () => {
    const good = new Mailbox()
    const x = good.addSent(SAM, new TextEncoder().encode('fine'), '')
    good.sentDone(x.id, clock)
    const data = good.toKept()
    const bad = [
      { ...data.sent![0], id: 'not hex' },
      { ...data.sent![0], id: id(9), to: 'AAAA' },
      { ...data.sent![0], id: id(10), folder: 'nowhere' },
      null,
      7,
    ]
    const back = Mailbox.fromKept({ ...data, sent: [...data.sent!, ...bad] }, false)
    const t = back.thread(SAM)
    assert.equal(t.length, 2, 'the good one and the one whose folder is gone (in Inbox)')
    assert.ok(t.every((e) => e.kind === 'out' && e.sent.folder === INBOX))
    const { sent: _, ...older } = data
    assert.equal(Mailbox.fromKept(older, false).thread(SAM).length, 0)
  })

  test('a record kept before conversations, with one sender’s messages in two folders, opens with them together', () => {
    const box = new Mailbox()
    box.add(msg(1, 'old', SAM, '', 1000), false)
    box.add(msg(2, 'new', SAM, '', 2000), false)
    const data = box.toKept()
    data.items.find((i) => i.id === id(1))!.folder = ARCHIVE
    const back = Mailbox.fromKept(data, false)
    assert.equal(back.get(id(1))!.folder, INBOX, 'with the newest')
  })

  test('another tab’s kept replies join this one’s; the oldest go past the limit', () => {
    const a = new Mailbox()
    const b = new Mailbox()
    const x = b.addSent(SAM, new TextEncoder().encode('from the other tab'), '')
    b.sentDone(x.id, clock)
    a.merge(b)
    assert.equal(a.thread(SAM).length, 1)
    assert.ok(MAX_SENT >= 1000)
    const c = new Mailbox()
    for (let i = 0; i <= MAX_SENT; i++) c.sentDone(c.addSent(SAM, new Uint8Array([1]), '', undefined, i + 1).id, i + 1)
    assert.equal(c.thread(SAM).length, MAX_SENT)
    assert.equal(c.thread(SAM)[0].at, 2, 'the oldest went')
  })

  test('wiping the mailbox (Lock) wipes the replies', () => {
    const box = new Mailbox()
    const x = box.addSent(SAM, new TextEncoder().encode('gone'), '')
    const body = x.body
    box.wipeAll()
    assert.ok(body.every((b) => b === 0))
    assert.equal(box.thread(SAM).length, 0)
  })
})

describe('the chat and the inbox’s own screen (the page)', () => {
  const owner = read('../src/inbox/owner.ts')
  const main = read('../src/main.ts')
  const html = read('../index.html')

  test('a reply goes from the tab’s second identity, with this inbox and the name shown, and only once the inbox is open in the core', () => {
    // With the reply keys they gave, if any: quantum-safe, in one message.
    assert.match(main, /return await core\.sendNotice\(address, pack\(text\), true, \(stage\) => onStage\(stage\), \{ name, replyKeys \}\)/)
    assert.match(owner, /if \(!address \|\| !info \|\| opening \|\| failed \|\| box\.isBlocked\(address\)\) return\n    if \(uploadMode\(\)\) return void sendUpload\(address\)\n    if \(!text\.trim\(\) \|\| !fits\(text, chatRoom\(\)\)\) return/)
    assert.match(owner, /const chatRoom = \(\) => \(chatWith \? textRoom\(chatWith, \{ nameBytes: textBytes\(chatAs\(\)\), reply: box\.hasReplyKeys\(chatWith\) \}\) : 0\)/)
    // One at a time, in order; a reply on its way holds Lock and the composer's Send.
    assert.match(owner, /queue = queue\.then\(async \(\) => \{/)
    assert.match(main, /if \(replying \|\| owner\.uploading\(\)\) return toast\(inboxCopy\.CHAT_BUSY\)/)
    assert.match(main, /canSend: \(upload\) => \(transferring \|\| pendingDrop \|\| \(upload && downloading\) \? inboxCopy\.CHAT_BUSY : ''\)/)
  })

  test('a reply sent from the composer with the inbox included joins the conversation too', () => {
    // Sealed with their reply keys or not.
    assert.match(main, /owner\.noteSent\(to\.address, text, include\.name, at, undefined, undefined, !!replyKeys\)/)
    // Files or a longer message: its text and the files' names and sizes too.
    assert.match(main, /owner\.noteSent\(p\.to\.address, p\.text, p\.include\.name, at, p\.size, p\.files, !!replyKeys\)/)
  })

  test('the inbox has a screen of its own, a step in the history, with a way back at the top', () => {
    assert.match(main, /\$\('card'\)\.hidden = inbox\n  \$\('hero'\)\.hidden = inbox\n  \$\('inbox-card'\)\.hidden = !inbox/)
    assert.match(main, /history\.pushState\(\{ slynk: 'inbox' \}, ''\)/)
    assert.match(main, /window\.addEventListener\('popstate', /)
    assert.match(html, /<section class="card inbox-card" id="inbox-card" aria-labelledby="ib-name" hidden>\n\s+<button class="back-chip" id="ib-home" type="button">/)
    assert.match(main, /\$\('ib-home'\)\.addEventListener\('click', leaveInbox\)/)
    // Back to the front page lands at its top, whatever the browser remembered (seen on an iPhone).
    assert.match(main, /else if \(was === 'inbox'\) toTop\(\)/)
    // Again a moment later: iPhone Safari put back its remembered position after Forget this device.
    assert.match(main, /requestAnimationFrame\(\(\) => requestAnimationFrame\(again\)\)\n\s+window\.setTimeout\(again, 300\)/)
    assert.match(main, /if \('scrollRestoration' in history\) history\.scrollRestoration = 'manual'/)
    // The card no longer shows itself: the page does.
    assert.ok(!/card\.hidden = (true|false)/.test(owner))
  })

  test('the front page’s bar opens the inbox straight away while it’s open, and says how many are new', () => {
    assert.match(main, /const said = s\.state === 'failed' \? inboxCopy\.BAR_FAILED : s\.unread \? inboxCopy\.BAR_NEW\(s\.unread\) : s\.state === 'ready' \? inboxCopy\.BAR_NONE : inboxCopy\.BAR_CHECKING/)
    // A live status, changed only when what it says changes; and the look-back's progress reaches it.
    assert.match(main, /state\.setAttribute\('role', 'status'\)/)
    assert.match(main, /if \(state\.textContent !== said\) state\.textContent = said/)
    assert.match(owner, /\/\/ The front page's bar says how opening is going too\.\n    deps\.unreadChanged\(\)\n  \}/)
    assert.match(owner, /unreadChanged\(\)/)
    assert.equal(copy.BAR_NEW(3), '3 new')
  })

  test('new messages: the tab’s dot only for what arrives after the look-back, a quiet note when looking elsewhere', () => {
    // Never for a blocked sender's (2026-10-24).
    assert.match(owner, /if \(lookback\?\.finished && !box\.setAside\(i\)\) arrived\(i\)/)
    assert.match(main, /arrived: \(\) => \{\n    if \(settings\(\)\.notify\) flagTab\(inboxCopy\.TAB_NEW\)/)
    assert.match(owner, /if \(deps\.onScreen\(\) && elsewhere\) deps\.toast\(/)
  })

  test('no "May be a copy": the core drops a copy sent again in another round', () => {
    assert.ok(!('MESSAGE_RESENT' in copy))
    assert.ok(!/resent/i.test(owner + read('../src/inbox/mailbox.ts') + read('../src/core/protocol.ts')))
    assert.ok(!read('../index.html').includes('ib-r-resent'))
    assert.match(read('../../core/transfer/inbox.go'), /if o\.round != uint32\(r\.ID\) \{\n\t\ts\.count\(&s\.copies, 1\)\n\t\treturn\n\t\}/)
  })

  test('what a sender wrote is shown as text, never as markup', () => {
    const chat = owner.slice(owner.indexOf('function bubble('), owner.indexOf('// The conversation\'s menu'))
    assert.ok(!/innerHTML = (?!MORE_SVG)/.test(chat), 'only fixed markup')
    // Its web links are made from the text too (ui/linkWarn.ts, tested in message-links.test.ts).
    assert.match(chat, /body\.append\(isText\(i\) \? linkedText\(shownText\(i\.body\), 'inbox'\) : copy\.MESSAGE_UNREADABLE\)/)
    assert.match(read('../src/style.css'), /\.bubble-text \{[^}]*unicode-bidi: plaintext;/)
  })

  test('wording: short, and “the name they gave” under the name', () => {
    for (const [k, v] of Object.entries(copy)) {
      if (!/^(CHAT_|THREAD_|BAR_|NEW_|TAB_)/.test(k) || typeof v !== 'string') continue
      assert.ok(v.length <= 60, `${k} is short`)
    }
    assert.equal(copy.CHAT_GIVEN, 'the name they gave')
    // Changing the name shown: they see it only with the next message, and the page says so.
    assert.match(read('../src/inbox/owner.ts'), /deps\.toast\(copy\.CHAT_AS_SAVED\(!!box\.shownTo\(chatWith\)\)\)/)
    assert.equal(copy.CHAT_AS_SAVED(true), 'Saved. They’ll see it with your next message.')
    assert.equal(copy.THREAD_COUNT(1), '1 message')
  })
})

describe('after the review of replies from the chat', () => {
  const owner = read('../src/inbox/owner.ts')
  const main = read('../src/main.ts')
  const html = read('../index.html')
  const css = read('../src/style.css')

  test('a reply the owner removed doesn’t come back from another tab’s record, or from what was kept', () => {
    const a = new Mailbox()
    const x = a.addSent(SAM, new TextEncoder().encode('gone for good'), '')
    a.sentDone(x.id, clock)
    const stale = Mailbox.fromKept(JSON.parse(JSON.stringify(a.toKept())), false)
    assert.ok(a.removeSent(x.id))
    a.merge(stale)
    assert.equal(a.thread(SAM).length, 0, 'not merged back')
    assert.equal(Mailbox.fromKept({ ...stale.toKept(), removed: a.toKept().removed }, false).thread(SAM).length, 0)
    // And a removal made in the other tab reaches this one.
    const b = Mailbox.fromKept(JSON.parse(JSON.stringify(stale.toKept())), false)
    b.merge(a)
    assert.equal(b.thread(SAM).length, 0)
  })

  test('a conversation’s row counts the owner’s messages that didn’t send, and says so', () => {
    const box = new Mailbox()
    box.add(msg(1, 'a', SAM), false)
    box.sentFailed(box.addSent(SAM, new TextEncoder().encode('b'), '').id)
    const row = box.rows(INBOX)[0]
    assert.ok(row.kind === 'thread' && row.failed === 1)
    assert.match(owner, /r\.kind === 'thread' && r\.failed \? copy\.ROW_FAILED/)
  })

  test('opening a kept inbox gathers thousands of conversations quickly', () => {
    const box = new Mailbox()
    for (let i = 0; i < 2000; i++) {
      const a = address(0)
      a[1] = i >> 8
      a[2] = i & 255
      box.add(msg(10_000 + i, 'x', a, '', 1000 + i), false)
      box.sentDone(box.addSent(a, new Uint8Array([1]), '', undefined, 2000 + i).id, 2000 + i)
    }
    const data = box.toKept()
    const t = performance.now()
    const back = Mailbox.fromKept(data, false)
    assert.ok(performance.now() - t < 3000, 'no conversation-by-conversation rescans')
    assert.equal(back.rows(INBOX).length, 2000)
  })

  test('a conversation can’t be removed while a message of the owner’s is on its way; a sent reply never resets the name shown', () => {
    assert.match(owner, /if \(entries\.some\(\(e\) => e\.kind === 'out' && e\.sent\.state === 'sending'\)\) return copy\.CHAT_REMOVE_BUSY/)
    assert.match(owner, /const busy = threadBusy\(address\)\n {6}if \(busy\) return deps\.toast\(busy\)/)
    const deliver = owner.slice(owner.indexOf('function deliver('), owner.indexOf('// The name they see'))
    assert.ok(!deliver.includes('setShownTo'), 'the name is the owner’s current choice, not the one a reply went with')
    assert.match(deliver, /queue = queue\.catch\(\(\) => \{\}\)/)
  })

  test('removing one message from a conversation asks first, as removing it on its own does', () => {
    assert.match(owner, /run: \(\) => askRemoveFromChat\(\{ in: e\.item\.id \}\)/)
    assert.match(owner, /run: \(\) => askRemoveFromChat\(\{ out: e\.sent\.id \}\)/)
    assert.equal(copy.SENT_REMOVE_ASK, 'Remove your message from this conversation? They still have it.')
  })

  test('the conversation is redrawn only when it changes, keeping menus and the focus', () => {
    assert.match(owner, /if \(shown === chatShown\) \{/)
    assert.match(owner, /log\.querySelector<HTMLElement>\(`\[data-key="\$\{CSS\.escape\(wasKey\)\}"\] \[data-role="\$\{wasRole\}"\]`\)/)
  })

  test('Back never leaves a one-time item, a link just made or a send under way; a reload starts afresh; a conversation is a step of its own', () => {
    assert.match(main, /if \(view !== 'inbox' && view !== 'compose' && view !== 'delivered' && \(transferring \|\| pendingDrop \|\| view === 'sent' \|\| \(view === 'received' && onceShown\)\)\) \{/)
    assert.match(main, /if \(\(history\.state as Step\)\?\.slynk\) history\.replaceState\(null, ''\)/)
    assert.match(main, /history\.pushState\(\{ slynk: 'inbox', chat: key \}, ''\)/)
    assert.match(main, /if \(step\?\.slynk === 'inbox'\) history\.go\(step\.chat \? -2 : -1\)/)
    // A link opened over the inbox's screen keeps its own hero.
    assert.match(main, /if \(next === 'compose' \|\| next === 'delivered'\) setHero\(heroNow\(\)\)/)
  })

  test('phones: the reply box never zooms an iPhone, and a message’s menu opens from its inner edge', () => {
    assert.match(css, /@media \(pointer: coarse\) \{\n  textarea,\n  \.chat-input textarea,/)
    assert.match(css, /\.bubble\.in > \.menu \{\n  right: auto;\n  left: 0;\n\}/)
    assert.match(css, /\.bubble\.out > \.menu \{\n  right: 0;\n  left: auto;\n\}/)
  })

  test('the warning for someone whose device or network is watched stays in sight; the rest folds', () => {
    const at = html.indexOf('id="to-after"')
    const after = html.slice(at, html.indexOf('</div>', html.indexOf('</details>', at)))
    assert.ok(after.indexOf('data-copy="TO_HONEST_TIMING"') < after.indexOf('<details'), 'outside the fold')
    assert.ok(after.indexOf('data-copy="TO_HONEST_IP"') > after.indexOf('<details'))
  })
})

describe('replies on another device', () => {
  const owner = read('../src/inbox/owner.ts')

  test('a conversation with two or more of theirs and none of the owner’s says replies from another device don’t show', () => {
    assert.match(owner, /if \(ins\.length >= 2 && ins\.length === entries\.length\) \{\n[^]*?li\.textContent = copy\.CHAT_ELSEWHERE/)
    assert.equal(copy.CHAT_ELSEWHERE, 'Your replies from another device don’t show here.')
    const about = read('../about/index.html').replace(/\s+/g, ' ')
    assert.match(about, /Your replies stay on the device you sent them from: open your inbox on another device and you’ll see only their messages\./)
  })
})

describe('sharing an open inbox', () => {
  test('the Share box offers the same printable QR code as after creating the inbox', () => {
    const html = read('../index.html')
    const box = html.slice(html.indexOf('id="ib-share-box"'), html.indexOf('id="ib-lock-ask"'))
    assert.match(box, /<button class="btn small center" id="ib-save-qr" type="button" data-copy="READY_SAVE_QR"><\/button>/)
    assert.match(read('../src/inbox/owner.ts'), /if \(address\) saveBlob\(await qrSvgFile\(inboxQrText\(LINK_ORIGIN, address\)\), copy\.READY_QR_FILE\(isQuantumSafe\(address\)\)\)/)
  })
})

describe('back to the front page', () => {
  test('after writing to an inbox from its link, the inbox screen’s way back reaches the front page, not that composer, unless a draft waits there', () => {
    const main = read('../src/main.ts')
    const back = main.slice(main.indexOf('function backHome()'), main.indexOf('/** The inbox\'s screen in the history'))
    assert.match(back, /if \(addressed && !transferring && !pendingDrop && !textBox\.value\.trim\(\) && !tray\.count\(\)\) \{\n    switchDraft\(draftKey\(addressed\), ''\)[^\n]*\n    addressed = undefined/)
    assert.ok(back.indexOf('addressed = undefined') < back.indexOf('goHome()'))
    // Both ways back go through it: the button (leaveInbox without a history step) and Back.
    assert.match(main, /else backHome\(\)\n\}/)
    assert.match(main, /\} else if \(view === 'inbox'\) backHome\(\)/)
  })
})

describe('replies that take a while to go (seen on a phone)', () => {
  test('a reply stays where it was written, however long it waited to go', () => {
    const box = new Mailbox()
    const first = box.addSent(SAM, new TextEncoder().encode('first'), '', undefined, 1000)
    const second = box.addSent(SAM, new TextEncoder().encode('second'), '', undefined, 2000)
    // The first took a while to go, and went after the second was written.
    box.sentDone(first.id, 5000)
    box.sentDone(second.id, 6000)
    assert.deepEqual(
      box.thread(SAM).map((e) => (e.kind === 'out' ? text(e.sent.body) : '')),
      ['first', 'second'],
    )
    const back = Mailbox.fromKept(JSON.parse(JSON.stringify(box.toKept())), false)
    const t = back.thread(SAM)
    assert.ok(t[0].kind === 'out' && t[0].sent.round === 5000 && t[0].at === 1000)
    // Try again keeps its place too.
    box.sentFailed(box.addSent(SAM, new TextEncoder().encode('third'), '', undefined, 3000).id)
    const third = box.thread(SAM)[2]
    assert.ok(third.kind === 'out' && box.sentRetry(third.sent.id))
    assert.equal(box.thread(SAM)[2].at, 3000)
  })

  test('one goes at a time, in order: the rest say they’re waiting their turn', () => {
    const owner = read('../src/inbox/owner.ts')
    assert.match(owner, /if \(going !== x\.id\) return copy\.CHAT_QUEUED\n/)
    assert.match(owner, /if \(stage === 'telling'\) return copy\.CHAT_TELLING\n    return copy\.CHAT_SENDING/)
    assert.equal((copy as Record<string, unknown>).CHAT_WAITING, undefined, 'no random moment any more')
    assert.equal(copy.CHAT_QUEUED, 'Waiting to send…')
  })
})

describe('the creation screens', () => {
  test('say where to open the inbox next time, and leave the footer’s inbox links off the inbox’s own screens', () => {
    assert.match(copy.READY_KEEP, /^To read messages later, choose “Unlock my inbox” on the front page and use your passphrase\./)
    assert.ok(!/bottom of the/.test(copy.READY_KEEP))
    // Under the way in, not above it.
    const html = read('../index.html')
    assert.ok(html.indexOf('id="ni-open"') < html.indexOf('data-copy="READY_KEEP"'), 'under Open my inbox now')
    const about = read('../about/index.html').replace(/\s+/g, ' ')
    assert.match(about, /Choose “Create an inbox” in the Anonymous inbox card on the front page\./)
    assert.ok(!/bottom of the main page/.test(about))
    assert.match(read('../src/main.ts'), /const ownScreen = view === 'new-inbox' \|\| view === 'open-inbox' \|\| view === 'inbox'\n  \$\('footer-inbox'\)\.hidden = \(inUse && open\) \|\| !\$\('inbox-entry'\)\.hidden \|\| ownScreen/)
  })
})

describe('the inbox’s heading panels', () => {
  test('Share (and Rename, Lock and Forget’s questions) close on going to a conversation or another screen; a message opens under them', () => {
    const owner = read('../src/inbox/owner.ts')
    assert.match(owner, /function closeHeadPanels\(\) \{\n    hideShare\(\)\n    closeNew\(false\)\n    renameBox\.hidden = true\n    \$\('ib-lock-ask'\)\.hidden = true\n    \$\('ib-forget-ask'\)\.hidden = true/)
    // A message opens in place in the list, with Share and the rest left as they are above it.
    const toggle = owner.slice(owner.indexOf('function toggleMessage('), owner.indexOf('const START_SHOWN'))
    assert.ok(toggle.length > 0 && !toggle.includes('closeHeadPanels'), 'opening a message leaves the heading as it is')
    assert.match(owner, /function openChat\(address: Uint8Array\) \{\n    closeHeadPanels\(\)/)
    assert.match(read('../src/main.ts'), /else if \(was === 'inbox'\) \{\n    owner\.left\(\)/)
  })
})

describe('“Why can’t I reply?”', () => {
  test('a message without an inbox to reply to has the link, opening a short popup; one from an inbox doesn’t', () => {
    const owner = read('../src/inbox/owner.ts')
    const html = read('../index.html')
    assert.match(owner, /\$\('ib-r-why'\)\.hidden = welcome \|\| !!i\.from/)
    assert.match(html, /<button class="soft-link" id="ib-r-why" type="button" aria-haspopup="dialog" data-copy="WHY_REPLY" hidden><\/button>/)
    assert.match(html, /<dialog id="why-reply" class="sheet" aria-labelledby="why-reply-title">/)
    assert.equal(copy.WHY_REPLY, 'Why can’t I reply?')
    // Short, and never that slynk.me could find out who it was.
    for (const t of [copy.WHY_REPLY_WHY, copy.WHY_REPLY_HOW]) assert.ok(t.length < 200 && !/slynk\.me|server/i.test(t), t)
  })
})

describe('the logo', () => {
  test('goes to the front page without reloading, keeping an open inbox, unless something would be lost', () => {
    const main = read('../src/main.ts')
    const logo = main.slice(main.indexOf("$('brand').addEventListener('click'"), main.indexOf('// --- Settings'))
    assert.match(logo, /if \(e\.button !== 0 \|\| e\.metaKey \|\| e\.ctrlKey \|\| e\.shiftKey \|\| e\.altKey\) return\n  e\.preventDefault\(\)/)
    assert.match(logo, /if \(view === 'inbox'\) return leaveInbox\(\)/)
    assert.match(logo, /if \(transferring\) return toast\(/)
    assert.match(logo, /if \(pendingDrop\) return toast\(inboxCopy\.UPLOAD_PENDING_NAV\)/)
    assert.match(logo, /if \(view === 'received' && onceShown\) return toast\(/)
    assert.ok(!/location\.(reload|href\s*=)/.test(logo), 'never a reload')
    assert.match(read('../index.html'), /<a class="brand" id="brand" href="\/" aria-label="Slynk home">/)
  })
})

describe('the front page’s inbox bar is tappable', () => {
  test('while the inbox is open, a tap anywhere on the bar opens it; its button stays for the keyboard', () => {
    const main = read('../src/main.ts')
    assert.match(main, /\$\('kept-card'\)\.addEventListener\('click', \(e\) => \{\n  if \(!owner\.isOpen\(\) \|\| \(e\.target as HTMLElement\)\.closest\('button, a'\)\) return\n  showInbox\(\)/)
    assert.match(read('../src/style.css'), /\.kept-card\[data-open\] \{\n  cursor: pointer;/)
  })
})

describe('New message, inside the inbox', () => {
  test('beside the folders, not on the front page; a conversation opens, otherwise the composer addressed with "Let them reply" off', () => {
    const html = read('../index.html')
    const owner = read('../src/inbox/owner.ts')
    const main = read('../src/main.ts')
    assert.ok(!html.includes('id="send-to"'), 'gone from the front page')
    assert.match(html, /<div class="ib-listbar">\n\s+<button class="btn mini grad-btn ib-compose" id="ib-new-go-open"/)
    // On a phone: a full-width row of its own, its step straight under it, then the folders.
    assert.match(html, /id="ib-new-go-open"[^\n]*<\/button>\n\s+<div class="ib-form ib-new" id="ib-new" hidden>/)
    assert.match(read('../src/style.css'), /@media \(max-width: 440px\) \{\n  \.ib-compose \{\n    flex-basis: 100%;/)
    assert.match(owner, /async function writeTo\(address: Uint8Array\) \{\n    closeNew\(false\)\n    const run = opened\n    if \(box\.thread\(address\)\.length && \(!isQuantumSafe\(address\) \|\| \(await addressWorks\(address\)\)\)\) \{\n      if \(run === opened\) openChat\(address\)\n      return\n    \}\n    if \(run === opened\) deps\.writeTo\(address\.slice\(\)\)/)
    // The composer, addressed as anyone's would be: anonymous unless they switch "Let them reply" on.
    assert.match(main, /writeTo: \(address\) => \{\n    void addressTo\(address\)/)
    assert.match(main, /if \(!again\) \{\n    includeBox\.checked = false/)
    // Saved names are picked and removed there, only while the inbox is kept.
    assert.match(owner, /const book = withBook\(\) \? box\.book\(\) : \[\]/)
    assert.equal(copy.COMPOSE, 'New message')
  })
})

describe('an empty-looking message (seen on a phone)', () => {
  test('the mailbox keeps its own copy: the same notice handed over twice never blanks what it holds', () => {
    const box = new Mailbox()
    const n = msg(900, 'still here', SAM)
    box.add(n, false)
    assert.equal(box.add(n, false), 'known')
    assert.equal(text(box.get(id(900))!.body), 'still here')
  })

  test('nothing visible in it says so, rather than showing a blank', () => {
    const owner = read('../src/inbox/owner.ts')
    // The page's own check, run on what a font draws as nothing (the review found Hangul and Braille
    // fillers, variation selectors and lone marks), and on what it must still show.
    const src = owner.match(/return \/(\[[^\n]+\])\/u\.test\(text\) \? text : copy\.MESSAGE_EMPTY/)
    assert.ok(src, 'the check')
    const visible = new RegExp(src[1], 'u')
    const C = (...n: number[]) => String.fromCodePoint(...n)
    for (const blank of ['', '   ', '\n\t', C(0), C(0, 0, 0), C(0x200b), C(0x3164), C(0xffa0), C(0x115f, 0x1160), C(0xfe0f), C(0x034f), C(0x0301), C(0x2800), C(0x2066, 0x2069)])
      assert.ok(!visible.test(blank), `blank: ${[...blank].map((c) => c.codePointAt(0)!.toString(16))}`)
    for (const shown of ['hi', '.', C(0x1f44d), C(0x1f469, 0x200d, 0x1f4bb), C(0x05e9, 0x05dc, 0x05d5, 0x05dd), 'e' + C(0x0301), C(0x4f60, 0x597d)])
      assert.ok(visible.test(shown), shown)
    // The chat and the owner's own messages use it too, not only the reader.
    assert.match(owner, /\} else body\.append\(linkedText\(shownText\(x\.body\), 'inbox'\)\)/)
    assert.match(owner, /pre\.append\(isText\(i\) \? linkedText\(shownText\(i\.body\), 'inbox'\) : copy\.MESSAGE_UNREADABLE\)/)
    assert.equal(copy.MESSAGE_EMPTY, 'An empty message')
  })
})
