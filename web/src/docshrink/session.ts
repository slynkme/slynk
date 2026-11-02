// Making a PDF or an Office file smaller in the composer: measured
// once, then made for whatever share of the space it's given, as often as that
// changes, in seconds. Runs in a second copy of the cleaner's worker
// (strip/stripWorker.ts, started by docshrink/client.ts), which keeps one
// session per file until the composer lets it go.
import { sentSize } from '../compress.ts'
import { closeOffice, makeOffice, measureOffice, openOffice, ShrinkError as OfficeError, type OfficeSession } from '../officeshrink/shrink.ts'
import { MARGIN, ladder } from '../pdfshrink/plan.ts'
import { closePdf, makePdf, measurePdf, openPdf, ShrinkError as PdfError, type PdfSession } from '../pdfshrink/shrink.ts'
import { Q_FLOOR } from '../shrink/plan.ts'
import type { DocMade, DocMeasure, DocReason, DocRequest, DocResponse } from './types.ts'

type Session = { kind: 'pdf'; s: PdfSession } | { kind: 'office'; s: OfficeSession }

const sessions = new Map<number, Session>()
let stopping = false
let busy: number | undefined // the document a job is under way for

const hooks = (progress: (done: number) => void) => ({
  progress: (stage: string, done: number) => progress(stage === 'measuring' || stage === 'making' ? done : 0),
  stopped: () => stopping,
})

class Lost extends Error {}

function reasonOf(e: unknown): DocReason {
  if (e instanceof PdfError || e instanceof OfficeError) return e.reason
  if (e instanceof Lost) return 'lost'
  return 'failed'
}

function close(id: number) {
  const s = sessions.get(id)
  sessions.delete(id)
  if (s?.kind === 'pdf') closePdf(s.s)
  else if (s) closeOffice(s.s)
}

/**
 * compressed: sizes counted as it's sent, compressed as Slynk compresses a file (compress.ts):
 * for a PDF, which goes deflated. An Office file is a zip, sent as it is, so its bytes are its bytes.
 */
async function measure(id: number, kind: 'pdf' | 'office', bytes: Uint8Array, cap: number, compressed: boolean, progress: (done: number) => void): Promise<DocMeasure> {
  close(id)
  const h = hooks(progress)
  let session: Session
  const original = compressed && kind === 'pdf' ? await sentSize(bytes) : bytes.length
  if (kind === 'pdf') {
    const s = await openPdf(bytes, h, false)
    session = { kind, s }
    await measurePdf(s, true, cap, h, compressed)
  } else {
    const s = openOffice(bytes, h, false)
    session = { kind, s }
    await measureOffice(s, true, cap, h)
  }
  // Dropped or stopped after its last check: not kept, so nothing lingers in memory.
  if (stopping) {
    if (session.kind === 'pdf') closePdf(session.s)
    else closeOffice(session.s)
    throw new PdfError('stopped')
  }
  sessions.set(id, session)
  const r = session.s.report
  const least = r.levels[r.levels.length - 1]
  // What's never made smaller (text, fonts, other files) against its smallest, both as saved.
  let kept: number
  let file: number
  if (session.kind === 'pdf') {
    const { where, levels } = session.s.report
    kept = session.s.tidied!.length - where.pictures - where.masks
    file = levels[levels.length - 1].file
  } else {
    const { where } = session.s.report
    kept = where.media + where.embedded + where.fonts + where.text + where.other
    file = least.predicted
  }
  return {
    pictures: session.s.candidates.length,
    tidied: session.s.tidied!.length,
    original,
    // A level made and measured needs no room for its prediction coming out big.
    levels: r.levels.map((l) => Math.ceil(l.predicted / ('exact' in l && l.exact ? 1 : MARGIN))),
    lowerFrom: ladder(false).length,
    smallest: least.predicted,
    mostlyKept: kept * 2 > file,
  }
}

async function make(id: number, target: number, lower: boolean, progress: (done: number) => void): Promise<DocMade | undefined> {
  const session = sessions.get(id)
  if (!session) throw new Lost('not measured here')
  const tidied = session.s.tidied!
  // Re-saved without changing a picture fits: nothing's lost. As it's sent, as the share counts it.
  const tidiedSent = session.kind === 'pdf' ? (session.s.sent?.tidied ?? tidied.length) : tidied.length
  if (tidiedSent <= target) return { data: tidied.slice(), sent: tidiedSent, changed: 0, lowered: false }
  const opts = { target, lower }
  const made = session.kind === 'pdf' ? await makePdf(session.s, opts, hooks(progress)) : await makeOffice(session.s, opts, hooks(progress))
  if (!made.data) return undefined
  const lines: { out?: unknown }[] = session.kind === 'pdf' ? session.s.report.images : session.s.report.pictures
  const sent = session.kind === 'pdf' ? (session.s.report.sent ?? made.data.length) : made.data.length
  return { data: made.data, sent, changed: lines.filter((l) => l.out).length, lowered: (made.report.level?.quality ?? 1) < Q_FLOOR }
}

/** One request from the page; answers through post, with progress on the way. */
export async function handleDoc(req: DocRequest, post: (msg: DocResponse, transfer?: Transferable[]) => void): Promise<void> {
  const progress = (done: number) => post({ id: req.id, kind: 'progress', done })
  if (req.doc === 'stop') {
    stopping = true
    return
  }
  if (req.doc === 'drop') {
    // Removed while it's being measured or made: that stops too.
    if (busy === req.session) stopping = true
    close(req.session)
    return
  }
  stopping = false
  busy = req.session
  try {
    if (req.doc === 'measure') post({ id: req.id, kind: 'measured', measured: await measure(req.session, req.kind, req.bytes, req.cap, req.compressed, progress) })
    else {
      const made = await make(req.session, req.target, req.lower, progress)
      post({ id: req.id, kind: 'made', made }, made ? [made.data.buffer] : [])
    }
  } catch (e) {
    if (req.doc === 'measure') close(req.session)
    post({ id: req.id, kind: 'error', reason: reasonOf(e), message: e instanceof Error ? e.message : String(e) })
  } finally {
    busy = undefined
  }
}
