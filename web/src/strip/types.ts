// Shared types for the hidden-info stripper (see index.ts for the page-side API).
import { SITE_NAME } from '../site.ts'

/** File types Slynk can clean, detected from their first bytes. */
export type Kind =
  | 'jpeg'
  | 'png'
  | 'webp'
  | 'gif'
  | 'heic'
  | 'avif'
  | 'mp3'
  | 'flac'
  | 'docx'
  | 'xlsx'
  | 'pptx'
  | 'odt'
  | 'ods'
  | 'odp'
  | 'rtf'
  | 'pdf'
  | 'mp4'
  | 'mov'
  | 'zip'
  | 'svg'

export interface StripOptions {
  /** Clean PDFs too (a PDF is rewritten as a whole). The composer always sets it. */
  pdf?: boolean
  /** A zip's files left as they are and not counted: ones the composer cleans as files of their own (tray.ts). */
  skip?: string[]
}

/**
 * What a removed item said, read so the sender can see it: a label from
 * LABEL and a display value. Only ever shown on the sender's screen.
 */
export interface Found {
  label: string
  value: string
}

/** One kind of hidden detail that was removed, with what it held when Slynk can show it. */
/**
 * Files inside a zip that went as they were, counted by kind: describeOther's names ('doc',
 * 'wav', 'zip'...), 'pdf', 'locked', 'signed', 'failed' (couldn't be cleaned) and 'other'.
 */
export type Unchecked = Record<string, number>

export interface Detail {
  label: string
  /** Up to MAX_SHOWN distinct values, in the order they were found. */
  values: string[]
  /** How many more distinct values there were, or -1 for more than Slynk counted. */
  more: number
}

export type StripResult =
  /**
   * removed: plain-language labels, de-duplicated, most telling first.
   * details: the same labels in the same order, each with its values.
   */
  | { status: 'cleaned'; bytes: Uint8Array; removed: string[]; details: Detail[]; unchecked?: Unchecked }
  /** A supported type with nothing to remove: send the original. */
  | { status: 'unchanged'; kind: string; unchecked?: Unchecked }
  /** Slynk can't check this type; kind names it when it's recognisable. */
  | { status: 'unsupported'; kind: string | null }
  /** Deliberately left alone, e.g. a signed PDF. */
  | { status: 'skipped'; kind: string; reason: string }
  /** Something went wrong; the UI asks before sending the original. */
  | { status: 'failed'; kind: string; error: string }

/** What a format module returns; the engine adds the kind and re-checks the output. */
export type FormatOutcome =
  /** values: what some of the removed items said, each under one of the removed labels. */
  | { status: 'cleaned'; bytes: Uint8Array; removed: string[]; values?: Found[]; unchecked?: Unchecked }
  | { status: 'unchanged'; unchecked?: Unchecked }
  | { status: 'skipped'; reason: string }
  /** A file of its kind that it can't be sure of reading (an SVG drawing it can't read safely): it goes as it is, as one Slynk can't check. */
  | { status: 'unsupported' }

export interface FormatModule {
  strip(bytes: Uint8Array, kind: Kind, opts: StripOptions): FormatOutcome | Promise<FormatOutcome>
  /** Re-parses a cleaned file and throws if it's malformed or still holds anything to remove. */
  verify(bytes: Uint8Array, kind: Kind, opts?: StripOptions): void | Promise<void>
}

/** Thrown for input we can't make sense of; the engine reports it as 'failed'. */
export class StripError extends Error {}

export function fail(message: string): never {
  throw new StripError(message)
}

/** Plain-language reasons for 'skipped', so the UI can tell them apart. */
export const SKIP = {
  pdfOff: 'Hidden data in this PDF stays unless you tick the box.',
  signed: 'This PDF is digitally signed. Cleaning it would break the signature.',
  signedDocument: 'This document is digitally signed. Cleaning it would break the signature.',
  encrypted: `This file is password-protected or encrypted, so ${SITE_NAME} can’t look inside it.`,
  tooLarge: 'This file is too large to check for hidden info.',
} as const

// Messages between the page (index.ts) and the strip worker (stripWorker.ts).
export interface StripRequest {
  id: number
  bytes: Uint8Array
  opts: StripOptions
}

export interface StripResponse {
  id: number
  result: StripResult
}
