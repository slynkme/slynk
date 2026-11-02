// pdf.js's worker (PDF previews, pdfView.ts), with the browser's own brotli
// decoder kept from the PDFs it reads (noNativeBrotli.ts). Imports run in
// order, so the refusal is in place before pdf.js's code is.
import './noNativeBrotli.ts'
import 'pdfjs-dist/build/pdf.worker.min.mjs'
