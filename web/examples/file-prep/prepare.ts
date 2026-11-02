// Prepares files for a mixnet transfer in the browser with Slynk's own engine:
// the file list its composer runs on slynk.me (web/src/prep/list.ts), here
// without a screen. Each file is cleaned of hidden details, made smaller
// (photos, videos, audio, the pictures inside PDFs and Office files, and the
// files inside a zip) and compressed, with Slynk's own modules, limits and plan,
// and totalled as Slynk counts what it sends. Nothing is sent anywhere: bytes go
// to this tab's workers and come back. Nothing is kept either: no storage, no
// settings read; every choice comes in through the options, whose defaults are
// Slynk's own.
//
//   const prepared = await prepareFiles(files)                    // as Slynk does by default
//   const fitted = await prepareFiles(files, { budget: 250_000, shrink: 'fit', onProgress, signal })
//   if (fitted.fits) send(fitted.files.filter((f) => f.data))     // a file left out has no data
//
// It adds the files to a list of its own as a sender adds them to Slynk's, all
// at once, gives each the choices perFile names (as a sender ticks them in
// Slynk), waits until the list has done all it does by itself, and reads what
// came out. Nothing here plans or makes anything: that's all the list's, so this
// does what Slynk does. An app that keeps a list that changes as files come and
// go, as Slynk's composer does, can use createFileList itself: the composer
// (web/src/tray.ts) shows how.
import { MAX_DECODED, MAX_FILES, MAX_PAYLOAD, PASSWORD_OVERHEAD, SEAL_OVERHEAD, type Stored } from '../../src/payload.ts'
import { alreadyListed, baseRow, createFileList, plainLine, type Compose, type FileRow, type Offer } from '../../src/prep/list.ts'
import { MAKERS } from '../../src/prep/makers.ts'
import { longEdge, type PhotoLevel } from '../../src/shrink/plan.ts'
import * as shrinkCopy from '../../src/shrinkCopy.ts'
import { ONE_TIME_ONLY } from '../../src/site.ts'
import type { Detail, StripResult } from '../../src/stripHook.ts'
import type { VideoLevel } from '../../src/video/plan.ts'

export type { Detail, PhotoLevel, VideoLevel }

/** 'smallest': every file as small as its level makes it; 'fit': made smaller only when they don't all fit, and only as much as needed; 'off': full size. */
export type Shrink = 'smallest' | 'fit' | 'off'
/** 'brotli' falls back to deflate where Slynk's WebAssembly helper isn't built. */
export type Compression = 'brotli' | 'deflate' | 'none'
/**
 * 'slynk': counted as Slynk sends them, inside its envelope (each file's name, type and size) and a
 * one-time link's seal, with room kept for a password; 'none': each file's compressed bytes alone,
 * for an app with framing of its own.
 */
export type Framing = 'slynk' | 'none'
export type Method = 'as-is' | 'deflate' | 'brotli'

/** One file's own choice, as Slynk's "Send original instead" (clean: false) and "Send full size instead" (shrink: false). */
export interface FileChoice {
  clean?: boolean
  shrink?: boolean
  /** Send it as it is when it couldn't be cleaned, as the sender's answer to Slynk's question. */
  sendAsIs?: boolean
}

export interface Options {
  /** What the upload may weigh. With framing 'slynk', what Slynk's envelope and link take is counted within it. */
  budget?: number
  /** Remove hidden details (Slynk's "Remove hidden details from files"). */
  clean?: boolean
  shrink?: Shrink
  /** What 'smallest' makes photos (Slynk's "Smallest photos"). */
  photoLevel?: PhotoLevel
  /** What 'smallest' makes videos, in lines (Slynk's "Smallest videos"), stepping down from it when they don't all fit. */
  videoLevel?: VideoLevel
  compression?: Compression
  /** Neutral names for files whose names give something away (Slynk's "Plain file names"). */
  plainNames?: boolean
  framing?: Framing
  /** A choice for one file, overriding clean and shrink for it alone. */
  perFile?: (file: File, index: number) => FileChoice | undefined
  onProgress?: (p: Progress) => void
  /** Stops the work: the promise then rejects with an AbortError at once. A photo being drawn finishes in the background. */
  signal?: AbortSignal
}

