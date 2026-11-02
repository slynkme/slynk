// SVG drawings (src/strip/svg.ts, read by src/strip/svgscan.ts): what drawing apps leave in them
// goes, everything that draws stays exactly as it was, and a file the reader can't be sure of goes
// as it is, as one Slynk can't check. What a browser draws from them is compared in the browser.
// Run from the repo root: npm --prefix web test
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DOMParser, type Element, type Node } from '@xmldom/xmldom'
import { zipSync } from 'fflate'
import { docPreviewOf } from '../../src/docview/index.ts'
import { stripBytes } from '../../src/strip/engine.ts'
import { IN_FILES, IN_PICTURES, LABEL } from '../../src/strip/labels.ts'
import { describeOther, detectKind } from '../../src/strip/sniff.ts'
import { fromBase64 } from '../../src/strip/svg.ts'
import { SvgUnreadable, scanSvg, startsAsSvg, toBase64 } from '../../src/strip/svgscan.ts'
import { cleaningNote } from '../../src/ui/cleaning.ts'
import { contains, text, utf8 } from './fixtures.ts'
import { EMBEDDED_JPEG, INKSCAPE, PLAIN, illustrator } from './svgfixtures.ts'

async function clean(b: Uint8Array) {
  const r = await stripBytes(b)
  assert.equal(r.status, 'cleaned', JSON.stringify(r).slice(0, 300))
  if (r.status !== 'cleaned') throw new Error()
  return r
}

const valuesOf = (r: { details: { label: string; values: string[] }[] }, label: string) => r.details.find((d) => d.label === label)?.values ?? []

const KEPT = new Set(['http://www.w3.org/2000/svg', 'http://www.w3.org/1999/xhtml', 'http://www.w3.org/1998/Math/MathML'])
const KEPT_ATTRS = new Set(['', null, 'http://www.w3.org/XML/1998/namespace', 'http://www.w3.org/1999/xlink'])
const TEXTY = new Set(['text', 'tspan', 'textPath', 'style', 'title', 'desc', 'script'])

/**
 * What a browser draws from a file, read by another parser: every SVG (HTML, MathML) element in
 * order with its attributes and text, but no comments, metadata or other apps' elements and
 * attributes. An embedded picture is named by its type only (its bytes are cleaned), and a link to
 * a file on the maker's computer is left out (it's removed on purpose).
 */
function drawing(svg: string): string {
  const doc = new DOMParser({ onError: () => {} }).parseFromString(svg, 'image/svg+xml')
  const out: string[] = []
  const walk = (n: Node, parent: Element | null) => {
    if (n.nodeType === 3 || n.nodeType === 4) {
      const t = n.nodeValue ?? ''
      if (parent && TEXTY.has(parent.localName ?? '')) out.push(`"${t}"`)
      else if (t.trim()) out.push(`"${t.trim()}"`)
      return
    }
    if (n.nodeType !== 1) return
    const el = n as Element
    if (!KEPT.has(el.namespaceURI ?? '') || el.localName === 'metadata') return
    const attrs: string[] = []
    for (let i = 0; i < el.attributes.length; i++) {
      const a = el.attributes[i]
      if (!KEPT_ATTRS.has(a.namespaceURI) || a.name === 'xmlns' || a.prefix === 'xmlns') continue
      if (a.localName === 'href' && /^\s*(file:|\/)/.test(a.value)) continue
      if (a.localName === 'content' && a.value.startsWith('<mxfile')) continue
      const v = a.localName === 'href' && /^\s*data:/.test(a.value) ? a.value.trim().slice(0, a.value.trim().indexOf(',')) : a.value
      attrs.push(`${a.namespaceURI ?? ''}|${a.localName}=${v}`)
    }
    out.push(`<${el.namespaceURI}|${el.localName} ${attrs.sort().join(' ')}>`)
    for (let c = el.firstChild; c; c = c.nextSibling) walk(c, el)
    out.push(`</${el.localName}>`)
  }
  walk(doc.documentElement!, null)
  return out.join('\n')
}

