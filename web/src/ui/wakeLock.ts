// Keeps the screen on while a send or a collect is under way, so a phone doesn't lock
// part-way and pause it (the screen wake lock; nothing is sent anywhere). The browser
// lets go of the lock whenever the page is out of sight, so it's asked for again when
// the page comes back, for as long as it's wanted. Where the browser has no such lock,
// or refuses it, the page says to keep the screen on instead.

let wanted = false
let lock: WakeLockSentinel | undefined
let asking = false
let refused = false

/** Whether this browser can keep the screen on for the page. */
export function canKeepScreenOn(): boolean {
  return 'wakeLock' in navigator && !refused
}

/** Starts or stops keeping the screen on. onRefused runs if the browser says no. */
export function keepScreenOn(on: boolean, onRefused?: () => void): void {
  wanted = on
  if (on) void ask(onRefused)
  else {
    const held = lock
    lock = undefined
    void held?.release().catch(() => {})
  }
}

async function ask(onRefused?: () => void) {
  if (!('wakeLock' in navigator) || lock || asking || document.visibilityState !== 'visible') return
  asking = true
  try {
    const got = await navigator.wakeLock.request('screen')
    // Stopped while it was being asked for: let it go at once.
    if (!wanted) void got.release().catch(() => {})
    else {
      lock = got
      got.addEventListener('release', () => {
        if (lock === got) lock = undefined
      })
    }
  } catch {
    // Refused (a battery saver, a policy): the page says to keep the screen on instead.
    refused = true
    onRefused?.()
  } finally {
    asking = false
  }
}

document.addEventListener('visibilitychange', () => {
  if (wanted && document.visibilityState === 'visible') void ask()
})
