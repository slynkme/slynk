// Quantum-safe replies between inboxes: a quantum-safe
// message including its sender's inbox gives the owner that inbox's reply
// keys, and replies sealed with them are quantum-safe too, in one message.
// The core seals and opens (core/transfer/reply.go); the page holds each
// sender's keys, keeps them with a kept inbox, passes them back to send, and
// reckons each kind of message's room. Run: npm --prefix web test
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import {
  FROM_OVERHEAD,
  INBOX_ADDRESS4_LENGTH,
  INBOX_ADDRESS4_VERSION,
  NOTICE_TEXT_MAX,
  NOTICE_TEXT_MAX_QS,
  NOTICE_TEXT_MAX_REPLY,
  REPLY_KEYS_LENGTH,
  compactAddress,
  textRoom,
} from '../src/inbox/address.ts'
import { NOTICE_TEXT } from '../src/inbox/drop.ts'
import { INBOX, Mailbox, hex, type Found } from '../src/inbox/mailbox.ts'
import { INBOX_FACTS, INBOX_FACTS_QS, INBOX_FACTS_REPLY } from '../src/ui/facts.ts'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

const id = (n: number) => n.toString(16).padStart(32, '0')
/** A compact address: version 3, then 32 bytes. */
function address(seed: number): Uint8Array {
  const a = new Uint8Array(33).fill(seed)
  a[0] = 3
  return a
}
/** A quantum-safe address of the same inbox, but for its keys. */
function address4(seed: number): Uint8Array {
  const a = Uint8Array.from({ length: INBOX_ADDRESS4_LENGTH }, (_, i) => (i * 131 + seed * 17) % 256)
  a.set(address(seed).subarray(1), 1)
  a[0] = INBOX_ADDRESS4_VERSION
  return a
}
const SAM = address(1)
const ALEX = address(2)
const keysOf = (seed: number) => new Uint8Array(REPLY_KEYS_LENGTH).fill(seed)
let clock = Date.UTC(2026, 9, 18, 12)
function msg(n: number, from?: Uint8Array, opts: { qs?: boolean; keys?: Uint8Array; at?: number } = {}): Found {
  const at = opts.at ?? (clock += 60_000)
  return {
    id: id(n),
    kind: NOTICE_TEXT,
    body: new TextEncoder().encode(`message ${n}`),
    at,
    quantumSafe: !!opts.qs,
    ...(from ? { from, fromName: '' } : {}),
    ...(opts.keys ? { replyKeys: opts.keys } : {}),
  }
}
const kept = (box: Mailbox) => Mailbox.fromKept(JSON.parse(JSON.stringify(box.toKept())), false)
/** The buffer the mailbox itself holds for an inbox's keys (private: only to see it wiped). */
const inner = (box: Mailbox, address: Uint8Array) => (box as unknown as { replyKeyMap: Map<string, { keys: Uint8Array }> }).replyKeyMap.get(hex(address))?.keys

describe('room', () => {
  test('the sizes are the core’s', () => {
    const reply = read('../../core/transfer/reply.go')
    assert.match(reply, /ReplyTokenLen = 8\n\tReplyKeyLen {3}= 32/)
    assert.match(reply, /replyOverhead = keyRepLen \+ ReplyTokenLen \+ 16/)
    assert.equal(REPLY_KEYS_LENGTH, 8 + 32)
    // One cMix message and its spare fields, less the one-time key, the hidden token, the AEAD's tag and the header.
    assert.equal(NOTICE_TEXT_MAX_REPLY, 926 + 62 - (32 + 8 + 16) - 16)
  })

  test('each kind of message’s room, with and without the sender’s inbox, as the core reckons it', () => {
    // TestReplySizes in core/transfer/reply_test.go has the same numbers.
    assert.equal(textRoom(SAM), NOTICE_TEXT_MAX)
    assert.equal(textRoom(address4(1)), NOTICE_TEXT_MAX_QS)
    assert.equal(textRoom(SAM, { nameBytes: 0 }), 924 - 66)
    assert.equal(textRoom(address4(1), { nameBytes: 0 }), 652 - 66 - 40)
    assert.equal(textRoom(SAM, { nameBytes: 0, reply: true }), 916 - 66 - 40)
    // A reply goes to their compact address, whichever address the owner has.
    assert.equal(textRoom(address4(1), { nameBytes: 3, reply: true }), 916 - FROM_OVERHEAD - REPLY_KEYS_LENGTH - 3)
    assert.equal(textRoom(SAM, { nameBytes: 5 }), 924 - FROM_OVERHEAD - 5)
  })
})

