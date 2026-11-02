// Scanning an inbox's QR code, from the open inbox's New message
// step: a sheet with the camera's picture, or a photo for a computer without
// a camera or a refused permission. A code that holds an inbox's address goes
// straight on, as "Write to it" does; anything else says so.
//
// The picture never leaves the page. A few times a second the square in the
// middle of the camera's picture is drawn to a canvas and handed to a worker
// of the sheet's own (scanWorker.ts), which reads it and drops it; nothing is
// recorded, kept or sent. The camera stops (every track) the moment the sheet
// closes, an inbox's code is read, a photo is chosen instead, or the page goes
// out of sight, and the worker ends with the sheet. The page asks for the camera
// only from the tap on the camera button, and .htaccess allows it to this
// site's own page only (Permissions-Policy camera=(self)).
import { checkCanvas } from '../shrink/draw'
import { photoInfo } from '../shrink/info'
import { MAX_PIXELS } from '../shrink/plan'
import { addressFromInput } from './address'
import { $ } from './dom'
import * as copy from './inboxCopy'
import type { ScanRequest, ScanResponse } from './scanRead'
import type { SCAN_READY } from './scanRead'

/** The pause between reads of the camera's picture: a few a second, which keeps a phone cool. */
const READ_EVERY_MS = 120
/**
 * Every other read takes the middle square in full detail, up to this many
 * pixels a side: a quantum-safe address's code has four times the squares of
 * a compact one's, too fine for the usual 640 unless it fills the
 * picture. The camera is asked for a picture big enough (1920 × 1080).
 */
const FINE_SIDE = 1080
/** After this long with no code read, the line suggests coming closer (on an iPhone, moving back), or a photo. */
const HARD_AFTER_MS = 8000
/**
 * An iPhone or iPad (iPadOS says it's a Mac, with touch): their main camera can't focus close up in
 * a web page (the iPhone's own Camera switches lens; a page can't), so a code held near is blurred,
 * worst for a quantum-safe address's detailed one (seen on an iPhone, 2026-10-19: it read only from
 * well back, while Android was fine). The frame is smaller there, so it's held further away, and
 * the hint says to move back rather than come closer.
 */
const IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1)
/** How long "isn't an inbox's address" stays once that code has left the picture. */
const NOT_INBOX_MS = 3000
/** The sizes a photo is read at, smaller first: quick for most, and the full detail for a small code in a big photo. */
const PHOTO_SIZES = [1280, 2560]
/** Enough of a photo's start to find its size without decoding it. */
const PHOTO_HEAD = 1 << 20
/** A read that takes longer has failed (a worker out of memory may never say so). */
const READ_TIMEOUT_MS = 20_000
/** How long "Inbox found" shows, with the camera already off, before the sheet goes on. */
const FOUND_MS = 900
/** A reader that hasn't said it's ready by then hasn't started; the pause before the one more try. */
const START_TIMEOUT_MS = 10_000
const START_RETRY_MS = 600

/**
 * What the sheet says that depends on what it's scanning for: an inbox's address (New message, the
 * address check), or any link (a local copy's "Received a Slynk link?", ui/localLinks.ts).
 */
export interface ScanWords {
  point: string
  notIt: string
  found: string
  pick: string
  broken: string
  failed: string
}

const INBOX_WORDS: ScanWords = {
  point: copy.SCAN_POINT,
  notIt: copy.SCAN_NOT_INBOX,
  found: copy.SCAN_FOUND,
  pick: copy.SCAN_PHOTO_PICK,
  broken: copy.SCAN_BROKEN,
  failed: copy.SCAN_FAILED,
}

interface Scan {
  /** What a code says, if it's what's wanted: what to do with it, once the sheet has said so. */
  accept: (text: string) => (() => void) | undefined
  words: ScanWords
  closed: boolean
  /** "Use a photo instead" was pressed: the camera stays off. */
  photo: boolean
  /** Counts the photos chosen, so a slow one can't speak over the next. */
  photos: number
  /** The page can't read pictures here, or the reader failed: nothing more starts. */
  broken: boolean
  /** An inbox's code was read: the sheet says so, then goes on. */
  done: boolean
  stream?: MediaStream
  worker?: Worker
  /** The reader being started: resolves once it says it's ready, or undefined if it never does. */
  starting?: Promise<Worker | undefined>
  /** Readers that failed after starting: after two, the sheet gives up rather than start them forever. */
  crashes: number
  timer?: ReturnType<typeof setTimeout>
  waiting?: { id: number; resolve: (text: Read) => void }
  nextId: number
  notInboxUntil: number
  reads: number // of the camera's picture: every other one in full detail
  since: number // when the camera's picture first came, to suggest a photo after a while
}

/** A code's text, undefined for none, or false when the reader failed or took too long. */
type Read = string | undefined | false

