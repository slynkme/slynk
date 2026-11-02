// The envelope wrapped around everything Slynk sends, before the core
// encrypts it. Names and types travel inside the encrypted payload, so neither
// the server nor the mixnet ever sees them. The encoder always writes v2; v1
// (a single item) is still decoded, for links made before v2.
//
// v2, integers big-endian:
//   version(1)=2 flags(1) count(1) extLength(2) ext[extLength]
//   then count items:
//   kind(1) flags(1) nameLength(1) name typeLength(1) type size(4) storedLength(4) body
//
// size is the item's real length; storedLength the bytes that follow (they
// differ only when the body is compressed). Items keep the sender's order,
// message first.
//
// Everything a later version might add is either ignorable or must-understand,
// so a feature that changes how the payload is read (encryption, say) makes an
// older page refuse the link instead of misreading it:
//   header flags  bits 0-3 ignorable, bits 4-7 must-understand: bit 4 = more than 51 items
//                 (up to 201 since 2026-10-26, was 51; a page from before says "newer")
//   ext records   type(1) length(2) value; type bit 7 = must-understand (none defined yet)
//   item kind     0 = file, 1 = text message; 2-127 must-understand, 128-255 optional (skipped)
//   item flags    bit 0 = body is compressed (deflate-raw, unless bit 4 says Brotli),
//                 bit 1 = the sender says hidden info was removed, bit 2 = the sender
//                 says it's a smaller copy their browser made (since 2026-10-17; older
//                 pages ignore it), bit 3 ignorable, bits 4-7 must-understand: bit 4 =
//                 the compression is Brotli (since 2026-10-26; always with bit 0, so a
//                 page from before it says "newer" rather than "damaged"), bit 5 = a zip
//                 sent unpacked (its files stored, the whole in Brotli: always with bits 0
//                 and 4), for the recipient to compress its files again (zipInside.ts);
//                 its size is the unpacked zip's
//
// v1: version(1)=1 flags(1) nameLength(2) name typeLength(1) type body
//     flags: bit 0 = text message, bit 1 = body is deflate-raw.
//
// Decoding trusts nothing: the bytes come from whoever made the link. Every
// length is bounds-checked, declared sizes are enforced while inflating, and
// sender-supplied types that a browser could run are replaced.
import { deflated, tryable } from './compress.ts'
import { SITE_NAME } from './site.ts'
import { MAX_BROTLI, SqueezeError, brotli, unbrotli } from './squeeze/index.ts'
import { MAX_REPACKED_FILES, repackZip } from './zipInside.ts'

// Bytes on the wire, after compression. One-time, expiring and password links
// fit their extra layers inside it. The core refuses anything bigger: it's
// xxDK's fileMaxSize (third_party/xxdk-client/channelsFileTransfer/manager.go).
export const MAX_PAYLOAD = 2_000_000
// What those layers add, here beside the limit so code that only counts sizes (the file list's
// example, web/examples/file-prep/) needn't load the key server's client or the password's worker.
/** What a one-time or expiring link's seal adds (burn.ts seal): the 96-bit nonce in front and the 128-bit tag behind. */
export const SEAL_OVERHEAD = 12 + 16
/** What the password layer adds (password.ts lock): its version, its 128-bit salt, and the 96-bit nonce and 128-bit tag. */
export const PASSWORD_OVERHEAD = 1 + 16 + 12 + 16
export const MAX_FILES = 200 // 50 until 2026-10-26
export const MAX_ITEMS = MAX_FILES + 1 // one message plus up to 200 files
/** What pages before then read: an envelope with more sets HEADER_MANY, and its v2 link MANY_FLAG (linkv2.ts). */
export const ITEMS_BEFORE = 51
export const MAX_DECODED = 100_000_000 // all items together, after inflating

export const HEADER_SIZE = 5
export const ITEM_FIXED_SIZE = 12
const MAX_NAME = 255 // UTF-8 bytes
const MAX_TYPE = 100 // ASCII bytes
const SLICE = 4096 // inflate input step; deflate expands at most ~1032x, so ~4 MB

const HEADER_MUST = 0xf0
const HEADER_MANY = 0x10
const EXT_MUST = 0x80
const KIND_FILE = 0
const KIND_TEXT = 1
const KIND_OPTIONAL = 0x80
const ITEM_DEFLATE = 1
const ITEM_STRIPPED = 2
const ITEM_SMALLER = 4
const ITEM_BROTLI = 0x10
const ITEM_UNPACKED_ZIP = 0x20
const ITEM_MUST = 0xf0