describe('reply keys in the mailbox', () => {
  test('a quantum-safe message’s sender gives them; they’re held by their inbox, as a copy', () => {
    const box = new Mailbox()
    const given = keysOf(9)
    assert.equal(box.add(msg(1, SAM, { qs: true, keys: given }), false), 'added')
    assert.deepEqual(box.replyKeysFor(SAM), keysOf(9))
    // Either address of theirs finds them.
    assert.deepEqual(box.replyKeysFor(address4(1)), keysOf(9))
    assert.deepEqual(box.replyKeysFor(compactAddress(address4(1))), keysOf(9))
    assert.equal(box.replyKeysFor(ALEX), undefined)
    // What the core handed over is wiped: the mailbox has its own copy.
    assert.ok(given.every((b) => b === 0))
    assert.deepEqual(box.replyKeysFor(SAM), keysOf(9))
    // And hands out copies: wiping one, as a send does once it has gone, leaves what's held.
    box.replyKeysFor(SAM)!.fill(0)
    assert.deepEqual(box.replyKeysFor(SAM), keysOf(9))
    assert.ok(box.hasReplyKeys(SAM) && box.hasReplyKeys(address4(1)) && !box.hasReplyKeys(ALEX))
  })

  test('a copy handed out stays whole whatever arrives meanwhile (the reviews’ finding: a file notice went with zeros)', () => {
    const box = new Mailbox()
    box.add(msg(1, SAM, { qs: true, keys: keysOf(5) }), false)
    const taken = box.replyKeysFor(SAM)! // as a reply's delivery takes them, before an upload runs for minutes
    box.add(msg(2, SAM, { qs: true, keys: keysOf(5) }), false) // every quantum-safe message of theirs carries them again
    box.add(msg(3, SAM, { qs: true, keys: keysOf(6) }), false)
    assert.deepEqual(taken, keysOf(5))
    assert.deepEqual(box.replyKeysFor(SAM), keysOf(5))
  })

  test('never from an anonymous message, a wrong size, or a message already here or removed', () => {
    const box = new Mailbox()
    box.add(msg(1, undefined, { qs: true, keys: keysOf(1) }), false)
    box.add(msg(2, ALEX, { qs: true, keys: new Uint8Array(39).fill(2) }), false)
    assert.equal(box.replyKeysFor(ALEX), undefined)
    assert.deepEqual(box.toKept().keys, [], 'nothing held, nothing kept')
    // Nor from a message that didn't come quantum-safe: the core never passes such keys on, and the page holds to that too.
    box.add(msg(5, ALEX, { keys: keysOf(5) }), false)
    assert.equal(box.replyKeysFor(ALEX), undefined)
    assert.equal(box.add(msg(3, SAM, { qs: true }), false), 'added')
    // The same message handed over again, now with keys: not taken.
    assert.equal(box.add(msg(3, SAM, { qs: true, keys: keysOf(3) }), false), 'known')
    assert.equal(box.replyKeysFor(SAM), undefined)
    box.remove(id(3))
    const again = keysOf(4)
    assert.equal(box.add(msg(3, SAM, { qs: true, keys: again }), false), 'removed')
    assert.equal(box.replyKeysFor(SAM), undefined)
    assert.ok(again.every((b) => b === 0), 'wiped all the same')
  })

  test('an inbox gives the same keys every time: different ones later are ignored, the earliest message’s kept', () => {
    const box = new Mailbox()
    box.add(msg(1, SAM, { qs: true, keys: keysOf(1), at: 2000 }), false)
    const held = inner(box, SAM)
    // The same again changes nothing: not even the buffer held.
    box.add(msg(2, SAM, { qs: true, keys: keysOf(1), at: 3000 }), false)
    assert.equal(inner(box, SAM), held)
    // Different ones from a later message (only a forgery or a fault could send them): ignored.
    box.add(msg(3, SAM, { qs: true, keys: keysOf(3), at: 4000 }), false)
    assert.deepEqual(box.replyKeysFor(SAM), keysOf(1))
    // An earlier message the look-back finds afterwards: its keys are the ones kept.
    box.add(msg(4, SAM, { qs: true, keys: keysOf(4), at: 1000 }), false)
    assert.deepEqual(box.replyKeysFor(SAM), keysOf(4))
    // The same keys from a still earlier message: the buffer stays, and they count from then.
    const now = inner(box, SAM)
    box.add(msg(5, SAM, { qs: true, keys: keysOf(4), at: 500 }), false)
    assert.equal(inner(box, SAM), now)
    assert.equal(box.toKept().keys?.[0][2], 500)
  })

  test('removing the conversation drops them; Lock wipes them', () => {
    const box = new Mailbox()
    box.add(msg(1, SAM, { qs: true, keys: keysOf(1) }), false)
    box.add(msg(2, ALEX, { qs: true, keys: keysOf(2) }), false)
    const held = inner(box, SAM)!
    assert.ok(box.removeThread(SAM))
    assert.equal(box.replyKeysFor(SAM), undefined)
    assert.ok(held.every((b) => b === 0), 'wiped')
    const alex = inner(box, ALEX)!
    box.wipeAll()
    assert.equal(box.replyKeysFor(ALEX), undefined)
    assert.ok(alex.every((b) => b === 0))
  })

  test('a removed conversation’s keys stay removed when another record of the inbox comes in, either way; a later message brings them back', () => {
    const now = Date.now()
    const a = new Mailbox()
    a.add(msg(1, SAM, { qs: true, keys: keysOf(1), at: now - 60_000 }), false)
    const stale = kept(a) // another tab's record, from before the removal
    a.removeThread(SAM)
    // The record from before comes in here: the keys don't come back.
    a.merge(stale)
    assert.equal(a.replyKeysFor(SAM), undefined)
    // This record, with its removal, goes into the one from before: the keys go there too.
    stale.merge(kept(a))
    assert.equal(stale.replyKeysFor(SAM), undefined)
    // Kept and opened again: still gone.
    assert.equal(kept(a).replyKeysFor(SAM), undefined)
    // A new message of theirs, after the removal, gives them again.
    a.add(msg(2, SAM, { qs: true, keys: keysOf(1), at: now + 60_000 }), false)
    assert.deepEqual(a.replyKeysFor(SAM), keysOf(1))
    assert.deepEqual(kept(a).replyKeysFor(SAM), keysOf(1))
  })

  test('kept with the inbox, sealed with the rest; anything malformed is skipped', () => {
    const box = new Mailbox()
    box.add(msg(1, SAM, { qs: true, keys: keysOf(1), at: 5000 }), false)
    const back = kept(box)
    assert.deepEqual(back.replyKeysFor(SAM), keysOf(1))
    const data = box.toKept()
    assert.deepEqual(data.keys?.[0][2], 5000)
    const odd = {
      ...data,
      keys: [
        [data.keys![0][0], data.keys![0][1].slice(0, 20), 1], // cut short
        ['not an address', data.keys![0][1], 1],
        [data.keys![0][0], data.keys![0][1]], // no time
        'nonsense',
      ],
    }
    assert.equal(Mailbox.fromKept(odd, false).replyKeysFor(SAM), undefined)
    // A record from before reply keys has none, and opens.
    const { keys: _gone, ...old } = data
    void _gone
    assert.equal(Mailbox.fromKept(old, false).replyKeysFor(SAM), undefined)
    assert.equal(Mailbox.fromKept(old, false).size, 1)
  })

  test('two records of one inbox together hold the keys either had, the earliest message’s where they differ', () => {
    const a = new Mailbox()
    const b = new Mailbox()
    a.add(msg(1, SAM, { qs: true, keys: keysOf(1), at: 1000 }), false)
    b.add(msg(2, SAM, { qs: true, keys: keysOf(2), at: 2000 }), false)
    b.add(msg(3, ALEX, { qs: true, keys: keysOf(3), at: 1500 }), false)
    a.merge(kept(b))
    assert.deepEqual(a.replyKeysFor(SAM), keysOf(1))
    assert.deepEqual(a.replyKeysFor(ALEX), keysOf(3))
  })
})

