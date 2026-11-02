// A picture that changes kind (a PNG photo saved as a JPEG) needs a new name
// to match, and everything that names it must follow: in Word, PowerPoint and
// Excel files, each relationship pointing at it and [Content_Types].xml (which
// says what each file is); in LibreOffice files, every xlink:href, any
// draw:mime-type beside it, and the manifest. Only attributes change: the
// document's text must come out identical, or nothing is changed.
import { type Document, type Element, children, elements, parseXmlBytes, serializeXmlBytes, textOf } from '../strip/xml.ts'
import { type Package, readEntry, resolveTarget } from '../strip/zip.ts'
import { type Family, odfTarget } from './place.ts'

const CT = 'http://schemas.openxmlformats.org/package/2006/content-types'
const PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
const XLINK = 'http://www.w3.org/1999/xlink'
const MANIFEST = 'urn:oasis:names:tc:opendocument:xmlns:manifest:1.0'

export interface Rename {
  from: string
  to: string
  /** Its new MIME type. */
  type: string
}

const EXT: Record<string, Record<string, string>> = {
  ooxml: { 'image/jpeg': '.jpeg', 'image/png': '.png' },
  odf: { 'image/jpeg': '.jpg', 'image/png': '.png' },
}

/** True when a part's extension already says it's this type. */
export function extFits(name: string, type: string): boolean {
  const ext = /\.([^./]+)$/.exec(name)?.[1].toLowerCase()
  return type === 'image/jpeg' ? ext === 'jpeg' || ext === 'jpg' : type === 'image/png' ? ext === 'png' : false
}

/** A new name for a part with this new type, clashing with nothing in the package (names compared without case, as OOXML does). */
export function newName(name: string, type: string, family: Family, taken: Set<string>): string {
  const dot = name.lastIndexOf('.')
  const base = dot > name.lastIndexOf('/') ? name.slice(0, dot) : name
  const ext = EXT[family][type]
  for (let n = 1; ; n++) {
    const candidate = base + (n === 1 ? '' : `-${n}`) + ext
    if (!taken.has(candidate.toLowerCase())) {
      taken.add(candidate.toLowerCase())
      return candidate
    }
  }
}

/** Points a relationship's Target at the new name, keeping its form (relative, absolute, escaped). */
function retarget(target: string, to: string): string {
  const cut = target.lastIndexOf('/') + 1
  const base = to.slice(to.lastIndexOf('/') + 1)
  return target.slice(0, cut) + encodeURI(base)
}

/**
 * The XML parts that change, as new bytes. Throws if a part can't be read, or
 * its text would change.
 */
