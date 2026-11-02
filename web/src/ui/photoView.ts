// "Show photo, media and document previews": a photo, video or audio as it will be sent, small
// in the file list and big in a viewer, so the sender can judge a smaller one
// before it goes; and one that arrived, so the recipient can look before
// saving it. Photos are drawn on canvases from the bytes in this tab's memory
// (the CSP allows no blob: pictures), fitted to the screen or zoomed in (one of
// its pixels to one of the page's), panned by scrolling. A video's small
// picture is a still taken in the video worker (video/client.ts); the viewer
// plays it from a blob: address the CSP allows for media only (media-src
// blob:), let go of as the viewer closes, with controls of its own (an
// iPhone's darken the whole picture while they show) over a still from it. A PDF
// (2026-10-22) is drawn page by page by pdf.js (pdfView.ts), one
// page at a time, with arrows on its sides. An RTF (2026-10-24), Word or
// LibreOffice Writer document (2026-10-25) is read for its text and shown as a
// simplified page (docview/). Audio (2026-10-25) shows as its
// outline (a waveform), drawn from its sound, which fills in as it plays in
// the browser's own player, from a blob: address as a video's is; small, the
// same outline as a few bars. An SVG drawing (2026-10-26) is drawn by the
// browser as a picture, on white, at a size it can draw quickly (svgPicture.ts).
// Nothing is stored or sent.
import { audioOutline } from '../audio/page'
import { fitDims, longEdge, type Dims } from '../shrink/plan'
import { readDoc, type DocPreview } from '../docview'
import { hasText } from '../docview/model'
import { docElements, drawTextThumb } from '../docview/render'
import * as shrinkCopy from '../shrinkCopy'
import { size } from './format'
import { drawPage, openPdf, type OpenPdf } from './pdfView'
import { stillInWorker } from '../video/client'
import { SHARE } from './share'
import { closeSvg, drawSize, isSvgPicture, openSvg } from './svgPicture'
import { decodeHeic } from '../heic/decode'

/** Phones refuse much bigger canvases. Copies are 2048 at most, so only a photo going at full size can be over. */
const MAX_VIEW_EDGE = 4096
/** An SVG drawing's longer side in the viewer, where it can be drawn that big quickly: sharp on a phone when fitted. */
const SVG_VIEW_EDGE = 2048
/** A PDF page's width in the viewer: sharp on a phone when fitted, readable when zoomed in. */
const PDF_PAGE_WIDTH = 1600
/** The small picture's side in CSS pixels (the file icon's). */
const THUMB = 36

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T

/** A decoded photo: a bitmap, or a canvas for a HEIC the browser opened with its video decoder (heic/decode.ts). */
type Decoded = ImageBitmap | HTMLCanvasElement

/**
 * The photo decoded, and its own size, upright. thumbnail: for a small picture, the shorter side it needs (a HEIC's
 * own small picture will do if it's that big); or else it's for the viewer. A HEIC is decoded no bigger than that needs.
 */
async function decode(data: Uint8Array, type: string, thumbnail?: number): Promise<{ picture: Decoded; own: Dims }> {
  try {
    // Every current browser turns the photo upright by default, as it will look to the recipient.
    const bitmap = await createImageBitmap(new Blob([data as BlobPart], { type }))
    return { picture: bitmap, own: { width: bitmap.width, height: bitmap.height } }
  } catch (e) {
    // A HEIC away from Apple's browsers: their own HEVC video decoder, where they have one.
    const scale = (d: Dims) => (thumbnail ? thumbnail / Math.min(d.width, d.height) : MAX_VIEW_EDGE / longEdge(d))
    const heic = await decodeHeic(data, { thumbnail, scale })
    if (heic) return { picture: heic.canvas, own: heic.size }
    throw e
  }
}

function closeDecoded(d: Decoded) {
  if (d instanceof HTMLCanvasElement) releaseThumb(d)
  else d.close()
}

/** The small picture's side in the canvas's pixels. */
const thumbSide = () => Math.round(THUMB * Math.min(3, window.devicePixelRatio || 1))

/** Draws the photo small and square onto canvas; false if this browser can't open it (e.g. HEIC where there's no HEVC decoder). An SVG drawing too. */
export async function drawThumb(canvas: HTMLCanvasElement, data: Uint8Array, type: string): Promise<boolean> {
  if (isSvgPicture(data)) return drawSvgThumb(canvas, data)
  let bitmap: Decoded
  try {
    bitmap = (await decode(data, type, thumbSide())).picture
  } catch {
    return false
  }
  return drawSquare(canvas, bitmap)
}

/**
 * Draws an SVG drawing small onto canvas, whole and in the middle, on white: a logo or an icon
 * cropped as a photo is would lose its edges. False if it's too costly to draw, or can't be read.
 */