describe('the conversation’s marker', () => {
  const rowQs = (box: Mailbox, a: Uint8Array) => box.rows(INBOX).some((r) => r.kind === 'thread' && r.key === hex(compactAddress(a)) && r.qs)

  test('a reply that came quantum-safe keeps a quantum-safe conversation marked so', () => {
    const box = new Mailbox()
    box.add(msg(1, SAM, { qs: true, keys: keysOf(1) }), false)
    const x = box.addSent(SAM, new TextEncoder().encode('answer'), '')
    box.sentDone(x.id, Date.now(), true)
    // Their next message, a reply sealed with this inbox's keys: quantum-safe, to the compact address.
    box.add(msg(2, SAM, { qs: true, keys: keysOf(1) }), false)
    assert.equal(box.threadQs(SAM), true)
    assert.equal(rowQs(box, SAM), true)
    assert.equal(box.rows(INBOX).length, 1, 'one list')
  })

  test('with nothing from them yet, as the owner’s newest message went: quantum-safe to a quantum-safe address', () => {
    const box = new Mailbox()
    const q = box.addSent(address4(1), new TextEncoder().encode('to their quantum-safe address'), '')
    box.sentDone(q.id, Date.now(), true)
    assert.equal(box.threadQs(SAM), true)
    assert.equal(rowQs(box, SAM), true)
    const c = box.addSent(ALEX, new TextEncoder().encode('to their secure address'), '')
    box.sentDone(c.id, Date.now(), false)
    assert.equal(box.threadQs(ALEX), false)
    assert.equal(rowQs(box, ALEX), false)
    // Kept: which way the owner's messages went.
    assert.equal(kept(box).threadQs(SAM), true)
    assert.equal(kept(box).threadQs(ALEX), false)
    // Their first reply, the standard way, decides from then on.
    box.add(msg(9, SAM), false)
    assert.equal(box.threadQs(SAM), false)
  })

  test('a message still on its way, or that failed, doesn’t change the mark once one has gone (the reviews’ finding); before that, it gives it', () => {
    const box = new Mailbox()
    const q = box.addSent(address4(1), new TextEncoder().encode('first, quantum-safe'), '', undefined, 1000)
    assert.equal(box.threadQs(SAM), true, 'nothing has gone: as it’s going')
    box.sentDone(q.id, 1000, true)
    const next = box.addSent(SAM, new TextEncoder().encode('second, the standard way, on its way'), '', undefined, 2000)
    assert.equal(box.threadQs(SAM), true, 'while it sends')
    assert.equal(rowQs(box, SAM), true)
    box.sentFailed(next.id)
    assert.equal(box.threadQs(SAM), true, 'after it failed')
    assert.equal(rowQs(box, SAM), true)
    // Nothing gone yet, to a compact address: a padlock.
    const a = box.addSent(ALEX, new TextEncoder().encode('to Alex'), '', undefined, 3000)
    assert.equal(box.threadQs(ALEX), false)
    box.sentFailed(a.id)
    assert.equal(rowQs(box, ALEX), false)
  })

  test('a message kept from before reply keys went quantum-safe if it went to a quantum-safe address, as every one there did', () => {
    const box = new Mailbox()
    const x = box.addSent(address4(1), new TextEncoder().encode('8j, to their quantum-safe address'), '')
    box.sentDone(x.id, Date.now())
    const y = box.addSent(ALEX, new TextEncoder().encode('8j, to their secure address'), '')
    box.sentDone(y.id, Date.now())
    const data = box.toKept()
    assert.equal(data.sent?.[0].qs, undefined, 'no flag kept')
    assert.equal(kept(box).threadQs(SAM), true)
    assert.equal(kept(box).threadQs(ALEX), false)
  })
})

