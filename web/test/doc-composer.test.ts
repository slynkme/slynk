// PDFs and Office files made smaller in the composer: what the sender
// reads, how a document shares the space and when it's made, and that its code
// and worker are fetched for every visitor. The shrinking itself needs a
// browser's canvases (pdf-shrink.test.ts and office-shrink.test.ts cover what
// runs without one); it was checked in Chromium with test files.
// Run from the repo root: npm --prefix web test
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import * as copy from '../src/shrinkCopy.ts'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const tray = read('../src/tray.ts') + read('../src/prep/list.ts') // the screen, and the file list it draws
const fn = (name: string) => {
  const start = tray.indexOf(`function ${name}(`)
  assert.ok(start >= 0, name)
  return tray.slice(start, tray.indexOf('\n  }\n', start))
}

test('what the sender reads about documents', () => {
  assert.equal(copy.whatSmaller({ photos: 2, videos: 1, docs: 1 }), 'your photos, video and document')
  assert.equal(copy.whatSmaller({ photos: 1, docs: 2 }), 'your photo and documents')
  assert.equal(copy.whatSmaller({ docs: 1 }), 'your document')
  assert.equal(copy.whatSmaller({ photos: 3, videos: 1 }), 'your photos and video', 'unchanged without documents')
  assert.equal(copy.AUTO_MIXED({ photos: 2, docs: 1 }), 'Slynk made your photos and document smaller to fit.')
  // Only some of a kind made smaller says how many.
  assert.equal(copy.AUTO_MIXED({ photos: 1, videos: 1, docs: 2 }, false, { photos: 4, videos: 1, docs: 3 }), 'Slynk made 1 of your photos, your video and 2 of your documents smaller to fit.')
  assert.equal(copy.AUTO_MIXED({ photos: 2, videos: 1, docs: 1 }, false, { photos: 2, videos: 1, docs: 1 }), 'Slynk made your photos, video and document smaller to fit.', 'all of each: as before')
  assert.equal(copy.whatSmaller({ photos: 1, docs: 1 }, { photos: 1, videos: 0, docs: 3 }), 'your photo and 1 of your documents')
  assert.equal(copy.OFFER_MIXED({ docs: 1 }), 'Slynk can make your document smaller to help it fit. Only the smaller version is sent.')
  assert.equal(copy.NO_FIT_VIDEO({ docs: 1 }), 'This document is too big to fit, even made smaller.')
  assert.equal(copy.NO_FIT_VIDEO({ photos: 3, docs: 1 }), 'Too much to fit, even made smaller. Remove the document or some photos.')
  assert.equal(copy.NO_FIT_VIDEO({ photos: 2, videos: 1, docs: 1 }), 'Too much to fit, even made smaller. Remove the video, the document or some photos.')
  assert.equal(copy.NO_FIT_VIDEO({ photos: 4, videos: 1 }), 'Too much to fit, even made smaller. Remove the video or some photos.', 'unchanged without documents')
  assert.equal(copy.WORKING_DOC(0.4, 1, 1), 'Making your document smaller… 40%')
  assert.equal(copy.WORKING_DOC(1, 2, 3), 'Making your documents smaller… 2 of 3, 99%')
  assert.equal(copy.DOC_NOTE(3, false), 'Made smaller: 3 of its pictures. Its text is unchanged.')
  assert.equal(copy.DOC_NOTE(1, true), 'Made smaller: 1 of its pictures, at a lower quality. Its text is unchanged.')
  assert.equal(copy.DOC_NOTE(0, false), 'Made smaller without changing its pictures or text.')
  assert.equal(copy.DOC_PROBLEM('signed', true), 'This PDF is signed, so making it smaller would break its signature.')
  assert.equal(copy.DOC_PROBLEM('locked', false), 'This document is locked with a password, so Slynk can’t make it smaller.')
  // Too big even at its smallest: how small it gets, and why only when that's so (most of it what's never made smaller).
  assert.equal(copy.DOC_PROBLEM('big', true, { smallest: 2_213_389, mostlyKept: false }), 'Even made smaller, this PDF is too big: about 2.21 MB at its smallest.')
  assert.equal(
    copy.DOC_PROBLEM('big', false, { smallest: 3_050_000, mostlyKept: true }),
    'Even made smaller, this document is too big: about 3.05 MB at its smallest. Most of that is text, fonts or other files, which Slynk leaves as they are.',
  )
  assert.equal(copy.DOC_PROBLEM('big', true), 'Even made smaller, this PDF is too big.')
})

