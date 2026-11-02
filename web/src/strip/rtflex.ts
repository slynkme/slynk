// RTF's tokens, for the cleaner (rtf.ts) and the document preview
// (docview/rtf.ts): every control word (\b), {group}, symbol (\'hh, \~) and
// run of text, with where it is, and the code page \'hh bytes are in. Kept
// apart from the cleaner so the page can read RTF without loading it.
import { fail } from './types.ts'

export const isLetter = (c: number) => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)
export const isDigit = (c: number) => c >= 0x30 && c <= 0x39
export const isHex = (c: number) => isDigit(c) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66)

export type Token =
  | { t: 'open' | 'close' | 'text'; at: number; end: number }
  | { t: 'word'; at: number; end: number; word: string; param: number | null; spaced: boolean }
  | { t: 'symbol'; at: number; end: number; ch: number }
  /** \binN and its N raw bytes. */
  | { t: 'bin'; at: number; end: number; data: number }

/** Reads RTF's tokens. Text runs stop at the next backslash or brace, and at line breaks (which RTF ignores). */
export class Lexer {
  i = 0
  readonly b: Uint8Array
  constructor(b: Uint8Array) {
    this.b = b
  }

  next(): Token | null {
    const b = this.b
    const at = this.i
    if (at >= b.length) return null
    const c = b[at]
    if (c === 0x7b || c === 0x7d) {
      this.i++
      return { t: c === 0x7b ? 'open' : 'close', at, end: this.i }
    }
    if (c !== 0x5c) {
      let i = at + 1
      if (c !== 0x0d && c !== 0x0a) while (i < b.length && b[i] !== 0x5c && b[i] !== 0x7b && b[i] !== 0x7d && b[i] !== 0x0d && b[i] !== 0x0a) i++
      this.i = i
      return { t: 'text', at, end: i }
    }
    let i = at + 1
    if (i >= b.length) fail('the file ends in the middle of a control word')
    if (!isLetter(b[i])) {
      const ch = b[i]
      i += ch === 0x27 ? 3 : 1 // \'hh
      this.i = Math.min(i, b.length)
      return { t: 'symbol', at, end: this.i, ch }
    }
    const start = i
    while (i < b.length && isLetter(b[i]) && i - start < 32) i++
    const word = String.fromCharCode(...b.subarray(start, i))
    let param: number | null = null
    if (i < b.length && (isDigit(b[i]) || (b[i] === 0x2d && isDigit(b[i + 1] ?? 0)))) {
      const p = i
      i++
      while (i < b.length && isDigit(b[i]) && i - p < 11) i++
      param = Number(String.fromCharCode(...b.subarray(p, i)))
    }
    const spaced = b[i] === 0x20
    if (spaced) i++
    if (word === 'bin' && param !== null && param > 0) {
      if (i + param > b.length) fail('binary data runs past the end of the file')
      this.i = i + param
      return { t: 'bin', at, end: this.i, data: i }
    }
    this.i = i
    return { t: 'word', at, end: i, word, param, spaced }
  }
}

/** A windows-125x and similar code page's decoder for \'hh bytes, or windows-1252's. */
export function codePage(b: Uint8Array): TextDecoder {
  const head = String.fromCharCode(...b.subarray(0, Math.min(b.length, 512)))
  const n = Number(/\\ansicpg(\d+)/.exec(head)?.[1] ?? 1252)
  const names: Record<number, string> = { 932: 'shift_jis', 936: 'gbk', 949: 'euc-kr', 950: 'big5', 10000: 'macintosh', 65001: 'utf-8' }
  try {
    return new TextDecoder(names[n] ?? (n >= 874 && n <= 1258 ? `windows-${n}` : 'windows-1252'))
  } catch {
    return new TextDecoder('windows-1252')
  }
}

