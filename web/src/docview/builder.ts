// Puts a document's text into the model (model.ts) as a reader goes through
// it: Word's and LibreOffice's readers share it;
// the RTF reader (rtf.ts) works the same way in its own code. It keeps the
// limits RTF's review asked for: maxChars of text, with each paragraph and
// cell counting as one so a flood of empty ones is cut short too; at most two
// empty paragraphs in a row; at most 63 cells in a row, as in Word. Tables in
// tables are flattened into their cell, a tab between cells and a line between
// rows, as RTF's are.
import { MAX_DOC_CHARS, type Align, type Block, type DocText, type Para, type Run, type Table } from './model.ts'

/** A run's formatting. */
export type Format = Omit<Run, 'text'>

export interface ParaProps {
  align?: Align
  /** Points from the left. */
  indent?: number
}

/** Cells in a row at most, as in Word: any more join the last, so a crafted row can't be a page wide. */
export const MAX_CELLS = 63

const same = (a: Format, b: Format) =>
  a.bold === b.bold && a.italic === b.italic && a.underline === b.underline && a.strike === b.strike && a.sup === b.sup && a.sub === b.sub && a.size === b.size

/** Control characters but tab and line end go, as RTF's reader drops them. */
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g

const textLength = (cell: Para[]) => cell.reduce((n, p) => n + p.runs.reduce((m, r) => m + r.text.length, 0), 0)

export class DocBuilder {
  private blocks: Block[] = []
  private runs: Run[] = []
  private chars = 0
  /** There's maxChars: anything more is cut. */
  private full = false
  /** Only the beginning: something more came after maxChars. A reader stops once it's set. */
  cut = false
  pictures = 0
  // The table being built (the outermost one), its row and cell.
  private table: Table | undefined
  private tableAdded = false
  private row: Para[][] | undefined
  private cell: Para[] | undefined
  // Tables open inside its cell, and the line their cells and rows are flattened into.
  private nested = 0
  private line: Run[] = []
  private maxChars: number

  constructor(maxChars = MAX_DOC_CHARS) {
    this.maxChars = maxChars
  }

  /** Text with this formatting, as far as there's room. */
  text(s: string, f: Format = {}) {
    s = s.replace(CONTROL, '')
    if (!s) return
    if (this.full) {
      this.cut = true
      return
    }
    const room = this.maxChars - this.chars
    if (s.length >= room) {
      if (s.length > room) this.cut = true
      this.full = true
      s = s.slice(0, room)
      if (!s) return
    }
    this.chars += s.length
    const last = this.runs[this.runs.length - 1]
    if (last && same(last, f)) last.text += s
    else this.runs.push({ text: s, ...f })
  }

  /** A paragraph or cell counts as one character. */
  private count() {
    if (!this.full && ++this.chars >= this.maxChars) this.full = true
  }

  private takeRuns(p: ParaProps): Para {
    const para: Para = { kind: 'para', runs: this.runs }
    if (p.align && p.align !== 'left') para.align = p.align
    if (p.indent && p.indent > 0) para.indent = p.indent
    this.runs = []
    return para
  }

  /** At most two empty paragraphs in a row: spacing, not a page of nothing. */
  private add(to: Block[], p: Para) {
    const n = to.length
    const empty = (x: Block | undefined) => x?.kind === 'para' && !x.runs.length
    if (!p.runs.length && empty(to[n - 1]) && empty(to[n - 2])) return
    to.push(p)
  }

  /** Ends a paragraph: in the page, its table's cell, or the line a table in a cell is flattened into. */
  endPara(p: ParaProps = {}) {
    // An empty one past the limit isn't kept, and isn't missed.
    if (this.full && !this.runs.length) return
    this.count()
    if (this.nested) {
      for (const r of this.runs) this.line.push(r)
      this.line.push({ text: '\n' })
      this.runs = []
    } else if (this.table) this.add((this.cell ??= []), this.takeRuns(p))
    else this.add(this.blocks, this.takeRuns(p))
  }

  /** Text not yet in a paragraph ends one before a table or cell starts or ends. */
  private flush() {
    if (this.runs.length) this.endPara()
  }

