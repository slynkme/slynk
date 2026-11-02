// Making PDFs smaller: finding where pictures are shown, which can be made
// smaller, their raw pixels, and the sizing ladder. The drawing itself needs
// a browser.
// Run from the repo root: npm --prefix web test
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deflateSync } from 'node:zlib'
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, type PDFRef, decodePDFRawStream } from 'pdf-lib'
import { PROBE, TOLERANCE, judge } from '../src/pdfshrink/canvasCheck.ts'
import { type PdfImage, adobeTransform, colourOf, findImages, predictRows, toRgba, undoFilters, unpredict } from '../src/pdfshrink/images.ts'
import { merge, pack, where } from '../src/pdfshrink/shrink.ts'
import { type Arg, mul, placements, readOps } from '../src/pdfshrink/place.ts'
import { GRAPHIC_FLOOR, PPI_FLOOR, PPI_STEPS, chosen, dimsAt, fillPage, firstFit, ladder, ppiOf, predict } from '../src/pdfshrink/plan.ts'
import { Q_LOWER, Q_MAX, Q_STEPS } from '../src/shrink/plan.ts'

const enc = (s: string) => new TextEncoder().encode(s)
const near = (a: number, b: number, what: string) => assert.ok(Math.abs(a - b) < 1e-6, `${what}: ${a} is not ${b}`)

// --- Drawing instructions ---------------------------------------------------------

test('only real operators are read: strings, comments and inline pictures are stepped over', () => {
  const ops: [string, Arg[]][] = []
  const src =
    '% 1 0 0 1 0 0 cm /Fake Do\n' +
    'q (a string with cm and /X Do \\) and (nested) brackets) Tj\n' +
    '<48656c6c6f> Tj [(x) 120 (y)] TJ << /MCID 3 >> BDC EMC\n' +
    'BI /W 4 /H 1 /CS /G /BPC 8 ID \x00Do\x01 cm\x02\x03 EI\n' +
    '2 0 0 3 10 20 cm /Im#201 Do Q'
  const inline = readOps(enc(src), (op, args) => ops.push([op, args]))
  assert.equal(inline, 1)
  const names = ops.map(([op]) => op)
  assert.deepEqual(names, ['q', 'Tj', 'Tj', 'TJ', 'BDC', 'EMC', 'BI', 'cm', 'Do', 'Q'])
  assert.deepEqual(ops[7][1], [2, 0, 0, 3, 10, 20])
  assert.deepEqual(ops[8][1], [{ name: 'Im 1' }])
})

test('matrices combine in PDF order', () => {
  const scale = [2, 0, 0, 3, 0, 0] as const
  const move = [1, 0, 0, 1, 10, 20] as const
  // Scale, then move: (1, 1) → (2, 3) → (12, 23).
  const m = mul([...scale], [...move])
  near(m[0] * 1 + m[2] * 1 + m[4], 12, 'x')
  near(m[1] * 1 + m[3] * 1 + m[5], 23, 'y')
})

async function docWithImage(opts: { width?: number; height?: number; dict?: Record<string, unknown>; data?: Uint8Array } = {}) {
  const doc = await PDFDocument.create()
  const ctx = doc.context
  const w = opts.width ?? 100
  const h = opts.height ?? 50
  const img = ctx.register(
    ctx.flateStream(opts.data ?? new Uint8Array(w * h * 3), {
      Type: 'XObject',
      Subtype: 'Image',
      Width: w,
      Height: h,
      ColorSpace: 'DeviceRGB',
      BitsPerComponent: 8,
      ...opts.dict,
    }),
  )
  return { doc, ctx, img }
}

function addPage(doc: PDFDocument, content: string, xobjects: Record<string, PDFRef>, extra: Record<string, unknown> = {}) {
  const ctx = doc.context
  const page = doc.addPage([612, 792])
  const res = ctx.obj({ XObject: ctx.obj(xobjects) })
  page.node.set(PDFName.of('Resources'), res)
  page.node.set(PDFName.of('Contents'), ctx.register(ctx.stream(enc(content))))
  for (const [k, v] of Object.entries(extra)) page.node.set(PDFName.of(k), ctx.obj(v as never))
  return page
}

