// Document previews shown as their text: RTF, read by docview/rtf.ts
// into the model render.ts draws, in the viewer and small in a file's row. Word and LibreOffice
// Writer documents (2026-10-25) are in docview-office.test.ts.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { describe, test } from 'node:test'
import { docPreviewOf } from '../src/docview/index.ts'
import { MAX_DOC_CHARS, hasText, type Block, type DocText, type Para } from '../src/docview/model.ts'
import { readRtf } from '../src/docview/rtf.ts'
import { drawTextThumb } from '../src/docview/render.ts'
import * as copy from '../src/shrinkCopy.ts'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const rtf = (body: string, head = '{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0\\fswiss\\fcharset0 Arial;}{\\f1\\fnil\\fcharset2 Symbol;}{\\f2\\fnil\\fcharset204 Arial Cyr;}{\\f3\\fnil\\fcharset128 MS Gothic;}}') =>
  new TextEncoder().encode(`${head}${body}}`)
const textOf = (p: Block) => (p.kind === 'para' ? p.runs.map((r) => r.text).join('') : '')
const paras = (doc: DocText) => doc.blocks.filter((b): b is Para => b.kind === 'para')
const allText = (doc: DocText) => JSON.stringify(doc)

describe('reading RTF', () => {
  test('paragraphs, with bold, italic, underline, strikethrough, raised and lowered text, sizes and alignment', () => {
    const doc = readRtf(rtf('\\pard\\qc\\b\\fs32 Heading\\b0\\fs24\\par\\pard Plain \\i italic\\i0 , \\ul under\\ulnone , \\uldb double\\ul0 , \\strike gone\\strike0 , x\\super 2\\nosupersub , H\\sub 2\\nosupersub O\\par'))
    const [heading, body] = paras(doc)
    assert.deepEqual(heading, { kind: 'para', runs: [{ text: 'Heading', bold: true, size: 16 }], align: 'center' })
    assert.equal(textOf(body), 'Plain italic, under, double, gone, x2, H2O')
    const run = (t: string) => body.runs.find((r) => r.text === t)!
    assert.equal(run('italic').italic, true)
    assert.equal(run('under').underline, true)
    assert.equal(run('double').underline, true)
    assert.equal(run('gone').strike, true)
    assert.equal(run('2').sup ?? body.runs.filter((r) => r.text === '2')[0].sup, true)
    assert.ok(body.runs.some((r) => r.text === '2' && r.sub))
    assert.equal(body.align, undefined)
  })

  test('characters in every way RTF writes them: code pages, a font’s own, Unicode with its stand-ins, and escapes', () => {
    const doc = readRtf(rtf("caf\\'e9 \\u8364?5 {\\uc2\\u20013\\'d6\\'d0}{\\uc0\\u9731} {\\f2\\'cf\\'f0\\'e8\\'e2\\'e5\\'f2} {\\f3\\'93\\'fa\\'96\\'7b} \\{braces\\} a\\~b c\\_d \\u-10179?\\u-8704? \\emdash\\par"))
    assert.equal(textOf(doc.blocks[0]), 'café €5 中☃ Привет 日本 {braces} a b c‑d 😀 —')
    // A document in another code page.
    const cyr = readRtf(rtf("\\'cf\\'f0\\'e8\\'e2\\'e5\\'f2\\par", '{\\rtf1\\ansi\\ansicpg1251'))
    assert.equal(textOf(cyr.blocks[0]), 'Привет')
  })

  test('bullets keep the symbol Word writes, as the character it looks like; a link shows its text', () => {
    const doc = readRtf(rtf("{\\listtext\\pard\\plain\\f1 \\'b7\\tab}One\\par{\\field{\\*\\fldinst HYPERLINK \"https://example.com\"}{\\fldrslt here}}\\par"))
    assert.equal(textOf(doc.blocks[0]), '•\tOne')
    assert.equal(textOf(doc.blocks[1]), 'here')
    assert.ok(!allText(doc).includes('example.com'))
  })

  test('leaves out what isn’t the document’s text: details, styles, headers, footnotes, comments, hidden and deleted text, unknown groups', () => {
    const doc = readRtf(
      rtf(
        '{\\colortbl;\\red255\\green0\\blue0;}{\\stylesheet{\\s0 Normal;}}{\\info{\\author Jane Doe}{\\title Secret plan}}{\\*\\generator Riched20}' +
          '{\\header {\\pard Page header\\par}}{\\footer {\\pard Page footer\\par}}Kept{\\footnote {\\pard A footnote\\par}}' +
          '{\\*\\atnid JD}{\\*\\annotation {\\pard A comment\\par}}{\\v hidden words}{\\deleted struck out}{\\*\\unknownthing gibberish} text\\par',
      ),
    )
    assert.equal(textOf(doc.blocks[0]), 'Kept text')
    for (const gone of ['Jane', 'Secret', 'Riched', 'header', 'footer', 'footnote', 'comment', 'hidden', 'struck', 'gibberish', 'Normal']) assert.ok(!allText(doc).includes(gone), gone)
  })

  test('tables: rows of cells, each its paragraphs; a paragraph after one ends it', () => {
    const doc = readRtf(rtf('\\trowd\\cellx1000\\cellx2000\\pard\\intbl A1\\cell B1\\par second line\\cell\\row\\trowd\\cellx1000\\cellx2000\\pard\\intbl A2\\cell\\cell\\row\\pard After\\par'))
    assert.equal(doc.blocks.length, 2)
    const t = doc.blocks[0]
    assert.equal(t.kind, 'table')
    if (t.kind !== 'table') return
    assert.deepEqual(
      t.rows.map((row) => row.map((cell) => cell.map(textOf))),
      [
        [['A1'], ['B1', 'second line']],
        [['A2'], ['']],
      ],
    )
    assert.equal(textOf(doc.blocks[1]), 'After')
  })

  test('pictures and objects are counted, not shown, and their data (\\bin too, braces and all) is passed over whole', () => {
    const bin = '\\bin6 }}{{\\x'
    const doc = readRtf(rtf(`Before{\\*\\shppict{\\pict\\pngblip 89504e47}}{\\nonshppict{\\pict\\wmetafile8 0102}}{\\object\\objemb{\\*\\objdata 0102}{\\result {\\pict\\pngblip ${bin} 00}}} after\\par`))
    assert.equal(textOf(doc.blocks[0]), 'Before after')
    assert.equal(doc.pictures, 2)
  })

  test('only the beginning of a very long document, and at most two empty paragraphs in a row', () => {
    const long = readRtf(rtf(`${'word '.repeat(100)}\\par`.repeat(500)), 10_000)
    assert.equal(long.cut, true)
    assert.ok(paras(long).length < 30)
    assert.equal(readRtf(rtf('A\\par\\par\\par\\par\\par B\\par')).blocks.length, 4)
    assert.equal(MAX_DOC_CHARS, 200_000)
  })

  test('a damaged or cut-off file shows what came before; something that isn’t RTF is refused', () => {
    const cutOff = new TextEncoder().encode('{\\rtf1\\ansi First paragraph\\par Second\\')
    assert.match(allText(readRtf(cutOff)), /First paragraph/)
    assert.throws(() => readRtf(new TextEncoder().encode('Hello')))
    // Nesting thousands deep, or every kind of junk after the header, never throws.
    readRtf(new TextEncoder().encode(`{\\rtf1 ${'{'.repeat(50_000)}deep${'}'.repeat(50_000)}}`))
    for (let i = 0; i < 200; i++) {
      const junk = crypto.getRandomValues(new Uint8Array(400))
      readRtf(new Uint8Array([...new TextEncoder().encode('{\\rtf1 '), ...junk]))
    }
  })

  test('says whether there’s anything to show', () => {
    assert.equal(hasText(readRtf(rtf('{\\pict\\pngblip 00}\\par\\par'))), false)
    assert.equal(hasText(readRtf(rtf('Hi\\par'))), true)
  })
})

