// SVG drawings in the previews (src/ui/svgPicture.ts): drawn by the browser as a picture, from a
// data: address, on white. A crafted one mustn't freeze the tab: one too costly to lay out gets no
// preview (checked here), and the size it's drawn at comes from timed trial drawings (checked in
// the browser). Run from the repo root: npm --prefix web test
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import * as copy from '../src/shrinkCopy.ts'
import { toBase64 } from '../src/strip/svgscan.ts'
import { isSvgPicture, prepareSvg } from '../src/ui/svgPicture.ts'
import { INKSCAPE, PLAIN, illustrator } from './strip/svgfixtures.ts'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const utf8 = (s: string) => new TextEncoder().encode(s)
const text = (b: Uint8Array) => new TextDecoder().decode(b)
const svg = (body: string, attrs = 'width="10" height="10"') => utf8(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ${attrs}>${body}</svg>`)

test('its own size: width and height in any unit, or what its viewBox gives, given outright to the copy drawn', () => {
  const ink = prepareSvg(utf8(INKSCAPE))!
  assert.equal(Math.round(ink.own.width), 794) // 210 mm
  assert.equal(Math.round(ink.own.height), 559) // 148 mm
  assert.equal(text(ink.bytes), INKSCAPE) // it had a size: drawn as it is
  assert.deepEqual(prepareSvg(utf8(illustrator()))?.own, { width: 200, height: 120 })
  assert.deepEqual(prepareSvg(utf8(PLAIN))?.own, { width: 24, height: 24 })
  // Only a viewBox, or a size relative to the page: given the viewBox's, in place of what it had.
  let p = prepareSvg(utf8('<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 40 30" height="100%"><rect width="40" height="30"/></svg>'))!
  assert.deepEqual(p.own, { width: 40, height: 30 })
  assert.equal(text(p.bytes), '<svg width="40" height="30" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 30"><rect width="40" height="30"/></svg>')
  p = prepareSvg(utf8('<svg xmlns="http://www.w3.org/2000/svg" width="80" viewBox="0 0 40 30"/>'))!
  assert.deepEqual(p.own, { width: 80, height: 60 })
  // Neither: a browser's 300 × 150.
  assert.deepEqual(prepareSvg(utf8('<svg xmlns="http://www.w3.org/2000/svg"/>'))?.own, { width: 300, height: 150 })
})

test('one too costly to lay out gets no preview, and saying so is quick', () => {
  // Each level repeats the one below ten times: ten levels would be ten billion rectangles.
  let defs = '<rect id="l0" width="1" height="1"/>'
  for (let i = 1; i <= 10; i++) defs += `<g id="l${i}">${`<use href="#l${i - 1}"/>`.repeat(10)}</g>`
  const bombs: [string, Uint8Array][] = [
    ['<use> repeating <use>', svg(`<defs>${defs}</defs><use href="#l10"/>`)],
    ['xlink:href too', svg(`<defs>${defs.replace(/ href=/g, ' xlink:href=')}</defs><use xlink:href="#l10"/>`)],
    ['a <use> inside what it repeats', svg('<g id="a"><use href="#a"/></g>')],
    ['markers on a long line', svg(`<marker id="m">${'<circle r="1"/>'.repeat(200)}</marker><path marker-mid="url(#m)" d="M0 0${' L1 1'.repeat(5000)}"/>`)],
    ['markers set in a style sheet', svg(`<style>path{marker-mid:url(#m)}</style><marker id="m">${'<circle r="1"/>'.repeat(200)}</marker><path d="M0 0${' L1 1'.repeat(5000)}"/>`)],
    ['filters on many elements', svg(`<filter id="f">${'<feGaussianBlur stdDeviation="1"/>'.repeat(100)}</filter>${'<rect filter="url(#f)" width="1" height="1"/>'.repeat(1000)}`)],
    ['filters set in a style sheet', svg(`<style>rect{filter:url(#f)}</style><filter id="f">${'<feGaussianBlur stdDeviation="1"/>'.repeat(100)}</filter>${'<rect width="1" height="1"/>'.repeat(1000)}`)],
    ['too many elements', svg('<g/>'.repeat(50_001))],
    ['too much text', svg(`<text>${'x'.repeat(500_001)}</text>`)],
    ['too big', svg(`<desc>${'x'.repeat(10_000_000)}</desc>`)],
    ['not well-formed', svg('<g>')],
  ]
  // Drawings in drawings in drawings.
  let nested = svg('<rect width="1" height="1"/>')
  for (let i = 0; i < 3; i++) nested = svg(`<image width="10" height="10" href="data:image/svg+xml;base64,${toBase64(nested)}"/>`)
  bombs.push(['drawings nested three deep', nested])
  // A <use> bomb inside an embedded drawing counts too.
  bombs.push(['a bomb inside', svg(`<image href="data:image/svg+xml;base64,${toBase64(bombs[0][1])}"/>`)])
  for (const [why, bytes] of bombs) {
    const t = performance.now()
    assert.equal(prepareSvg(bytes), null, why)
    assert.ok(performance.now() - t < 1500, `${why}: ${Math.round(performance.now() - t)} ms`)
  }
  // Ordinary use of each is fine.
  assert.ok(prepareSvg(svg(`<defs>${defs.slice(0, defs.indexOf('<g id="l4"'))}</defs><use href="#l3"/>`)))
  assert.ok(prepareSvg(svg(`<marker id="m"><circle r="1"/></marker><path marker-end="url(#m)" d="M0 0 L5 5 L9 1"/>`)))
  assert.ok(prepareSvg(svg(`<filter id="f"><feGaussianBlur stdDeviation="1"/></filter>${'<rect filter="url(#f)" width="1" height="1"/>'.repeat(50)}`)))
  assert.ok(prepareSvg(svg(`<image width="10" height="10" href="data:image/svg+xml;base64,${toBase64(svg('<rect width="1" height="1"/>'))}"/>`)))
})

