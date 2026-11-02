// RTF documents: plain text, where everything is a control word (\b) or a
// {group}. They're cleaned by cutting groups and words out of the text; every
// other byte is copied as it is.
//
// Removed: the info group (author, last editor, company, manager, title,
// subject, keywords, comments, dates, revision, editing time, statistics), the
// app that wrote it, the template's path, custom properties (where sensitivity
// labels live), document variables, Word's data store, editing-session IDs
// (the rsid table and every rsid word), anything after the document's end, and
// the metadata of pictures inside. Comments and tracked changes stay, with
// every author shown as "Author" and their dates removed.
import { stripPicture } from './embedded.ts'
import { ANON, LABEL } from './labels.ts'
import { type FormatOutcome, type Found, type Kind, fail } from './types.ts'
import { addAll, addFound } from './values.ts'
import { Lexer, codePage, isHex, type Token } from './rtflex.ts'

/** Whole groups taken out, by their first control word. */
const DROP: Record<string, string> = {
  generator: LABEL.app,
  template: LABEL.template,
  userprops: LABEL.custom,
  docvar: LABEL.custom,
  datastore: LABEL.appData,
  rsidtbl: LABEL.ids,
  atndate: LABEL.commentAuthors,
}

/** Control words taken out, with their number. */
const WORDS: Record<string, string> = {
  rsid: LABEL.ids,
  rsidroot: LABEL.ids,
  insrsid: LABEL.ids,
  charrsid: LABEL.ids,
  delrsid: LABEL.ids,
  sectrsid: LABEL.ids,
  pararsid: LABEL.ids,
  tblrsid: LABEL.ids,
  styrsid: LABEL.ids,
  // When each tracked change was made (who made it is a number into the revision table).
  revdttm: LABEL.changeAuthors,
  revdttmdel: LABEL.changeAuthors,
  crdate: LABEL.changeAuthors,
  pnrdate: LABEL.changeAuthors,
}

/** What the info group's fields are. Statistics and anything unknown are "other document details". */
const INFO: Record<string, string> = {
  author: LABEL.author,
  operator: LABEL.lastEditor,
  company: LABEL.company,
  manager: LABEL.manager,
  title: LABEL.title,
  subject: LABEL.title,
  keywords: LABEL.keywords,
  category: LABEL.keywords,
  doccomm: LABEL.description,
  comment: LABEL.description,
  creatim: LABEL.dates,
  revtim: LABEL.dates,
  printim: LABEL.dates,
  buptim: LABEL.dates,
  version: LABEL.revision,
  vern: LABEL.app,
  edmins: LABEL.editTime,
  id: LABEL.ids,
}

// Fields whose values the sender sees: names, the title and the app.
const SHOWN = new Set(['author', 'operator', 'company', 'manager', 'title', 'subject', 'generator'])

/** Kinds of picture that may carry their own metadata. */
const BLIPS = new Set(['jpegblip', 'pngblip'])

const enc = new TextEncoder()
interface Edit {
  from: number
  to: number
  put: Uint8Array
}

interface Group {
  /** Where its "{" is. */
  at: number
  /** After its "}". */
  end: number
  /** Its first control word, after any \*. */
  dest: string
  /** After that word (and its space). */
  inner: number
  /** Where its "}" is. */
  close: number
}

/** The readable text of b[from, to): escapes and \u characters decoded, control words and inner groups skipped. */
function textIn(b: Uint8Array, from: number, to: number, cp: TextDecoder): string {
  const lex = new Lexer(b.subarray(0, to))
  lex.i = from
  let out = ''
  let pending: number[] = []
  const flush = () => {
    if (pending.length) out += cp.decode(Uint8Array.from(pending))
    pending = []
  }
  let depth = 0
  let uc = 1
  let skip = 0
  for (let tok = lex.next(); tok; tok = lex.next()) {
    if (tok.t === 'open') depth++
    else if (tok.t === 'close') depth--
    if (depth !== 0 || tok.t === 'open' || tok.t === 'close' || tok.t === 'bin') continue
    if (tok.t === 'word') {
      if (tok.word === 'uc' && tok.param !== null) uc = tok.param
      else if (tok.word === 'u' && tok.param !== null) {
        flush()
        out += String.fromCharCode(tok.param < 0 ? tok.param + 65536 : tok.param)
        skip = uc
      } else if (['tab', 'line', 'par', 'emspace', 'enspace'].includes(tok.word)) {
        flush()
        out += ' '
      }
      continue
    }
    if (tok.t === 'symbol') {
      if (tok.ch === 0x27) {
        if (skip > 0) skip--
        else pending.push(parseInt(String.fromCharCode(b[tok.at + 2], b[tok.at + 3]), 16) || 0x3f)
      } else if (skip > 0) skip--
      else {
        flush()
        out += tok.ch === 0x7e ? ' ' : tok.ch === 0x5f ? '-' : tok.ch === 0x2d ? '' : String.fromCharCode(tok.ch)
      }
      continue
    }
    for (let i = tok.at; i < tok.end; i++) {
      if (b[i] === 0x0d || b[i] === 0x0a) continue
      if (skip > 0) skip--
      else pending.push(b[i])
    }
  }
  flush()
  return out
}

