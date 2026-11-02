import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream, PDFString, StandardFonts, decodePDFRawStream } from 'pdf-lib'
import { stripBytes } from '../../src/strip/engine.ts'
import { LABEL } from '../../src/strip/labels.ts'
import { SKIP } from '../../src/strip/types.ts'
import { PRIVATE_XMP, cat, contains, exifApp1, grayJpeg, phoneExif, text, xmpPacket } from './fixtures.ts'

const N = (s: string) => PDFName.of(s)
const WHEN = new Date(Date.UTC(2024, 5, 12, 18, 30, 0))

interface Options {
  xmp?: string
  signed?: boolean
  objectStreams?: boolean
  encrypt?: boolean
}

async function makePdf(o: Options = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false })
  doc.setTitle('Example Title')
  doc.setAuthor('Example Author')
  doc.setSubject('Example Subject')
  doc.setKeywords(['example', 'keywords'])
  doc.setCreator('ExampleWriter 1.0')
  doc.setProducer('ExamplePDF 2.0')
  doc.setCreationDate(WHEN)
  doc.setModificationDate(WHEN)
  const page = doc.addPage([200, 200])
  const font = await doc.embedFont(StandardFonts.Helvetica)
  page.drawText('Visible page text', { x: 10, y: 100, size: 12, font })
  const img = await doc.embedJpg(grayJpeg(exifApp1(phoneExif(1))))
  page.drawImage(img, { x: 10, y: 10, width: 8, height: 8 })
  const ctx = doc.context
  if (o.xmp) doc.catalog.set(N('Metadata'), ctx.register(ctx.stream(o.xmp, { Type: 'Metadata', Subtype: 'XML' })))
  page.node.set(N('PieceInfo'), ctx.obj({ ExampleApp: { Private: PDFString.of('Example private data') } }))
  page.node.set(N('LastModified'), PDFString.of('D:20240612183000Z'))
  page.node.set(N('Thumb'), ctx.register(ctx.stream(new Uint8Array(4), { Width: 2, Height: 2, ColorSpace: 'DeviceGray', BitsPerComponent: 8 })))
  page.node.set(N('Metadata'), ctx.register(ctx.stream(PRIVATE_XMP, { Type: 'Metadata', Subtype: 'XML' })))
  const note = ctx.obj({
    Type: 'Annot',
    Subtype: 'Text',
    Rect: [10, 150, 30, 170],
    Contents: PDFString.of('A visible note'),
    T: PDFString.of('Example Author'),
    M: PDFString.of('D:20240612183000Z'),
    CreationDate: PDFString.of('D:20240612183000Z'),
  })
  page.node.set(N('Annots'), ctx.obj([ctx.register(note)]))
  if (o.signed) {
    const sig = ctx.obj({ Type: 'Sig', Filter: 'Adobe.PPKLite', ByteRange: [0, 10, 20, 10], Contents: PDFHexString.of('00') })
    const field = ctx.register(ctx.obj({ FT: 'Sig', T: PDFString.of('Signature1'), V: sig }))
    doc.catalog.set(N('AcroForm'), ctx.obj({ Fields: [field], SigFlags: 3 }))
  }
  if (o.encrypt) ctx.trailerInfo.Encrypt = ctx.obj({ Filter: 'Standard', V: 1, R: 2, P: -4 })
  return doc.save({ useObjectStreams: !!o.objectStreams })
}

/** Raw text, or the UTF-16 hex strings pdf-lib writes for document properties. */
function hasText(b: Uint8Array, s: string): boolean {
  const hex = [...s].map((c) => c.charCodeAt(0).toString(16).padStart(4, '0')).join('')
  return contains(b, s) || contains(b, hex.toUpperCase()) || contains(b, hex)
}

async function clean(b: Uint8Array) {
  const r = await stripBytes(b, { pdf: true })
  assert.equal(r.status, 'cleaned', JSON.stringify(r))
  if (r.status !== 'cleaned') throw new Error()
  return r
}

const PRIVATE = ['Example Title', 'Example Author', 'Example Subject', 'ExampleWriter', 'ExamplePDF', 'Example private data', 'D:2024', 'ExampleCam', 'ExampleEditor']

test('PDF: off by default', async () => {
  const r = await stripBytes(await makePdf())
  assert.deepEqual(r, { status: 'skipped', kind: 'pdf', reason: SKIP.pdfOff })
})

