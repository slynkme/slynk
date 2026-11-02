// An RTF document's text, for the preview: its
// paragraphs and simple tables, with bold, italic, underline, strikethrough,
// superscript and subscript, font sizes, alignment and indents. Lists keep the
// bullet or number Word writes for older readers. Left out: the tables of
// fonts, colours and styles, the info group, pictures and objects (counted),
// headers and footers, footnotes, comments, field codes (their results show),
// hidden text, deleted tracked changes, and every {\*\...} group, which RTF
// says a reader that doesn't know it skips. Colours, fonts and page layout
// aren't kept: it's a simplified preview.
import { Lexer, codePage } from '../strip/rtflex.ts'
import { MAX_DOC_CHARS, SYMBOL, type Align, type Block, type DocText, type Para, type Run, type Table } from './model.ts'

/** Groups that aren't the document's text, by their first control word. */
const SKIP = new Set([
  'fonttbl',
  'colortbl',
  'stylesheet',
  'info',
  'pict',
  'object',
  'header',
  'headerl',
  'headerr',
  'headerf',
  'footer',
  'footerl',
  'footerr',
  'footerf',
  'footnote',
  'annotation',
  'atnid',
  'atnauthor',
  'atnref',
  'atndate',
  'fldinst',
  'listtable',
  'listoverridetable',
  'revtbl',
  'rsidtbl',
  'generator',
  'template',
  'userprops',
  'docvar',
  'xmlnstbl',
  'filetbl',
  'pgdsctbl',
  'nonshppict',
  'ftnsep',
  'ftnsepc',
  'aftnsep',
  'aftnsepc',
  'ftncn',
  'aftncn',
  'xe',
  'tc',
  'txe',
  'rxe',
  'bxe',
  // Word 6's list numbering, written without \* (its bullet is in \pntext too), and the copy of a
  // nested table's row for readers without nested tables.
  'pn',
  'pntxta',
  'pntxtb',
  'nonesttables',
])

/** Groups holding a list item's bullet or number: there, a symbol font's letters are drawn as the bullets they look like. */
const LIST_TEXT = new Set(['listtext', 'pntext'])

/** Cells in a row at most, as in Word: any more join the last, so a crafted row can't be a page wide. */
const MAX_CELLS = 63

/** Which of those are pictures or embedded objects, which the preview says it doesn't show. */
const PICTURES = new Set(['pict', 'object'])

/** Code pages for a font's \fcharset (0 and 1: the document's own). */
const CHARSETS: Record<number, string> = {
  77: 'macintosh',
  128: 'shift_jis',
  129: 'euc-kr',
  134: 'gbk',
  136: 'big5',
  161: 'windows-1253',
  162: 'windows-1254',
  163: 'windows-1258',
  177: 'windows-1255',
  178: 'windows-1256',
  186: 'windows-1257',
  204: 'windows-1251',
  222: 'windows-874',
  238: 'windows-1250',
}

/** Control words that are characters. */
const CHARS: Record<string, string> = {
  line: '\n',
  tab: '\t',
  emdash: '—',
  endash: '–',
  bullet: '•',
  lquote: '‘',
  rquote: '’',
  ldblquote: '“',
  rdblquote: '”',
  emspace: ' ',
  enspace: ' ',
  qmspace: ' ',
  zwj: '‍',
  zwnj: '‌',
  // A nested table's cells and rows, flattened into its cell.
  nestcell: '\t',
  nestrow: '\n',
}

/** Formatting that lasts until the group it was set in ends. */
interface State {
  bold: boolean
  italic: boolean
  underline: boolean
  strike: boolean
  sup: boolean
  sub: boolean
  size: number // half-points, 0: not said
  font: number
  hidden: boolean // \v, or a deleted tracked change
  list: boolean // in a list item's bullet or number (LIST_TEXT)
  uc: number // characters after \uN that stand in for it
  align: Align
  indent: number // twips
  inTable: boolean
}