describe('where it shows', () => {
  test('a PDF or an RTF is previewable, by its bytes', () => {
    assert.equal(docPreviewOf(new TextEncoder().encode('{\\rtf1\\ansi hello}')), 'rtf')
    assert.equal(docPreviewOf(new TextEncoder().encode('%PDF-1.7\n')), 'pdf')
    // Plain text is too, since 2026-10-26 ("plain text" below); a picture isn't.
    assert.equal(docPreviewOf(new TextEncoder().encode('hello')), 'text')
    assert.equal(docPreviewOf(Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46)), null)
  })

  test('the composer, a received file and an inbox’s collected files all preview it, as a PDF is', () => {
    for (const [file, re] of [
      ['../src/tray.ts', /const doc = docPreview\(row\)/],
      ['../src/ui/items.ts', /const doc = video \|\| audio \? null : docPreviewOf\(item\.data\)/],
      ['../src/main.ts', /const doc = item && !isVideo\(item\.data\) && !audio \? docPreviewOf\(item\.data\) : null/],
    ] as const)
      assert.match(read(file), re, file)
  })

  test('drawn as text, never as markup, with nothing fetched: no innerHTML, no dynamic import', () => {
    const dir = new URL('../src/docview/', import.meta.url)
    for (const f of readdirSync(dir)) {
      const src = readFileSync(new URL(f, dir), 'utf8')
      assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|DOMParser|import\(/.test(src), f)
    }
  })

  test('the viewer says it’s a simplified preview, and when only the beginning shows', () => {
    // Never "may differ": pictures are never shown, and it says how many there are (the review).
    assert.equal(copy.DOC_SIMPLIFIED(0), 'Just a text preview: the document itself keeps its fonts and page layout.')
    assert.equal(copy.DOC_SIMPLIFIED(1), 'Just a text preview: the document itself keeps its picture, fonts and page layout.')
    assert.equal(copy.DOC_SIMPLIFIED(3), 'Just a text preview: the document itself keeps its 3 pictures, fonts and page layout.')
    assert.equal(copy.DOC_CUT, 'Only the beginning is shown here.')
    assert.equal(copy.VIEW_ABOUT_DOC('24 KB', 'received'), 'Received: 24 KB')
    assert.equal(copy.VIEW_ABOUT_DOC('1.2 MB', 'copy'), 'As it will be sent: made smaller, 1.2 MB')
  })
})