/** Every option with a default. */
export type Settings = Required<Omit<Options, 'perFile' | 'onProgress' | 'signal'>>

/** Slynk's own defaults: its limit (payload.ts MAX_PAYLOAD) and its settings' (web/src/ui/settings.ts). */
export const DEFAULTS: Readonly<Settings> = {
  budget: MAX_PAYLOAD,
  clean: true,
  shrink: 'smallest',
  photoLevel: 'least',
  videoLevel: 240,
  compression: 'brotli',
  plainNames: false,
  framing: 'slynk',
}

export interface PreparedFile {
  /** The name it goes under: a copy gets its new type's extension (IMG_1234.HEIC → IMG_1234.jpg). In a zip, its path there. */
  name: string
  type: string
  originalSize: number
  /** The prepared file, which opens as it is; null when it can't go (too big, not read, or waiting for an answer). */
  data: Uint8Array | null
  /**
   * What to send: data compressed, or not. The recipient inflates it, or un-Brotlis it, to get data back. A zip with
   * `unpacked` went unpacked and squeezed whole (Slynk's envelope flag 5): un-Brotli it, then pack it again with
   * zipInside.ts repackZip, as Slynk's recipient does.
   */
  compressed: Stored
  /** What it takes of the budget: with framing 'slynk', its item in Slynk's envelope; a zip, its own share beside its files' (theirs are in `inside`); in a zip, its share of the zip. */
  size: number
  /** What the cleaner did; 'copy': a new photo, video or audio file was made, which holds none of the original's details. */
  cleaning: StripResult['status'] | 'copy' | 'off'
  /** What was removed (for a copy, what the original held), with the values: for the sender's eyes only. */
  removed: Detail[]
  /** How it was made smaller, e.g. "1280 px JPEG at 40%"; undefined when it goes at full size. */
  smaller?: string
  /** Things to tell the sender, in Slynk's words: it couldn't be cleaned, made smaller or read. */
  problems: string[]
  /** A zip's photos, videos, audio and documents, each prepared as a file of its own and written back into it. */
  inside?: PreparedFile[]
}

export interface Prepared {
  files: PreparedFile[]
  /** What they take together: with framing 'slynk', Slynk's whole envelope. */
  total: number
  budget: number
  /** What they may take: the budget, less a one-time link's seal with framing 'slynk' on a site with the one-time rule. */
  limit: number
  /** Whether they can go: within the limit (and Slynk's own limits on files and their size unpacked), with nothing waiting and no file that can't go (too big to read, or too big as it is and not made smaller). */
  fits: boolean
  /** A file couldn't be cleaned and waits for an answer (perFile sendAsIs): as in Slynk, nothing is made smaller until then. */
  waiting: boolean
  /** Why they can't go as they are, as Slynk's box says it (they're too much even made smaller, a file stops it…), or undefined. */
  says?: string
}

export interface Progress {
  /** Which file, from 1, of count (a file inside a zip counts as its zip). */
  index: number
  count: number
  name: string
  stage: 'reading' | 'cleaning' | 'measuring' | 'shrinking' | 'compressing'
  /** 0 to 1 through the stage (measuring and shrinking: through both together), or null when it can't be measured. */
  done: number | null
}

const stopped = () => new DOMException('Stopped', 'AbortError')

/** What Slynk's box says when it says why they can't go: a file stops it, the browser's canvas lies, or they're too much. */
const TELLS: Offer<FileRow>['kind'][] = ['held', 'alone', 'blocked', 'no-fit']

