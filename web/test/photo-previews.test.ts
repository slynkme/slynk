// "Show photo previews" (on by default): a small picture of each photo in the
// file list, which opens the photo as it will be sent, fitted or at actual
// size. Drawn on canvases from memory only. The drawing needs a page, so these
// read the source; the behaviour is checked in the browser.
// Run from the repo root: npm --prefix web test
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import * as copy from '../src/shrinkCopy.ts'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const view = read('../src/ui/photoView.ts')
const tray = read('../src/tray.ts') + read('../src/prep/list.ts') // the screen, and the file list it draws
const html = read('../index.html')
const about = read('../about/index.html').replace(/\s+/g, ' ')

test('on by default, with a switch in Settings', () => {
  assert.match(read('../src/ui/settings.ts'), /\n  photoPreviews: true,\n/)
  assert.match(html, /<strong>Show photo, media and document previews<\/strong>[\s\S]{0,300}<input type="checkbox" class="switch" id="s-previews" \/>/)
  assert.match(read('../src/main.ts'), /\$\('s-previews'\)\.addEventListener\('change'/)
})

test('photos drawn on canvases from memory; a video plays from a blob: address only the player gets, let go of on closing; nothing stored', () => {
  // The CSP allows no blob: images; a canvas needs no CSP at all.
  assert.doesNotMatch(view, /localStorage|indexedDB/)
  assert.match(view, /createImageBitmap\(new Blob\(\[data as BlobPart\], \{ type \}\)\)/)
  assert.match(html, /<button class="thumb" type="button" data-part="thumb" hidden><canvas><\/canvas><svg class="thumb-zoom" [^>]*aria-hidden="true">/)
  // The only blob: addresses: a video or audio in the viewer's player (media-src blob:; audio since 2026-10-25).
  assert.equal(view.match(/createObjectURL/g)?.length, 2)
  assert.equal(view.match(/\.src\s*=/g)?.length, 2)
  assert.match(view, /video\.src = url/)
  assert.match(view, /audio\.src = url/)
  assert.match(view, /if \(playing\) URL\.revokeObjectURL\(playing\)/)
  assert.match(view, /URL\.revokeObjectURL\(hearing\.url\)/)
  assert.match(view, /releaseThumb\(\$<HTMLCanvasElement>\('pv-canvas'\)\)\n\s+stopVideo\(\)\n\s+stopAudio\(\)/)
  // A document's text (2026-10-24) and audio (2026-10-25) have places of their own in the viewer too.
  // A video's own controls (2026-10-25): no browser controls, which on an iPhone darken the picture.
  assert.match(html, /<div class="viewer-body" id="pv-body"><canvas id="pv-canvas"><\/canvas><div class="video-view" id="pv-video-box" hidden><div class="video-stage" id="pv-stage"><video id="pv-video" playsinline preload="metadata"><\/video>/)
  assert.match(html, /<\/div><div class="audio-view" id="pv-audio-box" hidden><canvas id="pv-wave"><\/canvas><audio id="pv-audio" controls preload="metadata"><\/audio><\/div><div class="doc-view" id="pv-doc" hidden><\/div><\/div>/)
  // The CSP: media from the page's own blob: addresses, and still no blob: pictures.
  const csp = read('../public/.htaccess').match(/Content-Security-Policy "([^"]+)"/)![1]
  assert.match(csp, /; media-src blob:; /)
  assert.match(csp, /; img-src 'self' data:; /)
})

