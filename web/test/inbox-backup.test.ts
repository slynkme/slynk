// A backup of the whole inbox, messages and all, restored by
// merging it with whatever a device already keeps; and blocked senders, whose messages
// are set aside: out of the list, the counts and the alerts.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { NOTICE_TEXT } from '../src/inbox/drop.ts'
import * as copy from '../src/inbox/inboxCopy.ts'
import { BACKUP_FILE_NAME, KeyFileError, MAX_BACKUP_FILE, holdsMessages, isKeyFile, makeKeyFile, readKeyFile } from '../src/inbox/keyfile.ts'
import { INBOX, MAX_HELD, MAX_SET_ASIDE, Mailbox } from '../src/inbox/mailbox.ts'
import { fromBase64url } from '../src/linkv2.ts'
import type { Derive } from '../src/password.ts'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const WORDS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const PW = 'tidy melon orbit seven lamp'
// Argon2id is the real thing's; here the lock only needs to be a lock.
const fastDerive: Derive = async (password, salt) => new Uint8Array(createHash('sha256').update(password).update(salt).digest())

let n = 0
let clock = Date.UTC(2026, 9, 20, 12)
const addr = (fill: number) => {
  const a = new Uint8Array(33).fill(fill)
  a[0] = 3
  return a
}
const A = addr(0xa1)
const B = addr(0xb2)
function msg(text: string, from?: Uint8Array, at = (clock += 60_000)) {
  return { id: (++n).toString(16).padStart(32, '0'), kind: NOTICE_TEXT, body: new TextEncoder().encode(text), sent: at, at, quantumSafe: false, ...(from ? { from: from.slice(), fromName: '' } : {}) }
}
const text = (box: Mailbox, id: string) => new TextDecoder().decode(box.get(id)!.body)

