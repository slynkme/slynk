// Files and longer messages to anonymous inboxes, behind INBOX_FILES in
// site.ts: off on slynk.me, where inboxes carry text only; on, an upload to a random pickup address announced by a notice that
// carries its plain v1 link. Run: npm --prefix web test
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { NOTICE_TEXT_MAX, NOTICE_TEXT_MAX_QS, NOTICE_TEXT_UNPACKED_MAX } from '../src/inbox/address.ts'
import { DROP_LIMIT, NOTICE_FILE, NOTICE_TEXT, fileNoticeBody, needsUpload, readFileNotice, uploadKey } from '../src/inbox/drop.ts'
import * as copy from '../src/inbox/inboxCopy.ts'
import { MAX_HELD, Mailbox } from '../src/inbox/mailbox.ts'
import { LINK_LENGTH, MAX_PAYLOAD, decode, encode, linkTimes, packItem, store } from '../src/payload.ts'
import { INBOX_FILES, ONE_TIME_ONLY } from '../src/site.ts'
import { FACTS, INBOX_UPLOAD_FACTS } from '../src/ui/facts.ts'
import { sitePage, seenOn } from './helpers/pages.ts'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const main = read('../src/main.ts')
const owner = read('../src/inbox/owner.ts')
const bridge = read('../../core/cmd/wasm/inbox.go')
const between = (src: string, from: string, to: string) => {
  const a = src.indexOf(from)
  const b = src.indexOf(to, a + from.length)
  assert.ok(a >= 0 && b > a, `${from} … ${to}`)
  return src.slice(a, b)
}

/** A v1 link as the core packs it: version, file ID, recipient, sent time, key, MAC, size, parts, retry. */
function v1Link(size: number, sent = Date.now()): Uint8Array {
  const v1 = new Uint8Array(LINK_LENGTH)
  crypto.getRandomValues(v1)
  v1[0] = 1
  const view = new DataView(v1.buffer)
  view.setBigUint64(1 + 32 + 33, BigInt(sent) * 1_000_000n)
  view.setUint32(1 + 32 + 33 + 8 + 32 + 32, size)
  return v1
}

