// PDF, through pdf-lib. Unlike the other formats, the whole file is rewritten
// as one fresh revision (the composer always asks for it; "Send original
// instead" undoes it).
//
// Removed: the Info dictionary (title, author, subject, keywords, creator and
// producer apps, dates, custom keys), XMP metadata at document, page and
// object level, app-private PieceInfo, page thumbnails, LastModified stamps,
// the authors' names and dates on comments (shown as "Author"), EXIF inside
// JPEG images, and everything no longer reachable from the document, which is
// where older revisions (and the text they deleted) linger.
//
// Never touched: signed PDFs (cleaning breaks the signature) and encrypted ones.
// PDF/A and PDF/UA files keep a minimal XMP naming their conformance level.
import {
  EncryptedPDFError,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  type PDFObject,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  decodePDFRawStream,
} from 'pdf-lib'
import { fromUtf8, indexOf, latin1, utf8 } from './bytes.ts'
import { stripPicture } from './embedded.ts'
import { ANON, LABEL } from './labels.ts'
import { type FormatOutcome, type Found, type Kind, SKIP, type StripOptions, fail } from './types.ts'
import { addAll, addFound } from './values.ts'
import { PDF_ID, onlyNamespaces, xmpLabels, xmpValues } from './xmp.ts'

const N = (s: string) => PDFName.of(s)
const PLACEHOLDER = '0'.repeat(32)

const INFO_LABELS: Record<string, string> = {
  Title: LABEL.title,
  Subject: LABEL.title,
  Author: LABEL.author,
  Keywords: LABEL.keywords,
  Creator: LABEL.app,
  Producer: LABEL.app,
  CreationDate: LABEL.dates,
  ModDate: LABEL.dates,
  Trapped: '',
}

// Info entries whose values the sender sees: the author, the title and the apps.
const SHOWN = new Set(['Title', 'Subject', 'Author', 'Creator', 'Producer'])

const MARKUP = new Set([
  'Text', 'FreeText', 'Line', 'Square', 'Circle', 'Polygon', 'PolyLine', 'Highlight', 'Underline', 'Squiggly',
  'StrikeOut', 'Stamp', 'Caret', 'Ink', 'FileAttachment', 'Sound', 'Redact', 'Projection',
])

const LOAD = { updateMetadata: false, ignoreEncryption: false, throwOnInvalidObject: true, parseSpeed: Infinity }

/** Calls fn on every dictionary inside obj, including stream dictionaries, without following references. */
function eachDict(obj: PDFObject, fn: (d: PDFDict) => void) {
  const stack: PDFObject[] = [obj]
  while (stack.length) {
    const o = stack.pop()!
    if (o instanceof PDFStream) stack.push(o.dict)
    else if (o instanceof PDFDict) {
      fn(o)
      for (const [, v] of o.entries()) if (v instanceof PDFDict || v instanceof PDFArray) stack.push(v)
    } else if (o instanceof PDFArray) {
      for (let i = 0; i < o.size(); i++) {
        const v = o.get(i)
        if (v instanceof PDFDict || v instanceof PDFArray) stack.push(v)
      }
    }
  }
}

/** Indirect objects reachable from roots. */
export function reachable(doc: PDFDocument, roots: (PDFObject | undefined)[]): Set<PDFRef> {
  const seen = new Set<PDFRef>()
  const stack = roots.filter((r): r is PDFObject => !!r)
  while (stack.length) {
    const o = stack.pop()!
    if (o instanceof PDFRef) {
      if (seen.has(o)) continue
      seen.add(o)
      const target = doc.context.lookup(o)
      if (target) stack.push(target)
    } else if (o instanceof PDFStream) stack.push(o.dict)
    else if (o instanceof PDFDict) for (const [, v] of o.entries()) stack.push(v)
    else if (o instanceof PDFArray) for (let i = 0; i < o.size(); i++) stack.push(o.get(i))
  }
  return seen
}

