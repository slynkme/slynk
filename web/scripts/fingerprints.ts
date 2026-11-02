// Writes dist/SHA256SUMS.txt: the SHA-256 of every file the site deploys,
// after `vite build` and precompress.mjs (npm run build:deploy, as CI runs it).
// CI publishes it with the files in the deploy branch, so anyone can check the
// live site against it (deploy/check-site.sh) or rebuild the commit it names and
// match it. In sha256sum's own format, so `sha256sum -c
// SHA256SUMS.txt` checks a copy of the files too (it skips the # lines).
//   node scripts/fingerprints.ts [DIST]
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { builtFrom, type Commit } from './commit.ts'

export const LIST = 'SHA256SUMS.txt'

/** Every file under dir but the list itself, as sorted '/' paths: the same order on every system. */
export function filesOf(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)).split(sep).join('/'))
    .filter((f) => f !== LIST)
    .sort()
}

/** The list's text for the files in dir, built from commit. */
export function fingerprints(dir: string, commit: Commit): string {
  if (commit.changed) throw new Error(`${LIST}: the files git tracks differ from the commit, so this build isn’t that commit’s`)
  const lines = filesOf(dir).map((f) => `${createHash('sha256').update(readFileSync(join(dir, f))).digest('hex')}  ${f}`)
  return (
    `# The SHA-256 of every file of this website, built from commit\n` +
    `# ${commit.id} (${commit.time}).\n` +
    `# The same commit always builds to these bytes: npm run build:deploy in web/.\n` +
    lines.join('\n') +
    '\n'
  )
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] ?? fileURLToPath(new URL('../dist/', import.meta.url))
  const text = fingerprints(dir, builtFrom())
  writeFileSync(join(dir, LIST), text)
  console.log(`${LIST}: ${text.split('\n').filter((l) => /^[0-9a-f]{64} /.test(l)).length} files`)
}
