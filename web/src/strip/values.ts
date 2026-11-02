// What the removed details said, so the sender can see exactly what's being
// taken out ("GPS location: 12.34° N, 56.78° E"). Values are read from the
// file being cleaned and only ever reach the sender's own screen: they're
// never sent, stored or logged. Everything here is pure and never throws.
import type { Detail, Found } from './types.ts'

/** Values listed per label; any others are only counted. */
export const MAX_SHOWN = 3

/** Longer values are cut short, with an ellipsis. */
export const MAX_LENGTH = 80

/**
 * Values collected per file, at most. Only a contrived file comes near it;
 * past it, further values are dropped and counts say "and more".
 */
export const MAX_FOUND = 1000

// Control characters, invisible ones (zero-width spaces, tag characters) and
// those that reorder text, which could make a value read backwards. The
// zero-width joiner and non-joiner stay: Persian, Hindi and emoji need them.
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b\u200e\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb\u{e0000}-\u{e007f}]/gu

/** Text on one line without the characters that hide or reorder it, trimmed. */
export function visibleText(raw: string): string {
  return raw.replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim()
}

/** A value fit to show: one line, trimmed, at most MAX_LENGTH characters, or '' when there's nothing to read. */
export function displayValue(raw: string): string {
  const nul = raw.indexOf('\0')
  const s = visibleText(nul === -1 ? raw : raw.slice(0, nul))
  // Blanks like "    :  :     :  :  " or "----" say nothing.
  if (!/[\p{L}\p{N}\p{So}]/u.test(s)) return ''
  const chars = Array.from(s)
  return chars.length > MAX_LENGTH ? chars.slice(0, MAX_LENGTH - 1).join('').trimEnd() + '…' : s
}

/** A value under a label, or null when it has nothing worth showing. */
export function found(label: string, raw: string | null | undefined): Found | null {
  const value = displayValue(raw ?? '')
  return value ? { label, value } : null
}

/** Pushes found(label, raw) onto list when there's something to show and room for it. */
export function addFound(list: Found[], label: string, raw: string | null | undefined) {
  if (list.length >= MAX_FOUND) return
  const f = found(label, raw)
  if (f) list.push(f)
}

/** Pushes more onto list, up to MAX_FOUND (one at a time: a spread of many would overflow the stack). */
export function addAll(list: Found[], more: Iterable<Found>) {
  for (const f of more) {
    if (list.length >= MAX_FOUND) return
    list.push(f)
  }
}

/** Text that's usually UTF-8 but sometimes Latin-1 (EXIF strings, ID3v1). */
export function looseText(b: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b)
  } catch {
    return String.fromCharCode(...b.subarray(0, 4096))
  }
}

function degrees(parts: number[]): number {
  if (parts.length < 1 || parts.length > 3) return NaN
  return (parts[0] ?? 0) + (parts[1] ?? 0) / 60 + (parts[2] ?? 0) / 3600
}

function coordinate(value: number, ref: string, max: number, refs: string): string | null {
  const r = ref.trim().charAt(0).toUpperCase()
  if (!r || !refs.includes(r) || !Number.isFinite(value) || value < 0 || value > max) return null
  // Four decimal places is about 10 m, the precision phones record.
  return `${value.toFixed(4).replace(/\.?0+$/, '')}° ${r}`
}

/** "12.34° N, 56.78° E" from EXIF's degrees, minutes and seconds, or null when it doesn't add up. */
export function formatGps(lat: number[], latRef: string, lon: number[], lonRef: string): string | null {
  const a = coordinate(degrees(lat), latRef, 90, 'NS')
  const b = coordinate(degrees(lon), lonRef, 180, 'EW')
  return a && b ? `${a}, ${b}` : null
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * "12 Jun 2024, 18:30" from an EXIF date ("2024:06:12 18:30:00"). It's the
 * camera's clock, with no time zone, so it's shown as written. Dates in
 * another shape are shown as they are; blank ones ("0000:00:00") give ''.
 */
export function formatExifDate(raw: string): string {
  const s = displayValue(raw)
  const m = /^(\d{4})[:\-./](\d{1,2})[:\-./](\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/.exec(s)
  if (!m) return s
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])]
  // A real day of a real month ("31 Feb" isn't one).
  const check = new Date(0)
  check.setUTCFullYear(year, month - 1, day)
  if (year < 1 || month < 1 || month > 12 || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return ''
  const date = `${day} ${MONTHS[month - 1]} ${m[1]}`
  if (m[4] === undefined || Number(m[4]) > 23 || Number(m[5]) > 59) return date
  return `${date}, ${m[4].padStart(2, '0')}:${m[5]}`
}

/** "ExampleCam X1" from a make and a model, without saying the maker twice ("Canon" + "Canon EOS R5"). */
export function cameraName(make: string, model: string): string {
  const a = displayValue(make)
  const b = displayValue(model)
  if (!a || !b) return a || b
  // As whole words: "Canon" + "Canonet QL17" names both.
  const startsWithWord = (s: string, word: string) => s.startsWith(word) && !/[\p{L}\p{N}]/u.test(s.charAt(word.length))
  const lower = b.toLowerCase()
  if (startsWithWord(lower, a.toLowerCase()) || startsWithWord(lower, a.split(' ')[0].toLowerCase())) return b
  return displayValue(`${a} ${b}`)
}

/**
 * One Detail per label, in the labels' order, with the distinct values found
 * under each. When collecting stopped at MAX_FOUND, a label with values to
 * spare says "more" (-1) rather than a count that could be short.
 */
export function describe(labels: string[], values: Found[] = []): Detail[] {
  const byLabel = new Map<string, Set<string>>()
  for (const { label, value } of values) {
    const set = byLabel.get(label)
    if (set) set.add(value)
    else byLabel.set(label, new Set([value]))
  }
  const full = values.length >= MAX_FOUND
  return labels.map((label) => {
    const all = [...(byLabel.get(label) ?? [])]
    const more = all.length - MAX_SHOWN
    return { label, values: all.slice(0, MAX_SHOWN), more: full && more >= 0 ? -1 : Math.max(0, more) }
  })
}
