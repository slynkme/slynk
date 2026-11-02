// Files to inboxes in the chat, behind INBOX_FILES in
// site.ts, off on slynk.me: the owner attaches files in a conversation with
// the composer's own tray (tray.ts), the upload goes from the tab's main
// identity and its notice from the second, the owner's message keeps its text
// and the files' names and sizes (never the files), and their files are
// collected in the conversation itself. Run: npm --prefix web test
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import * as copy from '../src/inbox/inboxCopy.ts'
import { Mailbox } from '../src/inbox/mailbox.ts'
import { fromBase64url } from '../src/linkv2.ts'
import { MAX_FILES, encode, fileNames, pack } from '../src/payload.ts'
import { INBOX_FILES } from '../src/site.ts'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const main = read('../src/main.ts')
const owner = read('../src/inbox/owner.ts')
const tray = read('../src/tray.ts') + read('../src/prep/list.ts') // the screen, and the file list it draws
const html = read('../index.html')
const between = (src: string, from: string, to: string) => {
  const a = src.indexOf(from)
  const b = src.indexOf(to, a + from.length)
  assert.ok(a >= 0 && b > a, `${from} … ${to}`)
  return src.slice(a, b)
}

function address(seed: number): Uint8Array {
  const a = new Uint8Array(33).fill(seed)
  a[0] = 3
  return a
}
const SAM = address(1)
const enc = (s: string) => new TextEncoder().encode(s)
const dec = (b: Uint8Array) => new TextDecoder().decode(b)

describe('what the owner’s own message keeps', () => {
  test('its text, and the files by name and size: never the files', async () => {
    const packed = [
      await pack({ kind: 'text', name: '', type: '', data: enc('Here they are') }),
      await pack({ kind: 'file', name: 'leaflet.pdf', type: 'application/pdf', data: new Uint8Array(5000).fill(7) }),
      await pack({ kind: 'file', name: 'form.txt', type: 'text/plain', data: enc('Name:') }),
    ]
    const notes = fileNames(packed)
    assert.deepEqual(notes, [
      { name: 'leaflet.pdf', size: 5000 },
      { name: 'form.txt', size: 5 },
    ])
    const box = new Mailbox()
    const bytes = encode(packed)
    const x = box.addSent(SAM, enc('Here they are'), 'Advice line', bytes.length, 1000, notes)
    box.sentDone(x.id, 2000)
    const kept = box.toKept().sent![0]
    assert.equal(kept.upload, bytes.length)
    assert.deepEqual(kept.files, notes)
    assert.equal(dec(fromBase64url(kept.body)), 'Here they are')
    // Nothing of the files' contents: the record's size is about its names, not 5 KB.
    assert.ok(JSON.stringify(kept).length < 400, 'no file bytes in the record')
    const back = Mailbox.fromKept(box.toKept(), true).thread(SAM)[0]
    assert.ok(back.kind === 'out')
    assert.deepEqual(back.sent.files, notes)
    assert.equal(dec(back.sent.body), 'Here they are')
  })

  test('only an upload has files; what was kept is checked, cut short and capped', () => {
    const box = new Mailbox()
    const plain = box.addSent(SAM, enc('hi'), '', undefined, 1000, [{ name: 'x', size: 1 }])
    assert.equal(plain.files, undefined, 'a text message has no files')
    const x = box.addSent(SAM, new Uint8Array(0), '', 900, 2000, [{ name: 'a.txt', size: 3 }])
    box.sentDone(plain.id, 1500)
    box.sentDone(x.id, 2500)
    const data = box.toKept()
    const k = data.sent!.find((s) => s.id === x.id)!
    const odd = [{ name: 'n'.repeat(1000), size: 4 }, { name: 7, size: 1 }, { name: 'neg', size: -1 }, null, { name: 'ok', size: 2 }]
    const many = Array.from({ length: MAX_FILES + 20 }, (_, i) => ({ name: `f${i}`, size: i }))
    for (const [files, expect] of [
      [odd, [{ name: 'n'.repeat(255), size: 4 }, { name: 'ok', size: 2 }]],
      [many, many.slice(0, MAX_FILES)],
      ['not a list', undefined],
    ] as const) {
      const back = Mailbox.fromKept({ ...data, sent: [{ ...k, files: files as never }] }, true).thread(SAM)[0]
      assert.ok(back.kind === 'out')
      assert.deepEqual(back.sent.files, expect)
    }
    // An older record, from before files in conversations, kept neither text nor names: it still opens, as "Files or a longer message".
    const { files: _, ...older } = k
    const back = Mailbox.fromKept({ ...data, sent: [{ ...older, body: '' }] }, true).thread(SAM)[0]
    assert.ok(back.kind === 'out' && back.sent.upload === 900 && !back.sent.files && !back.sent.body.length)
  })

  test('another tab’s record brings its names along, as copies', () => {
    const a = new Mailbox()
    const b = new Mailbox()
    const files = [{ name: 'notes.txt', size: 10 }]
    const x = b.addSent(SAM, enc('see attached'), '', 300, 1000, files)
    b.sentDone(x.id, 1100)
    a.merge(b)
    const e = a.thread(SAM)[0]
    assert.ok(e.kind === 'out')
    assert.deepEqual(e.sent.files, files)
    assert.notEqual(e.sent.files, b.getSent(x.id)!.files, 'not shared with the other mailbox')
  })
})

