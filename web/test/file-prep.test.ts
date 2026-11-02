// The file-prep example (web/examples/file-prep/) against Slynk as it is now.
// It runs Slynk's own engine, the file list its composer runs (web/src/prep/list.ts),
// so there's no copy of the composer's planning to keep in step: these check
// that it still imports that engine and plans nothing of its own; that it
// type-checks; that its defaults are still Slynk's; that it stays out of the
// site's build; and that prepareFiles cleans, counts, compresses and plans as
// the composer does. Its workers are stood in for by the same engines run in
// this process. Node has no canvas, WebCodecs or Brotli helper, so photos,
// videos and audio aren't made smaller here (file-list.test.ts stands in for
// what makes them, to check the plan): the demo page, in a browser, is where
// that's tried, beside Slynk's own page with the same files.
// Run from the repo root: npm --prefix web test
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync, brotliDecompressSync, constants, inflateRawSync } from 'node:zlib'
import { strToU8, unzipSync, zipSync } from 'fflate'
import { PDFDocument } from 'pdf-lib'
import { contains, fakeVideo } from './strip/fixtures.ts'
import { docx, photoWithGps, pngWithAuthor, privateRtf } from './strip/docfixtures.ts'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const EXAMPLE = '../examples/file-prep/'

// A few of Slynk's modules use TypeScript that Node's type-stripping can't run (video/client.ts's
// parameter properties): those are turned into JavaScript here, as the site's bundler does.
// Node calls both features experimental and says so once; the test doesn't need telling.
const WEB = new URL('../', import.meta.url).href
const quietly = <T>(f: () => T): T => {
  const emit = process.emitWarning
  process.emitWarning = () => {}
  try {
    return f()
  } finally {
    process.emitWarning = emit
  }
}
quietly(() =>
  registerHooks({
    load(url, context, next) {
      const loaded = next(url, context)
      if (!url.startsWith(WEB) || url.includes('/node_modules/') || loaded.format !== 'module-typescript') return loaded
      const source = String(loaded.source)
      try {
        quietly(() => stripTypeScriptTypes(source))
        return loaded
      } catch {
        return { ...loaded, format: 'module', source: quietly(() => stripTypeScriptTypes(source, { mode: 'transform', sourceUrl: url })) }
      }
    },
  }),
)

/**
 * Stands in for the page's workers. The cleaner's (which also makes documents smaller) answers as
 * strip/stripWorker.ts does, with the same engines; the rest (the Brotli helper's, the video
 * worker) fail to start, as where Slynk's WebAssembly helper isn't built. Messages are copied as
 * a worker's are: what's transferred is gone from the sender.
 */
class StandInWorker extends EventTarget {
  static started: string[] = []
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: ((e: Event) => void) | null = null
  onmessageerror: (() => void) | null = null
  readonly script: string
  ended = false
  constructor(url: URL | string) {
    super()
    this.script = String(url).slice(String(url).lastIndexOf('/') + 1)
    StandInWorker.started.push(this.script)
  }
  postMessage(msg: any, transfer: Transferable[] = []) {
    if (this.script !== 'stripWorker.ts') {
      setImmediate(() => this.fail(`${this.script} isn’t run in this test`))
      return
    }
    const req = structuredClone(msg, { transfer })
    setImmediate(async () => {
      const post = (m: unknown, t: Transferable[] = []) => this.reply(m, t)
      if ('doc' in req) return handleDoc(req, post)
      if ('check' in req) return post({ id: req.id, warnings: await checkBytes(req.check.bytes, req.check.name) })
      let result
      try {
        result = await stripBytes(req.bytes, req.opts)
      } catch (err) {
        // As stripWorker.ts: a last line of defence.
        result = { status: 'failed', kind: 'file', error: err instanceof Error ? err.message : String(err) }
      }
      post({ id: req.id, result }, result.status === 'cleaned' ? [result.bytes.buffer] : [])
    })
  }
  terminate() {
    this.ended = true
  }
  private reply(data: unknown, transfer: Transferable[]) {
    if (this.ended) return
    const e = new MessageEvent('message', { data: structuredClone(data, { transfer }) })
    this.onmessage?.(e)
    this.dispatchEvent(e)
  }
  private fail(message: string) {
    if (this.ended) return
    const e = Object.assign(new Event('error', { cancelable: true }), { message })
    this.onerror?.(e)
    this.dispatchEvent(e)
  }
}
;(globalThis as { Worker?: unknown }).Worker = StandInWorker