const V1_TEXT = 1
const V1_DEFLATE = 2

export interface Item {
  kind: 'text' | 'file'
  name: string
  type: string
  data: Uint8Array
  /** The sender says hidden info (metadata) was removed. Only their claim. */
  stripped?: boolean
  /** The sender says it's a smaller copy of a photo, made in their browser (so it holds no hidden info). Only their claim. */
  smaller?: boolean
}

/** How an item's bytes go on the wire: as they are, deflate-raw, or Brotli. */
export type Method = 'as-is' | 'deflate' | 'brotli'

export interface Stored {
  body: Uint8Array
  method: Method
  /** A zip that goes unpacked (zipInside.ts unpackedZip): the length its Brotli body unpacks to, which the recipient compresses again. */
  unpacked?: number
}

/** An item ready to encode. Packed items have exact, independent wire sizes. */
export interface Packed {
  kind: 'text' | 'file'
  name: Uint8Array
  type: Uint8Array
  size: number
  body: Uint8Array
  method: Method
  /** A zip that goes unpacked: the length its body unpacks to (the size on the wire; size stays the zip's own). */
  unpacked?: number
  stripped: boolean
  smaller: boolean
}

/**
 * Thrown for any envelope Slynk won't open. newer: made by a later version. again: this tab
 * couldn't unpack it just now (its Brotli worker failed), so trying the same bytes again may work.
 */
export class EnvelopeError extends Error {
  newer: boolean
  again: boolean
  constructor(message: string, newer: boolean, again = false) {
    super(message)
    this.name = 'EnvelopeError'
    this.newer = newer
    this.again = again
  }
}

export const DAMAGED_TEXT = `It arrived, but what’s inside is damaged, so ${SITE_NAME} won’t open it.`
export const NEWER_TEXT = `This link was made by a newer version of ${SITE_NAME}. Reload the page, then open the link again.`
export const UNPACK_TEXT = `It arrived, but this tab couldn’t unpack it just now. Try again.`
const damaged = () => new EnvelopeError(DAMAGED_TEXT, false)
const newer = () => new EnvelopeError(NEWER_TEXT, true)

// --- Encoding ------------------------------------------------------------------

const MIME_RE = /^[\w.+-]+\/[\w.+-]+$/

/** Decides how to store bytes, by what they hold: deflate-raw only when it saves at least 5% (compress.ts). Quick: the browser's own deflate. */
export async function store(data: Uint8Array): Promise<Stored> {
  const packed = await deflated(data)
  return packed ? { body: packed, method: 'deflate' } : { body: data, method: 'as-is' }
}

/**
 * Brotli's version of what store() made of data, when it's smaller still (and saves at least 5%
 * on the original), or stored itself. Slower: seconds for a big file. Not tried for what's already
 * compressed (by its first bytes) or past MAX_BROTLI, but tried whatever deflate managed: Brotli
 * looks back 16 MB, deflate 32 KB, so it finds what a file repeats far apart (the same font or
 * picture twice in a PDF: 51% off one that deflate couldn't touch, 2026-10-26). If Brotli fails,
 * stored is kept: the setting only ever makes things smaller. Rejects with an AbortError once
 * signal aborts.
 */
export async function squeeze(data: Uint8Array, stored: Stored, quality: number, signal?: AbortSignal): Promise<Stored> {
  if (!tryable(data) || data.length > MAX_BROTLI) return stored
  let packed: Uint8Array
  try {
    packed = await brotli(data, quality, signal)
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e
    return stored
  }
  return packed.length < stored.body.length && packed.length < data.length * 0.95 ? { body: packed, method: 'brotli' } : stored
}

/** Builds the wire form of an item from its stored body (no compression here). */
export function packItem(item: Item, stored: Stored): Packed {
  const isText = item.kind === 'text'
  const type = item.type.toLowerCase()
  return {
    kind: item.kind,
    name: isText ? new Uint8Array(0) : new TextEncoder().encode(fitName(item.name)),
    type: !isText && type.length <= MAX_TYPE && MIME_RE.test(type) ? new TextEncoder().encode(type) : new Uint8Array(0),
    size: item.data.length,
    body: stored.body,
    method: stored.method,
    ...(stored.unpacked !== undefined && stored.method === 'brotli' ? { unpacked: stored.unpacked } : {}),
    stripped: !isText && !!item.stripped,
    smaller: !isText && !!item.smaller,
  }
}