/** Hex for a picture's data, in lines of 128 characters as Word writes it. */
function hex(data: Uint8Array): Uint8Array {
  const digits = '0123456789abcdef'
  const lines = Math.ceil(data.length / 64)
  const out = new Uint8Array(data.length * 2 + lines)
  let o = 0
  for (let i = 0; i < data.length; i++) {
    if (i % 64 === 0) out[o++] = 0x0a
    out[o++] = digits.charCodeAt(data[i] >> 4)
    out[o++] = digits.charCodeAt(data[i] & 15)
  }
  return out
}

function unhex(b: Uint8Array, from: number, to: number): Uint8Array | null {
  const out = new Uint8Array((to - from) >> 1)
  let n = 0
  let high = -1
  for (let i = from; i < to; i++) {
    const c = b[i]
    if (c === 0x20 || c === 0x0d || c === 0x0a || c === 0x09) continue
    if (!isHex(c)) return null
    const v = c <= 0x39 ? c - 0x30 : (c | 0x20) - 0x57
    if (high < 0) high = v
    else {
      out[n++] = (high << 4) | v
      high = -1
    }
  }
  return high < 0 ? out.subarray(0, n) : null
}

type Size = { width: number; height: number }

/** A picture in an RTF file, and where its parts are. */
export interface RtfPicture {
  /** What kind it says it is: jpegblip, pngblip, emfblip, wmetafile, dibitmap… ('' when it doesn't say), and where that word is. */
  blip: string
  blipAt: number
  /** Its data's place in the file (hex, or a \bin run), and the bytes. */
  from: number
  to: number
  data: Uint8Array
  /** Its words with numbers (picw, picwgoal, picscalex…), and where each number is. */
  words: Map<string, { param: number; at: number; end: number }>
  /** Its {\*\blipuid} and \bliptag: IDs worked out from its bytes, wrong once they change. */
  ids: { at: number; end: number; group: boolean }[]
}

const KINDS = new Set(['jpegblip', 'pngblip', 'emfblip', 'wmetafile', 'macpict', 'pmmetafile', 'dibitmap', 'wbitmap'])

/** A {\pict} group's picture, from its tokens (as Cleaner.group reads them); null when its data is missing or broken up. */
function readPicture(b: Uint8Array, tokens: Token[]): RtfPicture | null {
  let depth = 0
  let blip = ''
  let blipAt = -1
  let from = -1
  let to = -1
  let bin: Uint8Array | null = null
  let split = false
  const words = new Map<string, { param: number; at: number; end: number }>()
  const ids: RtfPicture['ids'] = []
  let sub: { at: number; uid: boolean; first: boolean } | null = null
  for (const tok of tokens) {
    if (tok.t === 'open') {
      if (depth++ === 0) {
        if (from >= 0) split = true
        sub = { at: tok.at, uid: false, first: true }
      }
      continue
    }
    if (tok.t === 'close') {
      if (--depth === 0 && sub) {
        if (sub.uid) ids.push({ at: sub.at, end: tok.end, group: true })
        sub = null
      }
      continue
    }
    if (depth === 1 && sub?.first) {
      if (tok.t === 'word') {
        sub.uid = tok.word === 'blipuid'
        sub.first = false
      } else if (!(tok.t === 'symbol' && tok.ch === 0x2a) && !(tok.t === 'text' && (b[tok.at] === 0x0d || b[tok.at] === 0x0a))) sub.first = false
      continue
    }
    if (depth !== 0) continue
    if (tok.t === 'word') {
      if (!blip && KINDS.has(tok.word)) {
        blip = tok.word
        blipAt = tok.at
      }
      if (tok.word === 'bliptag') ids.push({ at: tok.at, end: tok.end, group: false })
      else if (from >= 0) split = true
      else if (tok.param !== null && !words.has(tok.word)) {
        const at = tok.at + 1 + tok.word.length
        words.set(tok.word, { param: tok.param, at, end: tok.end - (tok.spaced ? 1 : 0) })
      }
    } else if (tok.t === 'bin') {
      if (from >= 0) split = true
      from = tok.at
      to = tok.end
      bin = b.subarray(tok.data, tok.end)
    } else if (tok.t === 'text') {
      if (b.subarray(tok.at, tok.end).every((c) => c === 0x20 || c === 0x0d || c === 0x0a || c === 0x09)) continue
      if (bin) split = true
      if (from < 0) from = tok.at
      to = tok.end
    } else if (from >= 0) split = true
  }
  if (from < 0 || split) return null
  const data = bin ?? unhex(b, from, to)
  return data ? { blip, blipAt, from, to, data, words, ids } : null
}

