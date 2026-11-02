// What the file list (list.ts) makes smaller with: the page's photo drawing,
// the document shrinker's worker, the video and audio worker, and the browser's
// own audio decoding. Passed in as one object so a test can stand in for them
// where there's no canvas or WebCodecs (Node); Slynk's composer and the file-prep
// example use these, the real ones.
import { canShrinkAudio, decodeWhole } from '../audio/page.ts'
import { dropDoc, makeDoc, measureDoc, stopDoc } from '../docshrink/client.ts'
import { checkCanvas, keptCopy, makeCopy, measure } from '../shrink/draw.ts'
import { audioInWorker, shrinkInWorker } from '../video/client.ts'

export interface Makers {
  /** Whether the page's canvas gives back what's drawn on it: some privacy settings make it lie. */
  checkCanvas: typeof checkCanvas
  /** A photo's smallest copies, measured; with "Smallest", its copy at the level kept as it was made. */
  measure: typeof measure
  keptCopy: typeof keptCopy
  makeCopy: typeof makeCopy
  /** A document measured at every level in the worker, made for a share, let go of, or stopped. */
  measureDoc: typeof measureDoc
  makeDoc: typeof makeDoc
  dropDoc: typeof dropDoc
  stopDoc: typeof stopDoc
  /** A video made smaller in the worker, from its file. */
  shrinkInWorker: typeof shrinkInWorker
  /** Audio made again as Opus in the same worker, from its file or its sound decoded on the page. */
  audioInWorker: typeof audioInWorker
  decodeWhole: typeof decodeWhole
  /** Whether this browser can make this audio smaller at all. */
  canShrinkAudio: typeof canShrinkAudio
}

export const MAKERS: Makers = { checkCanvas, measure, keptCopy, makeCopy, measureDoc, makeDoc, dropDoc, stopDoc, shrinkInWorker, audioInWorker, decodeWhole, canShrinkAudio }