const fresh = (): State => ({ bold: false, italic: false, underline: false, strike: false, sup: false, sub: false, size: 0, font: -1, hidden: false, list: false, uc: 1, align: 'left', indent: 0, inTable: false })

/** \plain: the characters' formatting back to the defaults, and the font to \deff's. */
const plain = (s: State): State => ({ ...s, bold: false, italic: false, underline: false, strike: false, sup: false, sub: false, size: 0, font: -1, hidden: false })

/** After {, the end of the group: its matching }, minding escaped braces and \bin data. */
function groupEnd(b: Uint8Array, from: number): number {
  let depth = 1
  let i = from
  while (i < b.length) {
    const c = b[i]
    if (c === 0x5c) {
      // \binN: N raw bytes, which may hold anything.
      if (b[i + 1] === 0x62 && b[i + 2] === 0x69 && b[i + 3] === 0x6e) {
        let j = i + 4
        let n = 0
        while (j < b.length && b[j] >= 0x30 && b[j] <= 0x39 && j - i < 15) n = n * 10 + b[j++] - 0x30
        if (b[j] === 0x20) j++
        i = j + n
        continue
      }
      i += 2
      continue
    }
    if (c === 0x7b) depth++
    else if (c === 0x7d && --depth === 0) return i + 1
    i++
  }
  return b.length
}

/** The fonts' code pages, from the font table at b[from, to): \fN … \fcharsetN. */
function fontTable(b: Uint8Array, from: number, to: number): Map<number, number> {
  const fonts = new Map<number, number>()
  const lex = new Lexer(b.subarray(0, to))
  lex.i = from
  let font = -1
  try {
    for (let tok = lex.next(); tok; tok = lex.next()) {
      if (tok.t !== 'word' || tok.param === null) continue
      if (tok.word === 'f') font = tok.param
      else if (tok.word === 'fcharset' && font >= 0) fonts.set(font, tok.param)
    }
  } catch {
    // a damaged table: the fonts read so far
  }
  return fonts
}

/**
 * Reads an RTF document's text, as far as maxChars (each paragraph and cell counting as one, so a
 * flood of empty ones is cut short too). Throws if it isn't RTF.
 */
