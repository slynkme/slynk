/**
 * On an iPhone or iPad, Safari offers to "View" a video or sound file it's
 * given to save. Its viewer is a page of its own that loads the file again,
 * which this page's security rules stop (and the file is let go of after 10 s
 * anyway), so it showed a broken play button (on an iPhone,
 * 2026-10-19). Handed over as a plain file, it offers only Download, which
 * works; Share is the way into Photos. Photos, text and PDFs view fine: Safari
 * shows those from the file itself.
 */
export function plainForSafari(type: string, ua = navigator.userAgent, touchPoints = navigator.maxTouchPoints): boolean {
  return isAppleTouch(ua, touchPoints) && /^(video|audio)\//i.test(type)
}

/** An iPhone or iPad. iPadOS says it's a Mac, but a Mac has no touch screen. */
export function isAppleTouch(ua = navigator.userAgent, touchPoints = navigator.maxTouchPoints): boolean {
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1)
}

/** Hands the browser a file to save, as a download. */
export function saveBlob(blob: Blob, name: string) {
  const file = plainForSafari(blob.type) ? new Blob([blob], { type: 'application/octet-stream' }) : blob
  const url = URL.createObjectURL(file)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.append(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
