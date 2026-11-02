// "Make audio smaller to fit" (2026-10-25): the sizing rules, reading each kind
// of sound file's length, the sample-rate change, the M4A written, the words,
// and the composer's wiring. The decoding and encoding need a browser
// (WebCodecs); they were checked in one, and the tray's behaviour too.
// Run from the repo root: npm --prefix web test
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { AUDIO_FLOOR, AUDIO_GOOD, LEEWAY, MONO_GOOD, STEREO_FROM, audioGoodBytes, audioLeastBytes, audioOverhead, audioWeight, levels, planAt, planAudio } from '../src/audio/plan.ts'
import { audioInfo, bytesReader, findWav, readFlac, readOgg, scanMp3, soundKind, wavInfo, wavPlanes } from '../src/audio/read.ts'
import { OUTLINE_MAX_SECONDS, Resampler, mix } from '../src/audio/shrink.ts'
import { allocate, copyName, weight } from '../src/shrink/plan.ts'
import * as copy from '../src/shrinkCopy.ts'
import { demux } from '../src/video/demux.ts'
import { mux } from '../src/video/mux.ts'
import { PHOTO_BYTES_PER_PIXEL } from '../src/video/plan.ts'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const tray = read('../src/tray.ts') + read('../src/prep/list.ts') // the screen, and the file list it draws
const fn = (name: string) => {
  const start = tray.indexOf(`function ${name}(`)
  assert.ok(start >= 0, name)
  return tray.slice(start, tray.indexOf('\n  }\n', start))
}
const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0))
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}
/** About the space one file has beside the link's own layers and the room kept for a message. */
const SPACE = 1_999_900 - 8_000 - 100

test('audio fills its share up to a good quality, in stereo down to 40 kbit/s, then mono, down to 16', () => {
  const at = (minutes: number, channels = 2) => planAudio({ seconds: minutes * 60, channels }, SPACE)
  // Three minutes: near the top. Four: about 64 kbit/s stereo.
  assert.ok(at(3)!.bitrate > 80_000 && at(3)!.channels === 2)
  const four = at(4)!
  assert.ok(four.bitrate >= 62_000 && four.bitrate <= 66_000, `${four.bitrate}`)
  assert.equal(four.channels, 2)
  // A short one stops at a good quality instead of filling the space.
  assert.equal(at(1)!.bitrate, AUDIO_GOOD)
  assert.equal(at(1, 1)!.bitrate, MONO_GOOD, 'a mono recording needs less')
  // Six minutes stays stereo; seven goes mono.
  assert.equal(at(6)!.channels, 2)
  assert.equal(at(7)!.channels, 1)
  assert.ok(at(7)!.bitrate < STEREO_FROM)
  // About fifteen minutes at the floor, alone; sixteen is too long.
  assert.ok(at(15)!.bitrate >= AUDIO_FLOOR)
  assert.equal(at(16), undefined)
  assert.equal(planAudio({ seconds: 0, channels: 2 }, SPACE), undefined)
  // What a plan asks for really fits: the sound and its index.
  for (const minutes of [2, 4, 5, 8, 15]) {
    const p = at(minutes)!
    assert.ok((p.bitrate * minutes * 60) / 8 + audioOverhead(minutes * 60) <= SPACE, `${minutes} min`)
  }
  assert.deepEqual(planAt({ seconds: 60, channels: 2 }, 39_999), { bitrate: 39_999, channels: 1 })
  assert.equal(planAt({ seconds: 60, channels: 2 }, AUDIO_FLOOR - 1), undefined)
})

test('“Smallest”: at its least, every length plans at the floor, decoded a little longer too (the review, 2026-10-26)', () => {
  // Before the fix, exactly audioLeastBytes could come out at 15,999.99… bits a second (an M4A of
  // 8,439 AAC frames), and a decoder counting the sound longer than its header put it under.
  const lengths = [
    ...Array.from({ length: 12_000 }, (_, i) => ((i + 1) * 1024) / 48_000), // AAC at 48 kHz
    ...Array.from({ length: 6_000 }, (_, i) => (i + 1) / 10), // tenths of a second
    ...Array.from({ length: 3_000 }, (_, i) => ((i + 1) * 1152) / 44_100), // MP3 frames at 44.1 kHz
  ]
  for (const seconds of lengths)
    for (const channels of [1, 2]) {
      const target = audioLeastBytes({ seconds, channels })
      for (const longer of [0, LEEWAY / 2, LEEWAY]) {
        const plan = planAudio({ seconds: seconds + longer, channels }, target)
        assert.ok(plan && plan.bitrate >= AUDIO_FLOOR, `${seconds} s, decoded ${longer} s longer, ${channels} ch`)
      }
    }
  // Still about the floor for anything but the shortest (what the About page says).
  assert.ok((planAudio({ seconds: 30, channels: 2 }, audioLeastBytes({ seconds: 30, channels: 2 }))!.bitrate) < AUDIO_FLOOR * 1.01)
})