/**
 * The edits that put new bytes in a picture's place: as hex, without its IDs
 * (a space stands in for \bliptag, so the words either side stay apart), with
 * \picw and \pich given new sizes when they counted the old one's pixels, and
 * \jpegblip for a PNG that became a JPEG.
 */
function pictureEdits(p: RtfPicture, bytes: Uint8Array, size?: { was: Size; now: Size; blip?: string }): Edit[] {
  const out: Edit[] = [{ from: p.from, to: p.to, put: hex(bytes) }]
  if (size?.blip && size.blip !== p.blip && p.blipAt >= 0) out.push({ from: p.blipAt + 1, to: p.blipAt + 1 + p.blip.length, put: enc.encode(size.blip) })
  for (const id of p.ids) out.push({ from: id.at, to: id.end, put: enc.encode(id.group ? '' : ' ') })
  const w = p.words.get('picw')
  const h = p.words.get('pich')
  if (size && w && h && w.param === size.was.width && h.param === size.was.height) {
    out.push({ from: w.at, to: w.end, put: enc.encode(String(size.now.width)) })
    out.push({ from: h.at, to: h.end, put: enc.encode(String(size.now.height)) })
  }
  return out
}

/** Every picture in an RTF file, wherever it is. */
export function rtfPictures(b: Uint8Array): RtfPicture[] {
  if (!isRtf(b)) fail('not an RTF file')
  const lex = new Lexer(b)
  const out: RtfPicture[] = []
  let depth = 0
  for (let tok = lex.next(); tok; tok = lex.next()) {
    if (tok.t === 'close') {
      if (--depth === 0) return out
      continue
    }
    if (tok.t !== 'open') continue
    depth++
    const save = lex.i
    let first = lex.next()
    while (first?.t === 'text' && (b[first.at] === 0x0d || b[first.at] === 0x0a)) first = lex.next()
    if (first?.t !== 'word' || first.word !== 'pict') {
      lex.i = save
      continue
    }
    // Its tokens, to its end.
    const tokens: Token[] = [first]
    let d = 1
    for (let t = lex.next(); t; t = lex.next()) {
      if (t.t === 'open') d++
      else if (t.t === 'close' && --d === 0) break
      tokens.push(t)
    }
    if (d !== 0) fail('a group is never closed')
    depth--
    const p = readPicture(b, tokens)
    if (p) out.push(p)
  }
  fail('the document never ends')
}

/** The file with new bytes for some of its pictures (and their new pixel sizes). */
export function withPictures(b: Uint8Array, changes: { picture: RtfPicture; bytes: Uint8Array; was: Size; now: Size; blip: string }[]): Uint8Array {
  return apply(
    b,
    changes.flatMap((c) => pictureEdits(c.picture, c.bytes, c)),
  )
}

/** Groups worth reading whole, by their first control word. */
const WANTED = new Set([...Object.keys(DROP), 'info', 'atnauthor', 'atnid', 'revtbl', 'pict'])

/**
 * Cuts and replacements, worked out in one pass. A cut that follows a control
 * word with no space after it leaves a space instead, so that word doesn't run
 * into what comes next (\b{\*\rsidtbl…}x mustn't become \bx).
 */
class Cleaner {
  readonly edits: Edit[] = []
  readonly labels = new Set<string>()
  readonly values: Found[] = []
  readonly pictures: RtfPicture[] = []
  /** The last token kept was a control word with nothing after it yet. */
  private bare = false
  private readonly cp: TextDecoder
  private readonly lex: Lexer

  readonly b: Uint8Array

  constructor(b: Uint8Array) {
    this.b = b
    this.cp = codePage(b)
    this.lex = new Lexer(b)
  }

