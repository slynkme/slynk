// Word, Excel and PowerPoint files (OOXML): ZIP packages of XML parts.
//
// Removed: document properties (author, last editor, company, manager, title,
// subject, keywords, description, dates, revision, editing time, app and
// template), custom properties, sensitivity labels, the preview thumbnail,
// editing-session IDs (rsid), document IDs, Excel's saved path and the names
// on its pivot tables and shared-file settings, PowerPoint's revision and
// co-authoring logs, and the metadata of pictures and of Office files inside
// (a chart's workbook). Signed files are left alone.
//
// Kept on purpose: comments and tracked changes stay, with every author shown
// as "Author" and dates removed or set to a neutral value. Styles, numbering,
// themes and fonts are never touched, and a part is only rewritten when it
// holds something to remove; its text must come out identical.
import { stripPicture } from './embedded.ts'
import { ANON, LABEL, NEUTRAL_DATE } from './labels.ts'
import { detectKind } from './sniff.ts'
import { type FormatOutcome, type Found, type Kind, SKIP, fail } from './types.ts'
import { addAll, addFound } from './values.ts'
import {
  type Document,
  type Element,
  children,
  elements,
  parseXmlBytes,
  removeNode,
  serializeXmlBytes,
  setText,
  textOf,
} from './xml.ts'
import { type OutEntry, type Package, openPackage, readEntry, resolveTarget, writePackage } from './zip.ts'
import type { ZipEntry } from './zipdir.ts'

const NS = {
  ct: 'http://schemas.openxmlformats.org/package/2006/content-types',
  rel: 'http://schemas.openxmlformats.org/package/2006/relationships',
  cp: 'http://schemas.openxmlformats.org/package/2006/metadata/core-properties',
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  w14: 'http://schemas.microsoft.com/office/word/2010/wordml',
  w15: 'http://schemas.microsoft.com/office/word/2012/wordml',
  w16cex: 'http://schemas.microsoft.com/office/word/2018/wordml/cex',
  x: 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
  x15ac: 'http://schemas.microsoft.com/office/spreadsheetml/2010/11/ac',
  xr: 'http://schemas.microsoft.com/office/spreadsheetml/2014/revision',
  xtc: 'http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments',
  mc: 'http://schemas.openxmlformats.org/markup-compatibility/2006',
  p: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  p188: 'http://schemas.microsoft.com/office/powerpoint/2018/8/main',
}

// "Strict Open XML" files use other namespace names for the same markup.
const STRICT: Record<string, string> = {
  [NS.w]: 'http://purl.oclc.org/ooxml/wordprocessingml/main',
  [NS.x]: 'http://purl.oclc.org/ooxml/spreadsheetml/main',
  [NS.p]: 'http://purl.oclc.org/ooxml/presentationml/main',
}

/** True for a transitional namespace or its strict twin. */
function isNs(actual: string | null | undefined, ns: string): boolean {
  return actual === ns || (STRICT[ns] !== undefined && actual === STRICT[ns])
}

/** Elements by local name in a namespace or its strict twin. */
function elementsIn(root: Document | Element, ns: string, local: string): Element[] {
  return STRICT[ns] ? [...elements(root, ns, local), ...elements(root, STRICT[ns], local)] : elements(root, ns, local)
}

const REL = {
  core: 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties',
  app: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties',
  custom: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties',
  thumbnail: 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail',
  template: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate',
}

// The same relationships in strict files.
const REL_STRICT: Record<string, string> = {
  [REL.app]: 'http://purl.oclc.org/ooxml/officeDocument/relationships/extendedProperties',
  [REL.custom]: 'http://purl.oclc.org/ooxml/officeDocument/relationships/customProperties',
  [REL.template]: 'http://purl.oclc.org/ooxml/officeDocument/relationships/attachedTemplate',
}

function isRel(type: string | null, rel: string): boolean {
  return type === rel || (REL_STRICT[rel] !== undefined && type === REL_STRICT[rel])
}

const MINIMAL_CORE =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
  'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
  'xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"></cp:coreProperties>'

const MINIMAL_APP =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ' +
  'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"></Properties>'