/** Every XML part parses without complaint (bar Illustrator's entities, which this parser doesn't read). */
function wellFormed(svg: string) {
  new DOMParser({
    onError: (level, msg) => {
      if (!/entity not found:&ns_/.test(msg)) assert.fail(`${level} ${msg}`)
    },
  }).parseFromString(svg, 'image/svg+xml')
}

test('what it is: an SVG drawing by its first element, not a page with an icon in it', () => {
  for (const svg of [INKSCAPE, illustrator(), PLAIN]) assert.equal(detectKind(utf8(svg)), 'svg')
  assert.equal(detectKind(utf8(String.fromCodePoint(0xfeff) + '<!-- a -->\n<?pi x?><svg:svg xmlns:svg="http://www.w3.org/2000/svg"/>')), 'svg')
  // A page with an icon in it is shown as its text, as before; an SVG as a picture, never as text.
  const page = utf8('<!doctype html><html><body><svg viewBox="0 0 1 1"></svg></body></html>')
  assert.equal(detectKind(page), null)
  assert.equal(docPreviewOf(page), 'text')
  assert.equal(docPreviewOf(utf8(illustrator())), null)
  for (const not of ['<svgx/>', '<svg', 'svg', '<?xml version="1.0"?>', '<!-- <svg> -->', '<html><svg/></html>']) assert.equal(startsAsSvg(utf8(not)), false, not)
})

test('Inkscape: the file name, export path, version, window, layers and metadata go; the drawing stays', async () => {
  const input = utf8(INKSCAPE)
  const r = await clean(input)
  const out = text(r.bytes)
  for (const gone of ['exampleuser', 'Example plan.svg', 'Example Author', 'Example Corp', 'Inkscape', 'inkscape', 'sodipodi', '1.3.2', 'Example layer', 'window-width', 'metadata1', 'rdf:', 'dc:', 'cc:', 'creativecommons', 'perspective', 'namedview']) {
    assert.ok(INKSCAPE.includes(gone), gone)
    assert.ok(!out.includes(gone), gone)
  }
  // The drawing, its text included, exactly as it was: only the link to the maker's own file is gone.
  assert.equal(drawing(out), drawing(INKSCAPE))
  assert.ok(out.includes('>Example floor plan</tspan>'))
  // The metadata element stays, empty, in its place: elements around it keep theirs (a <switch> picks it as before).
  assert.ok(out.includes('\n  <metadata/>\n  <g\n'))
  wellFormed(out)
  assert.deepEqual(valuesOf(r, LABEL.savedPath), ['Example plan.svg', '/home/exampleuser/Pictures/Example plan.png', 'file:///home/exampleuser/Pictures/Example photo.jpg'])
  assert.deepEqual(valuesOf(r, LABEL.software), ['Inkscape (http://www.inkscape.org/)', 'Inkscape 1.3.2 (091e20e, 2023-11-25, custom)'])
  assert.deepEqual(valuesOf(r, LABEL.author), ['Example Author'])
  assert.deepEqual(valuesOf(r, LABEL.copyright), ['Example Corp', 'http://creativecommons.org/licenses/by/4.0/'])
  assert.deepEqual(valuesOf(r, LABEL.title), ['Example floor plan'])
  assert.deepEqual(valuesOf(r, LABEL.dates), ['12 Jun 2024'])
  assert.deepEqual(valuesOf(r, LABEL.keywords), ['example', 'floor plan'])
  for (const l of [LABEL.appData, LABEL.otherDoc]) assert.ok(r.removed.includes(l), l)
  // No line left empty where something went.
  assert.doesNotMatch(out.slice(out.indexOf('<svg')), /\n[ \t]*\n/)
  assert.match(out, /^<\?xml version="1\.0" encoding="UTF-8" standalone="no"\?>\n\n<svg\n   width="210mm"/)
  // Cleaned again, nothing's left.
  assert.equal((await stripBytes(r.bytes)).status, 'unchanged')
})

