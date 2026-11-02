// Decompression with a size cap, so a tiny compressed chunk can't expand into
// gigabytes (a "zip bomb"). Uses fflate's synchronous streaming API only: its
// async API starts blob: workers, which our Content-Security-Policy forbids.
import { Inflate, Unzlib } from 'fflate'
import { fail } from './types.ts'

/**
 * Whether a streaming inflater has come to the end of its data: its last block read through. fflate
 * says so only in its state (0.8.3, pinned: its last-block flag set and no block in progress); the
 * tests fail if that changes. Anything pushed after the end is kept and copied again on every push,
 * so megabytes of junk after a stream took seconds.
 */
export function streamEnded(stream: Inflate | Unzlib): boolean {
  const s = (stream as unknown as { s?: { f?: number; l?: unknown } }).s
  return !!s?.f && !s.l
}

function run(stream: Inflate | Unzlib, data: Uint8Array, cap: number, parts: Uint8Array[]): Uint8Array {
  let total = 0
  stream.ondata = (chunk: Uint8Array) => {
    total += chunk.length
    if (total > cap) fail('compressed data expands too far')
    parts.push(chunk)
  }
  // Feed small slices: fflate expands each push in one go before reporting it,
  // so this bounds how far one step can grow (deflate tops out near 1:1032).
  // Nothing after the end of the data: it's junk, and it would be slow.
  const step = 4096
  for (let i = 0; (i < data.length || i === 0) && !streamEnded(stream); i += step) {
    stream.push(data.subarray(i, i + step), i + step >= data.length)
  }
  const out = new Uint8Array(total)
  let i = 0
  for (const p of parts) {
    out.set(p, i)
    i += p.length
  }
  return out
}

/** Inflates raw deflate data (as in ZIP), refusing to grow beyond `cap` bytes. */
export function inflateRaw(data: Uint8Array, cap: number): Uint8Array {
  return run(new Inflate(), data, cap, [])
}

/** Inflates zlib-wrapped data (as in PNG text chunks), refusing to grow beyond `cap` bytes. */
export function inflateZlib(data: Uint8Array, cap: number): Uint8Array {
  return run(new Unzlib(), data, cap, [])
}
