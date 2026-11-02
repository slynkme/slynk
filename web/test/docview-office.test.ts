// Word and LibreOffice Writer documents shown as their text: read by
// docview/docx.ts and docview/odt.ts, through docview/xmlscan.ts and docview/zipread.ts, into the
// model render.ts draws, as RTF's is (docview.test.ts). The fixtures are built here with fflate.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { strToU8, zipSync, type Zippable } from 'fflate'
import { docPreviewOf } from '../src/docview/index.ts'
import { readDocx, symbolFont } from '../src/docview/docx.ts'
import { readOdt } from '../src/docview/odt.ts'
import { MAX_DOC_CHARS, hasText, type Block, type DocText, type Para, type Table } from '../src/docview/model.ts'
import { formatNumber } from '../src/docview/numbers.ts'
import { drawTextThumb } from '../src/docview/render.ts'
import { decodeXml, scanXml, type XmlEl } from '../src/docview/xmlscan.ts'
import { MAIN_CAP } from '../src/docview/zipread.ts'

const textOf = (b: Block | undefined) => (b?.kind === 'para' ? b.runs.map((r) => r.text).join('') : '')
const paras = (doc: DocText) => doc.blocks.filter((b): b is Para => b.kind === 'para')
const texts = (doc: DocText) => paras(doc).map(textOf)
const tables = (doc: DocText) => doc.blocks.filter((b): b is Table => b.kind === 'table')
const cells = (t: Table) => t.rows.map((row) => row.map((cell) => cell.map(textOf)))
const allText = (doc: DocText) => JSON.stringify(doc)
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

type Files = Record<string, string | Uint8Array | [Uint8Array, { level: 0 }]>
const zip = (files: Files) =>
  zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, typeof v === 'string' ? strToU8(v) : v])) as Zippable)

// ---- Word ----

const WNS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" ' +
  'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" ' +
  'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"'
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
const rels = (list: [string, string][]) =>
  `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list
    .map(([type, target], i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`)
    .join('')}</Relationships>`
const CT = `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`

/** A Word file with this body, and these other parts (styles.xml, numbering.xml…), listed in its relationships. */
function docx(body: string, parts: Record<string, string> = {}, extra: Files = {}): Uint8Array {
  return zip({
    '[Content_Types].xml': CT,
    '_rels/.rels': rels([['officeDocument', 'word/document.xml']]),
    'word/document.xml': `${XML}<w:document ${WNS}><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body></w:document>`,
    'word/_rels/document.xml.rels': rels(Object.keys(parts).map((name) => [name.replace(/\d*\.xml$/, ''), name])),
    ...Object.fromEntries(Object.entries(parts).map(([name, xml]) => [`word/${name}`, xml])),
    ...extra,
  })
}
const p = (inner: string, pPr = '') => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${inner}</w:p>`
const r = (text: string, rPr = '') => `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t xml:space="preserve">${text}</w:t></w:r>`
const styles = (inner: string) => `${XML}<w:styles ${WNS}>${inner}</w:styles>`
const numbering = (inner: string) => `${XML}<w:numbering ${WNS}>${inner}</w:numbering>`

