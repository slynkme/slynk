// What the file checks found (check.ts): each is one line on a file's row, in
// fileWarnCopy.ts's words, and none of them says a file is harmful or safe.

/** Which program a document's outside content would be fetched by, for the "Why?" text. */
export type OpensIn = 'office' | 'word' | 'libreoffice' | 'pdf' | 'player'

export type Warning =
  | { kind: 'program' }
  | { kind: 'script' } // a script or a shortcut: runs commands when opened
  | { kind: 'disguised'; claimed: string; real: 'program' | 'disk' } // claimed: the name's ending, like ".pdf"
  | { kind: 'disk' } // a disk image, which can hold programs
  | { kind: 'macros' }
  | { kind: 'internet'; hosts: string[]; opensIn: OpensIn } // fetches something from these when opened
  | { kind: 'pdf-scripts'; onOpen: boolean }
  | { kind: 'pdf-launch' } // can ask to open other programs
  | { kind: 'attachments' } // a PDF with files attached
  | { kind: 'inside'; files: InsideFile[] } // an archive with files inside that have warnings of their own
  | { kind: 'locked' } // locked with a password, so what's inside couldn't be checked
  | { kind: 'web-page'; hosts: string[] } // a web page or SVG, by its name: opened in a browser it can contact websites (these, as soon as it's opened)
  | { kind: 'web-scripts' } // a web page or SVG that runs scripts when opened in a browser
  | { kind: 'unread' } // the check didn't finish (too long, or it failed), so it can't say there's nothing

/** A file inside an archive, under its path there, and what its own checks found. */
export interface InsideFile {
  name: string
  warnings: Warning[]
}

export type WarningKind = Warning['kind']

export interface CheckRequest {
  id: number
  check: { bytes: Uint8Array; name: string }
}

export interface CheckResponse {
  id: number
  warnings: Warning[]
}
