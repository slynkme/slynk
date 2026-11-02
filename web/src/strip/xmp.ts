// XMP (Adobe's XML metadata) helpers: what a packet reveals, for the report,
// and whether it holds nothing but HDR gain-map parameters, which must stay
// for the picture to render in HDR.
import { LABEL } from './labels.ts'
import type { Found } from './types.ts'
import { MAX_FOUND, addFound } from './values.ts'

export const NS = {
  x: 'adobe:ns:meta/',
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  xml: 'http://www.w3.org/XML/1998/namespace',
  hdrgm: 'http://ns.adobe.com/hdr-gain-map/1.0/',
  container: 'http://ns.google.com/photos/1.0/container/',
  item: 'http://ns.google.com/photos/1.0/container/item/',
  appleGainMap: 'http://ns.apple.com/HDRGainMap/1.0/',
  applePixelInfo: 'http://ns.apple.com/pixeldatainfo/1.0/',
}

// Namespaces that carry only rendering parameters.
const RENDERING = new Set([NS.x, NS.rdf, NS.xml, NS.hdrgm, NS.container, NS.item, NS.appleGainMap, NS.applePixelInfo])

// Property names (prefix-free) and what they reveal. Prefixes vary between
// writers, so the local name plus a namespace hint is what's matched.
const RULES: [RegExp, string][] = [
  [/:GPS(Latitude|Longitude|Altitude|Position|DestLatitude|DestLongitude|ImgDirection|Speed|Track|AreaInformation|ProcessingMethod)\b/, LABEL.gps],
  [/\b(LocationCreated|LocationShown|GPano:)/, LABEL.gps],
  [/\btiff:(Make|Model)\b|\bexifEX:(CameraOwnerName)\b/, LABEL.camera],
  [/\b(aux|exifEX):Lens(Info|Model|ID|Make|Specification)?\b/, LABEL.lens],
  [/\b(aux:SerialNumber|exifEX:BodySerialNumber|exifEX:LensSerialNumber|exif:ImageUniqueID|aux:ImageNumber|xmpMM:(DocumentID|InstanceID|OriginalDocumentID))\b/, LABEL.serial],
  [/\b(xmp:CreateDate|photoshop:DateCreated|exif:DateTimeOriginal|exif:DateTimeDigitized)\b/, LABEL.dateTaken],
  [/\b(xmp:ModifyDate|xmp:MetadataDate|tiff:DateTime)\b/, LABEL.dates],
  [/\b(dc:creator|photoshop:AuthorsPosition|Iptc4xmpCore:CreatorContactInfo|tiff:Artist)\b/, LABEL.author],
  [/\b(dc:rights|xmpRights:\w+|photoshop:Credit|photoshop:Source)\b/, LABEL.copyright],
  [/\b(dc:title|dc:description|photoshop:Headline|photoshop:Instructions|exif:UserComment|tiff:ImageDescription)\b/, LABEL.description],
  [/\b(dc:subject|lr:hierarchicalSubject|MicrosoftPhoto:LastKeywordXMP|photoshop:Category|photoshop:SupplementalCategories)\b/, LABEL.keywords],
  [/\b(mwg-rs:Regions|MP:RegionInfo|MPRI:Regions|Iptc4xmpExt:PersonInImage|MP:RegionPersonDisplayName)\b/, LABEL.people],
  [/\b(xmp:CreatorTool|tiff:Software)\b/, LABEL.software],
  [/\b(xmpMM:(History|DerivedFrom|Ingredients|Pantry|PreservedFileName|Manifest)|photoshop:DocumentAncestors|crs:\w+|photoshop:TextLayers)\b/, LABEL.history],
  [/\b(GImage:Data|GDepth:Data|GDepth:Confidence)\b/, LABEL.extraImages],
  [/\b(exif|exifEX|aux):\w+/, LABEL.settings],
]

/** Plain-language labels for an XMP packet; empty if it only holds rendering parameters. */
export function xmpLabels(text: string): string[] {
  if (onlyRendering(text)) return []
  const labels = new Set<string>()
  for (const [re, label] of RULES) if (re.test(text)) labels.add(label)
  if (labels.size === 0) labels.add(LABEL.otherPhoto)
  return [...labels]
}

// Values come from the start of a packet only, and every pattern below is
// bounded, so a contrived packet can't make reading them slow. A shown value
// is cut to 80 characters anyway.
const VALUE_SCAN = 262_144

