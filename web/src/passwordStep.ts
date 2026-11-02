// The recipient's password step (main.ts, afterDownload), kept apart so its
// promises can be tested: a wrong password keeps the download and asks again;
// a fault keeps the typed password for Try again; once the password has
// opened its layer it's never asked for again, and only then may the page go
// on to slynk.me for a one-time or expiring link's other half of the key.
import { PasswordError, openWithPassword, type Derive } from './password.ts'

/** What the page holds for a link being collected. */
export interface Held {
  /** The download or, once the password has opened it, what was inside. */
  sealed?: Uint8Array
  /** sealed is past the password layer. */
  pwChecked?: boolean
  /** What the recipient typed, until it has been tried. */
  pwText?: string
}

/**
 * wrong: ask again (the download is kept). damaged, newer: give up.
 * failed: the password module didn't load or run; Try again can help.
 */
export type Step =
  | { ok: true }
  | { ok: false; reason: 'wrong' | 'damaged' | 'newer' | 'failed' }

/** Opens the password layer of held.sealed in place, wiping the outer copy. */
export async function checkPassword(held: Held, derive?: Derive): Promise<Step> {
  if (held.pwChecked) return { ok: true }
  const outer = held.sealed
  if (!outer) throw new TypeError('nothing downloaded to check')
  let inner: Uint8Array
  try {
    inner = await openWithPassword(outer, held.pwText ?? '', derive)
  } catch (e) {
    if (!(e instanceof PasswordError)) return { ok: false, reason: 'failed' }
    if (e.code === 'wrong') held.pwText = undefined
    return { ok: false, reason: e.code }
  }
  held.pwText = undefined
  outer.fill(0)
  held.sealed = inner
  held.pwChecked = true
  return { ok: true }
}