test('beside photos audio gives up some of the space, never below its floor; too much is said at once', () => {
  const audio = { seconds: 240, channels: 2 }
  const photo = { full: 1_200_000, least: 150_000, weight: weight({ width: 4032, height: 3024 }) }
  const share = { full: audioGoodBytes(audio), least: audioLeastBytes(audio), weight: audioWeight(audio, PHOTO_BYTES_PER_PIXEL) }
  const three = allocate(SPACE, [share, photo, photo, photo])
  assert.ok(three.fits)
  if (!three.fits) return
  const audioBytes = three.sizes[0]
  assert.ok(audioBytes >= audioLeastBytes(audio))
  const plan = planAudio(audio, audioBytes)!
  assert.equal(plan.channels, 2, 'four minutes beside three photos stays stereo')
  assert.ok(plan.bitrate > STEREO_FROM && plan.bitrate < 64_000, `${plan.bitrate}`)
  for (const p of three.sizes.slice(1)) assert.ok(p >= 150_000)
  // Eleven photos at their smallest and four minutes at the floor are too much.
  assert.equal(allocate(SPACE, [share, ...Array(12).fill(photo)]).fits, false)
})

test('a sound file’s kind from its first bytes', () => {
  const ftyp = (brand: string) => concat(new Uint8Array([0, 0, 0, 24]), ascii('ftyp' + brand), new Uint8Array(12))
  assert.equal(soundKind(ftyp('M4A ')), 'm4a')
  assert.equal(soundKind(ftyp('isom')), 'mp4', 'perhaps sound alone: its tracks tell')
  assert.equal(soundKind(ftyp('qt  ')), null, 'a MOV is a video')
  assert.equal(soundKind(ftyp('heic')), null)
  assert.equal(soundKind(concat(ascii('RIFF'), new Uint8Array(4), ascii('WAVE'), new Uint8Array(8))), 'wav')
  assert.equal(soundKind(concat(ascii('OggS'), new Uint8Array(30))), 'ogg')
  assert.equal(soundKind(concat(ascii('fLaC'), new Uint8Array(30))), 'flac')
  assert.equal(soundKind(mp3({ frames: 3 })), 'mp3')
  assert.equal(soundKind(concat(id3(300), mp3({ frames: 3 }))), 'mp3', 'after its tags')
  assert.equal(soundKind(ascii('hello, this is not a sound file at all')), null)
})

/** An ID3v2 tag of this many bytes of frames. */
function id3(size: number) {
  return concat(ascii('ID3'), new Uint8Array([4, 0, 0, (size >> 21) & 127, (size >> 14) & 127, (size >> 7) & 127, size & 127]), new Uint8Array(size))
}

/** MPEG-1 layer III frames at 128 kbit/s, 44.1 kHz (417 bytes each), or 48 kHz (384), joint stereo or mono, the first optionally a Xing "Info" frame with a LAME tag. */
function mp3(o: { frames: number; mono?: boolean; at48?: boolean; lame?: { delay: number; padding: number } }) {
  const frame = () => {
    const f = new Uint8Array(o.at48 ? 384 : 417)
    f.set([0xff, 0xfb, o.at48 ? 0x94 : 0x90, o.mono ? 0xc0 : 0x40])
    return f
  }
  const frames: Uint8Array[] = []
  if (o.lame) {
    const f = frame()
    const xing = 4 + (o.mono ? 17 : 32)
    f.set(ascii('Info'), xing)
    f.set([0, 0, 0, 15], xing + 4) // frames, bytes, table of contents and quality follow
    const lame = xing + 8 + 4 + 4 + 100 + 4
    f.set(ascii('LAME3.100'), lame)
    f.set([o.lame.delay >> 4, ((o.lame.delay & 15) << 4) | (o.lame.padding >> 8), o.lame.padding & 255], lame + 21)
    frames.push(f)
  }
  for (let i = 0; i < o.frames; i++) frames.push(frame())
  return concat(...frames)
}

