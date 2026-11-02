// XML through @xmldom/xmldom: Web Workers have no DOMParser of their own.
// Parsing is strict (any error fails the file), so a part we can't read
// faithfully is never rewritten.
import { DOMParser, XMLSerializer, type Document, type Element, type Node } from '@xmldom/xmldom'
import { fail } from './types.ts'

export type { Document, Element, Node }

// xmldom treats U+0085 and U+2028 as line ends (an XML 1.1 rule) and turns
// them into "\n", which would quietly change the text of a rewritten part.
// Written as character references they come through as themselves. Comments,
// processing instructions and CDATA don't read references, so they're skipped.
const LINE_ENDS = /[\u0085\u2028]/
const VERBATIM = /(<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>)/

function protectLineEnds(text: string): string {
  if (!LINE_ENDS.test(text)) return text
  return text
    .split(VERBATIM)
    .map((piece, i) => (i % 2 ? piece : piece.replace(/[\u0085\u2028]/g, (c) => `&#x${c.charCodeAt(0).toString(16)};`)))
    .join('')
}

export function parseXml(text: string): Document {
  const parser = new DOMParser({
    onError: (level, msg) => {
      if (level !== 'warning') fail(`unreadable XML: ${msg}`)
    },
  })
  const doc = parser.parseFromString(protectLineEnds(text), 'text/xml')
  if (!doc.documentElement) fail('empty XML')
  return doc
}

export function parseXmlBytes(b: Uint8Array): Document {
  if ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff)) fail('UTF-16 XML is not supported')
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(b)
  } catch {
    return fail('XML is not valid UTF-8')
  }
  return parseXml(text)
}

export function serializeXml(node: Node): string {
  return new XMLSerializer().serializeToString(node)
}

/**
 * A rewritten part, checked to read back exactly as it was written. Parsing
 * turns every raw line end into "\n", so a carriage return left in the tree
 * came from &#13; in text; the serializer would write it raw, and readers
 * would then see "\n", so it's written as a reference again.
 */
export function serializeXmlBytes(doc: Document): Uint8Array {
  const text = serializeXml(doc).replace(/\r/g, '&#13;')
  if (serializeXml(parseXml(text)).replace(/\r/g, '&#13;') !== text) fail('a part would not read back the same once rewritten')
  return new TextEncoder().encode(text)
}

/** All elements with this namespace and local name, as a static array. */
export function elements(root: Document | Element, ns: string, local: string): Element[] {
  const list = root.getElementsByTagNameNS(ns, local)
  const out: Element[] = []
  for (let i = 0; i < list.length; i++) out.push(list[i])
  return out
}

export function children(el: Element): Element[] {
  const out: Element[] = []
  for (let c = el.firstChild; c; c = c.nextSibling) if (c.nodeType === 1) out.push(c as Element)
  return out
}

export function removeNode(node: Node) {
  node.parentNode?.removeChild(node)
}

/** The document's text, skipping subtrees where `skip` says so. */
export function textOf(node: Node, skip?: (el: Element) => boolean): string {
  let s = ''
  const visit = (n: Node) => {
    if (n.nodeType === 3 || n.nodeType === 4) s += n.nodeValue ?? ''
    if (n.nodeType === 1 && skip?.(n as Element)) return
    for (let c = n.firstChild; c; c = c.nextSibling) visit(c)
  }
  visit(node)
  return s
}

export function setText(el: Element, text: string) {
  while (el.firstChild) el.removeChild(el.firstChild)
  el.appendChild(el.ownerDocument!.createTextNode(text))
}
