// A list of files on their way into something to send, and what's done with them: Slynk's
// composer (tray.ts) shows one, and the file-prep example (web/examples/file-prep/) runs one
// without a screen, so the code given to other developers is the code slynk.me runs. Each file
// is read, cleaned of hidden details (when that setting is on) and compressed on its own as soon
// as it's added, so a meter can show exactly what will be sent, and adding or removing a file
// never redoes the others. Photos that don't fit can be made into smaller copies that share the
// space (shrink/plan.ts), drawn by the browser (shrink/draw.ts): only when asked, each copy then
// goes instead of its photo, and the photo's row says what the copy is, with "Send full size
// instead".
//
// Videos too big to go as they are aren't read at all: their index
// says how long they are (video/info.ts), they share the space with the photos
// (video/plan.ts), and a smaller version is made in a worker (video/client.ts),
// last, once additions settle, and only once.
//
// PDFs and Office files bend like photos: the pictures inside them
// are made smaller, in a second copy of the cleaner's worker (docshrink/),
// which measures each one once and then makes it for its share of the space,
// in seconds, as often as that changes. Their text and layout never change.
//
// A plain zip's photos, videos, audio and documents (2026-10-25) are rows of
// their own under it (its members), behind "The … inside": cleaned, made
// smaller and shown as they would be on their own, then put back in their
// places in the zip, which is written again from them as they go.
//
// Audio files (2026-10-25) bend too: read and cleaned like any file,
// and when they don't fit, made again as Opus in the video worker
// (audio/shrink.ts) at the bitrate that fills their share, which their length
// alone tells (audio/plan.ts), in seconds, and again whenever that share
// changes enough (the worst case: a flatter-sounding file).
//
// Nothing here touches the page: what a screen shows (each file's row, the box under the meter,
// the focus) it draws from these rows and from offer(), through the hooks it passes in.
// What makes things smaller comes in too (makers.ts), so a test can stand in for it.
import { keepOutline } from '../audio/page.ts'
import { audioGoodBytes, audioLeastBytes, audioWeight, goodRate, planAudio } from '../audio/plan.ts'
import { STREAMED, audioInfo, wavInfo, type AudioInfo } from '../audio/read.ts'
import type { AudioInput, AudioProgress } from '../audio/shrink.ts'
import { DocError, type DocKind, type DocMeasure } from '../docshrink/client.ts'
import { MAX_DECODED, MAX_FILES, envelopeSize, itemWireSize, packItem, squeeze, store, type Packed, type Stored } from '../payload.ts'
import { CopyError, type Copy, type Measured } from '../shrink/draw.ts'
import { photoInfo, type PhotoInfo } from '../shrink/info.ts'
import { Q_FLOOR, Q_MAX, allocate, atLevel, copyName, giveRoom, levelBytes, longEdge, smallestShare, topEdge, weight, type Dims, type Share } from '../shrink/plan.ts'
import * as shrinkCopy from '../shrinkCopy.ts'
import { MAX_BROTLI, brotli, qualityFor } from '../squeeze/index.ts'
import { describeOther, detectKind } from '../strip/sniff.ts'
import { SKIP } from '../strip/types.ts'
import { modeOf, systemName } from '../strip/zip.ts'
import { shownName } from '../strip/zipdir.ts'
import { cleanFile, suggestNeutralName, videoHeld, type Detail, type StripResult } from '../stripHook.ts'
import { bytesToSend } from '../ui/cleaning.ts'
import type { Settings } from '../ui/settings.ts'
import { isSvgPicture } from '../ui/svgPicture.ts'
import { videoInfo, type VideoInfo } from '../video/info.ts'
import { PHOTO_BYTES_PER_PIXEL, goodBytes, leastBytes, levelSteps, videoWeight, type VideoStep } from '../video/plan.ts'
import { type IndexEntry, entryBlob, entryBytes, entryHead, readZipIndex, skeleton } from '../zipFile.ts'
import { keepZip, packedLength, rebuildZip, unpackedZip } from '../zipInside.ts'
import type { Makers } from './makers.ts'

// Files this large aren't even read: they'd need better than 12x compression
// to fit. Nor is more than READ_BUDGET read in total: no more than
// MAX_DECODED can be sent anyway. (Videos too big to go as they are are
// never read whole, whatever their size: video/info.ts reads their index.)
const HOPELESS_SIZE = 25_000_000
// A PDF or Office file can shrink 30x or more when it's mostly photos,
// so it may be bigger. Read whole, cleaned and measured, it takes a few times
// its size in memory, so not without limit on a phone.
const HOPELESS_DOC = 60_000_000
// A WAV holds its sound as it is, ten times the size of an MP3: a recording of up to this size
// (about 19 minutes at CD quality; 15 fit made smaller) is made smaller from its file, a run
// at a time, never read whole (200 MB allows for the worst case).
const HOPELESS_WAV = 200_000_000
const READ_BUDGET = MAX_DECODED
/** A zip by its name or type, before it's read: it may be as big as a document, since its photos can shrink as a document's do. */
const looksLikeZip = (file: File) => /\.zip$/i.test(file.name) || /^application\/(x-)?zip(-compressed)?$/.test(file.type)
// A zip's files that are rows of their own, at most; the rest go as they are.
const MAX_MEMBERS = 200
// What's read of a file in a zip to tell what it is: enough for a photo's size, past its EXIF.
const MEMBER_HEAD = 262_144
// A packed video or recording in a zip is unpacked by the browser to be made smaller: at most this
// much each, and in all (a stored one is read from the zip itself, so it has no limit, as on its own).
const MAX_UNPACK = 1_000_000_000
const MAX_UNPACKED = 2_000_000_000
// What a file in a zip takes beside its bytes: its local header (30) and directory entry (46), each with its name.
const ZIP_ENTRY = 76
/** A PDF or Office file by its name or type, before it's read (docKind confirms it from its bytes). */
const looksLikeDoc = (file: File) =>
  /\.(pdf|docx|xlsx|pptx|odt|ods|odp|rtf)$/i.test(file.name) || file.type === 'application/pdf' || /officedocument|opendocument|rtf/.test(file.type)
/** A sound file by its name or type, before it's read (audioInfo confirms it): it may be as big as a document, since a few minutes of WAV is 30 MB or more. */
const looksLikeAudio = (file: File) => /\.(mp3|m4a|wav|flac|ogg|oga|opus)$/i.test(file.name) || file.type.startsWith('audio/')
/** A photo, video, document or sound by its name or type, before it's read: what may be made smaller. */
export const looksShrinkable = (file: File) =>
  looksLikeDoc(file) || looksLikeAudio(file) || /^(image|video)\//.test(file.type) || /\.(jpe?g|png|heic|heif|webp|avif|gif|tiff?|bmp|mp4|mov|m4v|webm|mkv|avi)$/i.test(file.name)
// The part of a file's bar its first pass takes (read, cleaned, compressed) when it may then be made
// smaller: the making smaller fills the rest, so it's one bar, not one that fills, turns green and
// starts again.
export const FIRST_PART = 0.25
/** How far along a file's bar is while it's made smaller (made: 0 to 1): what its row and the box say too, so they agree. */
export const barAt = (made: number) => FIRST_PART + (1 - FIRST_PART) * made