/** What the packet names as its authors and the software that made or edited the file, for the sender to see. */
export function xmpValues(text: string): Found[] {
  if (onlyRendering(text)) return []
  const t = text.length > VALUE_SCAN ? text.slice(0, VALUE_SCAN) : text
  const values: Found[] = []
  // dc:creator is a list: <dc:creator><rdf:Seq><rdf:li>Name</rdf:li>…
  for (const inner of contents(t, 'dc:creator')) {
    const names = [...inner.matchAll(/<rdf:li\b[^<>]{0,256}>([^<]{0,1024})<\/rdf:li\s*>/g)].map((li) => li[1])
    for (const v of names.length ? names : [inner.replace(/<[^<>]*>/g, ' ')]) {
      if (values.length >= MAX_FOUND) return values
      addFound(values, LABEL.author, unescapeXml(v))
    }
  }
  for (const name of ['xmp:CreatorTool', 'tiff:Software']) {
    for (const v of property(t, name)) {
      if (values.length >= MAX_FOUND) return values
      addFound(values, LABEL.software, v)
    }
  }
  return values
}

/** What's inside each <name …>…</name>, found by searching rather than by a pattern that could backtrack. */
function contents(text: string, name: string): string[] {
  const out: string[] = []
  const open = `<${name}`
  const close = `</${name}`
  for (let at = 0; ; ) {
    const start = text.indexOf(open, at)
    if (start === -1) return out
    // An unclosed one runs to the end (the text may have been cut short).
    const found = text.indexOf(close, start + open.length)
    const end = found === -1 ? text.length : found
    const tag = text.slice(start + open.length, end)
    const gt = tag.indexOf('>')
    // "<dc:creatorX" is another element, and "<dc:creator/>" is empty.
    if (gt > -1 && /^[\s>]/.test(tag) && tag[gt - 1] !== '/') out.push(tag.slice(gt + 1))
    if (found === -1) return out
    at = end + close.length
  }
}

/** A simple property's values, written either as an attribute or as an element. */
function property(text: string, name: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]{0,1024})"|'([^']{0,1024})')`, 'g'))) out.push(m[1] ?? m[2] ?? '')
  for (const m of text.matchAll(new RegExp(`<${name}(?:\\s[^<>]{0,256})?>([^<]{0,1024})</${name}\\s*>`, 'g'))) out.push(m[1])
  return out.map(unescapeXml)
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function unescapeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos);/gi, (whole, e: string) => {
    if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? whole
    const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
  })
}

/**
 * True when every element and attribute in the packet belongs to a rendering
 * namespace (gain-map parameters and the container directory). Anything we
 * can't account for counts as metadata, so unknown packets get removed.
 */
export function onlyRendering(text: string): boolean {
  return onlyNamespaces(text, RENDERING)
}

/** Namespaces that only identify a PDF/A or PDF/UA conformance level. */
export const PDF_ID = new Set([NS.x, NS.rdf, NS.xml, 'http://www.aiim.org/pdfa/ns/id/', 'http://www.aiim.org/pdfua/ns/id/'])

/** text without each open…close section (an unclosed one stays), in one pass. */
function cut(text: string, open: string, close: string): string {
  let out = ''
  for (let at = 0; ; ) {
    const start = text.indexOf(open, at)
    const end = start === -1 ? -1 : text.indexOf(close, start + open.length)
    if (end === -1) return out + text.slice(at)
    out += text.slice(at, start)
    at = end + close.length
  }
}

/** True when every element and attribute name in the packet is in an allowed namespace. */
export function onlyNamespaces(text: string, allowed: Set<string>): boolean {
  const prefixes = new Map<string, string>([['xml', NS.xml]])
  // Bounded, so an unclosed quote can't make this slow; a longer namespace name
  // isn't recognised, so its elements count as metadata.
  for (const m of text.matchAll(/xmlns:([\w.-]+)\s*=\s*("([^"]{0,2048})"|'([^']{0,2048})')/g)) prefixes.set(m[1], m[3] ?? m[4] ?? '')
  // Unprefixed names would need a default namespace; XMP never relies on one.
  const body = cut(cut(text, '<?', '?>'), '<!--', '-->')
  for (const m of body.matchAll(/<\/?([\w.-]+)(:[\w.-]+)?/g)) {
    if (!m[2]) return false
    const ns = prefixes.get(m[1])
    if (!ns || !allowed.has(ns)) return false
  }
  for (const m of body.matchAll(/\s([\w.-]+)(:[\w.-]+)?\s*=\s*["']/g)) {
    if (m[1] === 'xmlns') continue
    if (!m[2]) return false
    const ns = prefixes.get(m[1])
    if (!ns || !allowed.has(ns)) return false
  }
  return true
}
