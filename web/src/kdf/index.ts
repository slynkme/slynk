// Argon2id for password links, in its own worker (kdfWorker.ts). Each key
// gets a fresh worker that's closed straight afterwards, so its 64 MB is
// freed and nothing about the password stays in a long-lived worker. The
// mixnet worker never does this work: it would hold up its traffic.

export interface KdfParams {
  time: number
  memoryKiB: number
  threads: number
}

export interface KdfRequest extends KdfParams {
  password: Uint8Array
  salt: Uint8Array
}

export type KdfResponse = { ok: true; key: Uint8Array } | { ok: false; message: string }

/** Thrown when the module couldn't load or run (offline, say, or a page left open across an update). */
export class KdfError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KdfError'
  }
}

/** The parts of a Worker used here, so tests can stand one in. */
export interface KdfWorker {
  postMessage(message: KdfRequest, transfer: Transferable[]): void
  terminate(): void
  addEventListener(type: 'message', listener: (e: MessageEvent<KdfResponse>) => void): void
  addEventListener(type: 'error', listener: (e: Event) => void): void
}

export interface Kdf {
  /** Starts loading the module ahead of time (when a password box appears), so the key comes sooner. */
  warm(): void
  /** Closes a worker started by warm() that's no longer wanted. */
  cool(): void
  /** The 32-byte Argon2id key. The caller keeps its password array and should wipe it. */
  argon2id(password: Uint8Array, salt: Uint8Array, params: KdfParams): Promise<Uint8Array>
}

interface Started {
  worker: KdfWorker
  /** Set when the worker's script failed to load, which it reports only once. */
  failed: boolean
  /** What the browser said about it, if anything, for the error screen. */
  reason?: string
  /** Who to tell, once a key has been asked for. */
  onFail?: () => void
}

// Per try: a slow phone takes a few seconds, plus loading the module.
const TIMEOUT_MS = 30_000
// Before the second try, so a phone can free the first worker's memory.
const RETRY_DELAY_MS = 1000

export function makeKdf(newWorker: () => KdfWorker, timeoutMs = TIMEOUT_MS, retryDelayMs = RETRY_DELAY_MS): Kdf {
  let spare: Started | null = null

  // Listen for a failed load straight away: a worker reports it once, and a
  // listener added later never hears it, which left a key waiting for the
  // whole timeout (the review, 2026-10-15).
  function start(): Started {
    const s: Started = { worker: newWorker(), failed: false }
    s.worker.addEventListener('error', (e) => {
      e.preventDefault()
      s.failed = true
      const said = (e as Partial<ErrorEvent>).message
      s.reason = typeof said === 'string' ? said : ''
      s.onFail?.()
    })
    return s
  }

  function take(): Started {
    const s = spare && !spare.failed ? spare : start()
    if (spare && spare !== s) spare.worker.terminate()
    spare = null
    return s
  }

  return {
    warm() {
      if (!spare || spare.failed) {
        spare?.worker.terminate()
        spare = start()
      }
    },
    cool() {
      spare?.worker.terminate()
      spare = null
    },
    // One more try on a fresh worker before giving up. On a phone, a worker
    // can be paused or dropped while the visitor switches apps to fetch the
    // password, or refused memory for a moment; an iPhone hit
    // "Couldn't check the password" twice on 2026-10-15, then it worked.
    argon2id(password, salt, params) {
      return attempt(take(), password, salt, params).catch(async (first: KdfError) => {
        await new Promise((r) => setTimeout(r, retryDelayMs))
        return attempt(start(), password, salt, params).catch((second: KdfError) => {
          // Both reasons, for the error screen: they may differ.
          throw new KdfError(first.message === second.message ? first.message : `${first.message}; then ${second.message}`)
        })
      })
    },
  }

  function attempt(s: Started, password: Uint8Array, salt: Uint8Array, params: KdfParams): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => finish(new KdfError('timed out')), timeoutMs)
      function finish(result: Uint8Array | KdfError) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        s.worker.terminate()
        if (result instanceof KdfError) reject(result)
        else resolve(result)
      }
      s.onFail = () => finish(new KdfError(`the password module didn’t load${s.reason ? `: ${s.reason}` : ''}`))
      if (s.failed) return s.onFail()
      s.worker.addEventListener('message', (e) => {
        const r = e.data
        finish(r.ok && r.key instanceof Uint8Array ? r.key : new KdfError(r.ok ? 'no key' : r.message))
      })
      // The copy moves to the worker, which wipes it.
      const pw = password.slice()
      s.worker.postMessage({ password: pw, salt: salt.slice(), ...params }, [pw.buffer])
    })
  }
}

const kdf = makeKdf(() => new Worker(new URL('./kdfWorker.ts', import.meta.url), { type: 'module' }))

export const warmKdf = (): void => kdf.warm()
export const coolKdf = (): void => kdf.cool()
export const argon2id = (password: Uint8Array, salt: Uint8Array, params: KdfParams): Promise<Uint8Array> =>
  kdf.argon2id(password, salt, params)
