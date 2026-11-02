// Messages between the composer (docshrink/client.ts) and the worker that
// makes PDFs and Office files smaller (docshrink/session.ts, in a second copy
// of the cleaner's worker).

export type DocKind = 'pdf' | 'office'

/**
 * Why a document couldn't be made smaller: the shrinkers' reasons; 'lost' when the worker no
 * longer has it (it was restarted), so it's measured again; or anything else ('failed').
 */
export type DocReason = 'signed' | 'encrypted' | 'older' | 'unreadable' | 'canvas' | 'stopped' | 'lost' | 'failed'

export interface DocMeasure {
  /** Pictures it could make smaller. */
  pictures: number
  /** Its bytes re-saved without changing a picture: as small as it goes losslessly. */
  tidied: number
  /** Its bytes as it's sent as it is: compressed, when it was measured so (a PDF), else its length. */
  original: number
  /**
   * The share each level needs, best first: the usual qualities, then (from lowerFrom) the lower
   * ones. Its predicted bytes (as it's sent) with room for predictions that come out a little big
   * (MARGIN), so a share this size is made at that level.
   */
  levels: number[]
  lowerFrom: number
  /** Its predicted bytes at its very smallest (the lowest quality), as it's sent, for saying so. */
  smallest: number
  /** At its smallest, most of it is what's never made smaller: text, fonts and other files. */
  mostlyKept: boolean
}

export interface DocMade {
  data: Uint8Array
  /** Its bytes as it's sent, as the share counted them. */
  sent: number
  /** Pictures replaced by smaller ones (none: only re-saved). */
  changed: number
  /** Some went below the usual quality. */
  lowered: boolean
}

export type DocRequest =
  | { id: number; doc: 'measure'; session: number; kind: DocKind; bytes: Uint8Array; cap: number; compressed: boolean }
  | { id: number; doc: 'make'; session: number; target: number; lower: boolean }
  | { id: number; doc: 'drop'; session: number }
  | { id: number; doc: 'stop' }

export type DocResponse =
  | { id: number; kind: 'progress'; done: number }
  | { id: number; kind: 'measured'; measured: DocMeasure }
  | { id: number; kind: 'made'; made: DocMade | undefined }
  | { id: number; kind: 'error'; reason: DocReason; message: string }
