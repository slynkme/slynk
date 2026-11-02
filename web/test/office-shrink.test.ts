// Making Office files smaller: reading pictures' headers, finding where each
// picture is shown and how big, renaming a picture that changes kind,
// checking the rewritten zip, and an RTF file's pictures. The drawing itself needs a browser.
// Run from the repo root: npm --prefix web test
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { zipSync, type Zippable } from 'fflate'
import { checkOffice } from '../src/officeshrink/check.ts'
import { pictureInfo, turnsQuarter, withOrientation, withoutApp1 } from '../src/officeshrink/picture.ts'
import { EMU_PER_INCH, odfInches, placements } from '../src/officeshrink/place.ts'
import { extFits, newName, renameParts } from '../src/officeshrink/rename.ts'
import { ShrinkError, openOffice } from '../src/officeshrink/shrink.ts'
import { rtfPictures, withPictures } from '../src/strip/rtf.ts'
import { openPackage, readEntry, writePackage } from '../src/strip/zip.ts'
import { compound } from './strip/docfixtures.ts'
import { PNG_SIG, be16, be32, cat, exifApp1, iccApp2, phoneExif, pngChunk, seg, utf8 } from './strip/fixtures.ts'

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
const near = (a: number | undefined, b: number, what: string) => assert.ok(a !== undefined && Math.abs(a - b) < 1e-6, `${what}: ${a} is not ${b}`)
const text = (b: Uint8Array) => new TextDecoder().decode(b)

/** A JPEG header: what pictureInfo reads (it never decodes). */
const jpegOf = (w: number, h: number, components = 3, ...app: Uint8Array[]) =>
  cat([0xff, 0xd8], ...app, seg(0xc0, [8, ...be16(h), ...be16(w), components, ...new Array(components * 3).fill(1)]), [0xff, 0xd9])
const pngOf = (w: number, h: number, ...extra: Uint8Array[]) =>
  cat(PNG_SIG, pngChunk('IHDR', [...be32(w), ...be32(h), 8, 2, 0, 0, 0]), ...extra, pngChunk('IDAT', [0]), pngChunk('IEND', []))

function zip(files: Record<string, string | Uint8Array>, store: string[] = []): Uint8Array {
  const z: Zippable = {}
  for (const [name, data] of Object.entries(files)) z[name] = [typeof data === 'string' ? utf8(data) : data, { level: store.includes(name) ? 0 : 6 }]
  return zipSync(z)
}

// --- Picture headers -----------------------------------------------------------------

test('picture headers: kind, size, print colours, rotation, animation', () => {
  assert.deepEqual(pictureInfo(jpegOf(4000, 3000)), { kind: 'jpeg', dims: { width: 4000, height: 3000 } })
  assert.equal(pictureInfo(jpegOf(10, 10, 4)).cmyk, true)
  assert.equal(pictureInfo(jpegOf(10, 10, 3, exifApp1(phoneExif(6)))).orientation, 6)
  assert.equal(pictureInfo(jpegOf(10, 10, 3, exifApp1(phoneExif(1)))).orientation, undefined)
  assert.deepEqual(pictureInfo(pngOf(640, 480)), { kind: 'png', dims: { width: 640, height: 480 } })
  assert.equal(pictureInfo(pngOf(1, 1, pngChunk('acTL', [0, 0, 0, 2, 0, 0, 0, 0]))).animated, true)
  assert.equal(pictureInfo(pngOf(1, 1, pngChunk('eXIf', [0x4d, 0x4d, 0, 0x2a]))).pngExif, true)
  const bmp = new Uint8Array(54)
  bmp.set([0x42, 0x4d])
  new DataView(bmp.buffer).setInt32(18, 300, true)
  new DataView(bmp.buffer).setInt32(22, -200, true) // stored top-down
  assert.deepEqual(pictureInfo(bmp), { kind: 'bmp', dims: { width: 300, height: 200 } })
  const emf = new Uint8Array(88)
  emf.set([1, 0, 0, 0])
  emf.set(utf8(' EMF'), 40)
  assert.equal(pictureInfo(emf).kind, 'emf')
  assert.equal(pictureInfo(Uint8Array.from([0xd7, 0xcd, 0xc6, 0x9a, 0, 0])).kind, 'wmf')
  assert.equal(pictureInfo(utf8('<?xml version="1.0"?>\n<!-- drawn -->\n<svg xmlns="http://www.w3.org/2000/svg"/>')).kind, 'svg')
  assert.equal(pictureInfo(utf8('GIF89a\x10\x00\x20\x00')).kind, 'gif')
  assert.equal(pictureInfo(new Uint8Array(3)).kind, 'other')
})

