// Slynk's file list (web/src/prep/list.ts): what both the composer (tray.ts)
// and the file-prep example run. Here what makes things smaller (prep/makers.ts)
// is stood in for, so the list's plan and what it makes can be checked in Node,
// which has no canvas or WebCodecs: the stand-ins' sizes follow a photo's pixels
// and quality roughly as a browser's do. What's checked is how the list shares
// the space, in what order it makes things, what its box says, and that it
// settles. The real makers are tried in a browser, on Slynk's page and the
// example's.
// Run from the repo root: npm --prefix web test
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { test } from 'node:test'
import { zipSync } from 'fflate'
import { be16, cat, seg } from './strip/fixtures.ts'

// As in file-prep.test.ts: a few of Slynk's modules use TypeScript that Node's type-stripping can't
// run (video/client.ts's parameter properties), so those are turned into JavaScript here.
const WEB = new URL('../', import.meta.url).href
const quietly = <T>(f: () => T): T => {
  const emit = process.emitWarning
  process.emitWarning = () => {}
  try {
    return f()
  } finally {
    process.emitWarning = emit
  }
}
quietly(() =>
  registerHooks({
    load(url, context, next) {
      const loaded = next(url, context)
      if (!url.startsWith(WEB) || url.includes('/node_modules/') || loaded.format !== 'module-typescript') return loaded
      const source = String(loaded.source)
      try {
        quietly(() => stripTypeScriptTypes(source))
        return loaded
      } catch {
        return { ...loaded, format: 'module', source: quietly(() => stripTypeScriptTypes(source, { mode: 'transform', sourceUrl: url })) }
      }
    },
  }),
)

const { baseRow, createFileList } = await import('../src/prep/list.ts')
const { Q_FLOOR, Q_LOWER, Q_LOWEST, Q_MAX, Q_STEPS, fitDims, floorEdge, topEdge } = await import('../src/shrink/plan.ts')
const { BPP_FLOOR, leastTarget, planStep } = await import('../src/video/plan.ts')
const { avcC } = await import('../src/video/avc.ts')
const { videoInfo } = await import('../src/video/info.ts')
const { mux } = await import('../src/video/mux.ts')
type VideoStep = import('../src/video/plan.ts').VideoStep
type Dims = { width: number; height: number }

/** About what a photo takes at this long edge and quality. */
const bytesAt = (dims: Dims, edge: number, q: number) => {
  const d = fitDims(dims, edge)
  return Math.ceil(d.width * d.height * (0.02 + 0.2 * q * q))
}