function textOfString(o: PDFObject | undefined): string {
  return o instanceof PDFString || o instanceof PDFHexString ? o.decodeText() : ''
}

function streamText(s: PDFObject | undefined): string | null {
  if (!(s instanceof PDFRawStream)) return null
  try {
    return fromUtf8(decodePDFRawStream(s).decode())
  } catch {
    return null
  }
}

function pdfXmpLabels(text: string | null, values: Found[]): string[] {
  if (text === null) return [LABEL.otherDoc]
  if (onlyNamespaces(text, PDF_ID)) return []
  addAll(values, xmpValues(text))
  const swap: Record<string, string> = {
    [LABEL.serial]: LABEL.ids,
    [LABEL.dateTaken]: LABEL.dates,
    [LABEL.otherPhoto]: LABEL.otherDoc,
    [LABEL.settings]: LABEL.otherDoc,
  }
  const labels = new Set(xmpLabels(text).map((l) => swap[l] ?? l))
  if (/\bpdf:Producer\b/.test(text)) labels.add(LABEL.app)
  if (/\bpdf:Keywords\b/.test(text)) labels.add(LABEL.keywords)
  if (labels.size > 1) labels.delete(LABEL.otherDoc)
  return [...labels]
}

/** A minimal XMP packet that keeps a PDF/A or PDF/UA claim true. */
function conformanceXmp(text: string): string | null {
  const field = (name: string) => new RegExp(`${name}\\s*(?:=\\s*["']|>)\\s*([A-Za-z0-9]+)`).exec(text)?.[1]
  const part = field('pdfaid:part')
  const conformance = field('pdfaid:conformance')
  const ua = field('pdfuaid:part')
  if (!part && !ua) return null
  const attrs = [
    part ? ` xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/" pdfaid:part="${part}"` : '',
    part && conformance ? ` pdfaid:conformance="${conformance}"` : '',
    ua ? ` xmlns:pdfuaid="http://www.aiim.org/pdfua/ns/id/" pdfuaid:part="${ua}"` : '',
  ].join('')
  return (
    '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>\n' +
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
    `<rdf:Description rdf:about=""${attrs}/></rdf:RDF></x:xmpmeta>\n<?xpacket end="w"?>`
  )
}

async function sha256Hex(b: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource))
  return [...digest.subarray(0, 16)].map((v) => v.toString(16).padStart(2, '0')).join('')
}

/** Where the trailer's two /ID strings sit, if they're plain 16-byte hex strings. */
function findId(b: Uint8Array): [number, number, string, string] | null {
  const from = Math.max(0, b.length - 4096)
  const m = /\/ID\s*\[\s*<([0-9A-Fa-f]{32})>\s*<([0-9A-Fa-f]{32})>\s*\]/.exec(latin1(b, from))
  if (!m) return null
  const first = from + m.index + m[0].indexOf('<') + 1
  const second = from + m.index + m[0].lastIndexOf('<') + 1
  return [first, second, m[1], m[2]]
}

/**
 * Our /ID is a hash of the file with a zero placeholder in its place, so it
 * depends only on the cleaned content and a second pass can recognise it.
 */
async function idFor(b: Uint8Array, at: [number, number]): Promise<string> {
  const copy = b.slice()
  copy.set(utf8(PLACEHOLDER), at[0])
  copy.set(utf8(PLACEHOLDER), at[1])
  return sha256Hex(copy)
}

async function hasOwnId(b: Uint8Array): Promise<boolean> {
  const id = findId(b)
  if (!id || id[2].toLowerCase() !== id[3].toLowerCase()) return false
  return (await idFor(b, [id[0], id[1]])) === id[2].toLowerCase()
}

export function looksSigned(doc: PDFDocument): boolean {
  let signed = !!doc.catalog.get(N('Perms'))
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    eachDict(obj, (d) => {
      if (d.has(N('ByteRange')) || d.has(N('SigFlags')) || d.get(N('Type')) === N('Sig')) signed = true
    })
  }
  return signed
}