  private cut(from: number, to: number) {
    this.edits.push({ from, to, put: this.bare ? enc.encode(' ') : new Uint8Array(0) })
    this.bare = false
  }

  private isBreak(tok: Token): boolean {
    return tok.t === 'text' && (this.b[tok.at] === 0x0d || this.b[tok.at] === 0x0a)
  }

  /** The first control word of the group whose "{" was just read (after any \*), and where it ends; the lexer doesn't move. */
  private peek(): { dest: string; inner: number } {
    const save = this.lex.i
    let tok = this.lex.next()
    while (tok && this.isBreak(tok)) tok = this.lex.next()
    if (tok?.t === 'symbol' && tok.ch === 0x2a) tok = this.lex.next()
    while (tok && this.isBreak(tok)) tok = this.lex.next()
    this.lex.i = save
    return tok?.t === 'word' ? { dest: tok.word, inner: tok.end } : { dest: '', inner: save }
  }

  /** Reads the group whose "{" at `at` was just read, to its "}". */
  private group(at: number): Group & { tokens: Token[] } {
    const { dest, inner } = this.peek()
    const tokens: Token[] = []
    let depth = 1
    for (let tok = this.lex.next(); tok; tok = this.lex.next()) {
      if (tok.t === 'open') depth++
      else if (tok.t === 'close' && --depth === 0) return { at, end: tok.end, dest, inner, close: tok.at, tokens }
      tokens.push(tok)
    }
    fail('a group is never closed')
  }

  /** Walks the document, noting what to cut; returns where it ends. */
  run(): number {
    let depth = 0
    for (let tok = this.lex.next(); tok; tok = this.lex.next()) {
      if (tok.t === 'close') {
        this.bare = false
        if (--depth === 0) return tok.end
        continue
      }
      if (tok.t === 'open') {
        if (depth === 0 && tok.at !== 0) fail('not an RTF file')
        const save = this.lex.i
        if (depth > 0 && WANTED.has(this.peek().dest)) {
          if (this.handle(this.group(tok.at))) {
            this.bare = false
            continue
          }
          this.lex.i = save
        }
        depth++
        this.bare = false
        continue
      }
      if (tok.t === 'word') {
        const label = Object.hasOwn(WORDS, tok.word) ? WORDS[tok.word] : undefined
        if (label && tok.param !== null) {
          this.labels.add(label)
          this.cut(tok.at, tok.end)
        } else this.bare = !tok.spaced
        continue
      }
      // Text, a symbol or a line break: each ends a word that had no space after it.
      this.bare = false
    }
    fail('the document never ends')
  }

  /** Deals with a group if it's one to change, true if so; false leaves it to be walked into. */
  private handle(g: Group & { tokens: Token[] }): boolean {
    if (g.dest === 'info') {
      if (!this.info(g)) return false
      this.cut(g.at, g.end)
      return true
    }
    if (Object.hasOwn(DROP, g.dest)) {
      this.labels.add(DROP[g.dest])
      const text = () => textIn(this.b, g.inner, g.close, this.cp)
      // Sensitivity labels are custom properties named MSIP_Label_….
      if (g.dest === 'userprops' && /MSIP_Label/i.test(new TextDecoder('latin1').decode(this.b.subarray(g.inner, g.close)))) this.labels.add(LABEL.sensitivity)
      if (SHOWN.has(g.dest)) addFound(this.values, DROP[g.dest], text().replace(/;\s*$/, ''))
      this.cut(g.at, g.end)
      return true
    }
    if (g.dest === 'atnauthor' || g.dest === 'atnid') {
      const want = g.dest === 'atnauthor' ? ANON : ''
      if (textIn(this.b, g.inner, g.close, this.cp).trim() !== want) {
        this.labels.add(LABEL.commentAuthors)
        // From before the space that ends the word, so the name gets exactly one.
        const from = this.b[g.inner - 1] === 0x20 ? g.inner - 1 : g.inner
        this.edits.push({ from, to: g.close, put: enc.encode(want ? ` ${want}` : '') })
      }
      return true
    }
    if (g.dest === 'revtbl') {
      this.revisionTable(g)
      return true
    }
    if (g.dest === 'pict') {
      this.picture(g)
      return true
    }
    return false
  }

