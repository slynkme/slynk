// Checks a rewritten Office file the way an office app would first look at
// it: every part unzips with the right checksum, the parts that name others
// parse, and nothing points at a part that isn't there. (Other parts are
// copied as they were, so their checksum is enough: a big spreadsheet's
// sheets aren't parsed again.) For Word, PowerPoint and Excel,
// every relationship's target exists and every part has a content type; for
// LibreOffice, mimetype comes first and uncompressed, the manifest lists only
// files that exist, and every picture link finds its picture.
//
// It lists problems rather than stopping at the first, so a rewritten file can
// be held to the original: some files arrive with a dangling link of their
// own, and only a new problem means the rewrite broke something.
import { elements, parseXmlBytes } from '../strip/xml.ts'
import { openPackage, readEntry, resolveTarget } from '../strip/zip.ts'
import { type Family, odfTarget } from './place.ts'

const CT = 'http://schemas.openxmlformats.org/package/2006/content-types'
const PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
const MANIFEST = 'urn:oasis:names:tc:opendocument:xmlns:manifest:1.0'
const XLINK = 'http://www.w3.org/1999/xlink'

function decoded(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/** What's wrong with the package, if anything. Throws if it can't be unzipped at all. */
export function checkOffice(bytes: Uint8Array, family: Family): string[] {
  const problems: string[] = []
  const pkg = openPackage(bytes)
  const names = new Set(pkg.entries.map((e) => e.name))
  const lower = new Set([...names].map((n) => n.toLowerCase()))
  const xml = new Map<string, ReturnType<typeof parseXmlBytes>>()
  const structural = family === 'ooxml' ? /(\.rels|^\[Content_Types\]\.xml)$/ : /(^|\/)(content|styles)\.xml$|^META-INF\/manifest\.xml$/
  for (const e of pkg.entries) {
    const data = readEntry(pkg, e)
    if (!structural.test(e.name) || !data.length) continue
    try {
      xml.set(e.name, parseXmlBytes(data))
    } catch {
      problems.push(`${e.name} can't be read`)
    }
  }
  if (family === 'ooxml') {
    const ct = xml.get('[Content_Types].xml')
    if (!ct) return [...problems, 'no [Content_Types].xml']
    const defaults = new Set(elements(ct, CT, 'Default').map((d) => (d.getAttribute('Extension') ?? '').toLowerCase()))
    const overrides = new Set(elements(ct, CT, 'Override').map((o) => decoded((o.getAttribute('PartName') ?? '').replace(/^\//, '')).toLowerCase()))
    for (const n of names) {
      if (n === '[Content_Types].xml' || n.endsWith('/')) continue
      const ext = /\.([^./]+)$/.exec(n)?.[1].toLowerCase() ?? ''
      if (!overrides.has(n.toLowerCase()) && !defaults.has(ext)) problems.push(`${n} has no content type`)
    }
    for (const o of overrides) if (!lower.has(o)) problems.push(`a content type is listed for ${o}, which isn't there`)
    for (const [name, doc] of xml) {
      if (!name.endsWith('.rels')) continue
      for (const r of elements(doc, PKG_REL, 'Relationship')) {
        if (r.getAttribute('TargetMode') === 'External') continue
        const t = resolveTarget(name, r.getAttribute('Target') ?? '')
        // Some relationships point at the package itself or a folder.
        if (t && !lower.has(t.toLowerCase()) && ![...lower].some((n) => n.startsWith(t.toLowerCase() + '/'))) problems.push(`${name} points at ${t}, which isn't there`)
      }
    }
  } else {
    const first = pkg.entries[0]
    if (first?.name !== 'mimetype' || first.method !== 0) problems.push('mimetype must come first, uncompressed')
    const manifest = xml.get('META-INF/manifest.xml')
    if (!manifest) return [...problems, 'no manifest']
    for (const fe of elements(manifest, MANIFEST, 'file-entry')) {
      const path = fe.getAttributeNS(MANIFEST, 'full-path') ?? ''
      if (path === '/' || path.endsWith('/')) continue
      if (!names.has(path)) problems.push(`the manifest lists ${path}, which isn't there`)
    }
    for (const [name, doc] of xml) {
      if (name.startsWith('META-INF/')) continue
      const walk = [doc.documentElement!]
      while (walk.length) {
        const el = walk.pop()!
        for (let c = el.firstChild; c; c = c.nextSibling) if (c.nodeType === 1) walk.push(c as typeof el)
        const href = el.getAttributeNS(XLINK, 'href')
        if (href && /(^|\/)Pictures\//.test(href) && !odfTarget(name, href, names)) problems.push(`${name} links to ${href}, which isn't there`)
      }
    }
  }
  return problems
}
