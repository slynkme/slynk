// Synthetic Office and OpenDocument packages, zipped with fflate. Names and
// dates are invented; entry times are a fixed June 2024 moment.
import { zipSync, type Zippable } from 'fflate'
import { cat, exifApp1, grayJpeg, phoneExif, pngChunk, PNG_SIG, ihdr, idat, utf8 } from './fixtures.ts'

const MTIME = new Date(2024, 5, 12, 18, 30, 44)
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'

export function zip(files: Record<string, string | Uint8Array>, store: string[] = []): Uint8Array {
  const z: Zippable = {}
  for (const [name, data] of Object.entries(files)) {
    z[name] = [typeof data === 'string' ? utf8(data) : data, { level: store.includes(name) ? 0 : 6, mtime: MTIME }]
  }
  return zipSync(z)
}

export const photoWithGps = () => grayJpeg(exifApp1(phoneExif(1)))
export const pngWithAuthor = () => cat(PNG_SIG, ihdr(), pngChunk('tEXt', 'Author\0Example Author'), idat(), pngChunk('IEND', []))

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
const R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
const W14 = 'xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"'
const W15 = 'xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships'

export const CORE =
  XML +
  '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
  '<dc:title>Example Title</dc:title><dc:subject>Example Subject</dc:subject><dc:creator>Example Author</dc:creator>' +
  '<cp:keywords>example, keywords</cp:keywords><dc:description>Example description</dc:description>' +
  '<cp:lastModifiedBy>Example Editor</cp:lastModifiedBy><cp:revision>7</cp:revision>' +
  '<dcterms:created xsi:type="dcterms:W3CDTF">2024-06-12T18:30:00Z</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">2024-06-12T19:00:00Z</dcterms:modified>' +
  '</cp:coreProperties>'

export const APP =
  XML +
  '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
  '<Template>Normal.dotm</Template><TotalTime>42</TotalTime><Pages>1</Pages><Words>5</Words><Application>Example Office</Application>' +
  '<Company>Example Corp</Company><Manager>Example Manager</Manager><AppVersion>16.0000</AppVersion></Properties>'

export const CUSTOM =
  XML +
  '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
  '<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="MSIP_Label_00000000-0000-0000-0000-000000000000_Enabled"><vt:lpwstr>true</vt:lpwstr></property>' +
  '<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="3" name="ExampleProjectCode"><vt:lpwstr>EX-42</vt:lpwstr></property></Properties>'

function rootRels(main: string): string {
  return (
    XML +
    `<Relationships xmlns="${PKG_REL}">` +
    `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="${main}"/>` +
    `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>` +
    `<Relationship Id="rId3" Type="${REL}/extended-properties" Target="docProps/app.xml"/>` +
    `<Relationship Id="rId4" Type="${REL}/custom-properties" Target="docProps/custom.xml"/>` +
    `<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail" Target="docProps/thumbnail.jpeg"/>` +
    `<Relationship Id="rId6" Type="http://schemas.microsoft.com/office/2020/02/relationships/classificationlabels" Target="docMetadata/LabelInfo.xml"/>` +
    '</Relationships>'
  )
}

function contentTypes(overrides: [string, string][]): string {
  return (
    XML +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/><Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="png" ContentType="image/png"/>' +
    overrides.map(([p, t]) => `<Override PartName="${p}" ContentType="${t}"/>`).join('') +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
    '<Override PartName="/docProps/custom.xml" ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"/>' +
    '<Override PartName="/docMetadata/LabelInfo.xml" ContentType="application/vnd.ms-office.classificationlabels+xml"/>' +
    '</Types>'
  )
}

const common = (main: string) => ({
  '_rels/.rels': rootRels(main),
  'docProps/core.xml': CORE,
  'docProps/app.xml': APP,
  'docProps/custom.xml': CUSTOM,
  'docProps/thumbnail.jpeg': grayJpeg(),
  'docMetadata/LabelInfo.xml': XML + '<clbl:labelList xmlns:clbl="http://schemas.microsoft.com/office/2020/mipLabelMetadata"><clbl:label id="{00000000-0000-0000-0000-000000000000}" enabled="1" siteId="{11111111-1111-1111-1111-111111111111}"/></clbl:labelList>',
})