test('an MP3: every frame after its tags, the Xing frame left out, and the LAME tag’s delay and padding cut', () => {
  const plain = scanMp3(concat(id3(1000), mp3({ frames: 100 }), ascii('TAG'), new Uint8Array(125)))
  assert.equal(plain.frames.length, 100, 'an ID3v1 tag after the end isn’t a frame')
  assert.equal(plain.sampleRate, 44100)
  assert.equal(plain.channels, 2)
  assert.equal(plain.perFrame, 1152)
  assert.equal(plain.frames[0].offset, 1010)
  assert.deepEqual([plain.skipStart, plain.skipEnd], [0, 0])
  const gapless = scanMp3(mp3({ frames: 100, mono: true, lame: { delay: 576, padding: 1000 } }))
  assert.equal(gapless.frames.length, 100, 'the Info frame holds no sound')
  assert.equal(gapless.channels, 1)
  assert.equal(gapless.skipStart, 576 + 529)
  assert.equal(gapless.skipEnd, 1000 - 529)
  assert.throws(() => scanMp3(ascii('not an mp3 file, only words')))
  assert.equal(plain.bytes, 100 * 417, 'its sound alone: no tags')
  assert.ok(Math.abs(plain.seconds - (100 * 1152) / 44100) < 1e-9)
  assert.equal(plain.mixed, false)
})

test('an MP3 with something between its frames is read to its end (the review: it was cut short)', () => {
  // Stray bytes where two files were joined, then a tag in the middle with a "picture" that looks like frames.
  const fake = new Uint8Array(2000)
  for (let i = 0; i < fake.length; i += 417) fake.set([0xff, 0xfb, 0x90, 0x40], i)
  const joined = concat(mp3({ frames: 100 }), new Uint8Array(50).fill(0x20), mp3({ frames: 1000 }), id3(fake.length), mp3({ frames: 10 }))
  joined.set(fake, joined.length - 10 * 417 - fake.length)
  const m = scanMp3(joined)
  assert.equal(m.frames.length, 1110)
  assert.equal(m.mixed, false)
  assert.ok(Math.abs(m.seconds - (1110 * 1152) / 44100) < 1e-9)
  // Another file at another rate after it: its length counted at its own rate, and decoded on the page (mixed).
  const two = scanMp3(concat(mp3({ frames: 100 }), mp3({ frames: 100, at48: true })))
  assert.equal(two.frames.length, 200)
  assert.equal(two.mixed, true)
  assert.ok(Math.abs(two.seconds - (100 * 1152) / 44100 - (100 * 1152) / 48000) < 1e-9)
})

/** A WAV of these samples (interleaved, already in its format's bytes). */
function wav(o: { format: number; bits: number; channels: number; rate: number; data: Uint8Array; extensible?: boolean; size?: number }) {
  const fmt = new Uint8Array(o.extensible ? 40 : 16)
  const v = new DataView(fmt.buffer)
  v.setUint16(0, o.extensible ? 0xfffe : o.format, true)
  v.setUint16(2, o.channels, true)
  v.setUint32(4, o.rate, true)
  v.setUint32(8, (o.rate * o.channels * o.bits) / 8, true)
  v.setUint16(12, (o.channels * o.bits) / 8, true)
  v.setUint16(14, o.bits, true)
  if (o.extensible) {
    v.setUint16(16, 22, true)
    v.setUint16(24, o.format, true)
  }
  const head = new Uint8Array(8)
  new DataView(head.buffer).setUint32(4, fmt.length, true)
  head.set(ascii('fmt '))
  const data = new Uint8Array(8)
  data.set(ascii('data'))
  new DataView(data.buffer).setUint32(4, o.size ?? o.data.length, true)
  return concat(ascii('RIFF'), new Uint8Array(4), ascii('WAVE'), head, fmt, data, o.data)
}

