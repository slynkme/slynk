// Test HEICs for the HEIC tests (heic.test.ts, heic-decode.test.ts): a real one encoded with x265, and a
// builder for made-up ones.
import { be16, be32, cat, type Part } from '../strip/fixtures.ts'

// A 120 x 100 test picture as a 2 x 2 grid of 64 x 64 tiles, turned a quarter clockwise
// (irot 3), with an nclx colour box and a 64 x 54 thumbnail: encoded with x265.
export const TINY = Buffer.from(
  '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' +
  'cUCv6qkDUoFsQA==',
  'base64',
)

export function box(type: string, ...body: Part[]): Uint8Array {
  const b = cat(...body)
  return cat(be32(8 + b.length), type, b)
}
export const full = (type: string, version: number, flags: number, ...body: Part[]) => box(type, [version, 0, 0, flags], ...body)

/** An hvcC record with no parameter sets: profile byte, compatibility flags, level. */
export const hvcC = (profile = 1, compat = 0x60000000, level = 93, salt = 0) => box('hvcC', [1, profile], be32(compat), [0x90, 0, 0, 0, 0, 0, level, 0xf0, 0, 0xfc, 0xfd, 0xf8, 0xf8, 0, salt, 0x0f, 0])
export const ispe = (w: number, h: number) => full('ispe', 0, 0, be32(w), be32(h))
export const irot = (quarters: number) => box('irot', [quarters])
export const imir = (axis: number) => box('imir', [axis])
export const clap = (w: number, h: number, offX: number, offY: number) => box('clap', be32(w), be32(1), be32(h), be32(1), be32(offX * 2), be32(2), be32(offY * 2), be32(2))
export const nclx = (primaries: number, transfer: number, matrix: number, full: boolean) => box('colr', 'nclx', be16(primaries), be16(transfer), be16(matrix), [full ? 0x80 : 0])
export const grid = (rows: number, columns: number, w: number, h: number, wide = false) => cat([0, wide ? 1 : 0, rows - 1, columns - 1], wide ? cat(be32(w), be32(h)) : cat(be16(w), be16(h)))

export interface Item {
  id: number
  type: string
  data?: Uint8Array
  /** Its properties, in order: boxes, or the number of one already listed (from 1). */
  props?: (Uint8Array | number)[]
}

/** A HEIF file with every item's data in idat (construction method 1). */
export function heifFile(o: { primary: number; items: Item[]; refs?: [string, number, number[]][]; brands?: string[] }): Uint8Array {
  const props: Uint8Array[] = []
  const indexOf = (p: Uint8Array | number) => (typeof p === 'number' ? p : props.push(p))
  const assoc = o.items.map((it) => cat(be16(it.id), [(it.props ?? []).length], (it.props ?? []).map((p) => indexOf(p))))
  const infe = (it: Item) => full('infe', 2, 0, be16(it.id), be16(0), it.type, '\0')
  let at = 0
  const locs = o.items.filter((it) => it.data).map((it) => {
    const loc = cat(be16(it.id), be16(1), be16(0), be16(1), be32(at), be32(it.data!.length))
    at += it.data!.length
    return loc
  })
  const refs = (o.refs ?? []).map(([type, from, to]) => box(type, be16(from), be16(to.length), ...to.map(be16)))
  const meta = full(
    'meta', 0, 0,
    full('hdlr', 0, 0, be32(0), 'pict', new Array(12).fill(0), '\0'),
    full('pitm', 0, 0, be16(o.primary)),
    full('iinf', 0, 0, be16(o.items.length), ...o.items.map(infe)),
    ...(refs.length ? [full('iref', 0, 0, ...refs)] : []),
    box('iprp', box('ipco', ...props), full('ipma', 0, 0, be32(o.items.length), ...assoc)),
    full('iloc', 1, 0, [0x44, 0x00], be16(locs.length), ...locs),
    box('idat', ...o.items.filter((it) => it.data).map((it) => it.data!)),
  )
  return cat(box('ftyp', (o.brands ?? ['heic'])[0], be32(0), ...(o.brands ?? ['mif1', 'heic'])), meta)
}

export const tileData = (n: number) => cat(be32(4), [0x26, 0x01, n, n]) // one made-up NAL unit each

/** A phone-style photo: a grid of tiles sharing one hvcC, with the grid's own properties after its size. */
export function phonePhoto(o: { rows?: number; columns?: number; tile?: number; width?: number; height?: number; gridProps?: (Uint8Array | number)[]; tileIds?: number[] } = {}) {
  const rows = o.rows ?? 2
  const columns = o.columns ?? 3
  const t = o.tile ?? 512
  const width = o.width ?? columns * t - 12
  const height = o.height ?? rows * t - 30
  const ids = o.tileIds ?? Array.from({ length: rows * columns }, (_, i) => 10 + i)
  const items: Item[] = [
    { id: 1, type: 'grid', data: grid(rows, columns, width, height), props: [ispe(width, height), ...(o.gridProps ?? [])] },
    ...ids.map((id, i) => ({ id, type: 'hvc1', data: tileData(i), props: i === 0 ? [hvcC(), ispe(t, t)] : [1 + (o.gridProps?.length ?? 0) + 1, 1 + (o.gridProps?.length ?? 0) + 2] })),
  ]
  return heifFile({ primary: 1, items, refs: [['dimg', 1, ids]] })
}
