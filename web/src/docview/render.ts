// Draws a document's text (model.ts) for the preview: in the viewer as the
// page's own paragraphs and tables, every word set as text, never as markup;
// and small, as a page's first lines, in place of a file's icon. Sizes are
// relative to the document's commonest one, so its body reads at the page's
// own size on a phone and headings stay bigger.
import type { Block, DocText, Para, Run } from './model.ts'

/** The size most of the text is in, in points (12 if it never says). */
function bodySize(doc: DocText): number {
  const count = new Map<number, number>()
  const add = (p: Para) => {
    for (const r of p.runs) if (r.size) count.set(r.size, (count.get(r.size) ?? 0) + r.text.length)
  }
  for (const b of doc.blocks) {
    if (b.kind === 'para') add(b)
    else for (const row of b.rows) for (const cell of row) cell.forEach(add)
  }
  let best = 12
  let most = 0
  for (const [size, n] of count) if (n > most) [best, most] = [size, n]
  return best
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

function runEl(r: Run, base: number): Node {
  const plain = !r.bold && !r.italic && !r.underline && !r.strike && !r.sup && !r.sub && (!r.size || r.size === base)
  if (plain) return document.createTextNode(r.text)
  const el = document.createElement(r.sup ? 'sup' : r.sub ? 'sub' : 'span')
  el.textContent = r.text
  if (r.bold) el.style.fontWeight = '700'
  if (r.italic) el.style.fontStyle = 'italic'
  const lines = [r.underline && 'underline', r.strike && 'line-through'].filter(Boolean).join(' ')
  if (lines) el.style.textDecorationLine = lines
  if (r.size && r.size !== base) el.style.fontSize = `${clamp(r.size / base, 0.6, 3).toFixed(2)}em`
  return el
}

function paraEl(p: Para, base: number): HTMLElement {
  const el = document.createElement('p')
  el.className = 'doc-p'
  // One at a time: spreading a paragraph of 200,000 runs into one call overflows the stack (the review).
  for (const r of p.runs) el.append(runEl(r, base))
  if (p.align && p.align !== 'left') el.style.textAlign = p.align
  // Never more than a third of a phone's width.
  if (p.indent) el.style.marginInlineStart = `min(${(p.indent / base).toFixed(2)}em, 33%)`
  return el
}

function blockEl(b: Block, base: number): HTMLElement {
  if (b.kind === 'para') return paraEl(b, base)
  const table = document.createElement('table')
  table.className = 'doc-table'
  const body = table.createTBody()
  for (const row of b.rows) {
    const tr = body.insertRow()
    for (const cell of row) {
      const td = tr.insertCell()
      for (const p of cell) td.append(paraEl(p, base))
    }
  }
  // A wide table scrolls sideways on the sheet, rather than spilling off it.
  const wrap = document.createElement('div')
  wrap.className = 'doc-table-wrap'
  wrap.append(table)
  return wrap
}

/** The document's text, as elements for the viewer's page. */
export function docElements(doc: DocText): HTMLElement[] {
  if (doc.plain) {
    // Plain text as one paragraph of its lines: the page keeps its spaces and line breaks (white-space: pre-wrap).
    const el = document.createElement('p')
    el.className = 'doc-p doc-plain'
    el.textContent = doc.blocks.map((b) => (b.kind === 'para' ? b.runs.map((r) => r.text).join('') : '')).join('\n')
    return [el]
  }
  const base = bodySize(doc)
  return doc.blocks.map((b) => blockEl(b, base))
}

/** The first lines of a document's text, flattened, for its small picture. */
function firstLines(doc: DocText, max: number): { text: string; bold: boolean }[] {
  const lines: { text: string; bold: boolean }[] = []
  const add = (p: Para) => {
    const text = p.runs.map((r) => r.text).join('').replace(/\s+/g, ' ').trim()
    if (text) lines.push({ text, bold: p.runs.some((r) => r.bold && r.text.trim()) && p.runs.every((r) => r.bold || !r.text.trim()) })
  }
  for (const b of doc.blocks) {
    if (lines.length >= max) break
    if (b.kind === 'para') add(b)
    else for (const row of b.rows) add({ kind: 'para', runs: row.flatMap((cell) => cell.flatMap((p) => [...p.runs, { text: ' ' }])) })
  }
  return lines.slice(0, max)
}

/** Draws the top of a page of the document small and square onto canvas, side pixels wide: false if it has no text. */
export function drawTextThumb(canvas: HTMLCanvasElement, doc: DocText, side: number): boolean {
  const lines = firstLines(doc, 12)
  if (!lines.length) return false
  canvas.width = side
  canvas.height = side
  const ctx = canvas.getContext('2d')
  if (!ctx) return false
  // A sheet of paper, as a PDF's first page shows: white whatever the theme.
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, side, side)
  ctx.fillStyle = '#3a3d4a'
  const size = Math.max(4, Math.round(side / 11))
  const pad = Math.round(side / 9)
  const width = side - 2 * pad
  const step = Math.round(size * 1.35)
  let y = pad + size
  for (const line of lines) {
    ctx.font = doc.plain ? `400 ${size}px ui-monospace, monospace` : `${line.bold ? '700' : '400'} ${size}px system-ui, sans-serif`
    // Wrapped word by word, forwards, from no more than a line's worth of each paragraph: only a few
    // rows fit, and measuring a long paragraph again and again froze a tab (the review).
    let row = ''
    for (const word of line.text.slice(0, 300).split(' ')) {
      const next = row ? `${row} ${word}` : word
      if (!row || ctx.measureText(next).width <= width) {
        row = next
        continue
      }
      ctx.fillText(row, pad, y, width)
      y += step
      if (y >= side) return true
      row = word
    }
    if (row) ctx.fillText(row, pad, y, width)
    y += step
    if (y >= side) break
  }
  return true
}
