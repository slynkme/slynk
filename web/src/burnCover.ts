// Cover requests to slynk.me's key server (site.ts KEY_SERVER). It keeps no
// logs, but whoever can see which addresses talk to it (its provider's
// network, or someone watching it) would otherwise see exactly the visits that
// sent a link (a put) or opened one (a hold, then a claim and a done). So
// every open tab of the page sends cover requests at random moments, from the
// moment it loads: a Poisson process, whose gaps are exponentially distributed
// with no floor or ceiling, so a cover request's timing says nothing. They come
// BURST_SPEEDUP times as often in the page's first BURST_S seconds, when most
// links are opened (an opener taps Open it now within seconds) and short
// messages sent.
//
// A real request takes the next slot and goes in place of its cover request,
// so it adds nothing to the visit's count and its timing is the schedule's:
// - Someone is waiting on a put, a hold, a claim or a cancel: in the first
//   BURST_S seconds, where slots come every few seconds, it waits for one for
//   MAX_WAIT_S at most, then goes anyway; after them, it goes at once, one
//   extra among dozens.
// - Nobody waits on a done, or on taking back a failed send's half-key: it
//   waits for a slot, however long, but goes at once when the tab is hidden or
//   closed, rather than wait for a timer the browser slows or stops and keep
//   slynk.me holding a share longer.
// - In a hidden tab, where nobody is looking, every other real request waits
//   for a slot, unless the tab comes back into view first.
//
// A cover request is an ordinary hold (burn.ts), padded and retried the same
// way, on a random ID nobody has, with a random nonce. The key server answers
// it "gone", as it would a used link, changing nothing.
//
// The mean gap is slynk.me's to set (the key server's -cover-gap, carried in every
// answer), so it can slow every open tab down at once. It's kept between
// MIN_GAP_S and MAX_GAP_S here, in case of a mistake there.
//
// Only the app's page sends them: the About page never makes a real request to
// the key server, so there's nothing there to cover.
import { advisedGap, coverHold, setPacer, type NetOptions } from './burn.ts'

/** Seconds, until slynk.me's first answer says otherwise (the key server's -cover-gap). */
export const DEFAULT_GAP_S = 25
export const MIN_GAP_S = 10
export const MAX_GAP_S = 3600

/** A page's first minute: when most links are opened, and short messages sent. */
export const BURST_S = 60
/** How many times as often cover requests come in it: about every 4 seconds at slynk.me's usual 25. */
export const BURST_SPEEDUP = 6
/** How long, in it, what someone waits on may wait for a slot. */
export const MAX_WAIT_S = 8

export interface CoverOptions {
  net?: NetOptions
  /** Tests only: the mean gap in milliseconds, in place of slynk.me's. */
  meanMs?: number
  /** Tests only: the burst's length, in place of BURST_S. */
  burstMs?: number
  /** Tests only: the longest wait for a slot in it, in place of MAX_WAIT_S. */
  maxWaitMs?: number
  /** Tests only: the gaps between slots, in milliseconds, in place of random ones. */
  gaps?: () => number
}

/**
 * A real request waiting for a slot. inView: someone is waiting on it, so it
 * goes first, and at once if the tab comes back into view. cap: its MAX_WAIT_S.
 */
type Waiting = { go: () => void; inView: boolean; cap?: ReturnType<typeof setTimeout> }

let running = false
let timer: ReturnType<typeof setTimeout> | undefined
let options: CoverOptions = {}
let startedAt = 0
const waiting: Waiting[] = []
let watching = false

/** Starts this tab's cover requests, if they aren't running already. */
export function startCover(opts: CoverOptions = {}): void {
  if (running) return
  running = true
  options = opts
  startedAt = performance.now()
  setPacer(turn)
  if (!watching && typeof document !== 'undefined') {
    watching = true
    // Back in view: what someone waits on goes. Hidden: what nobody waits on goes, before the timers slow.
    document.addEventListener('visibilitychange', () => release((w) => (hidden() ? !w.inView : w.inView)))
    if (typeof addEventListener === 'function') addEventListener('pagehide', () => release(() => true))
  }
  schedule()
}

/** Stops them, and lets every real request still waiting for a slot go now. A request already on its way still finishes. */
export function stopCover(): void {
  running = false
  clearTimeout(timer)
  timer = undefined
  release(() => true)
}

/** When a real request may go (burn.ts asks before each one): see the top of this file. */
export function turn(when: 'now' | 'slot'): Promise<void> {
  if (!running || (when === 'now' && !hidden() && !inBurst())) return Promise.resolve()
  return new Promise((go) => {
    const w: Waiting = { go, inView: when === 'now' }
    if (w.inView && !hidden()) w.cap = setTimeout(() => release((x) => x === w), options.maxWaitMs ?? MAX_WAIT_S * 1000)
    waiting.push(w)
  })
}

function release(which: (w: Waiting) => boolean) {
  for (const w of waiting.filter(which)) {
    waiting.splice(waiting.indexOf(w), 1)
    clearTimeout(w.cap)
    w.go()
  }
}

function inBurst(): boolean {
  return performance.now() - startedAt < (options.burstMs ?? BURST_S * 1000)
}

function hidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden'
}

/** The mean gap to use, in seconds, given what slynk.me last advised. */
export function meanGap(advised: number | undefined): number {
  if (advised === undefined || !Number.isFinite(advised)) return DEFAULT_GAP_S
  return Math.min(MAX_GAP_S, Math.max(MIN_GAP_S, advised))
}

/**
 * The wait, in ms, from `elapsed` ms after the page loaded to its next slot: a
 * Poisson process with this mean gap, but BURST_SPEEDUP times as fast for the
 * first `burst` ms. `e` is the exponential draw (mean 1) the wait is made of:
 * spent at the burst's rate while it lasts, then at the usual one.
 */
export function nextGap(elapsed: number, mean: number, burst: number = BURST_S * 1000, e: number = expGap(1)): number {
  const fast = mean / BURST_SPEEDUP
  const left = Math.max(0, burst - elapsed)
  return e * fast <= left ? e * fast : left + (e - left / fast) * mean
}

/** A gap with this mean, exponentially distributed: the wait between a Poisson process's events. */
export function expGap(mean: number, u: number = uniform()): number {
  return -Math.log(u) * mean
}

/** A uniform number in (0, 1], from 53 random bits. */
export function uniform(): number {
  const [a, b] = crypto.getRandomValues(new Uint32Array(2))
  return ((a >>> 5) * 2 ** 26 + (b >>> 6) + 1) / 2 ** 53
}

function schedule() {
  const meanMs = options.meanMs ?? meanGap(advisedGap()) * 1000
  const gap = options.gaps ? options.gaps() : nextGap(performance.now() - startedAt, meanMs, options.burstMs ?? BURST_S * 1000)
  timer = setTimeout(tick, Math.min(gap, 2 ** 31 - 1)) // beyond that, a timer fires at once
}

function tick() {
  if (!running) return
  const real = waiting.find((w) => w.inView) ?? waiting[0] // someone waiting on it goes first
  if (real) release((w) => w === real) // in place of this slot's cover request
  else void coverHold(options.net) // only its answer's "g" matters, which burn.ts notes
  schedule()
}