test('a picture is sized where it is shown largest, through forms and annotations', async () => {
  const { doc, ctx, img } = await docWithImage()
  // Page 1: 3 × 1.5 inches.
  addPage(doc, 'q 216 0 0 108 72 600 cm /Im1 Do Q', { Im1: img })
  // Page 2: a form scaled ×2 by its Matrix, drawing the picture at 144 × 72 inside: 4 × 2 inches.
  const form = ctx.register(
    ctx.stream(enc('q 144 0 0 72 0 0 cm /P Do Q'), {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, 1000, 1000],
      Matrix: [2, 0, 0, 2, 0, 0],
      Resources: ctx.obj({ XObject: ctx.obj({ P: img }) }),
    }),
  )
  addPage(doc, 'q 1 0 0 1 50 50 cm /F1 Do Q', { F1: form })
  // Page 3: an annotation whose 100 × 100 appearance box is fitted into a 7 × 7 inch rectangle.
  const ap = ctx.register(
    ctx.stream(enc('q 100 0 0 100 0 0 cm /P Do Q'), {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, 100, 100],
      Resources: ctx.obj({ XObject: ctx.obj({ P: img }) }),
    }),
  )
  const annot = ctx.obj({ Type: 'Annot', Subtype: 'Stamp', Rect: [0, 0, 504, 504], AP: ctx.obj({ N: ap }) })
  addPage(doc, '', {}, { Annots: [ctx.register(annot)] })
  const p = placements(doc)
  const s = p.shown.get(img)!
  near(s.w, 7, 'width')
  near(s.h, 7, 'height')
  assert.deepEqual(s.pages, [1, 2, 3])
  near(p.page.w, 8.5, 'page width')
  near(p.page.h, 11, 'page height')
})

test('a form that draws itself is not followed forever, and Q without q keeps going', async () => {
  const { doc, ctx, img } = await docWithImage()
  const loopRef = ctx.nextRef()
  const loop = ctx.stream(enc('Q Q /Self Do q 72 0 0 72 0 0 cm /P Do Q'), {
    Type: 'XObject',
    Subtype: 'Form',
    BBox: [0, 0, 10, 10],
    Resources: ctx.obj({ XObject: ctx.obj({ Self: loopRef, P: img }) }),
  })
  ctx.assign(loopRef, loop)
  addPage(doc, '/L Do', { L: loopRef })
  const s = placements(doc).shown.get(img)!
  near(s.w, 1, 'width')
})

// --- Which pictures, and their pixels --------------------------------------------------