async function drawSvgThumb(canvas: HTMLCanvasElement, data: Uint8Array): Promise<boolean> {
  const picture = await openSvg(data)
  if (!picture) return false
  try {
    const side = Math.round(THUMB * Math.min(3, window.devicePixelRatio || 1))
    const at = await drawSize(picture, Math.round(side * 0.84))
    const ctx = at && canvas.getContext('2d')
    if (!at || !ctx) return false
    canvas.width = side
    canvas.height = side
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, side, side)
    ctx.drawImage(picture.img, (side - at.width) / 2, (side - at.height) / 2, at.width, at.height)
    return true
  } finally {
    closeSvg(picture)
  }
}

/** Draws a still from the video small and square onto canvas; false if this browser can't read it. */
export async function drawVideoThumb(canvas: HTMLCanvasElement, data: Uint8Array, type: string): Promise<boolean> {
  const bitmap = await stillInWorker(new Blob([data as BlobPart], { type: type || 'video/mp4' }))
  return bitmap ? drawSquare(canvas, bitmap) : false
}

/** The picture on the canvas, square and small, cropped as photo apps' grids do; the bitmap is let go of. */
function drawSquare(canvas: HTMLCanvasElement, bitmap: Decoded): boolean {
  try {
    const side = thumbSide()
    canvas.width = side
    canvas.height = side
    const ctx = canvas.getContext('2d')
    if (!ctx) return false
    ctx.imageSmoothingQuality = 'high'
    // Fill the square, cropping the longer side, as photo apps' grids do.
    const s = Math.max(side / bitmap.width, side / bitmap.height)
    const w = bitmap.width * s
    const h = bitmap.height * s
    ctx.drawImage(bitmap, (side - w) / 2, (side - h) / 2, w, h)
    return true
  } finally {
    closeDecoded(bitmap)
  }
}

/** The bars drawn for audio whose own outline isn't known (FLAC, Ogg, or one this browser can't decode): an icon, not its sound. */
const PLAIN_OUTLINE = [0.35, 0.6, 0.9, 0.55, 0.8, 0.45, 0.3]

/**
 * Draws an audio file's outline small and square onto canvas, as a few bars:
 * from peaks the worker worked out for audio it made, or else from its sound
 * decoded in the worker, or else plain bars, an icon. Always true: the player
 * itself says whether this browser can play it.
 */
export async function drawAudioThumb(canvas: HTMLCanvasElement, data: Uint8Array, peaks?: number[]): Promise<boolean> {
  const outline = peaks ?? (await audioOutline(data)) ?? PLAIN_OUTLINE
  const side = Math.round(THUMB * Math.min(3, window.devicePixelRatio || 1))
  canvas.width = side
  canvas.height = side
  const ctx = canvas.getContext('2d')
  if (!ctx) return false
  const bars = 7
  const gap = side / (bars * 2 + 1)
  ctx.fillStyle = colour('--accent', '#8b7bff')
  for (let i = 0; i < bars; i++) {
    const loud = loudest(outline, i / bars, (i + 1) / bars)
    const h = Math.max(gap, side * 0.62 * (0.15 + 0.85 * loud))
    const x = gap * (1 + 2 * i)
    roundBar(ctx, x, (side - h) / 2, gap, h)
  }
  return true
}

/** The loudest of an outline's points between two places along it (0 to 1). */
function loudest(outline: number[], from: number, to: number): number {
  const a = Math.floor(from * outline.length)
  const b = Math.max(a + 1, Math.ceil(to * outline.length))
  let v = 0
  for (let i = a; i < b && i < outline.length; i++) v = Math.max(v, outline[i])
  return v
}

