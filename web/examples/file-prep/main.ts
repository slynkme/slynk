// The example's page: choose or drop files, pick a budget and the options
// (Slynk's defaults chosen), prepare them (prepare.ts), and see each one
// before and after (a zip's files under it), what was removed, and the total
// against what the budget leaves them, with a way to save each prepared file.
import { size } from '../../src/ui/format.ts'
import { DEFAULTS, prepareFiles, type Compression, type FileChoice, type Framing, type Options, type PhotoLevel, type Prepared, type PreparedFile, type Progress, type Shrink, type VideoLevel } from './prepare.ts'

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const input = $<HTMLInputElement>('file')
const drop = $('drop')
const chosenList = $('chosen')
const chosenHelp = $('chosen-help')
const custom = $<HTMLInputElement>('custom')
const go = $<HTMLButtonElement>('go')
const stopButton = $<HTMLButtonElement>('stop')
const status = $('status')
const bar = $('bar')
const fill = $('fill')
const results = $('results')
const totalLine = $('total')
const list = $('list')

let files: File[] = []
// Each file's own choice, as Slynk's "Send original instead" and "Send full size instead".
let choices: FileChoice[] = []
let running: AbortController | undefined
// The budget the results shown were prepared for: they're Slynk's for that budget and those options.
let lastBudget: number | undefined
let stale = false
// Each saved file's address, let go of when the results are drawn again.
let saved: string[] = []

const STAGE: Record<Progress['stage'], string> = {
  reading: 'Reading',
  cleaning: 'Removing hidden details from',
  measuring: 'Measuring',
  shrinking: 'Making smaller',
  compressing: 'Compressing',
}

/** How far along a file is at each stage, from where the stage starts to where it ends. A file not made smaller stops partway. */
const ALONG: Record<Progress['stage'], [number, number]> = {
  reading: [0, 0.1],
  cleaning: [0.1, 0.25],
  compressing: [0.25, 0.4],
  measuring: [0.4, 0.7],
  shrinking: [0.7, 1],
}

const METHOD = { 'as-is': 'not compressed', deflate: 'deflated', brotli: 'Brotli' }
const bytes = (n: number) => n.toLocaleString('en-GB')

const picked = (name: string) => document.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)!.value

/** The budget chosen, or null for a custom one that isn't a whole number of bytes. */
function budget(): number | null {
  if (picked('budget') !== 'custom') return Number(picked('budget'))
  const n = Number(custom.value)
  return Number.isInteger(n) && n > 0 ? n : null
}

