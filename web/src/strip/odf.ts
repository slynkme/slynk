// OpenDocument files (ODT, ODS, ODP): ZIP packages like OOXML.
//
// Removed: meta.xml's people, dates, title, subject, keywords, description,
// custom fields, template, generator and editing statistics (also in embedded
// objects such as charts); the printer in settings.xml; the preview
// thumbnail; older saved versions; and the metadata of pictures inside.
// Comments and tracked changes stay, with every author shown as "Author" and
// comment dates removed (tracked changes need a date, so theirs is set to a
// neutral one). The manifest is kept in step. Signed files are left alone.
import { stripPicture } from './embedded.ts'
import { ANON, LABEL, NEUTRAL_DATE } from './labels.ts'
import { type FormatOutcome, type Found, type Kind, SKIP, fail } from './types.ts'
import { addAll, addFound } from './values.ts'
import { type Document, type Element, children, elements, parseXmlBytes, removeNode, serializeXmlBytes, setText, textOf } from './xml.ts'
import { type OutEntry, type Package, openPackage, readEntry, writePackage } from './zip.ts'

const NS = {
  office: 'urn:oasis:names:tc:opendocument:xmlns:office:1.0',
  meta: 'urn:oasis:names:tc:opendocument:xmlns:meta:1.0',
  dc: 'http://purl.org/dc/elements/1.1/',
  config: 'urn:oasis:names:tc:opendocument:xmlns:config:1.0',
  manifest: 'urn:oasis:names:tc:opendocument:xmlns:manifest:1.0',
  loext: 'urn:org:documentfoundation:names:experimental:office:xmlns:loext:1.0',
}

const MANIFEST = 'META-INF/manifest.xml'
const NEUTRAL = NEUTRAL_DATE.replace(/Z$/, '')

const META_LABELS: Record<string, string> = {
  'initial-creator': LABEL.author,
  creator: LABEL.lastEditor,
  'printed-by': LABEL.printedBy,
  'creation-date': LABEL.dates,
  date: LABEL.dates,
  'print-date': LABEL.dates,
  'editing-cycles': LABEL.revision,
  'editing-duration': LABEL.editTime,
  generator: LABEL.app,
  title: LABEL.title,
  subject: LABEL.title,
  description: LABEL.description,
  keyword: LABEL.keywords,
  'user-defined': LABEL.custom,
}

// Fields whose values the sender sees: names, the title and the app.
const SHOWN = new Set(['initial-creator', 'creator', 'printed-by', 'title', 'subject', 'generator'])

/** The author and date children of comments and tracked changes. */
function isPersonal(el: Element): boolean {
  return (
    (el.namespaceURI === NS.dc && (el.localName === 'creator' || el.localName === 'date')) ||
    (el.namespaceURI === NS.meta && (el.localName === 'creator-initials' || el.localName === 'date-string')) ||
    (el.namespaceURI === NS.loext && el.localName === 'sender-initials')
  )
}