  startTable() {
    this.flush()
    if (this.table) this.nested++
    else {
      this.table = { kind: 'table', rows: [] }
      this.tableAdded = false
    }
  }

  startRow() {
    this.flush()
    if (this.nested || !this.table) return
    if (this.row) this.endRow()
    this.row = []
  }

  startCell() {
    this.flush()
    if (this.nested || !this.table) return
    if (this.cell) this.endCell()
    this.cell = []
  }

  /** Leaves out the paragraph being built: a hidden one. */
  dropPara() {
    this.runs = []
  }

  /** Leaves out the row being built: a deleted tracked change. */
  dropRow() {
    if (this.nested || !this.table) return
    this.runs = []
    this.row = this.cell = undefined
  }

  /** Ends a cell, and adds repeat - 1 copies of it (LibreOffice's repeated cells) while there's room. */
  endCell(repeat = 1) {
    this.flush()
    if (this.nested) {
      this.count()
      if (this.line[this.line.length - 1]?.text === '\n') this.line.pop()
      this.line.push({ text: '\t' })
      return
    }
    if (!this.table) return
    const cell = this.cell ?? []
    this.cell = undefined
    if (this.full && !cell.length) return
    if (!cell.length) cell.push({ kind: 'para', runs: [] })
    this.count()
    this.pushCell(cell)
    const weight = 1 + textLength(cell)
    for (let k = 1; k < repeat && this.row!.length < MAX_CELLS; k++) {
      if (!this.room(weight)) break
      this.pushCell(cell)
    }
  }

  /**
   * Adds a cell to the row. The last one a row has room for is an array of its own, and the cells
   * past it join it: copies of a repeated cell are one array, and joining that showed one row's
   * overflow 63 times (the review).
   */
  private pushCell(cell: Para[]) {
    const row = (this.row ??= [])
    if (row.length < MAX_CELLS - 1) row.push(cell)
    else if (row.length === MAX_CELLS - 1) row.push(cell.slice())
    else for (const p of cell) row[row.length - 1].push(p)
  }

  /** Room for a copy of something weight characters long: the limit is cut at, not passed. */
  private room(weight: number): boolean {
    if (this.full || this.chars + weight > this.maxChars) {
      this.full = this.cut = true
      return false
    }
    this.chars += weight
    if (this.chars >= this.maxChars) this.full = true
    return true
  }

  /** Ends a row, and adds repeat - 1 copies of it while there's room. */
  endRow(repeat = 1) {
    this.flush()
    if (this.nested) {
      const last = this.line[this.line.length - 1]?.text
      if (last === '\t' || last === '\n') this.line.pop()
      this.line.push({ text: '\n' })
      return
    }
    if (!this.table) return
    if (this.cell) this.endCell()
    const row = this.row
    this.row = undefined
    if (!row?.length) return
    if (!this.tableAdded) {
      this.blocks.push(this.table)
      this.tableAdded = true
    }
    this.table.rows.push(row)
    const weight = row.reduce((n, cell) => n + 1 + textLength(cell), 0)
    for (let k = 1; k < repeat; k++) {
      if (!this.room(weight)) break
      this.table.rows.push(row)
    }
  }

  endTable() {
    this.flush()
    if (this.nested) {
      if (--this.nested) return
      // The line of the tables in this cell is one paragraph of it.
      while (this.line.length && /^[\t\n]$/.test(this.line[this.line.length - 1].text)) this.line.pop()
      if (this.line.length) (this.cell ??= []).push({ kind: 'para', runs: this.line })
      this.line = []
      return
    }
    if (!this.table) return
    if (this.row || this.cell) this.endRow()
    this.table = undefined
  }

  /** The document as read. more: there was more of it than was read. */
  finish(more: boolean, p: ParaProps = {}): DocText {
    const cut = this.cut || more
    if (this.runs.length) this.endPara(p)
    while (this.nested) this.endTable()
    if (this.table) this.endTable()
    return { blocks: this.blocks, cut, pictures: this.pictures }
  }
}
