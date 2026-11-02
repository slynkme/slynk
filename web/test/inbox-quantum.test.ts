// An inbox's quantum-safe address: its two addresses as
// links, digits and QR codes; message text compressed to fit; one list in the
// mailbox with each message marked (2026-10-18, in place of a tab for each
// address); what's kept; and the wording. The sealing itself is the core's
// (core/transfer/inbox4.go, kemeleon.go), tested in Go.
// Run: npm --prefix web test
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { inflateSync } from 'fflate'
import { correction, generate } from 'lean-qr'
import {
  ADDRESS4_DIGITS,
  INBOX_ADDRESS4_LENGTH,
  INBOX_ADDRESS4_VERSION,
  INBOX_ADDRESS_LENGTH,
  NOTICE_TEXT_MAX,
  NOTICE_TEXT_MAX_QS,
  NOTICE_TEXT_UNPACKED_MAX,
  addressDigits,
  addressFromInput,
  compactAddress,
  inboxLink,
  inboxQrText,
  inboxRoute,
  isInboxAddress,
  isQuantumSafe,
  noticeTextMax,
  sameInbox,
} from '../src/inbox/address.ts'
import { NOTICE_TEXT } from '../src/inbox/drop.ts'
import * as copy from '../src/inbox/inboxCopy.ts'
import { INBOX, Mailbox, hex, inboxKey } from '../src/inbox/mailbox.ts'
import { fill, fits, pack } from '../src/inbox/pack.ts'
import { readQr } from '../src/inbox/scanRead.ts'
import { toBase64url } from '../src/linkv2.ts'
import { INBOX_FACTS, INBOX_FACTS_QS } from '../src/ui/facts.ts'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

/** A quantum-safe address as the core makes it, but for its keys: version 4, the ed25519 key, the ML-KEM key, the signature. */
function address4(seed: number): Uint8Array {
  const a = Uint8Array.from({ length: INBOX_ADDRESS4_LENGTH }, (_, i) => (i * 131 + seed * 17) % 256)
  a[0] = INBOX_ADDRESS4_VERSION
  return a
}
const compactOf = (seed: number) => compactAddress(address4(seed))

// An English letter, as a sender in trouble might write it: what the room is reckoned from.
const LETTER =
  "I'm writing because I don't know who else to ask. My landlord has been coming into the flat when I'm not there, and last week he took my passport \"to keep it safe\". He says I owe him three months' rent, which isn't true, and that if I go to the police he'll tell them I'm working without papers. I have the receipts for every payment on my phone. I can't leave because I have nowhere else to go and my daughter starts school here in September. Is there anything I can do without him finding out? I can meet on Tuesday or Thursday afternoons when he's at his other building. Please don't call the number he knows. Thank you for reading this. I'm sorry it's so long, I've never had to do anything like this before and I'm scared of getting it wrong. " +
  'Some more background, in case it helps. We moved here two years ago from my aunt\'s house in the north, after my husband left. The first year was fine. The landlord was friendly and fixed the boiler when it broke in January. Things changed in the spring when his brother started collecting the rent instead of him. The brother asks for cash, never gives a receipt, and twice he has said the amount was short when it wasn\'t. I started paying by bank transfer instead, which is why I have the records. Since then the visits started. Sometimes I come home and things on the table have been moved, or the window is open when I closed it. My neighbour saw him leaving once with a bag. I don\'t know what was in it. I haven\'t told my daughter any of this because she would worry, and she has her exams soon. I work cleaning offices in the evenings, five nights a week, and I\'m afraid that if I make trouble I will lose that job as well, because the same family owns the company that hired me. I would like to know my rights about the passport most of all, and whether I can get it back without the police, and whether there is a safe place we could stay for a few weeks if it gets worse. I can read English well but I find phone calls hard, so writing is better for me if that is possible.'