function roundBar(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  const r = Math.min(w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.fill()
}

/** A colour from the style sheet's tokens (light or dark), for drawing on a canvas. */
function colour(token: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(token).trim() || fallback
}

/** Draws the top of a PDF's first page small and square onto canvas; false if pdf.js can't open it (damaged, or locked). */
export async function drawPdfThumb(canvas: HTMLCanvasElement, data: Uint8Array): Promise<boolean> {
  let open: OpenPdf | undefined
  try {
    open = await openPdf(data)
    const side = Math.round(THUMB * Math.min(3, window.devicePixelRatio || 1))
    await drawPage(open.doc, 1, canvas, side, side)
    return true
  } catch {
    return false
  } finally {
    open?.close()
  }
}

/** A document's small picture: a PDF's first page, or the first lines of another's text. False if it can't be read, or has no text. */
export async function drawDocThumb(canvas: HTMLCanvasElement, data: Uint8Array, kind: DocPreview): Promise<boolean> {
  if (kind === 'pdf') return drawPdfThumb(canvas, data)
  try {
    return drawTextThumb(canvas, readDoc(data, kind, 2000), Math.round(THUMB * Math.min(3, window.devicePixelRatio || 1)))
  } catch {
    return false
  }
}

let queue: Promise<unknown> = Promise.resolve()
/** drawThumb, one picture at a time (each decodes a whole photo), for a list drawn all at once. */
export function thumbFor(canvas: HTMLCanvasElement, data: Uint8Array, type: string): Promise<boolean> {
  const next = queue.then(() => drawThumb(canvas, data, type))
  queue = next.catch(() => {})
  return next.catch(() => false)
}

/** Lets go of a small picture's pixels (a row removed, or previews turned off). */
export function releaseThumb(canvas: HTMLCanvasElement) {
  canvas.width = 0
  canvas.height = 0
}

const dialog = () => $<HTMLDialogElement>('photo-view')
let shown: Dims | undefined // the canvas's size, while open
let pdf: { open: OpenPdf; page: number; pages: number; about: (page: number) => string; drawing: number } | undefined // a PDF in the viewer, while open
let playing: string | undefined // the blob: address of the video in the viewer, while open
let videoFrame = 0 // the frame that keeps a playing video's bar in step
let hearing: { url: string; outline: number[]; frame: number } | undefined // audio in the viewer, while open
let actual = false
let save: (() => void) | undefined // the open photo's Save, for one that arrived
let share: (() => void) | undefined // and its Share, where the browser can share it

/** What the viewer offers for a photo that arrived, beside Zoom. */
export interface ViewActions {
  save?: () => void
  share?: () => void
  /**
   * In the composer, the bytes it goes as, compressed, as its row says ("186 bytes → 146 bytes"): what
   * "As it will be sent" counts. Otherwise its own size.
   */
  sent?: number
}

/** Sizes the canvas on the page: fitted inside the viewer, or zoomed in, one pixel to one. */
function layout() {
  if (!shown) return
  const body = $('pv-body')
  const canvas = $<HTMLCanvasElement>('pv-canvas')
  const s = actual ? 1 : Math.min(1, body.clientWidth / shown.width, body.clientHeight / shown.height)
  canvas.style.width = `${Math.max(1, Math.floor(shown.width * s))}px`
  canvas.style.height = `${Math.max(1, Math.floor(shown.height * s))}px`
  body.classList.toggle('actual', actual)
  $('pv-zoom').textContent = actual ? shrinkCopy.VIEW_FIT : shrinkCopy.VIEW_ZOOM
}

/** Switches between fitted and zoomed in, keeping the point at (x, y) on the canvas in view. */
function toggle(at?: { x: number; y: number }) {
  if (!shown) return
  const canvas = $<HTMLCanvasElement>('pv-canvas')
  const body = $('pv-body')
  const rect = canvas.getBoundingClientRect()
  // Where on the photo, as a share of its width and height (the middle unless tapped).
  const fx = at ? (at.x - rect.left) / rect.width : 0.5
  const fy = at ? (at.y - rect.top) / rect.height : 0.5
  actual = !actual
  layout()
  if (actual) {
    body.scrollLeft = fx * shown.width - body.clientWidth / 2
    body.scrollTop = fy * shown.height - body.clientHeight / 2
  }
}

/**
 * The page behind the viewer stays put while it's open (seen on an iPhone, 2026-10-25): a
 * swipe on a photo or page that fits the screen, with nothing of its own to scroll, scrolled the
 * page underneath, and closing the viewer left them somewhere else. The style sheet holds the page
 * while the viewer is open (html:has(#photo-view[open]), so nothing can leave it held), and where
 * it was is put back as the viewer closes, in case a browser scrolled it anyway.
 */
let pageY: number | undefined
function show(d: HTMLDialogElement) {
  if (d.open) return
  pageY = window.scrollY
  d.showModal()
}
function putPageBack() {
  if (pageY !== undefined && Math.abs(window.scrollY - pageY) >= 1) window.scrollTo({ top: pageY, behavior: 'instant' })
  pageY = undefined
}

let wired = false
function wire() {
  if (wired) return
  wired = true
  const d = dialog()
  // Lets go of the photo's pixels (a 2048-pixel photo is 16 MB) as the viewer closes. Not from
  // its close event: that comes a moment later, after a photo opened again quickly (blanking
  // it), or not at all when Chrome folds it into the next close.
  const release = () => {
    shown = undefined
    save = undefined
    share = undefined
    releaseThumb($<HTMLCanvasElement>('pv-canvas'))
    stopVideo()
    stopAudio()
    closePdf()
    $('pv-doc').replaceChildren()
    putPageBack()
  }
  d.querySelector('[data-close]')!.addEventListener('click', () => {
    d.close()
    release()
  })
  d.addEventListener('cancel', release) // Escape
  // Closed some other way (Chrome closes on a second Escape or Back without a cancel): the page goes
  // back all the same, unless the viewer has opened again meanwhile.
  d.addEventListener('close', () => {
    if (d.open) return
    // A video or audio mustn't go on playing out of sight, its address still held.
    stopVideo()
    stopAudio()
    putPageBack()
  })
  $('pv-zoom').addEventListener('click', () => toggle())
  $('pv-save').addEventListener('click', () => save?.())
  $('pv-share').addEventListener('click', () => share?.())
  $('pv-canvas').addEventListener('click', (e) => toggle({ x: e.clientX, y: e.clientY }))
  for (const [id, label] of [['pv-prev', shrinkCopy.VIEW_PREV], ['pv-next', shrinkCopy.VIEW_NEXT]]) {
    $(id).setAttribute('aria-label', label)
    $(id).title = label
  }
  $('pv-prev').addEventListener('click', () => void turn(-1))
  $('pv-next').addEventListener('click', () => void turn(1))
  // Arrow keys turn a PDF's pages, unless zoomed in, where they scroll.
  d.addEventListener('keydown', (e) => {
    if (!pdf || actual || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return
    e.preventDefault()
    void turn(e.key === 'ArrowLeft' ? -1 : 1)
  })
  window.addEventListener('resize', () => {
    if (!actual) layout()
    drawWave()
  })
  // Audio: tapping or dragging along its outline goes to that moment, and plays from there if it
  // wasn't playing. It starts as the finger lifts: Safari lets sound
  // start only then, and a drag to find the moment doesn't set it going before it's found.
  const wave = $<HTMLCanvasElement>('pv-wave')
  let playOnLift = false
  const seek = (e: PointerEvent) => {
    const audio = $<HTMLAudioElement>('pv-audio')
    const rect = wave.getBoundingClientRect()
    if (!hearing || !(audio.duration > 0) || !Number.isFinite(audio.duration) || !rect.width) return
    audio.currentTime = nearEnd(Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)) * audio.duration, audio.duration)
    drawWave()
  }
  wave.addEventListener('pointerdown', (e) => {
    wave.setPointerCapture(e.pointerId)
    playOnLift = !!hearing && $<HTMLAudioElement>('pv-audio').paused
    seek(e)
  })
  wave.addEventListener('pointermove', (e) => {
    if (wave.hasPointerCapture(e.pointerId)) seek(e)
  })
  wave.addEventListener('pointerup', () => {
    if (!playOnLift || !hearing) return
    playOnLift = false
    $<HTMLAudioElement>('pv-audio')
      .play()
      .catch(() => {}) // the player's own button still works
  })
  wave.addEventListener('pointercancel', () => (playOnLift = false))
  // A video: tap the picture to play or pause; the play button over it, the one in its bar; and its bar,
  // tapped or dragged, goes to that moment and plays from there, as audio's outline does.
  const video = () => $<HTMLVideoElement>('pv-video')
  const playPause = () => {
    const v = video()
    if (!playing) return
    if (v.paused || v.ended) void v.play().catch(() => {})
    else v.pause()
  }
  $('pv-stage').addEventListener('click', (e) => {
    if (e.target === $('pv-vbig') || $('pv-vbig').contains(e.target as Node)) return
    playPause()
  })
  $('pv-vbig').addEventListener('click', playPause)
  $('pv-vplay').addEventListener('click', playPause)
  // The big button is for a finger or a mouse; keyboards and screen readers have the bar's.
  $('pv-vbig').title = shrinkCopy.VIEW_PLAY
  $('pv-vfull').setAttribute('aria-label', shrinkCopy.VIEW_FULL)
  $('pv-vfull').title = shrinkCopy.VIEW_FULL
  $('pv-vtrack').setAttribute('aria-label', shrinkCopy.VIEW_POSITION)
  const track = $('pv-vtrack')
  let playAfterSeek = false
  const seekVideo = (e: PointerEvent) => {
    const v = video()
    const rect = track.getBoundingClientRect()
    const length = lengthOf(v)
    if (!playing || !length || !rect.width) return
    v.currentTime = nearEnd(Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)) * length, length)
    syncVideo()
  }
  track.addEventListener('pointerdown', (e) => {
    track.setPointerCapture(e.pointerId)
    playAfterSeek = !!playing && video().paused
    seekVideo(e)
  })
  track.addEventListener('pointermove', (e) => {
    if (track.hasPointerCapture(e.pointerId)) seekVideo(e)
  })
  track.addEventListener('pointerup', () => {
    if (!playAfterSeek || !playing) return
    playAfterSeek = false
    void video()
      .play()
      .catch(() => {})
  })
  track.addEventListener('pointercancel', () => (playAfterSeek = false))
  // As a slider: arrow keys move it five seconds, Page Up and Down a tenth of it, Home and End to either end.
  track.addEventListener('keydown', (e) => {
    const v = video()
    const length = lengthOf(v)
    if (!playing || !length) return
    const at = v.currentTime
    const to = { ArrowLeft: at - 5, ArrowDown: at - 5, ArrowRight: at + 5, ArrowUp: at + 5, PageDown: at - length / 10, PageUp: at + length / 10, Home: 0, End: length }[e.key]
    if (to === undefined) return
    e.preventDefault()
    v.currentTime = Math.min(length, Math.max(0, to))
    syncVideo()
  })
  // Full screen: the video with its bar where the browser can; on an iPhone, its own full-screen player.
  $('pv-vfull').addEventListener('click', () => {
    const box = $('pv-video-box')
    if (document.fullscreenEnabled && box.requestFullscreen) void box.requestFullscreen().catch(() => {})
    else (video() as HTMLVideoElement & { webkitEnterFullscreen?: () => void }).webkitEnterFullscreen?.()
  })
  // The theme changed (Settings, or the device's, applied as <html data-theme>): the outline's colours follow.
  new MutationObserver(() => drawWave()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
}