// Room kept beside videos for a message to grow without remaking them.
const VIDEO_SLACK = 8_000
// A video is made only once this long has passed since the last file was added.
const SETTLE_MS = 1500
// A phone photo at its smallest, about: what "room for more" counts beside only videos.
const ANOTHER_PHOTO = 150_000
// The share of an audio file's bar that decoding it on the page takes, when it's decoded there (makeAudio).
const PAGE_DECODE_SHARE = 0.3
// A document smaller than this isn't worth measuring: it would save little, slowly.
const DOC_MIN = 200_000
// With "Smallest", a file whose least would save less than this share of it goes as it is: not worth its quality.
const SMALLEST_SAVES = 0.05
// And a photo's copy may come out this much over what it measured at its least.
const SMALLEST_LEEWAY = 1.02
// Office files Slynk can make smaller (older .doc, .xls and .ppt files can't be; strip/sniff.ts).
const OFFICE = new Set(['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'rtf'])

/** 'video': too big to go as it is, so it's never read; only a smaller version of it can go. */
export type RowState = 'reading' | 'cleaning' | 'packing' | 'ready' | 'too-big' | 'video'

/** A PDF or Office file made smaller: its file, how many pictures changed, and for what share it was made. */
export interface DocCopy {
  data: Uint8Array
  /** Its bytes as it's sent (compressed, if it was measured so), as its share counted them. */
  sent: number
  changed: number
  lowered: boolean
  target: number
  /** Made from the cleaned file. */
  stripped: boolean
}

/** Audio made smaller: its file, how it was made, the share it was made for, and its outline for its picture. */
export interface AudioCopy {
  data: Uint8Array
  bitrate: number
  channels: number
  target: number
  peaks: number[]
  /** The original's bitrate, as it would have gone. */
  was: number
}

/** A video made smaller: its file, its size the way up it plays, and its sound ('none' when it has none). */
export interface VideoCopy {
  data: Uint8Array
  dims: Dims
  fps: number
  sound: 'aac' | 'opus' | 'none'
}

/** A file on the list: what's known of it, what it would send, and the work under way on it. A screen adds what it draws with. */
export interface ListRow<Row extends ListRow<Row>> {
  file: File
  name: string
  suggested: string | null // a neutral name to offer, if the stripper has one
  state: RowState
  data?: Uint8Array // the file's bytes, once read
  strip?: StripResult // what the stripper made of it, when that setting is on
  held?: { details: Detail[] } // what a video never read holds (none of it in its smaller version), when that setting is on
  useOriginal: boolean // "Send original instead"
  sendAsIs: boolean // the sender agreed to send a file that couldn't be cleaned
  photo?: PhotoInfo | null // a photo Slynk could make a smaller copy of, read from its first bytes
  svg?: boolean // an SVG drawing, previewed as a picture (never made smaller: Brotli shrinks it)
  measured?: Measured // its smallest copies, measured when copies were first asked for
  copy?: Copy & { from: Dims } // a smaller copy, sent instead of the photo; from: the photo's size
  copyProblem?: 'open' | 'big' | 'failed' // why no copy can be made
  n: number // the order it was added in: names a set of photos (photoSet), and a document to its worker
  useFull: boolean // "Send full size instead" of the copy
  placed?: boolean // looked at (a video or not), and read or not accordingly
  read?: boolean // read whole: counts against the read budget (a video made smaller never was)
  video?: VideoInfo | null // a phone video, from its index; null: not one
  vcopy?: VideoCopy // the video made smaller, sent instead
  vmaking?: number // 0 to 1 while it's being made smaller
  vqueued?: boolean // in the run, waiting its turn to be made smaller
  pqueued?: boolean // a photo in the run, waiting for its smaller copy
  pmaking?: number // 0 to 1 while a photo is measured and made smaller (kept between the two)
  videoProblem?: keyof typeof shrinkCopy.VIDEO_PROBLEM // why it can't be made smaller to fit
  doc?: DocKind | null // a PDF or Office file whose pictures could be made smaller; null: not one
  dmeasured?: DocMeasure // its size at each level, measured when copies were first asked for
  dstripped?: boolean // the bytes measured were the cleaned ones
  dgen?: number // bumps whenever its bytes change, so a measure or make for the old ones is thrown away
  dcopy?: DocCopy // made smaller, sent instead
  dmaking?: number // 0 to 1 while it's measured or made smaller
  dqueued?: boolean // in the run, waiting its turn
  docProblem?: shrinkCopy.DocProblem // why it can't be made smaller to fit
  audio?: AudioInfo | null // a sound file Slynk could make smaller, from its bytes; null: not one
  acopy?: AudioCopy // made smaller, sent instead
  amaking?: number // 0 to 1 while it's made smaller
  aqueued?: boolean // in the run, waiting its turn
  audioProblem?: keyof typeof shrinkCopy.AUDIO_PROBLEM // why it can't be made smaller to fit
  audioRefused?: boolean // a try found this browser can't encode it (no Opus encoder), whatever it seemed to have
  sending?: { data: Uint8Array; stored: Stored; stripped: boolean }
  squeezing?: AbortController // Brotli at work on what it sends (squeezeRow, squeezeZip)
  squeezeFrom?: number // when it started, for how long the offer waits for it (brotliWaitLeft)
  squeezeData?: Uint8Array // the bytes it's at work on: work on the same bytes again goes on (packRow)
  zipUnpacked?: () => Uint8Array | null // a zip written afresh, unpacked: squeezed once copies are done (squeezeZip)
  seq: number // bumps whenever the row's work restarts, so stale results are dropped
  parent?: Row // the zip it's in, when it's one of a zip's files: it goes inside that, not on its own
  entry?: string // its name in that zip, folders and all
  zip?: ZipParts<Row> | null // a plain zip's files that are rows of their own; null: none (not a zip, or none of those)
}

/** A row with nothing added: what a list without a screen keeps (the file-prep example). */
export interface FileRow extends ListRow<FileRow> {}

/** A plain zip's photos, videos, audio and documents, each a row of its own (its members), and the zip made from them. */
export interface ZipParts<Row> {
  members: Row[]
  /** Its other files, which go as they are: listed so each can be taken out. */
  plain: PlainFile[]
  /** Those taken out: still in its skeleton, so not counted while it waits. */
  gone: PlainFile[]
  /** For the cleaner to leave alone: its members (cleaned as files of their own), and files held back or taken out. */
  skip: string[]
  /** Members removed from the list: they're left out of the zip. */
  dropped: Set<string>
  /** What each member was as the zip being sent was made: it's made again when one changes. */
  from?: Uint8Array[]
  /** The zip as it was, read whole only when it's small enough to go as it is. */
  whole?: Uint8Array
}

/**
 * One of a zip's files that goes as it is, packed as it is in the zip (size). tooBig: it can't go
 * even alone, so it's held back from the zip's own bytes, which can't go while it's there.
 */
export interface PlainFile {
  entry: string
  size: number
  /** Its own size, unpacked. */
  usize: number
  tooBig: boolean
  /** Its entry in the zip's index: its folder, and its name as the zip meant it, for its row. */
  header: IndexEntry
}

/** Everything that would be sent right now, packed, and what's still to come. */
export interface Compose<Row> {
  packed: Packed[]
  wire: number
  files: number
  messages: number
  raw: number // bytes before compression
  pending: boolean // something is still being read, cleaned or compressed
  asking: boolean // a file couldn't be cleaned and the sender hasn't said what to do
  rowWire: Map<Row, number> // each ready file's share of wire
}

/** A message to send with the files: its bytes, and once compressed, how they go. */
export interface Text {
  data: Uint8Array
  stored?: Stored
}

/** The settings the list follows (ui/settings.ts): a screen passes Slynk's own, the example its options. */
export type ListSettings = Pick<Settings, 'stripMetadata' | 'shrink' | 'smallestPhotos' | 'smallestVideos' | 'plainNames' | 'brotli'>

/** A piece of the box's line: its words, a link to a setting, or a line break. */
export type Part = string | { link: 'off' | 'fit' } | { br: true }

/** What each link says: "Ask first" ends a line saying Slynk made copies by itself, "To fit" one saying "Smallest" did. */
export const LINK_TEXT = { off: shrinkCopy.AUTO_OFF, fit: shrinkCopy.SMALLEST_FIT }
const OFF_LINK: Part = { link: 'off' }
const FIT_LINK: Part = { link: 'fit' }
const BR: Part = { br: true }

/** How the space is shared (planCopies): each one's target, or how many fit; with "Smallest", the steps its videos go at, from the one planned. */
type Plan = ({ fits: true; targets: (number | null)[] } | { fits: false; count: number }) & { steps?: VideoStep[] }

/** A line's words, its links as they read and its breaks as spaces: for a host that shows it as plain text. */
export const plainLine = (says: Part[]) => says.map((p) => (typeof p === 'string' ? p : 'br' in p ? ' ' : LINK_TEXT[p.link])).join('')

/**
 * The box under the meter (offer): what it says and how it looks, its button, and whether copies are to be
 * made now. kind: 'working' while they're made; 'start' as a run starts by itself; 'squeezing' while it gives
 * stronger compression a moment; 'made' and 'room' once they fit; 'held' (a file in a zip too big to go even
 * alone), 'alone' (a file too big to go even alone beside others: names), 'blocked' (the browser's canvas lies),
 * 'lower', 'no-fit' and 'offer' when they don't; 'hidden' when there's nothing to say.
 */
export interface Offer<Row> {
  kind: 'hidden' | 'working' | 'held' | 'start' | 'squeezing' | 'made' | 'room' | 'alone' | 'blocked' | 'no-fit' | 'lower' | 'offer'
  /** An info card while copies are made or about to be (busy), or once they fit (room); otherwise the amber warning. */
  look?: 'busy' | 'room'
  says: Part[]
  /** Its button: what it says, and whether it lowers the quality ("Lower the quality"). */
  button?: { text: string; lower: boolean }
  /** Copies are to be made now, by themselves: the host starts them once it has drawn this, with makeSmallerCopies(false, true). */
  start?: boolean
  /** The files it names. */
  names?: Row[]
}

export interface ListOptions<Row> {
  settings(): ListSettings
  /** What makes photos, videos, documents and audio smaller: MAKERS (makers.ts), or stand-ins in a test. */
  makers: Makers
  /** Everything that would be sent now: these files and whatever the host adds (its text), from compose(). */
  compose(): Compose<Row>
  /** The most what's being made can carry. */
  limit(): number
  /** What copies aim for: the least the package could carry, so a later choice can't push it over. */
  planLimit(): number
  /** 'slynk' (the default): each file counted as its item in Slynk's envelope; 'none': its compressed bytes alone. */
  framing?: 'slynk' | 'none'
  /** Deflate each file (store()), as Slynk does; false: as it is, or Brotli's when that's on. */
  deflate?: boolean
  /** A new row for a file: the host's, with what it draws with, from baseRow(file). inZip: one of a zip's files, and its entry there. */
  newRow(file: File, inZip?: { zip: Row; header: IndexEntry }): Row
  /** A row changed: the host redraws it, and what depends on it (changed). */
  updateRow(row: Row): void
  /** Something changed: the host redraws its meter and the box (offer). */
  changed(): void
  /** A file was added: the host may start joining the mixnet. */
  added?(): void
  toast(text: string): void
  /** A file couldn't be read: the host takes it off the list (remove), and may say so. */
  unreadable(row: Row, text: string): void
  /** A row is off the list for good: the host lets go of what it showed. */
  forgot?(row: Row): void
  /** A zip's files are rows of their own now (row.zip): the host lists them under it. */
  zipOpened?(row: Row): void
  /** A zip was written again from its files: packed, the size each file that goes as it is takes in it now (none: as it was). */
  zipMade?(row: Row, packed: Map<string, number>): void
  /** A zip goes squeezed whole: its files' own sizes in it no longer apply. */
  zipSqueezed?(row: Row): void
  /** A run of copies started (auto: by itself, not from the box's button). */
  runStarted?(auto: boolean): void
  /** A run of copies is ending, before the host redraws: what it returns runs after that redraw. */
  runEnding?(): (() => void) | void
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** What the list says of a file added again. */
export const alreadyListed = (name: string) => `${name} is already on the list`

/** Compresses each distinct set of bytes once, however often it's asked. */
const stores = new WeakMap<Uint8Array, Promise<Stored>>()
function storeOnce(data: Uint8Array): Promise<Stored> {
  let stored = stores.get(data)
  if (!stored) {
    stored = store(data)
    stores.set(data, stored)
  }
  return stored
}

/** Brotli's version of each distinct set of bytes, once it's been made (or found no smaller). */
const squeezed = new WeakMap<Uint8Array, Stored>()

/** A file's item in Slynk's envelope with these bytes, name and type (pictures are never deflated). */
function itemOf(name: string, type: string, length: number): number {
  const empty = new Uint8Array(0)
  return itemWireSize(packItem({ kind: 'file', name, type, data: empty }, { body: empty, method: 'as-is' })) + length
}

/** A file's type from its bytes (or what kind of sound it is), for a zip's file: a zip says nothing of its files' types. */
function typeFrom(data: Uint8Array, audio: AudioInfo | null): string {
  if (audio) return { mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg' }[audio.kind] ?? ''
  const kind = detectKind(data)
  if (kind === 'jpeg' || kind === 'png' || kind === 'webp' || kind === 'gif' || kind === 'heic' || kind === 'avif') return `image/${kind}`
  if (kind === 'mp4') return 'video/mp4'
  if (kind === 'mov') return 'video/quicktime'
  if (kind === 'pdf') return 'application/pdf'
  if (kind === 'mp3') return 'audio/mpeg'
  if (kind === 'flac') return 'audio/flac'
  return ''
}

/**
 * What a file in a zip may be, from its first bytes: a video or a WAV recording (Blobs, if big),
 * or something to read whole and look at (a photo, a document, other audio); null for anything
 * else, which goes in the zip as it is. An Office file starts as any zip does, so its name says.
 */
function memberKind(head: Uint8Array, name: string): 'video' | 'wav' | 'read' | null {
  let kind: string | null
  try {
    kind = detectKind(head) ?? describeOther(head)
  } catch {
    return null
  }
  if (kind === 'mp4' || kind === 'mov') return 'video'
  if (kind === 'wav') return 'wav'
  // Tagged audio (ID3) can carry cover art longer than what's read here.
  const tagged = head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33
  const documents = ['pdf', 'rtf', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp']
  if (tagged || photoInfo(head) || ['jpeg', 'png', 'webp', 'gif', 'heic', 'avif', 'mp3', 'flac', 'm4a', 'ogg', ...documents].includes(kind ?? '')) return 'read'
  return kind === 'zip' && /\.(docx|xlsx|pptx|odt|ods|odp)$/i.test(name) ? 'read' : null
}

// Every list's rows are numbered together: the document worker keeps each document under its number.
let nextRowId = 1

/** What every row starts with: a host's newRow adds what it draws with. */
export function baseRow(file: File) {
  return {
    file,
    name: file.name,
    suggested: suggestNeutralName(file.name),
    state: 'reading' as RowState,
    useOriginal: false,
    sendAsIs: false,
    useFull: false,
    seq: 0,
    n: nextRowId++,
  }
}

/** A PDF or an Office file whose pictures Slynk could make smaller, from its first bytes. */
function docKind(data: Uint8Array): DocKind | null {
  try {
    const kind = detectKind(data)
    return kind === 'pdf' ? 'pdf' : kind && OFFICE.has(kind) ? 'office' : null
  } catch {
    return null
  }
}

/** A video's size the way up it plays: a phone's portrait video is stored on its side. */
export const uprightDims = (d: Dims, rotation: number): Dims => (rotation === 90 || rotation === 270 ? { width: d.height, height: d.width } : d)

export function createFileList<Row extends ListRow<Row>>(o: ListOptions<Row>) {
  const { checkCanvas, measure, keptCopy, makeCopy, measureDoc, makeDoc, dropDoc, stopDoc, shrinkInWorker, audioInWorker, decodeWhole, canShrinkAudio } = o.makers
  const settings = o.settings
  const updateRow = (row: Row) => o.updateRow(row)
  const bare = o.framing === 'none'
  const rows: Row[] = []
  /** Copies being made: photos done of total; or a video or document, index of count, done 0 to 1. */
  let shrinking:
    | {
        done: number
        total: number
        video?: { index: number; count: number; done: number }
        doc?: { index: number; count: number; done: number }
        audio?: { index: number; count: number; done: number }
      }
    | undefined
  let job: { row: Row; stop: { abort(): void } } | undefined // the video, document or audio being made smaller
  // A new "Smallest photos" or "Smallest videos" level that job isn't for: what it is for is made again when its run ends.
  let levelPending: ((row: Row) => boolean) | undefined
  let decodingHere: Promise<unknown> = Promise.resolve() // audio being decoded on the page (makeAudio), which can't be stopped
  let lastAdded = 0
  let placing: Promise<void> = Promise.resolve() // rows are looked at in the order they came
  let shrinkRun = 0 // bumps when the list is cleared, so a run in progress stops
  let canvasBlocked = false // the browser handed back a blank picture last time
  let copiesChosen = false // the sender asked for smaller copies: photos added since get them without asking again
  // The last run of copies: its photos, and the space everything else left them. A run
  // starts by itself only when these change, so a copy that failed isn't tried again in a loop.
  let lastPhotos: string | undefined
  let lastAuto: string | undefined
  // "Smallest"'s last run couldn't fit them: it tries again whenever their space changes (the review, 2026-10-26).
  let unfit = false

  // Work under way, so a host with no screen can wait for it all to settle (idle).
  let inFlight = 0
  const onIdle: (() => void)[] = []
  function track<T>(work: Promise<T>): Promise<T> {
    inFlight++
    const settle = () => {
      if (--inFlight) return
      for (const wake of onIdle.splice(0)) wake()
    }
    void work.then(settle, (e) => {
      settle()
      throw e
    })
    return work
  }

  /** Resolves once nothing is being read, cleaned, compressed or made smaller, and nothing is about to be. */
  function idle(): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (inFlight) return void onIdle.push(check)
        // A moment more: what just ended may start more (the host's redraw starting a run).
        setTimeout(() => (inFlight ? onIdle.push(check) : resolve()), 0)
      }
      check()
    })
  }

  /** A file's wire size with these bytes, name and type: its item in Slynk's envelope, or (framing 'none') its bytes alone. */
  const wireOf = (name: string, type: string, length: number) => (bare ? length : itemOf(name, type, length))

  /** What a file adds to what's sent with these bytes and name: as an item of its own, or inside its zip (folders and all). */
  function wireAs(row: Row, name: string, type: string, length: number): number {
    if (!row.entry) return wireOf(name, type, length)
    const dir = row.entry.slice(0, row.entry.lastIndexOf('/') + 1)
    return ZIP_ENTRY + 2 * new TextEncoder().encode(dir + name).length + length
  }

  const inCopy = (row: Row) => (!!row.copy || !!row.vcopy || !!row.dcopy || !!row.acopy) && !row.useFull
  /** The photo at full size (cleaned, if it was) is over the limit by itself, so no choice of copies could fit it. A video never read can't go at all. */
  function fullTooBig(row: Row): boolean {
    if (!row.data) return true
    const full = bytesToSend(row.data, row.strip, row)
    return !!full && wireAs(row, baseName(row), row.file.type, full.data.length) > o.limit()
  }

  /**
   * Going as it is, though that's too big to send even on its own: a photo at full size ("Ask first", or "Send full size
   * instead"), a file Slynk can't make smaller. Not while Brotli may yet make it fit. A screen also waits while it may yet
   * be made smaller (tray.ts goesTooBig).
   */
  function tooBigAsIs(row: Row): boolean {
    const s = row.sending
    if (!s || inCopy(row) || row.squeezing || asking(row)) return false
    // As it goes: inside its zip, or as an item of its own.
    const length = row.parent ? (packedLength(s.data) ?? s.data.length) : s.stored.body.length
    return wireAs(row, sentName(row), sentType(row), length) > o.limit()
  }

  /**
   * Too big to go even on its own, whatever is made smaller: a file too big to read, one Slynk can't make smaller, or a zip
   * still too big without its files that can be (its own bytes and the files in it that go as they are). A zip of photos
   * was named as too large while its photos could make room (2026-10-31).
   */
  function tooBigAlone(c: Compose<Row>, row: Row): boolean {
    if (row.state === 'too-big') return true
    if (!tooBigAsIs(row) || shareable(row)) return false
    const members = row.zip?.members ?? []
    const rest = members.reduce((n, m) => n + (shareable(m) ? 0 : (c.rowWire.get(m) ?? 0)), c.rowWire.get(row) ?? 0)
    return !members.some(shareable) || rest > o.limit()
  }

  /** The name it goes under before any copy's new extension: a plain one ("Plain file names") if its own gives something away. */
  const baseName = (row: Row) => (settings().plainNames && row.suggested ? row.suggested : row.name)
  // A document made smaller keeps its kind and name.
  const sentType = (row: Row) => (inCopy(row) && !row.dcopy ? (row.vcopy ? 'video/mp4' : row.acopy ? 'audio/mp4' : row.copy!.type) : row.file.type)
  const sentName = (row: Row) => (inCopy(row) && !row.dcopy ? copyName(baseName(row), sentType(row)) : baseName(row))
  /** A photo, video or audio made smaller, which never holds the original's hidden details. A document keeps whatever its own still had. */
  const newPicture = (row: Row) => inCopy(row) && !row.dcopy

  /**
   * Forgets a document's measurements and smaller version: its bytes changed (cleaned again, or
   * "Send original instead"). Anything still being measured or made for the old bytes is thrown
   * away when it comes back (dgen), even if the worker couldn't stop in time.
   */
  function resetDoc(row: Row) {
    row.dgen = (row.dgen ?? 0) + 1
    if (job?.row === row) job.stop.abort()
    if (row.doc) dropDoc(row.n)
    row.dmeasured = row.dcopy = row.docProblem = undefined
    row.dmaking = undefined
    row.dqueued = false
    lastAuto = lastPhotos = undefined // plan again
  }
  const asking = (row: Row) => row.state === 'ready' && !row.sending

  /** Adds files: each new one's row, in their order, or undefined for one already on the list. */
  function add(files: File[]): (Row | undefined)[] {
    if (!files.length) return []
    o.added?.()
    lastAdded = Date.now()
    // Copies being made for the space as it was: stop, and plan again once the new files are in
    // (with any new level's photos or videos made again).
    if (shrinking) {
      shrinkRun++
      shrinking = undefined
      job?.stop.abort()
      unqueue()
      if (levelPending) track(fullSize(true, levelPending))
    }
    return files.map((file) => {
      if (rows.some((r) => r.file.name === file.name && r.file.size === file.size && r.file.lastModified === file.lastModified)) {
        o.toast(alreadyListed(file.name))
        return undefined
      }
      const row = o.newRow(file)
      rows.push(row)
      updateRow(row)
      placing = placing.then(() => place(row)).catch(() => {})
      track(placing)
      return row
    })
  }

  /**
   * Looks at a file before reading it: a video too big to go as it is is
   * never read (only a smaller version of it can go); anything else is read
   * and cleaned as before, within the read budget, in the order added.
   */
  async function place(row: Row) {
    if (!rows.includes(row)) return
    const v = (row.video = await videoInfo(row.file))
    if (!rows.includes(row)) return
    row.placed = true
    if (v && wireAs(row, row.name, row.file.type, row.file.size) > o.limit()) {
      row.state = 'video'
      const least = leastBytes(v) + wireAs(row, copyName(row.name, 'video/mp4'), 'video/mp4', 0)
      row.videoProblem = v.can !== 'yes' ? v.can : least > o.planLimit() ? 'long' : undefined
      updateRow(row)
      track(lookInside(row))
      // One of a zip's files: the zip, which waited for it, is now too big as it is.
      if (row.parent) track(repack(row.parent))
      return
    }
    // A long WAV: like a video, only its header is read, and only a smaller version of it can go.
    if (row.file.size > HOPELESS_SIZE && row.file.size <= HOPELESS_WAV) {
      const a = await wavInfo(row.file)
      if (!rows.includes(row)) return
      if (a && wireAs(row, row.name, row.file.type, row.file.size) > o.limit()) {
        row.audio = a
        row.state = 'video'
        const least = audioLeastBytes(a) + wireAs(row, copyName(row.name, 'audio/mp4'), 'audio/mp4', 0)
        row.audioProblem = canShrinkAudio(a) !== 'yes' ? 'browser' : least > o.planLimit() ? 'long' : undefined
        updateRow(row)
        if (row.parent) track(repack(row.parent))
        return
      }
    }
    // A plain zip with photos, videos, audio or documents in it: read as a video is, never whole.
    if (!row.parent && (await openZip(row))) return
    if (!rows.includes(row)) return
    const budget = READ_BUDGET - rows.reduce((n, r) => n + (r !== row && r.read && r.state !== 'too-big' ? r.file.size : 0), 0)
    const hopeless = looksLikeDoc(row.file) || looksLikeAudio(row.file) || looksLikeZip(row.file) ? HOPELESS_DOC : HOPELESS_SIZE
    // A zip's file read with the zip was read within the read budget; one that's a Blob is looked at as a file on its own is.
    if ((!row.parent || !row.data) && (row.file.size > hopeless || row.file.size > budget)) {
      row.state = 'too-big'
      updateRow(row)
      return
    }
    row.read = true
    track(processRow(row))
  }

  /** What a video never read holds, for its chip once it's made smaller: only while hidden details are removed, as for every file. */
  async function lookInside(row: Row) {
    row.held = undefined
    if (!settings().stripMetadata) return updateRow(row)
    const held = await videoHeld(row.file)
    if (!rows.includes(row) || !settings().stripMetadata) return
    row.held = held
    updateRow(row)
  }

  /** Drops a row's work and what it made, once the row is gone. */
  function forgetRow(row: Row) {
    row.seq++
    stopSqueeze(row)
    if (row.doc) dropDoc(row.n)
    row.dcopy = row.dmeasured = undefined
    row.acopy = undefined
    row.strip = row.held = undefined
    o.forgot?.(row)
  }

  /**
   * Takes a file off the list, a zip's files with it. One of a zip's files is left out of the zip; a
   * zip left with no file to list goes too, rather than go empty (or with only what a computer added
   * by itself): that zip is returned.
   */
  function remove(row: Row): Row | undefined {
    const i = rows.indexOf(row)
    if (i < 0) return
    rows.splice(i, 1)
    if (job?.row === row) job.stop.abort()
    forgetRow(row)
    // A zip's files go with it; one of its files taken off the list is left out of it.
    for (const m of row.zip?.members ?? []) {
      rows.splice(rows.indexOf(m), 1)
      if (job?.row === m) job.stop.abort()
      forgetRow(m)
    }
    const zip = row.parent?.zip
    if (zip && rows.includes(row.parent!)) {
      zip.members = zip.members.filter((m) => m !== row)
      zip.dropped.add(row.entry!)
      if (emptied(row.parent!)) return row.parent
      track(repack(row.parent!))
    }
    if (!rows.length) copiesChosen = false // starting again: the next photos are offered copies afresh
    o.changed()
  }

  /** A zip whose last listed file was taken out goes too: true when it did. */
  function emptied(zip: Row): boolean {
    const z = zip.zip
    if (!z || z.members.length || z.plain.length) return false
    remove(zip)
    return true
  }

  /** Reads the file if needed, cleans it when that's on, then packs it. */
  async function processRow(row: Row) {
    const seq = ++row.seq
    const live = () => seq === row.seq && rows.includes(row)
    row.sending = undefined
    if (!row.data) {
      row.state = 'reading'
      updateRow(row)
      try {
        row.data = new Uint8Array(await row.file.arrayBuffer())
      } catch {
        if (live()) o.unreadable(row, `Couldn’t read ${row.file.name}`)
        return
      }
      if (!live()) return
      row.photo = photoInfo(row.data)
      row.doc = docKind(row.data)
      row.svg = !row.photo && !row.doc && isSvgPicture(row.data)
      row.audio = row.photo || row.doc || row.svg ? null : await audioInfo(row.data)
      if (!live()) return
    }
    if (row.doc) resetDoc(row)
    row.strip = undefined
    row.sendAsIs = false // a new attempt gets a new question
    if (settings().stripMetadata) {
      row.state = 'cleaning'
      updateRow(row)
      const strip = await clean(row.data, row.zip?.skip)
      if (!live()) return
      row.strip = strip
    }
    await packRow(row, seq)
  }

  /**
   * A plain zip, read as a video is, never whole (zipFile.ts), so it needs no size limit of its
   * own. Its photos, videos, audio and documents become rows of their own under it (its members):
   * photos, documents and short recordings read whole, within the read budget and the limits
   * they'd have on their own; videos and long WAV recordings unpacked by the browser into Blobs,
   * to be read a run at a time. The rest of it, its "skeleton", is what's read and cleaned as the
   * zip's own bytes. Not a locked zip, links, or files packed in ways Slynk can't unpack: those,
   * and every other file, go in the zip as they are (as the cleaner leaves them). False when it
   * isn't a plain zip with any of those: it's then read as any file is.
   */
  async function openZip(row: Row): Promise<boolean> {
    row.zip = null
    const zip = await readZipIndex(row.file)
    if (!zip || zip.entries.some((e) => e.flags & 1) || !rows.includes(row)) return false
    // Every file a sender would see in it: not folders, nor what a computer added by itself.
    const listed: IndexEntry[] = []
    for (const e of zip.entries) {
      if (e.name.endsWith('/') || systemName(e.name, e.usize)) continue
      // macOS's "._" companion of a file, which the cleaner takes out (strip/archive.ts).
      if (/(^|\/)\._[^/]*$/.test(e.name) && e.usize >= 26 && (e.method === 0 || e.method === 8)) {
        const head = await entryHead(zip, e, 4).catch(() => new Uint8Array())
        if (head.length === 4 && head[0] === 0 && head[1] === 5 && head[2] === 0x16 && head[3] === 7) continue
      }
      listed.push(e)
    }
    let budget = READ_BUDGET - rows.reduce((n, r) => n + (r !== row && r.read && r.state !== 'too-big' ? r.file.size : 0), 0)
    let unpacked = 0
    const found: Row[] = []
    for (const e of listed) {
      if (found.length >= MAX_MEMBERS || !rows.includes(row)) break
      if ((modeOf(e) & 0o170000) !== 0o100000 || (e.method !== 0 && e.method !== 8) || e.usize < 8) continue
      // Its name to show, decoded as the zip meant it (the zip keeps its own bytes).
      const name = shownName(e.name.slice(e.name.lastIndexOf('/') + 1), !!(e.flags & 0x800))
      try {
        const kind = memberKind(await entryHead(zip, e, MEMBER_HEAD), name)
        if (!kind) continue
        // A video, or a WAV recording too long to read whole: a Blob, as a file on its own would be.
        if (kind === 'video' || (kind === 'wav' && e.usize > HOPELESS_SIZE)) {
          if (kind === 'wav' && e.usize > HOPELESS_WAV) continue
          if (e.method === 8 && (e.usize > MAX_UNPACK || unpacked + e.usize > MAX_UNPACKED)) continue
          const type = kind === 'wav' ? 'audio/wav' : 'video/mp4'
          const file = new File([await entryBlob(zip, e, type)], name, { type })
          if (e.method === 8) unpacked += e.usize
          found.push(member(row, e, file))
          continue
        }
        if (e.usize > Math.min(HOPELESS_DOC, budget)) continue
        const bytes = await entryBytes(zip, e)
        const photo = photoInfo(bytes)
        const doc = photo ? null : docKind(bytes)
        const audio = photo || doc ? null : await audioInfo(bytes)
        if (!photo && !doc && !audio) continue
        budget -= bytes.length
        found.push(member(row, e, new File([bytes as BlobPart], name, { type: typeFrom(bytes, audio) }), { data: bytes, read: true, photo, doc, audio } as Partial<Row>))
      } catch {
        // Damaged, or it couldn't be unpacked: it goes in the zip as it is.
      }
    }
    if (!rows.includes(row)) return true
    // The rest go as they are, each listed with a way to take it out. One too big to fit even
    // alone is left out of the zip's own bytes (read only if it stays, which can't be sent).
    const members = new Set(found.map((m) => m.entry!))
    const plain = listed.filter((e) => !members.has(e.name)).map((e) => plainFile(e))
    if (!found.length && !plain.length) return false
    const held = [...members, ...plain.filter((p) => p.tooBig).map((p) => p.entry)]
    try {
      row.data = await skeleton(zip, new Set(held), READ_BUDGET)
    } catch {
      row.state = 'too-big'
      updateRow(row)
      return true
    }
    // Small enough to go as it is: kept exactly as it was, for when nothing in it changes.
    const whole = row.file.size <= o.limit() ? new Uint8Array(await row.file.arrayBuffer()) : undefined
    if (!rows.includes(row)) return true
    row.zip = { members: found, plain, gone: [], skip: held, dropped: new Set(), whole }
    o.zipOpened?.(row)
    // Listed as a folder shows them, by name (the zip keeps its own order).
    const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
    rows.splice(rows.indexOf(row) + 1, 0, ...found.sort((a, b) => byName(a.entry!, b.entry!)))
    for (const m of found) {
      updateRow(m)
      placing = placing.then(() => place(m)).catch(() => {})
      track(placing)
    }
    track(processRow(row))
    return true
  }

  /** One of a zip's files that goes as it is: its size in the zip, and whether it can go at all. */
  function plainFile(e: IndexEntry): PlainFile {
    // In the zip it takes its packed bytes and its two headers.
    const tooBig = ZIP_ENTRY + 2 * new TextEncoder().encode(e.name).length + e.csize > o.limit()
    return { entry: e.name, size: e.csize, usize: e.usize, tooBig, header: e }
  }

  /**
   * Takes a file that goes as it is out of its zip: the zip is cleaned again without it, so what it says of
   * the rest stays true. True when that was the last file listed in it, so the zip went too.
   */
  function dropPlain(zip: Row, p: PlainFile): boolean {
    const z = zip.zip
    if (!z || !rows.includes(zip)) return false
    z.plain = z.plain.filter((x) => x !== p)
    z.gone.push(p)
    z.dropped.add(p.entry)
    if (!z.skip.includes(p.entry)) z.skip.push(p.entry)
    if (emptied(zip)) return true
    track(processRow(zip))
    return false
  }

  /** One of a zip's files as a row of its own: what's known of it already (read whole), or nothing yet (a Blob, looked at as a file is). */
  function member(zip: Row, e: IndexEntry, file: File, known: Partial<Row> = {}): Row {
    const m = o.newRow(file, { zip, header: e })
    Object.assign(m, { parent: zip, entry: e.name, ...known })
    return m
  }

  /** skip: a zip's files that are rows of their own, cleaned as those. */
  async function clean(data: Uint8Array, skip?: string[]): Promise<StripResult> {
    try {
      // A copy, so the original stays intact whatever the stripper does with its input. PDFs
      // too, like every other file: "Send original instead" undoes it.
      return await cleanFile(data.slice(), { pdf: true, skip })
    } catch (e) {
      return { status: 'failed', kind: 'unknown', error: errorText(e) }
    }
  }

  /** "Send original instead" ticked or not: a document's measurements were for the other bytes. */
  function setOriginal(row: Row, on: boolean) {
    row.useOriginal = on
    if (row.doc) resetDoc(row)
    track(packRow(row))
  }

  /** The sender's answer for a file that couldn't be cleaned: send it as it is. */
  function answer(row: Row) {
    row.sendAsIs = true
    track(packRow(row))
  }

  /** "Send full size instead" ticked or not. */
  function setFull(row: Row, on: boolean) {
    row.useFull = on
    track(repack(row))
  }

  /** Compresses whichever version will be sent, or waits for an answer. */
  async function packRow(row: Row, seq = ++row.seq) {
    const live = () => seq === row.seq && rows.includes(row)
    row.sending = undefined
    // A video never read has nothing to send until it's made smaller.
    if (!inCopy(row) && !row.data) {
      stopSqueeze(row)
      row.state = 'video'
      updateRow(row)
      // One of a zip's files: the zip, which carried its smaller version, can't go as it was.
      if (row.parent && rows.includes(row.parent)) await repack(row.parent)
      return
    }
    // A zip taken on is made from its files as they go: new bytes, so Brotli starts again.
    if (row.zip) {
      stopSqueeze(row)
      return packZip(row)
    }
    // A copy never holds the photo's hidden details, so it needs no question
    // about them; it's flagged as cleaned when the photo had some removed.
    const pick = row.dcopy && inCopy(row)
      ? { data: row.dcopy.data, stripped: row.dcopy.stripped }
      : inCopy(row)
        ? { data: row.vcopy?.data ?? row.acopy?.data ?? row.copy!.data, stripped: row.strip?.status === 'cleaned' }
        : bytesToSend(row.data!, row.strip, row)
    // Brotli at work on other bytes stops; on these same bytes (hidden details left as they were, say), it goes on.
    if (row.squeezeData !== pick?.data) stopSqueeze(row)
    if (pick) {
      row.state = 'packing'
      updateRow(row)
      // A zip's file goes inside it, compressed there if that's worth it (zipInside.ts), not on its own.
      const stored: Stored = row.parent || o.deflate === false ? { body: pick.data, method: 'as-is' } : await storeOnce(pick.data)
      if (!live()) return
      row.sending = { ...pick, stored }
    }
    row.state = 'ready' // with nothing to send yet if the sender still has to answer
    if (row.audio) audioLimits(row)
    // Brotli marked as at work before the redraw, so the offer waits for it rather than make it smaller at once.
    if (!row.parent) track(squeezeRow(row))
    updateRow(row)
    // One of a zip's files: the zip is made again with it as it goes now (once the zip is read and cleaned).
    if (row.parent && rows.includes(row.parent)) await repack(row.parent)
  }

  /**
   * With "Stronger compression" on, Brotli's smaller version of what a file sends, once it's made:
   * until then (and if Brotli fails) it goes deflated, so the setting never makes anyone wait.
   */
  async function squeezeRow(row: Row) {
    const s = row.sending
    // A zip's file goes inside the zip, which is already compressed file by file.
    if (!s || row.parent || row.zip || !settings().brotli || s.stored.method === 'brotli') return
    let better = squeezed.get(s.data)
    if (!better) {
      // Already at work on these bytes: that result is used for whatever sends them then.
      if (row.squeezing && row.squeezeData === s.data) return
      const stop = startSqueeze(row, s.data)
      try {
        better = await squeeze(s.data, s.stored, qualityFor(s.data.length), stop.signal)
      } catch {
        return // stopped: the file was taken off, or its work started again on other bytes
      } finally {
        endSqueeze(row, stop)
      }
      squeezed.set(s.data, better)
    }
    // Applied to what sends these bytes now, which may have been packed again meanwhile.
    const now = row.sending
    if (!now || now.data !== s.data || !rows.includes(row) || !settings().brotli || better.body.length >= now.stored.body.length) {
      // No smaller: the offer may still have been waiting for it, and the row may be too big to go after all (goesTooBig).
      if (rows.includes(row)) updateRow(row)
      return
    }
    row.sending = { ...now, stored: better }
    updateRow(row)
  }

  function startSqueeze(row: Row, data: Uint8Array): AbortController {
    row.squeezeFrom = Date.now()
    row.squeezeData = data
    return (row.squeezing = new AbortController())
  }

  /** Brotli's work for a row is over. The caller redraws once its result is in place, never before: the offer acts on what it sees. */
  function endSqueeze(row: Row, stop: AbortController) {
    if (row.squeezing !== stop) return
    row.squeezing = row.squeezeFrom = row.squeezeData = undefined
  }

  /** Stops Brotli's work for a row, if any, and stops counting it as at work at once. */
  function stopSqueeze(row: Row) {
    row.squeezing?.abort()
    row.squeezing = row.squeezeFrom = row.squeezeData = undefined
  }

  // Over the limit while "Stronger compression" is at work on files, the offer gives it a moment
  // before making anything smaller or calling them too big, so only what still doesn't fit is made
  // smaller: 10 s, or 20 when it might make them fit on its own.
  const BROTLI_WAIT_MS = 10_000
  const BROTLI_WAIT_LONGER_MS = 20_000
  let brotliTimer: ReturnType<typeof setTimeout> | undefined

  /**
   * How much longer the offer waits for Brotli, in ms: 0 once it's done, or it's had its time. When
   * it might make them fit on its own, the offer waits for all of it; otherwise only for files that
   * won't be made smaller, since the plan judges those that will by their own sizes (the review,
   * 2026-10-26): Brotli on what's left over can still leave them more room.
   */
  function brotliWaitLeft(c: Compose<Row>): number {
    if (!settings().brotli) return 0
    const busy = rows.filter((r) => r.squeezing && r.squeezeFrom !== undefined && r.sending)
    if (!busy.length) return 0
    // At best, about half what deflate left of what it's at work on (51% off a PDF deflate couldn't touch, 2026-10-26).
    const hope = busy.reduce((n, r) => n + r.sending!.stored.body.length / 2, 0)
    const enough = c.wire - hope <= o.limit()
    const counted = enough ? busy : busy.filter((r) => !shareable(r))
    if (!counted.length) return 0
    const left = Math.max(...counted.map((r) => r.squeezeFrom!)) + (enough ? BROTLI_WAIT_LONGER_MS : BROTLI_WAIT_MS) - Date.now()
    if (left <= 0) return 0
    clearTimeout(brotliTimer)
    brotliTimer = setTimeout(() => o.changed(), left + 50)
    return left
  }

  /**
   * With "Stronger compression" on, a zip written afresh goes unpacked and squeezed whole with
   * Brotli (zipInside.ts), when that's smaller, once it's made: until then (and if Brotli fails)
   * it goes as rebuildZip wrote it. Not tried for a zip of photos and the like, already
   * compressed, which unpacked is hardly bigger.
   */
  async function squeezeZip(row: Row, unpacked: () => Uint8Array | null) {
    const s = row.sending
    // Not while copies are made: each one writes the zip again (squeezed once they're done).
    if (!s || !settings().brotli || shrinking || s.stored.method === 'brotli') return
    let better = squeezed.get(s.data)
    if (!better) {
      const plain = unpacked()
      if (!plain || plain.length < s.data.length * 1.2) better = s.stored
      else {
        const stop = startSqueeze(row, s.data)
        try {
          const body = await brotli(plain, qualityFor(plain.length), stop.signal)
          better = body.length < s.data.length * 0.95 ? { body, method: 'brotli', unpacked: plain.length } : s.stored
        } catch (e) {
          if (e instanceof DOMException && e.name === 'AbortError') return
          better = s.stored
        } finally {
          endSqueeze(row, stop)
        }
      }
      squeezed.set(s.data, better)
    }
    if (row.sending !== s || !rows.includes(row) || !settings().brotli || better === s.stored) {
      if (rows.includes(row)) o.changed()
      return
    }
    row.sending = { ...s, stored: better }
    // Its files' own sizes in it no longer apply: it goes squeezed whole.
    o.zipSqueezed?.(row)
    updateRow(row)
  }

  /** Once copies are done: the zips written afresh meanwhile, squeezed. */
  function squeezeZips() {
    for (const row of rows) if (row.zip && row.zipUnpacked && row.sending) track(squeezeZip(row, row.zipUnpacked))
  }

  /** Sending has begun: Brotli stops, so it doesn't compete with the upload. What it made is kept. */
  function stopSqueezing() {
    rows.forEach(stopSqueeze)
  }

  /** "Stronger compression" turned off: every file goes deflated again, as store() makes it, and a zip as rebuildZip wrote it. */
  async function unsqueeze() {
    for (const row of rows) {
      stopSqueeze(row)
      const s = row.sending
      if (!s || s.stored.method !== 'brotli') continue
      const stored: Stored = row.zip || o.deflate === false ? { body: s.data, method: 'as-is' } : await storeOnce(s.data)
      if (row.sending !== s) continue
      row.sending = { ...s, stored }
      updateRow(row)
    }
    o.changed() // the offer stops waiting for it
  }

  /** What one of a zip's files puts in it now: what it sends (none while it's worked on, or waits to be made smaller). */
  const memberData = (m: Row) => m.sending?.data

  /**
   * The zip as it goes: its skeleton as cleaned (or as it was, as the sender chose), with each of
   * its files that's a row of its own as that goes, in its empty place and under its new name if
   * it has one; undefined until they're all ready. A small zip with nothing changed goes exactly
   * as it was.
   */
  function zipToSend(
    row: Row,
    base: Uint8Array,
  ): { data: Uint8Array; from: Uint8Array[]; packed: Map<string, number>; unpacked?: () => Uint8Array | null } | undefined {
    const z = row.zip!
    const from: Uint8Array[] = []
    for (const m of z.members) {
      const d = memberData(m)
      if (!d) return undefined
      from.push(d)
    }
    // One not renamed keeps its name's own bytes; a renamed one is written in UTF-8, as it's shown.
    const files = z.members.map((m, i) => ({ entry: m.entry!, name: sentName(m) === m.name ? m.entry!.slice(m.entry!.lastIndexOf('/') + 1) : sentName(m), data: from[i], same: false }))
    // The sender keeps its own details: as it was, but for the files that changed, and exactly as
    // it was if none did. Otherwise it's written afresh, so nothing of it goes that the cleaner
    // didn't see (bytes between its files, extra fields it doesn't name).
    if (keepsDetails(row)) {
      const same = !z.dropped.size && z.members.every((m, i) => from[i] === m.data && sentName(m) === m.name)
      if (same && z.whole) return { data: z.whole, from, packed: new Map() }
      return { ...keepZip(base, files, z.dropped), from }
    }
    const rebuilt = rebuildZip(base, files, z.dropped)
    // Not for a zip of photos and the like, which unpacked is hardly bigger: judged before anything is unpacked.
    return { ...rebuilt, from, unpacked: () => unpackedZip(base, files, z.dropped, MAX_BROTLI, rebuilt.data.length * 1.2) }
  }

  /** The sender keeps a zip's own details: "Send original instead", hidden details left in, or sent as it is after cleaning failed. */
  const keepsDetails = (row: Row) => !settings().stripMetadata || row.useOriginal || row.strip?.status === 'failed'

  /**
   * "Hidden details were removed", for the recipient: only when that's true of all of it. Something
   * was removed, from the zip or a file in it; none was kept by choice; and nothing in it went
   * unchecked.
   */
  function zipStripped(row: Row, base: { stripped: boolean }): boolean {
    const z = row.zip!
    if (keepsDetails(row) || Object.keys(uncheckedIn(row)).length) return false
    const clean = (m: Row) => newPicture(m) || !!m.sending?.stripped || m.strip?.status === 'unchanged'
    return z.members.every(clean) && (base.stripped || z.members.some((m) => newPicture(m) || !!m.sending?.stripped))
  }

  /** What a zip's line says went unchecked: what its cleaner counted, and its own files that couldn't be cleaned. */
  function uncheckedIn(row: Row): Record<string, number> {
    const s = row.strip
    const counts: Record<string, number> = { ...(s && (s.status === 'cleaned' || s.status === 'unchanged') ? (s.unchecked ?? {}) : {}) }
    for (const m of row.zip?.members ?? []) {
      // Made anew, it holds none of its original's details; nothing to say without cleaning.
      if (newPicture(m) || !m.strip) continue
      const t = m.strip
      const kind =
        t.status === 'unsupported' && t.kind !== 'text'
          ? (t.kind ?? 'other')
          : t.status === 'skipped'
            ? t.reason === SKIP.encrypted
              ? 'locked'
              : t.reason === SKIP.signed || t.reason === SKIP.signedDocument
                ? 'signed'
                : 'failed'
            : t.status === 'failed' && m.sendAsIs
              ? 'failed'
              : undefined
      if (kind) counts[kind] = (counts[kind] ?? 0) + 1
    }
    return counts
  }

  /**
   * Packs a zip made from its files as they go; or it waits for them, or for the sender's answer
   * (with no bytes of its own to start from); or, while one of them is too big to go and waits to
   * be made smaller, it's too big itself, as a video is ('video').
   */
  function packZip(row: Row) {
    const base = bytesToSend(row.data!, row.strip, row)
    const members = row.zip!.members
    const big = (m: Row) => !m.sending && (m.state === 'video' || m.state === 'too-big')
    const waiting = members.some((m) => !m.sending && !big(m))
    const tooBig = members.some(big) || row.zip!.plain.some((p) => p.tooBig)
    let made: ReturnType<typeof zipToSend>
    try {
      made = base && !waiting && !tooBig ? zipToSend(row, base.data) : undefined
    } catch {
      // It couldn't be written again: it can't go (a zip one reader takes and the other doesn't).
      row.state = 'too-big'
      updateRow(row)
      return
    }
    row.state = !base ? 'ready' : waiting ? 'packing' : tooBig ? 'video' : 'ready'
    if (base && made) {
      row.zip!.from = made.from
      // Not deflated again: its files were compressed one by one, where that's worth it (zipInside.ts).
      row.sending = { data: made.data, stored: { body: made.data, method: 'as-is' }, stripped: zipStripped(row, base) }
      row.zipUnpacked = made.unpacked
      if (made.unpacked) track(squeezeZip(row, made.unpacked))
      // A file that goes as it is, compressed in it now: its row says so, as a file on its own does.
      o.zipMade?.(row, made.packed)
    }
    updateRow(row)
  }

  /**
   * Whether an audio file too big to go as it is could be made smaller at all: not in
   * a browser without what it needs, nor one too long even at its smallest,
   * alone. Said only then: one that fits as it is needs neither.
   */
  function audioLimits(row: Row) {
    const a = row.audio!
    if (row.audioProblem && row.audioProblem !== 'browser' && row.audioProblem !== 'long') return // what a try found stands
    row.audioProblem = undefined
    if (inCopy(row) || !fullTooBig(row)) return
    const least = audioLeastBytes(a) + wireAs(row, copyName(baseName(row), 'audio/mp4'), 'audio/mp4', 0)
    row.audioProblem = canShrinkAudio(a) !== 'yes' || row.audioRefused ? 'browser' : least > o.planLimit() ? 'long' : undefined
  }

  /**
   * Packs a row again after its copy or "Send full size instead" changed. Not
   * while it's still being read or cleaned: that packs it when it's done, and
   * packing now would throw away its cleaning (the photo would go uncleaned).
   */
  function repack(row: Row): Promise<void> {
    if (row.state !== 'reading' && row.state !== 'cleaning') return packRow(row)
    updateRow(row)
    return Promise.resolve()
  }

  /** What would be sent now: text (if any, once compressed) and the files. messages: whether there's text at all. */
  function compose(text: Text | undefined, messages: number): Compose<Row> {
    const packed: Packed[] = []
    const rowWire = new Map<Row, number>()
    let extra = 0
    let raw = 0
    let bodies = 0 // framing 'none': what's sent is these alone
    // Text being typed isn't "pending": it's packed within a moment of the last
    // keystroke, and sending waits for it. Counting it flipped the button and
    // meter on every keystroke. Until then they show the last packed text.
    let pending = false
    let waiting = false
    // A zip sent unpacked unpacks to more than the zip, and the recipient counts that against
    // MAX_DECODED: past it, every zip goes as rebuildZip wrote it (the review, 2026-10-26).
    const unpackedRaw = (text?.stored ? text.data.length : 0) + rows.reduce((n, r) => n + (!r.parent && r.sending ? (r.sending.stored.unpacked ?? r.sending.data.length) : 0), 0)
    const unpack = unpackedRaw <= MAX_DECODED
    if (text?.stored) {
      raw += text.data.length
      bodies += text.stored.body.length
      packed.push(packItem({ kind: 'text', name: '', type: '', data: text.data }, text.stored))
    }
    for (const row of rows) {
      const s = row.sending
      // One of a zip's files goes inside it: counted there, and here as its share of it, for the plan.
      if (row.parent) {
        // At its size in the zip: compressed there, where that was worth it.
        if (s) rowWire.set(row, wireAs(row, sentName(row), '', packedLength(s.data) ?? s.data.length))
        // Too big to go as it is (waiting to be made smaller, or not to be): as big as it is.
        else if (row.state === 'video' || row.state === 'too-big') rowWire.set(row, wireAs(row, row.name, '', row.file.size))
        else if (asking(row)) waiting = true
        else pending = true
        continue
      }
      // A zip waiting for one of its files to be made smaller, or holding one too big: counted below, as it would go.
      if (row.zip && row.state === 'video' && !s) continue
      if (row.state === 'too-big') extra += row.file.size // can't be sent (blocker says so): counted as it is
      else if (row.state === 'video' && !s) {
        // Too big as it is, and not made smaller (yet): over, as it would be.
        extra += row.file.size
        rowWire.set(row, row.file.size)
      } else if (s) {
        const stored: Stored = s.stored.unpacked !== undefined && !unpack ? { body: s.data, method: 'as-is' } : s.stored
        raw += stored.unpacked ?? s.data.length
        const p = packItem({ kind: 'file', name: sentName(row), type: sentType(row), data: s.data, stripped: s.stripped, smaller: newPicture(row) }, stored)
        packed.push(p)
        bodies += stored.body.length
        rowWire.set(row, bare ? stored.body.length : itemWireSize(p))
      } else if (asking(row)) waiting = true
      else pending = true
    }
    // A zip's own share is what's left beside its files'. One not yet made again from them as they
    // are now is still to come; one waiting for one of them to be made smaller is over, as it would
    // go: its skeleton (less its files' empty places) and its files as they are.
    for (const row of rows) {
      const z = row.zip
      if (!z) continue
      const inside = z.members.reduce((n, m) => n + (rowWire.get(m) ?? 0), 0)
      if (row.sending && z.from) {
        if (z.from.length !== z.members.length || z.members.some((m, i) => memberData(m) !== z.from![i])) pending = true
        // Never below nothing: squeezed whole, a zip can go smaller than its files would each.
        rowWire.set(row, Math.max(0, (rowWire.get(row) ?? 0) - inside))
      } else if (row.state === 'video') {
        // Files held back too big, which stay in it as they are: their places are empty in its own bytes.
        const place = (entry: string) => ZIP_ENTRY + 2 * new TextEncoder().encode(entry).length
        const held = z.plain.filter((p) => p.tooBig)
        const places = [...z.members.map((m) => m.entry!), ...held.map((p) => p.entry)].reduce((n, e) => n + place(e), 0)
        const gone = z.gone.filter((p) => !p.tooBig).reduce((n, p) => n + place(p.entry) + p.size, 0)
        const own = Math.max(0, wireOf(sentName(row), row.file.type, row.data!.length) - places - gone) + held.reduce((n, p) => n + place(p.entry) + p.size, 0)
        extra += own + inside
        rowWire.set(row, own)
      }
    }
    const wire = bare ? bodies + extra : packed.length || extra ? envelopeSize(packed) + extra : 0
    return { packed, wire, files: rows.filter((r) => !r.parent).length, messages, raw, pending, asking: waiting, rowWire }
  }

  /** Why these files can't be sent as they are, or '' when they can. */
  function blocker(c: Compose<Row>): string {
    if (c.files > MAX_FILES) return `Too many files (${MAX_FILES} at most)`
    if (shrinking) return workingText()
    // A file that can't go isn't packed, so whatever the meter shows, Send waits until it's taken out: a small file
    // not read because 100 MB already had been left Send on, and would have been left out without a word (2026-10-31).
    if (c.wire > o.limit() || c.raw > MAX_DECODED || rows.some(cantGo)) return 'Too large to send'
    return ''
  }

  /** A file that can't go as things are: too big to read, or too big to go as it is and not made smaller. */
  const cantGo = (row: Row) => row.state === 'too-big' || (row.state === 'video' && !row.sending)

  /** What the files still wait for: an answer about one, or being read, cleaned or compressed. */
  function waiting(c: Compose<Row>): string {
    if (c.asking) return 'Answer the question above first'
    if (c.pending) return 'Getting it ready…'
    return ''
  }

  // --- Smaller copies of photos, and videos made smaller -----------------------------------
  // When it's too large and some of it is photos or videos, the list offers to
  // make smaller versions of them that share the space. With "Make photos and
  // videos smaller to fit" on (the default) it makes them by itself and says
  // so, with a link to turn that off; with it off, it asks, and once the
  // sender has said yes, ones they add later are made smaller too. While
  // there's room the box says more photos are welcome: someone whose first
  // photo was too big shouldn't think that's all that fits.
  //
  // Photos and videos share the space in one calculation (video/plan.ts):
  // each gets the same share of what it would take at a good quality, none
  // below its smallest. A video takes far more at a good quality, so beside a
  // long one the photos go down towards their smallest (1,280 pixels), where
  // they still look fine, and the video, which suffers more, gets the room.
  // A video's share is known from its index alone, so whether everything fits
  // is said before anything slow starts; videos are made last, once additions
  // settle, and only once: a video made smaller
  // keeps that version, and photos added or taken away later share what it
  // leaves. Making it again whenever the photos changed took minutes each time,
  // and one that came out too long kept its older, bigger version, so the box
  // asked for most of the photos to go before it fitted again.

  /** Photos a copy could be made of: still pictures, ready, that could also go as they are. A 'failed' one may be tried again. */
  const copyable = (row: Row) =>
    !!row.photo?.still &&
    row.copyProblem !== 'open' &&
    row.copyProblem !== 'big' &&
    !row.useFull &&
    !!row.sending &&
    !!bytesToSend(row.data!, row.strip, row)

  /**
   * Videos that could be made smaller: too big to go as they are, or read and
   * ready (a short clip). Not one this browser can't do, too long even alone,
   * or that failed (another go would cost minutes, so it waits to be added
   * again); one too long for its share ('tight') is tried again when the
   * space changes.
   */
  const shrinkable = (row: Row) =>
    !!row.video &&
    row.video.can === 'yes' &&
    (!row.videoProblem || row.videoProblem === 'tight') &&
    !row.useFull &&
    (row.state === 'video' || !!row.vcopy || (!!row.sending && !!row.data && !!bytesToSend(row.data, row.strip, row)))

  /**
   * PDFs and Office files that could be made smaller: ready, big
   * enough to be worth it, and not one that can't be (signed, locked, no
   * pictures to make smaller…); one too big for its share ('tight') is tried
   * again when the space changes.
   */
  const docable = (row: Row) =>
    !!row.doc &&
    (!row.docProblem || row.docProblem === 'tight') &&
    !row.useFull &&
    !!row.sending &&
    !!row.data &&
    (bytesToSend(row.data, row.strip, row)?.data.length ?? 0) >= DOC_MIN

  /**
   * Audio files that could be made smaller: ready, in a browser that
   * can, and not one too long even alone or that couldn't be opened or made;
   * one too long for its share ('tight') is tried again when the space changes.
   */
  const audioShareable = (row: Row) =>
    !!row.audio &&
    canShrinkAudio(row.audio) === 'yes' &&
    !row.audioRefused &&
    (!row.audioProblem || row.audioProblem === 'tight') &&
    !row.useFull &&
    // A long WAV never read whole, or one read and ready.
    (row.state === 'video' || !!row.acopy || (!!row.sending && !!row.data && !!bytesToSend(row.data, row.strip, row)))

  /** Everything that shares the space: photos, videos, documents and audio. */
  const shareable = (row: Row) => copyable(row) || shrinkable(row) || docable(row) || audioShareable(row)
  /** Photos among them: what's none of the others. */
  const isPhoto = (row: Row) => !row.video && !row.doc && !row.audio
  /** "Smallest" with "Good" photos: only then is each one's top size measured too (one more drawing each). */
  const wantTop = () => settings().shrink === 'smallest' && settings().smallestPhotos === 'good'
  /** A photo still to be measured: never yet, or without the top size "Good" plans with. */
  const toMeasure = (row: Row) => !row.measured || (wantTop() && !row.measured.top)
  /** How many of these are photos, videos, documents and audio. */
  const kinds = (items: Row[]) => {
    const videos = items.filter((r) => r.video).length
    const docs = items.filter((r) => r.doc).length
    const audio = items.filter((r) => r.audio).length
    return { photos: items.length - videos - docs - audio, videos, docs, audio }
  }

  /** A video already made smaller: it keeps that version, and the rest share what it leaves. */
  const kept = (row: Row) => !!row.video && !!row.vcopy && !row.useFull

  /**
   * What shares the space when it's planned: everything but the videos already
   * made smaller, whose size is then fixed. Only when nothing else is left to
   * make room (a long message written after, say) are they planned again.
   */
  const sharing = (items: Row[]) => {
    const loose = items.filter((r) => !kept(r))
    return loose.length || !items.some(kept) ? loose : items
  }

  /** With "Smallest", the steps its videos may be made at: those of "Smallest videos", best first. */
  const videoSteps = () => (settings().shrink === 'smallest' ? levelSteps(settings().smallestVideos) : undefined)

  /**
   * How the space would be shared between photos (all measured) and videos: a
   * byte target for each (null: it goes as it is), or how many fit at their
   * smallest. lower: photos down to the lowest quality, as "Lower the quality" allows.
   * With "Smallest", videos are planned at the first of steps at which everything fits,
   * all at the same one; the plan's steps are those from it
   * down, for the worker to go on down should a video's sound take more than counted.
   */
  function planCopies(c: Compose<Row>, items: Row[], lower: boolean, steps = videoSteps()): Plan {
    for (let i = 0; ; i++) {
      const plan = planAt(c, items, lower, steps?.[i])
      if (plan.fits || !steps || i >= steps.length - 1 || !items.some((r) => r.video)) return { ...plan, steps: steps?.slice(i) }
    }
  }

  /** The same with videos at one step (with "Smallest"). */
  function planAt(c: Compose<Row>, items: Row[], lower: boolean, step?: VideoStep): { fits: true; targets: (number | null)[] } | { fits: false; count: number } {
    const { space, list, overheads, asIs, ceilings } = shares(c, items, lower, step)
    const plan = allocate(space, list)
    if (!plan.fits) return plan
    const sizes = giveRoom(space, plan.sizes, ceilings)
    return { fits: true, targets: sizes.map((s, i) => (asIs[i] && s >= list[i].full ? null : s - overheads[i])) }
  }

  /**
   * When they can't all fit: each photo's target at its smallest ("Smallest": at its level), fitting or not; null for one
   * as small as it gets already, and for everything else, which is left as it is. "To fit" has a little leeway, as
   * "Smallest" has in aimFor, should the browser's drawing come out a few bytes different.
   */
  function leastTargets(c: Compose<Row>, items: Row[]): (number | null)[] {
    const { list, overheads, asIs } = shares(c, items, true)
    const smallest = settings().shrink === 'smallest'
    return items.map((row, i) => {
      // "Smallest" claims its level as both its full and its least; one a copy wouldn't make smaller goes as it is.
      if (!isPhoto(row) || !row.measured || (smallest ? asIs[i] : list[i].least >= list[i].full)) return null
      const least = list[i].least - overheads[i]
      return smallest ? least : Math.ceil(least * SMALLEST_LEEWAY)
    })
  }

  /**
   * The space photos and videos may share (what everything else leaves), and each one's claim on
   * it. With "Smallest", each claims only what "Smallest" makes it, whatever the room: its least, at
   * the lowest quality, or a photo at the level chosen in Settings → Advanced, and never smaller; a
   * video at step (by default its level's own). ceilings: with "Smallest", how much of the room
   * nobody claims a video may have (its good quality's size), as a ceiling for the worker.
   */
  function shares(
    c: Compose<Row>,
    items: Row[],
    lower: boolean,
    step?: VideoStep,
  ): { space: number; list: Share[]; overheads: number[]; asIs: boolean[]; ceilings: (number | undefined)[] } {
    const smallest = settings().shrink === 'smallest'
    if (smallest) lower = true
    const { smallestPhotos } = settings()
    const videoStep = step ?? levelSteps(settings().smallestVideos)[0]
    const fixed = items.reduce((n, row) => n - (c.rowWire.get(row) ?? 0), c.wire)
    const overheads = items.map((row) => {
      if (row.doc) return wireAs(row, baseName(row), row.file.type, 0) // made smaller, it keeps its name
      const type = row.video ? 'video/mp4' : row.audio ? 'audio/mp4' : row.measured!.type
      return wireAs(row, copyName(baseName(row), type), type, 0)
    })
    const asIs: boolean[] = []
    const ceilings: (number | undefined)[] = []
    const claim = (row: Row, i: number, full: number): Share => {
      const v = row.video
      if (v) {
        // At most what a good quality takes; a short clip that's smaller still goes as it is.
        const good = overheads[i] + goodBytes(v)
        asIs[i] = full <= good
        return { full: Math.min(full, good), least: Math.min(full, overheads[i] + leastBytes(v)), weight: videoWeight(v) }
      }
      const a = row.audio
      if (a) {
        // As a video: at most what a good quality takes; one that's smaller than that already goes as it is.
        const good = overheads[i] + audioGoodBytes(a)
        asIs[i] = full <= good
        return { full: Math.min(full, good), least: Math.min(full, overheads[i] + audioLeastBytes(a)), weight: audioWeight(a, PHOTO_BYTES_PER_PIXEL) }
      }
      if (row.doc) {
        // Its best is its pictures at the top level; its least, at the bottom (lower: the lowest
        // quality). Weighed as a video is, so it comes out at about the photos' quality.
        const m = row.dmeasured!
        const least = overheads[i] + (lower ? m.levels[m.levels.length - 1] : m.levels[m.lowerFrom - 1])
        asIs[i] = true
        return { full, least: Math.min(full, least), weight: Math.max(1, (overheads[i] + m.levels[0]) / PHOTO_BYTES_PER_PIXEL) }
      }
      asIs[i] = true
      const m = row.measured!
      return { full, least: overheads[i] + (lower ? m.lowest : m.least), weight: weight(m.dims) }
    }
    const list = items.map((row, i): Share => {
      const sent = row.data && bytesToSend(row.data, row.strip, row)
      // A document as it's sent, compressed, as it was measured; a photo, video or audio file is never compressed.
      const full = sent ? wireAs(row, baseName(row), row.file.type, row.doc && row.dmeasured ? row.dmeasured.original : sent.data.length) : Infinity
      const share = claim(row, i, full)
      if (!smallest) return share
      // What "Smallest" makes it: a photo above its least with a little leeway, as the browser's
      // drawing may come out a few bytes different, so a copy made for it fits what's planned.
      const m = row.measured
      const aim = row.video
        ? Math.min(share.full, overheads[i] + leastBytes(row.video, videoStep))
        : m
          ? Math.min(share.full, overheads[i] + (smallestPhotos === 'least' ? m.lowest : Math.ceil(levelBytes(m, smallestPhotos) * SMALLEST_LEEWAY)))
          : share.least
      const made = smallestShare(share, full, aim, SMALLEST_SAVES)
      asIs[i] = made.asIs
      // A video's claim is its step's size; what's left is its ceiling: the worker makes it at its step whatever it's given (makeVideo).
      if (row.video && !made.asIs) ceilings[i] = share.full
      return made.share
    })
    // Room for a message to grow beside a video or audio without making it again.
    const slack = !bare && items.some((r) => r.video || r.audio) ? VIDEO_SLACK : 0
    return { space: o.planLimit() - fixed - slack, list, overheads, asIs, ceilings }
  }

  /** Which photos and videos: changes when one is added or removed, or "Send full size instead" changes. */
  const photoSet = (items: Row[]) => items.map((r) => r.n).join(',')
  /** Among the last run's: what it is now (made smaller, or as it is) was settled then. */
  const planned = (row: Row) => !!lastPhotos && lastPhotos.split(',').includes(String(row.n))

  /** Which photos and videos, and the space everything else leaves them: changes with them, or with a message written or cut. */
  function situation(c: Compose<Row>, items: Row[]): string {
    const fixed = items.reduce((n, row) => n - (c.rowWire.get(row) ?? 0), c.wire)
    return `${photoSet(items)}/${o.planLimit() - fixed}`
  }

  /**
   * A photo's copy not as large or as good as copies get, or a document made
   * well below its best: more room could make it better. A video keeps its version.
   */
  const improvable = (row: Row) =>
    row.dcopy
      ? inCopy(row) && !!row.dmeasured && row.dmeasured.levels[0] > row.dcopy.sent * 1.25
      : row.acopy
        ? inCopy(row) && row.acopy.bitrate < goodRate(row.audio!) * 0.95
        : !row.video && inCopy(row) && !!row.measured && (row.copy!.quality < Q_MAX || longEdge(row.copy!.dims) < topEdge(row.measured.dims))

  /** Audio made before should be made again for a new share: it no longer fits, or the share grew by a quarter and it's below a good quality. */
  const remakeAudio = (row: Row, target: number) => {
    const made = row.acopy!
    return made.data.length > target || (target >= made.target * 1.25 && made.bitrate < goodRate(row.audio!) * 0.95)
  }

  /** A document made before should be made again for a new share: it no longer fits, or the share grew by a quarter and it's below its best. As it's sent, as shares count it. */
  const remakeDoc = (row: Row, target: number) => {
    const made = row.dcopy!.sent
    return made > target || (target >= made * 1.25 && row.dmeasured!.levels[0] > made * 1.05)
  }

  /**
   * There are copies, and one more photo like these would still fit at its
   * smallest, with everything else at its smallest too, beside any video at
   * the size it was made (said only when there
   * genuinely is room; it isn't made again to make room, 2026-10-22).
   */
  function roomForMore(c: Compose<Row>, items: Row[]): boolean {
    if (!items.some(inCopy) || c.files >= MAX_FILES) return false
    const known = items.filter((row) => (row.video || row.audio || row.measured || row.dmeasured) && !kept(row))
    const { space, list } = shares(c, known, false)
    const least = list.reduce((n, p) => n + Math.min(p.least, p.full), 0)
    // One more photo: as big as the biggest smallest here, or a typical phone photo's beside only videos and documents.
    const photos = list.filter((_, i) => isPhoto(known[i]))
    const another = photos.length ? Math.max(...photos.map((p) => p.least)) : ANOTHER_PHOTO
    return least + another <= space
  }

  /** What the box says while copies are made: photos done of total, or a video's or document's progress. */
  function workingText(): string {
    const s = shrinking!
    // As far along as the file's bar.
    if (s.video) return shrinkCopy.WORKING_VIDEO(barAt(s.video.done), s.video.index, s.video.count)
    if (s.doc) return shrinkCopy.WORKING_DOC(barAt(s.doc.done), s.doc.index, s.doc.count)
    if (s.audio) return shrinkCopy.WORKING_AUDIO(barAt(s.audio.done), s.audio.index, s.audio.count)
    return shrinkCopy.WORKING(s.done, s.total)
  }

  /** What the box says as a run starts: the photos to measure, or else the first document, audio file or video. */
  function startText(items: Row[]): string {
    const { docs, audio, videos } = kinds(items)
    const photoRows = items.filter(isPhoto)
    return photoRows.length
      ? shrinkCopy.WORKING(0, photoRows.filter(toMeasure).length || photoRows.length)
      : docs
        ? shrinkCopy.WORKING_DOC(0, 1, docs)
        : audio
          ? shrinkCopy.WORKING_AUDIO(0, 1, audio)
          : shrinkCopy.WORKING_VIDEO(0, 1, videos)
  }

  /** The box under the meter: the offer, the work in progress, why it can't fit, or that there's room for more. */
  function offer(c: Compose<Row>): Offer<Row> {
    // An info card while copies are made, or once they fit; the amber warning otherwise.
    if (shrinking) {
      // While a video is made, "Keep this page open…" on a line of its own (it ran on from the percentage).
      return { kind: 'working', look: 'busy', says: [workingText(), ...(shrinking.video ? [BR, shrinkCopy.KEEP_OPEN] : [])] }
    }
    const items = rows.filter(shareable)
    const counts = kinds(items)
    const { photos, videos, docs, audio } = counts
    const over = c.wire > o.limit() && c.files <= MAX_FILES
    const settled = !c.pending && !c.asking && !rows.some((r) => r.state === 'too-big')
    const auto = settings().shrink !== 'ask'
    const smallest = settings().shrink === 'smallest'
    // A file in a zip too big to go even alone: nothing else can make room for it, so the box says what can.
    const holding = rows.find((r) => r.zip?.plain.some((p) => p.tooBig))
    if (over && holding) return { kind: 'held', says: [shrinkCopy.ZIP_TOO_BIG(sentName(holding), holding.zip!.plain.filter((p) => p.tooBig).length)], names: [holding] }
    // "Smallest": whenever photos, videos, audio or documents come or go, each is made as small as
    // it goes, fitting or not. Never twice for the same ones, so one that failed isn't tried in a loop.
    if (smallest && settled && items.length && (photoSet(items) !== lastPhotos || (unfit && situation(c, items) !== lastAuto))) {
      return { kind: 'start', look: 'busy', says: [startText(items)], start: true }
    }
    // Over, while stronger compression is still at work: a moment for it first (brotliWaitLeft).
    if (over && settled && brotliWaitLeft(c) > 0) return { kind: 'squeezing', look: 'busy', says: [shrinkCopy.SQUEEZING] }
    // With the setting on, photos taken away may leave room to make the others'
    // copies better: larger, or back at the usual quality (a video keeps its version).
    if (!over && settled && auto && photoSet(items) !== lastPhotos && items.some(improvable)) {
      const better = items.filter(improvable)
      const betterPhotos = better.filter(isPhoto).length
      const betterDocs = better.filter((r) => r.doc).length
      const says = betterPhotos
        ? shrinkCopy.WORKING(0, betterPhotos)
        : betterDocs
          ? shrinkCopy.WORKING_DOC(0, 1, betterDocs)
          : shrinkCopy.WORKING_AUDIO(0, 1, better.length)
      return { kind: 'start', look: 'busy', says: [says], start: true }
    }
    if (!over && settled && auto && items.some(inCopy)) {
      const made = kinds(items.filter(inCopy))
      // Out of how many of each in the list, those that couldn't be made smaller too: "1 of your photos"
      // where only some were (the review: counting only those that could left "your document" beside three).
      const all = {
        photos: rows.filter((r) => r.photo && isPhoto(r)).length,
        videos: rows.filter((r) => r.video).length,
        docs: rows.filter((r) => r.doc).length,
        audio: rows.filter((r) => r.audio).length,
      }
      if (smallest) {
        // "As small as it can" only where each kind made is at its least ("Smallest photos" and "Smallest videos").
        const least = (!made.photos || settings().smallestPhotos === 'least') && (!made.videos || settings().smallestVideos === 180)
        return { kind: 'made', look: 'room', says: [`${shrinkCopy.SMALLEST(made, all, least)} `, FIT_LINK] }
      }
      const room = roomForMore(c, items)
      // A video can't go at full size, so with only videos made there's no way back to offer; nor, most often, can audio.
      if (videos || docs || audio) {
        const off = made.videos || made.audio ? shrinkCopy.AUTO_MIXED_OFF : shrinkCopy.AUTO_DOCS_OFF
        const says = shrinkCopy.AUTO_MIXED(made, room, all)
        return { kind: 'made', look: 'room', says: made.photos || (made.docs && !made.videos && !made.audio) ? [`${says} ${off} `, OFF_LINK, '.'] : [says] }
      }
      const lowered = items.some((r) => inCopy(r) && !!r.copy && r.copy.quality < Q_FLOOR)
      return { kind: 'made', look: 'room', says: [`${shrinkCopy.AUTO(room, lowered)} `, OFF_LINK, '.'] }
    }
    if (!over && settled && roomForMore(c, items)) return { kind: 'room', look: 'room', says: [shrinkCopy.ROOM] }
    // A file Slynk can't make smaller, too big to go even on its own: nothing else can make room for it, so the box
    // names it rather than say the photos don't fit. Not when it's all there is.
    const stuck = rows.filter((r) => !r.parent && tooBigAlone(c, r))
    if (over && stuck.length && rows.some((r) => !r.parent && !stuck.includes(r))) {
      return { kind: 'alone', says: [shrinkCopy.TOO_LARGE_ALONE(sentName(stuck[0]), stuck.length)], names: stuck }
    }
    if (!items.length || !over || !settled) return { kind: 'hidden', says: [] }
    if (canvasBlocked && photos) return { kind: 'blocked', says: [shrinkCopy.BLOCKED], button: { text: shrinkCopy.TRY_AGAIN, lower: false } }
    // With the setting on, or asked for once: whenever the photos, videos or
    // their space have changed since the last run (one added or taken away, a
    // message written or cut), copies are made again without asking. With the
    // setting on, the run lowers photos' quality too if that's what it takes.
    // Never twice for the same situation, so a copy that failed isn't tried
    // again in a loop.
    if ((auto || copiesChosen) && situation(c, items) !== lastAuto) {
      return { kind: 'start', look: 'busy', says: [startText(items)], start: true }
    }
    // A video, document or audio file came out too big for its share: it's too much, whatever the button would say.
    if (items.some((r) => r.videoProblem === 'tight' || r.docProblem === 'tight' || r.audioProblem === 'tight')) {
      return { kind: 'no-fit', says: [shrinkCopy.NO_FIT_VIDEO(counts)] }
    }
    // Measured before: say straight away if they can't fit, even at their
    // smallest, and offer a lower quality if that would do. A video already
    // made smaller keeps its size, so beside it only the photos are counted:
    // the sender is told how many to remove.
    const shared = sharing(items)
    const left = kinds(shared)
    const plan = shared.every((r) => r.video || r.audio || r.measured || r.dmeasured) ? planCopies(c, shared, false) : undefined
    if (plan && !plan.fits) {
      const lower = planCopies(c, shared, true)
      if (lower.fits && (left.photos || left.docs)) {
        const says = left.photos ? shrinkCopy.LOWER(left.videos || left.docs || left.audio ? 0 : plan.count, left.photos) : shrinkCopy.LOWER_DOCS(left.docs)
        return { kind: 'lower', says: [says], button: { text: shrinkCopy.LOWER_BUTTON, lower: true } }
      }
      if (left.videos || left.docs || left.audio) return { kind: 'no-fit', says: [shrinkCopy.NO_FIT_VIDEO(left)] }
      const says = auto
        ? shrinkCopy.NO_FIT_AUTO(lower.fits ? left.photos : lower.count, left.photos)
        : shrinkCopy.NO_FIT(plan.count, left.photos, lower.fits ? left.photos : lower.count)
      return { kind: 'no-fit', says: [says] }
    }
    const mixed = videos || docs || audio
    return {
      kind: 'offer',
      says: [mixed ? shrinkCopy.OFFER_MIXED(counts) : shrinkCopy.OFFER(photos)],
      button: { text: mixed ? shrinkCopy.OFFER_BUTTON_MIXED(counts) : shrinkCopy.OFFER_BUTTON(photos), lower: false },
    }
  }

  /** The photo's own size, the way round the copy is (the header doesn't know about rotation). */
  function photoSize(row: Row, upright: Dims): Dims {
    const d = row.photo?.dims ?? upright
    return (d.width > d.height) === (upright.width > upright.height) ? d : { width: d.height, height: d.width }
  }

  function copyProblem(e: unknown): NonNullable<Row['copyProblem']> {
    if (e instanceof CopyError && e.reason !== 'failed') return e.reason
    return 'failed'
  }

  /** Why a video couldn't be made smaller, from the worker's answer; undefined when it was stopped. */
  function videoProblem(e: unknown): Row['videoProblem'] {
    const why = errorText(e)
    if (why === 'stopped') return undefined
    // Too long for the share it was given (its sound came out bigger than counted): another share may do.
    if (/too-long/.test(why)) return 'tight'
    if (/can't-decode/.test(why)) return 'open'
    if (/canvas-blocked/.test(why)) return 'blocked'
    if (/no-webcodecs|no-h264-encoder/.test(why)) return 'browser'
    return 'failed'
  }

  /** Resolves once SETTLE_MS have passed since the last file was added: a video takes a while, so it waits for the sender to finish choosing. */
  async function settledAdds() {
    for (let wait = lastAdded + SETTLE_MS - Date.now(); wait > 0; wait = lastAdded + SETTLE_MS - Date.now()) await new Promise((r) => setTimeout(r, wait))
  }

  /** Nothing is waiting its turn any more: the run is over, or stopped. */
  function unqueue() {
    for (const row of rows) {
      if (!row.vqueued && !row.pqueued && row.pmaking === undefined && !row.dqueued && !row.aqueued) continue
      row.vqueued = row.pqueued = row.dqueued = row.aqueued = false
      row.pmaking = undefined
      updateRow(row)
    }
  }

  /** Why a document couldn't be made smaller, from the worker's answer; undefined when it was stopped. */
  function docProblem(e: unknown): Row['docProblem'] {
    const reason = e instanceof DocError ? e.reason : 'failed'
    if (reason === 'stopped' || reason === 'lost') return undefined
    if (reason === 'signed') return 'signed'
    if (reason === 'encrypted') return 'locked'
    if (reason === 'unreadable' || reason === 'older') return 'unreadable'
    if (reason === 'canvas') return 'blocked'
    return 'failed'
  }

  /** Measures a document in the worker, once: its size at every level, with its progress on its row and in the box. */
  async function measureDocument(row: Row, index: number, count: number, live: () => boolean) {
    const gen = row.dgen ?? 0
    const input = bytesToSend(row.data!, row.strip, row)
    if (!input || !live()) return
    shrinking = { done: 0, total: 0, doc: { index, count, done: 0 } }
    row.dmaking = 0
    updateRow(row)
    job = { row, stop: { abort: () => stopDoc(row.n) } }
    try {
      // Its sizes as it will be sent: compressed, as a file on its own is (a zip's file is
      // compressed in the zip with another deflate, so its sizes stay as saved, to be safe).
      const compressed = !row.parent && o.deflate !== false
      const m = await measureDoc(
        row.n,
        row.doc!,
        input.data,
        o.limit(),
        (done) => {
          // Measuring is most of the work: the bar's first nine tenths.
          row.dmaking = Math.max(row.dmaking ?? 0, done * 0.9)
          if (shrinking?.doc) shrinking.doc.done = row.dmaking
          updateRow(row)
        },
        compressed,
      )
      // Gone, or its bytes changed meanwhile: these sizes are for bytes that won't be sent.
      if (!rows.includes(row) || row.dgen !== gen) return
      row.dmeasured = m
      row.dstripped = input.stripped
      // Nothing to gain (no pictures it can make smaller), or too big even at its smallest, alone.
      const overhead = wireAs(row, baseName(row), row.file.type, 0)
      if (!m.pictures && m.tidied >= input.data.length * 0.95) row.docProblem = 'none'
      else if (overhead + m.levels[m.levels.length - 1] > o.limit()) row.docProblem = 'big'
    } catch (e) {
      if (rows.includes(row) && row.dgen === gen) row.docProblem = docProblem(e)
    } finally {
      if (job?.row === row) job = undefined
      row.dmaking = undefined
      updateRow(row)
    }
  }

  /** Makes a measured document for target bytes in the worker, its progress on its row and in the box. */
  async function makeDocument(row: Row, target: number, lower: boolean, index: number, count: number, live: () => boolean) {
    const gen = row.dgen ?? 0
    // Its bytes changed since the plan (measured afresh next time), or the run is over.
    if (!live() || !row.dmeasured) return
    shrinking = { done: 0, total: 0, doc: { index, count, done: 0.9 } }
    row.dqueued = false
    row.dmaking = 0.9
    updateRow(row)
    job = { row, stop: { abort: () => stopDoc(row.n) } }
    const progress = (done: number) => {
      row.dmaking = Math.max(row.dmaking ?? 0, 0.9 + done * 0.1)
      if (shrinking?.doc) shrinking.doc.done = row.dmaking
      updateRow(row)
    }
    try {
      let made = await makeDoc(row.n, target, lower, progress)
      // With "Make … smaller to fit" on, a lower quality is Slynk's call too, when the usual one can't fit this share.
      if (!made && !lower && settings().shrink !== 'ask' && live() && row.dgen === gen) made = await makeDoc(row.n, target, true, progress)
      if (!live() || !rows.includes(row) || row.dgen !== gen) throw new DocError('stopped') // made for a plan or bytes that are gone
      // Too big for its share after all: its older version (if any) goes too, so it can't linger over the limit.
      // Cleaned or not as the bytes it was measured from were.
      row.dcopy = made ? { ...made, target, stripped: !!row.dstripped } : undefined
      row.docProblem = made ? undefined : 'tight'
    } catch (e) {
      if (rows.includes(row) && row.dgen === gen) {
        if (e instanceof DocError && e.reason === 'lost') {
          // The worker was restarted and no longer has it: measured again on the next run.
          row.dmeasured = undefined
          lastAuto = lastPhotos = undefined
        } else {
          const problem = docProblem(e)
          if (problem) row.docProblem = problem
        }
      }
    } finally {
      if (job?.row === row) job = undefined
      row.dmaking = undefined
    }
    if (rows.includes(row)) await repack(row)
  }

  /** Makes a video smaller in the worker for target bytes (with "Smallest", at the first of steps that fits), its progress on its row and in the box. */
  async function makeVideo(row: Row, target: number, steps: VideoStep[] | undefined, index: number, count: number, live: () => boolean) {
    shrinking = { done: 0, total: 0, video: { index, count, done: 0 } }
    row.vqueued = false
    row.vmaking = 0
    updateRow(row)
    const stop = new AbortController()
    job = { row, stop }
    try {
      const r = await shrinkInWorker(
        row.file,
        target,
        (p) => {
          // Reading is quick; the sound takes a few seconds on a phone (its own part of the
          // bar, so it doesn't sit still); the pictures are nearly all the rest. A second try
          // (the first came out too big or too small) goes on from there, never back.
          const pictures = p.pass <= 1 ? [0.12, 0.8] : p.pass === 2 ? [0.82, 0.92] : p.pass === 3 ? [0.93, 0.97] : [0.97, 0.99]
          const done =
            p.stage === 'pictures' ? pictures[0] + (pictures[1] - pictures[0]) * p.done
            : p.stage === 'packing' ? pictures[1]
            : p.stage === 'sound' ? 0.02 + 0.1 * p.done
            : 0.02
          row.vmaking = Math.max(row.vmaking ?? 0, done)
          if (shrinking?.video) shrinking.video.done = row.vmaking
          updateRow(row)
        },
        stop.signal,
        // "Smallest": made at the step planned, or one further down if its sound, which only the worker knows once it's made, takes more than counted; target is a ceiling.
        steps,
      )
      if (!live() || !rows.includes(row)) throw new Error('stopped') // made for a plan that's gone
      const out = r.report.output!
      row.vcopy = {
        data: r.data,
        dims: uprightDims({ width: out.width, height: out.height }, row.video!.rotation),
        fps: out.fps,
        sound: r.report.sound.codec,
      }
      row.videoProblem = undefined
    } catch (e) {
      if (rows.includes(row)) row.videoProblem = videoProblem(e)
    } finally {
      if (job?.row === row) job = undefined
      row.vmaking = undefined
    }
    if (rows.includes(row)) await repack(row)
  }

  /** Why audio couldn't be made smaller, from the worker's answer or the page's decoding; undefined when it was stopped. */
  function audioProblem(e: unknown): Row['audioProblem'] {
    const why = errorText(e)
    if (why === 'stopped') return undefined
    if (/too-long/.test(why)) return 'tight'
    if (/cant-decode/.test(why)) return 'open'
    if (/no-webcodecs|no-opus-encoder/.test(why)) return 'browser'
    return 'failed'
  }

  /**
   * Makes an audio file for target bytes in the worker, its progress
   * on its row and in the box: from its file where the worker's decoder takes
   * it, else from its sound decoded here (FLAC, Ogg, or a browser whose
   * decoder won't take an MP3).
   */
  async function makeAudio(row: Row, target: number, index: number, count: number, live: () => boolean) {
    const a = row.audio!
    const data = row.data // none for a long WAV never read whole: the worker reads it from its file
    shrinking = { done: 0, total: 0, audio: { index, count, done: 0 } }
    row.aqueued = false
    row.amaking = 0
    updateRow(row)
    const stop = new AbortController()
    job = { row, stop }
    const progress = (done: number) => {
      if (stop.signal.aborted) return // a stopped run's decoding here goes on, but says nothing
      row.amaking = Math.max(row.amaking ?? 0, Math.min(0.99, done))
      if (shrinking?.audio) shrinking.audio.done = row.amaking
      updateRow(row)
    }
    // The worker's share of the bar starts here: after decoding on the page, when it was.
    let base = 0
    // Decoding here says nothing of its progress, so its first share of the bar creeps along as
    // it goes, slower as it nears the end (its pace a hundredth of the sound's length: 2.4 s
    // for four minutes, about what a computer takes; a phone's longer decoding meets a slower
    // creep). It can't be stopped, so one still going from a run that was stopped is waited
    // for: never two at once.
    const decodedHere = async (): Promise<AudioInput> => {
      const plan = planAudio(a, target)
      if (!plan) throw new Error('too-long')
      if (!data) throw new Error('cant-decode: never read')
      await decodingHere
      if (stop.signal.aborted) throw new Error('stopped')
      const decoding = decodeWhole(data, a, plan.channels)
      decodingHere = decoding.catch(() => {})
      const started = Date.now()
      const pace = Math.max(1000, a.seconds * 10)
      const creep = setInterval(() => progress(PAGE_DECODE_SHARE * (1 - Math.exp(-(Date.now() - started) / pace))), 200)
      let input: AudioInput
      try {
        input = await decoding
      } catch (e) {
        throw new Error(`cant-decode: ${errorText(e)}`)
      } finally {
        clearInterval(creep)
      }
      if (stop.signal.aborted) throw new Error('stopped') // its sound is let go of here, not handed on
      base = Math.max(PAGE_DECODE_SHARE, row.amaking ?? 0)
      return input
    }
    try {
      // A second try (rare: Opus lands on the size) goes on from where the first ended, never back.
      const share = (p: AudioProgress) => (p.pass === 1 ? p.done * 0.85 : 0.85 + 0.12 * p.done)
      const run = async (input: AudioInput) => audioInWorker(input, target, (p) => progress(base + (1 - base) * share(p)), stop.signal)
      let r
      if (!STREAMED.includes(a.kind)) r = await run(await decodedHere())
      else {
        try {
          r = await run({ file: row.file, kind: a.kind, seconds: a.seconds, channels: a.channels })
        } catch (e) {
          if (!/^cant-decode/.test(errorText(e)) || stop.signal.aborted) throw e
          r = await run(await decodedHere())
        }
      }
      if (!live() || !rows.includes(row)) throw new Error('stopped') // made for a plan that's gone
      // The original's bitrate from its sound alone, not its tags or cover art.
      row.acopy = { data: r.data, bitrate: r.report.bitrate, channels: r.report.channels, target, peaks: r.report.peaks, was: (a.bytes * 8) / a.seconds }
      keepOutline(r.data, r.report.peaks)
      row.audioProblem = undefined
    } catch (e) {
      if (rows.includes(row) && live()) {
        const problem = audioProblem(e)
        if (problem) {
          row.audioProblem = problem
          if (problem === 'browser') row.audioRefused = true
          // Too big for its share now: its older version goes too, so it can't linger over the limit.
          row.acopy = undefined
        }
      }
    } finally {
      // A newer run may be making it already: only this one's own job and bar are cleared.
      if (job?.stop === stop) job = undefined
      if (job?.row !== row) row.amaking = undefined
    }
    if (rows.includes(row)) await repack(row)
  }

  /**
   * lowerAsked: the sender chose "Lower the quality". auto: started by itself
   * (the setting, or asked before), so the focus stays put.
   */
  async function makeSmallerCopies(lowerAsked: boolean, auto = false) {
    // "Smallest": the lowest quality is the point, so it's planned for from the start.
    const smallest = settings().shrink === 'smallest'
    let lower = lowerAsked || smallest
    if (shrinking) return
    // Over the limit, stronger compression may yet make them fit: the offer asks again once it's done
    // (brotliWaitLeft). Not with "Smallest", which makes them smaller whatever it does.
    const now = o.compose()
    if (auto && !smallest && now.wire > o.limit() && brotliWaitLeft(now) > 0) return
    if (!auto) copiesChosen = true
    const run = ++shrinkRun
    const live = () => run === shrinkRun
    let items = rows.filter(shareable)
    if (!items.length) return
    let photos = items.filter(isPhoto)
    for (const row of items) {
      row.copyProblem = undefined // only 'failed' gets here: try it again
      if (row.videoProblem === 'failed') row.videoProblem = undefined
    }
    lastPhotos = photoSet(items)
    lastAuto = situation(o.compose(), items)
    for (const row of items) {
      if (row.video && !row.vcopy) row.vqueued = true
      if (row.doc && !row.dcopy) row.dqueued = true
      if (row.audio && !row.acopy) row.aqueued = true
      if (isPhoto(row) && !row.copy) row.pqueued = true
      // To be made smaller: Brotli on the original would be wasted, and hold a lot of memory.
      if (row.vqueued || row.dqueued || row.aqueued || row.pqueued) stopSqueeze(row)
    }
    items.forEach(updateRow)
    // Until the plan says which need copies: the new photos, or (first time, or asked again) all of them;
    // with no photos, the first document, or the first audio file, or else the first video.
    const docRows = items.filter((r) => r.doc)
    const audioRows = items.filter((r) => r.audio)
    shrinking = photos.length
      ? { done: 0, total: photos.filter(toMeasure).length || photos.length }
      : docRows.length
        ? { done: 0, total: 0, doc: { index: 1, count: docRows.length, done: 0 } }
        : audioRows.length
          ? { done: 0, total: 0, audio: { index: 1, count: audioRows.length, done: 0 } }
          : { done: 0, total: 0, video: { index: 1, count: items.length, done: 0 } }
    o.changed()
    o.runStarted?.(auto) // the box's button had the focus, if it was pressed
    try {
      if (photos.length) {
        const works = await checkCanvas()
        if (!live()) return
        canvasBlocked = !works
        if (canvasBlocked) return
      }
      // With "Smallest", each photo's copy is made as it's measured (decoding it once, not twice): that's
      // nearly all of its bar. Otherwise measuring is the first part, and making it the rest.
      const keep = smallest ? settings().smallestPhotos : undefined
      const measuring = keep ? 0.9 : 0.4
      for (const row of photos) {
        if (!toMeasure(row) || !rows.includes(row)) continue
        row.pmaking = 0
        updateRow(row)
        try {
          row.measured = await measure(row.data!, row.photo!, {
            top: wantTop(),
            keep,
            progress: (done) => {
              if (!live() || row.pmaking === undefined) return // the run was stopped meanwhile
              row.pmaking = Math.max(row.pmaking, done * measuring)
              updateRow(row)
            },
          })
        } catch (e) {
          row.copyProblem = copyProblem(e)
          row.pmaking = undefined
          updateRow(row)
        }
        if (!live()) return
      }
      // Documents measured once each, in the worker: seconds, and then any share is quick.
      const unmeasured = items.filter((r) => r.doc && !r.dmeasured && rows.includes(r))
      for (const [i, row] of unmeasured.entries()) {
        if (!live()) return
        await measureDocument(row, i + 1, unmeasured.length, live)
        if (!live()) return
      }
      // Things may have been added or removed meanwhile: plan for what's there now.
      items = rows.filter(shareable)
      photos = items.filter(isPhoto)
      const c = o.compose()
      // Something still being read, cleaned or packed again: planned once it's done, not for what it was (the review, 2026-10-26).
      if (c.pending || c.asking) {
        lastPhotos = lastAuto = undefined
        return
      }
      if (!items.length || photos.some((r) => !r.measured) || items.some((r) => r.doc && !r.dmeasured)) return
      // A video already made smaller keeps its size: the rest share what it leaves.
      const shared = sharing(items)
      let plan = planCopies(c, shared, lower)
      // With "Make photos and videos smaller to fit" on, a lower quality is Slynk's call
      // too, but only when the usual one can't fit: planning for it from the
      // start could leave a photo blocky that didn't need to be.
      if (!plan.fits && !lower && settings().shrink !== 'ask') {
        const low = planCopies(c, shared, true)
        if (low.fits) {
          plan = low
          lower = true
        }
      }
      unfit = !plan.fits
      // Too much even at their smallest: with "Smallest" or "To fit", the photos are made at their smallest all the
      // same, so they're ready to go once some are removed (they all stayed "full size",
      // as if it didn't even try); the box says how many fit. Not videos, documents or audio, which take a while: they're
      // made once what's left fits. Not with "Ask first", which offers a lower quality, or says how many fit.
      const anyway = !plan.fits && settings().shrink !== 'ask'
      if (!plan.fits && !anyway) return
      if (anyway) lower = true
      const targets = plan.fits ? plan.targets : leastTargets(c, shared)
      const target = (row: Row) => targets[shared.indexOf(row)]
      const level = settings().smallestPhotos
      // What a photo's copy may weigh: its target, or with "Smallest", what it measured at its level
      // and a little leeway, should the browser's drawing come out a few bytes different (a level
      // above the least has it in its claim already).
      const aimFor = (row: Row) => (smallest ? Math.max(target(row)!, Math.ceil(row.measured!.lowest * SMALLEST_LEEWAY)) : target(row)!)
      // A copy already as large and good as copies get, that still fits its share, stays as it is;
      // with "Smallest", any made at its level (no bigger than that).
      const done = (row: Row) =>
        !!row.copy &&
        (smallest ? atLevel(row.copy, row.measured!.dims, level) : row.copy.quality === Q_MAX && longEdge(row.copy.dims) === topEdge(row.measured!.dims)) &&
        row.copy.data.length <= aimFor(row)
      const todo = photos.filter((row) => target(row) !== null && !done(row))
      for (const row of photos) {
        if (todo.includes(row) || (!row.pqueued && row.pmaking === undefined)) continue
        row.pqueued = false // fits as it is, or its copy already does
        row.pmaking = undefined
        updateRow(row)
      }
      for (const row of shared) {
        // Not when they don't fit: then null is only "not made now", and what was made stays.
        if (!anyway && target(row) === null && (row.copy || row.vcopy || row.dcopy || row.acopy)) {
          row.copy = undefined // it fits as it is now
          row.vcopy = undefined
          row.dcopy = undefined
          row.acopy = undefined
          await repack(row)
        }
      }
      if (!live()) return
      shrinking = { done: 0, total: todo.length }
      o.changed()
      for (const row of todo) {
        if (!rows.includes(row)) {
          shrinking.done++ // removed meanwhile: don't decode it
          continue
        }
        let copy: Copy | undefined
        // On from where measuring left its bar.
        const from = row.pmaking ?? 0
        row.pmaking = from
        updateRow(row)
        try {
          // "Smallest": the copy made as it was measured, at its level, if it's still the level.
          copy = smallest ? keptCopy(row.measured!, level, aimFor(row)) : undefined
          copy ??= await makeCopy(row.data!, row.photo!, row.measured!, aimFor(row), lower, (done) => {
            if (!live() || row.pmaking === undefined) return
            row.pmaking = Math.max(row.pmaking, from + (1 - from) * done)
            updateRow(row)
          })
          if (!copy) row.copyProblem = 'failed'
        } catch (e) {
          row.copyProblem = copyProblem(e)
        } finally {
          row.pmaking = undefined
          row.pqueued = false
          row.measured!.kept = undefined // it's the copy now, or not wanted: not held twice
        }
        if (!live()) {
          updateRow(row)
          return
        }
        if (copy) row.copy = { ...copy, from: photoSize(row, row.measured!.dims) }
        shrinking.done++
        if (rows.includes(row)) await repack(row)
      }
      if (anyway) return
      // Documents next: seconds each, made again only when their share has changed enough.
      const docsToMake = shared.filter((row) => row.doc && target(row) !== null && (!row.dcopy || remakeDoc(row, target(row)!)))
      for (const row of shared) {
        if (!row.dqueued || docsToMake.includes(row)) continue
        row.dqueued = false // goes as it is, or as it was made
        updateRow(row)
      }
      for (const [i, row] of docsToMake.entries()) {
        // A file added or the setting turned off meanwhile ends this run: never start work for it after.
        if (!live()) return
        if (!rows.includes(row)) continue
        o.changed()
        await makeDocument(row, target(row)!, lower, i + 1, docsToMake.length, live)
        if (!live()) return
      }
      // Audio next: seconds each, once the sender has finished choosing, and made again whenever its share has changed enough.
      const audioToMake = shared.filter((row) => row.audio && target(row) !== null && (!row.acopy || remakeAudio(row, target(row)!)))
      for (const row of shared) {
        if (!row.aqueued || audioToMake.includes(row)) continue
        row.aqueued = false // goes as it is, or as it was made
        updateRow(row)
      }
      for (const [i, row] of audioToMake.entries()) {
        await settledAdds()
        if (!live()) return
        if (!rows.includes(row)) continue
        o.changed()
        await makeAudio(row, target(row)!, i + 1, audioToMake.length, live)
        if (!live()) return
      }
      // Videos last, being slow: once the sender has finished choosing. One already made
      // smaller isn't made again, unless nothing else was left to make room.
      const videos = shared.filter((row) => row.video && target(row) !== null && (!row.vcopy || row.vcopy.data.length > target(row)!))
      // "Smallest" makes a video at its step, often well under what it claimed: the room it leaves goes to those still to
      // be made, planned again before each with the sizes made so far, at the same step. Planned once, a short clip late
      // in the list had only its claim, and came out a step below its level (2026-10-31).
      const videoTarget = (row: Row, left: Row[]) => {
        const again = smallest ? planCopies(o.compose(), left, true, plan.steps!.slice(0, 1)) : undefined
        return Math.max(target(row)!, (again?.fits && again.targets[0]) || 0)
      }
      for (const row of items) {
        if (!row.vqueued || videos.includes(row)) continue
        row.vqueued = false // goes as it is, or as it was made
        updateRow(row)
      }
      for (const [i, row] of videos.entries()) {
        await settledAdds()
        if (!live()) return
        if (!rows.includes(row)) continue
        await makeVideo(row, videoTarget(row, videos.slice(i).filter((r) => rows.includes(r))), plan.steps, i + 1, videos.length, live)
        if (!live()) return
      }
    } finally {
      if (live()) {
        shrinking = undefined
        unqueue()
        squeezeZips()
        // Stronger compression for any lined up to be made smaller that goes as it is after all (stopped when it was lined up).
        for (const row of rows) if (!inCopy(row)) track(squeezeRow(row))
        const after = o.runEnding?.()
        // A level changed meanwhile for what this run had already made: made again now.
        if (levelPending) track(fullSize(true, levelPending))
        o.changed()
        after?.()
      }
    }
  }

  // Turning hidden-info removal on or off redoes every file. Choosing "Ask
  // first" puts every photo back at full size (that's what the link to it
  // promises), and the box asks instead; "To fit" from there makes copies of
  // photos over the limit. "Smallest", or leaving it, makes them all again
  // for it, as a new level for its photos or videos makes those.
  let stripWasOn = settings().stripMetadata
  let shrinkWas = settings().shrink
  let photoLevelWas = settings().smallestPhotos
  let videoLevelWas = settings().smallestVideos
  let plainWereOn = settings().plainNames
  let brotliWasOn = settings().brotli
  /** The settings changed (ui/settings.ts onSettings): what they change is done again. */
  function heard(s: ListSettings) {
    if (s.brotli !== brotliWasOn) {
      brotliWasOn = s.brotli
      if (s.brotli) for (const row of rows) track(row.zip ? repack(row) : squeezeRow(row))
      else track(unsqueeze())
    }
    if (s.plainNames !== plainWereOn) {
      plainWereOn = s.plainNames
      rows.forEach(updateRow) // compose() packs each name as it goes, so nothing needs packing again
      // Except a zip, whose files' names are written in it.
      for (const row of rows) if (row.zip) track(repack(row))
    }
    if (s.shrink !== shrinkWas) {
      const was = shrinkWas
      shrinkWas = s.shrink
      if (s.shrink === 'fit' && was === 'ask') o.changed()
      // Each "Send full size instead" stands, except where nothing is made smaller unasked.
      else track(fullSize(s.shrink !== 'ask'))
    }
    if (s.smallestPhotos !== photoLevelWas || s.smallestVideos !== videoLevelWas) {
      const photosToo = s.smallestPhotos !== photoLevelWas
      const videosToo = s.smallestVideos !== videoLevelWas
      photoLevelWas = s.smallestPhotos
      videoLevelWas = s.smallestVideos
      // Only "Smallest" makes them at a level: those it changes for are made again. A video or document
      // being made that it isn't for goes on (a video takes minutes), and they're made again after it.
      if (s.shrink === 'smallest') {
        const was = levelPending
        const only = (row: Row) => (photosToo && isPhoto(row)) || (videosToo && !!row.video) || !!was?.(row)
        if (job && !only(job.row)) levelPending = only
        else track(fullSize(true, only))
      }
    }
    if (s.stripMetadata === stripWasOn) return
    stripWasOn = s.stripMetadata
    for (const row of rows) {
      if (row.data) track(processRow(row))
      else if (row.video) track(lookInside(row))
    }
  }

  /**
   * Every photo, document and audio file back as it was (and every video as it is: too big to
   * send), and a run in progress stopped. keepChoices: each "Send full size instead" stays.
   * only: just these back, the rest kept as they were made.
   */
  async function fullSize(keepChoices = false, only?: (row: Row) => boolean) {
    levelPending = undefined // its rows are among these, or it was merged into them
    shrinkRun++
    shrinking = undefined
    job?.stop.abort()
    unqueue()
    copiesChosen = false
    lastPhotos = lastAuto = undefined
    unfit = false
    const back: Row[] = []
    for (const row of rows) {
      if (only && !only(row)) continue
      // One sent at full size by choice keeps its smaller version, so the choice can be undone.
      if (keepChoices && row.useFull) continue
      row.useFull = false
      if (!row.copy && !row.vcopy && !row.dcopy && !row.acopy) continue
      row.copy = undefined
      row.vcopy = undefined
      row.dcopy = undefined
      row.acopy = undefined
      back.push(row)
    }
    // All at once: one at a time, a run started after the first could plan for the rest still made smaller (the review, 2026-10-26).
    await Promise.all(back.map(repack))
    o.changed()
  }

  /** Empties the list: every file goes, and a run of copies in progress stops. */
  function clear() {
    levelPending = undefined
    shrinkRun++
    shrinking = undefined
    job?.stop.abort()
    clearTimeout(brotliTimer)
    canvasBlocked = false
    copiesChosen = false
    unfit = false
    lastPhotos = lastAuto = undefined
    for (const row of rows.splice(0)) forgetRow(row)
    o.changed()
  }

  return {
    /** Every file on the list, in its order: a zip's own files follow it. */
    rows,
    add,
    remove,
    dropPlain,
    setOriginal,
    answer,
    setFull,
    clear,
    compose,
    blocker,
    waiting,
    offer,
    /** Makes copies (lowerAsked: "Lower the quality"; auto: by itself, as offer() said to start). */
    makeSmallerCopies: (lowerAsked: boolean, auto = false) => track(makeSmallerCopies(lowerAsked, auto)),
    heard,
    stopSqueezing,
    idle,
    /** Photos or videos are being made smaller to fit right now. */
    working: () => !!shrinking,
    /** The browser's canvas gave back something else than was drawn on it at the last run: no photo was made smaller. */
    canvasBlocked: () => canvasBlocked,
    inCopy,
    fullTooBig,
    tooBigAsIs,
    baseName,
    sentName,
    sentType,
    newPicture,
    asking,
    shareable,
    isPhoto,
    kinds,
    planned,
    uncheckedIn,
  }
}