const CORE_LABELS: Record<string, string> = {
  creator: LABEL.author,
  lastModifiedBy: LABEL.lastEditor,
  title: LABEL.title,
  subject: LABEL.title,
  keywords: LABEL.keywords,
  category: LABEL.keywords,
  description: LABEL.description,
  contentStatus: LABEL.otherDoc,
  identifier: LABEL.ids,
  created: LABEL.dates,
  modified: LABEL.dates,
  lastPrinted: LABEL.dates,
  revision: LABEL.revision,
  version: LABEL.revision,
}

const APP_LABELS: Record<string, string> = {
  Company: LABEL.company,
  Manager: LABEL.manager,
  Template: LABEL.template,
  TotalTime: LABEL.editTime,
  Application: LABEL.app,
  AppVersion: LABEL.app,
  HyperlinkBase: LABEL.otherDoc,
}

// Properties whose values the sender sees: names, the title and the app.
const SHOWN = new Set(['creator', 'lastModifiedBy', 'title', 'subject', 'Company', 'Manager', 'Application'])

/** A property's label; own keys only, so an element named "constructor" isn't mistaken for one. */
function labelOf(map: Record<string, string>, name: string | null | undefined): string | undefined {
  return name && Object.hasOwn(map, name) ? map[name] : undefined
}

/** Every element under root, without recursion (documents can nest deeply). */
function allElements(root: Element): Element[] {
  const out: Element[] = []
  const stack: Element[] = [root]
  while (stack.length) {
    const el = stack.pop()!
    out.push(el)
    for (let c = el.lastChild; c; c = c.previousSibling) if (c.nodeType === 1) stack.push(c as Element)
  }
  return out
}

/** Sets an attribute's value; returns true if that changed anything. */
function setAttr(el: Element, ns: string, local: string, value: string): boolean {
  const a = el.getAttributeNodeNS(ns, local)
  if (!a || a.value === value) return false
  a.value = value
  return true
}

function dropAttr(el: Element, ns: string, local: string): boolean {
  if (!el.hasAttributeNS(ns, local)) return false
  el.removeAttributeNS(ns, local)
  return true
}

class Session {
  pkg: Package
  kind: Kind
  labels: Set<string>
  /** What some of the removed properties say, for the sender to see. */
  values: Found[] = []
  byName: Map<string, ZipEntry>
  docs = new Map<string, Document>()
  changed = new Map<string, Uint8Array>()
  removed = new Set<string>()
  /** Parts whose XML was edited, with their text before editing. */
  edited = new Map<string, string>()

  constructor(pkg: Package, kind: Kind) {
    this.pkg = pkg
    this.kind = kind
    this.labels = new Set(pkg.labels)
    this.byName = new Map(pkg.entries.map((e) => [e.name, e]))
  }

  has(name: string): boolean {
    return this.byName.has(name)
  }

  doc(name: string): Document {
    let d = this.docs.get(name)
    if (!d) {
      d = parseXmlBytes(readEntry(this.pkg, this.byName.get(name)!))
      this.docs.set(name, d)
    }
    return d
  }

  /** Records that a part's XML is about to change, remembering its text. */
  touch(name: string, skip?: (el: Element) => boolean) {
    if (!this.edited.has(name)) this.edited.set(name, textOf(this.doc(name), skip))
  }

  label(l: string) {
    this.labels.add(l)
  }

  remove(name: string, label: string) {
    if (!this.has(name) || this.removed.has(name)) return
    this.removed.add(name)
    this.label(label)
  }

  /** Targets of the root relationships of a given type. */
  rootTargets(type: string): string[] {
    if (!this.has('_rels/.rels')) return []
    return elements(this.doc('_rels/.rels'), NS.rel, 'Relationship')
      .filter((r) => isRel(r.getAttribute('Type'), type) && r.getAttribute('TargetMode') !== 'External')
      .map((r) => resolveTarget('_rels/.rels', r.getAttribute('Target') ?? ''))
  }
}