/** Stand-ins for the page's photo drawing, document worker and audio worker, each call noted in calls. */
function standIns(calls: string[]) {
  const docs = new Map<number, number[]>()
  return {
    checkCanvas: async () => true,
    measure: async (_bytes: Uint8Array, info: { dims: Dims }, o: { keep?: string; progress?: (d: number) => void } = {}) => {
      calls.push('measure')
      const dims = info.dims
      const floor = floorEdge(dims)
      const m: any = { dims, type: 'image/jpeg', least: bytesAt(dims, floor, Q_FLOOR), lowest: bytesAt(dims, floor, Q_LOWEST), hint: { edge: floor, quality: Q_MAX, size: bytesAt(dims, floor, Q_MAX) } }
      // "Smallest" keeps the copy it made at its level as it measured.
      if (o.keep === 'least') m.kept = { data: new Uint8Array(m.lowest), type: 'image/jpeg', dims: fitDims(dims, floor), quality: Q_LOWEST, level: 'least' }
      o.progress?.(1)
      return m
    },
    keptCopy: (m: any, level: string, target: number) => (m.kept?.level === level && m.kept.data.length <= target ? { data: m.kept.data, type: m.kept.type, dims: m.kept.dims, quality: m.kept.quality } : undefined),
    makeCopy: async (_bytes: Uint8Array, _info: unknown, m: any, target: number, lower: boolean) => {
      calls.push('makeCopy')
      // Down from its top size at the best quality, as the page tries them.
      const tries: [number, number][] = []
      for (let e = topEdge(m.dims); e > floorEdge(m.dims); e = Math.floor(e * 0.9)) tries.push([e, Q_MAX])
      for (const q of [Q_MAX, ...Q_STEPS, ...(lower ? Q_LOWER : [])]) tries.push([floorEdge(m.dims), q])
      for (const [e, q] of tries) if (bytesAt(m.dims, e, q) <= target) return { data: new Uint8Array(bytesAt(m.dims, e, q)), type: 'image/jpeg', dims: fitDims(m.dims, e), quality: q }
      return undefined
    },
    measureDoc: async (n: number, _kind: string, bytes: Uint8Array, _cap: number, progress: (d: number) => void) => {
      calls.push('measureDoc')
      const levels = [0.1, 0.07, 0.05, 0.035, 0.02, 0.012].map((f) => Math.ceil(bytes.length * f))
      docs.set(n, levels)
      progress(1)
      return { pictures: 4, tidied: bytes.length, original: bytes.length, levels, lowerFrom: 4, smallest: levels[levels.length - 1], mostlyKept: false }
    },
    makeDoc: async (n: number, target: number, lower: boolean) => {
      calls.push('makeDoc')
      const levels = docs.get(n)!
      const at = (lower ? levels : levels.slice(0, 4)).find((l) => l <= target)
      return at === undefined ? undefined : { data: new Uint8Array(at), sent: at, changed: 3, lowered: levels.indexOf(at) >= 4 }
    },
    dropDoc: (n: number) => {
      calls.push('dropDoc')
      docs.delete(n)
    },
    stopDoc: () => {},
    shrinkInWorker: async () => {
      throw new Error('no-webcodecs')
    },
    audioInWorker: async (_input: unknown, target: number) => {
      calls.push('audio')
      return { data: new Uint8Array(Math.min(target, 20_000)), report: { seconds: 60, bitrate: 12_000, channels: 1, rate: 48_000, resampled: false, bytes: 0, passes: [], peaks: [] } }
    },
    decodeWhole: async () => {
      throw new Error('not decoded here')
    },
    canShrinkAudio: () => 'yes',
  } as any
}

/**
 * A list as Slynk's page drives one: each change redraws the box, which may say to make copies now. No
 * cleaning or Brotli (those are tried with the real workers in file-prep.test.ts).
 */
function host(set: object, limit = 2_000_000, makers: object = {}) {
  const calls: string[] = []
  const settings = { stripMetadata: false, shrink: 'smallest', smallestPhotos: 'least', smallestVideos: 240, plainNames: false, brotli: false, ...set } as const
  const redraw = () => {
    if (list.offer(list.compose(undefined, 0)).start) queueMicrotask(() => void list.makeSmallerCopies(false, true))
  }
  const list = createFileList<any>({
    settings: () => settings,
    makers: { ...standIns(calls), ...makers },
    compose: () => list.compose(undefined, 0),
    limit: () => limit,
    planLimit: () => limit,
    newRow: (file: File) => baseRow(file),
    updateRow: redraw,
    changed: redraw,
    toast: () => {},
    unreadable: (row: unknown) => list.remove(row),
  })
  return { list, calls, limit }
}

/** A JPEG that says it's width × height, size bytes long: what Slynk reads of a photo before drawing it. */
function photo(width: number, height: number, size: number, name: string): File {
  const head = cat(
    [0xff, 0xd8],
    seg(0xdb, cat([0x00], new Array(64).fill(1))),
    seg(0xc0, [8, ...be16(height), ...be16(width), 1, 1, 0x11, 0]),
    seg(0xc4, cat([0x00, 1], new Array(15).fill(0), [0x00])),
    seg(0xda, [1, 1, 0x00, 0, 63, 0]),
  )
  return new File([head, randomBytes(Math.max(0, size - head.length - 2)), new Uint8Array([0xff, 0xd9])], name, { type: 'image/jpeg' })
}

/** A PDF size bytes long: what Slynk reads of one before its worker measures it. */
const pdf = (size: number, name: string) => new File([new TextEncoder().encode('%PDF-1.7\n'), randomBytes(size - 9)], name, { type: 'application/pdf' })

