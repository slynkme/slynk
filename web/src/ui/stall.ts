// Wording for a download that has gone quiet: the core reports the stage
// "stalled" when no new piece has arrived for a while (core/transfer/stall.go).

/** Shown under the progress bar, with Keep waiting and Stop. */
export function stallText(done: number, total: number): string {
  if (!done) return 'Nothing has arrived yet. This is taking longer than usual.'
  return `${done} of ${total} pieces have arrived. The rest are taking longer than usual, so the link may be incomplete.`
}

/** Shown after the recipient presses Stop. */
export function stoppedText(done: number): string {
  if (!done) return 'Nothing arrived. You can try again, or ask the sender to send it again.'
  return 'Some pieces never arrived, so the link may be incomplete. You can try again, or ask the sender to send it again.'
}