test('a WAV: its format and samples, 8, 16 and 24 bits and floating point, one never finished, and chunks wherever they are', async () => {
  const s16 = new Uint8Array(new Int16Array([16384, -16384, 32767, -32768]).buffer)
  const read = (b: Uint8Array) => findWav(bytesReader(b), b.length)
  const w = await read(wav({ format: 1, bits: 16, channels: 2, rate: 8000, data: s16 }))
  assert.deepEqual({ ...w, offset: 0 }, { format: 1, bits: 16, channels: 2, sampleRate: 8000, offset: 0, bytes: 8 })
  const planes = wavPlanes(w, s16)
  assert.deepEqual([...planes[0]], [0.5, 32767 / 32768])
  assert.deepEqual([...planes[1]], [-0.5, -1])
  const s24 = new Uint8Array([0, 0, 0x40, 0, 0, 0xc0]) // +0.5, -0.5
  assert.deepEqual([...wavPlanes(await read(wav({ format: 1, bits: 24, channels: 1, rate: 8000, data: s24, extensible: true })), s24)[0]], [0.5, -0.5])
  const u8 = new Uint8Array([128, 192, 64])
  assert.deepEqual([...wavPlanes(await read(wav({ format: 1, bits: 8, channels: 1, rate: 8000, data: u8 })), u8)[0]], [0, 0.5, -0.5])
  const f32 = new Uint8Array(new Float32Array([0.25, -0.75]).buffer)
  assert.deepEqual([...wavPlanes(await read(wav({ format: 3, bits: 32, channels: 1, rate: 8000, data: f32 })), f32)[0]], [0.25, -0.75])
  // Recorded and never finished (a size of 0): the samples run to the end of the file.
  assert.equal((await read(wav({ format: 1, bits: 16, channels: 1, rate: 8000, data: s16, size: 0 }))).bytes, 8)
  await assert.rejects(read(wav({ format: 85, bits: 16, channels: 1, rate: 8000, data: s16 })), /format 85/)
  // A chunk of 2 MB before the samples (the review: the worker read only the first 1 MB).
  const plainWav = wav({ format: 1, bits: 16, channels: 2, rate: 8000, data: s16 })
  const pad = concat(ascii('LIST'), new Uint8Array([0, 0, 0x20, 0]), new Uint8Array(0x200000))
  const padded = concat(plainWav.subarray(0, 12), pad, plainWav.subarray(12))
  const far = await read(padded)
  assert.equal(far.offset, 12 + pad.length + 8 + 16 + 8)
  assert.equal(far.bytes, 8)
  // From a file, reading only its header: what the composer does for a long WAV, never read whole.
  const info = await wavInfo(new Blob([padded as BlobPart]))
  assert.deepEqual(info, { kind: 'wav', seconds: 2 / 8000, sampleRate: 8000, channels: 2, bytes: 8 })
  assert.equal(await wavInfo(new Blob([mp3({ frames: 3 }) as BlobPart])), null)
})

test('a FLAC’s and an Ogg file’s length, from their headers and the last page', () => {
  // STREAMINFO: 44.1 kHz, 2 channels, 16 bits, 441,000 samples (10 s).
  const info = new Uint8Array(34)
  let bits = (BigInt(44100) << 44n) | (1n << 41n) | (15n << 36n) | 441000n
  for (let i = 17; i >= 10; i--, bits >>= 8n) info[i] = Number(bits & 255n)
  const flac = concat(ascii('fLaC'), new Uint8Array([0x80, 0, 0, 34]), info)
  assert.deepEqual(readFlac(flac), { sampleRate: 44100, channels: 2, seconds: 10 })
  assert.deepEqual(readFlac(concat(id3(50), flac)), { sampleRate: 44100, channels: 2, seconds: 10 }, 'after an ID3 tag')
  // Ogg Opus: OpusHead (2 channels, 312 samples to skip, made from 44.1 kHz), and a last page 10 s on.
  const page = (granule: number, packet: Uint8Array) => {
    const h = new Uint8Array(27)
    h.set(ascii('OggS'))
    const v = new DataView(h.buffer)
    v.setUint32(6, granule % 2 ** 32, true)
    v.setUint32(10, Math.floor(granule / 2 ** 32), true)
    h[26] = 1
    return concat(h, new Uint8Array([packet.length]), packet)
  }
  const head = concat(ascii('OpusHead'), new Uint8Array([1, 2, 312 & 255, 312 >> 8, 0x44, 0xac, 0, 0, 0, 0, 0]))
  const ogg = concat(page(0, head), page(0, new Uint8Array(20)), page(480_000 + 312, new Uint8Array(40)))
  assert.deepEqual(readOgg(ogg), { sampleRate: 44100, channels: 2, seconds: 10 })
  assert.throws(() => readOgg(concat(page(0, ascii('Theora video')), page(1000, new Uint8Array(4)))), /Opus or Vorbis/)
})

/** Opus as an encoder gives it: its header (2 channels, 312 to skip, from 48 kHz) and 10 s of 20 ms pieces. */
function opusSound() {
  const description = concat(ascii('OpusHead'), new Uint8Array([1, 2, 312 & 255, 312 >> 8, 0x80, 0xbb, 0, 0, 0, 0, 0]))
  const samples = Array.from({ length: 500 }, (_, i) => ({ data: new Uint8Array(160).fill(0x55), pts: i * 20_000, duration: 20_000, key: true }))
  return { codec: 'opus' as const, sampleRate: 48000, channels: 2, description, samples }
}