let current: Scan | undefined
let canvas: HTMLCanvasElement | undefined
let wired = false

const sheet = () => $<HTMLDialogElement>('scan')
const video = () => $<HTMLVideoElement>('scan-video')

/** The square in the middle of the camera's picture, as the sheet shows it, and the size it's read at. */
function middleSquare(width: number, height: number, most = 640) {
  const side = Math.min(width, height)
  return { x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), side, out: Math.min(side, most) }
}

/** A photo's size to read it at, keeping its shape. */
function fitWithin(width: number, height: number, most: number) {
  const scale = Math.min(1, most / Math.max(width, height))
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

/** The sheet's line: what to do, how it's going, or what went wrong. */
function say(text: string, bad = false) {
  const line = $('scan-line')
  if (line.textContent !== text) line.textContent = text // the same text again isn't announced again
  line.classList.toggle('scan-bad', bad)
}

/**
 * How the sheet looks: the camera's picture while it's starting or on, and
 * which way to a photo (the main button once the camera can't be used, none
 * when the browser won't let the page read pictures at all).
 */
function show(mode: 'camera' | 'photo' | 'photo-first' | 'found' | 'none') {
  const view = $('scan-view')
  view.hidden = mode !== 'camera' && mode !== 'found'
  view.classList.toggle('found', mode === 'found')
  view.classList.toggle('ios', IOS)
  const photo = $('scan-photo')
  photo.hidden = mode === 'none' || mode === 'found'
  photo.classList.toggle('grad-btn', mode === 'photo-first')
}

function stopCamera(s: Scan) {
  clearTimeout(s.timer)
  s.timer = undefined
  for (const track of s.stream?.getTracks() ?? []) track.stop()
  s.stream = undefined
  const v = video()
  v.pause()
  v.srcObject = null
}

/** Ends the scan: the camera, the reading and the worker. Safe to call more than once. */
function end() {
  const s = current
  if (!s) return
  current = undefined
  s.closed = true
  stopCamera(s)
  s.worker?.terminate()
  s.worker = undefined
  s.starting = undefined
  s.waiting?.resolve(undefined)
  s.waiting = undefined
  if (canvas) canvas.width = canvas.height = 0 // its pixels go too
  $<HTMLInputElement>('scan-file').value = ''
  document.removeEventListener('visibilitychange', onHidden)
  window.removeEventListener('pagehide', closeScan)
  window.removeEventListener('popstate', closeScan)
  window.removeEventListener('hashchange', closeScan)
}

/** Closes the sheet, if it's open, and stops everything it started. */
export function closeScan() {
  const d = sheet()
  if (d.open) d.close()
  end()
}

// Out of sight, the camera goes, and the sheet with it. Not while a photo is being chosen: the
// camera is already off, and a phone's photo picker sends the page out of sight until it's back.
function onHidden() {
  if (document.visibilityState === 'hidden' && !current?.photo) closeScan()
}

/** The browser won't let the page read pictures (some privacy settings), or the reader failed: no way on from here. */
function broken(s: Scan, why = s.words.broken) {
  s.broken = true
  stopCamera(s)
  show('none')
  say(why, true)
}

function cameraFailed(s: Scan, err: unknown) {
  stopCamera(s)
  show('photo-first')
  const name = err instanceof DOMException ? err.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') say(copy.SCAN_REFUSED, true)
  else if (name === 'NotFoundError' || name === 'OverconstrainedError') say(copy.SCAN_NO_CAMERA, true)
  else say(copy.SCAN_CAMERA_FAILED, true)
}

/**
 * Starts the reader and waits until it says it has loaded. On an iPhone a worker can fail to start
 * the first time and work the next (seen on 2026-10-19: scanning failed once straight away, with
 * the same reader file that had worked; the password check's worker did the same on 2026-10-15), so
 * a reader that errs or stays silent is ended and one more is started.
 */
function startWorker(s: Scan): Promise<Worker | undefined> {
  if (s.worker) return Promise.resolve(s.worker)
  s.starting ??= (async () => {
    for (let tries = 0; tries < 2; tries++) {
      if (tries) await new Promise((r) => setTimeout(r, START_RETRY_MS))
      if (s.closed) return undefined
      const w = await launch(s)
      if (w) return w
    }
    return undefined
  })()
  return s.starting
}

/** One reader, ready, or undefined if it errs or says nothing in time. */
function launch(s: Scan): Promise<Worker | undefined> {
  return new Promise((resolve) => {
    let w: Worker
    try {
      w = new Worker(new URL('./scanWorker.ts', import.meta.url), { type: 'module' })
    } catch {
      return resolve(undefined)
    }
    const timer = setTimeout(() => {
      w.terminate()
      resolve(undefined)
    }, START_TIMEOUT_MS)
    w.onerror = (e) => {
      e.preventDefault()
      clearTimeout(timer)
      w.terminate()
      resolve(undefined)
    }
    w.onmessage = (e: MessageEvent<ScanResponse | typeof SCAN_READY>) => {
      if (!('ready' in e.data)) return
      clearTimeout(timer)
      if (s.closed) {
        w.terminate()
        return resolve(undefined)
      }
      running(s, w)
      resolve(w)
    }
  })
}

/** A reader that has started: its answers, and a failure later on, after which the next read starts another. */
function running(s: Scan, w: Worker) {
  s.worker = w
  w.onmessage = (e: MessageEvent<ScanResponse>) => {
    if (s.waiting?.id !== e.data.id) return
    const { resolve } = s.waiting
    s.waiting = undefined
    resolve(e.data.text)
  }
  w.onerror = (e) => {
    e.preventDefault()
    w.terminate()
    if (s.worker === w) {
      s.worker = undefined
      s.starting = undefined
    }
    s.waiting?.resolve(false)
    s.waiting = undefined
    if (++s.crashes >= 2 && !s.closed) broken(s, s.words.failed)
  }
}

/** Reads a picture in the worker, one at a time. A worker that takes too long is ended; the next read starts another. */
async function read(s: Scan, image: ImageData, invert: boolean): Promise<Read> {
  if (s.closed || s.broken) return undefined
  const worker = await startWorker(s)
  if (s.closed || s.broken) return undefined
  if (!worker) {
    // Twice it didn't start: most likely a tab left open across an update, whose old reader file has gone.
    broken(s, s.words.failed)
    return false
  }
  s.waiting?.resolve(undefined) // a read of the camera's picture, overtaken by a photo
  return new Promise((resolve) => {
    const id = s.nextId++
    s.waiting = { id, resolve }
    setTimeout(() => {
      if (s.waiting?.id !== id) return
      s.waiting = undefined
      worker.terminate()
      if (s.worker === worker) {
        s.worker = undefined
        s.starting = undefined
      }
      resolve(false)
    }, READ_TIMEOUT_MS)
    const msg: ScanRequest = { id, width: image.width, height: image.height, data: image.data, invert }
    worker.postMessage(msg, [image.data.buffer])
  })
}

/** A 2D canvas of this size to read pixels back from. */
function context(width: number, height: number): CanvasRenderingContext2D {
  canvas ??= document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas.getContext('2d', { willReadFrequently: true })!
}

/**
 * What a code said: what's wanted (an inbox's address, or a link) goes on, after a moment that
 * says so (the camera already off); anything else says it isn't one.
 */
function decoded(s: Scan, text: string): boolean {
  const go = s.accept(text)
  if (go) {
    s.done = true
    stopCamera(s)
    show('found')
    say(s.words.found)
    // Closing the sheet now (Cancel, Escape, out of sight) ends this too: it goes nowhere.
    s.timer = setTimeout(() => {
      if (s.closed) return
      closeScan()
      go()
    }, FOUND_MS)
    return true
  }
  say(s.words.notIt, true)
  s.notInboxUntil = Date.now() + NOT_INBOX_MS
  return false
}

/** Reads the camera's picture again after a pause, until a code is read or the sheet closes. */
function next(s: Scan) {
  s.timer = setTimeout(async () => {
    const v = video()
    if (s.closed || !s.stream) return
    if (v.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !v.videoWidth) return next(s)
    const sq = middleSquare(v.videoWidth, v.videoHeight, s.reads++ % 2 ? FINE_SIDE : 640)
    s.since ||= Date.now()
    const ctx = context(sq.out, sq.out)
    ctx.drawImage(v, sq.x, sq.y, sq.side, sq.side, 0, 0, sq.out, sq.out)
    const text = await read(s, ctx.getImageData(0, 0, sq.out, sq.out), false)
    if (s.closed || !s.stream) return
    if (text && decoded(s, text)) return
    if (!text && Date.now() > s.notInboxUntil) say(Date.now() - s.since > HARD_AFTER_MS ? (IOS ? copy.SCAN_HARD_IOS : copy.SCAN_HARD) : s.words.point)
    next(s)
  }, READ_EVERY_MS)
}

async function startCamera(s: Scan, media: Promise<MediaStream> | undefined, canvasWorks: Promise<boolean>) {
  let stream: MediaStream
  try {
    if (!media) throw new DOMException('No camera here', 'NotFoundError')
    stream = await media
  } catch (err) {
    if (!s.closed && !s.photo) cameraFailed(s, err)
    return
  }
  // Closed, switched to a photo, or broken while the browser was asking: stop it at once.
  if (s.closed || s.photo || s.broken) {
    for (const track of stream.getTracks()) track.stop()
    return
  }
  s.stream = stream
  if (!(await canvasWorks)) return void (s.closed || broken(s))
  if (s.closed || s.broken || s.stream !== stream) return
  const v = video()
  // A computer's own camera faces the visitor: shown as in a mirror, as they'd expect. Read as it comes.
  v.classList.toggle('mirror', stream.getVideoTracks()[0]?.getSettings().facingMode !== 'environment')
  v.srcObject = stream
  v.play().catch(() => {}) // muted and inline, so it plays; reading waits for its first picture anyway
  for (const track of stream.getVideoTracks()) {
    track.addEventListener('ended', () => {
      if (!s.closed && s.stream === stream) cameraFailed(s, new DOMException('The camera stopped', 'NotReadableError'))
    })
  }
  say(s.words.point)
  next(s)
}

async function readPhoto(s: Scan, file: File) {
  const run = ++s.photos
  const stale = () => s.closed || s.broken || s.done || s.photos !== run
  say(copy.SCAN_PHOTO_READING)
  if (!(await checkCanvas())) return void (stale() || broken(s))
  let bitmap: ImageBitmap
  try {
    // Its size first, from its header, as the composer does: a huge photo isn't opened at all,
    // since decoding one takes 4 bytes a pixel, more than a phone's tab can spare.
    const dims = photoInfo(new Uint8Array(await file.slice(0, PHOTO_HEAD).arrayBuffer()))?.dims
    if (stale()) return
    if (dims && dims.width * dims.height > MAX_PIXELS) return say(copy.SCAN_PHOTO_BIG, true)
    bitmap = await createImageBitmap(file)
  } catch {
    if (!stale()) say(copy.SCAN_PHOTO_FAILED, true)
    return
  }
  try {
    for (const most of PHOTO_SIZES) {
      if (stale()) return
      const { width, height } = fitWithin(bitmap.width, bitmap.height, most)
      const ctx = context(width, height)
      ctx.drawImage(bitmap, 0, 0, width, height)
      const text = await read(s, ctx.getImageData(0, 0, width, height), true)
      if (stale()) return
      if (text === false) return say(copy.SCAN_PHOTO_FAILED, true)
      if (text) return void decoded(s, text)
      if (width === bitmap.width && height === bitmap.height) break // read at its full size already
    }
    say(copy.SCAN_PHOTO_NONE, true)
  } finally {
    bitmap.close()
  }
}

function wire() {
  if (wired) return
  wired = true
  const d = sheet()
  // The close event comes a moment after closing (Escape, say): by then the sheet may be open
  // again, with a new scan that's not this one to end.
  d.addEventListener('close', () => d.open || end())
  d.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeScan))
  d.addEventListener('click', (e) => {
    if (e.target === d) closeScan() // click on the backdrop
  })
  const file = $<HTMLInputElement>('scan-file')
  $('scan-photo').addEventListener('click', () => {
    const s = current
    if (!s || s.done) return
    // A photo instead: the camera goes off now, not when the sheet closes.
    s.photo = true
    stopCamera(s)
    show('photo-first')
    say(s.words.pick)
    file.click()
  })
  file.addEventListener('change', () => {
    const picked = file.files?.[0]
    file.value = ''
    if (current && !current.done && picked) void readPhoto(current, picked)
  })
}

