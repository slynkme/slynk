// Word, Excel, PowerPoint and OpenDocument packages.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DOMParser } from '@xmldom/xmldom'
import { unzipSync } from 'fflate'
import { stripBytes } from '../../src/strip/engine.ts'
import { LABEL } from '../../src/strip/labels.ts'
import { readZipDirectory } from '../../src/strip/zipdir.ts'
import { NUMBERING, STYLES, THEME, docx, odf, pptx, xlsx, zip } from './docfixtures.ts'
import { contains, text } from './fixtures.ts'

async function clean(b: Uint8Array) {
  const r = await stripBytes(b)
  assert.equal(r.status, 'cleaned', JSON.stringify(r))
  if (r.status !== 'cleaned') throw new Error()
  return r
}

function parts(b: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, data] of Object.entries(unzipSync(b))) out[name] = text(data)
  return out
}

/** Every part unzips, and every XML part parses without complaint. */
function wellFormed(b: Uint8Array) {
  for (const [name, data] of Object.entries(parts(b))) {
    if (!/\.(xml|rels)$/.test(name)) continue
    new DOMParser({ onError: (level, msg) => assert.fail(`${name}: ${level} ${msg}`) }).parseFromString(data, 'text/xml')
  }
}

function visibleText(xml: string): string {
  return xml.replace(/<[^>]*>/g, '')
}

const PRIVATE = ['Example Author', 'Example Editor', 'Example Corp', 'Example Manager', 'Example Title', 'Example Subject', 'Example description', 'ExampleUser', 'author@example.com', 'MSIP_Label', 'ExampleCam', '2024-06-12T18:3', 'Normal.dotm']

test('DOCX: removes properties, labels, template, rsids and IDs; anonymises comments and changes', async () => {
  const input = docx()
  const r = await clean(input)
  for (const s of PRIVATE) {
    assert.ok(Object.values(parts(input)).some((p) => p.includes(s)) || s === 'ExampleCam', s)
    assert.ok(!Object.values(parts(r.bytes)).some((p) => p.includes(s)), s)
  }
  assert.ok(!contains(r.bytes, 'ExampleCam'))
  const p = parts(r.bytes)
  for (const gone of ['docProps/custom.xml', 'docProps/thumbnail.jpeg', 'docMetadata/LabelInfo.xml']) assert.ok(!(gone in p), gone)
  assert.ok(!p['[Content_Types].xml'].includes('custom.xml') && !p['[Content_Types].xml'].includes('LabelInfo'))
  assert.ok(!p['_rels/.rels'].includes('thumbnail') && !p['_rels/.rels'].includes('custom.xml'))
  assert.ok(!p['word/settings.xml'].includes('rsid') && !p['word/settings.xml'].includes('docId') && !p['word/settings.xml'].includes('attachedTemplate'))
  assert.ok(!p['word/_rels/settings.xml.rels'].includes('attachedTemplate'))
  assert.ok(p['word/settings.xml'].includes('defaultTabStop'))
  // Comments and tracked changes stay, as "Author" without dates.
  assert.match(p['word/comments.xml'], /<w:comment w:id="0" w:author="Author">/)
  assert.match(p['word/document.xml'], /<w:ins w:id="1" w:author="Author">/)
  assert.match(p['word/document.xml'], /<w:del w:id="2" w:author="Author">/)
  assert.match(p['word/document.xml'], /w14:paraId="1A2B3C4D"/)
  assert.ok(!p['word/document.xml'].includes('w:rsid'))
  assert.equal(p['word/people.xml'].match(/<w15:person /g)?.length, 1)
  for (const l of [LABEL.author, LABEL.lastEditor, LABEL.company, LABEL.manager, LABEL.title, LABEL.keywords, LABEL.description, LABEL.custom, LABEL.sensitivity, LABEL.template, LABEL.revision, LABEL.editTime, LABEL.app, LABEL.dates, LABEL.thumbnail, LABEL.ids, LABEL.commentAuthors, LABEL.changeAuthors, LABEL.saveTimes, `${LABEL.gps} (in pictures)`]) {
    assert.ok(r.removed.includes(l), l)
  }
})

