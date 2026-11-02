// A real inbox: the owner's mailbox (read, folders, titles,
// removed, the address book) and keeping it on the device, encrypted with a
// key from the inbox's words. Run: npm --prefix web test
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { describe, mock, test } from 'node:test'
import { LINK_LENGTH } from '../src/payload.ts'
import { NOTICE_FILE, NOTICE_TEXT, fileNoticeBody } from '../src/inbox/drop.ts'
import { KeptError, PAD, keptKey, readKept, seal, unseal, writeKept } from '../src/inbox/kept.ts'
import { ARCHIVE, INBOX, LOOKBACK_MARGIN_MS, MAX_FOLDERS, MAX_NAME, MAX_TITLE, Mailbox, REMEMBER_REMOVED_MS, cleanName } from '../src/inbox/mailbox.ts'
import { seenOn } from './helpers/pages.ts'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

// The golden inbox's store secret ("abandon" x11, "about"): core/transfer/inbox_test.go.
const GOLDEN_STORE = '7af7023f3f5dbdd2e40bcee35cc27b771415503ab036c54f5af2ec4f3618065d8110de99d8786acd8c2329f8658e53a3'
const secret = (hex = GOLDEN_STORE) => new Uint8Array(Buffer.from(hex, 'hex'))

const id = (n: number) => n.toString(16).padStart(32, '0')
let clock = Date.UTC(2026, 9, 16, 12)
function text(n: number, words: string, at = (clock += 60_000)) {
  return { id: id(n), kind: NOTICE_TEXT, body: new TextEncoder().encode(words), sent: at, at: at + 20_000, quantumSafe: false }
}
function v1Link(size: number, sent = Date.now()): Uint8Array {
  const v1 = new Uint8Array(LINK_LENGTH)
  crypto.getRandomValues(v1)
  v1[0] = 1
  const view = new DataView(v1.buffer)
  view.setBigUint64(1 + 32 + 33, BigInt(sent) * 1_000_000n)
  view.setUint32(1 + 32 + 33 + 8 + 32 + 32, size)
  return v1
}
function file(n: number, sent = Date.now()) {
  return { id: id(n), kind: NOTICE_FILE, body: fileNoticeBody(v1Link(30_000, sent)), sent, at: sent, quantumSafe: false }
}
const words = (box: Mailbox, n: number) => new TextDecoder().decode(box.get(id(n))!.body)

/**
 * A stand-in for the browser's IndexedDB, enough for kept.ts: one store in memory, and connections
 * that can be made to fail, as Safari's do after a phone wakes ("Connection to Indexed Database
 * server lost"): failOpens opens, then failTransactions transactions.
 */
function fakeStorage() {
  const lost = () => new DOMException('Connection to Indexed Database server lost. Refresh the page to try again', 'UnknownError')
  const fake = {
    data: new Map<string, unknown>(),
    opens: 0,
    failOpens: 0,
    failTransactions: 0,
    databases: async () => [{ name: 'slynk', version: 1 }],
    open() {
      fake.opens++
      const fail = fake.failOpens > 0
      if (fail) fake.failOpens--
      const req: Record<string, unknown> & { onsuccess?: () => void; onerror?: (e: Event) => void } = { result: undefined, error: null }
      queueMicrotask(() => {
        if (fail) {
          req.error = lost()
          req.onerror?.(new Event('error'))
        } else {
          req.result = db
          req.onsuccess?.()
        }
      })
      return req
    },
  }
  const db = {
    close() {},
    transaction() {
      if (fake.failTransactions > 0) {
        fake.failTransactions--
        throw lost()
      }
      const steps: (() => void)[] = []
      const request = (run: () => unknown) => {
        const req: { result?: unknown; onsuccess?: () => void } = {}
        steps.push(() => {
          req.result = run()
          req.onsuccess?.()
        })
        return req
      }
      const tx: { oncomplete?: () => void; objectStore: () => unknown } = {
        objectStore: () => ({
          get: (k: string) => request(() => fake.data.get(k)),
          put: (v: unknown, k: string) => request(() => fake.data.set(k, v) && k),
          delete: (k: string) => request(() => fake.data.delete(k) && undefined),
          getAllKeys: () => request(() => [...fake.data.keys()]),
          count: () => request(() => fake.data.size),
        }),
      }
      queueMicrotask(() => {
        for (const step of steps) step()
        tx.oncomplete?.()
      })
      return tx
    },
  }
  return fake
}