/**
 * Opens the viewer on a photo: name, bytes and type, what it is (about to be
 * sent as a smaller copy or at full size, or received), and for one that
 * arrived, how to save it. False if this browser can't open it.
 */
export async function showPhoto(name: string, data: Uint8Array, type: string, kind: shrinkCopy.ViewKind, actions: ViewActions = {}): Promise<boolean> {
  wire()
  stopVideo()
  stopAudio()
  closePdf()
  mode('photo')
  if (isSvgPicture(data)) return showSvg(name, data, kind, actions)
  let bitmap: Decoded
  let own: Dims
  try {
    ;({ picture: bitmap, own } = await decode(data, type))
  } catch {
    return false
  }
  const d = dialog()
  const canvas = $<HTMLCanvasElement>('pv-canvas')
  try {
    // From what was decoded: a HEIC is already no bigger than the viewer needs.
    const at = fitDims({ width: bitmap.width, height: bitmap.height }, MAX_VIEW_EDGE)
    canvas.width = at.width
    canvas.height = at.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return false
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bitmap, 0, 0, at.width, at.height)
    shown = at
    $('pv-title').textContent = name
    $('pv-about').textContent = shrinkCopy.VIEW_ABOUT(own, size(actions.sent ?? data.length), kind)
    offer(name, actions)
  } finally {
    closeDecoded(bitmap)
  }
  actual = false
  show(d)
  layout()
  $('pv-title').focus() // as for the other dialogs: the title, not the first button
  return true
}

