// The composer's side of making PDFs and Office files smaller: a
// second copy of the cleaner's worker, started when a document first needs it
// (its script and code were fetched for every visitor at the start: preload.ts,
// strip/formats.ts), so cleaning files added meanwhile never waits behind it.
// One job at a time; each document is measured once, then made for a size as
// often as its share of the space changes.
import type { DocKind, DocMade, DocMeasure, DocReason, DocRequest, DocResponse } from './types.ts'

export type { DocKind, DocMade, DocMeasure, DocReason } from './types.ts'

export class DocError extends Error {
  readonly reason: DocReason
  constructor(reason: DocReason, message: string = reason) {
    super(message)
    this.name = 'DocError'
    this.reason = reason
  }
}

interface Job {
  req: DocRequest
  transfer: Transferable[]
  progress(done: number): void
  resolve(r: DocResponse): void
  reject(e: DocError): void
}

let worker: Worker | undefined
let nextId = 1
let current: Job | undefined
const queue: Job[] = []

function getWorker(): Worker {
  if (worker) return worker
  const w = new Worker(new URL('../strip/stripWorker.ts', import.meta.url), { type: 'module' })
  w.onmessage = (e: MessageEvent<DocResponse>) => {
    const job = current
    if (!job || e.data.id !== job.req.id) return
    if (e.data.kind === 'progress') return job.progress(e.data.done)
    current = undefined
    if (e.data.kind === 'error') job.reject(new DocError(e.data.reason, e.data.message))
    else job.resolve(e.data)
    pump()
  }
  // Out of memory, say: every document it held is gone with it.
  w.onerror = (e) => {
    e.preventDefault()
    w.terminate()
    worker = undefined
    const job = current
    current = undefined
    job?.reject(new DocError('failed', e.message || 'the worker stopped'))
    pump()
  }
  worker = w
  return w
}

function pump() {
  if (current || !queue.length) return
  const job = (current = queue.shift()!)
  try {
    getWorker().postMessage(job.req, job.transfer)
  } catch (e) {
    current = undefined
    job.reject(new DocError('failed', e instanceof Error ? e.message : String(e)))
    pump()
  }
}

function run(req: DocRequest, progress: (done: number) => void, transfer: Transferable[] = []): Promise<DocResponse> {
  return new Promise((resolve, reject) => {
    queue.push({ req, transfer, progress, resolve, reject })
    pump()
  })
}

/**
 * Measures a document (session: the composer's own number for it); its bytes are copied over.
 * compressed: its sizes counted as it will be sent, compressed (a PDF on its own), not as it's saved.
 */
export async function measureDoc(session: number, kind: DocKind, bytes: Uint8Array, cap: number, progress: (done: number) => void, compressed = false): Promise<DocMeasure> {
  const copy = bytes.slice()
  const r = await run({ id: nextId++, doc: 'measure', session, kind, bytes: copy, cap, compressed }, progress, [copy.buffer])
  if (r.kind !== 'measured') throw new DocError('failed')
  return r.measured
}

/** Makes a measured document for target bytes (counted as it was measured); undefined when it can't fit. */
export async function makeDoc(session: number, target: number, lower: boolean, progress: (done: number) => void): Promise<DocMade | undefined> {
  const r = await run({ id: nextId++, doc: 'make', session, target, lower }, progress)
  if (r.kind !== 'made') throw new DocError('failed')
  return r.made
}

/** Lets the worker forget a document: removed, or about to be measured afresh. */
export function dropDoc(session: number): void {
  // Queued jobs for it go too; one under way stops by itself, being for a document that's gone.
  for (const job of queue.filter((j) => 'session' in j.req && j.req.session === session)) {
    queue.splice(queue.indexOf(job), 1)
    job.reject(new DocError('stopped'))
  }
  if (worker) worker.postMessage({ id: nextId++, doc: 'drop', session } satisfies DocRequest)
}

/** Stops this document's job if it's the one under way (it then fails as 'stopped'); another tray's is left alone. */
export function stopDoc(session: number): void {
  if (worker && current && 'session' in current.req && current.req.session === session) worker.postMessage({ id: nextId++, doc: 'stop' } satisfies DocRequest)
}
