// QR codes of an inbox's address, and of a link on the sent screen. Unlike a
// link's, an address is public, so its code can be shown straight away and
// saved as an image for posters. Dark on white with a quiet zone, so phone
// cameras read it in either theme. A quantum-safe address makes a much more
// detailed code (version 30, 137 squares a side, written as digits:
// address.ts inboxQrText), which the page shows larger.
//
// The library (about 8 KB) is part of the page, not loaded when a code is
// first drawn: on an iPhone (2026-10-19) the first code after
// each page load didn't show, though every later one did, and loading it on
// demand was the one thing that happened only the first time.
import { correction, generate } from 'lean-qr'
import { toSvg, toSvgSource } from 'lean-qr/extras/svg'

const code = (text: string) => generate(text, { minCorrectionLevel: correction.M })

/** text's QR code as an SVG element, dark on white with a quiet zone. */
export const qrSvg = (text: string): SVGElement => toSvg(code(text), document, { on: '#000', off: '#fff', pad: 4 })

/** Draws text's QR code into el, unless still() says it's no longer wanted. Kept async for its callers. */
export async function drawQr(el: HTMLElement, text: string, still: () => boolean = () => true): Promise<void> {
  if (still()) el.replaceChildren(qrSvg(text))
}

/**
 * text's QR code as a PNG file, about 1,024 pixels a side, each square a whole number of pixels so
 * it stays sharp. A link's code is saved this way: a phone's photo viewer shows it, to scan from the
 * screen, and it prints as well as the SVG.
 */
export async function qrPngFile(text: string): Promise<Blob> {
  const qr = code(text)
  const pad = 4
  const side = qr.size + pad * 2
  const scale = Math.max(1, Math.floor(1024 / side))
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = side * scale
  const g = canvas.getContext('2d')
  if (!g) throw new Error('no canvas')
  g.fillStyle = '#fff'
  g.fillRect(0, 0, canvas.width, canvas.height)
  g.fillStyle = '#000'
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) if (qr.get(x, y)) g.fillRect((x + pad) * scale, (y + pad) * scale, scale, scale)
  }
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('no picture'))), 'image/png'))
}

/** text's QR code as an SVG file. */
export async function qrSvgFile(text: string): Promise<Blob> {
  // Scaled up so it prints sharply without resizing.
  const source = toSvgSource(code(text), { on: '#000', off: '#fff', pad: 4, width: 1024, height: 1024, xmlDeclaration: true })
  return new Blob([source], { type: 'image/svg+xml' })
}