test('each kind of picture gets the right verdict', async () => {
  const big = 40_000 // over SMALL
  const doc = await PDFDocument.create()
  const ctx = doc.context
  const random = (n: number) => {
    const b = new Uint8Array(n)
    for (let i = 0; i < n; i += 65536) crypto.getRandomValues(b.subarray(i, i + 65536))
    return b
  }
  const add = (dict: Record<string, unknown>, data = random(big)) =>
    ctx.register(ctx.stream(data, { Type: 'XObject', Subtype: 'Image', Width: 200, Height: 100, BitsPerComponent: 8, ColorSpace: 'DeviceRGB', ...dict }))
  const smask = add({ ColorSpace: 'DeviceGray', Filter: 'FlateDecode' })
  const icc = ctx.register(ctx.stream(new Uint8Array(10), { N: 4 }))
  const refs = {
    jpeg: add({ Filter: 'DCTDecode' }),
    pixels: add({ Filter: 'FlateDecode', SMask: smask }),
    smask,
    jpx: add({ Filter: 'JPXDecode' }),
    bw: add({ Filter: 'CCITTFaxDecode', BitsPerComponent: 1, ColorSpace: 'DeviceGray' }),
    stencil: add({ ImageMask: true, BitsPerComponent: 1 }),
    cmyk: add({ Filter: 'DCTDecode', ColorSpace: 'DeviceCMYK' }),
    iccCmyk: add({ Filter: 'DCTDecode', ColorSpace: ctx.obj([PDFName.of('ICCBased'), icc]) }),
    colour: add({ ColorSpace: ctx.obj(['Separation', 'Gold', 'DeviceCMYK', 0]) }),
    decode: add({ Decode: [1, 0, 1, 0, 1, 0] }),
    sameDecode: add({ Decode: [0, 1, 0, 1, 0, 1] }),
    key: add({ Mask: [0, 10, 0, 10, 0, 10] }),
    bits: add({ BitsPerComponent: 16 }),
    small: add({}, new Uint8Array(1000)),
    transform: add({ Filter: 'DCTDecode', DecodeParms: { ColorTransform: 0 } }),
    chain: add({ Filter: ['ASCIIHexDecode', 'DCTDecode'] }),
    unknown: add({ Filter: 'Crypt' }),
  }
  const byRef = new Map(findImages(doc).map((im) => [im.ref, im]))
  const v = (k: keyof typeof refs) => {
    const im = byRef.get(refs[k])!
    return im.skip ?? im.source
  }
  assert.equal(v('jpeg'), 'jpeg')
  assert.equal(v('pixels'), 'pixels')
  assert.equal(v('smask'), 'mask')
  assert.equal(v('jpx'), 'jpx')
  assert.equal(v('bw'), 'bw')
  assert.equal(v('stencil'), 'stencil')
  assert.equal(v('cmyk'), 'cmyk')
  assert.equal(v('iccCmyk'), 'cmyk')
  assert.equal(v('colour'), 'colour')
  assert.equal(v('decode'), 'decode')
  assert.equal(v('sameDecode'), 'pixels')
  assert.equal(v('key'), 'colour-key')
  assert.equal(v('bits'), 'bits')
  assert.equal(v('small'), 'small')
  assert.equal(v('transform'), 'filter')
  assert.equal(v('chain'), 'jpeg')
  assert.equal(v('unknown'), 'filter')
})

/** The PNG filters, forwards, for the tests. */
function pngFilter(raw: Uint8Array, rowBytes: number, bpp: number, types: number[]): Uint8Array {
  const rows = raw.length / rowBytes
  const out = new Uint8Array(rows * (rowBytes + 1))
  for (let r = 0; r < rows; r++) {
    const type = types[r % types.length]
    out[r * (rowBytes + 1)] = type
    for (let i = 0; i < rowBytes; i++) {
      const x = raw[r * rowBytes + i]
      const a = i >= bpp ? raw[r * rowBytes + i - bpp] : 0
      const b = r > 0 ? raw[(r - 1) * rowBytes + i] : 0
      const c = r > 0 && i >= bpp ? raw[(r - 1) * rowBytes + i - bpp] : 0
      const pa = Math.abs(b - c)
      const pb = Math.abs(a - c)
      const pc = Math.abs(a + b - 2 * c)
      const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][type]
      out[r * (rowBytes + 1) + 1 + i] = (x - pred) & 255
    }
  }
  return out
}

test('PNG and TIFF predictors are undone exactly', () => {
  const w = 37
  const h = 11
  const raw = new Uint8Array(w * h * 3)
  crypto.getRandomValues(raw)
  const coded = pngFilter(raw, w * 3, 3, [0, 1, 2, 3, 4])
  assert.deepEqual(unpredict(coded, { predictor: 15, colors: 3, bpc: 8, columns: w }), raw)
  const tiff = raw.slice()
  for (let r = h - 1; r >= 0; r--)
    for (let i = w * 3 - 1; i >= 3; i--) tiff[r * w * 3 + i] = (raw[r * w * 3 + i] - raw[r * w * 3 + i - 3]) & 255
  assert.deepEqual(unpredict(tiff, { predictor: 2, colors: 3, bpc: 8, columns: w }), raw)
  assert.throws(() => unpredict(new Uint8Array([7, 0, 0]), { predictor: 15, colors: 1, bpc: 8, columns: 2 }), /PNG filter 7/)
})