test('Illustrator: its comment, XMP, Save for Web data, private copy of the artwork go; an embedded photo is cleaned', async () => {
  const svg = illustrator()
  const r = await clean(utf8(svg))
  const out = text(r.bytes)
  for (const gone of ['Generator', 'Example Author', 'Example logo', 'xmpmeta', 'xpacket', '<sfw', 'i:pgf', 'adobe_illustrator_pgf', 'eJzsvW', 'i:extraneous', 'xmlns:i=', 'xmlns:x=', 'xmlns:graph=', 'Macintosh', 'xmp.did']) {
    assert.ok(svg.includes(gone), gone)
    assert.ok(!out.includes(gone), gone)
  }
  // Its DOCTYPE stays: the switch still names Illustrator's extension by its entity, so it's still passed over.
  assert.ok(out.includes('<!ENTITY ns_ai "http://ns.adobe.com/AdobeIllustrator/10.0/">'))
  assert.ok(out.includes('<foreignObject requiredExtensions="&ns_ai;" x="0" y="0" width="1" height="1">'))
  assert.equal(drawing(out), drawing(svg))
  wellFormed(out)
  // The photo inside: its GPS and camera gone, its picture the same.
  const href = /xlink:href="data:image\/jpeg;base64,([^"]+)"/.exec(out)![1]
  const photo = fromBase64(href)
  assert.ok(contains(EMBEDDED_JPEG, 'ExampleCam') && !contains(photo, 'ExampleCam'))
  assert.equal(detectKind(photo), 'jpeg')
  assert.ok(r.removed.includes(LABEL.gps + IN_PICTURES), r.removed.join())
  assert.deepEqual(valuesOf(r, LABEL.gps + IN_PICTURES), ['12.34° N, 56.78° E'])
  assert.deepEqual(valuesOf(r, LABEL.software), ['Adobe Illustrator 27.0.0, SVG Export Plug-In . SVG Version: 6.00 Build 0)', 'Adobe Illustrator 27.0 (Macintosh)'])
  assert.deepEqual(valuesOf(r, LABEL.author), ['Example Author'])
  assert.deepEqual(valuesOf(r, LABEL.title), ['Example logo'])
  assert.deepEqual(valuesOf(r, LABEL.dates), ['12 Jun 2024, 18:30'])
  for (const l of [LABEL.appData, LABEL.editable, LABEL.history, LABEL.ids]) assert.ok(r.removed.includes(l), l)
  // Listed without values: IDs and editing steps say nothing worth reading.
  assert.deepEqual([valuesOf(r, LABEL.history), valuesOf(r, LABEL.ids), valuesOf(r, LABEL.appData)], [[], [], []])
  assert.equal((await stripBytes(r.bytes)).status, 'unchanged')
})

test('nothing to remove: it goes as it is', async () => {
  assert.equal((await stripBytes(utf8(PLAIN))).status, 'unchanged')
  // Only another app's namespace declared, or an empty <metadata/>: nothing worth a word, so nothing changes.
  const quiet = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"><metadata id="m"/><rect width="1" height="1"/></svg>'
  assert.equal((await stripBytes(utf8(quiet))).status, 'unchanged')
})

test('comments go, wherever they are; text and CDATA that only look like them stay', async () => {
  const svg =
    '<?xml version="1.0"?>\n<!-- Drawn for Example Corp -->\n<!DOCTYPE svg [\n  <!-- a note in the DTD -->\n  <!ENTITY name "Example">\n]>\n<svg xmlns="http://www.w3.org/2000/svg">\n' +
    '  <!-- draft 3 -->\n  <style>.a{fill:red}<!-- old: .a{fill:blue} -->.b{fill:green}</style>\n' +
    '  <style><![CDATA[ .c::after { content: "<!-- kept -->" } ]]></style>\n' +
    '  <text xml:space="preserve">a<!-- x --> b &name;</text>\n</svg><!-- after -->\n'
  const r = await clean(utf8(svg))
  const out = text(r.bytes)
  assert.equal(
    out,
    '<?xml version="1.0"?>\n<!DOCTYPE svg [\n  <!ENTITY name "Example">\n]>\n<svg xmlns="http://www.w3.org/2000/svg">\n' +
      '  <style>.a{fill:red}.b{fill:green}</style>\n' +
      '  <style><![CDATA[ .c::after { content: "<!-- kept -->" } ]]></style>\n' +
      '  <text xml:space="preserve">a b &name;</text>\n</svg>\n',
  )
  assert.deepEqual(valuesOf(r, LABEL.comments), ['Drawn for Example Corp', 'a note in the DTD', 'draft 3'])
  assert.ok(r.details.find((d) => d.label === LABEL.comments)!.more >= 2)
})

