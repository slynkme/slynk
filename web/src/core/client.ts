// Page-side handle on the core worker: a small promise-based API.
import type { CoreEvent, CoreRequest, CoreResponse, Include, InboxInfo, NetStatus } from './protocol'
import type { Packed } from '../inbox/pack'

export type { CoreEvent, FoundNotice, Include, InboxInfo, LookbackState, NetStatus } from './protocol'
export type OnProgress = (stage: string, done: number, total: number) => void

type Result = { bytes?: Uint8Array; status?: NetStatus; value?: unknown }
type Pending = { resolve: (r: Result) => void; reject: (e: Error) => void; onProgress?: OnProgress }

/** A failure from the core, with a code when the page has its own words for it (core/cmd/wasm/inbox.go). */
export class CoreError extends Error {
  readonly code?: string
  constructor(message: string, code?: string) {
    super(message)
    this.name = 'CoreError'
    this.code = code
  }
}

/** The code of a failure from the core, if it has one. */
export const errorCode = (e: unknown): string | undefined => (e instanceof CoreError ? e.code : undefined)

// Distributive Omit, so each request variant keeps its own fields.
type NewRequest = CoreRequest extends infer R ? (R extends CoreRequest ? Omit<R, 'id'> : never) : never

export class Core {
  private worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  private pending = new Map<number, Pending>()
  private nextId = 1
  /** Hears an open inbox's messages and look-back progress. */
  onEvent?: (e: CoreEvent) => void

  constructor() {
    this.worker.onmessage = (e: MessageEvent<CoreResponse>) => {
      const msg = e.data
      if (msg.kind === 'event') return this.onEvent?.(msg)
      const p = this.pending.get(msg.id)
      if (!p) return
      if (msg.kind === 'progress') {
        p.onProgress?.(msg.stage, msg.done, msg.total)
        return
      }
      this.pending.delete(msg.id)
      if (msg.kind === 'error') p.reject(new CoreError(msg.message, msg.code))
      else p.resolve(msg)
    }
    this.worker.onerror = (e) => {
      const err = new Error(e.message || 'the core failed to start')
      this.pending.forEach((p) => p.reject(err))
      this.pending.clear()
    }
  }

