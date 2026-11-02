// The stripper itself: detect the type, run its cleaner, then re-check the
// result with the same parser before trusting it. Pure (bytes in, result
// out), so tests can call it without a worker. It never throws.
import { loadFormat } from './formats.ts'
import { orderLabels } from './labels.ts'
import { describeOther, detectKind } from './sniff.ts'
import { type Kind, SKIP, type StripOptions, type StripResult, fail } from './types.ts'
import { describe } from './values.ts'

/** Larger inputs are left alone (Slynk reads documents and zips up to 60 MB). */
export const MAX_INPUT = 100_000_000

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export async function stripBytes(bytes: Uint8Array, opts: StripOptions = {}): Promise<StripResult> {
  let kind: Kind | null = null
  try {
    kind = detectKind(bytes)
  } catch {
    kind = null
  }
  if (!kind) {
    let other: string | null = null
    try {
      other = describeOther(bytes)
    } catch {
      other = null
    }
    return { status: 'unsupported', kind: other }
  }
  if (bytes.length > MAX_INPUT) return { status: 'skipped', kind, reason: SKIP.tooLarge }
  try {
    const mod = await loadFormat(kind)
    const out = await mod.strip(bytes, kind, opts)
    if (out.status === 'skipped') return { status: 'skipped', kind, reason: out.reason }
    if (out.status === 'unsupported') return { status: 'unsupported', kind }
    const unchecked = out.unchecked && Object.keys(out.unchecked).length ? { unchecked: out.unchecked } : {}
    if (out.status === 'unchanged' || out.removed.length === 0) return { status: 'unchanged', kind, ...unchecked }
    if (detectKind(out.bytes) !== kind) fail('the cleaned file no longer reads as the same type')
    await mod.verify(out.bytes, kind, opts)
    // Hand back a buffer of its own, so it can be transferred without copying.
    let own = out.bytes
    if (own.buffer === bytes.buffer || own.byteOffset !== 0 || own.byteLength !== own.buffer.byteLength) own = own.slice()
    const removed = orderLabels(out.removed)
    return { status: 'cleaned', bytes: own, removed, details: describe(removed, out.values), ...unchecked }
  } catch (err) {
    return { status: 'failed', kind, error: message(err) }
  }
}