/** A mono 16-bit WAV, seconds long at 8 kHz. */
function wav(seconds: number, name: string): File {
  const n = 8000 * seconds
  const b = new Uint8Array(44 + n * 2)
  const v = new DataView(b.buffer)
  const s = (o: number, t: string) => [...t].forEach((c, i) => (b[o + i] = c.charCodeAt(0)))
  s(0, 'RIFF')
  v.setUint32(4, 36 + n * 2, true)
  s(8, 'WAVE')
  s(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, 1, true)
  v.setUint32(24, 8000, true)
  v.setUint32(28, 16000, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  s(36, 'data')
  v.setUint32(40, n * 2, true)
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(8000 * Math.sin(i / 10)), true)
  return new File([b], name, { type: 'audio/wav' })
}

test('“To fit”: photos that fit go as they are; over the limit they share the space, and the box says so', async () => {
  const { list, calls, limit } = host({ shrink: 'fit' })
  list.add([photo(4032, 3024, 900_000, 'a.jpg'), photo(4032, 3024, 900_000, 'b.jpg')])
  await list.idle()
  let c = list.compose(undefined, 0)
  assert.ok(c.wire <= limit, `${c.wire}`)
  assert.deepEqual(calls, [], 'nothing measured while they fit')
  assert.equal(list.offer(c).kind, 'hidden')
  list.add([photo(4032, 3024, 900_000, 'c.jpg')])
  await list.idle()
  c = list.compose(undefined, 0)
  assert.ok(c.wire <= limit, `${c.wire} over ${limit}`)
  assert.equal(list.rows.filter(list.inCopy).length, 3, 'all three share the room')
  assert.ok(list.rows.every((r: any) => r.copy.quality === Q_MAX), 'at the best quality, since that fits')
  assert.equal(list.offer(c).kind, 'made')
  assert.equal(list.working(), false)
  assert.equal(c.pending, false)
})

test('“Smallest”: every photo at its level, fitting or not, made as it was measured', async () => {
  const { list, calls } = host({ shrink: 'smallest' })
  list.add([photo(4032, 3024, 900_000, 'a.jpg'), photo(3000, 2000, 400_000, 'b.jpg')])
  await list.idle()
  assert.ok(list.rows.every(list.inCopy))
  assert.ok(list.rows.every((r: any) => r.copy.quality === Q_LOWEST))
  assert.deepEqual(calls, ['measure', 'measure'], 'each decoded once: its copy kept as it was measured')
  assert.equal(list.offer(list.compose(undefined, 0)).kind, 'made')
})

test('photos first, then documents, then audio, each made once', async () => {
  const { list, calls } = host({ shrink: 'smallest' })
  list.add([wav(60, 'voice.wav'), pdf(1_500_000, 'scan.pdf'), photo(4032, 3024, 900_000, 'a.jpg')])
  await list.idle()
  assert.deepEqual(
    calls.filter((x) => x !== 'dropDoc'),
    ['measure', 'measureDoc', 'makeDoc', 'audio'],
  )
  assert.ok(list.rows.every(list.inCopy))
  assert.equal(list.compose(undefined, 0).pending, false)
})

test('“Ask first”: nothing made until asked; the box offers, and its button makes them fit', async () => {
  const { list, calls, limit } = host({ shrink: 'ask' })
  list.add([photo(4032, 3024, 1_200_000, 'a.jpg'), photo(4032, 3024, 1_200_000, 'b.jpg')])
  await list.idle()
  const offer = list.offer(list.compose(undefined, 0))
  assert.equal(offer.kind, 'offer')
  assert.equal(offer.button?.lower, false)
  assert.deepEqual(calls, [])
  await list.makeSmallerCopies(false)
  await list.idle()
  assert.ok(list.compose(undefined, 0).wire <= limit)
  assert.ok(list.rows.every(list.inCopy))
})

