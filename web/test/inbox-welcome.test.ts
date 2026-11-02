// The welcome message: the site's own message
// about the inbox, at the bottom of it until the owner removes it. Nobody sent
// it and it's never sent anywhere; kept on the device, a removal sticks, and
// otherwise it's back each time the inbox is unlocked. Run: npm --prefix web test
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { NOTICE_TEXT } from '../src/inbox/drop.ts'
import * as copy from '../src/inbox/inboxCopy.ts'
import { ARCHIVE, INBOX, Mailbox, WELCOME } from '../src/inbox/mailbox.ts'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const notice = (text: string) => ({ id: randomBytes(16).toString('hex'), kind: NOTICE_TEXT, body: new TextEncoder().encode(text), at: Date.now(), quantumSafe: false })

describe('the welcome message', () => {
  test('added unread at the bottom of the inbox, and never counted as a message that arrived or as news', () => {
    const box = new Mailbox()
    assert.equal(box.addWelcome(), true)
    assert.equal(box.addWelcome(), false, 'once')
    assert.equal(box.add(notice('Hello'), false), 'added')
    const rows = box.rows(INBOX)
    assert.equal(rows.length, 2)
    const last = rows.at(-1)
    assert.ok(last?.kind === 'message' && last.item.id === WELCOME, 'at the bottom')
    assert.equal(box.received, 1, 'the status line counts only what arrived')
    assert.equal(box.size, 1)
    assert.equal(box.unread(), 1, 'the front page’s count is news only')
    assert.equal(box.counts().get(INBOX)?.unread, 2, 'the Inbox folder shows it unread')
    // Its words are the page's own, never kept or sent.
    assert.equal(box.get(WELCOME)?.body.length, 0)
  })

  test('kept on the device: where it is and whether it’s read are kept, its words never; a removal sticks', () => {
    const box = new Mailbox()
    box.addWelcome()
    box.setRead(WELCOME, true)
    box.move(WELCOME, ARCHIVE)
    box.setTitle(WELCOME, 'How to use it')
    const kept = box.toKept()
    assert.deepEqual(kept.welcome, { read: true, folder: ARCHIVE, title: 'How to use it' })
    assert.ok(!kept.items.some((i) => i.id === WELCOME), 'never kept as a message')
    const again = Mailbox.fromKept(JSON.parse(JSON.stringify(kept)), false)
    assert.equal(again.addWelcome(), false, 'already back, as it was')
    assert.deepEqual({ read: again.get(WELCOME)?.read, folder: again.get(WELCOME)?.folder, title: again.get(WELCOME)?.title }, { read: true, folder: ARCHIVE, title: 'How to use it' })
    // Removed: kept as gone, and not added again.
    assert.equal(again.remove(WELCOME), true)
    const gone = Mailbox.fromKept(JSON.parse(JSON.stringify(again.toKept())), false)
    assert.equal(gone.toKept().welcome, 'gone')
    assert.equal(gone.addWelcome(), false)
    assert.equal(gone.get(WELCOME), undefined)
    // A record from before it existed: it's added as the inbox opens.
    const old = Mailbox.fromKept({ ...JSON.parse(JSON.stringify(new Mailbox().toKept())), welcome: undefined }, false)
    assert.equal(old.addWelcome(), true)
  })

  test('not kept: a removal lasts until the inbox is unlocked again, and says so', () => {
    const box = new Mailbox()
    box.addWelcome()
    assert.equal(box.remove(WELCOME), true)
    assert.equal(box.addWelcome(), false, 'gone for this visit')
    const next = new Mailbox()
    assert.equal(next.addWelcome(), true, 'back next time')
    assert.match(copy.WELCOME_REMOVE_ASK(false), /comes back each time you unlock your inbox, as your inbox isn’t kept on this device/)
    assert.match(copy.WELCOME_REMOVE_ASK(true), /won’t come back on this device/)
  })

  test('removed in another tab, removed here; a damaged record can’t put it in a folder that isn’t there', () => {
    const here = new Mailbox()
    here.addWelcome()
    const there = new Mailbox()
    there.addWelcome()
    there.remove(WELCOME)
    here.merge(there)
    assert.equal(here.get(WELCOME), undefined)
    assert.equal(here.welcomeGone, true)
    const odd = Mailbox.fromKept({ ...JSON.parse(JSON.stringify(new Mailbox().toKept())), welcome: { read: 'yes', folder: 'f000000000000', title: 42 } }, false)
    assert.deepEqual({ read: odd.get(WELCOME)?.read, folder: odd.get(WELCOME)?.folder, title: odd.get(WELCOME)?.title }, { read: false, folder: INBOX, title: '' })
  })

  test('on screen: from the site, with its coil, no time, no marker, no reply or copy, and its own removal question', () => {
    const owner = read('../src/inbox/owner.ts')
    assert.match(owner, /\/\/ The site's welcome at the bottom, unless the owner removed it \(kept here, it stays removed\)\.\n {4}box\.addWelcome\(\)/)
    assert.match(owner, /i\.id === WELCOME \? \[copy\.WELCOME_FROM\]/)
    assert.match(owner, /if \(welcome\) paintSite\(part\(li, 'avatar'\)\)/)
    assert.match(owner, /t\.textContent = welcome \? '' : rowTime\(r\.at\)/)
    assert.match(owner, /if \(welcome\) part\(li, 'mark'\)\.replaceChildren\(\)/)
    assert.match(owner, /\$\('ib-r-copy'\)\.hidden = welcome \|\|/)
    assert.match(owner, /\$\('ib-r-why'\)\.hidden = welcome \|\|/)
    assert.match(owner, /\$\('ib-r-remove-text'\)\.textContent = welcome \? copy\.WELCOME_REMOVE_ASK\(keeping\)/)
    assert.equal(copy.WELCOME_FROM, 'Slynk')
    assert.equal(copy.WELCOME_TITLE, 'Welcome to your inbox')
  })

  test('its words: what the inbox does, plainly, and true', () => {
    const all = copy.WELCOME_BODY.join(' ')
    assert.match(all, /without an account, a name or an email address/)
    assert.match(all, /up to about three weeks, so unlock your inbox at least once a week/)
    assert.match(all, /a padlock \(secure\) or an atom \(quantum-safe\)/)
    assert.equal(copy.WELCOME_BODY.at(-1), 'This message was generated in your browser: it wasn’t sent to your inbox. Remove it whenever you like.')
    assert.match(all, /Slynk is a small digital privacy project: free, with no accounts, ads or tracking, and here to help people protect their privacy and safety\./)
    assert.ok(!/from Slynk itself/.test(all))
    assert.ok(!/\b(we|us|our)\b/i.test(all), 'no "we" as the site’s voice')
    // Every button it names is labelled so.
    for (const name of [copy.OWNER_SHARE, copy.OWNER_LOCK, copy.COMPOSE]) assert.ok(all.includes(name) || all.includes(name.toLowerCase()), name)
    // Select is a tick box on a phone, with no word beside it: named by what it looks like.
    assert.match(all, /The tick box by the folders selects several at once/)
    // Messages open in place, and fold again.
    // Its words can be selected, so it's the top, or Close, that folds it.
    assert.match(all, /tap one to read it, and tap its top again or the Close button at the bottom to close it/)
    assert.ok(all.includes(copy.READ_CLOSE), 'names the Close button as it’s labelled')
    assert.ok(!/open one to read it\. From there/.test(all), 'no screen to go to any more')
  })
})
