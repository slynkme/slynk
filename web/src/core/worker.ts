// Runs Slynk's Go core (compiled to WebAssembly) off the main thread, so the
// page stays responsive while it does cryptography and talks to the mixnet.
// Everything it holds lives in this worker's memory and disappears with it.
import './generated/wasm_exec.js'
import wasmUrl from './generated/slynk-core.wasm?url'
import type { CoreEvent, CoreRequest, CoreResponse, FoundNotice, InboxInfo, LookbackState, NetStatus } from './protocol'

interface SlynkCore {
  connect(onProgress: ProgressFn): Promise<void>
  upload(data: Uint8Array, varied: boolean, onProgress: ProgressFn): Promise<Uint8Array>
  download(link: Uint8Array, onProgress: ProgressFn): Promise<Uint8Array>
  stopDownload(): void
  stopUpload(): void
  cover(on: boolean): void
  status(): Promise<NetStatus>
  verbose(on: boolean): void
  inboxNew(): Promise<InboxInfo>
  inboxAddress(address: Uint8Array): Promise<boolean>
  inboxCheckWords(words: string): Promise<InboxInfo>
  inboxOpen(words: string, onEvent: (kind: string, data: FoundNotice | LookbackState) => void, since: number, skipFrom: number, skipTo: number): Promise<InboxInfo>
  inboxClose(): void
  sendNotice(address: Uint8Array, text: Uint8Array, separate: boolean, onProgress: ProgressFn, atRandom: boolean, include: boolean, name: string, compressed: boolean, replyKeys: Uint8Array | null, apart: boolean): Promise<number>
  sendFileNotice(address: Uint8Array, link: Uint8Array, since: number, onProgress: ProgressFn, include: boolean, name: string, replyKeys: Uint8Array | null, apart: boolean): Promise<number>
  noticeConnect(onProgress: ProgressFn): Promise<void>
  noticeRestart(): boolean
  stopFileNotice(): boolean
}
type ProgressFn = (stage: string, done: number, total: number) => void

declare const Go: new () => { importObject: WebAssembly.Imports; run(instance: WebAssembly.Instance): Promise<void> }
const scope = self as unknown as { slynkCore?: SlynkCore; onSlynkCoreReady?: () => void } & Worker

const core = new Promise<SlynkCore>((resolve, reject) => {
  scope.onSlynkCoreReady = () => resolve(scope.slynkCore!)
  const go = new Go()
  WebAssembly.instantiateStreaming(fetch(wasmUrl), go.importObject)
    .then(({ instance }) => go.run(instance))
    .catch(reject)
})

function reply(msg: CoreResponse, transfer: Transferable[] = []) {
  scope.postMessage(msg, transfer)
}

scope.onmessage = async (e: MessageEvent<CoreRequest>) => {
  const req = e.data
  const progress: ProgressFn = (stage, done, total) => reply({ id: req.id, kind: 'progress', stage, done, total })
  try {
    // The engine (several MB) may still be downloading and compiling.
    if (req.op === 'connect') progress('engine', 0, 0)
    const c = await core
    switch (req.op) {
      case 'connect':
        await c.connect(progress)
        reply({ id: req.id, kind: 'result' })
        break
      case 'ready':
        reply({ id: req.id, kind: 'result' })
        break
      case 'status':
        reply({ id: req.id, kind: 'result', status: await c.status() })
        break
      case 'upload': {
        const link = await c.upload(req.bytes, req.varied, progress)
        reply({ id: req.id, kind: 'result', bytes: link }, [link.buffer])
        break
      }
      case 'download': {
        const data = await c.download(req.bytes, progress)
        reply({ id: req.id, kind: 'result', bytes: data }, [data.buffer])
        break
      }
      case 'stopDownload':
        c.stopDownload()
        reply({ id: req.id, kind: 'result' })
        break
      case 'stopUpload':
        c.stopUpload()
        reply({ id: req.id, kind: 'result' })
        break
      case 'cover':
        c.cover(req.on)
        reply({ id: req.id, kind: 'result' })
        break
      case 'verbose':
        c.verbose(req.on)
        reply({ id: req.id, kind: 'result' })
        break
      case 'inboxNew':
        reply({ id: req.id, kind: 'result', value: await c.inboxNew() })
        break
      case 'inboxAddress':
        reply({ id: req.id, kind: 'result', value: await c.inboxAddress(req.bytes) })
        break
      case 'inboxCheckWords':
        reply({ id: req.id, kind: 'result', value: await c.inboxCheckWords(req.words) })
        break
      case 'inboxOpen': {
        const info = await c.inboxOpen(req.words, (kind, data) => {
          const ev: CoreEvent = kind === 'notice' ? { event: 'notice', notice: data as FoundNotice } : { event: 'lookback', lookback: data as LookbackState }
          scope.postMessage({ id: 0, kind: 'event', ...ev } satisfies CoreResponse)
        }, req.since ?? 0, req.skipFrom ?? 0, req.skipTo ?? 0)
        reply({ id: req.id, kind: 'result', value: info })
        break
      }
      case 'inboxClose':
        c.inboxClose()
        reply({ id: req.id, kind: 'result' })
        break
      case 'sendNotice': {
        // Never at a random moment: the page doesn't offer it (2026-10-18); the core keeps it for file notices.
        // Always apart: a quantum-safe message's two pieces go each in a round of its own (always,
        // with no switch, since 2026-10-19). The core ignores it for a message of one piece.
        const at = await c.sendNotice(req.address, req.bytes, req.separate, progress, false, !!req.include, req.include?.name ?? '', req.compressed, req.include?.replyKeys ?? null, true)
        reply({ id: req.id, kind: 'result', value: at })
        break
      }
      case 'sendFileNotice': {
        const at = await c.sendFileNotice(req.address, req.link, req.since, progress, !!req.include, req.include?.name ?? '', req.include?.replyKeys ?? null, true)
        reply({ id: req.id, kind: 'result', value: at })
        break
      }
      case 'noticeConnect':
        await c.noticeConnect(progress)
        reply({ id: req.id, kind: 'result' })
        break
      case 'noticeRestart':
        reply({ id: req.id, kind: 'result', value: c.noticeRestart() })
        break
      case 'stopFileNotice':
        reply({ id: req.id, kind: 'result', value: c.stopFileNotice() })
        break
    }
  } catch (err) {
    const code = err instanceof Error ? (err as Error & { code?: string }).code : undefined
    reply({ id: req.id, kind: 'error', message: err instanceof Error ? err.message : String(err), code })
  }
}
