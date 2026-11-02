// Makes this worker's DecompressionStream refuse "brotli", for pdf.js
// (pdfWorker.ts). pdf.js tries the browser's own brotli decoder first and,
// when that's refused, uses its own JavaScript one. The browser's is C code
// that has had a memory-corruption bug a crafted stream could reach
// (CVE-2026-111497, fixed in Firefox 150; whether Safari's had it is unknown),
// and the PDFs previewed here can come from strangers. A JavaScript decoder
// can only throw. Other formats keep the browser's decoder.
const Native = globalThis.DecompressionStream

if (Native) {
  globalThis.DecompressionStream = class extends Native {
    constructor(format: CompressionFormat) {
      if ((format as string) === 'brotli') throw new TypeError('brotli is decoded by pdf.js itself here')
      super(format)
    }
  }
}