test('audio made smaller is an M4A of its own: nothing about the original, no dates, Opus’s warm-up skipped', async () => {
  const file = mux(null, opusSound())
  const text = new TextDecoder('latin1').decode(file)
  assert.equal(text.slice(4, 12), 'ftypM4A ')
  assert.ok(!text.includes('vide'), 'no picture track')
  assert.ok(text.includes('soun') && text.includes('Opus') && text.includes('dOps') && text.includes('elst'))
  // No tags of any kind, and every time field zero (mvhd's created and modified).
  for (const tag of ['udta', 'meta', 'ilst', '©', 'ID3', 'TAG']) assert.ok(!text.includes(tag), tag)
  const mvhd = text.indexOf('mvhd')
  assert.deepEqual([...file.subarray(mvhd + 8, mvhd + 16)], [0, 0, 0, 0, 0, 0, 0, 0])
  // Read back as a sound file: its length starts after the 312 samples Opus skips.
  const info = await audioInfo(file)
  assert.equal(info?.kind, 'm4a')
  assert.equal(info?.channels, 2)
  assert.ok(Math.abs(info!.seconds - (480_000 - 312) / 48_000) < 1e-6, `${info?.seconds}`)
  const movie = await demux(new Blob([file as BlobPart]))
  const track = movie.tracks[0]
  assert.equal(track.codec, 'opus')
  assert.equal(track.mediaStart, 312)
  assert.equal(track.samples.length, 500)
  // A video's sound beside its pictures is written as before: no edit list of its own.
  assert.equal(copyName('Interview.mp3', 'audio/mp4'), 'Interview.m4a')
})

test('sound changed from 44.1 to 48 kHz keeps its pitch and loudness, whatever pieces it comes in', () => {
  const inRate = 44100
  const outRate = 48000
  const tone = new Float32Array(inRate).map((_, i) => Math.sin((2 * Math.PI * 1000 * i) / inRate))
  const whole = new Resampler(inRate, outRate, 1)
  const a = [...whole.push([tone])[0], ...whole.flush()[0]]
  const pieces = new Resampler(inRate, outRate, 1)
  const b: number[] = []
  for (let i = 0, n = 1; i < tone.length; i += n, n = (n * 7 + 3) % 4001 || 1) b.push(...pieces.push([tone.subarray(i, i + n)])[0])
  b.push(...pieces.flush()[0])
  assert.equal(b.length, a.length)
  for (let i = 0; i < a.length; i++) assert.ok(Math.abs(a[i] - b[i]) < 1e-6, `sample ${i}`)
  assert.ok(a.length >= outRate && a.length <= outRate + 40, `${a.length}`)
  let worst = 0
  for (let j = 200; j < outRate - 200; j++) worst = Math.max(worst, Math.abs(a[j] - Math.sin((2 * Math.PI * 1000 * j) / outRate)))
  assert.ok(worst < 5e-3, `off by ${worst}`)
  // Down to 24 kHz, an 18 kHz tone (above the new rate's highest, 12 kHz) is filtered away, not folded back.
  const high = new Float32Array(48000).map((_, i) => Math.sin((2 * Math.PI * 18000 * i) / 48000))
  const down = new Resampler(48000, 24000, 1)
  const out = [...down.push([high])[0], ...down.flush()[0]].slice(100, -100)
  const rms = Math.sqrt(out.reduce((n, v) => n + v * v, 0) / out.length)
  assert.ok(rms < 0.01, `rms ${rms}`)
})

test('mixing: mono is the channels’ average; a mono recording goes as the same in both sides of stereo', () => {
  const l = Float32Array.of(1, 0.5)
  const r = Float32Array.of(0, -0.5)
  assert.deepEqual([...mix([l, r], 1)[0]], [0.5, 0])
  assert.deepEqual(mix([l], 2), [l, l])
  assert.deepEqual(mix([l, r, l], 2), [l, r], 'surround keeps its front left and right')
})

test('its outline: each stretch’s loudness, the loudest 1', () => {
  assert.deepEqual(levels(Float64Array.of(4, 1, 0), Float64Array.of(1, 1, 0)), [1, 0.5, 0])
})

