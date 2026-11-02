// SVG drawings: what drawing apps leave in them
// that isn't part of the picture, cut out by byte, so that everything else
// stays exactly as it was and draws the same:
//   - the <metadata> element's contents (title, author, rights, dates, Adobe's
//     XMP), and a <desc> that only names the app ("Created with Sketch.")
//   - comments ("Generator: Adobe Illustrator 27.0"), in the file and in its
//     style sheets
//   - every element and attribute in another app's namespace: Inkscape's and
//     Sodipodi's (the file's name, export paths, the version, window and layer
//     settings), Illustrator's (its whole editable copy of the artwork,
//     <i:pgf>), and any other app's; browsers draw none of them. Some apps'
//     own attributes in no namespace too: draw.io's copy of the diagram,
//     Illustrator's layer names (data-name), Inkscape's font names in styles
//   - processing instructions other than a style sheet's (XMP packets',
//     PlantUML's copy of its source), and links to files on the maker's own
//     computer, which no one else could open
//   - the hidden details of pictures embedded as data: addresses, wherever
//     they are (an <image>, HTML's <img>, a style's url()), which go through
//     the photo cleaners (embedded.ts), and of drawings embedded so
// The file is read by svgscan.ts, which leaves alone one it can't be sure of,
// as does this when a cut could change what's drawn (the review, 2026-10-26:
// a <style> or a shape a <use> repeats, inside what would go; a style sheet
// that picks elements by their place among others or by another app's names;
// a photo kept in the DTD): that one goes as it is, and the sender is told.
import { stripPicture } from './embedded.ts'
import { IN_PICTURES, LABEL } from './labels.ts'
import { describeOther } from './sniff.ts'
import { MATHML_NS, SVG_NS, SvgUnreadable, XHTML_NS, XLINK_NS, XMLNS_NS, XML_NS, scanSvg, startsAsSvg, toBase64, type SvgAttr, type SvgDoc, type SvgEl, type SvgHandler } from './svgscan.ts'
import { type FormatOutcome, type Found, SKIP, type Unchecked, fail } from './types.ts'
import { addFound, displayValue, formatExifDate } from './values.ts'

/** Larger drawings are left alone: the composer reads no bigger file of this kind. */
export const MAX_SVG = 25_000_000
/** Drawings embedded in drawings, at most, one in another. */
const MAX_NESTED = 3

// What a browser draws: SVG, and the HTML and MathML a <foreignObject> can hold. Attributes in no
// namespace, xml:space and xml:lang, and xlink:href.
const KEPT = new Set([SVG_NS, XHTML_NS, MATHML_NS])
const KEPT_ATTRS = new Set(['', XML_NS, XLINK_NS])

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'
const X_META = 'adobe:ns:meta/'
const DC = 'http://purl.org/dc/elements/1.1/'
const CC = new Set(['http://creativecommons.org/ns#', 'http://web.resource.org/cc/'])
const XMP = 'http://ns.adobe.com/xap/1.0/'
const XMP_MM = 'http://ns.adobe.com/xap/1.0/mm/'
const XMP_RIGHTS = 'http://ns.adobe.com/xap/1.0/rights/'
const PDF = 'http://ns.adobe.com/pdf/1.3/'
const PHOTOSHOP = 'http://ns.adobe.com/photoshop/1.0/'
const INKSCAPE = 'http://www.inkscape.org/namespaces/inkscape'
const SODIPODI = new Set(['http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd', 'http://inkscape.sourceforge.net/DTD/sodipodi-0.dtd'])
const ILLUSTRATOR = /^http:\/\/ns\.adobe\.com\/AdobeIllustrator\//

/** Labels whose values the sender is shown. */
const SHOWN = new Set<string>([LABEL.comments, LABEL.author, LABEL.company, LABEL.copyright, LABEL.title, LABEL.description, LABEL.keywords, LABEL.dates, LABEL.software, LABEL.savedPath])