describe('a PDF’s page buttons (seen on an iPhone, 2026-10-24)', () => {
  test('sit on the page’s sides, halfway down, out of the strip where a first tap only brings back Safari’s toolbar', () => {
    const html = read('../index.html')
    const css = read('../src/style.css')
    assert.ok(!html.includes('class="pv-pages"'))
    assert.match(html, /<button class="icon-btn pv-turn pv-prev" id="pv-prev" type="button" hidden>/)
    assert.match(css, /\.pv-turn \{\n {2}position: absolute;\n {2}top: 50%;/)
    // "Page 2 of 5" under the name instead; a one-page PDF has neither.
    assert.equal(copy.VIEW_ABOUT_PDF(2, 5, '1.2 MB', 'received'), 'Page 2 of 5 · Received, 1.2 MB')
    assert.equal(copy.VIEW_ABOUT_PDF(1, 1, '80 KB', 'received'), 'Received: 1 page, 80 KB')
    assert.equal(copy.VIEW_ABOUT_PDF(1, 3, '1 MB', 'copy'), 'Page 1 of 3 · As it will be sent: made smaller, 1 MB')
    assert.match(read('../src/ui/photoView.ts'), /const pages = what === 'pdf' && !!pdf && pdf\.pages > 1/)
  })
})

describe('the review’s findings (2026-10-24)', () => {
  test('macOS TextEdit ends paragraphs with a backslash before a line break', () => {
    const doc = readRtf(new TextEncoder().encode('{\\rtf1\\ansi\\cocoartf2580\nHello\\\nWorld\\\n\\\nThird\\\r\nFourth}'))
    assert.deepEqual(paras(doc).map(textOf), ['Hello', 'World', '', 'Third', 'Fourth'])
  })

  test('the limit holds inside one long paragraph, and a flood of empty paragraphs or cells is cut too', () => {
    const one = readRtf(rtf('x'.repeat(50_000)), 2000)
    assert.equal(one.cut, true)
    assert.ok(allText(one).length < 3000)
    const cells = readRtf(rtf(`\\trowd\\pard\\intbl ${'\\cell'.repeat(400_000)}a\\cell\\row`), 10_000)
    assert.equal(cells.cut, true)
    const table = cells.blocks.find((b) => b.kind === 'table')
    assert.ok(!table || (table.kind === 'table' && table.rows.every((r) => r.length <= 63)), 'at most 63 cells a row')
    assert.equal(readRtf(rtf(`\\pard\\intbl ${'\\par'.repeat(500_000)}a\\cell\\row`), 10_000).cut, true)
    // Empty paragraphs in a cell are kept to two in a row, as outside one.
    const cell = readRtf(rtf('\\trowd\\pard\\intbl a\\par\\par\\par\\par\\par b\\cell\\row'))
    const t = cell.blocks[0]
    assert.ok(t.kind === 'table' && t.rows[0][0].length === 4)
    // Only cut when there's more: a document of exactly the limit isn't.
    assert.equal(readRtf(rtf('x'.repeat(100)), 101).cut, false)
  })

  test('drawing the small picture measures a bounded amount of text, however long the paragraph', () => {
    let measured = 0
    const ctx = { fillStyle: '', font: '', fillRect() {}, fillText() {}, measureText: (t: string) => ((measured += t.length), { width: t.length * 5 }) }
    const canvas = { width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement
    for (const body of ['x'.repeat(20_000), `${'word '.repeat(20_000)}`]) {
      measured = 0
      assert.equal(drawTextThumb(canvas, readRtf(rtf(body), 2000), 108), true)
      assert.ok(measured < 50_000, `${measured} characters measured`)
    }
  })

  test('a line break between { and \\* or a group’s first word doesn’t let its text through', () => {
    const doc = readRtf(rtf('{\r\n\\*\\fldinst HYPERLINK "http://evil.example"}{\r\n\\info{\\author Jane}}{\n\\header Top\\par}Body\\par'))
    assert.equal(textOf(doc.blocks[0]), 'Body')
    for (const gone of ['evil', 'Jane', 'Top']) assert.ok(!allText(doc).includes(gone), gone)
  })

  test('cells left without \\row end their table before what follows; Word 6’s numbering and nested tables’ copies aren’t shown twice', () => {
    const doc = readRtf(rtf('\\pard\\intbl A\\cell B\\cell\\pard After\\par Later\\par'))
    assert.deepEqual(
      doc.blocks.map((b) => b.kind),
      ['table', 'para', 'para'],
    )
    const pn = readRtf(rtf("{\\pntext\\f1 \\'b7\\tab}{\\pn\\pnlvlblt{\\pntxtb \\'b7}}Item\\par{\\nonesttables\\par}"))
    assert.equal(textOf(pn.blocks[0]), '•\tItem')
    assert.equal(pn.blocks.length, 1)
  })

  test('a symbol font’s letters are bullets only in a bullet; \\plain goes back to the default font', () => {
    const doc = readRtf(rtf("{\\f1 quiet vineyard}\\par{\\listtext\\f1 \\'b7}x\\par{\\f2\\plain \\'e9}\\par"))
    assert.equal(textOf(doc.blocks[0]), 'quiet vineyard')
    assert.equal(textOf(doc.blocks[1]), '•x')
    assert.equal(textOf(doc.blocks[2]), 'é', 'windows-1252 again, not the Cyrillic font')
  })

  test('nothing after the document’s closing brace, no control characters, and no size of 0 or less', () => {
    const doc = readRtf(new TextEncoder().encode('{\\rtf1 {\\pict\\pngblip 00}}\u0000after'))
    assert.equal(hasText(doc), false)
    assert.equal(textOf(readRtf(rtf('a\u0001b\tc\\par')).blocks[0]), 'ab\tc')
    assert.equal(paras(readRtf(rtf('\\fs-10 x\\par')))[0].runs[0].size, undefined)
  })

  test('the composer counts every file of each kind; the "can’t show" note waits until the picture was tried', () => {
    assert.match(read('../src/prep/list.ts'), /const all = \{\n\s+photos: rows\.filter\(\(r\) => r\.photo && isPhoto\(r\)\)\.length,\n\s+videos: rows\.filter\(\(r\) => r\.video\)\.length,\n\s+docs: rows\.filter\(\(r\) => r\.doc\)\.length,\n\s+audio: rows\.filter\(\(r\) => r\.audio\)\.length,/)
    assert.match(read('../src/ui/items.ts'), /else if \(tried && doc && doc !== 'pdf' && doc !== 'text'\) tip/)
    assert.match(read('../src/main.ts'), /const textWaiting = !!docPreviewOf\(item\.data\) && receivedTried !== item/)
    assert.match(read('../src/ui/photoView.ts'), /if \(what !== 'pdf'\) \$\('pv-page'\)\.textContent = ''/)
  })
})

// Plain text: .txt files at the very least.
describe('plain text', () => {
  const bytes = (s: string) => new TextEncoder().encode(s)

  test('any file that is text by its bytes is shown as text, whatever its name; anything else isn’t', () => {
    for (const s of ['Shopping list\n- milk\n- bread\n', 'a,b,c\n1,2,3\r\n', '<!doctype html><p>hi</p>', '{"a": 1}', 'Grüße, 你好, café\n', '﻿with a BOM\n'])
      assert.equal(docPreviewOf(bytes(s)), 'text', s)
    // Control characters (binary), invalid UTF-8, a zip, an SVG (a picture), and too short to tell.
    for (const b of [Uint8Array.of(0, 1, 2, 3, 4, 5), Uint8Array.of(0x61, 0xff, 0xfe, 0x62, 0x63), bytes('PK\x03\x04rest of a zip'), bytes('<svg xmlns="x"></svg>'), bytes('ab')])
      assert.equal(docPreviewOf(b), null)
    // A real document is still shown as its kind.
    assert.equal(docPreviewOf(bytes('%PDF-1.7\n')), 'pdf')
    assert.equal(docPreviewOf(bytes('{\\rtf1 hi}')), 'rtf')
  })

  test('shown as it is: every line, its spaces, and blank lines, nothing simplified', async () => {
    const { readText } = await import('../src/docview/text.ts')
    const doc = readText(bytes('Title\r\n\r\n    indented\tline\nlast'))
    assert.equal(doc.plain, true)
    assert.equal(doc.cut, false)
    assert.equal(doc.pictures, 0)
    assert.deepEqual(paras(doc).map(textOf), ['Title', '', '    indented\tline', 'last'])
    assert.ok(hasText(doc))
    // Long files only as far as a preview shows, and never decoded further than that.
    const long = readText(bytes('x'.repeat(50)), 20)
    assert.deepEqual([long.cut, paras(long).map(textOf).join('')], [true, 'x'.repeat(20)])
    assert.equal(readText(bytes('é'.repeat(30)), 5).cut, true)
    // A character cut off where decoding stops isn't shown as a broken one.
    assert.doesNotMatch(paras(readText(bytes('é'.repeat(30)), 5)).map(textOf).join(''), /�/)
  })

  test('the review (2026-10-26): text that starts like another kind of file, a page with an icon, an emoji cut, a file that stops being text', async () => {
    const { readText } = await import('../src/docview/text.ts')
    // describeOther's guesses would call these a picture, a video and an archive: they're text.
    for (const s of ['BMI,weight\n22,70\n', 'Tax-free allowance\n', '07070 phone list\n', '<p>An icon <svg width=1></svg> in a page</p>'])
      assert.equal(docPreviewOf(bytes(s)), 'text', s)
    // A real SVG is a picture, whatever comes before its <svg>.
    for (const s of ['<svg xmlns="x"></svg>', '<?xml version="1.0"?>\n<!-- made by hand -->\n<!DOCTYPE svg>\n<svg></svg>']) assert.equal(docPreviewOf(bytes(s)), null, s)
    // Never half an emoji at the cut.
    const cut = readText(bytes('😀'.repeat(30)), 5)
    assert.equal(paras(cut).map(textOf).join(''), '😀😀')
    assert.equal(cut.cut, true)
    // A script with an archive after it: shown as far as its text goes, then "only the beginning".
    const installer = new Uint8Array(6000)
    installer.set(bytes('#!/bin/sh\necho installing\n'))
    installer.fill(0, 5000)
    const got = readText(installer)
    assert.equal(got.cut, true)
    assert.doesNotMatch(paras(got).map(textOf).join('\n'), /[\u0000\ufffd]/)
    // And bytes that aren't UTF-8 past the first few KB: up to them, never a � for them.
    const latin = new Uint8Array([...bytes('a'.repeat(5000)), 0xe9, ...bytes('tail')])
    assert.deepEqual([readText(latin).cut, paras(readText(latin)).map(textOf).join('')], [true, 'a'.repeat(5000)])
    // A blank received text file gets no "open it in Word" tip.
    assert.match(read('../src/ui/items.ts'), /else if \(tried && doc && doc !== 'pdf' && doc !== 'text'\) tip/)
    assert.match(read('../src/style.css'), /\.doc-p\.doc-plain \{\n\s+margin: 0;\n[^\n]*\n\s+unicode-bidi: plaintext;/)
  })

  test('its words: no "simplified" note, and no "full size", which suggests it could be made smaller', () => {
    assert.equal(copy.VIEW_ABOUT_DOC('12 KB', 'full', true), 'As it will be sent: 12 KB')
    assert.equal(copy.VIEW_ABOUT_DOC('12 KB', 'received', true), 'Received: 12 KB')
    const view = read('../src/ui/photoView.ts')
    assert.match(view, /if \(!doc\.plain\) \{\n\s+const note = document\.createElement\('p'\)\n\s+note\.className = 'doc-note'\n\s+note\.textContent = shrinkCopy\.DOC_SIMPLIFIED\(doc\.pictures\)/)
    // As text, never as markup, in one paragraph the page keeps the spaces and lines of.
    const render = read('../src/docview/render.ts')
    assert.match(render, /el\.className = 'doc-p doc-plain'\n\s+el\.textContent = /)
    assert.match(read('../src/style.css'), /\.doc-page \{[^}]*white-space: pre-wrap;/)
    // The composer offers it for any row that isn't a photo, video, audio file or zip.
    assert.match(read('../src/tray.ts'), /const docPreview = \(row: Row\) => \(row\.sending && !row\.photo && !row\.video && !row\.audio && !row\.zip \? docPreviewOf\(row\.sending\.data\) : null\)/)
  })
})

test('the About page says plain text shows as it is, and only in UTF-8', () => {
  const about = read('../about/index.html').replace(/\s+/g, ' ')
  assert.match(about, /A plain text file, like a note, a CSV file or code, shows as it is, line by line, whatever its name, when its text is in UTF-8, as most is today\./)
})
