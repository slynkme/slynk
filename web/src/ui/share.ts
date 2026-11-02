// Sharing a file that arrived straight to another app, through the device's
// own share sheet (the Web Share API): on an iPhone, "Save Image" puts a photo
// in Photos, where Save puts it in Files; AirDrop and messaging apps are there
// too. Offered only where the browser says it can share that very file (Chrome
// on Android shares pictures, video, audio, text and PDFs, not zips), so nobody
// sees a button that does nothing. The file goes only to the app they pick.
import type { Item } from '../payload.ts'
import { FILE_PREFIX } from '../site.ts'
import { safeName } from '../zip.ts'

/** A received file as the share sheet takes it: its cleaned-up name, and its type. */
export function asFile(item: Item): File {
  return new File([item.data as BlobPart], safeName(item.name, `${FILE_PREFIX}-file`), { type: item.type || 'application/octet-stream' })
}

/** Whether this browser can share this file (nothing is shared by asking). */
export function canShare(file: File): boolean {
  try {
    return typeof navigator.share === 'function' && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })
  } catch {
    return false
  }
}

/** Opens the share sheet. Closing it without choosing an app isn't a failure. */
export async function shareFile(file: File): Promise<'shared' | 'cancelled' | 'failed'> {
  try {
    await navigator.share({ files: [file] })
    return 'shared'
  } catch (e) {
    return e instanceof DOMException && e.name === 'AbortError' ? 'cancelled' : 'failed'
  }
}

export const SHARE = (name: string) => `Share ${name}`
export const SHARE_ALL = 'Share all (.zip)'
export const SHARE_FAILED = 'Couldn’t share it. Save it instead.'
export const SHARE_ZIP_FAILED = 'This browser can’t share a .zip. Use Save all instead.'