/** The options as chosen on the page. */
function options(): Options {
  return {
    budget: budget() ?? DEFAULTS.budget,
    clean: $<HTMLInputElement>('clean').checked,
    shrink: picked('shrink') as Shrink,
    photoLevel: $<HTMLSelectElement>('photo-level').value as PhotoLevel,
    videoLevel: Number($<HTMLSelectElement>('video-level').value) as VideoLevel,
    compression: $<HTMLSelectElement>('compression').value as Compression,
    plainNames: $<HTMLInputElement>('plain-names').checked,
    framing: $<HTMLSelectElement>('framing').value as Framing,
    perFile: (_file, i) => choices[i],
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (text) e.textContent = text
  if (className) e.className = className
  return e
}

/** A checkbox with its words, which sets one of a file's own choices. */
function toggle(text: string, set: (on: boolean) => void): HTMLLabelElement {
  const label = el('label', '', 'small')
  const box = el('input')
  box.type = 'checkbox'
  box.addEventListener('change', () => set(box.checked))
  label.append(box, ` ${text}`)
  return label
}

function choose(added: FileList | File[]) {
  files = [...added]
  choices = files.map(() => ({}))
  chosenList.replaceChildren(
    ...files.map((f, i) => {
      const li = el('li')
      li.append(el('span', `${f.name} · ${size(f.size)}`), ' ')
      // As it was: not cleaned, and sent as it is even if cleaning failed (perFile sendAsIs).
      li.append(toggle('Send original (not cleaned)', (on) => Object.assign(choices[i], on ? { clean: false, sendAsIs: true } : { clean: undefined, sendAsIs: undefined })), ' ')
      li.append(toggle('Full size', (on) => (choices[i].shrink = on ? false : undefined)))
      return li
    }),
  )
  chosenList.hidden = chosenHelp.hidden = !files.length
  refresh()
}

function refresh() {
  go.disabled = !!running || !files.length || budget() === null
  // What Slynk would make of the files depends on the budget and the options: prepared again, not re-totalled.
  if (lastBudget !== undefined && !running && (stale || budget() !== lastBudget)) status.textContent = 'The budget or options have changed: prepare them again.'
}

function drawTotal(p: Prepared) {
  const room = p.limit === p.budget ? `${bytes(p.budget)} bytes` : `${bytes(p.limit)} bytes (${bytes(p.budget)}, less the link’s own ${bytes(p.budget - p.limit)})`
  const verdict = p.waiting ? 'a file waits for an answer' : p.fits ? 'they fit' : p.total > p.limit ? `too much, by ${size(p.total - p.limit)}` : 'a file can’t go'
  totalLine.textContent = `${size(p.total)} of ${room}: ${verdict}.${p.says ? ` ${p.says}` : ''}`
  totalLine.classList.toggle('over', !p.fits)
}

function drawFile(f: PreparedFile): HTMLLIElement {
  const li = el('li', '', 'item')
  li.append(el('p', f.name, 'name'))
  const method = f.compressed.unpacked ? 'Brotli, unpacked and squeezed whole' : METHOD[f.compressed.method]
  const sizes = f.data ? `${size(f.originalSize)} → ${size(f.size)} (${method})` : `${size(f.originalSize)}, left as it was`
  li.append(el('p', sizes, 'sizes'))
  if (f.smaller) li.append(el('p', `Made smaller: ${f.smaller}.`))
  if (f.cleaning === 'copy') li.append(el('p', 'A new file was made: it holds none of the original’s hidden details.', 'muted'))
  else if (f.cleaning === 'unchanged') li.append(el('p', 'No hidden details found.', 'muted'))
  else if (f.cleaning === 'off') li.append(el('p', 'Not cleaned.', 'muted'))
  if (f.removed.length) {
    li.append(el('p', f.cleaning === 'copy' ? 'The original held:' : 'Removed:'))
    const ul = el('ul', '', 'removed')
    for (const d of f.removed) {
      const line = el('li')
      line.append(el('span', d.values.length ? `${d.label}: ` : d.label, 'label'))
      // Each value in its own span, with its own direction, so right-to-left text can't reorder the line.
      d.values.forEach((v, i) => {
        if (i) line.append(' · ')
        const value = el('span', v)
        value.dir = 'auto'
        line.append(value)
      })
      if (d.more) line.append(d.more < 0 ? ' · and more' : ` · and ${d.more} more`)
      ul.append(line)
    }
    li.append(ul)
  }
  for (const problem of f.problems) li.append(el('p', problem, 'problem'))
  if (f.inside?.length) {
    li.append(el('p', 'In it, each prepared as a file of its own:'))
    li.append(el('ul', '', 'list inside'))
    li.lastElementChild!.append(...f.inside.map(drawFile))
  }
  if (f.data) {
    const a = el('a', 'Save', 'button quiet')
    // Its file made only when it's asked for, so the prepared files aren't all held twice.
    a.href = '#'
    a.addEventListener('click', () => {
      if (!a.href.startsWith('blob:')) {
        const url = URL.createObjectURL(new Blob([f.data as BlobPart], { type: f.type || 'application/octet-stream' }))
        saved.push(url)
        a.href = url
      }
    })
    a.download = f.name
    const p = el('p')
    p.append(a)
    li.append(p)
  }
  return li
}

async function prepare() {
  if (!files.length || budget() === null) return
  running = new AbortController()
  refresh()
  stopButton.hidden = false
  bar.hidden = false
  fill.style.width = '0'
  status.textContent = 'Starting…'
  const started = performance.now()
  const along = files.map(() => 0)
  try {
    const p = await prepareFiles(files, {
      ...options(),
      signal: running.signal,
      onProgress: (pr) => {
        status.textContent = `${STAGE[pr.stage]} ${pr.name} (${pr.index} of ${pr.count})…`
        // Files are worked on side by side: each keeps how far along it has got, and the bar is their average.
        const [from, to] = ALONG[pr.stage]
        along[pr.index - 1] = Math.max(along[pr.index - 1], from + (to - from) * (pr.done ?? 0))
        fill.style.width = `${(100 * along.reduce((n, a) => n + a, 0)) / pr.count}%`
      },
    })
    lastBudget = p.budget
    stale = false
    for (const url of saved) URL.revokeObjectURL(url)
    saved = []
    list.replaceChildren(...p.files.map(drawFile))
    drawTotal(p)
    results.hidden = false
    status.textContent = `Done in ${((performance.now() - started) / 1000).toFixed(1)} s.`
  } catch (e) {
    status.textContent = e instanceof DOMException && e.name === 'AbortError' ? 'Stopped.' : `Something went wrong: ${e instanceof Error ? e.message : String(e)}`
  } finally {
    running = undefined
    stopButton.hidden = true
    bar.hidden = true
    refresh()
  }
}

input.addEventListener('change', () => input.files && choose(input.files))
drop.addEventListener('dragover', (e) => {
  e.preventDefault()
  drop.classList.add('over')
})
drop.addEventListener('dragleave', () => drop.classList.remove('over'))
drop.addEventListener('drop', (e) => {
  e.preventDefault()
  drop.classList.remove('over')
  if (e.dataTransfer?.files.length) choose(e.dataTransfer.files)
})
for (const r of document.querySelectorAll<HTMLInputElement>('input[name="budget"]')) r.addEventListener('change', refresh)
for (const id of ['clean', 'photo-level', 'video-level', 'compression', 'framing', 'plain-names']) {
  $(id).addEventListener('change', () => {
    stale = true
    refresh()
  })
}
for (const r of document.querySelectorAll<HTMLInputElement>('input[name="shrink"]')) {
  r.addEventListener('change', () => {
    stale = true
    refresh()
  })
}
custom.addEventListener('input', () => {
  document.querySelector<HTMLInputElement>('input[name="budget"][value="custom"]')!.checked = true
  refresh()
})
go.addEventListener('click', () => void prepare())
stopButton.addEventListener('click', () => running?.abort())