const DC_LABELS: Record<string, string> = {
  creator: LABEL.author,
  contributor: LABEL.author,
  publisher: LABEL.company,
  rights: LABEL.copyright,
  title: LABEL.title,
  description: LABEL.description,
  subject: LABEL.keywords,
  date: LABEL.dates,
  identifier: LABEL.ids,
}

/**
 * What an element or attribute inside metadata holds, by its namespace and name: a label, or
 * undefined for RDF's and XMP's structure, which hold nothing themselves.
 */
function metaLabel(ns: string, local: string): string | undefined {
  if (ns === RDF || ns === X_META || ns === SVG_NS) return undefined
  if (ns === DC) return DC_LABELS[local] ?? LABEL.otherDoc
  if (CC.has(ns)) {
    if (local === 'Work' || local === 'Agent') return undefined
    return local === 'license' || local === 'License' ? LABEL.copyright : local === 'attributionName' ? LABEL.author : LABEL.otherDoc
  }
  if (ns === XMP) return local === 'CreatorTool' ? LABEL.software : /^(CreateDate|ModifyDate|MetadataDate)$/.test(local) ? LABEL.dates : local === 'Thumbnails' ? LABEL.thumbnail : LABEL.otherDoc
  if (ns === XMP_MM) return /^(DocumentID|InstanceID|OriginalDocumentID)$/.test(local) ? LABEL.ids : LABEL.history
  if (ns === XMP_RIGHTS) return LABEL.copyright
  if (ns === PDF) return { Producer: LABEL.software, Author: LABEL.author, Title: LABEL.title, Keywords: LABEL.keywords }[local] ?? LABEL.otherDoc
  if (ns === PHOTOSHOP) return { AuthorsPosition: LABEL.author, Credit: LABEL.copyright, Source: LABEL.copyright, DateCreated: LABEL.dates, Headline: LABEL.description }[local] ?? LABEL.otherDoc
  if (/^http:\/\/ns\.adobe\.com\/(illustrator|AdobeIllustrator|SaveForWeb)\//.test(ns)) return LABEL.appData
  return LABEL.otherDoc
}

// A comment or <desc> naming the app that wrote the file, and its lead-in, which isn't shown.
const GENERATOR = /^\s*(generator\s*:|creator\s*:|created with\s|produced by\s|generated by\s|exported (from|by|with)\s)\s*/i

// A link to a file on the maker's own computer, which no one else can open: its path can name them.
// An address of the computer's own (file:, a drive, a shared folder, a home or a disk's folder), or
// one that climbs out of the drawing's own folder. On an <a>, only one that can't be a website's.
const LOCAL_FILE = /^(file:|smb:|afp:|[a-z]:[\\/]|\\\\|~[\\/]|\/(Users|home|media|mnt|Volumes|run\/media|var\/folders|private|tmp|root)\/)|(^|[\\/])\.\.([\\/]|$)/i
const LOCAL_LINK = /^(file:|smb:|afp:|[a-z]:[\\/]|\\\\|~[\\/])/i

// Elements that load what they link to, and the attributes that hold the link.
const LOADS = new Set(['image', 'feImage', 'use', 'script', 'img', 'video', 'audio', 'source', 'iframe', 'object', 'embed', 'link', 'track', 'input'])
const LINK_ATTRS = new Set(['href', 'src', 'poster', 'data'])

// Parents whose white space between children never shows: a line left empty by a cut goes with it.
const CONTAINERS = new Set(['svg', 'g', 'defs', 'symbol', 'switch', 'clipPath', 'mask', 'pattern', 'marker', 'linearGradient', 'radialGradient', 'filter'])

// Attributes in no namespace that only some app reads, and what's in them.
const APP_ATTRS: Record<string, string> = { 'data-name': LABEL.appData, d2Version: LABEL.software }

const isSpace = (c: number) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x0c

/** from..to of s without the white space at either end, found by looking, not by a pattern that could go back over it. */
function trimmed(s: string, from = 0, to = s.length): [number, number] {
  while (from < to && isSpace(s.charCodeAt(from))) from++
  while (to > from && isSpace(s.charCodeAt(to - 1))) to--
  return [from, to]
}

/** from..to widened to the whole line when nothing else is on it (only spaces and tabs around it). */
function wholeLine(s: string, from: number, to: number): [number, number] {
  let a = from
  while (a > 0 && (s.charCodeAt(a - 1) === 0x20 || s.charCodeAt(a - 1) === 0x09)) a--
  if (a > 0 && s.charCodeAt(a - 1) !== 0x0a && s.charCodeAt(a - 1) !== 0x0d) return [from, to]
  let z = to
  while (z < s.length && (s.charCodeAt(z) === 0x20 || s.charCodeAt(z) === 0x09)) z++
  if (z === s.length) return [a, z]
  if (s.charCodeAt(z) === 0x0d && s.charCodeAt(z + 1) === 0x0a) return [a, z + 2]
  if (s.charCodeAt(z) === 0x0a || s.charCodeAt(z) === 0x0d) return [a, z + 1]
  return [from, to]
}

/** A data: address's base64, read as a browser reads it (white space ignored); throws if it isn't base64. */
export function fromBase64(text: string): Uint8Array {
  const plain = text.includes('%') ? text.replace(/%([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))) : text
  const bin = atob(plain)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** A data: address read: its type and options, whether it's base64, its bytes, and any #fragment; null if it isn't one, or can't be read. */
function readData(url: string): { head: string; base64: boolean; bytes: Uint8Array; fragment: string } | null {
  if (!/^data:/i.test(url)) return null
  const comma = url.indexOf(',')
  if (comma < 0) return null
  const head = url.slice(0, comma + 1)
  const hash = url.indexOf('#', comma)
  const body = url.slice(comma + 1, hash < 0 ? url.length : hash)
  const base64 = /;\s*base64\s*,$/i.test(head)
  try {
    if (base64) return { head, base64, bytes: fromBase64(body), fragment: hash < 0 ? '' : url.slice(hash) }
    // Percent-encoded text, as a drawing often is: its bytes, each %xx one byte.
    const raw = new TextEncoder().encode(body)
    const out = new Uint8Array(raw.length)
    let n = 0
    for (let i = 0; i < raw.length; i++) {
      const hex = raw[i] === 0x25 ? String.fromCharCode(raw[i + 1] ?? 0, raw[i + 2] ?? 0) : ''
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        out[n++] = parseInt(hex, 16)
        i += 2
      } else out[n++] = raw[i]
    }
    return { head, base64, bytes: out.subarray(0, n), fragment: hash < 0 ? '' : url.slice(hash) }
  } catch {
    return null
  }
}

/**
 * The data: addresses in some text, by where each starts and ends: the whole of it (trimmed) for an
 * attribute that is an address, or each one in it (a style's url(…), a srcset's list). One that runs to
 * the end of a style sheet's piece may go on past it, so it's marked as not whole.
 */
function dataSpans(s: string, whole: boolean): { from: number; to: number; ends: boolean }[] {
  if (whole) {
    const [from, to] = trimmed(s)
    return /^data:/i.test(s.slice(from, from + 5)) ? [{ from, to, ends: true }] : []
  }
  const out: { from: number; to: number; ends: boolean }[] = []
  const lower = s.length > 5 && /data:/i.test(s) ? s.toLowerCase() : ''
  for (let at = lower.indexOf('data:'); at >= 0; at = lower.indexOf('data:', at + 5)) {
    const quote = at > 0 ? s.charCodeAt(at - 1) : 0
    const comma = s.indexOf(',', at)
    if (comma < 0) break
    let end = comma + 1
    if (quote === 0x22 || quote === 0x27) {
      const q = s.indexOf(quote === 0x22 ? '"' : "'", end)
      end = q < 0 ? s.length : q
    } else while (end < s.length && !/[)\s,'"]/.test(s[end])) end++
    out.push({ from: at, to: end, ends: end < s.length })
    at = end - 5
  }
  return out
}

/** The ids a value points to: #id as a whole, or url(#id) in it. */
function pointsTo(value: string, whole: boolean): string[] {
  if (whole) {
    const [a, b] = trimmed(value)
    return value.charCodeAt(a) === 0x23 ? [value.slice(a + 1, b)] : []
  }
  return value.includes('url(') ? [...value.matchAll(/url\(\s*['"]?\s*#([^'")\s]+)/g)].map((m) => m[1]) : []
}

/** A style sheet's selectors (what's outside its braces), without its comments. */
function selectorsOf(css: string): string {
  let out = ''
  let depth = 0
  for (let i = 0; i < css.length; i++) {
    if (css.startsWith('/*', i)) {
      const e = css.indexOf('*/', i + 2)
      if (e < 0) break
      i = e + 1
      continue
    }
    const c = css[i]
    if (c === '{') depth++
    else if (c === '}') depth = Math.max(0, depth - 1)
    else if (!depth) out += c
  }
  return out
}

/** A style sheet's comments, by where each one's text starts and ends (strings passed over). */
function cssComments(s: string): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = []
  let quote = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (quote) {
      if (c === 0x5c) i++
      else if (c === quote) quote = 0
    } else if (c === 0x22 || c === 0x27) quote = c
    else if (c === 0x2f && s.charCodeAt(i + 1) === 0x2a) {
      const e = s.indexOf('*/', i + 2)
      if (e < 0) break
      out.push({ from: i + 2, to: e })
      i = e + 1
    }
  }
  return out
}

interface Cut {
  from: number
  to: number
  /** What goes in its place, if anything. */
  with?: string | Uint8Array
  /** Left in place after all if a selector names this (it may pick elements by it); and what it held, listed only if it goes. */
  unless?: string
  held?: [string, string]
}

interface Embedded {
  /** Where the address is in the file, and the address as a browser reads it. */
  from: number
  to: number
  url: string
}

interface Frame {
  label: string | undefined
  text: string
}

/** What the scan finds to cut, and what it held. */
class Cleaner implements SvgHandler {
  doc!: SvgDoc
  cuts: Cut[] = []
  /** What was found under each label: its values (raw, '' for none to show). */
  found = new Map<string, string[]>()
  embedded: Embedded[] = []
  /** Something it can't be sure of cutting without changing the drawing: the file goes as it is. */
  unsure = false
  /** Ids inside what goes, and those pointed to from what stays: one in both means something drawn would go. */
  goneIds = new Set<string>()
  usedIds = new Set<string>()
  /** The style sheets' text; titles and descriptions that stay. */
  css = ''
  kept = new Set<string>()
  /** Elements that go, which a style sheet picking elements by their place would miss: given a stand-in then. */
  private gone: { el: SvgEl; cut: number }[] = []
  private root: SvgEl | undefined
  /** The element being cut, while inside it; and while it's metadata, what its elements hold. */
  private removing: SvgEl | undefined
  private meta: Frame[] | undefined
  /** A <title> or <desc>, while inside it: its text. */
  private texty: { el: SvgEl; text: string; desc: boolean } | undefined
  private styles = 0 // style elements open, that stay

  begin(doc: SvgDoc) {
    this.doc = doc
  }

  label(label: string, raw = '') {
    const list = this.found.get(label)
    if (list) list.push(raw)
    else this.found.set(label, [raw])
  }

  private cut(from: number, to: number, parent: SvgEl | undefined, extra: Partial<Cut> = {}) {
    if (!parent || (parent.ns === SVG_NS && CONTAINERS.has(parent.local))) [from, to] = wholeLine(this.doc.text, from, to)
    this.cuts.push({ from, to, ...extra })
  }

  private cutAttr(a: SvgAttr, unless?: string, held?: [string, string]) {
    this.cuts.push({ from: a.from, to: a.valueEnd + 1, unless, held })
  }

  /** The element as a stand-in: its name and namespace declarations, nothing else, so the elements around it keep their places. */
  private shell(el: SvgEl): string {
    const decls = el.attrs.filter((a) => a.ns === XMLNS_NS).map((a) => this.doc.text.slice(a.from, a.valueEnd + 1))
    return `<${el.qname}${decls.join('')}/>`
  }

  open(el: SvgEl) {
    if (this.removing) {
      const id = el.attrs.find((a) => a.ns === '' && a.local === 'id')
      if (id) this.goneIds.add(this.doc.value(id))
      // A style sheet applies wherever it is, even inside what goes.
      if (el.local === 'style' && KEPT.has(el.ns)) this.unsure = true
      if (this.meta) this.metaOpen(el)
      return
    }
    this.root ??= el
    if (!KEPT.has(el.ns) || (el.ns === SVG_NS && el.local === 'metadata')) {
      this.removing = el
      const id = el.attrs.find((a) => a.ns === '' && a.local === 'id')
      if (id) this.goneIds.add(this.doc.value(id))
      // Metadata (SVG's own element, or RDF or XMP on their own) is read for what it says; another app's data isn't.
      if (el.ns === SVG_NS || el.ns === RDF || el.ns === X_META) {
        this.meta = []
        this.metaOpen(el)
      } else this.label(ILLUSTRATOR.test(el.ns) && el.local === 'pgf' ? LABEL.editable : LABEL.appData)
      return
    }
    if (el.ns === SVG_NS && (el.local === 'title' || el.local === 'desc')) this.texty = { el, text: '', desc: el.local === 'desc' }
    if (el.local === 'style') this.styles++
    for (const a of el.attrs) this.attr(el, a)
  }

  private attr(el: SvgEl, a: SvgAttr) {
    if (a.ns === XMLNS_NS) {
      // A namespace whose elements and attributes all go: nothing left can use its declaration.
      if (a.local !== 'xmlns' && !KEPT.has(a.uri!) && !KEPT_ATTRS.has(a.uri!)) this.cutAttr(a)
      return
    }
    if (!KEPT_ATTRS.has(a.ns)) {
      this.cutAttr(a)
      if ((SODIPODI.has(a.ns) && /^(docname|docbase|absref)$/.test(a.local)) || (a.ns === INKSCAPE && a.local === 'export-filename')) this.label(LABEL.savedPath, this.doc.value(a))
      else if (a.ns === INKSCAPE && a.local === 'version') this.label(LABEL.software, `Inkscape ${this.doc.value(a)}`)
      else this.label(LABEL.appData)
      return
    }
    const name = a.ns === XML_NS ? `xml:${a.local}` : a.local
    if (a.ns === '' && el === this.root && a.local === 'content' && /^\s*<mxfile[\s>]/.test(this.doc.value(a))) {
      this.cutAttr(a, 'content', [LABEL.editable, ''])
      return
    }
    if (a.ns === '' && Object.hasOwn(APP_ATTRS, a.local)) {
      this.cutAttr(a, a.local, [APP_ATTRS[a.local], a.local === 'd2Version' ? `D2 ${this.doc.value(a)}` : ''])
      return
    }
    const link = (LINK_ATTRS.has(a.local) && (a.ns === '' || a.ns === XLINK_NS)) || name === 'xml:base'
    const value = a.raw.includes('&') || a.raw.includes('url(') || a.raw.includes('#') || /data:/i.test(a.raw) || link ? this.doc.value(a) : ''
    if (link) {
      const [from, to] = trimmed(value)
      const target = value.slice(from, Math.min(to, from + 512))
      const loads = name === 'xml:base' || LOADS.has(el.local)
      if (loads ? LOCAL_FILE.test(target) && !/^(https?:|data:|#)/i.test(target) : LOCAL_LINK.test(target)) {
        this.cutAttr(a)
        let shown = value.slice(from, to)
        try {
          shown = decodeURI(shown)
        } catch {
          // shown as written
        }
        this.label(LABEL.savedPath, shown)
        return
      }
    }
    for (const id of pointsTo(value, link)) this.usedIds.add(id)
    // Inkscape's font names in a style, read by no one else.
    if (a.ns === '' && a.local === 'style' && a.raw.includes('-inkscape-')) {
      for (const m of a.raw.matchAll(/(^|;)\s*-inkscape-[\w-]{1,64}\s*:[^;]{0,1024}/g)) this.cuts.push({ from: a.valueStart + m.index + m[1].length, to: a.valueStart + m.index + m[0].length })
      this.label(LABEL.appData)
    }
    // Pictures and drawings embedded in it, where the file says them as they're read.
    if (!/data:/i.test(a.raw)) return
    for (const span of dataSpans(a.raw, link)) {
      const raw = a.raw.slice(span.from, span.to)
      this.embedded.push({ from: a.valueStart + span.from, to: a.valueStart + span.to, url: raw.includes('&') ? this.doc.resolve(this.doc.decode(a.valueStart + span.from, a.valueStart + span.to)) : raw })
    }
  }

  close(el: SvgEl, end: number) {
    if (this.texty?.el === el) {
      const { text, desc } = this.texty
      this.texty = undefined
      const app = desc ? GENERATOR.exec(text) : null
      if (app && text.length < 200) {
        // A description that only names the app: emptied, so the elements around it keep their places.
        this.cuts.push({ from: el.start, to: end, with: this.shell(el) })
        this.label(LABEL.software, text.slice(app[0].length))
      } else this.kept.add(displayValue(text))
    }
    if (el.local === 'style' && !this.removing) this.styles--
    if (!this.removing) return
    if (this.meta) this.metaClose()
    if (el !== this.removing) return
    this.removing = this.meta = undefined
    // SVG's metadata is emptied, as a stand-in for itself: a <switch> picks it, drawing nothing, as before.
    if (el.ns === SVG_NS && el.local === 'metadata') this.cuts.push({ from: el.start, to: end, with: this.shell(el) })
    else {
      this.gone.push({ el, cut: this.cuts.length })
      this.cut(el.start, end, el.parent)
    }
  }

  comment(start: number, end: number, parent: SvgEl | undefined) {
    const text = this.doc.decode(start + 4, end - 3)
    if (this.removing) {
      // Excalidraw keeps its whole scene in comments inside its metadata.
      if (this.meta && /payload-type:application\/vnd\.excalidraw/.test(text)) this.label(LABEL.editable)
      return
    }
    const app = GENERATOR.exec(text)
    if (app) this.label(LABEL.software, text.slice(app[0].length))
    else this.label(LABEL.comments, text)
    this.cut(start, end, parent)
  }

  pi(target: string, start: number, end: number, parent: SvgEl | undefined) {
    if (this.removing) return
    // A style sheet's instruction is kept, unless it links to a file on the maker's computer (which never loads).
    if (target === 'xml-stylesheet') {
      const href = /\shref\s*=\s*(?:"([^"]{0,2048})"|'([^']{0,2048})')/.exec(this.doc.decode(start, end))
      const link = href ? this.doc.resolve(href[1] ?? href[2]).trim() : ''
      if (!LOCAL_FILE.test(link) || /^(https?:|data:|#)/i.test(link)) return
      this.label(LABEL.savedPath, link)
    } else if (target !== 'xpacket' && target !== 'adobe-xap-filters') this.label(target === 'plantuml-src' ? LABEL.editable : LABEL.appData)
    this.cut(start, end, parent)
  }

  text(from: number, to: number) {
    if (this.meta) this.metaText(this.doc.resolve(this.doc.decode(from, to)))
    else if (this.texty && !this.removing) this.texty.text += this.doc.resolve(this.doc.decode(from, to)).slice(0, 2048)
    if (this.styles && !this.removing) this.styleText(from, to, true)
  }

  cdata(from: number, to: number) {
    if (this.meta) this.metaText(this.doc.decode(from, to))
    else if (this.texty && !this.removing) this.texty.text += this.doc.decode(from, to).slice(0, 2048)
    if (this.styles && !this.removing) this.styleText(from, to, false)
  }

  /** A piece of a style sheet that stays: its comments emptied, what it points to, and the pictures it embeds. */
  private styleText(from: number, to: number, refs: boolean) {
    const raw = this.doc.text.slice(from, to)
    const css = refs && raw.includes('&') ? this.doc.resolve(this.doc.decode(from, to)) : this.doc.decode(from, to)
    this.css += css
    for (const id of pointsTo(css, false)) this.usedIds.add(id)
    // A comment's text goes and its /**/ stays: taking it all out could join what's either side.
    for (const c of cssComments(raw)) {
      if (c.to === c.from) continue
      this.cuts.push({ from: from + c.from, to: from + c.to })
      this.label(LABEL.comments, this.doc.decode(from + c.from, from + c.to))
    }
    for (const span of dataSpans(raw, false)) {
      // One that may go on past this piece can't be read whole.
      if (!span.ends) this.unsure = true
      const url = raw.slice(span.from, span.to)
      this.embedded.push({ from: from + span.from, to: from + span.to, url: refs && url.includes('&') ? this.doc.resolve(url) : url })
    }
  }

  // Inside metadata, a property's label goes to all it holds ("dc:creator > cc:Agent > dc:title" is
  // an author's name, not a title), and it's listed only for what it holds: an empty one isn't.
  private metaOpen(el: SvgEl) {
    const meta = this.meta!
    const up = meta[meta.length - 1]?.label
    const own = metaLabel(el.ns, el.local)
    const label = up ?? own
    for (const a of el.attrs) {
      if (a.ns === XMLNS_NS || a.ns === XML_NS || a.ns === X_META || a.ns === '') continue
      const value = this.doc.value(a)
      if (!/\S/.test(value)) continue
      // A licence's address, written as a resource.
      if (a.ns === RDF) {
        if ((a.local === 'resource' || a.local === 'about') && !up && own) this.label(own, value)
        continue
      }
      // XMP's short form: properties as attributes.
      const l = label ?? metaLabel(a.ns, a.local)
      if (l) this.label(l, value)
    }
    meta.push({ label, text: '' })
  }

  private metaText(t: string) {
    const top = this.meta![this.meta!.length - 1]
    if (top && top.text.length < 2048) top.text += t.slice(0, 2048)
  }

  private metaClose() {
    const f = this.meta!.pop()!
    if (!/\S/.test(f.text)) return
    this.label(f.label ?? LABEL.otherDoc, f.text)
  }

  /** Once it's all read: whether anything that goes could change what's drawn, and the stand-ins a style sheet needs. */
  finish() {
    for (const id of this.usedIds) if (this.goneIds.has(id)) this.unsure = true
    const selectors = selectorsOf(this.css)
    // Elements picked by another app's names, or by their place among others ("rect:first-child").
    if (this.css.includes('@namespace') || /\|(?!=)/.test(selectors)) this.unsure = true
    if (/[+~]|:(nth-|first-|last-|only-|empty|has\()/i.test(selectors))
      for (const { el, cut } of this.gone) {
        // Another app's element in a <switch> can't be given a stand-in SVG would pick.
        if (el.parent?.ns === SVG_NS && el.parent.local === 'switch') this.unsure = true
        this.cuts[cut].with = '<metadata/>'
      }
    // An attribute a selector names ([data-name="…"]) stays.
    this.cuts = this.cuts.filter((c) => !c.unless || !selectors.includes(c.unless))
    for (const c of this.cuts) if (c.held) this.label(...c.held)
    // A DTD's entity holding a picture or a link, which this can't clean where it's said.
    for (const v of this.doc.entities.values()) if (/data:/i.test(v) || LOCAL_FILE.test(v.trim())) this.unsure = true
  }
}

interface Cleaned {
  bytes: Uint8Array
  removed: string[]
  values: Found[]
  unchecked: Unchecked
}

/** The drawing without what isn't part of it, and what that was; null if it can't be read, or cleaned for sure. Throws for a picture inside that can't be cleaned. */
async function clean(bytes: Uint8Array, depth: number): Promise<Cleaned | null> {
  const c = new Cleaner()
  try {
    scanSvg(bytes, c)
  } catch (err) {
    if (err instanceof SvgUnreadable) return null
    throw err
  }
  c.finish()
  if (c.unsure) return null
  const unchecked: Unchecked = {}
  for (const e of c.embedded) {
    const data = readData(e.url)
    if (!data || !data.bytes.length) continue // not one a browser could read either
    let out: { bytes: Uint8Array; removed: string[]; values: Found[] } | null
    // A drawing, by its type or its bytes.
    if (/^data:\s*image\/svg\+xml/i.test(data.head) || startsAsSvg(data.bytes)) {
      if (depth >= MAX_NESTED) fail('drawings nested too deeply')
      const inner = await clean(data.bytes, depth + 1)
      if (!inner) fail('a drawing inside can’t be read')
      for (const [k, n] of Object.entries(inner!.unchecked)) unchecked[k] = (unchecked[k] ?? 0) + n
      out = { bytes: inner!.bytes, removed: inner!.removed.map(inPictures), values: inner!.values.map((v) => ({ label: inPictures(v.label), value: v.value })) }
    } else {
      out = await stripPicture(data.bytes)
      // A picture of a kind no cleaner reads (TIFF, BMP): it goes as it is, and the sender is told.
      const kind = out ? null : describeOther(data.bytes)
      if (kind === 'tiff' || kind === 'bmp') unchecked[kind] = (unchecked[kind] ?? 0) + 1
    }
    if (!out?.removed.length) continue
    for (const l of out.removed) c.label(l)
    for (const v of out.values) c.label(v.label, v.value)
    // Percent-encoded, it goes as base64: the same picture.
    const head = data.base64 ? data.head : `${data.head.slice(0, -1)};base64,`
    c.cuts.push({ from: e.from, to: e.to, with: head + toBase64(out.bytes) + data.fragment })
  }
  // A title or description that stays isn't listed as gone, nor its label if nothing else went under it.
  const removed: string[] = []
  const values: Found[] = []
  for (const [label, list] of c.found) {
    const shown = SHOWN.has(label) ? list.filter((v) => !c.kept.has(displayValue(v))) : list
    if (SHOWN.has(label) && !shown.length) continue
    removed.push(label)
    // Values only for what's worth reading (not IDs or editing steps); a picture's cleaner chose its own.
    if (SHOWN.has(label) || label.endsWith(IN_PICTURES)) for (const v of shown) if (v) addFound(values, label, label === LABEL.dates ? formatExifDate(v) || v : v)
  }
  if (!removed.length) return { bytes, removed: [], values: [], unchecked }
  c.cuts.sort((a, b) => a.from - b.from || b.to - a.to)
  const parts: Uint8Array[] = []
  let at = 0
  for (const cut of c.cuts) {
    if (cut.from < at) {
      // A cut inside one already made (a style's font name in an element that went) goes with it.
      if (cut.to <= at && !cut.with) continue
      fail('two cuts overlap')
    }
    parts.push(bytes.subarray(at, cut.from))
    if (cut.with) parts.push(typeof cut.with === 'string' ? new TextEncoder().encode(cut.with) : cut.with)
    at = cut.to
  }
  parts.push(bytes.subarray(at))
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let i = 0
  for (const p of parts) {
    out.set(p, i)
    i += p.length
  }
  return { bytes: out, removed, values, unchecked }
}

const inPictures = (label: string) => (label.endsWith(IN_PICTURES) ? label : label + IN_PICTURES)

export async function strip(bytes: Uint8Array): Promise<FormatOutcome> {
  if (bytes.length > MAX_SVG) return { status: 'skipped', reason: SKIP.tooLarge }
  const out = await clean(bytes, 0)
  if (!out) return { status: 'unsupported' }
  const unchecked = Object.keys(out.unchecked).length ? { unchecked: out.unchecked } : {}
  if (!out.removed.length) return { status: 'unchanged', ...unchecked }
  return { status: 'cleaned', bytes: out.bytes, removed: out.removed, values: out.values, ...unchecked }
}

/** Reads the cleaned drawing again: it must read, and have nothing left to remove. */
export async function verify(bytes: Uint8Array): Promise<void> {
  const again = await clean(bytes, 0)
  if (!again) fail('the cleaned drawing can’t be read')
  if (again.removed.length) fail('something is still left to remove')
}