describe('the mailbox', () => {
  test('new messages arrive unread in Inbox, newest first, once each', () => {
    const box = new Mailbox()
    assert.equal(box.add(text(1, 'first'), false), 'added')
    assert.equal(box.add(text(2, 'second'), false), 'added')
    const again = text(1, 'first')
    assert.equal(box.add(again, false), 'known')
    assert.ok(again.body.every((b) => b === 0), 'a repeat is wiped')
    assert.deepEqual(
      box.all().map((i) => i.id),
      [id(2), id(1)],
    )
    assert.ok(box.all().every((i) => i.folder === INBOX && !i.read && !i.title))
    assert.deepEqual(box.counts().get(INBOX), { total: 2, unread: 2 })
  })

  test('read and unread, Archive, folders of the owner’s own, and titles', () => {
    const box = new Mailbox()
    box.add(text(1, 'a'), false)
    box.add(text(2, 'b'), false)
    assert.ok(box.setRead(id(1), true))
    assert.ok(!box.setRead(id(1), true), 'no change, nothing to keep')
    assert.ok(box.move(id(2), ARCHIVE))
    assert.deepEqual(box.counts().get(INBOX), { total: 1, unread: 0 })
    assert.deepEqual(box.counts().get(ARCHIVE), { total: 1, unread: 1 })

    const builtIn = ['Inbox', 'Archive']
    const f = box.addFolder('  Urgent   cases ', builtIn)
    assert.ok(typeof f === 'object' && f.name === 'Urgent cases' && /^f[0-9a-f]{12}$/.test(f.id))
    assert.equal(box.addFolder('urgent CASES', builtIn), 'taken')
    assert.equal(box.addFolder('archive', builtIn), 'taken', 'not the name of a folder that’s always there')
    assert.equal(box.addFolder(' \u0007 ', builtIn), 'empty')
    assert.ok(box.move(id(1), f.id))
    assert.equal(box.renameFolder(f.id, 'Follow up', builtIn), 'ok')
    assert.equal(box.inFolder(f.id)[0].id, id(1))
    assert.ok(box.deleteFolder(f.id))
    assert.equal(box.get(id(1))!.folder, INBOX, 'a deleted folder’s messages go back to Inbox')
    assert.ok(!box.move(id(1), f.id), 'not into a folder that’s gone')

    assert.ok(box.setTitle(id(1), '  Housing\u202e  question  '))
    assert.equal(box.get(id(1))!.title, 'Housing question')
    assert.equal(box.get(id(1))!.title.length <= MAX_TITLE, true)
  })

  test('a limit on folders', () => {
    const box = new Mailbox()
    for (let i = 0; i < MAX_FOLDERS; i++) assert.equal(typeof box.addFolder(`Folder ${i}`), 'object')
    assert.equal(box.addFolder('One more'), 'full')
  })

  test('removed for good: wiped, and the look-back doesn’t bring it back', () => {
    const box = new Mailbox()
    box.add(text(1, 'remove me'), false)
    const body = box.get(id(1))!.body
    assert.ok(box.remove(id(1)))
    assert.ok(body.every((b) => b === 0))
    const again = text(1, 'remove me')
    assert.equal(box.add(again, false), 'removed')
    assert.ok(again.body.every((b) => b === 0))
    assert.equal(box.size, 0)
  })

  test('an upload removed for good doesn’t come back in a notice sent again either', () => {
    const box = new Mailbox()
    const v1 = v1Link(9000)
    box.add({ id: id(1), kind: NOTICE_FILE, body: fileNoticeBody(v1), sent: clock, at: clock, quantumSafe: false }, true)
    box.remove(id(1))
    assert.equal(box.add({ id: id(2), kind: NOTICE_FILE, body: fileNoticeBody(v1), sent: clock, at: clock, quantumSafe: false }, true), 'known')
  })

  test('an upload’s link goes once the network has let it go, and when it was collected stays', () => {
    const box = new Mailbox()
    const long = Date.now() - 600 * 3600_000 // sent long enough ago to have expired
    box.add(file(1, long), true)
    box.add(file(2), true)
    const old = box.get(id(1))!.upload!
    const v1 = old.v1!
    assert.ok(box.markCollected(id(1), long + 1000))
    assert.ok(box.dropExpiredLinks())
    assert.equal(old.v1, undefined)
    assert.ok(v1.every((b) => b === 0))
    assert.equal(old.collected, long + 1000)
    assert.ok(box.get(id(2))!.upload!.v1, 'one still on the network keeps its link')
  })

  test('the address book: names the owner gives, found without case, never twice', () => {
    const box = new Mailbox()
    const a = new Uint8Array(33).fill(3)
    const b = new Uint8Array(33).fill(4)
    const saved = box.saveContact(a, ' Advice  line ')
    assert.ok(typeof saved === 'object' && saved.name === 'Advice line')
    assert.equal(box.contactNamed('ADVICE LINE')?.name, 'Advice line')
    assert.equal(box.saveContact(b, 'advice line'), 'taken')
    assert.equal(box.saveContact(b, ''), 'empty')
    assert.equal(typeof box.saveContact(a, 'Housing team'), 'object', 'saving it again renames it')
    assert.equal(box.book().length, 1)
    assert.equal(box.contactFor(a)?.name, 'Housing team')
    assert.ok(box.removeContact(a))
    assert.equal(box.contactFor(a), undefined)
  })

  test('names, labels and titles are cleaned: no control or direction characters, spaces collapsed, cut short', () => {
    assert.equal(cleanName('  Staff\n\tconcerns\u200f '), 'Staff concerns')
    assert.equal(cleanName('a'.repeat(100)).length, MAX_NAME)
    assert.equal(cleanName('🏠'.repeat(100)), '🏠'.repeat(MAX_NAME), 'counted in characters, never cut inside one')
    assert.equal(cleanName('\u202e\u2066'), '')
  })
})