test('lossless pictures get PNG predictors that undo exactly, and help flat pictures compress', () => {
  for (const colors of [1, 3]) {
    const w = 53
    const h = 17
    const noisy = new Uint8Array(w * h * colors)
    crypto.getRandomValues(noisy)
    assert.deepEqual(unpredict(predictRows(noisy, w, colors), { predictor: 15, colors, bpc: 8, columns: w }), noisy)
    // Smooth shading that doesn't repeat: predicted rows compress much better than raw ones.
    const smooth = new Uint8Array(400 * 300 * colors)
    for (let y = 0; y < 300; y++)
      for (let x = 0; x < 400; x++)
        for (let k = 0; k < colors; k++) smooth[(y * 400 + x) * colors + k] = Math.round(128 + 100 * Math.sin(x / 37 + k) * Math.cos(y / 23))
    const predicted = predictRows(smooth, 400, colors)
    assert.deepEqual(unpredict(predicted, { predictor: 15, colors, bpc: 8, columns: 400 }), smooth)
    const [p, r] = [deflateSync(predicted).length, deflateSync(smooth).length]
    assert.ok(p < r * 0.8, `${p} vs ${r}`)
  }
})

test('raw pixels come out as RGBA: grey, RGB and palettes, at 1 to 8 bits', async () => {
  const doc = await PDFDocument.create()
  const gray = { kind: 'gray', label: 'DeviceGray', n: 1 } as const
  // 1 bit: 1 0 1 1, then padding.
  assert.deepEqual([...toRgba(new Uint8Array([0b10110000]), { width: 4, height: 1, bpc: 1, colour: gray })], [255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255])
  // 4 bits: 0x0, 0xf, 0x8.
  assert.deepEqual([...toRgba(new Uint8Array([0x0f, 0x80]), { width: 3, height: 1, bpc: 4, colour: gray })].filter((_, i) => i % 4 === 0), [0, 255, 136])
  const rgb = colourOf(doc, PDFName.of('DeviceRGB'))
  assert.deepEqual([...toRgba(new Uint8Array([1, 2, 3, 4, 5, 6]), { width: 2, height: 1, bpc: 8, colour: rgb })], [1, 2, 3, 255, 4, 5, 6, 255])
  // A 2-bit palette of 3 colours; index 3 is past the end and is clamped to the last.
  const pal = colourOf(doc, doc.context.obj(['Indexed', 'DeviceRGB', 2, doc.context.obj([]) as never]))
  assert.equal(pal.kind, 'other') // no palette string: unusable
  const indexed = {
    kind: 'indexed' as const,
    label: 'Indexed DeviceRGB',
    n: 1,
    base: rgb,
    hival: 2,
    palette: new Uint8Array([10, 11, 12, 20, 21, 22, 30, 31, 32]),
  }
  assert.deepEqual([...toRgba(new Uint8Array([0b00011011]), { width: 4, height: 1, bpc: 2, colour: indexed })], [10, 11, 12, 255, 20, 21, 22, 255, 30, 31, 32, 255, 30, 31, 32, 255])
  // Short data: missing rows stay black.
  assert.deepEqual([...toRgba(new Uint8Array([9]), { width: 1, height: 2, bpc: 8, colour: gray })], [9, 9, 9, 255, 0, 0, 0, 255])
})

test('a Flate stream with a PNG predictor is unpacked to its pixels', async () => {
  const w = 120
  const h = 60
  const raw = new Uint8Array(w * h * 3)
  crypto.getRandomValues(raw)
  const data = deflateSync(pngFilter(raw, w * 3, 3, [4, 2]))
  const doc = await PDFDocument.create()
  const ctx = doc.context
  const ref = ctx.register(
    ctx.stream(new Uint8Array(data), {
      Type: 'XObject',
      Subtype: 'Image',
      Width: w,
      Height: h,
      ColorSpace: 'DeviceRGB',
      BitsPerComponent: 8,
      Filter: 'FlateDecode',
      DecodeParms: { Predictor: 15, Colors: 3, BitsPerComponent: 8, Columns: w },
    }),
  )
  const im = findImages(doc).find((x) => x.ref === ref) as PdfImage
  assert.equal(im.source, 'pixels')
  assert.deepEqual(undoFilters(doc, im), raw)
})

