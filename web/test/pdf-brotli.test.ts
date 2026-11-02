// PDF previews never hand a PDF's brotli-compressed parts (PDF 2.0's
// BrotliDecode) to the browser's own decoder: pdf.js's worker refuses it
// (src/ui/noNativeBrotli.ts, imported first by src/ui/pdfWorker.ts), so pdf.js
// uses its JavaScript one. Node's DecompressionStream has brotli, as Firefox's
// and Safari's do, and pdf.js runs its worker's code in this thread here, so
// this runs the real worker file and watches which decoders it asks for.
// Run from the repo root: npm --prefix web test
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { brotliCompressSync, deflateSync } from 'node:zlib'

// pdf.js's browser build uses this, which browsers have and Node 24 lacks.
const bytes = Uint8Array.prototype as Uint8Array & { toHex?: () => string }
bytes.toHex ??= function (this: Uint8Array) {
  return Buffer.from(this).toString('hex')
}

// Records every format pdf.js asks the "browser's" decoder for.
const Native = globalThis.DecompressionStream
const asked: string[] = []
class Watched extends Native {
  constructor(format: CompressionFormat) {
    asked.push(format)
    super(format)
  }
}
globalThis.DecompressionStream = Watched
await import('../src/ui/pdfWorker.ts')
const refusing = globalThis.DecompressionStream
const pdfjs = await import('pdfjs-dist')

/** A one-page PDF whose page drawing is stored brotli-compressed. */
function brotliPdf(text: string): Uint8Array {
  const drawing = brotliCompressSync(Buffer.from(`BT /F1 24 Tf 72 720 Td (${text}) Tj ET`))
  const objects: Buffer[] = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>'),
    Buffer.concat([Buffer.from(`<< /Length ${drawing.length} /Filter /BrotliDecode >>\nstream\n`), drawing, Buffer.from('\nendstream')]),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
  ]
  const parts = [Buffer.from('%PDF-2.0\n')]
  const offsets: number[] = []
  let at = parts[0].length
  objects.forEach((body, i) => {
    const obj = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), body, Buffer.from('\nendobj\n')])
    offsets.push(at)
    parts.push(obj)
    at += obj.length
  })
  const xref = ['xref', `0 ${objects.length + 1}`, '0000000000 65535 f ', ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n `)]
  parts.push(Buffer.from(`${xref.join('\n')}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${at}\n%%EOF\n`))
  return new Uint8Array(Buffer.concat(parts))
}

/** The first page's text, opened with pdfView.ts's options. */
async function pageText(data: Uint8Array): Promise<string> {
  const task = pdfjs.getDocument({ data, useWasm: false, useWorkerFetch: false, enableXfa: false, disableAutoFetch: true, disableStream: true, disableRange: true, verbosity: 0 })
  try {
    const page = await (await task.promise).getPage(1)
    return (await page.getTextContent()).items.map((i) => ('str' in i ? i.str : '')).join('')
  } finally {
    await task.destroy()
  }
}

test('the worker refuses brotli and keeps the browser decoder for the rest', async () => {
  assert.throws(() => new DecompressionStream('brotli' as CompressionFormat), TypeError)
  const data = new TextEncoder().encode('kept '.repeat(100))
  const out = await new Response(new Blob([deflateSync(data)]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer()
  assert.deepEqual(new Uint8Array(out), data)
})

test("a PDF's brotli part is read by pdf.js's own decoder, never the browser's", async () => {
  asked.length = 0
  assert.equal(await pageText(brotliPdf('Hello brotli')), 'Hello brotli')
  assert.ok(!asked.includes('brotli'), `asked for: ${asked.join(', ')}`)

  // Without the refusal pdf.js does ask for the browser's, so the check above means something.
  globalThis.DecompressionStream = Watched
  try {
    asked.length = 0
    assert.equal(await pageText(brotliPdf('Hello again')), 'Hello again')
    assert.ok(asked.includes('brotli'))
  } finally {
    globalThis.DecompressionStream = refusing
  }
})
