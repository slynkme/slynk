// Replies between inboxes: a sender with their own inbox
// open may include it, proved deniably by the core; the owner's page tells
// senders apart by their inbox, never by a name, and warns about names that
// change or look alike. Run: npm --prefix web test
import assert from 'node:assert/strict'
import { createHash, createHmac, createPrivateKey, createPublicKey, diffieHellman, hkdfSync } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { FROM_OVERHEAD, NOTICE_TEXT_MAX, NOTICE_TEXT_MAX_QS } from '../src/inbox/address.ts'
import { NOTICE_TEXT } from '../src/inbox/drop.ts'
import * as copy from '../src/inbox/inboxCopy.ts'
import { LOOKALIKES } from '../src/inbox/lookalikes.ts'
import { MAX_BOOK, MAX_HELD, MAX_SENDERS, Mailbox, type MailItem } from '../src/inbox/mailbox.ts'
import { MAX_GIVEN_NAME, MAX_GIVEN_NAME_BYTES, cleanGivenName, looksSame, nameKeys } from '../src/inbox/names.ts'
import { seenOn } from './helpers/pages.ts'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const C = (...cps: number[]) => String.fromCodePoint(...cps)
const shown = (parts: copy.Part[]) => parts.map((p) => (typeof p === 'string' ? p : p.name)).join('')

describe('the proof, worked out again with Node’s crypto', () => {
  // From the words to the keys, as core/transfer/inbox.go does it: the
  // golden inbox ("abandon" x11, "about") has 16 zero bytes of entropy, and
  // the core's testKey(2) sixteen 2s.
  const keys = (entropy: Buffer) => {
    const seed = Buffer.from(hkdfSync('sha256', entropy, Buffer.alloc(0), 'slynk/inbox/v1/ed25519', 32))
    const ed = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' })
    const pub = Buffer.from(createPublicKey(ed).export({ format: 'jwk' }).x!, 'base64url')
    // The X25519 key is the hashed seed's first half, which X25519 clamps.
    const scalar = createHash('sha512').update(seed).digest().subarray(0, 32)
    const x = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), scalar]), format: 'der', type: 'pkcs8' })
    return { pub, x, xpub: createPublicKey(x) }
  }
  const a = keys(Buffer.alloc(16, 0))
  const b = keys(Buffer.alloc(16, 2))
  const gold = (name: string) => read('../../core/transfer/inbox_from_test.go').match(new RegExp(`const ${name} = "([0-9a-f]{64})"`))![1]

  test('the same inboxes, the same proof key and the same proof as the core', () => {
    // The golden address, as core/transfer/inbox_test.go pins it.
    assert.equal('03' + a.pub.toString('hex'), '03398330eaeb0a19e6abcfe411c31a0f2c3ef90a5b3cb7511a67177161bd919955')
    const shared = diffieHellman({ privateKey: a.x, publicKey: b.xpub })
    const info = Buffer.concat([Buffer.from('slynk/inbox/v1/from'), a.pub, b.pub])
    const key = Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(0), info, 32))
    assert.equal(key.toString('hex'), gold('goldenKeyHex'))
    const pt = Buffer.from(Array.from({ length: 64 }, (_, i) => i))
    const proof = createHmac('sha256', key).update(Buffer.alloc(32, 0x11)).update(pt.subarray(0, 20)).update(pt.subarray(52, 60)).digest('hex')
    assert.equal(proof, gold('goldenProof'))
  })

  test('only the two inboxes can make it, and the recipient could have made it: it proves nothing to anyone else', () => {
    const bySender = diffieHellman({ privateKey: a.x, publicKey: b.xpub })
    const byRecipient = diffieHellman({ privateKey: b.x, publicKey: a.xpub })
    assert.deepEqual(bySender, byRecipient)
    const c = keys(Buffer.alloc(16, 3))
    assert.notDeepEqual(diffieHellman({ privateKey: c.x, publicKey: b.xpub }), bySender, 'a third inbox can’t')
  })

  test('the page leaves room for it exactly as the core does', () => {
    // core FromOverhead(0): the address, the name's length and the 32-byte proof.
    assert.equal(FROM_OVERHEAD, 66)
    assert.match(read('../../core/transfer/inbox_from_test.go'), /if got := FromOverhead\(0\); got != 66/)
    assert.equal(MAX_GIVEN_NAME_BYTES, Number(read('../../core/transfer/inbox.go').match(/MaxFromName\s+= (\d+)/)![1]))
    assert.equal(NOTICE_TEXT_MAX - FROM_OVERHEAD, 858)
    assert.equal(NOTICE_TEXT_MAX_QS - FROM_OVERHEAD, 586)
  })
})