describe('a backup with its messages', () => {
  function filled() {
    const box = new Mailbox()
    box.label = 'Staff concerns'
    const one = msg('Hello from nobody')
    const two = msg('Hello from A', A)
    box.add(one, false)
    box.add(two, false)
    box.setRead(one.id, true)
    return { box, one, two }
  }

  test('holds the words, the label and everything the inbox keeps, all inside the lock', async () => {
    const { box, one, two } = filled()
    const file = await makeKeyFile(`  ${WORDS.toUpperCase()} `, PW, fastDerive, box.label, box.toKept())
    // Nothing readable without the password: two lines anyone may read, then the sealed part alone.
    const lines = file.split('\n')
    assert.equal(lines[0], 'Your Slynk inbox backup')
    assert.equal(lines[1], 'To use it, choose “Unlock my inbox” on the Slynk page, then “Restore from a backup file”. It needs the password you chose for it.')
    assert.match(lines[2], /^v2\.[A-Za-z0-9_-]+$/)
    assert.deepEqual(lines.slice(3), [''])
    assert.equal(isKeyFile(file), '')
    assert.equal(holdsMessages(file), true)
    const back = await readKeyFile(file, ' Tidy Melon Orbit Seven Lamp', fastDerive)
    assert.equal(back.words, WORDS)
    assert.equal(back.label, 'Staff concerns')
    const restored = Mailbox.fromKept(back.inbox, false)
    assert.equal(text(restored, one.id), 'Hello from nobody')
    assert.equal(text(restored, two.id), 'Hello from A')
    assert.equal(restored.get(one.id)!.read, true)
    assert.equal(restored.get(two.id)!.from?.address.length, 33)
    assert.equal(BACKUP_FILE_NAME, 'slynk-inbox-backup.txt')
  })

  test('is padded as kept records are, so its size says little about how many messages it holds', async () => {
    const { box } = filled()
    const sizeOf = async (b: Mailbox) => fromBase64url((await makeKeyFile(WORDS, PW, fastDerive, '', b.toKept())).split('\n')[2].slice(3)).length
    const few = await sizeOf(box)
    for (let i = 0; i < 5; i++) box.add(msg(`more ${i}`), false)
    assert.equal(await sizeOf(box), few)
    // salt(16) nonce(12) tag(16) around a multiple of 16 KB.
    assert.equal((few - 44) % 16384, 0)
  })

  test('a passphrase-only backup is as before, and says it holds no messages', async () => {
    const file = await makeKeyFile(WORDS, PW, fastDerive)
    assert.equal(holdsMessages(file), false)
    assert.deepEqual(await readKeyFile(file, PW, fastDerive), { words: WORDS, label: '' })
  })

  test('a wrong password, a damaged file or one too big to be real is refused', async () => {
    const { box } = filled()
    const file = await makeKeyFile(WORDS, PW, fastDerive, '', box.toKept())
    const code = async (t: string, pw = PW) => {
      try {
        await readKeyFile(t, pw, fastDerive)
        return 'opened'
      } catch (e) {
        assert.ok(e instanceof KeyFileError)
        return e.code
      }
    }
    assert.equal(await code(file, 'tidy melon orbit seven lamps'), 'wrong')
    assert.equal(await code(file.replace(/v2\.(.)/, (_, c) => `v2.${c === 'A' ? 'B' : 'A'}`)), 'wrong')
    // Passed off as a passphrase-only file, it's far too big to be one (and sealed under another label).
    assert.equal(await code(file.replace('v2.', 'v1.')), 'not-key-file')
    assert.equal(isKeyFile(file + 'x'.repeat(MAX_BACKUP_FILE)), 'not-key-file')
  })

  test('restoring joins it to what the device keeps: what the device has wins where both hold a message', () => {
    const { box: backup, one, two } = filled()
    backup.covered = Date.UTC(2026, 9, 21)
    // The device kept the first message, unread there, and has one the backup doesn't.
    const device = new Mailbox()
    const own = msg('Only here')
    device.add({ ...one, body: new TextEncoder().encode('Hello from nobody') }, false)
    device.add(own, false)
    const before = device.size
    device.merge(Mailbox.fromKept(backup.toKept(), false))
    assert.equal(device.size - before, 1, 'only the message it didn’t have')
    assert.equal(device.get(one.id)!.read, false)
    assert.equal(text(device, two.id), 'Hello from A')
    assert.equal(text(device, own.id), 'Only here')
    assert.equal(device.covered, Date.UTC(2026, 9, 21), 'its look-back carries on from the backup’s')
    assert.equal(copy.RESTORED(1), '1 message restored from your backup.')
    assert.equal(copy.RESTORED(0), 'Restored from your backup.')
    // Where the device couldn't keep it, the toast says the messages are in that tab only (the review).
    assert.equal(copy.RESTORED_TAB(4), '4 messages restored in this tab only: this device couldn’t keep your inbox.')
  })

  test('the menu offers it with the messages switched on, and the open screen restores them and keeps the inbox here', () => {
    const owner = read('../src/inbox/owner.ts')
    const html = read('../index.html')
    assert.equal(copy.SAVEFILE_START, 'Back up your inbox…')
    assert.match(html, /<input type="checkbox" class="switch" id="ib-savefile-all" autocomplete="off" \/>/)
    // Offered whenever there's more than the words: folders, names, replies or blocks count too (the review).
    assert.match(owner, /\$\('ib-savefile-all-row'\)\.hidden = !box\.holdsMore\(\)\n {4}saveFileAll\.checked = true/)
    const box = new Mailbox()
    assert.equal(box.holdsMore(), false)
    box.saveContact(A, 'Sam')
    assert.equal(box.holdsMore(), true)
    assert.equal(copy.SAVEFILE_ALL_HELP(0), 'Your replies, folders and names. Files sent to you aren’t included.')
    assert.equal(copy.SAVEFILE_ALL_HELP(2), '2 messages, your replies, folders and names. Files sent to you aren’t included.')
    assert.match(owner, /\.\.\.\(saveFileAll\.checked && !\$\('ib-savefile-all-row'\)\.hidden \? \{ inbox: box\.toKept\(\) \} : \{\}\)/)
    // A newer version's kept format isn't half-read.
    assert.match(owner, /if \(\(inbox as \{ v\?: unknown \}\)\.v !== 1\) return formError\(copy\.OPEN_NEWER_KEY_FILE\)/)
    assert.match(owner, /const had = new Set\(box\.all\(\)\.map\(\(i\) => i\.id\)\)\n {6}box\.merge\(opts\.restore\)/)
    assert.match(owner, /restore\?\.wipeAll\(\)/)
    assert.match(owner, /deps\.toast\(keeping \? copy\.RESTORED\(restored\) : copy\.RESTORED_TAB\(restored\)\)/)
    // The keep switch shows the owner's own choice again once the file no longer needs it (the review).
    assert.match(owner, /function renderKeepBox\(\) \{\n {4}const needed = rememberBox\.checked \|\| fileKeeps\n {4}keepBox\.checked = keepChosen \|\| needed\n {4}keepBox\.disabled = needed\n {2}\}/)
    // Read once as it's chosen, not again on every check.
    assert.match(owner, /const parsed = parseKeyFile\(await file\.text\(\)\)/)
    assert.match(html, /<p class="note" id="oi-file-messages" data-copy="OPEN_FILE_MESSAGES" hidden><\/p>/)
  })
})

