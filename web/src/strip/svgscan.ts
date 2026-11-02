// A strict reader for SVG drawings, shared by the
// cleaner (svg.ts) and the previews (ui/svgPicture.ts). It goes through a file
// once, from the start, telling its handler where each element, comment,
// processing instruction and run of text begins and ends, by byte, so the
// cleaner can cut parts out and leave every other byte as it was.
//
// Unlike docview/xmlscan.ts it's strict: a file it can't be sure it reads as a
// browser does throws SvgUnreadable, and the file then goes as it is. That's
// one that isn't well-formed XML, or isn't a drawing (its first element isn't
// <svg> in SVG's namespace), or is in an encoding that isn't UTF-8 or one byte
// per character (where "<" and quotes might be part of another character), or
// whose DTD does more than name plain text (Illustrator names its namespaces
// that way). Entities are never expanded inside one another, and nothing is
// ever fetched. Linear: every search starts where the last one ended, and no
// regular expression can go back over what it has read.

export const SVG_NS = 'http://www.w3.org/2000/svg'
export const XLINK_NS = 'http://www.w3.org/1999/xlink'
export const XHTML_NS = 'http://www.w3.org/1999/xhtml'
export const MATHML_NS = 'http://www.w3.org/1998/Math/MathML'
export const XML_NS = 'http://www.w3.org/XML/1998/namespace'
export const XMLNS_NS = 'http://www.w3.org/2000/xmlns/'

/** A file this reader isn't sure of: not well-formed, not a drawing, or written in a way it doesn't read. */
export class SvgUnreadable extends Error {}

const unreadable = (why: string): never => {
  throw new SvgUnreadable(why)
}

export interface SvgAttr {
  qname: string
  /** Its namespace: '' for none, XMLNS_NS for a namespace declaration (whose local name is its prefix, or 'xmlns'). */
  ns: string
  local: string
  /** Where the white space before it starts: cutting from here to valueEnd + 1 takes it out cleanly. */
  from: number
  start: number
  valueStart: number
  /** The closing quote's index. */
  valueEnd: number
  /** The value as written, references unread, one character per byte. */
  raw: string
  /** A namespace declaration's namespace, its references read. */
  uri?: string
}

export interface SvgEl {
  qname: string
  ns: string
  local: string
  attrs: SvgAttr[]
  /** The index of its "<". */
  start: number
  /** Just past its start tag's ">". */
  tagEnd: number
  /** Just past its name: where an attribute could be added. */
  nameEnd: number
  empty: boolean
  parent: SvgEl | undefined
  /** Prefixes it declared, with what they meant outside it, put back as it closes. */
  outer?: [string, string | undefined][]
}

export interface SvgHandler {
  /** Called once, before anything else, with the file as it's being read. */
  begin?(doc: SvgDoc): void
  open?(el: SvgEl): void
  /** end: just past its end tag (or its start tag, for an empty one). */
  close?(el: SvgEl, end: number): void
  /** Character data as written, from and to by byte (references unread). */
  text?(from: number, to: number, parent: SvgEl): void
  /** A CDATA section's contents, from and to by byte. */
  cdata?(from: number, to: number, parent: SvgEl): void
  /** A comment, from its "<!--" to just past its "-->"; parent is undefined outside the drawing. */
  comment?(start: number, end: number, parent: SvgEl | undefined): void
  /** A processing instruction other than the XML declaration. */
  pi?(target: string, start: number, end: number, parent: SvgEl | undefined): void
}

export interface ScanLimits {
  /** Elements at most; more throws SvgUnreadable. */
  elements?: number
}

/** Elements open at once, at most. Browsers stop far sooner. */
const MAX_DEPTH = 1024
/** Namespace declarations in a file, at most. */
const MAX_NS = 4096
/** Entities a DTD may name, at most. */
const MAX_ENTITIES = 1024
/**
 * Characters the file's entities may stand for, all told: one long entity used thousands of times
 * made a 72 KB file read as hundreds of megabytes, enough to crash a tab (the review). Browsers
 * stop such files too.
 */
const MAX_EXPANSION = 1_000_000
/** A namespace's name, at most this long. */
const MAX_NS_LENGTH = 2048

const PREDEFINED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }

