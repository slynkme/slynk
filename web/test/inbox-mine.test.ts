// The owner's own messages without their inbox:
// one sent to another inbox with "Let them reply" off belongs to no
// conversation, so it's noted in Inbox like any message, kept with the inbox
// when it's kept, and its row says it went one way, out.
// Run: npm --prefix web test
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import * as copy from '../src/inbox/inboxCopy.ts'
import { ARCHIVE, INBOX, Mailbox } from '../src/inbox/mailbox.ts'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

function address(seed: number): Uint8Array {
  const a = new Uint8Array(33).fill(seed)
  a[0] = 3
  return a
}
const SAM = address(1)
const words = (t: string) => new TextEncoder().encode(t)
const text = (b: Uint8Array) => new TextDecoder().decode(b)

describe('the owner’s own messages, sent without their inbox', () => {
  test('noted in Inbox as a message of its own, read, and not counted as one that arrived', () => {
    const box = new Mailbox()
    const i = box.addMine(SAM, words('For your records'), 5000, undefined, undefined, 4000)!
    assert.equal(i.folder, INBOX)
    assert.equal(i.read, true)
    assert.deepEqual([...i.mine!.address], [...SAM])
    assert.equal(i.at, 5000, 'its round’s time')
    assert.equal(box.received, 0)
    assert.equal(box.unread(), 0)
    const rows = box.rows(INBOX)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].kind, 'message', 'in no conversation')
    assert.equal(box.thread(SAM).length, 0)
    // Its own copies: wiping what was passed in leaves it be.
    const typed = words('x')
    const j = box.addMine(SAM, typed, 0)!
    typed.fill(0)
    assert.equal(text(j.body), 'x')
  })

  test('files or a longer message: its text, and the files’ names and sizes only', () => {
    const box = new Mailbox()
    const i = box.addMine(SAM, words('The report'), 1, 120_000, [{ name: 'report.pdf', size: 119_000 }])!
    assert.equal(i.mine!.upload, 120_000)
    assert.deepEqual(i.mine!.files, [{ name: 'report.pdf', size: 119_000 }])
  })

  test('kept with the inbox, and read back the same; a damaged one is skipped, never shown as if it arrived', () => {
    const box = new Mailbox()
    box.addMine(SAM, words('kept'), 7000, 5, [{ name: 'a.txt', size: 5 }])
    const data = box.toKept()
    assert.deepEqual(Object.keys(data.items[0].mine!).sort(), ['files', 'to', 'upload'])
    const back = Mailbox.fromKept(JSON.parse(JSON.stringify(data)), false)
    const [i] = back.all()
    assert.equal(text(i.body), 'kept')
    assert.deepEqual([...i.mine!.address], [...SAM])
    assert.deepEqual(i.mine!.files, [{ name: 'a.txt', size: 5 }])
    assert.equal(i.read, true)
    assert.equal(i.from, undefined)
    const damaged = { ...data, items: [{ ...data.items[0], mine: { to: 'AAAA' } }] }
    assert.equal(Mailbox.fromKept(damaged, false).size, 0)
  })

  test('filed, merged from another tab, and removed for good like any message', () => {
    const a = new Mailbox()
    const b = new Mailbox()
    const i = b.addMine(SAM, words('from the other tab'), 1)!
    a.merge(b)
    assert.equal(a.get(i.id)?.mine !== undefined, true)
    assert.ok(a.move(i.id, ARCHIVE))
    assert.ok(a.remove(i.id))
    // The other tab's record doesn't bring it back.
    a.merge(Mailbox.fromKept(b.toKept(), false))
    assert.equal(a.get(i.id), undefined)
  })

  test('Lock wipes it', () => {
    const box = new Mailbox()
    const i = box.addMine(SAM, words('gone'), 1)!
    const body = i.body
    box.wipeAll()
    assert.ok(body.every((b) => b === 0))
  })
})

describe('where it’s noted, and what the screens say', () => {
  test('only a message without the owner’s inbox, sent from a tab where it’s open', () => {
    const main = read('../src/main.ts')
    assert.match(main, /const noted = !include && owner\.noteMine\(to\.address, text, at\)/)
    assert.match(main, /const noted = !p\.include && owner\.noteMine\(p\.to\.address, p\.text, at, p\.size, p\.files\)/)
    assert.match(read('../src/inbox/owner.ts'), /noteMine\(address: Uint8Array, text: string, at: number, upload\?: number, files\?: FileNote\[\]\): boolean \{\n\s+if \(!info\) return false/)
  })

  test('its row says which way it went, beside conversations and messages that arrived', () => {
    assert.deepEqual(copy.ROW_KIND, { thread: 'Conversation', in: 'One-way, received', out: 'One-way, sent by you' })
    assert.equal(copy.ROW_MINE, 'Your message')
    assert.match(copy.MINE_NOTE, /without letting them reply/)
    // Then a faint link to write to the same inbox again, as New message does.
    assert.equal(copy.MINE_WRITE_AGAIN, 'Write to them again')
    const owner = read('../src/inbox/owner.ts')
    assert.match(owner, /className: 'soft-link', textContent: copy\.MINE_WRITE_AGAIN \}\)\n {8}const to = i\.mine\.address\n {8}again\.addEventListener\('click', \(\) => void writeTo\(to\)\)/)
  })

  test('opened, it can show the inbox it went to in full, as the composer does, to check later', () => {
    const owner = read('../src/inbox/owner.ts')
    assert.match(owner, /\$\('ib-r-address'\)\.textContent = i\.mine \? inboxLink\(LINK_ORIGIN, i\.mine\.address\) : ''/)
    assert.match(read('../index.html'), /id="ib-r-address-go" type="button" aria-expanded="false" aria-controls="ib-r-address" data-copy="TO_SHOW_ADDRESS" hidden>/)
  })

  test('the About page says the owner’s own are kept too', () => {
    const about = read('../about/index.html').replace(/\s+/g, ' ')
    assert.match(about, /messages you sent without letting them reply/)
  })
})