describe('blocked senders', () => {
  const T = Date.UTC(2026, 9, 22)

  function withA() {
    const box = new Mailbox()
    const fromA = msg('From A', A, T - 3_600_000)
    const fromB = msg('From B', B, T - 1_800_000)
    const anon = msg('Anonymous', undefined, T - 600_000)
    for (const m of [fromA, fromB, anon]) box.add(m, false)
    return { box, fromA, fromB, anon }
  }

  test('their messages are set aside: not in the list, not counted, not news', () => {
    const { box, fromA } = withA()
    assert.equal(box.unread(), 3)
    assert.equal(box.block(A, true, T), true)
    assert.equal(box.block(A, true, T), false, 'once')
    assert.equal(box.isBlocked(A), true)
    assert.equal(box.setAside(box.get(fromA.id)!), true)
    assert.equal(box.unread(), 2)
    assert.equal(box.received, 2)
    assert.equal(box.counts().get(INBOX)!.total, 2)
    assert.ok(!box.rows(INBOX).some((r) => r.kind === 'thread' && r.address[1] === 0xa1))
    assert.equal(box.rows(INBOX).length, 2)
    // Still there, for Show and in case they're unblocked.
    assert.equal(box.thread(A).length, 1)
    assert.deepEqual(
      box.blocked().map((b) => [b.address[1], b.count]),
      [[0xa1, 1]],
    )
    assert.equal(box.block(A, false, T + 1), true)
    assert.equal(box.rows(INBOX).length, 3)
    assert.deepEqual(box.blocked(), [])
  })

  test(`of what they send once blocked, only the newest ${MAX_SET_ASIDE} stay, so they can’t fill the inbox`, () => {
    const { box, fromA } = withA()
    box.block(A, true, T)
    const sent = Array.from({ length: MAX_SET_ASIDE + 5 }, (_, i) => msg(`flood ${i}`, A, T + (i + 1) * 1000))
    for (const m of sent) box.add(m, false)
    assert.equal(box.thread(A).length, MAX_SET_ASIDE + 1, 'what came before the block stays')
    assert.ok(box.get(fromA.id))
    assert.equal(box.get(sent[0].id), undefined)
    assert.ok(box.get(sent[sent.length - 1].id))
    // Gone, and not remembered as removed, which would grow with a flood: if it comes again, it goes again.
    const removedBefore = box.toKept().removed.length
    assert.equal(box.add({ ...sent[0], body: new TextEncoder().encode('flood 0') }, false), 'removed')
    assert.equal(box.toKept().removed.length, removedBefore)
  })

  test('one older than all they’ve sent since goes at once, and says so, rather than seeming added (the review)', () => {
    const { box } = withA()
    box.block(A, true, T)
    for (let i = 0; i < MAX_SET_ASIDE; i++) box.add(msg(`newer ${i}`, A, T + 10_000 + i), false)
    const older = msg('older', A, T + 5_000)
    assert.equal(box.add(older, false), 'removed')
    assert.equal(box.get(older.id), undefined)
    assert.equal(box.blocked()[0].count, MAX_SET_ASIDE + 1, 'with the one from before the block')
  })

  test('not counted even where the inbox is full, and their conversation stays where the owner put it', () => {
    const box = new Mailbox()
    const first = msg('From A', A, T - 1000)
    box.add(first, false)
    box.move(first.id, 'f000000000001')
    box.block(A, true, T)
    assert.equal(box.add(msg('Again', A, T + 1000), false), 'added')
    assert.equal(box.get(first.id)!.folder, box.folder('f000000000001') ? 'f000000000001' : INBOX)
    for (let i = box.size; i < MAX_HELD; i++) box.add(msg(`filler ${i}`), false)
    assert.equal(box.add(msg('Once more', A, T + 2000), false), 'removed')
    assert.equal(box.overflow, 0)
    assert.equal(box.add(msg('Someone else'), false), 'full')
    assert.equal(box.overflow, 1)
  })

  test('a block dated in the future, from a damaged or crafted record, counts from now', () => {
    const box = new Mailbox()
    box.block(A, true, T)
    const kept = box.toKept()
    kept.blocks![0][1] = Date.now() + 365 * 86_400_000
    assert.ok(Mailbox.fromKept(kept, false).blocked()[0].at <= Date.now())
  })

  test('kept with the inbox, and in its backup; another copy follows whichever was done last', () => {
    const { box } = withA()
    box.block(A, true, T)
    box.block(B, true, T)
    box.block(B, false, T + 5)
    const kept = box.toKept()
    assert.equal(kept.blocks?.length, 2)
    const again = Mailbox.fromKept(JSON.parse(JSON.stringify(kept)), false)
    assert.equal(again.isBlocked(A), true)
    assert.equal(again.isBlocked(B), false)
    // Another copy unblocked A later, and blocked B before B was unblocked here.
    const other = new Mailbox()
    other.block(A, true, T - 10)
    other.block(A, false, T + 10)
    other.block(B, true, T + 1)
    again.merge(other)
    assert.equal(again.isBlocked(A), false)
    assert.equal(again.isBlocked(B), false)
    // Nothing blocked, nothing written.
    assert.equal(new Mailbox().toKept().blocks, undefined)
  })

  test('offered in a conversation’s menu only where the inbox is kept, said honestly first; a blocked conversation can’t be answered', () => {
    const owner = read('../src/inbox/owner.ts')
    const html = read('../index.html')
    assert.match(owner, /if \(box\.isBlocked\(address\)\) items\.push\(\{ label: copy\.UNBLOCK, run: \(\) => unblockSender\(address\) \}\)\n {4}else if \(withBook\(\)\) items\.push\(\{ label: copy\.BLOCK_START, run: askBlock \}\)/)
    assert.match(copy.BLOCK_ASK('Sam'), /^Block Sam\? Their messages will be set aside on this device, unseen: not in your inbox, not counted, no alerts\. They won’t be told, and could still write anonymously or from another inbox\.$/)
    assert.match(owner, /\$\('ib-c-blocked'\)\.hidden = !isBlocked\n {4}\$\('ib-c-form'\)\.hidden = isBlocked/)
    assert.match(owner, /if \(!address \|\| !info \|\| opening \|\| failed \|\| box\.isBlocked\(address\)\) return/)
    assert.match(owner, /if \(blockedCount\) items\.splice\(2, 0, \{ label: copy\.BLOCKED_MENU\(blockedCount\), run: openBlocked \}\)/)
    assert.match(html, /<div class="ib-form blocked-ask" id="ib-blocked" hidden>/)
    assert.equal(copy.BLOCKED_COUNT(3), '3 messages set aside')
    // Nothing to show once their conversation is removed; no files dropped into a blocked chat.
    assert.match(owner, /show\.hidden = !b\.count/)
    assert.match(owner, /takesFiles: \(\) => INBOX_FILES && !!info && !!chatWith && !box\.isBlocked\(chatWith\),/)
  })
})