export async function strip(bytes: Uint8Array, _kind: Kind): Promise<FormatOutcome> {
  const pkg: Package = openPackage(bytes)
  if (pkg.encrypted) return { status: 'skipped', reason: SKIP.encrypted }
  const byName = new Map(pkg.entries.map((e) => [e.name, e]))
  const mimetype = byName.get('mimetype')
  if (!mimetype || !byName.has(MANIFEST)) fail('not an OpenDocument file')
  const docs = new Map<string, Document>()
  const doc = (name: string) => {
    let d = docs.get(name)
    if (!d) docs.set(name, (d = parseXmlBytes(readEntry(pkg, byName.get(name)!))))
    return d
  }
  const manifest = doc(MANIFEST)
  if (elements(manifest, NS.manifest, 'encryption-data').length) return { status: 'skipped', reason: SKIP.encrypted }
  // Document and macro signatures cover the package's files; any change breaks them.
  if (pkg.entries.some((e) => /^META-INF\/[^/]*signatures[^/]*\.xml$/i.test(e.name))) return { status: 'skipped', reason: SKIP.signedDocument }

  const labels = new Set(pkg.labels)
  const values: Found[] = []
  const changed = new Map<string, Uint8Array>()
  const removed = new Set<string>()
  // Parts about to change, with their text beforehand (minus what we mean to change).
  const edited = new Map<string, [string, (el: Element) => boolean]>()
  const touch = (name: string, skip: (el: Element) => boolean = isPersonal) => {
    if (!edited.has(name)) edited.set(name, [textOf(doc(name), skip), skip])
  }

  // The document's meta.xml, and those of embedded objects such as charts ("Object 1/meta.xml").
  for (const e of pkg.entries) {
    if (e.name !== 'meta.xml' && !e.name.endsWith('/meta.xml')) continue
    if (e.usize === 0) continue
    const root = doc(e.name).documentElement!
    const meta = elements(root, NS.office, 'meta')[0]
    let found = false
    for (const el of meta ? children(meta) : []) {
      const name = el.localName ?? ''
      const label = Object.hasOwn(META_LABELS, name) ? META_LABELS[name] : undefined
      if (label && textOf(el).trim()) {
        labels.add(label)
        if (SHOWN.has(name)) addFound(values, label, textOf(el))
        found = true
      } else if (el.namespaceURI === NS.meta && el.localName === 'template') {
        labels.add(LABEL.template)
        found = true
      }
    }
    if (found) {
      const version = root.getAttributeNS(NS.office, 'version')
      const v = version ? ` office:version="${version.replace(/[^0-9.]/g, '')}"` : ''
      changed.set(e.name, new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8"?>\n<office:document-meta xmlns:office="${NS.office}"${v}><office:meta/></office:document-meta>`))
    }
  }

  if (byName.has('settings.xml')) {
    const isPrinter = (el: Element) => el.localName === 'config-item' && ['PrinterName', 'PrinterSetup'].includes(el.getAttributeNS(NS.config, 'name') ?? '')
    const items = elements(doc('settings.xml'), NS.config, 'config-item').filter((el) => isPrinter(el) && textOf(el).trim())
    if (items.length) {
      touch('settings.xml', isPrinter)
      items.forEach(removeNode)
      labels.add(LABEL.printer)
    }
  }

  for (const e of pkg.entries) {
    if (e.name.startsWith('Thumbnails/') && !e.name.endsWith('/')) {
      removed.add(e.name)
      labels.add(LABEL.thumbnail)
    }
    if (e.name === 'VersionList.xml' || (e.name.startsWith('Versions/') && !e.name.endsWith('/'))) {
      removed.add(e.name)
      labels.add(LABEL.versions)
    }
  }

  for (const e of pkg.entries) {
    // LibreOffice leaves some empty .xml files (Configurations2/accelerator/current.xml).
    if (!e.name.endsWith('.xml') || e.usize === 0 || removed.has(e.name) || ['meta.xml', 'settings.xml', MANIFEST].includes(e.name) || e.name.endsWith('/meta.xml')) continue
    if (e.name.startsWith('META-INF/')) continue
    const d = doc(e.name)
    const work: (() => void)[] = []
    for (const note of elements(d, NS.office, 'annotation')) {
      for (const el of children(note)) {
        if (el.namespaceURI === NS.dc && el.localName === 'creator' && textOf(el) !== ANON) work.push(() => setText(el, ANON))
        else if (isPersonal(el) && !(el.namespaceURI === NS.dc && el.localName === 'creator')) work.push(() => removeNode(el))
        else continue
        labels.add(LABEL.commentAuthors)
      }
    }
    for (const info of elements(d, NS.office, 'change-info')) {
      for (const el of children(info)) {
        if (el.namespaceURI !== NS.dc) continue
        if (el.localName === 'creator' && textOf(el) !== ANON) work.push(() => setText(el, ANON))
        else if (el.localName === 'date' && textOf(el) !== NEUTRAL) work.push(() => setText(el, NEUTRAL))
        else continue
        labels.add(LABEL.changeAuthors)
      }
    }
    if (!work.length) continue
    touch(e.name)
    work.forEach((w) => w())
  }

  for (const e of pkg.entries) {
    if (!e.name.startsWith('Pictures/') || e.name.endsWith('/')) continue
    const out = await stripPicture(readEntry(pkg, e))
    if (!out) continue
    changed.set(e.name, out.bytes)
    out.removed.forEach((l) => labels.add(l))
    addAll(values, out.values)
  }

  if (labels.size === 0) return { status: 'unchanged' }

  if (removed.size) {
    // The manifest must list exactly the files in the package.
    touch(MANIFEST)
    const left = pkg.entries.filter((e) => !removed.has(e.name)).map((e) => e.name)
    for (const fe of elements(manifest, NS.manifest, 'file-entry')) {
      const path = fe.getAttributeNS(NS.manifest, 'full-path') ?? ''
      const dirGone = path.endsWith('/') && [...removed].some((r) => r.startsWith(path)) && !left.some((n) => n.startsWith(path))
      if (removed.has(path) || dirGone) removeNode(fe)
    }
  }
  for (const [name, [before, skip]] of edited) {
    if (textOf(doc(name), skip) !== before) fail(`the text of ${name} would change`)
    changed.set(name, serializeXmlBytes(doc(name)))
  }

  // mimetype first and stored, as OpenDocument requires.
  const list: OutEntry[] = [{ name: 'mimetype', data: readEntry(pkg, mimetype!), store: true }]
  for (const e of pkg.entries) {
    if (e.name === 'mimetype' || removed.has(e.name)) continue
    const data = changed.get(e.name)
    list.push(data ? { name: e.name, data } : { name: e.name, from: e })
  }
  return { status: 'cleaned', bytes: writePackage(pkg, list), removed: [...labels], values }
}

export async function verify(bytes: Uint8Array, kind: Kind): Promise<void> {
  const pkg = openPackage(bytes)
  const first = pkg.entries[0]
  if (first?.name !== 'mimetype' || first.method !== 0) fail('mimetype must come first, uncompressed')
  for (const e of pkg.entries) {
    const data = readEntry(pkg, e)
    if (e.name.endsWith('.xml') && data.length) parseXmlBytes(data)
  }
  const again = await strip(bytes, kind)
  if (again.status !== 'unchanged') fail('something is still left to remove')
}