test('a JPEG loses its EXIF before decoding, keeps its colour profile, and gets only its rotation back', () => {
  const original = jpegOf(40, 30, 3, exifApp1(phoneExif(6)), iccApp2())
  const plain = withoutApp1(original)
  assert.equal(pictureInfo(plain).orientation, undefined)
  assert.ok(!text(plain).includes('ExampleCam'), 'the camera went')
  assert.ok(text(plain).includes('ICC_PROFILE'), 'the colour profile stayed')
  assert.deepEqual(pictureInfo(plain).dims, { width: 40, height: 30 })
  const turned = withOrientation(jpegOf(20, 15), 6)
  assert.equal(pictureInfo(turned).orientation, 6)
  assert.deepEqual(pictureInfo(turned).dims, { width: 20, height: 15 })
  assert.equal(turned.length, jpegOf(20, 15).length + 36, 'nothing but the one tag')
  assert.ok(turnsQuarter(6) && turnsQuarter(8) && !turnsQuarter(3) && !turnsQuarter(undefined))
})

// --- Word, PowerPoint and Excel ---------------------------------------------------------

const NS_DECL =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" ' +
  'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" ' +
  'xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office"'
const IMAGE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image'
const PKG_RELS = 'http://schemas.openxmlformats.org/package/2006/relationships'

const emu = (inches: number) => Math.round(inches * EMU_PER_INCH)

function wordPic(rid: string, w: number, h: number, crop = '', fill = '<a:stretch><a:fillRect/></a:stretch>') {
  return (
    `<w:r><w:drawing><wp:inline><wp:extent cx="${emu(w)}" cy="${emu(h)}"/><wp:docPr id="1" name="Picture 1"/>` +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>' +
    `<pic:nvPicPr><pic:cNvPr id="0" name="p"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}"/>${crop}${fill}</pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${emu(w)}" cy="${emu(h)}"/></a:xfrm><a:prstGeom prst="rect"/></pic:spPr>` +
    '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>'
  )
}