function properties(s: Session) {
  const core = s.rootTargets(REL.core)[0] ?? 'docProps/core.xml'
  if (s.has(core)) {
    let found = false
    for (const el of children(s.doc(core).documentElement!)) {
      const label = labelOf(CORE_LABELS, el.localName)
      if (label && textOf(el).trim()) {
        s.label(label)
        if (SHOWN.has(el.localName!)) addFound(s.values, label, textOf(el))
        found = true
      }
    }
    if (found) s.changed.set(core, new TextEncoder().encode(MINIMAL_CORE))
  }
  const app = s.rootTargets(REL.app)[0] ?? 'docProps/app.xml'
  if (s.has(app)) {
    let found = false
    for (const el of children(s.doc(app).documentElement!)) {
      const label = labelOf(APP_LABELS, el.localName)
      if (label && textOf(el).trim()) {
        s.label(label)
        if (SHOWN.has(el.localName!)) addFound(s.values, label, textOf(el))
        found = true
      }
    }
    if (found) s.changed.set(app, new TextEncoder().encode(MINIMAL_APP))
  }
  for (const custom of [...s.rootTargets(REL.custom), 'docProps/custom.xml']) {
    if (!s.has(custom) || s.removed.has(custom)) continue
    const names = children(s.doc(custom).documentElement!)
      .filter((el) => el.localName === 'property')
      .map((el) => el.getAttribute('name') ?? '')
    // An empty part has nothing worth a "removed" line; leave it.
    if (!names.length) continue
    const labels: string[] = names.some((n) => n.startsWith('MSIP_Label')) ? [LABEL.sensitivity] : []
    if (names.some((n) => !n.startsWith('MSIP_Label'))) labels.push(LABEL.custom)
    s.remove(custom, labels[0])
    labels.forEach((l) => s.label(l))
  }
  for (const thumb of s.rootTargets(REL.thumbnail)) s.remove(thumb, LABEL.thumbnail)
  for (const e of s.pkg.entries) {
    if (/^docProps\/thumbnail\.[a-z]+$/i.test(e.name)) s.remove(e.name, LABEL.thumbnail)
    if (e.name.startsWith('docMetadata/')) s.remove(e.name, LABEL.sensitivity)
  }
}

function word(s: Session) {
  for (const e of s.pkg.entries) {
    if (!/^word\/.*\.xml$/.test(e.name) || e.usize === 0 || s.removed.has(e.name)) continue
    const doc = s.doc(e.name)
    const root = doc.documentElement!
    const changes: (() => void)[] = []
    for (const el of allElements(root)) {
      const isComment = isNs(el.namespaceURI, NS.w) && el.localName === 'comment'
      const who = isComment ? LABEL.commentAuthors : LABEL.changeAuthors
      const attrs = []
      for (let i = 0; i < el.attributes.length; i++) attrs.push(el.attributes[i])
      for (const a of attrs) {
        const ns = a.namespaceURI ?? ''
        const local = a.localName ?? ''
        if (isNs(ns, NS.w)) {
          if (local === 'author' && a.value !== ANON) changes.push(() => setAttr(el, ns, 'author', ANON) && s.label(who))
          else if (local === 'date' || (local === 'initials' && isComment)) {
            changes.push(() => dropAttr(el, ns, local) && s.label(who))
          } else if (local.startsWith('rsid')) changes.push(() => dropAttr(el, ns, local) && s.label(LABEL.ids))
        } else if (ns === NS.w15 && local === 'author' && a.value !== ANON) {
          changes.push(() => setAttr(el, NS.w15, 'author', ANON) && s.label(LABEL.commentAuthors))
        } else if (local === 'dateUtc' && ns.startsWith('http://schemas.microsoft.com/office/word/')) {
          // Newer Word stores each comment's and change's time again in UTC
          // (w16cex, w16du); next to the local w:date it also gives away the time zone.
          changes.push(() => dropAttr(el, ns, local) && s.label(ns === NS.w16cex ? LABEL.commentAuthors : who))
        }
      }
      if (el.namespaceURI === NS.w15 && el.localName === 'presenceInfo') {
        changes.push(() => (removeNode(el), s.label(LABEL.commentAuthors)))
      }
      if (e.name === 'word/settings.xml') {
        if (isNs(el.namespaceURI, NS.w) && el.localName === 'rsids') changes.push(() => (removeNode(el), s.label(LABEL.ids)))
        if ((el.namespaceURI === NS.w14 || el.namespaceURI === NS.w15) && el.localName === 'docId') {
          changes.push(() => (removeNode(el), s.label(LABEL.ids)))
        }
        if (isNs(el.namespaceURI, NS.w) && el.localName === 'attachedTemplate') {
          changes.push(() => (removeNode(el), s.label(LABEL.template)))
        }
      }
    }
    if (!changes.length) continue
    s.touch(e.name)
    for (const c of changes) c()
    if (e.name === 'word/people.xml') {
      // With every name now "Author", keep one entry per name.
      const seen = new Set<string>()
      for (const person of elements(doc, NS.w15, 'person')) {
        const name = person.getAttributeNS(NS.w15, 'author') ?? ''
        if (seen.has(name)) removeNode(person)
        seen.add(name)
      }
    }
  }
  // The template's path lives in settings' relationships.
  const rels = 'word/_rels/settings.xml.rels'
  if (s.has(rels)) {
    const doc = s.doc(rels)
    for (const r of elements(doc, NS.rel, 'Relationship')) {
      if (!isRel(r.getAttribute('Type'), REL.template)) continue
      s.touch(rels)
      removeNode(r)
      s.label(LABEL.template)
    }
  }
}

