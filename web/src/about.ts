// The About / FAQ page (about/index.html): the shared styles, the visitor's
// theme, opening the answer a link points to, and asking before a link leaves
// slynk.me. It never connects to the network.
import './style.css'
import { fillCopy } from './inbox/dom'
import { FOOTER_OPEN } from './inbox/inboxCopy'
import { countKept } from './inbox/kept'
import { askBeforeLeaving } from './ui/linkWarn'
import { wireLocalLinks } from './ui/localLinks'
import { applyTheme, loadSettings } from './ui/settings'

loadSettings()
applyTheme(() => {})

// A link to one answer (e.g. "/about/#size-limit" from the drop zone) opens
// it, and the section it's in: not every browser opens a closed <details> it
// scrolls to. A jump within the page does the same, even to where it already
// pointed (no hashchange then).
function openLinkedAnswer() {
  const target = location.hash.length > 1 ? document.getElementById(location.hash.slice(1)) : null
  if (!target) return
  for (let el: Element | null = target; el; el = el.parentElement) if (el instanceof HTMLDetailsElement) el.open = true
  target.scrollIntoView({ block: 'start' })
}
openLinkedAnswer()
window.addEventListener('hashchange', openLinkedAnswer)
document.addEventListener('click', (e) => {
  if (e.target instanceof Element && e.target.closest('main a[href^="#"]')) setTimeout(openLinkedAnswer)
})

// The main sections fold. Closing one that was
// scrolled past, by its heading (pinned at the top while it's open) or "Close
// this section", goes back to the list of sections, from the first.
// Closing and scrolling happen together, so the page never shows the end of
// itself for a moment as it gets shorter.
const sections = [...document.querySelectorAll<HTMLDetailsElement>('details.section')]
function closeSection(section: HTMLDetailsElement) {
  const past = section.getBoundingClientRect().top < 0
  section.open = false
  if (past) sections[0].scrollIntoView({ block: 'start' })
}
for (const section of sections) {
  section.querySelector(':scope > summary')!.addEventListener('click', (e) => {
    if (!section.open) return
    e.preventDefault()
    closeSection(section)
  })
  section.querySelector('[data-close-section]')?.addEventListener('click', () => closeSection(section))
}

// Links to other sites (the write-ups, the xx network) ask first, as in the app.
fillCopy(document.getElementById('link-warn')!)
askBeforeLeaving()
// In a copy run from one's own computer, this page's links open as ui/localLinks.ts says.
wireLocalLinks()

// No second inbox is offered while this device keeps one:
// the inbox section's button opens it instead. Looking leaves no trace (kept.ts).
countKept()
  .then((n) => {
    const a = document.getElementById('about-inbox')
    if (n > 0 && a instanceof HTMLAnchorElement) {
      a.href = '/#/open-inbox'
      a.textContent = FOOTER_OPEN
    }
  })
  .catch(() => {})