// After the hook and the stand-in, so both apply to everything the example imports.
const { stripBytes } = await import('../src/strip/engine.ts')
const { handleDoc } = await import('../src/docshrink/session.ts')
const { checkBytes } = await import('../src/filecheck/check.ts')
const { useSqueezer } = await import('../src/squeeze/index.ts')
const { MAX_PAYLOAD } = await import('../src/payload.ts')
const { MAX_PAYLOAD_SEALED, SEAL_OVERHEAD } = await import('../src/burn.ts')
const { PASSWORD_OVERHEAD } = await import('../src/password.ts')
const { ONE_TIME_ONLY } = await import('../src/site.ts')
const shrinkCopy = await import('../src/shrinkCopy.ts')
const { settings } = await import('../src/ui/settings.ts')
const { FLOOR_EDGE, MAX_EDGE, PHOTO_LEVELS, Q_FLOOR, Q_LOWEST, Q_MAX } = await import('../src/shrink/plan.ts')
const { VIDEO_LEVELS } = await import('../src/video/plan.ts')
const { DEFAULTS, prepareFiles } = await import('../examples/file-prep/prepare.ts')

const file = (bytes: Uint8Array, name: string, type = '') => new File([bytes as BlobPart], name, { type })
const note = new TextEncoder().encode('A plain text note, said again and again. '.repeat(2000))

/** A mono 16-bit WAV of a tone, seconds long at rate. */
function wav(seconds: number, rate = 8000): Uint8Array {
  const n = rate * seconds
  const b = new Uint8Array(44 + n * 2)
  const v = new DataView(b.buffer)
  const s = (o: number, t: string) => [...t].forEach((c, i) => (b[o + i] = c.charCodeAt(0)))
  s(0, 'RIFF')
  v.setUint32(4, 36 + n * 2, true)
  s(8, 'WAVE')
  s(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, 1, true)
  v.setUint32(24, rate, true)
  v.setUint32(28, rate * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  s(36, 'data')
  v.setUint32(40, n * 2, true)
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(8000 * Math.sin(i / 10)), true)
  return b
}

/** A PDF of small text with an author and a title, pages of it. */
async function textPdf(pages: number, line: () => string): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.setAuthor('Example Author')
  doc.setTitle('Example Title')
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage()
    for (let j = 0; j < 60; j++) page.drawText(line(), { x: 10, y: 10 + j * 12, size: 6 })
  }
  return new Uint8Array(await doc.save({ useObjectStreams: false }))
}

// --- It still runs Slynk's engine ---------------------------------------------------------

const prepare = read(EXAMPLE + 'prepare.ts')
const tray = read('../src/tray.ts')

test('the example type-checks as its own project', () => {
  const tsc = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))
  try {
    execFileSync(process.execPath, [tsc, '--noEmit', '-p', fileURLToPath(new URL(EXAMPLE, import.meta.url))], { encoding: 'utf8', stdio: 'pipe' })
  } catch (e) {
    const { stdout, stderr } = e as { stdout?: string; stderr?: string }
    assert.fail(`tsc -p examples/file-prep found errors:\n${stdout || stderr || e}`)
  }
})