// Encodings in which every byte below 0x80 is that ASCII character, as WHATWG names them: in those, a "<"
// or a quote byte is always one. Not Shift_JIS, GBK, Big5, EUC or ISO-2022, whose characters can contain
// such bytes, nor UTF-16.
const SINGLE_BYTE = /^(ibm866|iso-8859-([2-8]|1[0-6])|koi8-[ru]|macintosh|windows-(874|125[0-8])|x-mac-cyrillic)$/

const isSpace = (c: number) => c === 0x20 || c === 0x0a || c === 0x09 || c === 0x0d
const isNameStart = (c: number) => (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || c === 0x5f || c === 0x3a || c >= 0x80
const isNameChar = (c: number) => isNameStart(c) || (c >= 0x30 && c <= 0x39) || c === 0x2d || c === 0x2e

/** The bytes as a string of one character per byte (each byte's place is its index). */
function binary(bytes: Uint8Array): string {
  const s = new TextDecoder('latin1').decode(bytes)
  // windows-1252, which "latin1" means, gives every byte one character of its own.
  if (s.length !== bytes.length) unreadable('the bytes could not be read one by one')
  return s
}

/** Whether the bytes are well-formed UTF-8 (no overlong forms, surrogates or values past U+10FFFF), without copying them. */
export function isUtf8(b: Uint8Array): boolean {
  const n = b.length
  for (let i = 0; i < n; ) {
    const c = b[i]
    if (c < 0x80) {
      i++
      continue
    }
    let need: number
    let min: number
    if (c >= 0xc2 && c <= 0xdf) {
      need = 1
      min = 0x80
    } else if (c >= 0xe0 && c <= 0xef) {
      need = 2
      min = 0x800
    } else if (c >= 0xf0 && c <= 0xf4) {
      need = 3
      min = 0x10000
    } else return false
    let cp = c & (need === 1 ? 0x1f : need === 2 ? 0x0f : 0x07)
    for (let k = 1; k <= need; k++) {
      const d = b[i + k]
      if (d === undefined || (d & 0xc0) !== 0x80) return false
      cp = (cp << 6) | (d & 0x3f)
    }
    if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return false
    i += need + 1
  }
  return true
}

/** Bytes as base64, for a data: address. */
export function toBase64(b: Uint8Array): string {
  let s = ''
  for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192))
  return btoa(s)
}

/** A name with at most one colon, not at either end, as namespaces need. */
function checkQName(q: string) {
  const c = q.indexOf(':')
  if (c === 0 || c === q.length - 1 || (c > 0 && q.indexOf(':', c + 1) !== -1)) unreadable(`a name namespaces can't read: ${q.slice(0, 40)}`)
}

/** A read file: its bytes as one character per byte, its encoding, and the plain-text entities its DTD names. */
export class SvgDoc {
  readonly bytes: Uint8Array
  readonly text: string
  readonly encoding: string
  readonly entities: Map<string, string>
  readonly decoder: TextDecoder
  constructor(bytes: Uint8Array, text: string, encoding: string, entities: Map<string, string>) {
    this.bytes = bytes
    this.text = text
    this.encoding = encoding
    this.entities = entities
    this.decoder = new TextDecoder(encoding)
  }

  /** The text from and to these bytes, decoded (references unread). */
  decode(from: number, to: number): string {
    return this.decoder.decode(this.bytes.subarray(from, to))
  }

  /** Text as a browser reads it: XML's five entities, character references and the DTD's entities read. */
  resolve(s: string): string {
    if (!s.includes('&')) return s
    return s.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[^&;\s]{1,64});/g, (m, ref: string) => {
      if (ref[0] !== '#') return (Object.hasOwn(PREDEFINED, ref) ? PREDEFINED[ref] : this.entities.get(ref)) ?? m
      const cp = ref[1] === 'x' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10)
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m
    })
  }

  /** An attribute's value as a browser reads it. */
  value(a: SvgAttr): string {
    // Plain ASCII without references, as most values are, reads as it's written.
    return /[&\u0080-\uffff]/.test(a.raw) ? this.resolve(this.decode(a.valueStart, a.valueEnd)) : a.raw
  }
}

/**
 * Checks the references in text or a value: each one XML's own, a character, or one the DTD names,
 * and all the DTD's together standing for no more than MAX_EXPANSION characters (budget.left).
 */
