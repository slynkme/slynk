// Rows for what arrived: a file with its Save button, or a message blurred
// until revealed. The received screen (main.ts) and the uploads an inbox's
// owner collects (inbox/owner.ts) share them.
import type { Item } from '../payload'
import { photoInfo } from '../shrink/info'
import * as shrinkCopy from '../shrinkCopy'
import { safeName } from '../zip'
import { size } from './format'
import { detectKind } from '../strip/sniff'
import { drawAudioThumb, drawDocThumb, drawVideoThumb, showAudio, showDoc, showPhoto, showVideo, thumbFor, type ViewActions } from './photoView'
import { soundKind } from '../audio/read'
import { docPreviewOf } from '../docview'
import { isSvgPicture } from './svgPicture'
import { tip } from './tip'
import { SHARE, SHARE_FAILED, asFile, canShare, shareFile } from './share'
import { RECEIVED_SMALLER, RECEIVED_STRIPPED } from './cleaning'
import { linkedText, linksReachable, type LinkPlace } from './linkWarn'
import { saveBlob } from './save'
import { settings } from './settings'
import { showWarnings, warningsFor } from './fileWarn'

const part = (root: Element, name: string) => root.querySelector<HTMLElement>(`[data-part="${name}"]`)!
const clone = (template: string) => (document.getElementById(template) as HTMLTemplateElement).content.firstElementChild!.cloneNode(true) as HTMLElement

export const fileDetails = (item: Item) => `${size(item.data.length)}${item.type ? ' · ' + item.type : ''}`

/** Saves bytes as a download. The type is the sender's, already checked by decode(): nothing a browser would run. */
export function download(data: Uint8Array, name: string, type: string) {
  saveBlob(new Blob([data as BlobPart], { type: type || 'application/octet-stream' }), name)
}

/** Saves a received file under its cleaned-up name. */
export const saveFile = (item: Item) => download(item.data, safeName(item.name, 'slynk-file'), item.type)

/** A received file, with a Save button that calls save, and Share where the browser can share it (toast says if that failed). */
export function fileRow(item: Item, save: (item: Item, button: HTMLElement) => void, toast: (text: string) => void): HTMLElement {
  const li = clone('tpl-got-file')
  const name = item.name || 'Untitled file'
  part(li, 'name').textContent = name
  part(li, 'size').textContent = fileDetails(item)
  const said = part(li, 'stripped')
  said.textContent = item.smaller ? RECEIVED_SMALLER : RECEIVED_STRIPPED
  said.hidden = !item.stripped && !item.smaller
  const button = part(li, 'save')
  button.setAttribute('aria-label', `Save ${name}`)
  button.addEventListener('click', () => save(item, button))
  const file = asFile(item)
  const onShare = canShare(file) ? () => void shareFile(file).then((r) => r === 'failed' && toast(SHARE_FAILED)) : undefined
  const shareButton = part(li, 'share')
  shareButton.hidden = !onShare
  if (onShare) {
    shareButton.setAttribute('aria-label', SHARE(name))
    shareButton.title = SHARE(name)
    shareButton.addEventListener('click', onShare)
  }
  if (settings().photoPreviews) {
    if (photoInfo(item.data) || isSvgPicture(item.data) || isVideo(item.data) || docPreviewOf(item.data) || isAudio(item.data)) previewRow(li, item, name, { save: () => save(item, button), share: onShare })
    // PowerPoint or Excel, or LibreOffice's: its name says it can't be shown here.
    else if (docKindOf(item.data) === 'office') part(li, 'meta').addEventListener('click', () => tip(part(li, 'meta'), shrinkCopy.DOC_NO_PREVIEW_RECEIVED))
  }
  // What the file checks find, once they've read it.
  void warningsFor(item).then((warnings) => {
    showWarnings(part(li, 'warns'), warnings)
    part(li, 'more').hidden = !warnings.length
  })
  return li
}