test('what the sender reads about audio', () => {
  const plain = (s: string) => s.replace(/ /g, ' ')
  assert.equal(copy.whatSmaller({ audio: 1 }), 'your audio file')
  assert.equal(copy.whatSmaller({ photos: 2, audio: 1 }), 'your photos and audio file')
  assert.equal(copy.whatSmaller({ photos: 1, audio: 1 }, { photos: 3, audio: 1 }), '1 of your photos and your audio file')
  assert.equal(copy.AUTO_MIXED({ audio: 2 }), 'Slynk made your audio files smaller to fit.')
  assert.equal(copy.OFFER_MIXED({ audio: 1 }), 'Slynk can make your audio file smaller to help it fit. Only the smaller version is sent.')
  assert.equal(copy.NO_FIT_VIDEO({ audio: 1 }), 'This audio file is too long to fit, even made smaller.')
  assert.equal(copy.NO_FIT_VIDEO({ photos: 3, audio: 1 }), 'Too much to fit, even made smaller. Remove the audio file or some photos.')
  assert.equal(copy.NO_FIT_VIDEO({ videos: 1, audio: 2 }), 'Too much to fit, even made smaller. Remove the video or an audio file.')
  assert.equal(copy.WORKING_AUDIO(0.4, 1, 1), 'Making your audio file smaller… 40%')
  assert.equal(copy.WORKING_AUDIO(1, 2, 3), 'Making your audio files smaller… 2 of 3, 99%')
  assert.equal(plain(copy.AUDIO_NOTE(64_412, 2, 320_000)), 'Made smaller: 64 kbit/s stereo (was 320 kbit/s)')
  assert.equal(plain(copy.AUDIO_NOTE(31_000, 1)), 'Made smaller: 31 kbit/s mono')
  assert.equal(plain(copy.VIEW_ABOUT_AUDIO(238.4, '1.95 MB', 'copy', { bitrate: 64_000, channels: 2 })), 'As it will be sent: made smaller, 3:58, 64 kbit/s stereo, 1.95 MB')
  assert.equal(copy.VIEW_ABOUT_AUDIO(161, '1.9 MB', 'full'), 'As it will be sent: full quality, 2:41, 1.9 MB')
  assert.equal(copy.VIEW_ABOUT_AUDIO(Infinity, '3.8 MB', 'received'), 'Received: 3.8 MB', 'no length when the player doesn’t know it')
  assert.equal(copy.clock(59.6), '1:00')
  assert.equal(copy.AUDIO_PROBLEM.tight, copy.VIDEO_PROBLEM.tight)
  // "audio", never "song": it may be any recording.
  for (const words of [read('../src/shrinkCopy.ts'), read('../src/ui/cleaning.ts')]) assert.doesNotMatch(words, /'[^'\n]*\bsongs?\b[^'\n]*'/i)
})

test('the composer: audio shares the space, made after documents and before videos, again when its share changes enough', () => {
  assert.match(tray, /const shareable = \(row: Row\) => copyable\(row\) \|\| shrinkable\(row\) \|\| docable\(row\) \|\| audioShareable\(row\)/)
  assert.match(tray, /canShrinkAudio\(row\.audio\) === 'yes' &&\n\s+!row\.audioRefused &&\n\s+\(!row\.audioProblem \|\| row\.audioProblem === 'tight'\)/)
  const run = fn('makeSmallerCopies')
  assert.ok(run.indexOf('makeDocument(') < run.indexOf('makeAudio(') && run.indexOf('makeAudio(') < run.indexOf('makeVideo('))
  assert.match(run, /const audioToMake = shared\.filter\(\(row\) => row\.audio && target\(row\) !== null && \(!row\.acopy \|\| remakeAudio\(row, target\(row\)!\)\)\)/)
  // Made again when it no longer fits, or its share grew by a quarter while it's below a good quality.
  assert.match(tray, /return made\.data\.length > target \|\| \(target >= made\.target \* 1\.25 && made\.bitrate < goodRate\(row\.audio!\) \* 0\.95\)/)
  // Never kept like a video: it's planned with the rest every time.
  assert.match(tray, /const kept = \(row: Row\) => !!row\.video && !!row\.vcopy && !row\.useFull/)
  // Room for a message to grow beside it without making it again.
  assert.match(tray, /const slack = !bare && items\.some\(\(r\) => r\.video \|\| r\.audio\) \? VIDEO_SLACK : 0/)
  // A browser whose decoder won't take it: decoded on the page instead, then encoded in the worker.
  const make = fn('makeAudio')
  assert.match(make, /if \(!\/\^cant-decode\/\.test\(errorText\(e\)\) \|\| stop\.signal\.aborted\) throw e\n\s+r = await run\(await decodedHere\(\)\)/)
  assert.match(make, /keepOutline\(r\.data, r\.report\.peaks\)/)
  // A try that failed takes its older version with it, so nothing lingers over the limit.
  assert.match(make, /row\.audioProblem = problem\n\s+if \(problem === 'browser'\) row\.audioRefused = true\n[^\n]*\n\s+row\.acopy = undefined/)
  // A browser that turned out to have no Opus encoder says so, and isn't asked again (the review: the verdict was erased).
  assert.match(fn('audioLimits'), /canShrinkAudio\(a\) !== 'yes' \|\| row\.audioRefused \? 'browser'/)
  // Only its own job and bar are cleared: a newer run may be making it already (the review).
  assert.match(make, /if \(job\?\.stop === stop\) job = undefined\n\s+if \(job\?\.row !== row\) row\.amaking = undefined/)
  // Decoding on the page, which can't be stopped, never twice at once, and not handed on once stopped.
  assert.match(make, /await decodingHere\n\s+if \(stop\.signal\.aborted\) throw new Error\('stopped'\)/)
  // The original's bitrate from its sound alone (the review: cover art made it look higher).
  assert.match(make, /was: \(a\.bytes \* 8\) \/ a\.seconds/)
  const problem = fn('audioProblem')
  assert.match(problem, /if \(\/too-long\/\.test\(why\)\) return 'tight'/)
  assert.match(problem, /if \(\/cant-decode\/\.test\(why\)\) return 'open'/)
  // Read whole like a document (a few minutes of WAV is over 25 MB), and its row says what it is made into.
  assert.match(tray, /looksLikeDoc\(row\.file\) \|\| looksLikeAudio\(row\.file\) \|\| looksLikeZip\(row\.file\) \? HOPELESS_DOC : HOPELESS_SIZE/)
  assert.match(tray, /row\.acopy \? 'audio\/mp4'/)
  // Something made anew needs no note about cleaning: an M4A can't be cleaned, but its smaller version has nothing to clean.
  assert.match(tray, /note\.textContent = fresh \? '' : cleaningNote\(told, choice\)/)
})