describe('the page and the bridge', () => {
  const owner = read('../src/inbox/owner.ts')
  const main = read('../src/main.ts')
  const worker = read('../src/core/worker.ts')
  const bridge = read('../../core/cmd/wasm/inbox.go')

  test('a reply goes with a copy of the keys they gave, unless it no longer fits with them; its quantum-safety is noted', () => {
    assert.match(owner, /let keys = box\.replyKeysFor\(x\.address\)\n {6}if \(keys && x\.upload === undefined && !fits\(text, textRoom\(x\.address, \{ nameBytes: textBytes\(x\.name\), reply: true \}\)\)\) \{\n {8}keys\.fill\(0\)\n {8}keys = undefined/)
    assert.match(owner, /: await deps\.sendReply\(x\.address, text, x\.name, keys, \(stage\) => stages\.set\(id, stage\)\)/)
    assert.match(owner, /box\.sentDone\(id, at, !!keys \|\| isQuantumSafe\(x\.address\)\)/)
    // The copy is wiped only once everything, a file's notice included, has gone.
    assert.match(owner, /\} finally \{\n {8}keys\?\.fill\(0\)\n {8}stages\.delete\(id\)/)
    // From the composer: a quantum-safe address, or a reply sealed with their keys, carried this inbox's keys.
    assert.match(owner, /box\.sentDone\(x\.id, at, reply \|\| isQuantumSafe\(address\)\)/)
  })

  test('the bridge refuses keys without the inbox before connecting anything', () => {
    assert.match(bridge, /if reply != nil && from == nil \{\n\t\t\treturn nil, transfer\.ErrReplyKeys \/\/ before connecting anything/)
    assert.match(bridge, /if reply != nil && from == nil \{\n\t\t\treturn nil, transfer\.ErrReplyKeys \/\/ now, rather than after minutes of waiting/)
  })

  test('the worker hands the keys to the core in their place, and only with the inbox included', () => {
    assert.match(worker, /req\.compressed, req\.include\?\.replyKeys \?\? null, true\)/)
    assert.match(worker, /!!req\.include, req\.include\?\.name \?\? '', req\.include\?\.replyKeys \?\? null, true\)/)
    assert.match(bridge, /reply, replyErr := replyArg\(args, 8\)/)
    assert.match(bridge, /reply, replyErr := replyArg\(args, 6\)/)
    // The core refuses reply keys without the sender's inbox (newNoticeSealer, ErrReplyKeys).
    assert.match(read('../../core/transfer/inbox.go'), /if mode == modeReply && from == nil \{\n\t\treturn nil, ErrReplyKeys/)
    // And the notice event carries the sender's keys.
    assert.match(bridge, /notice\["replyKeys"\] = bytesToJS\(n\.ReplyKeys\.Bytes\(\)\)/)
  })

  test('the composer seals with their keys too, when it includes the inbox: a conversation that began quantum-safe stays so however it’s reached (the reviews’ finding)', () => {
    const send = main.slice(main.indexOf('async function sendToInbox()'), main.indexOf('/** The Delivered screen'))
    assert.match(send, /const replyKeys = including\(\) \? owner\.replyKeysFor\(to\.address\) : undefined/)
    assert.match(send, /const apart = isQuantumSafe\(to\.address\) && !replyKeys\n/)
    assert.match(send, /startProgress\('Sending', next, replyKeys \? INBOX_FACTS_REPLY : apart \? INBOX_FACTS_QS : INBOX_FACTS\)/)
    assert.match(send, /\} finally \{\n {4}replyKeys\?\.fill\(0\) \/\/ the worker has its own copy/)
    // The room and the size line follow: one piece, a reply's room.
    assert.match(main, /const replyWithKeys = \(\) => including\(\) && !!owner\?\.hasReplyKeys\(addressed!\.address\)/)
    assert.match(main, /const two = isQuantumSafe\(addressed\.address\) && !replyWithKeys\(\)/)
    // An upload's notice from the composer (INBOX_FILES) looks them up as it goes.
    const announce = main.slice(main.indexOf('async function announceUpload('), main.indexOf('async function announceUpload(') + 2500)
    assert.match(announce, /const replyKeys = p\.include \? owner\.replyKeysFor\(p\.to\.address\) : undefined/)
    assert.match(announce, /p\.include && \{ \.\.\.p\.include, \.\.\.\(replyKeys \? \{ replyKeys \} : \{\}\) \}/)
  })

  test('the facts while a reply sealed with keys goes: quantum-safe, and a single piece', () => {
    assert.equal(INBOX_FACTS_REPLY[0], INBOX_FACTS_QS[0])
    assert.equal(INBOX_FACTS_REPLY[1], INBOX_FACTS[1])
    assert.match(INBOX_FACTS_REPLY[1], /single piece/)
    assert.ok(!INBOX_FACTS_REPLY.some((f) => /two pieces/.test(f)))
  })
})