test('DOCX: visible text, numbering, styles and themes are untouched', async () => {
  const before = parts(docx())
  const r = await clean(docx())
  const after = parts(r.bytes)
  assert.equal(visibleText(after['word/document.xml']), visibleText(before['word/document.xml']))
  assert.equal(visibleText(after['word/comments.xml']), visibleText(before['word/comments.xml']))
  assert.equal(after['word/numbering.xml'], NUMBERING)
  assert.equal(after['word/styles.xml'], STYLES)
  assert.equal(after['word/theme/theme1.xml'], THEME)
  // Untouched entries keep their exact compressed bytes.
  const raw = (b: Uint8Array, name: string) => {
    const e = readZipDirectory(b).find((x) => x.name === name)!
    return b.subarray(e.dataOffset, e.dataOffset + e.csize)
  }
  assert.deepEqual(raw(r.bytes, 'word/styles.xml'), raw(docx(), 'word/styles.xml'))
  wellFormed(r.bytes)
})

test('DOCX: fixed ZIP dates, no extras, deterministic, idempotent', async () => {
  const a = await clean(docx())
  const b = await clean(docx())
  assert.deepEqual(a.bytes, b.bytes)
  for (const e of readZipDirectory(a.bytes)) {
    assert.equal(e.dosDate, 0x21)
    assert.equal(e.dosTime, 0)
    assert.deepEqual(e.extraIds, [])
  }
  assert.equal((await stripBytes(a.bytes)).status, 'unchanged')
})

test('XLSX: removes saved path, IDs and app stamp; anonymises notes and threads', async () => {
  const r = await clean(xlsx())
  const p = parts(r.bytes)
  for (const s of PRIVATE) assert.ok(!Object.values(p).some((x) => x.includes(s)), s)
  assert.ok(!p['xl/workbook.xml'].includes('absPath') && !p['xl/workbook.xml'].includes('AlternateContent'))
  assert.ok(!p['xl/workbook.xml'].includes('revisionPtr') && !p['xl/workbook.xml'].includes('fileVersion'))
  assert.match(p['xl/workbook.xml'], /<sheet name="Example Sheet" sheetId="1" r:id="rId1"\/>/)
  assert.match(p['xl/comments1.xml'], /<author>Author<\/author>/)
  assert.match(p['xl/comments1.xml'], /A cell note/)
  assert.match(p['xl/threadedComments/threadedComment1.xml'], /dT="1980-01-01T00:00:00Z"/)
  assert.match(p['xl/persons/person.xml'], /displayName="Author"[^>]*userId="Author" providerId="None"/)
  assert.ok(visibleText(p['xl/worksheets/sheet1.xml']).includes('Visible cell'))
  for (const l of [LABEL.savedPath, LABEL.ids, LABEL.app, LABEL.commentAuthors, `${LABEL.author} (in pictures)`]) assert.ok(r.removed.includes(l), l)
  wellFormed(r.bytes)
  assert.equal((await stripBytes(r.bytes)).status, 'unchanged')
})

test('PPTX: anonymises comment authors, removes the revision log', async () => {
  const r = await clean(pptx())
  const p = parts(r.bytes)
  for (const s of PRIVATE) assert.ok(!Object.values(p).some((x) => x.includes(s)), s)
  assert.ok(!('ppt/revisionInfo.xml' in p))
  assert.ok(!p['ppt/_rels/presentation.xml.rels'].includes('revisionInfo'))
  assert.ok(!p['[Content_Types].xml'].includes('revisionInfo'))
  assert.match(p['ppt/commentAuthors.xml'], /name="Author" initials="A"/)
  assert.match(p['ppt/comments/comment1.xml'], /dt="1980-01-01T00:00:00Z"/)
  assert.match(p['ppt/authors.xml'], /name="Author" initials="A" userId="Author" providerId="None"/)
  assert.match(p['ppt/comments/modernComment_100_1.xml'], /created="1980-01-01T00:00:00Z"/)
  assert.ok(visibleText(p['ppt/slides/slide1.xml']).includes('Visible slide text'))
  wellFormed(r.bytes)
  assert.equal((await stripBytes(r.bytes)).status, 'unchanged')
})

