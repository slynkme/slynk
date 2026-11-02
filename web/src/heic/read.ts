// Reads a HEIC photo's container (HEIF: ISO base media "boxes") for browsers
// that can't open HEIC as a picture (all but Safari), so their own HEVC video
// decoder can (decode.ts, WebCodecs): the primary picture or its thumbnail,
// its decoder's configuration (hvcC), its pieces (phones store a photo as a
// grid of 512 x 512 HEVC pictures, "tiles"), and how it's cropped, turned and
// mirrored to show it as the camera meant. Nothing here decodes anything.
import { u16be, u32be, u8 } from '../strip/bytes.ts'
import { type Box, children, gather, readBox, readItems, readLocations } from '../strip/isobmff.ts'
import { hevcCodec } from '../video/demux.ts'
import { namedColours, streamColours, streamSize } from './vui.ts'
import { MAX_PIXELS, type Dims } from '../shrink/plan.ts'

export class HeicError extends Error {}
const fail = (message: string): never => {
  throw new HeicError(message)
}

/** Each step turns the picture so far into the next: a crop ('clap'), a turn anticlockwise ('irot') or a mirroring ('imir'), in the file's order. */
export type Step = { crop: { x: number; y: number; width: number; height: number } } | { turn: 90 | 180 | 270 } | { mirror: 'top-bottom' | 'left-right' }

export interface HeicPicture {
  /** For WebCodecs, e.g. "hvc1.1.6.L93.B0". */
  codec: string
  /** The hvcC record: the decoder's configuration, shared by every tile. */
  description: Uint8Array
  /** Each tile's size, and how many across and down. */
  tile: Dims
  columns: number
  rows: number
  /** Each tile's HEVC picture (length-prefixed NAL units), row by row. */
  tiles: Uint8Array[]
  /** The whole picture before any step: the grid's output size, which may cut the last tiles short. */
  size: Dims
  steps: Step[]
  /**
   * From the container's nclx 'colr' box, which a decoder should use over the stream's own; or else the stream's
   * own (vui.ts), with a photo's usual colours for whatever neither says.
   */
  colour?: VideoColorSpaceInit
}

/** The most tiles Slynk puts together: a 50-megapixel photo is about 200 of 512 x 512. */
const MAX_TILES = 1024
/** The biggest decoder configuration (hvcC) Slynk reads: a real one is a few hundred bytes. */
const MAX_HVCC = 65_536
/** How many thumbnails are looked at, the biggest first. */
const MAX_THUMBNAILS = 16
/** How much bigger than its tile a tile's stream may say its pictures are (what a decoder would make). */
const SLACK = 64

/**
 * A photo's colours where neither its container nor its stream says (MIAF's, as libheif takes them): sRGB, with
 * JPEG's full range and matrix, not video's.
 */
const PHOTO_COLOURS: VideoColorSpaceInit = { fullRange: true, primaries: 'bt709', transfer: 'iec61966-2-1' as VideoTransferCharacteristics, matrix: 'smpte170m' }

/** HEIF's ftyp brands for still pictures made with HEVC. */
const BRANDS = ['heic', 'heix', 'heim', 'heis', 'mif1', 'mif2', 'msf1']

/** Whether the bytes begin as a HEIF file does, so it's worth trying to read. */
export function looksLikeHeif(b: Uint8Array): boolean {
  const ftyp = readBox(b, 0, b.length)
  if (!ftyp || ftyp.type !== 'ftyp') return false
  // The major brand, the minor version (skipped), then the first brands: a real file lists a handful.
  const end = Math.min(ftyp.end, ftyp.body + 4 * 66)
  for (let i = ftyp.body; i + 4 <= end; i += 4) if (i !== ftyp.body + 4 && BRANDS.includes(String.fromCharCode(...b.subarray(i, i + 4)))) return true
  return false
}

/**
 * The photo's primary picture, or with 'thumbnail' its largest thumbnail
 * (undefined when it has none Slynk can read). Throws HeicError when the
 * picture isn't one Slynk can read: not HEVC, not a grid of tiles, broken.
 */
export function readHeic(b: Uint8Array, want: 'primary' | 'thumbnail' = 'primary'): HeicPicture | undefined {
  try {
    return read(b, want)
  } catch (e) {
    if (e instanceof HeicError) throw e
    throw new HeicError(`can't read the photo: ${e instanceof Error ? e.message : e}`)
  }
}