function docx(body: string, media: Record<string, Uint8Array>, rels: string, extra: Record<string, string | Uint8Array> = {}) {
  return zip({
    '[Content_Types].xml':
      XML +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
      '<Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': `${XML}<Relationships xmlns="${PKG_RELS}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    'word/document.xml': `${XML}<w:document ${NS_DECL}><w:body><w:p>${body}</w:p><w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body></w:document>`,
    'word/_rels/document.xml.rels': `${XML}<Relationships xmlns="${PKG_RELS}">${rels}</Relationships>`,
    ...Object.fromEntries(Object.entries(media).map(([k, v]) => [`word/media/${k}`, v])),
    ...extra,
  })
}

const rel = (id: string, target: string, type = IMAGE) => `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`

test('Word: a picture is sized by its shape, a crop counts as shown larger, and its largest use wins', () => {
  const crop = '<a:srcRect l="25000" r="25000" t="10000" b="10000"/>'
  const file = docx(
    wordPic('rId5', 3, 2) + wordPic('rId6', 2, 1.6, crop) + wordPic('rId5', 4, 1),
    { 'image1.jpeg': jpegOf(4000, 3000), 'image2.png': pngOf(1000, 800), 'image9.png': pngOf(10, 10) },
    rel('rId5', 'media/image1.jpeg') + rel('rId6', '/word/media/image2.png'),
  )
  const placed = placements(openPackage(file), 'ooxml')
  near(placed.page.w, 8.5, 'page width')
  near(placed.page.h, 11, 'page height')
  const one = placed.pictures.get('word/media/image1.jpeg')!
  near(one.shown?.w, 4, 'widest use')
  near(one.shown?.h, 2, 'tallest use')
  assert.deepEqual(one.places, ['document'])
  assert.equal(one.unsized, false)
  // Half its width and 80% of its height show: the whole picture counts as 4 × 2 inches.
  const two = placed.pictures.get('word/media/image2.png')!
  near(two.shown?.w, 4, 'cropped width')
  near(two.shown?.h, 2, 'cropped height')
  // In the media folder but used nowhere: sized as if it filled the page.
  assert.equal(placed.pictures.get('word/media/image9.png')!.unsized, true)
})

test('Word: textures are left alone, VML pictures are sized by their style, and fallbacks are ignored', () => {
  const tiled = wordPic('rId5', 2, 2, '', '<a:tile tx="0" ty="0" sx="100000" sy="100000"/>')
  const vml = '<w:r><w:pict><v:shape style="width:216pt;height:1.5in"><v:imagedata r:id="rId6" cropleft="0.25" cropright="16384f"/></v:shape></w:pict></w:r>'
  const choice =
    '<mc:AlternateContent><mc:Choice Requires="wps">' +
    wordPic('rId7', 1, 1) +
    '</mc:Choice><mc:Fallback><w:pict><v:group><v:shape style="width:900pt;height:900pt"><v:imagedata r:id="rId7"/></v:shape></v:group></w:pict></mc:Fallback></mc:AlternateContent>'
  const background = '<w:r><w:pict><v:background><v:fill r:id="rId8" type="tile"/></v:background></w:pict></w:r>'
  const file = docx(
    tiled + vml + choice + background,
    { 'a.png': pngOf(100, 100), 'b.png': pngOf(100, 100), 'c.png': pngOf(100, 100), 'd.png': pngOf(100, 100) },
    rel('rId5', 'media/a.png') + rel('rId6', 'media/b.png') + rel('rId7', 'media/c.png') + rel('rId8', 'media/d.png'),
  )
  const p = placements(openPackage(file), 'ooxml').pictures
  assert.equal(p.get('word/media/a.png')!.fill, true)
  // 3 × 1.5 inches shown, half its width cropped away.
  near(p.get('word/media/b.png')!.shown?.w, 6, 'VML width')
  near(p.get('word/media/b.png')!.shown?.h, 1.5, 'VML height')
  near(p.get('word/media/c.png')!.shown?.w, 1, 'only the mc:Choice counts')
  assert.equal(p.get('word/media/c.png')!.unsized, false)
  assert.equal(p.get('word/media/d.png')!.fill, true)
})

const PML =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'

function pptx(slides: string[], media: Record<string, Uint8Array>) {
  const files: Record<string, string | Uint8Array> = {
    '[Content_Types].xml':
      XML +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/></Types>',
    '_rels/.rels': `${XML}<Relationships xmlns="${PKG_RELS}">${rel('rId1', 'ppt/presentation.xml', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument')}</Relationships>`,
    // Slides listed in reverse: the second file is the first slide.
    'ppt/presentation.xml': `${XML}<p:presentation ${PML}><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${10 + slides.length - 1 - i}"/>`).join('')}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': `${XML}<Relationships xmlns="${PKG_RELS}">${slides.map((_, i) => rel(`rId${10 + i}`, `slides/slide${i + 1}.xml`, 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide')).join('')}</Relationships>`,
  }
  slides.forEach((s, i) => {
    files[`ppt/slides/slide${i + 1}.xml`] = `${XML}<p:sld ${PML}><p:cSld>${s}</p:cSld></p:sld>`
    files[`ppt/slides/_rels/slide${i + 1}.xml.rels`] = `${XML}<Relationships xmlns="${PKG_RELS}">${Object.keys(media).map((m, k) => rel(`rId${k + 2}`, `../media/${m}`)).join('')}</Relationships>`
  })
  for (const [k, v] of Object.entries(media)) files[`ppt/media/${k}`] = v
  return zip(files)
}

const ppic = (rid: string, w: number, h: number) =>
  `<p:pic><p:nvPicPr><p:cNvPr id="4" name="p"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
  `<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${emu(w)}" cy="${emu(h)}"/></a:xfrm></p:spPr></p:pic>`