/**
 * An SVG drawing in the viewer, as a photo is: drawn on white, as big as it can be drawn quickly
 * (svgPicture.ts), fitted or zoomed in. False if it's too costly to draw, or can't be read.
 */
async function showSvg(name: string, data: Uint8Array, kind: shrinkCopy.ViewKind, actions: ViewActions): Promise<boolean> {
  const picture = await openSvg(data)
  if (!picture) return false
  const canvas = $<HTMLCanvasElement>('pv-canvas')
  try {
    const at = await drawSize(picture, SVG_VIEW_EDGE)
    const ctx = at && canvas.getContext('2d')
    if (!at || !ctx) return false
    canvas.width = at.width
    canvas.height = at.height
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, at.width, at.height)
    ctx.drawImage(picture.img, 0, 0, at.width, at.height)
    shown = at
    $('pv-title').textContent = name
    $('pv-about').textContent = shrinkCopy.VIEW_ABOUT_SVG(size(actions.sent ?? data.length), kind)
    offer(name, actions)
  } finally {
    closeSvg(picture)
  }
  actual = false
  show(dialog())
  layout()
  $('pv-title').focus()
  return true
}

/** The viewer's Save and Share, for one that arrived. */
function offer(name: string, actions: ViewActions) {
  save = actions.save
  $('pv-save').hidden = !save
  $('pv-save').setAttribute('aria-label', shrinkCopy.VIEW_SAVE(name))
  $('pv-save').title = shrinkCopy.VIEW_SAVE(name)
  share = actions.share
  $('pv-share').hidden = !share
  $('pv-share').setAttribute('aria-label', SHARE(name))
  $('pv-share').title = SHARE(name)
}

/** A photo on the canvas, with Zoom; a PDF's page there too, with its page buttons; a video in the player; audio's outline and player; or a document's text. */
function mode(what: 'photo' | 'video' | 'pdf' | 'doc' | 'audio') {
  $('pv-canvas').hidden = what === 'video' || what === 'doc' || what === 'audio'
  $('pv-zoom').hidden = what === 'video' || what === 'doc' || what === 'audio'
  $('pv-video-box').hidden = what !== 'video'
  $('pv-audio-box').hidden = what !== 'audio'
  $('pv-doc').hidden = what !== 'doc'
  if (what !== 'doc') $('pv-doc').replaceChildren()
  $('pv-body').classList.toggle('doc', what === 'doc')
  // What a screen reader heard last for a PDF's page doesn't linger for anything else.
  if (what !== 'pdf') $('pv-page').textContent = ''
  // One page or many: the arrows only where there's another page to go to.
  const pages = what === 'pdf' && !!pdf && pdf.pages > 1
  $('pv-prev').hidden = !pages
  $('pv-next').hidden = !pages
}

/** Lets go of the PDF in the viewer, if any. */
function closePdf() {
  const open = pdf?.open
  pdf = undefined
  open?.close()
}

