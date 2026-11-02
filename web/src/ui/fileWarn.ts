// A received file's warnings (filecheck/check.ts) as lines under its name,
// each ending in an ⓘ that opens the sheet in index.html (#file-warn), in
// fileWarnCopy.ts's words. The whole line is the
// button, so it's easy to tap on a phone. Recipients only: they're the ones a
// harmful file is aimed at, and the words speak to them.
import * as copy from '../fileWarnCopy'
import type { InsideFile, Warning } from '../filecheck/types'
import type { Item } from '../payload'
import { checkFile } from '../strip/index'
import { visibleText } from '../strip/values'

const SVG = 'http://www.w3.org/2000/svg'

// Each file's bytes are checked once, however often its row is drawn.
const asked = new WeakMap<Uint8Array, Promise<Warning[]>>()

/** What the checks found in a received file (none when it can't tell). */
export function warningsFor(item: Item): Promise<Warning[]> {
  let found = asked.get(item.data)
  if (!found) {
    found = checkFile(item.data, item.name)
    asked.set(item.data, found)
  }
  return found
}

function icon(className: string, paths: string[], circle = false): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg')
  svg.setAttribute('class', className)
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', circle ? '2.4' : '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  if (circle) {
    const c = document.createElementNS(SVG, 'circle')
    for (const [k, v] of [['cx', '12'], ['cy', '12'], ['r', '9.5']]) c.setAttribute(k, v)
    svg.append(c)
  }
  for (const d of paths) {
    const path = document.createElementNS(SVG, 'path')
    path.setAttribute('d', d)
    svg.append(path)
  }
  return svg
}

// A warning triangle before the line, and the "Cleaned ⓘ" chip's ⓘ after it.
const warnIcon = () => icon('warn-sign', ['M10.3 4.2 2.6 17.6A2 2 0 0 0 4.3 20.6h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z', 'M12 9.5v4', 'M12 17.2v.1'])
const infoIcon = () => icon('warn-info', ['M12 11v5.5M12 7.6v.2'], true)

let wired = false

/**
 * A name inside an archive as it's shown: without characters that hide or reorder text (a name
 * can be made to read backwards, hiding its real ending), and cut in the middle when it's long,
 * never at its ending.
 */
function shownName(name: string): string {
  const chars = Array.from(visibleText(name))
  return chars.length > 100 ? `${chars.slice(0, 50).join('')}…${chars.slice(-49).join('')}` : chars.join('')
}

/** An archive's files with warnings: each name, what was found in it, and why that matters (said once). */
function insideList(files: InsideFile[]): HTMLElement {
  const list = document.createElement('ul')
  list.className = 'warn-files'
  const said = new Set<string>()
  const span = (className: string, textContent: string) => Object.assign(document.createElement('span'), { className, textContent })
  for (const f of files.slice(0, copy.SHOWN_INSIDE)) {
    const li = document.createElement('li')
    const name = span('warn-file', shownName(f.name))
    name.dir = 'auto'
    li.append(name)
    for (const w of f.warnings) {
      li.append(span('warn-what', copy.LINE(w)))
      for (const text of copy.WHY(w)) if (!said.has(text) && said.add(text)) li.append(span('warn-why', text))
    }
    list.append(li)
  }
  if (files.length > copy.SHOWN_INSIDE) list.append(Object.assign(document.createElement('li'), { className: 'warn-more', textContent: copy.MORE_INSIDE(files.length - copy.SHOWN_INSIDE) }))
  return list
}

function openWhy(w: Warning) {
  const sheet = document.getElementById('file-warn') as HTMLDialogElement
  if (!wired) {
    wired = true
    sheet.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => sheet.close()))
    sheet.addEventListener('click', (e) => {
      if (e.target === sheet) sheet.close() // the backdrop
    })
  }
  const title = document.getElementById('file-warn-title')!
  title.textContent = copy.LINE(w)
  // First, that looking at it here is fine; then why it matters once it's opened elsewhere.
  const here = document.createElement('p')
  here.className = 'warn-here'
  here.append(Object.assign(document.createElement('strong'), { textContent: copy.HERE }), ` ${copy.HERE_MORE}`)
  // An archive's files with warnings, each with why it matters.
  const inside = w.kind === 'inside' ? [insideList(w.files)] : []
  const why = copy.WHY(w).map((text) => Object.assign(document.createElement('p'), { textContent: text }))
  document.getElementById('file-warn-body')!.replaceChildren(here, ...inside, ...why)
  if (!sheet.open) sheet.showModal()
  // The title takes the focus, not the close button: Safari rings a button focused on opening.
  title.focus()
}

function line(w: Warning): HTMLElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'file-warn'
  button.setAttribute('aria-haspopup', 'dialog')
  button.setAttribute('aria-label', `${copy.LINE(w)} ${copy.WHY_LABEL}`)
  const text = document.createElement('span')
  // The ⓘ goes with the last word, so it never sits alone on a line (a browser may break before an icon).
  const words = copy.LINE(w)
  const cut = words.lastIndexOf(' ') + 1
  const tail = document.createElement('span')
  tail.className = 'warn-tail'
  tail.append(`${words.slice(cut)}\u00a0`, infoIcon())
  text.append(words.slice(0, cut), tail)
  button.append(warnIcon(), text)
  button.addEventListener('click', (e) => {
    e.stopPropagation() // not the row's own tap, which opens a preview
    openWhy(w)
  })
  return button
}

/** Fills box with a line for each warning, or hides it when there are none. */
export function showWarnings(box: HTMLElement, warnings: Warning[]) {
  box.replaceChildren(...warnings.map(line))
  box.hidden = !warnings.length
}
