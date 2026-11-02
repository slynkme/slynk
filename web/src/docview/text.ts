// Plain text for the preview: any file that is
// text by its bytes (UTF-8 without control characters, strip/sniff.ts
// isUtf8Text), whatever its name: a note, a CSV, code, a web page's source.
// Shown as it is, its lines and spaces kept, never as markup.
import { isControlByte } from '../strip/sniff.ts'
import { MAX_DOC_CHARS, type DocText } from './model.ts'

/**
 * A file's text as far as maxChars, a paragraph for each line, and only as far as it is text: one
 * that's text at the start and something else after (an installer with an archive on its end)
 * ends where its text does (the review, 2026-10-26).
 */
export function readText(data: Uint8Array, maxChars = MAX_DOC_CHARS): DocText {
  // UTF-8 takes at most 4 bytes a character, so a long file is decoded only as far as is shown.
  const limit = maxChars * 4
  const head = data.subarray(0, limit)
  const control = head.findIndex(isControlByte)
  const bytes = control >= 0 ? head.subarray(0, control) : head
  let text: string
  let stopped = control >= 0
  try {
    // stream: a character cut off where decoding stops isn't an error, and isn't shown.
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: true })
  } catch {
    text = new TextDecoder().decode(bytes, { stream: true })
    const bad = text.indexOf('\ufffd')
    if (bad >= 0) text = text.slice(0, bad)
    stopped = true
  }
  let shown = text.length > maxChars ? text.slice(0, maxChars) : text
  // Never half of a character beyond the basic plane (an emoji): its first half alone shows as a broken one.
  if (/[\ud800-\udbff]$/.test(shown)) shown = shown.slice(0, -1)
  return {
    blocks: shown.split(/\r\n|\r|\n/).map((line) => ({ kind: 'para', runs: [{ text: line }] })),
    cut: stopped || shown.length < text.length || data.length > limit,
    pictures: 0,
    plain: true,
  }
}
