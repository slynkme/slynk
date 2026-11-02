// A LibreOffice Writer document's text (OpenDocument, .odt), for the preview,
// from its content.xml: paragraphs, headings and
// tables, with bold, italic, underline, strikethrough, raised and lowered
// text, sizes, alignment and indents, as its styles say (the automatic ones in
// content.xml, over the named ones in styles.xml), and lists with their
// bullets and numbers. Spaces are read as OpenDocument says: a run of them is
// one, but for those it writes out (text:s). Left out: comments, footnotes and
// endnotes, tracked deletions, hidden text and sections, the text in drawings
// and text boxes, and indexes' templates (their text shows). Headers and
// footers are in styles.xml, which is read only for its styles. Pictures and
// embedded objects are counted. Colours, fonts and page layout aren't kept.
import { DocBuilder, type Format, type ParaProps } from './builder.ts'
import { MAX_DOC_CHARS, SYMBOL, type Align, type DocText } from './model.ts'
import { formatNumber } from './numbers.ts'
import { TreeBuilder, attrOf, kidOf, parseTree, scanXml, type XmlEl, type XmlNode, type XmlReader } from './xmlscan.ts'
import { Package, SIDE_CAP, mainCap } from './zipread.ts'

const NS = {
  office: 'urn:oasis:names:tc:opendocument:xmlns:office:1.0',
  style: 'urn:oasis:names:tc:opendocument:xmlns:style:1.0',
  text: 'urn:oasis:names:tc:opendocument:xmlns:text:1.0',
  table: 'urn:oasis:names:tc:opendocument:xmlns:table:1.0',
  draw: 'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0',
  dr3d: 'urn:oasis:names:tc:opendocument:xmlns:dr3d:1.0',
  fo: 'urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0',
  presentation: 'urn:oasis:names:tc:opendocument:xmlns:presentation:1.0',
  xml: 'http://www.w3.org/XML/1998/namespace',
}

/** Formatting as a style says it: what isn't said is left to what's under it. A size may be a share of the one under it. */
interface TProps {
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  pos?: 'sup' | 'sub' | 'base'
  size?: number
  percent?: number
  hidden?: boolean
}

interface Style {
  parent?: string
  t: TProps
  align?: Align
  indent?: number
  list?: string
}

interface ListLevel {
  /** A bullet's character, or undefined for a number. */
  bullet?: string
  fmt: string
  /** Letters go on (aa, ab) unless they repeat (aa, bb). */
  repeat: boolean
  prefix: string
  suffix: string
  start: number
  /** How many levels' numbers show: 2 for "1.2". */
  levels: number
  indent?: number
  follow: string
}

/** A length in points: in, cm, mm, pt, pc or px. */
function points(s: string | undefined): number | undefined {
  const m = /^(-?\d*\.?\d+)(in|cm|mm|pt|pc|px)$/.exec(s?.trim() ?? '')
  if (!m) return undefined
  const n = parseFloat(m[1]) * { in: 72, cm: 72 / 2.54, mm: 72 / 25.4, pt: 1, pc: 12, px: 0.75 }[m[2] as 'in']
  return Number.isFinite(n) ? n : undefined
}

const int = (s: string | undefined) => {
  const n = s === undefined ? NaN : parseInt(s, 10)
  return Number.isFinite(n) ? n : undefined
}

/** Where an element's fo:margin-left and fo:text-indent put a paragraph's first line, in points (a list's bullet sits there). */
function firstLine(el: XmlEl): number | undefined {
  const left = points(attrOf(el, NS.fo, 'margin-left'))
  return left === undefined ? undefined : Math.max(0, left + Math.min(0, points(attrOf(el, NS.fo, 'text-indent')) ?? 0))
}

const ALIGN: Record<string, Align> = { start: 'left', left: 'left', center: 'center', end: 'right', right: 'right', justify: 'justify' }

