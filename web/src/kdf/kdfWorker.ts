// Runs Argon2id in the small helper module (core/cmd/tools-wasm) for
// kdf/index.ts, which starts a fresh worker for every key and closes it
// afterwards.
import '../core/generated/wasm_exec.js'
import wasmUrl from '../core/generated/slynk-tools.wasm?url'
import type { KdfRequest, KdfResponse } from './index.ts'

interface SlynkTools {
  argon2id(password: Uint8Array, salt: Uint8Array, time: number, memoryKiB: number, threads: number): Promise<Uint8Array>
}

declare const Go: new () => { importObject: WebAssembly.Imports; run(instance: WebAssembly.Instance): Promise<void> }
const scope = self as unknown as { slynkTools?: SlynkTools; onSlynkToolsReady?: () => void } & Worker

// The last few lines Go printed. Its runtime reports a crash (running out of
// memory, say) this way, so a failure can say why instead of only "didn't
// load" (seen on an iPhone, 2026-10-17). No password ever goes here.
const said: string[] = []
const log = console.log.bind(console)
console.log = (...parts: unknown[]) => {
  said.push(parts.map(String).join(' ').slice(0, 200))
  if (said.length > 4) said.shift()
  log(...parts)
}
const why = () => (said.length ? `: ${said.join(' / ')}` : '')

const kdf = new Promise<SlynkTools>((resolve, reject) => {
  scope.onSlynkToolsReady = () => resolve(scope.slynkTools!)
  const go = new Go()
  WebAssembly.instantiateStreaming(fetch(wasmUrl), go.importObject)
    .then(({ instance }) => go.run(instance))
    // The module never ends by itself, so ending means its runtime stopped.
    .then(() => reply({ ok: false, message: `the password module stopped${why()}` }))
    .catch(reject)
})
// Report a failed load when a key is asked for, not as an unhandled rejection.
kdf.catch(() => {})

// Anything thrown later (Go's runtime after a crash throws "already exited")
// becomes this key's error, with what Go said, rather than a bare failure.
scope.addEventListener('error', (e) => {
  e.preventDefault()
  reply({ ok: false, message: `${e.message || 'the password module failed'}${why()}` })
})

function reply(msg: KdfResponse, transfer: Transferable[] = []) {
  scope.postMessage(msg, transfer)
}

scope.onmessage = async (e: MessageEvent<KdfRequest>) => {
  const { password, salt, time, memoryKiB, threads } = e.data
  try {
    const key = await (await kdf).argon2id(password, salt, time, memoryKiB, threads)
    reply({ ok: true, key }, [key.buffer])
  } catch (err) {
    reply({ ok: false, message: err instanceof Error ? `${err.name}: ${err.message}` : String(err) })
  } finally {
    password.fill(0)
  }
}