test('PowerPoint: groups scale what is in them, a background fills the slide, slides go by their order', () => {
  // A group shown at 6 × 4 inches whose children think in 3 × 2: everything inside is drawn twice as big.
  const group =
    '<p:spTree><p:grpSp><p:nvGrpSpPr><p:cNvPr id="2" name="g"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${emu(6)}" cy="${emu(4)}"/><a:chOff x="0" y="0"/><a:chExt cx="${emu(3)}" cy="${emu(2)}"/></a:xfrm></p:grpSpPr>` +
    ppic('rId2', 1.5, 1) +
    '</p:grpSp></p:spTree>'
  const background = '<p:bg><p:bgPr><a:blipFill><a:blip r:embed="rId3"/><a:stretch><a:fillRect/></a:stretch></a:blipFill></p:bgPr></p:bg>'
  const shapeFill = `<p:spTree><p:sp><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${emu(2)}" cy="${emu(2)}"/></a:xfrm><a:blipFill><a:blip r:embed="rId4"/><a:stretch><a:fillRect l="25000" r="25000"/></a:stretch></a:blipFill></p:spPr></p:sp></p:spTree>`
  const file = pptx([group, background + shapeFill], { 'image1.png': pngOf(3000, 2000), 'image2.png': pngOf(1920, 1080), 'image3.png': pngOf(500, 1000) })
  const placed = placements(openPackage(file), 'ooxml')
  near(placed.page.w, 12192000 / EMU_PER_INCH, 'slide width')
  const one = placed.pictures.get('ppt/media/image1.png')!
  near(one.shown?.w, 3, 'grouped width')
  near(one.shown?.h, 2, 'grouped height')
  assert.deepEqual(one.places, ['slide 2'])
  const bg = placed.pictures.get('ppt/media/image2.png')!
  near(bg.shown?.w, 12192000 / EMU_PER_INCH, 'background width')
  assert.deepEqual(bg.places, ['slide 1'])
  // Stretched into the middle half of a 2-inch shape.
  near(placed.pictures.get('ppt/media/image3.png')!.shown?.w, 1, 'fill rectangle')
})

test('Excel: a picture is sized by its own transform; a sheet background is left alone', () => {
  const XDR =
    'xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
  const file = zip({
    '[Content_Types].xml': `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/></Types>`,
    'xl/workbook.xml': `${XML}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>`,
    'xl/worksheets/sheet1.xml': `${XML}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><picture r:id="rId9"/></worksheet>`,
    'xl/worksheets/_rels/sheet1.xml.rels': `${XML}<Relationships xmlns="${PKG_RELS}">${rel('rId9', '../media/image2.png')}</Relationships>`,
    'xl/drawings/drawing1.xml':
      `${XML}<xdr:wsDr ${XDR}><xdr:twoCellAnchor><xdr:from/><xdr:to/><xdr:pic><xdr:blipFill><a:blip r:embed="rId1"/></xdr:blipFill>` +
      `<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${emu(5)}" cy="${emu(2.5)}"/></a:xfrm></xdr:spPr></xdr:pic></xdr:twoCellAnchor>` +
      `<xdr:oneCellAnchor><xdr:from/><xdr:ext cx="${emu(1)}" cy="${emu(1)}"/><xdr:pic><xdr:blipFill><a:blip r:embed="rId1"/></xdr:blipFill><xdr:spPr/></xdr:pic></xdr:oneCellAnchor></xdr:wsDr>`,
    'xl/drawings/_rels/drawing1.xml.rels': `${XML}<Relationships xmlns="${PKG_RELS}">${rel('rId1', '../media/image1.png')}</Relationships>`,
    'xl/media/image1.png': pngOf(2000, 1000),
    'xl/media/image2.png': pngOf(64, 64),
  })
  const p = placements(openPackage(file), 'ooxml').pictures
  near(p.get('xl/media/image1.png')!.shown?.w, 5, 'transform width')
  near(p.get('xl/media/image1.png')!.shown?.h, 2.5, 'transform height')
  assert.deepEqual(p.get('xl/media/image1.png')!.places, ['sheet'])
  assert.equal(p.get('xl/media/image2.png')!.fill, true)
})