/** A style:text-properties' formatting. */
function textProps(node: XmlNode | undefined): TProps {
  const t: TProps = {}
  if (!node) return t
  const a = (ns: string, name: string) => attrOf(node, ns, name)
  const weight = a(NS.fo, 'font-weight')
  if (weight) t.bold = weight === 'bold' || (parseInt(weight, 10) || 0) >= 600
  const style = a(NS.fo, 'font-style')
  if (style) t.italic = style === 'italic' || style === 'oblique'
  const lines = (what: string) => {
    const s = a(NS.style, `text-${what}-style`)
    const type = a(NS.style, `text-${what}-type`)
    return s ? s !== 'none' : type ? type !== 'none' : undefined
  }
  const under = lines('underline')
  if (under !== undefined) t.underline = under
  const through = lines('line-through')
  if (through !== undefined) t.strike = through
  const pos = a(NS.style, 'text-position')?.trim().split(/\s+/)[0]
  if (pos) {
    const n = parseFloat(pos)
    t.pos = pos === 'super' || n > 0 ? 'sup' : pos === 'sub' || n < 0 ? 'sub' : 'base'
  }
  const size = a(NS.fo, 'font-size')
  if (size?.endsWith('%')) {
    const n = parseFloat(size)
    if (n > 0 && n <= 1000) t.percent = n
  } else {
    const n = points(size)
    if (n !== undefined && n > 0 && n <= 1638) t.size = n
  }
  const display = a(NS.text, 'display')
  if (display) t.hidden = display === 'none'
  return t
}

/** Formatting over what's under it: a size given as a share is a share of the size under it (12 points if none). */
function over(base: TProps, t: TProps): TProps {
  const { percent, ...rest } = t
  const out = { ...base, ...rest }
  if (percent !== undefined && rest.size === undefined) out.size = Math.min(1638, ((base.size ?? 12) * percent) / 100)
  return out
}

function toFormat(t: TProps): Format {
  const f: Format = {}
  if (t.bold) f.bold = true
  if (t.italic) f.italic = true
  if (t.underline) f.underline = true
  if (t.strike) f.strike = true
  if (t.pos === 'sup') f.sup = true
  else if (t.pos === 'sub') f.sub = true
  if (t.size) f.size = Math.round(t.size * 10) / 10
  return f
}

/** OpenDocument's number formats, as Word's names for them. */
const FORMATS: Record<string, string> = { '1': 'decimal', a: 'lowerLetter', A: 'upperLetter', i: 'lowerRoman', I: 'upperRoman', '': 'none' }

/** A bullet as written: a symbol font's as the one it looks like, and a plain one for any other private character. */
function bullet(s: string | undefined): string {
  const c = s?.codePointAt(0)
  if (c === undefined) return '•'
  if (c >= 0xf000 && c <= 0xf0ff) return SYMBOL[c - 0xf000] ?? '•'
  if (c >= 0xe000 && c <= 0xf8ff) return '•'
  return String.fromCodePoint(c)
}

/** The styles of styles.xml and content.xml: each one's formatting with all it's based on. */
class Styles {
  private styles = new Map<string, Style>()
  private defaults = new Map<string, Style>()
  lists = new Map<string, Map<number, ListLevel>>()
  /** Headings' numbering (Tools → Heading Numbering): numbered only where a level says how. */
  outline: Map<number, ListLevel> | undefined
  private resolved = new Map<string, { t: TProps; align?: Align; indent?: number; list?: string }>()
  private spans = new WeakMap<TProps, Map<string, TProps>>()

  /** The styles in an office:styles or office:automatic-styles element: later ones over earlier ones of the same name. */
  add(root: XmlNode | undefined) {
    this.resolved.clear()
    this.spans = new WeakMap()
    for (const s of root?.kids ?? []) {
      if (s.ns === NS.style && (s.name === 'style' || s.name === 'default-style')) {
        const family = attrOf(s, NS.style, 'family') ?? ''
        const pp = kidOf(s, NS.style, 'paragraph-properties')
        const style: Style = { t: textProps(kidOf(s, NS.style, 'text-properties')) }
        const parent = attrOf(s, NS.style, 'parent-style-name')
        if (parent) style.parent = parent
        const align = ALIGN[(pp && attrOf(pp, NS.fo, 'text-align')) ?? '']
        if (align) style.align = align
        const indent = pp && firstLine(pp)
        if (indent !== undefined) style.indent = indent
        const list = attrOf(s, NS.style, 'list-style-name')
        if (list) style.list = list
        if (s.name === 'default-style') this.defaults.set(family, style)
        else {
          const name = attrOf(s, NS.style, 'name')
          if (name) this.styles.set(`${family} ${name}`, style)
        }
      } else if (s.ns === NS.text && (s.name === 'list-style' || s.name === 'outline-style')) {
        const name = attrOf(s, NS.style, 'name')
        const levels = listLevels(s)
        if (name) this.lists.set(name, levels)
        if (s.name === 'outline-style') this.outline = levels
      }
    }
  }

