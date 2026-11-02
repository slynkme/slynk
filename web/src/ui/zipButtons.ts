// "Save all (.zip)" and "Share all (.zip)" for files that arrived together:
// the received screen (main.ts) and an inbox owner's collected uploads
// (inbox/owner.ts) share them, so a fork with INBOX_FILES on gets the same.
import type { Item } from '../payload'
import { zipFiles, zipName } from '../zip'
import { download } from './items'
import { SHARE_ALL, SHARE_ZIP_FAILED, canShare, shareFile } from './share'

export const SAVE_ALL = 'Save all (.zip)'
export const MAKING_ZIP = 'Making the zip…'
export const SAVED_ZIP = 'Saved · save again'
export const ZIP_FAILED = (reason: string) => `Couldn’t make the zip: ${reason}`
/** Under the buttons when messages came with the files. */
export const ZIP_NOTE = (messages: number) => `The zip holds the files only, not the ${messages === 1 ? 'message' : 'messages'}.`

export interface ZipButtons {
  /** Offers both for what arrived (two or more files), or neither. */
  show(items: Item[]): void
  /** Takes them away, and the zip made for sharing with them. */
  clear(): void
}

/**
 * Wires a Save all button, a Share all button and the note under them. The
 * zip Share all hands over is made as soon as the files show and kept ready:
 * a share must follow its tap at once, and Safari refused even a wait for an
 * already-made zip (on a Mac, 2026-10-17). Until it's ready,
 * the button waits. Share all shows only where the browser takes that very
 * zip: Chrome said yes to an empty one, then refused the real thing (it
 * shares pictures, video, audio, text and PDFs).
 */
export function zipButtons(save: HTMLButtonElement, share: HTMLButtonElement, note: HTMLElement, toast: (text: string) => void): ZipButtons {
  let files: Item[] = []
  let zipToShare: File | undefined
  let zipRun = 0 // bumps when what arrived changes, so a zip made for earlier files is dropped
  let zipping = false
  share.setAttribute('aria-label', SHARE_ALL)
  share.title = SHARE_ALL

  save.addEventListener('click', async () => {
    const these = files
    if (these.length < 2 || zipping) return
    zipping = true
    save.disabled = true
    save.textContent = MAKING_ZIP
    try {
      const zip = await zipFiles(these)
      if (files === these) {
        download(zip, zipName(new Date()), 'application/zip')
        save.textContent = SAVED_ZIP
      }
    } catch (e) {
      save.textContent = SAVE_ALL
      toast(ZIP_FAILED(e instanceof Error ? e.message : String(e)))
    } finally {
      zipping = false
      save.disabled = false
    }
  })

  share.addEventListener('click', () => {
    const zip = zipToShare
    if (!zip) return
    // Straight from the tap, nothing awaited first. If it's refused all the same, the
    // browser won't share a zip: say so, and take the button away.
    void shareFile(zip).then((r) => {
      if (r !== 'failed') return
      share.hidden = true
      toast(SHARE_ZIP_FAILED)
    })
  })

  function clear() {
    files = []
    zipToShare = undefined
    zipRun++
    save.hidden = true
    share.hidden = true
    note.hidden = true
  }

  function show(items: Item[]) {
    clear()
    files = items.filter((i) => i.kind === 'file')
    const messages = items.length - files.length
    const several = files.length > 1
    save.hidden = !several
    save.textContent = SAVE_ALL
    note.hidden = !several || !messages
    note.textContent = ZIP_NOTE(messages)
    const zipShareable = several && canShare(new File([], 'slynk.zip', { type: 'application/zip' }))
    share.hidden = !zipShareable
    share.disabled = true
    if (!zipShareable) return
    const run = zipRun
    zipFiles(files)
      .then((zip) => {
        if (run !== zipRun) return
        const file = new File([zip as BlobPart], zipName(new Date()), { type: 'application/zip' })
        if (!canShare(file)) return void (share.hidden = true)
        zipToShare = file
        share.disabled = false
      })
      .catch(() => {
        if (run === zipRun) share.hidden = true // Save all still makes the zip, and says if it can't
      })
  }

  return { show, clear }
}
