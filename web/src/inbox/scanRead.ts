// Reading a QR code from a picture's pixels, for the scan sheet's
// worker (scanWorker.ts) and the tests; only the worker loads it, so jsQR
// never joins the page's own code. jsQR is plain JavaScript: it looks at the
// pixels it's given and returns the code's text, with no network, storage or
// workers of its own.
import jsQR from 'jsqr'

export interface ScanRequest {
  id: number
  width: number
  height: number
  /** RGBA, 4 bytes a pixel, as getImageData gives. */
  data: Uint8ClampedArray
  /** Also try it as light on dark: for photos, which are read once, not a camera's frames. */
  invert: boolean
}

export interface ScanResponse {
  id: number
  /** The code's text, or undefined when the picture holds none that can be read. */
  text?: string
}

/** The worker's first message: it has loaded and can read (scan.ts waits for it before sending pictures). */
export const SCAN_READY = { ready: true } as const

/** The text of the QR code in a picture, if one can be read. */
export function readQr(data: Uint8ClampedArray, width: number, height: number, invert = false): string | undefined {
  const code = jsQR(data, width, height, { inversionAttempts: invert ? 'attemptBoth' : 'dontInvert' })
  return code?.data || undefined
}