describe('reading Word documents', () => {
  test('paragraphs, with bold, italic, underline, strikethrough, raised and lowered text, sizes, alignment and indents', () => {
    const doc = readDocx(
      docx(
        p(r('Heading', '<w:b/><w:sz w:val="32"/>'), '<w:jc w:val="center"/>') +
          p(
            r('Plain ') +
              r('italic', '<w:i/>') +
              r(', ') +
              r('under', '<w:u w:val="single"/>') +
              r(', ') +
              r('not under', '<w:u w:val="none"/>') +
              r(', ') +
              r('gone', '<w:strike/>') +
              r(', ') +
              r('twice', '<w:dstrike/>') +
              r(', x') +
              r('2', '<w:vertAlign w:val="superscript"/>') +
              r(', H') +
              r('2', '<w:vertAlign w:val="subscript"/>') +
              r('O, ') +
              r('not bold', '<w:b w:val="0"/><w:i w:val="false"/>'),
            '<w:jc w:val="both"/><w:ind w:left="1440" w:hanging="720"/>',
          ) +
          p(r('Right'), '<w:jc w:val="end"/>'),
      ),
    )
    const [heading, body, right] = paras(doc)
    assert.deepEqual(heading, { kind: 'para', runs: [{ text: 'Heading', bold: true, size: 16 }], align: 'center' })
    assert.equal(textOf(body), 'Plain italic, under, not under, gone, twice, x2, H2O, not bold')
    const run = (t: string) => body.runs.find((x) => x.text === t)!
    assert.equal(run('italic').italic, true)
    assert.equal(run('under').underline, true)
    assert.equal(run('gone').strike, true)
    assert.equal(run('twice').strike, true)
    assert.ok(body.runs.some((x) => x.text === '2' && x.sup))
    assert.ok(body.runs.some((x) => x.text === '2' && x.sub))
    // Text with the same formatting is one run, whatever splits it in the file.
    assert.deepEqual(
      body.runs.filter((x) => !x.italic && !x.underline && !x.strike && !x.sup && !x.sub).map((x) => x.text),
      ['Plain ', ', ', ', not under, ', ', ', ', x', ', H', 'O, not bold'],
    )
    // Where the first line starts: the left indent less the hanging one, in points.
    assert.equal(body.align, 'justify')
    assert.equal(body.indent, 36)
    assert.equal(right.align, 'right')
  })

  test('tabs, line breaks, symbols and characters in every way XML writes them', () => {
    const doc = readDocx(
      docx(
        p(
          r('a') +
            '<w:r><w:tab/><w:t>b</w:t><w:br/><w:t>c</w:t><w:cr/><w:t>d</w:t><w:noBreakHyphen/><w:t>e</w:t><w:sym w:font="Symbol" w:char="F0B7"/><w:sym w:font="Wingdings" w:char="F0FC"/></w:r>' +
            r(' caf&#233; &#x20AC;5 &lt;tag&gt; &amp; &quot;q&quot; &apos;s&apos; 😀'),
        ) + p('<w:r><w:t>  trimmed  </w:t></w:r><w:r><w:t xml:space="preserve">  kept  </w:t></w:r>'),
      ),
    )
    assert.equal(texts(doc)[0], 'a\tb\nc\nd‑e•✓ café €5 <tag> & "q" \'s\' 😀')
    // Without xml:space="preserve", Word drops a piece of text's end spaces.
    assert.equal(texts(doc)[1], 'trimmed  kept  ')
  })

  test('styles: the defaults, the default paragraph style, headings based on it, character styles, and the text’s own over all of them', () => {
    const st = styles(
      '<w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>' +
        '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:pPr><w:jc w:val="both"/></w:pPr></w:style>' +
        '<w:style w:type="paragraph" w:styleId="Heading1"><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>' +
        '<w:style w:type="paragraph" w:styleId="Heading2"><w:basedOn w:val="Heading1"/><w:rPr><w:i/></w:rPr></w:style>' +
        '<w:style w:type="character" w:styleId="Strong"><w:rPr><w:b/></w:rPr></w:style>' +
        // Styles based on each other in a circle don't go round for ever.
        '<w:style w:type="paragraph" w:styleId="Loop1"><w:basedOn w:val="Loop2"/><w:rPr><w:u w:val="single"/></w:rPr></w:style>' +
        '<w:style w:type="paragraph" w:styleId="Loop2"><w:basedOn w:val="Loop1"/></w:style>',
    )
    const doc = readDocx(
      docx(
        p(r('Body ') + r('strong', '<w:rStyle w:val="Strong"/>')) +
          p(r('Title') + r(' plain', '<w:b w:val="0"/>'), '<w:pStyle w:val="Heading1"/>') +
          p(r('Sub'), '<w:pStyle w:val="Heading2"/>') +
          p(r('Loop'), '<w:pStyle w:val="Loop1"/>') +
          p(r('Unknown'), '<w:pStyle w:val="NoSuchStyle"/>'),
        { 'styles.xml': st },
      ),
    )
    const [body, title, sub, loop, unknown] = paras(doc)
    assert.deepEqual(body, { kind: 'para', align: 'justify', runs: [{ text: 'Body ', size: 11 }, { text: 'strong', bold: true, size: 11 }] })
    assert.deepEqual(title, { kind: 'para', align: 'center', runs: [{ text: 'Title', bold: true, size: 16 }, { text: ' plain', size: 16 }] })
    assert.deepEqual(sub.runs, [{ text: 'Sub', bold: true, italic: true, size: 16 }])
    assert.equal(loop.runs[0].underline, true)
    assert.deepEqual(unknown, { kind: 'para', align: 'justify', runs: [{ text: 'Unknown', size: 11 }] })
  })

  test('lists: their bullets and numbers as Word counts them, deeper levels starting again, a list told to start at 5', () => {
    const lvl = (ilvl: number, fmt: string, text: string, left: number, extra = '') =>
      `<w:lvl w:ilvl="${ilvl}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/>${extra}<w:lvlText w:val="${text}"/><w:pPr><w:ind w:left="${left}" w:hanging="360"/></w:pPr></w:lvl>`
    const num = numbering(
      `<w:abstractNum w:abstractNumId="0">${lvl(0, 'bullet', '', 720)}${lvl(1, 'bullet', 'o', 1440)}${lvl(2, 'bullet', '', 2160)}</w:abstractNum>` +
        `<w:abstractNum w:abstractNumId="1">${lvl(0, 'decimal', '%1.', 720)}${lvl(1, 'lowerLetter', '%2)', 1440)}${lvl(2, 'upperRoman', '%1.%2.%3', 2160, '<w:suff w:val="space"/>')}</w:abstractNum>` +
        `<w:abstractNum w:abstractNumId="2">${lvl(0, 'none', '', 720)}</w:abstractNum>` +
        '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>' +
        '<w:num w:numId="3"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="5"/></w:lvlOverride></w:num>' +
        '<w:num w:numId="4"><w:abstractNumId w:val="2"/></w:num>',
    )
    const st = styles('<w:style w:type="paragraph" w:styleId="ListBullet"><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr></w:style>')
    const item = (text: string, numId: number, ilvl = 0) => p(r(text), `<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr>`)
    const doc = readDocx(
      docx(
        item('One', 1) +
          item('Two', 1, 1) +
          item('Three', 1, 2) +
          item('First', 2) +
          item('Sub a', 2, 1) +
          item('Sub b', 2, 1) +
          item('Deep', 2, 2) +
          item('Second', 2) +
          item('Sub again', 2, 1) +
          item('Fifth', 3) +
          item('Sixth', 3) +
          item('Plain', 0) +
          item('No such list', 9) +
          item('No number', 4) +
          p(r('Styled'), '<w:pStyle w:val="ListBullet"/>'),
        { 'styles.xml': st, 'numbering.xml': num },
      ),
    )
    assert.deepEqual(texts(doc), [
      '•\tOne',
      'o\tTwo',
      '▪\tThree',
      '1.\tFirst',
      'a)\tSub a',
      'b)\tSub b',
      // Each level's number in its own format, as Word writes "%1.%2.%3".
      '1.b.I Deep',
      '2.\tSecond',
      'a)\tSub again',
      '5.\tFifth',
      '6.\tSixth',
      'Plain',
      'No such list',
      'No number',
      '•\tStyled',
    ])
    // Each item starts where its bullet sits.
    assert.deepEqual(
      paras(doc)
        .slice(0, 3)
        .map((x) => x.indent),
      [18, 54, 90],
    )
  })

  test('tables: rows of cells, each its paragraphs; a table in a cell is flattened into it; a paragraph after one is apart', () => {
    const tc = (inner: string) => `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr>${inner}</w:tc>`
    const inner = `<w:tbl><w:tblPr/><w:tr>${tc(p(r('x')))}${tc(p(r('y')))}</w:tr><w:tr>${tc(p(r('z')))}${tc(p(''))}</w:tr></w:tbl>`
    const doc = readDocx(
      docx(
        `<w:tbl><w:tblPr><w:tblStyle w:val="Grid"/></w:tblPr><w:tblGrid><w:gridCol w:w="2000"/></w:tblGrid>` +
          `<w:tr><w:trPr><w:cantSplit/></w:trPr>${tc(p(r('A1')))}${tc(p(r('B1')) + p(r('second line')))}</w:tr>` +
          `<w:tr>${tc(p(r('A2')))}${tc(inner + p(''))}</w:tr></w:tbl>` +
          p(r('After')),
      ),
    )
    assert.equal(doc.blocks.length, 2)
    assert.deepEqual(cells(tables(doc)[0]), [
      [['A1'], ['B1', 'second line']],
      [['A2'], ['x\ty\nz', '']],
    ])
    assert.equal(textOf(doc.blocks[1]), 'After')
    // At most 63 cells a row: the rest join the last.
    const wide = readDocx(docx(`<w:tbl><w:tr>${Array.from({ length: 100 }, (_, i) => tc(p(r(`c${i}`)))).join('')}</w:tr></w:tbl>`))
    const row = tables(wide)[0].rows[0]
    assert.equal(row.length, 63)
    assert.equal(row[62].length, 38)
  })

  test('links and fields show their text, never their codes, nested ones too', () => {
    const doc = readDocx(
      docx(
        p('<w:hyperlink r:id="rId9">' + r('a link') + '</w:hyperlink>') +
          p('<w:fldSimple w:instr=" PAGE ">' + r('7') + '</w:fldSimple>') +
          p(
            '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> HYPERLINK "https://evil.example" </w:instrText></w:r>' +
              r('code text') +
              '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
              r('here') +
              '<w:r><w:fldChar w:fldCharType="end"/></w:r>',
          ) +
          p(
            '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>IF </w:instrText></w:r>' +
              '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>DATE</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
              r('inner') +
              '<w:r><w:fldChar w:fldCharType="end"/></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
              r('outer') +
              '<w:r><w:fldChar w:fldCharType="end"/></w:r>' +
              r(' after'),
          ),
        {},
        { 'word/_rels/document.xml.rels': rels([['hyperlink', 'https://link.example']]) },
      ),
    )
    assert.deepEqual(texts(doc), ['a link', '7', 'here', 'outer after'])
    for (const gone of ['evil', 'link.example', 'code text', 'inner', 'HYPERLINK', 'PAGE', 'DATE']) assert.ok(!allText(doc).includes(gone), gone)
  })

  test('leaves out deleted and hidden text, field codes, properties, text boxes, and the parts that are headers, footers, footnotes and comments', () => {
    const st = styles(
      '<w:style w:type="paragraph" w:styleId="Secret"><w:rPr><w:vanish/></w:rPr></w:style><w:style w:type="character" w:styleId="Hide"><w:rPr><w:vanish/></w:rPr></w:style>',
    )
    const textBox = (words: string) =>
      `<w:r><w:drawing><wp:anchor><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:txbx><w:txbxContent>${p(r(words))}</w:txbxContent></wps:txbx></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>`
    const vmlBox = (words: string) => `<w:r><w:pict><v:shape><v:textbox><w:txbxContent>${p(r(words))}</w:txbxContent></v:textbox></v:shape></w:pict></w:r>`
    const doc = readDocx(
      docx(
        p(
          r('Kept') +
            '<w:del w:id="1" w:author="Jane Doe" w:date="2026-01-01T00:00:00Z"><w:r><w:delText>struck out</w:delText></w:r></w:del>' +
            '<w:ins w:id="2" w:author="Jane Doe"><w:r><w:t xml:space="preserve"> inserted</w:t></w:r></w:ins>' +
            '<w:moveFrom w:id="3"><w:r><w:t>moved away</w:t></w:r></w:moveFrom><w:moveTo w:id="4"><w:r><w:t xml:space="preserve"> moved here</w:t></w:r></w:moveTo>' +
            r(' hidden words', '<w:vanish/>') +
            r(' styled hidden', '<w:rStyle w:val="Hide"/>') +
            '<w:commentRangeStart w:id="0"/><w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r><w:r><w:footnoteReference w:id="1"/></w:r>' +
            '<w:sdt><w:sdtPr><w:alias w:val="Field"/><w:placeholder><w:docPart w:val="x"/></w:placeholder><w:text/><w:r><w:t>sdt property</w:t></w:r></w:sdtPr><w:sdtContent>' +
            r(' content') +
            '</w:sdtContent></w:sdt>' +
            '<w:r><w:rPr><w:b/><w:rPrChange w:id="5" w:author="Jane"><w:rPr><w:i/></w:rPr></w:rPrChange></w:rPr><w:t xml:space="preserve"> now bold</w:t></w:r>' +
            textBox('in a text box') +
            vmlBox('in an old text box') +
            `<w:r><mc:AlternateContent><mc:Choice Requires="wps">${textBox('choice box').replace(/^<w:r>|<\/w:r>$/g, '')}</mc:Choice><mc:Fallback>${vmlBox('fallback box').replace(/^<w:r>|<\/w:r>$/g, '')}</mc:Fallback></mc:AlternateContent></w:r>`,
        ) + p(r('A secret paragraph'), '<w:pStyle w:val="Secret"/>'),
        { 'styles.xml': st, 'comments.xml': `${XML}<w:comments ${WNS}><w:comment w:id="0" w:author="Jane Doe">${p(r('A comment'))}</w:comment></w:comments>` },
        {
          'word/header1.xml': `${XML}<w:hdr ${WNS}>${p(r('Page header'))}</w:hdr>`,
          'word/footer1.xml': `${XML}<w:ftr ${WNS}>${p(r('Page footer'))}</w:ftr>`,
          'word/footnotes.xml': `${XML}<w:footnotes ${WNS}><w:footnote w:id="1">${p(r('A footnote'))}</w:footnote></w:footnotes>`,
        },
      ),
    )
    assert.equal(texts(doc)[0], 'Kept inserted moved here content now bold')
    assert.equal(paras(doc)[0].runs.find((x) => x.text.includes('now bold'))?.italic, undefined, 'the formatting before a tracked change isn’t used')
    for (const gone of ['Jane', 'struck', 'moved away', 'hidden', 'sdt property', 'Field', 'text box', 'choice', 'fallback', 'secret', 'comment', 'header', 'footer', 'footnote'])
      assert.ok(!allText(doc).toLowerCase().includes(gone.toLowerCase()), gone)
    // Text boxes and shapes aren't pictures.
    assert.equal(doc.pictures, 0)
  })

  test('a deleted paragraph end joins its text to the next paragraph’s, as accepting the change does', () => {
    const doc = readDocx(docx(p(r('First half'), '<w:rPr><w:del w:id="1" w:author="A"/></w:rPr>') + p(r(' and second')) + p(r('Next'))))
    assert.deepEqual(texts(doc), ['First half and second', 'Next'])
  })

  test('pictures, charts and objects are counted once each, an alternative’s fallback not again, and their data isn’t shown', () => {
    const inline = '<w:r><w:drawing><wp:inline><wp:docPr id="1" name="Photo of Jane"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:blipFill><a:blip r:embed="rId5"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>'
    const chart = '<w:r><w:drawing><wp:anchor><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId6"/></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>'
    const alt = '<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><a:graphic><a:graphicData uri="x"><a:blip/></a:graphicData></a:graphic></w:drawing></mc:Choice><mc:Fallback><w:pict><v:shape><v:imagedata r:id="rId7"/></v:shape></w:pict></mc:Fallback></mc:AlternateContent></w:r>'
    const object = '<w:r><w:object><v:shape><v:imagedata r:id="rId8"/></v:shape><o:OLEObject ProgID="Excel.Sheet.12"/></w:object></w:r>'
    const rule = '<w:r><w:pict><v:rect o:hr="t"/></w:pict></w:r>'
    const doc = readDocx(docx(p(r('Before') + inline + chart + alt + object + rule + r(' after'))))
    assert.equal(texts(doc)[0], 'Before after')
    assert.equal(doc.pictures, 4)
    assert.ok(!allText(doc).includes('Jane'))
  })

  test('an equation shows as its text', () => {
    const doc = readDocx(docx(p(r('So ') + '<m:oMath><m:r><m:t>x=2</m:t></m:r><m:sSup><m:e><m:r><m:t>y</m:t></m:r></m:e><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup></m:oMath>')))
    assert.equal(texts(doc)[0], 'So x=2y2')
  })

  test('Strict Open XML, any prefix for the namespace, and the document part where the package says it is', () => {
    const strict = zip({
      '[Content_Types].xml': CT,
      '_rels/.rels': rels([['officeDocument', 'word/document.xml']]),
      'word/document.xml': `${XML}<doc:document xmlns:doc="http://purl.oclc.org/ooxml/wordprocessingml/main"><doc:body><doc:p><doc:r><doc:rPr><doc:b doc:val="true"/></doc:rPr><doc:t>Strict</doc:t></doc:r></doc:p></doc:body></doc:document>`,
    })
    assert.deepEqual(paras(readDocx(strict))[0].runs, [{ text: 'Strict', bold: true }])
    const unprefixed = zip({
      '[Content_Types].xml': CT,
      'word/document.xml': `${XML}<document xmlns="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><body><p><r><t>Default namespace</t></r></p></body></document>`,
    })
    assert.equal(texts(readDocx(unprefixed))[0], 'Default namespace')
    const elsewhere = zip({
      '[Content_Types].xml': CT,
      '_rels/.rels': rels([['officeDocument', '/word/main.xml']]),
      'word/document.xml': `${XML}<w:document ${WNS}><w:body>${p(r('Decoy'))}</w:body></w:document>`,
      'word/main.xml': `${XML}<w:document ${WNS}><w:body>${p(r('The real one'))}</w:body></w:document>`,
    })
    assert.deepEqual(texts(readDocx(elsewhere)), ['The real one'])
  })

  test('only the beginning of a very long document, and at most two empty paragraphs in a row', () => {
    const long = readDocx(docx(p(r('word '.repeat(100))).repeat(500)), 10_000)
    assert.equal(long.cut, true)
    assert.ok(paras(long).length < 30)
    assert.ok(allText(long).length < 15_000)
    assert.equal(readDocx(docx(p(r('A')) + p('').repeat(5) + p(r('B')))).blocks.length, 4)
    // The limit holds inside one long run; and only the beginning is said to be shown only when there's more.
    const one = readDocx(docx(p(r('x'.repeat(50_000)))), 2000)
    assert.equal(one.cut, true)
    assert.ok(allText(one).length < 3000)
    assert.equal(readDocx(docx(p(r('x'.repeat(100)))), 101).cut, false)
    assert.equal(readDocx(docx(p(r('x'.repeat(100))) + p(r('y'))), 101).cut, true)
    assert.equal(readDocx(docx(p(r('x'.repeat(100))) + p('').repeat(20)), 101).cut, false)
  })

  test('a flood of empty paragraphs or cells is cut short too', () => {
    const floodP = readDocx(docx('<w:p/>'.repeat(300_000) + p(r('end'))), 10_000)
    assert.equal(floodP.cut, true)
    assert.ok(floodP.blocks.length <= 3)
    const floodC = readDocx(docx(`<w:tbl>${'<w:tr><w:tc><w:p/></w:tc></w:tr>'.repeat(100_000)}</w:tbl>${p(r('end'))}`), 10_000)
    assert.equal(floodC.cut, true)
    assert.ok(tables(floodC)[0].rows.length <= 10_000)
  })
})