// --- Sizing -------------------------------------------------------------------------

test('the ladder: resolution first, then quality, lower only when allowed', () => {
  const l = ladder(false)
  assert.deepEqual(
    l.map((x) => x.ppi),
    [...PPI_STEPS, ...Q_STEPS.map(() => PPI_FLOOR)],
  )
  assert.ok(l.slice(0, PPI_STEPS.length).every((x) => x.quality === Q_MAX))
  assert.deepEqual(
    l.slice(PPI_STEPS.length).map((x) => x.quality),
    [...Q_STEPS],
  )
  assert.deepEqual(
    ladder(true).slice(-Q_LOWER.length).map((x) => x.quality),
    [...Q_LOWER],
  )
  assert.ok(GRAPHIC_FLOOR > PPI_FLOOR)
})

test('pixels needed: never more than it has, keeping its shape, nothing for a tenth', () => {
  // A 4032 × 3024 photo shown 4 × 3 inches is 1008 pixels per inch.
  const photo = { width: 4032, height: 3024 }
  const shown = { w: 4, h: 3 }
  near(ppiOf(photo, shown), 1008, 'ppi')
  assert.deepEqual(dimsAt(photo, shown, 200), { width: 800, height: 600 })
  assert.deepEqual(dimsAt(photo, shown, 100), { width: 400, height: 300 })
  // Shown big: it keeps every pixel.
  assert.deepEqual(dimsAt(photo, { w: 40, h: 30 }, 200), photo)
  // 5% over: not worth a new picture.
  assert.deepEqual(dimsAt({ width: 840, height: 630 }, shown, 200), { width: 840, height: 630 })
  // Stretched: the axis that needs more decides.
  assert.deepEqual(dimsAt({ width: 1000, height: 1000 }, { w: 1, h: 4 }, 100), { width: 400, height: 400 })
  // Not found on a page: as if it filled the page.
  const fill = fillPage({ width: 3000, height: 1000 }, { w: 8.5, h: 11 })
  near(fill.w, 8.5, 'fill width')
  near(fill.h, 8.5 / 3, 'fill height')
})

test('sizes are predicted from what was measured, and a new picture must save 5%', () => {
  const seen = [
    { pixels: 1_000_000, quality: Q_MAX, bytes: 200_000 },
    { pixels: 250_000, quality: Q_MAX, bytes: 70_000 },
    { pixels: 250_000, quality: 0.7, bytes: 45_000 },
  ]
  assert.equal(predict(seen, 250_000, 0.7), 45_000)
  assert.equal(predict(seen, 250_000, 0.75), undefined)
  const mid = predict(seen, 500_000, Q_MAX)!
  assert.ok(mid > 70_000 && mid < 200_000, `${mid}`)
  // It passes through both points.
  assert.equal(predict(seen, 1_000_000, Q_MAX), 200_000)
  // Monotone as pixels grow.
  let last = 0
  for (let px = 100_000; px <= 2_000_000; px += 100_000) {
    const p = predict(seen, px, Q_MAX)!
    assert.ok(p > last)
    last = p
  }
  // As they'd go deflated, from what each measured picture deflated to; one measured without it counts its bytes.
  const sent = seen.map((m, i) => ({ ...m, sent: i === 2 ? undefined : Math.round(m.bytes * 0.8) }))
  assert.equal(predict(sent, 1_000_000, Q_MAX, 'sent'), 160_000)
  assert.equal(predict(sent, 250_000, 0.7, 'sent'), 45_000)
  const midSent = predict(sent, 500_000, Q_MAX, 'sent')!
  assert.ok(Math.abs(midSent - mid * 0.8) <= 1, `${midSent} ${mid}`)
  assert.equal(chosen(100_000, 96_000), 100_000)
  assert.equal(chosen(100_000, 94_000), 94_000)
  assert.equal(chosen(100_000, undefined), 100_000)
  const levels = ladder(false)
  assert.equal(
    firstFit(levels, 1000, 1500, (l) => [l.ppi * 4]),
    levels.findIndex((l) => l.ppi * 4 + 1000 <= 1500),
  )
  assert.equal(
    firstFit(levels, 1000, 10, () => [0]),
    undefined,
  )
})

