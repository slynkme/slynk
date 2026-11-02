// Runs Brotli in the small helper module (core/cmd/tools-wasm) for
// squeeze/index.ts, which closes the worker once it has been idle a moment,
// since a WebAssembly module's memory never shrinks.
import '../core/generated/wasm_exec.js'
import wasmUrl from '../core/generated/slynk-tools.wasm?url'
import type { SqueezeRequest, SqueezeResponse } from './index.ts'

interface SlynkTools {
  brotli(data: Uint8Array, quality: number): Promise<Uint8Array>
  unbrotli(stream: Uint8Array, size: number): Promise<Uint8Array>
}

declare const Go: new () => { importObject: WebAssembly.Imports; run(instance: WebAssembly.Instance): Promise<void> }
const scope = self as unknown as { slynkTools?: SlynkTools; onSlynkToolsReady?: () => void } & Worker

// The last few lines Go printed: its runtime reports a crash (out of memory,
// say) this way, so a failure can say why.
const said: string[] = []
const log = console.log.bind(console)
console.log = (...parts: unknown[]) => {
  said.push(parts.map(String).join(' ').slice(0, 200))
  if (said.length > 4) said.shift()
  log(...parts)
}
const why = () => (said.length ? `: ${said.join(' / ')}` : '')

const tools = new Promise<SlynkTools>((resolve, reject) => {
  scope.onSlynkToolsReady = () => resolve(scope.slynkTools!)
  const go = new Go()
  WebAssembly.instantiateStreaming(fetch(wasmUrl), go.importObject)
    .then(({ instance }) => go.run(instance))
    // The module never ends by itself, so ending means its runtime stopped.
    .then(() => fail(`the helper module stopped${why()}`))
    .catch(reject)
})
tools.catch(() => {})

let job = 0
function fail(message: string) {
  reply({ id: job, ok: false, broken: true, message })
}

// Anything thrown later (Go's runtime after a crash throws "already exited")
// fails the job at hand, and the client starts a fresh worker.
scope.addEventListener('error', (e) => {
  e.preventDefault()
  fail(`${e.message || 'the helper module failed'}${why()}`)
})

function reply(msg: SqueezeResponse, transfer: Transferable[] = []) {
  scope.postMessage(msg, transfer)
}

scope.onmessage = async (e: MessageEvent<SqueezeRequest>) => {
  const r = e.data
  job = r.id
  let t: SlynkTools
  try {
    t = await tools
  } catch (err) {
    return reply({ id: r.id, ok: false, broken: true, message: `the helper module didn’t load: ${err instanceof Error ? err.message : String(err)}` })
  }
  try {
    const data = r.op === 'brotli' ? await t.brotli(r.data, r.quality) : await t.unbrotli(r.data, r.size)
    reply({ id: r.id, ok: true, data }, [data.buffer])
  } catch (err) {
    // The module's own answer (a damaged stream, say) leaves the worker fine; anything else (Go's
    // runtime gone between jobs, "already exited") is the worker's fault, and a fresh one may do.
    const message = err instanceof Error ? err.message : String(err)
    reply({ id: r.id, ok: false, broken: !/^(squeeze|brotli): /.test(message), message })
  }
}