export async function pack(item: Item): Promise<Packed> {
  return packItem(item, await store(item.data))
}

/** Whether an envelope of these needs a page that reads Brotli: its v2 link says so (linkv2.ts BROTLI_FLAG). */
export const usesBrotli = (packed: Packed[]): boolean => packed.some((p) => p.method === 'brotli')

/** Whether it has more items than pages before 2026-10-26 read: its v2 link says so too (linkv2.ts MANY_FLAG). */
export const usesMany = (packed: Packed[]): boolean => packed.length > ITEMS_BEFORE

export function itemWireSize(p: Packed): number {
  return ITEM_FIXED_SIZE + p.name.length + p.type.length + p.body.length
}

/** The files in a package, by name and size as they go: what an inbox owner's own message keeps of them. */
export function fileNames(packed: Packed[]): { name: string; size: number }[] {
  return packed.filter((p) => p.kind === 'file').map((p) => ({ name: new TextDecoder().decode(p.name), size: p.size }))
}

/** Exactly encode(packed).length, since each item is packed on its own. */
export function envelopeSize(packed: Packed[]): number {
  return packed.reduce((n, p) => n + itemWireSize(p), HEADER_SIZE)
}

export function encode(packed: Packed[]): Uint8Array {
  if (packed.length < 1 || packed.length > MAX_ITEMS) throw new Error(`Send between 1 and ${MAX_ITEMS} items.`)
  const out = new Uint8Array(envelopeSize(packed))
  const view = new DataView(out.buffer)
  let i = 0
  out[i++] = 2
  out[i++] = usesMany(packed) ? HEADER_MANY : 0 // flags
  out[i++] = packed.length
  view.setUint16(i, 0) // no extension records
  i += 2
  for (const p of packed) {
    if (p.name.length > MAX_NAME || p.type.length > MAX_TYPE) throw new Error('Name or type too long.')
    out[i++] = p.kind === 'text' ? KIND_TEXT : KIND_FILE
    const packing = p.method === 'brotli' ? ITEM_DEFLATE | ITEM_BROTLI | (p.unpacked !== undefined ? ITEM_UNPACKED_ZIP : 0) : p.method === 'deflate' ? ITEM_DEFLATE : 0
    out[i++] = packing | (p.stripped ? ITEM_STRIPPED : 0) | (p.smaller ? ITEM_SMALLER : 0)
    out[i++] = p.name.length
    out.set(p.name, i)
    i += p.name.length
    out[i++] = p.type.length
    out.set(p.type, i)
    i += p.type.length
    view.setUint32(i, p.unpacked ?? p.size)
    view.setUint32(i + 4, p.body.length)
    i += 8
    out.set(p.body, i)
    i += p.body.length
  }
  return out
}

/**
 * Shortens a name to at most max UTF-8 bytes on a code-point boundary,
 * keeping a short extension: the start of the name, then "…", then ".pdf".
 */
export function fitName(name: string, max = MAX_NAME): string {
  const enc = new TextEncoder()
  if (enc.encode(name).length <= max) return name
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : ''
  const budget = max - enc.encode('…' + ext).length
  let out = ''
  let used = 0
  for (const ch of name.slice(0, name.length - ext.length)) {
    const n = enc.encode(ch).length
    if (used + n > budget) break
    out += ch
    used += n
  }
  return out + '…' + ext
}

// --- Decoding ------------------------------------------------------------------

// Types a browser might render or run if a download were opened in place.
// They're saved as plain bytes instead; the file name keeps its extension.
// Deliberately broad: any HTML, SVG or XML flavour (text/xml, image/svg+xml,
// application/x-xml, application/xml-dtd…), scripts, and MIME containers.
const ACTIVE_TYPE =
  /html|svg|^[\w.+-]+\/([\w.+-]*xml|xml[\w.+-]*)$|^text\/xsl$|^(text|application)\/(x-)?(java|ecma|j|live)script[\d.]*$|^text\/jsx$|^multipart\/|^message\/|^text\/x-component$|^application\/x-shockwave-flash$|^application\/hta$/

