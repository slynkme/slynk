// Where the composer meets the hidden-details stripping engine (web/src/strip/).
// When "Remove hidden details from files" is on, every file added to the
// composer goes through cleanFile() before it's compressed, so the meter shows
// the cleaned size. The engine runs in its own worker, started for every visit
// (preload.ts).

import { type Detail, stripFile, suggestNeutralName as suggest, type StripResult } from './strip/index.ts'
import { orderLabels } from './strip/labels.ts'
import { describe } from './strip/values.ts'
import { heldIn } from './strip/video.ts'

export type { Detail, StripResult }

/** Removes hidden details from a file's bytes. opts.pdf: PDFs too; opts.skip: a zip's files
 *  the composer cleans as files of their own. The engine takes ownership of `bytes`; pass a copy if the original is still needed. */
export function cleanFile(bytes: Uint8Array, opts: { pdf: boolean; skip?: string[] }): Promise<StripResult> {
  return stripFile(bytes, opts)
}

/** A neutral name to offer instead of one that gives something away, or null. */
export function suggestNeutralName(name: string): string | null {
  return suggest(name)
}

/**
 * What a video too big to go as it is holds, for its "Cleaned" list once a
 * smaller video is made in its place (which holds none of it): read from the
 * boxes beside its pictures and sound, never the whole file. Undefined when
 * it holds nothing that cleaning would remove, or can't be read.
 */
export async function videoHeld(file: Blob): Promise<{ removed: string[]; details: Detail[] } | undefined> {
  try {
    const read = async (offset: number, length: number) => new Uint8Array(await file.slice(offset, offset + length).arrayBuffer())
    const { labels, values } = await heldIn(read, file.size)
    if (!labels.length) return undefined
    const removed = orderLabels(labels)
    return { removed, details: describe(removed, values) }
  } catch {
    return undefined
  }
}
