// How Slynk compresses a file's bytes before sending them (payload.ts store): deflate-raw,
// and only when that saves at least 5%, judged by what the bytes hold. Kept apart from the
// envelope so what counts sizes uses the very same rule without loading the envelope's code:
// the PDF shrinker, in the cleaner's worker, makes a PDF for its share as it will be sent,
// compressed, not as it's saved (a PDF of screenshots goes about a seventh smaller).

const SMALL = 64 // not worth compressing

// Already compressed, by their first bytes: deflate would only waste time. Judged by what a file
// holds, never its name or the type a browser guesses from it, so a text file named .png is
// compressed, and a photo named .txt isn't tried.
const COMPRESSED_MAGIC: [number, number[]][] = [
  [0, [0x50, 0x4b, 0x03, 0x04]], // zip and everything built on it
  [0, [0x1f, 0x8b]], // gzip
  [0, [0xff, 0xd8, 0xff]], // JPEG
  [0, [0x89, 0x50, 0x4e, 0x47]], // PNG
  [0, [0x47, 0x49, 0x46, 0x38]], // GIF
  [0, [0x37, 0x7a, 0xbc, 0xaf]], // 7z
  [0, [0x52, 0x61, 0x72, 0x21]], // RAR
  [0, [0xfd, 0x37, 0x7a, 0x58, 0x5a]], // xz
  [0, [0x28, 0xb5, 0x2f, 0xfd]], // zstd
  [0, [0x42, 0x5a, 0x68]], // bzip2
  [4, [0x66, 0x74, 0x79, 0x70]], // MP4, MOV, HEIC, AVIF ("ftyp")
  [8, [0x57, 0x45, 0x42, 0x50]], // WebP
  [8, [0x41, 0x56, 0x49, 0x20]], // AVI ("RIFF....AVI ")
  [0, [0x1a, 0x45, 0xdf, 0xa3]], // Matroska, WebM
  [0, [0x4f, 0x67, 0x67, 0x53]], // Ogg ("OggS")
  [0, [0x66, 0x4c, 0x61, 0x43]], // FLAC ("fLaC")
  [0, [0x49, 0x44, 0x33]], // MP3 with tags ("ID3")
  [0, [0x77, 0x4f, 0x46, 0x46]], // WOFF
  [0, [0x77, 0x4f, 0x46, 0x32]], // WOFF2
  [0, [0xff, 0x0a]], // JPEG XL
  [4, [0x4a, 0x58, 0x4c, 0x20]], // JPEG XL in its box ("JXL ")
]

/** Worth trying to deflate: big enough, and not already compressed, by its first bytes. */
export function tryable(data: Uint8Array): boolean {
  return data.length >= SMALL && !COMPRESSED_MAGIC.some(([at, magic]) => magic.every((b, i) => data[at + i] === b))
}

/**
 * What's tried before a big file is deflated whole: its start, middle and end. One that doesn't
 * squeeze in any of them (a recording or a video in a container without a start Slynk knows)
 * isn't deflated whole for nothing. None for a smaller file, which is simply tried.
 */
export function samplesOf(data: Uint8Array): Uint8Array[] {
  const n = 65_536
  return data.length <= n * 4 ? [] : [0, (data.length - n) >> 1, data.length - n].map((i) => data.subarray(i, i + n))
}

/** A sample squeezes when deflating saves at least 3% of it. */
export const squeezes = (part: Uint8Array, packed: Uint8Array) => packed.length < part.length * 0.97

/** The browser's own deflate-raw. */
export async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const out = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(out).arrayBuffer())
}

/** Its deflated form when it's sent that way (saving at least 5%, and in a sample first for a big file); null when it goes as it is. */
export async function deflated(data: Uint8Array): Promise<Uint8Array | null> {
  if (!tryable(data)) return null
  const samples = samplesOf(data)
  if (samples.length && !(await Promise.all(samples.map(async (s) => squeezes(s, await deflate(s))))).some(Boolean)) return null
  const packed = await deflate(data)
  return packed.length < data.length * 0.95 ? packed : null
}

/** The bytes it takes as it's sent: deflated, or as it is. */
export async function sentSize(data: Uint8Array): Promise<number> {
  return (await deflated(data))?.length ?? data.length
}
