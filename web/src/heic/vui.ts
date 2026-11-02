// The colours an HEVC stream says its pictures are in: its sequence parameter
// set's "VUI" (H.265, 7.3.2.2 and E.2.1). A HEIC photo without an nclx 'colr'
// box is in those colours, and some Android phones' photos have none: theirs
// are full range, as a JPEG's are, where video usually leaves the darkest and
// lightest values unused. The browser's decoder should read them itself;
// handing them to it as well (decode.ts) keeps one that doesn't from taking
// the photo for video, with its shadows too dark and highlights too bright.

// ISO/IEC 23091-2 code points, as WebCodecs names them (TypeScript's list
// lags the browsers'); others are left to the stream.
const PRIMARIES: Record<number, string> = { 1: 'bt709', 5: 'bt470bg', 6: 'smpte170m', 9: 'bt2020', 12: 'smpte432' }
const TRANSFER: Record<number, string> = { 1: 'bt709', 6: 'smpte170m', 8: 'linear', 13: 'iec61966-2-1', 16: 'pq', 18: 'hlg' }
const MATRIX: Record<number, string> = { 0: 'rgb', 1: 'bt709', 5: 'bt470bg', 6: 'smpte170m', 9: 'bt2020-ncl' }

/** Colours from their code points, leaving out those WebCodecs has no name for. */
export function namedColours(primaries: number, transfer: number, matrix: number, fullRange: boolean): VideoColorSpaceInit {
  const out: VideoColorSpaceInit = { fullRange }
  if (PRIMARIES[primaries]) out.primaries = PRIMARIES[primaries] as VideoColorPrimaries
  if (TRANSFER[transfer]) out.transfer = TRANSFER[transfer] as VideoTransferCharacteristics
  if (MATRIX[matrix]) out.matrix = MATRIX[matrix] as VideoMatrixCoefficients
  return out
}

/** The stream's colours from its hvcC record's SPS, or undefined when it says none (or can't be read). */
export function streamColours(hvcC: Uint8Array): VideoColorSpaceInit | undefined {
  try {
    const sps = parameterSet(hvcC, 33)
    return sps && fromSps(rbsp(sps.subarray(2)))
  } catch {
    return undefined
  }
}

/** The first NAL unit of a type in the hvcC record's arrays. */
function parameterSet(c: Uint8Array, type: number): Uint8Array | undefined {
  let p = 23
  for (let arrays = c[22]; arrays > 0 && p + 3 <= c.length; arrays--) {
    const t = c[p] & 0x3f
    const count = (c[p + 1] << 8) | c[p + 2]
    p += 3
    for (let k = 0; k < count; k++) {
      const len = (c[p] << 8) | c[p + 1]
      if (p + 2 + len > c.length) return undefined
      if (t === type) return c.subarray(p + 2, p + 2 + len)
      p += 2 + len
    }
  }
  return undefined
}

/** The NAL unit's payload without its emulation prevention bytes (00 00 03 → 00 00): its RBSP. */
function rbsp(d: Uint8Array): Uint8Array {
  const out: number[] = []
  let zeros = 0
  for (const x of d) {
    if (zeros >= 2 && x === 3) {
      zeros = 0
      continue
    }
    out.push(x)
    zeros = x === 0 ? zeros + 1 : 0
  }
  return Uint8Array.from(out)
}

function bits(d: Uint8Array) {
  let pos = 0
  const bit = () => {
    if (pos >= d.length * 8) throw new Error('cut short')
    return (d[pos >> 3] >> (7 - (pos++ & 7))) & 1
  }
  const u = (n: number) => {
    let v = 0
    for (let i = 0; i < n; i++) v = v * 2 + bit()
    return v
  }
  // Exp-Golomb; a signed one (se) is skipped the same way.
  const ue = () => {
    let zeros = 0
    while (!bit()) if (++zeros > 31) throw new Error('not a number')
    return 2 ** zeros - 1 + u(zeros)
  }
  return { u, ue }
}

type Bits = ReturnType<typeof bits>

/** The size the stream's pictures decode to (its SPS's size less its conformance window), or undefined if it can't be read. */
export function streamSize(hvcC: Uint8Array): { width: number; height: number } | undefined {
  try {
    const sps = parameterSet(hvcC, 33)
    if (!sps) return undefined
    const { width, height } = start(bits(rbsp(sps.subarray(2))))
    return { width, height }
  } catch {
    return undefined
  }
}

