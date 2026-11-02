// PDF previews: a PDF as it will be sent, or one
// that arrived, drawn page by page by pdf.js (Mozilla's PDF engine, Apache-2.0)
// on canvases, in the photo viewer (photoView.ts), and small in its row.
//
// Every visitor fetches its code and its worker at the start (preload.ts), so
// the host's logs can't tell who looked at a PDF. Nothing else is ever fetched:
// no fonts, character maps, colour profiles or WebAssembly. So pictures stored
// as JPEG 2000 or JBIG2 (some scans) show blank, and East Asian text without
// its own font data may look wrong, in the preview only: the file is
// unaffected. Only the pages' drawing is rendered: no forms, scripts or links.
// pdf.js 6 has no eval to switch off, and the page's CSP forbids it anyway.
// Its worker (pdfWorker.ts) unpacks brotli-compressed parts with pdf.js's own
// JavaScript, never the browser's decoder.
import pdfWorkerUrl from './pdfWorker.ts?worker&url'
import type { PDFDocumentProxy, PDFWorker } from 'pdfjs-dist'

type Pdfjs = typeof import('pdfjs-dist')

/** pdf.js's worker, fetched into the cache at the start (preload.ts) and started when a PDF is first shown. */
export const PDF_WORKER_URL = pdfWorkerUrl

let lib: Promise<Pdfjs> | undefined
let worker: PDFWorker | undefined

/** Loads pdf.js's code, once: at the start, for every visitor (preload.ts). */
export function warmPdf(): Promise<Pdfjs> {
  lib ??= import('pdfjs-dist').then((m) => {
    m.GlobalWorkerOptions.workerSrc = pdfWorkerUrl
    return m
  })
  return lib
}

/** A PDF open in pdf.js, and how to let go of it. */
export interface OpenPdf {
  doc: PDFDocumentProxy
  close(): void
}

/** Opens a PDF from bytes in this tab's memory (a copy goes to the worker). Rejects if pdf.js can't: damaged, or locked with a password. */
export async function openPdf(data: Uint8Array): Promise<OpenPdf> {
  const m = await warmPdf()
  worker ??= new m.PDFWorker()
  const task = m.getDocument({
    data: data.slice(),
    worker,
    // Only what's already here: nothing fetched for fonts, colour or pictures.
    useWasm: false,
    useWorkerFetch: false,
    enableXfa: false,
    disableAutoFetch: true,
    disableStream: true,
    disableRange: true,
    verbosity: 0,
  })
  const close = () => void task.destroy().catch(() => {})
  try {
    return { doc: await task.promise, close }
  } catch (e) {
    close()
    throw e
  }
}

/**
 * Draws page n onto canvas at width pixels wide (its height to match, no more
 * than maxHeight: a page taller than that is cut off at the bottom, as a small
 * picture's square is). Returns the canvas's size.
 */
export async function drawPage(doc: PDFDocumentProxy, n: number, canvas: HTMLCanvasElement, width: number, maxHeight = Infinity): Promise<{ width: number; height: number }> {
  const page = await doc.getPage(n)
  const base = page.getViewport({ scale: 1 })
  const viewport = page.getViewport({ scale: width / base.width })
  canvas.width = Math.max(1, Math.round(viewport.width))
  canvas.height = Math.max(1, Math.round(Math.min(viewport.height, maxHeight)))
  await page.render({ canvas, viewport }).promise
  page.cleanup()
  return { width: canvas.width, height: canvas.height }
}