  /** A style's formatting with all it's based on, over its family's default. */
  get(family: string, name: string | undefined): { t: TProps; align?: Align; indent?: number; list?: string } {
    const key = `${family} ${name ?? ''}`
    let got = this.resolved.get(key)
    if (got) return got
    const chain: Style[] = []
    const seen = new Set<string>()
    for (let at = name; at !== undefined && !seen.has(at) && chain.length < 32; ) {
      seen.add(at)
      const s = this.styles.get(`${family} ${at}`)
      if (!s) break
      chain.unshift(s)
      at = s.parent
    }
    const def = this.defaults.get(family)
    if (def) chain.unshift(def)
    got = { t: {} }
    for (const s of chain) {
      got.t = over(got.t, s.t)
      if (s.align) got.align = s.align
      if (s.indent !== undefined) got.indent = s.indent
      if (s.list) got.list = s.list
    }
    this.resolved.set(key, got)
    return got
  }

  /**
   * A text style's formatting over what's under it, worked out once for each: thousands of spans
   * of a style based on 40 others took 3.2 s (the review). What's under is itself one of these,
   * or a paragraph style's, so the same objects come back.
   */
  span(base: TProps, name: string | undefined): TProps {
    if (!name) return base
    let byName = this.spans.get(base)
    if (!byName) this.spans.set(base, (byName = new Map()))
    let got = byName.get(name)
    if (!got) byName.set(name, (got = this.spanOver(base, name)))
    return got
  }

  private spanOver(base: TProps, name: string): TProps {
    const chain: TProps[] = []
    const seen = new Set<string>()
    for (let at: string | undefined = name; at !== undefined && !seen.has(at) && chain.length < 32; ) {
      seen.add(at)
      const s = this.styles.get(`text ${at}`)
      if (!s) break
      chain.unshift(s.t)
      at = s.parent
    }
    return chain.reduce(over, base)
  }
}

function listLevels(node: XmlNode): Map<number, ListLevel> {
  const levels = new Map<number, ListLevel>()
  for (const l of node.kids) {
    if (l.ns !== NS.text || !/^(list-level-style-(number|bullet|image)|outline-level-style)$/.test(l.name)) continue
    const level = int(attrOf(l, NS.text, 'level'))
    if (level === undefined || level < 1 || level > 10 || levels.has(level)) continue
    const props = kidOf(l, NS.style, 'list-level-properties')
    const align = kidOf(props, NS.style, 'list-level-label-alignment')
    // Where the bullet or number sits: OpenDocument 1.2's way of saying it, or 1.0's.
    const indent = (align && firstLine(align)) ?? points(props && attrOf(props, NS.text, 'space-before'))
    const follow = align && attrOf(align, NS.text, 'label-followed-by')
    levels.set(level, {
      bullet: l.name === 'list-level-style-bullet' ? bullet(attrOf(l, NS.text, 'bullet-char')) : l.name === 'list-level-style-image' ? '•' : undefined,
      fmt: FORMATS[attrOf(l, NS.style, 'num-format') ?? ''] ?? 'decimal',
      repeat: attrOf(l, NS.style, 'num-letter-sync') === 'true',
      prefix: (attrOf(l, NS.style, 'num-prefix') ?? '').slice(0, 20),
      suffix: (attrOf(l, NS.style, 'num-suffix') ?? '').slice(0, 20),
      start: Math.max(0, Math.min(1e6, int(attrOf(l, NS.text, 'start-value')) ?? 1)),
      levels: Math.max(1, Math.min(10, int(attrOf(l, NS.text, 'display-levels')) ?? 1)),
      indent: indent === undefined ? undefined : Math.max(0, indent),
      follow: follow === 'space' ? ' ' : follow === 'nothing' ? '' : '\t',
    })
  }
  return levels
}