/** Draws page n of the PDF in the viewer, fitted again, and says which page it is. */
async function drawPdfPage(n: number) {
  const p = pdf
  if (!p) return
  const run = ++p.drawing
  p.page = n
  $('pv-page').textContent = p.pages > 1 ? shrinkCopy.VIEW_PAGE(n, p.pages) : ''
  $<HTMLButtonElement>('pv-prev').disabled = n <= 1
  $<HTMLButtonElement>('pv-next').disabled = n >= p.pages
  $('pv-about').textContent = p.about(n)
  // Drawn off screen, then swapped in: the page shown stays until the next is ready.
  const off = document.createElement('canvas')
  try {
    const at = await drawPage(p.open.doc, n, off, PDF_PAGE_WIDTH, MAX_VIEW_EDGE)
    if (pdf !== p || run !== p.drawing) return
    const canvas = $<HTMLCanvasElement>('pv-canvas')
    canvas.width = at.width
    canvas.height = at.height
    canvas.getContext('2d')?.drawImage(off, 0, 0)
    shown = at
    actual = false
    layout()
    $('pv-body').scrollTo(0, 0)
  } catch {
    // A page pdf.js can't draw keeps the last one shown; Previous and Next still work.
  } finally {
    releaseThumb(off)
  }
}

/** The next or previous page of the PDF in the viewer. */
async function turn(by: number) {
  if (!pdf) return
  const n = Math.min(pdf.pages, Math.max(1, pdf.page + by))
  if (n !== pdf.page) await drawPdfPage(n)
}

/**
 * Opens the viewer on a PDF, at its first page: as it will be sent (made
 * smaller, or as it is) or one that arrived, and for one that arrived, how to
 * save it. False if pdf.js can't open it (damaged, or locked with a password).
 */
export async function showPdf(name: string, data: Uint8Array, kind: shrinkCopy.ViewKind, actions: ViewActions = {}): Promise<boolean> {
  wire()
  stopVideo()
  stopAudio()
  closePdf()
  let open: OpenPdf
  try {
    open = await openPdf(data)
  } catch {
    return false
  }
  const pages = open.doc.numPages
  pdf = { open, page: 1, pages, about: (n) => shrinkCopy.VIEW_ABOUT_PDF(n, pages, size(actions.sent ?? data.length), kind), drawing: 0 }
  mode('pdf')
  $('pv-title').textContent = name
  offer(name, actions)
  const d = dialog()
  show(d)
  await drawPdfPage(1)
  $('pv-title').focus()
  return true
}

/**
 * Opens the viewer on a document: a PDF page by page, or another's text as a
 * simplified page (as it will be sent, or one that arrived), and for one that
 * arrived, how to save it. False if it can't be read, or has no text to show.
 */
export async function showDoc(name: string, data: Uint8Array, which: DocPreview, kind: shrinkCopy.ViewKind, actions: ViewActions = {}): Promise<boolean> {
  if (which === 'pdf') return showPdf(name, data, kind, actions)
  wire()
  stopVideo()
  stopAudio()
  closePdf()
  let doc
  try {
    doc = readDoc(data, which)
  } catch {
    return false
  }
  if (!hasText(doc)) return false
  mode('doc')
  const page = document.createElement('div')
  page.className = 'doc-page'
  for (const el of docElements(doc)) page.append(el)
  const parts: HTMLElement[] = [page]
  // Plain text is shown as it is: nothing simplified to say so of.
  if (!doc.plain) {
    const note = document.createElement('p')
    note.className = 'doc-note'
    note.textContent = shrinkCopy.DOC_SIMPLIFIED(doc.pictures)
    parts.unshift(note)
  }
  if (doc.cut) {
    const cut = document.createElement('p')
    cut.className = 'doc-note'
    cut.textContent = shrinkCopy.DOC_CUT
    parts.push(cut)
  }
  $('pv-doc').replaceChildren(...parts)
  shown = undefined
  actual = false
  $('pv-title').textContent = name
  $('pv-about').textContent = shrinkCopy.VIEW_ABOUT_DOC(size(actions.sent ?? data.length), kind, !!doc.plain)
  offer(name, actions)
  const d = dialog()
  show(d)
  $('pv-body').scrollTo(0, 0)
  $('pv-title').focus()
  return true
}

/** A video's length in seconds, or 0 while unknown (or endless, as some recordings say they are). */
const lengthOf = (video: HTMLVideoElement) => (video.duration > 0 && Number.isFinite(video.duration) ? video.duration : 0)

/** A moment tapped at the very end goes a tenth of a second before it: at the end, playing would start again from the beginning. */
const nearEnd = (at: number, length: number) => Math.min(at, Math.max(0, length - 0.1))

/** Stops the video in the viewer, if any, and lets go of its bytes' address and its cover's pixels. */
function stopVideo() {
  const video = $<HTMLVideoElement>('pv-video')
  video.pause()
  video.removeAttribute('src')
  video.removeAttribute('poster')
  video.load() // drops what the player holds
  if (playing) URL.revokeObjectURL(playing)
  playing = undefined
  cancelAnimationFrame(videoFrame)
  if (document.fullscreenElement === $('pv-video-box')) void document.exitFullscreen().catch(() => {})
}