const OFFICE = new Set(['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'rtf'])
/** A PDF, or a Word, PowerPoint, Excel, LibreOffice or RTF file, from its bytes. */
export function docKindOf(data: Uint8Array): 'pdf' | 'office' | null {
  try {
    const kind = detectKind(data)
    return kind === 'pdf' ? 'pdf' : kind && OFFICE.has(kind) ? 'office' : null
  } catch {
    return null
  }
}

/** A phone or camera video (MP4, MOV): one the viewer can try to play. */
export const isVideo = (data: Uint8Array) => ['mp4', 'mov'].includes(detectKind(data.subarray(0, 64)) ?? '')

/** Audio (MP3, M4A, WAV, FLAC, Ogg): one the viewer can try to play. An MP4 with only sound and a video's brand plays as a video. */
export const isAudio = (data: Uint8Array) => {
  const kind = soundKind(data)
  return !!kind && kind !== 'mp4'
}

/**
 * "Show photo, media and document previews": a photo or SVG drawing that arrived, small in place
 * of its icon, a still from a video, or audio's outline. The picture, or its name and size, open it
 * big (a video or audio plays), with a Save button that does what the row's does.
 * Nothing is drawn for one this browser can't open.
 */
function previewRow(li: HTMLElement, item: Item, name: string, actions: ViewActions) {
  const icon = part(li, 'icon')
  const thumb = part(li, 'thumb')
  thumb.setAttribute('aria-label', shrinkCopy.PREVIEW_RECEIVED(name))
  const video = isVideo(item.data)
  const audio = !video && isAudio(item.data)
  // A PDF, or a document shown as its text (RTF, 2026-10-24; Word and LibreOffice Writer, 2026-10-25).
  const doc = video || audio ? null : docPreviewOf(item.data)
  const open = () =>
    void (doc
      ? showDoc(name, item.data, doc, 'received', actions)
      : audio
        ? showAudio(name, item.data, item.type, 'received', actions)
        : (video ? showVideo : showPhoto)(name, item.data, item.type, 'received', actions))
  thumb.addEventListener('click', open)
  let tried = false // its small picture was drawn, or couldn't be
  part(li, 'meta').addEventListener('click', () => {
    if (li.classList.contains('previewable')) open()
    // One with nothing to show (a document of pictures only) says so, as a PowerPoint file's does, once that's known;
    // not a blank text file, which opening "in Word, Pages or another app" wouldn't help (the review, 2026-10-26).
    else if (tried && doc && doc !== 'pdf' && doc !== 'text') tip(part(li, 'meta'), shrinkCopy.DOC_NO_PREVIEW_RECEIVED)
  })
  const canvas = thumb.querySelector('canvas')!
  void (video ? drawVideoThumb(canvas, item.data, item.type) : audio ? drawAudioThumb(canvas, item.data) : doc ? drawDocThumb(canvas, item.data, doc) : thumbFor(canvas, item.data, item.type)).then((ok) => {
    tried = true
    thumb.hidden = !ok
    icon.classList.toggle('has-thumb', ok)
    li.classList.toggle('previewable', ok)
  })
}

/** What a file's Save button says once it has saved. */
export function markSaved(button: HTMLElement, item: Item) {
  button.textContent = 'Saved'
  button.setAttribute('aria-label', `Saved ${item.name || 'Untitled file'}. Save again`)
}

/**
 * A received message, blurred until revealed, with Copy and Hide. With a place, the web links
 * in it are links that ask first (linkWarn.ts).
 */
export function messageRow(item: Item, copy: (text: string) => void, place?: LinkPlace): HTMLElement {
  const li = clone('tpl-got-text')
  const secret = part(li, 'secret')
  const text = new TextDecoder().decode(item.data)
  if (place) part(li, 'text').replaceChildren(linkedText(text, place))
  else part(li, 'text').textContent = text
  setHidden(secret, true)
  part(li, 'reveal').addEventListener('click', () => setHidden(secret, false))
  part(li, 'hide').addEventListener('click', () => setHidden(secret, true))
  part(li, 'copy').addEventListener('click', () => copy(part(li, 'text').textContent ?? ''))
  return li
}

/** Blurs a message, or reveals it: its links can be reached with the Tab key only while it shows. */
export function setHidden(secret: HTMLElement, hidden: boolean) {
  secret.dataset.hidden = String(hidden)
  linksReachable(secret, !hidden)
}