function read(b: Uint8Array, want: 'primary' | 'thumbnail'): HeicPicture | undefined {
  const top: Box[] = []
  for (let pos = 0; ; ) {
    const box = readBox(b, pos, b.length)
    if (!box) break
    top.push(box)
    pos = box.end
  }
  if (top[0]?.type !== 'ftyp') fail('not a HEIF file')
  const meta = top.find((x) => x.type === 'meta') ?? fail('no meta box')
  const kids = children(b, meta.body + 4, meta.end)
  const kid = (type: string) => kids.find((x) => x.type === type)
  const pitm = kid('pitm') ?? fail('no primary item')
  const wideIds = u8(b, pitm.body) !== 0
  need(pitm, wideIds ? 8 : 6)
  const primary = wideIds ? u32be(b, pitm.body + 4) : u16be(b, pitm.body + 4)
  const iinf = kid('iinf') ?? fail('no item list')
  const iloc = kid('iloc') ?? fail('no item locations')
  const items = new Map(readItems(b, iinf).map((item) => [item.id, item.type]))
  const locations = readLocations(b, iloc, kid('idat'))
  const refs = references(b, kid('iref'))
  const props = properties(b, kid('iprp'))

  // Each item copied once, and all of them together no bigger than the file: no real file's items repeat or overlap.
  const copied = new Map<number, Uint8Array>()
  let room = b.length
  const data = (id: number) => {
    const had = copied.get(id)
    if (had) return had
    const ext = locations.get(id)
    if (!ext || typeof ext === 'string') return fail(`item ${id} isn't stored in this file`)
    const d = gather(b, ext)
    if ((room -= d.length) < 0) fail('items that overlap')
    copied.set(id, d)
    return d
  }
  const prop = (id: number, type: string) => props(id).find((x) => x.type === type)
  // HEIF allows an ICC profile and an nclx box side by side, in either order: the nclx one, wherever it is.
  const nclx = (id: number) => props(id).reduce<VideoColorSpaceInit | undefined>((found, x) => found ?? (x.type === 'colr' ? colour(b, x) : undefined), undefined)
  const dims = (id: number): Dims => {
    const ispe = prop(id, 'ispe') ?? fail(`item ${id} has no size`)
    need(ispe, 12)
    const d = { width: u32be(b, ispe.body + 4), height: u32be(b, ispe.body + 8) }
    return d.width > 0 && d.height > 0 ? d : fail(`item ${id} has no size`)
  }
  const inputs = (id: number) => refs.filter((r) => r.type === 'dimg' && r.from === id).flatMap((r) => r.to)

  const picture = (id: number, depth = 0): HeicPicture => {
    if (depth > 4) fail('items derived from each other too deeply')
    const type = items.get(id) ?? fail(`no item ${id}`)
    if (type === 'tmap') {
      // An HDR photo's tone-mapped picture: its first input is the ordinary picture, as readers that can't tone-map show it.
      return picture(inputs(id)[0] ?? fail('a tone map without its picture'), depth + 1)
    }
    if (type === 'iden') {
      const from = picture(inputs(id)[0] ?? fail('a derived item without its source'), depth + 1)
      return { ...from, steps: [...from.steps, ...steps(b, props(id), sizeAfter(from.size, from.steps))], colour: nclx(id) ?? from.colour }
    }
    let tiles: number[]
    let columns = 1
    let rows = 1
    let size: Dims
    if (type === 'hvc1') {
      tiles = [id]
      size = dims(id)
    } else if (type === 'grid') {
      const g = data(id)
      if (g.length < 8 || g.length < (g[1] & 1 ? 12 : 8) || g[0] !== 0) fail('a grid Slynk cannot read')
      rows = g[2] + 1
      columns = g[3] + 1
      size = g[1] & 1 ? { width: u32be(g, 4), height: u32be(g, 8) } : { width: u16be(g, 4), height: u16be(g, 6) }
      tiles = inputs(id)
      if (tiles.length !== rows * columns) fail(`a grid of ${rows} x ${columns} with ${tiles.length} tiles`)
      if (tiles.length > MAX_TILES) fail('too many tiles')
      if (new Set(tiles).size !== tiles.length) fail('a tile listed twice')
    } else return fail(`a picture stored as ${type}`)
    if (!(size.width > 0 && size.height > 0)) fail('a picture with no size')
    // Checked before anything is copied: no bigger than Slynk opens at all, and no tiles wholly outside it.
    if (size.width * size.height > MAX_PIXELS) fail('a picture too big to open')
    const tile = dims(tiles[0])
    if (tile.width * tile.height > MAX_PIXELS) fail('a tile too big to open')
    if (columns * tile.width < size.width || rows * tile.height < size.height) fail('tiles too small for the picture')
    if ((columns - 1) * tile.width >= size.width || (rows - 1) * tile.height >= size.height) fail('tiles outside the picture')
    const config = configuration(tiles[0])
    const description = b.slice(config.body, config.end)
    // What a decoder would make of each tile: not much bigger than the tile, or one could keep it busy for nothing.
    const decoded = streamSize(description)
    if (decoded && (decoded.width > tile.width + SLACK || decoded.height > tile.height + SLACK)) fail('tiles whose pictures are bigger than they say')
    const pieces = tiles.map((t) => {
      if (items.get(t) !== 'hvc1') fail('a tile that is not HEVC')
      const d = dims(t)
      if (d.width !== tile.width || d.height !== tile.height) fail('tiles of different sizes')
      // One decoder configuration for every tile: phones' photos share one (the same box, or the same bytes).
      const own = configuration(t)
      if (own !== config && !same(b.subarray(own.body, own.end), description)) fail('tiles with different configurations')
      return data(t)
    })
    return {
      codec: hevcCodec('hvc1', description),
      description,
      tile,
      columns,
      rows,
      tiles: pieces,
      size,
      steps: steps(b, props(id), size),
      colour: nclx(id) ?? nclx(tiles[0]) ?? { ...PHOTO_COLOURS, ...streamColours(description) },
    }
  }
  const configuration = (id: number) => {
    const hvcC = prop(id, 'hvcC') ?? fail(`tile ${id} has no hvcC`)
    if (hvcC.end - hvcC.body < 23) fail('an hvcC cut short')
    if (hvcC.end - hvcC.body > MAX_HVCC) fail('an hvcC too big')
    return hvcC
  }

  if (want === 'primary') return picture(primary)
  // Thumbnails point at the picture they're of ('thmb'): the biggest by its stated size that can be read, the
  // others built only if it can't be.
  const area = (id: number) => {
    try {
      const d = dims(id)
      return d.width * d.height
    } catch {
      return 0
    }
  }
  const candidates = [...new Set(refs.filter((r) => r.type === 'thmb' && r.to.includes(primary)).map((r) => r.from))]
    .slice(0, MAX_THUMBNAILS)
    .map((id) => ({ id, area: area(id) }))
    .filter((c) => c.area > 0)
    .sort((x, y) => y.area - x.area)
  for (const { id } of candidates) {
    try {
      return picture(id)
    } catch {
      // the next one
    }
  }
  return undefined
}