/**
 * A new player for each video, in place of the last (as audio's: a player reused can keep the
 * last one's state), without the browser's own controls: the viewer's are its own.
 */
function freshVideo(): HTMLVideoElement {
  const video = document.createElement('video')
  video.id = 'pv-video'
  video.playsInline = true // in the page, not straight to an iPhone's full-screen player
  video.preload = 'metadata'
  for (const event of ['play', 'pause', 'ended', 'timeupdate', 'seeked', 'loadedmetadata', 'durationchange', 'error']) video.addEventListener(event, () => syncVideo())
  video.addEventListener('play', () => followVideo())
  $('pv-video').replaceWith(video)
  return video
}

/**
 * The controls as the video stands: playing or not, how far through, and the time. The bar's fill
 * moves every frame; its words change only when they do, so a screen reader isn't told each frame.
 */
function syncVideo() {
  const video = $<HTMLVideoElement>('pv-video')
  const going = !!playing && !video.paused && !video.ended && !video.error
  $('pv-video-box').classList.toggle('playing', going)
  const label = going ? shrinkCopy.VIEW_PAUSE : shrinkCopy.VIEW_PLAY
  if ($('pv-vplay').title !== label) {
    $('pv-vplay').setAttribute('aria-label', label)
    $('pv-vplay').title = label
  }
  const length = lengthOf(video)
  const at = Math.min(length, video.currentTime || 0)
  $('pv-vfill').style.width = `${length ? (at / length) * 100 : 0}%`
  const time = length ? `${shrinkCopy.clock(at)} / ${shrinkCopy.clock(length)}` : ''
  if ($('pv-vtime').textContent === time) return
  $('pv-vtime').textContent = time
  const track = $('pv-vtrack')
  track.setAttribute('aria-valuemax', String(Math.round(length)))
  track.setAttribute('aria-valuenow', String(Math.round(at)))
  track.setAttribute('aria-valuetext', time)
}

/** Keeps the bar in step while the video plays (timeupdate comes only a few times a second). */
function followVideo() {
  cancelAnimationFrame(videoFrame)
  const tick = () => {
    const video = $<HTMLVideoElement>('pv-video')
    if (!playing || video.paused || video.ended || video.error) return
    syncVideo()
    videoFrame = requestAnimationFrame(tick)
  }
  videoFrame = requestAnimationFrame(tick)
}

/**
 * A still from the start of the video as its cover until it plays, from the video worker, as its small
 * picture is (an iPhone shows a dark frame otherwise). A data: picture, which the CSP allows.
 */
async function coverFor(data: Uint8Array, type: string, url: string) {
  // Skipped when its turn comes if the viewer has moved on: it may wait behind a video being made smaller.
  const bitmap = await stillInWorker(new Blob([data as BlobPart], { type: type || 'video/mp4' }), 0, 1280, () => playing === url)
  if (!bitmap) return
  try {
    if (playing !== url) return
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0)
    const cover = canvas.toDataURL('image/jpeg', 0.9)
    releaseThumb(canvas)
    if (playing === url) $<HTMLVideoElement>('pv-video').poster = cover
  } finally {
    bitmap.close()
  }
}

/**
 * Opens the viewer on a video, with the viewer's own controls: as it will be
 * sent (made smaller, or as it is) or one that arrived. Its size in pixels is
 * said once the player knows it. False if this browser can't play it.
 */
export async function showVideo(name: string, data: Uint8Array, type: string, kind: shrinkCopy.ViewKind, actions: ViewActions = {}): Promise<boolean> {
  wire()
  stopVideo()
  stopAudio()
  closePdf()
  releaseThumb($<HTMLCanvasElement>('pv-canvas'))
  shown = undefined
  mode('video')
  const video = freshVideo()
  const url = URL.createObjectURL(new Blob([data as BlobPart], { type: type || 'video/mp4' }))
  playing = url
  const ready = new Promise<boolean>((resolve) => {
    const done = (ok: boolean) => {
      video.removeEventListener('loadedmetadata', yes)
      video.removeEventListener('error', no)
      resolve(ok)
    }
    const yes = () => done(true)
    const no = () => done(false)
    video.addEventListener('loadedmetadata', yes)
    video.addEventListener('error', no)
  })
  video.src = url
  if (!(await ready) || playing !== url) {
    if (playing === url) stopVideo()
    return false
  }
  $('pv-title').textContent = name
  $('pv-about').textContent = shrinkCopy.VIEW_ABOUT({ width: video.videoWidth, height: video.videoHeight }, size(actions.sent ?? data.length), kind)
  offer(name, actions)
  $('pv-vfull').hidden = !document.fullscreenEnabled && !('webkitEnterFullscreen' in video)
  syncVideo()
  void coverFor(data, type, url)
  const d = dialog()
  show(d)
  $('pv-title').focus()
  return true
}