function excel(s: Session) {
  const wb = 'xl/workbook.xml'
  if (s.has(wb)) {
    const doc = s.doc(wb)
    const absPaths = elements(doc, NS.x15ac, 'absPath')
    const revision = elements(doc, NS.xr, 'revisionPtr')
    const version = elementsIn(doc, NS.x, 'fileVersion')
    // "Read-only recommended" and write-reservation keep the name of whoever set them.
    const sharing = elementsIn(doc, NS.x, 'fileSharing').filter((el) => el.hasAttribute('userName') && el.getAttribute('userName') !== ANON)
    if (absPaths.length || revision.length || version.length || sharing.length) s.touch(wb)
    for (const el of sharing) {
      el.setAttribute('userName', ANON)
      s.label(LABEL.author)
    }
    for (const el of absPaths) {
      const choice = el.parentNode as Element | null
      removeNode(el)
      // Drop the compatibility wrapper too once it holds nothing else.
      if (choice?.namespaceURI === NS.mc && children(choice).length === 0) {
        const block = choice.parentNode as Element | null
        removeNode(choice)
        if (block?.namespaceURI === NS.mc && children(block).every((c) => c.localName === 'Fallback' && children(c).length === 0)) removeNode(block)
      }
      s.label(LABEL.savedPath)
    }
    for (const el of revision) {
      removeNode(el)
      s.label(LABEL.ids)
    }
    for (const el of version) {
      removeNode(el)
      s.label(LABEL.app)
    }
  }
  for (const e of s.pkg.entries) {
    const n = e.name
    if (/^xl\/pivotCache\/[^/]+\.xml$/.test(n) && !n.includes('Records')) {
      // A pivot table's cache says who last refreshed it, and when.
      const defs = elementsIn(s.doc(n), NS.x, 'pivotCacheDefinition').filter(
        (el) => (el.hasAttribute('refreshedBy') && el.getAttribute('refreshedBy') !== ANON) || el.hasAttribute('refreshedDate') || el.hasAttribute('refreshedDateIso'),
      )
      if (!defs.length) continue
      s.touch(n)
      for (const el of defs) {
        if (el.hasAttribute('refreshedBy') && el.getAttribute('refreshedBy') !== ANON) {
          el.setAttribute('refreshedBy', ANON)
          s.label(LABEL.lastEditor)
        }
        for (const k of ['refreshedDate', 'refreshedDateIso']) {
          if (!el.hasAttribute(k)) continue
          el.removeAttribute(k)
          s.label(LABEL.dates)
        }
      }
    } else if (/^xl\/comments\d*\.xml$/.test(n)) {
      const authors = elementsIn(s.doc(n), NS.x, 'author').filter((a) => textOf(a) !== ANON)
      if (!authors.length) continue
      s.touch(n, (el) => el.localName === 'authors')
      for (const a of authors) setText(a, ANON)
      s.label(LABEL.commentAuthors)
    } else if (/^xl\/threadedComments\/[^/]+\.xml$/.test(n)) {
      const list = elements(s.doc(n), NS.xtc, 'threadedComment').filter((c) => c.hasAttribute('dT') && c.getAttribute('dT') !== NEUTRAL_DATE)
      if (!list.length) continue
      s.touch(n)
      for (const c of list) c.setAttribute('dT', NEUTRAL_DATE)
      s.label(LABEL.commentAuthors)
    } else if (/^xl\/persons\/[^/]+\.xml$/.test(n)) {
      const people = elements(s.doc(n), NS.xtc, 'person')
      const want: [string, string][] = [['displayName', ANON], ['userId', ANON], ['providerId', 'None']]
      const todo = people.filter((p) => want.some(([k, v]) => p.hasAttribute(k) && p.getAttribute(k) !== v))
      if (!todo.length) continue
      s.touch(n)
      for (const p of todo) for (const [k, v] of want) if (p.hasAttribute(k)) p.setAttribute(k, v)
      s.label(LABEL.commentAuthors)
    } else if (/^xl\/revisions\/[^/]+\.xml$/.test(n)) {
      // Shared-workbook change history: who changed what, and when.
      const targets: [string, string][] = [['userName', ANON], ['name', ANON], ['dateTime', NEUTRAL_DATE]]
      const els = allElements(s.doc(n).documentElement!).filter(
        (el) => (el.localName === 'header' || el.localName === 'userInfo') && targets.some(([k, v]) => el.hasAttribute(k) && el.getAttribute(k) !== v),
      )
      if (!els.length) continue
      s.touch(n)
      for (const el of els) for (const [k, v] of targets) if (el.hasAttribute(k)) el.setAttribute(k, v)
      s.label(LABEL.changeAuthors)
    }
  }
}

