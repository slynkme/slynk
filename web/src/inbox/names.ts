// Names people give themselves when they include their own inbox with a
// message, so its owner can reply. A name is only what the
// sender chose to be called: anyone can choose any name, so the owner's page
// cleans it before showing it, never groups by it (only by the sender's
// inbox), and warns when two inboxes use names that look the same.
import { LOOKALIKES } from './lookalikes.ts'

/** The longest name a sender can give, in characters, and in bytes of UTF-8 (the core's MaxFromName). */
export const MAX_GIVEN_NAME = 40
export const MAX_GIVEN_NAME_BYTES = 160

// Characters that are invisible, control the line or reorder text: a name
// made of them would look blank, or read backwards. The zero-width joiner
// and non-joiner stay (Persian, Hindi and emoji need them). Also the "blank
// letters" (Hangul fillers, the braille blank) that make a name look empty.
const INVISIBLE =
  /[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u180e\u200b\u200e\u200f\u2028-\u202e\u2060-\u206f\u2800\u3164\ufeff\uffa0\ufff9-\ufffb\u{e0000}-\u{e007f}]/gu

// Combining marks piled on one letter beyond this many are dropped, so a
// name can't spill over the lines around it.
const MAX_MARKS = 2

const utf8 = new TextEncoder()

/**
 * A name a sender gave, fit to show (and to send): NFKC, no invisible,
 * control, format, private-use or unassigned characters (the joiners stay
 * between two characters: Persian, Hindi and emoji need them), at most two
 * marks on a letter and none on a space, spaces collapsed, at most
 * MAX_GIVEN_NAME characters (and MAX_GIVEN_NAME_BYTES), or '' when nothing
 * is left to read. Cleaning it again changes nothing, so the sender's page
 * and the owner's agree. The page shows it isolated from the text around it.
 */
export function cleanGivenName(raw: string): string {
  // Each round can only take characters away, so it settles; a few rounds at most in practice.
  let s = raw
  for (let round = 0; round < 32; round++) {
    const next = cleanOnce(s)
    if (next === s) break
    s = next
  }
  return /[\p{L}\p{N}\p{So}]/u.test(s) ? s : ''
}

function cleanOnce(raw: string): string {
  // Line breaks and tabs become spaces; anything else invisible goes.
  const chars = [...raw.normalize('NFKC').replace(/\s/g, ' ').replace(INVISIBLE, '')]
  let kept = ''
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]
    if (/[\p{Co}\p{Cn}]/u.test(ch)) continue
    if (/\p{Cf}/u.test(ch)) {
      const joiner = ch === '\u200c' || ch === '\u200d'
      const between = i > 0 && i < chars.length - 1 && chars[i - 1] !== ' ' && chars[i + 1] !== ' '
      if (!joiner || !between) continue
    }
    kept += ch
  }
  const s = kept.replace(/ +/g, ' ').trim()
  // Marks are counted with each letter taken apart, so an accented letter's own accent counts too;
  // a mark on a space, or with nothing before it, goes.
  let capped = ''
  let marks = 0
  let base = ''
  for (const ch of s.normalize('NFD')) {
    if (/\p{M}/u.test(ch)) {
      if (++marks > MAX_MARKS || !base || base === ' ') continue
    } else {
      marks = 0
      base = ch
    }
    capped += ch
  }
  let out = ''
  let count = 0
  let bytes = 0
  for (const ch of capped.normalize('NFC')) {
    if (!/\p{M}/u.test(ch) && ++count > MAX_GIVEN_NAME) break
    bytes += utf8.encode(ch).length
    if (bytes > MAX_GIVEN_NAME_BYTES) break
    out += ch
  }
  return out.trim().replace(/^\p{M}+/u, '')
}

/** Without marks (accents and the like), spaces, punctuation, or anything invisible or unassigned. */
const bare = (s: string) => s.normalize('NFD').replace(/[\p{M}\p{Z}\p{P}\p{Cf}\p{Co}\p{Cn}\s]/gu, '')

/** Each character as the Latin letters it looks like, if any, then bare and in lower case. */
const fold = (s: string) => bare(Array.from(s, (ch) => LOOKALIKES.get(ch) ?? ch).join('')).toLowerCase()

/**
 * What a name looks like, folded: case, spaces, punctuation, accents and
 * letters that look like Latin ones (Unicode's confusables, e.g. Cyrillic а
 * for a). Two forms, since a capital can look like another lower-case letter
 * (I and l) while case alone shouldn't matter (Sam and sam).
 */
export function nameKeys(name: string): string[] {
  const had = memo.get(name)
  if (had) return had
  const n = cleanGivenName(name)
  const a = n && fold(bare(n).toLowerCase())
  const b = n && fold(fold(bare(n)))
  const keys = !a ? [] : a === b ? [a] : [a, b]
  if (memo.size > 10_000) memo.clear()
  memo.set(name, keys)
  return keys
}
const memo = new Map<string, string[]>()

/** Whether two names look the same once folded (nameKeys). Empty names never do. */
export function looksSame(a: string, b: string): boolean {
  const ka = nameKeys(a)
  return ka.length > 0 && nameKeys(b).some((k) => ka.includes(k))
}