/** Cleans, shrinks and compresses the files as Slynk's composer does, and says whether they can go together. */
export async function prepareFiles(files: File[], opts: Options = {}): Promise<Prepared> {
  const given = Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined))
  const o = { ...DEFAULTS, ...given } as Settings
  const signal = opts.signal ?? new AbortController().signal
  if (signal.aborted) throw stopped()
  const slynk = o.framing === 'slynk'
  // The composer's limit() and planLimit() (main.ts): a link is sealed where the one-time rule is on, and
  // copies are planned as if it were sealed and had a password, so neither makes anything again.
  const limit = slynk ? o.budget - (ONE_TIME_ONLY ? SEAL_OVERHEAD : 0) : o.budget
  const planLimit = slynk ? o.budget - SEAL_OVERHEAD - PASSWORD_OVERHEAD : o.budget
  const choices = files.map((file, i) => opts.perFile?.(file, i) ?? {})
  // Which file each row is, from 0 (one of a zip's files counts as its zip), and the choices it was given.
  const index = new Map<FileRow, number>()
  const choice = new Map<FileRow, FileChoice>()
  // Files that couldn't be read, taken off the list as Slynk does, and why.
  const gone = new Map<FileRow, string>()
  let adding = 0
  let told = ''
  const list = createFileList<FileRow>({
    settings: () => ({
      stripMetadata: o.clean,
      shrink: o.shrink === 'off' ? 'ask' : o.shrink,
      smallestPhotos: o.photoLevel,
      smallestVideos: o.videoLevel,
      plainNames: o.plainNames,
      brotli: o.compression === 'brotli',
    }),
    makers: MAKERS,
    compose: (): Compose<FileRow> => list.compose(undefined, 0),
    limit: () => limit,
    planLimit: () => planLimit,
    framing: o.framing,
    deflate: o.compression !== 'none',
    newRow: (file, inZip) => {
      const row: FileRow = baseRow(file)
      if (inZip) {
        // As in Slynk, a zip's files have choices of their own (none, here), but the answer for one that couldn't be cleaned: the zip's.
        index.set(row, index.get(inZip.zip)!)
        choice.set(row, { sendAsIs: choice.get(inZip.zip)?.sendAsIs })
        return row
      }
      const own = choices[adding]
      index.set(row, adding)
      choice.set(row, own)
      // Ticked before anything was made smaller.
      row.useOriginal = own.clean === false
      row.useFull = own.shrink === false
      return row
    },
    updateRow: (row) => {
      report(row)
      // Slynk asks about a file that couldn't be cleaned; perFile's sendAsIs answers, once it asks.
      if (list.asking(row) && choice.get(row)?.sendAsIs) queueMicrotask(() => list.rows.includes(row) && list.asking(row) && list.answer(row))
      redraw()
    },
    changed: () => redraw(),
    toast: () => {}, // a file added twice: it has no row, and comes back as left out
    unreadable: (row, text) => {
      gone.set(row, text)
      list.remove(row)
    },
  })

  /** What Slynk's page does each time the list changes: it draws the box, which may say to make copies now. */
  function redraw() {
    if (list.offer(list.compose(undefined, 0)).start) queueMicrotask(() => void list.makeSmallerCopies(false, true))
  }

  /** Tells onProgress what a file is going through, when that changes. */
  function report(row: FileRow) {
    if (!opts.onProgress || signal.aborted || !index.has(row)) return
    const now = stageOf(row)
    if (!now) return
    const p: Progress = { index: index.get(row)! + 1, count: files.length, name: row.file.name, ...now }
    const key = JSON.stringify(p)
    if (key === told) return
    told = key
    opts.onProgress(p)
  }

  // Listened for before anything is added: adding reports progress at once, and onProgress may stop it then.
  let stopNow = () => {}
  const stop = new Promise<never>((_, reject) => (stopNow = () => reject(stopped())))
  stop.catch(() => {}) // the race below sees it
  signal.addEventListener('abort', stopNow)
  try {
    // Added as a sender adds them all at once: one at a time, so each row knows which file it is.
    const added = files.map((file, i) => {
      adding = i
      return list.add([file])[0]
    })
    await Promise.race([list.idle(), stop])
    const c = list.compose(undefined, 0)
    const offer = list.offer(c)
    const top = list.rows.filter((r) => !r.parent)
    const waiting = list.rows.some(list.asking)
    // Nothing too big to go: always over Slynk's limit, and over any budget too, since it isn't read.
    const blocked = list.rows.some((r) => r.state === 'too-big' || (r.state === 'video' && !r.sending))
    const fits = top.length > 0 && !waiting && !c.pending && !blocked && c.wire <= limit && (!slynk || (top.length <= MAX_FILES && c.raw <= MAX_DECODED))
    const says = fits || !TELLS.includes(offer.kind) ? undefined : plainLine(offer.says)
    const out = added.map((row, i) => {
      if (!row) return leftOut(files[i], alreadyListed(files[i].name))
      if (gone.has(row)) return leftOut(row.file, gone.get(row)!)
      return result(row, c, offer)
    })
    return { files: out, total: c.wire, budget: o.budget, limit, fits, waiting, ...(says ? { says } : {}) }
  } finally {
    signal.removeEventListener('abort', stopNow) // a signal used again for other calls keeps nothing of this one
    list.clear() // lets go of what the workers keep (each document measured), and stops what's under way
  }

  /** What the sender is told about a file, in Slynk's words. */
  function problemsOf(row: FileRow, offer: Offer<FileRow>): string[] {
    const out: string[] = []
    if (TELLS.includes(offer.kind) && offer.names?.includes(row)) out.push(plainLine(offer.says))
    const pdf = row.doc === 'pdf'
    if (row.state === 'too-big') out.push('Too big to read here.')
    else if (row.state === 'video' && !row.sending) out.push(row.zip ? 'A file in it is too big to go, even made smaller.' : 'Too big to go as it is, and not made smaller.')
    if (row.state === 'packing') out.push('A file in it couldn’t be cleaned: it waits for an answer (perFile sendAsIs, given for the zip).')
    if (list.asking(row)) out.push(`Couldn’t be cleaned${row.strip?.status === 'failed' ? ` (${row.strip.error})` : ''}. Slynk asks before sending it: nothing is made smaller until perFile gives it sendAsIs, or it's taken out.`)
    const s = row.strip
    if (o.clean && s && !list.newPicture(row) && !row.useOriginal) {
      if (s.status === 'failed' && row.sendAsIs) out.push(`Couldn’t be cleaned (${s.error}): this is the original.`)
      else if (s.status === 'skipped') out.push(s.reason)
      else if (s.status === 'unsupported' && !row.zip) out.push(`Hidden details can’t be checked in this kind of file${s.kind ? ` (${s.kind})` : ''}.`)
    }
    // The browser's canvas gave back something else than was drawn: no photo was made smaller.
    if (list.canvasBlocked() && row.photo?.still && !row.copy && !row.useFull) out.push(shrinkCopy.BLOCKED)
    else if (row.copyProblem && !row.copy) {
      if (row.copyProblem === 'open' && row.photo?.kind === 'heic') out.push(`${shrinkCopy.CANT_OPEN} Opening a HEIC takes an HEVC decoder, which not every browser has.`)
      else out.push({ open: shrinkCopy.CANT_OPEN, big: shrinkCopy.TOO_BIG, failed: shrinkCopy.FAILED }[row.copyProblem])
    }
    if (row.videoProblem && !row.vcopy) out.push(shrinkCopy.VIDEO_PROBLEM[row.videoProblem])
    if (row.docProblem && !row.dcopy) out.push(shrinkCopy.DOC_PROBLEM(row.docProblem, pdf, row.dmeasured))
    if (row.audioProblem && !row.acopy) out.push(shrinkCopy.AUDIO_PROBLEM[row.audioProblem])
    return out
  }

  function result(row: FileRow, c: Compose<FileRow>, offer: Offer<FileRow>): PreparedFile {
    const s = row.sending
    const copy = list.newPicture(row)
    let removed: Detail[] = o.clean && !row.useOriginal && row.strip?.status === 'cleaned' ? row.strip.details : []
    // A video never read, made smaller: what it held, read from beside its pictures and sound.
    if (copy && row.held && !removed.length) removed = row.held.details
    const inside = row.zip?.members.map((m) => ({ ...result(m, c, offer), name: m.entry!.slice(0, m.entry!.lastIndexOf('/') + 1) + list.sentName(m) }))
    return {
      name: list.sentName(row),
      type: list.sentType(row),
      originalSize: row.file.size,
      data: s?.data ?? null,
      compressed: s?.stored ?? { body: new Uint8Array(0), method: 'as-is' },
      // What it takes: nothing while it waits for an answer; as it is when it can't go.
      size: c.rowWire.get(row) ?? (list.asking(row) ? 0 : row.file.size),
      cleaning: copy ? 'copy' : o.clean && !row.useOriginal ? (row.strip?.status ?? 'skipped') : 'off',
      removed,
      smaller: list.inCopy(row) ? smallerOf(row) : undefined,
      problems: problemsOf(row, offer),
      ...(inside ? { inside } : {}),
    }
  }
}

