// Builds the key server (core/cmd/keyserver) once, and runs it with -dev
// (plain HTTP, no hardening) on a free port, keeping its shutdown file in a
// throwaway folder. Needs the Go toolchain. Nothing outside the temporary
// folders is touched.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CORE = fileURLToPath(new URL('../../../core/', import.meta.url))
const PROTOCOL = readFileSync(new URL('../../../core/keyserver/protocol.go', import.meta.url), 'utf8')
const SERVER = readFileSync(new URL('../../../core/keyserver/server.go', import.meta.url), 'utf8')

/**
 * The puzzle's difficulty the test server asks for unless a test says
 * otherwise: low, so the many puts are quick, but never 0, so every put's
 * solution is checked.
 */
export const TEST_POW_BITS = 8

/** A numeric constant from core/keyserver/protocol.go, so tests follow the real values. */
export function goConst(name: string): number {
  const m = new RegExp(`^\\s*${name}\\s*=\\s*(\\d+)`, 'm').exec(PROTOCOL)
  if (!m) throw new Error(`no constant ${name} in protocol.go`)
  return Number(m[1])
}

/** One of slynk.me's settings, from DefaultConfig in core/keyserver/server.go. */
export function goDefault(name: string): number {
  const m = new RegExp(`^\\s*${name}:\\s*(\\d+)`, 'm').exec(SERVER)
  if (!m) throw new Error(`no default ${name} in server.go`)
  return Number(m[1])
}
let binary: string | undefined

export function hasGo(): boolean {
  return spawnSync('go', ['version'], { stdio: 'ignore' }).status === 0
}

function build(): string {
  if (binary) return binary
  const dir = mkdtempSync(join(tmpdir(), 'slynk-keyserver-bin-'))
  const out = join(dir, 'keyserver')
  const r = spawnSync('go', ['-C', CORE, 'build', '-trimpath', '-o', out, './cmd/keyserver'], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`go build failed: ${r.stderr}`)
  process.once('exit', () => rmSync(dir, { recursive: true, force: true }))
  binary = out
  return out
}

export interface KeyServer {
  origin: string
  endpoint: string
  /** Its state folder, where the shutdown file goes. */
  state: string
  stop(): Promise<void>
  /** Stops it cleanly (it saves its shares) and starts it again. */
  restart(): Promise<void>
  /** Kills it at once (SIGKILL: its shares are lost) and starts it again. */
  crash(): Promise<void>
}

export interface KeyServerOptions {
  /** slynk.me's rule, on unless this is false. */
  oneTimeOnly?: boolean
  /** The puzzle's difficulty; TEST_POW_BITS by default. */
  powBits?: number
  /** Sent as Access-Control-Allow-Origin; none by default. */
  allowOrigin?: string
}

export async function startKeyServer(opts: KeyServerOptions = {}): Promise<KeyServer> {
  const bin = build()
  const state = mkdtempSync(join(tmpdir(), 'slynk-keyserver-state-'))
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  const endpoint = `${origin}/`
  const args = [
    '-dev', `127.0.0.1:${port}`,
    '-state-dir', state,
    '-status', '',
    '-pow-bits', String(opts.powBits ?? TEST_POW_BITS),
    `-one-time-only=${opts.oneTimeOnly !== false}`,
    '-allow-origin', opts.allowOrigin ?? '',
  ]
  // As at install: an empty shutdown file, so the first start counts as clean.
  const init = spawnSync(bin, ['-init', '-state-dir', state], { encoding: 'utf8' })
  if (init.status !== 0) throw new Error(`keyserver -init failed: ${init.stderr}`)
  let child: ChildProcess
  const run = async () => {
    child = spawn(bin, args, { env: { PATH: process.env.PATH ?? '', TZ: 'UTC' }, stdio: 'ignore' })
    const deadline = Date.now() + 10_000
    for (;;) {
      try {
        await fetch(endpoint, { method: 'GET' })
        return
      } catch {
        if (Date.now() > deadline || child.exitCode !== null) throw new Error('the key server did not start')
        await new Promise((r) => setTimeout(r, 30))
      }
    }
  }
  const end = async (signal: NodeJS.Signals) => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((r) => child.once('exit', r))
      child.kill(signal)
      await exited
    }
  }
  await run()
  return {
    origin,
    endpoint,
    state,
    stop: async () => {
      await end('SIGTERM')
      rmSync(state, { recursive: true, force: true })
    },
    restart: async () => {
      await end('SIGTERM')
      await run()
    },
    crash: async () => {
      await end('SIGKILL')
      await run()
    },
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address()
      s.close(() => (typeof addr === 'object' && addr ? resolve(addr.port) : reject(new Error('no port'))))
    })
  })
}