test('PDF: removes Info, XMP, PieceInfo, thumbnails, dates and annotation authors', async () => {
  const input = await makePdf({ xmp: PRIVATE_XMP })
  for (const s of PRIVATE) assert.ok(hasText(input, s) || s === 'ExampleCam', s)
  const r = await clean(input)
  for (const s of PRIVATE) assert.ok(!hasText(r.bytes, s), s)
  for (const l of [LABEL.title, LABEL.author, LABEL.keywords, LABEL.app, LABEL.dates, LABEL.appData, LABEL.thumbnail, LABEL.commentAuthors, LABEL.history, `${LABEL.gps} (in pictures)`]) {
    assert.ok(r.removed.includes(l), l)
  }
  const doc = await PDFDocument.load(r.bytes, { updateMetadata: false })
  assert.equal(doc.getPageCount(), 1)
  assert.equal(doc.context.trailerInfo.Info, undefined)
  assert.equal(doc.catalog.get(N('Metadata')), undefined)
  const page = doc.getPage(0).node
  for (const k of ['PieceInfo', 'LastModified', 'Thumb', 'Metadata']) assert.equal(page.get(N(k)), undefined, k)
  const annot = doc.context.lookup((page.lookup(N('Annots')) as PDFArray).get(0)) as PDFDict
  assert.equal((annot.get(N('T')) as PDFString).decodeText(), 'Author')
  assert.equal((annot.get(N('Contents')) as PDFString).decodeText(), 'A visible note')
  assert.equal(annot.get(N('M')), undefined)
  // The page's drawing instructions are untouched.
  const contents = async (b: Uint8Array) => {
    const d = await PDFDocument.load(b, { updateMetadata: false })
    const c = d.getPage(0).node.lookup(N('Contents'))
    const refs = c instanceof PDFArray ? c.asArray() : [d.getPage(0).node.get(N('Contents'))]
    return refs.map((r) => text(decodePDFRawStream(d.context.lookup(r) as PDFRawStream).decode())).join('\n')
  }
  assert.equal(await contents(r.bytes), await contents(input))
  assert.match(text(r.bytes.subarray(0, 8)), /^%PDF-1\.7/)
})

test('PDF: deterministic document ID, idempotent output', async () => {
  const input = await makePdf({ xmp: PRIVATE_XMP })
  const a = await clean(input)
  const b = await clean(input)
  assert.deepEqual(a.bytes, b.bytes)
  const m = /\/ID \[ <([0-9a-f]{32})> <([0-9a-f]{32})> \]/.exec(text(a.bytes.subarray(-600)))
  assert.ok(m && m[1] === m[2] && m[1] !== '0'.repeat(32))
  assert.equal((await stripBytes(a.bytes, { pdf: true })).status, 'unchanged')
})

test('PDF: earlier revisions left by incremental updates are dropped', async () => {
  const base = await makePdf()
  const root = (await PDFDocument.load(base, { updateMetadata: false })).context.trailerInfo.Root!.toString()
  const update = `\n900 0 obj\n<< /Title (Example Revised Title) /Author (Example Revised Author) >>\nendobj\ntrailer\n<< /Size 901 /Root ${root} /Info 900 0 R >>\nstartxref\n0\n%%EOF\n`
  const input = cat(base, update)
  const r = await clean(input)
  assert.ok(r.removed.includes(LABEL.leftovers))
  assert.ok(!hasText(r.bytes, 'Example Revised'))
  assert.ok(!hasText(r.bytes, 'Example Author'))
  assert.ok(!hasText(r.bytes, 'Example Title'))
})

test('PDF: signed files are never touched', async () => {
  for (const objectStreams of [false, true]) {
    const input = await makePdf({ signed: true, objectStreams })
    assert.equal(contains(input, '/ByteRange'), !objectStreams)
    for (const pdf of [false, true]) {
      const r = await stripBytes(input, { pdf })
      assert.deepEqual(r, { status: 'skipped', kind: 'pdf', reason: SKIP.signed })
    }
  }
})

test('PDF: encrypted files are skipped', async () => {
  const r = await stripBytes(await makePdf({ encrypt: true }), { pdf: true })
  assert.deepEqual(r, { status: 'skipped', kind: 'pdf', reason: SKIP.encrypted })
})

test('PDF/A keeps a minimal conformance XMP', async () => {
  const xmp = xmpPacket(
    '<dc:creator><rdf:Seq><rdf:li>Example Author</rdf:li></rdf:Seq></dc:creator>',
    ' xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/" xmlns:dc="http://purl.org/dc/elements/1.1/" pdfaid:part="1" pdfaid:conformance="B"',
  )
  const r = await clean(await makePdf({ xmp }))
  const doc = await PDFDocument.load(r.bytes, { updateMetadata: false })
  const meta = text((doc.context.lookup(doc.catalog.get(N('Metadata'))) as PDFRawStream).getContents())
  assert.match(meta, /pdfaid:part="1"/)
  assert.match(meta, /pdfaid:conformance="B"/)
  assert.ok(!meta.includes('Example Author'))
  assert.equal((await stripBytes(r.bytes, { pdf: true })).status, 'unchanged')
})

test('PDF: damaged files never throw', async () => {
  const good = await makePdf({ xmp: PRIVATE_XMP })
  let seed = 57
  const random = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  for (let k = 0; k < 24; k++) {
    const b = k < 8 ? good.subarray(0, Math.floor((good.length * (k + 1)) / 9)) : good.slice()
    if (k >= 8) for (let j = 0; j < 3; j++) b[Math.floor(random() * b.length)] = Math.floor(random() * 256)
    const r = await stripBytes(b, { pdf: true })
    assert.ok(['cleaned', 'unchanged', 'unsupported', 'skipped', 'failed'].includes(r.status))
    if (r.status === 'cleaned') assert.equal((await stripBytes(r.bytes, { pdf: true })).status, 'unchanged')
  }
})

test('PDF: malformed input fails cleanly', async () => {
  const good = await makePdf()
  for (const b of [good.subarray(0, 40), good.subarray(0, good.length >> 1), cat('%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R\nendobj\n')]) {
    const r = await stripBytes(b, { pdf: true })
    assert.ok(r.status === 'failed' || r.status === 'unchanged', r.status)
  }
})