export const NUMBERING = XML + `<w:numbering ${W}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`
export const STYLES = XML + `<w:styles ${W}><w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:rFonts w:ascii="Example Sans"/></w:rPr></w:style></w:styles>`
export const THEME = XML + '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Example Theme"><a:themeElements/></a:theme>'

export const DOCUMENT =
  XML +
  `<w:document ${W} ${R} ${W14}><w:body>` +
  '<w:p w:rsidR="00A1B2C3" w:rsidRDefault="00A1B2C3" w14:paraId="1A2B3C4D"><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>' +
  '<w:commentRangeStart w:id="0"/><w:r w:rsidRPr="00D4E5F6"><w:t xml:space="preserve">Hello visible text &amp; more </w:t></w:r><w:commentRangeEnd w:id="0"/>' +
  '<w:r><w:commentReference w:id="0"/></w:r>' +
  '<w:ins w:id="1" w:author="Example Author" w:date="2024-06-12T18:30:00Z"><w:r><w:t>inserted text</w:t></w:r></w:ins>' +
  '<w:del w:id="2" w:author="Example Editor" w:date="2024-06-12T18:31:00Z"><w:r><w:delText>deleted text</w:delText></w:r></w:del>' +
  '</w:p><w:p><w:r><w:rPr><w:rPrChange w:id="3" w:author="Example Editor" w:date="2024-06-12T18:32:00Z"><w:rPr/></w:rPrChange></w:rPr><w:t>Second paragraph</w:t></w:r>' +
  '<w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:blipFill><a:blip r:embed="rId7"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>' +
  '<w:sectPr w:rsidR="00A1B2C3"/></w:body></w:document>'

export function docx(): Uint8Array {
  return zip({
    '[Content_Types].xml': contentTypes([
      ['/word/document.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'],
      ['/word/comments.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml'],
      ['/word/people.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.people+xml'],
      ['/word/settings.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml'],
      ['/word/numbering.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml'],
      ['/word/styles.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml'],
      ['/word/theme/theme1.xml', 'application/vnd.openxmlformats-officedocument.theme+xml'],
    ]),
    ...common('word/document.xml'),
    'word/document.xml': DOCUMENT,
    'word/_rels/document.xml.rels':
      XML +
      `<Relationships xmlns="${PKG_REL}">` +
      `<Relationship Id="rId1" Type="${REL}/comments" Target="comments.xml"/>` +
      `<Relationship Id="rId2" Type="${REL}/settings" Target="settings.xml"/>` +
      `<Relationship Id="rId3" Type="http://schemas.microsoft.com/office/2011/relationships/people" Target="people.xml"/>` +
      `<Relationship Id="rId4" Type="${REL}/numbering" Target="numbering.xml"/>` +
      `<Relationship Id="rId5" Type="${REL}/styles" Target="styles.xml"/>` +
      `<Relationship Id="rId6" Type="${REL}/theme" Target="theme/theme1.xml"/>` +
      `<Relationship Id="rId7" Type="${REL}/image" Target="media/image1.jpeg"/>` +
      '</Relationships>',
    'word/comments.xml':
      XML +
      `<w:comments ${W}><w:comment w:id="0" w:author="Example Author" w:date="2024-06-12T18:30:00Z" w:initials="EA"><w:p><w:r><w:t>A comment</w:t></w:r></w:p></w:comment></w:comments>`,
    'word/people.xml':
      XML +
      `<w15:people ${W15}><w15:person w15:author="Example Author"><w15:presenceInfo w15:providerId="AD" w15:userId="S::author@example.com::0000"/></w15:person>` +
      '<w15:person w15:author="Example Editor"><w15:presenceInfo w15:providerId="None" w15:userId="Example Editor"/></w15:person></w15:people>',
    'word/settings.xml':
      XML +
      `<w:settings ${W} ${R} ${W14} ${W15}><w:attachedTemplate r:id="rId1"/><w:defaultTabStop w:val="720"/>` +
      '<w:rsids><w:rsidRoot w:val="00A1B2C3"/><w:rsid w:val="00A1B2C3"/><w:rsid w:val="00D4E5F6"/></w:rsids>' +
      '<w14:docId w14:val="1234ABCD"/><w15:docId w15:val="{00000000-1111-2222-3333-444444444444}"/></w:settings>',
    'word/_rels/settings.xml.rels':
      XML +
      `<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL}/attachedTemplate" Target="file:///C:/Users/ExampleUser/Templates/Normal.dotm" TargetMode="External"/></Relationships>`,
    'word/numbering.xml': NUMBERING,
    'word/styles.xml': STYLES,
    'word/theme/theme1.xml': THEME,
    'word/media/image1.jpeg': photoWithGps(),
  })
}

