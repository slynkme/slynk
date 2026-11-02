// Messages between the page (client.ts) and the core worker (worker.ts).

export interface NetStatus {
  registered: number
  total: number
  healthy: boolean
  cover?: number // cover messages sent so far
  noticeJoining?: number // when the second identity started joining (ms), or 0
}

/**
 * An inbox's public half, its two addresses (the compact one, and the
 * quantum-safe one), and its words when the owner has them.
 * Checking the words also gives store: the secret an owner's page keeps the
 * inbox on their device with, if they ask it to (inbox/kept.ts).
 */
export interface InboxInfo {
  address: Uint8Array
  address4: Uint8Array
  words?: string
  store?: Uint8Array
}

/**
 * A message found in an open inbox. Times are milliseconds since 1970. One
 * found in any round but the one it was sealed for is a copy someone sent
 * again, which the core drops.
 */
export interface FoundNotice {
  id: string // the same whenever a look-back finds it again (hex)
  kind: number // 1: text (unpacked if it came compressed); 2: an upload's v1 link (files or a longer message)
  body: Uint8Array
  at: number // when the round carrying it ran: when it was sent
  quantumSafe: boolean // it came to the inbox's quantum-safe address
  from?: Uint8Array // the sender's own (compact) inbox address, if they included it so the owner can reply (proved by the core)
  fromName?: string // the name they chose to show with it, as sent: clean it before showing it
  replyKeys?: Uint8Array // the sender's reply keys for this inbox, from a quantum-safe message: answers sealed with them are quantum-safe too
}

/**
 * The open inbox included with a message, so its recipient can reply,
 * and the name to show them. replyKeys: the reply keys that inbox gave
 * this one, to seal it as a reply: quantum-safe, in one message.
 */
export interface Include {
  name: string
  replyKeys?: Uint8Array
}

/** How far opening an inbox has got (core/transfer/inbox.go, Lookback). */
export interface LookbackState {
  daysLeft: number
  daysTotal: number
  collecting: number
  finished: boolean
  missing: number // once finished: rounds the network didn't hand over, still being tried
  doneFrom: number // while looking back: everything from then until now is collected (0: can't say)
}

export type CoreRequest =
  /** Answered once the engine has downloaded and started (nothing else). */
  | { id: number; op: 'ready' }
  | { id: number; op: 'connect' }
  | { id: number; op: 'upload'; bytes: Uint8Array; varied: boolean }
  | { id: number; op: 'download'; bytes: Uint8Array }
  | { id: number; op: 'stopDownload' }
  | { id: number; op: 'stopUpload' }
  | { id: number; op: 'cover'; on: boolean }
  | { id: number; op: 'status' }
  | { id: number; op: 'verbose'; on: boolean }
  | { id: number; op: 'inboxNew' }
  | { id: number; op: 'inboxAddress'; bytes: Uint8Array }
  | { id: number; op: 'inboxCheckWords'; words: string }
  | { id: number; op: 'inboxOpen'; words: string; since?: number; skipFrom?: number; skipTo?: number }
  | { id: number; op: 'inboxClose' }
  | { id: number; op: 'sendNotice'; address: Uint8Array; bytes: Uint8Array; compressed: boolean; separate: boolean; include?: Include }
  | { id: number; op: 'sendFileNotice'; address: Uint8Array; link: Uint8Array; since: number; include?: Include }
  | { id: number; op: 'noticeConnect' }
  | { id: number; op: 'noticeRestart' }
  | { id: number; op: 'stopFileNotice' }

export type CoreEvent = { event: 'notice'; notice: FoundNotice } | { event: 'lookback'; lookback: LookbackState }

export type CoreResponse =
  | { id: number; kind: 'progress'; stage: string; done: number; total: number }
  | { id: number; kind: 'result'; bytes?: Uint8Array; status?: NetStatus; value?: unknown }
  | { id: number; kind: 'error'; message: string; code?: string }
  | ({ id: 0; kind: 'event' } & CoreEvent)
