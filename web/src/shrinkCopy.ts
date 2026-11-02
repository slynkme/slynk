// The words for making photos smaller ("copy", which suggested a duplicate
// going somewhere, became "made smaller" and "smaller version" on
// 2026-10-17). Screens stay plain: how a copy is made, and what it keeps, is
// explained on the About page ("How does Slynk make photos smaller?").
import type { DocMeasure } from './docshrink/types.ts'
import type { Dims } from './shrink/plan.ts'
import { SITE_NAME } from './site.ts'
import { size } from './ui/format.ts'

/** Under the meter, when it's too large and some of it is photos. Nothing's measured yet, so no promise it'll fit. */
export const OFFER = (n: number) =>
  n === 1
    ? `${SITE_NAME} can make your photo smaller to help it fit. Only the smaller version is sent.`
    : `${SITE_NAME} can make your photos smaller to help them fit. Only the smaller versions are sent.`

export const OFFER_BUTTON = (n: number) => (n === 1 ? 'Make it smaller' : 'Make them smaller')

export const WORKING = (done: number, total: number) =>
  total === 1 ? 'Making your photo smaller…' : done ? `Making your photos smaller… ${done} of ${total}` : 'Making your photos smaller…'

/** Even the smallest copies don't fit: fit of n photos would, or fitLower at a lower quality. */
export function NO_FIT(fit: number, n: number, fitLower = fit): string {
  if (n === 1 || !fitLower) {
    const what = n === 1 ? 'its smallest, this photo doesn’t' : 'their smallest, these photos don’t'
    return `Even at ${what} fit with everything else. Remove something to make room.`
  }
  // Which ones to remove is the sender's choice: the count assumes the smallest stay.
  const lower = fitLower > fit ? `, or ${fitLower} at a lower quality` : ''
  return `Even at their smallest, ${fit ? `only ${fit}` : 'none'} of these ${n} photos fit${lower}. Remove some to make room.`
}

/**
 * The same with "Make photos smaller to fit" on, where the lower quality is
 * already Slynk's call: fit of n would fit at it, so say how many must go
 * (at least: the count keeps the photos that shrink smallest). One number,
 * since "or 16 at a lower quality" was one the sender couldn't act on.
 */
export function NO_FIT_AUTO(fit: number, n: number): string {
  if (n === 1 || !fit) return NO_FIT(0, n)
  return `Even at their smallest, only ${fit} of these ${n} photos fit. Remove at least ${n - fit} to make room.`
}

/** They don't fit, but would at a lower quality: fit of n fit as they are. */
export function LOWER(fit: number, n: number): string {
  if (n === 1) return 'Even at its smallest, this photo doesn’t fit with everything else. At a lower quality it can, though it may look a little blocky up close.'
  const now = fit ? `only ${fit} of these ${n} photos fit` : 'these photos don’t fit with everything else'
  return `Even at their smallest, ${now}. At a lower quality all ${n} can, though they may look a little blocky up close.`
}

/** Documents (with no photos to lower) don't fit even at their smallest, but would at a lower quality. */
export function LOWER_DOCS(n: number): string {
  if (n === 1) return 'Even at its smallest, this document doesn’t fit with everything else. At a lower quality it can, though its pictures may look a little blocky up close.'
  return 'Even at their smallest, these documents don’t fit with everything else. At a lower quality they can, though their pictures may look a little blocky up close.'
}

export const LOWER_BUTTON = 'Lower the quality'

/** Under the meter once copies fit and another photo would too: more are welcome, and they'll get copies without asking. */
export const ROOM = `Add more photos if you like: ${SITE_NAME} will fit them in.`

/**
 * Under the meter once Slynk has made copies by itself ("Make photos smaller
 * to fit", on by default). room: another photo would fit too. lowered: some
 * went below the usual quality (each row says which). AUTO_OFF is the link to
 * that setting, and ends the sentence.
 */