  /** Labels the info group's fields; returns how many there were. */
  private info(g: Group & { tokens: Token[] }): number {
    let fields = 0
    let depth = 0
    let sub: { name: string; inner: number; first: boolean } | null = null
    for (const tok of g.tokens) {
      if (tok.t === 'open') {
        if (depth++ === 0) sub = { name: '', inner: tok.end, first: true }
        continue
      }
      if (tok.t === 'close') {
        if (--depth === 0 && sub) {
          // {\author Jane}, {\*\company Example}, {\creatim\yr2024\mo6…}
          const value = textIn(this.b, sub.inner, tok.at, this.cp)
          const isTime = ['creatim', 'revtim', 'printim', 'buptim'].includes(sub.name)
          if (isTime || value.trim()) {
            fields++
            this.labels.add(Object.hasOwn(INFO, sub.name) ? INFO[sub.name] : LABEL.otherDoc)
            if (SHOWN.has(sub.name)) addFound(this.values, INFO[sub.name], value)
          }
          sub = null
        }
        continue
      }
      if (depth === 1 && sub?.first) {
        if (tok.t === 'word') {
          sub.name = tok.word
          sub.inner = tok.end
          sub.first = false
        } else if (!(tok.t === 'symbol' && tok.ch === 0x2a) && !this.isBreak(tok)) sub.first = false
        continue
      }
      // The group's own words: \version3, \edmins12, \nofpages2 (the first is \info itself).
      if (depth === 0 && tok.t === 'word' && tok.at >= g.inner && tok.word !== 'uc') {
        fields++
        this.labels.add(Object.hasOwn(INFO, tok.word) ? INFO[tok.word] : LABEL.otherDoc)
      }
    }
    return fields
  }

  /** Every name in the tracked-changes table becomes "Author" ("Unknown", Word's first entry, stays). */
  private revisionTable(g: Group & { tokens: Token[] }) {
    let depth = 0
    let start = 0
    for (const tok of g.tokens) {
      if (tok.t === 'open' && depth++ === 0) start = tok.end
      else if (tok.t === 'close' && --depth === 0) {
        const name = textIn(this.b, start, tok.at, this.cp).replace(/;\s*$/, '').trim()
        if (name && name !== 'Unknown' && name !== ANON) {
          this.labels.add(LABEL.changeAuthors)
          this.edits.push({ from: start, to: tok.at, put: enc.encode(`${ANON};`) })
        }
      }
    }
  }

  /** Notes a JPEG or PNG picture, to be cleaned once the walk is done. */
  private picture(g: Group & { tokens: Token[] }) {
    const p = readPicture(this.b, g.tokens)
    if (p && BLIPS.has(p.blip)) this.pictures.push(p)
  }
}

function apply(b: Uint8Array, edits: Edit[]): Uint8Array {
  edits.sort((x, y) => x.from - y.from)
  let size = b.length
  for (let k = 0; k < edits.length; k++) {
    if (k && edits[k].from < edits[k - 1].to) fail('two changes overlap')
    size += edits[k].put.length - (edits[k].to - edits[k].from)
  }
  const out = new Uint8Array(size)
  let o = 0
  let i = 0
  for (const e of edits) {
    out.set(b.subarray(i, e.from), o)
    o += e.from - i
    out.set(e.put, o)
    o += e.put.length
    i = e.to
  }
  out.set(b.subarray(i), o)
  return out
}

/** True when b starts like an RTF file. */
export function isRtf(b: Uint8Array): boolean {
  return b.length >= 5 && String.fromCharCode(...b.subarray(0, 5)) === '{\\rtf'
}

export async function strip(bytes: Uint8Array, _kind: Kind): Promise<FormatOutcome> {
  if (!isRtf(bytes)) fail('not an RTF file')
  const c = new Cleaner(bytes)
  const end = c.run()
  // Anything after the last "}" that isn't blank.
  if (bytes.subarray(end).some((v) => v !== 0 && v !== 0x20 && v !== 0x0d && v !== 0x0a && v !== 0x09)) {
    c.labels.add(LABEL.trailing)
    c.edits.push({ from: end, to: bytes.length, put: new Uint8Array(0) })
  }
  const values = c.values
  for (const p of c.pictures) {
    const out = await stripPicture(p.data)
    if (!out) continue
    c.edits.push(...pictureEdits(p, out.bytes))
    out.removed.forEach((l) => c.labels.add(l))
    addAll(values, out.values)
  }
  if (c.labels.size === 0) return { status: 'unchanged' }
  return { status: 'cleaned', bytes: apply(bytes, c.edits), removed: [...c.labels], values }
}

export async function verify(bytes: Uint8Array, kind: Kind): Promise<void> {
  // strip() reads every group to its end and fails on one left open or closed twice.
  const again = await strip(bytes, kind)
  if (again.status !== 'unchanged') fail('something is still left to remove')
}