function checkRefs(s: string, entities: Map<string, string>, budget: { left: number }) {
  for (let a = s.indexOf('&'); a !== -1; a = s.indexOf('&', a + 1)) {
    // Looked for nearby only: a run of "&" without a ";" mustn't be searched to its end each time.
    const semi = s.slice(a + 1, a + 66).indexOf(';')
    if (semi < 1) unreadable('an & that starts no reference')
    const ref = s.slice(a + 1, a + 1 + semi)
    if (ref[0] === '#') {
      const m = /^#(?:x([0-9a-fA-F]{1,6})|([0-9]{1,7}))$/.exec(ref)
      const cp = m ? (m[1] !== undefined ? parseInt(m[1], 16) : parseInt(m[2], 10)) : -1
      // Only the characters XML allows: no NUL or other control characters, surrogates or U+FFFE/U+FFFF.
      const ok = cp === 0x9 || cp === 0xa || cp === 0xd || (cp >= 0x20 && cp <= 0xd7ff) || (cp >= 0xe000 && cp <= 0xfffd) || (cp >= 0x10000 && cp <= 0x10ffff)
      if (!ok) unreadable('a character reference XML refuses')
    } else if (!Object.hasOwn(PREDEFINED, ref)) {
      const value = entities.get(ref)
      if (value === undefined) unreadable(`an entity the file doesn't name: ${ref.slice(0, 40)}`)
      if ((budget.left -= value!.length) < 0) unreadable('entities that stand for too much text')
    }
  }
}

/**
 * Reads the whole file, telling handler what's in it, and returns it read. Throws SvgUnreadable for a
 * file it can't be sure of (see the top of this file).
 */
