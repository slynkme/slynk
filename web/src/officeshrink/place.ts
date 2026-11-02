// Where each picture in an Office file is shown, and how big, read from the
// document's own XML, so every picture can come down to the same sharpness
// (as pdfshrink/place.ts does for PDFs).
//
// Word, PowerPoint and Excel (OOXML) keep pictures as files in the zip
// (word/media/, ppt/media/, xl/media/), each reached through a relationship
// ("rId7" in document.xml.rels). Where one is drawn, its shape says how big:
// a:xfrm/a:ext or Word's wp:extent, in EMUs (914,400 to the inch), scaled by
// any group it's in (a group's chExt is the size its children think in; its
// ext the size it's shown at). A cropped picture is stored whole: a:srcRect
// says how much of each side is cut off, in thousandths of a percent, so the
// whole picture counts as shown that much larger.
//
// LibreOffice files (OpenDocument) keep them in Pictures/, drawn by a
// draw:frame whose svg:width and svg:height say how big. Their crops
// (fo:clip) are lengths measured against the picture's own size, which
// depends on its pixels, so a cropped one is left alone.
//
// Pictures used as a repeating texture or a background fill are left alone
// too: how they look depends on their pixels. A picture found nowhere, or
// used where its size can't be read (a chart, a theme), is sized as if it
// filled the largest page, the cautious choice.
import { type Document, type Element, children, parseXmlBytes } from '../strip/xml.ts'
import { type Package, readEntry, resolveTarget } from '../strip/zip.ts'

export type Family = 'ooxml' | 'odf'

/** Inches, for the whole picture as stored. */
export interface Shown {
  w: number
  h: number
}

export interface Placement {
  /** The largest it's shown at (each side on its own), when every use's size was read. */
  shown?: Shown
  /** Some use, or none found, whose size is unknown: sized as if it filled the page. */
  unsized: boolean
  /** Used as a texture or background fill: left alone. */
  fill: boolean
  /** Cropped in an OpenDocument file: left alone. */
  clipped: boolean
  /** Where it's used, for the report ("slide 2", "header"). */
  places: string[]
}

export interface Placed {
  /** By part name, every picture the package holds. */
  pictures: Map<string, Placement>
  /** The largest page or slide, in inches (Letter when none is given). */
  page: Shown
  /** Parts that couldn't be read: their pictures count as unsized. */
  unread: number
}

export const EMU_PER_INCH = 914_400
const LETTER: Shown = { w: 8.5, h: 11 }