function powerpoint(s: Session) {
  for (const e of s.pkg.entries) {
    const n = e.name
    if (n === 'ppt/commentAuthors.xml') {
      const list = elementsIn(s.doc(n), NS.p, 'cmAuthor').filter((a) => a.getAttribute('name') !== ANON || a.getAttribute('initials') !== 'A')
      if (!list.length) continue
      s.touch(n)
      for (const a of list) {
        a.setAttribute('name', ANON)
        a.setAttribute('initials', 'A')
      }
      s.label(LABEL.commentAuthors)
    } else if (n === 'ppt/authors.xml') {
      const want: [string, string][] = [['name', ANON], ['initials', 'A'], ['userId', ANON], ['providerId', 'None']]
      const list = elements(s.doc(n), NS.p188, 'author').filter((a) => want.some(([k, v]) => a.hasAttribute(k) && a.getAttribute(k) !== v))
      if (!list.length) continue
      s.touch(n)
      for (const a of list) for (const [k, v] of want) if (a.hasAttribute(k)) a.setAttribute(k, v)
      s.label(LABEL.commentAuthors)
    } else if (/^ppt\/comments\/[^/]+\.xml$/.test(n)) {
      const doc = s.doc(n)
      const list = [
        ...elementsIn(doc, NS.p, 'cm').map((el) => [el, 'dt'] as const),
        ...elements(doc, NS.p188, 'cm').map((el) => [el, 'created'] as const),
        ...elements(doc, NS.p188, 'reply').map((el) => [el, 'created'] as const),
      ].filter(([el, k]) => el.hasAttribute(k) && el.getAttribute(k) !== NEUTRAL_DATE)
      if (!list.length) continue
      s.touch(n)
      for (const [el, k] of list) el.setAttribute(k, NEUTRAL_DATE)
      s.label(LABEL.commentAuthors)
    } else if (n === 'ppt/revisionInfo.xml') {
      s.remove(n, LABEL.ids)
    } else if (/^ppt\/changesInfos\/[^/]+\.xml$/.test(n)) {
      // Co-authoring change log: every editor's name, account and edit times.
      s.remove(n, LABEL.history)
    }
  }
}

/** Office files nested this deep are refused rather than followed. */
const MAX_DEPTH = 2

