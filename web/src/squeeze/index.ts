// Brotli for what's sent (payload.ts), in a worker of its own
// (squeezeWorker.ts) that runs the small helper module (core/cmd/tools-wasm),
// so the slow work never holds up the page or the mixnet worker. Its files
// are fetched for every visitor at the start (preload.ts), so starting one
// fetches nothing.
//
// Two lanes, each one worker doing one job at a time: packing what's being
// sent, and unpacking what arrived, so a link opened in a tab that's also
// packing a big file doesn't wait behind it. A worker is closed once it has
// been idle a moment, since a WebAssembly module's memory never shrinks.

export type SqueezeRequest =
  | { id: number; op: 'brotli'; data: Uint8Array; quality: number }
  | { id: number; op: 'unbrotli'; data: Uint8Array; size: number }

/** broken: the worker or its module failed (not the data), so a fresh worker may do better. */
export type SqueezeResponse = { id: number; ok: true; data: Uint8Array } | { id: number; ok: false; broken: boolean; message: string }

/** Thrown when a job fails. broken: the worker failed, not the data; unbrotli has already tried fresh ones. */
export class SqueezeError extends Error {
  broken: boolean
  constructor(message: string, broken: boolean) {
    super(message)
    this.name = 'SqueezeError'
    this.broken = broken
  }
}

export interface Squeezer {
  /** One Brotli stream of data, checked to decompress to it. Rejects with an AbortError once signal aborts. */
  brotli(data: Uint8Array, quality: number, signal?: AbortSignal): Promise<Uint8Array>
  /** Exactly size bytes from a Brotli stream, or a SqueezeError. */
  unbrotli(stream: Uint8Array, size: number): Promise<Uint8Array>
}

/**
 * Bigger files are only deflated. As much as Slynk reads of an ordinary file (tray.ts HOPELESS_SIZE):
 * 25 MB of text takes about 10 s and 220 MB of the worker's memory on a computer, freed once it's
 * idle (raised from 8 MB on 2026-10-26: a 25 MB log fits only with Brotli).
 */
export const MAX_BROTLI = 25_000_000

/**
 * Brotli's setting for this many bytes: its best (11) for the size of most pages and scripts,
 * then a little less, as the time grows. In this module on a computer, 11 handles about 120 KB a
 * second, 10 about 250 KB and 9 about 1.4 MB, each a few times slower on a phone; 10 gives about
 * 2% more than 11 and 9 about 10% more (measured on sample files, 2026-10-26). Nothing waits for it:
 * what's sent goes deflated until it's done (tray.ts).
 */
export function qualityFor(n: number): number {
  return n <= 512_000 ? 11 : n <= 2_000_000 ? 10 : 9
}

/** The parts of a Worker used here, so tests can stand one in. */
export interface SqueezeWorker {
  postMessage(message: SqueezeRequest, transfer: Transferable[]): void
  terminate(): void
  addEventListener(type: 'message', listener: (e: MessageEvent<SqueezeResponse>) => void): void
  addEventListener(type: 'error', listener: (e: Event) => void): void
  removeEventListener(type: 'message', listener: (e: MessageEvent<SqueezeResponse>) => void): void
  removeEventListener(type: 'error', listener: (e: Event) => void): void
}

const IDLE_MS = 5000
// A fresh worker's tries at unpacking, a moment apart: what arrived is all there is of a one-time link.
const UNPACK_TRIES = 3
const RETRY_DELAY_MS = 1000

type Job = { op: 'brotli'; data: Uint8Array; quality: number } | { op: 'unbrotli'; data: Uint8Array; size: number }

