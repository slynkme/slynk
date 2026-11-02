// The file tray: the files on their way into something to send, as the page
// shows them. What's done with them (read, cleaned, compressed, planned and
// made smaller to fit) is the file list's (prep/list.ts), which the file-prep
// example (web/examples/file-prep/) runs too, so the code given to other
// developers is the code slynk.me runs. This draws each file's row (its bar,
// what it says of its copy and its cleaning, the chip listing what was
// removed, its small picture, a zip's files under it) and the box under the
// meter, and passes on what the sender chooses.
//
// The composer has one; so does an inbox's chat, with files to inboxes on
// (INBOX_FILES). Both clean in the same worker (strip/index.ts), one file at a time.
import { FIRST_PART, LINK_TEXT, barAt, baseRow, createFileList, looksShrinkable, uprightDims, type Compose as ListCompose, type ListRow, type PlainFile, type Text } from './prep/list.ts'
import { MAKERS } from './prep/makers.ts'
import { Q_FLOOR } from './shrink/plan'
import * as shrinkCopy from './shrinkCopy'
import type { Detail } from './stripHook'
import { shownName } from './strip/zipdir'
import type { IndexEntry } from './zipFile'
import { AUDIO_HOLDS_NONE, CHANGE_SETTING, COPY_HOLDS_NONE, VIDEO_HOLDS_NONE, chipText, cleaningNote, detailLine } from './ui/cleaning'
import { size } from './ui/format'
import { drawAudioThumb, drawDocThumb, drawThumb, drawVideoThumb, releaseThumb, showAudio, showDoc, showPhoto, showVideo } from './ui/photoView'
import { docPreviewOf } from './docview'
import { tip } from './ui/tip'
import { onSettings, settings } from './ui/settings'

export type { Text }

/** A file on the list, with what its row draws with. */
export interface Row extends ListRow<Row> {
  li: HTMLElement
  popOpen: boolean // the chip's list is open
  listed?: { details: Detail[] } // what the chip's list shows (its values stay on this screen only)
  thumbOf?: Uint8Array // the bytes its small picture shows ("Show photo previews")
  thumbTried?: Uint8Array // the bytes its small picture was tried for, drawn or not
  zipView?: ZipView // a zip's files' list, once it has files of its own
}

/** A zip's files' list, under its row (an item of the list it's in), and what shows it. */
interface ZipView {
  box: HTMLElement
  list: HTMLElement
  expander: HTMLButtonElement
  open: boolean
}

/** Everything that would be sent right now, packed, and what's still to come. */
export type Compose = ListCompose<Row>

export interface TrayOptions {
  /** The list the files' rows go in. */
  list: HTMLElement
  /** The box that offers smaller copies of photos, its line and its button. */
  fit: HTMLElement
  fitText: HTMLElement
  fitGo: HTMLButtonElement
  /** Everything that would be sent now: these files and whatever the host adds (its text). */
  compose(): Compose
  /** The most what's being made can carry. */
  limit(): number
  /** What copies aim for: the least the package could carry, so a later choice can't push it over. */
  planLimit(): number
  /** Something changed: the host redraws its meter, the offer (renderOffer) and its button. */
  changed(): void
  /** A file was added: the host may start joining the mixnet. */
  added(): void
  toast(text: string): void
  /** Where the focus goes once the last file is removed: the way to add files. */
  addButton(): HTMLElement
  /** The host's Send button, which takes the focus when copies make it fit. */
  sendButton(): HTMLButtonElement
  /** Opens Settings at a choice: "Shrink photos, media & docs" (s-shrink) or "Remove hidden details" (s-strip). */
  openSetting(id: 's-shrink' | 's-strip'): void
}

const COPY_PROBLEM = { open: shrinkCopy.CANT_OPEN, big: shrinkCopy.TOO_BIG, failed: shrinkCopy.FAILED }

const part = (root: Element, name: string) => root.querySelector<HTMLElement>(`[data-part="${name}"]`)!
const checkbox = (label: HTMLElement) => label.querySelector('input')!
/** Sets what an element says, only when that changes. */
const say = (el: HTMLElement, text: string) => {
  if (el.textContent !== text) el.textContent = text
}