// Passed over whole: what isn't the document's text, or isn't shown.
const SKIP: Record<string, Set<string>> = {
  [NS.text]: new Set([
    'note',
    'tracked-changes',
    'ruby-text',
    'hidden-text',
    'sequence-decls',
    'variable-decls',
    'user-field-decls',
    'dde-connection-decls',
  ]),
  [NS.office]: new Set(['annotation', 'annotation-end', 'forms', 'scripts', 'font-face-decls', 'event-listeners', 'settings']),
  [NS.table]: new Set([
    'table-column',
    'table-columns',
    'table-header-columns',
    'table-column-group',
    'table-source',
    'scenario',
    'shapes',
    'named-expressions',
    'database-ranges',
    'calculation-settings',
    'content-validations',
    'label-ranges',
    'dde-links',
    'tracked-changes',
  ]),
  [NS.presentation]: new Set(['notes']),
}
/** What a draw:frame shows that's a picture or an embedded object. */
const PICTURE = new Set(['image', 'object', 'object-ole', 'plugin'])
/** Rows and cells repeated, at most: as many as there's room for, in any case. */
const MAX_REPEAT = 100_000

type Frame = { kind: 'none' | 'para' | 'span' | 'list' | 'item' | 'table' | 'row' | 'cell' | 'number'; repeat?: number }

/** Lists remembered by name for one that goes on from them, at most. */
const MAX_LISTS = 10_000

/**
 * A list item's bullet or number at this level, with what follows it, counting it in c: deeper
 * levels start again under it. none: what an item at a level its style doesn't describe shows.
 */
function itemLabel(levels: Map<number, ListLevel> | undefined, level: number, c: number[], start: number | undefined, none: string): string {
  const lvl = levels?.get(level + 1)
  if (start !== undefined) c[level] = Math.max(0, Math.min(1e6, start)) - 1
  c[level] = (c[level] ?? (lvl?.start ?? 1) - 1) + 1
  c.length = level + 1
  if (!lvl) return none
  let text: string
  if (lvl.bullet !== undefined) text = lvl.prefix + lvl.bullet + lvl.suffix
  else {
    const parts: string[] = []
    for (let k = Math.max(0, level - lvl.levels + 1); k <= level; k++) {
      const at = levels!.get(k + 1)
      const n = formatNumber(c[k] ?? at?.start ?? 1, at?.fmt ?? 'decimal', at?.repeat ?? false)
      if (n) parts.push(n)
    }
    text = lvl.prefix + parts.join('.') + lvl.suffix
  }
  return text.trim() ? text + lvl.follow : ''
}

interface Sub {
  kind: 'skip' | 'drawing' | 'styles'
  /** Elements open in it, itself included. */
  depth: number
  /** In a drawing: for each element open, whether it's a frame, and whether its picture was counted. */
  frames?: ({ counted: boolean } | undefined)[]
  tree?: TreeBuilder
}

/** Goes through content.xml once, building the preview as it goes. */
class WriterReader implements XmlReader {
  done = false
  private frames: Frame[] = []
  private sub: Sub | undefined
  /** labelled: it has a bullet or number of Slynk's working out. hidden: a hidden paragraph's. wrote: its text:number had text. */
  private para: { props: ParaProps; lastSpace: boolean; labelled: boolean; hidden: boolean; wrote?: boolean } | undefined
  /** The formatting of the text: the paragraph's, then each span's within it. */
  private fmts: TProps[] = []
  private lists: { style?: string; level: number }[] = []
  private items: { labelled: boolean; start?: number; header: boolean }[] = []
  private counters: number[] = []
  /** Each list's counts by its style and its xml:id, for a later list that goes on from it. */
  private byStyle = new Map<string, number[]>()
  private byId = new Map<string, number[]>()
  /** Headings' counts, level by level. */
  private outline: number[] = []

  private b: DocBuilder
  private styles: Styles

  constructor(b: DocBuilder, styles: Styles) {
    this.b = b
    this.styles = styles
  }