describe('an inbox’s two addresses', () => {
  test('a quantum-safe address opens from its link, or from its digits, the same', () => {
    for (const seed of [1, 2, 3, 250]) {
      const a = address4(seed)
      const b64 = toBase64url(a)
      assert.equal(b64.length, 1708)
      const digits = addressDigits(a)
      assert.equal(digits.length, ADDRESS4_DIGITS, 'its first byte is 4, so always 3,084 digits')
      for (const fragment of [`#${b64}`, `#${digits}`]) {
        const r = inboxRoute(fragment)
        assert.equal(r?.kind, 'inbox', fragment.slice(0, 20))
        assert.deepEqual(r?.kind === 'inbox' && [...r.address], [...a])
      }
      assert.ok(isQuantumSafe(a) && isInboxAddress(a))
    }
  })

  test('nothing else reads as a quantum-safe address', () => {
    const a = address4(7)
    const digits = addressDigits(a)
    const wrongFirst = Uint8Array.from(a, (b, i) => (i ? b : 5))
    for (const bad of [
      digits.slice(1), // a digit short
      `${digits}0`, // one too many
      digits.replace(/^./, '9'), // its first byte isn't 4
      digits.replace(/.$/, 'x'),
      toBase64url(a).slice(1),
      toBase64url(wrongFirst),
      toBase64url(a.slice(0, INBOX_ADDRESS4_LENGTH - 1)),
    ]) {
      assert.equal(inboxRoute(`#${bad}`), undefined, bad.slice(0, 30))
    }
    assert.ok(!isQuantumSafe(compactOf(7)) && isInboxAddress(compactOf(7)))
  })

  test('both addresses are one inbox: the quantum-safe one starts with the compact one', () => {
    const a = address4(9)
    const c = compactAddress(a)
    assert.equal(c.length, INBOX_ADDRESS_LENGTH)
    assert.equal(c[0], 3)
    assert.deepEqual([...c.subarray(1)], [...a.subarray(1, INBOX_ADDRESS_LENGTH)])
    assert.equal(compactAddress(c), c, 'a compact address is its own')
    assert.equal(inboxKey(a), inboxKey(c))
    assert.equal(inboxKey(c), hex(c))
  })

  test('either address of an inbox is the same inbox, and nobody else’s is', () => {
    const a = address4(10)
    assert.ok(sameInbox(a, compactAddress(a)) && sameInbox(compactAddress(a), a) && sameInbox(a, a))
    assert.ok(!sameInbox(a, address4(13)) && !sameInbox(compactAddress(a), compactOf(13)))
  })

  test('writing to one’s own inbox at either address offers no “Let them reply”; a quantum-safe address names nobody until the core has checked it', () => {
    const main = read('../src/main.ts')
    assert.match(main, /return !!addressed && !!owner\?\.isOpen\(\) && !\(own && sameInbox\(addressed\.address, own\)\)/)
    assert.match(main, /const confirmed = \(to: \{ address: Uint8Array; checked: boolean \}\) => to\.checked \|\| !isQuantumSafe\(to\.address\)/)
    assert.match(main, /const known = confirmed\(to\)\n    const name = known \? nameFor\(to\.address\) : undefined\n    const theirs = known \? owner\?\.senderLabel\(to\.address\) : undefined/)
    assert.match(main, /\$\('to-links'\)\.hidden = !!name \|\| !owner\?\.book\(\) \|\| !known/)
    assert.match(main, /if \(!to \|\| !confirmed\(to\)\) return\n  const result = owner\.saveContact\(to\.address/)
    // The page shows the address again once the core has checked it.
    assert.match(main, /await core\.inboxAddress\(address\)\n    to\.checked = true/)
    assert.match(main, /if \(addressed === to\) applyMode\(\)/)
  })

  test('the inbox’s own screen checks a quantum-safe address with the core before opening a conversation with it', () => {
    const owner = read('../src/inbox/owner.ts')
    // New message, the address book and the scanner all go through writeTo.
    assert.match(owner, /if \(box\.thread\(address\)\.length && \(!isQuantumSafe\(address\) \|\| \(await addressWorks\(address\)\)\)\) \{\n      if \(run === opened\) openChat\(address\)/)
    assert.match(owner, /const addressWorks = \(address: Uint8Array\) =>\n    deps\n      \.core\(\)\n      \.inboxAddress\(address\)/)
    assert.match(owner, /write\.addEventListener\('click', \(\) => writeTo\(c\.address\)\)/)
    assert.match(owner, /openScan\(\(address\) => writeTo\(address\)\)/)
    // A reply the core refuses for its address leaves the conversation, its text back in the box.
    assert.match(owner, /if \(errorCode\(e\) === 'address'\) refusedAddress\(x\)/)
    assert.match(owner, /function refusedAddress\(x: SentItem\) \{\n    box\.removeSent\(x\.id, false\)/)
  })

  test('a forged quantum-safe address that was refused never stays what a conversation is written to', () => {
    // The second review's case: a forged address (a known inbox's key, someone else's ML-KEM key) for Bob.
    const box = new Mailbox()
    const bob = compactOf(14)
    box.add({ id: 'ab'.repeat(16), kind: NOTICE_TEXT, body: new TextEncoder().encode('hi'), at: Date.now(), quantumSafe: false, from: bob, fromName: 'Bob' }, false)
    const forged = address4(14)
    assert.equal(inboxKey(forged), inboxKey(bob), 'it names Bob’s conversation by its compact part')
    const x = box.addSent(forged, new TextEncoder().encode('to the forged address'), '')
    assert.deepEqual([...box.bestAddress(bob)], [...forged], 'while it waits to go, it’s what Bob is written to')
    // The core refuses it (its signature doesn't check): the screen removes it.
    assert.ok(box.removeSent(x.id, false))
    assert.deepEqual([...box.bestAddress(bob)], [...bob])
    assert.equal(box.thread(bob).length, 1)
  })

  test('a long link survives being wrapped over lines by the app it came in', () => {
    const a = address4(11)
    const link = inboxLink('https://slynk.example', a)
    const wrapped = link.match(/.{1,76}/g)!.join('\r\n')
    assert.deepEqual([...addressFromInput(wrapped)!], [...a])
    assert.deepEqual([...addressFromInput(`  ${addressDigits(a)}\n`)!], [...a])
  })

  test('its QR code holds digits, version 30, and the scanner reads it back to the same address', () => {
    const origin = 'https://slynk.me'
    const a = address4(12)
    const text = inboxQrText(origin, a)
    assert.equal(text, `${origin}/#${addressDigits(a)}`)
    assert.equal(inboxQrText(origin, compactOf(12)), inboxLink(origin, compactOf(12)), 'the compact one keeps its link, as printed before')
    const code = generate(text, { minCorrectionLevel: correction.M })
    assert.equal(code.size, 137, 'version 30 at correction level M (35 as base64url)')
    // Drawn at 5 pixels a square, as the scanner's full-detail read sees a code filling most of its square.
    const scale = 5
    const modules = code.size + 8
    const width = modules * scale
    const data = new Uint8ClampedArray(width * width * 4).fill(255)
    for (let y = 0; y < width; y++) {
      for (let x = 0; x < width; x++) {
        const mx = Math.floor(x / scale) - 4
        const my = Math.floor(y / scale) - 4
        if (mx >= 0 && my >= 0 && mx < code.size && my < code.size && code.get(mx, my)) {
          const i = (y * width + x) * 4
          data[i] = data[i + 1] = data[i + 2] = 0
        }
      }
    }
    const read = readQr(data, width, width, false)
    assert.deepEqual(read && [...addressFromInput(read)!], [...a])
  })

  test('the scanner asks for a picture big enough, and reads every other one in full detail', () => {
    const scan = read('../src/inbox/scan.ts')
    assert.match(scan, /video: \{ facingMode: 'environment', width: \{ ideal: 1920 \}, height: \{ ideal: 1080 \} \}/)
    assert.match(scan, /const sq = middleSquare\(v\.videoWidth, v\.videoHeight, s\.reads\+\+ % 2 \? FINE_SIDE : 640\)/)
    assert.match(scan, /const FINE_SIDE = 1080/)
    assert.match(copy.SCAN_HARD, /use a photo instead/)
  })
})

describe('message text, compressed to fit (as Haven does)', () => {
  test('the room for each kind matches the core', () => {
    const core = read('../../core/transfer/inbox_test.go')
    assert.match(core, /if got := MaxNoticeBody\(msgLen\); got != 924/)
    assert.match(core, /if got := MaxNoticeBody4\(msgLen\); got != 652/)
    assert.equal(NOTICE_TEXT_MAX, 924)
    assert.equal(NOTICE_TEXT_MAX_QS, 652)
    assert.equal(noticeTextMax(compactOf(1)), 924)
    assert.equal(noticeTextMax(address4(1)), 652)
    assert.equal(NOTICE_TEXT_UNPACKED_MAX, Number(read('../../core/transfer/inbox.go').match(/MaxNoticeText = (\d+)/)![1]))
  })

  test('compressed only when that’s smaller, and it unpacks to the same text', () => {
    assert.deepEqual(pack(''), { bytes: new Uint8Array(0), compressed: false, raw: 0 })
    const hi = pack('hi')
    assert.equal(hi.compressed, false)
    assert.equal(new TextDecoder().decode(hi.bytes), 'hi')
    const p = pack(LETTER)
    assert.ok(p.compressed && p.bytes.length < p.raw * 0.6)
    assert.equal(new TextDecoder().decode(inflateSync(p.bytes)), LETTER)
    const emoji = '😀🏠🌱🔒'.repeat(5)
    assert.equal(new TextDecoder().decode(pack(emoji).compressed ? inflateSync(pack(emoji).bytes) : pack(emoji).bytes), emoji)
  })

  test('about 1,800 characters of an English letter fit a compact message, about 1,250 a quantum-safe one', () => {
    const most = (room: number) => {
      let lo = 0
      let hi = LETTER.length
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        if (fits(LETTER.slice(0, mid), room)) lo = mid
        else hi = mid - 1
      }
      return lo
    }
    assert.ok(LETTER.length > 2000)
    const compact = most(NOTICE_TEXT_MAX)
    const qs = most(NOTICE_TEXT_MAX_QS)
    assert.ok(compact > 1700 && compact < 1900, `compact: ${compact}`)
    assert.ok(qs > 1150 && qs < 1350, `quantum-safe: ${qs}`)
    // The screens say "about 300 words" and "about 200": with room to spare.
    assert.ok(LETTER.slice(0, compact).split(/\s+/).length > 300)
    assert.ok(LETTER.slice(0, qs).split(/\s+/).length > 200)
  })

  test('the meter counts in characters of the script typed, and says how far over', () => {
    const empty = fill('', NOTICE_TEXT_MAX)
    assert.equal(empty.over, false)
    assert.ok(empty.chars > 1500 && empty.chars < 1800, `an empty message has room for about ${empty.chars}`)
    const over = fill(LETTER, NOTICE_TEXT_MAX_QS)
    assert.equal(over.over, true)
    assert.ok(over.chars > 0)
    // More than the core unpacks is too long, however well it packs.
    const flood = fill('y'.repeat(NOTICE_TEXT_UNPACKED_MAX + 10), NOTICE_TEXT_MAX)
    assert.deepEqual([flood.over, flood.chars], [true, 10])
    assert.equal(fits('y'.repeat(NOTICE_TEXT_UNPACKED_MAX), NOTICE_TEXT_MAX), true)
  })

  test('what’s sent is what the meter measured: the composer and the chat both send pack(text)', () => {
    const main = read('../src/main.ts')
    assert.equal(main.match(/core\.sendNotice\(/g)?.length, 2)
    assert.equal(main.match(/pack\(text\)/g)?.length, 2)
    assert.match(read('../src/core/client.ts'), /bytes: text\.bytes, compressed: text\.compressed/)
    assert.match(read('../../core/cmd/wasm/inbox.go'), /if len\(args\) > 7 && args\[7\]\.Truthy\(\) \{\n\t\tkind \|= transfer\.NoticeDeflate\n\t\}/)
  })
})

describe('one list in the mailbox, each message marked', () => {
  let clock = Date.UTC(2026, 9, 18, 9)
  let n = 0
  const found = (body: string, qs: boolean, from?: Uint8Array, name = '') => ({
    id: (++n).toString(16).padStart(32, '0'),
    kind: NOTICE_TEXT,
    body: new TextEncoder().encode(body),
    at: (clock += 60_000),
    quantumSafe: qs,
    ...(from ? { from: from.slice(), fromName: name } : {}),
  })
  const ids = (rows: ReturnType<Mailbox['rows']>) => rows.map((r) => (r.kind === 'message' ? new TextDecoder().decode(r.item.body) : `thread ${r.key.slice(0, 6)}`))

  test('every message is in the one list, marked as it came, and counted once', () => {
    const box = new Mailbox()
    box.add(found('to the secure address', false), false)
    box.add(found('to the quantum-safe address', true), false)
    assert.deepEqual(ids(box.rows(INBOX)), ['to the quantum-safe address', 'to the secure address'])
    assert.deepEqual(
      box.rows(INBOX).map((r) => r.kind === 'message' && !!r.item.qs),
      [true, false],
    )
    // One count of what's unread, in every folder and for the front page's bar.
    assert.equal(box.unread(), 2)
    assert.equal(box.counts().get(INBOX)?.unread, 2)
    assert.equal(box.counts().get(INBOX)?.total, 2)
    assert.equal(box.received, 2)
    // No list or count by address any more.
    for (const gone of ['receivedIn', 'tabOf', 'threadTab', 'prefersQs']) assert.equal(gone in box, false, gone)
    assert.equal(Mailbox.prototype.rows.length, 1, 'a folder, and nothing more')
  })

  test('a conversation is marked as their latest message came; with nothing from them, as the owner’s newest went', () => {
    const box = new Mailbox()
    const sam = compactOf(1)
    box.add(found('hello, from Sam to the quantum-safe address', true, sam, 'Sam'), false)
    const t = box.rows(INBOX)
    assert.equal(t.length, 1)
    assert.ok(t[0].kind === 'thread' && t[0].qs)
    assert.equal(box.threadQs(sam), true)
    // The owner's reply joins it, sent the standard way: their latest message still marks it.
    const r = box.addSent(sam, new TextEncoder().encode('a reply'), '')
    box.sentDone(r.id, Date.now(), false)
    assert.equal(box.threadQs(sam), true)
    // Sam writes again, to the secure address this time: the mark follows.
    box.add(found('again, to the secure address', false, sam, 'Sam'), false)
    assert.equal(box.threadQs(sam), false)
    assert.ok(box.rows(INBOX).every((x) => x.kind !== 'thread' || !x.qs))
    // A conversation the owner started at a quantum-safe address: an atom, before and after it has gone.
    const alex = address4(2)
    const a = box.addSent(alex, new TextEncoder().encode('hi Alex'), '')
    assert.equal(box.threadQs(alex), true, 'on its way')
    box.sentDone(a.id, Date.now(), true)
    assert.equal(box.threadQs(alex), true)
    // And one at a compact address: a padlock.
    const kim = compactOf(9)
    box.addSent(kim, new TextEncoder().encode('hi Kim'), '')
    assert.equal(box.threadQs(kim), false)
  })

  test('a row and the top of its chat are always marked the same', () => {
    const box = new Mailbox()
    const people = [compactOf(11), compactOf(12), address4(13), compactOf(14)]
    let i = 0
    for (const p of people) {
      // Messages both ways, some at the same moment, some still on their way or failed.
      for (let k = 0; k < 4; k++) {
        const at = Date.UTC(2026, 9, 18, 10, k)
        if ((i + k) % 3 !== 2) box.add({ ...found(`from ${i} ${k}`, (i + k) % 2 === 0, compactAddress(p), ''), at }, false)
        const x = box.addSent((i + k) % 2 ? p : compactAddress(p), new TextEncoder().encode(`to ${i} ${k}`), '', undefined, at)
        if (k % 3 === 0) box.sentDone(x.id, at, (i + k) % 2 === 1)
        else if (k % 3 === 1) box.sentFailed(x.id)
      }
      i++
    }
    // Nothing from them, and two of the owner's messages at the same moment, one of each kind: the
    // same one decides on both (thread order: by time, then ID).
    for (const seed of [21, 22, 23, 24, 25, 26]) {
      const x = box.addSent(address4(seed), new TextEncoder().encode('quantum-safe'), '', undefined, 5000)
      const y = box.addSent(compactOf(seed), new TextEncoder().encode('the standard way'), '', undefined, 5000)
      box.sentDone(x.id, 5000, true)
      if (seed % 2) box.sentDone(y.id, 5000, false)
      if (seed % 3 === 0) {
        const z = box.addSent(compactOf(seed), new TextEncoder().encode('on its way'), '', undefined, 5000)
        assert.equal(z.state, 'sending')
      }
    }
    let threads = 0
    for (const r of box.rows(INBOX)) {
      if (r.kind !== 'thread') continue
      threads++
      assert.equal(r.qs, box.threadQs(r.address), r.key)
    }
    assert.equal(threads, 10)
  })

  test('either of an inbox’s addresses is one conversation, written to at its quantum-safe address once that’s known', () => {
    const box = new Mailbox()
    const alex = address4(3)
    const alexCompact = compactAddress(alex)
    // The owner wrote to Alex's quantum-safe address with their inbox included...
    box.addSent(alex, new TextEncoder().encode('hello Alex'), 'Kim')
    // ...and Alex's reply came from Alex's compact address, as every included inbox is.
    box.add(found('hello Kim', false, alexCompact, 'Alex'), false)
    const thread = box.thread(alexCompact)
    assert.equal(thread.length, 2, 'one conversation')
    assert.equal(box.thread(alex).length, 2)
    assert.deepEqual([...box.bestAddress(alexCompact)], [...alex], 'written to at the quantum-safe address')
    const rows = box.rows(INBOX)
    assert.equal(rows.length, 1)
    assert.ok(rows[0].kind === 'thread' && isQuantumSafe(rows[0].address))
    // Someone only known by their compact address is written to at that.
    const sam = compactOf(4)
    assert.equal(box.bestAddress(sam), sam)
  })

  test('the address book holds either address, finds an inbox by either, and keeps the quantum-safe one', () => {
    const box = new Mailbox()
    const a = address4(5)
    const c = compactAddress(a)
    assert.ok(typeof box.saveContact(c, 'Advice line') === 'object')
    assert.equal(box.contactFor(a)?.name, 'Advice line', 'found by the other address')
    box.saveContact(a, 'Advice line')
    assert.ok(isQuantumSafe(box.contactFor(c)!.address), 'saved by the quantum-safe address, kept as that')
    box.saveContact(c, 'Advice line 2')
    assert.ok(isQuantumSafe(box.contactFor(c)!.address), 'renaming by the compact one keeps it')
    assert.equal(box.book().length, 1)
    assert.deepEqual([...box.bestAddress(c)], [...a])
  })

  test('the owner’s own one-way messages are marked by the address they went to, whatever an older record says', () => {
    const box = new Mailbox()
    box.addMine(compactOf(6), new TextEncoder().encode('one-way, secure'), Date.now())
    box.addMine(address4(6), new TextEncoder().encode('one-way, quantum-safe'), Date.now())
    const marks = () => box.rows(INBOX).map((r) => (r.kind === 'message' ? `${new TextDecoder().decode(r.item.body)}: ${!!r.item.qs}` : ''))
    assert.deepEqual(marks().sort(), ['one-way, quantum-safe: true', 'one-way, secure: false'])
    // A record kept before the one list marked them by the tab shown when sending: read by where they went.
    const kept = JSON.parse(JSON.stringify(box.toKept()))
    for (const i of kept.items) i.qs = !i.qs ? true : undefined
    const back = Mailbox.fromKept(kept, false)
    assert.deepEqual(
      back
        .rows(INBOX)
        .map((r) => (r.kind === 'message' ? `${new TextDecoder().decode(r.item.body)}: ${!!r.item.qs}` : ''))
        .sort(),
      ['one-way, quantum-safe: true', 'one-way, secure: false'],
    )
  })

  test('kept on the device: the marks, the address shared last, and addresses of either kind', () => {
    const box = new Mailbox()
    box.sharesQs = true
    box.add(found('to the quantum-safe address', true), false)
    box.add(found('to the secure address', false), false)
    const a = address4(7)
    box.saveContact(a, 'Advice line')
    box.addSent(a, new TextEncoder().encode('to their quantum-safe address'), '')
    const sent = box.thread(a)[0]
    assert.ok(sent.kind === 'out' && box.sentDone(sent.sent.id, Date.now()))
    box.addMine(a, new TextEncoder().encode('one-way'), Date.now())
    const kept = JSON.parse(JSON.stringify(box.toKept()))
    // The same field quantum-safe inboxes first kept the main address in: records kept then open as they are.
    assert.equal(kept.prefer, 'qs')
    assert.ok(!JSON.stringify(kept).includes('resent'))
    const back = Mailbox.fromKept(kept, false)
    assert.equal(back.sharesQs, true)
    assert.equal(back.rows(INBOX).filter((r) => (r.kind === 'message' ? r.item.qs : r.qs)).length, 3, 'the quantum-safe message, the one-way one and the conversation')
    assert.ok(isQuantumSafe(back.contactFor(compactAddress(a))!.address))
    assert.equal(back.thread(compactAddress(a)).length, 1)
    // Shared last the secure one: nothing extra is kept.
    assert.ok(!('prefer' in new Mailbox().toKept()))
    // A record from before quantum-safe inboxes: its "May be a copy" flag is no longer read.
    const old = { ...kept, prefer: undefined, items: kept.items.map((i: Record<string, unknown>) => ({ ...i, resent: true, qs: undefined })) }
    const fromOld = Mailbox.fromKept(old, false)
    assert.equal(fromOld.sharesQs, false)
    assert.ok(fromOld.all().every((i) => !('resent' in i) && (!i.qs || !!i.mine)))
  })
})

describe('the screens', () => {
  const html = read('../index.html')
  const owner = read('../src/inbox/owner.ts')
  const create = read('../src/inbox/create.ts')

  test('the two addresses are tabs only where one is shared: the ready screen and Share, each with the explainer’s (i)', () => {
    assert.equal(html.match(/role="tablist"/g)?.length, 2)
    assert.match(html, /<div class="addr-tabs-row">\s*<div class="addr-tabs" id="ni-tabs" role="tablist" data-copy-label="TABS_LABEL">\s*<button class="addr-tab" id="ni-tab-secure" type="button" role="tab" aria-selected="true"[^>]*>[\s\S]*?<\/div>\s*<button class="icon-btn small addr-what" id="ni-tabs-what" type="button" data-qs-why="inbox" data-copy-label="TABS_WHAT">/)
    // Share's: inside its box, before the link and the QR code, with the (i).
    const share = html.slice(html.indexOf('<div class="ib-share" id="ib-share-box" hidden>'), html.indexOf('id="ib-save-qr"'))
    assert.match(share, /<div class="addr-tabs ib-tabs" id="ib-tabs" role="tablist" data-copy-label="TABS_LABEL">\s*<button class="addr-tab" id="ib-tab-secure"[^>]*data-qs="false">[\s\S]*<button class="addr-tab" id="ib-tab-qs"[^>]*data-qs="true"/)
    assert.match(share, /id="ib-tabs-what" type="button" data-qs-why="inbox" data-copy-label="TABS_WHAT"/)
    assert.ok(share.indexOf('ib-tabs') < share.indexOf('id="ib-link"'))
    // Inside it: nothing closes before the tabs.
    assert.ok(!share.slice(0, share.indexOf('id="ib-tabs"')).includes('</div>'))
    // Nothing in the list chooses by address: no tabs, no main address to make, no news of another tab.
    for (const gone of ['qsTab', 'renderTabs', 'showTab', 'makeMain', 'TAB_MAKE_MAIN', 'NEW_IN_TAB', 'TAB_UNREAD', 'receivedIn', 'threadTab']) assert.ok(!owner.includes(gone), gone)
    for (const gone of ['TAB_MAKE_MAIN', 'TAB_MADE_MAIN', 'NEW_IN_TAB', 'TAB_UNREAD']) assert.equal((copy as Record<string, unknown>)[gone], undefined, gone)
    assert.match(owner, /const items = box\.rows\(folder\)\n/)
    assert.match(owner, /const counts = box\.counts\(\)\n/)
    assert.match(owner, /const count = box\.received \+ box\.overflow\n/)
    // Each tab with its marker, so the markers in the list are known on sight.
    assert.match(owner, /for \(const tab of \$\('ib-tabs'\)\.querySelectorAll<HTMLElement>\('\[role="tab"\]'\)\) tab\.prepend\(markIcon\(tab\.dataset\.qs === 'true'\)\)/)
    assert.match(create, /for \(const tab of \$\('ni-tabs'\)\.querySelectorAll<HTMLElement>\('\[role="tab"\]'\)\) tab\.prepend\(markIcon\(tab\.dataset\.qs === 'true'\)\)/)
    // One name each, on every screen: "Secure" and "Quantum-safe", without "inbox" (it's one inbox).
    for (const name of ['TAB_SECURE', 'TAB_QS']) assert.equal(html.match(new RegExp(`<span class="addr-tab-name" data-copy="${name}"></span></button>`, 'g'))?.length, 2, name)
    assert.ok(!/tab-long|tab-short|_SHORT"/.test(html + read('../src/style.css')))
  })

  test('Share opens on the address shared last: at first the one chosen as it was made, then the tab last picked, kept with the inbox', () => {
    assert.match(owner, /const sharedAddress = \(\) => \(info \? \(box\.sharesQs \? info\.address4 : info\.address\) : undefined\)/)
    assert.match(owner, /wireTabs\(\$\('ib-tabs'\), \(tab\) => \{\n {4}const qs = tab\.dataset\.qs === 'true'\n {4}if \(qs === box\.sharesQs\) return\n {4}box\.sharesQs = qs\n {4}changed\(\)\n {4}renderShareTabs\(\)\n {4}void fillShare\(\)/)
    assert.match(owner, /renderShareTabs\(\)\n {4}await fillShare\(\)/)
    // The ready screen's tab left selected seeds it.
    assert.match(create, /if \(words\) deps\.openInbox\(words, name, remember, password, qs\)/)
    assert.match(read('../src/main.ts'), /\.open\(words, \{ label, keep: remember, remember, password, qs \}\)/)
    assert.match(owner, /if \(opts\.qs !== undefined && box\.sharesQs !== opts\.qs\) \{\n {6}box\.sharesQs = opts\.qs\n {6}changed\(\)\n {4}\}/)
  })

  test('a reply that can only go to a secure address says so in the chat; letting a quantum-safe inbox reply needs no warning', () => {
    assert.match(html, /<p class="chat-room" id="ib-c-not-qs" data-copy="CHAT_NOT_QS" hidden><\/p>/)
    // Only in a conversation marked quantum-safe, with neither their quantum-safe address nor reply keys from them: one from before reply keys.
    assert.match(owner, /\$\('ib-c-not-qs'\)\.hidden = !\(chatWith && box\.threadQs\(chatWith\) && !isQuantumSafe\(chatWith\) && !box\.hasReplyKeys\(chatWith\)\)/)
    assert.match(copy.CHAT_NOT_QS, /not quantum-safe/)
    // Their replies come quantum-safe now, sealed with this inbox's reply keys.
    assert.ok(!html.includes('include-not-qs') && !read('../src/main.ts').includes('include-not-qs'))
    assert.equal((copy as Record<string, unknown>).INCLUDE_NOT_QS, undefined)
  })

  test('one explainer, from the ready screen, the (i) beside the tabs, a marker’s note and a sender’s card', () => {
    assert.match(html, /<dialog id="qs-why" class="sheet" aria-labelledby="qs-why-title">/)
    assert.deepEqual(html.match(/data-qs-why="(ready|inbox|sender)"/g), ['data-qs-why="inbox"', 'data-qs-why="sender"', 'data-qs-why="inbox"', 'data-qs-why="ready"'])
    assert.match(html, /<a href="\/about\/#inbox-quantum" target="_blank" rel="noopener" data-copy="COMPARE_MORE"><\/a>/)
    assert.match(read('../about/index.html'), /<details id="inbox-quantum">\s*<summary>What’s a quantum-safe inbox\?<\/summary>/)
    // From a sender's card, a short one: what it is, and (2026-10-19) that a
    // first or anonymous message is slower for a little privacy; the honest line is in the full explainer.
    const sender = read('../src/inbox/qsWhy.ts')
    assert.match(sender, /parts\.push\(\.\.\.\(from === 'sender' \? copy\.QS_SHORT : copy\.QS_WHY\)\.map\(p\)\)/)
    assert.equal(copy.QS_SHORT.length, 2)
    assert.match(copy.QS_SHORT[0], /quantum computers of the future/)
    assert.equal(copy.QS_SHORT[1], 'Sending can take a little longer when you write to them for the first time, or anonymously: that adds a little more privacy.')
    assert.match(copy.QS_WHY[3], /so the way they’re sent could stand out\. Senders can safeguard their network privacy further, for example by using a VPN\./)
    // Opened from elements made later too (a marker's note): one listener for the whole page.
    const why = read('../src/inbox/qsWhy.ts')
    assert.match(why, /document\.addEventListener\('click', \(e\) => \{\n {4}const b = \(e\.target as Element \| null\)\?\.closest\?\.<HTMLElement>\('\[data-qs-why\]'\)\n {4}if \(b\) openQsWhy\(b\.dataset\.qsWhy as From\)/)
    assert.match(read('../src/inbox/marker.ts'), /more\.dataset\.qsWhy = from/)
  })
})

describe('the wording', () => {
  const all = [...copy.QS_WHY, ...copy.TABS_WHY].join(' ')

  test('says why it exists, what it costs, and the honest line, plainly', () => {
    assert.match(all, /quantum computer/)
    assert.match(all, /even on messages someone copied years before/)
    assert.match(all, /most extreme circumstances/)
    assert.match(all, /same passphrase/)
    assert.match(all, /longer link and a more detailed QR code/)
    // The honest line in plain words; the About page says who could see what.
    assert.match(all, /Not many people send quantum-safe messages yet, so the way they’re sent could stand out/)
    assert.match(all, /intentionally slower to send/)
    assert.match(all, /VPN/)
    assert.ok(!/two pieces/.test(all), 'no mechanics on screen')
    // Replies in a quantum-safe conversation are quantum-safe too.
    assert.ok(!/still go to the secure address/.test(all + read('../about/index.html')))
    // One inbox, two addresses: never two inboxes, and the markers named as they show.
    assert.match(all, /People can write to either at any time, and every message comes to this one inbox, marked with a padlock \(secure\) or an atom \(quantum-safe\)\. Replies in a quantum-safe conversation are quantum-safe too\./)
    assert.equal(copy.TABS_TITLE, 'Your inbox’s two addresses')
    assert.ok(!/two inboxes|tab/i.test([copy.TABS_TITLE, copy.TABS_WHAT, ...copy.TABS_WHY].join(' ')))
    // Slynk never speaks as "we", on screens or the About page.
    assert.match(all, /No other app on the xx network is known to have an address like this: one you can share openly/)
    assert.match(read('../about/index.html').replace(/\s+/g, ' '), /As far as Slynk knows, no other app on the xx network has an address like this: one you can share openly/)
    assert.ok(!/known to offer this/.test(all + read('../about/index.html')))
    assert.ok(!/quantum-proof|unbreakable|guarantee/i.test(all + read('../about/index.html')))
  })

  test('the About answer says the same, with the link’s length as built and why cover messages don’t help', () => {
    const about = read('../about/index.html').replace(/\s+/g, ' ')
    assert.match(about, /may be able to tell which internet address sent a message to that inbox/)
    // Two pieces a few seconds apart, always (2026-10-19): what that hides and what it doesn't.
    assert.match(about, /Until the first reply, and always for anonymous messages, a message to it travels as two pieces, sent a few seconds apart, each in a round of its own, so it takes a little longer\./)
    assert.match(about, /someone watching the inbox could notice two messages arriving close together\. Cover messages don’t help here, as they’re single pieces; a VPN keeps your internet address from them\./)
    assert.match(about, /every message comes to the same inbox, marked with a padlock \(secure\) or an atom \(quantum-safe\)\. Share, in the inbox, gives either address\./)
    assert.ok(!/under its own tab|the tab of its latest/.test(about))
    assert.match(about, /about 1,700 characters as a link/)
    // Replies: quantum-safe, and single pieces from the first reply on.
    assert.match(about, /Replies are quantum-safe too\. When someone writes to the quantum-safe address and lets the owner reply, their message also carries a reply key/)
    assert.match(about, /From the first reply on, each message in the conversation travels as a single piece, like any other\./)
    // Hedged as the rest is ("built to hold"): RFC 9180 says PSK mode's quantum resistance isn't proven.
    assert.match(about, /so they’re built to stay closed even to someone who could break the usual lock/)
    assert.match(about, /the reply keys their quantum-safe messages carried, so your replies stay quantum-safe/)
    // 1,708 characters after slynk.me's 18.
    assert.equal('https://slynk.me/#'.length + toBase64url(address4(1)).length, 1726)
  })

  test('the facts while it sends are true for each kind', () => {
    assert.ok(INBOX_FACTS.some((f) => /single piece/.test(f)))
    assert.ok(!INBOX_FACTS_QS.some((f) => /single piece/.test(f)))
    assert.ok(INBOX_FACTS_QS.some((f) => /two pieces a few seconds apart/.test(f)))
  })

  test('short on the tabs, and no "inbox" on them (one inbox, two addresses)', () => {
    assert.equal(copy.TAB_SECURE, 'Secure')
    assert.equal(copy.TAB_QS, 'Quantum-safe')
    for (const gone of ['TAB_SECURE_SHORT', 'TAB_QS_SHORT']) assert.equal((copy as Record<string, unknown>)[gone], undefined, gone)
  })
})