test('other apps: draw.io’s copy of the diagram, Affinity’s and Sketch’s names, any unknown namespace', async () => {
  const drawio = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" version="1.1" width="121px" height="61px" viewBox="-0.5 -0.5 121 61" content="&lt;mxfile host=&quot;app.diagrams.net&quot; modified=&quot;2024-06-12T18:30:00.000Z&quot; agent=&quot;Mozilla/5.0 (Example)&quot;&gt;&lt;diagram id=&quot;x&quot; name=&quot;Secret page 2&quot;&gt;abc&lt;/diagram&gt;&lt;/mxfile&gt;"><defs/><g><rect x="0" y="0" width="120" height="60" fill="#ffffff" stroke="#000000"/></g></svg>`
  let r = await clean(utf8(drawio))
  assert.ok(!contains(r.bytes, 'mxfile') && !contains(r.bytes, 'Secret page'))
  assert.equal(drawing(text(r.bytes)), drawing(drawio))
  assert.deepEqual(r.removed, [LABEL.editable])
  const affinity = `<svg width="100%" height="100%" viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg" xmlns:serif="http://www.serif.com/" xmlns:sketch="http://www.bohemiancoding.com/sketch/ns" xmlns:my="urn:example:app"><g id="Layer1" serif:id="Example Author's layer" sketch:type="MSPage"><my:settings secret="1"/><rect width="10" height="10"/></g></svg>`
  r = await clean(utf8(affinity))
  assert.equal(text(r.bytes), `<svg width="100%" height="100%" viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg"><g id="Layer1"><rect width="10" height="10"/></g></svg>`)
})

