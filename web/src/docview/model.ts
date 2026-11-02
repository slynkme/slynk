// A document's text as the preview shows it: blocks
// of paragraphs and tables, each paragraph runs of text with the little
// formatting a simplified preview keeps. Each format's reader makes one (rtf.ts,
// docx.ts, odt.ts) and render.ts draws it. Nothing in it is
// markup: it's drawn as text, so nothing in a document can run or fetch anything.

/** Text with one set of formatting. size: points, when the document says. */
export interface Run {
  text: string
  bold?: true
  italic?: true
  underline?: true
  strike?: true
  sup?: true
  sub?: true
  size?: number
}

export type Align = 'left' | 'center' | 'right' | 'justify'

export interface Para {
  kind: 'para'
  runs: Run[]
  align?: Align
  /** How far it's indented from the left, in points. */
  indent?: number
}

/** Rows of cells, each cell its paragraphs. */
export interface Table {
  kind: 'table'
  rows: Para[][][]
}

export type Block = Para | Table

export interface DocText {
  blocks: Block[]
  /** Only the beginning: the rest is past MAX_DOC_CHARS. */
  cut: boolean
  /** Pictures and embedded objects, which the preview doesn't show. */
  pictures: number
  /** Plain text (text.ts): its lines as they are, nothing simplified. */
  plain?: true
}

/** Symbol fonts (Symbol, Wingdings): the bullets Word uses, as the characters they look like. */
export const SYMBOL: Record<number, string> = { 0xb7: '•', 0xa7: '▪', 0xd8: '➢', 0xfc: '✓', 0x76: '❖', 0x6e: '■', 0x71: '❑' }

/** As much text as a preview shows: a long book's worth is past what anyone reads in a preview. */
export const MAX_DOC_CHARS = 200_000

/** Whether there's any text to show at all. */
export const hasText = (doc: DocText): boolean =>
  doc.blocks.some((b) => (b.kind === 'para' ? b.runs.some((r) => r.text.trim()) : b.rows.some((row) => row.some((cell) => cell.some((p) => p.runs.some((r) => r.text.trim()))))))