// ---- LibreOffice Writer ----

const ONS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" ' +
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" ' +
  'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" ' +
  'xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" office:version="1.3"'
const MANIFEST = `${XML}<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>`

/** A Writer file with this body, these automatic styles (content.xml) and named ones (styles.xml). */
function odt(body: string, auto = '', named = '', extra: Files = {}): Uint8Array {
  return zip({
    mimetype: [strToU8('application/vnd.oasis.opendocument.text'), { level: 0 }],
    'META-INF/manifest.xml': MANIFEST,
    'content.xml': `${XML}<office:document-content ${ONS}><office:automatic-styles>${auto}</office:automatic-styles><office:body><office:text>${body}</office:text></office:body></office:document-content>`,
    'styles.xml': `${XML}<office:document-styles ${ONS}><office:styles>${named}</office:styles><office:master-styles><style:master-page style:name="Standard"><style:header><text:p>Page header</text:p></style:header></style:master-page></office:master-styles></office:document-styles>`,
    ...extra,
  })
}
const tp = (inner: string, style = '') => `<text:p${style ? ` text:style-name="${style}"` : ''}>${inner}</text:p>`
const span = (inner: string, style: string) => `<text:span text:style-name="${style}">${inner}</text:span>`
const tstyle = (name: string, props: string, family = 'text', parent = '') =>
  `<style:style style:name="${name}" style:family="${family}"${parent ? ` style:parent-style-name="${parent}"` : ''}><style:text-properties ${props}/></style:style>`