// --- OpenDocument ----------------------------------------------------------------------

const ODF_NS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" ' +
  'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" ' +
  'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" ' +
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:loext="urn:org:documentfoundation:names:experimental:office:xmlns:loext:1.0"'

function odf(type: string, body: string, pictures: Record<string, Uint8Array>, autoStyles = '', styles = '') {
  return zip(
    {
      mimetype: `application/vnd.oasis.opendocument.${type}`,
      'META-INF/manifest.xml':
        `${XML}<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3">` +
        `<manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.${type}"/>` +
        '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>' +
        Object.keys(pictures)
          .map((n) => `<manifest:file-entry manifest:full-path="Pictures/${n}" manifest:media-type="image/${n.endsWith('.png') ? 'png' : 'jpeg'}"/>`)
          .join('') +
        '</manifest:manifest>',
      'content.xml': `${XML}<office:document-content ${ODF_NS}><office:automatic-styles>${autoStyles}</office:automatic-styles><office:body>${body}</office:body></office:document-content>`,
      'styles.xml': `${XML}<office:document-styles ${ODF_NS}><office:styles>${styles}</office:styles><office:automatic-styles><style:page-layout style:name="pm1"><style:page-layout-properties fo:page-width="21cm" fo:page-height="29.7cm"/></style:page-layout></office:automatic-styles></office:document-styles>`,
      ...Object.fromEntries(Object.entries(pictures).map(([k, v]) => [`Pictures/${k}`, v])),
    },
    ['mimetype'],
  )
}

const frame = (href: string, w: string, h: string, style = '') =>
  `<draw:frame${style ? ` draw:style-name="${style}"` : ''} svg:width="${w}" svg:height="${h}"><draw:image xlink:href="${href}" xlink:type="simple" loext:mime-type="image/png"/></draw:frame>`

test('OpenDocument: frames give the size; crops and fills are left alone; slides are counted', () => {
  assert.equal(odfInches('2.54cm'), 1)
  assert.equal(odfInches('72pt'), 1)
  assert.equal(odfInches('50%'), undefined)
  const clip = '<style:style style:name="fr1" style:family="graphic"><style:graphic-properties fo:clip="rect(0cm, 1cm, 0cm, 0cm)"/></style:style>'
  const noClip = '<style:style style:name="fr2" style:family="graphic"><style:graphic-properties fo:clip="rect(0cm, 0cm, 0cm, 0cm)"/></style:style>'
  const fill = '<draw:fill-image draw:name="Texture" xlink:href="Pictures/d.png"/>'
  const body =
    '<office:presentation><draw:page draw:name="one">' +
    frame('Pictures/a.png', '15.24cm', '3in', 'fr2') +
    '</draw:page><draw:page draw:name="two">' +
    frame('./Pictures/b.png', '2in', '2in', 'fr1') +
    frame('Pictures/c.jpg', '50%', '2in') +
    '</draw:page></office:presentation>'
  const file = odf('presentation', body, { 'a.png': pngOf(3000, 1500), 'b.png': pngOf(800, 800), 'c.jpg': jpegOf(100, 100), 'd.png': pngOf(64, 64) }, clip + noClip, fill)
  const placed = placements(openPackage(file), 'odf')
  near(placed.page.h, 29.7 / 2.54, 'page height')
  const a = placed.pictures.get('Pictures/a.png')!
  near(a.shown?.w, 6, 'frame width')
  near(a.shown?.h, 3, 'frame height')
  assert.deepEqual(a.places, ['slide 1'])
  assert.equal(placed.pictures.get('Pictures/b.png')!.clipped, true)
  assert.deepEqual(placed.pictures.get('Pictures/b.png')!.places, ['slide 2'])
  assert.equal(placed.pictures.get('Pictures/c.jpg')!.unsized, true, 'a relative width is unknown')
  assert.equal(placed.pictures.get('Pictures/d.png')!.fill, true)
})

