// SVG drawings in the previews, drawn by the
// browser itself as a picture, from a data: address (the CSP allows data:
// pictures, not blob: ones). As a picture an SVG runs no scripts and fetches
// nothing, not even what it links to. Two things keep a crafted one from
// freezing the tab:
//   - it's read first (strip/svgscan.ts, strict and linear): one too big, too
//     many elements once every <use> and marker is counted for all it
//     repeats, or too many filters to lay out quickly, gets no preview
//   - the size it's drawn at is chosen from small trial drawings, timed: a
//     browser does the real drawing only when the pixels are needed, and a
//     drawing whose every pixel is slow (filters on filters) took 1.6 s at
//     512 pixels square, so it's drawn smaller, or not at all
// Drawn on white, as on a page, whatever the theme. Nothing is stored or sent.
import { photoInfo } from '../shrink/info.ts'
import type { Dims } from '../shrink/plan.ts'
import { detectKind } from '../strip/sniff.ts'
import { SVG_NS, XLINK_NS, scanSvg, startsAsSvg, toBase64, type SvgAttr, type SvgDoc, type SvgEl, type SvgHandler } from '../strip/svgscan.ts'

/** Larger files get no preview. */
const MAX_BYTES = 10_000_000
/** Elements in the file, at most: a browser lays out 100,000 in about a second, on the page's own thread. */
const MAX_ELEMENTS = 50_000
/**
 * What drawing it may cost, at most, counted in elements drawn: each <use> as all it repeats, a
 * marker at every point it's drawn, and a filter's steps and a line's dashes at their weights.
 */
const MAX_DRAWN = 250_000
/** A filter step applied to an element, against drawing an element. */
const FILTER_WEIGHT = 5
/** A dash, against drawing an element: a line dashed every hundredth of a unit is a million of them, at any size it's drawn. */
const DASH_WEIGHT = 0.2
/**
 * Pixels of the pictures embedded in it, all told, at most: each is unpacked whole, on the page's own
 * thread, as it's drawn, and a 200 KB PNG can be 13,000 pixels square (the review).
 */
const MAX_PIXELS = 24_000_000
/** An embedded picture whose size can't be read, at most this many bytes (all it could unpack to is then small). */
const MAX_UNSIZED = 512
/** Characters of text, at most. */
const MAX_TEXT = 500_000
/**
 * References in a chain, at most: a clip path clipped by another, and so on. A browser goes down such a
 * chain for each link, so its time grows with the chain's length squared (1,000 took 0.17 s).
 */
const MAX_CHAIN = 64
/** Drawings in drawings, one in another, at most. */
const MAX_NESTED = 2
/** How long it may take to load. */
const LOAD_MS = 4_000
/** How long its first small trial drawing may take: that's when it's laid out. */
const LAYOUT_MS = 800
/** How long drawing it may take, from the trial drawings. */
const DRAW_MS = 400

/** An SVG drawing, by its bytes. */
export function isSvgPicture(data: Uint8Array): boolean {
  try {
    return detectKind(data) === 'svg'
  } catch {
    return false
  }
}

const UNITS: Record<string, number> = { px: 1, pt: 4 / 3, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96 }

