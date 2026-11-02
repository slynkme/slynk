// "Save all (.zip)": several received files saved as one zip, built here on
// the recipient's device (with fflate, fetched for every visit: preload.ts). Entries are
// stored as they are, since there's nothing to gain from compressing again,
// and every entry gets the same fixed date, so the zip says nothing about when
// or where it was made. The names come from the sender, so they're cleaned up
// first: no folders, no characters file systems refuse, no clashes.

import { fitName } from './payload.ts'
import { FILE_PREFIX } from './site.ts'

// Path separators, characters Windows refuses, control characters, and the
// invisible characters that can disguise a name: direction marks and
// overrides ("invoice" + U+202E + "fdp.exe" shows as "invoiceexe.pdf"), line
// separators and zero-width spaces. Joiners (U+200C/D) and variation
// selectors stay: emoji and some scripts need them.
const UNSAFE = /[/\\:*?"<>|\x00-\x1f\x7f-\x9f\u061c\u200b\u200e\u200f\u2028-\u202e\u2060-\u2064\u2066-\u206f\ufeff\ufff9-\ufffb]/g
const RESERVED = /^(con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3]|conin\$|conout\$)(\.|$)/i

/**
 * A file name that's safe to save and to show, or fallback when nothing usable
 * is left. Names are put in NFC form first, so two spellings of an accented
 * letter can't become two zip entries that a Mac treats as one file.
 */
export function safeName(name: string, fallback: string): string {
  let s = name
    .normalize('NFC')
    .replace(UNSAFE, '_')
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '')
  if (!s) s = fallback
  if (RESERVED.test(s) || s === '__proto__') s = '_' + s
  return fitName(s)
}

/** Makes names unique, ignoring case: "a.txt", "A.txt" → "a.txt", "A (2).txt". */
export function uniqueNames(names: string[]): string[] {
  const taken = new Set<string>()
  const enc = new TextEncoder()
  return names.map((name) => {
    let out = name
    if (taken.has(out.toLowerCase())) {
      const dot = name.lastIndexOf('.')
      const stem = dot > 0 ? name.slice(0, dot) : name
      const ext = dot > 0 ? name.slice(dot) : ''
      for (let n = 2; taken.has(out.toLowerCase()); n++) {
        const tail = ` (${n})${ext}`
        out = fitName(stem, 255 - enc.encode(tail).length) + tail
      }
    }
    taken.add(out.toLowerCase())
    return out
  })
}

/** slynk-YYYY-MM-DD.zip (site.ts FILE_PREFIX), by the recipient's own calendar. */
export function zipName(date: Date): string {
  const two = (n: number) => String(n).padStart(2, '0')
  return `${FILE_PREFIX}-${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}.zip`
}

/** Loads the zip code now, for every visitor (web/src/preload.ts). */
export function warmZip(): void {
  import('fflate').catch(() => {})
}

/** Zips the files. A message is a secret, so it never goes in, even if passed. */
export async function zipFiles(items: { kind?: 'file' | 'text'; name: string; data: Uint8Array }[]): Promise<Uint8Array> {
  const files = items.filter((f) => f.kind !== 'text')
  if (!files.length) throw new Error('there are no files to put in it')
  // Only the synchronous API: fflate's async one starts blob: workers, which the CSP blocks.
  const { zipSync } = await import('fflate')
  const names = uniqueNames(files.map((f, i) => safeName(f.name, `file-${i + 1}`)))
  const entries: Record<string, Uint8Array> = Object.create(null)
  names.forEach((name, i) => (entries[name] = files[i].data))
  // Zip dates are local time; 1 January 1980 is the earliest a zip can hold.
  return zipSync(entries, { level: 0, mtime: new Date(1980, 0, 1) })
}