// --- Renaming and checking ------------------------------------------------------------

test('new names never clash, and an extension that already fits needs none', () => {
  const taken = new Set(['word/media/image1.jpeg', 'word/media/image1.png'])
  assert.equal(newName('word/media/image1.png', 'image/jpeg', 'ooxml', taken), 'word/media/image1-2.jpeg')
  assert.equal(newName('word/media/image2.PNG', 'image/jpeg', 'ooxml', taken), 'word/media/image2.jpeg')
  assert.equal(newName('Pictures/10000.bmp', 'image/png', 'odf', taken), 'Pictures/10000.png')
  assert.equal(newName('Pictures/10000.png', 'image/jpeg', 'odf', taken), 'Pictures/10000.jpg')
  assert.ok(extFits('a/b.JPG', 'image/jpeg') && extFits('a/b.jpeg', 'image/jpeg') && extFits('a.png', 'image/png'))
  assert.ok(!extFits('a.png', 'image/jpeg') && !extFits('a.bmp', 'image/png'))
})

/** The package rewritten as shrink.ts writes it: renamed pictures with new bytes, changed XML. */
function rewrite(file: Uint8Array, family: 'ooxml' | 'odf', renames: { from: string; to: string; type: string; bytes: Uint8Array }[]) {
  const pkg = openPackage(file)
  const xml = renameParts(pkg, family, renames)
  const out = writePackage(
    pkg,
    pkg.entries.map((e) => {
      const r = renames.find((x) => x.from === e.name)
      if (r) return { name: r.to, data: r.bytes, store: true }
      const x = xml.get(e.name)
      return x ? { name: e.name, data: x } : { name: e.name, from: e }
    }),
  )
  return { out, xml }
}

const entryText = (file: Uint8Array, name: string) => {
  const pkg = openPackage(file)
  return text(readEntry(pkg, pkg.entries.find((e) => e.name === name)!))
}

test('Word: a renamed picture is followed by its relationships and content types, and the file checks out', () => {
  const file = docx(
    wordPic('rId5', 3, 2) + wordPic('rId6', 3, 2),
    { 'image1.png': pngOf(4000, 3000), 'image2.bmp': pngOf(10, 10) },
    rel('rId5', 'media/image1.png') + rel('rId6', '/word/media/image2.bmp'),
    {
      // A content type given for the one picture on its own, and none for .bmp.
      '[Content_Types].xml':
        XML +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
        '<Default Extension="png" ContentType="image/png"/><Override PartName="/word/media/image2.bmp" ContentType="image/bmp"/></Types>',
    },
  )
  assert.deepEqual(checkOffice(file, 'ooxml'), [])
  const { out, xml } = rewrite(file, 'ooxml', [
    { from: 'word/media/image1.png', to: 'word/media/image1.jpeg', type: 'image/jpeg', bytes: jpegOf(2000, 1500) },
    { from: 'word/media/image2.bmp', to: 'word/media/image2.png', type: 'image/png', bytes: pngOf(10, 10) },
  ])
  assert.deepEqual([...xml.keys()].sort(), ['[Content_Types].xml', 'word/_rels/document.xml.rels'])
  const rels = entryText(out, 'word/_rels/document.xml.rels')
  assert.ok(rels.includes('Target="media/image1.jpeg"'), 'relative target kept relative')
  assert.ok(rels.includes('Target="/word/media/image2.png"'), 'absolute target kept absolute')
  const ct = entryText(out, '[Content_Types].xml')
  assert.ok(/<Default Extension="jpeg" ContentType="image\/jpeg"\/>.*<Override/.test(ct), 'a jpeg default, before the overrides')
  assert.ok(ct.includes('<Override PartName="/word/media/image2.png" ContentType="image/png"/>'))
  assert.deepEqual(checkOffice(out, 'ooxml'), [])
  assert.deepEqual(entryText(out, 'word/document.xml'), entryText(file, 'word/document.xml'), 'the document itself is untouched')
})