describe('the switch', () => {
  test('is off on slynk.me, beside the one-time rule', () => {
    assert.equal(INBOX_FILES, false)
    assert.equal(ONE_TIME_ONLY, true)
    const site = read('../src/site.ts')
    assert.match(site, /A copy that switches it on takes on the responsibility for that/)
    assert.match(site, /export const INBOX_FILES = false\n/)
  })

  test('with it off, the composer addressed to an inbox is for a message only: no drop zone, one piece, no files', () => {
    assert.match(main, /drop\.hidden = !!to && !INBOX_FILES/)
    // Less any included inbox: what no longer fits one message goes as an upload.
    assert.match(main, /return !!addressed && INBOX_FILES && needsUpload\(tray\.count\(\), textBox\.value, noticeRoom\(\)\)/)
    assert.match(main, /if \(addressed && !inboxUpload\(\)\) return renderInboxCompose\(\)/)
    assert.match(main, /if \(addressed && !inboxUpload\(\)\) return inboxBlocker\(\)/)
    assert.match(main, /if \(tray\.count\(\)\) return inboxCopy\.TO_FILES/)
    // Dropped files are refused too, not only the drop zone hidden.
    assert.equal(main.match(/view === 'compose' && \(!addressed \|\| INBOX_FILES\)/g)?.length, 2)
    // 8a's send: one notice, whatever else is in the composer.
    assert.match(main, /async function sendToInbox\(\) \{\n  if \(inboxUpload\(\)\) return sendUploadToInbox\(\)/)
  })

  test('with it off, an owner’s page never collects an upload, and drops its link at once', () => {
    const box = new Mailbox()
    const body = fileNoticeBody(v1Link(40_000))
    assert.equal(box.add(found('a'.repeat(32), NOTICE_FILE, body), false), 'added')
    assert.ok(body.every((b) => b === 0), 'the notice’s copy of the link is wiped')
    const item = box.get('a'.repeat(32))!
    assert.equal(item.upload, undefined)
    assert.match(item.off!, /^[0-9a-f]{66}$/, 'only its pickup address is kept, to tell a repeat')
    assert.equal(item.body.length, 0)
    // The page shows DROP_OFF for it, opened or in a conversation, and never offers Collect.
    assert.match(between(owner, 'function renderOpen()', 'function '), /i\.off[\s\S]*offNote\(\)/)
    assert.match(between(owner, 'function offNote()', 'const isText'), /copy\.DROP_OFF/)
    assert.match(between(owner, 'function bubble(', '// The conversation'), /if \(i\.off\) body\.append\(offNote\(\)\)/)
    assert.match(owner, /box\.add\(n, INBOX_FILES\)/)
  })

  test('either way, an upload announced twice shows once', () => {
    for (const on of [true, false]) {
      const box = new Mailbox()
      const v1 = v1Link(5000)
      assert.equal(box.add(found('1'.repeat(32), NOTICE_FILE, fileNoticeBody(v1)), on), 'added')
      const again = fileNoticeBody(v1)
      assert.equal(box.add(found('2'.repeat(32), NOTICE_FILE, again), on), 'known')
      assert.ok(again.every((b) => b === 0), 'the repeat is wiped')
      assert.equal(box.size, 1)
    }
  })
})

describe('what goes as one notice and what needs an upload', () => {
  test('a message that fits one notice goes as one; files or anything longer need an upload', () => {
    assert.equal(needsUpload(0, ''), false)
    // Counted packed (inbox/pack.ts): what compresses fits, up to what the core unpacks.
    assert.equal(needsUpload(0, 'x'.repeat(NOTICE_TEXT_UNPACKED_MAX)), false)
    assert.equal(needsUpload(0, 'x'.repeat(NOTICE_TEXT_UNPACKED_MAX + 1)), true)
    const noise = (n: number) => Array.from({ length: n }, (_, i) => String.fromCodePoint(0x4e00 + ((i * 2654435761) >>> 7) % 20000)).join('')
    assert.equal(needsUpload(0, noise(NOTICE_TEXT_MAX / 3)), false, 'counted in bytes, not characters')
    assert.equal(needsUpload(0, noise(NOTICE_TEXT_MAX / 2)), true)
    assert.equal(needsUpload(0, noise(NOTICE_TEXT_MAX / 3), NOTICE_TEXT_MAX_QS), true, 'a quantum-safe address has less room')
    assert.equal(needsUpload(1, ''), true)
    assert.equal(needsUpload(1, 'hi'), true)
  })

  test('an upload to an inbox has the whole 2 MB: no one-time or password layer', () => {
    assert.equal(DROP_LIMIT, MAX_PAYLOAD)
    assert.match(main, /const payloadLimit = \(\) => \(addressed \? DROP_LIMIT : /)
    assert.match(main, /if \(usePassword && !addressed\) \{/)
  })
})

describe('the notice that announces an upload', () => {
  test('carries a plain v1 link and nothing else', () => {
    const v1 = v1Link(40_000)
    const body = fileNoticeBody(v1)
    assert.deepEqual([...body], [...v1])
    assert.notEqual(body, v1, 'a copy, so wiping one leaves the other')
    assert.ok(body.length <= NOTICE_TEXT_MAX, 'fits one notice')
    assert.equal(NOTICE_FILE, 2)
    assert.equal(NOTICE_TEXT, 1)
  })

  test('refuses anything but a plain v1 link: never v2 (the key server), never a password link', () => {
    const v1 = v1Link(1)
    for (const first of [0, 2, 0x81, 0x82]) {
      const bad = v1.slice()
      bad[0] = first
      assert.throws(() => fileNoticeBody(bad), `version byte ${first}`)
    }
    assert.throws(() => fileNoticeBody(v1.slice(0, LINK_LENGTH - 1)))
    assert.throws(() => fileNoticeBody(new Uint8Array(183)), 'a v2 link is longer')
  })

  test('is read back on the owner’s side, with its size and times', () => {
    const sent = Date.UTC(2026, 9, 16, 10, 0, 0)
    const v1 = v1Link(123_456, sent)
    const file = readFileNotice(fileNoticeBody(v1))!
    assert.deepEqual([...file.v1], [...v1])
    assert.equal(file.size, 123_456)
    assert.equal(file.sent.getTime(), sent)
    assert.equal(file.expires.getTime(), linkTimes(v1).expires.getTime())
  })

  test('is told apart from others by its pickup address, never by its key', () => {
    const v1 = v1Link(10)
    const key = uploadKey(v1)!
    assert.equal(key.length, 66, 'the 33-byte recipient ID')
    assert.equal(key, Buffer.from(v1.subarray(33, 66)).toString('hex'))
    assert.equal(uploadKey(fileNoticeBody(v1)), key, 'a notice sent again')
    const sameRecipient = v1Link(10)
    sameRecipient.set(v1.subarray(33, 66), 33)
    assert.equal(uploadKey(sameRecipient), key)
    assert.notEqual(uploadKey(v1Link(10)), key, 'another upload')
    const rekeyed = v1.slice()
    rekeyed.fill(7, 74, 74 + 64)
    assert.equal(uploadKey(rekeyed), key, 'the key and MAC play no part')
    assert.equal(uploadKey(v1.slice(0, LINK_LENGTH - 1)), undefined)
  })

  test('anything after the link is left for a later version; anything else is not a file notice', () => {
    const v1 = v1Link(5)
    const longer = new Uint8Array([...v1, ...new TextEncoder().encode('a later version’s note')])
    assert.deepEqual([...readFileNotice(longer)!.v1], [...v1])
    assert.equal(readFileNotice(v1.slice(0, LINK_LENGTH - 1)), undefined)
    const other = v1.slice()
    other[0] = 0x81
    assert.equal(readFileNotice(other), undefined)
  })

  test('goes from the tab’s second identity, never the one that uploaded, a random 1-3 minutes after it', () => {
    const fn = between(bridge, 'func sendFileNotice(', '// noticeIdentity connects')
    assert.match(fn, /c, err := noticeIdentity\(progress\)/)
    assert.ok(!fn.includes('connected()'), 'never the main identity')
    assert.match(fn, /until := transfer\.UploadNoticeTime\(since, time\.Now\(\)\)/)
    assert.ok(fn.indexOf('until :=') < fn.indexOf('noticeIdentity('), 'the wait counts from the upload, connecting included')
    // It waits for its moment, unless its sender stops it first, and only then goes.
    assert.match(fn, /case <-time\.After\(time\.Until\(until\)\):\n\t\tcase <-stop:\n\t\t\treturn nil, errNoticeStopped/)
    assert.ok(fn.indexOf('time.After(time.Until(until))') < fn.indexOf('at, err := c.SendNoticeAt(to, transfer.NoticeLink, link, from, reply, when, progress)'), 'it waits first')
    // Then on the beat of cover messages, always (the page's random moment is gone, but this wait stays).
    assert.match(fn, /when := transfer\.NoticeTiming\{AtRandom: true, Apart: len\(args\) > 7 && args\[7\]\.Truthy\(\)\}/)
    // Reply keys need the sender's inbox: refused at once, not after the wait.
    assert.ok(fn.indexOf('if reply != nil && from == nil {') < fn.indexOf('time.After(time.Until(until))'))
    const inbox = read('../../core/transfer/inbox.go')
    assert.match(inbox, /uploadNoticeMin = time\.Minute\n\tuploadNoticeMax = 3 \* time\.Minute/)
  })
})

describe('sending an upload to an inbox', () => {
  const send = between(main, 'async function sendUploadToInbox()', '$(\'to-clear\')')

  test('is an ordinary upload: no key server, no one-time layer, no password, whatever ONE_TIME_ONLY says', () => {
    assert.match(send, /const bytes = encode\(c\.packed\)\n  stopSqueezing\(\)\n  try \{\n    v1 = await core\.upload\(bytes,/)
    for (const s of ['protect(', 'reserve(', 'buildLinkV2', 'lock(', 'passwordKey', 'linkKind', 'oneTime', 'ONE_TIME_ONLY']) {
      assert.ok(!send.includes(s), s)
    }
    assert.match(send, /fileNoticeBody\(p\.v1\)/)
  })

  test('uploads from this tab’s identity, never one that has sent to inboxes', () => {
    assert.ok(send.indexOf('claimForLinks()') > 0 && send.indexOf('claimForLinks()') < send.indexOf('core.upload('))
    assert.match(main, /const mainNeeded = !addressed \|\| inboxUpload\(\) \|\| coreUse !== 'links'/)
  })

  test('the notice goes through sendFileNotice only, timed from the upload’s end', () => {
    const announce = between(main, 'async function announceUpload(p: PendingDrop)', '$(\'to-clear\')')
    assert.match(announce, /core\.sendFileNotice\(\n      p\.to\.address,\n      body,\n      p\.since,/)
    assert.ok(!announce.includes('core.sendNotice('), 'never the text path, which may use this identity')
    assert.match(send, /v1 = await core\.upload\([^]*?\n  pendingDrop = \{ to, v1, since: Date\.now\(\), size: bytes\.length, text: message\?\.text \?\? '', files: fileNames\(c\.packed\), \.\.\.\(including\(\) \? \{ include: \{ name: includeAs\(\) \} \} : \{\}\) \}\n  await announceUpload\(pendingDrop\)/)
    assert.match(announce, /\} finally \{\n    body\.fill\(0\)/)
  })

  test('Try again sends only the notice, and the tab asks before closing until it has gone', () => {
    assert.match(send, /\(\) => void announceUpload\(p\)\)/)
    assert.match(main, /function forgetPendingDrop\(\) \{\n  pendingDrop\?\.v1\.fill\(0\)\n  pendingDrop = undefined/)
    // A link arriving mid-flow is refused rather than dropping the upload unannounced.
    const read = between(main, 'function readLinkFromAddress()', 'function sameLink(')
    assert.match(read, /if \(pendingDrop\) \{\n    toast\(inboxCopy\.UPLOAD_PENDING_NAV\)\n    return true/)
    assert.ok(!read.includes('forgetPendingDrop'))
    assert.match(main, /window\.addEventListener\('beforeunload', \(e\) => \{\n  \/\/ [^\n]*\n  if \(pendingDrop \|\| owner\.unsent\(\)\) e\.preventDefault\(\)/)
    assert.match(main, /function resetCompose\(\) \{\n  forgetPendingDrop\(\)/)
  })
})

describe('collecting on the owner’s side', () => {
  const uploads = between(owner, '// --- Uploads', '// --- Opening')

  test('happens on a click, from the page: the link never goes into a URL or onto the screen', () => {
    for (const s of ['location', 'history', 'linkToFragment', 'toBase64url', 'inboxLink', 'clipboard']) {
      assert.ok(!uploads.includes(s), s)
    }
    assert.match(uploads, /part\(el, 'collect'\)\.addEventListener\('click', \(\) => void collect\(drop\)\)/)
    assert.match(uploads, /const v1 = drop\.item\.upload\?\.v1\n/)
    assert.match(uploads, /deps\.download\(v1,/)
    assert.ok(!/autoSave|settings\(\)/.test(uploads), 'never saved by itself')
  })

  test('one download at a time in the tab, whichever kind, and a send doesn’t stop a collect', () => {
    assert.match(main, /download: \(v1, onProgress\) => \{\n[^\n]*\n    if \(downloading\) return undefined\n    downloading = true\n    return core\.download\(v1, onProgress\)\.finally\(\(\) => \(downloading = false\)\)/)
    assert.match(main, /if \(downloading\) return toast\(inboxCopy\.DROP_WAIT_LINK\)/)
    const receive = between(main, 'async function receive()', 'async function afterDownload(')
    // A link tapped just before an owner's Collect waits for it, then holds the core.
    assert.match(receive, /while \(downloading \|\| owner\.uploading\(\)\) await new Promise/)
    assert.ok(receive.indexOf('while (downloading)') < receive.indexOf('downloading = true'))
    assert.ok(receive.indexOf('downloading = true') < receive.indexOf('core.download('))
    assert.equal(receive.match(/downloading = false/g)?.length, 2, 'released on success and on failure')
    assert.match(uploads, /if \(collecting\) return deps\.toast\(copy\.DROP_ONE_AT_A_TIME\)/)
    assert.match(uploads, /if \(!run\) return deps\.toast\(copy\.DROP_ONE_AT_A_TIME\)/)
  })

  test('Lock waits for a collect, a collect blocks removing its message, and a flood never pushes anything out', () => {
    // ...and for an upload's notice still to go (Try again needs the inbox).
    // ...and for a reply from the chat still on its way.
    assert.match(owner, /if \(deps\.busy\(\) \|\| deps\.pending\(\) \|\| !!collecting \|\| sendingNow > 0\) return copy\.OWNER_LOCK_BUSY\n/)
    assert.equal(owner.match(/const wait = lockWait\(\)\n    if \(wait\) return deps\.toast\(wait\)/g)?.length, 2)
    assert.match(owner, /if \(collecting === d\) \{\n        deps\.toast\(copy\.DROP_ONE_AT_A_TIME\)\n        return false\n      \}\n      wipeDrop\(d\)/)
    // Past MAX_HELD, new arrivals are counted, not shown: nothing held is ever dropped for them.
    const box = new Mailbox()
    for (let i = 0; i < MAX_HELD; i++) box.add(found(i.toString(16).padStart(32, '0'), NOTICE_TEXT, new Uint8Array([1])), true)
    const late = new Uint8Array([7, 7])
    assert.equal(box.add(found('f'.repeat(32), NOTICE_TEXT, late), true), 'full')
    assert.ok(late.every((b) => b === 0), 'what isn’t held is wiped')
    assert.equal(box.size, MAX_HELD)
    assert.equal(box.overflow, 1)
  })

  test('wipes what it collected on Forget and Lock, and the link too on Lock or Remove', () => {
    assert.match(uploads, /function forget\(drop: Drop\) \{\n    drop\.zip\.clear\(\) \/\/ and the zip made for sharing them\n    for \(const item of drop\.items \?\? \[\]\) item\.data\.fill\(0\)\n    drop\.bytes\?\.fill\(0\)\n    drop\.items = undefined\n    drop\.bytes = undefined/)
    assert.match(uploads, /function wipeDrop\(drop: Drop\) \{\n    drop\.gone = true\n    forget\(drop\)/)
    assert.match(between(owner, 'function wipeMessages()', '// --- Opening'), /for \(const d of drops\.values\(\)\) wipeDrop\(d\)\n    drops\.clear\(\)\n    box\.wipeAll\(\)/)
    for (const how of ['lock', 'remove'] as const) {
      const box = new Mailbox()
      box.add(found('c'.repeat(32), NOTICE_FILE, fileNoticeBody(v1Link(9000))), true)
      const v1 = box.get('c'.repeat(32))!.upload!.v1!
      assert.ok(v1.some((b) => b !== 0))
      if (how === 'lock') box.wipeAll()
      else box.remove('c'.repeat(32))
      assert.ok(v1.every((b) => b === 0), how)
    }
  })

  test('a round trip, page to page: the package, the notice, the owner’s row and what it opens', async () => {
    // The sender packs a message and a file exactly as for a link.
    const text = new TextEncoder().encode('Here are the documents. '.repeat(60))
    const file = crypto.getRandomValues(new Uint8Array(30_000))
    const packed = [
      packItem({ kind: 'text', name: '', type: '', data: text }, await store(text, '')),
      packItem({ kind: 'file', name: 'report.pdf', type: 'application/pdf', data: file, stripped: true }, await store(file, 'application/pdf')),
    ]
    const payload = encode(packed)
    assert.ok(payload.length <= DROP_LIMIT)
    // The core uploads it and gives a v1 link; a notice carries the link.
    const v1 = v1Link(payload.length)
    const body = fileNoticeBody(v1)
    // The owner's page reads the notice, collects with its link and opens the package.
    const seen = readFileNotice(body)!
    assert.equal(seen.size, payload.length)
    assert.deepEqual([...seen.v1], [...v1])
    const items = await decode(payload)
    assert.equal(items.length, 2)
    assert.equal(items[0].kind, 'text')
    assert.deepEqual([...items[0].data], [...text])
    assert.equal(items[1].kind, 'file')
    assert.equal(items[1].name, 'report.pdf')
    assert.equal(items[1].stripped, true)
    assert.deepEqual([...items[1].data], [...file])
  })
})

describe('the wording for files to inboxes', () => {
  test('the honest line: many pieces, the internet address, a VPN, and short messages as the discreet way', () => {
    assert.match(copy.TO_UPLOAD_HONEST, /many pieces/)
    assert.match(copy.TO_UPLOAD_HONEST, /internet address/)
    assert.match(copy.TO_UPLOAD_HONEST, /never see what’s inside/)
    assert.match(copy.TO_UPLOAD_HONEST, /A VPN keeps your address from them/)
    assert.match(copy.TO_UPLOAD_HONEST, /a short message on its own is the most discreet way to write/)
    assert.ok(!/\blinks?\b/i.test(copy.TO_UPLOAD_HONEST), 'never suggests sending a link instead')
  })

  test('shows only when the switch is on and something needs an upload', () => {
    assert.match(read('../index.html'), /id="to-upload-honest" data-copy="TO_UPLOAD_HONEST" hidden/)
    assert.match(main, /\$\('to-upload-honest'\)\.hidden = !addressed\n/)
    assert.match(main, /\$\('to-upload-honest'\)\.hidden = true\n/)
  })

  test('with it off, senders, new owners and the "doesn’t collect" note say messages only, and link to why', () => {
    assert.equal(copy.MESSAGES_ONLY, 'slynk.me’s inboxes take messages, not files.')
    assert.equal(copy.MESSAGES_ONLY_HREF, '/about/#inbox-files')
    assert.match(read('../about/index.html'), /<details id="inbox-files">\s*<summary>Can people send files to an inbox\?<\/summary>/)
    const html = read('../index.html')
    // The sender's "Why messages only?" sits in Good to know, beside "How it compares".
    assert.match(html, /<span id="to-only" hidden> · <a data-copy="MESSAGES_ONLY_WHY" target="_blank" rel="noopener"><\/a><\/span><\/p>\s*<\/details>/)
    assert.match(html, /<p class="lead-p" id="ni-only" hidden><span data-copy="MESSAGES_ONLY"><\/span> <a data-copy="MESSAGES_ONLY_WHY"/)
    // Shown only while the switch is off; with it on, no limit is claimed.
    // The size line follows how the message would go: two pieces to a quantum-safe address, one sealed with reply keys.
    assert.match(main, /\$\('to-size'\)\.textContent = inboxCopy\.TO_SIZE\(INBOX_FILES, two\)/)
    assert.match(main, /    renderSize\(\)\n(?:[^\n]*\n){0,3}    \$\('to-only'\)\.hidden = INBOX_FILES/)
    assert.match(main, /\$\('ni-only'\)\.hidden = INBOX_FILES/)
    assert.match(main, /a\[data-copy="MESSAGES_ONLY_WHY"\]'\)\) a\.href = inboxCopy\.MESSAGES_ONLY_HREF/)
    assert.match(between(owner, 'function offNote()', 'const isText'), /copy\.DROP_OFF[\s\S]*copy\.MESSAGES_ONLY_HREF/)
  })

  test('an owner’s page that doesn’t collect says so plainly', () => {
    assert.match(copy.DROP_OFF, /files or a longer message/)
    assert.match(copy.DROP_OFF, /don’t collect/)
    assert.ok(!/newer version/.test(copy.DROP_OFF))
  })

  test('nothing on the owner’s side or while sending tells anyone to pass on a link', () => {
    for (const t of [copy.DROP_STALLED(1, 2), copy.DROP_STOPPED(1), copy.DROP_STOPPED(0), copy.DROP_FAILED('x'), copy.UPLOAD_NOTICE_FAILED('x'), copy.UPLOAD_UNDELIVERED, copy.UPLOAD_UNCONFIRMED, copy.UPLOAD_WAITING]) {
      assert.ok(!/\blinks?\b|ask the sender/i.test(t), t)
    }
  })

  test('the facts while uploading to an inbox: nothing about links, one piece or who’s talking to whom', () => {
    assert.ok(INBOX_UPLOAD_FACTS.length >= 8)
    for (const f of INBOX_UPLOAD_FACTS) {
      assert.ok(FACTS.includes(f) || /only the inbox/.test(f), f)
      assert.ok(!/\blink\b|#|as a single piece|talking to whom/i.test(f), f)
    }
  })
})

describe('the About page on files to inboxes', () => {
  const about = seenOn(sitePage('about/index.html')).replace(/\s+/g, ' ')
  const answer = between(about, 'id="inbox-files"', '</details>')

  test('says slynk.me leaves them out, that the code can do it, and that a developer launching their own version can switch it on', () => {
    assert.match(answer, /Not on slynk\.me, for now: its inboxes take short messages/)
    assert.match(answer, /Slynk’s code can send files and longer messages to an inbox too, with one setting switched on/)
    assert.match(answer, /Any developer who launches their own version of Slynk’s code can switch it on/)
    assert.match(answer, /the choice, and what comes of it, would be theirs/)
    assert.match(answer, /doesn’t collect files, even ones sent from someone else’s version of Slynk/)
  })

  test('a Slynk link in a message is the way to send files, honestly put', () => {
    // Not the same risk as files collected in the inbox's own tab: a link opens in a new tab with an
    // identity of its own, whenever and wherever the owner likes; only the same internet address could tie it.
    assert.match(answer, /A message can include links, though, Slynk links among them/)
    assert.match(answer, /A link in a message opens in a new tab with an identity of its own/)
    assert.match(answer, /Opened from a different internet address than the inbox’s, on another network or with a VPN, it can’t easily be tied to the inbox/)
    assert.match(answer, /since every link opens only once, whatever it holds reaches the owner alone/)
    assert.ok(!/same risk/.test(answer))
  })
})

/** A notice as the core hands it over. */
function found(id: string, kind: number, body: Uint8Array) {
  return { id, kind, body, sent: Date.now(), at: Date.now(), quantumSafe: false }
}