/** Validates a sender-supplied MIME type: '' if malformed, octet-stream if active. */
export function safeType(type: string): string {
  const t = type.toLowerCase()
  if (t.length > MAX_TYPE || !MIME_RE.test(t)) return ''
  return ACTIVE_TYPE.test(t) ? 'application/octet-stream' : t
}

export async function decode(bytes: Uint8Array): Promise<Item[]> {
  // No Slynk page ever sends more than MAX_PAYLOAD, v1 or v2.
  if (bytes.length === 0 || bytes.length > MAX_PAYLOAD || bytes[0] === 0) throw damaged()
  if (bytes[0] === 1) return [await decodeV1(bytes)]
  if (bytes[0] === 2) return decodeV2(bytes)
  throw newer()
}

class Reader {
  private bytes: Uint8Array
  private view: DataView
  private at: number

  constructor(bytes: Uint8Array, at: number) {
    this.bytes = bytes
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    this.at = at
  }

  get left(): number {
    return this.bytes.length - this.at
  }

  u8(): number {
    this.need(1)
    return this.bytes[this.at++]
  }

  u16(): number {
    this.need(2)
    const v = this.view.getUint16(this.at)
    this.at += 2
    return v
  }

  u32(): number {
    this.need(4)
    const v = this.view.getUint32(this.at)
    this.at += 4
    return v
  }

  take(n: number): Uint8Array {
    this.need(n)
    const v = this.bytes.subarray(this.at, this.at + n)
    this.at += n
    return v
  }

  private need(n: number) {
    if (n > this.left) throw damaged()
  }
}

const utf8 = (b: Uint8Array) => new TextDecoder().decode(b)

async function decodeV1(bytes: Uint8Array): Promise<Item> {
  const r = new Reader(bytes, 1)
  const flags = r.u8()
  const name = utf8(r.take(r.u16()))
  const type = safeType(utf8(r.take(r.u8())))
  let data = r.take(r.left)
  if (flags & V1_DEFLATE) data = await inflate(data, MAX_DECODED, false)
  if (flags & V1_TEXT) return { kind: 'text', name: '', type: '', data, stripped: false, smaller: false }
  return { kind: 'file', name, type, data, stripped: false, smaller: false }
}

function checkExtensions(ext: Uint8Array) {
  const r = new Reader(ext, 0)
  while (r.left) {
    const type = r.u8()
    r.take(r.u16())
    if (type & EXT_MUST) throw newer() // none are defined yet
  }
}

interface Head {
  kind: 'text' | 'file'
  flags: number
  name: string
  type: string
  size: number
  body: Uint8Array
}

async function decodeV2(bytes: Uint8Array): Promise<Item[]> {
  const r = new Reader(bytes, 1)
  if (r.u8() & HEADER_MUST & ~HEADER_MANY) throw newer()
  const count = r.u8()
  if (count < 1 || count > MAX_ITEMS) throw damaged()
  checkExtensions(r.take(r.u16()))

  // First pass: every header and length, before inflating anything.
  const heads: Head[] = []
  let total = 0
  for (let n = 0; n < count; n++) {
    const kind = r.u8()
    const flags = r.u8()
    const name = r.take(r.u8())
    const type = r.take(r.u8())
    const size = r.u32()
    const body = r.take(r.u32())
    if (!(flags & ITEM_DEFLATE) && size !== body.length) throw damaged()
    if (kind !== KIND_FILE && kind !== KIND_TEXT) {
      if (kind & KIND_OPTIONAL) continue // an extra from a newer Slynk, safe to skip
      throw newer()
    }
    if (flags & ITEM_MUST & ~(ITEM_BROTLI | ITEM_UNPACKED_ZIP)) throw newer()
    if ((flags & ITEM_BROTLI && !(flags & ITEM_DEFLATE)) || (flags & ITEM_UNPACKED_ZIP && !(flags & ITEM_BROTLI))) throw damaged()
    // No page sends Brotli bigger than this: a later one that did would say so (the review, 2026-10-26).
    if (flags & ITEM_BROTLI && size > MAX_BROTLI) throw newer()
    total += size
    if (total > MAX_DECODED) throw damaged()
    heads.push({ kind: kind === KIND_TEXT ? 'text' : 'file', flags, name: utf8(name), type: safeType(utf8(type)), size, body })
  }
  if (r.left) throw damaged()
  if (!heads.length) throw newer()

  const items: Item[] = []
  const budget = { files: MAX_REPACKED_FILES }
  for (const h of heads) {
    let data = h.flags & ITEM_BROTLI ? await unpackBrotli(h.body, h.size) : h.flags & ITEM_DEFLATE ? await inflate(h.body, h.size, true) : h.body
    // Never bigger than a sender's page makes one: past that it's given as it is.
    if (h.flags & ITEM_UNPACKED_ZIP) data = await repackZip(data, MAX_BROTLI, budget)
    const isText = h.kind === 'text'
    items.push({
      kind: h.kind,
      name: isText ? '' : h.name,
      type: isText ? '' : h.type,
      data,
      stripped: !isText && (h.flags & ITEM_STRIPPED) !== 0,
      smaller: !isText && (h.flags & ITEM_SMALLER) !== 0,
    })
  }
  return items
}

