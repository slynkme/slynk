// The parts of a Word or LibreOffice file a preview reads:
// its ZIP directory read as strictly as the cleaner reads it
// (strip/zipdir.ts), and each part decompressed only as far as the preview
// needs, so a part that would expand to gigabytes (a "zip bomb") stops there.
// fflate's synchronous API only: its async one starts blob: workers, which the
// CSP forbids.
import { Inflate } from 'fflate'
import { readZipDirectory, type ZipEntry } from '../strip/zipdir.ts'

/** How far the document's own part (Word's document.xml, LibreOffice's content.xml) is read, at most. */
export const MAIN_CAP = 16_000_000
/** How far the parts it looks things up in (styles, numbering, the lists of parts) are read, at most: real ones are under 0.5 MB. */
export const SIDE_CAP = 2_000_000

/**
 * How much of the document's part to read for maxChars of text: room for a lot of markup around
 * each character, so a small picture of the first lines needs only the start of a long document.
 */
export const mainCap = (maxChars: number) => Math.min(MAIN_CAP, 1_000_000 + maxChars * 64)

export interface PartText {
  text: string
  /** All of the part: not cut at the cap, nor damaged partway. */
  whole: boolean
}

const ENOUGH = new Error('enough')

/** Raw deflate data, inflated no further than max bytes, or up to where it's damaged. */
function inflatePrefix(data: Uint8Array, max: number): { out: Uint8Array; whole: boolean } {
  const parts: Uint8Array[] = []
  let total = 0
  let whole = true
  const stream = new Inflate()
  stream.ondata = (chunk: Uint8Array) => {
    parts.push(chunk)
    total += chunk.length
    if (total > max) throw ENOUGH
  }
  try {
    // Small slices: fflate expands each push in one go, and deflate can grow a thousandfold.
    const step = 1024
    for (let i = 0; i < data.length || i === 0; i += step) stream.push(data.subarray(i, i + step), i + step >= data.length)
  } catch {
    whole = false
  }
  const out = new Uint8Array(Math.min(total, max))
  let at = 0
  for (const p of parts) {
    if (at >= out.length) break
    out.set(p.subarray(0, out.length - at), at)
    at += p.length
  }
  return { out, whole: whole && total <= max }
}

/** UTF-8, or UTF-16 with its byte-order mark. A character cut in two at the end isn't shown half. */
function decode(b: Uint8Array, whole: boolean): string {
  const label = b[0] === 0xff && b[1] === 0xfe ? 'utf-16le' : b[0] === 0xfe && b[1] === 0xff ? 'utf-16be' : 'utf-8'
  return new TextDecoder(label).decode(b, { stream: !whole })
}

export class Package {
  private bytes: Uint8Array
  private entries: Map<string, ZipEntry>
  /** Throws if it isn't a ZIP the cleaner would read either. */
  constructor(bytes: Uint8Array) {
    this.bytes = bytes
    this.entries = new Map(readZipDirectory(bytes).map((e) => [e.name, e]))
  }

  has(name: string): boolean {
    return this.entries.has(name)
  }

  /** A part's text, no more than max bytes of it; undefined if there's no such part. Throws if it's locked. */
  text(name: string, max: number): PartText | undefined {
    const e = this.entries.get(name)
    if (!e) return undefined
    if (e.flags & 1 || (e.method !== 0 && e.method !== 8)) throw new Error('a locked or unreadable part')
    const raw = this.bytes.subarray(e.dataOffset, e.dataOffset + e.csize)
    const { out, whole } = e.method === 0 ? { out: raw.subarray(0, max), whole: raw.length <= max } : inflatePrefix(raw, max)
    return { text: decode(out, whole), whole }
  }
}
