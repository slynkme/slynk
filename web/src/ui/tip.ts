// A small note under something tapped, saying what it can't do (a Word
// or PowerPoint file's name says it can't be shown here). One at a time; it goes on the next tap anywhere, Escape, a
// scroll, or after a few seconds. Placed from script (the CSP allows no style
// attributes), kept clear of the screen's edges.
const EDGE = 12
const LASTS = 6000

let shown: { note: HTMLElement; timer: number } | undefined

export function closeTip() {
  if (!shown) return
  clearTimeout(shown.timer)
  shown.note.remove()
  shown = undefined
}

/** Shows text in a note just under anchor. */
export function tip(anchor: HTMLElement, text: string) {
  closeTip()
  const note = document.createElement('span')
  note.className = 'tip-note'
  note.setAttribute('role', 'status')
  note.textContent = text
  // Inside an open dialog it must be in the dialog, or it would sit under it.
  ;(anchor.closest('dialog') ?? document.body).append(note)
  const a = anchor.getBoundingClientRect()
  const width = document.documentElement.clientWidth
  const n = note.getBoundingClientRect()
  note.style.top = `${Math.round(a.bottom + 6)}px`
  note.style.left = `${Math.round(Math.max(EDGE, Math.min(a.left, width - EDGE - n.width)))}px`
  shown = { note, timer: window.setTimeout(closeTip, LASTS) }
}

document.addEventListener(
  'pointerdown',
  (e) => {
    if (shown && !shown.note.contains(e.target as Node)) closeTip()
  },
  true,
)
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeTip()
})
window.addEventListener('scroll', closeTip, true)
window.addEventListener('resize', closeTip)
