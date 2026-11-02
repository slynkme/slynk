// Reads QR codes off the main thread for the scan sheet (scan.ts), so a busy
// picture can't make the camera's view stutter. It keeps nothing: each
// picture is read and dropped, and the sheet ends the worker when it closes.
import { SCAN_READY, readQr, type ScanRequest, type ScanResponse } from './scanRead.ts'

const scope = self as unknown as Worker

scope.onmessage = (e: MessageEvent<ScanRequest>) => {
  const { id, width, height, data, invert } = e.data
  let text: string | undefined
  try {
    text = readQr(data, width, height, invert)
  } catch {
    text = undefined // a picture it can't make sense of holds no code it can read
  }
  const msg: ScanResponse = { id, text }
  scope.postMessage(msg)
}

// Loaded: the sheet waits for this before it sends a picture, and starts a fresh worker if it never comes.
scope.postMessage(SCAN_READY)
