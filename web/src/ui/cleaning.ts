// What the composer does with the hidden-info stripper's verdict on a file:
// which bytes to send, the "Cleaned" chip and its list, or the line shown
// under the file.
import { SKIP } from '../strip/types.ts'
import type { Detail, StripResult } from '../stripHook.ts'
import { SITE_NAME } from '../site.ts'

export interface Choice {
  useOriginal: boolean // "Send original instead"
  sendAsIs: boolean // agreed to send a file that couldn't be cleaned
}

/**
 * The bytes to send, and whether they're the cleaned version (item flag bit 1),
 * or undefined while a file that couldn't be cleaned waits for the sender's answer.
 */
export function bytesToSend(
  original: Uint8Array,
  strip: StripResult | undefined,
  choice: Choice,
): { data: Uint8Array; stripped: boolean } | undefined {
  if (strip?.status === 'cleaned' && !choice.useOriginal) return { data: strip.bytes, stripped: true }
  if (strip?.status === 'failed' && !choice.sendAsIs) return undefined
  return { data: original, stripped: false }
}

/** The chip on a cleaned file, the end of its name for screen readers, and the heading of its list. */
/** Under a file that arrived: the sender's word, not proof (the About page says so; "Sender says" was dropped from the screen, 2026-10-17). */
export const RECEIVED_STRIPPED = 'Hidden details were removed'
/**
 * The same for a photo the sender's browser made smaller ("removed"
 * undersold that it was squeezed). No longer than the line above, so a phone's list
 * row grows no taller (2 lines at 375 px, 3 at 320).
 */
export const RECEIVED_SMALLER = 'Made smaller, no hidden details'

/** Beside the list's heading: opens Settings at "Remove hidden details from files", which covers every file. */
export const CHANGE_SETTING = 'Change in Settings'
/** In a smaller copy's list instead, in bold: the setting can't put anything back into a copy. */
export const COPY_HOLDS_NONE = 'A photo made smaller never contains hidden data.'
export const VIDEO_HOLDS_NONE = 'A video made smaller never contains hidden data.'
export const AUDIO_HOLDS_NONE = 'An audio file made smaller never contains hidden data.'

export function chipText(useOriginal: boolean): { chip: string; hint: string; title: string } {
  return useOriginal
    ? { chip: 'Not cleaned', hint: ': see what it still holds', title: 'Kept hidden data' }
    : { chip: 'Cleaned', hint: ': see what was removed', title: 'Removed hidden data' }
}

/**
 * One line of the chip's list: "GPS location" and ["12.34° N, 56.78° E"],
 * plus "and 2 more" when there were more values than it shows. The heading
 * says "hidden data", so a label like "title" can't read as the document's
 * visible title being removed.
 */
export function detailLine(d: Detail): { label: string; values: string[]; more: string } {
  const more = d.more < 0 ? 'and more' : d.more > 0 ? `and ${d.more} more` : ''
  return { label: d.label.charAt(0).toUpperCase() + d.label.slice(1), values: d.values, more }
}

/** Office's older files (sniff.ts tells them apart), with the app and the newer kind Slynk cleans. */
const OLDER_OFFICE: Record<string, [string, string]> = { doc: ['Word', '.docx'], xls: ['Excel', '.xlsx'], ppt: ['PowerPoint', '.pptx'] }

/** Files inside a zip that went as they were (strip/archive.ts), by what they are: one and many. */
const UNCHECKED: [string[], string, string][] = [
  [['pdf'], 'PDF', 'PDFs'],
  [['doc'], 'older Word file', 'older Word files'],
  [['xls'], 'older Excel file', 'older Excel files'],
  [['ppt'], 'older PowerPoint file', 'older PowerPoint files'],
  [['locked', 'locked-office'], 'password-protected file', 'password-protected files'],
  [['signed'], 'signed document', 'signed documents'],
  [['mov', 'mp4', '3gp', 'avi', 'mkv'], 'video', 'videos'],
  [['m4a', 'wav', 'ogg', 'aiff', 'aac'], 'audio file', 'audio files'],
  [['tiff', 'bmp', 'cr3'], 'picture', 'pictures'],
  [['svg'], 'drawing', 'drawings'],
  [['zip', 'gzip', '7z', 'rar', 'tar', 'ar', 'cpio'], 'zip or other archive', 'zips or other archives'],
  [['sidecar'], 'file describing a photo', 'files describing photos'],
  [['link'], 'shortcut to another file', 'shortcuts to other files'],
  [['failed'], 'file it couldn’t clean', 'files it couldn’t clean'],
]

/** "2 PDFs and 1 older Word file": what went unchecked inside a zip, or '' for nothing. */
export function uncheckedList(unchecked: Record<string, number> | undefined): string {
  const counts = new Map<number, number>()
  for (const [kind, n] of Object.entries(unchecked ?? {})) {
    let i = UNCHECKED.findIndex(([kinds]) => kinds.includes(kind))
    if (i === -1) i = UNCHECKED.length // anything else
    counts.set(i, (counts.get(i) ?? 0) + n)
  }
  const parts = [...counts.entries()]
    .sort(([a], [b]) => a - b)
    .map(([i, n]) => {
      const [, one, many] = UNCHECKED[i] ?? [[], 'other file', 'other files']
      return `${n} ${n === 1 ? one : many}`
    })
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : (parts[0] ?? '')
}

/**
 * The line under a file that wasn't cleaned, or under a zip whose files weren't all checked;
 * '' when there's nothing to say (a cleaned file shows its chip instead).
 */
export function cleaningNote(strip: StripResult | undefined, choice: Choice): string {
  if ((strip?.status === 'cleaned' && !choice.useOriginal) || strip?.status === 'unchanged') {
    const list = uncheckedList(strip.unchecked)
    return list ? `Some files inside weren’t checked for hidden data, so they go as they are: ${list}.` : ''
  }
  if (strip?.status === 'skipped') return strip.reason
  if (strip?.status === 'failed' && choice.sendAsIs) return 'Couldn’t clean its hidden data, so it goes as it is'
  if (strip?.status === 'unsupported' && strip.kind && Object.hasOwn(OLDER_OFFICE, strip.kind)) {
    const [app, newer] = OLDER_OFFICE[strip.kind]
    return `${SITE_NAME} can’t check older ${app} files for hidden data, so it goes as it is. Save it as ${newer} to have it cleaned.`
  }
  // A password-protected Word, Excel or PowerPoint file.
  if (strip?.status === 'unsupported' && strip.kind === 'locked-office') return SKIP.encrypted
  // An SVG drawing written in a way the cleaner can't be sure of reading (strip/svgscan.ts).
  if (strip?.status === 'unsupported' && strip.kind === 'svg') return `${SITE_NAME} can’t read this drawing to check it for hidden data, so it goes as it is`
  // Plain text has nowhere to keep hidden data; anything else unrecognised might.
  if (strip?.status === 'unsupported' && strip.kind !== 'text') return `${SITE_NAME} can’t check this kind of file for hidden data, so it goes as it is`
  return ''
}

/** PDF readers accept the "%PDF-" header anywhere in the first 1024 bytes. */
export function isPdf(data: Uint8Array): boolean {
  const head = data.subarray(0, 1024)
  for (let i = head.indexOf(0x25); i >= 0 && i + 5 <= head.length; i = head.indexOf(0x25, i + 1)) {
    if (head[i + 1] === 0x50 && head[i + 2] === 0x44 && head[i + 3] === 0x46 && head[i + 4] === 0x2d) return true
  }
  return false
}