describe('the chat with files off (slynk.me)', () => {
  test('the switch is off here, and the chat shows no paperclip and no files', () => {
    assert.equal(INBOX_FILES, false)
    assert.match(html, /<button class="icon-btn chat-attach" id="ib-c-attach" type="button" hidden>/)
    assert.match(html, /<div class="chat-tray" id="ib-c-tray" hidden>/)
    assert.match(owner, /\$\('ib-c-attach'\)\.hidden = !INBOX_FILES/)
    assert.match(owner, /const uploadMode = \(\) => INBOX_FILES && !!chatWith && needsUpload\(/)
    assert.match(owner, /function addChatFiles\(files: File\[\]\) \{\n    if \(!INBOX_FILES \|\| !chatWith \|\| !files\.length\) return/)
    assert.match(owner, /dropFiles\(files: File\[\]\) \{\n      if \(INBOX_FILES && info && chatWith\) addChatFiles\(files\)/)
    assert.match(owner, /takesFiles: \(\) => INBOX_FILES && !!info && !!chatWith && !box\.isBlocked\(chatWith\),/)
  })

  test('a reply too long for one message can’t go, as before; there’s no hand-off to the composer', () => {
    assert.match(owner, /send\.disabled = wait \|\| !chatText\.value\.trim\(\) \|\| f\.over/)
    assert.ok(!owner.includes('deps.reply('))
    assert.ok(!html.includes('ib-c-draft-ask'))
    assert.ok(!('CHAT_LONGER' in copy) && !('READ_REPLY_DRAFT' in copy) && !('READ_BACK_CHAT' in copy))
  })
})

describe('attaching in the chat', () => {
  test('uses the composer’s own tray: one module, one cleaner', () => {
    assert.match(main, /const tray = createTray\(\{/)
    assert.match(owner, /const tray: Tray = createTray\(\{/)
    // Only the tray's file list cleans files, so the composer and the chat share the one cleaner worker.
    assert.match(tray, /import \{ cleanFile, suggestNeutralName, videoHeld, type Detail, type StripResult \} from '\.\.\/stripHook\.ts'/)
    assert.ok(!main.includes("from './stripHook'") && !owner.includes('stripHook'))
    // Nothing later can change an upload's limit, so copies aim for the whole of it.
    assert.match(owner, /limit: \(\) => DROP_LIMIT,\n      planLimit: \(\) => DROP_LIMIT,/)
  })

  test('each conversation keeps its own files until Lock', () => {
    assert.match(owner, /const trays = new Map<string, ChatTray>\(\)/)
    const wipe = between(owner, 'function wipeMessages()', '// --- Opening')
    assert.match(wipe, /for \(const t of trays\.values\(\)\) t\.tray\.close\(\)\n    trays\.clear\(\)/)
    assert.match(wipe, /for \(const id of \[\.\.\.outgoing\.keys\(\)\]\) forgetOutgoing\(id\)/)
  })

  test('the honest line shows the first time, until a first upload goes', () => {
    assert.match(html, /<p class="note upload-note" id="ib-c-honest" data-copy="TO_UPLOAD_HONEST" hidden><\/p>/)
    assert.match(owner, /\$\('ib-c-honest'\)\.hidden = honestDone/)
    assert.match(between(owner, 'async function sendUpload(', 'async function deliverUpload('), /honestDone = true/)
  })
})

describe('sending it', () => {
  const upload = between(owner, 'async function deliverUpload(', 'function forgetOutgoing(')

  test('the package uploads from the tab’s main identity; the notice goes from the second, never as text', () => {
    const up = between(main, 'uploadReply: async (bytes, onProgress) => {', 'noticeReply:')
    assert.match(up, /return await core\.upload\(bytes, settings\(\)\.variedBatches, onProgress\)/)
    const notice = between(main, 'noticeReply: async (address, v1, since, name, replyKeys) => {', 'canSend:')
    // With the reply keys they gave, if any: quantum-safe, in one message.
    assert.match(notice, /return await core\.sendFileNotice\(address, body, since, undefined, \{ name, replyKeys \}\)/)
    assert.match(notice, /body\.fill\(0\) \/\/ the worker has its own copy/)
    assert.ok(!notice.includes('sendNotice('))
  })

  test('never alongside a link’s send or collection, or anything being collected', () => {
    assert.match(main, /if \(transferring \|\| pendingDrop \|\| downloading\) throw new Error\(inboxCopy\.CHAT_BUSY\)/)
    assert.match(main, /canSend: \(upload\) => \(transferring \|\| pendingDrop \|\| \(upload && downloading\) \? inboxCopy\.CHAT_BUSY : ''\)/)
    assert.match(main, /if \(owner\.uploading\(\)\) return toast\(inboxCopy\.CHAT_UPLOAD_BUSY\)/)
    assert.match(main, /if \(replying \|\| owner\.uploading\(\)\) return toast\(inboxCopy\.CHAT_BUSY\)/)
    assert.match(owner, /if \(uploadsWaiting\(\)\) return deps\.toast\(copy\.CHAT_UPLOAD_BUSY\)/)
    // One at a time, in order, with text replies: the same queue.
    assert.match(owner, /x\.upload !== undefined\n            \? await deliverUpload\(x, run, keys\)/)
  })

  test('Try again uploads again only if it didn’t; once uploaded, only the notice goes', () => {
    assert.match(upload, /if \(!out\.v1\) \{\n      out\.done = 0\n      out\.total = 0\n      stages\.set\(x\.id, 'uploading'\)/)
    // Uploaded: the package is wiped, only its link is kept, to tell them.
    assert.match(upload, /out\.bytes\?\.fill\(0\)\n      out\.bytes = undefined/)
    assert.match(upload, /return deps\.noticeReply\(x\.address, out\.v1, out\.since, x\.name, keys\)/)
    assert.match(owner, /function forgetOutgoing\(id: string\) \{\n    const out = outgoing\.get\(id\)\n    out\?\.bytes\?\.fill\(0\)\n    out\?\.v1\?\.fill\(0\)/)
  })

  test('files they weren’t told about hold Lock and closing the tab: their link would be lost', () => {
    // Not one the owner stopped: they chose not to tell them.
    assert.match(owner, /const untold = \(\) => \[\.\.\.outgoing\]\.some\(\(\[id, out\]\) => !!out\.v1 && !stopped\.has\(id\)\)/)
    assert.match(owner, /return untold\(\) \? copy\.OWNER_LOCK_UNTOLD : ''/)
    assert.match(owner, /unsent: \(\) => sendingNow > 0 \|\| untold\(\)/)
    assert.match(main, /if \(pendingDrop \|\| owner\.unsent\(\)\) e\.preventDefault\(\)/)
  })

  test('a link tapped before files started uploading waits for them; Send checks again after packing', () => {
    assert.match(main, /while \(downloading \|\| owner\.uploading\(\)\) await new Promise/)
    const send = between(owner, 'async function sendUpload(', 'async function deliverUpload(')
    assert.ok(send.indexOf('const later = deps.canSend(true)') > send.indexOf('await packChatText()'))
    // A retry starts its percentage afresh.
    assert.match(upload, /if \(!out\.v1\) \{\n      out\.done = 0\n      out\.total = 0/)
  })

  test('a conversation’s files go with it, and its tray stops hearing settings', () => {
    assert.match(read('../src/ui/settings.ts'), /export function onSettings\(l: Listener\): \(\) => void \{/)
    assert.match(tray, /close\(\) \{\n      prep\.clear\(\)\n      unhear\(\)/)
    assert.match(owner, /function closeTray\(address: Uint8Array\) \{\n    trays\.get\(inboxKey\(address\)\)\?\.tray\.close\(\)/)
    assert.match(between(owner, 'function wipeMessages()', '// --- Opening'), /t\.tray\.close\(\)/)
  })

  test('the bubble says how it’s going', () => {
    assert.match(owner, /if \(stage === 'uploading'\) return copy\.CHAT_UPLOADING\(/)
    assert.match(owner, /if \(stage === 'telling'\) return copy\.CHAT_TELLING/)
    assert.equal(copy.CHAT_UPLOADING(40), 'Uploading… 40%')
    assert.equal(copy.CHAT_TELLING, 'Letting them know in a few minutes; keep this tab open.')
    assert.equal(copy.CHAT_TELL_FAILED, 'Uploaded, but they haven’t been told yet.')
  })

  test('the files’ names are shown as text, never as markup', () => {
    const files = between(owner, 'function sentFiles(', '// --- Uploads')
    assert.match(files, /li\.innerHTML = FILE_SVG \/\/ fixed markup/)
    assert.match(files, /className: 'bubble-file-name', textContent: f\.name/)
  })

  test('the composer’s own sends to an inbox keep the same: the text and the names', () => {
    assert.match(main, /text: message\?\.text \?\? '', files: fileNames\(c\.packed\)/)
    assert.match(owner, /const x = box\.addSent\(address, new TextEncoder\(\)\.encode\(text\), name, upload, Date\.now\(\), files\)/)
  })
})

describe('receiving in the conversation', () => {
  test('their files are collected right in the bubble, the message in them as plain text', () => {
    const bubble = between(owner, 'function bubble(', "// The conversation's menu")
    assert.match(bubble, /const d = dropFor\(i\)\n          renderDrop\(d\)\n          body\.append\(d\.el\)/)
    assert.match(owner, /: drop\.item\.from\n            \? chatMessage\(item\)/)
    assert.match(owner, /className: 'drop-msg', tabIndex: -1 \}\)\n    li\.append\(linkedText\(new TextDecoder\(\)\.decode\(item\.data\), 'inbox'\)\)/)
    // Copy in the message's menu, once collected.
    assert.match(bubble, /const words = text \|\| \(e\.kind === 'in' \? collectedText\(e\.item\.id\) : ''\)/)
  })

  test('open with care, once in the conversation; the focus stays put when the conversation is redrawn', () => {
    assert.match(owner, /if \(e\.kind === 'in' && e\.item\.upload && !cared\) \{/)
    assert.match(owner, /if \(was\?\.isConnected\) was\.focus\(\{ preventScroll: true \}\)/)
    // What was collected is drawn again only when it changes, so its Save buttons stay (with "Saved").
    assert.match(owner, /if \(drop\.drawn === drop\.items && \(drop\.items \|\| items\.hidden\)\) return\n    drop\.drawn = drop\.items/)
    // After collecting: a file's Save, else the message itself, never Forget.
    assert.match(owner, /\?\? list\.querySelector<HTMLElement>\('\.drop-msg, \.item'\)\)\?\.focus\(\)/)
  })
})