describe('names people give themselves', () => {
  test('are cleaned before they’re sent or shown: nothing invisible, nothing that reorders text', () => {
    assert.equal(cleanGivenName('  Sam  '), 'Sam')
    assert.equal(cleanGivenName(`Sa${C(0x200b)}m`), 'Sam', 'a zero-width space goes')
    assert.equal(cleanGivenName(`${C(0x202e)}maS`), 'maS', 'a right-to-left override goes')
    assert.equal(cleanGivenName(`Sam${C(0x2066)}x${C(0x2069)}`), 'Samx')
    assert.equal(cleanGivenName('Sam\nfrom\tnights'), 'Sam from nights')
    assert.equal(cleanGivenName(`${C(0xe0041)}Sam`), 'Sam', 'tag characters go')
    assert.equal(cleanGivenName(C(0xff33, 0xff21, 0xff2d)), 'SAM', 'NFKC: full-width letters')
    // Emoji and scripts that need the joiners keep them.
    assert.equal(cleanGivenName(`${C(0x1f469, 0x200d, 0x1f4bb)}`), C(0x1f469, 0x200d, 0x1f4bb))
    for (const blank of ['', '   ', C(0x3164), C(0x2800), C(0x115f, 0x1160), C(0x200b, 0x200b), '...', C(0x0301, 0x0301)]) assert.equal(cleanGivenName(blank), '', JSON.stringify(blank))
  })

  test('have a length limit, in characters and in bytes, and at most two marks on a letter', () => {
    assert.equal([...cleanGivenName('x'.repeat(100))].length, MAX_GIVEN_NAME)
    assert.ok(new TextEncoder().encode(cleanGivenName(C(0x4e2d, 0x301, 0x302).repeat(60))).length <= MAX_GIVEN_NAME_BYTES)
    assert.ok(new TextEncoder().encode(cleanGivenName(C(0x1f600).repeat(60))).length <= MAX_GIVEN_NAME_BYTES)
    assert.equal(cleanGivenName(`a${C(0x301).repeat(9)}`).normalize('NFD').length, 3, 'a letter and two marks')
  })

  test('look the same once case, spaces, punctuation, accents and look-alike letters are folded', () => {
    const cyrillic = C(0x0405, 0x0430) + 'm' // Ѕаm
    const greek = 'S' + C(0x03b1) + 'm' // Sαm
    for (const [x, y] of [
      ['Sam', 'sam'],
      ['Sam', 'SAM'],
      ['Sam', 'S a m'],
      ['Sam', 'Sam.'],
      ['Sam', 'Sàm'],
      ['Sam', cyrillic],
      ['Sam', greek],
      ['Sam', 'Sarn'],
      ['Ian', 'lan'],
      ['Ian', 'ian'],
      ['0scar', 'Oscar'],
      ['Advice line', 'ADVICE-LINE'],
    ]) assert.ok(looksSame(x, y), `${x} and ${y}`)
    for (const [x, y] of [
      ['Sam', 'Pam'],
      ['Sam', 'Sammy'],
      ['Ann', 'Anna'],
      ['Sam', ''],
      ['', ''],
    ]) assert.ok(!looksSame(x, y), `${x} and ${y}`)
    assert.deepEqual(nameKeys(''), [])
  })

  test('invisible format, private-use and unassigned characters never hide a look-alike (the review)', () => {
    for (const hidden of [0x200c, 0x200d, 0x1d173, 0x13430, 0x1bca0, 0xe000, 0xf0000, 0x2066]) {
      assert.ok(looksSame(`S${C(hidden)}am`, 'Sam'), hidden.toString(16))
    }
    assert.equal(cleanGivenName(`S${C(0xe000)}am`), 'Sam', 'private use goes')
    assert.equal(cleanGivenName(`S${C(0x1d173)}am`), 'Sam', 'format controls go')
    assert.equal(cleanGivenName(`${C(0x200d)}Sam${C(0x200c)}`), 'Sam', 'a joiner with nothing to join goes')
    assert.equal(cleanGivenName(` ${C(0x301)}Sam`), 'Sam', 'a mark on a space goes')
  })

  test('cleaning a name twice changes nothing, so both pages agree (fuzzed)', () => {
    const pool = [0x20, 0x61, 0x62, 0x301, 0x302, 0x200b, 0x200c, 0x200d, 0x202e, 0x3164, 0x1f469, 0xe000, 0x0430, 0x4e2d, 0xad, 0x9, 0xa, 0x115f, 0x1d173, 0x13430, 0xfe0f, 0x2800, 0x0627, 0x0644, 0xfb01, 0x1100, 0x1161]
    let seed = 8
    const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n)
    for (let i = 0; i < 20_000; i++) {
      let raw = ''
      for (let j = rand(14) + 1; j > 0; j--) raw += C(pool[rand(pool.length)])
      const once = cleanGivenName(raw)
      assert.equal(cleanGivenName(once), once, JSON.stringify(raw))
    }
  })

  test('the look-alikes come from Unicode’s own list, and map only to Latin letters and digits', () => {
    const table = read('../src/inbox/lookalikes.ts')
    assert.match(table, /UTS #39, version 17\.0\.0, SHA-256 091c7f82fc39ef208faf8f94d29c244de99254675e09de163160c810d13ef22a/)
    assert.ok(LOOKALIKES.size > 400)
    for (const [from, to] of LOOKALIKES) {
      assert.match(to, /^[A-Za-z0-9]+$/)
      assert.equal(from.normalize('NFKC'), from, 'NFKC comes first, so nothing it changes is needed')
    }
    assert.equal(LOOKALIKES.get(C(0x0430)), 'a')
    assert.equal(LOOKALIKES.get(C(0x03bf)), 'o')
    assert.ok(!/[^\x00-\x7e\n©]/.test(table), 'every other character is written as an escape')
    assert.match(read('../../CREDITS.md'), /Unicode/)
  })
})

