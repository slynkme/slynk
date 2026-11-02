// The page-side API (index.ts): its queue, watchdog and failure handling.
// Node has no Web Worker, so a stand-in runs the engine in-process.
import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { stripBytes } from '../../src/strip/engine.ts'
import { exifApp1, grayJpeg, phoneExif, utf8 } from './fixtures.ts'

type Mode = 'ok' | 'hang' | 'crash'
let mode: Mode = 'ok'
const made: FakeWorker[] = []

class FakeWorker {
  onmessage: ((e: { data: unknown }) => void) | null = null
  onerror: ((e: { message: string; preventDefault(): void }) => void) | null = null
  onmessageerror: (() => void) | null = null
  terminated = false
  readonly mode = mode
  readonly url: URL
  readonly options: { type?: string }

  constructor(url: URL, options: { type?: string }) {
    this.url = url
    this.options = options
    made.push(this)
  }

  postMessage(msg: { id: number; bytes: Uint8Array; opts: object }) {
    if (this.mode === 'hang') return
    if (this.mode === 'crash') {
      setImmediate(() => this.onerror?.({ message: 'boom', preventDefault() {} }))
      return
    }
    void stripBytes(msg.bytes, msg.opts).then((result) => {
      if (!this.terminated) this.onmessage?.({ data: { id: msg.id, result } })
    })
  }

  terminate() {
    this.terminated = true
  }
}

;(globalThis as unknown as { Worker: unknown }).Worker = FakeWorker
const { stripFile } = await import('../../src/strip/index.ts')

const photo = () => grayJpeg(exifApp1(phoneExif(6)))

/** Makes the page drop its current worker (as after an error), so the next file starts one in `next` mode. */
function replaceWorker(next: Mode) {
  mode = next
  made[made.length - 1]?.onerror?.({ message: 'restart', preventDefault() {} })
}

test('API: unrecognised files are answered without starting the worker', async () => {
  assert.deepEqual(await stripFile(utf8('just a note')), { status: 'unsupported', kind: 'text' })
  assert.deepEqual(await stripFile(new Uint8Array(0)), { status: 'unsupported', kind: null })
  assert.equal(made.length, 0)
})

test('API: one module worker, started on first use and reused; files go one at a time, in order', async () => {
  const inputs = [photo(), grayJpeg(), photo()]
  const results = await Promise.all(inputs.map((b) => stripFile(b.slice())))
  assert.equal(made.length, 1)
  assert.equal(made[0].options.type, 'module')
  assert.match(made[0].url.pathname, /\/strip\/stripWorker\.ts$/)
  assert.deepEqual(results.map((r) => r.status), ['cleaned', 'unchanged', 'cleaned'])
  for (const [i, b] of inputs.entries()) assert.deepEqual(results[i], await stripBytes(b))
})

test('API: a stuck file times out as "failed", and the worker is replaced', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    replaceWorker('hang')
    const pending = stripFile(photo())
    const hung = made[made.length - 1]
    assert.equal(hung.mode, 'hang')
    let settled = false
    void pending.then(() => (settled = true))
    mock.timers.tick(29_000)
    await new Promise((r) => setImmediate(r))
    assert.equal(settled, false)
    mock.timers.tick(2_000)
    const r = await pending
    assert.equal(r.status, 'failed')
    assert.ok(hung.terminated)
  } finally {
    mock.timers.reset()
  }
  mode = 'ok'
  assert.equal((await stripFile(photo())).status, 'cleaned')
  assert.equal(made[made.length - 1].mode, 'ok')
})

test('API: a crashing worker answers "failed" for its file, and later files still work', async () => {
  replaceWorker('crash')
  const [a, b] = await Promise.all([stripFile(photo()), stripFile(photo())])
  assert.equal(a.status, 'failed')
  assert.equal(b.status, 'failed') // each file gets its own (crashing) worker
  assert.ok(made.filter((w) => w.mode === 'crash').every((w) => w.terminated))
  mode = 'ok'
  assert.equal((await stripFile(photo())).status, 'cleaned')
})