export function AUTO(room: boolean, lowered = false): string {
  if (lowered) return `${SITE_NAME} made your photos smaller and lowered the quality to fit. For full size,`
  return room ? `${SITE_NAME} made your photos smaller to fit, and there’s room for more. For full size,` : `${SITE_NAME} made your photos smaller to fit. For full size,`
}
// Was "turn this off", while the setting was a switch (three choices since 2026-10-26).
export const AUTO_OFF = 'choose “Ask first” in Settings'

/** The browser handed back a blank picture (Tor Browser, strict privacy settings). */
export const BLOCKED = `Your browser stopped ${SITE_NAME} from making it smaller, as some privacy settings do. If it asks, allow it, then try again.`
export const TRY_AGAIN = 'Try again'

/** On the photo's row. Each size stays on one line, so a phone breaks before "(was". */
const dims = (d: Dims) => `${d.width}\u00a0×\u00a0${d.height}`
export function COPY_NOTE(to: Dims, from: Dims, lower = false): string {
  const what = `Made smaller${lower ? ', lower quality' : ''}: ${dims(to)}\u00a0pixels`
  const same = to.width === from.width && to.height === from.height
  return same ? `${what}, saved at a lower quality` : `${what} (was\u00a0${dims(from)})`
}
export const USE_FULL = 'Send full size instead'
/** After a photo's size on its row, when it goes as it is (no copy): "5.74 MB · full size". */
export const SIZE_FULL = 'full size'

/** "Show photo previews": the small picture's label, and the big view's. */
export const PREVIEW = (name: string) => `See ${name} as it will be sent`
/** The same for a photo that arrived. */
export const PREVIEW_RECEIVED = (name: string) => `See ${name}`
/** What the viewer shows: a smaller copy or the photo at full size, about to be sent (it says which, so nobody wonders whether it's the original), or a photo that arrived. */
export type ViewKind = 'copy' | 'full' | 'received'
export function VIEW_ABOUT(d: Dims, bytes: string, kind: ViewKind): string {
  if (kind === 'received') return `Received: ${dims(d)}\u00a0pixels, ${bytes}`
  return `As it will be sent: ${kind === 'copy' ? 'made smaller' : 'full size'}, ${dims(d)}\u00a0pixels, ${bytes}`
}
/** The viewer's save button, for a photo that arrived. */
export const VIEW_SAVE = (name: string) => `Save ${name}`
/** One of the photo's pixels to one of the page's. Not "Actual size": that read as the original's size. */
export const VIEW_ZOOM = 'Zoom in'
export const VIEW_FIT = 'Fit to screen'
export const VIEW_CANT = 'This browser can’t show this photo.'
/** A PDF in the viewer (pdf.js, 2026-10-22): which page, and what it is, as for a photo. */
export const VIEW_PAGE = (n: number, pages: number) => `Page ${n} of ${pages}`
export const VIEW_PREV = 'Previous page'
export const VIEW_NEXT = 'Next page'
/**
 * Under the PDF's name: which page, since its page buttons sit on the page's sides (on an
 * iPhone, 2026-10-24: at the bottom, a first tap only brought back the browser's toolbar).
 */
