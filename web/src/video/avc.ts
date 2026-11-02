// H.264 in its two packagings. MP4 wants each picture's pieces (NAL units)
// prefixed with their lengths, and the stream's parameter sets in an avcC box;
// an encoder that hands back the broadcast form ("Annex B": pieces separated
// by 00 00 01 start codes, parameter sets inline) is repackaged here.

/** The NAL units of an Annex B stream. */
export function splitAnnexB(b: Uint8Array): Uint8Array[] {
  const starts: number[] = []
  for (let i = 0; i + 2 < b.length; i++) {
    if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 1) {
      starts.push(i + 3)
      i += 2
    }
  }
  return starts.map((s, k) => {
    let end = k + 1 < starts.length ? starts[k + 1] - 3 : b.length
    while (end > s && b[end - 1] === 0) end-- // a four-byte start code's leading zero, or trailing padding
    return b.subarray(s, end)
  })
}

/** Whether these bytes are Annex B (they start with a start code). */
export const isAnnexB = (b: Uint8Array) => b.length > 3 && b[0] === 0 && b[1] === 0 && (b[2] === 1 || (b[2] === 0 && b[3] === 1))

/** An avcC box's body from a stream's parameter sets; lengthSize: the bytes before each NAL unit in the pictures. */
export function avcC(sps: Uint8Array[], pps: Uint8Array[], lengthSize = 4): Uint8Array {
  const s = sps[0]
  const out = [1, s[1], s[2], s[3], 0xfc | (lengthSize - 1), 0xe0 | sps.length]
  for (const x of sps) out.push(x.length >> 8, x.length & 0xff, ...x)
  out.push(pps.length)
  for (const x of pps) out.push(x.length >> 8, x.length & 0xff, ...x)
  // High profiles add their chroma format and bit depths: 4:2:0, 8 bits.
  if ([100, 110, 122, 144].includes(s[1])) out.push(0xfd, 0xf8, 0xf8, 0)
  return new Uint8Array(out)
}

/** An avcC's parameter sets and length size, or undefined if these bytes aren't a sound one. */
export function parseAvcC(c: Uint8Array): { sps: Uint8Array[]; pps: Uint8Array[]; lengthSize: number } | undefined {
  if (c.length < 7 || c[0] !== 1) return undefined
  let p = 5
  const list = (count: number, type: number): Uint8Array[] | undefined => {
    const out: Uint8Array[] = []
    for (let i = 0; i < count; i++) {
      if (p + 2 > c.length) return undefined
      const n = (c[p] << 8) | c[p + 1]
      p += 2
      if (!n || p + n > c.length || (c[p] & 0x1f) !== type) return undefined
      out.push(c.slice(p, p + n))
      p += n
    }
    return out
  }
  const sps = list(c[p++] & 0x1f, 7)
  if (!sps?.length || p >= c.length) return undefined
  const pps = list(c[p++], 8)
  if (!pps?.length) return undefined
  return { sps, pps, lengthSize: (c[4] & 3) + 1 }
}

/** The NAL units of a picture whose units each follow their length, if that's exactly what it holds. */
export function lengthPrefixed(b: Uint8Array, lengthSize = 4): Uint8Array[] | undefined {
  const out: Uint8Array[] = []
  for (let p = 0; p < b.length; ) {
    if (p + lengthSize > b.length) return undefined
    let n = 0
    for (let i = 0; i < lengthSize; i++) n = n * 256 + b[p + i]
    p += lengthSize
    if (!n || p + n > b.length) return undefined
    out.push(b.subarray(p, p + n))
    p += n
  }
  return out.length ? out : undefined
}

/**
 * The encoder's output made right for MP4, whatever form it came in: a clean
 * avcC rebuilt from the parameter sets (Firefox has written broken ones), and
 * pictures as lengths and units. fixed says what had to be done.
 */
export function forMp4(description: Uint8Array | undefined, pictures: Uint8Array[]): { description: Uint8Array; pictures: Uint8Array[]; fixed: string } {
  if (isAnnexB(pictures[0])) return { ...fromAnnexB(pictures, description), fixed: 'repackaged from Annex B' }
  const parsed = description && parseAvcC(description)
  if (parsed && pictures.every((p) => lengthPrefixed(p, parsed.lengthSize))) {
    const clean = avcC(parsed.sps, parsed.pps, parsed.lengthSize)
    const same = clean.length === description!.length && clean.every((v, i) => v === description![i])
    return { description: clean, pictures, fixed: same ? '' : 'avcC rebuilt' }
  }
  // No usable avcC: the parameter sets from the description in Annex B form, or from the pictures themselves.
  const units = [...(description && isAnnexB(description) ? splitAnnexB(description) : []), ...(lengthPrefixed(pictures[0]) ?? [])]
  const sps = units.filter((u) => (u[0] & 0x1f) === 7)
  const pps = units.filter((u) => (u[0] & 0x1f) === 8)
  if (!sps.length || !pps.length || !pictures.every((p) => lengthPrefixed(p))) throw new Error('the encoder’s output can’t be read')
  return { description: avcC([sps[0].slice()], [pps[0].slice()]), pictures, fixed: 'avcC made from the parameter sets' }
}

/**
 * Repackages Annex B pictures for MP4: lengths instead of start codes, and the
 * parameter sets (and access unit delimiters) taken out into an avcC.
 */
export function fromAnnexB(pictures: Uint8Array[], description?: Uint8Array): { description: Uint8Array; pictures: Uint8Array[] } {
  // Parameter sets the encoder gave apart, if it did, then any in the stream.
  const given = description && parseAvcC(description)
  const sps: Uint8Array[] = given ? [...given.sps] : []
  const pps: Uint8Array[] = given ? [...given.pps] : []
  const seen = new Set<string>([...sps.map((x) => `7:${x.join(',')}`), ...pps.map((x) => `8:${x.join(',')}`)])
  const out = pictures.map((p) => {
    const kept: Uint8Array[] = []
    for (const nal of splitAnnexB(p)) {
      const type = nal[0] & 0x1f
      if (type === 7 || type === 8) {
        const key = `${type}:${nal.join(',')}`
        if (!seen.has(key)) (type === 7 ? sps : pps).push(nal.slice())
        seen.add(key)
      } else if (type !== 9) kept.push(nal)
    }
    const bytes = new Uint8Array(kept.reduce((n, x) => n + 4 + x.length, 0))
    let at = 0
    for (const nal of kept) {
      new DataView(bytes.buffer).setUint32(at, nal.length)
      bytes.set(nal, at + 4)
      at += 4 + nal.length
    }
    return bytes
  })
  if (!sps.length || !pps.length) throw new Error('the encoder gave no parameter sets')
  return { description: avcC(sps, pps), pictures: out }
}
