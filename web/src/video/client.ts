// The page's side of making videos smaller: one worker (shrinkWorker.ts),
// started when the first video needs it and kept for the tab, one video at a
// time. Stopping a job tells the worker, which stops at its next picture.
// Audio files are made smaller in the same worker (audioInWorker).
import type { AudioKind } from '../audio/read.ts'
import type { AudioInput, AudioProgress, AudioReport } from '../audio/shrink.ts'
import type { Progress, Report } from './shrink.ts'
import type { FromWorker, ToWorker } from './shrinkWorker.ts'
import type { VideoStep } from './plan.ts'

let worker: Worker | undefined
let busy: Promise<unknown> = Promise.resolve()
/**
 * A worker that says nothing for this long has died without a word (a phone
 * out of memory can end one silently): it reports progress every few frames,
 * and reading the index or the sound takes seconds at most.
 */
const SILENT_MS = 60_000

export class ShrinkFailed extends Error {
  constructor(
    message: string,
    readonly report?: Report,
  ) {
    super(message)
  }
}

/**
 * Makes the video at most target bytes in the worker; steps: as "Smallest"
 * makes it, at the first of them that fits, with target only a ceiling.
 * Rejects with ShrinkFailed (its message says why: 'too-long', "can't-decode
 * …", 'stopped' …). signal stops it.
 */
export function shrinkInWorker(file: Blob, target: number, onProgress: (p: Progress) => void, signal: AbortSignal, steps?: readonly VideoStep[]): Promise<{ data: Uint8Array; report: Report }> {
  return run({ op: 'shrink', file, target, steps }, [], signal, (m, resolve) => {
    if (m.op === 'progress') onProgress(m)
    else if (m.op === 'done') resolve({ data: m.data, report: m.report })
  })
}

/**
 * Makes an audio file at most target bytes in the worker: from its
 * file, or from its sound decoded on the page (planes, handed over to the
 * worker, so unusable here afterwards). Rejects with ShrinkFailed ('too-long',
 * 'cant-decode: …', 'stopped' …). signal stops it.
 */
export function audioInWorker(input: AudioInput, target: number, onProgress: (p: AudioProgress) => void, signal: AbortSignal): Promise<{ data: Uint8Array; report: AudioReport }> {
  const transfer = 'planes' in input ? input.planes.map((p) => p.buffer as ArrayBuffer) : []
  return run({ op: 'audio', input, target }, transfer, signal, (m, resolve) => {
    if (m.op === 'audio-progress') onProgress(m)
    else if (m.op === 'audio-done') resolve({ data: m.data, report: m.report })
  })
}

/** One job in the worker, after any before it: hear handles its messages and resolves it; a failure, a stop or a silent worker rejects it. */
function run<T>(message: ToWorker, transfer: Transferable[], signal: AbortSignal, hearOne: (m: FromWorker, resolve: (v: T) => void) => void): Promise<T> {
  const job = busy.then(
    () =>
      new Promise<T>((resolve, reject) => {
        if (signal.aborted) return reject(new ShrinkFailed('stopped'))
        worker ??= new Worker(new URL('./shrinkWorker.ts', import.meta.url), { type: 'module' })
        const w = worker
        const stop = () => w.postMessage({ op: 'stop' } satisfies ToWorker)
        signal.addEventListener('abort', stop)
        let heard = Date.now()
        const watch = setInterval(() => {
          if (Date.now() - heard > SILENT_MS) broke()
        }, 5000)
        // A phone pauses a page out of sight, and its worker with it: the clock starts again on its return.
        const back = () => {
          if (document.visibilityState === 'visible') heard = Date.now()
        }
        document.addEventListener('visibilitychange', back)
        const done = () => {
          clearInterval(watch)
          document.removeEventListener('visibilitychange', back)
          signal.removeEventListener('abort', stop)
          w.removeEventListener('message', hear)
          w.removeEventListener('error', broke)
          w.removeEventListener('messageerror', broke)
        }
        const hear = (e: MessageEvent<FromWorker>) => {
          heard = Date.now()
          const m = e.data
          if (m.op === 'failed') {
            done()
            reject(new ShrinkFailed(signal.aborted ? 'stopped' : m.message, m.report))
          } else
            hearOne(m, (v) => {
              done()
              resolve(v)
            })
        }
        // The worker didn't start, or died (a phone out of memory): a fresh one next time.
        // Not "stopped", which is a stop the page asked for.
        const broke = () => {
          done()
          if (worker === w) worker = undefined
          w.terminate()
          reject(new ShrinkFailed(signal.aborted ? 'stopped' : 'the worker ended unexpectedly'))
        }
        w.addEventListener('message', hear)
        w.addEventListener('error', broke)
        w.addEventListener('messageerror', broke)
        w.postMessage(message, transfer)
      }),
  )
  busy = job.catch(() => {})
  return job
}

let stills = 0

/**
 * A still from the video, upright, at most edge pixels on its long side (point: 0 to 1 through it);
 * null if it can't be read, or if wanted says it's no longer wanted when its turn comes.
 */
export function stillInWorker(file: Blob, point = 0, edge = 160, wanted: () => boolean = () => true): Promise<ImageBitmap | null> {
  const job = busy.then(
    () =>
      new Promise<ImageBitmap | null>((resolve) => {
        if (!wanted()) return resolve(null)
        worker ??= new Worker(new URL('./shrinkWorker.ts', import.meta.url), { type: 'module' })
        const w = worker
        const which = `still-${++stills}`
        const timer = setTimeout(() => finish(null), 20_000) // a video too strange to decode in time: no picture
        const finish = (bitmap: ImageBitmap | null) => {
          clearTimeout(timer)
          w.removeEventListener('message', hear)
          resolve(bitmap)
        }
        const hear = (e: MessageEvent<FromWorker>) => {
          if (e.data.op === 'snapshots' && e.data.which === which) finish(e.data.bitmaps[0] ?? null)
        }
        w.addEventListener('message', hear)
        w.postMessage({ op: 'snapshots', file, points: [point], which, edge } satisfies ToWorker)
      }),
  )
  busy = job.catch(() => {})
  return job
}

let outlines = 0

/** An audio file's outline for its picture (audio/shrink.ts, outlineOf), decoded in the worker; null if it can't be. */
export function outlineInWorker(file: Blob, kind: AudioKind, seconds: number): Promise<number[] | null> {
  const job = busy.then(
    () =>
      new Promise<number[] | null>((resolve) => {
        worker ??= new Worker(new URL('./shrinkWorker.ts', import.meta.url), { type: 'module' })
        const w = worker
        const which = `outline-${++outlines}`
        const timer = setTimeout(() => finish(null), 30_000) // too slow to wait for: no outline
        const finish = (levels: number[] | null) => {
          clearTimeout(timer)
          w.removeEventListener('message', hear)
          resolve(levels)
        }
        const hear = (e: MessageEvent<FromWorker>) => {
          if (e.data.op === 'outline' && e.data.which === which) finish(e.data.levels)
        }
        w.addEventListener('message', hear)
        w.postMessage({ op: 'outline', file, kind, seconds, which } satisfies ToWorker)
      }),
  )
  busy = job.catch(() => {})
  return job
}