/** A box with fewer than n bytes in it is cut short. */
function need(box: Box, n: number) {
  if (box.end - box.body < n) fail(`a '${box.type}' box cut short`)
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

interface Reference {
  type: string
  from: number
  to: number[]
}

function references(b: Uint8Array, iref: Box | undefined): Reference[] {
  if (!iref) return []
  const wide = u8(b, iref.body) !== 0
  const id = (i: number) => (wide ? u32be(b, i) : u16be(b, i))
  const n = wide ? 4 : 2
  return children(b, iref.body + 4, iref.end).map((r) => {
    const count = u16be(b, r.body + n)
    if (r.body + n + 2 + count * n > r.end) fail('a reference cut short')
    return { type: r.type, from: id(r.body), to: Array.from({ length: count }, (_, k) => id(r.body + n + 2 + k * n)) }
  })
}

/** Each item's properties, in the order the file lists them for it (which is the order its steps apply in). */
function properties(b: Uint8Array, iprp: Box | undefined): (id: number) => Box[] {
  const map = new Map<number, Box[]>()
  if (!iprp) return () => []
  const kids = children(b, iprp.body, iprp.end)
  const ipco = kids.find((x) => x.type === 'ipco')
  const list = ipco ? children(b, ipco.body, ipco.end) : []
  for (const ipma of kids.filter((x) => x.type === 'ipma')) {
    const version = u8(b, ipma.body)
    const wide = u8(b, ipma.body + 3) & 1
    let p = ipma.body + 4
    const count = u32be(b, p)
    p += 4
    for (let i = 0; i < count; i++) {
      const id = version < 1 ? u16be(b, p) : u32be(b, p)
      p += version < 1 ? 2 : 4
      const n = u8(b, p++)
      // Listed once (ISO/IEC 23008-12): a second list could make every lookup long.
      if (map.has(id)) fail(`item ${id} has two property lists`)
      const own: Box[] = []
      for (let k = 0; k < n; k++) {
        const index = wide ? u16be(b, p) & 0x7fff : u8(b, p) & 0x7f
        p += wide ? 2 : 1
        // 0 is "no property"; an index past the list is ignored, as an unknown property would be.
        if (index > 0 && index <= list.length) own.push(list[index - 1])
      }
      if (p > ipma.end) fail('property associations cut short')
      map.set(id, own)
    }
  }
  return (id) => map.get(id) ?? []
}

/** The crop, turn and mirroring properties, in order; size: the picture's before them. */
function steps(b: Uint8Array, props: Box[], size: Dims): Step[] {
  const out: Step[] = []
  let at = size
  for (const p of props) {
    let step: Step | undefined
    if (p.type === 'irot') {
      need(p, 1)
      const turn = (u8(b, p.body) & 3) * 90
      if (turn) step = { turn: turn as 90 | 180 | 270 }
    } else if (p.type === 'imir') {
      need(p, 1)
      // ISO/IEC 23008-12: axis 0 swaps top and bottom, 1 left and right.
      step = { mirror: u8(b, p.body) & 1 ? 'left-right' : 'top-bottom' }
    } else if (p.type === 'clap' && p.end - p.body >= 32) {
      const crop = cleanAperture(b, p.body, at)
      if (crop) step = { crop }
    }
    if (step) {
      out.push(step)
      at = sizeAfter(at, [step])
    }
  }
  return out
}

/**
 * A 'clap' box's crop, in whole pixels: its size, centred on the picture's
 * middle plus its offset (ISO/IEC 14496-12). Undefined when it doesn't fit
 * the picture: then the picture shows uncropped.
 */
function cleanAperture(b: Uint8Array, i: number, size: Dims) {
  const ratio = (n: number, d: number) => (d ? n / d : NaN)
  const width = Math.round(ratio(u32be(b, i), u32be(b, i + 4)))
  const height = Math.round(ratio(u32be(b, i + 8), u32be(b, i + 12)))
  const offX = ratio(u32be(b, i + 16) | 0, u32be(b, i + 20))
  const offY = ratio(u32be(b, i + 24) | 0, u32be(b, i + 28))
  const x = Math.round(offX + (size.width - 1) / 2 - (width - 1) / 2)
  const y = Math.round(offY + (size.height - 1) / 2 - (height - 1) / 2)
  if (!(width > 0 && height > 0 && x >= 0 && y >= 0 && x + width <= size.width && y + height <= size.height)) return undefined
  return { x, y, width, height }
}

/** An 'nclx' colour box's colours, for the decoder. An ICC profile ('prof') isn't used: the picture is shown as sRGB. */
function colour(b: Uint8Array, colr: Box | undefined): VideoColorSpaceInit | undefined {
  if (!colr || colr.end - colr.body < 11 || String.fromCharCode(...b.subarray(colr.body, colr.body + 4)) !== 'nclx') return undefined
  return namedColours(u16be(b, colr.body + 4), u16be(b, colr.body + 6), u16be(b, colr.body + 8), (u8(b, colr.body + 10) & 0x80) !== 0)
}

/**
 * Codec names to ask the browser about, the photo's own first. A Main Still
 * Picture one (a photo's own HEVC profile) also as Main: a phone's decoder
 * may not list that profile, yet decodes it, since it's Main with one picture.
 */
export function codecChoices(codec: string): string[] {
  const [format, profile, , ...rest] = codec.split('.')
  return profile === '3' ? [codec, [format, '1', '6', ...rest].join('.')] : [codec]
}

/** The picture's size after these steps. */
export function sizeAfter(size: Dims, list: Step[]): Dims {
  let d = size
  for (const s of list) {
    if ('crop' in s) d = { width: s.crop.width, height: s.crop.height }
    else if ('turn' in s && s.turn !== 180) d = { width: d.height, height: d.width }
  }
  return d
}

/** A 2D transform as a canvas takes it (setTransform's a, b, c, d, e, f): x' = a x + c y + e, y' = b x + d y + f. */
export type Matrix = [number, number, number, number, number, number]

/**
 * Where the picture's pixels go on a canvas of its final size: one transform
 * for every step, so each tile is drawn once, straight to its place.
 */
export function placement(p: Pick<HeicPicture, 'size' | 'steps'>): { size: Dims; matrix: Matrix } {
  let m: Matrix = [1, 0, 0, 1, 0, 0]
  let { width: w, height: h } = p.size
  for (const s of p.steps) {
    let t: Matrix
    if ('crop' in s) {
      t = [1, 0, 0, 1, -s.crop.x, -s.crop.y]
      w = s.crop.width
      h = s.crop.height
    } else if ('mirror' in s) {
      t = s.mirror === 'left-right' ? [-1, 0, 0, 1, w, 0] : [1, 0, 0, -1, 0, h]
    } else {
      // Anticlockwise: a quarter turn puts the top right corner at the top left.
      t = s.turn === 90 ? [0, -1, 1, 0, 0, w] : s.turn === 180 ? [-1, 0, 0, -1, w, h] : [0, 1, -1, 0, h, 0]
      if (s.turn !== 180) [w, h] = [h, w]
    }
    m = then(m, t)
  }
  return { size: { width: w, height: h }, matrix: m }
}

/** m, then t. */
function then(m: Matrix, t: Matrix): Matrix {
  const [a, b, c, d, e, f] = m
  const [ta, tb, tc, td, te, tf] = t
  return [ta * a + tc * b, tb * a + td * b, ta * c + tc * d, tb * c + td * d, ta * e + tc * f + te, tb * e + td * f + tf]
}