  open(el: XmlEl) {
    const sub = this.sub
    if (sub) {
      sub.depth++
      if (sub.kind === 'styles') sub.tree!.open(el)
      else if (sub.frames) {
        const frame = sub.frames[sub.frames.length - 1]
        if (frame && !frame.counted && el.ns === NS.draw && PICTURE.has(el.name)) {
          frame.counted = true
          this.b.pictures++
        }
        sub.frames.push(el.ns === NS.draw && el.name === 'frame' ? { counted: false } : undefined)
      }
      return
    }
    const top = this.frames[this.frames.length - 1]
    const frame: Frame = { kind: 'none' }
    const name = el.name
    if (SKIP[el.ns]?.has(name) || (el.ns === NS.text && name.endsWith('-source'))) return this.begin('skip')
    if (el.ns === NS.text) {
      switch (name) {
        case 'p':
        case 'h':
          this.startPara(el, top)
          frame.kind = 'para'
          break
        case 'span':
          this.fmts.push(this.styles.span(this.fmts[this.fmts.length - 1] ?? {}, attrOf(el, NS.text, 'style-name')))
          frame.kind = 'span'
          break
        case 's':
          this.add(' '.repeat(Math.max(1, Math.min(1000, int(attrOf(el, NS.text, 'c')) ?? 1))))
          break
        case 'tab':
          this.add('\t')
          break
        case 'line-break':
          this.add('\n')
          break
        case 'list':
          this.openList(el)
          frame.kind = 'list'
          break
        case 'list-item':
        case 'list-header':
          this.items.push({ labelled: false, start: int(attrOf(el, NS.text, 'start-value')), header: name === 'list-header' })
          frame.kind = 'item'
          break
        case 'section':
          if (attrOf(el, NS.text, 'display') === 'none') return this.begin('skip')
          break
        case 'hidden-paragraph':
          // The paragraph it's in is hidden, when its condition says so.
          if (this.para && attrOf(el, NS.text, 'is-hidden') === 'true') this.para.hidden = true
          break
        case 'number':
          // The number the app wrote down: shown only where Slynk worked out none.
          if (!this.para || this.para.labelled) return this.begin('skip')
          frame.kind = 'number'
          break
      }
    } else if (el.ns === NS.table) {
      const repeat = (what: string) => Math.max(1, Math.min(MAX_REPEAT, int(attrOf(el, NS.table, `number-${what}-repeated`)) ?? 1))
      if (name === 'table') {
        this.b.startTable()
        frame.kind = 'table'
      } else if (name === 'table-row') {
        this.b.startRow()
        frame.kind = 'row'
        frame.repeat = repeat('rows')
      } else if (name === 'table-cell' || name === 'covered-table-cell') {
        this.b.startCell()
        frame.kind = 'cell'
        frame.repeat = repeat('columns')
      }
    } else if (el.ns === NS.office && name === 'automatic-styles') {
      this.sub = { kind: 'styles', depth: 1, tree: new TreeBuilder() }
      this.sub.tree!.open(el)
      return
    } else if ((el.ns === NS.draw && name !== 'a') || el.ns === NS.dr3d) {
      // A drawing, frame or shape: its text isn't shown, and a frame holding a picture is counted.
      this.sub = { kind: 'drawing', depth: 1, frames: [name === 'frame' ? { counted: false } : undefined] }
      return
    }
    this.frames.push(frame)
  }

  private begin(kind: 'skip') {
    this.sub = { kind, depth: 1 }
  }

  close() {
    const sub = this.sub
    if (sub) {
      sub.tree?.close()
      sub.frames?.pop()
      if (--sub.depth) return
      this.sub = undefined
      if (sub.kind === 'styles') this.styles.add(sub.tree!.root)
      return
    }
    const frame = this.frames.pop()
    switch (frame?.kind) {
      case 'para':
        this.endPara()
        break
      case 'span':
        this.fmts.pop()
        break
      case 'list':
        this.lists.pop()
        break
      case 'item':
        this.items.pop()
        break
      case 'number':
        if (this.para?.wrote) this.add('\t')
        break
      case 'table':
        this.b.endTable()
        break
      case 'row':
        this.b.endRow(frame.repeat)
        break
      case 'cell':
        this.b.endCell(frame.repeat)
        break
    }
    if (this.b.cut) this.done = true
  }

  /** Text as OpenDocument says to read it: a run of spaces, tabs and line ends is one space, and none starts a paragraph. */
  text(s: string) {
    const para = this.para
    if (!para || this.sub) return
    s = s.replace(/[ \t\r\n]+/g, ' ')
    if (para.lastSpace && s.startsWith(' ')) s = s.slice(1)
    if (!s) return
    if (this.write(s)) para.lastSpace = s.endsWith(' ')
  }

  /** Spaces, tabs and line breaks it writes out. */
  private add(s: string) {
    if (this.para && this.write(s)) this.para.lastSpace = false
  }