/** Stops the audio in the viewer, if any, and lets go of its bytes' address. */
function stopAudio() {
  const audio = $<HTMLAudioElement>('pv-audio')
  audio.pause()
  audio.removeAttribute('src')
  audio.load()
  if (hearing) {
    cancelAnimationFrame(hearing.frame)
    URL.revokeObjectURL(hearing.url)
  }
  hearing = undefined
  releaseThumb($<HTMLCanvasElement>('pv-wave'))
}

/**
 * A new player for each audio file, in place of the last: Safari's own controls, given a
 * new file in a player that had been playing, kept showing Pause (on an iPhone,
 * 2026-10-25), though it had been stopped. Its outline follows it as it plays.
 */
function freshPlayer(): HTMLAudioElement {
  const audio = document.createElement('audio')
  audio.id = 'pv-audio'
  audio.controls = true
  audio.preload = 'metadata'
  for (const event of ['timeupdate', 'seeked', 'loadedmetadata', 'ended']) audio.addEventListener(event, () => drawWave())
  audio.addEventListener('play', () => followWave())
  $('pv-audio').replaceWith(audio)
  return audio
}

/** What the viewer says of audio made smaller: its bitrate and channels. */
export interface AudioMade {
  bitrate: number
  channels: number
}

/**
 * Opens the viewer on an audio file: its outline, and the browser's
 * own player, as it will be sent (made smaller, or as it is) or one that
 * arrived. peaks: its outline, when the worker made it; otherwise it's drawn
 * flat and filled in once worked out. False if this browser can't play it
 * (not when another opened meanwhile: that one says for itself).
 */
export async function showAudio(name: string, data: Uint8Array, type: string, kind: shrinkCopy.ViewKind, actions: ViewActions = {}, made?: AudioMade, peaks?: number[]): Promise<boolean> {
  wire()
  stopVideo()
  stopAudio()
  closePdf()
  releaseThumb($<HTMLCanvasElement>('pv-canvas'))
  shown = undefined
  const audio = freshPlayer()
  const url = URL.createObjectURL(new Blob([data as BlobPart], { type: type || 'audio/mpeg' }))
  const mine = { url, outline: peaks ?? [], frame: 0 }
  hearing = mine
  const ready = new Promise<boolean>((resolve) => {
    const done = (ok: boolean) => {
      audio.removeEventListener('loadedmetadata', yes)
      audio.removeEventListener('error', no)
      resolve(ok)
    }
    const yes = () => done(true)
    const no = () => done(false)
    audio.addEventListener('loadedmetadata', yes)
    audio.addEventListener('error', no)
  })
  audio.src = url
  const ok = await ready
  if (hearing !== mine) return true
  if (!ok) {
    stopAudio()
    return false
  }
  if (!peaks)
    void audioOutline(data).then((outline) => {
      if (hearing !== mine || !outline) return
      mine.outline = outline
      drawWave()
    })
  mode('audio')
  $('pv-title').textContent = name
  $('pv-about').textContent = shrinkCopy.VIEW_ABOUT_AUDIO(audio.duration, size(actions.sent ?? data.length), kind, made)
  offer(name, actions)
  const d = dialog()
  show(d)
  drawWave()
  $('pv-title').focus()
  return true
}

/** Redraws the audio's outline: the part played so far in the accent colour, the rest faint. */
function drawWave() {
  const canvas = $<HTMLCanvasElement>('pv-wave')
  if (!hearing || canvas.offsetParent === null) return
  const audio = $<HTMLAudioElement>('pv-audio')
  const ratio = Math.min(3, window.devicePixelRatio || 1)
  const width = Math.max(1, Math.round(canvas.clientWidth * ratio))
  const height = Math.max(1, Math.round(canvas.clientHeight * ratio))
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width
    canvas.height = height
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, width, height)
  const outline = hearing.outline
  const played = audio.duration > 0 ? audio.currentTime / audio.duration : 0
  const bar = 3 * ratio
  const step = 5 * ratio
  const count = Math.max(1, Math.floor((width + step - bar) / step))
  const accent = colour('--accent', '#8b7bff')
  const faint = colour('--muted', '#9aa0b5')
  for (let i = 0; i < count; i++) {
    const loud = outline.length ? loudest(outline, i / count, (i + 1) / count) : 0.2
    const h = Math.max(bar, height * (0.08 + 0.92 * loud))
    ctx.fillStyle = (i + 0.5) / count <= played ? accent : faint
    ctx.globalAlpha = (i + 0.5) / count <= played ? 1 : 0.45
    roundBar(ctx, i * step, (height - h) / 2, bar, h)
  }
  ctx.globalAlpha = 1
}

/** Keeps the outline in step while it plays (timeupdate comes only a few times a second). */
function followWave() {
  const h = hearing
  if (!h) return
  cancelAnimationFrame(h.frame)
  const tick = () => {
    const audio = $<HTMLAudioElement>('pv-audio')
    if (hearing !== h || audio.paused) return
    drawWave()
    h.frame = requestAnimationFrame(tick)
  }
  h.frame = requestAnimationFrame(tick)
}