test('a dangling relationship, a part with no content type and a stale manifest entry are all caught', () => {
  const file = docx(wordPic('rId5', 1, 1), { 'image1.png': pngOf(1, 1), 'x.weird': pngOf(1, 1) }, rel('rId5', 'media/gone.png'))
  const problems = checkOffice(file, 'ooxml')
  assert.ok(problems.some((p) => p.includes('points at word/media/gone.png')))
  assert.ok(problems.some((p) => p.includes('x.weird has no content type')))
  const o = odf('text', '<office:text/>', {})
  const pkg = openPackage(o)
  const stale = writePackage(
    pkg,
    pkg.entries.map((e) =>
      e.name === 'META-INF/manifest.xml'
        ? { name: e.name, data: utf8(text(readEntry(pkg, e)).replace('</manifest:manifest>', '<manifest:file-entry manifest:full-path="Pictures/x.png" manifest:media-type="image/png"/></manifest:manifest>')) }
        : { name: e.name, from: e },
    ),
  )
  assert.deepEqual(checkOffice(stale, 'odf'), ["the manifest lists Pictures/x.png, which isn't there"])
})

test('OpenDocument: a renamed picture is followed by its links, its MIME type and the manifest', () => {
  const body = `<office:text><text:p>Some words.${frame('Pictures/a.png', '6in', '3in')}${frame('./Pictures/a.png', '1in', '1in')}</text:p></office:text>`
  const file = odf('text', body, { 'a.png': pngOf(3000, 1500) })
  assert.deepEqual(checkOffice(file, 'odf'), [])
  const { out } = rewrite(file, 'odf', [{ from: 'Pictures/a.png', to: 'Pictures/a.jpg', type: 'image/jpeg', bytes: jpegOf(1200, 600) }])
  const content = entryText(out, 'content.xml')
  assert.ok(content.includes('xlink:href="Pictures/a.jpg"') && content.includes('xlink:href="./Pictures/a.jpg"'))
  assert.ok(!content.includes('a.png') && content.includes('loext:mime-type="image/jpeg"'))
  assert.ok(content.includes('Some words.'))
  const manifest = entryText(out, 'META-INF/manifest.xml')
  assert.ok(manifest.includes('manifest:full-path="Pictures/a.jpg" manifest:media-type="image/jpeg"'))
  assert.deepEqual(checkOffice(out, 'odf'), [])
  const pkg = openPackage(out)
  assert.equal(pkg.entries[0].name, 'mimetype')
  assert.equal(pkg.entries[0].method, 0)
})

const latin = (b: Uint8Array) => new TextDecoder('latin1').decode(b)
const bytesOf = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0))
const hexOf = (b: Uint8Array) => Buffer.from(b).toString('hex')

