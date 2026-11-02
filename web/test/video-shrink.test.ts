// "Make videos smaller to fit" (src/video/): reading a video's index, writing
// a small MP4, the sizing rules, and the codec names WebCodecs needs. The
// encoding itself needs a browser; this is everything around it.
// Run from the repo root: npm --prefix web test
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { avcC, forMp4, fromAnnexB, isAnnexB, parseAvcC, splitAnnexB } from '../src/video/avc.ts'
import { aacConfig, audioConfig, demux, fileReader, hevcCodec, readSamplesOf, showsAt } from '../src/video/demux.ts'
import { mux, type MuxSample } from '../src/video/mux.ts'
import { bytesOf, halve } from '../src/video/shrink.ts'
import { BPP_FLOOR, BPP_GOOD, BPP_OK, LADDER, fitShort, leastBytes, leastTarget, planVideo, retryBitrate, smallerStep } from '../src/video/plan.ts'

const SPS = new Uint8Array([0x67, 0x64, 0x00, 0x1f, 0xac, 0xd9, 0x40])
const PPS = new Uint8Array([0x68, 0xeb, 0xe3, 0xcb])
const ASC = new Uint8Array([0x11, 0x88]) // AAC-LC, 48 kHz, mono

const bytes = (tag: string, n: number) => new Uint8Array(n).map((_, i) => (tag.charCodeAt(i % tag.length) + i) & 0xff)

/** Frames at 30 a second, a key frame every 10; their bytes say which they are. */
function frames(count: number, order?: number[]): MuxSample[] {
  const list = Array.from({ length: count }, (_, i) => ({ data: bytes(`frame${i}:`, 200 + (i % 7) * 31), pts: Math.round((i * 1e6) / 30), duration: Math.round(1e6 / 30), key: i % 10 === 0 }))
  return order ? order.map((i) => list[i]) : list
}

function sound(count: number): MuxSample[] {
  return Array.from({ length: count }, (_, i) => ({ data: bytes(`aac${i}:`, 90 + (i % 5)), pts: Math.round((i * 1024 * 1e6) / 48000), duration: Math.round((1024 * 1e6) / 48000), key: true }))
}

const blob = (b: Uint8Array) => new Blob([b as BlobPart])

/** The top-level boxes' types, in order. */
function topBoxes(b: Uint8Array): string[] {
  const out: string[] = []
  const view = new DataView(b.buffer, b.byteOffset)
  for (let p = 0; p + 8 <= b.length; ) {
    out.push(String.fromCharCode(...b.subarray(p + 4, p + 8)))
    p += view.getUint32(p)
  }
  return out
}

test('a written video reads back: sizes, turn, codecs, every sample where it should be', async () => {
  const video = frames(90)
  const audio = sound(140)
  const file = mux({ width: 640, height: 360, rotation: 90, description: avcC([SPS], [PPS]), samples: video }, { codec: 'aac', sampleRate: 48000, channels: 1, description: ASC, samples: audio })
  assert.deepEqual(topBoxes(file), ['ftyp', 'moov', 'mdat'], 'the index comes first, so it plays as it arrives')
  const movie = await demux(blob(file))
  assert.equal(movie.brand, 'isom')
  assert.ok(Math.abs(movie.duration - 3) < 0.05)
  const [v, a] = movie.tracks
  assert.equal(v.kind, 'video')
  assert.equal(v.codec, 'avc1.64001f')
  assert.equal(v.width, 640)
  assert.equal(v.height, 360)
  assert.equal(v.rotation, 90)
  assert.equal(v.enabled, true)
  assert.deepEqual(v.description, avcC([SPS], [PPS]))
  assert.equal(a.kind, 'audio')
  assert.equal(a.codec, 'mp4a.40.2')
  assert.equal(a.sampleRate, 48000)
  assert.equal(a.channels, 1)
  assert.deepEqual(a.description, ASC)
  const read = fileReader(blob(file))
  for (const [track, samples] of [
    [v, video],
    [a, audio],
  ] as const) {
    assert.equal(track.samples.length, samples.length)
    for await (const { index, data } of readSamplesOf(read, track.samples)) {
      assert.deepEqual(data, samples[index].data, `sample ${index}`)
      assert.ok(Math.abs(showsAt(track, track.samples[index]) - samples[index].pts) <= 25, `sample ${index}'s time`)
      if (track.kind === 'video') assert.equal(track.samples[index].key, samples[index].key)
    }
  }
})

