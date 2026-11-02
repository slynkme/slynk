// Plain-language names for what was removed, in the order the UI lists them:
// the most telling first. Format modules only ever use these constants.

export const LABEL = {
  gps: 'GPS location',
  /** A video's own track of where the camera was, and how it moved, as it filmed (action cameras). */
  sensors: 'location and motion recordings',
  camera: 'camera make and model',
  lens: 'lens details',
  serial: 'serial numbers and IDs',
  dateTaken: 'date taken',
  author: 'author name',
  lastEditor: 'last editor’s name',
  printedBy: 'name of who last printed it',
  company: 'company name',
  manager: 'manager name',
  people: 'people and face tags',
  commentAuthors: 'comment author names and dates',
  changeAuthors: 'tracked-change author names and dates',
  title: 'title and subject',
  description: 'description',
  keywords: 'keywords and categories',
  copyright: 'copyright notice',
  custom: 'custom properties',
  sensitivity: 'sensitivity labels',
  template: 'template name or path',
  savedPath: 'saved file path',
  printer: 'printer name',
  dates: 'dates and times',
  revision: 'revision number',
  editTime: 'total editing time',
  app: 'app name and version',
  software: 'editing software',
  encoder: 'encoding software',
  history: 'editing history',
  versions: 'older saved versions',
  /** A drawing app's own copy of an SVG, to edit it again: Illustrator's, draw.io's diagram (every page of it), Excalidraw's scene (svg.ts). */
  editable: 'editable copy of the drawing',
  leftovers: 'leftover data from earlier edits',
  ids: 'document IDs',
  settings: 'camera settings',
  makerNotes: 'camera maker notes',
  prompt: 'image generation prompt',
  songInfo: 'title, artist and album',
  coverArt: 'cover art',
  lyrics: 'lyrics',
  links: 'web links',
  catalog: 'CD catalog numbers',
  thumbnail: 'preview image',
  extraImages: 'extra preview images',
  motion: 'motion-photo video',
  c2pa: 'content credentials',
  iptc: 'captions and credits',
  comments: 'comments',
  embeddedText: 'embedded text notes',
  appData: 'private app data',
  /** Files a computer adds to a zip by itself: .DS_Store, Thumbs.db, __MACOSX (archive.ts). */
  systemFiles: 'hidden system files',
  saveTimes: 'file save times',
  otherPhoto: 'other photo details',
  otherAudio: 'other audio tags',
  otherDoc: 'other document details',
  trailing: 'hidden data after the file',
  other: 'other hidden data',
} as const

const ORDER: string[] = Object.values(LABEL)

/** The name every comment and tracked-change author becomes. */
export const ANON = 'Author'

/** Stands in for dates a document format requires but we'd rather not keep. */
export const NEUTRAL_DATE = '1980-01-01T00:00:00Z'

/** Suffix for labels found in pictures inside a document. */
export const IN_PICTURES = ' (in pictures)'

/** Suffix for labels found in the files inside a zip (archive.ts). */
export const IN_FILES = ' (in files inside)'

/** De-duplicates labels and sorts them into the display order. */
export function orderLabels(labels: Iterable<string>): string[] {
  const rank = (l: string) => {
    const inner = [IN_PICTURES, IN_FILES].find((s) => l.endsWith(s))
    const base = inner ? l.slice(0, -inner.length) : l
    const i = ORDER.indexOf(base)
    return (inner ? ORDER.length + 1 : 0) + (i === -1 ? ORDER.length : i)
  }
  return [...new Set(labels)].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0))
}
