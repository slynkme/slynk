// Runs the stripper off the main thread, so a large document doesn't freeze
// the page. It keeps nothing: each file is handled and handed straight back.
// A second copy of it makes PDFs and Office files smaller for the composer
// (docshrink/), keeping each one measured until the composer lets it go. It
// also runs the file checks behind a row's warnings (filecheck/).
import type { DocRequest, DocResponse } from '../docshrink/types.ts'
import { checkBytes } from '../filecheck/check.ts'
import type { CheckRequest, CheckResponse } from '../filecheck/types.ts'
import { stripBytes } from './engine.ts'
import { loadEveryFormat } from './formats.ts'
import type { StripRequest, StripResponse, StripResult } from './types.ts'

const scope = self as unknown as Worker

// Every format's code now, whatever files come (web/src/preload.ts). A
// failure here shows up again, as that format's own error, when it's used.
loadEveryFormat().catch(() => {})

scope.onmessage = async (e: MessageEvent<StripRequest | DocRequest | CheckRequest>) => {
  if ('doc' in e.data) {
    const req = e.data
    const { handleDoc } = await import('../docshrink/session.ts')
    return handleDoc(req, (msg: DocResponse, transfer: Transferable[] = []) => scope.postMessage(msg, transfer))
  }
  if ('check' in e.data) {
    const { id, check } = e.data
    const msg: CheckResponse = { id, warnings: await checkBytes(check.bytes, check.name) }
    return scope.postMessage(msg)
  }
  const { id, bytes, opts } = e.data
  let result: StripResult
  try {
    result = await stripBytes(bytes, opts)
  } catch (err) {
    // stripBytes never throws; this is a last line of defence.
    result = { status: 'failed', kind: 'file', error: err instanceof Error ? err.message : String(err) }
  }
  const msg: StripResponse = { id, result }
  scope.postMessage(msg, result.status === 'cleaned' ? [result.bytes.buffer] : [])
}
