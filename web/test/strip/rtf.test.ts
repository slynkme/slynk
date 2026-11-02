// RTF documents: the info group, app, template, custom properties, rsids,
// comment and tracked-change names, and pictures' own metadata.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { stripBytes } from '../../src/strip/engine.ts'
import { IN_PICTURES, LABEL } from '../../src/strip/labels.ts'
import { detectKind } from '../../src/strip/sniff.ts'
import { RTF_PHOTO as PHOTO, privateRtf } from './docfixtures.ts'
import { latin1 } from './fixtures.ts'

const bytes = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0))

/** A picture's bytes back from the hex in a cleaned file. */
function pictureIn(rtf: string): Uint8Array {
  const m = /\\jpegblip[^{}]*?\s([0-9a-f\s]{40,})\}/.exec(rtf)
  assert.ok(m, 'no picture data found')
  return Uint8Array.from(Buffer.from(m[1].replace(/\s/g, ''), 'hex'))
}

const PRIVATE = [
  'Example Title',
  'Example Subject',
  'Example Author',
  'Example Editor',
  'Example Corp',
  'Example Manager',
  'Example description',
  'ExampleUser',
  'MSIP_Label',
  'secretvalue',
  'Riched20',
  'rsid',
  'revdttm',
  'Example Reviewer',
  'Example Commenter',
  'atndate',
  'bliptag',
  'blipuid',
  'TRAILING-SECRET',
  'yr2024',
  'edmins',
]

async function clean(b: Uint8Array) {
  const r = await stripBytes(b)
  assert.equal(r.status, 'cleaned', JSON.stringify(r))
  if (r.status !== 'cleaned') throw new Error()
  return r
}

test('RTF: detected by its first bytes', () => {
  assert.equal(detectKind(privateRtf()), 'rtf')
  assert.equal(detectKind(bytes('{\\rtf1 hello}')), 'rtf')
  assert.equal(detectKind(bytes('{\\rt hello there}')), null)
})

test('RTF: removes properties, app, template, custom properties, rsids and trailing data; anonymises comments and changes', async () => {
  const input = latin1(privateRtf())
  for (const s of PRIVATE) assert.ok(input.includes(s), s)
  const r = await clean(bytes(input))
  const out = latin1(r.bytes)
  for (const s of PRIVATE) assert.ok(!out.includes(s), s)
  for (const label of [
    LABEL.author,
    LABEL.lastEditor,
    LABEL.company,
    LABEL.manager,
    LABEL.title,
    LABEL.keywords,
    LABEL.description,
    LABEL.dates,
    LABEL.revision,
    LABEL.editTime,
    LABEL.otherDoc,
    LABEL.app,
    LABEL.template,
    LABEL.custom,
    LABEL.sensitivity,
    LABEL.ids,
    LABEL.commentAuthors,
    LABEL.changeAuthors,
    LABEL.trailing,
    LABEL.gps + IN_PICTURES,
    LABEL.camera + IN_PICTURES,
  ])
    assert.ok(r.removed.includes(label), label)
  const shown = Object.fromEntries(r.details.map((d) => [d.label, d.values]))
  assert.deepEqual(shown[LABEL.author], ['José Example Author'])
  assert.deepEqual(shown[LABEL.lastEditor], ['Example Editor'])
  assert.deepEqual(shown[LABEL.company], ['Example Corp'])
  assert.deepEqual(shown[LABEL.app], ['Riched20 10.0.19041'])
  assert.deepEqual(shown[LABEL.title], ['Example Title', 'Example Subject'])

  // What the document shows is untouched, word for word.
  assert.ok(out.startsWith('{\\rtf1\\ansi\\ansicpg1252\\deff0\\uc1{\\fonttbl{\\f0\\froman Times New Roman;}}'))
  assert.ok(out.includes('{\\stylesheet{\\s0 Normal;}}'))
  assert.ok(out.includes('\\pard\\plain Hello \\b world\\b0\\par'), out)
  assert.ok(out.includes('{\\*\\atnid}{\\*\\atnauthor Author}\\chatn{\\*\\annotation \\pard Note text}'), out)
  assert.ok(out.includes('{\\*\\revtbl {Unknown;}{Author;}}'))
  assert.ok(out.includes('\\revised\\revauth1 inserted\\revised0\\par'), out)
  assert.ok(out.includes("\\'e9t\\'e9 \\u8364?\\par"))
  assert.ok(out.includes('\\picwgoal120\\pichgoal120\\jpegblip'))
  assert.ok(out.trimEnd().endsWith('}'))
  // The picture is still a JPEG, without its EXIF.
  const picture = pictureIn(out)
  assert.equal(detectKind(picture), 'jpeg')
  assert.ok(!latin1(picture).includes('ExampleCam'))
  assert.ok(latin1(PHOTO).includes('ExampleCam'))
  // Cleaning it again finds nothing.
  assert.equal((await stripBytes(r.bytes)).status, 'unchanged')
})

test('RTF: a cut never joins a control word to what follows', async () => {
  const r = await clean(bytes('{\\rtf1\\ansi\\b{\\*\\generator App 1;}x\\i\\rsid12 y\\ul\\rsid3\\rsid4\\par}'))
  assert.equal(latin1(r.bytes), '{\\rtf1\\ansi\\b x\\i y\\ul \\par}')
})

test('RTF: pictures as raw \\bin bytes are cleaned too, written back as hex', async () => {
  const raw = latin1(PHOTO)
  const r = await clean(bytes(`{\\rtf1{\\pict\\jpegblip\\bin${PHOTO.length} ${raw}}}`))
  const out = latin1(r.bytes)
  assert.ok(!out.includes('\\bin') && !out.includes('ExampleCam'))
  assert.equal(detectKind(pictureIn(out)), 'jpeg')
})

test('RTF: a file with nothing to remove is left alone', async () => {
  assert.deepEqual(await stripBytes(bytes('{\\rtf1\\ansi{\\fonttbl{\\f0 Arial;}}\\f0 Hello\\par}')), { status: 'unchanged', kind: 'rtf' })
  // An empty info group holds nothing.
  assert.deepEqual(await stripBytes(bytes('{\\rtf1\\ansi{\\info}Hello\\par}\r\n\0')), { status: 'unchanged', kind: 'rtf' })
})

test('RTF: broken files fail, so the sender is asked', async () => {
  for (const s of ['{\\rtf1 {\\info{\\author A}', '{\\rtf1 \\', '{\\rtf1 {\\pict\\jpegblip\\bin999 ab}}']) {
    const r = await stripBytes(bytes(s))
    assert.equal(r.status, 'failed', s)
  }
})