test('each turn reads back as written', async () => {
  for (const rotation of [0, 90, 180, 270] as const) {
    const file = mux({ width: 640, height: 360, rotation, description: avcC([SPS], [PPS]), samples: frames(3) })
    assert.equal((await demux(blob(file))).tracks[0].rotation, rotation)
  }
})

test('pictures encoded out of order (B-frames) keep their times', async () => {
  // Decode order I0 P3 B1 B2 P6 B4 B5: each shows at its own time.
  const order = [0, 3, 1, 2, 6, 4, 5]
  const written = frames(7, order)
  const file = mux({ width: 64, height: 36, rotation: 0, description: avcC([SPS], [PPS]), samples: written })
  const v = (await demux(blob(file))).tracks[0]
  const shown = v.samples.map((s) => showsAt(v, s))
  written.forEach((s, i) => assert.ok(Math.abs(shown[i] - s.pts) <= 12, `frame ${order[i]}`))
})

test('the file says nothing about when or on what it was made', () => {
  const file = mux({ width: 640, height: 360, rotation: 0, description: avcC([SPS], [PPS]), samples: frames(30) }, { codec: 'aac', sampleRate: 48000, channels: 1, description: ASC, samples: sound(47) })
  const text = new TextDecoder('latin1').decode(file)
  // Every header's creation and modification times are zero.
  for (const type of ['mvhd', 'tkhd', 'mdhd']) {
    let at = -1
    while ((at = text.indexOf(type, at + 1)) >= 0) assert.deepEqual([...file.subarray(at + 8, at + 16)], [0, 0, 0, 0, 0, 0, 0, 0], `${type} times`)
  }
  for (const box of ['udta', 'meta', '©xyz', 'uuid', 'free']) assert.ok(!text.includes(box), `no ${box}`)
})

test('Opus sound is written with its dOps box', async () => {
  const head = new Uint8Array([...new TextEncoder().encode('OpusHead'), 1, 1, 0x38, 0x01, 0x80, 0xbb, 0, 0, 0, 0, 0])
  const opus = Array.from({ length: 50 }, (_, i) => ({ data: bytes(`opus${i}`, 60), pts: i * 20000, duration: 20000, key: true }))
  const file = mux({ width: 64, height: 36, rotation: 0, description: avcC([SPS], [PPS]), samples: frames(30) }, { codec: 'opus', sampleRate: 48000, channels: 1, description: head, samples: opus })
  const a = (await demux(blob(file))).tracks[1]
  assert.equal(a.codec, 'opus')
  assert.equal(a.timescale, 48000)
  const text = new TextDecoder('latin1').decode(file)
  const at = text.indexOf('dOps')
  assert.ok(at > 0)
  // Version 0, one channel, pre-skip 312 (0x0138, big-endian now), 48000 Hz.
  assert.deepEqual([...file.subarray(at + 4, at + 12)], [0, 1, 0x01, 0x38, 0, 0, 0xbb, 0x80])
})

test('HEVC codec names, as browsers expect them', () => {
  const hvcC = (profileByte: number, compat: number, level: number, constraint = 0xb0) => {
    const c = new Uint8Array(23)
    c[0] = 1
    c[1] = profileByte
    new DataView(c.buffer).setUint32(2, compat)
    c[6] = constraint
    c[12] = level
    return c
  }
  assert.equal(hevcCodec('hvc1', hvcC(0x01, 0x60000000, 93)), 'hvc1.1.6.L93.B0') // Main, 1080p
  assert.equal(hevcCodec('hvc1', hvcC(0x02, 0x20000000, 153)), 'hvc1.2.4.L153.B0') // Main 10, 4K (iPhone HDR)
  assert.equal(hevcCodec('hev1', hvcC(0x21, 0x40000000, 120, 0)), 'hev1.1.2.H120') // high tier, no constraints
})