export function readRtf(b: Uint8Array, maxChars = MAX_DOC_CHARS): DocText {
  if (String.fromCharCode(...b.subarray(0, 5)) !== '{\\rtf') throw new Error('not RTF')
  const docPage = codePage(b)
  const decoders = new Map<string, TextDecoder>()
  let fonts = new Map<number, number>()
  let defaultFont = -1 // \deffN: text before any \f is in it
  const decoderFor = (font: number): TextDecoder | 'symbol' => {
    const charset = fonts.get(font < 0 ? defaultFont : font)
    if (charset === 2) return 'symbol'
    const name = charset === undefined ? undefined : CHARSETS[charset]
    if (!name) return docPage
    let d = decoders.get(name)
    if (!d) {
      try {
        d = new TextDecoder(name)
      } catch {
        d = docPage
      }
      decoders.set(name, d)
    }
    return d
  }

  const blocks: Block[] = []
  let table: Table | undefined // the table rows are going into, until a paragraph outside one
  let row: Para[][] = []
  let cell: Para[] = []
  let runs: Run[] = []
  let chars = 0
  let cut = false
  let pictures = 0
  let pending: number[] = [] // bytes of text in the current code page, not yet decoded
  let text = '' // decoded text with the current formatting, not yet a run
  let state = fresh()
  let runState = state // the formatting text is gathering under
  const stack: State[] = []
  let skip = 0 // characters still to skip after a \uN

  const decodePending = () => {
    if (!pending.length) return
    const d = decoderFor(runState.font)
    // A symbol font's letters are bullets only in a list item's bullet: elsewhere, the letters as they are.
    if (d === 'symbol' && runState.list) text += pending.map((c) => SYMBOL[c] ?? String.fromCharCode(c)).join('')
    else text += (d === 'symbol' ? docPage : d).decode(Uint8Array.from(pending))
    pending = []
  }
  /** Ends the run gathering text: what changes formatting calls it first. */
  const endRun = () => {
    decodePending()
    if (text) {
      const s = runState
      const run: Run = { text }
      if (s.bold) run.bold = true
      if (s.italic) run.italic = true
      if (s.underline) run.underline = true
      if (s.strike) run.strike = true
      if (s.sup) run.sup = true
      else if (s.sub) run.sub = true
      if (s.size) run.size = s.size / 2
      runs.push(run)
      chars += text.length
    }
    text = ''
    runState = state
  }
  const setState = (next: State) => {
    endRun()
    state = next
    runState = next
  }
  const para = (): Para => {
    const p: Para = { kind: 'para', runs }
    if (state.align !== 'left') p.align = state.align
    if (state.indent > 0) p.indent = state.indent / 20
    runs = []
    return p
  }
  /** A paragraph or cell counts as one character: at the limit, what's left is cut. */
  const count = () => {
    if (++chars >= maxChars) cut = true
  }
  /** At most two empty paragraphs in a row: spacing, not a page of nothing. */
  const add = (to: Block[], p: Para) => {
    const n = to.length
    const empty = (x: Block | undefined) => x?.kind === 'para' && !x.runs.length
    if (!p.runs.length && empty(to[n - 1]) && empty(to[n - 2])) return
    to.push(p)
  }
  const endPara = () => {
    endRun()
    count()
    if (state.inTable) {
      add(cell, para())
      return
    }
    // Cells left without a \row end their table here, before what follows it.
    if (row.length || cell.length) endRow()
    table = undefined
    add(blocks, para())
  }
  const endCell = () => {
    endRun()
    count()
    if (runs.length || !cell.length) add(cell, para())
    if (row.length < MAX_CELLS) row.push(cell)
    else for (const p of cell) row[row.length - 1].push(p)
    cell = []
  }
  const endRow = () => {
    endRun()
    if (runs.length || cell.length) endCell()
    if (!row.length) return
    if (!table) blocks.push((table = { kind: 'table', rows: [] }))
    table.rows.push(row)
    row = []
  }
  /** Room for more text: none once there's maxChars, and only then is the document cut. */
  const room = () => {
    if (chars + text.length + pending.length < maxChars) return true
    cut = true
    return false
  }
  /** Text from the document: dropped while hidden, or standing in for a \uN. Control characters but tab go. */
  const addByte = (c: number) => {
    if (skip > 0) skip--
    else if (!state.hidden && (c >= 0x20 || c === 0x09) && room()) pending.push(c)
  }
  const addText = (s: string) => {
    if (state.hidden || !room()) return
    decodePending()
    text += s
  }

  const lex = new Lexer(b)
  // A file cut short or damaged partway shows what came before it.
  const next = () => {
    try {
      return lex.next()
    } catch {
      return null
    }
  }
  /** The next token that isn't a line break, which RTF ignores (between { and \*, say). */
  const nextSolid = () => {
    let tok = next()
    while (tok?.t === 'text' && b.subarray(tok.at, tok.end).every((c) => c === 0x0d || c === 0x0a)) tok = next()
    return tok
  }
  for (let tok = next(); tok && !cut; tok = next()) {
    if (tok.t === 'open') {
      // Groups that aren't the document's text are passed over whole, unread.
      const at = lex.i
      const first = nextSolid()
      let dest = ''
      if (first?.t === 'symbol' && first.ch === 0x2a) {
        const named = nextSolid()
        dest = named?.t === 'word' ? named.word : '*'
        if (dest !== 'shppict' && dest !== '*') dest = '*'
      } else if (first?.t === 'word') dest = first.word
      if (dest === 'fonttbl') {
        const end = groupEnd(b, at)
        fonts = fontTable(b, at, end)
        lex.i = end
        continue
      }
      if (dest === '*' || dest === 'shppict' || SKIP.has(dest)) {
        if (PICTURES.has(dest) || dest === 'shppict') pictures++
        lex.i = groupEnd(b, at)
        continue
      }
      lex.i = at
      stack.push(state)
      if (LIST_TEXT.has(dest)) setState({ ...state, list: true })
      continue
    }
    if (tok.t === 'close') {
      skip = 0
      const back = stack.pop()
      if (back) setState(back)
      // The document's own group has closed: anything after it isn't the document.
      if (!stack.length) break
      continue
    }
    if (tok.t === 'bin') continue
    if (tok.t === 'text') {
      for (let i = tok.at; i < tok.end; i++) if (b[i] !== 0x0d && b[i] !== 0x0a) addByte(b[i])
      continue
    }
    if (tok.t === 'symbol') {
      const ch = tok.ch
      // A backslash before a line break is a paragraph's end: how macOS's TextEdit writes them.
      if (ch === 0x0a || ch === 0x0d) {
        skip = 0
        endPara()
        continue
      }
      if (ch === 0x27) addByte(parseInt(String.fromCharCode(b[tok.at + 2] ?? 0, b[tok.at + 3] ?? 0), 16) || 0x3f)
      else if (skip > 0) skip--
      else if (ch === 0x7b || ch === 0x7d || ch === 0x5c) addText(String.fromCharCode(ch))
      else if (ch === 0x7e) addText(' ')
      else if (ch === 0x5f) addText('‑')
      continue
    }
    // A control word. One ends what stands in for a \uN, rather than being skipped: a paragraph's
    // end must never go with it.
    if (tok.t !== 'word') continue
    const { word, param } = tok
    const on = param !== 0
    if (word !== 'u') skip = 0
    switch (word) {
      case 'deff':
        defaultFont = param ?? -1
        break
      case 'par':
      case 'sect':
      case 'page':
        endPara()
        break
      case 'cell':
        endCell()
        break
      case 'row':
        endRow()
        break
      case 'pard':
        setState({ ...state, align: 'left', indent: 0, inTable: false })
        break
      case 'intbl':
        state = { ...state, inTable: true }
        break
      case 'ql':
      case 'qc':
      case 'qr':
      case 'qj':
        state = { ...state, align: ({ ql: 'left', qc: 'center', qr: 'right', qj: 'justify' } as const)[word] }
        break
      case 'li':
        state = { ...state, indent: Math.max(0, param ?? 0) }
        break
      case 'plain':
        setState(plain(state))
        break
      case 'b':
        setState({ ...state, bold: on })
        break
      case 'i':
        setState({ ...state, italic: on })
        break
      case 'strike':
      case 'striked':
        setState({ ...state, strike: on })
        break
      case 'ulnone':
        setState({ ...state, underline: false })
        break
      case 'super':
        setState({ ...state, sup: true, sub: false })
        break
      case 'sub':
        setState({ ...state, sub: true, sup: false })
        break
      case 'nosupersub':
        setState({ ...state, sup: false, sub: false })
        break
      case 'fs':
        setState({ ...state, size: param !== null && param > 0 ? param : 0 })
        break
      case 'f':
        setState({ ...state, font: param ?? -1 })
        break
      case 'v':
      case 'deleted':
        setState({ ...state, hidden: on })
        break
      case 'uc':
        state = { ...state, uc: Math.max(0, param ?? 1) }
        break
      case 'u':
        if (param !== null) {
          addText(String.fromCharCode(param < 0 ? param + 65536 : param))
          skip = state.uc
        }
        break
      default:
        // \ul and every kind of underline (\uld, \ulw, \ulwave…), but not its colour (\ulc).
        if (word.startsWith('ul') && word !== 'ulc' && !word.startsWith('ulc')) setState({ ...state, underline: on })
        else if (CHARS[word] !== undefined) addText(CHARS[word])
    }
  }
  // What's left ends here: nothing follows it to be cut.
  const wasCut = cut
  endRun()
  if (runs.length) endPara()
  if (row.length || cell.length) endRow()
  return { blocks, cut: wasCut, pictures }
}