test('it shows what will be sent, and lets go of the pixels when done', () => {
  const sync = tray.slice(tray.indexOf('function syncThumb('), tray.indexOf('\n  }\n', tray.indexOf('function syncThumb(')))
  // An SVG drawing too (2026-10-26, svg-previews.test.ts).
  assert.match(sync, /settings\(\)\.photoPreviews && \(row\.photo \|\| row\.svg \|\| row\.video \|\| doc \|\| audio\) && row\.sending \? row\.sending\.data : undefined/)
  // Audio too big to go as it is waits for its smaller version: its outline would mean decoding all of it.
  assert.match(sync, /const audio = !!row\.audio && \(inCopy\(row\) \|\| !fullTooBig\(row\)\)/)
  assert.match(sync, /const ok = await \(row\.video \? drawVideoThumb\(canvas, data, type\) : doc \? drawDocThumb\(canvas, data, doc\) : row\.audio \? drawAudioThumb\(canvas, data, peaks\) : drawThumb\(canvas, data, type\)\)/)
  // One at a time: each decodes the whole photo.
  assert.match(sync, /thumbQueue = thumbQueue\.then\(/)
  // The very bytes that will go, and whether they're a smaller copy (the header says which).
  assert.match(tray, /const show = row\.video \? showVideo : showPhoto\n\s+if \(!\(await show\(sentName\(row\), row\.sending\.data, sentType\(row\), kind, as\)\)\) o\.toast\(row\.video \? shrinkCopy\.VIEW_CANT_VIDEO : row\.svg \? shrinkCopy\.VIEW_CANT_SVG : shrinkCopy\.VIEW_CANT\)/)
  // The name and size open it too (the small picture is hard to hit on a phone), once it has a picture.
  assert.match(tray, /part\(li, 'meta'\)\.addEventListener\('click', \(\) => \{\n\s+if \(li\.classList\.contains\('previewable'\)\) void preview\(\)/)
  assert.match(sync, /row\.li\.classList\.toggle\('previewable', ok\)/)
  assert.match(html, /<span class="item-meta" data-part="meta"><strong data-part="name"><\/strong>/)
  // Once a row is off the list (the file list's forgetRow), the screen lets go of what it showed.
  assert.match(tray, /function forgetRow\(row: Row\) \{[^}]*o\.forgot\?\.\(row\)/)
  const forget = tray.slice(tray.indexOf('function dropView('), tray.indexOf('\n  }\n', tray.indexOf('function dropView(')))
  assert.match(forget, /releaseThumb\(/)
  assert.match(tray, /forgot: dropView,/)
  // As it closes (the close button, or Escape), never from the late close event, which blanked a
  // photo opened again quickly, or never came.
  assert.match(view, /const release = \(\) => \{\n\s+shown = undefined\n\s+save = undefined\n\s+share = undefined\n\s+releaseThumb\(\$<HTMLCanvasElement>\('pv-canvas'\)\)/)
  assert.match(view, /addEventListener\('click', \(\) => \{\n\s+d\.close\(\)\n\s+release\(\)/)
  assert.match(view, /d\.addEventListener\('cancel', release\)/)
  // The late close event only lets the page behind go, and only once the viewer is shut (2026-10-25).
  assert.equal(view.match(/addEventListener\('close'/g)?.length, 1)
  // Closed without a cancel (Chrome folds one into the next): a video or audio stops too, its address let go of.
  assert.match(view, /d\.addEventListener\('close', \(\) => \{\n    if \(d\.open\) return\n[^\n]*\n    stopVideo\(\)\n    stopAudio\(\)\n    putPageBack\(\)\n  \}\)/)
})

test('plain words, and the About page says how', () => {
  assert.equal(copy.PREVIEW('IMG_1234.jpg'), 'See IMG_1234.jpg as it will be sent')
  assert.equal(copy.VIEW_ABOUT({ width: 2048, height: 1536 }, '472 KB', 'copy').replace(/\u00a0/g, ' '), 'As it will be sent: made smaller, 2048 × 1536 pixels, 472 KB')
  assert.equal(copy.VIEW_ABOUT({ width: 1200, height: 900 }, '264 KB', 'full').replace(/\u00a0/g, ' '), 'As it will be sent: full size, 1200 × 900 pixels, 264 KB')
  assert.equal(copy.VIEW_ABOUT({ width: 1200, height: 900 }, '83 KB', 'received').replace(/\u00a0/g, ' '), 'Received: 1200 × 900 pixels, 83 KB')
  // Not "Actual size": it read as the original's size, when it's the copy's own pixels.
  assert.equal(copy.VIEW_ZOOM, 'Zoom in')
  assert.equal(copy.VIEW_FIT, 'Fit to screen')
  assert.match(about, /Tap a photo’s small picture or its name to see it as it will be sent, and zoom in to check the quality \(“Show photo, media and document previews” in Settings\)\./)
})

test('received photos get small pictures too, and the viewer saves them as their Save button does', () => {
  const items = read('../src/ui/items.ts')
  assert.match(items, /if \(photoInfo\(item\.data\) \|\| isSvgPicture\(item\.data\) \|\| isVideo\(item\.data\) \|\| docPreviewOf\(item\.data\) \|\| isAudio\(item\.data\)\) previewRow\(li, item, name, \{ save: \(\) => save\(item, button\), share: onShare \}\)/)
  assert.match(items, /\(video \? showVideo : showPhoto\)\(name, item\.data, item\.type, 'received', actions\)/)
  const main = read('../src/main.ts')
  assert.match(main, /\(isVideo\(item\.data\) \? showVideo : showPhoto\)\(name, item\.data, item\.type, 'received', actions\)/)
  assert.match(main, /receivedThumb\(undefined\)/) // let go of when what arrived is wiped
  assert.match(html, /<button class="icon-btn" id="pv-save" type="button" hidden>/)
  assert.equal(copy.VIEW_SAVE('beach.jpg'), 'Save beach.jpg')
  assert.equal(copy.PREVIEW_RECEIVED('beach.jpg'), 'See beach.jpg')
  assert.equal(copy.VIEW_CANT_VIDEO, 'This browser can’t play this video.')
  // Videos too: MP4 and MOV, by their first bytes.
  assert.match(items, /export const isVideo = \(data: Uint8Array\) => \['mp4', 'mov'\]\.includes\(detectKind\(data\.subarray\(0, 64\)\) \?\? ''\)/)
})

test('PDFs get previews too, drawn by pdf.js: a small first page, and the viewer page by page (2026-10-22)', () => {
  const html = read('../index.html')
  assert.match(html, /<strong>Show photo, media and document previews<\/strong>/)
  // The page buttons on the page's sides since 2026-10-24 (docview.test.ts): along the bottom, an iPhone's
  // first tap only brought back Safari's toolbar.
  assert.ok(html.indexOf('id="pv-body"') < html.indexOf('id="pv-prev"'), 'over the page')
  const view = read('../src/ui/photoView.ts')
  assert.match(view, /export async function showPdf\(name: string, data: Uint8Array, kind: shrinkCopy\.ViewKind, actions: ViewActions = \{\}\)/)
  assert.match(view, /export async function drawPdfThumb\(canvas: HTMLCanvasElement, data: Uint8Array\)/)
  // Let go of as the viewer closes, or another photo, video or PDF takes its place.
  assert.match(view, /stopVideo\(\)\n\s+stopAudio\(\)\n\s+closePdf\(\)\n\s+\$\('pv-doc'\)\.replaceChildren\(\)\n\s+putPageBack\(\)\n\s+\}/)
  assert.equal(copy.VIEW_ABOUT_PDF(1, 4, '1.03 MB', 'copy'), 'Page 1 of 4 · As it will be sent: made smaller, 1.03 MB')
  assert.equal(copy.VIEW_ABOUT_PDF(1, 1, '86 KB', 'received'), 'Received: 1 page, 86 KB')
  assert.equal(copy.VIEW_PAGE(2, 5), 'Page 2 of 5')
  // In the composer, the received list and the single file that arrived.
  // As one of the documents showDoc shows (an RTF's text too, 2026-10-24).
  assert.match(view, /if \(which === 'pdf'\) return showPdf\(name, data, kind, actions\)/)
  assert.match(read('../src/tray.ts'), /if \(doc\) \{\n\s+if \(!\(await showDoc\(sentName\(row\), row\.sending\.data, doc, kind, as\)\)\) o\.toast\(doc === 'pdf' \? shrinkCopy\.VIEW_CANT_PDF : shrinkCopy\.VIEW_CANT_DOC\)/)
  assert.match(read('../src/ui/items.ts'), /const open = \(\) =>\n\s+void \(doc\n\s+\? showDoc\(name, item\.data, doc, 'received', actions\)/)
  assert.match(read('../src/main.ts'), /if \(doc\) void showDoc\(name, item\.data, doc, 'received', actions\)/)
})

test('the page behind the viewer stays put while it’s open, and is where it was after (seen on an iPhone, 2026-10-25)', () => {
  const view = read('../src/ui/photoView.ts')
  // Every way the viewer opens holds the page; nothing opens it around that.
  assert.equal(view.match(/\.showModal\(\)/g)?.length, 1)
  assert.match(view, /function show\(d: HTMLDialogElement\) \{\n  if \(d\.open\) return\n  pageY = window\.scrollY\n  d\.showModal\(\)/)
  assert.equal(view.match(/^  show\(d\)$/gm)?.length, 5)
  // Held by the style sheet while the viewer is open (nothing can leave it held), and put back where it was.
  assert.match(read('../src/style.css'), /html:has\(#photo-view\[open\]\),\nhtml:has\(#photo-view\[open\]\) body \{\n  overflow: hidden;\n  overscroll-behavior: none;\n\}/)
  assert.match(view, /\$\('pv-doc'\)\.replaceChildren\(\)\n    putPageBack\(\)/)
  assert.match(view, /d\.addEventListener\('close', \(\) => \{\n    if \(d\.open\) return\n[^\n]*\n    stopVideo\(\)\n    stopAudio\(\)\n    putPageBack\(\)/)
  assert.match(view, /window\.scrollTo\(\{ top: pageY, behavior: 'instant' \}\)/)
})

test('a PowerPoint or Excel file says it can’t be shown here, when its name is tapped (a Word, Writer or RTF document with no text too)', () => {
  assert.equal(copy.DOC_NO_PREVIEW, 'Slynk can’t show this document here. Open it in its own app to see it.')
  assert.equal(copy.DOC_NO_PREVIEW_RECEIVED, 'Slynk can’t show this document here. Save it to see it in Word, Pages or another app.')
  assert.match(read('../src/tray.ts'), /else if \(row\.doc === 'office' && settings\(\)\.photoPreviews && \(!docPreviewOf\(row\.data \?\? new Uint8Array\(\)\) \|\| \(!!row\.thumbTried && row\.thumbTried === row\.sending\?\.data\)\)\)\n\s+tip\(part\(li, 'meta'\), shrinkCopy\.DOC_NO_PREVIEW\)/)
  assert.match(read('../src/ui/items.ts'), /else if \(docKindOf\(item\.data\) === 'office'\) part\(li, 'meta'\)\.addEventListener\('click', \(\) => tip\(part\(li, 'meta'\), shrinkCopy\.DOC_NO_PREVIEW_RECEIVED\)\)/)
  // Not a blank text file (2026-10-26): Word wouldn't help.
  assert.match(read('../src/ui/items.ts'), /else if \(tried && doc && doc !== 'pdf' && doc !== 'text'\) tip\(part\(li, 'meta'\), shrinkCopy\.DOC_NO_PREVIEW_RECEIVED\)/)
  // The note: placed from script (no style attributes), closed by the next tap, Escape or a scroll.
  const tip = read('../src/ui/tip.ts')
  assert.match(tip, /note\.setAttribute\('role', 'status'\)/)
  assert.match(tip, /window\.addEventListener\('scroll', closeTip, true\)/)
})

test('a video plays with the viewer’s own controls over a still from it: an iPhone’s own darken the picture', () => {
  const view = read('../src/ui/photoView.ts')
  // No browser controls; in the page, not an iPhone's full-screen player; a fresh player each time.
  assert.doesNotMatch(html, /<video[^>]* controls/)
  assert.match(view, /function freshVideo\(\): HTMLVideoElement \{[\s\S]*?video\.playsInline = true[\s\S]*?\$\('pv-video'\)\.replaceWith\(video\)/)
  assert.doesNotMatch(view, /video\.controls = true/)
  assert.match(view, /const video = freshVideo\(\)/)
  // Tap the picture to play or pause; the big button and the bar's do the same; the bar goes to a moment and plays from there.
  assert.match(view, /\$\('pv-stage'\)\.addEventListener\('click'/)
  assert.match(view, /\$\('pv-vbig'\)\.addEventListener\('click', playPause\)/)
  assert.match(view, /playAfterSeek = !!playing && video\(\)\.paused/)
  assert.match(view, /track\.addEventListener\('keydown'/)
  // The cover: a still from the video worker, as a data: picture (the CSP's img-src allows data:, not blob:).
  // Skipped when its turn comes if the viewer has moved on (the review: it may wait behind a video being made smaller).
  assert.match(view, /stillInWorker\(new Blob\(\[data as BlobPart\], \{ type: type \|\| 'video\/mp4' \}\), 0, 1280, \(\) => playing === url\)/)
  assert.match(read('../src/video/client.ts'), /new Promise<ImageBitmap \| null>\(\(resolve\) => \{\n\s+if \(!wanted\(\)\) return resolve\(null\)/)
  // Let go of on closing; never a moment the browser can't take (an endless length), and a tap at the end stays at the end.
  assert.match(view, /video\.removeAttribute\('poster'\)/)
  assert.match(view, /const lengthOf = \(video: HTMLVideoElement\) => \(video\.duration > 0 && Number\.isFinite\(video\.duration\) \? video\.duration : 0\)/)
  assert.match(view, /const nearEnd = \(at: number, length: number\) => Math\.min\(at, Math\.max\(0, length - 0\.1\)\)/)
  // The big button is for fingers and mice: out of the tab order, hidden from screen readers, which have the bar's.
  assert.match(html, /<button class="video-big" id="pv-vbig" type="button" tabindex="-1" aria-hidden="true">/)
  // Its words change only when they do, not every frame.
  assert.match(view, /if \(\$\('pv-vtime'\)\.textContent === time\) return/)
  // Full screen is black: the bar takes the dark theme's colours; a tall video never spills over the bar.
  const css = read('../src/style.css')
  assert.match(css, /\.video-view:fullscreen \{\n\s+--surface: [^;]+;\n\s+--line: [^;]+;\n\s+--line-strong: [^;]+;\n\s+--text: #eef0f8;\n\s+--muted: #9aa0b5;/)
  assert.match(css, /overflow: hidden; \/\* a tall video never spills over its bar \*\//)
  assert.match(view, /canvas\.toDataURL\('image\/jpeg', 0\.9\)/)
  const csp = read('../public/.htaccess').match(/Content-Security-Policy "([^"]+)"/)![1]
  assert.match(csp, /; img-src 'self' data:; /)
  // Full screen with its bar where the browser can; an iPhone's own full-screen player otherwise; let go of on closing.
  assert.match(view, /if \(document\.fullscreenEnabled && box\.requestFullscreen\) void box\.requestFullscreen\(\)/)
  assert.match(view, /webkitEnterFullscreen\?\.\(\)/)
  assert.match(view, /if \(document\.fullscreenElement === \$\('pv-video-box'\)\) void document\.exitFullscreen\(\)/)
  // Labelled for screen readers; the bar is a slider.
  assert.equal(copy.VIEW_PLAY, 'Play')
  assert.equal(copy.VIEW_PAUSE, 'Pause')
  assert.match(html, /<div class="video-track" id="pv-vtrack" role="slider" tabindex="0" aria-valuemin="0">/)
})

test('"As it will be sent" counts the bytes it goes as, compressed, as its row does (2026-10-26)', () => {
  const tray = read('../src/tray.ts') + read('../src/prep/list.ts') // the screen, and the file list it draws
  assert.match(tray, /const as = \{ sent: row\.sending\.stored\.body\.length \}/)
  for (const call of ['showDoc(sentName(row), row.sending.data, doc, kind, as)', 'showAudio(sentName(row), row.sending.data, sentType(row), kind, as,', 'show(sentName(row), row.sending.data, sentType(row), kind, as)'])
    assert.ok(tray.includes(call), call)
  // Every viewer's line: the size it goes as, or else its own (one that arrived).
  const view = read('../src/ui/photoView.ts')
  // Photos, PDFs, documents, videos, audio, and SVG drawings (2026-10-26).
  assert.equal(view.match(/size\(actions\.sent \?\? data\.length\)/g)?.length, 6)
  assert.doesNotMatch(view, /size\(data\.length\)/)
  // And the row says the same.
  assert.match(tray, /return `\$\{size\(s\.data\.length\)\} → \$\{size\(s\.stored\.body\.length\)\}`/)
})