export function scanSvg(bytes: Uint8Array, h: SvgHandler = {}, limits: ScanLimits = {}): SvgDoc {
  const n = bytes.length
  if ((bytes[0] === 0xfe && bytes[1] === 0xff) || (bytes[0] === 0xff && bytes[1] === 0xfe)) unreadable('UTF-16')
  // Control characters (and the NULs of UTF-16 without its mark) are never allowed in XML.
  for (let k = 0; k < n; k++) {
    const c = bytes[k]
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) unreadable('a control character')
  }
  const s = binary(bytes)
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
  let i = bom ? 3 : 0

  // The XML declaration, if any, comes first: its version and encoding.
  let encoding = 'utf-8'
  if (s.startsWith('<?xml', i) && isSpace(s.charCodeAt(i + 5))) {
    const end = s.indexOf('?>', i)
    if (end < 0) unreadable('an unfinished XML declaration')
    const decl = s.slice(i, end)
    if (!/^<\?xml\s+version\s*=\s*(["'])1\.0\1/.test(decl)) unreadable('not XML 1.0')
    const m = /\sencoding\s*=\s*(?:"([A-Za-z][A-Za-z0-9._-]{0,39})"|'([A-Za-z][A-Za-z0-9._-]{0,39})')/.exec(decl)
    if (m) {
      try {
        encoding = new TextDecoder(m[1] ?? m[2]).encoding
      } catch {
        unreadable('an unknown encoding')
      }
    }
    i = end + 2
  }
  if (encoding === 'utf-8' ? !isUtf8(bytes) : bom || !SINGLE_BYTE.test(encoding)) unreadable(`not readable as ${encoding}`)

  const entities = new Map<string, string>()
  const budget = { left: MAX_EXPANSION }
  const doc = new SvgDoc(bytes, s, encoding, entities)
  h.begin?.(doc)
  const scope = new Map<string, string>([['xml', XML_NS]])
  const stack: SvgEl[] = []
  let root = false // its first element has opened
  let done = false // and closed
  let doctype = false
  let elements = 0
  let declared = 0
  const maxElements = limits.elements ?? Infinity

  const comment = (at: number, parent: SvgEl | undefined): number => {
    // "--" is allowed only as the comment's end.
    const dd = s.indexOf('--', at + 4)
    if (dd < 0 || s.charCodeAt(dd + 2) !== 0x3e) unreadable('a comment that never ends, or has "--" in it')
    h.comment?.(at, dd + 3, parent)
    return dd + 3
  }

  const quoted = (at: number): number => {
    const q = s.charCodeAt(at)
    const end = s.indexOf(q === 0x22 ? '"' : "'", at + 1)
    if (end < 0) unreadable('an unfinished quote')
    return end
  }

  // <!ENTITY name "plain text"> only: a parameter entity ("%", not a name), one fetched from elsewhere, or
  // one holding markup or other references could make the file read differently from how this reader sees it.
  const entityDecl = (at: number): number => {
    let k = at
    while (isSpace(s.charCodeAt(k))) k++
    if (!isNameStart(s.charCodeAt(k))) unreadable('a DTD entity this reader leaves alone')
    const start = k
    while (k < n && isNameChar(s.charCodeAt(k))) k++
    const name = s.slice(start, k)
    if (!isSpace(s.charCodeAt(k))) unreadable('a DTD entity this reader leaves alone')
    while (isSpace(s.charCodeAt(k))) k++
    const q = s.charCodeAt(k)
    if (q !== 0x22 && q !== 0x27) unreadable('an entity from outside the file')
    const end = quoted(k)
    const value = s.slice(k + 1, end)
    if (/[<&%]/.test(value)) unreadable('an entity holding markup or references')
    k = end + 1
    while (isSpace(s.charCodeAt(k))) k++
    if (s.charCodeAt(k) !== 0x3e) unreadable('an unfinished entity')
    // The first declaration of a name is the one that counts.
    if (!entities.has(name)) entities.set(name, doc.decode(end - value.length, end))
    if (entities.size > MAX_ENTITIES) unreadable('too many entities')
    return k + 1
  }

  // The DOCTYPE's internal subset: plain-text entities, element declarations (which change nothing
  // without validation) and comments. Not attribute lists, whose defaults would add attributes unseen.
  const subset = (at: number): number => {
    let k = at
    for (;;) {
      while (isSpace(s.charCodeAt(k))) k++
      if (k >= n) unreadable('an unfinished DTD')
      if (s.charCodeAt(k) === 0x5d) return k + 1
      if (s.startsWith('<!--', k)) k = comment(k, undefined)
      else if (s.startsWith('<!ENTITY', k) && isSpace(s.charCodeAt(k + 8))) k = entityDecl(k + 8)
      else if (s.startsWith('<!ELEMENT', k) && isSpace(s.charCodeAt(k + 9))) {
        const end = s.indexOf('>', k)
        if (end < 0 || /["'<]/.test(s.slice(k + 9, end))) unreadable('an unfinished element declaration')
        k = end + 1
      } else unreadable('a DTD that does more than name entities')
    }
  }

  const doctypeDecl = (at: number): number => {
    let k = at + 9
    if (!isSpace(s.charCodeAt(k))) unreadable('a DOCTYPE without a name')
    for (;;) {
      if (k >= n) unreadable('an unfinished DOCTYPE')
      const c = s.charCodeAt(k)
      if (c === 0x22 || c === 0x27) k = quoted(k) + 1
      else if (c === 0x5b) {
        k = subset(k + 1)
        while (isSpace(s.charCodeAt(k))) k++
        if (s.charCodeAt(k) !== 0x3e) unreadable('an unfinished DOCTYPE')
        return k + 1
      } else if (c === 0x3e) return k + 1
      else if (c === 0x3c) unreadable('markup in a DOCTYPE')
      else k++
    }
  }

  const close = (el: SvgEl, end: number) => {
    if (el.outer) for (let k = el.outer.length - 1; k >= 0; k--) {
      const [prefix, before] = el.outer[k]
      if (before === undefined) scope.delete(prefix)
      else scope.set(prefix, before)
    }
    h.close?.(el, end)
    if (!stack.length) done = true
  }

  while (i < n) {
    const lt = s.indexOf('<', i)
    const end = lt < 0 ? n : lt
    if (end > i) {
      const parent = stack[stack.length - 1]
      if (parent) {
        const run = s.slice(i, end)
        checkRefs(run, entities, budget)
        if (run.includes(']]>')) unreadable('"]]>" in text')
        h.text?.(i, end, parent)
      } else for (let k = i; k < end; k++) if (!isSpace(s.charCodeAt(k))) unreadable('text outside the drawing')
    }
    if (lt < 0) break
    i = lt
    const c = s.charCodeAt(i + 1)
    const parent = stack[stack.length - 1]
    if (c === 0x21) {
      if (s.startsWith('<!--', i)) i = comment(i, parent)
      else if (s.startsWith('<![CDATA[', i)) {
        if (!parent) unreadable('CDATA outside the drawing')
        const e = s.indexOf(']]>', i + 9)
        if (e < 0) unreadable('an unfinished CDATA section')
        h.cdata?.(i + 9, e, parent!)
        i = e + 3
      } else if (s.startsWith('<!DOCTYPE', i)) {
        if (root || doctype) unreadable('a DOCTYPE out of place')
        doctype = true
        i = doctypeDecl(i)
      } else unreadable('an unknown declaration')
      continue
    }
    if (c === 0x3f) {
      const e = s.indexOf('?>', i + 2)
      if (e < 0) unreadable('an unfinished processing instruction')
      let k = i + 2
      if (!isNameStart(s.charCodeAt(k))) unreadable('a processing instruction without a target')
      while (k < e && isNameChar(s.charCodeAt(k))) k++
      if (k < e && !isSpace(s.charCodeAt(k))) unreadable('a processing instruction without a target')
      const target = s.slice(i + 2, k)
      if (target.toLowerCase() === 'xml') unreadable('an XML declaration out of place')
      h.pi?.(target, i, e + 2, parent)
      i = e + 2
      continue
    }
    if (c === 0x2f) {
      if (!parent) unreadable('an end tag with nothing open')
      const k0 = i + 2 + parent!.qname.length
      let k = k0
      while (isSpace(s.charCodeAt(k))) k++
      if (!s.startsWith(parent!.qname, i + 2) || s.charCodeAt(k) !== 0x3e) unreadable('an end tag that closes something else')
      i = k + 1
      stack.pop()
      close(parent!, i)
      continue
    }
    if (done) unreadable('a second drawing')
    if (!isNameStart(c)) unreadable('a stray "<"')
    if (++elements > maxElements) unreadable('too many elements')

    // A start tag: its name, then each attribute, with white space before it, as name="value".
    let k = i + 1
    while (k < n && isNameChar(s.charCodeAt(k))) k++
    const qname = s.slice(i + 1, k)
    checkQName(qname)
    const nameEnd = k
    const attrs: SvgAttr[] = []
    const names = new Set<string>()
    let empty = false
    for (;;) {
      const from = k
      while (isSpace(s.charCodeAt(k))) k++
      const ch = s.charCodeAt(k)
      if (ch === 0x3e) {
        k++
        break
      }
      if (ch === 0x2f && s.charCodeAt(k + 1) === 0x3e) {
        empty = true
        k += 2
        break
      }
      if (k === from || !isNameStart(ch)) unreadable('an unreadable start tag')
      const start = k
      while (k < n && isNameChar(s.charCodeAt(k))) k++
      const aname = s.slice(start, k)
      checkQName(aname)
      while (isSpace(s.charCodeAt(k))) k++
      if (s.charCodeAt(k) !== 0x3d) unreadable('an attribute without a value')
      k++
      while (isSpace(s.charCodeAt(k))) k++
      const q = s.charCodeAt(k)
      if (q !== 0x22 && q !== 0x27) unreadable('a value without quotes')
      const ve = quoted(k)
      const raw = s.slice(k + 1, ve)
      if (raw.includes('<')) unreadable('"<" in a value')
      checkRefs(raw, entities, budget)
      if (names.has(aname)) unreadable('an attribute given twice')
      names.add(aname)
      attrs.push({ qname: aname, ns: '', local: aname, from, start, valueStart: k + 1, valueEnd: ve, raw })
      k = ve + 1
    }
    const el: SvgEl = { qname, ns: '', local: qname, attrs, start: i, tagEnd: k, nameEnd, empty, parent }

    // Namespaces declared here count for its own name and attributes too.
    for (const a of attrs) {
      if (a.qname !== 'xmlns' && !a.qname.startsWith('xmlns:')) continue
      const prefix = a.qname === 'xmlns' ? '' : a.qname.slice(6)
      const uri = doc.value(a)
      if (prefix === 'xmlns' || (prefix === 'xml') !== (uri === XML_NS) || uri === XMLNS_NS || (prefix && !uri)) unreadable('a namespace declaration XML refuses')
      if (uri.length > MAX_NS_LENGTH) unreadable('a namespace with too long a name')
      ;(el.outer ??= []).push([prefix, scope.get(prefix)])
      scope.set(prefix, uri)
      if (++declared > MAX_NS) unreadable('too many namespace declarations')
      a.ns = XMLNS_NS
      a.local = prefix || 'xmlns'
      a.uri = uri
    }
    const colon = qname.indexOf(':')
    el.ns = colon < 0 ? (scope.get('') ?? '') : (scope.get(qname.slice(0, colon)) ?? unreadable(`an undeclared prefix: ${qname.slice(0, 40)}`))
    el.local = colon < 0 ? qname : qname.slice(colon + 1)
    const expanded = new Set<string>()
    for (const a of attrs) {
      if (a.ns === XMLNS_NS) continue
      const ac = a.qname.indexOf(':')
      if (ac < 0) continue
      a.ns = scope.get(a.qname.slice(0, ac)) ?? unreadable(`an undeclared prefix: ${a.qname.slice(0, 40)}`)
      a.local = a.qname.slice(ac + 1)
      const key = `${a.ns} ${a.local}`
      if (expanded.has(key)) unreadable('an attribute given twice')
      expanded.add(key)
    }
    if (!root) {
      root = true
      if (el.ns !== SVG_NS || el.local !== 'svg') unreadable('not an SVG drawing')
    }
    if (stack.length >= MAX_DEPTH) unreadable('elements nested too deeply')
    h.open?.(el)
    i = k
    if (empty) close(el, k)
    else stack.push(el)
  }
  if (!done) unreadable(root ? 'an unfinished drawing' : 'no drawing')
  return doc
}

/**
 * Whether the bytes start as an SVG drawing: past any XML declaration, comments, processing
 * instructions and DOCTYPE (looked at as far as the first 64 KB), the first element is <svg>,
 * with a prefix or without. Quick, for telling what a file is; the reader above decides whether
 * it can be read.
 */
export function startsAsSvg(b: Uint8Array): boolean {
  const n = Math.min(b.length, 65_536)
  let i = b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? 3 : 0
  const at = (k: number, t: string) => {
    if (k + t.length > n) return false
    for (let j = 0; j < t.length; j++) if (b[k + j] !== t.charCodeAt(j)) return false
    return true
  }
  const find = (from: number, t: string) => {
    for (let k = from; k + t.length <= n; k++) if (b[k] === t.charCodeAt(0) && at(k, t)) return k
    return -1
  }
  for (;;) {
    while (i < n && isSpace(b[i])) i++
    if (i >= n || b[i] !== 0x3c) return false
    if (at(i, '<?')) {
      const e = find(i + 2, '?>')
      if (e < 0) return false
      i = e + 2
    } else if (at(i, '<!--')) {
      const e = find(i + 4, '-->')
      if (e < 0) return false
      i = e + 3
    } else if (at(i, '<!DOCTYPE')) {
      // To its ">", past any quoted text and [internal subset].
      let quote = 0
      let depth = 0
      let k = i + 9
      for (; k < n; k++) {
        const c = b[k]
        if (quote) {
          if (c === quote) quote = 0
        } else if (at(k, '<!--') || at(k, '<?')) {
          // A comment or instruction in the subset: its quotes and brackets are only words (the review).
          const end = at(k, '<?') ? '?>' : '-->'
          const e = find(k + 2, end)
          if (e < 0) return false
          k = e + end.length - 1 // the loop steps past its last character
        } else if (c === 0x22 || c === 0x27) quote = c
        else if (c === 0x5b) depth++
        else if (c === 0x5d) depth--
        else if (c === 0x3e && depth <= 0) break
      }
      if (k >= n) return false
      i = k + 1
    } else {
      let k = i + 1
      while (k < n && isNameChar(b[k])) k++
      const name = String.fromCharCode(...b.subarray(i + 1, Math.min(k, i + 200)))
      return (name === 'svg' || /^[^:]+:svg$/.test(name)) && k < n && (isSpace(b[k]) || b[k] === 0x3e || b[k] === 0x2f)
    }
  }
}