export function renameParts(pkg: Package, family: Family, renames: Rename[]): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>()
  if (!renames.length) return out
  const byFrom = new Map(renames.map((r) => [r.from, r]))
  const byName = new Map(pkg.entries.map((e) => [e.name, e]))
  const names = new Set(byName.keys())
  const docs = new Map<string, { doc: Document; text: string }>()
  const open = (name: string) => {
    let d = docs.get(name)
    if (!d) {
      const doc = parseXmlBytes(readEntry(pkg, byName.get(name)!))
      d = { doc, text: textOf(doc) }
      docs.set(name, d)
    }
    return d.doc
  }
  const changed = new Set<string>()

  if (family === 'ooxml') {
    for (const e of pkg.entries) {
      if (!e.name.endsWith('.rels')) continue
      const doc = open(e.name)
      for (const r of elements(doc, PKG_REL, 'Relationship')) {
        if (r.getAttribute('TargetMode') === 'External') continue
        const target = r.getAttribute('Target') ?? ''
        const ren = byFrom.get(resolveTarget(e.name, target))
        if (!ren) continue
        r.getAttributeNode('Target')!.value = retarget(target, ren.to)
        changed.add(e.name)
      }
    }
    const ct = '[Content_Types].xml'
    const doc = open(ct)
    const types = doc.documentElement!
    const defaults = new Map(elements(doc, CT, 'Default').map((d) => [(d.getAttribute('Extension') ?? '').toLowerCase(), d]))
    for (const o of elements(doc, CT, 'Override')) {
      let part = (o.getAttribute('PartName') ?? '').replace(/^\//, '')
      try {
        part = decodeURIComponent(part)
      } catch {
        // Compared as written.
      }
      const ren = renames.find((r) => r.from.toLowerCase() === part.toLowerCase())
      if (!ren) continue
      o.getAttributeNode('PartName')!.value = '/' + encodeURI(ren.to)
      o.getAttributeNode('ContentType')!.value = ren.type
      changed.add(ct)
    }
    for (const r of renames) {
      const ext = r.to.slice(r.to.lastIndexOf('.') + 1)
      const listed = elements(doc, CT, 'Override').some((o) => (o.getAttribute('PartName') ?? '').toLowerCase() === '/' + encodeURI(r.to).toLowerCase())
      if (listed) continue
      const d = defaults.get(ext.toLowerCase())
      if (d && d.getAttribute('ContentType') === r.type) continue
      if (d) {
        // That extension means something else here: say what this one is on its own.
        const o = doc.createElementNS(CT, 'Override')
        o.setAttribute('PartName', '/' + encodeURI(r.to))
        o.setAttribute('ContentType', r.type)
        types.appendChild(o)
      } else {
        // Defaults come before Overrides.
        const n = doc.createElementNS(CT, 'Default')
        n.setAttribute('Extension', ext)
        n.setAttribute('ContentType', r.type)
        types.insertBefore(n, children(types).find((c) => c.localName === 'Override') ?? null)
        defaults.set(ext.toLowerCase(), n)
      }
      changed.add(ct)
    }
  } else {
    for (const e of pkg.entries) {
      if (!e.name.endsWith('.xml') || !e.usize || e.name.startsWith('META-INF/')) continue
      // Only parts that could name a picture are opened.
      if (!hasAscii(readEntry(pkg, e), 'Pictures/')) continue
      const doc = open(e.name)
      const walk: Element[] = [doc.documentElement!]
      while (walk.length) {
        const el = walk.pop()!
        walk.push(...children(el))
        const href = el.getAttributeNS(XLINK, 'href')
        const ren = href ? byFrom.get(odfTarget(e.name, href, names) ?? '') : undefined
        if (!ren || !href) continue
        el.getAttributeNodeNS(XLINK, 'href')!.value = retarget(href, ren.to)
        for (let i = 0; i < el.attributes.length; i++) {
          const a = el.attributes[i]
          if (a.localName === 'mime-type') a.value = ren.type
        }
        changed.add(e.name)
      }
    }
    const m = 'META-INF/manifest.xml'
    const doc = open(m)
    for (const fe of elements(doc, MANIFEST, 'file-entry')) {
      const ren = byFrom.get(fe.getAttributeNS(MANIFEST, 'full-path') ?? '')
      if (!ren) continue
      fe.getAttributeNodeNS(MANIFEST, 'full-path')!.value = ren.to
      const type = fe.getAttributeNodeNS(MANIFEST, 'media-type')
      if (type) type.value = ren.type
      changed.add(m)
    }
  }

  for (const name of changed) {
    const { doc, text } = docs.get(name)!
    if (textOf(doc) !== text) throw new Error(`the text of ${name} would change`)
    out.set(name, serializeXmlBytes(doc))
  }
  return out
}

function hasAscii(b: Uint8Array, s: string): boolean {
  const first = s.charCodeAt(0)
  outer: for (let i = b.indexOf(first); i !== -1 && i + s.length <= b.length; i = b.indexOf(first, i + 1)) {
    for (let k = 1; k < s.length; k++) if (b[i + k] !== s.charCodeAt(k)) continue outer
    return true
  }
  return false
}