test('AAC configurations give their rate and channels', () => {
  assert.deepEqual(audioConfig(new Uint8Array([0x12, 0x10])), { sampleRate: 44100, channels: 2 })
  assert.deepEqual(audioConfig(new Uint8Array([0x11, 0x90])), { sampleRate: 48000, channels: 2 })
  assert.deepEqual(audioConfig(ASC), { sampleRate: 48000, channels: 1 })
})

test('Annex B pictures are repackaged for MP4', () => {
  const idr = new Uint8Array([0x65, 0x88, 0x84, 0x00, 0x21])
  const p = new Uint8Array([0x41, 0x9a, 0x02])
  const first = new Uint8Array([0, 0, 0, 1, 0x09, 0xf0, 0, 0, 0, 1, ...SPS, 0, 0, 1, ...PPS, 0, 0, 1, ...idr])
  const second = new Uint8Array([0, 0, 0, 1, ...p])
  assert.ok(isAnnexB(first))
  assert.equal(splitAnnexB(first).length, 4)
  const out = fromAnnexB([first, second])
  assert.deepEqual(out.description, avcC([SPS], [PPS]))
  assert.deepEqual([...out.pictures[0]], [0, 0, 0, idr.length, ...idr], 'the delimiter and parameter sets go to the avcC')
  assert.deepEqual([...out.pictures[1]], [0, 0, 0, p.length, ...p])
  assert.throws(() => fromAnnexB([second]))
})

test('a video is made at most 360p, even sizes, keeping its shape', () => {
  assert.deepEqual(fitShort({ width: 1920, height: 1080 }, 360), { width: 640, height: 360 })
  assert.deepEqual(fitShort({ width: 1080, height: 1920 }, 360), { width: 360, height: 640 })
  assert.deepEqual(fitShort({ width: 3840, height: 2160 }, 240), { width: 426, height: 240 })
  assert.deepEqual(fitShort({ width: 320, height: 240 }, 360), { width: 320, height: 240 }, 'never larger')
  // A phone's tall screen recording and a wide video stay within 640 × 360 too.
  assert.deepEqual(fitShort({ width: 1179, height: 2556 }, 360), { width: 296, height: 640 })
  assert.deepEqual(fitShort({ width: 2560, height: 1080 }, 360), { width: 640, height: 270 })
})

test('a short video gets a good picture, and no more than it needs', () => {
  const plan = planVideo({ width: 1920, height: 1080 }, 5, 30, 1_950_000, 20_000, 47)!
  assert.equal(plan.width, 640)
  assert.equal(plan.fps, 30)
  assert.equal(plan.bitrate, Math.floor(640 * 360 * 30 * BPP_GOOD), 'it stops at a good quality instead of filling the space')
})

test('a 30-second video fits at 360p and 30 frames a second', () => {
  const plan = planVideo({ width: 1920, height: 1080 }, 30, 30, 1_950_000, 120_000, 47)!
  assert.deepEqual([plan.width, plan.height, plan.fps], [640, 360, 30])
  assert.ok(plan.bpp >= BPP_OK && plan.bpp < BPP_GOOD)
  assert.ok((plan.bitrate * 30) / 8 + 120_000 < 1_950_000)
})

test('longer videos step down the ladder, and too long ones are refused', () => {
  const at = (seconds: number) => planVideo({ width: 1920, height: 1080 }, seconds, 30, 1_950_000, seconds * 4000, 47)
  let lastPixels = Infinity
  for (const seconds of [30, 45, 60, 90, 120, 150]) {
    const plan = at(seconds)!
    assert.ok(plan, `${seconds} s fits`)
    const pixels = plan.width * plan.height * plan.fps
    assert.ok(pixels <= lastPixels, `${seconds} s is no bigger than shorter ones`)
    lastPixels = pixels
    assert.ok(LADDER.some((s) => s.fps === plan.fps && Math.min(plan.width, plan.height) === s.short))
  }
  assert.equal(at(600), undefined)
  assert.equal(planVideo({ width: 1920, height: 1080 }, 30, 30, 100_000, 120_000, 47), undefined, 'no room after the sound')
})