test('a document is measured once, then made after the photos and before the videos', () => {
  const run = fn('makeSmallerCopies')
  assert.ok(run.indexOf('measureDocument(') < run.indexOf('planCopies('), 'measured before the plan')
  assert.ok(run.indexOf('makeCopy(') < run.indexOf('makeDocument('), 'after the photos')
  assert.ok(run.indexOf('makeDocument(') < run.indexOf('makeVideo('), 'before the videos')
  assert.match(run, /items\.some\(\(r\) => r\.doc && !r\.dmeasured\)/)
  // Made again only when its share has changed enough.
  assert.match(tray, /return made > target \|\| \(target >= made \* 1\.25 && row\.dmeasured!\.levels\[0\] > made \* 1\.05\)/)
  // One that came out too big for its share drops its older version, so it can't linger over the limit.
  assert.match(fn('makeDocument'), /row\.dcopy = made \? \{ \.\.\.made, target, stripped: !!row\.dstripped \} : undefined\n\s+row\.docProblem = made \? undefined : 'tight'/)
  // With the setting on, the lower qualities before giving up.
  assert.match(fn('makeDocument'), /if \(!made && !lower && settings\(\)\.shrink !== 'ask' && live\(\) && row\.dgen === gen\) made = await makeDoc\(row\.n, target, true, progress\)/)
  // A run that's over (a file added, the setting turned off) starts no more work: "working" can't stick.
  assert.match(run, /for \(const \[i, row\] of unmeasured\.entries\(\)\) \{\n\s+if \(!live\(\)\) return/)
  assert.match(run, /for \(const \[i, row\] of docsToMake\.entries\(\)\) \{\n[^\n]*\n\s+if \(!live\(\)\) return/)
})

test('a measure or make for bytes that changed meanwhile is thrown away (the review)', () => {
  // Ticking "Send original instead" or the cleaning setting while
  // it's measured or made: those sizes and that file are for bytes that won't be sent.
  assert.match(tray, /function resetDoc\(row: Row\) \{\n\s+row\.dgen = \(row\.dgen \?\? 0\) \+ 1/)
  assert.match(fn('processRow'), /if \(row\.doc\) resetDoc\(row\)/)
  assert.match(fn('measureDocument'), /if \(!rows\.includes\(row\) \|\| row\.dgen !== gen\) return\n\s+row\.dmeasured = m\n\s+row\.dstripped = input\.stripped/)
  assert.match(fn('makeDocument'), /if \(!live\(\) \|\| !rows\.includes\(row\) \|\| row\.dgen !== gen\) throw new DocError\('stopped'\)/)
  // Only this document's job is stopped, never another tray's.
  assert.match(tray, /job = \{ row, stop: \{ abort: \(\) => stopDoc\(row\.n\) \} \}/)
  assert.match(read('../src/docshrink/client.ts'), /current\.req\.session === session\) worker\.postMessage/)
  // Dropped after its last check: the worker keeps nothing.
  assert.match(read('../src/docshrink/session.ts'), /if \(stopping\) \{\n\s+if \(session\.kind === 'pdf'\) closePdf\(session\.s\)/)
})

test('a level’s share includes the margin a make needs, so the plan never gives one that can’t be made', () => {
  // None for a level already made and measured (a PDF's smallest, as it's sent): its size is known.
  assert.match(read('../src/docshrink/session.ts'), /levels: r\.levels\.map\(\(l\) => Math\.ceil\(l\.predicted \/ \('exact' in l && l\.exact \? 1 : MARGIN\)\)\)/)
  assert.match(read('../src/pdfshrink/shrink.ts'), /findIndex\(\(l\) => l\.predicted <= opts\.target \* \(l\.exact \? 1 : MARGIN\)\)/)
  for (const f of ['../src/pdfshrink/shrink.ts', '../src/officeshrink/shrink.ts']) {
    assert.match(read(f), /import \{[^}]*\bMARGIN\b[^}]*\} from '[./]*pdfshrink\/plan\.ts'|import \{[^}]*\bMARGIN\b[^}]*\} from '\.\/plan\.ts'/)
    assert.doesNotMatch(read(f), /const MARGIN = /)
  }
})

