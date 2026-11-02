// "Make a smaller copy": sharing the space, and finding the best copy that fits.
// Run from the repo root: npm --prefix web test
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  FLOOR_EDGE,
  MAX_EDGE,
  Q_FLOOR,
  Q_LOWER,
  Q_LOWEST,
  Q_MAX,
  Q_STEPS,
  allocate,
  copyName,
  fitDims,
  floorEdge,
  searchCopy,
  topEdge,
  weight,
  type Dims,
  type Share,
} from '../src/shrink/plan.ts'

test('sizes keep their shape, never grow, and stay within the limits', () => {
  assert.deepEqual(fitDims({ width: 4032, height: 3024 }, 2048), { width: 2048, height: 1536 })
  assert.deepEqual(fitDims({ width: 3024, height: 4032 }, 2048), { width: 1536, height: 2048 })
  assert.deepEqual(fitDims({ width: 800, height: 600 }, 2048), { width: 800, height: 600 })
  assert.deepEqual(fitDims({ width: 10000, height: 1 }, 100), { width: 100, height: 1 }) // never 0 wide
  const big = { width: 8064, height: 6048 }
  assert.equal(topEdge(big), MAX_EDGE)
  assert.equal(floorEdge(big), FLOOR_EDGE)
  assert.equal(topEdge({ width: 900, height: 700 }), 900) // a small photo keeps its own size
  assert.equal(floorEdge({ width: 900, height: 700 }), 900)
  assert.equal(MAX_EDGE, 2048) // about 4 megapixels
  assert.equal(weight(big), 2048 * 1536)
  assert.equal(weight({ width: 0, height: 0 }), 1) // never divides by zero
  assert.equal(Q_FLOOR, Q_STEPS[Q_STEPS.length - 1])
  assert.ok(Q_STEPS.every((q) => q < Q_MAX))
})

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)

test('one photo gets the whole space, or goes as it is when that fits', () => {
  assert.deepEqual(allocate(1_000_000, [{ full: 3_000_000, least: 200_000, weight: 12e6 }]), { fits: true, sizes: [1_000_000] })
  assert.deepEqual(allocate(5_000_000, [{ full: 3_000_000, least: 200_000, weight: 12e6 }]), { fits: true, sizes: [3_000_000] })
  assert.deepEqual(allocate(150_000, [{ full: 3_000_000, least: 200_000, weight: 12e6 }]), { fits: false, count: 0 })
})

test('photos share the space by their pixels, so they come out alike', () => {
  const a = allocate(1_200_000, [
    { full: 3_000_000, least: 150_000, weight: 12e6 },
    { full: 3_000_000, least: 150_000, weight: 12e6 },
    { full: 6_000_000, least: 150_000, weight: 24e6 },
  ])
  assert.ok(a.fits)
  assert.ok(Math.abs(a.sizes[0] - 300_000) <= 1 && Math.abs(a.sizes[1] - 300_000) <= 1 && Math.abs(a.sizes[2] - 600_000) <= 1)
  assert.ok(sum(a.sizes) <= 1_200_000)
})

test('a small photo goes as it is, and the space it doesn’t need goes to the others', () => {
  const a = allocate(1_000_000, [
    { full: 50_000, least: 60_000, weight: 1e6 }, // a copy would be no smaller
    { full: 4_000_000, least: 200_000, weight: 12e6 },
  ])
  assert.ok(a.fits)
  assert.equal(a.sizes[0], 50_000)
  assert.equal(a.sizes[1], 950_000)
})

test('no photo gets less than its smallest copy', () => {
  const a = allocate(700_000, [
    { full: 3_000_000, least: 400_000, weight: 1e6 }, // a detailed photo, small in pixels
    { full: 3_000_000, least: 100_000, weight: 12e6 },
  ])
  assert.ok(a.fits)
  assert.equal(a.sizes[0], 400_000)
  assert.equal(a.sizes[1], 300_000)
})

test('when even the smallest copies don’t fit, it says how many would', () => {
  const photos = [400_000, 300_000, 500_000, 250_000, 350_000].map((least) => ({ full: 3_000_000, least, weight: 12e6 }))
  assert.deepEqual(allocate(1_000_000, photos), { fits: false, count: 3 }) // 250 + 300 + 350 KB
  assert.deepEqual(allocate(1_800_000, photos), { fits: true, sizes: [400_000, 300_000, 500_000, 250_000, 350_000] }) // exactly the smallest
  assert.deepEqual(allocate(200_000, photos), { fits: false, count: 0 })
  assert.deepEqual(allocate(-5, photos), { fits: false, count: 0 }) // other files already fill it
})