describe('keeping it on the device', () => {
  test('round trip: messages, read state, folders, titles, label, address book, removed and uploads', () => {
    const box = new Mailbox()
    box.label = 'Staff concerns'
    box.add(text(1, 'hello'), true)
    box.add(text(2, 'second'), true)
    box.add(text(3, 'gone'), true)
    box.add(file(4), true)
    box.setRead(id(1), true)
    const f = box.addFolder('Follow up')
    assert.ok(typeof f === 'object')
    box.move(id(2), f.id)
    box.setTitle(id(2), 'Rota')
    box.remove(id(3))
    box.markCollected(id(4))
    box.saveContact(Uint8Array.from({ length: 33 }, (_, i) => (i ? 9 : 3)), 'Advice line')
    const back = Mailbox.fromKept(JSON.parse(JSON.stringify(box.toKept())), true)
    assert.equal(back.label, 'Staff concerns')
    assert.equal(words(back, 1), 'hello')
    assert.equal(back.get(id(1))!.read, true)
    assert.equal(back.get(id(2))!.folder, f.id)
    assert.equal(back.get(id(2))!.title, 'Rota')
    assert.equal(back.add(text(3, 'gone'), true), 'removed', 'still remembered')
    assert.deepEqual([...back.get(id(4))!.upload!.v1!], [...box.get(id(4))!.upload!.v1!])
    assert.ok(back.get(id(4))!.upload!.collected)
    assert.equal(back.contactNamed('advice line')?.address[1], 9)
    assert.deepEqual(
      back.ownFolders().map((f) => f.name),
      ['Follow up'],
    )
  })

  test('never the files or the words: only what the mailbox holds', () => {
    const kept = JSON.stringify(new Mailbox().toKept())
    // keys: the reply keys senders gave, so a kept inbox can still answer them quantum-safely.
    assert.deepEqual(Object.keys(JSON.parse(kept)).sort(), ['book', 'covered', 'folders', 'items', 'keys', 'label', 'next', 'removed', 'senders', 'sent', 'shown', 'v'])
    assert.ok(!('done' in JSON.parse(kept)), 'a stretch only once there is one')
    const owner = read('../src/inbox/owner.ts')
    // What's collected (drop.items, drop.bytes) lives in the reader's Drop, never in the mailbox.
    assert.ok(!/upload\.(items|bytes|data)|item\.upload\.files/.test(owner))
    // The sealed record never holds the words: only "Remember my passphrase" keeps them, apart (below).
    // Every write in kept.ts: the sealed record, and only rememberWords' words (and the label, apart).
    const keptTs = read('../src/inbox/kept.ts')
    assert.deepEqual(keptTs.match(/s\.put\([^)]*\)/g), [
      's.put({ v: 1, words }, WORDS + name)',
      's.put({ v: 1, sealed: words }, SEALED + name)',
      's.put(label, LABEL + name)',
      's.put(label, LABEL + name)',
      's.put(rec, name)',
    ])
    assert.match(keptTs, /export async function rememberWords\(name: string, words: string \| Uint8Array, label: string\): Promise<void> \{\n  await inTx\('readwrite', \(s\) => \{\n    if \(typeof words === 'string'\) \{\n      s\.put\(\{ v: 1, words \}, WORDS \+ name\)\n      s\.delete\(SEALED \+ name\)/)
  })

  test('a message with no known time is still sorted, and its removal still remembered', () => {
    const box = new Mailbox()
    // The core sends 0 for an unknown round time; an older build sent year 1.
    box.add({ ...text(1, 'no round time'), at: 0 }, false)
    box.add({ ...text(2, 'year one'), at: -62135596800000 }, false)
    assert.ok(box.all().every((i) => i.sent > 0))
    box.remove(id(1))
    box.remove(id(2))
    assert.equal(box.toKept().removed.length, 2, 'not dropped at the first save')
  })

  test('a link the network has let go is never written to the device', () => {
    const box = new Mailbox()
    box.add(file(1, Date.now() - 600 * 3600_000), true)
    const kept = box.toKept()
    assert.equal(kept.items[0].upload!.v1, undefined)
    assert.ok(kept.items[0].upload!.key)
  })

  test('turning keeping on where something is already kept merges, never overwrites', () => {
    // Another tab kept the inbox for weeks: an old message, a folder, a removal.
    const stored = new Mailbox()
    stored.label = 'Staff concerns'
    stored.add(text(1, 'from long ago', Date.now() - 40 * 86400_000), false)
    stored.add(text(2, 'removed there'), false)
    stored.remove(id(2))
    const f = stored.addFolder('Follow up')
    assert.ok(typeof f === 'object')
    stored.move(id(1), f.id)
    // This tab, without keeping: what the look-back found, read here.
    const here = new Mailbox()
    here.add(text(2, 'removed there'), false)
    here.add(text(3, 'new'), false)
    here.setRead(id(3), true)
    here.merge(stored)
    assert.equal(here.get(id(1))!.folder, f.id, 'what only the device kept comes back, in its folder')
    assert.equal(here.get(id(2)), undefined, 'a removal made there sticks')
    assert.equal(here.add(text(2, 'removed there'), false), 'removed')
    assert.equal(here.get(id(3))!.read, true, 'what’s on screen keeps its state')
    assert.equal(here.label, 'Staff concerns')
    // The merged copy is its own: wiping the other doesn't touch it.
    stored.wipeAll()
    assert.equal(words(here, 1), 'from long ago')
  })

  test('a kept inbox looks back only from a day before its last finished look-back', () => {
    const box = new Mailbox()
    assert.equal(box.lookbackFrom(), undefined, 'nothing known: as far as the network keeps')
    const t = Date.now() - 3 * 3600_000
    box.covered = t
    assert.equal(box.lookbackFrom(), t - LOOKBACK_MARGIN_MS)
    assert.equal(LOOKBACK_MARGIN_MS, 24 * 3600_000)
    const back = Mailbox.fromKept(JSON.parse(JSON.stringify(box.toKept())), false)
    assert.equal(back.covered, t)
    // A mark in the future would skip what arrives until then: never trusted.
    assert.equal(Mailbox.fromKept({ ...box.toKept(), covered: Date.now() + 86400_000 }, false).covered, 0)
    assert.equal(Mailbox.fromKept({ ...box.toKept(), covered: 'soon' }, false).covered, 0)
    // Merged, they hold everything either did up to the later mark.
    const other = new Mailbox()
    other.covered = t + 1000
    box.merge(other)
    assert.equal(box.covered, t + 1000)
    box.wipeAll()
    assert.equal(box.covered, 0)
  })

  test('a look-back cut short carries on next time: the days it went through are skipped', () => {
    const now = Date.now()
    const day = 24 * 3600_000
    // First visit: a full look-back, newest days first, cut short with 7 of 21 days done.
    const box = new Mailbox()
    assert.ok(box.noteDone(now - 7 * day, now))
    const plan = box.lookbackPlan()
    assert.equal(plan.since, undefined, 'still as far back as the network keeps')
    assert.equal(plan.skipFrom, now - 7 * day)
    assert.equal(plan.skipTo, now - day, 'all but the last day of the stretch, checked again to be safe')
    // Kept and read back, the plan is the same.
    const back = Mailbox.fromKept(JSON.parse(JSON.stringify(box.toKept())), false)
    assert.deepEqual(back.lookbackPlan(), plan)

    // Second visit, cut short again further back: the stretches join.
    assert.ok(back.noteDone(now - 12 * day, now + 3600_000))
    assert.deepEqual(back.done, { from: now - 12 * day, to: now + 3600_000 })
    // A stretch that doesn't meet the one noted replaces it only if it's longer.
    assert.equal(back.noteDone(now - 30 * day, now - 29 * day), false)

    // Finished at last: everything is covered, and nothing is left to skip.
    back.coveredUpTo(now + 2 * 3600_000)
    assert.equal(back.done, undefined)
    assert.deepEqual(back.lookbackPlan(), { since: now + 2 * 3600_000 - day })
  })

  test('a stretch reaching back to what was covered folds into it', () => {
    const now = Date.now()
    const day = 24 * 3600_000
    const box = new Mailbox()
    box.covered = now - 5 * day
    // A short look-back from there, cut short: its newest days are done, not yet back to the mark.
    assert.ok(box.noteDone(now - 2 * day, now))
    assert.equal(box.covered, now - 5 * day)
    assert.deepEqual(box.done, { from: now - 2 * day, to: now })
    // Then reaching back past the mark: all of it is covered.
    assert.ok(box.noteDone(now - 6 * day, now + 1000))
    assert.equal(box.covered, now + 1000)
    assert.equal(box.done, undefined)
    // Nonsense is ignored.
    assert.equal(box.noteDone(0, now), false)
    assert.equal(box.noteDone(now, now - 1), false)
    // A stretch in the future is never trusted from what's kept.
    const kept = { ...new Mailbox().toKept(), done: { from: now, to: now + day } }
    assert.equal(Mailbox.fromKept(kept, false).done, undefined)
  })

  test('the owner notes how far a running look-back has got, and opens the next one with the plan', () => {
    const owner = read('../src/inbox/owner.ts')
    assert.match(owner, /\} else if \(!lookback\.finished && lookback\.doneFrom > 0 && !lookback\.collecting\) \{\n      \/\/[^\n]*\n      if \(box\.noteDone\(lookback\.doneFrom, Date\.now\(\)\)\) changed\(\)/)
    assert.match(owner, /const plan = box\.lookbackPlan\(\)/)
    assert.match(owner, /await core\.inboxOpen\(words, plan\)/)
    const core = read('../../core/transfer/inbox.go')
    assert.match(core, /func doneFrom\(left, inFlight, failed int, pending time\.Time\) time\.Time \{\n\tif left == 0 \|\| inFlight > 0 \|\| failed > 0 \{/)
    const bridge = read('../../core/cmd/wasm/inbox.go')
    assert.match(bridge, /if to\.After\(from\) && to\.Before\(time\.Now\(\)\) \{\n\t\t\tskipFrom, skipTo = from, to/)
  })

  test('the mark moves only when a look-back finished with nothing missing, and the next one starts from it', () => {
    const owner = read('../src/inbox/owner.ts')
    assert.match(owner, /if \(lookback\.finished && !lookback\.missing && !lookback\.collecting\) \{\n      box\.coveredUpTo\(Date\.now\(\)\)/)
    assert.match(owner, /await core\.inboxOpen\(words, plan\)/)
    assert.match(owner, /opened\+\+\n    markCovered\(\)/)
    const bridge = read('../../core/cmd/wasm/inbox.go')
    // The page can only shorten a look-back, never push it past what the network keeps.
    assert.match(bridge, /since := time\.Now\(\)\.Add\(-lookbackSince\)\n\tif len\(args\) > 2 && args\[2\]\.Type\(\) == js\.TypeNumber \{\n\t\tif t := time\.UnixMilli\(int64\(args\[2\]\.Float\(\)\)\); t\.After\(since\) \{/)
    assert.match(bridge, /session = c\.OpenInboxSkipping\(key, since, skipFrom, skipTo,/)
  })

  test('an inbox that isn’t kept is offered keeping while it looks back, until the owner answers', () => {
    const owner = read('../src/inbox/owner.ts')
    assert.match(owner, /const offerShown = \(\) => !!info && !!key && !kept\(\) && !blocked && !offerDismissed && !!lookback/)
    const html = read('../index.html')
    assert.match(html, /<div class="keep-offer" id="ib-keep-offer" hidden>\s*<p><span data-copy="KEEP_OFFER"><\/span> <a href="\/about\/#inbox-keep" target="_blank" rel="noopener"/)
  })

  test('the words box doesn’t invite a browser to save the passphrase (the prompts got in the way)', async () => {
    const html = read('../index.html')
    // No form and no sign-in fields, but still a password box, so keyboards don't learn the words.
    assert.ok(!/<form id="oi-form"|id="oi-user"|autocomplete="(username|current-password)"/.test(html))
    assert.match(html, /<div id="oi-form">/)
    assert.match(html, /<input id="oi-words" class="pw-input" type="password" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" data-1p-ignore data-lpignore="true" \/>/)
    assert.match(html, /<button class="btn primary step-next" id="oi-go" type="button"/)
    const copy = await import('../src/inbox/inboxCopy.ts')
    assert.ok(!('OPEN_SAVE_NOTE' in copy))
    assert.ok(!html.includes('oi-save-note'))
    // Unlocked with the button, or Enter in one of its boxes, as the form was.
    const owner = read('../src/inbox/owner.ts')
    assert.match(owner, /\$\('oi-go'\)\.addEventListener\('click', unlock\)/)
    assert.match(owner, /\$\('oi-form'\)\.addEventListener\('keydown', \(e\) => \{\n    const box = e\.target\n    if \(e\.key !== 'Enter' \|\| e\.isComposing/)
    assert.match(owner, /function clearForm\(\) \{\n    wordsBox\.value = ''\n    showWords\(false\)/)
    // No password field anywhere asks to be saved or filled.
    for (const m of html.matchAll(/<input[^>]*type="password"[^>]*>/g)) assert.match(m[0], /autocomplete="off"/, m[0])
  })

  test('the main page offers to open or forget a kept inbox, knowing only how many there are', () => {
    const kept = read('../src/inbox/kept.ts')
    // Counting needs no words and never creates the database (reads never do).
    assert.match(kept, /export async function countKept\(\): Promise<number> \{\n  return \(await allKeys\(\)\)\.filter\(isRecord\)\.length/)
    assert.match(kept, /const isRecord = \(k: string\) => !k\.startsWith\(WORDS\) && !k\.startsWith\(SEALED\) && !k\.startsWith\(LABEL\)/)
    assert.match(kept, /export function forgetAllKept\(\): Promise<void> \{\n  return new Promise\(\(resolve, reject\) => \{\n    const req = indexedDB\.deleteDatabase\(DB_NAME\)/)
    const main = read('../src/main.ts')
    // Kept but not open: only on the plain composer, never to someone writing to an inbox or collecting a link.
    // Open in this tab: on the front page, going straight back in.
    assert.match(main, /const plain = view === 'compose' && !addressed && !open\n/)
    assert.match(main, /const show = open \? view === 'compose' \|\| view === 'delivered' : keptCount > 0 && plain\n/)
    assert.match(main, /\$\('kept-open'\)\.addEventListener\('click', \(\) => \{\n  if \(!owner\.isOpen\(\)\) \{/)
    // Straight in only for the one inbox kept here with its words remembered; otherwise the open screen.
    assert.match(main, /if \(keptCount === 1 && remembered\.length === 1\) return void openRememberedHere\(remembered\[0\]\.name/)
    // Several kept: those remembered here by name, one tap each; "Open another" only for the rest.
    assert.match(main, /const named = keptCount > 1 \? remembered : \[\]/)
    assert.match(main, /\$\('kept-open'\)\.hidden = named\.length > 0 && named\.length >= keptCount/)
    assert.match(main, /textContent: inboxCopy\.OPEN_REMEMBERED\(label \? isolate\(label\) : ''\)/)
    assert.match(main, /    location\.hash = OPEN_INBOX_ROUTE\n    return\n  \}\n  showInbox\(\)/)
    // Forget needs no words, so it's never offered for an inbox open in this tab: that's the inbox's own menu.
    assert.match(main, /\$\('kept-forget'\)\.hidden = open\n/)
  })

  test('no "leave this tab open until it has finished looking back": a kept inbox carries on where it stopped', async () => {
    const owner = read('../src/inbox/owner.ts')
    const copy = await import('../src/inbox/inboxCopy.ts')
    assert.ok(!('KEEP_FINISH' in copy))
    assert.ok(!/ib-keep-finish|fullLookback/.test(owner + read('../index.html')))
    assert.match(owner, /const plan = box\.lookbackPlan\(\)\n    resuming = plan\.skipTo !== undefined/)
  })

  test('a message to an inbox goes at once (the random moment is gone)', async () => {
    const { settings } = await import('../src/ui/settings.ts')
    assert.ok(!('randomSend' in settings()))
    const main = read('../src/main.ts')
    assert.ok(!/atRandom|randomSend|to-random|s-random/.test(main))
    assert.ok(!/s-random|to-random|random moment/.test(read('../index.html')))
    assert.ok(!/atRandom/.test(read('../src/core/client.ts') + read('../src/core/protocol.ts')))
    // The worker never asks for one; the core keeps it for file notices.
    assert.match(read('../src/core/worker.ts'), /c\.sendNotice\(req\.address, req\.bytes, req\.separate, progress, false, /)
    const core = read('../../core/transfer/inbox.go')
    assert.match(core, /func \(c \*Client\) SendNoticeAt\(to \*InboxAddress, kind byte, body \[\]byte, from \*From, reply \*ReplyKeys, when NoticeTiming, progress Progress\)/)
    // An upload's notice always waits (its 1-3 minutes keep the two apart).
    const bridge = read('../../core/cmd/wasm/inbox.go')
    assert.match(bridge, /when := transfer\.NoticeTiming\{AtRandom: true, Apart: len\(args\) > 7 && args\[7\]\.Truthy\(\)\}/)
    assert.match(bridge, /c\.SendNoticeAt\(to, transfer\.NoticeLink, link, from, reply, when, progress\)/)
    assert.match(bridge, /when := transfer\.NoticeTiming\{AtRandom: atRandom, Apart: len\(args\) > 9 && args\[9\]\.Truthy\(\)\}/)
    assert.match(bridge, /c\.SendNoticeAt\(to, kind, text, from, reply, when, progress\)/)
  })

  test('slynk.me is never where an inbox’s messages are kept, and the page says so plainly', async () => {
    const copy = await import('../src/inbox/inboxCopy.ts')
    assert.match(copy.PURPOSE_HELD, /^Messages never go to slynk\.me\./)
    assert.match(copy.OWNER_HELD, /^Messages never go to slynk\.me\./)
    assert.match(read('../about/index.html').replace(/\s+/g, ' '), /Messages never go to slynk\.me\. They wait, encrypted, on the xx network/)
  })

  test('a removed message is remembered only while the network could still bring it back', () => {
    const box = new Mailbox()
    const old = Date.now() - REMEMBER_REMOVED_MS - 3600_000
    box.add(text(1, 'old', old), false)
    box.add(text(2, 'recent'), false)
    box.remove(id(1))
    box.remove(id(2))
    assert.deepEqual(
      box.toKept().removed.map(([r]) => r),
      [id(2)],
    )
  })

  test('kept by a copy that collects uploads, opened where uploads aren’t collected: the link goes', () => {
    const box = new Mailbox()
    box.add(file(1), true)
    const back = Mailbox.fromKept(JSON.parse(JSON.stringify(box.toKept())), false)
    const item = back.get(id(1))!
    assert.equal(item.upload, undefined)
    assert.match(item.off!, /^[0-9a-f]{66}$/)
  })

  test('anything malformed is skipped, not trusted', () => {
    const back = Mailbox.fromKept(
      {
        label: 42,
        folders: [{ id: 'x', name: 'bad id' }, { id: 'f000000000001', name: 'Good' }, null],
        book: [{ address: 'not base64!', name: 'x' }, 7],
        items: [{ id: 'short' }, { id: id(1), kind: 1, body: 'aGk', sent: 1, at: 2, folder: 'nowhere', read: 'yes', title: 9 }, 'junk'],
        removed: [['a', 'b'], 5],
      },
      true,
    )
    assert.equal(back.label, '')
    assert.deepEqual(
      back.ownFolders().map((f) => f.name),
      ['Good'],
    )
    assert.equal(back.size, 1)
    const item = back.get(id(1))!
    assert.equal(item.folder, INBOX)
    assert.equal(item.read, false)
    assert.equal(item.title, '')
    assert.equal(new TextDecoder().decode(item.body), 'hi')
    assert.equal(Mailbox.fromKept(null, true).size, 0)
  })

  test('sealed with a key from the words, padded, and named so the device doesn’t say which inbox', async () => {
    const s = secret()
    const k = await keptKey(s)
    assert.ok(s.every((b) => b === 0), 'the core’s secret is wiped')
    assert.equal(k.name, '8110de99d8786acd8c2329f8658e53a3')
    assert.equal(k.key.extractable, false)
    const box = new Mailbox()
    box.add(text(1, 'a secret message'), false)
    const rec = await seal(k, box.toKept())
    assert.equal(rec.v, 1)
    assert.equal(rec.data.length % PAD, 16, 'a multiple of PAD, plus the tag')
    assert.ok(!Buffer.from(rec.data).toString('latin1').includes('secret'))
    const small = await seal(k, new Mailbox().toKept())
    assert.equal(small.data.length, rec.data.length, 'a message more or less doesn’t change the size')
    const back = Mailbox.fromKept(await unseal(k, rec), false)
    assert.equal(words(back, 1), 'a secret message')
  })

  test('another inbox’s key, a damaged record or a newer one can’t be read', async () => {
    const k = await keptKey(secret())
    const rec = await seal(k, new Mailbox().toKept())
    const other = await keptKey(secret(GOLDEN_STORE.replace(/^7a/, '7b')))
    const code = async (r: unknown, key = k) => {
      try {
        await unseal(key, r)
        return 'opened'
      } catch (e) {
        assert.ok(e instanceof KeptError)
        return e.code
      }
    }
    assert.equal(await code(rec, other), 'unreadable')
    const bent = { ...rec, data: rec.data.slice() }
    bent.data[5] ^= 1
    assert.equal(await code(bent), 'unreadable')
    assert.equal(await code({ ...rec, v: 2 }), 'unreadable')
    // A newer layout inside the same seal is left alone too.
    assert.equal(await code(await seal(k, { ...new Mailbox().toKept(), v: 2 } as never)), 'unreadable')
    assert.equal(await code(undefined), 'unreadable')
    assert.equal(await code(rec), 'opened')
  })
})

describe('the promise: nothing persists unless the owner asks', () => {
  const src = (dir: string): string[] =>
    readdirSync(new URL(dir, import.meta.url)).flatMap((f) => {
      const path = `${dir}/${f}`
      return statSync(new URL(path, import.meta.url)).isDirectory() ? (f === 'generated' ? [] : src(path)) : /\.ts$/.test(f) ? [path] : []
    })
  const files = src('../src')

  test('the browser’s storage is touched in two places only: remembered settings, and a kept inbox', () => {
    for (const f of files) {
      const s = read(f)
      if (/localStorage|sessionStorage|document\.cookie/.test(s)) assert.match(f, /ui\/settings\.ts$/, f)
      if (/indexedDB|IndexedDB/.test(s.replace(/^\s*\/\/.*$/gm, ''))) assert.match(f, /inbox\/kept\.ts$/, f)
    }
  })

  test('the words are remembered only when the owner asks, after the warnings, and forgotten with the inbox', async () => {
    const html = read('../index.html')
    const owner = read('../src/inbox/owner.ts')
    const keptTs = read('../src/inbox/kept.ts')
    // Off: both switches start unticked, and are unticked again.
    assert.match(html, /<input type="checkbox" class="switch" id="oi-remember" autocomplete="off" aria-describedby="oi-remember-warn" \/>/)
    assert.match(html, /<input type="checkbox" class="switch" id="ni-remember" autocomplete="off" aria-describedby="ni-remember-warn" \/>/)
    // Unticked again, the keep switch goes back to what it was (the review).
    assert.match(owner, /keepBox\.checked = keepChosen \|\| needed\n    keepBox\.disabled = needed/)
    assert.match(owner, /rememberBox\.addEventListener\('change', \(\) => \{\n[^}]*renderKeepBox\(\)\n  \}\)/)
    assert.match(owner, /rememberBox\.checked = false\n    \$\('oi-remember-warn'\)\.hidden = true/)
    assert.match(read('../src/inbox/create.ts'), /\$<HTMLInputElement>\('ni-remember'\)\.checked = false\n    \$\('ni-remember-warn'\)\.hidden = true/)
    // The warnings show as soon as it's switched on, and fill every place it's offered.
    assert.match(owner, /\$\('oi-remember-warn'\)\.hidden = !rememberBox\.checked/)
    assert.equal(html.match(/<ul class="remember-risks" data-risks><\/ul>/g)?.length, 3)
    // Written in one place, only while the inbox is kept here, and only when asked: as it opens, or after typing the words again.
    assert.equal(owner.match(/rememberWords\(/g)?.length, 1)
    assert.match(owner, /async function storeWords\(words: string, password = ''\): Promise<boolean> \{\n    const k = key\n    if \(!k \|\| !keeping\) return false/)
    assert.equal(owner.match(/storeWords\(/g)?.length, 3, 'defined, as it opens, and from the menu')
    assert.match(owner, /if \(opts\.remember && keeping\) await storeWords\(words, opts\.password\)/)
    // With a password, sealed before they're written; without one, as they are.
    assert.match(owner, /await rememberWords\(k\.name, password \? await sealWords\(words, password\) : words\.trim\(\), box\.label\)/)
    assert.match(owner, /if \(checked\.address\.length !== at\.length \|\| !checked\.address\.every/)
    // Beside the record, under its own prefix: as they are without a password (said plainly on the About
    // page), or sealed with one under another prefix; the label either way.
    assert.match(keptTs, /s\.put\(\{ v: 1, words \}, WORDS \+ name\)\n      s\.delete\(SEALED \+ name\)/)
    assert.match(keptTs, /s\.delete\(WORDS \+ name\)\n    \}\n    s\.put\(label, LABEL \+ name\)/)
    // Forgotten with Forget my passphrase, Forget this device (deleteKept), and the front page's Forget it (the whole database).
    // Forget this device: the record, its words and its label in one transaction, so words never outlive the inbox.
    assert.match(keptTs, /\(s\) => \{\n      s\.delete\(name\)\n      s\.delete\(WORDS \+ name\)\n      s\.delete\(SEALED \+ name\)\n      s\.delete\(LABEL \+ name\)\n    \},\n    false,/)
    // Forget my passphrase takes either kind.
    assert.match(keptTs, /s\.delete\(WORDS \+ name\)\n      s\.delete\(SEALED \+ name\)\n      s\.delete\(LABEL \+ name\)\n    \},\n    false,\n  \)\n\}\n\n\/\*\* The sealed record/)
    // A Forget or Lock during the write takes the words back out.
    assert.match(owner, /if \(key !== k \|\| !keeping\) \{\n      await forgetWords\(k\.name\)/)
    // Naming remembered inboxes never reads their words; opening reads only the one.
    assert.match(keptTs, /export async function rememberedInboxes\(\)/)
    assert.ok(!/rememberedInboxes\(\)[^\n]*words/.test(read('../src/main.ts')))
    assert.match(owner, /found = await readWords\(name\)/)
    // Telling which need a password reads keys only, never words.
    assert.match(keptTs, /\.\.\.keys\.filter\(\(k\) => k\.startsWith\(SEALED\)\)\.map\(\(k\) => \(\{ name: k\.slice\(SEALED\.length\), password: true \}\)\)/)
    // Lock and Forget say so when the words are remembered; Forget my passphrase asks first.
    assert.match(owner, /copy\.OWNER_LOCK_ASK\(kept\(\), remembered\)/)
    assert.match(owner, /remembered \? `\$\{copy\.FORGET_ASK\} \$\{copy\.FORGET_ASK_WORDS\}` : copy\.FORGET_ASK/)
    // Forget this device locks the inbox too, once what's kept is deleted,
    // waiting for what Lock waits for, and stays open if the deleting fails.
    const words = await import('../src/inbox/inboxCopy.ts')
    assert.match(words.FORGET_ASK, /deleted, and the inbox locks\./)
    assert.equal(words.FORGOTTEN, 'Forgotten on this device, and locked')
    assert.match(owner, /await deleteKept\(k\.name\) \/\/ its remembered words too\n\s+\} catch \{\n\s+deps\.toast\(copy\.KEEP_FAILED\)[\s\S]{0,120}return \$\('ib-more-go'\)\.focus\(\)\n\s+\}\n\s+blocked = false\n\s+remembered = false\n\s+if \(key !== k\) return \/\/ locked meanwhile\n\s+lock\(\)\n\s+deps\.toast\(copy\.FORGOTTEN\)/)
    assert.equal((owner.match(/const wait = forgetWait\(\)\n\s+if \(wait\) return deps\.toast\(wait\)/g) ?? []).length, 2, 'asked and confirmed only when Lock could go ahead')
    assert.match(read('../src/main.ts'), /inboxCopy\.KEPT_FORGET_ASK\(keptCount, remembered\.length > 0\)/)
    assert.match(owner, /if \(remembered\) items\.push\(\{ label: copy\.REMEMBER_FORGET, run: askForgetWords \}\)/)
    assert.match(html, /<div class="confirm" id="ib-words-ask" hidden>/)
    // On a touch screen the warnings come first: no jump past them to the words box (seen on an iPhone).
    assert.match(owner, /if \(matchMedia\('\(pointer: fine\)'\)\.matches\) return rememberField\.focus\(\)\n    const warn = \$\('ib-remember-warn'\)\n    warn\.scrollIntoView\(\{ block: 'start'/)
    assert.match(html, /<div class="remember-warn" id="ib-remember-warn" role="note" tabindex="-1">/)
    assert.match(owner, /await forgetWords\(k\.name\)/)
    // Counting kept inboxes never counts remembered words as inboxes.
    assert.match(keptTs, /return \(await allKeys\(\)\)\.filter\(isRecord\)\.length/)
  })

  test('keeping is off until the owner turns it on, and only Forget this device deletes it', () => {
    const html = read('../index.html')
    assert.match(html, /<input type="checkbox" class="switch" id="oi-keep" autocomplete="off" \/>/)
    const owner = read('../src/inbox/owner.ts')
    assert.match(owner, /keepBox\.checked = false/)
    // On a device that already keeps an inbox, the switch isn't shown: unticking it would
    // look like deleting it, which is the card's Forget this device.
    assert.match(read('../src/main.ts'), /owner\.clearForm\(\)\n(\s*\/\/[^\n]*\n)+    \$\('oi-keep-row'\)\.hidden = keptCount > 0/)
    // Restoring a backup's messages keeps the inbox here too (2026-10-24), said under the file as it's chosen.
    assert.match(owner, /const result = await open\(words, \{ keep: keepBox\.checked \|\| rememberBox\.checked \|\| !!restore, label, remember: rememberBox\.checked, password, restore \}\)/)
    assert.match(owner, /if \(parsed\.v === 2\) fileHoldsMessages\(true\)/)
    // Saving happens only while keeping: every write goes through startKeeping (fresh) or save().
    assert.equal(owner.match(/writeKept\(/g)?.length, 2)
    assert.match(owner, /function save\(\): Promise<void> \{\n    clearTimeout\(saveTimer\)\n    if \(!keeping \|\| !key\) return saving/)
    assert.equal(owner.match(/deleteKept\(/g)?.length, 1)
  })

  test('two tabs with the same inbox can’t overwrite each other, and the second promises nothing', () => {
    const owner = read('../src/inbox/owner.ts')
    assert.match(owner, /const rel = await holdKept\(k\.name\)/)
    assert.match(owner, /if \(!rel\) \{\n      elsewhere = true/)
    // Only the tab that saves says a removal sticks, or offers the address book.
    assert.match(owner, /copy\.READ_REMOVE\(keeping\)/)
    assert.match(owner, /copy\.REMOVE_ASK\(keeping\)/)
    assert.match(owner, /const withBook = \(\) => !!info && keeping\n/)
    // Switching keeping on reads what's kept and merges it before anything is written.
    const start = owner.slice(owner.indexOf('async function startKeeping'), owner.indexOf('function stopKeeping'))
    assert.ok(start.indexOf('readKept(') < start.indexOf('writeKept('))
    assert.match(start, /box\.merge\(stored\)/)
    assert.ok(start.indexOf('writeKept(') < start.indexOf('keeping = true'), 'a Lock meanwhile can’t write before the merge')
  })

  test('looking for a kept inbox leaves no trace: only keeping creates the database, and Forget removes it', () => {
    const kept = read('../src/inbox/kept.ts')
    assert.match(kept, /export const readKept = \(name: string\): Promise<unknown> => withStore\('readonly', \(s\) => s\.get\(name\)\)/)
    assert.match(kept, /create = mode === 'readwrite'/)
    assert.match(kept, /if \(!create && e\.oldVersion === 0\) \{\n        absent = true\n        req\.transaction\?\.abort\(\)/)
    assert.match(kept, /indexedDB\.databases\?\.\(\)/)
    assert.match(kept, /if \(left === 0\) \{\n    await new Promise<void>\(\(resolve\) => \{\n      const req = indexedDB\.deleteDatabase\(DB_NAME\)/)
    // Forget deletes without first creating: the delete itself never creates.
    assert.match(kept, /s\.delete\(name\)\n      s\.delete\(WORDS \+ name\)\n      s\.delete\(SEALED \+ name\)\n      s\.delete\(LABEL \+ name\)\n    \},\n    false,/)
  })

  test('a storage hiccup after a phone wakes is tried again on a fresh connection, and a save that fails out of sight is made again', async () => {
    // Safari can lose its storage while the screen is off: the first steps after fail, a fresh one works.
    const fake = fakeStorage()
    globalThis.indexedDB = fake as unknown as IDBFactory
    // The waits between tries pass on a clock of the test's own.
    mock.timers.enable({ apis: ['setTimeout'] })
    const settle = async <T>(p: Promise<T>): Promise<T> => {
      let done = false
      p.then(
        () => (done = true),
        () => (done = true),
      )
      while (!done) {
        await new Promise((r) => setImmediate(r))
        mock.timers.tick(500)
      }
      return p
    }
    try {
      const rec = { v: 1 as const, iv: new Uint8Array(12), data: new Uint8Array(16) }
      fake.failOpens = 2
      await settle(writeKept('a', rec))
      assert.equal(fake.opens, 3, 'two failed opens, then a third on a connection of its own')
      fake.failTransactions = 1
      assert.deepEqual(await settle(readKept('a')), rec)
      // Gone for good: it fails as before, after its tries, and nothing is half-written.
      fake.opens = 0
      fake.failOpens = 99
      await assert.rejects(settle(writeKept('b', rec)), (e) => e instanceof KeptError && e.code === 'unavailable')
      assert.equal(fake.opens, 3)
      assert.equal(fake.data.has('b'), false)
      // A record that can't be read isn't tried again: it isn't a hiccup.
      fake.failOpens = 0
      const k = await keptKey(secret())
      fake.opens = 0
      await assert.rejects(unseal(k, await settle(readKept('a'))), (e) => e instanceof KeptError && e.code === 'unreadable')
      assert.equal(fake.opens, 1)
    } finally {
      mock.timers.reset()
      delete (globalThis as { indexedDB?: unknown }).indexedDB
    }
    const owner = read('../src/inbox/owner.ts')
    const save = owner.slice(owner.indexOf('function save(): Promise<void>'), owner.indexOf("document.addEventListener('visibilitychange'"))
    assert.match(save, /if \(document\.visibilityState === 'hidden'\) \{\n          saveOnShow = true\n          return\n        \}\n        stopKeeping\(\)/)
    assert.match(owner, /if \(document\.visibilityState === 'visible' && saveOnShow\) \{\n      saveOnShow = false\n      if \(keeping\) void save\(\)/)
    assert.ok(!owner.includes('readKeptAgain'))
  })

  test('a kept record that can’t be read is left as it is, never overwritten', () => {
    const owner = read('../src/inbox/owner.ts')
    // Storage that doesn't answer is tried again (kept.ts); still nothing, and keeping isn't offered as
    // if nothing were kept (that offer was seen on a kept inbox).
    assert.match(owner, /const rec = await readKept\(key\.name\) \/\/ tried again on a hiccup \(kept\.ts\)/)
    assert.match(owner, /offerDismissed = true\n          deps\.toast\(copy\.KEEP_READ_FAILED\)/)
    assert.match(owner, /if \(e instanceof KeptError && e\.code === 'unreadable'\) blocked = true/)
    assert.match(owner, /if \(!key \|\| keeping \|\| blocked\) return false/)
  })

  test('remembering the words has a short answer of its own, after keeping, which the screens link to', () => {
    const about = seenOn(read('../about/index.html'))
    const keep = about.slice(about.indexOf('<details id="inbox-keep">'), about.indexOf('</details>', about.indexOf('<details id="inbox-keep">')))
    const answer = about.slice(about.indexOf('<details id="inbox-remember">'), about.indexOf('</details>', about.indexOf('<details id="inbox-remember">')))
    assert.ok(about.indexOf('<details id="inbox-remember">') > about.indexOf('<details id="inbox-keep">'))
    assert.match(answer, /<summary>Can Slynk remember my passphrase\?<\/summary>/)
    assert.match(answer, /saved as it is/)
    assert.match(answer, /can never be changed/)
    assert.match(answer, /Forget my passphrase on this device/)
    // The keeping answer is about keeping: it links to this one, and says nothing more of it.
    assert.match(keep, /<a href="#inbox-remember">ask Slynk to remember\s+it<\/a>/)
    assert.ok(!/saved as it is|Forget my passphrase/.test(keep))
    assert.equal(read('../index.html').match(/href="\/about\/#inbox-remember"/g)?.length, 3)
  })

  test('the About page says what changed, with the honest limits', () => {
    const about = seenOn(read('../about/index.html')).replace(/\s+/g, ' ')
    const keep = about.slice(about.indexOf('id="inbox-keep"'), about.indexOf('</details>', about.indexOf('id="inbox-keep"')))
    assert.match(keep, /off unless you switch it on/)
    assert.match(keep, /encrypted with a key worked out from your passphrase/)
    assert.match(keep, /Safari/)
    assert.match(keep, /seven days/)
    assert.match(keep, /private window/)
    assert.match(keep, /anyone who uses this browser will see that there\s+is one, and its name if its passphrase is remembered\. They still can’t read it without your passphrase,\s+unless that is remembered too/)
    assert.match(keep, /anyone with access to the device your inbox is kept on, and your passphrase, can read everything kept/i)
    assert.match(keep, /Forget this device/)
    assert.ok(!/Nothing is kept for you, on slynk\.me or in your browser/.test(about), 'the old promise is gone')
    assert.match(about, /browser’s history keeps the inbox’s link/)
    assert.match(keep, /Opening is quicker, too\. Your browser remembers how far back it has already looked/)
    assert.match(keep, /they might also guess that your inbox is kept on a device\. They can never see what’s in it/)
    // Password managers: Slynk doesn't invite them, and if one offers anyway, say no.
    assert.match(about, /Slynk asks your browser not to offer to save your passphrase\. If it offers anyway, it’s safest to say no: anyone who can use your saved passwords could then open your inbox too\./)
  })
})
