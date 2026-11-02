// A zip in the composer (tray.ts): its photos, videos, audio and
// documents become rows of their own
// under it, cleaned and made smaller as they would be on their own, and the zip is written again
// from them as they go (zipInside.ts, tested in zip-inside.test.ts). The tray needs a page, so
// these read its source; the behaviour is checked in the browser.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import * as copy from '../src/shrinkCopy.ts'

// The composer's screen, and the file list it draws (prep/list.ts).
const screen = readFileSync(new URL('../src/tray.ts', import.meta.url), 'utf8')
const list = readFileSync(new URL('../src/prep/list.ts', import.meta.url), 'utf8')
const tray = screen + list
const fn = (name: string) => {
  const start = tray.indexOf(`function ${name}(`)
  assert.ok(start >= 0, name)
  return tray.slice(start, tray.indexOf('\n  }\n', start))
}
/** The file list's own function, where the screen has one of the same name (dropPlain). */
const inList = (name: string) => list.slice(list.indexOf(`function ${name}(`), list.indexOf('\n  }\n', list.indexOf(`function ${name}(`)))

test('a plain zip is read as a video is, never whole: its photos, videos, audio and documents become rows of their own', () => {
  const open = fn('openZip')
  assert.match(open, /const zip = await readZipIndex\(row\.file\)/)
  assert.match(open, /if \(!zip \|\| zip\.entries\.some\(\(e\) => e\.flags & 1\) \|\| !rows\.includes\(row\)\) return false/)
  assert.match(open, /if \(found\.length >= MAX_MEMBERS \|\| !rows\.includes\(row\)\) break/)
  // Videos and long recordings as Blobs, unpacked by the browser, within what may be unpacked.
  assert.match(open, /if \(kind === 'video' \|\| \(kind === 'wav' && e\.usize > HOPELESS_SIZE\)\) \{/)
  assert.match(open, /if \(e\.method === 8 && \(e\.usize > MAX_UNPACK \|\| unpacked \+ e\.usize > MAX_UNPACKED\)\) continue/)
  assert.match(open, /const file = new File\(\[await entryBlob\(zip, e, type\)\], name, \{ type \}\)/)
  // The rest read whole within the limits they'd have on their own.
  assert.match(open, /if \(e\.usize > Math\.min\(HOPELESS_DOC, budget\)\) continue/)
  // What's left, the skeleton, is the zip's own bytes: without its members, nor files too big to go even alone.
  assert.match(open, /const held = \[\.\.\.members, \.\.\.plain\.filter\(\(p\) => p\.tooBig\)\.map\(\(p\) => p\.entry\)\]/)
  assert.match(open, /row\.data = await skeleton\(zip, new Set\(held\), READ_BUDGET\)/)
  // Taken on before anything is read whole, as a video is.
  const place = fn('place')
  assert.ok(place.indexOf('await openZip(row)') < place.indexOf('row.read = true'))
  // The zip's own cleaning leaves them alone: they're cleaned as files of their own.
  assert.match(fn('processRow'), /const strip = await clean\(row\.data, row\.zip\?\.skip\)/)
  assert.match(tray, /const MAX_UNPACK = 1_000_000_000\nconst MAX_UNPACKED = 2_000_000_000/)
})

test('a zip waiting for one of its files to be made smaller is too big, as a video is, counted as it would go', () => {
  // The zip waited for that file: it's told when the file turns out too big to go as it is.
  assert.equal(fn('place').match(/if \(row\.parent\) track\(repack\(row\.parent\)\)/g)?.length, 2)
  assert.match(fn('packZip'), /row\.state = !base \? 'ready' : waiting \? 'packing' : tooBig \? 'video' : 'ready'/)
  assert.match(fn('compose'), /extra \+= own \+ inside/)
  // A small zip with nothing changed goes exactly as it was; otherwise each file is written from its own bytes.
  // Kept as it was when the sender keeps its details (exactly, if nothing changed); written afresh when it's cleaned.
  assert.match(fn('zipToSend'), /if \(keepsDetails\(row\)\) \{[\s\S]*?if \(same && z\.whole\) return \{ data: z\.whole, from, packed: new Map\(\) \}\n\s+return \{ \.\.\.keepZip\(base, files, z\.dropped\), from \}/)
  // A file the zip stored uncompressed, compressed in it now, says so on its row.
  assert.match(fn('packZip'), /o\.zipMade\?\.\(row, made\.packed\)/)
  assert.match(fn('showPacked'), /packed \? `\$\{size\(p\.usize\)\} → \$\{size\(packed\)\}`/)
})

test('the zip is made again from its files as they go, once it’s cleaned itself, and goes stored as it is', () => {
  assert.match(fn('packRow'), /if \(row\.zip\) \{\n\s+stopSqueeze\(row\)\n\s+return packZip\(row\)/)
  assert.match(fn('packRow'), /if \(row\.parent && rows\.includes\(row\.parent\)\) await repack\(row\.parent\)/)
  assert.match(fn('packZip'), /stored: \{ body: made\.data, method: 'as-is' \}/)
  assert.match(fn('zipToSend'), /const rebuilt = rebuildZip\(base, files, z\.dropped\)\n[^\n]*\n\s+return \{ \.\.\.rebuilt, from, unpacked: \(\) => unpackedZip\(base, files, z\.dropped, MAX_BROTLI, rebuilt\.data\.length \* 1\.2\) \}/)
  // One that can't be written again can't go, rather than stay "packing".
  assert.match(fn('packZip'), /catch \{[\s\S]*?row\.state = 'too-big'/)
})

test('its files count as their own shares of the space, and the list counts the zip as one file', () => {
  const compose = fn('compose')
  assert.match(compose, /if \(s\) rowWire\.set\(row, wireAs\(row, sentName\(row\), '', packedLength\(s\.data\) \?\? s\.data\.length\)\)/)
  // Taken out while the zip waits: no longer counted.
  assert.match(compose, /const gone = z\.gone\.filter/)
  assert.match(compose, /files: rows\.filter\(\(r\) => !r\.parent\)\.length/)
  // A zip not yet made from its files as they are now is still to come.
  assert.match(compose, /z\.members\.some\(\(m, i\) => memberData\(m\) !== z\.from!\[i\]\)\) pending = true/)
  assert.match(tray, /count: \(\) => rows\.filter\(\(r\) => !r\.parent\)\.length/)
  // Inside a zip, a file takes its bytes, a local header and a directory entry, each with its name.
  assert.match(tray, /return ZIP_ENTRY \+ 2 \* new TextEncoder\(\)\.encode\(dir \+ name\)\.length \+ length/)
})

test('every file in a zip is listed; one that goes as it is can be taken out too, and the zip is cleaned again without it', () => {
  const open = fn('openZip')
  assert.match(open, /if \(e\.name\.endsWith\('\/'\) \|\| systemName\(e\.name, e\.usize\)\) continue/)
  assert.match(open, /const plain = listed\.filter\(\(e\) => !members\.has\(e\.name\)\)\.map\(\(e\) => plainFile\(e\)\)/)
  // Listed under it on the screen; one too big to go even alone is shown at once, and holds the zip back while it's there.
  assert.match(open, /o\.zipOpened\?\.\(row\)/)
  assert.match(fn('showZip'), /if \(z\.plain\.some\(\(p\) => p\.tooBig\)\) showMembers\(row, true\)/)
  assert.match(fn('packZip'), /\|\| row\.zip!\.plain\.some\(\(p\) => p\.tooBig\)/)
  const drop = inList('dropPlain')
  assert.match(drop, /z\.dropped\.add\(p\.entry\)\n\s+if \(!z\.skip\.includes\(p\.entry\)\) z\.skip\.push\(p\.entry\)/)
  assert.match(drop, /track\(processRow\(zip\)\)/)
  assert.equal(copy.AS_IT_IS, 'goes as it is')
  assert.equal(copy.TOO_LARGE, 'too large to send')
  assert.equal(copy.ZIP_FILES({ others: 3 }), 'The 3 files inside')
  // The box says what's holding it back, not to remove a document.
  assert.match(fn('offer'), /if \(over && holding\) return \{ kind: 'held'/)
  assert.equal(copy.ZIP_TOO_BIG('samples.zip', 1), 'A file in samples.zip is too large to send. Take it out of the zip to send the rest.')
  assert.equal(copy.ZIP_TOO_BIG('samples.zip', 2), '2 files in samples.zip are too large to send. Take them out of the zip to send the rest.')
})

test('taking out the last of a zip’s files takes the zip out too, rather than send it empty', () => {
  assert.match(fn('remove'), /zip\.dropped\.add\(row\.entry!\)\n\s+if \(emptied\(row\.parent!\)\) return row\.parent/)
  assert.match(inList('dropPlain'), /if \(!z\.skip\.includes\(p\.entry\)\) z\.skip\.push\(p\.entry\)\n\s+if \(emptied\(zip\)\) return true/)
  const empty = fn('emptied')
  assert.match(empty, /if \(!z \|\| z\.members\.length \|\| z\.plain\.length\) return false/)
  assert.match(empty, /remove\(zip\)/)
  // The focus goes where the zip was, on the screen.
  assert.match(fn('removeRow'), /if \(zip\) return focusFrom\(tops, zip\)/)
  assert.match(fn('dropPlain'), /if \(prep\.dropPlain\(zip, p\)\) return void \(hadFocus && focusFrom\(tops, zip\)\)/)
})

test('taking one of its files off the list leaves it out of the zip; the zip takes its files with it', () => {
  const remove = fn('remove')
  assert.match(remove, /zip\.dropped\.add\(row\.entry!\)/)
  assert.match(remove, /for \(const m of row\.zip\?\.members \?\? \[\]\) \{/)
})

test('what the sender reads about a zip', () => {
  assert.equal(copy.ZIP_FILES({ photos: 4, audio: 1 }), 'The 4 photos and 1 audio file inside')
  assert.equal(copy.ZIP_FILES({ photos: 1 }), 'The photo inside')
  assert.equal(copy.ZIP_FILES({ photos: 2, videos: 1, docs: 3 }), 'The 2 photos, 1 video and 3 documents inside')
  assert.equal(copy.ZIP_FILES({ photos: 1, others: 1 }), 'The 1 photo and 1 other file inside')
  assert.equal(copy.ZIP_FILES({ others: 1 }), 'The file inside')
  assert.equal(copy.ZIP_NOTE({ photos: 3, audio: 1 }), 'Made smaller: 3 photos and 1 audio file inside.')
  assert.equal(copy.ZIP_NOTE({ docs: 1 }), 'Made smaller: 1 document inside.')
  assert.equal(copy.ZIP_REMOVE('a.jpg', 'trip.zip'), 'Remove a.jpg from trip.zip')
  const about = readFileSync(new URL('../about/index.html', import.meta.url), 'utf8')
  assert.match(about, /<summary>What does Slynk do with a zip\?<\/summary>/)
})

test('over the limit, the offer waits for stronger compression before making anything smaller: 10 s, or 20 when it might be enough', () => {
  const offer = fn('offer')
  const wait = offer.indexOf('brotliWaitLeft(c) > 0')
  // Not for "Smallest", whose run comes first: it makes them smaller whatever Brotli does.
  assert.ok(offer.indexOf('if (smallest && settled') < wait)
  assert.ok(wait > 0 && wait < offer.lastIndexOf('start: true') && wait < offer.indexOf('NO_FIT'))
  assert.match(offer, /return \{ kind: 'squeezing', look: 'busy', says: \[shrinkCopy\.SQUEEZING\] \}/)
  const left = fn('brotliWaitLeft')
  assert.match(left, /const enough = c\.wire - hope <= o\.limit\(\)/)
  assert.match(left, /\(enough \? BROTLI_WAIT_LONGER_MS : BROTLI_WAIT_MS\)/)
  assert.match(tray, /const BROTLI_WAIT_MS = 10_000\n  const BROTLI_WAIT_LONGER_MS = 20_000/)
  assert.equal(copy.SQUEEZING, 'Trying stronger compression first…')
  // It hears when Brotli is done, smaller or not, and only once the result is in place (updateRow ends with o.changed).
  assert.match(fn('squeezeRow'), /if \(rows\.includes\(row\)\) updateRow\(row\)/)
  assert.match(fn('updateRow'), /\n    o\.changed\(\)$/)
  assert.doesNotMatch(fn('endSqueeze'), /changed/)
})

// The adversarial review of 2026-10-26.
test('a zip sent unpacked counts at its unpacked size, and past MAX_DECODED every zip goes as it was written', () => {
  const compose = fn('compose')
  assert.match(compose, /const unpack = unpackedRaw <= MAX_DECODED/)
  assert.match(compose, /const stored: Stored = s\.stored\.unpacked !== undefined && !unpack \? \{ body: s\.data, method: 'as-is' \} : s\.stored\n\s+raw \+= stored\.unpacked \?\? s\.data\.length/)
  assert.match(compose, /rowWire\.set\(row, Math\.max\(0, \(rowWire\.get\(row\) \?\? 0\) - inside\)\)/)
})

test('Brotli stops at once where its work is over or wasted, and goes on for the same bytes', () => {
  for (const f of ['forgetRow', 'unsqueeze', 'stopSqueezing']) assert.match(fn(f), /stopSqueeze/, f)
  assert.match(fn('stopSqueeze'), /row\.squeezing\?\.abort\(\)\n\s+row\.squeezing = row\.squeezeFrom = row\.squeezeData = undefined/)
  assert.match(fn('packRow'), /if \(row\.squeezeData !== pick\?\.data\) stopSqueeze\(row\)/)
  assert.match(fn('squeezeRow'), /if \(row\.squeezing && row\.squeezeData === s\.data\) return/)
  assert.match(fn('squeezeRow'), /if \(!now \|\| now\.data !== s\.data/)
  // To be made smaller: no Brotli on the original. Zips: not while copies are made, then all at once.
  assert.match(fn('makeSmallerCopies'), /if \(row\.vqueued \|\| row\.dqueued \|\| row\.aqueued \|\| row\.pqueued\) stopSqueeze\(row\)/)
  assert.match(fn('squeezeZip'), /if \(!s \|\| !settings\(\)\.brotli \|\| shrinking/)
  assert.match(fn('makeSmallerCopies'), /unqueue\(\)\n\s+squeezeZips\(\)/)
})

test('the offer waits only while over, and in the 10 s case only for files that won’t be made smaller', () => {
  assert.match(fn('makeSmallerCopies'), /if \(auto && !smallest && now\.wire > o\.limit\(\) && brotliWaitLeft\(now\) > 0\) return/)
  assert.match(fn('brotliWaitLeft'), /const counted = enough \? busy : busy\.filter\(\(r\) => !shareable\(r\)\)/)
})

test('sending stops Brotli, for the message, the files and an inbox reply', () => {
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
  assert.match(main, /const brotli = usesBrotli\(c\.packed\)\n\s+stopSqueezing\(\)/)
  assert.match(main, /const bytes = encode\(c\.packed\)\n\s+stopSqueezing\(\)/)
  // One message job at a time; the switch swaps it in place.
  assert.match(main, /messageSqueeze\?\.abort\(\) \/\/ for the text as it was/)
  const owner = readFileSync(new URL('../src/inbox/owner.ts', import.meta.url), 'utf8')
  assert.match(owner, /chatSqueeze\?\.abort\(\)\n\s+tray\.stopSqueezing\(\)/)
  assert.match(owner, /chatSqueeze\?\.abort\(\) \/\/ for the text as it was/)
  assert.match(owner, /onSettings\(\(st\) => \{\n\s+if \(st\.brotli === brotliWasOn\) return/)
})

test('"Try again" runs one try at a time; a worker that failed is told from a damaged stream', () => {
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
  assert.match(main, /if \(trying\) return\n\s+trying = true\n\s+retry\.disabled = true/)
  const worker = readFileSync(new URL('../src/squeeze/squeezeWorker.ts', import.meta.url), 'utf8')
  assert.match(worker, /broken: !\/\^\(squeeze\|brotli\): \/\.test\(message\)/)
})