export function VIEW_ABOUT_PDF(page: number, pages: number, bytes: string, kind: ViewKind): string {
  const at = pages === 1 ? '' : `Page ${page} of ${pages} · `
  if (kind === 'received') return pages === 1 ? `Received: 1 page, ${bytes}` : `${at}Received, ${bytes}`
  return `${at}As it will be sent: ${kind === 'copy' ? 'made smaller' : 'full size'}${pages === 1 ? ', 1 page' : ''}, ${bytes}`
}
/** Audio (2026-10-25): its length, and made smaller, its bitrate and channels. */
export function VIEW_ABOUT_AUDIO(seconds: number, bytes: string, kind: ViewKind, made?: { bitrate: number; channels: number }): string {
  const length = Number.isFinite(seconds) && seconds > 0 ? `${clock(seconds)}, ` : ''
  if (kind === 'received') return `Received: ${length}${bytes}`
  if (kind === 'full') return `As it will be sent: full quality, ${length}${bytes}`
  return `As it will be sent: made smaller, ${length}${made ? `${soundOf(made.bitrate, made.channels)}, ` : ''}${bytes}`
}
/** "3:58": minutes and seconds. */
export function clock(seconds: number): string {
  const s = Math.round(seconds)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
const soundOf = (bitrate: number, channels: number) => `${Math.round(bitrate / 1000)}\u00a0kbit/s ${channels >= 2 ? 'stereo' : 'mono'}`
/** A document shown as its text: RTF (2026-10-24), Word and LibreOffice Writer (2026-10-25). */
export function VIEW_ABOUT_DOC(bytes: string, kind: ViewKind, plain = false): string {
  if (kind === 'received') return `Received: ${bytes}`
  // Plain text (2026-10-26) is never made smaller: "full size" would suggest it could be.
  if (plain) return `As it will be sent: ${bytes}`
  return `As it will be sent: ${kind === 'copy' ? 'made smaller' : 'full size'}, ${bytes}`
}
/**
 * Above a document shown as its text: that it's only that, and that the document itself keeps what the preview leaves
 * out, with how many pictures (the review: never "may differ", they're never shown). Without it, the preview read as if they
 * weren't sent. Said the same of one sent and one received: it's true of both.
 */
export const DOC_SIMPLIFIED = (pictures: number) =>
  `Just a text preview: the document itself keeps its ${pictures ? `${pictures === 1 ? 'picture' : `${pictures} pictures`}, ` : ''}fonts and page layout.`
export const DOC_CUT = 'Only the beginning is shown here.'
export const VIEW_CANT_DOC = `${SITE_NAME} can’t show this document here.`
/** An SVG drawing (2026-10-26): never made smaller, so no "full size". */
export function VIEW_ABOUT_SVG(bytes: string, kind: ViewKind): string {
  return kind === 'received' ? `Received: SVG drawing, ${bytes}` : `As it will be sent: SVG drawing, ${bytes}`
}
/** One that can't be read, or would take too long to draw. */
export const VIEW_CANT_SVG = `${SITE_NAME} can’t show this drawing here.`
/** Damaged, or locked with a password: pdf.js can't open it. */
export const VIEW_CANT_PDF = `${SITE_NAME} can’t show this PDF here.`
/** Tapping a PowerPoint or Excel file's name (or LibreOffice's), or a document's with no text: there's no way to show one here. */
export const DOC_NO_PREVIEW = `${SITE_NAME} can’t show this document here. Open it in its own app to see it.`
export const DOC_NO_PREVIEW_RECEIVED = `${SITE_NAME} can’t show this document here. Save it to see it in Word, Pages or another app.`
export const VIEW_CANT_VIDEO = 'This browser can’t play this video.'
/** A video's own controls in the viewer (2026-10-25): for screen readers and as tooltips. */
export const VIEW_PLAY = 'Play'
export const VIEW_PAUSE = 'Pause'
export const VIEW_FULL = 'Full screen'
export const VIEW_POSITION = 'Where it is in the video'
export const VIEW_CANT_AUDIO = 'This browser can’t play this audio file.'
export const CANT_OPEN = 'This browser can’t open this photo to make it smaller.'
export const TOO_BIG = 'This photo is too big for your browser to make smaller.'
export const FAILED = 'Couldn’t make this photo smaller.'

// --- Videos -------------------------------------------------------------------------
// A video too big to go as it is can only go made smaller: re-made by the
// browser at a smaller size, sharing the space with any photos (video/plan.ts).

/** How many of each kind: photos, videos, documents (PDFs and Office files) and audio files (2026-10-25). */
export interface Kinds {
  photos?: number
  videos?: number
  docs?: number
  audio?: number
}

/**
 * "your photo", "your videos", "your photos and video", "your photos, video and document"… With how many of each
 * there are (of), one only some of which were made smaller says so: "1 of your photos, your video and 2 of your
 * documents" ("your photo, video and document" read oddly beside several photos and
 * documents).
 */
export function whatSmaller(n: Kinds, of?: Kinds): string {
  const kinds = [
    [n.photos ?? 0, of?.photos, 'photo', 'photos'],
    [n.videos ?? 0, of?.videos, 'video', 'videos'],
    [n.docs ?? 0, of?.docs, 'document', 'documents'],
    [n.audio ?? 0, of?.audio, 'audio file', 'audio files'],
  ] as const
  const named = kinds.filter(([n]) => n > 0)
  const list = (words: string[]) => (words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}` : words[0])
  if (named.every(([n, total]) => total === undefined || total <= n)) return `your ${list(named.map(([n, , one, many]) => (n === 1 ? one : many)))}`
  return list(named.map(([n, total, one, many]) => (total !== undefined && total > n ? `${n} of your ${many}` : `your ${n === 1 ? one : many}`)))
}

const total = (n: Kinds) => (n.photos ?? 0) + (n.videos ?? 0) + (n.docs ?? 0) + (n.audio ?? 0)

/** The offer with "Make … smaller to fit" off, when videos, documents or audio are among what's over. */
export function OFFER_MIXED(n: Kinds): string {
  const one = total(n) === 1
  return `${SITE_NAME} can make ${whatSmaller(n)} smaller to help ${one ? 'it' : 'them'} fit. Only the smaller ${one ? 'version is' : 'versions are'} sent.`
}
export const OFFER_BUTTON_MIXED = (n: Kinds) => (total(n) === 1 ? 'Make it smaller' : 'Make them smaller')

/** While a video is being made smaller: one of count, done 0 to 1. */
export function WORKING_VIDEO(done: number, index: number, count: number): string {
  const pct = `${Math.min(99, Math.floor(done * 100))}%`
  return count === 1 ? `Making your video smaller… ${pct}` : `Making your videos smaller… ${index} of ${count}, ${pct}`
}
/** After it: a phone pauses a page that's out of sight, and the work with it. */
export const KEEP_OPEN = 'Keep this page open until it’s done.'

/** Once Slynk has made videos, documents or audio (and perhaps photos) smaller by itself. Photos and documents end with the link to go back to full size. */
export const AUTO_MIXED = (n: Kinds, room = false, of?: Kinds) => `${SITE_NAME} made ${whatSmaller(n, of)} smaller to fit${room ? ', and there’s room for more' : ''}.`
export const AUTO_MIXED_OFF = 'For photos at full size,'
/** The same without a video, which can't go at full size: everything else can. */
export const AUTO_DOCS_OFF = 'For full size,'

/**
 * Once Slynk has made them as small as it goes ("Smallest", the default since 2026-10-26), fitting
 * or not; SMALLEST_FIT, greyed, after it, opens Settings at the choice.
 * least false: photos or videos among them were made at a better level ("Smallest photos" or
 * "Smallest videos" in Settings → Advanced), so not as small as it can.
 */
export const SMALLEST = (n: Kinds, of?: Kinds, least = true) =>
  `${SITE_NAME} made ${whatSmaller(n, of)} ${least ? 'as small as it can' : 'smaller'}, so ${total(n) === 1 ? 'it sends' : 'they send'} faster.`
export const SMALLEST_FIT = 'For better quality, choose “To fit” in Settings.'

/** Even at their smallest, they don't all fit (with a video, document or audio file among them, which bend furthest, so no count). */
export function NO_FIT_VIDEO(n: Kinds): string {
  const { photos = 0, videos = 0, docs = 0, audio = 0 } = n
  if (total(n) === 1 && videos) return 'This video is too long to fit, even made smaller.'
  if (total(n) === 1 && docs) return 'This document is too big to fit, even made smaller.'
  if (total(n) === 1 && audio) return 'This audio file is too long to fit, even made smaller.'
  const what = [
    videos ? (videos === 1 ? 'the video' : 'a video') : '',
    docs ? (docs === 1 ? 'the document' : 'a document') : '',
    audio ? (audio === 1 ? 'the audio file' : 'an audio file') : '',
    photos ? 'some photos' : '',
  ].filter(Boolean)
  return `Too much to fit, even made smaller. Remove ${what.length > 1 ? `${what.slice(0, -1).join(', ')} or ${what[what.length - 1]}` : what[0]}.`
}

/** On the video's row once it's made smaller. fps only when it's fewer than the video had. */
export function VIDEO_NOTE(to: Dims, from: Dims, fps?: number): string {
  const rate = fps ? `, ${fps} frames a second` : ''
  return `Made smaller: ${dims(to)} pixels${rate} (was ${dims(from)})`
}
export const NO_SOUND = 'Without sound: this browser can’t make sound smaller.'
export const VIDEO_PROBLEM = {
  browser: 'This browser can’t make videos smaller.',
  open: 'This browser can’t open this video to make it smaller.',
  long: 'Too long to fit, even made smaller.',
  tight: 'Too much to fit with everything else, even made smaller.',
  /** Drawing came back different from what was drawn (Safari's Private Browsing can do this): nothing made from it could be trusted. */
  blocked: `Your browser stopped ${SITE_NAME} from making it smaller, as some privacy settings and private windows do.`,
  failed: 'Couldn’t make this video smaller.',
} as const
// --- Audio -------------------------------------------------------------------------------
// An audio file too big to go as it is, made again by the browser as
// Opus at the bitrate that fills its share (audio/plan.ts), and made again whenever
// that share changes enough.

/** While audio is made smaller: one of count, done 0 to 1. */
export function WORKING_AUDIO(done: number, index: number, count: number): string {
  const pct = `${Math.min(99, Math.floor(done * 100))}%`
  return count === 1 ? `Making your audio file smaller… ${pct}` : `Making your audio files smaller… ${index} of ${count}, ${pct}`
}
/** On its row once it's made smaller: "Made smaller: 64 kbit/s stereo (was 320 kbit/s)". */
export function AUDIO_NOTE(bitrate: number, channels: number, was?: number): string {
  return `Made smaller: ${soundOf(bitrate, channels)}${was ? ` (was ${Math.round(was / 1000)}\u00a0kbit/s)` : ''}`
}
/** Under an audio file made smaller, which can go as it was when it fits that way. */
export const USE_FULL_AUDIO = 'Send full quality instead'
export const AUDIO_PROBLEM = {
  browser: 'This browser can’t make audio smaller.',
  open: 'This browser can’t open this audio file to make it smaller.',
  long: 'Too long to fit, even made smaller.',
  tight: 'Too much to fit with everything else, even made smaller.',
  failed: 'Couldn’t make this audio file smaller.',
} as const

/**
 * On its row while it waits its turn to be made smaller, after its size. Short enough for one
 * line on a phone, as MAKING is ("making it smaller… 62%" went to two
 * lines as the numbers grew), in the words of "Shrink photos, media & docs".
 */
export const QUEUED = 'waiting to shrink'
/** On its row while it's made smaller, after its size. */
export const MAKING = (done: number) => `shrinking… ${Math.min(99, Math.floor(done * 100))}%`

// --- Documents -------------------------------------------------------------------------------
// A PDF or Office file (Word, PowerPoint, Excel, LibreOffice, RTF) made smaller
// by making the pictures inside it smaller (pdfshrink/, officeshrink/), sharing
// the space with photos and videos. Its text, fonts and layout never change.

/** What a document is called on its row: a PDF, or else a document. */
export const docNoun = (pdf: boolean) => (pdf ? 'PDF' : 'document')

/** While documents are made smaller: one of count, done 0 to 1. */
export function WORKING_DOC(done: number, index: number, count: number): string {
  const pct = `${Math.min(99, Math.floor(done * 100))}%`
  return count === 1 ? `Making your document smaller… ${pct}` : `Making your documents smaller… ${index} of ${count}, ${pct}`
}

/** On its row once it's made smaller: how many of its pictures were (none: it was only saved more compactly). */
export function DOC_NOTE(changed: number, lowered: boolean): string {
  if (!changed) return 'Made smaller without changing its pictures or text.'
  return `Made smaller: ${changed === 1 ? '1 of its pictures' : `${changed} of its pictures`}${lowered ? ', at a lower quality' : ''}. Its text is unchanged.`
}

export type DocProblem = 'signed' | 'locked' | 'unreadable' | 'none' | 'big' | 'tight' | 'blocked' | 'failed'
/**
 * On its row when it can't be made smaller. measured: for 'big', how small it gets (so the sender
 * knows how much less a version of it would need), and whether what's left is mostly text and fonts.
 */
export function DOC_PROBLEM(problem: DocProblem, pdf: boolean, measured?: Pick<DocMeasure, 'smallest' | 'mostlyKept'>): string {
  const it = docNoun(pdf)
  switch (problem) {
    case 'signed':
      return `This ${it} is signed, so making it smaller would break its signature.`
    case 'locked':
      return `This ${it} is locked with a password, so ${SITE_NAME} can’t make it smaller.`
    case 'unreadable':
      return `${SITE_NAME} can’t read this ${it} to make it smaller.`
    case 'none':
      return `${SITE_NAME} can’t make the pictures in this ${it} smaller.`
    case 'big':
      if (!measured) return `Even made smaller, this ${it} is too big.`
      return `Even made smaller, this ${it} is too big: about ${size(measured.smallest)} at its smallest.${measured.mostlyKept ? ` Most of that is text, fonts or other files, which ${SITE_NAME} leaves as they are.` : ''}`
    case 'tight':
      return 'Too much to fit with everything else, even made smaller.'
    case 'blocked':
      return VIDEO_PROBLEM.blocked
    case 'failed':
      return `Couldn’t make this ${it} smaller.`
  }
}

/** On an iPhone, while the picker is still handing files over: iOS converts a video first, and the page hears nothing until it's done. */
export const PICK_WAIT = 'Waiting for your files… On an iPhone, a long video can take a minute to come through.'

// While files over the limit get stronger compression (Brotli), before anything is made smaller (tray.ts brotliWaitLeft).
export const SQUEEZING = 'Trying stronger compression first…'

// --- Zips (2026-10-25): their photos, videos, audio and documents as rows of their own --------

/** "14 photos and 1 video": how many of each, plainly (others: any other files); "photo" for a lone one. */
function counted(n: Kinds & { others?: number }, lone: boolean): string {
  // Beside photos and the like, the rest are "other files"; alone, just "files".
  const rest = total(n) ? ['other file', 'other files'] : ['file', 'files']
  const kinds = [
    [n.photos ?? 0, 'photo', 'photos'],
    [n.videos ?? 0, 'video', 'videos'],
    [n.docs ?? 0, 'document', 'documents'],
    [n.audio ?? 0, 'audio file', 'audio files'],
    [n.others ?? 0, rest[0], rest[1]],
  ] as const
  const named = kinds.filter(([k]) => k > 0)
  if (lone && named.length === 1 && named[0][0] === 1) return n.others ? 'file' : named[0][1]
  const words = named.map(([k, one, many]) => `${k} ${k === 1 ? one : many}`)
  return words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}` : (words[0] ?? '')
}

/** Under a zip, with a chevron: opens or closes the list of its files that are rows of their own. */
export const ZIP_FILES = (n: Kinds & { others?: number }) => `The ${counted(n, true)} inside`
/** On a zip's row, once some of its files are made smaller (each says how on its own row). */
export const ZIP_NOTE = (n: Kinds) => `Made smaller: ${counted(n, false)} inside.`
/** In the box, while a zip holds files too big to go even on their own. */
export const ZIP_TOO_BIG = (zip: string, n: number) =>
  n === 1
    ? `A file in ${zip} is too large to send. Take it out of the zip to send the rest.`
    : `${n} files in ${zip} are too large to send. Take them out of the zip to send the rest.`
/** After the size of one of a zip's files that goes as it is, or can't go even on its own. */
export const AS_IT_IS = 'goes as it is'
export const TOO_LARGE = 'too large to send'

/** Under the meter: a file Slynk can't make smaller is too big to go even on its own, so nothing else can make room for it. */
export const TOO_LARGE_ALONE = (name: string, n: number) =>
  n === 1
    ? `${name} is too large to send, even on its own. Remove it to send the rest.`
    : `${n} files are too large to send, even on their own. Remove them to send the rest.`
/** For screen readers: the list of a zip's files, and taking one of them out of it. */
export const ZIP_LIST = (zip: string) => `Files inside ${zip}`
export const ZIP_REMOVE = (name: string, zip: string) => `Remove ${name} from ${zip}`