test('a document shares the space as photos do, from its measured sizes', () => {
  const shares = fn('shares')
  assert.match(shares, /const least = overheads\[i\] \+ \(lower \? m\.levels\[m\.levels\.length - 1\] : m\.levels\[m\.lowerFrom - 1\]\)/)
  assert.match(shares, /weight: Math\.max\(1, \(overheads\[i\] \+ m\.levels\[0\]\) \/ PHOTO_BYTES_PER_PIXEL\)/)
  // Not worth measuring when small, and never one that can't be made smaller.
  assert.match(tray, /const DOC_MIN = 200_000/)
  assert.match(tray, /\(!row\.docProblem \|\| row\.docProblem === 'tight'\) &&/)
})

test('a document (or a zip, or audio) may be read up to 60 MB, other files 25 MB; videos too big to go as they are are never read whole', () => {
  assert.match(tray, /const HOPELESS_SIZE = 25_000_000/)
  assert.match(tray, /const HOPELESS_DOC = 60_000_000/)
  assert.match(tray, /const hopeless = looksLikeDoc\(row\.file\) \|\| looksLikeAudio\(row\.file\) \|\| looksLikeZip\(row\.file\) \? HOPELESS_DOC : HOPELESS_SIZE/)
  // A zip's files were read with the zip, within the read budget.
  assert.match(tray, /if \(\(!row\.parent \|\| !row\.data\) && \(row\.file\.size > hopeless \|\| row\.file\.size > budget\)\) \{/)
  // The video check comes first, and returns before anything is read.
  const place = fn('place')
  assert.ok(place.indexOf("row.state = 'video'") < place.indexOf('HOPELESS_DOC'))
})

test('a document made smaller keeps its name and kind, and its own hidden details stay its own', () => {
  assert.match(tray, /const sentName = \(row: Row\) => \(inCopy\(row\) && !row\.dcopy \?/)
  assert.match(tray, /const sentType = \(row: Row\) => \(inCopy\(row\) && !row\.dcopy \?/)
  // The recipient's "made smaller, no hidden details" is for photos and videos only.
  assert.match(fn('compose'), /smaller: newPicture\(row\)/)
  // Made from what would be sent: cleaned or not, as the sender chose; choosing again measures it afresh.
  assert.match(fn('packRow'), /\? \{ data: row\.dcopy\.data, stripped: row\.dcopy\.stripped \}/)
  assert.match(tray, /original\.addEventListener\('change', \(\) => prep\.setOriginal\(row, original\.checked\)\)/)
  assert.match(fn('setOriginal'), /row\.useOriginal = on\n\s+if \(row\.doc\) resetDoc\(row\)/)
  assert.match(fn('processRow'), /if \(row\.doc\) resetDoc\(row\)/)
})

test('its worker and code are fetched for every visitor, and it runs beside the cleaner, not in its way', () => {
  // The code: one of the chunks the cleaner's worker loads as it starts (uniform-loading.test.ts).
  assert.match(read('../src/strip/formats.ts'), /import\('\.\.\/docshrink\/session\.ts'\),/)
  assert.match(read('../src/strip/stripWorker.ts'), /if \('doc' in e\.data\) \{/)
  // The worker: a second copy of the cleaner's own, started when a document first needs it.
  assert.match(read('../src/docshrink/client.ts'), /new Worker\(new URL\('\.\.\/strip\/stripWorker\.ts', import\.meta\.url\), \{ type: 'module' \}\)/)
  // Removed while it's measured or made: the worker stops and forgets it.
  assert.match(read('../src/docshrink/session.ts'), /if \(busy === req\.session\) stopping = true\n\s+close\(req\.session\)/)
  assert.match(fn('forgetRow'), /if \(row\.doc\) dropDoc\(row\.n\)/)
})

test('the setting and the About page say documents too', () => {
  assert.match(read('../index.html'), /<strong id="s-shrink-title">Shrink photos, media &amp; docs<\/strong>/)
  const about = read('../about/index.html').replace(/\s+/g, ' ')
  assert.match(about, /<details id="smaller-documents"> <summary>Can Slynk make a PDF or Word file smaller\?<\/summary>/)
  assert.match(about, /The text, fonts, links and layout stay exactly as they are\./)
  assert.match(about, /Making a document smaller doesn’t remove its hidden details, like its author/)
  assert.match(about, /A signed or password-locked file is never changed, and neither are older \.doc, \.xls and \.ppt files\./)
})