test('shares never add up to more than the space (random cases)', () => {
  let seed = 7
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
  for (let k = 0; k < 2000; k++) {
    const photos: Share[] = Array.from({ length: 1 + Math.floor(rand() * 8) }, () => {
      const full = Math.floor(rand() * 8_000_000) + 1
      return { full, least: Math.floor(rand() * 600_000) + 1, weight: Math.floor(rand() * 16e6) + 1 }
    })
    const space = Math.floor(rand() * 3_000_000)
    const a = allocate(space, photos)
    if (!a.fits) {
      const least = photos.map((p) => Math.min(p.least, p.full)).sort((x, y) => x - y)
      assert.ok(sum(least) > space)
      assert.ok(sum(least.slice(0, a.count)) <= space)
      if (a.count < least.length) assert.ok(sum(least.slice(0, a.count + 1)) > space)
      continue
    }
    assert.ok(sum(a.sizes) <= space, `case ${k}: ${sum(a.sizes)} > ${space}`)
    photos.forEach((p, i) => {
      assert.ok(a.sizes[i] >= Math.min(p.least, p.full) - 1, `case ${k}: below its smallest copy`)
      assert.ok(a.sizes[i] <= p.full)
    })
    // Close to the space, unless every photo goes as it is.
    if (a.sizes.some((s, i) => s < photos[i].full)) assert.ok(sum(a.sizes) >= space - photos.length - 1, `case ${k}: space wasted`)
  }
})

/**
 * A stand-in for the browser's encoder: JPEG-like sizes that grow as
 * edge^1.8 and fall with quality, plus a little noise so it isn't too tidy.
 */
function model(d: Dims, bytesAtFloor = 300_000) {
  const calls: [number, number][] = []
  const qf = (q: number) => Math.pow(q / Q_MAX, 3)
  const encode = async (edge: number, quality: number) => {
    calls.push([edge, quality])
    const e = Math.min(edge, topEdge(d))
    const noise = 1 + 0.03 * Math.sin(edge * 12.9898)
    return Math.round(bytesAtFloor * Math.pow(e / FLOOR_EDGE, 1.8) * qf(quality) * noise)
  }
  return { encode, calls }
}

const photo = { width: 4032, height: 3024 }

test('a copy is never bigger than MAX_EDGE, however much room there is, and takes one try', async () => {
  const m = model(photo)
  const r = await searchCopy(photo, 10_000_000, m.encode)
  assert.deepEqual(r && [r.edge, r.quality], [MAX_EDGE, Q_MAX])
  assert.equal(m.calls.length, 1)
  // About 700 KB in this model, though nearly 2 MB was free: the space isn't filled for its own sake.
  assert.ok(r && r.size < 1_000_000)
  const huge = { width: 8064, height: 6048 }
  const h = model(huge)
  const big = await searchCopy(huge, 10_000_000, h.encode)
  assert.deepEqual(big && [big.edge, big.quality], [MAX_EDGE, Q_MAX])
  // A photo already under MAX_EDGE keeps its own size.
  const mid = { width: 1800, height: 1200 }
  const k = model(mid)
  const own = await searchCopy(mid, 10_000_000, k.encode)
  assert.deepEqual(own && [own.edge, own.quality], [1800, Q_MAX])
})

test('otherwise it finds about the largest that fits, in a few tries', async () => {
  for (const target of [350_000, 450_000, 550_000, 650_000]) { // between the floor and MAX_EDGE in this model
    const m = model(photo)
    const r = await searchCopy(photo, target, m.encode)
    assert.ok(r, `target ${target}`)
    assert.equal(r.quality, Q_MAX)
    assert.ok(r.size <= target)
    assert.ok(r.size >= target * 0.85, `target ${target}: only ${r.size}`)
    assert.ok(m.calls.length <= 5, `target ${target}: ${m.calls.length} tries`)
  }
})

test('a hint from measuring saves tries', async () => {
  const plain = model(photo)
  await searchCopy(photo, 800_000, plain.encode)
  const hinted = model(photo)
  const hint = { edge: FLOOR_EDGE, quality: Q_MAX, size: await hinted.encode(FLOOR_EDGE, Q_MAX) }
  hinted.calls.length = 0
  const r = await searchCopy(photo, 800_000, hinted.encode, hint)
  assert.ok(r && r.size <= 800_000)
  assert.ok(hinted.calls.length <= plain.calls.length)
})