export function createTray(o: TrayOptions) {
  // The rows of a zip's files that go as they are: only shown, never planned.
  const plainRows = new WeakMap<PlainFile, HTMLElement>()
  const prep = createFileList<Row>({
    settings,
    makers: MAKERS,
    compose: () => o.compose(),
    limit: () => o.limit(),
    planLimit: () => o.planLimit(),
    newRow: makeRow,
    updateRow,
    changed: () => o.changed(),
    added: () => o.added(),
    toast: (text) => o.toast(text),
    unreadable: (row, text) => {
      removeRow(row)
      o.toast(text)
    },
    forgot: dropView,
    zipOpened: showZip,
    zipMade: showPacked,
    zipSqueezed: (row) => {
      for (const p of row.zip?.plain ?? []) if (!p.tooBig) part(plainRows.get(p)!, 'size').textContent = size(p.usize)
    },
    runStarted: (auto) => {
      if (!auto) o.fitText.focus() // the button it replaces had the focus
    },
    runEnding: () => {
      const hadFocus = o.fit.contains(document.activeElement)
      // Once it fits (the box gone, or saying there's room): Send next, or else the first copy's line.
      return () => {
        if (!hadFocus || !(o.fit.hidden || o.fit.classList.contains('room'))) return
        const send = o.sendButton()
        if (!send.disabled) send.focus()
        else o.list.querySelector<HTMLElement>('[data-part="copy"]:not([hidden])')?.focus()
      }
    },
  })
  const { rows, inCopy, fullTooBig, sentName, sentType, newPicture, asking, shareable, isPhoto, kinds, planned, uncheckedIn, makeSmallerCopies } = prep

  // "For full size, choose “Ask first” in Settings": the link that ends the line saying Slynk made copies by itself.
  const offLink = Object.assign(document.createElement('button'), { type: 'button', className: 'soft-link', textContent: shrinkCopy.AUTO_OFF })
  offLink.addEventListener('click', () => o.openSetting('s-shrink'))
  // With "Smallest", the line saying so ends with the way to a better quality, greyed: there if wanted.
  const fitLink = Object.assign(document.createElement('button'), { type: 'button', className: 'soft-link quiet', textContent: shrinkCopy.SMALLEST_FIT })
  fitLink.addEventListener('click', () => o.openSetting('s-shrink'))
  const links: Record<keyof typeof LINK_TEXT, HTMLButtonElement> = { off: offLink, fit: fitLink }
  // The info card's badge: a tick once copies fit, a spinner while they're made (CSS).
  const badge = Object.assign(document.createElement('span'), { className: 'fit-icon' })
  badge.setAttribute('aria-hidden', 'true')
  const tick = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  tick.setAttribute('viewBox', '0 0 24 24')
  tick.setAttribute('fill', 'none')
  tick.setAttribute('stroke', 'currentColor')
  tick.setAttribute('stroke-width', '2.6')
  tick.setAttribute('stroke-linecap', 'round')
  tick.setAttribute('stroke-linejoin', 'round')
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', 'M6 12.5l4 4L18 8')
  tick.append(path)
  badge.append(tick)
  o.fit.prepend(badge)
  // Small pictures are drawn one at a time: each decodes the whole photo (48 MB for 12 megapixels).
  let thumbQueue: Promise<void> = Promise.resolve()

  /**
   * Going as it is, though that's too big to send even on its own: a photo at full size ("Ask first", or "Send full size
   * instead"), a file Slynk can't make smaller. Red, and said so, as a video too big is (green
   * "full size" looked as if all was well). Not while it may yet be made smaller, or Brotli may yet make it fit.
   */
  const goesTooBig = (row: Row) => prep.tooBigAsIs(row) && !mayShrink(row)

  /**
   * How a file's preview shows it as a document: a PDF, a document's text (RTF, 2026-10-24; Word and
   * LibreOffice Writer, 2026-10-25), or plain text (2026-10-26, any file that is text by its bytes).
   */
  const docPreview = (row: Row) => (row.sending && !row.photo && !row.video && !row.audio && !row.zip ? docPreviewOf(row.sending.data) : null)

  /** A file's row, wired to what the sender can do with it; one of a zip's files goes in the zip's list (showZip), the rest in the tray's. */
  function makeRow(file: File, inZip?: { zip: Row; header: IndexEntry }): Row {
    const li = document.querySelector<HTMLTemplateElement>('#tpl-file')!.content.firstElementChild!.cloneNode(true) as HTMLElement
    const row: Row = { ...baseRow(file), popOpen: false, li }
    const remove = part(li, 'remove')
    remove.setAttribute('aria-label', `Remove ${file.name}`)
    remove.addEventListener('click', () => removeRow(row))
    const chip = part(li, 'chip')
    const pop = part(li, 'pop')
    pop.id = `pop-${row.n}`
    part(li, 'pop-title').id = `${pop.id}-title`
    const popSet = part(li, 'pop-set')
    popSet.textContent = CHANGE_SETTING
    popSet.addEventListener('click', () => o.openSetting('s-strip'))
    pop.setAttribute('aria-labelledby', `${pop.id}-title`)
    chip.setAttribute('aria-controls', pop.id)
    chip.addEventListener('click', () => setPop(row, !row.popOpen))
    part(li, 'cleaned').addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !row.popOpen) return
      e.preventDefault()
      e.stopPropagation()
      setPop(row, false)
      chip.focus()
    })
    const original = checkbox(part(li, 'original'))
    original.addEventListener('change', () => prep.setOriginal(row, original.checked))
    part(li, 'as-is').addEventListener('click', () => prep.answer(row))
    part(li, 'drop').addEventListener('click', () => removeRow(row))
    const preview = async () => {
      if (!row.sending) return
      const kind = inCopy(row) ? 'copy' : 'full'
      // Its size as it goes, compressed, as its row says.
      const as = { sent: row.sending.stored.body.length }
      const doc = docPreview(row)
      if (doc) {
        if (!(await showDoc(sentName(row), row.sending.data, doc, kind, as))) o.toast(doc === 'pdf' ? shrinkCopy.VIEW_CANT_PDF : shrinkCopy.VIEW_CANT_DOC)
        return
      }
      if (row.audio) {
        const made = row.acopy && row.sending.data === row.acopy.data ? row.acopy : undefined
        if (!(await showAudio(sentName(row), row.sending.data, sentType(row), kind, as, made, made?.peaks))) o.toast(shrinkCopy.VIEW_CANT_AUDIO)
        return
      }
      const show = row.video ? showVideo : showPhoto
      if (!(await show(sentName(row), row.sending.data, sentType(row), kind, as))) o.toast(row.video ? shrinkCopy.VIEW_CANT_VIDEO : row.svg ? shrinkCopy.VIEW_CANT_SVG : shrinkCopy.VIEW_CANT)
    }
    part(li, 'thumb').addEventListener('click', () => void preview())
    // The name and size open it too: the small picture is a small target on a phone.
    // The picture stays the one button for keyboards and screen readers. A Word,
    // PowerPoint or Excel file's says it can't be shown here.
    part(li, 'meta').addEventListener('click', () => {
      if (li.classList.contains('previewable')) void preview()
      // A document shown as its text (RTF, Word, Writer) says nothing while its small picture is still to
      // come, and "can't" once it couldn't be drawn (pictures only, or locked: the review).
      else if (row.doc === 'office' && settings().photoPreviews && (!docPreviewOf(row.data ?? new Uint8Array()) || (!!row.thumbTried && row.thumbTried === row.sending?.data)))
        tip(part(li, 'meta'), shrinkCopy.DOC_NO_PREVIEW)
    })
    const full = part(li, 'full')
    checkbox(full).addEventListener('change', () => prep.setFull(row, checkbox(full).checked))
    if (!inZip) {
      o.list.append(li)
      return row
    }
    li.classList.add('member')
    showFolder(li, inZip.header)
    remove.setAttribute('aria-label', shrinkCopy.ZIP_REMOVE(file.name, inZip.zip.name))
    return row
  }

  /** Opens or closes a cleaned file's list of what was removed. */
  function setPop(row: Row, open: boolean) {
    row.popOpen = open
    part(row.li, 'pop').hidden = !open
    part(row.li, 'chip').setAttribute('aria-expanded', String(open))
  }

  /** Shows what the stripper removed, with the values it read: only ever here, on the sender's screen. */
  function listDetails(row: Row, shown: { details: Detail[] } | undefined) {
    if (row.listed === shown) return
    row.listed = shown
    const list = part(row.li, 'pop-list')
    list.replaceChildren()
    if (!shown) return
    for (const d of shown.details) {
      const { label, values, more } = detailLine(d)
      const li = document.createElement('li')
      const k = document.createElement('span')
      k.className = 'pop-k'
      k.textContent = values.length ? `${label}: ` : label
      li.append(k)
      values.forEach((value, i) => {
        if (i) li.append(' · ')
        // Each value keeps its own direction, so right-to-left text can't reorder the line.
        const v = document.createElement('span')
        v.className = 'pop-v'
        v.dir = 'auto'
        v.textContent = value
        li.append(v)
      })
      if (more) li.append(` · ${more}`)
      list.append(li)
    }
  }

  /** Lets go of what a row showed once it's off the list: its small picture, its row and the values on show. */
  function dropView(row: Row) {
    row.thumbOf = undefined
    releaseThumb(part(row.li, 'thumb').querySelector('canvas')!)
    row.li.remove()
    row.zipView?.box.remove()
    listDetails(row, undefined)
  }

  function removeRow(row: Row) {
    const i = rows.indexOf(row)
    if (i < 0) return
    // Keep keyboard focus nearby instead of losing it with the removed button.
    const hadFocus = row.li.contains(document.activeElement)
    const tops = rows.filter((r) => !r.parent)
    // The last listed file of a zip: the zip goes too, and the focus where it was.
    const zip = prep.remove(row)
    if (!hadFocus) return
    if (zip) return focusFrom(tops, zip)
    // The next file that shows: not one in a closed zip's list.
    const shows = (r: Row | undefined) => !!r && (!r.parent || !!r.parent.zipView?.open)
    const next = rows.slice(i).find(shows) ?? rows.slice(0, i).reverse().find(shows)
    ;(next ? part(next.li, 'remove') : o.addButton()).focus()
  }

  /** The focus where a zip that went was (tops: the files listed then): the next file, or the way to add files. */
  function focusFrom(tops: Row[], zip: Row) {
    const at = tops.indexOf(zip)
    const next = tops[at + 1] ?? tops[at - 1]
    ;(next && rows.includes(next) ? part(next.li, 'remove') : o.addButton()).focus()
  }

  /**
   * A zip's files that are rows of their own, and those that go as they are, listed under it as a
   * folder shows them, by name (the zip keeps its own order), behind "The … inside".
   */
  function showZip(row: Row) {
    const z = row.zip!
    const box = document.createElement('li')
    box.className = 'zip-files'
    box.hidden = true
    box.id = `zip-${row.n}`
    const list = document.createElement('ul')
    list.className = 'items'
    list.setAttribute('aria-label', shrinkCopy.ZIP_LIST(row.name))
    box.append(list)
    row.li.after(box)
    const expander = Object.assign(document.createElement('button'), { type: 'button', className: 'expander zip-open' })
    expander.setAttribute('aria-expanded', 'false')
    expander.setAttribute('aria-controls', box.id)
    expander.addEventListener('click', () => showMembers(row, !row.zipView?.open))
    part(row.li, 'more').append(expander)
    row.zipView = { box, list, expander, open: false }
    const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
    const items = [...z.members.map((m) => ({ entry: m.entry!, li: m.li })), ...z.plain.map((p) => ({ entry: p.entry, li: plainFile(row, p) }))]
    for (const item of items.sort((a, b) => byName(a.entry, b.entry))) list.append(item.li)
    // One too big to go even alone: shown at once, so it's clear what to take out.
    if (z.plain.some((p) => p.tooBig)) showMembers(row, true)
  }

  /** A zip's file's folder in it, above its name: so a sender sees every path that goes (a command-line zip can hold "Users/alice/…"). */
  function showFolder(li: HTMLElement, e: IndexEntry) {
    const dir = e.name.slice(0, e.name.lastIndexOf('/') + 1)
    if (!dir) return
    const folder = Object.assign(document.createElement('span'), { className: 'zip-dir', textContent: shownName(dir, !!(e.flags & 0x800)) })
    folder.dir = 'auto'
    part(li, 'name').before(folder)
  }

  /** One of a zip's files that goes as it is: its name and size, and a way to take it out of the zip. */
  function plainFile(zip: Row, p: PlainFile): HTMLElement {
    const li = document.querySelector<HTMLTemplateElement>('#tpl-file')!.content.firstElementChild!.cloneNode(true) as HTMLElement
    const e = p.header
    const name = shownName(e.name.slice(e.name.lastIndexOf('/') + 1), !!(e.flags & 0x800))
    li.classList.add('member')
    showFolder(li, e)
    part(li, 'name').textContent = name
    part(li, 'size').textContent = `${size(p.usize)} · ${p.tooBig ? shrinkCopy.TOO_LARGE : shrinkCopy.AS_IT_IS}`
    li.dataset.stage = p.tooBig ? 'blocked' : 'ready'
    li.style.setProperty('--p', '1')
    const remove = part(li, 'remove')
    remove.setAttribute('aria-label', shrinkCopy.ZIP_REMOVE(name, zip.name))
    remove.addEventListener('click', () => dropPlain(zip, p))
    plainRows.set(p, li)
    return li
  }

  /** A zip's files that go as they are, compressed in it now: each row says so, as a file on its own does. */
  function showPacked(row: Row, made: Map<string, number>) {
    for (const p of row.zip!.plain) {
      const packed = made.get(p.entry)
      part(plainRows.get(p)!, 'size').textContent = packed ? `${size(p.usize)} → ${size(packed)}` : `${size(p.usize)} · ${p.tooBig ? shrinkCopy.TOO_LARGE : shrinkCopy.AS_IT_IS}`
    }
  }

  /** Takes a file that goes as it is out of its zip, keeping the focus nearby. */
  function dropPlain(zip: Row, p: PlainFile) {
    const li = plainRows.get(p)!
    if (!zip.zip || !rows.includes(zip)) return
    const next = li.nextElementSibling ?? li.previousElementSibling
    const hadFocus = li.contains(document.activeElement)
    const tops = rows.filter((r) => !r.parent)
    li.remove()
    // The last file listed in it: the zip went too.
    if (prep.dropPlain(zip, p)) return void (hadFocus && focusFrom(tops, zip))
    if (hadFocus) (next ? part(next as HTMLElement, 'remove') : zip.zipView!.expander).focus()
  }

  /** Shows or hides a zip's files under it; their small pictures are drawn only while they show. */
  function showMembers(row: Row, open: boolean) {
    const z = row.zipView
    if (!z || !row.zip) return
    z.open = open
    z.box.hidden = !open
    z.expander.setAttribute('aria-expanded', String(open))
    row.zip.members.forEach(syncThumb)
    updateRow(row)
  }

  function rowSize(row: Row): string {
    const s = row.sending
    // As far along as its bar: the bar's first quarter was reading and cleaning it.
    if (row.vmaking !== undefined) return `${size(row.file.size)} · ${shrinkCopy.MAKING(barAt(row.vmaking))}`
    if (row.dmaking !== undefined) return `${size(row.file.size)} · ${shrinkCopy.MAKING(barAt(row.dmaking))}`
    if (row.amaking !== undefined) return `${size(row.file.size)} · ${shrinkCopy.MAKING(barAt(row.amaking))}`
    if (row.pmaking !== undefined) return `${size(row.file.size)} · ${shrinkCopy.MAKING(barAt(row.pmaking))}`
    // A photo waiting its turn: not "full size", which it won't be.
    if (row.aqueued || row.pqueued) return `${size(row.file.size)} · ${shrinkCopy.QUEUED}`
    // Not "too large to send" while it's lined up: that read as "remove it".
    // Nor a zip whose files are (the zip itself is made from them once they're done).
    const queued = (r: Row) => r.vqueued || r.aqueued || r.vmaking !== undefined || r.amaking !== undefined
    if ((row.vqueued || row.zip?.members.some(queued)) && !s) return `${size(row.file.size)} · ${shrinkCopy.QUEUED}`
    if (row.state === 'too-big' || (row.state === 'video' && !s)) return `${size(row.file.size)} · too large to send`
    if (row.state === 'reading') return `${size(row.file.size)} · reading…`
    // "Cleaning…", as its chip says "Cleaned" after: "removing hidden details…" took two lines on a phone.
    if (row.state === 'cleaning') return `${size(row.file.size)} · cleaning…`
    if (!s) return asking(row) ? size(row.file.size) : `${size(row.file.size)} · compressing…`
    if (goesTooBig(row)) return `${size(row.file.size)} · ${shrinkCopy.TOO_LARGE}`
    // A zip made smaller inside, or with files compressed in it.
    if (inCopy(row) || (row.zip && s.stored.body.length < row.file.size * 0.95)) return `${size(row.file.size)} → ${size(s.stored.body.length)}`
    if (s.stored.method !== 'as-is') return `${size(s.data.length)} → ${size(s.stored.body.length)}`
    // A photo going as it is: "full size", like "Send full size instead"
    // ("already compressed" read as if Slynk had done something to it).
    if (row.photo) return `${size(s.data.length)} · ${shrinkCopy.SIZE_FULL}`
    return s.data.length >= 64 ? `${size(s.data.length)} · already compressed` : size(s.data.length)
  }

  function updateRow(row: Row) {
    const li = row.li
    const s = row.strip
    const copied = inCopy(row)
    part(li, 'name').textContent = sentName(row)
    part(li, 'size').textContent = rowSize(row)

    const copyNote = part(li, 'copy')
    const z = row.zip
    copyNote.textContent = z
      ? z.members.some(inCopy)
        ? shrinkCopy.ZIP_NOTE(kinds(z.members.filter(inCopy)))
        : ''
      : row.videoProblem
      ? shrinkCopy.VIDEO_PROBLEM[row.videoProblem]
      : row.docProblem
        ? shrinkCopy.DOC_PROBLEM(row.docProblem, row.doc === 'pdf', row.dmeasured)
        : row.audioProblem
          ? shrinkCopy.AUDIO_PROBLEM[row.audioProblem]
          : copied
            ? row.vcopy
              ? videoNote(row)
              : row.dcopy
                ? shrinkCopy.DOC_NOTE(row.dcopy.changed, row.dcopy.lowered)
                : row.acopy
                  ? shrinkCopy.AUDIO_NOTE(row.acopy.bitrate, row.acopy.channels, row.acopy.was)
                  : shrinkCopy.COPY_NOTE(row.copy!.dims, row.copy!.from, row.copy!.quality < Q_FLOOR)
            : row.copyProblem
              ? COPY_PROBLEM[row.copyProblem]
              : ''
    copyNote.hidden = !copyNote.textContent

    // A copy can't keep the photo's hidden details, whatever "Send original instead" said.
    // A document made smaller keeps whatever its own still had, so its choice stands.
    const fresh = newPicture(row)
    const choice = fresh ? { useOriginal: false, sendAsIs: false } : row
    const note = part(li, 'note')
    // Nothing to say about cleaning something made anew (an M4A, which Slynk can't clean, made smaller).
    // A zip's line counts its own files that couldn't be cleaned too: their rows may be out of sight.
    const told = z && s && (s.status === 'cleaned' || s.status === 'unchanged') ? { ...s, unchecked: uncheckedIn(row) } : s
    note.textContent = fresh ? '' : cleaningNote(told, choice)
    note.hidden = !note.textContent

    // A cleaned file shows a chip instead, which opens the list of what was removed. So does a
    // video never read, once made smaller: it wasn't cleaned, but its new version holds none of it.
    const shown = s?.status === 'cleaned' ? s : fresh ? row.held : undefined
    const cleaned = part(li, 'cleaned')
    cleaned.hidden = !shown
    if (cleaned.hidden && row.popOpen) setPop(row, false)
    listDetails(row, shown)
    const words = chipText(choice.useOriginal)
    const chip = part(li, 'chip')
    part(li, 'chip-text').textContent = words.chip
    part(li, 'chip-hint').textContent = words.hint
    part(li, 'pop-title').textContent = words.title
    chip.classList.toggle('kept', choice.useOriginal)
    const original = part(li, 'original')
    original.hidden = s?.status !== 'cleaned' || fresh
    // The setting covers files as they go; a copy holds none whatever it says.
    part(li, 'pop-set').hidden = fresh
    part(li, 'pop-copy').hidden = !fresh
    // What a copy holds of its original's details, and the way back to that: a video's or a sound's own words.
    say(part(li, 'pop-copy'), row.audio ? AUDIO_HOLDS_NONE : row.video ? VIDEO_HOLDS_NONE : COPY_HOLDS_NONE)
    checkbox(original).checked = row.useOriginal
    const full = part(li, 'full')
    say(full.querySelector('span')!, row.audio ? shrinkCopy.USE_FULL_AUDIO : shrinkCopy.USE_FULL)
    // Not when the photo at full size couldn't go even on its own: ticking it
    // would only block Send. Always while ticked,
    // so it can be unticked.
    full.hidden = !(row.copy || row.vcopy || row.dcopy || row.acopy) || (!row.useFull && fullTooBig(row))
    checkbox(full).checked = row.useFull

    const ask = part(li, 'ask')
    ask.hidden = !asking(row)
    paintStage(row)
    const view = row.zipView
    if (z && view) {
      view.expander.hidden = !z.members.length && !z.plain.length
      // Each by what it turned out to be: one that looked like a video may be one Slynk can't read.
      const n = (f: (r: Row) => boolean) => z.members.filter(f).length
      const counts = { photos: n((r) => !!r.photo && isPhoto(r)), videos: n((r) => !!r.video), docs: n((r) => !!r.doc), audio: n((r) => !!r.audio) }
      const others = z.members.length - counts.photos - counts.videos - counts.docs - counts.audio + z.plain.length
      view.expander.textContent = z.members.length || z.plain.length ? shrinkCopy.ZIP_FILES({ ...counts, others }) : ''
    }
    part(li, 'more').hidden = copyNote.hidden && full.hidden && cleaned.hidden && note.hidden && ask.hidden && !z?.members.length && !z?.plain.length
    syncThumb(row)
    // One of a zip's files: the zip's bar follows it, and a question about it opens the list so it's seen.
    if (row.parent) {
      // A question about it, or a file in it that can't go, opens the list so it's seen.
      const stuck = row.state === 'too-big' || (!!(row.videoProblem || row.audioProblem || row.docProblem) && stageOf(row).stage === 'blocked')
      if ((asking(row) || stuck) && !row.parent.zipView?.open) showMembers(row.parent, true)
    }
    o.changed()
  }

  /**
   * How far a file is on its way, as a pale bar across its row:
   * lavender while it's worked on, filling as it goes (a video by
   * its real progress, the rest in steps); green once it's ready to go as it
   * will be sent; red when it can't be sent; amber while it waits for an answer.
   */
  function stageOf(row: Row): { stage: 'working' | 'ready' | 'blocked' | 'asking'; p: number } {
    // A zip with files of its own: as far as they are, once it's read and cleaned itself.
    const members = row.zip?.members
    if (members?.length && row.state !== 'reading' && row.state !== 'cleaning' && !asking(row)) {
      const all = members.map(stageOf)
      if (all.some((s) => s.stage === 'asking')) return { stage: 'asking', p: 1 }
      if (all.some((s) => s.stage === 'working')) return { stage: 'working', p: all.reduce((n, s) => n + (s.stage === 'working' ? s.p : 1), 0) / all.length }
      if (all.some((s) => s.stage === 'blocked')) return { stage: 'blocked', p: 1 }
    }
    if (row.vmaking !== undefined) return { stage: 'working', p: barAt(row.vmaking) }
    if (row.dmaking !== undefined) return { stage: 'working', p: barAt(row.dmaking) }
    if (row.amaking !== undefined) return { stage: 'working', p: barAt(row.amaking) }
    if (row.pmaking !== undefined) return { stage: 'working', p: barAt(row.pmaking) }
    if (row.vqueued || row.pqueued || row.dqueued || row.aqueued) return { stage: 'working', p: FIRST_PART }
    if (row.state === 'too-big' || row.videoProblem || (row.state === 'video' && !row.sending)) return { stage: 'blocked', p: 1 }
    if (row.audioProblem && row.audioProblem !== 'tight' && fullTooBig(row) && !inCopy(row)) return { stage: 'blocked', p: 1 }
    if (asking(row)) return { stage: 'asking', p: 1 }
    const first = mayShrink(row) ? FIRST_PART : 1
    if (row.state === 'reading') return { stage: 'working', p: first * (row.placed ? 0.25 : 0.1) }
    if (row.state === 'cleaning') return { stage: 'working', p: first * 0.5 }
    if (row.state === 'packing' || !row.sending) return { stage: 'working', p: first * 0.8 }
    // Ready as it is, but about to be made smaller: its bar waits where the making smaller starts.
    if (first < 1) return { stage: 'working', p: FIRST_PART }
    if (goesTooBig(row)) return { stage: 'blocked', p: 1 }
    return { stage: 'ready', p: 1 }
  }

  // Over the limit, with copies about to be made or being made (the offer's box busy): set by
  // showOffer each time the offer is drawn.
  let shrinkAhead = false

  /**
   * Whether a file's bar leaves room for its being made smaller: one that may be (a photo, video,
   * document or sound, not yet in its copy, with "Make … smaller to fit" on) while copies are
   * about to be made, or when it looks as if they will be: it's over the limit alone, or with the
   * files still on their first pass, counted at their own size.
   */
  function mayShrink(row: Row): boolean {
    if (settings().shrink === 'ask' || row.zip || inCopy(row)) return false
    const first = row.state === 'reading' || row.state === 'cleaning' || row.state === 'packing' || !row.sending
    // By its kind on its first pass: whether it can be made smaller (shareable) is known only once it's ready.
    if (!(first ? row.photo || row.video || row.doc || row.audio || looksShrinkable(row.file) : shareable(row))) return false
    // "Smallest": every one is, until a run has found it's better as it is.
    if (settings().shrink === 'smallest') return first || !planned(row)
    const coming = rows.reduce((n, r) => n + (!r.parent && !r.sending ? r.file.size : 0), 0)
    return shrinkAhead || (first && row.file.size > o.limit()) || (coming > 0 && lastWire + coming > o.limit())
  }

  /** What would be sent at the offer's last look, for mayShrink. */
  let lastWire = 0

  /** Draws the offer, and redraws files' bars when copies become about to be made, or stop being, or what goes changes size. */
  function showOffer(c: Compose) {
    renderOffer(c)
    const ahead = c.wire > o.limit() && settings().shrink !== 'ask' && !o.fit.hidden && o.fit.classList.contains('busy')
    if (ahead === shrinkAhead && c.wire === lastWire) return
    shrinkAhead = ahead
    lastWire = c.wire
    rows.forEach(paintStage)
  }

  /** A file's bar as stageOf has it, and its zip's, with what their rows say (red says "too large to send"). */
  function paintStage(row: Row) {
    const { stage, p } = stageOf(row)
    row.li.dataset.stage = stage
    row.li.style.setProperty('--p', String(p))
    part(row.li, 'size').textContent = rowSize(row)
    if (row.parent) {
      const zip = stageOf(row.parent)
      row.parent.li.dataset.stage = zip.stage
      row.parent.li.style.setProperty('--p', String(zip.p))
      part(row.parent.li, 'size').textContent = rowSize(row.parent)
    }
  }

  /**
   * "Show photo, media and document previews": the photo as it will be sent (its copy,
   * or the cleaned photo), small in place of the file icon, opening big when
   * tapped; for a video, a still from it as it will be sent, playing when
   * tapped; for audio, its outline as a few bars; an SVG drawing as a picture
   * (2026-10-26). Redrawn when what will be sent changes; the old one shows
   * until then.
   */
  function syncThumb(row: Row) {
    const icon = part(row.li, 'icon')
    const thumb = part(row.li, 'thumb')
    const canvas = thumb.querySelector('canvas')!
    const doc = docPreview(row)
    // Audio too big to go as it is has no picture until it's made smaller: its outline would mean decoding all of it, to be replaced.
    const audio = !!row.audio && (inCopy(row) || !fullTooBig(row))
    // One of a zip's files draws its picture only while the zip's list shows.
    const shown = !row.parent || !!row.parent.zipView?.open
    const data = shown && settings().photoPreviews && (row.photo || row.svg || row.video || doc || audio) && row.sending ? row.sending.data : undefined
    if (!data) {
      thumb.hidden = true
      icon.classList.remove('has-thumb')
      row.li.classList.remove('previewable')
      if (row.thumbOf) releaseThumb(canvas)
      row.thumbOf = undefined
      return
    }
    thumb.setAttribute('aria-label', shrinkCopy.PREVIEW(sentName(row)))
    if (row.thumbOf === data) return
    row.thumbOf = data
    const type = sentType(row)
    thumbQueue = thumbQueue.then(async () => {
      if (row.thumbOf !== data || !rows.includes(row)) return // changed or gone meanwhile
      const peaks = row.acopy?.data === data ? row.acopy.peaks : undefined
      const ok = await (row.video ? drawVideoThumb(canvas, data, type) : doc ? drawDocThumb(canvas, data, doc) : row.audio ? drawAudioThumb(canvas, data, peaks) : drawThumb(canvas, data, type))
      if (row.thumbOf !== data) return
      row.thumbTried = data
      thumb.hidden = !ok
      icon.classList.toggle('has-thumb', ok)
      row.li.classList.toggle('previewable', ok)
    }).catch(() => {}) // one that fails mustn't stop the others
  }

  /** The box under the meter, as the list's offer has it: an info card or the amber warning, its line, its button. */
  function renderOffer(c: Compose) {
    const box = o.fit
    const offer = prep.offer(c)
    box.classList.remove('room', 'busy')
    box.hidden = offer.kind === 'hidden'
    if (box.hidden) return
    if (offer.look) box.classList.add(offer.look)
    o.fitText.replaceChildren(...offer.says.map((p) => (typeof p === 'string' ? p : 'br' in p ? document.createElement('br') : links[p.link])))
    o.fitGo.hidden = !offer.button
    if (offer.button) {
      o.fitGo.textContent = offer.button.text
      o.fitGo.dataset.lower = offer.button.lower ? 'yes' : ''
    }
    if (offer.start) queueMicrotask(() => void makeSmallerCopies(false, true)) // not from inside the host's redraw
  }

  /** "Made smaller: 288 × 512 pixels (was 2160 × 3840)", the frame rate if it lost frames, and the sound if it lost that. */
  function videoNote(row: Row): string {
    const v = row.video!
    const made = row.vcopy!
    const from = uprightDims({ width: v.width, height: v.height }, v.rotation)
    const fewer = made.fps < Math.min(30, Math.round(v.fps)) ? made.fps : undefined
    const note = shrinkCopy.VIDEO_NOTE(made.dims, from, fewer)
    return v.sound && made.sound === 'none' ? `${note}. ${shrinkCopy.NO_SOUND}` : note
  }

  o.fitGo.addEventListener('click', (e) => void makeSmallerCopies(!!(e.currentTarget as HTMLElement).dataset.lower))

  // The settings the list follows change what it does (prep/list.ts heard); turning previews on or off draws or drops them.
  let previewsWereOn = settings().photoPreviews
  const unhear = onSettings((s) => {
    prep.heard(s)
    if (s.photoPreviews === previewsWereOn) return
    previewsWereOn = s.photoPreviews
    rows.forEach(syncThumb)
  })

  return {
    add: prep.add,
    /** Empties the tray: every file goes, and a run of copies in progress stops. */
    clear: prep.clear,
    /** Empties the tray for good: a tray of the inbox's chat, gone at Lock or with its conversation. */
    close() {
      prep.clear()
      unhear()
    },
    compose: prep.compose,
    blocker: prep.blocker,
    waiting: prep.waiting,
    renderOffer: showOffer,
    /** How many files are on the list (a zip's own files go inside it). */
    count: () => rows.filter((r) => !r.parent).length,
    /** Photos or videos are being made smaller to fit right now. */
    working: prep.working,
    stopSqueezing: prep.stopSqueezing,
    /** The first file's name as it will go: what the progress screen calls a lone file. */
    firstName: () => (rows[0] ? sentName(rows[0]) : ''),
  }
}

export type Tray = ReturnType<typeof createTray>