test('drawn on canvases from a data: address, never a blob:, with time limits; SVGs only by their bytes', () => {
  const pic = read('../src/ui/svgPicture.ts')
  assert.match(pic, /img\.src = `data:image\/svg\+xml;base64,\$\{toBase64\(picture\.bytes\)\}`/)
  assert.equal(pic.match(/\.src\s*=/g)?.length, 1)
  assert.doesNotMatch(pic.replace(/\/\/.*$/gm, ''), /createObjectURL|blob:|localStorage|indexedDB|fetch\(/)
  assert.match(pic, /const LOAD_MS = 4_000/)
  assert.match(pic, /const DRAW_MS = 400/)
  // A browser draws it only when its pixels are needed: the trial drawings are read back to be timed.
  assert.match(pic, /ctx\.drawImage\(img, 0, 0, at\.width, at\.height\)\n  try \{\n    ctx\.getImageData\(0, 0, 1, 1\)/)
  const csp = read('../public/.htaccess').match(/Content-Security-Policy "([^"]+)"/)![1]
  assert.match(csp, /; img-src 'self' data:; /)
  assert.ok(isSvgPicture(utf8(PLAIN)) && !isSvgPicture(utf8('<html><svg/></html>')) && !isSvgPicture(utf8('hello world')))
})

test('both screens: the composer, what arrived (and an inbox’s files), and a single file', () => {
  const view = read('../src/ui/photoView.ts')
  assert.match(view, /export async function drawThumb\([^)]*\)[^{]*\{\n  if \(isSvgPicture\(data\)\) return drawSvgThumb\(canvas, data\)/)
  assert.match(view, /mode\('photo'\)\n  if \(isSvgPicture\(data\)\) return showSvg\(name, data, kind, actions\)/)
  // On white, as a page shows it, whole in the thumbnail rather than cropped.
  assert.equal(view.match(/ctx\.fillStyle = '#fff'/g)?.length, 2)
  const tray = read('../src/tray.ts') + read('../src/prep/list.ts') // the screen, and the file list it draws
  assert.match(tray, /row\.svg = !row\.photo && !row\.doc && isSvgPicture\(row\.data\)/)
  assert.match(tray, /settings\(\)\.photoPreviews && \(row\.photo \|\| row\.svg \|\| row\.video \|\| doc \|\| audio\) && row\.sending \? row\.sending\.data : undefined/)
  assert.match(tray, /row\.svg \? shrinkCopy\.VIEW_CANT_SVG/)
  assert.match(read('../src/ui/items.ts'), /if \(photoInfo\(item\.data\) \|\| isSvgPicture\(item\.data\) \|\| isVideo/)
  assert.match(read('../src/main.ts'), /!\(photoInfo\(item\.data\) \|\| isSvgPicture\(item\.data\) \|\| isVideo\(item\.data\) \|\| doc \|\| audio\)/)
})

test('plain words', () => {
  assert.equal(copy.VIEW_ABOUT_SVG('12 KB', 'full'), 'As it will be sent: SVG drawing, 12 KB')
  assert.equal(copy.VIEW_ABOUT_SVG('12 KB', 'received'), 'Received: SVG drawing, 12 KB')
  assert.equal(copy.VIEW_CANT_SVG, 'Slynk can’t show this drawing here.')
})

test('the About page says so: SVG drawings cleaned, and shown as pictures', () => {
  const about = read('../about/index.html').replace(/\s+/g, ' ')
  assert.match(about, /MP3 and FLAC audio, most SVG drawings, and PDF, Word, Excel, PowerPoint, OpenDocument and RTF files\./)
  // What goes, what stays, and that it may not open for editing as before (the review: "exactly as it was" overstated it).
  assert.match(about, /From an SVG drawing it removes what the app that made it leaves behind, like the author, comments and file names, and cleans the photos stored in it\. It looks the same, but may no longer open for editing as before, and its title, layers you’ve hidden and anything off the page still go with it\./)
  assert.match(about, /An SVG drawing shows as a picture, on a white background\. As with a picture on a web page, nothing in it runs and nothing it links to is fetched\. A very large or detailed one may show smaller, or not at all, and so may one Slynk can’t read\./)
  assert.match(about, /as any web page or SVG drawing can in a browser/)
  // Still true with previews of drawings: nothing in a file runs in the app, or makes it contact a website.
  assert.match(about, /nothing in a file can run in the app: it only previews files, and a file can’t make it contact any website\./)
})

test('what the review found: pictures that unpack huge, lines of countless dashes, and what a style sheet applies', async () => {
  const { seg, be16, cat } = await import('./strip/fixtures.ts')
  // A PNG's signature and header, with its size.
  const png = (w: number, h: number) => {
    const b = new Uint8Array(33)
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
    new DataView(b.buffer).setUint32(16, w)
    new DataView(b.buffer).setUint32(20, h)
    return b
  }
  // A JPEG's frame header, with its size, is all it takes to say how big it unpacks.
  const jpeg = (w: number, h: number) => cat([0xff, 0xd8], seg(0xc0, [8, ...be16(h), ...be16(w), 1, 1, 0x11, 0]), [0xff, 0xd9])
  const image = (b: Uint8Array, type = 'png', attr = 'href') => `<image width="10" height="10" ${attr}="data:image/${type};base64,${toBase64(b)}"/>`
  const refused: [string, Uint8Array][] = [
    // 13,000 pixels square, in a 214 KB PNG: about 680 MB unpacked, on the page's own thread.
    ['a PNG that unpacks huge', svg(image(png(13_000, 13_000)))],
    ['a JPEG that does', svg(image(jpeg(20_000, 20_000), 'jpeg'))],
    ['a PNG with no type of its own', svg(`<image href="data:;base64,${toBase64(png(13_000, 13_000))}"/>`)],
    ['several that add up', svg(image(png(4000, 4000)).repeat(2))],
    ['one inside a drawing inside it', svg(`<image href="data:image/svg+xml;base64,${toBase64(svg(image(png(13_000, 13_000))))}"/>`)],
    ['one in HTML inside it', svg(`<foreignObject width="10" height="10"><img xmlns="http://www.w3.org/1999/xhtml" src="data:image/png;base64,${toBase64(png(13_000, 13_000))}"/></foreignObject>`)],
    ['one in a style', svg(`<rect width="1" height="1" style="mask-image:url('data:image/png;base64,${toBase64(png(13_000, 13_000))}')"/>`)],
    ['one in a style sheet', svg(`<style>rect{mask-image:url(data:image/png;base64,${toBase64(png(13_000, 13_000))})}</style>`)],
    ['one whose size can’t be read', svg(image(new Uint8Array(600).fill(7), 'x-icon'))],
    // Rectangles 16,000 units around, dashed every two hundredths: 800,000 dashes each (0.1 s), however small they're drawn.
    ['countless dashes', svg('<rect width="4000" height="4000" stroke="#000" stroke-dasharray="0.01 0.01"/>'.repeat(3), 'viewBox="0 0 4000 4000"')],
    ['dashes set on a group', svg(`<g style="stroke-dasharray:0.01">${'<path d="M0 0 L4000 0 L4000 4000"/>'.repeat(5)}</g>`)],
    ['dashes set in a style sheet', svg('<style>.d{stroke-dasharray:.01 .01}</style>' + '<rect class="d" width="4000" height="4000"/>'.repeat(3))],
    // Each clip path clipped by the one before: a browser's time grows with the chain's length squared.
    ['a long chain of clip paths', svg(Array.from({ length: 200 }, (_, i) => `<clipPath id="c${i}"${i ? ` clip-path="url(#c${i - 1})"` : ''}><rect width="9" height="9"/></clipPath>`).join('') + '<rect clip-path="url(#c199)" width="9" height="9"/>')],
    ['a chain a style sheet makes', svg(`<style>${Array.from({ length: 200 }, (_, i) => `#c${i + 1}{clip-path:url(#c${i})}`).join('')}</style>` + Array.from({ length: 201 }, (_, i) => `<clipPath id="c${i}"><rect width="9" height="9"/></clipPath>`).join('') + '<rect clip-path="url(#c200)" width="9" height="9"/>')],
    ['gradients each built on the last', svg(Array.from({ length: 200 }, (_, i) => `<linearGradient id="g${i}"${i ? ` href="#g${i - 1}"` : ''}/>`).join('') + '<rect fill="url(#g199)" width="9" height="9"/>')],
    ['a clip path clipped by itself', svg('<clipPath id="c" clip-path="url(#c)"><rect width="9" height="9"/></clipPath><rect clip-path="url(#c)" width="9" height="9"/>')],
    ['dashes repeated by <use>', svg(`<defs><path id="p" stroke-dasharray="0.1" d="M0 0 L2000 0"/></defs>${'<use href="#p"/>'.repeat(300)}`)],
  ]
  for (const [why, bytes] of refused) assert.equal(prepareSvg(bytes), null, why)
  // Ordinary ones still show: a 12-megapixel photo inside, dashed lines, a drop shadow on one of many shapes.
  const shadow = '<filter id="s">' + '<feOffset dx="1"/>'.repeat(6) + '</filter>'
  for (const [why, bytes] of [
    ['a 12-megapixel photo inside', svg(image(png(4000, 3000)))],
    ['dashed lines', svg('<style>.d{stroke-dasharray:4 2}</style>' + '<path class="d" d="M0 0 L100 100 L200 0"/>'.repeat(500))],
    ['a shadow on one of 9,000 shapes', svg(`<style>.st1{filter:url(#s)}</style>${shadow}${'<rect class="st0" width="1" height="1"/>'.repeat(9000)}<rect class="st1" width="1" height="1"/>`)],
    ['a font embedded in its style sheet', svg(`<style>@font-face{font-family:x;src:url(data:font/woff2;base64,${toBase64(new Uint8Array(5000))})}</style>`)],
  ] as [string, Uint8Array][])
    assert.ok(prepareSvg(bytes), why)
})

test('a drawing the cleaner can’t read says so as a drawing, under it and in a zip', async () => {
  const { cleaningNote, uncheckedList } = await import('../src/ui/cleaning.ts')
  const choice = { useOriginal: false, sendAsIs: false }
  assert.equal(cleaningNote({ status: 'unsupported', kind: 'svg' }, choice), 'Slynk can’t read this drawing to check it for hidden data, so it goes as it is')
  assert.equal(uncheckedList({ svg: 2 }), '2 drawings')
  assert.equal(uncheckedList({ svg: 1, pdf: 1 }), '1 PDF and 1 drawing')
})
