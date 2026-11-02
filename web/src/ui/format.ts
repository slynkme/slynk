// Small display helpers.

export function size(bytes: number): string {
  if (bytes < 1000) return bytes === 1 ? '1 byte' : `${bytes} bytes`
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(bytes < 10_000 ? 1 : 0)} KB`
  return `${(bytes / 1_000_000).toFixed(2)} MB`
}

export function duration(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s`
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return s ? `${m} min ${s} s` : `${m} min`
}

export function ago(date: Date): string {
  const s = (Date.now() - date.getTime()) / 1000
  if (s < 90) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} minutes ago`
  if (s < 86400 * 1.5) {
    const hours = Math.round(s / 3600)
    return hours === 1 ? 'an hour ago' : `${hours} hours ago`
  }
  return `${Math.round(s / 86400)} days ago`
}

export function day(date: Date): string {
  return date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
}

/** "a file", "3 files and a message", "2 messages"… */
export function countLabel(files: number, messages: number): string {
  const f = files === 1 ? 'a file' : `${files} files`
  const m = messages === 1 ? 'a message' : `${messages} messages`
  if (files && messages) return `${f} and ${m}`
  return files ? f : m
}

export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** A calm, rounded version of a time estimate. */
export function roughly(seconds: number): string {
  if (seconds < 10) return 'a few seconds'
  if (seconds < 60) return `about ${Math.ceil(seconds / 5) * 5} s`
  return `about ${Math.round(seconds / 60)} min`
}

/**
 * The line under the progress bar, kept short enough for one line on phones
 * 360 px wide and up (the heading already says Sending or Receiving). On
 * narrower screens the time left still wraps as one piece, and the "·" stays
 * on the first line.
 */
export function piecesText(done: number, total: number, left: number | undefined, sending: boolean): string {
  if (total <= 2) {
    if (done) return 'Almost there…'
    return sending ? 'Mixing it through the mixnet… small items take a few seconds.' : 'Collecting it from the mixnet…'
  }
  const counted = `${done} of ${total} pieces`
  if (!left) return counted
  return `${counted}\u00a0· ${`${roughly(left)} left`.replace(/ /g, '\u00a0')}`
}

/**
 * Estimates time left from the average rate since the transfer started. The
 * network confirms pieces in bursts, so this is steadier than recent rates.
 * Undefined until there's enough to go on.
 */
export class Eta {
  private start = performance.now()

  update(done: number, total: number): number | undefined {
    const elapsed = this.elapsed()
    if (elapsed < 6 || done < 3 || done >= total) return undefined
    return (total - done) / (done / elapsed)
  }

  elapsed(): number {
    return (performance.now() - this.start) / 1000
  }
}