  private write(s: string): boolean {
    const t = this.fmts[this.fmts.length - 1] ?? {}
    if (t.hidden || this.para?.hidden) return false
    if (this.para && this.frames[this.frames.length - 1]?.kind === 'number') this.para.wrote = true
    this.b.text(s, toFormat(t))
    if (this.b.cut) this.done = true
    return true
  }

  private openList(el: XmlEl) {
    const level = this.lists.length
    const style = attrOf(el, NS.text, 'style-name') ?? this.lists[level - 1]?.style
    if (!level) {
      // A list goes on from another only if it says so: the one it names, or the last of its style.
      const from = attrOf(el, NS.text, 'continue-list')
      const goOn = (from !== undefined && this.byId.get(from)) || (attrOf(el, NS.text, 'continue-numbering') === 'true' && this.byStyle.get(style ?? ''))
      this.counters = goOn || []
      if (this.byStyle.size < MAX_LISTS) this.byStyle.set(style ?? '', this.counters)
      const id = attrOf(el, NS.xml, 'id')
      if (id !== undefined && this.byId.size < MAX_LISTS) this.byId.set(id, this.counters)
    }
    this.lists.push({ style, level })
  }

  /** The innermost list's level, and its style's description of it (the paragraph's style may name the list's style). */
  private level(paraList: string | undefined) {
    const list = this.lists[this.lists.length - 1]
    const level = Math.min(9, list?.level ?? 0)
    const levels = this.styles.lists.get(list?.style ?? paraList ?? '')
    return { level, levels, lvl: levels?.get(level + 1) }
  }

  /** The bullet or number of the list item a paragraph begins, with what follows it. */
  private label(paraList: string | undefined, item: { start?: number; header: boolean }): string {
    if (item.header) return ''
    const { level, levels } = this.level(paraList)
    return itemLabel(levels, level, this.counters, item.start, '•\t')
  }

  private startPara(el: XmlEl, top: Frame | undefined) {
    // A paragraph inside another (only in damaged files): the first ends there.
    if (this.para) this.endPara()
    const s = this.styles.get('paragraph', attrOf(el, NS.text, 'style-name'))
    const props: ParaProps = {}
    if (s.align) props.align = s.align
    let indent = s.indent
    this.para = { props, lastSpace: true, labelled: false, hidden: false }
    const para = this.para
    this.fmts = [s.t]
    const item = top?.kind === 'item' ? this.items[this.items.length - 1] : undefined
    let label = ''
    if (item) {
      // The item's first paragraph has its bullet or number; the rest line up with it.
      if (!item.labelled) {
        item.labelled = true
        label = this.label(s.list, item)
      }
      const { level, lvl } = this.level(s.list)
      indent ??= lvl?.indent ?? 18 * (level + 1)
    } else if (el.name === 'h' && attrOf(el, NS.text, 'is-list-header') !== 'true') {
      // A heading numbered by the headings' numbering, where it numbers that level.
      const level = Math.max(1, Math.min(10, int(attrOf(el, NS.text, 'outline-level')) ?? 1)) - 1
      label = itemLabel(this.styles.outline, level, this.outline, int(attrOf(el, NS.text, 'start-value')), '')
    }
    if (label) {
      this.write(label)
      para.labelled = true
    }
    if (indent) props.indent = indent
  }

  private endPara() {
    const para = this.para
    this.para = undefined
    this.fmts = []
    // A hidden paragraph goes whole, with anything written before what hid it.
    if (para?.hidden) this.b.dropPara()
    else if (para) this.b.endPara(para.props)
    if (this.b.cut) this.done = true
  }
}

/** Reads a LibreOffice Writer document's text, as far as maxChars. Throws if it can't be read, or is locked with a password. */
export function readOdt(data: Uint8Array, maxChars = MAX_DOC_CHARS): DocText {
  const pkg = new Package(data)
  if (pkg.text('META-INF/manifest.xml', SIDE_CAP)?.text.includes('encryption-data')) throw new Error('locked with a password')
  const part = pkg.text('content.xml', mainCap(maxChars))
  if (!part) throw new Error('not an OpenDocument text')
  const styles = new Styles()
  // Its named styles only: the automatic ones there are its headers' and footers'.
  const named = pkg.text('styles.xml', SIDE_CAP)
  styles.add(kidOf(named && parseTree(named.text), NS.office, 'styles'))
  const b = new DocBuilder(maxChars)
  const whole = scanXml(part.text, new WriterReader(b, styles)) && part.whole
  return b.finish(!whole)
}
