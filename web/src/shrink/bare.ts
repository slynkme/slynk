// A smaller copy is the browser's own new picture, so it can't carry anything
// from the original file. Browsers do add a little of their own: Chrome a
// colour profile with its maker's name, Firefox (with its fingerprinting
// protection) a private PNG chunk, Safari possibly a small EXIF block. This
// keeps only what the picture needs, so no copy carries a name, profile or
// marker. (How each browser compresses still differs a little, so a copy can
// hint at the browser engine that made it, but not at a person or device.) A
// picture without a colour profile is shown as sRGB, which is what the canvas
// drew it in.
//
//   JPEG  every segment except APP0-15 and comments (tables, frame, scans)
//   WebP  the image and alpha chunks, and VP8X with only its alpha flag
//   PNG   IHDR, PLTE, tRNS, IDAT and IEND

/** The picture data alone. Throws if it isn't a well-formed JPEG, WebP or PNG. */
export function barePicture(b: Uint8Array, type: string): Uint8Array {
  if (type === 'image/jpeg') return bareJpeg(b)
  if (type === 'image/webp') return bareWebp(b)
  if (type === 'image/png') return barePng(b)
  throw new Error(`unexpected picture type ${type}`)
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let i = 0
  for (const p of parts) {
    out.set(p, i)
    i += p.length
  }
  return out
}

const u16be = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1]
const u32be = (b: Uint8Array, i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0
const u32le = (b: Uint8Array, i: number) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0
const tag = (b: Uint8Array, i: number) => String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3])

function bareJpeg(b: Uint8Array): Uint8Array {
  if (b[0] !== 0xff || b[1] !== 0xd8) throw new Error('not a JPEG')
  const parts: Uint8Array[] = [b.subarray(0, 2)]
  let i = 2
  for (;;) {
    while (b[i] === 0xff && b[i + 1] === 0xff) i++ // fill bytes before a marker
    if (i + 2 > b.length || b[i] !== 0xff) throw new Error('bad JPEG marker')
    const m = b[i + 1]
    if (m === 0xd9) {
      parts.push(b.subarray(i, i + 2))
      return concat(parts)
    }
    if (i + 4 > b.length) throw new Error('JPEG cut short')
    let end = i + 2 + u16be(b, i + 2)
    if (end > b.length) throw new Error('JPEG cut short')
    if (m === 0xda) {
      // The scan's coded data runs to the next marker that isn't a stuffed
      // 0xFF00 or a restart marker.
      while (end + 1 < b.length && !(b[end] === 0xff && b[end + 1] !== 0 && (b[end + 1] < 0xd0 || b[end + 1] > 0xd7))) end++
      if (end + 1 >= b.length) throw new Error('JPEG cut short')
    }
    const app = (m >= 0xe0 && m <= 0xef) || m === 0xfe
    if (!app) parts.push(b.subarray(i, end))
    i = end
  }
}

function bareWebp(b: Uint8Array): Uint8Array {
  if (tag(b, 0) !== 'RIFF' || tag(b, 8) !== 'WEBP') throw new Error('not a WebP')
  const end = 8 + u32le(b, 4)
  if (end > b.length) throw new Error('WebP cut short')
  const parts: Uint8Array[] = []
  let hasAlph = false
  let vp8x: Uint8Array | undefined
  for (let i = 12; i < end; ) {
    if (i + 8 > end) throw new Error('bad WebP chunk')
    const name = tag(b, i)
    const size = u32le(b, i + 4)
    const next = i + 8 + size + (size & 1)
    if (next > end) throw new Error('WebP cut short')
    const chunk = b.subarray(i, next)
    if (name === 'VP8X') {
      vp8x = chunk.slice()
      vp8x[8] &= 0x10 // alpha only: no colour profile, EXIF, XMP or animation
    } else if (name === 'ALPH' || name === 'VP8 ' || name === 'VP8L') {
      if (name === 'ALPH') hasAlph = true
      parts.push(chunk)
    }
    i = next
  }
  if (!parts.some((p) => tag(p, 0) !== 'ALPH')) throw new Error('WebP without a picture')
  // Without alpha, the plain format is enough; with it, VP8X has to come first.
  if (vp8x && (hasAlph || vp8x[8])) parts.unshift(vp8x)
  else if (hasAlph) throw new Error('WebP alpha without VP8X')
  const body = concat(parts)
  const head = new Uint8Array(12)
  head.set(b.subarray(0, 12))
  new DataView(head.buffer).setUint32(4, 4 + body.length, true)
  return concat([head, body])
}

const PNG_KEEP = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND'])

function barePng(b: Uint8Array): Uint8Array {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (!sig.every((v, i) => b[i] === v)) throw new Error('not a PNG')
  const parts: Uint8Array[] = [b.subarray(0, 8)]
  for (let i = 8; ; ) {
    if (i + 12 > b.length) throw new Error('PNG cut short')
    const name = tag(b, i + 4)
    const next = i + 12 + u32be(b, i)
    if (next > b.length) throw new Error('PNG cut short')
    if (PNG_KEEP.has(name)) parts.push(b.subarray(i, next))
    if (name === 'IEND') return concat(parts)
    i = next
  }
}
