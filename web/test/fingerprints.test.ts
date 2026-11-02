// Verifiable builds: the footer and the fingerprint list name
// the commit, its time comes from the commit rather than the clock, and the
// list is sha256sum's own format. Run: npm --prefix web test
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { builtFrom, footerText, utcMinute } from '../scripts/commit.ts'
import { LIST, filesOf, fingerprints } from '../scripts/fingerprints.ts'

const ID = '1a2b3c40c3d1f2a4b5c6d7e8f90123456789abcd'
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const hasSha256sum = (() => {
  try {
    return execFileSync('sha256sum', ['--version']) && true
  } catch {
    return false
  }
})()

test('the commit’s time, in UTC, whatever the clock says', () => {
  assert.equal(utcMinute(1792857600), '2026-10-24 16:00 UTC')
  const c = builtFrom({ SLYNK_COMMIT: ID, SOURCE_DATE_EPOCH: '1792857959' })
  assert.deepEqual(c, { id: ID, time: '2026-10-24 16:05 UTC', changed: false })
  assert.deepEqual(builtFrom({ SLYNK_COMMIT: ID, SOURCE_DATE_EPOCH: '1792857959' }), c)
  assert.equal(footerText(c), '1a2b3c4 · 2026-10-24 16:05 UTC')
  assert.equal(footerText({ ...c, changed: true }), '1a2b3c4 + changes · 2026-10-24 16:05 UTC')
})

test('read from git otherwise, and anything else stops the build', () => {
  const c = builtFrom({})
  assert.match(c.id, /^[0-9a-f]{40}$/)
  assert.match(c.time, /^\d{4}-\d\d-\d\d \d\d:\d\d UTC$/)
  assert.throws(() => builtFrom({ SLYNK_COMMIT: '1a2b3c4', SOURCE_DATE_EPOCH: '1792857959' }), /full commit ID/)
  assert.throws(() => builtFrom({ SLYNK_COMMIT: ID, SOURCE_DATE_EPOCH: '2026-10-24' }), /time in seconds/)
})

test('the footer has the place the build fills, and nothing else writes the build time there', () => {
  assert.equal(read('../index.html').split('<span id="build"></span>').length, 2)
  assert.doesNotMatch(read('../src/main.ts'), /\$\('build'\)/)
  assert.doesNotMatch(read('../vite.config.ts'), /new Date\(/)
})

test('the list: every file but itself, sorted, in sha256sum’s format, naming the commit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'slynk-fingerprints-'))
  try {
    mkdirSync(join(dir, 'assets'))
    mkdirSync(join(dir, 'about'))
    writeFileSync(join(dir, 'index.html'), 'page')
    writeFileSync(join(dir, '.htaccess'), 'rules')
    writeFileSync(join(dir, 'about', 'index.html'), 'about')
    writeFileSync(join(dir, 'assets', 'main-AbC.js'), 'code')
    writeFileSync(join(dir, LIST), 'an old list')
    assert.deepEqual(filesOf(dir), ['.htaccess', 'about/index.html', 'assets/main-AbC.js', 'index.html'])

    const commit = { id: ID, time: '2026-10-24 16:05 UTC', changed: false }
    const text = fingerprints(dir, commit)
    assert.equal(text, fingerprints(dir, commit))
    assert.match(text, new RegExp(`^# .*\n# ${ID} \\(2026-10-24 16:05 UTC\\)\\.\n`))
    const lines = text.split('\n').filter((l) => l && !l.startsWith('#'))
    assert.deepEqual(lines.map((l) => l.slice(66)), filesOf(dir))
    writeFileSync(join(dir, LIST), text)
    // A Mac has shasum instead, which also skips the # lines.
    const [cmd, ...args] = hasSha256sum ? ['sha256sum'] : ['shasum', '-a', '256']
    execFileSync(cmd, [...args, '--check', '--strict', '--quiet', LIST], { cwd: dir })

    assert.throws(() => fingerprints(dir, { ...commit, changed: true }), /differ from the commit/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