export function xlsx(): Uint8Array {
  const X = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
  return zip({
    '[Content_Types].xml': contentTypes([
      ['/xl/workbook.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'],
      ['/xl/worksheets/sheet1.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'],
      ['/xl/comments1.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml'],
      ['/xl/threadedComments/threadedComment1.xml', 'application/vnd.ms-excel.threadedcomments+xml'],
      ['/xl/persons/person.xml', 'application/vnd.ms-excel.person+xml'],
    ]),
    ...common('xl/workbook.xml'),
    'xl/workbook.xml':
      XML +
      `<workbook ${X} ${R} xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:x15="http://schemas.microsoft.com/office/spreadsheetml/2010/11/main" xmlns:xr="http://schemas.microsoft.com/office/spreadsheetml/2014/revision" mc:Ignorable="x15 xr">` +
      '<fileVersion appName="xl" lastEdited="7" lowestEdited="7" rupBuild="27425"/><workbookPr defaultThemeVersion="166925"/>' +
      '<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice Requires="x15"><x15ac:absPath xmlns:x15ac="http://schemas.microsoft.com/office/spreadsheetml/2010/11/ac" url="C:\\Users\\ExampleUser\\Documents\\"/></mc:Choice></mc:AlternateContent>' +
      '<xr:revisionPtr revIDLastSave="0" documentId="8_{00000000-AAAA-BBBB-CCCC-DDDDDDDDDDDD}" xr6:coauthVersionLast="47" xmlns:xr6="http://schemas.microsoft.com/office/spreadsheetml/2016/revision6"/>' +
      '<sheets><sheet name="Example Sheet" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': XML + `<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    'xl/worksheets/sheet1.xml': XML + `<worksheet ${X}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Visible cell</t></is></c></row></sheetData></worksheet>`,
    'xl/worksheets/_rels/sheet1.xml.rels':
      XML +
      `<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL}/comments" Target="../comments1.xml"/><Relationship Id="rId2" Type="http://schemas.microsoft.com/office/2017/10/relationships/threadedComment" Target="../threadedComments/threadedComment1.xml"/></Relationships>`,
    'xl/comments1.xml': XML + `<comments ${X}><authors><author>Example Author</author><author>tc={00000000-0000-0000-0000-000000000001}</author></authors><commentList><comment ref="A1" authorId="0"><text><r><t>A cell note</t></r></text></comment></commentList></comments>`,
    'xl/threadedComments/threadedComment1.xml':
      XML + '<ThreadedComments xmlns="http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments"><threadedComment ref="A1" dT="2024-06-12T18:30:00.00" personId="{00000000-0000-0000-0000-000000000002}" id="{00000000-0000-0000-0000-000000000001}"><text>A thread</text></threadedComment></ThreadedComments>',
    'xl/persons/person.xml':
      XML + '<personList xmlns="http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments"><person displayName="Example Author" id="{00000000-0000-0000-0000-000000000002}" userId="author@example.com" providerId="AD"/></personList>',
    'xl/media/image1.png': pngWithAuthor(),
  })
}