test('a zip’s last file taken off the list takes the zip with it', async () => {
  const { list } = host({ shrink: 'ask' })
  const inside = new Uint8Array(await photo(640, 480, 20_000, 'x').arrayBuffer())
  list.add([new File([zipSync({ 'trip/IMG_0001.jpg': [inside, { level: 0 }] })], 'trip.zip', { type: 'application/zip' })])
  await list.idle()
  const [zip, member] = list.rows
  assert.equal(member.parent, zip)
  assert.equal(member.entry, 'trip/IMG_0001.jpg')
  assert.equal(list.remove(member), zip)
  assert.deepEqual(list.rows, [])
})

test('emptying the list lets go of each document the worker measured', async () => {
  const { list, calls } = host({ shrink: 'smallest' })
  list.add([pdf(600_000, 'a.pdf')])
  await list.idle()
  assert.ok(calls.includes('measureDoc'))
  const before = calls.filter((x) => x === 'dropDoc').length
  list.clear()
  assert.equal(calls.filter((x) => x === 'dropDoc').length, before + 1)
  assert.deepEqual(list.rows, [])
})

/**
 * A PDF's stand-in that's smaller as it's sent (deflated) than as it's saved, as one of
 * screenshots is: its levels, as the worker gives them (with room for predictions, MARGIN).
 */
function sentDoc(saved: number[], seen: boolean[]) {
  const levelsOf = (compressed: boolean) => saved.map((b) => Math.ceil((compressed ? b * 0.85 : b) / 0.97))
  const levels = new Map<number, number[]>()
  return {
    measureDoc: async (n: number, _kind: string, bytes: Uint8Array, _cap: number, progress: (d: number) => void, compressed = false) => {
      seen.push(compressed)
      const l = levelsOf(compressed)
      levels.set(n, l)
      progress(1)
      return { pictures: 9, tidied: bytes.length, original: bytes.length, levels: l, lowerFrom: 2, smallest: Math.floor(l[l.length - 1] * 0.97), mostlyKept: false }
    },
    makeDoc: async (n: number, target: number, lower: boolean) => {
      const l = levels.get(n)!
      const at = (lower ? l : l.slice(0, 2)).find((b) => b <= target)
      return at === undefined ? undefined : { data: new Uint8Array(at), sent: at, changed: 5, lowered: l.indexOf(at) >= 2 }
    },
  }
}

test('a PDF is planned as it’s sent, compressed: one too big as it’s saved, but not as it goes, is made smaller', async () => {
  const seen: boolean[] = []
  const { list } = host({ shrink: 'smallest' }, 2_000_000, sentDoc([3_000_000, 2_600_000, 2_300_000, 2_180_000], seen))
  list.add([pdf(2_400_000, 'manual.pdf')])
  await list.idle()
  assert.deepEqual(seen, [true], 'measured as it’s sent')
  const [row] = list.rows
  assert.equal(row.docProblem, undefined)
  assert.ok(row.dcopy && list.inCopy(row))
  assert.ok(row.dcopy.sent <= 2_000_000)
})

test('a PDF too big even as it’s sent says how small it gets', async () => {
  const seen: boolean[] = []
  const { list } = host({ shrink: 'smallest' }, 2_000_000, sentDoc([3_400_000, 3_000_000, 2_800_000, 2_600_000], seen))
  list.add([pdf(2_400_000, 'manual.pdf')])
  await list.idle()
  const [row] = list.rows
  assert.equal(row.docProblem, 'big')
  const { DOC_PROBLEM } = await import('../src/shrinkCopy.ts')
  assert.equal(DOC_PROBLEM(row.docProblem, true, row.dmeasured), 'Even made smaller, this PDF is too big: about 2.21 MB at its smallest.')
})

/** A 1080p video with sound, seconds long at fps, a little over size bytes: only its index is read, so its pictures are made up. */
function movie(seconds: number, name: string, fps = 30, size = 2_100_000): File {
  const frames = Math.round(seconds * fps)
  const picture = new Uint8Array(Math.ceil(size / frames))
  const video = Array.from({ length: frames }, (_, i) => ({ data: picture, pts: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps), key: i % fps === 0 }))
  const sound = Array.from({ length: Math.round((seconds * 48000) / 1024) }, (_, i) => ({ data: new Uint8Array(50), pts: Math.round((i * 1024e6) / 48000), duration: 21_333, key: true }))
  const sps = new Uint8Array([0x67, 0x64, 0x00, 0x28, 0xac, 0xd9, 0x40])
  const pps = new Uint8Array([0x68, 0xeb, 0xe3, 0xcb])
  const file = mux({ width: 1920, height: 1080, rotation: 0, description: avcC([sps], [pps]), samples: video }, { codec: 'aac', sampleRate: 48000, channels: 1, description: new Uint8Array([0x11, 0x88]), samples: sound })
  return new File([file as BlobPart], name, { type: 'video/mp4' })
}