test('every visit fetches the same files: audio is made in the video worker, and the page holds no encoder', () => {
  assert.match(read('../src/video/shrinkWorker.ts'), /import \{ CantDecode, outlineOf, shrinkAudio, type AudioInput, type AudioProgress, type AudioReport \} from '\.\.\/audio\/shrink\.ts'/)
  const page = read('../src/audio/page.ts')
  assert.doesNotMatch(page, /from '\.\/shrink/, 'the encoder stays in the worker, out of the page’s code')
  for (const f of ['plan.ts', 'read.ts', 'shrink.ts', 'page.ts']) {
    const src = read(`../src/audio/${f}`)
    assert.doesNotMatch(src, /new Worker|import\(|localStorage|indexedDB|fetch\(/, f)
  }
  // The viewer plays it from a blob: address, let go of as it closes, as a video's is.
  const view = read('../src/ui/photoView.ts')
  assert.match(view, /function stopAudio\(\) \{\n[^}]*URL\.revokeObjectURL\(hearing\.url\)/)
})

test('an outline is never decoded whole on the page: in the worker, a run at a time, capped (the review: a small file can hold hours)', () => {
  const page = read('../src/audio/page.ts')
  assert.doesNotMatch(page, /decodeAt\(data, 8000\)/)
  assert.match(page, /if \(!info \|\| !STREAMED\.includes\(info\.kind\) \|\| !\(info\.seconds <= OUTLINE_SECONDS\)\) return null\n\s+return outlineInWorker\(/)
  // The worker stops at its own limit whatever the header says.
  const shrink = read('../src/audio/shrink.ts')
  assert.match(shrink, /if \(seen \+ n > limit\) throw new AudioError\('too-long'\)/)
  assert.equal(OUTLINE_MAX_SECONDS, 20 * 60)
  // Unknown outlines are plain bars, an icon; the viewer opens at once and fills in the outline later.
  const view = read('../src/ui/photoView.ts')
  assert.match(view, /const outline = peaks \?\? \(await audioOutline\(data\)\) \?\? PLAIN_OUTLINE/)
  assert.doesNotMatch(view, /Promise\.all\(\[ready/)
  // One opened meanwhile says for itself whether it plays: no "can't play" for the one it replaced.
  assert.match(view, /const ok = await ready\n\s+if \(hearing !== mine\) return true/)
  // Any rate the encoder refuses goes at 48 kHz, its own rates too (the review).
  assert.match(shrink, /if \(!\(await takes\(config\(rate\)\)\)\) use = 48000/)
})

test('the About page’s media answer says what the plan does', () => {
  const about = read('../about/index.html').replace(/\s+/g, ' ')
  assert.match(about, /from 96 kbit\/s in stereo for up to about 2½ minutes to mono from about 6½ minutes, and up to about 15 minutes fit/)
  // "Smallest" (2026-10-26): the floor.
  assert.match(about, /With “Smallest” it goes at about 16 kbit\/s in mono, fine for speech but flat for music\./)
  assert.equal(AUDIO_FLOOR, 16_000)
  const at = (seconds: number) => planAudio({ seconds, channels: 2 }, SPACE)
  assert.equal(at(150)!.bitrate, AUDIO_GOOD)
  assert.ok(Math.abs(at(240)!.bitrate - 64_000) < 2_000)
  assert.equal(at(375)!.channels, 2)
  assert.equal(at(395)!.channels, 1)
  assert.ok(at(890) && !at(930))
  // The same cleaning as everything made anew: a new file, so none of the original's tags.
  assert.match(about, /Its tags, such as the title, artist and cover art, don’t go with it\./)
  assert.match(about, /Audio needs the same, and on an iPhone, iPad or Mac, Safari 26 or later\./)
})

test('a long WAV, up to 200 MB, is made smaller from its file, never read whole', () => {
  assert.match(tray, /const HOPELESS_WAV = 200_000_000/)
  const place = fn('place')
  assert.match(place, /if \(row\.file\.size > HOPELESS_SIZE && row\.file\.size <= HOPELESS_WAV\) \{\n\s+const a = await wavInfo\(row\.file\)/)
  // Before anything is read, as a video's check is; and like a video, only a smaller version can go.
  assert.ok(place.indexOf('wavInfo(') < place.indexOf('row.read = true'))
  assert.match(place, /row\.audio = a\n\s+row\.state = 'video'/)
  assert.match(place, /row\.audioProblem = canShrinkAudio\(a\) !== 'yes' \? 'browser' : least > o\.planLimit\(\) \? 'long' : undefined/)
  assert.match(tray, /\(row\.state === 'video' \|\| !!row\.acopy \|\| \(!!row\.sending && !!row\.data && !!bytesToSend\(row\.data, row\.strip, row\)\)\)/)
  // It needs no page decoding (a WAV is read as it is), and says so if it ever would.
  assert.match(fn('makeAudio'), /if \(!data\) throw new Error\('cant-decode: never read'\)/)
  const about = read('../about/index.html').replace(/\s+/g, ' ')
  assert.match(about, /up to 60 MB, or 200 MB for a WAV recording\./)
})

test('the bar follows the work: said on a clock from what the encoder gave back, and creeping while the page decodes (seen on an iPhone)', () => {
  const shrink = read('../src/audio/shrink.ts')
  // Said only when it has moved, so a stalled codec still goes quiet and the page's watchdog ends it (the review).
  assert.match(shrink, /const clock = setInterval\(\(\) => \{\n\s+const done = out\.progress\(\)\n\s+if \(done <= said\) return/)
  assert.match(shrink, /clearInterval\(clock\)/)
  assert.match(shrink, /return Math\.max\(encoded, 0\.5 \* handed\)/)
  // A stop is seen even while a codec's queue doesn't move.
  assert.match(shrink, /if \(this\.signal\?\.aborted\) throw new AudioError\('stopped'\)/)
  assert.match(read('../src/audio/read.ts'), /while \(!failure && decoder\.decodeQueueSize > 20\) \{\n\s+stopped\(o\.signal\)/)
  assert.match(shrink, /this\.encodedUs = Math\.max\(this\.encodedUs, chunk\.timestamp \+ \(chunk\.duration \?\? 0\)\)/)
  const make = fn('makeAudio')
  assert.match(make, /const creep = setInterval\(\(\) => progress\(PAGE_DECODE_SHARE \* \(1 - Math\.exp\(-\(Date\.now\(\) - started\) \/ pace\)\)\), 200\)/)
  assert.match(make, /finally \{\n\s+clearInterval\(creep\)\n\s+\}/)
  assert.match(make, /progress\(base \+ \(1 - base\) \* share\(p\)\)/)
  // Never back: each new value only moves it on; and a stopped run's says nothing (the review).
  assert.match(make, /if \(stop\.signal\.aborted\) return[^\n]*\n\s+row\.amaking = Math\.max\(row\.amaking \?\? 0, Math\.min\(0\.99, done\)\)/)
})

test('each audio preview gets a fresh player: Safari on an iPhone kept showing Pause on the next file', () => {
  const view = read('../src/ui/photoView.ts')
  assert.match(view, /function freshPlayer\(\): HTMLAudioElement \{[\s\S]*?audio\.addEventListener\('play', \(\) => followWave\(\)\)\n\s+\$\('pv-audio'\)\.replaceWith\(audio\)/)
  assert.match(view, /shown = undefined\n\s+const audio = freshPlayer\(\)/)
  // The outline follows the player through it alone, not through one wired once at the start.
  assert.equal(view.match(/audio\.addEventListener\('play'/g)?.length, 1)
})

test('a tap on the outline plays from there, as the finger lifts, if it wasn’t playing', () => {
  const view = read('../src/ui/photoView.ts')
  assert.match(view, /playOnLift = !!hearing && \$<HTMLAudioElement>\('pv-audio'\)\.paused\n\s+seek\(e\)/)
  assert.match(view, /wave\.addEventListener\('pointerup', \(\) => \{\n\s+if \(!playOnLift \|\| !hearing\) return\n\s+playOnLift = false\n\s+\$<HTMLAudioElement>\('pv-audio'\)\n\s+\.play\(\)/)
  assert.match(view, /wave\.addEventListener\('pointercancel', \(\) => \(playOnLift = false\)\)/)
})
