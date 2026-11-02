// Which commit the site is built from, and when it was committed: the footer
// shows them (vite.config.ts) and the fingerprint list names them
// (scripts/fingerprints.ts). Taken from the commit rather than the clock, so the
// same commit always builds to the same bytes and anyone can rebuild it and
// match the published list.
//
// Read from git. Built from a copy without git's history (git archive, a
// downloaded zip), set SLYNK_COMMIT to the commit's full ID and SOURCE_DATE_EPOCH
// to its time in seconds (git log -1 --format=%ct), the usual name for it.
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export interface Commit {
  /** The full commit ID, 40 hex digits. */
  id: string
  /** When it was committed, e.g. "2026-10-24 16:05 UTC". */
  time: string
  /** Files git tracks differ from the commit (local work, never a CI build). */
  changed: boolean
}

/** A time in seconds since 1970 as the footer writes it, always in UTC. */
export const utcMinute = (seconds: number) => new Date(seconds * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'

/** The commit the files in this folder come from. */
export function builtFrom(env: NodeJS.ProcessEnv = process.env): Commit {
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: fileURLToPath(new URL('.', import.meta.url)), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  let id = env.SLYNK_COMMIT ?? ''
  let seconds = env.SOURCE_DATE_EPOCH ?? ''
  let changed = false
  if (!id || !seconds) {
    try {
      id ||= git('rev-parse', 'HEAD')
      seconds ||= git('log', '-1', '--format=%ct', 'HEAD')
      // Untracked files don't count: nothing reaches the build unless git tracks it or the build makes it.
      changed = git('status', '--porcelain', '--untracked-files=no') !== ''
    } catch {
      throw new Error('scripts/commit.ts: not a git checkout. Set SLYNK_COMMIT and SOURCE_DATE_EPOCH to the commit’s ID and time.')
    }
  }
  if (!/^[0-9a-f]{40}$/.test(id)) throw new Error(`scripts/commit.ts: SLYNK_COMMIT isn’t a full commit ID: ${id}`)
  if (!/^\d+$/.test(seconds)) throw new Error(`scripts/commit.ts: SOURCE_DATE_EPOCH isn’t a time in seconds: ${seconds}`)
  return { id, time: utcMinute(+seconds), changed }
}

/** What the footer says after "Build": the commit's short ID and its time. */
export const footerText = (c: Commit) => `${c.id.slice(0, 7)}${c.changed ? ' + changes' : ''} · ${c.time}`