test('the canvas check allows Safari\'s small nudges, not a solid colour or a blank', () => {
  const exact = PROBE.flatMap((rgb) => [...rgb, 255])
  assert.deepEqual(judge(exact), { ok: true, worst: 0, got: '200,30,40,255 20,160,60,255 30,60,210,255 90,120,150,255' })
  // Safari's usual protection: each pixel moved by up to 3, alpha too, then rounded.
  const nudged = PROBE.flatMap((rgb, i) => [...rgb.map((v) => v + [3, -3, 2, -1][i] + (i % 2)), 252])
  const n = judge(nudged)
  assert.ok(n.ok && n.worst <= TOLERANCE, n.got)
  // Its strictest: one random solid colour for everything. Or a blank picture.
  for (const px of [PROBE.flatMap(() => [117, 54, 201, 255]), new Array(16).fill(255), new Array(16).fill(0)]) assert.equal(judge(px).ok, false)
})

/** A JPEG's headers only: SOI, an optional Adobe marker with this transform, then SOF0 and SOS. */
function jpegHeaders(transform?: number): Uint8Array {
  const adobe = transform === undefined ? [] : [0xff, 0xee, 0, 14, ...[...'Adobe'].map((c) => c.charCodeAt(0)), 0, 100, 0, 0, 0, 0, transform]
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, ...adobe, 0xff, 0xc0, 0, 5, 8, 0, 1, 0, 0xff, 0xda, 0, 2])
}

test('the Adobe marker is read from a JPEG\'s headers', () => {
  assert.equal(adobeTransform(jpegHeaders(2)), 2)
  assert.equal(adobeTransform(jpegHeaders(0)), 0)
  assert.equal(adobeTransform(jpegHeaders()), undefined)
  assert.equal(adobeTransform(new Uint8Array([1, 2, 3])), undefined)
})

test('a CMYK JPEG is converted only when it is stored the way Adobe writes them', async () => {
  const doc = await PDFDocument.create()
  const ctx = doc.context
  const add = (transform: number | undefined, decode?: number[]) => {
    const body = new Uint8Array(40_000)
    body.set(jpegHeaders(transform))
    return ctx.register(
      ctx.stream(body, { Type: 'XObject', Subtype: 'Image', Width: 300, Height: 200, BitsPerComponent: 8, ColorSpace: 'DeviceCMYK', Filter: 'DCTDecode', ...(decode ? { Decode: decode } : {}) }),
    )
  }
  const inv = [1, 0, 1, 0, 1, 0, 1, 0]
  const refs = { adobeInverted: add(0, inv), ycckInverted: add(2, inv), adobePlain: add(0), plain: add(undefined), plainInverted: add(undefined, inv), odd: add(0, [0, 1, 1, 0, 0, 1, 0, 1]) }
  const byRef = new Map(findImages(doc).map((im) => [im.ref, im]))
  const v = (k: keyof typeof refs) => byRef.get(refs[k])!.skip ?? byRef.get(refs[k])!.source
  assert.equal(v('adobeInverted'), 'jpeg')
  assert.equal(v('ycckInverted'), 'jpeg')
  for (const k of ['adobePlain', 'plain', 'plainInverted', 'odd'] as const) assert.equal(v(k), 'cmyk', k)
  assert.deepEqual(byRef.get(refs.plain)!.cmyk, { adobe: undefined, decode: 'none', convert: false })
})