test('below the floor size at full quality, it lowers the quality at the floor', async () => {
  const m = model(photo)
  const atFloor = await m.encode(FLOOR_EDGE, Q_MAX)
  const at075 = await m.encode(FLOOR_EDGE, 0.75)
  m.calls.length = 0
  const r = await searchCopy(photo, at075 + 1, m.encode)
  assert.deepEqual(r && [r.edge, r.quality], [FLOOR_EDGE, 0.75])
  assert.ok(at075 < atFloor)
  // Never smaller than the floor, never lower than Q_FLOOR.
  assert.ok(m.calls.every(([e, q]) => e >= FLOOR_EDGE && q >= Q_FLOOR))
  assert.equal(await searchCopy(photo, (await m.encode(FLOOR_EDGE, Q_FLOOR)) - 1, m.encode), undefined)
})

test('“Lower the quality” goes on down, to Q_LOWEST and no further', async () => {
  assert.ok(Q_LOWER.every((q) => q < Q_FLOOR))
  assert.equal(Q_LOWEST, 0.4)
  const m = model(photo)
  const at05 = await m.encode(FLOOR_EDGE, 0.5)
  const lowest = await m.encode(FLOOR_EDGE, Q_LOWEST)
  m.calls.length = 0
  assert.equal(await searchCopy(photo, at05, m.encode), undefined) // not without asking
  const r = await searchCopy(photo, at05, m.encode, undefined, true)
  assert.deepEqual(r && [r.edge, r.quality], [FLOOR_EDGE, 0.5])
  assert.equal(await searchCopy(photo, lowest - 1, m.encode, undefined, true), undefined)
  assert.ok(m.calls.every(([, q]) => q >= Q_LOWEST))
  // Asking for it changes nothing when the usual quality fits.
  const big = await searchCopy(photo, 900_000, m.encode, undefined, true)
  assert.equal(big?.quality, Q_MAX)
})

test('a photo smaller than the floor keeps its own size', async () => {
  const small = { width: 1000, height: 750 }
  const m = model(small, 900_000)
  const r = await searchCopy(small, 450_000, m.encode) // about 577 KB at Q_MAX, 396 KB at 0.75
  assert.ok(r)
  assert.equal(r.edge, 1000)
  assert.equal(r.quality, 0.75)
  assert.ok(m.calls.every(([e]) => e === 1000))
})

test('whatever it returns fits, and it gives up only when even the smallest is too big (random cases)', async () => {
  let seed = 11
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
  for (let k = 0; k < 300; k++) {
    const d = { width: 500 + Math.floor(rand() * 9000), height: 500 + Math.floor(rand() * 9000) }
    const m = model(d, 50_000 + Math.floor(rand() * 600_000))
    const target = Math.floor(rand() * 3_000_000)
    const r = await searchCopy(d, target, m.encode)
    const smallest = await m.encode(floorEdge(d), Q_FLOOR)
    if (!r) assert.ok(smallest > target, `case ${k}: gave up though ${smallest} <= ${target}`)
    else {
      assert.ok(r.size <= target)
      assert.ok(r.edge >= floorEdge(d) && r.edge <= topEdge(d))
    }
    assert.ok(m.calls.length <= 12, `case ${k}: ${m.calls.length} tries`)
  }
})

test('copies get a name that matches their type', () => {
  assert.equal(copyName('IMG_1234.HEIC', 'image/jpeg'), 'IMG_1234.jpg')
  assert.equal(copyName('IMG_1234.JPG', 'image/jpeg'), 'IMG_1234.JPG')
  assert.equal(copyName('holiday.jpeg', 'image/jpeg'), 'holiday.jpeg')
  assert.equal(copyName('logo.png', 'image/webp'), 'logo.webp')
  assert.equal(copyName('logo.png', 'image/png'), 'logo.png')
  assert.equal(copyName('scan', 'image/jpeg'), 'scan.jpg')
  assert.equal(copyName('.hidden', 'image/jpeg'), '.hidden.jpg')
  assert.equal(copyName('', 'image/jpeg'), 'photo.jpg')
  assert.equal(copyName('my.photo.avif', 'image/jpeg'), 'my.photo.jpg')
})