/** Opens the sheet; found hears an inbox's address read from a code. From a tap: the camera starts from it. */
/** Opens the sheet to scan an inbox's QR code; found gets its address. */
export function openScan(found: (address: Uint8Array) => void) {
  openScanFor(addressFromInput, found, INBOX_WORDS)
}

/** Opens the sheet to scan a code that read() accepts; found gets what it made of it. */
export function openScanFor<T>(read: (text: string) => T | undefined, found: (value: T) => void, words: ScanWords) {
  wire()
  const d = sheet()
  if (d.open) return
  end()
  const accept = (text: string) => {
    const value = read(text)
    return value === undefined ? undefined : () => found(value)
  }
  const s: Scan = { accept, words, closed: false, photo: false, photos: 0, broken: false, done: false, nextId: 1, notInboxUntil: 0, reads: 0, since: 0, crashes: 0 }
  current = s
  // Asked for straight from the tap: Safari wants the camera started by the visitor's own action.
  let media: Promise<MediaStream> | undefined
  try {
    media = navigator.mediaDevices?.getUserMedia({
      audio: false,
      video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
    })
  } catch (err) {
    media = Promise.reject(err)
  }
  const canvasWorks = checkCanvas()
  void startWorker(s) // ready by the camera's first picture
  show('camera')
  say(copy.SCAN_STARTING)
  document.addEventListener('visibilitychange', onHidden)
  window.addEventListener('pagehide', closeScan)
  window.addEventListener('popstate', closeScan)
  window.addEventListener('hashchange', closeScan)
  d.showModal()
  // The title takes the focus, not the close button: Safari rings a button focused on opening.
  $('scan-title').focus()
  void startCamera(s, media, canvasWorks)
}