describe('reading LibreOffice Writer documents', () => {
  test('spans with their styles: bold, italic, underline, strikethrough, raised and lowered text, sizes', () => {
    const auto =
      tstyle('T1', 'fo:font-weight="bold"') +
      tstyle('T2', 'fo:font-style="italic"') +
      tstyle('T3', 'style:text-underline-style="solid" style:text-underline-width="auto"') +
      tstyle('T4', 'style:text-line-through-style="solid"') +
      tstyle('T5', 'style:text-position="super 58%"') +
      tstyle('T6', 'style:text-position="-33% 58%"') +
      tstyle('T7', 'fo:font-size="16pt"') +
      tstyle('T8', 'fo:font-weight="700" style:text-underline-style="none"') +
      tstyle('T9', 'fo:font-size="50%"')
    const doc = readOdt(
      odt(
        tp(
          `Plain ${span('bold', 'T1')} ${span('italic', 'T2')} ${span('under', 'T3')} ${span('gone', 'T4')} x${span('2', 'T5')} H${span('2', 'T6')}O ${span('big', 'T7')} ${span('heavy', 'T8')} ${span('half', 'T9')}`,
        ),
        auto,
        '<style:default-style style:family="paragraph"><style:text-properties fo:font-size="12pt"/></style:default-style>',
      ),
    )
    const [body] = paras(doc)
    assert.equal(textOf(body), 'Plain bold italic under gone x2 H2O big heavy half')
    const run = (t: string) => body.runs.find((x) => x.text === t)!
    assert.equal(run('bold').bold, true)
    assert.equal(run('italic').italic, true)
    assert.equal(run('under').underline, true)
    assert.equal(run('gone').strike, true)
    assert.ok(body.runs.some((x) => x.text === '2' && x.sup))
    assert.ok(body.runs.some((x) => x.text === '2' && x.sub))
    assert.equal(run('big').size, 16)
    assert.equal(run('heavy').bold, true)
    assert.equal(run('heavy').underline, undefined)
    assert.equal(run('half').size, 6)
    assert.equal(body.runs[0].size, 12)
  })

  test('headings from the named styles, with sizes as shares of the style they’re based on; alignment and indents', () => {
    const named =
      '<style:default-style style:family="paragraph"><style:text-properties fo:font-size="12pt"/></style:default-style>' +
      tstyle('Heading', 'fo:font-size="14pt"', 'paragraph') +
      '<style:style style:name="Heading_20_1" style:family="paragraph" style:parent-style-name="Heading"><style:paragraph-properties fo:text-align="center"/><style:text-properties fo:font-size="130%" fo:font-weight="bold"/></style:style>'
    const auto =
      '<style:style style:name="P1" style:family="paragraph" style:parent-style-name="Heading_20_1"><style:text-properties fo:font-style="italic"/></style:style>' +
      '<style:style style:name="P2" style:family="paragraph"><style:paragraph-properties fo:text-align="justify" fo:margin-left="0.5in" fo:text-indent="0in"/></style:style>' +
      '<style:style style:name="P3" style:family="paragraph"><style:paragraph-properties fo:text-align="end" fo:margin-left="2.54cm" fo:text-indent="-1.27cm"/></style:style>'
    const doc = readOdt(odt(`<text:h text:style-name="Heading_20_1" text:outline-level="1">Title</text:h>${tp('Italic title', 'P1')}${tp('Body', 'P2')}${tp('Right', 'P3')}`, auto, named))
    const [title, italic, body, right] = paras(doc)
    assert.deepEqual(title, { kind: 'para', align: 'center', runs: [{ text: 'Title', bold: true, size: 18.2 }] })
    assert.deepEqual(italic.runs, [{ text: 'Italic title', bold: true, italic: true, size: 18.2 }])
    assert.equal(body.align, 'justify')
    assert.equal(body.indent, 36)
    assert.equal(right.align, 'right')
    assert.equal(Math.round(right.indent!), 36)
    assert.ok(!allText(doc).includes('Page header'), 'headers aren’t read')
  })

  test('spaces as OpenDocument writes them: a run of them is one, none starts a paragraph, and text:s says how many', () => {
    const doc = readOdt(odt(tp('\n   Two  words\n  and <text:s text:c="3"/>three<text:tab/>tab<text:line-break/>line <text:span text:style-name="T1"> spaced</text:span>')))
    assert.equal(texts(doc)[0], 'Two words and    three\ttab\nline spaced')
  })

  test('lists: bullets, numbers with their prefix and suffix, deeper levels starting again, two levels shown, a list going on from the last', () => {
    const auto =
      '<text:list-style style:name="L1">' +
      '<text:list-level-style-bullet text:level="1" text:bullet-char="•"><style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="listtab" fo:margin-left="0.5in" fo:text-indent="-0.25in"/></style:list-level-properties></text:list-level-style-bullet>' +
      '<text:list-level-style-bullet text:level="2" text:bullet-char=""/>' +
      '</text:list-style>' +
      '<text:list-style style:name="L2">' +
      '<text:list-level-style-number text:level="1" style:num-suffix="." style:num-format="1"/>' +
      '<text:list-level-style-number text:level="2" style:num-prefix="(" style:num-suffix=")" style:num-format="a"/>' +
      '<text:list-level-style-number text:level="3" style:num-suffix="." style:num-format="i" text:display-levels="2"><style:list-level-properties><style:list-level-label-alignment text:label-followed-by="space" fo:margin-left="1in"/></style:list-level-properties></text:list-level-style-number>' +
      '</text:list-style>'
    const li = (inner: string, attrs = '') => `<text:list-item${attrs}>${inner}</text:list-item>`
    const doc = readOdt(
      odt(
        `<text:list text:style-name="L1">${li(tp('One') + `<text:list>${li(tp('Inner'))}</text:list>`)}${li(tp('Two') + tp('More of two'))}</text:list>` +
          `<text:list text:style-name="L2">${li(tp('First') + `<text:list>${li(tp('Sub a'))}${li(tp('Sub b') + `<text:list>${li(tp('Deep'))}</text:list>`)}</text:list>`)}${li(tp('Second') + `<text:list>${li(tp('Sub again'))}</text:list>`)}</text:list>` +
          tp('Between') +
          `<text:list text:style-name="L2" text:continue-numbering="true">${li(tp('Third'))}${li(tp('Tenth'), ' text:start-value="10"')}<text:list-header>${tp('A header')}</text:list-header></text:list>` +
          `<text:list text:style-name="L2">${li(tp('Again first'))}</text:list>` +
          `<text:list>${li(tp('No style'))}</text:list>`,
        auto,
      ),
    )
    assert.deepEqual(texts(doc), [
      '•\tOne',
      '•\tInner',
      '•\tTwo',
      'More of two',
      '1.\tFirst',
      '(a)\tSub a',
      '(b)\tSub b',
      'b.i. Deep',
      '2.\tSecond',
      '(a)\tSub again',
      'Between',
      '3.\tThird',
      '10.\tTenth',
      'A header',
      '1.\tAgain first',
      '•\tNo style',
    ])
    // Where the bullet sits: the margin less the label's own indent; the item's later paragraphs line up with it.
    assert.equal(paras(doc)[0].indent, 18)
    assert.equal(paras(doc)[3].indent, 18)
  })

  test('tables: rows of cells, repeated ones as many times as they say, covered cells, columns passed over; one in a cell flattened', () => {
    const row = (...c: string[]) => `<table:table-row>${c.join('')}</table:table-row>`
    const cell = (inner: string, attrs = '') => `<table:table-cell${attrs} office:value-type="string">${inner}</table:table-cell>`
    const inner = `<table:table>${row(cell(tp('x')), cell(tp('y')))}</table:table>`
    const doc = readOdt(
      odt(
        `<table:table table:name="T"><table:table-column table:number-columns-repeated="3"/><table:table-header-rows>${row(cell(tp('Head')), cell(tp('Two')), cell(tp('')))}</table:table-header-rows>` +
          `${row(cell(tp('A'), ' table:number-columns-spanned="2"'), '<table:covered-table-cell/>', cell(tp('C') + tp('C2')))}` +
          `<table:table-row table:number-rows-repeated="2">${cell(tp('rep'), ' table:number-columns-repeated="3"')}</table:table-row>` +
          `${row(cell(inner), cell(''))}</table:table>${tp('After')}`,
      ),
    )
    assert.deepEqual(cells(tables(doc)[0]), [
      [['Head'], ['Two'], ['']],
      [['A'], [''], ['C', 'C2']],
      [['rep'], ['rep'], ['rep']],
      [['rep'], ['rep'], ['rep']],
      [['x\ty'], ['']],
    ])
    assert.equal(textOf(doc.blocks[1]), 'After')
    // Repeated a million times, as spreadsheets' tables say: only as many as there's room for.
    const huge = readOdt(odt(`<table:table><table:table-row table:number-rows-repeated="1000000">${cell(tp('row'), ' table:number-columns-repeated="1000"')}</table:table-row></table:table>`), 10_000)
    assert.equal(huge.cut, true)
    assert.ok(tables(huge)[0].rows.length < 200)
    assert.ok(tables(huge)[0].rows.every((x) => x.length <= 63))
  })

  test('leaves out comments, notes, tracked deletions, hidden text and sections, text boxes, index templates and ruby readings; keeps index text, ruby’s base and a written-down number', () => {
    const auto = tstyle('Hidden', 'text:display="none"')
    const doc = readOdt(
      odt(
        '<text:sequence-decls><text:sequence-decl text:display-outline-level="0" text:name="Illustration"/></text:sequence-decls>' +
          '<text:tracked-changes><text:changed-region xml:id="ct1" text:id="ct1"><text:deletion><office:change-info><dc:creator>Jane Doe</dc:creator></office:change-info><text:p>struck out</text:p></text:deletion></text:changed-region></text:tracked-changes>' +
          tp(
            'Kept<text:change text:change-id="ct1"/>' +
              '<office:annotation office:name="c1"><dc:creator>Jane Doe</dc:creator><dc:date>2026-01-01T00:00:00</dc:date><text:p>A comment</text:p></office:annotation>' +
              ' text<office:annotation-end office:name="c1"/>' +
              '<text:note text:id="n1" text:note-class="footnote"><text:note-citation>1</text:note-citation><text:note-body><text:p>A footnote</text:p></text:note-body></text:note>' +
              span(' hidden words', 'Hidden') +
              '<text:hidden-text text:condition="true" text:string-value="conditional" text:is-hidden="true">conditional</text:hidden-text>' +
              '<draw:frame draw:name="Box"><draw:text-box><text:p>in a text box</text:p></draw:text-box></draw:frame>' +
              ' <text:ruby><text:ruby-base>漢</text:ruby-base><text:ruby-text>かん</text:ruby-text></text:ruby>',
          ) +
          '<text:section text:name="S1" text:display="none"><text:p>A hidden section</text:p></text:section>' +
          '<text:section text:name="S2"><text:p>A shown section</text:p></text:section>' +
          '<text:table-of-content text:name="TOC"><text:table-of-content-source text:outline-level="10"><text:index-title-template>Template title</text:index-title-template></text:table-of-content-source><text:index-body><text:p>Chapter 1<text:tab/>3</text:p></text:index-body></text:table-of-content>' +
          '<text:h text:outline-level="1"><text:number>1.</text:number>Numbered</text:h>',
        auto,
      ),
    )
    // A heading's number as the app wrote it down, where the headings' numbering doesn't say (the review).
    assert.deepEqual(texts(doc), ['Kept text 漢', 'A shown section', 'Chapter 1\t3', '1.\tNumbered'])
    for (const gone of ['Jane', 'struck', 'comment', 'footnote', 'hidden', 'conditional', 'text box', 'かん', 'Template', 'Illustration']) assert.ok(!allText(doc).includes(gone), gone)
    assert.equal(doc.pictures, 0)
  })

  test('a frame holding a picture or an object is counted once; text boxes and shapes aren’t pictures', () => {
    const image = '<draw:frame draw:name="Photo of Jane"><draw:image xlink:href="Pictures/a.jpg"/></draw:frame>'
    const object = '<draw:frame><draw:object xlink:href="./Object 1"/><draw:image xlink:href="./ObjectReplacements/Object 1"/></draw:frame>'
    const inBox = '<draw:frame><draw:text-box><text:p>caption<draw:frame><draw:image xlink:href="Pictures/b.png"/></draw:frame></text:p></draw:text-box></draw:frame>'
    const linked = '<draw:a xlink:href="https://example.com"><draw:frame><draw:image xlink:href="Pictures/c.png"/></draw:frame></draw:a>'
    const shape = '<draw:custom-shape><text:p>shape text</text:p></draw:custom-shape>'
    const doc = readOdt(odt(tp(`Before${image}${object}${inBox}${linked}${shape} after`)))
    assert.equal(texts(doc)[0], 'Before after')
    assert.equal(doc.pictures, 4)
    assert.ok(!allText(doc).includes('Jane'))
  })

  test('a password-locked file is refused rather than shown as noise', () => {
    const locked = odt(tp('Ciphertext'), '', '', {
      'META-INF/manifest.xml': MANIFEST.replace('manifest:media-type="text/xml"/>', 'manifest:media-type="text/xml"><manifest:encryption-data manifest:checksum-type="SHA1/1K"/></manifest:file-entry>'),
    })
    assert.throws(() => readOdt(locked))
  })

  test('the limits hold as for Word', () => {
    const long = readOdt(odt(tp('word '.repeat(100)).repeat(500)), 10_000)
    assert.equal(long.cut, true)
    assert.ok(paras(long).length < 30)
    assert.equal(readOdt(odt(tp('x'.repeat(100))), 101).cut, false)
    assert.equal(readOdt(odt(tp('A') + '<text:p/>'.repeat(5) + tp('B'))).blocks.length, 4)
    const flood = readOdt(odt('<text:p/>'.repeat(300_000) + tp('end')), 10_000)
    assert.equal(flood.cut, true)
    // text:s can't make a page of spaces.
    assert.ok(allText(readOdt(odt(tp('<text:s text:c="999999999"/>')))).length < 2000)
  })
})