test('its defaults are still Slynk’s, on the page and in the README too', () => {
  // Before any are loaded, settings() are Slynk's defaults.
  const s = settings()
  const slynk = {
    budget: MAX_PAYLOAD,
    clean: s.stripMetadata,
    shrink: s.shrink === 'ask' ? 'off' : s.shrink,
    photoLevel: s.smallestPhotos,
    videoLevel: s.smallestVideos,
    compression: s.brotli ? 'brotli' : 'deflate',
    plainNames: s.plainNames,
    framing: 'slynk',
  }
  assert.deepEqual({ ...DEFAULTS }, slynk, 'Slynk’s defaults changed: change the example’s to match (prepare.ts DEFAULTS, its README and demo page)')

  const page = read(EXAMPLE + 'index.html')
  const options = (id: string) => {
    const select = page.match(new RegExp(`<select id="${id}">([\\s\\S]*?)</select>`))
    assert.ok(select, id)
    return [...select[1].matchAll(/<option value="([^"]+)"( selected)?>([^<]+)<\/option>/g)].map(([, value, chosen, words]) => ({ value, chosen: !!chosen, words }))
  }
  const chosen = (id: string) => options(id).find((o) => o.chosen)?.value
  const checked = (id: string) => new RegExp(`<input type="checkbox" id="${id}" checked`).test(page)
  assert.match(page, new RegExp(`name="budget" value="${DEFAULTS.budget}" checked /> ${DEFAULTS.budget.toLocaleString('en-GB')} bytes`))
  assert.equal(checked('clean'), DEFAULTS.clean)
  assert.match(page, new RegExp(`name="shrink" value="${DEFAULTS.shrink}" checked`))
  assert.equal(chosen('photo-level'), DEFAULTS.photoLevel)
  assert.equal(chosen('video-level'), String(DEFAULTS.videoLevel))
  assert.equal(chosen('compression'), DEFAULTS.compression)
  assert.equal(chosen('framing'), DEFAULTS.framing)
  assert.equal(checked('plain-names'), DEFAULTS.plainNames)

  // The levels Slynk offers, described with its own numbers.
  const px = (n: number) => `${n.toLocaleString('en-GB')} px`
  const pc = (q: number) => `${Math.round(q * 100)}%`
  const photo = { least: [px(FLOOR_EDGE), pc(Q_LOWEST)], medium: [px(FLOOR_EDGE), pc(Q_FLOOR)], good: [`up to ${px(MAX_EDGE)}`, pc(Q_MAX)] }
  assert.deepEqual(Object.keys(photo), [...PHOTO_LEVELS])
  assert.deepEqual(
    options('photo-level').map((o) => [o.value, o.words]),
    PHOTO_LEVELS.map((l) => [l, `${l[0].toUpperCase()}${l.slice(1)} (${photo[l].join(', ')})`]),
  )
  assert.deepEqual(
    options('video-level').map((o) => [o.value, o.words]),
    VIDEO_LEVELS.map((l) => [String(l), `${l}p`]),
  )
  const readme = read(EXAMPLE + 'README.md')
  assert.ok(readme.includes(`\`${DEFAULTS.budget.toLocaleString('en-GB').replaceAll(',', '_')}\``), 'the README’s budget')
  for (const l of PHOTO_LEVELS) assert.ok(readme.includes(`\`'${l}'\` (${photo[l].join(' at ')})`), `the README’s ${l}`)
  const lines = VIDEO_LEVELS.map((l) => `\`${l}\``)
  assert.ok(readme.includes(`${lines.slice(0, -1).join(', ')} or ${lines.at(-1)} (lines)`), 'the README’s video levels')
})

