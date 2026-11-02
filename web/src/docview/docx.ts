// A Word document's text, for the preview, from
// its word/document.xml: paragraphs and tables, with bold, italic, underline,
// strikethrough, raised and lowered text, sizes, alignment and indents, as set
// on the text or by its styles (styles.xml), and lists with their bullets and
// numbers counted as Word counts them (numbering.xml). Inserted tracked
// changes show; deleted ones don't, nor field codes (their results show),
// hidden text, or the text in drawings and text boxes. Headers, footers,
// footnotes and comments are in other parts, which aren't read. Pictures,
// charts and embedded objects are counted. Colours, fonts and page layout
// aren't kept: it's a simplified preview.
import { resolveTarget } from '../strip/zip.ts'
import { DocBuilder, type Format, type ParaProps } from './builder.ts'
import { MAX_DOC_CHARS, SYMBOL, type Align, type DocText } from './model.ts'
import { formatNumber } from './numbers.ts'
import { TreeBuilder, attrOf, kidOf, kidsOf, parseTree, scanXml, type XmlEl, type XmlNode, type XmlReader } from './xmlscan.ts'
import { Package, SIDE_CAP, mainCap } from './zipread.ts'

// "Strict Open XML" files use other namespace names for the same markup.
const W = ['http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'http://purl.oclc.org/ooxml/wordprocessingml/main']
const M = ['http://schemas.openxmlformats.org/officeDocument/2006/math', 'http://purl.oclc.org/ooxml/officeDocument/math']
const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006'
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
const XML_NS = 'http://www.w3.org/XML/1998/namespace'
const isW = (ns: string) => ns === W[0] || ns === W[1]

/** A drawing that's only a shape, a group of them or a text box: not a picture. */
const SHAPES = /\/wordprocessing(Shape|Group|Canvas)$/

/** Formatting as a style or the text says it: what isn't said is left to what's under it. */
interface RProps {
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  dstrike?: boolean
  vert?: 'sup' | 'sub' | 'base'
  size?: number
  hidden?: boolean
  /** In the Symbol font: its letters are Greek and maths. */
  symbol?: boolean
}

interface PProps {
  align?: Align
  indent?: number
  numId?: number
  ilvl?: number
  /** The paragraph's end is a deleted tracked change, or hidden: it runs on into the next. */
  joined?: boolean
}

/** An attribute of a Word element: in its own namespace, as Word writes them, or in none. */
const wAttr = (el: XmlEl, name: string) => attrOf(el, el.ns, name) ?? attrOf(el, '', name)
const val = (el: XmlEl | undefined) => (el ? wAttr(el, 'val') : undefined)
const int = (s: string | undefined) => {
  const n = s === undefined ? NaN : parseInt(s, 10)
  return Number.isFinite(n) ? n : undefined
}
/** Word's on/off properties: on unless they say otherwise. */
const isOn = (s: string | undefined) => !/^(0|false|off)$/i.test(s ?? '')
const on = (el: XmlEl) => isOn(val(el))

const ALIGN: Record<string, Align> = {
  left: 'left',
  start: 'left',
  center: 'center',
  right: 'right',
  end: 'right',
  both: 'justify',
  distribute: 'justify',
  thaiDistribute: 'justify',
  lowKashida: 'justify',
  mediumKashida: 'justify',
  highKashida: 'justify',
}

/** A w:rPr's formatting, and the character style it names. */
function rPrOf(node: XmlNode | undefined): { r: RProps; style?: string } {
  const r: RProps = {}
  let style: string | undefined
  for (const k of node?.kids ?? []) {
    if (!isW(k.ns)) continue
    switch (k.name) {
      case 'b':
        r.bold = on(k)
        break
      case 'i':
        r.italic = on(k)
        break
      case 'u':
        r.underline = (val(k) ?? 'single') !== 'none'
        break
      case 'strike':
        r.strike = on(k)
        break
      case 'dstrike':
        r.dstrike = on(k)
        break
      case 'vertAlign': {
        const v = val(k)
        r.vert = v === 'superscript' ? 'sup' : v === 'subscript' ? 'sub' : 'base'
        break
      }
      case 'sz': {
        const n = int(val(k))
        if (n !== undefined && n > 0 && n <= 3276) r.size = n / 2
        break
      }
      case 'vanish':
      case 'specVanish':
        r.hidden = on(k)
        break
      case 'rStyle':
        style = val(k)
        break
      case 'rFonts': {
        const font = wAttr(k, 'ascii') ?? wAttr(k, 'hAnsi')
        if (font !== undefined) r.symbol = /^symbol$/i.test(font)
        break
      }
    }
  }
  return { r, style }
}

/** A w:pPr's properties, and the paragraph style it names. */
function pPrOf(node: XmlNode | undefined): { p: PProps; style?: string; mark?: RProps } {
  const p: PProps = {}
  let style: string | undefined
  let mark: RProps | undefined
  for (const k of node?.kids ?? []) {
    if (!isW(k.ns)) continue
    switch (k.name) {
      case 'pStyle':
        style = val(k)
        break
      case 'jc': {
        const a = ALIGN[val(k) ?? '']
        if (a) p.align = a
        break
      }
      case 'ind': {
        const left = firstLine(k)
        if (left !== undefined) p.indent = left
        break
      }
      case 'numPr': {
        const ilvl = int(val(kidOf(k, W, 'ilvl')))
        const numId = int(val(kidOf(k, W, 'numId')))
        if (ilvl !== undefined) p.ilvl = Math.min(8, Math.max(0, ilvl))
        if (numId !== undefined) p.numId = numId
        break
      }
      case 'rPr':
        // The paragraph mark's own formatting: the list number's, and whether it's deleted or hidden.
        mark = rPrOf(k).r
        if (k.kids.some((m) => isW(m.ns) && (m.name === 'del' || m.name === 'moveFrom' || ((m.name === 'vanish' || m.name === 'specVanish') && on(m))))) p.joined = true
        break
    }
  }
  return { p, style, mark }
}

/** Where a w:ind puts a paragraph's first line, in points: its left indent less any hanging one (a list's bullet sits there). */
function firstLine(ind: XmlNode): number | undefined {
  const left = int(wAttr(ind, 'left') ?? wAttr(ind, 'start'))
  return left === undefined ? undefined : Math.max(0, left - Math.max(0, int(wAttr(ind, 'hanging')) ?? 0)) / 20
}

interface Resolved {
  r: RProps
  p: PProps
}

/** Word's styles (styles.xml): each one's formatting with all it's based on. */
class Styles {
  private styles = new Map<string, { type: string; basedOn?: string; r: RProps; p: PProps }>()
  private resolved = new Map<string, Resolved>()
  defaults: Resolved
  defaultPara: string | undefined
  defaultChar: string | undefined

  constructor(root: XmlNode | undefined) {
    const dd = kidOf(root, W, 'docDefaults')
    this.defaults = { r: rPrOf(kidOf(kidOf(dd, W, 'rPrDefault'), W, 'rPr')).r, p: pPrOf(kidOf(kidOf(dd, W, 'pPrDefault'), W, 'pPr')).p }
    for (const s of kidsOf(root, W, 'style')) {
      const id = wAttr(s, 'styleId')
      if (id === undefined || this.styles.has(id)) continue
      const type = wAttr(s, 'type') ?? 'paragraph'
      this.styles.set(id, { type, basedOn: val(kidOf(s, W, 'basedOn')), r: rPrOf(kidOf(s, W, 'rPr')).r, p: pPrOf(kidOf(s, W, 'pPr')).p })
      const def = wAttr(s, 'default')
      if (def !== undefined && isOn(def)) {
        if (type === 'paragraph') this.defaultPara ??= id
        else if (type === 'character') this.defaultChar ??= id
      }
    }
  }

  has(id: string | undefined, type: string): id is string {
    return id !== undefined && this.styles.get(id)?.type === type
  }

  /** A style's formatting with all it's based on, its own last; nothing for one that isn't there. */
  get(id: string | undefined, type: string): Resolved {
    if (!this.has(id, type)) return { r: {}, p: {} }
    const key = `${type} ${id}`
    let got = this.resolved.get(key)
    if (got) return got
    const chain = []
    const seen = new Set<string>()
    for (let at: string | undefined = id; this.has(at, type) && !seen.has(at) && chain.length < 32; at = this.styles.get(at)!.basedOn) {
      seen.add(at)
      chain.unshift(this.styles.get(at)!)
    }
    got = { r: {}, p: {} }
    for (const s of chain) got = { r: { ...got.r, ...s.r }, p: { ...got.p, ...s.p } }
    this.resolved.set(key, got)
    return got
  }
}

interface Level {
  fmt: string
  text: string
  start: number
  indent?: number
  suff: string
}

function levelOf(l: XmlNode): Level {
  const v = (name: string) => val(kidOf(l, W, name))
  const ind = kidOf(kidOf(l, W, 'pPr'), W, 'ind')
  const left = ind && firstLine(ind)
  return {
    fmt: v('numFmt') ?? 'decimal',
    text: (v('lvlText') ?? '').slice(0, 50),
    start: Math.max(0, Math.min(1e6, int(v('start')) ?? 0)),
    indent: left,
    suff: v('suff') ?? 'tab',
  }
}

const levelNo = (el: XmlEl) => {
  const n = int(wAttr(el, 'ilvl'))
  return n !== undefined && n >= 0 && n <= 8 ? n : undefined
}

/** Word's list numbering (numbering.xml): each list's levels, and the counts so far, as Word keeps them. */
class Numbering {
  private abstracts = new Map<number, { levels: Map<number, Level>; link?: string }>()
  private nums = new Map<number, { abs: number; starts: Map<number, number>; levels: Map<number, Level> }>()
  private counters = new Map<number, number[]>()
  private begun = new Set<number>()
  private styles: Styles

  constructor(root: XmlNode | undefined, styles: Styles) {
    this.styles = styles
    for (const a of kidsOf(root, W, 'abstractNum')) {
      const id = int(wAttr(a, 'abstractNumId'))
      if (id === undefined || this.abstracts.has(id)) continue
      const levels = new Map<number, Level>()
      for (const l of kidsOf(a, W, 'lvl')) {
        const k = levelNo(l)
        if (k !== undefined && !levels.has(k)) levels.set(k, levelOf(l))
      }
      this.abstracts.set(id, { levels, link: val(kidOf(a, W, 'numStyleLink')) })
    }
    for (const n of kidsOf(root, W, 'num')) {
      const id = int(wAttr(n, 'numId'))
      const abs = int(val(kidOf(n, W, 'abstractNumId')))
      if (id === undefined || abs === undefined || this.nums.has(id)) continue
      const starts = new Map<number, number>()
      const levels = new Map<number, Level>()
      for (const o of kidsOf(n, W, 'lvlOverride')) {
        const k = levelNo(o)
        if (k === undefined) continue
        const start = int(val(kidOf(o, W, 'startOverride')))
        if (start !== undefined) starts.set(k, Math.max(0, Math.min(1e6, start)))
        const lvl = kidOf(o, W, 'lvl')
        if (lvl) levels.set(k, levelOf(lvl))
      }
      this.nums.set(id, { abs, starts, levels })
    }
  }

  /** The bullet or number of a list item at this level, with what follows it, and its indent; undefined if it has none. */
  label(numId: number, ilvl: number): { text: string; indent?: number } | undefined {
    const num = this.nums.get(numId)
    if (!num) return undefined
    let absId = num.abs
    let abs = this.abstracts.get(absId)
    // A list that takes its levels from a list style: the style's own list, once.
    if (abs?.link) {
      const linked = this.nums.get(this.styles.get(abs.link, 'numbering').p.numId ?? -1)
      if (linked && this.abstracts.has(linked.abs)) abs = this.abstracts.get((absId = linked.abs))
    }
    const level = (k: number) => num.levels.get(k) ?? abs?.levels.get(k)
    // A level this list starts at a number of its own starts there whenever it starts again.
    const start = (k: number) => num.starts.get(k) ?? level(k)?.start ?? 1
    const lvl = level(ilvl)
    if (!lvl) return undefined
    let c = this.counters.get(absId)
    if (!c) this.counters.set(absId, (c = []))
    // A list told to start again at a number: from its first item.
    if (!this.begun.has(numId)) {
      this.begun.add(numId)
      for (const [k, start] of num.starts) c[k] = start - 1
    }
    c[ilvl] = (c[ilvl] ?? start(ilvl) - 1) + 1
    // Deeper levels start again under a new item.
    c.length = ilvl + 1
    const text =
      lvl.fmt === 'bullet'
        ? bullet(lvl.text)
        : lvl.text.replace(/%([1-9])/g, (_, d: string) => {
            const k = Number(d) - 1
            return formatNumber(c[k] ?? start(k), level(k)?.fmt ?? 'decimal')
          })
    return { text: text + (lvl.suff === 'space' ? ' ' : lvl.suff === 'nothing' ? '' : '\t'), indent: lvl.indent }
  }
}

/**
 * The Symbol font's characters, 0x20 to 0x7e and 0xa0 to 0xfe, as Unicode: Greek, maths and arrows,
 * which scientific documents write with it (the review: "α ± µ" showed as spaces). 0xf0 has none.
 */
const SYMBOL_LOW = ' !∀#∃%&∋()∗+,−./0123456789:;<=>?≅ΑΒΧΔΕΦΓΗΙϑΚΛΜΝΟΠΘΡΣΤΥςΩΞΨΖ[∴]⊥_‾αβχδεφγηιϕκλμνοπθρστυϖωξψζ{|}∼'
const SYMBOL_HIGH = '€ϒ′≤⁄∞ƒ♣♦♥♠↔←↑→↓°±″≥×∝∂•÷≠≡≈…⏐⎯↵ℵℑℜ℘⊗⊕∅∩∪⊃⊇⊄⊂⊆∈∉∠∇®©™∏√⋅¬∧∨⇔⇐⇑⇒⇓◊〈®©™∑⎛⎜⎝⎡⎢⎣⎧⎨⎩⎪ 〉∫⌠⎮⌡⎞⎟⎠⎤⎥⎦⎫⎬⎭'

/** A character in the Symbol font, as itself or as Word stores it (0xf000 up): '' for one it has none for. */
export function symbolFont(c: number): string {
  const b = c >= 0xf000 && c <= 0xf0ff ? c - 0xf000 : c
  if (b >= 0x20 && b <= 0x7e) return SYMBOL_LOW[b - 0x20]
  if (b >= 0xa0 && b <= 0xfe && b !== 0xf0) return SYMBOL_HIGH[b - 0xa0]
  return ''
}

/** A character in another symbol font (Wingdings), as the one it looks like; '' if it's none Slynk knows. */
function symbolOf(c: number): string {
  if (c >= 0xf000 && c <= 0xf0ff) return SYMBOL[c - 0xf000] ?? ''
  if (c >= 0xe000 && c <= 0xf8ff) return ''
  return SYMBOL[c] ?? (c > 0 && c <= 0x10ffff ? String.fromCodePoint(c) : '')
}

/** A bullet as written: a symbol font's as the one it looks like, and a plain one for any other. */
const bullet = (text: string) => (text ? symbolOf(text.codePointAt(0)!) || '•' : '•')

function toFormat(r: RProps): Format {
  const f: Format = {}
  if (r.bold) f.bold = true
  if (r.italic) f.italic = true
  if (r.underline) f.underline = true
  if (r.strike || r.dstrike) f.strike = true
  if (r.vert === 'sup') f.sup = true
  else if (r.vert === 'sub') f.sub = true
  if (r.size) f.size = r.size
  return f
}

// Passed over whole: deleted text, field codes, and properties that aren't text.
const SKIP = new Set([
  'del',
  'moveFrom',
  'delText',
  'instrText',
  'delInstrText',
  'sdtPr',
  'sdtEndPr',
  'sectPr',
  'tblPr',
  'tblGrid',
  'trPr',
  'tcPr',
  'tblPrEx',
  'customXmlPr',
  'smartTagPr',
  'altChunk',
  'subDoc',
  'background',
  // A ruby's reading, set small over its text in Word: the text alone shows, as in LibreOffice's.
  'rt',
  'rubyPr',
])
// Drawings, VML pictures and embedded objects: counted if they hold a picture, their text never shown.
const DRAWINGS = new Set(['drawing', 'pict', 'object'])

type Frame = 'none' | 'para' | 'run' | 'text' | 'table' | 'row' | 'cell' | 'alt'

interface Sub {
  kind: 'skip' | 'drawing' | 'props'
  /** Elements open in it, itself included. */
  depth: number
  picture?: boolean
  tree?: TreeBuilder
}

/** Goes through document.xml once, building the preview as it goes. */
class WordReader implements XmlReader {
  done = false
  private frames: Frame[] = []
  /** A subtree passed over, looked through for a picture, or kept to read whole (a paragraph's or run's properties). */
  private sub: Sub | undefined
  private para: { props: ParaProps; joined: boolean; base: RProps; continues: boolean } | undefined
  /** The last paragraph's end was deleted: the next is the rest of it. */
  private joinNext = false
  private run: Format | undefined
  private hidden = false
  private symbol = false
  private inText = false
  private preserve = false
  private fields: ('code' | 'result')[] = []
  private fieldsOver = 0
  private alt: boolean[] = []
  private b: DocBuilder
  private styles: Styles
  private numbering: Numbering

  constructor(b: DocBuilder, styles: Styles, numbering: Numbering) {
    this.b = b
    this.styles = styles
    this.numbering = numbering
  }

  /** A paragraph style's formatting over the document's defaults (the default style's, if it names none). */
  private paraStyle(id: string | undefined): Resolved {
    const s = this.styles.get(this.styles.has(id, 'paragraph') ? id : this.styles.defaultPara, 'paragraph')
    return { r: { ...this.styles.defaults.r, ...s.r }, p: { ...this.styles.defaults.p, ...s.p } }
  }

  open(el: XmlEl) {
    const sub = this.sub
    if (sub) {
      sub.depth++
      if (sub.kind === 'props') sub.tree!.open(el)
      else if (sub.kind === 'drawing' && !sub.picture)
        sub.picture = el.name === 'blip' || el.name === 'imagedata' || el.name === 'OLEObject' || (el.name === 'graphicData' && !SHAPES.test(attrOf(el, '', 'uri') ?? ''))
      return
    }
    let frame: Frame = 'none'
    const top = this.frames[this.frames.length - 1]
    if (isW(el.ns)) {
      const name = el.name
      // A row's properties say whether it's a deleted tracked change.
      if (name === 'trPr' && top === 'row') return this.begin('props', el)
      if (SKIP.has(name)) return this.begin('skip')
      if (DRAWINGS.has(name)) return this.begin('drawing', el, name === 'object')
      switch (name) {
        case 'p':
          this.startPara()
          frame = 'para'
          break
        case 'pPr':
          return this.begin(top === 'para' ? 'props' : 'skip', el)
        case 'r':
          this.run = this.runFormat(undefined)
          frame = 'run'
          break
        case 'rPr':
          return this.begin(top === 'run' ? 'props' : 'skip', el)
        case 't':
          frame = 'text'
          this.inText = true
          this.preserve = attrOf(el, XML_NS, 'space') === 'preserve'
          break
        case 'tab':
        case 'ptab':
          this.add('\t')
          break
        case 'br':
        case 'cr':
          this.add('\n')
          break
        case 'noBreakHyphen':
          this.add('‑')
          break
        case 'sym': {
          const c = parseInt(wAttr(el, 'char') ?? '', 16)
          this.add(/^symbol$/i.test(wAttr(el, 'font') ?? '') ? symbolFont(c) : symbolOf(c))
          break
        }
        case 'fldChar':
          this.field(wAttr(el, 'fldCharType'))
          break
        case 'tbl':
          this.b.startTable()
          frame = 'table'
          break
        case 'tr':
          this.b.startRow()
          frame = 'row'
          break
        case 'tc':
          this.b.startCell()
          frame = 'cell'
          break
      }
    } else if (el.ns === MC) {
      if (el.name === 'AlternateContent') {
        this.alt.push(false)
        frame = 'alt'
      } else if (el.name === 'Choice' || el.name === 'Fallback') {
        // The first of the alternatives is read, as Word reads it; the others say the same again.
        if (top !== 'alt' || this.alt[this.alt.length - 1]) return this.begin('skip')
        this.alt[this.alt.length - 1] = true
      }
    } else if (M.includes(el.ns)) {
      // An equation: its text, as it's written.
      if (el.name === 'r') {
        this.run = this.runFormat(undefined)
        frame = 'run'
      } else if (el.name === 't') {
        frame = 'text'
        this.inText = true
        this.preserve = true
      }
    }
    this.frames.push(frame)
  }

  private begin(kind: Sub['kind'], el?: XmlEl, picture = false) {
    this.sub = { kind, depth: 1, picture }
    if (kind === 'props') (this.sub.tree = new TreeBuilder()).open(el!)
  }

  close() {
    const sub = this.sub
    if (sub) {
      sub.tree?.close()
      if (--sub.depth) return
      this.sub = undefined
      if (sub.kind === 'drawing' && sub.picture) this.b.pictures++
      else if (sub.tree?.root?.name === 'pPr') this.paraProps(sub.tree.root)
      else if (sub.tree?.root?.name === 'trPr') this.rowProps(sub.tree.root)
      else if (sub.tree?.root) this.runProps(sub.tree.root)
      return
    }
    switch (this.frames.pop()) {
      case 'para':
        this.endPara()
        break
      case 'run':
        this.run = undefined
        this.hidden = this.symbol = false
        break
      case 'text':
        this.inText = false
        break
      case 'table':
        this.b.endTable()
        break
      case 'row':
        this.b.endRow()
        break
      case 'cell':
        this.b.endCell()
        break
      case 'alt':
        this.alt.pop()
        break
    }
    if (this.b.cut) this.done = true
  }

  text(s: string) {
    if (!this.inText || this.sub) return
    // Without xml:space="preserve", Word drops the spaces at a piece of text's ends.
    if (!this.preserve) s = s.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '')
    s = s.replace(/[\r\n]+/g, ' ')
    // Text in the Symbol font: its letters as the Greek and maths they show as.
    if (this.symbol) s = s.replace(/[\u0020-\u00ff\uf020-\uf0ff]/g, (ch) => symbolFont(ch.charCodeAt(0)))
    this.add(s)
  }

  private add(s: string) {
    if (!s || this.hidden || this.fields.includes('code')) return
    this.b.text(s, this.run ?? toFormat(this.para?.base ?? this.paraStyle(undefined).r))
    if (this.b.cut) this.done = true
  }

  private field(type: string | undefined) {
    if (type === 'begin') {
      if (this.fields.length < 64) this.fields.push('code')
      else this.fieldsOver++
    } else if (type === 'separate') {
      if (!this.fieldsOver && this.fields.length) this.fields[this.fields.length - 1] = 'result'
    } else if (type === 'end') {
      if (this.fieldsOver) this.fieldsOver--
      else this.fields.pop()
    }
  }

  private startPara() {
    // A paragraph inside another (only in damaged files): the first ends there.
    if (this.para) this.endPara()
    const base = this.paraStyle(undefined)
    this.para = { props: paraProps(base.p, {}), joined: false, base: base.r, continues: this.joinNext }
    this.joinNext = false
  }

  private paraProps(node: XmlNode) {
    if (!this.para) return
    const { p: direct, style, mark } = pPrOf(node)
    const base = this.paraStyle(style)
    const numId = direct.numId ?? base.p.numId
    // The rest of a paragraph whose end was deleted isn't an item of its own: no number, none counted.
    const continues = this.para.continues
    const label = numId && !continues ? this.numbering.label(numId, direct.ilvl ?? base.p.ilvl ?? 0) : undefined
    this.para = { props: paraProps(base.p, direct, label?.indent), joined: !!direct.joined, base: base.r, continues }
    // The bullet or number in the weight, slant and size of the paragraph's end, as Word shows it;
    // underlined or struck through, a bullet only looks like a mistake.
    if (label?.text.trim() && !base.r.hidden) {
      const { bold, italic, size } = { ...base.r, ...mark }
      this.b.text(label.text, toFormat({ bold, italic, size }))
    }
  }

  private runFormat(direct: { r: RProps; style?: string } | undefined): Format {
    const base = this.para?.base ?? this.paraStyle(undefined).r
    const char = this.styles.get(this.styles.has(direct?.style, 'character') ? direct?.style : this.styles.defaultChar, 'character')
    const r = { ...base, ...char.r, ...direct?.r }
    this.hidden = !!r.hidden
    this.symbol = !!r.symbol
    return toFormat(r)
  }

  /** A deleted row goes, all of it, as accepting the change takes it out. */
  private rowProps(node: XmlNode) {
    if (!node.kids.some((k) => isW(k.ns) && k.name === 'del')) return
    this.b.dropRow()
    this.frames.pop() // the row's: its end tag ends what's passed over instead
    this.sub = { kind: 'skip', depth: 1 }
  }

  private runProps(node: XmlNode) {
    if (this.run) this.run = this.runFormat(rPrOf(node))
  }

  private endPara() {
    const para = this.para
    this.para = undefined
    // A deleted or hidden paragraph end joins its text to the next paragraph's.
    this.joinNext = !!para?.joined
    if (para?.joined) return
    this.b.endPara(para?.props)
    if (this.b.cut) this.done = true
  }
}

