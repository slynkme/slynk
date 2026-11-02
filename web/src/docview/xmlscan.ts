// A small XML reader for document previews: it
// goes through a part once, from the start, telling its reader each element
// as it opens and closes and the text between, and stops as soon as the reader
// has enough. xmldom (strip/xml.ts) builds the whole tree first: a 5 MB Word
// document took it 1.3 s and 195 MB, too slow and too big for a phone's page.
// Lenient, since a preview shows what it can: a part cut short ends where it's
// cut, and an end tag that matches nothing open is passed over. As in xmldom,
// a DOCTYPE's entities are never read (no "billion laughs", nothing fetched):
// only XML's own five and character references are.

export interface XmlAttr {
  ns: string
  name: string
  value: string
}

/** An element: its namespace, its name without the prefix, and its attributes. */
export interface XmlEl {
  ns: string
  name: string
  attrs: XmlAttr[]
}

export interface XmlReader {
  open(el: XmlEl): void
  close(el: XmlEl): void
  text(s: string): void
  /** Set once the reader has all it wants: the scan stops there. */
  done: boolean
}

/** Elements open at once, at most: deeper ones and all they hold are passed over. */
const MAX_DEPTH = 256
/** Namespace declarations in a part, at most: a part declaring more is read as if they weren't there. */
const MAX_NS = 2000
const XML_NS = 'http://www.w3.org/XML/1998/namespace'

const NAMED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }

/** Text with XML's five entities and character references read; any other entity is left as written. */
export function decodeXml(s: string): string {
  if (!s.includes('&')) return s
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,4});/g, (m, e: string) => {
    if (e[0] !== '#') return NAMED[e] ?? m
    const cp = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
    return cp > 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff) ? String.fromCodePoint(cp) : '�'
  })
}

/** The end of a <!…> declaration (a DOCTYPE, with any [subset]), minding quotes: just past its >, or -1. */
function declEnd(xml: string, from: number): number {
  let quote = 0
  let depth = 0
  for (let i = from + 2; i < xml.length; i++) {
    const c = xml.charCodeAt(i)
    if (quote) {
      if (c === quote) quote = 0
    } else if (c === 0x22 || c === 0x27) quote = c
    else if (c === 0x5b) depth++
    else if (c === 0x5d) depth--
    else if (c === 0x3e && depth <= 0) return i + 1
  }
  return -1
}

/** The > that ends a start tag, minding quoted values: its index, or -1. */
function tagEnd(xml: string, from: number): number {
  let quote = 0
  for (let i = from; i < xml.length; i++) {
    const c = xml.charCodeAt(i)
    if (quote) {
      if (c === quote) quote = 0
    } else if (c === 0x22 || c === 0x27) quote = c
    else if (c === 0x3e) return i
  }
  return -1
}

/**
 * A start tag's attributes, from `from` in its text: each a name, =, and a quoted value, read in one
 * pass. Anything else (a name with no value, a value without quotes) is passed over. A regular
 * expression went back over a long run of name characters again and again: a tag of 100,000 of them
 * took 7.6 s (the review).
 */
function attributes(body: string, from: number): [string, string][] {
  const out: [string, string][] = []
  const n = body.length
  const space = (c: number) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d
  for (let i = from; i < n; ) {
    let c = body.charCodeAt(i)
    if (space(c) || c === 0x2f) {
      i++
      continue
    }
    const start = i
    while (i < n && !space((c = body.charCodeAt(i))) && c !== 0x3d && c !== 0x2f) i++
    const name = body.slice(start, i)
    while (i < n && space(body.charCodeAt(i))) i++
    if (body.charCodeAt(i) !== 0x3d) continue
    i++
    while (i < n && space(body.charCodeAt(i))) i++
    const q = body.charCodeAt(i)
    if (q !== 0x22 && q !== 0x27) continue
    const end = body.indexOf(q === 0x22 ? '"' : "'", i + 1)
    if (end < 0) break
    if (name) out.push([name, body.slice(i + 1, end)])
    i = end + 1
  }
  return out
}

const isNameStart = (c: number) => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f || c === 0x3a || c > 0x7f

/**
 * Reads xml from the start, telling reader what's in it, until it ends or the reader is done.
 * True if the document's own element closed: the whole of it was read.
 */