describe('who a message is from, on the owner’s side', () => {
  let n = 0
  let clock = Date.UTC(2026, 9, 16, 12)
  const addr = (fill: number) => {
    const a = new Uint8Array(33).fill(fill)
    a[0] = 3
    return a
  }
  const A = addr(0xa1)
  const B = addr(0xb2)
  const D = addr(0xd4)
  function msg(text: string, from?: Uint8Array, name = '', at = (clock += 60_000)) {
    return { id: (++n).toString(16).padStart(32, '0'), kind: NOTICE_TEXT, body: new TextEncoder().encode(text), sent: at, at, quantumSafe: false, ...(from ? { from: from.slice(), fromName: name } : {}) }
  }
  const add = (box: Mailbox, m: ReturnType<typeof msg>) => {
    assert.equal(box.add(m, false), 'added')
    return box.get(m.id)!
  }

  test('anonymous stays anonymous: no sender, no number, no flags', () => {
    const box = new Mailbox()
    const i = add(box, msg('hello'))
    assert.equal(i.from, undefined)
    assert.deepEqual(box.nameFlags(i), {})
  })

  test('senders are told apart by their inbox, never by a name, and numbered in the order first heard from', () => {
    const box = new Mailbox()
    const a1 = add(box, msg('one', A, 'Sam'))
    const b1 = add(box, msg('two', B, 'Sam'))
    const a2 = add(box, msg('three', A))
    add(box, msg('four', D))
    assert.equal(box.sender(A)?.n, 1)
    assert.equal(box.sender(B)?.n, 2)
    assert.equal(box.sender(D)?.n, 3)
    assert.deepEqual(
      box.thread(A).flatMap((e) => (e.kind === 'in' ? [e.item.id] : [])).reverse(),
      [a2.id, a1.id],
    )
    assert.equal(box.thread(B)[0].kind === 'in' && box.thread(B)[0].item, b1)
    assert.equal(a2.from?.name, '', 'what this message carried')
    assert.equal(box.givenName(A), 'Sam', 'their newest name')
    assert.equal(box.givenName(D), '')
  })

  test('the name a message carried is cleaned on arrival', () => {
    const box = new Mailbox()
    const i = add(box, msg('x', A, `  Sa${C(0x202e)}m  `))
    assert.equal(i.from?.name, 'Sam')
    assert.equal(add(box, msg('y', B, 'x'.repeat(100))).from?.name.length, MAX_GIVEN_NAME)
  })

  test('“Now calls themselves Alex (was Sam)”, but not for case or a message with no name', () => {
    const box = new Mailbox()
    const first = add(box, msg('1', A, 'Sam'))
    const same = add(box, msg('2', A, 'SAM'))
    const none = add(box, msg('3', A))
    const alex = add(box, msg('4', A, 'Alex'))
    assert.deepEqual(box.nameFlags(first), {})
    assert.deepEqual(box.nameFlags(same), {})
    assert.deepEqual(box.nameFlags(none), {})
    assert.deepEqual(box.nameFlags(alex), { was: 'SAM' })
    assert.equal(shown(copy.FLAG_WAS('Alex', 'Sam')), 'Now calls themselves Alex (was Sam)')
  })

  test('a name another inbox used first: “Careful” on the newer one, “started using” on the earlier one', () => {
    const box = new Mailbox()
    const earlier = add(box, msg('1', A, 'Sam'))
    const newer = add(box, msg('2', B, C(0x0405, 0x0430) + 'm'))
    const other = add(box, msg('3', D, 'Alex'))
    assert.deepEqual(box.nameFlags(newer), { theirs: 'Sam' })
    assert.deepEqual(box.nameFlags(earlier), { copied: 'Sam' })
    assert.deepEqual(box.nameFlags(other), {})
    // Found out of order (a look-back), it's still who used it first that counts.
    const late = new Mailbox()
    add(late, msg('2', B, 'Sam', Date.UTC(2026, 9, 16, 14)))
    const first = add(late, msg('1', A, 'Sam', Date.UTC(2026, 9, 16, 13)))
    assert.deepEqual(late.nameFlags(first), { copied: 'Sam' })
  })

  test('a name that looks like one the owner gave someone else: the stronger warning', () => {
    const box = new Mailbox()
    add(box, msg('1', A, 'Alex'))
    box.saveContact(A, 'Sam')
    const b = add(box, msg('2', B, 'sam'))
    assert.equal(box.nameFlags(b).yours, 'Sam')
    // The owner's own name for someone is never flagged against itself, even when they use it too.
    const own = add(box, msg('3', A, 'Sam'))
    assert.equal(box.nameFlags(own).yours, undefined)
  })

  test('a sender who takes up someone’s name later is flagged on every message the list shows under it (the review)', () => {
    const box = new Mailbox()
    add(box, msg('1', A, 'Alice'))
    const asBob = add(box, msg('2', B, 'Bob'))
    add(box, msg('3', B, 'Alice'))
    // The list shows B's older message under "Alice", the newest name: that's what's checked too.
    assert.equal(box.givenName(B), 'Alice')
    assert.equal(box.nameFlags(asBob).theirs, 'Alice')
    // "Use this name" goes by the name it would save.
    assert.equal(box.nameClash(B, box.givenName(B)).theirs, 'Alice')
    assert.deepEqual(box.nameClash(A, 'Alice'), { copied: 'Alice' })
  })

  test('when a name was first used comes from the round, never the sender’s own clock', () => {
    const box = new Mailbox()
    add(box, msg('1', A, 'Alice'))
    // Sealed as sent a year ago, with no round time known: it can't claim the name first.
    const backdated = { ...msg('2', B, 'Alice'), at: 0, sent: Date.UTC(2025, 9, 16) }
    const i = add(box, backdated)
    assert.equal(box.nameFlags(i).theirs, 'Alice')
  })

  test('senders are only forgotten once their messages are gone, nameless ones first (the review)', () => {
    assert.ok(MAX_SENDERS >= MAX_HELD + MAX_BOOK, 'every held message and every name in the address book fits')
    const box = new Mailbox()
    const alice = add(box, msg('alice', A, 'Alice'))
    box.remove(alice.id)
    for (let i = 0; i <= MAX_SENDERS; i++) {
      const a = addr(0)
      a.set([1, i >> 8, i & 255], 1)
      box.remove(add(box, msg(`m${i}`, a)).id)
    }
    assert.ok(box.toKept().senders!.length <= MAX_SENDERS)
    assert.ok(box.sender(A), 'a sender who gave a name outlasts nameless ones')
    const mallory = add(box, msg('mallory', B, 'Alice'))
    assert.equal(box.nameFlags(mallory).theirs, 'Alice')
    assert.equal(box.sender(B)?.n !== undefined, true, 'the sender just added is never the one let go')
  })

  test('the name last shown to each inbox the owner writes to is remembered, cleaned', () => {
    const box = new Mailbox()
    assert.equal(box.shownTo(A), '')
    assert.ok(box.setShownTo(A, ' Advice team '))
    assert.equal(box.shownTo(A), 'Advice team')
    assert.ok(!box.setShownTo(A, 'Advice team'), 'no change')
    assert.ok(box.setShownTo(A, ''))
    assert.equal(box.shownTo(A), '')
  })

  test('kept on the device: who each message is from, every sender’s number and names, and the names shown', () => {
    const box = new Mailbox()
    add(box, msg('1', A, 'Sam'))
    add(box, msg('2', B))
    add(box, msg('3', A, 'Alex'))
    box.setShownTo(D, 'Advice team')
    const kept = JSON.parse(JSON.stringify(box.toKept()))
    const back = Mailbox.fromKept(kept, false)
    assert.equal(back.sender(A)?.n, 1)
    assert.equal(back.sender(B)?.n, 2)
    assert.deepEqual(back.sender(A)?.names.map((x) => x.name).sort(), ['Alex', 'Sam'])
    assert.equal(back.givenName(A), 'Alex')
    assert.equal(back.shownTo(D), 'Advice team')
    assert.equal(back.thread(A).length, 2)
    // Numbers stick: someone new is next, whatever came before.
    add(back, msg('4', D))
    assert.equal(back.sender(D)?.n, 3)
    // A record from before replies opens as it always did.
    delete kept.senders
    delete kept.next
    delete kept.shown
    for (const i of kept.items) delete i.from
    const old = Mailbox.fromKept(kept, false)
    assert.equal(old.size, 3)
    assert.equal(old.sender(A), undefined)
  })

  test('anything malformed in what was kept is skipped, not trusted', () => {
    const box = new Mailbox()
    add(box, msg('1', A, 'Sam'))
    const kept = JSON.parse(JSON.stringify(box.toKept()))
    kept.senders.push(
      { address: 'not base64!', n: 9, names: [] },
      { address: Buffer.from(new Uint8Array(33)).toString('base64url'), n: 10, names: [] }, // not an address's version
      { address: Buffer.from(B).toString('base64url'), n: 1, names: [[C(0x202e) + 'x', 0, 0], ['ok', 'no', 1], 'junk'] }, // a number already taken
    )
    kept.shown = [['zz', 'x'], [Buffer.from(D).toString('base64url'), '   ']]
    kept.items[0].from.name = `S${C(0x200b)}am`
    const back = Mailbox.fromKept(kept, false)
    assert.equal(back.sender(A)?.n, 1)
    assert.equal(back.sender(B)?.n, 2, 'a number already taken gets the next one')
    assert.deepEqual(back.sender(B)?.names.map((x) => x.name), ['x'], 'cleaned, and only well-formed ones')
    assert.equal(back.shownTo(D), '')
    assert.equal(back.all()[0].from?.name, 'Sam')
  })

  test('two tabs’ records merge: senders keep their names, new ones get the next numbers', () => {
    const one = new Mailbox()
    add(one, msg('1', A, 'Sam'))
    const two = new Mailbox()
    add(two, msg('2', B, 'Alex'))
    add(two, msg('3', A, 'Sammy'))
    two.setShownTo(D, 'Advice team')
    one.merge(two)
    assert.equal(one.sender(A)?.n, 1)
    assert.equal(one.sender(B)?.n, 2)
    assert.deepEqual(one.sender(A)?.names.map((x) => x.name).sort(), ['Sam', 'Sammy'])
    assert.equal(one.shownTo(D), 'Advice team')
    assert.equal(one.thread(A).length, 2)
  })

  test('a flood stays quick when each message is drawn as it arrives (the review)', () => {
    const box = new Mailbox()
    const start = performance.now()
    for (let i = 0; i < MAX_HELD; i++) {
      const a = addr(0)
      a.set([2, (i % 1900) >> 8, (i % 1900) & 255], 1)
      box.nameFlags(add(box, msg(`f${i}`, a, i % 3 ? 'Sam' : C(0x0405, 0x0430) + 'm')))
    }
    for (const i of box.all()) box.nameFlags(i)
    const took = performance.now() - start
    assert.ok(took < 8000, `took ${Math.round(took)} ms`)
  })

  test('a flood of senders stays quick, and senders past the limit with nothing held are let go first', () => {
    const box = new Mailbox()
    const start = performance.now()
    for (let i = 0; i < 3000; i++) {
      const a = addr(0)
      a.set([i >> 8, i & 255], 1)
      box.add(msg(`m${i}`, a, i % 2 ? 'Sam' : `Name ${i}`), false)
    }
    const items: MailItem[] = box.all()
    for (const i of items) box.nameFlags(i)
    assert.ok(performance.now() - start < 5000, `took ${Math.round(performance.now() - start)} ms`)
    for (const i of items.slice(0, 1500)) box.remove(i.id)
    for (let i = 3000; i < 3100; i++) {
      const a = addr(0)
      a.set([i >> 8, i & 255], 1)
      box.add(msg(`m${i}`, a), false)
    }
    assert.ok(box.toKept().senders!.length <= MAX_SENDERS)
  })
})

