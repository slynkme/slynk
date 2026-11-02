// Every visit fetches the same files, whatever the visitor goes on to do.
// The web host's visit logs record each file a visit fetches (with its
// internet address and time), so code fetched only when it's needed would
// tell them that someone added a PDF, used a password, scanned a QR code,
// made a video smaller, looked at a PDF (pdf.js) or set up a link (its
// puzzle, pow/). Instead,
// everything optional is fetched here, once, for everyone, after the page and
// the mixnet engine have loaded (main.ts), so on a slow connection it never
// slows those down. About 1.8 MB, cached after the first visit (the
// rule since 2026-10-19; see docs/findings/decisions.md, and
// web/test/uniform-loading.test.ts, which fails if code loaded on demand is
// added without being listed here).
//
// Workers are fetched rather than started where starting one costs memory
// (the helper module's WebAssembly, for passwords and Brotli). Their file names change whenever the
// site's security headers do (vite.config.ts), so they can be cached like
// everything else and starting one later fetches nothing.
import toolsWasmUrl from './core/generated/slynk-tools.wasm?url'
import scanWorkerUrl from './inbox/scanWorker.ts?worker&url'
import kdfWorkerUrl from './kdf/kdfWorker.ts?worker&url'
import powWorkerUrl from './pow/powWorker.ts?worker&url'
import squeezeWorkerUrl from './squeeze/squeezeWorker.ts?worker&url'
import { startCleaner } from './strip/index.ts'
import { PDF_WORKER_URL, warmPdf } from './ui/pdfView.ts'
import videoWorkerUrl from './video/shrinkWorker.ts?worker&url'
import { warmZip } from './zip.ts'

/** Files fetched into the browser's cache, unused for now. */
export const FETCHED = [kdfWorkerUrl, squeezeWorkerUrl, toolsWasmUrl, powWorkerUrl, scanWorkerUrl, videoWorkerUrl, PDF_WORKER_URL]

async function fetchInto(url: string) {
  const res = await fetch(url)
  await res.arrayBuffer() // read to the end, so the browser keeps it
}

let done = false

/** Fetches everything a visit might need. Once a page; failures are quiet (the feature fetches it again when used). */
export function preloadEverything(): void {
  if (done) return
  done = true
  startCleaner() // its worker loads every file format's code
  warmZip()
  warmPdf().catch(() => {}) // pdf.js's code (PDF previews); its worker is fetched below
  for (const url of FETCHED) fetchInto(url).catch(() => {})
}
