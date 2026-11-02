// The puzzle slynk.me asks of every new link (puzzle.ts), solved in a worker
// of its own (powWorker.ts) so the page stays smooth. The worker is fetched
// for every visitor at the start (preload.ts), so starting one fetches
// nothing. If it can't start, or fails to load (in a page left open across an
// update, which renames it), the puzzle is solved on the page instead, in
// short slices so the page keeps responding.
import { nonceBytes, search } from './puzzle.ts'

export interface SolveRequest {
  id: Uint8Array
  window: number
  bits: number
}

export type SolveResponse = { ok: true; nonce: Uint8Array } | { ok: false; message: string }

/** Tries between breaks when solving on the page: a few milliseconds on a computer, tens on an old phone. */
const SLICE = 20_000

/** A nonce that solves it (puzzle.ts). Rejects only if the request itself is wrong (an ID of the wrong size, say). */
export function solveInBackground(id: Uint8Array, window: number, bits: number): Promise<Uint8Array> {
  if (bits === 0 || typeof Worker === 'undefined') return solveHere(id, window, bits)
  return new Promise((resolve, reject) => {
    let worker: Worker
    try {
      worker = new Worker(new URL('./powWorker.ts', import.meta.url), { type: 'module' })
    } catch {
      return solveHere(id, window, bits).then(resolve, reject)
    }
    let settled = false
    const finish = (nonce?: Uint8Array) => {
      if (settled) return
      settled = true
      worker.terminate()
      if (nonce) resolve(nonce)
      else solveHere(id, window, bits).then(resolve, reject)
    }
    worker.addEventListener('error', (e) => {
      e.preventDefault()
      finish()
    })
    worker.addEventListener('message', (e: MessageEvent<SolveResponse>) => {
      finish(e.data.ok && e.data.nonce instanceof Uint8Array ? e.data.nonce : undefined)
    })
    const request: SolveRequest = { id: id.slice(), window, bits }
    worker.postMessage(request)
  })
}

async function solveHere(id: Uint8Array, window: number, bits: number): Promise<Uint8Array> {
  for (let from = 0; ; from += SLICE) {
    const n = search(id, window, bits, from, SLICE)
    if (n >= 0) return nonceBytes(n)
    await new Promise((r) => setTimeout(r, 0))
  }
}
