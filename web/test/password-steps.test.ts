// The password module's worker handling (kdf/index.ts) and the recipient's
// password step (passwordStep.ts), with stand-ins for the worker and Argon2id.
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { describe, test } from 'node:test'
import { KdfError, makeKdf, type KdfRequest, type KdfResponse, type KdfWorker } from '../src/kdf/index.ts'
import { KDF_V1, lock, passwordKey, type Derive } from '../src/password.ts'
import { checkPassword, type Held } from '../src/passwordStep.ts'

class FakeWorker implements KdfWorker {
  private message: Array<(e: MessageEvent<KdfResponse>) => void> = []
  private error: Array<(e: Event) => void> = []
  posted: Array<{ message: KdfRequest; transfer: Transferable[] }> = []
  terminated = false

  addEventListener(type: 'message' | 'error', listener: (e: never) => void) {
    if (type === 'message') this.message.push(listener)
    else this.error.push(listener)
  }
  postMessage(message: KdfRequest, transfer: Transferable[]) {
    this.posted.push({ message, transfer })
  }
  terminate() {
    this.terminated = true
  }
  /** What a browser does when the worker's script can't load: one error event. */
  failToLoad(): Event {
    const e = new Event('error', { cancelable: true })
    for (const l of this.error) l(e)
    return e
  }
  reply(r: KdfResponse) {
    for (const l of this.message) l({ data: r } as MessageEvent<KdfResponse>)
  }
}

function setup(timeoutMs = 60_000) {
  const workers: FakeWorker[] = []
  const kdf = makeKdf(
    () => {
      const w = new FakeWorker()
      workers.push(w)
      return w
    },
    timeoutMs,
    0, // no pause before the second try
  )
  return { kdf, workers }
}

const tick = () => new Promise((r) => setTimeout(r, 5))

const pw = () => new TextEncoder().encode('spider ocean')
const salt = new Uint8Array(16)
const KEY = new Uint8Array(32).fill(9)

describe('password module worker', () => {
  test('uses the warmed worker, sends a copy of the password, and closes it afterwards', async () => {
    const { kdf, workers } = setup()
    kdf.warm()
    kdf.warm()
    assert.equal(workers.length, 1)
    const mine = pw()
    const p = kdf.argon2id(mine, salt, KDF_V1)
    assert.equal(workers.length, 1)
    const { message, transfer } = workers[0].posted[0]
    assert.deepEqual(message.password, pw())
    assert.notEqual(message.password, mine, 'a copy, moved to the worker')
    assert.deepEqual(transfer, [message.password.buffer])
    assert.deepEqual(mine, pw(), 'the caller’s array is left alone')
    assert.deepEqual({ time: message.time, memoryKiB: message.memoryKiB, threads: message.threads }, KDF_V1)
    workers[0].reply({ ok: true, key: KEY })
    assert.deepEqual(await p, KEY)
    assert.ok(workers[0].terminated)
  })

  test('a warmed worker that failed to load is replaced, not waited on', async () => {
    const { kdf, workers } = setup()
    kdf.warm()
    const e = workers[0].failToLoad()
    assert.ok(e.defaultPrevented)
    const p = kdf.argon2id(pw(), salt, KDF_V1)
    assert.equal(workers.length, 2)
    assert.ok(workers[0].terminated)
    assert.equal(workers[0].posted.length, 0)
    workers[1].reply({ ok: true, key: KEY })
    assert.deepEqual(await p, KEY)
  })

  test('warming again after a failed load starts a fresh worker', () => {
    const { kdf, workers } = setup()
    kdf.warm()
    workers[0].failToLoad()
    kdf.warm()
    assert.equal(workers.length, 2)
    assert.ok(workers[0].terminated)
  })

  test('a worker that fails in use gets one more try, on a fresh worker', async () => {
    const { kdf, workers } = setup()
    const p = kdf.argon2id(pw(), salt, KDF_V1)
    workers[0].failToLoad()
    assert.ok(workers[0].terminated)
    await tick()
    assert.equal(workers.length, 2)
    assert.deepEqual(workers[1].posted[0].message.password, pw(), 'the same password, sent again')
    workers[1].reply({ ok: true, key: KEY })
    assert.deepEqual(await p, KEY)
    assert.ok(workers[1].terminated)
  })

  test('a worker that never answers (paused while the visitor was in another app) gets one more try', async () => {
    const { kdf, workers } = setup(30)
    const p = kdf.argon2id(pw(), salt, KDF_V1)
    await new Promise((r) => setTimeout(r, 60))
    assert.equal(workers.length, 2)
    assert.ok(workers[0].terminated)
    workers[1].reply({ ok: true, key: KEY })
    assert.deepEqual(await p, KEY)
  })

  test('two failures in a row are a KdfError, with every worker closed', async () => {
    const { kdf, workers } = setup(30)
    const a = kdf.argon2id(pw(), salt, KDF_V1)
    workers[0].reply({ ok: false, message: 'kdf: memory out of range' })
    await tick()
    workers[1].reply({ ok: false, message: 'kdf: memory out of range' })
    await assert.rejects(a, /memory out of range/)
    const b = kdf.argon2id(pw(), salt, KDF_V1)
    await assert.rejects(b, /timed out/)
    assert.equal(workers.length, 4)
    assert.ok(workers.every((w) => w.terminated))
  })

  test('cool closes an unused warmed worker', () => {
    const { kdf, workers } = setup()
    kdf.warm()
    kdf.cool()
    assert.ok(workers[0].terminated)
    const p = kdf.argon2id(pw(), salt, KDF_V1)
    assert.equal(workers.length, 2, 'a fresh worker, not the closed one')
    workers[1].reply({ ok: true, key: KEY })
    return p
  })
})