export function pptx(): Uint8Array {
  const P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
  const P188 = 'xmlns:p188="http://schemas.microsoft.com/office/powerpoint/2018/8/main"'
  return zip({
    '[Content_Types].xml': contentTypes([
      ['/ppt/presentation.xml', 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml'],
      ['/ppt/slides/slide1.xml', 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml'],
      ['/ppt/commentAuthors.xml', 'application/vnd.openxmlformats-officedocument.presentationml.commentAuthors+xml'],
      ['/ppt/comments/comment1.xml', 'application/vnd.openxmlformats-officedocument.presentationml.comments+xml'],
      ['/ppt/authors.xml', 'application/vnd.ms-powerpoint.authors+xml'],
      ['/ppt/comments/modernComment_100_1.xml', 'application/vnd.ms-powerpoint.comments+xml'],
      ['/ppt/revisionInfo.xml', 'application/vnd.ms-powerpoint.revisioninfo+xml'],
    ]),
    ...common('ppt/presentation.xml'),
    'ppt/presentation.xml': XML + `<p:presentation ${P} ${R}><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>`,
    'ppt/_rels/presentation.xml.rels':
      XML +
      `<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL}/slide" Target="slides/slide1.xml"/>` +
      `<Relationship Id="rId2" Type="${REL}/commentAuthors" Target="commentAuthors.xml"/>` +
      `<Relationship Id="rId3" Type="http://schemas.microsoft.com/office/2015/10/relationships/revisionInfo" Target="revisionInfo.xml"/>` +
      `<Relationship Id="rId4" Type="http://schemas.microsoft.com/office/2018/10/relationships/authors" Target="authors.xml"/></Relationships>`,
    'ppt/slides/slide1.xml': XML + `<p:sld ${P} xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Visible slide text</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
    'ppt/slides/_rels/slide1.xml.rels':
      XML + `<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL}/comments" Target="../comments/comment1.xml"/><Relationship Id="rId2" Type="${REL}/image" Target="../media/image1.jpeg"/></Relationships>`,
    'ppt/commentAuthors.xml': XML + `<p:cmAuthorLst ${P}><p:cmAuthor id="0" name="Example Author" initials="EA" lastIdx="1" clrIdx="0"/></p:cmAuthorLst>`,
    'ppt/comments/comment1.xml': XML + `<p:cmLst ${P}><p:cm authorId="0" dt="2024-06-12T18:30:00.000" idx="1"><p:pos x="10" y="10"/><p:text>A slide comment</p:text></p:cm></p:cmLst>`,
    'ppt/authors.xml': XML + `<p188:authorLst ${P188}><p188:author id="{00000000-0000-0000-0000-000000000003}" name="Example Author" initials="EA" userId="author@example.com" providerId="AD"/></p188:authorLst>`,
    'ppt/comments/modernComment_100_1.xml':
      XML + `<p188:cmLst ${P188}><p188:cm id="{00000000-0000-0000-0000-000000000004}" authorId="{00000000-0000-0000-0000-000000000003}" created="2024-06-12T18:30:00.000"><p188:txBody><a:p xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:r><a:t>Modern comment</a:t></a:r></a:p></p188:txBody></p188:cm></p188:cmLst>`,
    'ppt/revisionInfo.xml': XML + '<p1510:revInfo xmlns:p1510="http://schemas.microsoft.com/office/powerpoint/2015/10/main"><p1510:revLst><p1510:client id="{00000000-0000-0000-0000-000000000005}" v="2" dt="2024-06-12T18:30:00.000"/></p1510:revLst></p1510:revInfo>',
    'ppt/media/image1.jpeg': photoWithGps(),
  })
}

// --- OpenDocument -------------------------------------------------------------

const ODF_NS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" ' +
  'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" ' +
  'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" ' +
  'xmlns:xlink="http://www.w3.org/1999/xlink"'

export const ODF_META =
  `<?xml version="1.0" encoding="UTF-8"?>\n<office:document-meta ${ODF_NS} office:version="1.3"><office:meta>` +
  '<meta:initial-creator>Example Author</meta:initial-creator><dc:creator>Example Editor</dc:creator>' +
  '<meta:creation-date>2024-06-12T18:30:00</meta:creation-date><dc:date>2024-06-12T19:00:00</dc:date>' +
  '<meta:editing-cycles>7</meta:editing-cycles><meta:editing-duration>PT42M</meta:editing-duration>' +
  '<meta:generator>ExampleOffice/1.0$ExampleOS</meta:generator><dc:title>Example Title</dc:title>' +
  '<meta:keyword>example</meta:keyword><meta:user-defined meta:name="Client">Example Client</meta:user-defined>' +
  '<meta:template xlink:type="simple" xlink:href="file:///home/exampleuser/Templates/report.ott" xlink:title="report"/>' +
  '<meta:document-statistic meta:page-count="1"/></office:meta></office:document-meta>'

export const ODF_SETTINGS =
  '<?xml version="1.0" encoding="UTF-8"?>\n<office:document-settings xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0" office:version="1.3"><office:settings>' +
  '<config:config-item-set config:name="ooo:configuration-settings"><config:config-item config:name="PrinterName" config:type="string">Example Office Printer</config:config-item>' +
  '<config:config-item config:name="PrinterSetup" config:type="base64Binary">RXhhbXBsZQ==</config:config-item>' +
  '<config:config-item config:name="TabsRelativeToIndent" config:type="boolean">true</config:config-item></config:config-item-set></office:settings></office:document-settings>'

const annotation =
  '<office:annotation><dc:creator>Example Author</dc:creator><dc:date>2024-06-12T18:30:00</dc:date><meta:creator-initials>EA</meta:creator-initials><text:p>A comment</text:p></office:annotation>'

const changes =
  '<text:tracked-changes><text:changed-region text:id="ct1"><text:insertion><office:change-info><dc:creator>Example Editor</dc:creator><dc:date>2024-06-12T18:31:00</dc:date></office:change-info></text:insertion></text:changed-region></text:tracked-changes>'

export const ODT_CONTENT =
  `<?xml version="1.0" encoding="UTF-8"?>\n<office:document-content ${ODF_NS} office:version="1.3"><office:body><office:text>` +
  changes +
  `<text:p>Visible paragraph ${annotation} with a note</text:p><text:p><text:change-start text:change-id="ct1"/>inserted<text:change-end text:change-id="ct1"/></text:p>` +
  '<text:p><draw:frame><draw:image xlink:href="Pictures/photo.jpg"/></draw:frame></text:p></office:text></office:body></office:document-content>'

const ODS_CONTENT =
  `<?xml version="1.0" encoding="UTF-8"?>\n<office:document-content ${ODF_NS} office:version="1.3"><office:body><office:spreadsheet>` +
  `<table:table table:name="Example"><table:table-row><table:table-cell>${annotation}<text:p>Visible cell</text:p></table:table-cell></table:table-row></table:table></office:spreadsheet></office:body></office:document-content>`

const ODP_CONTENT =
  `<?xml version="1.0" encoding="UTF-8"?>\n<office:document-content ${ODF_NS} office:version="1.3"><office:body><office:presentation>` +
  `<draw:page draw:name="page1"><draw:frame><draw:text-box><text:p>Visible slide</text:p></draw:text-box></draw:frame>${annotation}</draw:page></office:presentation></office:body></office:document-content>`

export const ODF_STYLES = `<?xml version="1.0" encoding="UTF-8"?>\n<office:document-styles ${ODF_NS} office:version="1.3"><office:styles/></office:document-styles>`

export function odf(kind: 'text' | 'spreadsheet' | 'presentation'): Uint8Array {
  const mime = `application/vnd.oasis.opendocument.${kind}`
  const content = kind === 'text' ? ODT_CONTENT : kind === 'spreadsheet' ? ODS_CONTENT : ODP_CONTENT
  const entry = (path: string, type: string) => `<manifest:file-entry manifest:full-path="${path}" manifest:media-type="${type}"/>`
  return zip(
    {
      mimetype: mime,
      'META-INF/manifest.xml':
        '<?xml version="1.0" encoding="UTF-8"?>\n<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3">' +
        entry('/', mime) + entry('content.xml', 'text/xml') + entry('styles.xml', 'text/xml') + entry('meta.xml', 'text/xml') +
        entry('settings.xml', 'text/xml') + entry('Thumbnails/thumbnail.png', 'image/png') + entry('Pictures/photo.jpg', 'image/jpeg') +
        entry('VersionList.xml', 'text/xml') + entry('Versions/Version1', 'application/vnd.sun.xml.writer') + entry('Versions/', '') +
        '</manifest:manifest>',
      'content.xml': content,
      'styles.xml': ODF_STYLES,
      'meta.xml': ODF_META,
      'settings.xml': ODF_SETTINGS,
      'Thumbnails/thumbnail.png': pngWithAuthor(),
      'Pictures/photo.jpg': photoWithGps(),
      'VersionList.xml': '<?xml version="1.0" encoding="UTF-8"?>\n<VL:version-list xmlns:VL="http://openoffice.org/2001/versions-list"><VL:version-entry VL:title="Version1" VL:creator="Example Author"/></VL:version-list>',
      'Versions/Version1': utf8('old version with deleted text'),
    },
    ['mimetype'],
  )
}

/**
 * A minimal Compound File (the container of Office's older files) whose
 * directory lists these streams, over as many 512-byte sectors as they need.
 */
export function compound(names: string[]): Uint8Array {
  const entries = ['Root Entry', ...names]
  const dirSectors = Math.ceil(entries.length / 4)
  const out = new Uint8Array(512 * (2 + dirSectors))
  const v = new DataView(out.buffer)
  out.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
  v.setUint16(0x18, 0x3e, true)
  v.setUint16(0x1a, 3, true)
  v.setUint16(0x1c, 0xfffe, true)
  v.setUint16(0x1e, 9, true)
  v.setUint16(0x20, 6, true)
  v.setUint32(0x2c, 1, true) // one allocation-table sector
  v.setUint32(0x30, 1, true) // the directory starts at sector 1
  v.setUint32(0x3c, 0xfffffffe, true)
  v.setUint32(0x44, 0xfffffffe, true)
  for (let i = 0; i < 109; i++) v.setUint32(0x4c + 4 * i, i === 0 ? 0 : 0xffffffff, true)
  // Sector 0, the allocation table: itself, then the directory's chain.
  const fat = 512
  for (let i = 0; i < 128; i++) v.setUint32(fat + 4 * i, 0xffffffff, true)
  v.setUint32(fat, 0xfffffffd, true)
  for (let s = 1; s <= dirSectors; s++) v.setUint32(fat + 4 * s, s === dirSectors ? 0xfffffffe : s + 1, true)
  entries.forEach((name, i) => {
    const e = 1024 + 128 * i
    for (let k = 0; k < name.length; k++) v.setUint16(e + 2 * k, name.charCodeAt(k), true)
    v.setUint16(e + 0x40, 2 * (name.length + 1), true)
    out[e + 0x42] = i === 0 ? 5 : 2
  })
  return out
}

/** The photo inside privateRtf(), with its EXIF. */
export const RTF_PHOTO = grayJpeg(exifApp1(phoneExif()))

/** An RTF document holding every kind of hidden detail the RTF cleaner removes, a photo among them; names are invented. */
export function privateRtf(): Uint8Array {
  const pictureHex = Buffer.from(RTF_PHOTO).toString('hex').match(/.{1,128}/g)!.join('\r\n')
  const lines = [
    '{\\rtf1\\ansi\\ansicpg1252\\deff0\\uc1{\\fonttbl{\\f0\\froman Times New Roman;}}',
    '{\\*\\generator Riched20 10.0.19041;}',
    '{\\info{\\title Example Title}{\\subject Example Subject}{\\author Jos\\\'e9 Example Author}{\\operator Example Editor}',
    '{\\*\\company Example Corp}{\\manager Example Manager}{\\keywords example, keywords}{\\doccomm Example description}',
    '{\\creatim\\yr2024\\mo6\\dy12\\hr18\\min30}{\\revtim\\yr2024\\mo6\\dy12\\hr18\\min31}\\version3\\edmins12\\nofpages1\\nofwords5}',
    '{\\*\\template C:\\\\Users\\\\ExampleUser\\\\Normal.dotm}',
    '{\\*\\userprops {\\propname MSIP_Label_1234_Enabled}\\proptype30{\\staticval true}}',
    '{\\*\\docvar {secretvar}{secretvalue}}',
    '{\\*\\rsidtbl \\rsid1234567\\rsid7654321}{\\*\\revtbl {Unknown;}{Example Reviewer;}}',
    '{\\stylesheet{\\s0\\styrsid1234567 Normal;}}',
    '\\pard\\plain\\insrsid1234567\\charrsid7654321 Hello \\b\\insrsid1234567{\\*\\rsidtbl}world\\b0\\par',
    '{\\*\\atnid EX}{\\*\\atnauthor Example Commenter}\\chatn{\\*\\annotation{\\*\\atndate 1234567}\\pard Note text}',
    '\\revised\\revauth1\\revdttm1234567 inserted\\revised0\\par',
    '{\\*\\shppict{\\pict\\picw8\\pich8\\picwgoal120\\pichgoal120\\jpegblip\\bliptag-12345{\\*\\blipuid 0123456789abcdef0123456789abcdef}',
    pictureHex + '}}',
    "\\'e9t\\'e9 \\u8364?\\par",
    '}',
    'TRAILING-SECRET',
  ]
  return Uint8Array.from(lines.join('\r\n'), (c) => c.charCodeAt(0))
}
