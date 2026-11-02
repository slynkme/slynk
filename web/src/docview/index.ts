// Which documents the preview can show, and how each is read. PDFs are drawn by
// pdf.js (ui/pdfView.ts); the others are read for their text (model.ts), which
// the viewer shows as a simplified page (render.ts): RTF
// (2026-10-24), and Word and LibreOffice Writer documents (2026-10-25), each by
// a reader of its own; and any file that's plain text (2026-10-26), as it is.
// Older Word files (.doc), PowerPoint, Excel and LibreOffice's other files
// aren't shown, nor SVG drawings, which are shown as pictures (2026-10-26).
import { detectKind, isUtf8Text } from '../strip/sniff.ts'
import { readDocx } from './docx.ts'
import type { DocText } from './model.ts'
import { readOdt } from './odt.ts'
import { readRtf } from './rtf.ts'
import { readText } from './text.ts'

export type DocPreview = 'pdf' | 'rtf' | 'docx' | 'odt' | 'text'

const SHOWN = new Set<string>(['pdf', 'rtf', 'docx', 'odt'])

/** How the preview can show this file, from its bytes: as a PDF, as a document's text, as plain text, or not at all. */
export function docPreviewOf(data: Uint8Array): DocPreview | null {
  try {
    const kind = detectKind(data)
    if (kind) return SHOWN.has(kind) ? (kind as DocPreview) : null
    // By the text test alone: describeOther's guesses (a CSV starting "BM" read as a picture) would miss some.
    // An SVG drawing (detectKind's 'svg') is shown as a picture instead (ui/svgPicture.ts), not a page with an icon in it.
    return isUtf8Text(data) ? 'text' : null
  } catch {
    return null
  }
}

/** A document's text, as far as maxChars. Throws if it can't be read. */
export function readDoc(data: Uint8Array, kind: Exclude<DocPreview, 'pdf'>, maxChars?: number): DocText {
  switch (kind) {
    case 'rtf':
      return readRtf(data, maxChars)
    case 'docx':
      return readDocx(data, maxChars)
    case 'odt':
      return readOdt(data, maxChars)
    case 'text':
      return readText(data, maxChars)
  }
}