test('RTF: pictures are found wherever they are, with their size words, kind and IDs', () => {
  const jpeg = jpegOf(2400, 1600)
  const png = pngOf(430, 216)
  const rtf = bytesOf(
    `{\\rtf1\\ansi{\\*\\shppict{\\pict\\picscalex20\\picw2400\\pich1600\\picwgoal48000\\pichgoal32000\\jpegblip\\bliptag-77{\\*\\blipuid 00ff}\r\n${hexOf(jpeg)}}}` +
      `{\\nonshppict{\\pict\\wmetafile8\\picw100\\pich50 0102030405}}` +
      `{\\shp{\\*\\shpinst{\\sp{\\sn pib}{\\sv {\\pict\\picw11387\\pich5721\\pngblip ${hexOf(png)}}}}}}` +
      `{\\pict\\jpegblip\\bin${jpeg.length} ${latin(jpeg)}}` +
      // Data broken up by a word: left alone.
      `{\\pict\\pngblip 0102\\picw1 0304}}`,
  )
  const found = rtfPictures(rtf)
  assert.deepEqual(
    found.map((p) => [p.blip, p.data.length, p.words.get('picw')?.param, p.words.get('picwgoal')?.param, p.ids.length]),
    [
      ['jpegblip', jpeg.length, 2400, 48000, 2],
      ['wmetafile', 5, 100, undefined, 0],
      ['pngblip', png.length, 11387, undefined, 0],
      ['jpegblip', jpeg.length, undefined, undefined, 0],
    ],
  )
  assert.deepEqual(found[0].data, jpeg)
  assert.deepEqual(found[3].data, jpeg)
  assert.equal(found[0].words.get('picscalex')?.param, 20)
})

test('RTF: new pictures replace the hex, their IDs go, and \\picw follows only when it counted pixels', () => {
  const before = pngOf(2400, 1600)
  const rtf = bytesOf(
    `{\\rtf1 Text {\\pict\\picw2400\\pich1600\\picwgoal48000\\pichgoal32000\\pngblip\\bliptag-77{\\*\\blipuid 00ff}\r\n${hexOf(before)}} more ` +
      `{\\pict\\picw11387\\pich5721\\jpegblip ${hexOf(jpegOf(642, 428))}} end}`,
  )
  const [a, b] = rtfPictures(rtf)
  const newA = jpegOf(1333, 889)
  const newB = jpegOf(321, 214)
  const out = withPictures(rtf, [
    { picture: a, bytes: newA, was: { width: 2400, height: 1600 }, now: { width: 1333, height: 889 }, blip: 'jpegblip' },
    { picture: b, bytes: newB, was: { width: 642, height: 428 }, now: { width: 321, height: 214 }, blip: 'jpegblip' },
  ])
  const s = latin(out)
  assert.ok(s.startsWith('{\\rtf1 Text {\\pict\\picw1333\\pich889\\picwgoal48000\\pichgoal32000\\jpegblip \r\n'), s.slice(0, 120))
  assert.ok(!s.includes('bliptag') && !s.includes('blipuid'))
  // 11387 × 5721 are hundredths of a millimetre, not the old pixels: they stay.
  assert.ok(s.includes('{\\pict\\picw11387\\pich5721\\jpegblip '))
  assert.ok(s.includes('} more ') && s.endsWith('} end}'))
  const again = rtfPictures(out)
  assert.deepEqual(again.map((p) => [p.blip, p.data]), [
    ['jpegblip', newA],
    ['jpegblip', newB],
  ])
})

test('older and locked Office files are told apart, and neither is touched', async () => {
  const hooks = { progress() {}, stopped: () => false }
  const reason = (b: Uint8Array) => {
    try {
      openOffice(b, hooks)
      return 'opened'
    } catch (e) {
      return e instanceof ShrinkError ? e.reason : String(e)
    }
  }
  assert.equal(reason(compound(['Current User', 'Pictures', 'PowerPoint Document'])), 'older')
  assert.equal(reason(compound(['WordDocument', '1Table'])), 'older')
  assert.equal(reason(compound(['Workbook'])), 'older')
  assert.equal(reason(compound(['\x06DataSpaces', 'EncryptionInfo', 'EncryptedPackage'])), 'encrypted')
  assert.equal(reason(compound(['__substg1.0_0037001F'])), 'unreadable')
  assert.equal(reason(bytesOf('{\\rtf1 {\\pict\\pngblip 01')), 'unreadable')
})