test('it runs Slynk’s own engine, the composer’s, with nothing of its own to plan or make', () => {
  // One file list for both: the composer draws it (tray.ts), the example reads it (prepare.ts).
  assert.match(prepare, /import \{[^}]*\bcreateFileList\b[^}]*\} from '\.\.\/\.\.\/src\/prep\/list\.ts'/)
  assert.match(prepare, /import \{ MAKERS \} from '\.\.\/\.\.\/src\/prep\/makers\.ts'/)
  assert.match(tray, /import \{[^}]*\bcreateFileList\b[^}]*\} from '\.\/prep\/list\.ts'/)
  assert.match(tray, /import \{ MAKERS \} from '\.\/prep\/makers\.ts'/)
  // Nothing of the plan, or of what reads, cleans, compresses and makes files smaller, is called from the example itself.
  for (const name of ['allocate', 'giveRoom', 'smallestShare', 'planCopies', 'shares', 'measure', 'makeCopy', 'measureDoc', 'makeDoc', 'shrinkInWorker', 'audioInWorker', 'cleanFile', 'store', 'squeeze', 'brotli', 'readZipIndex', 'rebuildZip', 'videoInfo', 'audioInfo'])
    assert.doesNotMatch(prepare, new RegExp(`\\b${name}\\(`), `prepare.ts calls ${name}: that's the file list's to do`)
  // The limits the composer's host gives it (main.ts): what a link may carry, and the room planned for.
  assert.match(read('../src/main.ts'), /limit: \(\) => payloadLimit\(\),\n[^\n]*\n[^\n]*\n\s+planLimit: \(\) => limitFor\(true, true\),/)
  // The example's are the same: the seal a link has on a site with the one-time rule, and room for a password.
  assert.match(prepare, /const limit = slynk \? o\.budget - \(ONE_TIME_ONLY \? SEAL_OVERHEAD : 0\) : o\.budget/)
  assert.match(prepare, /const planLimit = slynk \? o\.budget - SEAL_OVERHEAD - PASSWORD_OVERHEAD : o\.budget/)
})

