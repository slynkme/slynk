// The page's side of audio: whether this browser could make a sound file
// smaller, decoding one whole where the worker's decoder can't (FLAC and Ogg,
// and anything else a browser's WebCodecs won't take: the Web Audio API's
// decodeAudioData exists only on the page), and the outline of an audio
// file's sound for its picture (a waveform), worked out in the video worker a
// run at a time. Nothing is fetched: the browser decodes what's in this tab's
// memory.
import { outlineInWorker } from '../video/client.ts'
import { audioInfo, STREAMED, type AudioInfo } from './read.ts'

/**
 * Whether this browser has what making audio smaller needs: 'yes', or
 * 'browser' without WebCodecs' encoder (older iPhones, Firefox on Android,
 * Tor Browser), or for a kind only decoded on the page, without Web Audio.
 */
export function canShrinkAudio(info: AudioInfo): 'yes' | 'browser' {
  if (typeof AudioEncoder === 'undefined' || typeof AudioData === 'undefined') return 'browser'
  if (!STREAMED.includes(info.kind) && typeof OfflineAudioContext === 'undefined') return 'browser'
  return 'yes'
}

/**
 * The most samples (all channels) decoded here at once: 180 MB as decodeAudioData hands them back,
 * which the browser's own decoding and the copies made of them add to. Enough for any stereo plan
 * (6½ minutes at 48 kHz) and any mono one (15 minutes at 24 kHz).
 */
const MAX_DECODED_SAMPLES = 45_000_000

/**
 * The whole sound decoded on the page, in out channels (mono: their
 * average), at 48 kHz, or 24 kHz for a long one going in mono, where Opus
 * keeps little treble anyway. Each channel its own buffer, so it can be
 * handed to the worker. Rejects if this browser can't decode it, or it's too
 * long, as its header says, to decode here.
 */
export async function decodeWhole(data: Uint8Array, info: AudioInfo, out: 1 | 2): Promise<{ planes: Float32Array[]; rate: number }> {
  const fits = (rate: number) => info.seconds * rate * info.channels <= MAX_DECODED_SAMPLES
  const rate = fits(48000) ? 48000 : out === 1 && fits(24000) ? 24000 : 0
  if (!rate) throw new Error('too long to decode here')
  const buffer = await decodeAt(data, rate)
  const planes: Float32Array[] = []
  if (out === 2) {
    for (let c = 0; c < 2; c++) {
      const p = new Float32Array(buffer.length)
      buffer.copyFromChannel(p, Math.min(c, buffer.numberOfChannels - 1))
      planes.push(p)
    }
  } else {
    const mono = new Float32Array(buffer.length)
    const p = new Float32Array(buffer.length)
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      buffer.copyFromChannel(p, c)
      for (let i = 0; i < p.length; i++) mono[i] += p[i] / buffer.numberOfChannels
    }
    planes.push(mono)
  }
  return { planes, rate: buffer.sampleRate }
}

/** decodeAudioData on a copy (it takes the bytes it's given), resampled by the browser to rate. */
async function decodeAt(data: Uint8Array, rate: number): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(1, 1, rate)
  return ctx.decodeAudioData(data.slice().buffer as ArrayBuffer)
}

const outlines = new WeakMap<Uint8Array, Promise<number[] | null>>()

/** Outlines are worked out only for this much sound, as its header says: the worker stops at its own limit too, whatever the header says. */
const OUTLINE_SECONDS = 20 * 60

/**
 * PEAKS numbers, 0 to 1, for an audio file's picture: how loud each stretch
 * is (levels() in plan.ts), worked out in the worker a run at a time. null for
 * one it can't decode that way (FLAC, Ogg: never decoded whole here just for a
 * picture, since a small file can hold hours of silence), or that's too long.
 * Worked out once for each set of bytes.
 */
export function audioOutline(data: Uint8Array): Promise<number[] | null> {
  let found = outlines.get(data)
  if (!found) {
    found = outline(data)
    outlines.set(data, found)
  }
  return found
}

async function outline(data: Uint8Array): Promise<number[] | null> {
  const info = await audioInfo(data)
  if (!info || !STREAMED.includes(info.kind) || !(info.seconds <= OUTLINE_SECONDS)) return null
  return outlineInWorker(new Blob([data as BlobPart]), info.kind, info.seconds)
}

/** Remembers the outline the worker worked out for bytes it made, so it isn't decoded again. */
export function keepOutline(data: Uint8Array, peaks: number[]) {
  outlines.set(data, Promise.resolve(peaks))
}
