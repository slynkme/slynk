// Removes hidden info (location, device, dates, authors...) from files before
// they're sent. The page calls stripFile; the work happens in a worker that
// every visit starts (startCleaner, from preload.ts).
// Nothing is stored anywhere: bytes go to the worker and come straight back.
//
//   const result = await stripFile(bytes)
//   'cleaned'      send result.bytes; show the sender result.details (what was
//                  removed, with values: for their eyes only, never sent or kept)
//   'unchanged'    nothing to remove: send the original
//   'unsupported'  Slynk can't check this type: send the original, and say so
//   'skipped'      left alone on purpose (result.reason says why)
//   'failed'       ask "Couldn't clean this file. Send it as it is?"
//
// stripFile takes ownership of `bytes`: for supported types its buffer moves
// to the worker without a copy, leaving the caller's array empty. Treat it as
// gone either way, and read the File again to send the original instead.
import type { CheckRequest, CheckResponse, Warning } from '../filecheck/types.ts'
import { describeOther, detectKind } from './sniff.ts'
import type { StripOptions, StripRequest, StripResponse, StripResult } from './types.ts'

export type { Detail, Kind, StripOptions, StripResult } from './types.ts'
export { SKIP } from './types.ts'
export { detectKind } from './sniff.ts'
export { suggestNeutralName } from './names.ts'

// Malformed files could make a parser spin; give up and treat it as a failure.
const BASE_TIMEOUT_MS = 30_000
const TIMEOUT_MS_PER_MB = 2_000
// A file check is quicker than cleaning; one that spins has stuck the worker.
const CHECK_TIMEOUT_MS = 15_000

interface Job {
  id: number
  bytes: Uint8Array
  opts: StripOptions
  kind: string
  resolve: (r: StripResult) => void
}

let worker: Worker | null = null
let nextId = 1
let current: { job: Job; timer: ReturnType<typeof setTimeout> } | null = null
const queue: Job[] = []
interface Check {
  bytes: Uint8Array
  name: string
  resolve: (w: Warning[]) => void
  timer?: ReturnType<typeof setTimeout>
}
const checks = new Map<number, Check>()

/** What a check that couldn't finish says: never nothing, which would read as nothing to warn about. */
const UNREAD: Warning[] = [{ kind: 'unread' }]

/**
 * Stops the worker. requeue: it was stopped for one stuck file (that one's settled already), so the
 * checks it still held go to a fresh worker; otherwise (it failed) they say they couldn't be checked.
 */
function stopWorker(requeue = false) {
  worker?.terminate()
  worker = null
  for (const [id, c] of checks) {
    clearTimeout(c.timer)
    if (requeue) postCheck(id, c)
    else {
      checks.delete(id)
      c.resolve(UNREAD)
    }
  }
}

function finish(result: StripResult) {
  if (!current) return
  clearTimeout(current.timer)
  const { job } = current
  current = null
  job.resolve(result)
  pump()
}

/** Starts the cleaner's worker now, for every visitor (web/src/preload.ts). */
export function startCleaner(): void {
  getWorker()
}

function getWorker(): Worker {
  if (worker) return worker
  const w = new Worker(new URL('./stripWorker.ts', import.meta.url), { type: 'module' })
  w.onmessage = (e: MessageEvent<StripResponse | CheckResponse>) => {
    if ('warnings' in e.data) {
      const c = checks.get(e.data.id)
      if (!c) return
      clearTimeout(c.timer)
      checks.delete(e.data.id)
      c.resolve(e.data.warnings)
    } else if (current && e.data.id === current.job.id) finish(e.data.result)
  }
  w.onerror = (e) => {
    e.preventDefault()
    const kind = current?.job.kind ?? 'file'
    stopWorker()
    finish({ status: 'failed', kind, error: e.message || 'the cleaner failed to start' })
  }
  w.onmessageerror = () => {
    stopWorker()
    finish({ status: 'failed', kind: current?.job.kind ?? 'file', error: 'the cleaner sent back something unreadable' })
  }
  worker = w
  return w
}

// One file at a time: a stuck file can then be timed out on its own, and
// files still waiting haven't been handed over yet.
function pump() {
  if (current || !queue.length) return
  const job = queue.shift()!
  const ms = BASE_TIMEOUT_MS + (job.bytes.length / 1_000_000) * TIMEOUT_MS_PER_MB
  const timer = setTimeout(() => {
    // The file being cleaned is stuck, not the checks: they go to a fresh worker.
    stopWorker(true)
    finish({ status: 'failed', kind: job.kind, error: 'cleaning took too long' })
  }, ms)
  current = { job, timer }
  try {
    const msg: StripRequest = { id: job.id, bytes: job.bytes, opts: job.opts }
    getWorker().postMessage(msg, [job.bytes.buffer])
  } catch (err) {
    stopWorker()
    finish({ status: 'failed', kind: job.kind, error: err instanceof Error ? err.message : String(err) })
  }
}

/** Cleans one file. Never rejects: problems come back as status 'failed'. */
export function stripFile(bytes: Uint8Array, opts: StripOptions = {}): Promise<StripResult> {
  let kind: string | null
  try {
    kind = detectKind(bytes)
    if (!kind) return Promise.resolve({ status: 'unsupported', kind: describeOther(bytes) })
  } catch {
    return Promise.resolve({ status: 'unsupported', kind: null })
  }
  // Transfer needs a buffer of its own; a view into a larger one is copied.
  const owned =
    bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer ? bytes : bytes.slice()
  return new Promise((resolve) => {
    queue.push({ id: nextId++, bytes: owned, opts: { pdf: !!opts.pdf, ...(opts.skip && { skip: opts.skip }) }, kind: kind!, resolve })
    pump()
  })
}

/**
 * The warnings for a received or added file (filecheck/check.ts): what it is and what's packed in
 * it, read in this worker. Never rejects: one it can't tell about gives none, and one it couldn't
 * finish says so. The bytes are copied, so the caller keeps them.
 */
export function checkFile(bytes: Uint8Array, name: string): Promise<Warning[]> {
  return new Promise((resolve) => {
    const id = nextId++
    const check: Check = { bytes, name, resolve }
    checks.set(id, check)
    postCheck(id, check)
  })
}

function postCheck(id: number, c: Check) {
  clearTimeout(c.timer)
  c.timer = setTimeout(() => {
    checks.delete(id)
    c.resolve(UNREAD)
    // It's holding the worker: a fresh one takes the checks after it, and a file being cleaned meanwhile fails as a stuck one would.
    stopWorker(true)
    if (current) finish({ status: 'failed', kind: current.job.kind, error: 'cleaning took too long' })
  }, CHECK_TIMEOUT_MS)
  try {
    // A view into a bigger buffer would send all of it: send a copy of just these bytes instead.
    const own = c.bytes.byteOffset === 0 && c.bytes.byteLength === c.bytes.buffer.byteLength ? c.bytes : c.bytes.slice()
    const msg: CheckRequest = { id, check: { bytes: own, name: c.name } }
    getWorker().postMessage(msg, own === c.bytes ? [] : [own.buffer])
  } catch {
    clearTimeout(c.timer)
    checks.delete(id)
    c.resolve(UNREAD)
  }
}