test('a drawing inside a drawing, and pictures it can’t clean or read', async () => {
  const inner = `<svg xmlns="http://www.w3.org/2000/svg"><!-- Example Author's icon --><rect width="1" height="1"/></svg>`
  const bmp = utf8('BM' + 'x'.repeat(40))
  const svg = `<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/svg+xml;base64,${toBase64(utf8(inner))}"/><image href=" DATA:image/bmp;base64,${toBase64(bmp)}"/><image href="data:image/png;base64,***"/></svg>`
  const r = await clean(utf8(svg))
  const out = text(r.bytes)
  const nested = text(fromBase64(/data:image\/svg\+xml;base64,([^"]+)/.exec(out)![1]))
  assert.equal(nested, `<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>`)
  assert.deepEqual(r.removed, [LABEL.comments + IN_PICTURES])
  assert.deepEqual(valuesOf(r, LABEL.comments + IN_PICTURES), ["Example Author's icon"])
  // A BMP isn't one it cleans, and "***" isn't base64: both stay as they were.
  assert.ok(out.includes(`href=" DATA:image/bmp;base64,${toBase64(bmp)}"`) && out.includes('base64,***'))
  // One inside that can't be read: the drawing can't be said to be clean.
  const broken = `<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/svg+xml;base64,${toBase64(utf8('<svg xmlns="http://www.w3.org/2000/svg"><g></svg>'))}"/></svg>`
  assert.equal((await stripBytes(utf8(broken))).status, 'failed')
})

test('older files in a Latin encoding, and a prefixed root', async () => {
  const latin = Uint8Array.from([...utf8('<?xml version="1.0" encoding="iso-8859-1"?>\n<svg xmlns="http://www.w3.org/2000/svg"><!-- Andr'), 0xe9, ...utf8(' --><desc>caf'), 0xe9, ...utf8('</desc></svg>')])
  const r = await clean(latin)
  assert.deepEqual(valuesOf(r, LABEL.comments), ['André'])
  assert.ok(contains(r.bytes, 'caf\xe9</desc>'))
  const prefixed = '<svg:svg xmlns:svg="http://www.w3.org/2000/svg"><svg:metadata>Example Author</svg:metadata><svg:rect width="1" height="1"/></svg:svg>'
  assert.equal(text((await clean(utf8(prefixed))).bytes), '<svg:svg xmlns:svg="http://www.w3.org/2000/svg"><svg:metadata/><svg:rect width="1" height="1"/></svg:svg>')
})

test('one it can’t be sure of reading goes as it is, and the sender is told', async () => {
  const svg = (body: string, before = '') => `${before}<svg xmlns="http://www.w3.org/2000/svg"><!-- c -->${body}</svg>`
  const cases: [string, string | Uint8Array][] = [
    ['unclosed element', svg('<g>')],
    ['mismatched end tag', svg('<g></h>')],
    ['an entity holding markup', svg('&e;', '<!DOCTYPE svg [<!ENTITY e "<metadata>Example</metadata>">]>')],
    ['billion laughs', svg('&lol2;', '<!DOCTYPE svg [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;">]>')],
    ['an external entity', svg('&e;', '<!DOCTYPE svg [<!ENTITY e SYSTEM "file:///etc/passwd">]>')],
    ['a parameter entity', svg('', '<!DOCTYPE svg [<!ENTITY % p "x">]>')],
    ['default attributes', svg('', '<!DOCTYPE svg [<!ATTLIST svg xmlns:a CDATA #FIXED "urn:a">]>')],
    ['an undeclared entity', svg('&nbsp;')],
    ['a bare &', svg('<text>a & b</text>')],
    ['an undeclared prefix', svg('<a:b/>')],
    ['an attribute twice', svg('<g id="a" id="b"/>')],
    ['< in a value', svg('<g id="a<b"/>')],
    ['-- in a comment', svg('<!-- a -- b -->')],
    ['text after the drawing', svg('') + 'x'],
    ['a second drawing', svg('') + '<svg/>'],
    ['not in SVG’s namespace', '<svg><!-- c --></svg>'],
    ['Shift_JIS', '<?xml version="1.0" encoding="Shift_JIS"?>' + svg('')],
    ['XML 1.1', '<?xml version="1.1"?>' + svg('')],
    ['UTF-16', Uint8Array.from([0xff, 0xfe, ...[...svg('')].flatMap((c) => [c.charCodeAt(0), 0])])],
    ['not UTF-8', Uint8Array.from([...utf8(svg('<desc>')), 0xe9, ...utf8('</desc>')])],
    ['a control character', svg('<desc>\u0001</desc>')],
  ]
  for (const [why, input] of cases) {
    const b = typeof input === 'string' ? utf8(input) : input
    const r = await stripBytes(b)
    assert.equal(r.status, 'unsupported', why)
    assert.throws(() => scanSvg(b), SvgUnreadable, why)
    // The composer's line for it: a drawing it can't read, or (not even read as one) any file it can't check.
    if (r.status === 'unsupported') assert.match(cleaningNote(r, { useOriginal: false, sendAsIs: false }), r.kind === 'svg' ? /can’t read this drawing to check it/ : /can’t check this kind of file/, why)
  }
})

test('linear on crafted files: each of several MB in well under a second', async () => {
  const MB = 4_000_000
  const open = '<svg xmlns="http://www.w3.org/2000/svg">'
  const cases: [string, string][] = [
    ['deep nesting', open + '<g>'.repeat(5000) + '</g>'.repeat(5000) + '</svg>'],
    ['many elements in metadata', open + '<metadata>' + '<a/>'.repeat(MB / 4) + '</metadata></svg>'],
    ['many comments', open + '<!---->'.repeat(MB / 7) + '</svg>'],
    ['one long comment, unclosed', open + '<!--' + '-'.repeat(1) + 'a-'.repeat(MB / 2) + '</svg>'],
    ['many attributes', open + '<g ' + Array.from({ length: 200_000 }, (_, i) => `a${i}="1"`).join(' ') + '/></svg>'],
    ['many & without ;', open + '<text>' + '&'.repeat(MB) + '</text></svg>'],
    ['many references', open + '<text>' + '&amp;'.repeat(MB / 5) + '</text></svg>'],
    ['a long name', open + '<' + 'a'.repeat(MB) + '/></svg>'],
    ['an unclosed value', open + '<g a="' + 'x'.repeat(MB) + '</svg>'],
    ['many namespace declarations', open + '<g ' + Array.from({ length: 5000 }, (_, i) => `xmlns:p${i}="urn:${i}"`).join(' ') + '>' + '<g/>'.repeat(100_000) + '</g></svg>'],
    ['many "<"', open + '<'.repeat(MB) + '</svg>'],
    ['a DOCTYPE without end', '<!DOCTYPE svg [' + '<!ENTITY a "b">'.repeat(MB / 15)],
    ['many end tags', open + '</g>'.repeat(MB / 4)],
    ['other apps’ attributes', open.replace('>', ' xmlns:i="urn:i">') + '<g ' + Array.from({ length: 100_000 }, (_, i) => `i:a${i}="1"`).join(' ') + '/></svg>'],
  ]
  for (const [why, svg] of cases) {
    const t = performance.now()
    await stripBytes(utf8(svg))
    const ms = performance.now() - t
    assert.ok(ms < 1500, `${why}: ${Math.round(ms)} ms`)
  }
})

test('too large to check, and inside a zip', async () => {
  // A zip's drawings are cleaned as files inside; one it can't read is counted as unchecked, as before.
  const z = zipSync({ 'a.svg': utf8(INKSCAPE), 'b.svg': utf8('<svg xmlns="http://www.w3.org/2000/svg"><g></svg>'), 'c.txt': utf8('hello') })
  const r = await clean(z)
  assert.ok(r.removed.includes(LABEL.savedPath + IN_FILES), r.removed.join())
  assert.deepEqual(r.unchecked, { svg: 1 })
  assert.ok(!contains(r.bytes, 'exampleuser'))
})

const S = 'xmlns="http://www.w3.org/2000/svg"'
const XL = 'xmlns:xlink="http://www.w3.org/1999/xlink"'
const gpsJpeg = () => toBase64(EMBEDDED_JPEG)

test('the review: pictures wherever they are embedded are cleaned', async () => {
  const cases: [string, string][] = [
    ['HTML’s <img> in a foreignObject', `<svg ${S}><foreignObject width="9" height="9"><div xmlns="http://www.w3.org/1999/xhtml"><img src="data:image/jpeg;base64,${gpsJpeg()}"/></div></foreignObject></svg>`],
    ['a style attribute’s url()', `<svg ${S}><rect width="9" height="9" style="fill:none;mask-image:url(data:image/jpeg;base64,${gpsJpeg()})"/></svg>`],
    ['a style sheet’s url(""), in CDATA', `<svg ${S}><style><![CDATA[.a{background-image:url("data:image/jpeg;base64,${gpsJpeg()}")}]]></style></svg>`],
    ['an address with no type', `<svg ${S}><image href="data:;base64,${gpsJpeg()}"/></svg>`],
    ['"; base64" with a space, and a #fragment', `<svg ${S}><image href=" data:image/jpeg; base64,${gpsJpeg()}#x "/></svg>`],
    ['a srcset', `<svg ${S}><foreignObject width="9" height="9"><img xmlns="http://www.w3.org/1999/xhtml" srcset="data:image/jpeg;base64,${gpsJpeg()} 2x"/></foreignObject></svg>`],
  ]
  for (const [why, svg] of cases) {
    const r = await clean(utf8(svg))
    assert.ok(r.removed.includes(LABEL.gps + IN_PICTURES), why)
    assert.ok(!contains(r.bytes, 'ExampleCam'), why)
    assert.equal((await stripBytes(r.bytes)).status, 'unchanged', why)
  }
  // A drawing inside, percent-encoded: cleaned, and sent as base64 (the same drawing).
  const inner = encodeURIComponent(`<svg ${S}><!-- Example Author --><rect width="1" height="1"/></svg>`)
  const r = await clean(utf8(`<svg ${S}><image href="data:image/svg+xml,${inner}"/></svg>`))
  assert.deepEqual(r.removed, [LABEL.comments + IN_PICTURES])
  assert.match(text(r.bytes), /href="data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+"/)
  // A drawing inside whose DTD has a comment with a quote in it is still one (the sniff read past it wrongly).
  const quirky = `<!DOCTYPE svg [<!-- don't ] -->]><svg ${S}><!-- Example Author --></svg>`
  assert.equal(detectKind(utf8(quirky)), 'svg')
  assert.deepEqual((await clean(utf8(`<svg ${S}><image href="data:image/svg+xml;base64,${toBase64(utf8(quirky))}"/></svg>`))).removed, [LABEL.comments + IN_PICTURES])
  // A TIFF, which no cleaner reads: it goes as it is, and the sender is told.
  const tiff = Uint8Array.from([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 0, 0, 0, 0])
  const t = await stripBytes(utf8(`<svg ${S}><image href="data:image/tiff;base64,${toBase64(tiff)}"/></svg>`))
  assert.equal(t.status, 'unchanged')
  assert.deepEqual(t.status === 'unchanged' && t.unchecked, { tiff: 1 })
  assert.match(cleaningNote(t, { useOriginal: false, sendAsIs: false }), /Some files inside weren’t checked for hidden data, so they go as they are: 1 picture\./)
})

test('the review: links to the maker’s own files, wherever they are; a website’s own link stays', async () => {
  const paths = ['/media/exampleuser/USB/a.png', '/run/media/exampleuser/a.png', '/mnt/c/Users/exampleuser/a.png', '/Volumes/Example Drive/a.png', '/var/folders/x/a.png', '../../Clients/Example Corp/a.jpg', 'smb://server/a.png', '\\\\server\\share\\a.png', 'C:/Users/exampleuser/a.png', '~/a.png']
  for (const p of paths) {
    const r = await clean(utf8(`<svg ${S} ${XL}><image xlink:href="${p}" width="9" height="9"/></svg>`))
    assert.deepEqual(valuesOf(r, LABEL.savedPath), [p], p)
    assert.equal(text(r.bytes), `<svg ${S} ${XL}><image width="9" height="9"/></svg>`, p)
  }
  let r = await clean(utf8(`<?xml-stylesheet href="file:///C:/Users/exampleuser/a.css"?>\n<svg ${S}><g xml:base="file:///home/exampleuser/"><image href="photo.jpg"/></g><a href="/home/"><text>Home</text></a></svg>`))
  assert.equal(text(r.bytes), `<svg ${S}><g><image href="photo.jpg"/></g><a href="/home/"><text>Home</text></a></svg>`)
  // A picture beside it, in its own folder, stays: sent together in a zip, it still shows.
  r = await clean(utf8(`<svg ${S}><!-- c --><image href="images/photo.jpg"/></svg>`))
  assert.equal(text(r.bytes), `<svg ${S}><image href="images/photo.jpg"/></svg>`)
})

test('the review: what other apps leave in plain sight, and what’s listed as gone is gone', async () => {
  const svg = `<?plantuml 1.2023.10?><?plantuml-src SoWkIImgAStDuNBAJrBGjLDmpCbCJbMmKiX8pSd9vt98pKi1IW80?>
<svg ${S} d2Version="v0.6.0"><title>Example Corp merger plan</title><desc>Created with Sketch.</desc>
<metadata><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/"><rdf:Description><dc:title>Example Corp merger plan</dc:title><dc:creator>Example Author</dc:creator><dc:description></dc:description><dc:subject/></rdf:Description></rdf:RDF></metadata>
<style>/* draft for Example Corp */ .a { fill: red } /* x */</style>
<g id="Layer_1" data-name="Example Author's layer"><text style="font-size:9px;-inkscape-font-specification:'Sans, Bold';fill:#000">Hi</text></g></svg>`
  const r = await clean(utf8(svg))
  const out = text(r.bytes)
  for (const gone of ['plantuml', 'Sketch', 'draft for', 'data-name', '-inkscape-', 'd2Version', 'Example Author']) assert.ok(!out.includes(gone), gone)
  assert.ok(out.includes('<title>Example Corp merger plan</title><desc/>'))
  assert.ok(out.includes('<style>/**/ .a { fill: red } /**/</style>'))
  assert.ok(out.includes(`style="font-size:9px;;fill:#000"`))
  // The title stays, so it isn't listed as gone; an empty description or subject isn't listed at all.
  assert.ok(!r.removed.includes(LABEL.title) && !r.removed.includes(LABEL.description) && !r.removed.includes(LABEL.keywords), r.removed.join())
  assert.deepEqual(valuesOf(r, LABEL.author), ['Example Author'])
  assert.deepEqual(valuesOf(r, LABEL.software), ['Sketch.', 'D2 v0.6.0'])
  assert.deepEqual(valuesOf(r, LABEL.comments), ['draft for Example Corp', 'x'])
  assert.ok(r.removed.includes(LABEL.editable) && r.removed.includes(LABEL.appData))
  // An attribute a style sheet picks elements by stays.
  const named = `<svg ${S}><style>[data-name="a"]{fill:red}</style><!-- c --><g data-name="a"/></svg>`
  assert.ok(contains((await clean(utf8(named))).bytes, 'data-name="a"'))
})

test('the review: a cut that could change what’s drawn leaves the file as it is, or puts a stand-in in its place', async () => {
  const unsure: [string, string][] = [
    ['a shape a <use> repeats, inside another app’s element', `<svg ${S} xmlns:my="urn:example"><my:store><rect id="r" width="9" height="9"/></my:store><use href="#r"/></svg>`],
    ['a style sheet inside metadata', `<svg ${S}><metadata><style>rect{fill:red}</style></metadata><rect width="9" height="9"/></svg>`],
    ['a style sheet picking another app’s names', `<svg ${S} xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"><style>@namespace i url(http://www.inkscape.org/namespaces/inkscape); g[i|groupmode=layer]{fill:red}</style><g inkscape:groupmode="layer"/></svg>`],
    ['a photo held in the DTD', `<!DOCTYPE svg [<!ENTITY img "data:image/jpeg;base64,${gpsJpeg()}">]><svg ${S}><!-- c --><image href="&img;"/></svg>`],
    ['an id that goes, shadowing one that stays', `<svg ${S} xmlns:my="urn:example"><my:x id="g"/><linearGradient id="g"/><rect fill="url(#g)" width="9" height="9"/></svg>`],
  ]
  for (const [why, svg] of unsure) assert.equal((await stripBytes(utf8(svg))).status, 'unsupported', why)
  // Picked by its place: what goes leaves a stand-in, so the rect is still second.
  const placed = `<svg ${S} xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"><style>rect:first-child{fill:red}</style><sodipodi:namedview id="n"/><rect width="9" height="9"/></svg>`
  assert.equal(text((await clean(utf8(placed))).bytes), `<svg ${S}><style>rect:first-child{fill:red}</style><metadata/><rect width="9" height="9"/></svg>`)
  // Metadata first in a <switch> is picked, drawing nothing: it stays, empty, picked as before.
  const sw = `<svg ${S}><switch><metadata>Example Author</metadata><rect width="9" height="9"/></switch></svg>`
  assert.equal(text((await clean(utf8(sw))).bytes), `<svg ${S}><switch><metadata/><rect width="9" height="9"/></switch></svg>`)
})

test('the review: crafted files that were too slow, or ran out of memory', async () => {
  const e = 'x'.repeat(60_000)
  const crafted: [string, string][] = [
    // One 60 KB entity used 4,000 times in a namespace: 240 MB, made again for every attribute.
    ['entities standing for too much', `<!DOCTYPE svg [<!ENTITY e "${e}">]><svg ${S} width="1" height="1"><g xmlns:p="${'&e;'.repeat(4000)}"${Array.from({ length: 10 }, (_, i) => ` p:a${i}="1"`).join('')}/></svg>`],
    ['entities in text', `<!DOCTYPE svg [<!ENTITY e "${e}">]><svg ${S}><metadata>${'&e;'.repeat(4000)}</metadata></svg>`],
    ['a long run of spaces in a link', `<svg ${S}><a href="x${' '.repeat(200_000)}y"/></svg>`],
  ]
  for (const [why, svg] of crafted) {
    const t = performance.now()
    const r = await stripBytes(utf8(svg))
    assert.ok(performance.now() - t < 1000, `${why}: ${Math.round(performance.now() - t)} ms`)
    if (why.startsWith('entities')) assert.equal(r.status, 'unsupported', why)
  }
})