export function scanXml(xml: string, reader: XmlReader): boolean {
  const stack: { qname: string; el: XmlEl; outer: Map<string, string> }[] = []
  // How many of each name are open: an end tag that matches none is passed over at once, never looked for.
  const openNames = new Map<string, number>()
  let scope = new Map<string, string>([['xml', XML_NS]])
  let declared = 0
  let deep = 0 // elements open beyond MAX_DEPTH, unreported
  let i = 0
  const n = xml.length
  // Text outside the document's element, or too deep, isn't read at all.
  const text = (from: number, to: number, raw = false) => {
    if (stack.length && !deep && to > from) reader.text(raw ? xml.slice(from, to) : decodeXml(xml.slice(from, to)))
  }
  while (i < n && !reader.done) {
    const lt = xml.indexOf('<', i)
    if (lt < 0) {
      text(i, n)
      break
    }
    if (lt > i) {
      text(i, lt)
      if (reader.done) break
    }
    i = lt
    const c = xml.charCodeAt(i + 1)
    if (c === 0x21) {
      // A comment, CDATA (its text as written) or a declaration.
      if (xml.startsWith('<!--', i)) {
        const e = xml.indexOf('-->', i + 4)
        if (e < 0) break
        i = e + 3
      } else if (xml.startsWith('<![CDATA[', i)) {
        const e = xml.indexOf(']]>', i + 9)
        text(i + 9, e < 0 ? n : e, true)
        if (e < 0) break
        i = e + 3
      } else {
        i = declEnd(xml, i)
        if (i < 0) break
      }
      continue
    }
    if (c === 0x3f) {
      const e = xml.indexOf('?>', i + 2)
      if (e < 0) break
      i = e + 2
      continue
    }
    if (c === 0x2f) {
      const e = xml.indexOf('>', i + 2)
      if (e < 0) break
      const qname = xml.slice(i + 2, e).trim()
      i = e + 1
      if (deep) {
        deep--
        continue
      }
      if (!openNames.get(qname)) continue
      let k = stack.length - 1
      while (k >= 0 && stack[k].qname !== qname) k--
      // Closing an element closes any left open inside it.
      while (k >= 0 && stack.length > k) {
        const top = stack.pop()!
        openNames.set(top.qname, openNames.get(top.qname)! - 1)
        scope = top.outer
        reader.close(top.el)
      }
      if (k === 0) return true
      continue
    }
    if (!isNameStart(c)) {
      // A lone "<": text, as a lenient reader takes it.
      text(i, i + 1, true)
      i++
      continue
    }
    const e = tagEnd(xml, i + 1)
    if (e < 0) break
    const empty = xml.charCodeAt(e - 1) === 0x2f
    const body = xml.slice(i + 1, empty ? e - 1 : e)
    i = e + 1
    if (deep || stack.length >= MAX_DEPTH) {
      if (!empty) deep++
      continue
    }
    const sp = body.search(/[\s/]/)
    const qname = sp < 0 ? body : body.slice(0, sp)
    const raw: [string, string][] = []
    let inner: Map<string, string> | undefined
    if (sp >= 0)
      for (const [name, text] of attributes(body, sp)) {
        const value = decodeXml(text)
        if (name === 'xmlns' || name.startsWith('xmlns:')) {
          if (declared++ < MAX_NS) (inner ??= new Map(scope)).set(name === 'xmlns' ? '' : name.slice(6), value)
        } else raw.push([name, value])
      }
    const here = inner ?? scope
    const split = (q: string, fallback: string): [string, string] => {
      const colon = q.indexOf(':')
      return colon < 0 ? [fallback, q] : [here.get(q.slice(0, colon)) ?? '', q.slice(colon + 1)]
    }
    const [ns, name] = split(qname, here.get('') ?? '')
    const attrs = raw.map(([q, value]) => {
      const [ans, aname] = split(q, '')
      return { ns: ans, name: aname, value }
    })
    const el = { ns, name, attrs }
    reader.open(el)
    if (empty) reader.close(el)
    else {
      stack.push({ qname, el, outer: scope })
      openNames.set(qname, (openNames.get(qname) ?? 0) + 1)
      scope = here
    }
  }
  return false
}

/** An attribute's value, if it has one. */
export function attrOf(el: XmlEl, ns: string, name: string): string | undefined {
  for (const a of el.attrs) if (a.name === name && a.ns === ns) return a.value
  return undefined
}

/** A part read whole into a tree, for the small ones a reader looks things up in (styles, numbering). */
export interface XmlNode extends XmlEl {
  kids: XmlNode[]
}

/** Elements a tree holds at most: the rest of a part with more isn't kept. A real styles.xml has some thousands. */
const MAX_NODES = 50_000

/** Builds a tree from what a scan tells it. */
export class TreeBuilder implements XmlReader {
  done = false
  root: XmlNode | undefined
  private stack: XmlNode[] = []
  private count = 0
  open(el: XmlEl) {
    const node: XmlNode = { ...el, kids: [] }
    if (++this.count > MAX_NODES) {
      this.done = true
      return
    }
    const top = this.stack[this.stack.length - 1]
    if (top) top.kids.push(node)
    else if (!this.root) this.root = node
    this.stack.push(node)
  }
  close() {
    this.stack.pop()
  }
  text() {}
}

/** A whole part as a tree: undefined if it has no element. */
export function parseTree(xml: string): XmlNode | undefined {
  const t = new TreeBuilder()
  scanXml(xml, t)
  return t.root
}

/** A node's children with this name, in any of the namespaces given. */
export function kidsOf(node: XmlNode | undefined, ns: string | readonly string[], name: string): XmlNode[] {
  if (!node) return []
  const set = typeof ns === 'string' ? [ns] : ns
  return node.kids.filter((k) => k.name === name && set.includes(k.ns))
}

/** A node's first child with this name, in any of the namespaces given. */
export const kidOf = (node: XmlNode | undefined, ns: string | readonly string[], name: string): XmlNode | undefined => kidsOf(node, ns, name)[0]