describe('the composer and the owner’s page', () => {
  const main = read('../src/main.ts')
  const owner = read('../src/inbox/owner.ts')
  const html = read('../index.html')

  test('anonymous stays the default: the switch starts off, and only shows with the writer’s own inbox open', () => {
    assert.match(html, /<input type="checkbox" class="switch" id="include-on" autocomplete="off" \/>/)
    assert.match(main, /return !!addressed && !!owner\?\.isOpen\(\) && !\(own && sameInbox\(addressed\.address, own\)\)/)
    assert.match(main, /if \(!offer\) includeBox\.checked = false/)
    // A new address starts anonymous.
    assert.match(main, /if \(!again\) \{\n    includeBox\.checked = false/)
    assert.match(main, /\$\('reply-hint'\)\.hidden = !addressed \|\| !!owner\?\.isOpen\(\)/)
  })

  test('replies go from the chat, files and longer replies too: never by way of the composer', () => {
    assert.ok(!owner.includes('deps.reply('), 'no hand-off to the front page')
    assert.match(owner, /if \(uploadMode\(\)\) return void sendUpload\(address\)/)
    // The chat's own replies always carry this inbox, from the tab's second identity.
    // With the reply keys they gave, if any.
    assert.match(main, /return await core\.sendNotice\(address, pack\(text\), true, \(stage\) => onStage\(stage\), \{ name, replyKeys \}\)/)
  })

  test('the page asks the core to include its inbox; the key and the words never leave the worker', () => {
    // With the reply keys that inbox gave, if any.
    assert.match(main, /const include = including\(\) \? \{ name: includeAs\(\), \.\.\.\(replyKeys \? \{ replyKeys \} : \{\}\) \} : undefined/)
    // Reply keys travel only with the inbox included: the core refuses them otherwise.
    assert.match(read('../src/core/protocol.ts'), /export interface Include \{\n  name: string\n  replyKeys\?: Uint8Array\n\}/)
    const bridge = read('../../core/cmd/wasm/inbox.go')
    assert.match(bridge, /inboxMu\.Lock\(\)\n\tkey := sessionKey\n\tinboxMu\.Unlock\(\)\n\tif key == nil \{\n\t\treturn nil, errNoInbox\n\t\}/)
    // It waits for the inbox to have opened in the core.
    assert.match(main, /if \(including\(\) && !owner\.canInclude\(\)\) return inboxCopy\.INCLUDE_WAIT/)
    assert.match(owner, /canInclude: \(\) => !!info && !opening && !failed/)
  })

  test('the room left counts the included inbox and its name', () => {
    // Packed (inbox/pack.ts), in the room the address's kind has.
    // And, to a quantum-safe address, this inbox's reply keys: textRoom.
    assert.match(main, /const noticeRoom = \(\) => \(addressed \? textRoom\(addressed\.address, including\(\) \? \{ nameBytes: textBytes\(includeAs\(\)\), reply: replyWithKeys\(\) \} : undefined\) : 0\)/)
    assert.match(main, /if \(!fits\(textBox\.value, noticeRoom\(\)\)\) return inboxCopy\.TO_TOO_LONG/)
  })

  test('naming senders needs the address book; never “Use this name” for a name that looks like someone else’s', () => {
    // The conversation's menu.
    assert.match(owner, /if \(withBook\(\)\) \{\n[^]*?const clash = given \? box\.nameClash\(address, given\) : \{\}\n      if \(!mine && given && !clash\.theirs && !clash\.yours\) items\.push\(\{ label: copy\.READ_USE_NAME_AS\(given\), run: useName \}\)\n      items\.push\(\{ label: mine \? copy\.READ_RENAME : copy\.READ_NAME, run: openNameBox \}\)/)
    assert.match(owner, /const withBook = \(\) => !!info && keeping/)
    assert.equal(copy.READ_USE_NAME_AS('Sam'), `Call them “${C(0x2068)}Sam${C(0x2069)}”`)
  })

  test('Lock waits for an upload’s notice', () => {
    assert.match(owner, /if \(deps\.busy\(\) \|\| deps\.pending\(\) \|\| !!collecting \|\| sendingNow > 0\) return copy\.OWNER_LOCK_BUSY/)
    assert.match(main, /pending: \(\) => !!pendingDrop/)
  })

  test('the bridge sends a message carrying the inbox from the second identity, whatever the page says', () => {
    assert.match(read('../../core/cmd/wasm/inbox.go'), /from, fromErr := fromArgs\(args, 5\)\n[^]*?\tseparate = separate \|\| from != nil/)
  })

  test('names are shown isolated, so they can’t reorder the words around them', () => {
    assert.match(main, /inboxCopy\.TO_SEND\(isolated\(nameFor\(addressed\.address\)\)\)/)
    assert.match(main, /inboxCopy\.DELIVERED_TITLE\(isolated\(nameFor\(to\)\)\)/)
    assert.match(owner, /copy\.BOOK_SAVED\(isolate\(c\.name\)\)/)
    assert.match(read('../src/inbox/dom.ts'), /const b = document\.createElement\('bdi'\)/)
    assert.match(read('../src/style.css'), /\.given-name \{\n  unicode-bidi: isolate;/)
  })
})

describe('the wording for replies', () => {
  test('the switch and its line, as agreed', () => {
    // Not "include my inbox", which reads like attaching what's in it.
    assert.equal(copy.INCLUDE_LABEL, 'Let them reply')
    assert.equal(copy.INCLUDE_HELP, 'They’ll be able to write back to your inbox, and they’ll know your messages come from the same inbox.')
    assert.equal(copy.INCLUDE_NAME_LABEL, 'Name to show them (optional)')
  })

  test('“Sender 1”, “Sender 2”, never a codename; the name they gave, said to be theirs', () => {
    assert.equal(copy.FROM_NUMBER(2), 'Sender 2')
  })

  test('the warnings, as drafted', () => {
    assert.equal(
      shown(copy.FLAG_THEIRS('Sam')),
      'Careful: someone else who writes to you uses the name “Sam” too. This message comes from a different inbox, so it may not be the person you think. Be cautious when dealing with the information.',
    )
    assert.equal(shown(copy.FLAG_YOURS('Sam')), 'You call someone else “Sam”. This is a different inbox: it could be someone pretending to be them.')
    assert.equal(shown(copy.FLAG_COPIED('Sam')), 'Another inbox has started using the name “Sam”.')
    assert.ok(!/what you share/.test(shown(copy.FLAG_THEIRS('Sam'))), 'not “what you share”, which assumes their intent')
  })

  test('the comparison’s Replies rows, and the message encrypted end to end', () => {
    assert.deepEqual(
      copy.COMPARE_OWNER.find(([what]) => what === 'Replies'),
      ['Replies', 'You can reply', 'You can reply, if they have an inbox and let you'],
    )
    assert.deepEqual(
      copy.COMPARE_SENDER.find(([what]) => what === 'Replies'),
      ['Replies', 'They can reply', 'They can reply, if you have an inbox and let them'],
    )
    // Not "only they can read it", which could mean the browsers.
    assert.deepEqual(
      copy.COMPARE_SENDER.find(([what]) => what === 'Your message'),
      ['Your message', 'Encrypted end to end in the best ones', 'Encrypted end to end: sealed in your browser, opened only in the owner’s'],
    )
  })

  test('for senders without an inbox open: "Want a reply?" set out like the switches above it, with a button', () => {
    const html = read('../index.html')
    const main = read('../src/main.ts')
    // The question in bold like a switch's title, "Already got one? Open yours" under it, and the
    // button where a switch would be.
    assert.match(
      html,
      /<div class="include reply-hint" id="reply-hint" hidden>\s*<div class="setting">\s*<span class="setting-text"><strong data-copy="REPLY_HINT_LEAD"><\/strong><span id="reply-hint-have"><span data-copy="REPLY_HINT_HAVE"><\/span> <a class="soft-link" href="#\/open-inbox" data-copy="REPLY_HINT_OPEN"><\/a><\/span><\/span>\s*<a class="btn small" id="reply-hint-go" href="#\/new-inbox" data-copy="REPLY_HINT_GET"><\/a>/,
    )
    assert.equal(copy.REPLY_HINT_LEAD, 'Want a reply?')
    assert.equal(copy.REPLY_HINT_GET, 'Create an inbox')
    assert.equal(`${copy.REPLY_HINT_HAVE} ${copy.REPLY_HINT_OPEN}`, 'Already got one? Open yours')
    // With an inbox kept on this device, no second one is offered: the button opens it, and the line goes.
    assert.match(main, /replyGo\.textContent = keptCount > 0 \? inboxCopy\.REPLY_HINT_OPEN_KEPT : inboxCopy\.REPLY_HINT_GET\n  replyGo\.setAttribute\('href', keptCount > 0 \? '#\/open-inbox' : '#\/new-inbox'\)\n  \$\('reply-hint-have'\)\.hidden = keptCount > 0/)
    assert.equal(copy.REPLY_HINT_OPEN_KEPT, 'Unlock your inbox')
    assert.match(read('../src/style.css'), /\.reply-hint \.btn \{\n  flex-shrink: 0;\n\}/)
  })

  test('how it works stays on the About page: no keys or proofs on the screens', () => {
    const screens = [copy.INCLUDE_LABEL, copy.INCLUDE_HELP, copy.READ_NAME_KEEP, copy.DELIVERED_NOTE_REPLY, copy.TO_REPLYING, shown(copy.FLAG_THEIRS('x')), shown(copy.FLAG_YOURS('x'))]
    for (const t of screens) assert.ok(!/\b(key|proo?f|proves?|deniab|signature|HMAC|X25519|crypt)/i.test(t), t)
  })
})

describe('the About page on replies', () => {
  const about = seenOn(read('../about/index.html')).replace(/\s+/g, ' ')
  const answer = about.slice(about.indexOf('id="inbox-reply"'), about.indexOf('</details>', about.indexOf('id="inbox-reply"')))

  test('says replies need the sender’s own inbox, and that anonymous stays the default', () => {
    assert.match(answer, /Yes, if the sender lets them\. Someone who has their own anonymous inbox open in the same tab can switch on “Let them reply”/)
    assert.match(answer, /Anonymous stays the default/)
  })

  test('the honest limits: known by an inbox and a name, what the owner learns, and the check that convinces only them', () => {
    assert.match(answer, /You’re no longer anonymous to them, but known by your inbox and the name you chose/)
    assert.match(answer, /they get your inbox’s address, so they can write to you, and they can tell that your messages come from the same inbox/)
    // Not on this answer: who could see when messages arrive is "What can others see about an inbox?"
    assert.ok(!/when messages arrive/.test(answer))
    assert.match(answer, /it can’t be shown to anyone else as proof that you wrote the message/)
    assert.ok(!/include my inbox|includes their own inbox/i.test(about), 'no "include my inbox" anywhere')
    assert.match(answer, /someone who got hold of the owner’s passphrase could read their inbox and also write to it as if from yours/)
    assert.match(answer, /tells senders apart by their inbox, never by their name/)
    assert.ok(!/slynk\.me (keeps|holds|stores)/.test(answer))
  })

  test('what a sender’s device keeps, and sender numbers without keeping, said truly (the review)', () => {
    // With replies on or off (the owner's own messages without their inbox are noted too, 2026-10-17).
    assert.match(about, /Slynk keeps nothing on your device when you write to an inbox, unless your own inbox is open in that tab and kept on your device: then it keeps what you wrote, encrypted with the rest of your inbox, so you can check it next time\. If you let them reply, it’s in your conversation with them, with the name you showed them; if not, it’s in your Inbox on its own\./)
    assert.match(answer, /otherwise they start afresh each time the inbox opens, so “Sender 2” may be someone else next time/)
  })

  test('the keeping answer says what replies add to what’s kept, the owner’s own messages too', () => {
    // Shortened on the About rewrite (2026-10-19): one list of what's kept.
    assert.match(about, /your messages, folders and titles, what you’ve read, your address book, the inboxes people wrote from when they let you reply \(with the names they gave, and the reply keys their quantum-safe messages carried, so your replies stay quantum-safe\), the messages you sent, including the messages you sent without letting them reply, and who you’ve blocked\. Files never are/)
  })
})

describe('the way in, and only one inbox in use', () => {
  const main = read('../src/main.ts')
  const html = read('../index.html')

  test('a card under the main one offers to get or open an inbox, and says how it differs from a link', () => {
    assert.match(html, /<section class="card inbox-entry" id="inbox-entry" aria-labelledby="inbox-entry-title" hidden>/)
    assert.ok(html.indexOf('id="inbox-entry"') > html.indexOf('<section class="how"'), 'under the main content, above the footer')
    assert.ok(html.indexOf('id="inbox-entry"') < html.indexOf('<footer'))
    assert.match(html, /<a class="entry-tile" id="entry-create" href="#\/new-inbox">/)
    assert.match(html, /<a class="entry-tile" id="entry-open" href="#\/open-inbox">/)
    assert.match(copy.ENTRY_LEAD, /^An anonymous inbox is different to Slynk links: a permanent address/)
    // Who it's for, so people don't take it for a general messenger.
    assert.match(copy.ENTRY_FOR, /^Made for organisations people need to reach in confidence, such as refuges, support services, charities/)
    assert.ok(html.indexOf('data-copy="ENTRY_FOR"') < html.indexOf('id="entry-create"'), 'before the tiles')
    // One line on a tile, then new or existing, since both end in the inbox.
    assert.equal(copy.ENTRY_CREATE, 'Create an inbox')
    // Two lines on a phone, as the Unlock tile's, so the tiles are the same height.
    assert.equal(copy.ENTRY_CREATE_SUB, 'Don’t have one yet? Make one, no account needed')
    // "Unlock", beside "Create an inbox" ("open" sounded like making one).
    assert.equal(copy.ENTRY_OPEN, 'Unlock my inbox')
    assert.equal(copy.ENTRY_OPEN_SUB, 'Already have one? Unlock it with your passphrase')
    assert.equal(copy.FOOTER_OPEN, 'Unlock my inbox')
    assert.equal(copy.OPEN_TITLE, 'Unlock your inbox')
    assert.equal(copy.OPEN_BUTTON, 'Unlock inbox')
    assert.match(html, /<strong data-copy="ENTRY_CREATE"><\/strong><span data-copy="ENTRY_CREATE_SUB"><\/span>/)
    // Only on the plain front page, while no inbox is open or kept here.
    assert.match(main, /\$\('inbox-entry'\)\.hidden = !plain \|\| keptCount > 0/)
  })

  test('no way to make a second inbox while one is open or kept here', () => {
    assert.match(main, /const inUse = open \|\| keptCount > 0\n  \$\('footer-create'\)\.hidden = inUse/)
    assert.match(main, /if \(owner\.isOpen\(\)\) \{\n      toast\(inboxCopy\.OPEN_ALREADY\)\n      return goHome\(\)\n    \}\n    void refreshKeptCount\(\)\.then\(\(\) => \{\n      if \(keptCount > 0\) \{\n        toast\(inboxCopy\.CREATE_KEPT\)/)
    assert.equal(copy.CREATE_KEPT, 'This device already keeps an inbox. To make a new one, forget it first.')
    // The About page's button opens the kept inbox instead.
    const about = read('../src/about.ts')
    assert.match(about, /if \(n > 0 && a instanceof HTMLAnchorElement\) \{\n      a\.href = '\/#\/open-inbox'/)
    assert.match(read('../about/index.html'), /<a class="btn" id="about-inbox" href="\/#\/new-inbox">Create an anonymous inbox<\/a>/)
  })
})

describe('the inbox, tidied: fewer links and buttons', () => {
  const owner = read('../src/inbox/owner.ts')
  const menu = read('../src/inbox/menu.ts')

  test('the list shows a sender’s name once; "the name they gave" is said under it in their conversation', () => {
    assert.match(owner, /fill\(part\(li, 'from'\), who\(r\.item\)\)/)
    assert.match(owner, /fill\(part\(li, 'from'\), whoIs\(r\.address\)\)/)
    assert.match(owner, /function whoIs\(address: Uint8Array\): Part\[\]/)
    // Under the name, small, so it never breaks the line on a phone.
    assert.match(owner, /\$\('ib-c-sub'\)\.hidden = !!box\.contactFor\(address\) \|\| !box\.givenName\(address\)\n    \$\('ib-c-sub'\)\.textContent = copy\.CHAT_GIVEN/)
    assert.equal(copy.CHAT_GIVEN, 'the name they gave')
  })

  test('menus work from the keyboard and close on Escape, Tab or a click elsewhere', () => {
    for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Escape', 'Tab']) assert.ok(menu.includes(`'${key}'`), key)
    assert.match(menu, /button\.setAttribute\('aria-expanded', 'false'\)/)
    assert.match(menu, /panel\.setAttribute\('role', 'menu'\)/)
    assert.match(menu, /b\.setAttribute\('role', 'menuitem'\)/)
    assert.match(menu, /document\.addEventListener\('pointerdown'/)
  })

  test('a message’s rarer actions, the inbox’s and a sender’s are in menus; one button stands out', () => {
    assert.match(owner, /attachMenu\(\$<HTMLButtonElement>\('ib-r-more'\)/)
    assert.match(owner, /attachMenu\(\$<HTMLButtonElement>\('ib-more-go'\)/)
    assert.match(owner, /attachMenu\(\$<HTMLButtonElement>\('ib-c-more'\)/)
    // (The owner's own message with files and no text has nothing to copy.)
    assert.match(owner, /\$\('ib-r-copy'\)\.hidden = welcome \|\| !isText\(i\) \|\| \(!!i\.mine && !i\.body\.length\)\n/)
    // Removing is marked as such.
    assert.match(owner, /items\.push\(\{ label: copy\.READ_REMOVE\(keeping\), danger: true, run: askRemove \}\)/)
  })

  test('a sender’s picture is a figure, a letter or a number: never anything from their key', () => {
    assert.match(owner, /el\.textContent = name \? firstLetter\(name\) : String\(n\)/)
    assert.match(owner, /el\.innerHTML = ANONYMOUS_SVG \/\/ fixed markup, nothing from the sender/)
    // An inbox the owner wrote to, with no name or number: a tray, nothing from its address either.
    assert.match(owner, /el\.innerHTML = INBOX_SVG \/\/ fixed markup, nothing from the inbox's address/)
  })
})

describe('never stranded on an inbox screen', () => {
  test('creating and opening an inbox start with a way back to the front page', () => {
    const html = read('../index.html')
    for (const view of ['v-new-inbox', 'v-open-inbox']) {
      const at = html.indexOf(`id="${view}"`)
      assert.match(html.slice(at, at + 600), /^id="[\w-]+" hidden>\n\s+<button class="back-chip" type="button" data-home><svg [^>]*aria-hidden="true">[^]*?<\/svg><span data-copy="BACK_HOME"><\/span><\/button>/, view)
    }
    assert.equal(copy.BACK_HOME, 'Back to the front page')
    // Back to where they were (an inbox's composer, message kept, if they came from one); the words box is wiped.
    assert.match(read('../src/main.ts'), /for \(const b of document\.querySelectorAll<HTMLButtonElement>\('\[data-home\]'\)\) \{\n  b\.addEventListener\('click', \(\) => \{\n    owner\.clearForm\(\)\n    goHome\(\)/)
  })
})