export async function strip(b: Uint8Array, _kind: Kind, opts: StripOptions): Promise<FormatOutcome> {
  if (indexOf(b, '/ByteRange') !== -1 || indexOf(b, '/SigFlags') !== -1 || indexOf(b, '/Perms') !== -1) {
    return { status: 'skipped', reason: SKIP.signed }
  }
  if (indexOf(b, '/Encrypt') !== -1) return { status: 'skipped', reason: SKIP.encrypted }
  // Compressed object streams can hide a signature from the byte scan, so
  // those files are opened even when cleaning is off, to give the right reason.
  if (!opts.pdf && indexOf(b, '/ObjStm') === -1) return { status: 'skipped', reason: SKIP.pdfOff }
  let doc: PDFDocument
  try {
    doc = await PDFDocument.load(b, LOAD)
  } catch (err) {
    if (err instanceof EncryptedPDFError) return { status: 'skipped', reason: SKIP.encrypted }
    if (!opts.pdf) return { status: 'skipped', reason: SKIP.pdfOff }
    throw err
  }
  if (doc.isEncrypted) return { status: 'skipped', reason: SKIP.encrypted }
  if (looksSigned(doc)) return { status: 'skipped', reason: SKIP.signed }
  if (!opts.pdf) return { status: 'skipped', reason: SKIP.pdfOff }
  const pages = doc.getPageCount()
  const ctx = doc.context
  const labels = new Set<string>()
  const values: Found[] = []

  // Objects nothing points to: old revisions and what they replaced.
  const live = reachable(doc, [ctx.trailerInfo.Root, ctx.trailerInfo.Info])
  const unreachable = ctx.enumerateIndirectObjects().filter(([ref]) => !live.has(ref))
  const dictOf = (o: PDFObject) => (o instanceof PDFStream ? o.dict : o instanceof PDFDict ? o : null)
  const linearized = unreachable.some(([, o]) => dictOf(o)?.has(N('Linearized')))
  for (const [, obj] of unreachable) {
    const d = dictOf(obj)
    // Structure, not content: the linearization dictionary and its hint stream (which has /S).
    if (d?.has(N('Linearized')) || d?.get(N('Type')) === N('XRef') || d?.get(N('Type')) === N('ObjStm')) continue
    if (linearized && obj instanceof PDFStream && d?.has(N('S'))) continue
    labels.add(LABEL.leftovers)
  }

  const info = ctx.lookup(ctx.trailerInfo.Info)
  if (info instanceof PDFDict) {
    for (const [key, value] of info.entries()) {
      const name = key.decodeText()
      const label = Object.hasOwn(INFO_LABELS, name) ? INFO_LABELS[name] : LABEL.custom
      if (label && (textOfString(value) || !(value instanceof PDFString || value instanceof PDFHexString))) labels.add(label)
      if (label && SHOWN.has(name)) addFound(values, label, textOfString(value))
    }
  }
  ctx.trailerInfo.Info = undefined

  // The catalog's XMP, kept in minimal form when it declares PDF/A or PDF/UA.
  const catalogXmp = streamText(ctx.lookup(doc.catalog.get(N('Metadata'))))
  let conformance: string | null = null
  if (doc.catalog.has(N('Metadata'))) {
    const found = pdfXmpLabels(catalogXmp, values)
    if (found.length) {
      found.forEach((l) => labels.add(l))
      conformance = catalogXmp ? conformanceXmp(catalogXmp) : null
      doc.catalog.delete(N('Metadata'))
    }
  }

  const work: Promise<void>[] = []
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    eachDict(obj, (d) => {
      if (d !== doc.catalog && d.has(N('Metadata'))) {
        pdfXmpLabels(streamText(ctx.lookup(d.get(N('Metadata')))), values).forEach((l) => labels.add(l))
        d.delete(N('Metadata'))
      }
      if (d.has(N('PieceInfo'))) {
        labels.add(LABEL.appData)
        d.delete(N('PieceInfo'))
      }
      if (d.has(N('LastModified'))) {
        labels.add(LABEL.dates)
        d.delete(N('LastModified'))
      }
      if (d.get(N('Type')) === N('Page') && d.has(N('Thumb'))) {
        labels.add(LABEL.thumbnail)
        d.delete(N('Thumb'))
      }
      const sub = d.get(N('Subtype'))
      if (sub instanceof PDFName && MARKUP.has(sub.decodeText()) && (d.get(N('Type')) === N('Annot') || d.has(N('Rect')))) {
        if (d.has(N('T')) && textOfString(d.get(N('T'))) !== ANON) {
          d.set(N('T'), PDFString.of(ANON))
          labels.add(LABEL.commentAuthors)
        }
        for (const k of ['M', 'CreationDate']) {
          if (!d.has(N(k))) continue
          d.delete(N(k))
          labels.add(LABEL.commentAuthors)
        }
      }
    })
    // JPEG images carry their own EXIF.
    if (obj instanceof PDFRawStream) {
      const filter = obj.dict.get(N('Filter'))
      const dct = filter === N('DCTDecode') || (filter instanceof PDFArray && filter.size() === 1 && filter.get(0) === N('DCTDecode'))
      if (dct) {
        work.push(
          stripPicture(obj.contents).then((out) => {
            if (!out) return
            ctx.assign(ref, PDFRawStream.of(obj.dict, out.bytes))
            out.removed.forEach((l) => labels.add(l))
            addAll(values, out.values)
          }),
        )
      }
    }
  }
  await Promise.all(work)

  const hadId = !!ctx.trailerInfo.ID && !(await hasOwnId(b))
  if (hadId) labels.add(LABEL.ids)
  if (labels.size === 0) return { status: 'unchanged' }

  if (conformance) {
    const stream = ctx.stream(utf8(conformance), { Type: 'Metadata', Subtype: 'XML' })
    doc.catalog.set(N('Metadata'), ctx.register(stream))
  }
  // Drop everything no longer reachable from the document. Stream lengths are
  // written inline on save, so an indirect /Length object would be orphaned:
  // inline them first.
  for (const [, obj] of ctx.enumerateIndirectObjects()) if (obj instanceof PDFRawStream) obj.updateDict()
  const keep = reachable(doc, [ctx.trailerInfo.Root])
  for (const [ref] of ctx.enumerateIndirectObjects()) if (!keep.has(ref)) ctx.delete(ref)
  // The trailer's /Size is one more than the highest object number left.
  ctx.largestObjectNumber = ctx.enumerateIndirectObjects().reduce((n, [ref]) => Math.max(n, ref.objectNumber), 0)

  ctx.trailerInfo.ID = ctx.obj([PDFHexString.of(PLACEHOLDER), PDFHexString.of(PLACEHOLDER)])
  const out = await doc.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false, objectsPerTick: Infinity })
  const id = findId(out)
  if (!id || id[2] !== PLACEHOLDER || id[3] !== PLACEHOLDER) fail('could not place the document ID')
  const hash = await idFor(out, [id[0], id[1]])
  out.set(utf8(hash), id[0])
  out.set(utf8(hash), id[1])

  const check = await PDFDocument.load(out, LOAD)
  if (check.getPageCount() !== pages) fail('the page count changed')
  return { status: 'cleaned', bytes: out, removed: [...labels], values }
}

export async function verify(b: Uint8Array, kind: Kind): Promise<void> {
  const doc = await PDFDocument.load(b, LOAD)
  if (doc.context.trailerInfo.Info) fail('the Info dictionary is still there')
  const again = await strip(b, kind, { pdf: true })
  if (again.status !== 'unchanged') fail('something is still left to remove')
}