  private call(req: NewRequest, onProgress?: OnProgress, transfer: Transferable[] = []): Promise<Result> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress })
      this.worker.postMessage({ ...req, id } as CoreRequest, transfer)
    })
  }

  async connect(onProgress?: OnProgress): Promise<void> {
    await this.call({ op: 'connect' }, onProgress)
  }

  /** varied: 1-11 part batches instead of 9-11 (slower, fewer parts per round). */
  async upload(data: Uint8Array, varied: boolean, onProgress?: OnProgress): Promise<Uint8Array> {
    return (await this.call({ op: 'upload', bytes: data, varied }, onProgress)).bytes!
  }

  /** A download that goes quiet reports the stage "stalled" and keeps waiting. */
  async download(link: Uint8Array, onProgress?: OnProgress): Promise<Uint8Array> {
    return (await this.call({ op: 'download', bytes: link }, onProgress)).bytes!
  }

  /** Ends the running download: its promise rejects. */
  async stopDownload(): Promise<void> {
    await this.call({ op: 'stopDownload' })
  }

  /**
   * Ends the running upload: what's still to go isn't sent, and its promise
   * rejects (or resolves, if it had just finished). The identity carries on.
   */
  async stopUpload(): Promise<void> {
    await this.call({ op: 'stopUpload' })
  }

  /** Cover messages on or off: occasional blank sends while connected. */
  async setCover(on: boolean): Promise<void> {
    await this.call({ op: 'cover', on })
  }

  /** Resolves once the engine (several MB) has downloaded and started; it connects nothing. */
  async ready(): Promise<void> {
    await this.call({ op: 'ready' })
  }

  async status(): Promise<NetStatus> {
    return (await this.call({ op: 'status' })).status!
  }

  async verbose(on: boolean): Promise<void> {
    await this.call({ op: 'verbose', on })
  }

  // --- Anonymous inboxes (core/cmd/wasm/inbox.go). Only inboxOpen,
  // sendNotice and sendFileNotice use the mixnet; the rest work offline.

  /** A new inbox: its words and addresses. */
  async inboxNew(): Promise<InboxInfo> {
    return (await this.call({ op: 'inboxNew' })).value as InboxInfo
  }

  /** Checks an inbox address of either kind; rejects if it isn't a valid one. */
  async inboxAddress(address: Uint8Array): Promise<void> {
    await this.call({ op: 'inboxAddress', bytes: address })
  }

  /** Checks 12 words without connecting, and gives their inbox's addresses and store secret. */
  async inboxCheckWords(words: string): Promise<InboxInfo> {
    return (await this.call({ op: 'inboxCheckWords', words })).value as InboxInfo
  }

  /**
   * Opens an inbox with the connected identity; its messages come through
   * onEvent. plan.since (ms since 1970): look back only that far, where what
   * came before is already kept on the device; otherwise as far as the
   * network keeps. plan.skipFrom to skipTo: days a look-back cut short already
   * went through, not looked through again.
   */
  async inboxOpen(words: string, plan: { since?: number; skipFrom?: number; skipTo?: number } = {}): Promise<InboxInfo> {
    return (await this.call({ op: 'inboxOpen', words, ...plan })).value as InboxInfo
  }

  async inboxClose(): Promise<void> {
    await this.call({ op: 'inboxClose' })
  }

  /**
   * Sends a text message to an inbox, at either of its addresses, at once.
   * text is as inbox/pack.ts made it: compressed says it's raw
   * DEFLATE. separate: from the tab's second identity, which it connects
   * first if need be. include: with the inbox open in this tab, so its
   * recipient can reply (fails with the code "no-inbox" if none is
   * open in the core yet), and with the reply keys that inbox gave this one,
   * sealed as a reply: quantum-safe, in one message. A message
   * to a quantum-safe address that isn't sealed as a reply goes as its two
   * pieces a few seconds apart, each in a round of its own (always,
   * since 2026-10-19), and onProgress hears "apart" once the first has been
   * delivered. Resolves with its (first) round's time, once all of it has
   * gone.
   */
  async sendNotice(address: Uint8Array, text: Packed, separate: boolean, onProgress?: OnProgress, include?: Include): Promise<number> {
    return (await this.call({ op: 'sendNotice', address, bytes: text.bytes, compressed: text.compressed, separate, include }, onProgress)).value as number
  }

  /**
   * Tells an inbox about an upload made for it: a notice carrying its v1
   * link, from the tab's second identity (never the one that uploaded), a
   * random 1-3 minutes after since (the upload's end, ms since 1970) and on
   * the beat of cover messages. include, and how a quantum-safe one goes:
   * as for sendNotice. Resolves with its (first) round's time.
   */
  async sendFileNotice(address: Uint8Array, link: Uint8Array, since: number, onProgress?: OnProgress, include?: Include): Promise<number> {
    return (await this.call({ op: 'sendFileNotice', address, link, since, include }, onProgress)).value as number
  }

  /**
   * Connects the tab's second identity, which messages to inboxes go from
   * while the first makes links or checks an inbox, ahead of a send: Send
   * then needn't wait for it.
   */
  async noticeConnect(): Promise<void> {
    await this.call({ op: 'noticeConnect' })
  }

  /**
   * Gives up the second identity's join under way for a fresh one (Settings'
   * Restart): a send waiting for it carries on once that has joined.
   * Resolves with whether there was one to give up.
   */
  async noticeRestart(): Promise<boolean> {
    return (await this.call({ op: 'noticeRestart' })).value === true
  }

  /**
   * Stops a file notice (sendFileNotice) still waiting for its moment: its
   * promise rejects with the code "stopped". Resolves with whether it was in
   * time; once the notice has started to go, it can't be called back.
   */
  async stopFileNotice(): Promise<boolean> {
    return (await this.call({ op: 'stopFileNotice' })).value === true
  }

  // Ends the worker, which discards the identity and everything in memory.
  // Anything still waiting on it fails.
  close() {
    this.worker.terminate()
    const err = new CoreError('the core was closed')
    this.pending.forEach((p) => p.reject(err))
    this.pending.clear()
  }
}
