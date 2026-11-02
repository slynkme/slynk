// GIF: walk the blocks. Keep every frame, its graphic control (timing and
// transparency), the looping extension and an ICC profile; drop comments, XMP,
// Photoshop/IPTC, Content Credentials and anything after the trailer.
import { concat, fromUtf8, latin1, u8 } from './bytes.ts'
import { LABEL } from './labels.ts'
import { type FormatOutcome, type Found, fail } from './types.ts'
import { addAll } from './values.ts'
import { xmpLabels, xmpValues } from './xmp.ts'

const KEEP_APPS = new Set(['NETSCAPE2.0', 'ANIMEXTS1.0', 'ICCRGBG1012'])

/** Skips data sub-blocks starting at i; returns the offset after the terminator. */
function subBlocks(b: Uint8Array, i: number): number {
  for (;;) {
    const n = u8(b, i)
    i += 1 + n
    if (n === 0) return i
    if (i > b.length) fail('the GIF is cut short')
  }
}

interface Block {
  kind: 'image' | 'gce' | 'text' | 'app' | 'comment' | 'other'
  app?: string
  start: number
  end: number
}

function blocks(b: Uint8Array): { header: number; list: Block[]; end: number } {
  const sig = latin1(b, 0, 6)
  if (sig !== 'GIF87a' && sig !== 'GIF89a') fail('not a GIF')
  const packed = u8(b, 10)
  const header = 13 + (packed & 0x80 ? 3 * 2 ** ((packed & 7) + 1) : 0)
  if (header > b.length) fail('the GIF is cut short')
  const list: Block[] = []
  let pos = header
  for (;;) {
    const t = u8(b, pos)
    if (t === 0x3b) return { header, list, end: pos + 1 }
    if (t === 0x2c) {
      const p = u8(b, pos + 9)
      const table = p & 0x80 ? 3 * 2 ** ((p & 7) + 1) : 0
      const end = subBlocks(b, pos + 10 + table + 1)
      list.push({ kind: 'image', start: pos, end })
      pos = end
    } else if (t === 0x21) {
      const label = u8(b, pos + 1)
      const end = subBlocks(b, pos + 2)
      if (label === 0xf9) list.push({ kind: 'gce', start: pos, end })
      else if (label === 0x01) list.push({ kind: 'text', start: pos, end })
      else if (label === 0xfe) list.push({ kind: 'comment', start: pos, end })
      else if (label === 0xff) {
        const n = u8(b, pos + 2)
        list.push({ kind: 'app', app: latin1(b, pos + 3, pos + 3 + Math.min(n, 11)), start: pos, end })
      } else list.push({ kind: 'other', start: pos, end })
      pos = end
    } else fail('bad GIF block')
  }
}

function analyse(b: Uint8Array) {
  const { header, list, end } = blocks(b)
  const labels = new Set<string>()
  const values: Found[] = []
  const parts: Uint8Array[] = [b.subarray(0, header)]
  for (const blk of list) {
    if (blk.kind === 'image' || blk.kind === 'gce' || blk.kind === 'text' || (blk.kind === 'app' && KEEP_APPS.has(blk.app!))) {
      parts.push(b.subarray(blk.start, blk.end))
    } else if (blk.kind === 'comment') labels.add(LABEL.comments)
    else if (blk.app === 'XMP DataXMP') {
      const text = fromUtf8(b.subarray(blk.start + 14, blk.end))
      const found = xmpLabels(text)
      ;(found.length ? found : [LABEL.otherPhoto]).forEach((l) => labels.add(l))
      addAll(values, xmpValues(text))
    } else if (blk.app?.startsWith('MGKIPTC')) labels.add(LABEL.iptc)
    else if (blk.app?.startsWith('MGK8BIM')) labels.add(LABEL.appData) // Photoshop's own resources
    else if (blk.app?.startsWith('C2PA_GIF')) labels.add(LABEL.c2pa)
    else labels.add(LABEL.other)
  }
  parts.push(new Uint8Array([0x3b]))
  if (end < b.length && b.subarray(end).some((v) => v !== 0)) labels.add(LABEL.trailing)
  return { labels, values, parts }
}

export function strip(b: Uint8Array): FormatOutcome {
  const a = analyse(b)
  if (a.labels.size === 0) return { status: 'unchanged' }
  return { status: 'cleaned', bytes: concat(a.parts), removed: [...a.labels], values: a.values }
}

export function verify(b: Uint8Array): void {
  const { end } = blocks(b)
  if (end !== b.length) fail('data after the GIF trailer')
  const a = analyse(b)
  if (a.labels.size) fail(`still holds: ${[...a.labels].join(', ')}`)
}