/** A length in CSS pixels, or undefined for none, a percentage, or one relative to text. */
function length(v: string | undefined): number | undefined {
  // A pattern like this one goes back over a long run of digits again and again (the review): none is that long.
  if (!v || v.length > 64) return undefined
  const m = /^\s*\+?((?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*(px|pt|pc|mm|cm|in)?\s*$/i.exec(v ?? '')
  if (!m) return undefined
  const n = parseFloat(m[1]) * UNITS[(m[2] ?? 'px').toLowerCase()]
  return n > 0 && Number.isFinite(n) ? n : undefined
}

/** A viewBox's width and height, if it has a usable one. */
function viewBox(v: string | undefined): Dims | undefined {
  const parts = (v ?? '').trim().split(/[\s,]+/)
  if (parts.length !== 4) return undefined
  const [, , w, h] = parts.map(Number)
  return w > 0 && h > 0 && Number.isFinite(w) && Number.isFinite(h) ? { width: w, height: h } : undefined
}

const NUMBER = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g

/** A path's d or a polyline's points: how many points, and a length no shorter than its outline's. */
function outline(s: string): { points: number; length: number } {
  let count = 0
  let length = 0
  let a = 0
  let b = 0
  for (const m of s.matchAll(NUMBER)) {
    const n = Math.abs(parseFloat(m[0]))
    // Each number as a step, and as the change from the one two before (x to x, y to y).
    length += n + Math.abs(n - a)
    a = b
    b = n
    count++
  }
  return { points: count / 2, length }
}

const num = (v: string | undefined) => Math.abs(parseFloat(v ?? '')) || 0

/** How many dashes a dash array draws per unit of line (0 for a solid line), or undefined for one that isn't valid. */
function dashDensity(v: string | undefined): number | undefined {
  if (v === undefined) return undefined
  if (/^\s*(none|inherit|initial|unset)\s*$/i.test(v)) return 0
  const parts = v.trim().split(/[\s,]+/).filter(Boolean)
  const values = parts.map((p) => parseFloat(p))
  if (!parts.length || values.some((n) => !(n >= 0))) return undefined
  const period = values.reduce((t, n) => t + n, 0) * (values.length % 2 ? 2 : 1)
  // A pattern too short to see: a browser draws it, every bit of it.
  return period > 0 ? (values.length % 2 ? values.length : values.length / 2) / period : 0
}

/** A property's value in a style attribute, if it sets it. */
function styleProp(style: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]*)`, 'i').exec(style)
  return m?.[1]
}

/** Steps of filtering a filter value asks for: those of each filter it names, and one for each function (blur(), drop-shadow()...). */
function filterSteps(value: string, steps: Map<string, number>): number {
  let n = 0
  // Its first 4 KB, as a long run of letters is gone over from each one: a real filter value is short.
  for (const m of value.slice(0, 4096).matchAll(/url\(\s*['"]?\s*#([^'")\s]+)|([a-z-]+)\(/gi)) n += m[1] !== undefined ? (steps.get(m[1]) ?? 0) : 1
  return n
}

/** A style sheet's rules setting a property: the simple selectors each applies to ("#id", ".class", a type, or "*" for any), and its value. */
function cssRules(css: string, prop: string): { keys: string[]; value: string }[] {
  // Without comments, found by searching: a pattern could go back over a long unclosed one.
  let plain = ''
  for (let at = 0; ; ) {
    const open = css.indexOf('/*', at)
    if (open < 0) {
      plain += css.slice(at)
      break
    }
    plain += css.slice(at, open) + ' '
    const close = css.indexOf('*/', open + 2)
    if (close < 0) break
    at = close + 2
  }
  const out: { keys: string[]; value: string }[] = []
  for (let at = 0; at < plain.length; ) {
    const brace = plain.indexOf('{', at)
    if (brace < 0) break
    const selector = plain.slice(at, brace).trim()
    // An at-rule's block (@media) holds rules of its own: read on inside it.
    if (selector.startsWith('@')) {
      at = brace + 1
      continue
    }
    const close = plain.indexOf('}', brace)
    const body = plain.slice(brace + 1, close < 0 ? plain.length : close)
    const value = styleProp(body, prop)
    if (value !== undefined) {
      const keys = selector.split(',').flatMap((one) => {
        // Its last part is what it styles: "g > .a:hover" styles .a.
        const last = one.trim().split(/[\s>+~]+/).pop() ?? ''
        const found = [...last.matchAll(/([#.])([\w-]+)/g)].map((m) => m[1] + m[2])
        const type = /^[a-zA-Z][\w-]*/.exec(last)?.[0]
        return found.length || type ? [...found, ...(type ? [type] : [])] : ['*']
      })
      out.push({ keys, value })
    }
    at = close < 0 ? plain.length : close + 1
  }
  return out
}

const attrOf = (doc: SvgDoc, el: SvgEl, local: string, ns = ''): string | undefined => {
  const a = el.attrs.find((x: SvgAttr) => x.local === local && x.ns === ns)
  return a && doc.value(a)
}
const hrefOf = (doc: SvgDoc, el: SvgEl) => attrOf(doc, el, 'href') ?? attrOf(doc, el, 'href', XLINK_NS)

const u32be = (b: Uint8Array, i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0

/**
 * A picture's size in pixels, from its header: a PNG's, GIF's or BMP's read directly (photoInfo gives
 * up on a PNG whose chunks it can't follow, which a browser might still unpack), the rest as photos' are.
 */
function pictureDims(b: Uint8Array): Dims | undefined {
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { width: u32be(b, 16), height: u32be(b, 20) }
  if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { width: b[6] | (b[7] << 8), height: b[8] | (b[9] << 8) }
  if (b.length >= 26 && b[0] === 0x42 && b[1] === 0x4d) {
    const d = new DataView(b.buffer, b.byteOffset, b.byteLength)
    return { width: Math.abs(d.getInt32(18, true)), height: Math.abs(d.getInt32(22, true)) }
  }
  return photoInfo(b)?.dims
}

/** A data: address's bytes (base64 or percent-encoded), and its type; null if it can't be read. */
function dataBytes(url: string): { type: string; bytes: Uint8Array } | null {
  const comma = url.indexOf(',')
  if (comma < 0) return null
  const head = url.slice(5, comma).toLowerCase()
  const body = url.slice(comma + 1)
  try {
    if (head.endsWith(';base64')) return { type: head, bytes: Uint8Array.from(atob(body.replace(/%([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))), (c) => c.charCodeAt(0)) }
    const raw = new TextEncoder().encode(body)
    const bytes: number[] = []
    for (let i = 0; i < raw.length; i++) {
      const hex = raw[i] === 0x25 && i + 2 < raw.length ? String.fromCharCode(raw[i + 1], raw[i + 2]) : ''
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16))
        i += 2
      } else bytes.push(raw[i])
    }
    return { type: head, bytes: Uint8Array.from(bytes) }
  } catch {
    return null
  }
}

class TooComplex extends Error {}

/** What reading it found: each element's parent, what it repeats, and what's costly to draw. */
class Reader {
  doc!: SvgDoc
  root: SvgEl | undefined
  depth: number
  parent: number[] = []
  /** The id each element repeats (<use>), if any. */
  uses: (string | undefined)[] = []
  /** What drawing each costs beyond itself (a drawing embedded in it, its dashes, its filters), in elements. */
  weight: number[] = []
  /** Each element's simple selectors ("*", its type, "#id", ".class"), and its outline's length, for the style sheet. */
  keys: string[][] = []
  lengths: number[] = []
  /** Each element's filter, and its dashes per unit, from its own attributes or its parents'. */
  filterOf: (string | undefined)[] = []
  /** The ids each element points to: url(#…) in its attributes and style, and a href="#…" (a gradient's, a <use>'s). */
  refs: string[][] = []
  ids = new Map<string, number>()
  markers: number[] = []
  /** Steps in each filter, by id. */
  steps = new Map<string, number>()
  /** Some element is given a marker; its lines' points. */
  marked = false
  points = 0
  /** Pixels of embedded pictures; characters of text; the style sheets' text; what the style sheets embed costs. */
  pixels = 0
  chars = 0
  css = ''
  extra = 0
  private stack: number[] = []
  private dashes: (number | undefined)[] = [] // dashes per unit, inherited
  private styles = 0 // <style> elements open
  private texts = 0 // <text> elements open
  private filter: string | undefined // the <filter> open, by id

  constructor(depth: number) {
    this.depth = depth
  }

  open(el: SvgEl) {
    const i = this.parent.length
    this.parent.push(this.stack.length ? this.stack[this.stack.length - 1] : -1)
    this.stack.push(i)
    this.root ??= el
    this.uses.push(undefined)
    this.weight.push(0)
    this.lengths.push(0)
    const id = attrOf(this.doc, el, 'id')
    if (id !== undefined && !this.ids.has(id)) this.ids.set(id, i)
    const classes = (attrOf(this.doc, el, 'class') ?? '').split(/\s+/).filter(Boolean).slice(0, 32)
    this.keys.push(['*', el.local, ...(id ? [`#${id}`] : []), ...classes.map((c) => `.${c}`)])
    if (el.local === 'style') this.styles++
    if (this.filter !== undefined) this.steps.set(this.filter, (this.steps.get(this.filter) ?? 0) + 1)
    const style = attrOf(this.doc, el, 'style') ?? ''
    this.filterOf.push(attrOf(this.doc, el, 'filter') ?? styleProp(style, 'filter'))
    const refs: string[] = []
    for (const a of el.attrs) {
      if (a.raw.includes('url(')) for (const m of this.doc.value(a).matchAll(/url\(\s*['"]?\s*#([^'")\s]{1,256})/g)) refs.push(m[1])
      else if (a.local === 'href' && a.raw.startsWith('#')) refs.push(this.doc.value(a).slice(1))
    }
    this.refs.push(refs)
    if (/marker/i.test(style) || el.attrs.some((a) => a.ns === '' && a.local.startsWith('marker'))) this.marked = true
    // Dashes, its own or its parents': a dash array is inherited.
    const own = dashDensity(attrOf(this.doc, el, 'stroke-dasharray') ?? styleProp(style, 'stroke-dasharray'))
    const dashes = own ?? this.dashes[this.dashes.length - 1]
    this.dashes.push(dashes)
    // A picture or drawing embedded anywhere in its attributes (an <image>'s or HTML's address, a style's url()).
    for (const a of el.attrs) if (/data:/i.test(a.raw)) this.embedded(this.doc.value(a), i, a.local === 'href' || a.local === 'src')
    if (el.ns !== SVG_NS) return
    if (el.local === 'text') this.texts++
    if (el.local === 'filter') this.filter = id ?? ''
    if (el.local === 'marker') this.markers.push(i)
    let line = 0
    if (el.local === 'path' || el.local === 'polyline' || el.local === 'polygon') {
      const o = outline(attrOf(this.doc, el, el.local === 'path' ? 'd' : 'points') ?? '')
      this.points += o.points
      line = o.length
    } else if (el.local === 'line') {
      this.points += 2
      line = Math.abs(num(attrOf(this.doc, el, 'x2')) - num(attrOf(this.doc, el, 'x1'))) + Math.abs(num(attrOf(this.doc, el, 'y2')) - num(attrOf(this.doc, el, 'y1')))
    } else if (el.local === 'rect') line = 2 * (num(attrOf(this.doc, el, 'width')) + num(attrOf(this.doc, el, 'height')))
    else if (el.local === 'circle') line = 2 * Math.PI * num(attrOf(this.doc, el, 'r'))
    else if (el.local === 'ellipse') line = 2 * Math.PI * Math.max(num(attrOf(this.doc, el, 'rx')), num(attrOf(this.doc, el, 'ry')))
    this.lengths[i] = line
    if (dashes) this.weight[i] += line * dashes * DASH_WEIGHT
    const href = el.local === 'use' ? hrefOf(this.doc, el) : undefined
    if (href?.startsWith('#')) this.uses[i] = href.slice(1)
  }

  /**
   * What a data: address costs: a picture, its pixels (unpacked whole as it's drawn); a drawing, what
   * drawing it costs. In a href or src the whole value is the address; elsewhere, each url(…).
   */
  private embedded(value: string, i: number, address: boolean) {
    const urls = address ? [value.trim()] : [...value.matchAll(/url\(\s*['"]?\s*(data:[^'")\s]*)/gi)].map((m) => m[1])
    for (const url of urls) {
      if (!/^data:/i.test(url)) continue
      const data = dataBytes(url)
      // Not an image (a font, say), or not one a browser could read.
      if (!data || !/^(image\/|;|$|application\/octet-stream)/.test(data.type)) continue
      if (startsAsSvg(data.bytes)) {
        if (this.depth >= MAX_NESTED) throw new TooComplex('drawings nested too deeply')
        const inner = read(data.bytes, this.depth + 1)
        if (i >= 0) this.weight[i] += inner.drawn
        else this.extra += inner.drawn
        this.pixels += inner.reader.pixels
        continue
      }
      const dims = pictureDims(data.bytes)
      if (dims) this.pixels += dims.width * dims.height
      else if (data.bytes.length > MAX_UNSIZED) throw new TooComplex('an embedded picture whose size can’t be read')
    }
  }

  close(el: SvgEl) {
    this.stack.pop()
    this.dashes.pop()
    if (el.local === 'style') this.styles--
    if (el.ns !== SVG_NS) return
    if (el.local === 'text') this.texts--
    if (el.local === 'filter') this.filter = undefined
  }

  text(from: number, to: number) {
    if (this.styles) this.css += this.doc.decode(from, to)
    else if (this.texts) this.chars += to - from
  }

  /** Once it's all read: filters and dashes, given by attributes or by the style sheet, weighed on the elements they apply to. */
  finish() {
    // The most each selector could give: one rule wins for an element, but which isn't worked out here.
    const most = (prop: string, cost: (value: string) => number) => {
      const byKey = new Map<string, number>()
      for (const r of cssRules(this.css, prop)) {
        const c = cost(r.value)
        for (const k of r.keys) byKey.set(k, Math.max(byKey.get(k) ?? 0, c))
      }
      return (keys: string[]) => keys.reduce((m, k) => Math.max(m, byKey.get(k) ?? 0), 0)
    }
    const cssSteps = most('filter', (v) => filterSteps(v, this.steps))
    const cssDashes = most('stroke-dasharray', (v) => dashDensity(v) ?? 0)
    // References a style sheet gives, by the selectors they apply to.
    const cssRefs = new Map<string, string[]>()
    for (const prop of ['clip-path', 'mask', 'filter', 'fill', 'stroke', 'marker', 'marker-start', 'marker-mid', 'marker-end'])
      for (const r of cssRules(this.css, prop))
        for (const m of r.value.slice(0, 4096).matchAll(/url\(\s*['"]?\s*#([^'")\s]{1,256})/g))
          for (const k of r.keys) (cssRefs.get(k) ?? cssRefs.set(k, []).get(k)!).push(m[1])
    if (cssRefs.size) for (let i = 0; i < this.parent.length; i++) for (const k of this.keys[i]) this.refs[i].push(...(cssRefs.get(k) ?? []).slice(0, 64))
    for (let i = 0; i < this.parent.length; i++) {
      const own = this.filterOf[i] === undefined ? 0 : filterSteps(this.filterOf[i]!, this.steps)
      this.weight[i] += Math.max(own, cssSteps(this.keys[i])) * FILTER_WEIGHT
      if (this.lengths[i]) this.weight[i] += this.lengths[i] * cssDashes(this.keys[i]) * DASH_WEIGHT
    }
    this.embedded(this.css, -1, false)
  }
}

/** What drawing it costs, in elements, each <use> counted as all it repeats. Throws TooComplex past MAX_DRAWN or for a <use> that repeats itself. */
function drawnCount(r: Reader): number {
  const n = r.parent.length
  const kids: number[][] = Array.from({ length: n }, () => [])
  for (let i = 1; i < n; i++) if (r.parent[i] >= 0) kids[r.parent[i]].push(i)
  const memo = new Float64Array(n).fill(-1)
  const busy = new Uint8Array(n)
  const count = (i: number): number => {
    if (memo[i] >= 0) return memo[i]
    if (busy[i]) throw new TooComplex('a <use> that repeats itself')
    busy[i] = 1
    let c = 1 + r.weight[i]
    for (const k of kids[i]) c += count(k)
    const target = r.uses[i] === undefined ? undefined : r.ids.get(r.uses[i]!)
    if (target !== undefined) c += count(target)
    // Not a number (an outline of 1e999 units, dashed) counts as too much.
    if (!(c <= MAX_DRAWN)) throw new TooComplex('too costly to draw')
    busy[i] = 0
    memo[i] = c
    return c
  }
  let drawn = count(0) + r.extra
  // A marker is drawn at every point of a line that has one: all of them, in the worst case.
  if (r.markers.length && (r.marked || /marker/i.test(r.css))) drawn += r.points * Math.max(...r.markers.map(count))
  if (!(drawn <= MAX_DRAWN)) throw new TooComplex('too costly to draw')
  return drawn
}

/** Throws TooComplex for a chain of references longer than MAX_CHAIN, or one that comes back on itself. */
function checkChains(r: Reader) {
  const n = r.parent.length
  const kids: number[][] = Array.from({ length: n }, () => [])
  for (let i = 1; i < n; i++) if (r.parent[i] >= 0) kids[r.parent[i]].push(i)
  const memo = new Int32Array(n).fill(-1)
  const busy = new Uint8Array(n)
  // The longest chain from an element: through what it holds, or one more through what it points to.
  const depth = (i: number): number => {
    if (memo[i] >= 0) return memo[i]
    if (busy[i]) throw new TooComplex('references that come back on themselves')
    busy[i] = 1
    let d = 0
    for (const k of kids[i]) d = Math.max(d, depth(k))
    for (const id of r.refs[i]) {
      const t = r.ids.get(id)
      if (t !== undefined) d = Math.max(d, 1 + depth(t))
    }
    if (d > MAX_CHAIN) throw new TooComplex('references chained too long')
    busy[i] = 0
    memo[i] = d
    return d
  }
  depth(0)
}

/** Reads a drawing and counts what drawing it costs; throws (SvgUnreadable or TooComplex) for one to leave undrawn. */
function read(bytes: Uint8Array, depth: number): { reader: Reader; drawn: number } {
  if (bytes.length > MAX_BYTES) throw new TooComplex('too big')
  const reader = new Reader(depth)
  const handler: SvgHandler = {
    begin: (doc) => (reader.doc = doc),
    open: (el) => reader.open(el),
    close: (el) => reader.close(el),
    text: (from, to) => reader.text(from, to),
    cdata: (from, to) => reader.text(from, to),
  }
  scanSvg(bytes, handler, { elements: MAX_ELEMENTS })
  if (reader.chars > MAX_TEXT) throw new TooComplex('too much text')
  reader.finish()
  if (!(reader.pixels <= MAX_PIXELS)) throw new TooComplex('embedded pictures too big')
  checkChains(reader)
  return { reader, drawn: drawnCount(reader) }
}

/** A drawing ready to draw: the picture, and its own size in CSS pixels (its shape). */
export interface SvgPicture {
  img: HTMLImageElement
  own: Dims
}

/**
 * Its own size: its width and height, or what its viewBox gives for a missing one, or a browser's
 * 300 × 150 for a drawing with neither. A copy for the preview is given that size outright, as some
 * browsers can't draw a picture with no size of its own on a canvas.
 */
function sized(bytes: Uint8Array, doc: SvgDoc, root: SvgEl): { bytes: Uint8Array; own: Dims } {
  const w = length(attrOf(doc, root, 'width'))
  const h = length(attrOf(doc, root, 'height'))
  const box = viewBox(attrOf(doc, root, 'viewBox'))
  let own: Dims
  if (w && h) return { bytes, own: { width: w, height: h } }
  if (box) own = w ? { width: w, height: (w * box.height) / box.width } : h ? { width: (h * box.width) / box.height, height: h } : box
  else own = { width: w ?? 300, height: h ?? 150 }
  // Its width and height replaced with these, right after its name.
  const cuts = root.attrs.filter((a) => a.ns === '' && (a.local === 'width' || a.local === 'height')).sort((a, b) => a.from - b.from)
  const added = new TextEncoder().encode(` width="${own.width}" height="${own.height}"`)
  const parts: Uint8Array[] = [bytes.subarray(0, root.nameEnd), added]
  let at = root.nameEnd
  for (const a of cuts) {
    parts.push(bytes.subarray(at, a.from))
    at = a.valueEnd + 1
  }
  parts.push(bytes.subarray(at))
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let i = 0
  for (const p of parts) {
    out.set(p, i)
    i += p.length
  }
  return { bytes: out, own }
}

/** The copy of a drawing to load, and its own size; null for one to leave undrawn (too costly, or unreadable). */
export function prepareSvg(data: Uint8Array): { bytes: Uint8Array; own: Dims } | null {
  try {
    const { reader } = read(data, 0)
    return sized(data, reader.doc, reader.root!)
  } catch {
    return null // unreadable, too costly, or a stack too deep counting what it repeats
  }
}

/** The drawing loaded as a picture, or null if it's too costly to draw, can't be read, or doesn't load in time. */
export async function openSvg(data: Uint8Array): Promise<SvgPicture | null> {
  const picture = prepareSvg(data)
  if (!picture) return null
  const img = new Image()
  const loaded = await new Promise<boolean>((resolve) => {
    const done = (ok: boolean) => {
      clearTimeout(timer)
      img.onload = img.onerror = null
      resolve(ok)
    }
    const timer = setTimeout(() => done(false), LOAD_MS)
    img.onload = () => done(true)
    img.onerror = () => done(false)
    img.src = `data:image/svg+xml;base64,${toBase64(picture.bytes)}`
  })
  if (!loaded) {
    closeSvg({ img, own: picture.own })
    return null
  }
  return { img, own: picture.own }
}

/** Lets go of the picture. */
export function closeSvg(p: SvgPicture) {
  p.img.removeAttribute('src')
}

/** Its shape, scaled so its longer side is edge. */
function scaled(d: Dims, edge: number): Dims {
  const s = edge / Math.max(d.width, d.height)
  return { width: Math.max(1, Math.round(d.width * s)), height: Math.max(1, Math.round(d.height * s)) }
}

/** How long drawing it at this size takes: drawn and read back, which is when the browser really draws it. */
function timeDraw(img: HTMLImageElement, at: Dims): number {
  const c = document.createElement('canvas')
  c.width = at.width
  c.height = at.height
  const ctx = c.getContext('2d', { willReadFrequently: true })
  if (!ctx) return Infinity
  const t = performance.now()
  ctx.drawImage(img, 0, 0, at.width, at.height)
  try {
    ctx.getImageData(0, 0, 1, 1)
  } catch {
    // A browser that won't let a page read some drawings back (one with HTML in it) has still drawn it.
  }
  const ms = performance.now() - t
  c.width = c.height = 0
  return ms
}

/** A moment for the page to draw and answer taps, between trial drawings. */
const breather = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/**
 * The size to draw it at: edge on its longer side if trial drawings say it can be drawn that big in
 * DRAW_MS, or as big as they say it can, or null if even a small one is too slow. The trials double in
 * size. Of each one's time, the part that grows with its pixels is told from the part that doesn't
 * (laying out many elements, which costs the same at any size: taking it all as growing drew such
 * drawings blurred, the review) by the trial before: what grows with pixels grows at least in step with
 * them. That part is reckoned to grow faster than its pixels do, as a filter that spreads by a number of
 * pixels does, so no trial takes much over DRAW_MS, and nor does the drawing.
 */
export async function drawSize(p: SvgPicture, edge: number): Promise<Dims | null> {
  const want = scaled(p.own, edge)
  const pixels = (d: Dims) => d.width * d.height
  let at = scaled(p.own, Math.min(16, edge))
  // The first drawing lays it out too.
  if (timeDraw(p.img, at) > LAYOUT_MS) return null
  let ms = timeDraw(p.img, at)
  if (ms > DRAW_MS) return null
  let fixed = 0 // the part of ms that doesn't grow with pixels, as far as the trials show
  const reckon = (d: Dims) => fixed + (ms - fixed) * Math.pow(pixels(d) / pixels(at), 1.5)
  for (;;) {
    if (reckon(want) <= DRAW_MS) return want
    const next = scaled(p.own, Math.max(at.width, at.height) * 2)
    if (pixels(next) >= pixels(want) || pixels(next) <= pixels(at) || reckon(next) > DRAW_MS) break
    await breather()
    const before = { at, ms }
    at = next
    ms = timeDraw(p.img, at)
    // Growing at least in step with pixels, it's no more than this (and a millisecond for the clock).
    const ratio = pixels(at) / pixels(before.at)
    fixed = ms - Math.min(ms, (Math.max(0, ms - before.ms) * ratio) / (ratio - 1) + 1)
  }
  // As big as can be drawn in time, by the same reckoning: the part that grows, as the side cubed.
  const room = (DRAW_MS - fixed) / Math.max(ms - fixed, 0.01)
  const side = Math.floor(Math.max(at.width, at.height) * Math.cbrt(Math.max(room, 0)))
  return scaled(p.own, Math.max(16, Math.min(edge, side)))
}