/** Reads the SPS up to and including its pictures' size. */
function start(r: Bits): { width: number; height: number; subLayers: number } {
  r.u(4) // sps_video_parameter_set_id
  const subLayers = r.u(3)
  r.u(1)
  profileTierLevel(r, subLayers)
  r.ue() // sps_seq_parameter_set_id
  const chroma = r.ue()
  if (chroma === 3) r.u(1) // 4:4:4: separate_colour_plane_flag
  let width = r.ue()
  let height = r.ue()
  if (r.u(1)) {
    // The conformance window, in chroma samples: two pixels across each for 4:2:0 and 4:2:2, two down for 4:2:0.
    const across = chroma === 1 || chroma === 2 ? 2 : 1
    const down = chroma === 1 ? 2 : 1
    width -= across * (r.ue() + r.ue())
    height -= down * (r.ue() + r.ue())
  }
  return { width, height, subLayers }
}

function fromSps(payload: Uint8Array): VideoColorSpaceInit | undefined {
  const r = bits(payload)
  const { subLayers } = start(r)
  r.ue() // bit depths
  r.ue()
  const pocBits = r.ue() + 4
  if (pocBits > 16) throw new Error('not an SPS')
  for (let i = r.u(1) ? 0 : subLayers; i <= subLayers; i++) for (let k = 0; k < 3; k++) r.ue() // sub-layer ordering
  for (let i = 0; i < 6; i++) r.ue() // block sizes, transform depths
  if (r.u(1) && r.u(1)) scalingLists(r)
  r.u(2) // amp, sample adaptive offset
  if (r.u(1)) {
    r.u(8) // PCM sample bit depths
    r.ue()
    r.ue()
    r.u(1)
  }
  const sets = r.ue()
  if (sets > 64) throw new Error('not an SPS')
  const counts: number[] = []
  for (let i = 0; i < sets; i++) counts.push(shortTermSet(r, i, counts))
  if (r.u(1)) {
    const longTerm = r.ue()
    if (longTerm > 32) throw new Error('not an SPS')
    for (let i = 0; i < longTerm; i++) r.u(pocBits + 1)
  }
  r.u(2) // temporal MVP, strong intra smoothing
  if (!r.u(1)) return undefined // no VUI
  if (r.u(1) && r.u(8) === 255) r.u(32) // aspect ratio
  if (r.u(1)) r.u(1) // overscan
  if (!r.u(1)) return undefined // no video signal type
  r.u(3) // video_format
  const fullRange = r.u(1) === 1
  if (!r.u(1)) return { fullRange }
  const primaries = r.u(8)
  const transfer = r.u(8)
  return namedColours(primaries, transfer, r.u(8), fullRange)
}

function profileTierLevel(r: Bits, subLayers: number) {
  r.u(48) // general profile (88 bits) and level (8)
  r.u(48)
  const present: [number, number][] = []
  for (let i = 0; i < subLayers; i++) present.push([r.u(1), r.u(1)])
  if (subLayers > 0) r.u(2 * (8 - subLayers))
  for (const [profile, level] of present) {
    if (profile) {
      r.u(44) // 88 bits, as the general profile
      r.u(44)
    }
    if (level) r.u(8)
  }
}

function scalingLists(r: Bits) {
  for (let size = 0; size < 4; size++)
    for (let matrix = 0; matrix < 6; matrix += size === 3 ? 3 : 1) {
      if (!r.u(1)) {
        r.ue() // predicted from another list
        continue
      }
      if (size > 1) r.ue() // DC coefficient
      for (let i = Math.min(64, 1 << (4 + 2 * size)); i > 0; i--) r.ue()
    }
}

/** Reads a short-term reference picture set; how many pictures it holds (counted as FFmpeg does). */
function shortTermSet(r: Bits, index: number, counts: number[]): number {
  if (index > 0 && r.u(1)) {
    // Predicted from the set before: a flag or two for each of its pictures, and one more.
    r.u(1)
    r.ue()
    let n = 0
    for (let j = 0; j <= counts[index - 1]; j++) if (r.u(1) || r.u(1)) n++
    return n
  }
  const negative = r.ue()
  const positive = r.ue()
  if (negative > 16 || positive > 16) throw new Error('not an SPS')
  for (let i = negative + positive; i > 0; i--) {
    r.ue()
    r.u(1)
  }
  return negative + positive
}