// A fast stand-in for Argon2id.
const derive: Derive = async (p, s) => new Uint8Array(createHash('sha256').update(p).update(s).digest())

async function held(password: string, typed: string, inner = new Uint8Array(randomBytes(40))) {
  const sealed = await lock(inner, await passwordKey(password, undefined, derive))
  return { h: { sealed, pwText: typed } as Held, sealed, inner }
}

describe('recipient’s password step', () => {
  test('the right password opens the layer in place and wipes the outer copy', async () => {
    const { h, sealed, inner } = await held('spider ocean', 'Spider  Ocean ')
    assert.deepEqual(await checkPassword(h, derive), { ok: true })
    assert.deepEqual(h.sealed, inner)
    assert.ok(h.pwChecked)
    assert.equal(h.pwText, undefined)
    assert.ok(sealed.every((b) => b === 0), 'the downloaded copy is wiped')
  })

  test('a wrong password keeps the download, forgets what was typed, and asks again', async () => {
    const { h, sealed } = await held('spider ocean', 'spider oceans')
    const before = sealed.slice()
    assert.deepEqual(await checkPassword(h, derive), { ok: false, reason: 'wrong' })
    assert.equal(h.sealed, sealed)
    assert.deepEqual(h.sealed, before)
    assert.ok(!h.pwChecked)
    assert.equal(h.pwText, undefined)
  })

  test('a fault in the module keeps the download and the typed password for Try again', async () => {
    const { h, sealed } = await held('spider ocean', 'spider ocean')
    const broken: Derive = async () => {
      throw new KdfError('the password module didn’t load')
    }
    assert.deepEqual(await checkPassword(h, broken), { ok: false, reason: 'failed' })
    assert.equal(h.sealed, sealed)
    assert.equal(h.pwText, 'spider ocean')
    assert.deepEqual(await checkPassword(h, derive), { ok: true }, 'and Try again then works')
  })

  test('once checked, the password is never worked out or asked for again', async () => {
    const { h, inner } = await held('spider ocean', 'spider ocean')
    await checkPassword(h, derive)
    let calls = 0
    const counting: Derive = async (...a) => (calls++, derive(...a))
    assert.deepEqual(await checkPassword(h, counting), { ok: true })
    assert.equal(calls, 0)
    assert.deepEqual(h.sealed, inner)
  })

  test('damaged or newer data gives up; nothing downloaded is a mistake', async () => {
    assert.deepEqual(await checkPassword({ sealed: new Uint8Array(10), pwText: 'x' }, derive), { ok: false, reason: 'damaged' })
    const newer = new Uint8Array(60)
    newer[0] = 2
    assert.deepEqual(await checkPassword({ sealed: newer, pwText: 'x' }, derive), { ok: false, reason: 'newer' })
    await assert.rejects(checkPassword({ pwText: 'x' }, derive), TypeError)
  })
})