test('streams stored twice are kept once, and everything points at the copy kept', async () => {
  const doc = await PDFDocument.create()
  const ctx = doc.context
  const font = new Uint8Array(5000).map((_, i) => (i * 7) & 255)
  const files = [0, 1].map(() => ctx.register(ctx.flateStream(font, { Length1: 5000 })))
  const other = ctx.register(ctx.flateStream(new Uint8Array(5000).fill(9), { Length1: 5000 }))
  const descriptors = [...files, other].map((f) => ctx.register(ctx.obj({ Type: 'FontDescriptor', FontFile2: f })))
  doc.catalog.set(PDFName.of('Test'), ctx.obj(descriptors))
  const merged = await merge(doc)
  assert.equal(merged.objects, 1)
  const point = descriptors.map((d) => (ctx.lookup(d) as PDFDict).get(PDFName.of('FontFile2')))
  assert.equal(point[0], point[1])
  assert.notEqual(point[0], point[2])
  assert.equal(ctx.lookup(files[1]), undefined) // swept
  assert.deepEqual(decodePDFRawStream(ctx.lookup(point[1]) as PDFRawStream).decode(), font)
})

test('re-packing: uncompressed to Flate, ASCII wrappings taken off, XMP left readable', async () => {
  const doc = await PDFDocument.create()
  const ctx = doc.context
  const text = enc(Array.from({ length: 400 }, (_, i) => `BT /F1 12 Tf ${(i * 37) % 500} ${(i * 91) % 700} Td (Line ${i * i}) Tj ET\n`).join(''))
  const plain = ctx.register(ctx.stream(text))
  const hex = [...new Uint8Array(ctx.flateStream(text).contents)].map((b) => b.toString(16).padStart(2, '0')).join('') + '>'
  const wrapped = ctx.register(ctx.stream(enc(hex), { Filter: [PDFName.of('ASCIIHexDecode'), PDFName.of('FlateDecode')] }))
  const xmp = ctx.register(ctx.stream(text, { Type: 'Metadata', Subtype: 'XML' }))
  const before = (ctx.lookup(wrapped) as PDFRawStream).contents.length
  const packed = await pack(doc)
  assert.equal(packed.streams, 2)
  for (const r of [plain, wrapped]) assert.deepEqual(decodePDFRawStream(ctx.lookup(r) as PDFRawStream).decode(), text)
  const w = ctx.lookup(wrapped) as PDFRawStream
  assert.equal(w.dict.get(PDFName.of('Filter')), PDFName.of('FlateDecode'))
  assert.ok(w.contents.length < before / 1.9)
  assert.equal((ctx.lookup(xmp) as PDFRawStream).dict.has(PDFName.of('Filter')), false)
})

test('the breakdown names colour profiles, XMP, attached files and drawings', async () => {
  const doc = await PDFDocument.create()
  const ctx = doc.context
  const icc = ctx.register(ctx.stream(new Uint8Array(3000), { N: 3 }))
  const out = ctx.register(ctx.stream(new Uint8Array(5000), { N: 4 }))
  ctx.register(ctx.stream(new Uint8Array(700), { Type: 'Metadata', Subtype: 'XML' }))
  ctx.register(ctx.stream(new Uint8Array(900), { Type: 'EmbeddedFile' }))
  ctx.register(ctx.stream(new Uint8Array(400), { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 1, 1] }))
  doc.catalog.set(PDFName.of('OutputIntents'), ctx.obj([ctx.obj({ Type: 'OutputIntent', DestOutputProfile: out })]))
  doc.catalog.set(PDFName.of('Test'), ctx.obj([PDFArray.withContext(ctx), ctx.obj([PDFName.of('ICCBased'), icc])]))
  const w = where(doc, [])
  assert.equal(w.profiles, 8000)
  assert.equal(w.metadata, 700)
  assert.equal(w.attachments, 900)
  assert.equal(w.forms, 400)
})