function lane(newWorker: () => SqueezeWorker, idleMs: number) {
  let worker: SqueezeWorker | null = null
  let tail: Promise<unknown> = Promise.resolve()
  let idle: ReturnType<typeof setTimeout> | undefined
  let next = 1

  const close = () => {
    worker?.terminate()
    worker = null
  }

  function run(job: Job, timeoutMs: number, signal?: AbortSignal): Promise<Uint8Array> {
    let started = false
    const p = tail.then(() => {
      started = true
      return once(job, timeoutMs, signal)
    })
    tail = p.catch(() => {})
    if (!signal) return p
    // Stopped while waiting its turn: settled at once, and its bytes let go, not held until the
    // job ahead of it is done (the review, 2026-10-26: a zip's unpacked copies piled up).
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        if (started) return
        job.data = new Uint8Array(0)
        reject(new DOMException('Stopped', 'AbortError'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
    })
  }

  function once(job: Job, timeoutMs: number, signal?: AbortSignal): Promise<Uint8Array> {
    if (signal?.aborted) return Promise.reject(new DOMException('Stopped', 'AbortError'))
    clearTimeout(idle)
    const w = (worker ??= newWorker())
    return new Promise((resolve, reject) => {
      const id = next++
      const timer = setTimeout(() => done(new SqueezeError('timed out', true)), timeoutMs)
      const onMessage = (e: MessageEvent<SqueezeResponse>) => {
        const r = e.data
        if (r.id !== id) return
        done(r.ok && r.data instanceof Uint8Array ? r.data : new SqueezeError(r.ok ? 'no data' : r.message, r.ok || r.broken))
      }
      // A worker whose script didn't load says so only this way.
      const onError = (e: Event) => {
        e.preventDefault()
        const said = (e as Partial<ErrorEvent>).message
        done(new SqueezeError(`the helper module didn’t load${typeof said === 'string' && said ? `: ${said}` : ''}`, true))
      }
      const onAbort = () => done(new DOMException('Stopped', 'AbortError'))
      w.addEventListener('message', onMessage)
      w.addEventListener('error', onError)
      signal?.addEventListener('abort', onAbort)
      function done(result: Uint8Array | Error) {
        clearTimeout(timer)
        w.removeEventListener('message', onMessage)
        w.removeEventListener('error', onError)
        signal?.removeEventListener('abort', onAbort)
        // A worker that failed, timed out or was stopped mid-job is no use for the next one.
        if (!(result instanceof Uint8Array) && !(result instanceof SqueezeError && !result.broken) && worker === w) close()
        clearTimeout(idle)
        idle = setTimeout(close, idleMs)
        if (result instanceof Uint8Array) resolve(result)
        else reject(result)
      }
      // A copy goes, so the caller's array stays whole.
      const data = job.data.slice()
      w.postMessage(job.op === 'brotli' ? { id, op: 'brotli', data, quality: job.quality } : { id, op: 'unbrotli', data, size: job.size }, [data.buffer])
    })
  }

  return run
}

export function makeSqueezer(newWorker: () => SqueezeWorker, idleMs = IDLE_MS, retryDelayMs = RETRY_DELAY_MS): Squeezer {
  const pack = lane(newWorker, idleMs)
  const unpack = lane(newWorker, idleMs)
  return {
    // A safety net only: about 10 seconds a megabyte, ten times what a phone needs.
    brotli: (data, quality, signal) => pack({ op: 'brotli', data, quality }, 30_000 + data.length / 100, signal),
    async unbrotli(stream, size) {
      for (let n = 1; ; n++) {
        try {
          return await unpack({ op: 'unbrotli', data: stream, size }, 30_000 + size / 1000)
        } catch (e) {
          if (!(e instanceof SqueezeError) || !e.broken || n >= UNPACK_TRIES) throw e
          await new Promise((r) => setTimeout(r, retryDelayMs))
        }
      }
    },
  }
}

let squeezer: Squeezer | null = null
let standIn: Squeezer | null = null

function current(): Squeezer {
  if (standIn) return standIn
  if (typeof Worker === 'undefined') throw new SqueezeError('no workers here', true)
  return (squeezer ??= makeSqueezer(() => new Worker(new URL('./squeezeWorker.ts', import.meta.url), { type: 'module' })))
}

/** For tests: a squeezer to use instead of the worker, or null to go back to it. */
export function useSqueezer(s: Squeezer | null): void {
  standIn = s
}

export const brotli = (data: Uint8Array, quality: number, signal?: AbortSignal): Promise<Uint8Array> =>
  Promise.resolve().then(() => current().brotli(data, quality, signal))
export const unbrotli = (stream: Uint8Array, size: number): Promise<Uint8Array> => Promise.resolve().then(() => current().unbrotli(stream, size))