async function pictures(s: Session) {
  for (const e of s.pkg.entries) {
    if (!/^(word|xl|ppt)\/media\//.test(e.name) || s.removed.has(e.name)) continue
    const out = await stripPicture(readEntry(s.pkg, e))
    if (!out) continue
    s.changed.set(e.name, out.bytes)
    out.removed.forEach((l) => s.label(l))
    addAll(s.values, out.values)
  }
}

/**
 * Office files embedded in this one: every chart in Word or PowerPoint keeps
 * its data as a whole workbook, with its own author and dates.
 */
async function embedded(s: Session, depth: number) {
  for (const e of s.pkg.entries) {
    if (!/^(word|xl|ppt)\/embeddings\//.test(e.name) || s.removed.has(e.name)) continue
    const data = readEntry(s.pkg, e)
    const kind = detectKind(data)
    if (kind !== 'docx' && kind !== 'xlsx' && kind !== 'pptx') continue
    if (depth >= MAX_DEPTH) fail('Office files are nested too deeply')
    const out = await stripPackage(data, kind, depth + 1)
    if (out.status === 'skipped') fail(`an embedded document can’t be cleaned: ${out.reason}`)
    if (out.status !== 'cleaned') continue
    await checkPackage(out.bytes)
    s.changed.set(e.name, out.bytes)
    out.removed.forEach((l) => s.label(l))
    addAll(s.values, (out.values ?? []))
  }
}

/** Drops removed parts from [Content_Types].xml and every .rels file. */
function unlink(s: Session) {
  if (!s.removed.size) return
  const gone = new Set([...s.removed].map((n) => n.toLowerCase()))
  // A removed part's own relationships go with it.
  for (const n of s.removed) {
    const rels = n.replace(/([^/]*)$/, '_rels/$1.rels')
    if (s.has(rels)) s.removed.add(rels)
  }
  const ct = '[Content_Types].xml'
  if (s.has(ct)) {
    const list = elements(s.doc(ct), NS.ct, 'Override').filter((o) => gone.has((o.getAttribute('PartName') ?? '').replace(/^\//, '').toLowerCase()))
    if (list.length) s.touch(ct)
    list.forEach(removeNode)
  }
  for (const e of s.pkg.entries) {
    if (!e.name.endsWith('.rels') || s.removed.has(e.name)) continue
    const list = elements(s.doc(e.name), NS.rel, 'Relationship').filter(
      (r) => r.getAttribute('TargetMode') !== 'External' && gone.has(resolveTarget(e.name, r.getAttribute('Target') ?? '').toLowerCase()),
    )
    if (list.length) s.touch(e.name)
    list.forEach(removeNode)
  }
}

export function strip(bytes: Uint8Array, kind: Kind): Promise<FormatOutcome> {
  return stripPackage(bytes, kind, 0)
}

async function stripPackage(bytes: Uint8Array, kind: Kind, depth: number): Promise<FormatOutcome> {
  const pkg = openPackage(bytes)
  if (pkg.encrypted) return { status: 'skipped', reason: SKIP.encrypted }
  // Office signatures cover the package's parts, so any change breaks them.
  if (pkg.entries.some((e) => e.name.startsWith('_xmlsignatures/'))) return { status: 'skipped', reason: SKIP.signedDocument }
  const s = new Session(pkg, kind)
  if (!s.has('[Content_Types].xml')) fail('not an Office document')
  properties(s)
  if (kind === 'docx') word(s)
  if (kind === 'xlsx') excel(s)
  if (kind === 'pptx') powerpoint(s)
  await pictures(s)
  await embedded(s, depth)
  if (s.labels.size === 0) return { status: 'unchanged' }
  unlink(s)
  // Nothing may still point at a part that's gone.
  const gone = new Set([...s.removed].map((n) => n.toLowerCase()))
  for (const o of s.has('[Content_Types].xml') ? elements(s.doc('[Content_Types].xml'), NS.ct, 'Override') : []) {
    if (gone.has((o.getAttribute('PartName') ?? '').replace(/^\//, '').toLowerCase())) fail('a removed part is still listed')
  }
  for (const [name, before] of s.edited) {
    const doc = s.doc(name)
    const skip = /^xl\/comments\d*\.xml$/.test(name) ? (el: Element) => el.localName === 'authors' : undefined
    if (textOf(doc, skip) !== before) fail(`the text of ${name} would change`)
    s.changed.set(name, serializeXmlBytes(doc))
  }
  const list: OutEntry[] = []
  for (const e of pkg.entries) {
    if (s.removed.has(e.name)) continue
    const data = s.changed.get(e.name)
    list.push(data ? { name: e.name, data } : { name: e.name, from: e })
  }
  return { status: 'cleaned', bytes: writePackage(pkg, list), removed: [...s.labels], values: s.values }
}

/** Unzips every part, parses all XML, and checks nothing is left to remove. */
export async function checkPackage(bytes: Uint8Array): Promise<Package> {
  const pkg = openPackage(bytes)
  for (const e of pkg.entries) {
    const data = readEntry(pkg, e)
    if (/\.(xml|rels)$/i.test(e.name) && data.length) parseXmlBytes(data)
  }
  return pkg
}

export async function verify(bytes: Uint8Array, kind: Kind): Promise<void> {
  await checkPackage(bytes)
  const again = await strip(bytes, kind)
  if (again.status !== 'unchanged') fail('something is still left to remove')
}
