// Solves one puzzle (puzzle.ts) for index.ts, off the page's thread, so
// typing and the screen stay smooth while it runs. Started fresh for each
// puzzle and closed afterwards.
import type { SolveRequest, SolveResponse } from './index.ts'
import { solve } from './puzzle.ts'

const scope = self as unknown as Worker

scope.onmessage = (e: MessageEvent<SolveRequest>) => {
  const { id, window, bits } = e.data
  let r: SolveResponse
  try {
    r = { ok: true, nonce: solve(id, window, bits) }
  } catch (err) {
    r = { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
  scope.postMessage(r)
}