test('“Smallest”: aimed at its least, a video is made at the ladder’s last step, just above the floor', () => {
  const last = LADDER[LADDER.length - 1]
  for (const [src, seconds, fps, sound, soundFps] of [
    [{ width: 1920, height: 1080 }, 10, 30, 40_000, 50],
    [{ width: 1080, height: 1920 }, 75, 60, 290_000, 47],
    [{ width: 3840, height: 2160 }, 200, 30, 0, 0],
    [{ width: 1280, height: 720 }, 20, 10, 80_000, 50],
  ] as const) {
    const plan = planVideo(src, seconds, fps, leastTarget(src, seconds, fps, sound, soundFps), sound, soundFps)!
    assert.ok(plan, `${seconds} s`)
    assert.equal(Math.min(plan.width, plan.height), Math.min(last.short, src.width, src.height))
    assert.equal(plan.fps, Math.min(last.fps, fps), 'its own frame rate when that’s fewer')
    assert.ok(plan.bpp >= BPP_FLOOR && plan.bpp < BPP_FLOOR * 1.01, `${plan.bpp} just above ${BPP_FLOOR}`)
  }
  // The tray's estimate, with the sound guessed, is the same sum.
  const v = { width: 1920, height: 1080, seconds: 60, fps: 30, sound: true }
  assert.equal(leastBytes(v), leastTarget(v, 60, 30, Math.ceil((48_000 * 60) / 8), 47))
})

test('“Smallest”: every shape, frame rate and length plans at its least, rounding and tiny videos too (the review, 2026-10-26)', () => {
  // Before the fix, 4:3 sources at odd frame counts came a hair under BPP_FLOOR (640 × 480, 308 frames at
  // 30 a second), and videos under about 3,840 pixels found no room at the first step's index and gave up.
  const shapes = [[640, 480], [1440, 1080], [1080, 1440], [1920, 1080], [1080, 1350], [3840, 2160], [64, 48], [48, 48]]
  let plans = 0
  for (const [width, height] of shapes)
    for (const fps of [5, 10, 15, 24, 25, 30, 60])
      for (let frames = 1; frames <= 900; frames++) {
        const seconds = frames / fps
        for (const [sound, soundFps] of [[0, 0], [Math.ceil(seconds * 4000), 50]]) {
          const plan = planVideo({ width, height }, seconds, fps, leastTarget({ width, height }, seconds, fps, sound, soundFps), sound, soundFps)
          assert.ok(plan && plan.bpp >= BPP_FLOOR, `${width}×${height}, ${frames} frames at ${fps}`)
          plans++
        }
      }
  assert.equal(plans, shapes.length * 7 * 900 * 2)
})

test('a video already at a low frame rate keeps it', () => {
  assert.equal(planVideo({ width: 1280, height: 720 }, 20, 15, 1_950_000, 80_000, 47)!.fps, 15)
})

test('a retry aims under what overshot', () => {
  assert.ok(retryBitrate(500_000, 2_100_000, 1_900_000) < (500_000 * 1_900_000) / 2_100_000)
})

test('an encoder’s H.264 header is rebuilt clean, whatever form it came in', () => {
  const idr = new Uint8Array([0, 0, 0, 5, 0x65, 0x88, 0x84, 0x00, 0x21])
  const p = new Uint8Array([0, 0, 0, 3, 0x41, 0x9a, 0x02])
  const good = avcC([SPS], [PPS])
  assert.deepEqual(parseAvcC(good), { sps: [SPS], pps: [PPS], lengthSize: 4 })
  // As given: nothing to do.
  assert.deepEqual(forMp4(good, [idr, p]), { description: good, pictures: [idr, p], fixed: '' })
  // A header with junk after it, or the parameter sets in Annex B form: rebuilt from the parameter sets.
  assert.deepEqual(forMp4(new Uint8Array([...good, 9, 9]), [idr, p]).description, good)
  const annexB = new Uint8Array([0, 0, 0, 1, ...SPS, 0, 0, 0, 1, ...PPS])
  const fromB = forMp4(annexB, [idr, p])
  assert.deepEqual(fromB.description, good)
  assert.equal(fromB.fixed, 'avcC made from the parameter sets')
  // No header at all, but the parameter sets in the first picture.
  const inBand = new Uint8Array([0, 0, 0, SPS.length, ...SPS, 0, 0, 0, PPS.length, ...PPS, ...idr])
  assert.deepEqual(forMp4(undefined, [inBand, p]).description, good)
  // Pictures in Annex B form are repackaged, with the header's parameter sets.
  const b = forMp4(good, [new Uint8Array([0, 0, 1, 0x65, 0x88, 0x84, 0x00, 0x21])])
  assert.deepEqual(b.pictures[0], idr)
  assert.deepEqual(b.description, good)
  assert.throws(() => forMp4(undefined, [p]), 'no parameter sets anywhere')
})