const RELS_NS = ['http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'http://purl.oclc.org/ooxml/officeDocument/relationships']
const VML = 'urn:schemas-microsoft-com:vml'
const O = 'urn:schemas-microsoft-com:office:office'
const PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006'
const XLINK = 'http://www.w3.org/1999/xlink'
const NS = {
  draw: 'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0',
  svg: 'urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0',
  style: 'urn:oasis:names:tc:opendocument:xmlns:style:1.0',
  fo: 'urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0',
  office: 'urn:oasis:names:tc:opendocument:xmlns:office:1.0',
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

const child = (el: Element, local: string) => children(el).find((c) => c.localName === local)
const parent = (el: Element) => (el.parentNode?.nodeType === 1 ? (el.parentNode as Element) : undefined)
const num = (el: Element | undefined, name: string, d = 0) => {
  const v = el?.getAttribute(name)
  const n = v ? Number(v) : NaN
  return Number.isFinite(n) ? n : d
}

function newPlacement(): Placement {
  return { unsized: false, fill: false, clipped: false, places: [] }
}

type Use = { size: Shown } | 'unsized' | 'fill' | 'clipped' | 'ignore'

function record(p: Placement, use: Use, place: string) {
  if (use === 'ignore') return
  if (!p.places.includes(place)) p.places.push(place)
  if (use === 'unsized') p.unsized = true
  else if (use === 'fill') p.fill = true
  else if (use === 'clipped') p.clipped = true
  else p.shown = p.shown ? { w: Math.max(p.shown.w, use.size.w), h: Math.max(p.shown.h, use.size.h) } : use.size
}

/** A picture found nowhere, or only where its size isn't known, is sized as if it filled the page. */
function settle(pictures: Map<string, Placement>) {
  for (const p of pictures.values()) if (!p.shown && !p.fill && !p.clipped) p.unsized = true
}

/** The whole picture's size when the shown part is a share of it (crop), clamped to something sensible. */
function whole(box: Shown, fx: number, fy: number): Use {
  if (!(fx > 0.005 && fy > 0.005)) return 'unsized'
  return { size: { w: box.w / fx, h: box.h / fy } }
}

// --- OOXML -------------------------------------------------------------------------------

const IMAGE_REL = /\/(image|hdphoto)$/
/** Pictures in a media folder that nothing points at (a video beside them isn't one). */
const PICTURE_NAME = /\.(png|jpe?g|gif|bmp|tiff?|emf|wmf|emz|wmz|svg|wdp|jxr|webp)$/i

/** The part a .rels file describes: "word/_rels/document.xml.rels" → "word/document.xml". */
export function relsSource(rels: string): string {
  return rels.replace(/(^|\/)_rels\/([^/]+)\.rels$/, '$1$2')
}

/** A shape's size from its own transform (a:xfrm/a:ext) or its anchor (wp:extent, xdr:ext), then scaled by its groups. */
function boxOf(start: Element): Shown | undefined {
  const sized = (el: Element | undefined) => (el && num(el, 'cx') > 0 && num(el, 'cy') > 0 ? el : undefined)
  let found: Element | undefined
  let at: Element | undefined
  for (let a: Element | undefined = start; a && !found; a = parent(a)) {
    const sp = a.localName === 'spPr' ? a : child(a, 'spPr')
    found =
      sized(sp && child(sp, 'xfrm') && child(child(sp, 'xfrm')!, 'ext')) ??
      sized(child(a, 'xfrm') && child(child(a, 'xfrm')!, 'ext')) ??
      sized(child(a, 'ext')) ??
      sized(child(a, 'extent'))
    at = a
  }
  if (!found || !at) return undefined
  let sx = 1
  let sy = 1
  for (let g = parent(at); g; g = parent(g)) {
    const x = child(g, 'grpSpPr') && child(child(g, 'grpSpPr')!, 'xfrm')
    const ext = x && child(x, 'ext')
    const ch = x && child(x, 'chExt')
    if (ext && ch && num(ch, 'cx') > 0 && num(ch, 'cy') > 0) {
      sx *= num(ext, 'cx') / num(ch, 'cx')
      sy *= num(ext, 'cy') / num(ch, 'cy')
    }
  }
  return { w: (num(found, 'cx') * sx) / EMU_PER_INCH, h: (num(found, 'cy') * sy) / EMU_PER_INCH }
}

/** A DrawingML picture (a:blip in a blipFill): its shape's size, its crop and its fill rectangle. */
function blipUse(blip: Element, page: Shown): Use {
  const fill = parent(blip)
  if (!fill || fill.localName !== 'blipFill') return 'unsized'
  if (child(fill, 'tile')) return 'fill'
  const crop = child(fill, 'srcRect')
  const fx = 1 - (num(crop, 'l') + num(crop, 'r')) / 100_000
  const fy = 1 - (num(crop, 't') + num(crop, 'b')) / 100_000
  // The picture can be stretched into a smaller (or larger) rectangle of its shape.
  const rect = child(child(fill, 'stretch') ?? fill, 'fillRect')
  const gx = 1 - (num(rect, 'l') + num(rect, 'r')) / 100_000
  const gy = 1 - (num(rect, 't') + num(rect, 'b')) / 100_000
  let box = boxOf(fill)
  if (!box) {
    // A slide's background fills the slide.
    for (let a = parent(fill); a && !box; a = parent(a)) if (a.localName === 'bgPr') box = page
  }
  if (!box || !(gx > 0.005 && gy > 0.005)) return 'unsized'
  return whole({ w: box.w * gx, h: box.h * gy }, fx, fy)
}

/** A CSS length in a VML style ("451.3pt") in inches. */
function cssInches(v: string | undefined): number | undefined {
  const m = v && /^\s*(-?[\d.]+)\s*(pt|in|cm|mm|pc|px)?\s*$/i.exec(v)
  if (!m) return undefined
  const n = Number(m[1])
  const per = { pt: 72, in: 1, cm: 2.54, mm: 25.4, pc: 6, px: 96 }[(m[2] ?? 'px').toLowerCase() as 'pt']
  return Number.isFinite(n) && n > 0 ? n / per : undefined
}

/** VML crop fractions: "0.1", or "6554f" in 65536ths. */
function vmlFraction(v: string | null): number {
  const m = v && /^\s*(-?[\d.]+)(f?)\s*$/.exec(v)
  if (!m) return 0
  const n = Number(m[1])
  return Number.isFinite(n) ? (m[2] ? n / 65536 : n) : 0
}

/** An older VML picture (v:imagedata): its shape's style gives the size. */
function vmlUse(data: Element): Use {
  const shape = parent(data)
  if (!shape) return 'unsized'
  // Inside a group, sizes are in the group's own units.
  for (let a = parent(shape); a; a = parent(a)) if (a.namespaceURI === VML && a.localName === 'group') return 'unsized'
  const style = new Map(
    (shape.getAttribute('style') ?? '')
      .split(';')
      .map((s) => s.split(':').map((x) => x.trim().toLowerCase()) as [string, string])
      .filter(([k, v]) => k && v),
  )
  const w = cssInches(style.get('width'))
  const h = cssInches(style.get('height'))
  if (!w || !h) return 'unsized'
  const fx = 1 - vmlFraction(data.getAttribute('cropleft')) - vmlFraction(data.getAttribute('cropright'))
  const fy = 1 - vmlFraction(data.getAttribute('croptop')) - vmlFraction(data.getAttribute('cropbottom'))
  return whole({ w, h }, fx, fy)
}

/**
 * Inside mc:Fallback: what readers older than Office 2010 draw instead (Word
 * repeats a picture there in VML). The mc:Choice beside it is what's shown.
 */
function fallback(el: Element): boolean {
  for (let a = parent(el); a; a = parent(a)) if (a.namespaceURI === MC && a.localName === 'Fallback') return true
  return false
}

function ooxmlUse(el: Element, page: Shown): Use {
  if (el.localName === 'blip') return blipUse(el, page)
  if (el.namespaceURI === VML && el.localName === 'imagedata') return vmlUse(el)
  // A VML fill (Word's page colour picture, a textured shape) and Excel's sheet background repeat.
  if (el.namespaceURI === VML && el.localName === 'fill') return 'fill'
  if (el.localName === 'picture' && /spreadsheetml/.test(el.namespaceURI ?? '')) return 'fill'
  return 'unsized'
}

/** Slides in presentation order: part name → its number. */
function slideNumbers(read: (name: string) => Document | undefined): Map<string, number> {
  const out = new Map<string, number>()
  const pres = read('ppt/presentation.xml')
  const rels = read('ppt/_rels/presentation.xml.rels')
  if (!pres || !rels) return out
  const targets = new Map<string, string>()
  for (const r of allElements(rels.documentElement!)) {
    if (r.localName === 'Relationship') targets.set(r.getAttribute('Id') ?? '', resolveTarget('ppt/_rels/presentation.xml.rels', r.getAttribute('Target') ?? ''))
  }
  let n = 0
  for (const el of allElements(pres.documentElement!)) {
    if (el.localName !== 'sldId') continue
    n++
    for (const ns of RELS_NS) {
      const t = targets.get(el.getAttributeNS(ns, 'id') ?? '')
      if (t) out.set(t, n)
    }
  }
  return out
}

function ooxmlPlace(part: string, slides: Map<string, number>): string {
  const n = slides.get(part)
  if (n) return `slide ${n}`
  const rules: [RegExp, string][] = [
    [/^word\/document\.xml$/, 'document'],
    [/^word\/header\d*\.xml$/, 'header'],
    [/^word\/footer\d*\.xml$/, 'footer'],
    [/^word\/(foot|end)notes\.xml$/, 'notes'],
    [/^ppt\/slideLayouts\//, 'layout'],
    [/^ppt\/slideMasters\//, 'master'],
    [/^ppt\/notes/, 'speaker notes'],
    [/^ppt\/handoutMasters\//, 'handout'],
    [/\/charts\//, 'chart'],
    [/\/diagrams\//, 'diagram'],
    [/\/theme\//, 'theme'],
    [/^xl\/drawings\/vmlDrawing/, 'sheet header'],
    [/^xl\/drawings\//, 'sheet'],
    [/^xl\/worksheets\//, 'sheet background'],
  ]
  for (const [re, name] of rules) if (re.test(part)) return name
  return part.replace(/^.*\//, '').replace(/\d*\.[a-z]+$/i, '') || 'elsewhere'
}

function placeOoxml(pkg: Package): Placed {
  const names = new Set(pkg.entries.map((e) => e.name))
  const byName = new Map(pkg.entries.map((e) => [e.name, e]))
  let unread = 0
  const cache = new Map<string, Document | undefined>()
  const read = (name: string): Document | undefined => {
    if (cache.has(name)) return cache.get(name)
    let d: Document | undefined
    const e = byName.get(name)
    if (e && e.usize) {
      try {
        d = parseXmlBytes(readEntry(pkg, e))
      } catch {
        unread++
      }
    }
    cache.set(name, d)
    return d
  }

  // Every picture: the target of an image relationship, or a file in a media folder.
  const pictures = new Map<string, Placement>()
  const bySource = new Map<string, Map<string, string>>()
  for (const e of pkg.entries) {
    if (!e.name.endsWith('.rels')) continue
    const rels = read(e.name)
    if (!rels) continue
    const ids = new Map<string, string>()
    for (const r of allElements(rels.documentElement!)) {
      if (r.namespaceURI !== PKG_REL || r.localName !== 'Relationship' || r.getAttribute('TargetMode') === 'External') continue
      if (!IMAGE_REL.test(r.getAttribute('Type') ?? '')) continue
      const target = resolveTarget(e.name, r.getAttribute('Target') ?? '')
      if (!names.has(target)) continue
      ids.set(r.getAttribute('Id') ?? '', target)
      if (!pictures.has(target)) pictures.set(target, newPlacement())
    }
    if (ids.size) bySource.set(relsSource(e.name), ids)
  }
  for (const e of pkg.entries) if (/(^|\/)media\/[^/]+$/.test(e.name) && PICTURE_NAME.test(e.name) && !pictures.has(e.name)) pictures.set(e.name, newPlacement())

  // The page or slide.
  let page: Shown | undefined
  const doc = read('word/document.xml')
  if (doc) {
    for (const el of allElements(doc.documentElement!)) {
      if (el.localName !== 'pgSz') continue
      const w = Number(el.getAttributeNS(el.namespaceURI, 'w')) / 1440
      const h = Number(el.getAttributeNS(el.namespaceURI, 'h')) / 1440
      if (w > 0 && h > 0) page = { w: Math.max(page?.w ?? 0, w), h: Math.max(page?.h ?? 0, h) }
    }
  }
  const pres = read('ppt/presentation.xml')
  const sld = pres && allElements(pres.documentElement!).find((el) => el.localName === 'sldSz')
  if (sld && num(sld, 'cx') > 0 && num(sld, 'cy') > 0) page = { w: num(sld, 'cx') / EMU_PER_INCH, h: num(sld, 'cy') / EMU_PER_INCH }
  page ??= LETTER
  const slides = slideNumbers(read)

  for (const [source, ids] of bySource) {
    // SmartArt's data part repeats what its drawing part shows.
    const duplicate = /\/diagrams\/data\d*\.xml$/.test(source)
    const d = read(source)
    if (!d) {
      for (const t of ids.values()) record(pictures.get(t)!, 'unsized', ooxmlPlace(source, slides))
      continue
    }
    for (const el of allElements(d.documentElement!)) {
      for (let i = 0; i < el.attributes.length; i++) {
        const a = el.attributes[i]
        const isRel = RELS_NS.includes(a.namespaceURI ?? '') || (a.namespaceURI === O && a.localName === 'relid')
        const target = isRel ? ids.get(a.value) : undefined
        if (!target || duplicate) continue
        record(pictures.get(target)!, fallback(el) ? 'ignore' : ooxmlUse(el, page), ooxmlPlace(source, slides))
      }
    }
  }
  settle(pictures)
  return { pictures, page, unread }
}

// --- OpenDocument ------------------------------------------------------------------------

/** An ODF length ("16.51cm", "6.5in") in inches. */
export function odfInches(v: string | null | undefined): number | undefined {
  const m = v && /^\s*(-?[\d.]+)\s*(in|cm|mm|pt|pc|px)\s*$/i.exec(v)
  if (!m) return undefined
  const n = Number(m[1])
  const per = { in: 1, cm: 2.54, mm: 25.4, pt: 72, pc: 6, px: 96 }[m[2].toLowerCase() as 'in']
  return Number.isFinite(n) && n > 0 ? n / per : undefined
}

/** A clip of "rect(0cm, 0cm, 0cm, 0cm)" or "auto" cuts nothing. */
function clips(v: string | null): boolean {
  if (!v || v.trim() === 'auto') return false
  const m = /rect\(([^)]*)\)/.exec(v)
  if (!m) return true
  return m[1].split(/[ ,]+/).some((x) => x && x !== 'auto' && Number.parseFloat(x) !== 0)
}

/** Resolves an xlink:href in a part to a file in the package, or undefined for an outside link. */
export function odfTarget(part: string, href: string, names: Set<string>): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('/')) return undefined
  let h = href.replace(/^(\.\/)+/, '')
  try {
    h = decodeURIComponent(h)
  } catch {
    // Kept as written.
  }
  const dir = part.includes('/') ? part.slice(0, part.lastIndexOf('/') + 1) : ''
  if (dir && names.has(dir + h)) return dir + h
  return names.has(h) ? h : undefined
}

function placeOdf(pkg: Package): Placed {
  const names = new Set(pkg.entries.map((e) => e.name))
  let unread = 0
  const pictures = new Map<string, Placement>()
  for (const e of pkg.entries) if (/(^|\/)Pictures\/[^/]+$/.test(e.name)) pictures.set(e.name, newPlacement())
  const docs = new Map<string, Document>()
  for (const e of pkg.entries) {
    if (!/(^|\/)(content|styles)\.xml$/.test(e.name) || e.name.startsWith('META-INF/') || !e.usize) continue
    try {
      docs.set(e.name, parseXmlBytes(readEntry(pkg, e)))
    } catch {
      unread++
    }
  }
  if (unread) for (const p of pictures.values()) p.unsized = true

  // Graphic styles by name, from the part's own automatic styles and styles.xml.
  const styles = new Map<string, Map<string, Element>>()
  const stylesIn = (part: string) => {
    let m = styles.get(part)
    if (m) return m
    m = new Map()
    const dir = part.slice(0, part.lastIndexOf('/') + 1)
    for (const name of [dir + 'styles.xml', part]) {
      const d = docs.get(name)
      if (!d) continue
      for (const el of allElements(d.documentElement!)) {
        if (el.namespaceURI === NS.style && el.localName === 'style') m.set(el.getAttributeNS(NS.style, 'name') ?? '', el)
      }
    }
    styles.set(part, m)
    return m
  }
  const clipped = (part: string, frame: Element): boolean => {
    const m = stylesIn(part)
    for (const attr of [
      [NS.draw, 'style-name'],
      ['urn:oasis:names:tc:opendocument:xmlns:presentation:1.0', 'style-name'],
    ]) {
      let name = frame.getAttributeNS(attr[0], attr[1])
      for (let depth = 0; name && depth < 8; depth++) {
        const s = m.get(name)
        if (!s) break
        const g = children(s).find((c) => c.localName === 'graphic-properties')
        if (g && clips(g.getAttributeNS(NS.fo, 'clip'))) return true
        name = s.getAttributeNS(NS.style, 'parent-style-name')
      }
    }
    return false
  }

  let page: Shown | undefined
  const st = docs.get('styles.xml')
  if (st) {
    for (const el of allElements(st.documentElement!)) {
      if (el.namespaceURI !== NS.style || el.localName !== 'page-layout-properties') continue
      const w = odfInches(el.getAttributeNS(NS.fo, 'page-width'))
      const h = odfInches(el.getAttributeNS(NS.fo, 'page-height'))
      if (w && h) page = { w: Math.max(page?.w ?? 0, w), h: Math.max(page?.h ?? 0, h) }
    }
  }
  page ??= LETTER

  for (const [part, d] of docs) {
    const top = !part.includes('/')
    let slide = 0
    for (const el of allElements(d.documentElement!)) {
      if (el.namespaceURI === NS.draw && el.localName === 'page') slide++
      const href = el.getAttributeNS(XLINK, 'href')
      const target = href ? odfTarget(part, href, names) : undefined
      const p = target && pictures.get(target)
      if (!p) continue
      let use: Use = 'unsized'
      if (el.namespaceURI === NS.draw && el.localName === 'image') {
        const frame = parent(el)
        const w = frame && odfInches(frame.getAttributeNS(NS.svg, 'width'))
        const h = frame && odfInches(frame.getAttributeNS(NS.svg, 'height'))
        if (frame && clipped(part, frame)) use = 'clipped'
        else if (w && h) use = { size: { w, h } }
      } else if (el.localName === 'fill-image' || el.localName === 'background-image') use = 'fill'
      const place = !top ? 'embedded object' : part === 'styles.xml' ? 'page style' : slide ? `slide ${slide}` : 'document'
      record(p, use, place)
    }
  }
  settle(pictures)
  return { pictures, page, unread }
}

export function placements(pkg: Package, family: Family): Placed {
  return family === 'ooxml' ? placeOoxml(pkg) : placeOdf(pkg)
}