/** How a file was made smaller, for a developer: "1280 px JPEG at 40%", "240p H.264 MP4 at 30 fps, Opus sound"… */
function smallerOf(row: FileRow): string {
  if (row.vcopy) {
    const { dims, fps, sound } = row.vcopy
    return `${Math.min(dims.width, dims.height)}p H.264 MP4 at ${Math.round(fps)} fps, ${sound === 'none' ? 'no sound' : sound === 'opus' ? 'Opus sound' : 'AAC sound'}`
  }
  if (row.acopy) return `Opus at ${Math.round(row.acopy.bitrate / 1000)} kbit/s, ${row.acopy.channels === 1 ? 'mono' : 'stereo'}`
  if (row.dcopy) {
    const n = row.dcopy.changed
    return n ? `${n} picture${n === 1 ? '' : 's'} in it made smaller${row.dcopy.lowered ? ', at a lower quality' : ''}` : 'saved again without changing a picture'
  }
  const copy = row.copy!
  const type = copy.type === 'image/jpeg' ? 'JPEG' : copy.type === 'image/webp' ? 'WebP' : 'PNG'
  return `${longEdge(copy.dims)} px ${type}${copy.type === 'image/png' ? '' : ` at ${Math.round(copy.quality * 100)}%`}`
}

/** What a file is going through, as Progress says it, from its row: nothing while it waits its turn, or once it's done. */
function stageOf(row: FileRow): Pick<Progress, 'stage' | 'done'> | undefined {
  if (row.state === 'reading') return { stage: 'reading', done: null }
  if (row.state === 'cleaning') return { stage: 'cleaning', done: null }
  const making = row.pmaking ?? row.vmaking ?? row.dmaking ?? row.amaking
  if (making !== undefined) {
    // A photo or document is measured before it's made for its share (with 'smallest', a photo's copy is made as it's measured).
    const measuring = row.pmaking !== undefined ? !row.measured : row.dmaking !== undefined && !row.dmeasured
    return { stage: measuring ? 'measuring' : 'shrinking', done: making }
  }
  if (row.state === 'packing' || row.squeezing) return { stage: 'compressing', done: null }
  return undefined
}

/** A file taken off the list (added twice, or unreadable): it goes with nothing, and says why. */
function leftOut(file: File, why: string): PreparedFile {
  return { name: file.name, type: file.type, originalSize: file.size, data: null, compressed: { body: new Uint8Array(0), method: 'as-is' }, size: 0, cleaning: 'off', removed: [], problems: [why] }
}