// --- Compression ---------------------------------------------------------------

/** Exactly size bytes from a Brotli body. The worker tries again on a fresh one if it fails, so a failure here says "try again". */
async function unpackBrotli(body: Uint8Array, size: number): Promise<Uint8Array> {
  let out: Uint8Array
  try {
    out = await unbrotli(body, size)
  } catch (e) {
    throw e instanceof SqueezeError && e.broken ? new EnvelopeError(UNPACK_TEXT, false, true) : damaged()
  }
  if (out.length !== size) throw damaged()
  return out
}

/**
 * Inflates deflate-raw data, refusing to produce more than limit bytes (and,
 * when exact, anything but exactly limit bytes). The input goes in small fixed
 * slices because a DecompressionStream inflates each input chunk in full
 * before anyone can read it: a 4 KB slice can't expand past about 4 MB.
 */
export async function inflate(data: Uint8Array, limit: number, exact: boolean): Promise<Uint8Array> {
  const stream = new DecompressionStream('deflate-raw')
  const writer = stream.writable.getWriter()
  const reader = stream.readable.getReader()
  const out = exact ? new Uint8Array(limit) : undefined
  const chunks: Uint8Array[] = []
  let at = 0
  let stop = false
  const feeding = (async () => {
    for (let i = 0; i < data.length && !stop; i += SLICE) await writer.write(data.subarray(i, i + SLICE) as BufferSource)
    if (!stop) await writer.close()
  })()
  feeding.catch(() => {}) // a failure shows up on the reading side too
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value.length > limit - at) throw damaged()
      if (out) out.set(value, at)
      else chunks.push(value)
      at += value.length
    }
    await feeding
  } catch (e) {
    stop = true
    reader.cancel().catch(() => {})
    throw e instanceof EnvelopeError ? e : damaged()
  }
  if (out) {
    if (at !== limit) throw damaged()
    return out
  }
  const all = new Uint8Array(at)
  let i = 0
  for (const c of chunks) {
    all.set(c, i)
    i += c.length
  }
  return all
}

// --- Links ---------------------------------------------------------------------

// A link is 148 bytes (see core/transfer/link.go); bytes 66–73 hold the send
// time in Unix nanoseconds. The network keeps data for at most about 500 hours;
// gateways may sweep it sooner.
export const LINK_LENGTH = 148
const LINK_LIFETIME_MS = 500 * 3600 * 1000

export function linkTimes(link: Uint8Array): { sent: Date; expires: Date } {
  const nanos = new DataView(link.buffer, link.byteOffset + 66, 8).getBigUint64(0)
  const sent = new Date(Number(nanos / 1_000_000n))
  return { sent, expires: new Date(sent.getTime() + LINK_LIFETIME_MS) }
}

/** The size in bytes of what a link fetches (bytes 138–141). */
export function linkSize(link: Uint8Array): number {
  return new DataView(link.buffer, link.byteOffset + 138, 4).getUint32(0)
}

// Links travel in the URL fragment (after #), which browsers never send to
// servers. base64url keeps them URL-safe.
export function linkToFragment(link: Uint8Array): string {
  let s = ''
  for (const b of link) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fragmentToLink(fragment: string): Uint8Array {
  const b64 = fragment.replace(/^#/, '').replace(/-/g, '+').replace(/_/g, '/')
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
}