/** The video worker as the real one plans (video/shrink.ts): the first of its steps that fits beside its sound, made at 32 kbit/s; each call noted. */
function videoWorker(made: { steps: string[]; got: string }[]) {
  return {
    shrinkInWorker: async (file: File, target: number, _progress: unknown, _signal: AbortSignal, steps?: VideoStep[]) => {
      const v = (await videoInfo(file))!
      const sound = Math.ceil((32_000 * v.seconds) / 8)
      const step = steps!.find((s) => leastTarget(v, v.seconds, v.fps, sound, 50, s) <= target)
      if (!step) throw new Error('too-long')
      const plan = planStep(v, v.seconds, v.fps, sound, 50, step)
      made.push({ steps: steps!.map(said), got: `${plan.height}p${plan.fps}` })
      const data = new Uint8Array(leastTarget(v, v.seconds, v.fps, sound, 50, step) - 1)
      return { data, report: { output: { width: plan.width, height: plan.height, fps: plan.fps }, sound: { codec: 'opus' } } }
    },
  }
}
const said = (s: VideoStep) => `${s.short}p${s.fps}${s.bpp === BPP_FLOOR ? ' floor' : ''}`

test('“Smallest”: a video too long for its level steps down to the first step that fits, several together at the same one', async () => {
  // Node has no WebCodecs: as if it had, so the videos can be made smaller.
  const g = globalThis as any
  Object.assign(g, { VideoDecoder: { isConfigSupported: async () => ({ supported: true }) }, VideoEncoder: {}, OffscreenCanvas: class {} })
  try {
    const run = async (level: number, files: File[]) => {
      const made: { steps: string[]; got: string }[] = []
      const { list, limit } = host({ shrink: 'smallest', smallestVideos: level }, 2_000_000, videoWorker(made))
      list.add(files)
      await list.idle()
      const c = list.compose(undefined, 0)
      return { made, list, fits: c.wire <= limit, box: list.offer(c).kind }
    }
    const [two, one, both, wide, long] = await Promise.all([
      // A 2-minute video: 240p 15, where it was refused (2026-11-01).
      run(240, [movie(120, 'two.mp4')]),
      // One that fits its level is made at it, as before.
      run(240, [movie(60, 'one.mp4')]),
      // Two of a minute don't fit at 240p 30: both at 240p 15.
      run(240, [movie(60, 'a.mp4'), movie(60, 'b.mp4')]),
      run(360, [movie(70, 'wide.mp4')]),
      // Too long even at 180p 15: refused at once, never made.
      run(240, [movie(240, 'long.mp4')]),
    ])
    assert.deepEqual(two.made, [{ steps: ['240p15', '180p30', '180p15 floor'], got: '240p15' }])
    assert.deepEqual([two.fits, two.box], [true, 'made'])
    assert.deepEqual(one.made, [{ steps: ['240p30', '240p15', '180p30', '180p15 floor'], got: '240p30' }])
    assert.deepEqual(both.made.map((m) => [m.steps[0], m.got]), [['240p15', '240p15'], ['240p15', '240p15']])
    assert.deepEqual([both.fits, both.box], [true, 'made'])
    assert.deepEqual(wide.made.map((m) => [m.steps[0], m.got]), [['360p15', '360p15']])
    assert.deepEqual(long.made, [])
    // Its row says so ("Too long to fit, even made smaller."); the box has nothing it could make.
    assert.equal(long.list.rows[0].videoProblem, 'long')
    assert.equal(long.box, 'hidden')
  } finally {
    for (const k of ['VideoDecoder', 'VideoEncoder', 'OffscreenCanvas']) delete g[k]
  }
})