test('it’s never part of the site’s build', () => {
  // Every visit to the site fetches the same files (web/src/preload.ts): the example's code, which
  // starts workers of its own, would be one more page to fetch, and isn't the site's.
  assert.doesNotMatch(read('../vite.config.ts'), /examples\//)
})

// --- What it does ---------------------------------------------------------------------------

test('cleans, compresses and counts as Slynk sends them; deflate when the Brotli helper is missing', async () => {
  const files = [
    file(photoWithGps(), 'IMG_0001.JPG', 'image/jpeg'),
    file(pngWithAuthor(), 'drawing.png', 'image/png'),
    file(docx(), 'letter.docx'),
    file(privateRtf(), 'notes.rtf'),
    file(note, 'note.txt', 'text/plain'),
    file(wav(3), 'voice.wav', 'audio/wav'),
    file(await textPdf(60, () => 'Example line of a report. '.repeat(3)), 'report.pdf', 'application/pdf'),
  ]
  const stages: string[] = []
  const p = await prepareFiles(files, { budget: 250_000, onProgress: (x) => stages.push(`${x.index}:${x.stage}`) })
  const [jpg, png, word, rtf, txt, sound, report] = p.files
  assert.equal(jpg.cleaning, 'cleaned')
  assert.ok(jpg.removed.some((d) => /location/i.test(d.label)), 'the photo’s location is listed')
  assert.ok(jpg.problems.includes(shrinkCopy.BLOCKED), 'no canvas here: Slynk’s words for a blocked one')
  assert.equal(jpg.data, jpg.compressed.body, 'a JPEG isn’t compressed again')
  assert.equal(png.cleaning, 'cleaned')
  assert.equal(word.cleaning, 'cleaned')
  assert.equal(word.compressed.method, 'as-is', 'a docx is a zip: not compressed again')
  assert.equal(rtf.cleaning, 'cleaned')
  assert.equal(txt.cleaning, 'unsupported')
  assert.equal(txt.compressed.method, 'deflate')
  assert.deepEqual(new Uint8Array(inflateRawSync(txt.compressed.body)), note, 'raw deflate, as the envelope uses')
  assert.ok(!sound.problems.some((x) => x === shrinkCopy.AUDIO_PROBLEM.browser), 'a recording that fits as it is isn’t told it can’t be made smaller')
  assert.equal(report.cleaning, 'cleaned')
  assert.ok(report.removed.some((d) => d.values.includes('Example Author')))
  // Slynk's envelope: each file's item, and the envelope's own few bytes.
  const items = p.files.reduce((n, f) => n + f.size, 0)
  assert.ok(p.total > items && p.total - items < 64, `${p.total} for items of ${items}`)
  for (const f of p.files) assert.ok(f.size > f.compressed.body.length, `${f.name}: its name, type and size are counted`)
  assert.equal(p.limit, ONE_TIME_ONLY ? 250_000 - SEAL_OVERHEAD : 250_000)
  assert.equal(p.fits, p.total <= p.limit)
  assert.ok(stages.includes('1:cleaning') && stages.includes('7:compressing'))
  assert.ok(StandInWorker.started.includes('squeezeWorker.ts'), 'Brotli was tried')
})

test('with framing none: the files’ compressed bytes alone, against the whole budget', async () => {
  const p = await prepareFiles([file(note, 'a.txt'), file(docx(), 'b.docx')], { framing: 'none', budget: 100_000 })
  assert.equal(p.limit, 100_000)
  assert.equal(p.total, p.files.reduce((n, f) => n + f.compressed.body.length, 0))
  for (const f of p.files) assert.equal(f.size, f.compressed.body.length)
})

test('Brotli where a squeezer is there, kept only when smaller', async () => {
  useSqueezer({
    brotli: async (data: Uint8Array, quality: number) => new Uint8Array(brotliCompressSync(data, { params: { [constants.BROTLI_PARAM_QUALITY]: quality } })),
    unbrotli: async () => new Uint8Array(),
  })
  try {
    const [f] = (await prepareFiles([file(note, 'note.txt')])).files
    assert.equal(f.compressed.method, 'brotli')
    assert.deepEqual(new Uint8Array(brotliDecompressSync(f.compressed.body)), note)
    const [docxFile] = (await prepareFiles([file(docx(), 'letter.docx')])).files
    assert.equal(docxFile.compressed.method, 'as-is', 'a zip isn’t tried')
  } finally {
    useSqueezer(null)
  }
})

test('stops with an AbortError', async () => {
  const stop = new AbortController()
  stop.abort()
  await assert.rejects(prepareFiles([file(note, 'note.txt')], { budget: 1000, signal: stop.signal }), { name: 'AbortError' })
})

test('with no options: Slynk’s defaults, and its limit for a one-time link', async () => {
  const p = await prepareFiles([file(docx(), 'letter.docx')])
  assert.equal(p.budget, MAX_PAYLOAD)
  assert.equal(p.limit, ONE_TIME_ONLY ? MAX_PAYLOAD_SEALED : MAX_PAYLOAD)
  assert.equal(p.files[0].cleaning, 'cleaned')
  assert.ok(p.fits)
  const given = await prepareFiles([file(docx(), 'letter.docx')], { budget: undefined, clean: undefined })
  assert.equal(given.budget, MAX_PAYLOAD, 'an option given as undefined is its default')
  assert.equal(given.files[0].cleaning, 'cleaned')
})

test('options: no cleaning, one file uncleaned, plain names, compression', async () => {
  const off = await prepareFiles([file(docx(), 'a.docx'), file(note, 'b.txt')], { clean: false, compression: 'none' })
  assert.deepEqual(
    off.files.map((f) => f.cleaning),
    ['off', 'off'],
  )
  assert.deepEqual(off.files[0].data, docx())
  assert.equal(off.files[1].compressed.method, 'as-is')
  const one = await prepareFiles([file(docx(), 'a.docx'), file(privateRtf(), 'b.rtf')], { perFile: (_f, i) => (i === 0 ? { clean: false } : undefined), compression: 'deflate' })
  assert.deepEqual(
    one.files.map((f) => f.cleaning),
    ['off', 'cleaned'],
  )
  assert.deepEqual(one.files[0].data, docx(), '“Send original instead”: as it was')
  assert.equal(one.files[1].compressed.method, 'deflate')
  const plain = await prepareFiles([file(photoWithGps(), 'IMG_20240612_183045.jpg'), file(note, 'notes.txt')], { plainNames: true, shrink: 'off' })
  assert.equal(plain.files[0].name, 'photo.jpg')
  assert.equal(plain.files[1].name, 'notes.txt')
  assert.deepEqual(plain.files[0].problems, [], 'shrink off: no photo is measured')
})

test('fit: nothing made smaller when they fit; planned when they don’t', async () => {
  const fits = await prepareFiles([file(photoWithGps(), 'a.jpg')], { shrink: 'fit' })
  assert.deepEqual(fits.files[0].problems, [])
  const over = await prepareFiles([file(photoWithGps(), 'a.jpg'), file(photoWithGps(), 'b.jpg')], { shrink: 'fit', budget: 300, compression: 'none' })
  assert.ok(over.files[0].problems.includes(shrinkCopy.BLOCKED), 'planned, so the canvas was checked')
  assert.equal(over.fits, false)
  // A file that can't be made smaller, too big alone beside others: the composer names it and plans nothing.
  const stuck = await prepareFiles([file(photoWithGps(), 'a.jpg'), file(note, 'b.txt')], { shrink: 'fit', budget: 200, compression: 'none' })
  assert.deepEqual(stuck.files[0].problems, [])
  assert.deepEqual(stuck.files[1].problems.slice(0, 1), [shrinkCopy.TOO_LARGE_ALONE('b.txt', 1)])
  assert.equal(stuck.says, shrinkCopy.TOO_LARGE_ALONE('b.txt', 1), 'and the box says so')
  assert.equal(over.says, shrinkCopy.BLOCKED)
  const own = await prepareFiles([file(photoWithGps(), 'a.jpg')], { shrink: 'fit', budget: 100, perFile: () => ({ shrink: false }) })
  assert.deepEqual(own.files[0].problems, [], 'full size by its own choice: not measured')
  assert.equal(own.fits, false)
  assert.equal(fits.says, undefined)
})

test('a PDF over 200 KB is measured in the document worker, and what it says is in Slynk’s words', async () => {
  const pdf = await textPdf(160, () => Math.random().toString(36).repeat(4))
  assert.ok(pdf.length > 200_000, `${pdf.length} bytes`)
  const stages: string[] = []
  const [f] = (await prepareFiles([file(pdf, 'big.pdf')], { onProgress: (x) => stages.push(x.stage) })).files
  assert.equal(f.cleaning, 'cleaned')
  assert.ok(f.removed.some((d) => d.values.includes('Example Title')))
  assert.ok(stages.includes('measuring'))
  assert.equal(f.smaller, undefined, 'nothing in it to make smaller')
  // A browser says it has no pictures to make smaller; Node has no canvas, so the worker says that's blocked.
  assert.equal(f.problems.length, 1)
  assert.ok([shrinkCopy.DOC_PROBLEM('none', true), shrinkCopy.DOC_PROBLEM('blocked', true)].includes(f.problems[0]), f.problems[0])
})

test('a file that can’t be cleaned waits for an answer, as Slynk asks, and goes when told', async () => {
  const waits = await prepareFiles([file(fakeVideo(), 'clip.mp4', 'video/mp4'), file(note, 'note.txt')])
  assert.equal(waits.waiting, true)
  assert.equal(waits.fits, false)
  const [clip, text] = waits.files
  assert.equal(clip.data, null)
  assert.equal(clip.size, 0)
  assert.match(clip.problems.join(' '), /Slynk asks before sending it/)
  assert.ok(text.data, 'the rest are ready')
  const told = await prepareFiles([file(fakeVideo(), 'clip.mp4', 'video/mp4')], { perFile: () => ({ sendAsIs: true }) })
  assert.equal(told.waiting, false)
  assert.deepEqual(told.files[0].data, fakeVideo())
  assert.match(told.files[0].problems.join(' '), /Couldn’t be cleaned .*: this is the original/)
})

test('the composer’s read limits: 25 MB for most files, 60 MB for documents, a long WAV never read whole', async () => {
  const big = randomBytes(26_000_000)
  const [blob] = (await prepareFiles([file(big, 'data.bin')])).files
  assert.equal(blob.data, null)
  assert.deepEqual(blob.problems, ['Too big to read here.'])
  const [doc] = (await prepareFiles([file(big, 'scan.pdf', 'application/pdf')], { clean: false })).files
  assert.ok(doc.data, 'a document is read up to 60 MB')
  // A 27 MB recording: only its header is read, and only a smaller version could go.
  const p = await prepareFiles([file(wav(1700, 8000), 'long.wav', 'audio/wav')])
  const [rec] = p.files
  assert.ok(rec.originalSize > 25_000_000)
  assert.equal(rec.data, null)
  assert.ok(rec.problems.includes('Too big to go as it is, and not made smaller.'))
  assert.ok(rec.problems.includes(shrinkCopy.AUDIO_PROBLEM.browser), 'no WebCodecs here')
  assert.equal(p.fits, false)
})

test('a small file past the 100 MB read in all can’t go, and nothing fits, as Slynk’s Send waits (2026-10-31)', async () => {
  // The composer left Send on: the meter counted only the small file's own size.
  const zeros = new Uint8Array(25_000_000)
  const p = await prepareFiles([file(zeros, 'a.bin'), file(zeros, 'b.bin'), file(zeros, 'c.bin'), file(zeros.subarray(1000), 'd.bin'), file(note.subarray(0, 2000), 'note.txt')])
  const last = p.files.at(-1)!
  assert.equal(last.data, null)
  assert.deepEqual(last.problems, ['Too big to read here.'])
  assert.ok(p.total < p.limit, `under the limit: ${p.total}`)
  assert.equal(p.fits, false)
})

test('as the composer: a file too big to read stops anything being made smaller, and so does a zip too big beside others with “To fit”', async () => {
  const big = randomBytes(26_000_000)
  const p = await prepareFiles([file(photoWithGps(), 'a.jpg'), file(big, 'data.bin')])
  assert.deepEqual(p.files[0].problems, [], 'not planned: the canvas was never checked')
  assert.equal(p.fits, false)
  // A zip at full size too big to go alone, beside another file: "To fit" names it and makes nothing smaller,
  // whether a file in it is too big alone or what in it can't be made smaller is, together.
  const zip = zipSync({ 'big.bin': [randomBytes(2_100_000), { level: 0 }], 'IMG_0001.jpg': [photoWithGps(), { level: 0 }] })
  const fit = await prepareFiles([file(zip, 'trip.zip', 'application/zip'), file(photoWithGps(), 'b.jpg')], { shrink: 'fit' })
  assert.ok(fit.files[0].problems.some((x) => /too large to send/.test(x)), fit.files[0].problems.join(' / '))
  assert.deepEqual(fit.files[1].problems, [], 'nothing planned')
  const both = zipSync({ 'a.bin': [randomBytes(1_200_000), { level: 0 }], 'b.bin': [randomBytes(1_200_000), { level: 0 }], 'IMG_0001.jpg': [photoWithGps(), { level: 0 }] })
  const rest = await prepareFiles([file(both, 'trip.zip', 'application/zip'), file(photoWithGps(), 'b.jpg')], { shrink: 'fit' })
  assert.equal(rest.says, shrinkCopy.TOO_LARGE_ALONE('trip.zip', 1))
  assert.deepEqual(rest.files[1].problems, [], 'nothing planned')
})

test('with “To fit”, a zip too big beside others whose photos could make room is planned, as the composer does (2026-10-31)', async () => {
  // It was named as too large to send even on its own, and nothing was made smaller.
  const zip = zipSync({ 'IMG_0001.jpg': [photoWithGps(), { level: 0 }], 'notes.txt': strToU8('Plain notes.') })
  const p = await prepareFiles([file(zip, 'trip.zip', 'application/zip'), file(strToU8('hi'), 'b.txt')], { shrink: 'fit', budget: 400, compression: 'none' })
  const photo = p.files[0].inside!.find((f) => f.name === 'IMG_0001.jpg')!
  assert.ok(p.files[0].size + photo.size > p.limit && p.files[0].size < p.limit, `the zip ${p.files[0].size} + its photo ${photo.size}, of ${p.limit}`)
  assert.equal(p.says, shrinkCopy.BLOCKED, 'planned: the canvas was checked (Node has none)')
  assert.deepEqual(photo.problems, [shrinkCopy.BLOCKED])
  assert.ok(!p.files[0].problems.some((x) => /too large to send/.test(x)), p.files[0].problems.join(' / '))
})

test('a file added twice goes once, and one that can’t be read is left out, as the composer does', async () => {
  const twice = file(note, 'note.txt')
  class Unreadable extends File {
    override arrayBuffer(): Promise<ArrayBuffer> {
      return Promise.reject(new DOMException('The file changed', 'NotReadableError'))
    }
  }
  const p = await prepareFiles([twice, twice, new Unreadable([note as BlobPart], 'gone.txt'), file(docx(), 'letter.docx')])
  const [first, again, gone, letter] = p.files
  assert.ok(first.data)
  assert.deepEqual([again.data, again.size, again.problems], [null, 0, ['note.txt is already on the list']])
  assert.deepEqual([gone.data, gone.problems], [null, ['Couldn’t read gone.txt']])
  assert.equal(letter.cleaning, 'cleaned')
  assert.ok(p.fits, 'the rest go')
  assert.equal((await prepareFiles([])).fits, false, 'nothing to send')
})

test('a zip whose file can’t be cleaned waits, says so on the zip, and goes when the zip is answered for', async () => {
  const zip = zipSync({ 'a/clip.mp4': [fakeVideo(), { level: 0 }], 'a/IMG.jpg': [photoWithGps(), { level: 0 }] })
  const waits = await prepareFiles([file(zip, 'a.zip', 'application/zip')], { shrink: 'off' })
  assert.equal(waits.waiting, true)
  assert.deepEqual(waits.files[0].problems, ['A file in it couldn’t be cleaned: it waits for an answer (perFile sendAsIs, given for the zip).'])
  const told = await prepareFiles([file(zip, 'a.zip', 'application/zip')], { shrink: 'off', perFile: () => ({ sendAsIs: true }) })
  assert.equal(told.waiting, false)
  assert.ok(told.fits)
  assert.ok(told.files[0].data)
})

test('a stop while the files are still being added stops it too (the review, 2026-11-01)', async () => {
  // Adding reports each file at once, so onProgress can stop it before anything is read.
  const stop = new AbortController()
  const run = prepareFiles([file(note, 'a.txt'), file(docx(), 'b.docx')], { signal: stop.signal, onProgress: () => stop.abort() })
  await assert.rejects(run, { name: 'AbortError' })
  // An onProgress that throws ends it with that error.
  await assert.rejects(prepareFiles([file(note, 'a.txt')], { onProgress: () => { throw new Error('the app’s own') } }), /the app’s own/)
})

test('stops part-way with an AbortError, and says nothing after', async () => {
  const pdf = await textPdf(160, () => Math.random().toString(36).repeat(4))
  const stop = new AbortController()
  let after = 0
  const run = prepareFiles([file(pdf, 'big.pdf'), file(note, 'note.txt')], {
    signal: stop.signal,
    onProgress: (x) => {
      if (stop.signal.aborted) after++
      else if (x.stage === 'measuring') stop.abort()
    },
  })
  await assert.rejects(run, { name: 'AbortError' })
  assert.equal(after, 0)
})

test('a zip’s photos and documents are prepared as files of their own and written back into it', async () => {
  const original = zipSync({ 'trip/IMG_0001.jpg': [photoWithGps(), { level: 0 }], 'trip/letter.docx': [docx(), { level: 0 }], 'trip/notes.txt': strToU8('Plain notes. '.repeat(500)) })
  const [z] = (await prepareFiles([file(original, 'trip.zip', 'application/zip')], { shrink: 'off' })).files
  assert.deepEqual(
    z.inside?.map((m) => [m.name, m.cleaning]),
    [
      ['trip/IMG_0001.jpg', 'cleaned'],
      ['trip/letter.docx', 'cleaned'],
    ],
  )
  const out = unzipSync(z.data!)
  assert.deepEqual(Object.keys(out).sort(), ['trip/IMG_0001.jpg', 'trip/letter.docx', 'trip/notes.txt'])
  assert.ok(!contains(out['trip/IMG_0001.jpg'], 'ExampleCam'), 'the photo in it went cleaned')
  assert.ok(contains(original, 'ExampleCam'))
  // Nothing in it changed (no cleaning): it goes exactly as it was.
  const [same] = (await prepareFiles([file(original, 'trip.zip', 'application/zip')], { shrink: 'off', clean: false })).files
  assert.deepEqual(same.data, original)
})