test('AAC configurations are dug out of an esds, as Safari 26 hands them back', () => {
  // ES descriptor > decoder config (AAC) > decoder-specific info (the AudioSpecificConfig) > SL config.
  const es = [3, 25, 0, 1, 0, 4, 17, 0x40, 0x15, 0, 0, 0, 0, 0, 0x7d, 0, 0, 0, 0x7d, 0, 5, 2, 0x11, 0x88, 6, 1, 2]
  const body = [0, 0, 0, 0, ...es]
  const box = [0, 0, 0, 8 + body.length, 0x65, 0x73, 0x64, 0x73, ...body]
  for (const form of [ASC, new Uint8Array(es), new Uint8Array(body), new Uint8Array(box)]) assert.deepEqual(aacConfig(form), ASC)
  assert.equal(aacConfig(new Uint8Array([0, 0])), undefined, 'not a configuration at all')
})

test('sound at half the rate keeps voices and drops what would fold back', () => {
  const rate = 48000
  const tone = (hz: number) => Float32Array.from({ length: rate }, (_, i) => Math.sin((2 * Math.PI * hz * i) / rate))
  const level = (x: Float32Array) => Math.sqrt(x.subarray(100, x.length - 100).reduce((n, v) => n + v * v, 0) / (x.length - 200))
  const voice = halve(tone(1000))
  assert.equal(voice.length, rate / 2)
  assert.ok(Math.abs(level(voice) - Math.SQRT1_2) < 0.01, 'a 1 kHz tone comes through at the same level')
  assert.ok(level(halve(tone(18000))) < 0.01, 'an 18 kHz tone, above the new rate’s 12 kHz limit, is filtered out')
})

test('a codec’s configuration is copied out of any buffer, without cross-origin isolation too', () => {
  const backing = new Uint8Array([9, 1, 2, 3, 9])
  const view = backing.subarray(1, 4)
  const check = () => {
    for (const d of [view, new DataView(backing.buffer, 1, 3), backing.buffer.slice(1, 4)]) {
      const out = bytesOf(d)
      assert.deepEqual([...out], [1, 2, 3])
      assert.notEqual(out.buffer, backing.buffer, 'a copy, not the same memory')
    }
  }
  check()
  const shared = new SharedArrayBuffer(3)
  new Uint8Array(shared).set([1, 2, 3])
  assert.deepEqual([...bytesOf(shared)], [1, 2, 3])
  // A page that isn't cross-origin isolated has no SharedArrayBuffer at all.
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'SharedArrayBuffer')!
  delete (globalThis as { SharedArrayBuffer?: unknown }).SharedArrayBuffer
  try {
    check()
  } finally {
    Object.defineProperty(globalThis, 'SharedArrayBuffer', saved)
  }
})

test('an encoder that can’t get low enough: each step down is a smaller picture, then fewer frames, then none', () => {
  const src = { width: 1920, height: 1080 }
  const steps: string[] = []
  let at: { width: number; height: number; fps: number } | undefined = { width: 640, height: 360, fps: 30 }
  while (at) {
    steps.push(`${at.width}x${at.height}@${at.fps}`)
    at = smallerStep(at, src, 30)
  }
  assert.deepEqual(steps, ['640x360@30', '512x288@30', '426x240@30', '320x180@30', '320x180@15'])
  // A video filmed at 24 frames keeps them; a small one never grows.
  assert.deepEqual(smallerStep({ width: 640, height: 360, fps: 24 }, src, 24), { width: 512, height: 288, fps: 24 })
  assert.equal(smallerStep({ width: 320, height: 180, fps: 15 }, src, 30), undefined)
})
