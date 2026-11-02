// Where each picture in a PDF is shown, and how big. A picture's pixels are
// spread over whatever area the page draws it at, so how sharp it looks is its
// pixels per inch there: a phone photo shown 3 inches wide has about 1,300
// pixels per inch, far more than any screen or printer can show, and can lose
// most of them without looking any different.
//
// This reads each page's drawing instructions (its content streams) for only
// two things, the transforms (q, Q, cm) and the pictures drawn (Do), following
// forms and the appearances of annotations (stamps, filled-in fields). Pictures
// drawn only inside patterns or Type 3 fonts aren't found; the caller sizes
// those as if they filled a page.
import { PDFArray, PDFDict, type PDFDocument, PDFName, PDFNumber, type PDFObject, PDFRawStream, PDFRef, decodePDFRawStream } from 'pdf-lib'

/** [a b c d e f]: a point (x, y) goes to (ax + cy + e, bx + dy + f). */
export type Matrix = [number, number, number, number, number, number]
export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

/** m applied first, then n (PDF's order: cm makes the new CTM m × CTM). */
export function mul(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ]
}

// --- Reading drawing instructions -------------------------------------------------------

/** An operand: a number, a name (without its slash), or anything else (null). */
export type Arg = number | { name: string } | null

const WS = new Uint8Array(256)
for (const c of [0, 9, 10, 12, 13, 32]) WS[c] = 1
const DELIM = new Uint8Array(256)
for (const c of '()<>[]{}/%') DELIM[c.charCodeAt(0)] = 1
const regular = (c: number) => !WS[c] && !DELIM[c]

function decodeName(raw: string): string {
  return raw.includes('#') ? raw.replace(/#([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))) : raw
}

/**
 * Calls onOp for each operator in a content stream, with its operands.
 * Strings, arrays and dictionaries are stepped over (as nulls). An inline
 * picture's data is skipped; returns how many there were.
 */
export function readOps(b: Uint8Array, onOp: (op: string, args: Arg[]) => void): number {
  const n = b.length
  let args: Arg[] = []
  let inline = 0
  let i = 0
  const word = () => {
    const from = i
    while (i < n && regular(b[i])) i++
    return String.fromCharCode(...b.subarray(from, Math.min(i, from + 127)))
  }
  while (i < n) {
    const c = b[i]
    if (WS[c]) {
      i++
    } else if (c === 0x25) {
      // % comment, to the end of the line.
      while (i < n && b[i] !== 10 && b[i] !== 13) i++
    } else if (c === 0x28) {
      // (literal string), with nested brackets and backslash escapes.
      let depth = 1
      i++
      while (i < n && depth) {
        const d = b[i++]
        if (d === 0x5c) i++
        else if (d === 0x28) depth++
        else if (d === 0x29) depth--
      }
      args.push(null)
    } else if (c === 0x3c) {
      if (b[i + 1] === 0x3c) i += 2 // << dictionary: its contents become operands, which the operator ignores
      else {
        while (i < n && b[i] !== 0x3e) i++ // <hex string>
        i++
        args.push(null)
      }
    } else if (c === 0x3e) {
      i += b[i + 1] === 0x3e ? 2 : 1
      args.push(null)
    } else if (c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d || c === 0x29) {
      i++
      args.push(null)
    } else if (c === 0x2f) {
      i++
      args.push({ name: decodeName(word()) })
    } else {
      const w = word()
      if (!w) {
        i++
        continue
      }
      const ch = w.charCodeAt(0)
      if ((ch >= 0x30 && ch <= 0x39) || ch === 0x2b || ch === 0x2d || ch === 0x2e) {
        const v = Number(w)
        args.push(Number.isFinite(v) ? v : null)
      } else if (w === 'true' || w === 'false' || w === 'null') {
        args.push(null)
      } else if (w === 'ID') {
        // An inline picture's data: from one byte after ID to an EI that has
        // white space either side (the usual way to find its end).
        i++
        let j = i
        while (j < n - 1 && !(b[j] === 0x45 && b[j + 1] === 0x49 && WS[b[j - 1]] && (j + 2 >= n || !regular(b[j + 2])))) j++
        i = Math.min(n, j + 2)
        inline++
        args = []
      } else {
        onOp(w, args)
        args = []
      }
    }
    if (args.length > 64) args = args.slice(-8)
  }
  return inline
}

// --- Following the pictures ---------------------------------------------------------------

/** The largest size a picture is shown at, in inches, and on which pages (1 = the first). */
export interface Shown {
  w: number
  h: number
  pages: number[]
}

export interface Placements {
  shown: Map<PDFRef, Shown>
  /** Inline pictures (in the drawing instructions themselves): left as they are. */
  inline: number
  /** The largest page, in inches, for pictures not found on any page. */
  page: { w: number; h: number }
  /** Pages whose drawing instructions couldn't be read. */
  unread: number
}

interface Use {
  ref: PDFRef
  m: Matrix
}

const MAX_DEPTH = 16
/** Uses kept per form: a form drawn thousands of times needs only its largest. */
const MAX_USES = 512

const num = (o: PDFObject | undefined) => (o instanceof PDFNumber ? o.asNumber() : undefined)

function matrixOf(doc: PDFDocument, o: PDFObject | undefined): Matrix {
  const a = doc.context.lookup(o)
  if (!(a instanceof PDFArray) || a.size() !== 6) return IDENTITY
  const m = a.asArray().map((v) => num(doc.context.lookup(v)))
  return m.every((v) => v !== undefined) ? (m as Matrix) : IDENTITY
}

function rectOf(doc: PDFDocument, o: PDFObject | undefined): [number, number, number, number] | undefined {
  const a = doc.context.lookup(o)
  if (!(a instanceof PDFArray) || a.size() !== 4) return undefined
  const r = a.asArray().map((v) => num(doc.context.lookup(v)))
  if (r.some((v) => v === undefined)) return undefined
  const [x1, y1, x2, y2] = r as number[]
  return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)]
}