// ---- Hostile files ----

describe('hostile files', () => {
  test('a part that expands hugely (a zip bomb) is read only as far as the cap', () => {
    // 20 MB of spaces, which compress to some 20 KB, and then text that's past the cap.
    const spaces = ' '.repeat(20_000_000)
    const doc = readDocx(docx(p(r('Early')) + spaces + p(r('LATE'))))
    assert.deepEqual(texts(doc), ['Early'])
    assert.equal(doc.cut, true)
    assert.ok(MAIN_CAP <= 16_000_000)
    // The parts it looks things up in are capped too: the document still reads.
    const bombStyles = readDocx(docx(p(r('Body')), { 'styles.xml': styles(spaces) }))
    assert.deepEqual(texts(bombStyles), ['Body'])
    // A small picture of the first lines needs only the start of the part (filler that doesn't count
    // towards the limit, so only the cap leaves LATE out: the review).
    const thumb = readDocx(docx(p(r('Start')) + ' '.repeat(3_000_000) + p(r('LATE'))), 2000)
    assert.ok(!allText(thumb).includes('LATE'))
    assert.equal(thumb.cut, true)
    assert.equal(readDocx(docx(p(r('Start')) + ' '.repeat(3_000_000) + p(r('LATE')))).cut, false)
    const odtBomb = readOdt(odt(tp('Early') + spaces + tp('LATE')))
    assert.deepEqual(texts(odtBomb), ['Early'])
  })

  test('a DOCTYPE’s entities are never expanded (no “billion laughs”), and nothing outside is read', () => {
    const laughs =
      '<!DOCTYPE w:document [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;"><!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">' +
      '<!ENTITY lol9 "&lol3;&lol3;&lol3;"><!ENTITY xxe SYSTEM "file:///etc/passwd"><!ENTITY tricky "]>">]>'
    const pkg = zip({
      '[Content_Types].xml': CT,
      'word/document.xml': `${XML}${laughs}<w:document ${WNS}><w:body>${p(r('A &lol9; B &xxe; C'))}</w:body></w:document>`,
    })
    const doc = readDocx(pkg)
    assert.equal(texts(doc)[0], 'A &lol9; B &xxe; C')
    assert.ok(!allText(doc).includes('lollol') && !allText(doc).includes('root:'))
    assert.equal(decodeXml('&amp;lt; &#0; &#xD800; &#x110000; &#65; &nbsp;'), '&lt; � � � A &nbsp;')
  })

  test('deep nesting, many namespaces, stray and missing end tags, quotes holding >, comments and CDATA never throw or hang', () => {
    const deep = readDocx(docx(`${'<w:customXml>'.repeat(100_000)}${p(r('deep'))}${'</w:customXml>'.repeat(100_000)}${p(r('after'))}`))
    assert.ok(hasText(deep))
    // Thousands of namespaces declared, nested or side by side: past 2000 they're passed over.
    const ns = Array.from({ length: 50 }, (_, i) => ` xmlns:n${i}="urn:x:${i}"`).join('')
    const nested = readDocx(docx(`${`<w:customXml${ns}>`.repeat(200)}${p(r('ns'))}${'</w:customXml>'.repeat(200)}`))
    assert.equal(texts(nested)[0], 'ns')
    const sideBySide = readDocx(docx(`<w:customXml${ns}>${p(r('x'))}</w:customXml>`.repeat(5000)), 1000)
    assert.ok(texts(sideBySide).length > 100)
    const messy = readDocx(
      docx(
        p(r('one') + '</w:tc></w:nonsense>' + r(' two')) +
          `<w:p><w:r><w:t a="x>y" b='>'>three</w:t></w:r><!-- <w:t>in a comment</w:t> --><?pi <w:t>in an instruction</w:t>?><w:r><w:t xml:space="preserve"><![CDATA[ <cdata> & ]]></w:t></w:r></w:p>` +
          '<w:p><w:r><w:t>unclosed',
      ),
    )
    assert.deepEqual(texts(messy).slice(0, 2), ['one two', 'three <cdata> & '])
    assert.ok(!allText(messy).includes('in a comment') && !allText(messy).includes('in an instruction'))
    // A document cut off partway shows what came before it, and says it's only the beginning.
    const whole = docx(p(r('First paragraph')) + p(r('Second')))
    const cut = zip({ '[Content_Types].xml': CT, 'word/document.xml': `${XML}<w:document ${WNS}><w:body>${p(r('First paragraph'))}<w:p><w:r><w:t>Seco` })
    assert.equal(readDocx(whole).cut, false)
    const partial = readDocx(cut)
    assert.equal(texts(partial)[0], 'First paragraph')
    assert.equal(partial.cut, true)
  })

  test('junk in the XML, or in the ZIP, never hangs: it reads what it can, or says it can’t', () => {
    for (let i = 0; i < 200; i++) {
      const junk = Array.from(crypto.getRandomValues(new Uint8Array(400)), (c) => String.fromCharCode(c)).join('')
      readDocx(docx(p(r('ok')) + junk))
      readOdt(odt(tp('ok') + junk))
    }
    const good = docx(p(r('A sentence of text. '.repeat(200))) + p(r('More.')), { 'styles.xml': styles('<w:style w:type="paragraph" w:styleId="X"/>') })
    for (let i = 0; i < 300; i++) {
      const bad = good.slice()
      for (let k = 0; k < 4; k++) bad[Math.floor(Math.random() * bad.length)] ^= 1 + Math.floor(Math.random() * 255)
      try {
        readDocx(bad)
      } catch {
        // refused: shown as "can't show this document here"
      }
    }
  })

  test('what isn’t a Word or Writer document is refused; a damaged part shows what came before', () => {
    assert.throws(() => readDocx(new TextEncoder().encode('Hello, not a zip')))
    assert.throws(() => readDocx(zip({ '[Content_Types].xml': CT })))
    assert.throws(() => readOdt(zip({ mimetype: [strToU8('application/vnd.oasis.opendocument.text'), { level: 0 }] })))
    // A part locked by the ZIP itself.
    const locked = docx(p(r('x')))
    for (let i = 0; i + 4 < locked.length; i++) if (locked[i] === 0x50 && locked[i + 1] === 0x4b && locked[i + 2] === 1 && locked[i + 3] === 2) locked[i + 8] |= 1
    assert.throws(() => readDocx(locked))
    // UTF-16, with its byte-order mark.
    const xml = `<?xml version="1.0" encoding="UTF-16"?><w:document ${WNS}><w:body>${p(r('Wide'))}</w:body></w:document>`
    const utf16 = new Uint8Array(2 + xml.length * 2)
    utf16.set([0xff, 0xfe])
    for (let i = 0; i < xml.length; i++) utf16[2 + 2 * i] = xml.charCodeAt(i)
    assert.equal(texts(readDocx(zip({ '[Content_Types].xml': CT, 'word/document.xml': utf16 })))[0], 'Wide')
  })

  test('drawing the small picture measures a bounded amount of text, however long the paragraph', () => {
    let measured = 0
    const ctx = { fillStyle: '', font: '', fillRect() {}, fillText() {}, measureText: (t: string) => ((measured += t.length), { width: t.length * 5 }) }
    const canvas = { width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement
    for (const doc of [readDocx(docx(p(r('x'.repeat(20_000)))), 2000), readOdt(odt(tp('word '.repeat(20_000))), 2000)]) {
      measured = 0
      assert.equal(drawTextThumb(canvas, doc, 108), true)
      assert.ok(measured < 50_000, `${measured} characters measured`)
    }
  })
})

describe('the review’s findings (2026-10-25)', () => {
  test('a tag with a long run of name characters is read in one pass: it froze a tab for minutes', () => {
    // 400,000 characters took about two minutes before (7.6 s for 100,000), and well under 0.1 s now.
    const t = performance.now()
    const doc = readDocx(docx(p(`<w:r><w:t a ${'b'.repeat(400_000)} c="1">x</w:t></w:r>`) + p(r('after'))), 2000)
    assert.ok(performance.now() - t < 2000, `${performance.now() - t} ms`)
    assert.deepEqual(texts(doc), ['x', 'after'])
    // Names without values, values without quotes and stray = are passed over, never stuck on.
    const seen: XmlEl[] = []
    scanXml(`<a b c=d e= "f" =g h='i' j="k/>l"/>`, { done: false, open: (el) => seen.push(el), close() {}, text() {} })
    assert.deepEqual(
      seen[0].attrs.map((a) => [a.name, a.value]),
      [
        ['e', 'f'],
        ['h', 'i'],
        ['j', 'k/>l'],
      ],
    )
  })

  test('copies of a repeated cell are never one array a row’s overflow joins', () => {
    const cell = (inner: string, attrs = '') => `<table:table-cell${attrs}>${inner}</table:table-cell>`
    const doc = readOdt(odt(`<table:table><table:table-row>${cell(tp('x'), ' table:number-columns-repeated="63"')}${cell(tp('y'.repeat(1000))).repeat(195)}</table:table-row></table:table>`))
    const row = tables(doc)[0].rows[0]
    assert.equal(row.length, 63)
    assert.notEqual(row[0], row[62])
    assert.deepEqual(row[0].map(textOf), ['x'])
    assert.ok(allText(doc).length < MAX_DOC_CHARS + 50_000)
  })

  test('a deleted list item’s end: the rest of it isn’t numbered as an item of its own', () => {
    const num = numbering('<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>')
    const item = (text: string, mark = '') => p(r(text), `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>${mark}`)
    const doc = readDocx(docx(item('Alpha', '<w:rPr><w:del w:id="1" w:author="A"/></w:rPr>') + item('Beta') + item('Gamma'), { 'numbering.xml': num }))
    assert.deepEqual(texts(doc), ['1.\tAlphaBeta', '2.\tGamma'])
  })

  test('the Symbol font’s Greek and maths, in w:sym and in text set in it; a list level told to start deeper down', () => {
    const doc = readDocx(
      docx(
        p('<w:r><w:sym w:font="Symbol" w:char="F061"/><w:t xml:space="preserve"> </w:t><w:sym w:font="Symbol" w:char="F0B1"/><w:sym w:font="Wingdings" w:char="F0FC"/></w:r>') +
          p(r('a+b=p', '<w:rFonts w:ascii="Symbol" w:hAnsi="Symbol"/>') + r(' plain')),
      ),
    )
    assert.deepEqual(texts(doc), ['α ±✓', 'α+β=π plain'])
    assert.equal(symbolFont(0xf0d6) + symbolFont(0xf0f0) + symbolFont(0x10), '√')
    const lvl = (ilvl: number, fmt: string, text: string) => `<w:lvl w:ilvl="${ilvl}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${text}"/></w:lvl>`
    const num = numbering(
      `<w:abstractNum w:abstractNumId="0">${lvl(0, 'decimal', '%1.')}${lvl(1, 'lowerLetter', '%2)')}</w:abstractNum>` +
        '<w:num w:numId="1"><w:abstractNumId w:val="0"/><w:lvlOverride w:ilvl="1"><w:startOverride w:val="5"/></w:lvlOverride></w:num>',
    )
    const item = (text: string, ilvl: number) => p(r(text), `<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="1"/></w:numPr>`)
    assert.deepEqual(texts(readDocx(docx(item('One', 0) + item('sub', 1) + item('Two', 0) + item('sub', 1), { 'numbering.xml': num }))), ['1.\tOne', 'e)\tsub', '2.\tTwo', 'e)\tsub'])
  })

  test('a deleted table row goes, and a ruby’s reading doesn’t show in Word’s files either', () => {
    const tc = (t: string) => `<w:tc>${p(r(t))}</w:tc>`
    const doc = readDocx(
      docx(`<w:tbl><w:tr>${tc('keep')}</w:tr><w:tr><w:trPr><w:del w:id="1" w:author="A"/></w:trPr>${tc('deleted row')}</w:tr><w:tr><w:trPr><w:ins w:id="2" w:author="A"/></w:trPr>${tc('inserted row')}</w:tr></w:tbl>` + p('<w:r><w:ruby><w:rubyPr><w:rubyAlign w:val="center"/></w:rubyPr><w:rt><w:r><w:t>とうきょう</w:t></w:r></w:rt><w:rubyBase><w:r><w:t>東京</w:t></w:r></w:rubyBase></w:ruby></w:r>')),
    )
    assert.deepEqual(cells(tables(doc)[0]), [[['keep']], [['inserted row']]])
    assert.deepEqual(texts(doc), ['東京'])
  })

  test('LibreOffice: headings numbered by its heading numbering, lists going on from the one they name, hidden paragraphs', () => {
    const named =
      '<text:outline-style style:name="Outline">' +
      '<text:outline-level-style text:level="1" style:num-format="1"><style:list-level-properties><style:list-level-label-alignment text:label-followed-by="space"/></style:list-level-properties></text:outline-level-style>' +
      '<text:outline-level-style text:level="2" style:num-format="1" text:display-levels="2"/>' +
      '<text:outline-level-style text:level="3" style:num-format=""/>' +
      '</text:outline-style>'
    const h = (level: number, text: string, extra = '') => `<text:h text:outline-level="${level}"${extra}>${text}</text:h>`
    const headings = readOdt(odt(h(1, 'Intro') + h(2, 'Background') + h(2, 'Aims') + h(3, 'Unnumbered') + h(1, 'Method') + h(2, '<text:number>2.1</text:number>Design') + h(1, 'Notes', ' text:is-list-header="true"'), '', named))
    assert.deepEqual(texts(headings), ['1 Intro', '1.1\tBackground', '1.2\tAims', 'Unnumbered', '2 Method', '2.1\tDesign', 'Notes'])
    const auto =
      '<text:list-style style:name="N"><text:list-level-style-number text:level="1" style:num-suffix="." style:num-format="1"/></text:list-style>' +
      '<text:list-style style:name="B"><text:list-level-style-bullet text:level="1" text:bullet-char="•"/></text:list-style>'
    const li = (t: string) => `<text:list-item>${tp(t)}</text:list-item>`
    const lists = readOdt(odt(`<text:list xml:id="list1" text:style-name="N">${li('a')}${li('b')}</text:list><text:list text:style-name="B">${li('bullet')}</text:list><text:list text:style-name="N" text:continue-list="list1">${li('c')}</text:list><text:list text:style-name="N">${li('anew')}</text:list>`, auto))
    assert.deepEqual(texts(lists), ['1.\ta', '2.\tb', '•\tbullet', '3.\tc', '1.\tanew'])
    const hidden = readOdt(odt(`<text:p><text:hidden-paragraph text:condition="ooow:1" text:is-hidden="true"/>SECRET para</text:p><text:p><text:hidden-paragraph text:condition="ooow:0" text:is-hidden="false"/>shown</text:p>`))
    assert.deepEqual(texts(hidden), ['shown'])
  })

  test('a paragraph of 200,000 runs reads, and is drawn one run at a time: a spread that big overflows the stack', () => {
    const doc = readDocx(docx(p(Array.from({ length: 100_000 }, (_, i) => r(i % 2 ? 'b' : 'a', i % 2 ? '<w:b/>' : '')).join(''))))
    assert.ok(paras(doc)[0].runs.length > 99_000)
    const render = read('../src/docview/render.ts')
    assert.ok(!/append\(\.\.\./.test(render + read('../src/ui/photoView.ts')), 'no append(...spread)')
    assert.ok(!/push\(\.\.\./.test(read('../src/docview/builder.ts') + read('../src/docview/rtf.ts')), 'no push(...spread)')
  })

  test('the composer says “can’t show” for a Word or Writer file once its small picture couldn’t be drawn', () => {
    const tray = read('../src/tray.ts')
    assert.match(tray, /row\.thumbTried = data\n\s+thumb\.hidden = !ok/)
    assert.match(tray, /\(!docPreviewOf\(row\.data \?\? new Uint8Array\(\)\) \|\| \(!!row\.thumbTried && row\.thumbTried === row\.sending\?\.data\)\)/)
  })
})

describe('the XML reader and list numbers', () => {
  test('elements with their namespaces and attributes, in order; it stops when its reader has enough', () => {
    const seen: string[] = []
    const reader = {
      done: false,
      open: (el: XmlEl) => seen.push(`<${el.ns}|${el.name} ${el.attrs.map((a) => `${a.ns}|${a.name}=${a.value}`).join(' ')}>`),
      close: (el: XmlEl) => seen.push(`</${el.name}>`),
      text: (s: string) => {
        seen.push(s)
        if (s === 'stop') reader.done = true
      },
    }
    scanXml('<a xmlns="urn:a" xmlns:b="urn:b" b:x="1 &amp; 2" y=\'3\'><b:c/>text<d>stop</d><e>never</e></a>', reader)
    assert.deepEqual(seen, ['<urn:a|a urn:b|x=1 & 2 |y=3>', '<urn:b|c >', '</c>', 'text', '<urn:a|d >', 'stop'])
  })

  test('numbers in each list format, letters going on after z the document’s way, and no label a million letters long', () => {
    assert.deepEqual(
      [1, 9, 10].map((n) => formatNumber(n, 'decimalZero')),
      ['01', '09', '10'],
    )
    assert.deepEqual(
      [1, 26, 27, 28, 53].map((n) => formatNumber(n, 'lowerLetter')),
      ['a', 'z', 'aa', 'bb', 'aaa'],
    )
    assert.deepEqual(
      [1, 26, 27, 28, 53].map((n) => formatNumber(n, 'upperLetter', false)),
      ['A', 'Z', 'AA', 'AB', 'BA'],
    )
    assert.deepEqual(
      [4, 9, 14, 1994, 3999].map((n) => formatNumber(n, 'upperRoman')),
      ['IV', 'IX', 'XIV', 'MCMXCIV', 'MMMCMXCIX'],
    )
    assert.equal(formatNumber(1_000_000, 'lowerLetter'), '1000000')
    assert.equal(formatNumber(5000, 'lowerRoman'), '5000')
    assert.equal(formatNumber(3, 'none'), '')
    assert.equal(formatNumber(3, 'chineseCounting'), '3')
  })
})

describe('where they show', () => {
  test('a Word or Writer document is previewable, by its bytes; PowerPoint, Excel and LibreOffice’s others aren’t', () => {
    assert.equal(docPreviewOf(docx(p(r('x')))), 'docx')
    assert.equal(docPreviewOf(odt(tp('x'))), 'odt')
    const office = (main: string) => zip({ '[Content_Types].xml': CT, [main]: `${XML}<x/>` })
    assert.equal(docPreviewOf(office('xl/workbook.xml')), null)
    assert.equal(docPreviewOf(office('ppt/presentation.xml')), null)
    for (const kind of ['spreadsheet', 'presentation']) assert.equal(docPreviewOf(zip({ mimetype: [strToU8(`application/vnd.oasis.opendocument.${kind}`), { level: 0 }], 'content.xml': `${XML}<x/>` })), null)
    assert.equal(docPreviewOf(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0])), null)
    assert.equal(MAX_DOC_CHARS, 200_000)
  })
})