/** Alignment and indent: the text's own, else a list's indent, else the style's. */
function paraProps(style: PProps, direct: PProps, listIndent?: number): ParaProps {
  const p: ParaProps = {}
  const align = direct.align ?? style.align
  if (align) p.align = align
  const indent = direct.indent ?? listIndent ?? style.indent
  if (indent) p.indent = indent
  return p
}

/** A part's relationships, as the last word of each type (so strict files' read the same) → the part it names. */
function relsOf(pkg: Package, part: string): Map<string, string> {
  const slash = part.lastIndexOf('/')
  const name = `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`
  const out = new Map<string, string>()
  const t = pkg.text(name, SIDE_CAP)
  for (const r of kidsOf(t && parseTree(t.text), REL, 'Relationship')) {
    const type = attrOf(r, '', 'Type')?.split('/').pop()
    const target = attrOf(r, '', 'Target')
    if (type && target && attrOf(r, '', 'TargetMode') !== 'External' && !out.has(type)) out.set(type, resolveTarget(name, target))
  }
  return out
}

/** Reads a Word document's text, as far as maxChars. Throws if it can't be read. */
export function readDocx(data: Uint8Array, maxChars = MAX_DOC_CHARS): DocText {
  const pkg = new Package(data)
  // The document is the part the package says it is, as Word finds it.
  const named = relsOf(pkg, '').get('officeDocument')
  const main = named && pkg.has(named) ? named : 'word/document.xml'
  const part = pkg.text(main, mainCap(maxChars))
  if (!part) throw new Error('not a Word document')
  const rels = relsOf(pkg, main)
  const tree = (type: string, fallback: string) => {
    const t = pkg.text(rels.get(type) ?? fallback, SIDE_CAP)
    return t && parseTree(t.text)
  }
  const styles = new Styles(tree('styles', 'word/styles.xml'))
  const numbering = new Numbering(tree('numbering', 'word/numbering.xml'), styles)
  const b = new DocBuilder(maxChars)
  const whole = scanXml(part.text, new WordReader(b, styles, numbering)) && part.whole
  return b.finish(!whole)
}