function streamBytes(o: PDFObject | undefined): Uint8Array | undefined {
  if (!(o instanceof PDFRawStream)) return undefined
  try {
    return decodePDFRawStream(o).decode()
  } catch {
    return undefined
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length + 1, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    out[at + p.length] = 10 // streams may split an instruction between them, never a word
    at += p.length + 1
  }
  return out
}

/** Where every picture is shown, read from every page. */
export function placements(doc: PDFDocument): Placements {
  const ctx = doc.context
  const shown = new Map<PDFRef, Shown>()
  const forms = new Map<PDFRef, Use[]>()
  const busy = new Set<PDFRef>()
  let inline = 0
  let unread = 0
  const page = { w: 0, h: 0 }

  const xobject = (res: PDFDict | undefined, name: string): PDFRef | undefined => {
    const xo = ctx.lookup(res?.get(PDFName.of('XObject')))
    if (!(xo instanceof PDFDict)) return undefined
    for (const [k, v] of xo.entries()) if (k.decodeText() === name) return v instanceof PDFRef ? v : undefined
    return undefined
  }

  /** The pictures a content stream draws, in its own space. */
  const uses = (bytes: Uint8Array, res: PDFDict | undefined, depth: number): Use[] => {
    const out: Use[] = []
    let ctm = IDENTITY
    const saved: Matrix[] = []
    inline += readOps(bytes, (op, args) => {
      if (op === 'q') saved.push(ctm)
      else if (op === 'Q') ctm = saved.pop() ?? ctm
      else if (op === 'cm') {
        const m = args.slice(-6)
        if (m.length === 6 && m.every((v) => typeof v === 'number')) ctm = mul(m as Matrix, ctm)
      } else if (op === 'Do') {
        const a = args[args.length - 1]
        if (!a || typeof a !== 'object') return
        const ref = xobject(res, a.name)
        const obj = ref && ctx.lookup(ref)
        if (!ref || !(obj instanceof PDFRawStream)) return
        const sub = obj.dict.get(PDFName.of('Subtype'))
        if (sub === PDFName.of('Image')) out.push({ ref, m: ctm })
        else if (sub === PDFName.of('Form')) {
          const at = mul(matrixOf(doc, obj.dict.get(PDFName.of('Matrix'))), ctm)
          for (const u of form(ref, obj, res, depth + 1)) out.push({ ref: u.ref, m: mul(u.m, at) })
        }
      }
    })
    return out
  }

  /** A form's pictures, in its space before its own Matrix; read once. */
  const form = (ref: PDFRef, obj: PDFRawStream, parentRes: PDFDict | undefined, depth: number): Use[] => {
    const known = forms.get(ref)
    if (known) return known
    if (busy.has(ref) || depth > MAX_DEPTH) return []
    busy.add(ref)
    const bytes = streamBytes(obj)
    const res = ctx.lookup(obj.dict.get(PDFName.of('Resources')))
    let found = bytes ? uses(bytes, res instanceof PDFDict ? res : parentRes, depth) : []
    busy.delete(ref)
    if (found.length > MAX_USES) {
      const scale = (m: Matrix) => Math.abs(m[0] * m[3] - m[1] * m[2])
      found = found.sort((x, y) => scale(y.m) - scale(x.m)).slice(0, MAX_USES)
    }
    forms.set(ref, found)
    return found
  }

  const record = (u: Use, inches: number, pageNo: number) => {
    const w = Math.hypot(u.m[0], u.m[1]) * inches
    const h = Math.hypot(u.m[2], u.m[3]) * inches
    if (!(w > 0 && h > 0)) return
    const s = shown.get(u.ref)
    if (!s) shown.set(u.ref, { w, h, pages: [pageNo] })
    else {
      s.w = Math.max(s.w, w)
      s.h = Math.max(s.h, h)
      if (s.pages[s.pages.length - 1] !== pageNo && s.pages.length < 50) s.pages.push(pageNo)
    }
  }

  // The page tree, read directly (with what pages inherit) so nothing is normalised on the way.
  let pageNo = 0
  const seen = new Set<PDFDict>()
  const visit = (node: PDFDict, inherited: { res?: PDFDict; box?: PDFObject }, depth: number) => {
    if (seen.has(node) || depth > 64) return
    seen.add(node)
    const r = ctx.lookup(node.get(PDFName.of('Resources')))
    const here = {
      res: r instanceof PDFDict ? r : inherited.res,
      box: node.get(PDFName.of('CropBox')) ?? node.get(PDFName.of('MediaBox')) ?? inherited.box,
    }
    const kids = ctx.lookup(node.get(PDFName.of('Kids')))
    if (kids instanceof PDFArray) {
      for (const k of kids.asArray()) {
        const kid = ctx.lookup(k)
        if (kid instanceof PDFDict) visit(kid, here, depth + 1)
      }
      return
    }
    pageNo++
    const inches = (num(ctx.lookup(node.get(PDFName.of('UserUnit')))) ?? 1) / 72
    const box = rectOf(doc, here.box)
    if (box) {
      page.w = Math.max(page.w, (box[2] - box[0]) * inches)
      page.h = Math.max(page.h, (box[3] - box[1]) * inches)
    }
    const contents = ctx.lookup(node.get(PDFName.of('Contents')))
    const parts = (contents instanceof PDFArray ? contents.asArray().map((c) => ctx.lookup(c)) : [contents]).filter((c) => c !== undefined)
    const decoded = parts.map(streamBytes)
    if (decoded.some((d) => !d)) unread++
    const bytes = concat(decoded.filter((d): d is Uint8Array => !!d))
    for (const u of uses(bytes, here.res, 0)) record(u, inches, pageNo)

    // Annotations' appearances: the form's box is fitted to the annotation's rectangle.
    const annots = ctx.lookup(node.get(PDFName.of('Annots')))
    if (!(annots instanceof PDFArray)) return
    for (const a of annots.asArray()) {
      const annot = ctx.lookup(a)
      if (!(annot instanceof PDFDict)) continue
      const rect = rectOf(doc, annot.get(PDFName.of('Rect')))
      const ap = ctx.lookup(annot.get(PDFName.of('AP')))
      const normal = ap instanceof PDFDict ? ap.get(PDFName.of('N')) : undefined
      if (!rect || !normal) continue
      const target = ctx.lookup(normal)
      const refs: PDFRef[] = []
      if (normal instanceof PDFRef && target instanceof PDFRawStream) refs.push(normal)
      else if (target instanceof PDFDict) for (const [, v] of target.entries()) if (v instanceof PDFRef) refs.push(v)
      for (const ref of refs) {
        const f = ctx.lookup(ref)
        if (!(f instanceof PDFRawStream)) continue
        const fm = matrixOf(doc, f.dict.get(PDFName.of('Matrix')))
        const bbox = rectOf(doc, f.dict.get(PDFName.of('BBox')))
        if (!bbox) continue
        const corners = [
          [bbox[0], bbox[1]],
          [bbox[2], bbox[1]],
          [bbox[0], bbox[3]],
          [bbox[2], bbox[3]],
        ].map(([x, y]) => [fm[0] * x + fm[2] * y + fm[4], fm[1] * x + fm[3] * y + fm[5]])
        const xs = corners.map((p) => p[0])
        const ys = corners.map((p) => p[1])
        const bw = Math.max(...xs) - Math.min(...xs)
        const bh = Math.max(...ys) - Math.min(...ys)
        if (!(bw > 0 && bh > 0)) continue
        const sx = (rect[2] - rect[0]) / bw
        const sy = (rect[3] - rect[1]) / bh
        const fit: Matrix = [sx, 0, 0, sy, rect[0] - Math.min(...xs) * sx, rect[1] - Math.min(...ys) * sy]
        const at = mul(fm, fit)
        for (const u of form(ref, f, here.res, 1)) record({ ref: u.ref, m: mul(u.m, at) }, inches, pageNo)
      }
    }
  }
  const root = ctx.lookup(doc.catalog.get(PDFName.of('Pages')))
  if (root instanceof PDFDict) visit(root, {}, 0)
  if (!(page.w > 0 && page.h > 0)) Object.assign(page, { w: 8.5, h: 11 })
  return { shown, inline, page, unread }
}