for (const kind of ['text', 'spreadsheet', 'presentation'] as const) {
  test(`ODF ${kind}: removes meta, printer, thumbnail and versions; anonymises comments`, async () => {
    const input = odf(kind)
    const r = await clean(input)
    const p = parts(r.bytes)
    for (const s of ['Example Author', 'Example Editor', 'Example Client', 'exampleuser', 'Example Office Printer', 'ExampleOffice', 'Example Title', 'old version', 'ExampleCam']) {
      assert.ok(!Object.values(p).some((x) => x.includes(s)), s)
    }
    assert.ok(!('Thumbnails/thumbnail.png' in p) && !('VersionList.xml' in p) && !('Versions/Version1' in p))
    const manifest = p['META-INF/manifest.xml']
    assert.ok(!manifest.includes('Thumbnails') && !manifest.includes('Version'))
    assert.ok(manifest.includes('Pictures/photo.jpg') && manifest.includes('content.xml'))
    assert.match(p['meta.xml'], /^<\?xml[^>]*>\n<office:document-meta [^>]*office:version="1.3"><office:meta\/><\/office:document-meta>$/)
    assert.ok(p['settings.xml'].includes('TabsRelativeToIndent'))
    assert.match(p['content.xml'], /<office:annotation><dc:creator>Author<\/dc:creator><text:p>A comment<\/text:p><\/office:annotation>/)
    if (kind === 'text') assert.match(p['content.xml'], /<dc:creator>Author<\/dc:creator><dc:date>1980-01-01T00:00:00<\/dc:date>/)
    // mimetype first, stored, no extra field.
    const entries = readZipDirectory(r.bytes)
    assert.equal(entries[0].name, 'mimetype')
    assert.equal(entries[0].method, 0)
    assert.equal(entries[0].localExtra, 0)
    for (const l of [LABEL.author, LABEL.lastEditor, LABEL.dates, LABEL.custom, LABEL.template, LABEL.printer, LABEL.thumbnail, LABEL.versions, LABEL.commentAuthors, LABEL.saveTimes, `${LABEL.gps} (in pictures)`]) {
      assert.ok(r.removed.includes(l), l)
    }
    wellFormed(r.bytes)
    assert.equal((await stripBytes(r.bytes)).status, 'unchanged')
    assert.deepEqual((await clean(odf(kind))).bytes, r.bytes)
  })
}

test('Packages: encrypted entries are skipped; broken ones fail cleanly', async () => {
  const good = docx()
  const enc = good.slice()
  // Set the "encrypted" flag on the first entry, in both headers.
  const first = readZipDirectory(enc)[0]
  enc[first.offset + 6] |= 1
  const cd = Buffer.from(enc).indexOf(Buffer.from([0x50, 0x4b, 1, 2]))
  enc[cd + 8] |= 1
  const r = await stripBytes(enc)
  assert.equal(r.status, 'skipped')
  for (const b of [good.subarray(0, 100), good.subarray(0, good.length - 30), zip({ '[Content_Types].xml': '<Types', 'word/document.xml': '<w:document>' })]) {
    const res = await stripBytes(b)
    assert.ok(['failed', 'unsupported'].includes(res.status), res.status)
  }
  const corrupt = good.slice()
  const e = readZipDirectory(corrupt).find((x) => x.name === 'word/document.xml')!
  corrupt[e.dataOffset + 5] ^= 0xff
  assert.equal((await stripBytes(corrupt)).status, 'failed')
})
