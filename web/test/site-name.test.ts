// The site's name and address are one setting each (src/site.ts SITE_NAME,
// SITE_ADDRESS): the page's texts take them from there, and the pages get them
// at build time (scripts/site-name.ts), so a fork changes one file. For
// slynk.me nothing changes. Run: npm --prefix web test
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { describe, test } from 'node:test'
import { checkSiteName, fillSiteName } from '../scripts/site-name.ts'
import { FILE_PREFIX, SITE_ADDRESS, SITE_NAME } from '../src/site.ts'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

/** Every .ts file under web/src, as a path relative to web/test. */
function sources(dir = '../src/'): string[] {
  return readdirSync(new URL(dir, import.meta.url), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (e.name === 'generated' ? [] : sources(`${dir}${e.name}/`)) : e.name.endsWith('.ts') ? [`${dir}${e.name}`] : [],
  )
}

test('slynk.me’s name and address', () => {
  assert.equal(SITE_NAME, 'Slynk')
  assert.equal(SITE_ADDRESS, 'slynk.me')
  assert.equal(FILE_PREFIX, 'slynk')
})

test('no text people read in the page’s code names Slynk or slynk.me itself: it says SITE_NAME or SITE_ADDRESS', () => {
  const literal = /'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g
  const files = sources()
  assert.ok(files.length > 100)
  for (const f of files) {
    if (f.endsWith('/site.ts')) continue
    read(f)
      .split('\n')
      .forEach((line, i) => {
        const code = line.trim()
        // Comments, and what only developers see: the console, and the cleaner's reasons (never shown).
        if (/^(\/\/|\*|\/\*)/.test(code) || /console\.|\bfail\(/.test(code)) return
        for (const m of code.split(' // ')[0].matchAll(literal)) {
          assert.doesNotMatch(m[0], /\bSlynk\b|(?<![\w.-])slynk\.me(?![\w-])/, `${f}:${i + 1}: ${m[0]}`)
        }
      })
  }
})

test('files saved from the site begin with its name', async () => {
  const { zipName } = await import('../src/zip.ts')
  const { KEY_FILE_NAME } = await import('../src/inbox/keyfile.ts')
  const copy = await import('../src/inbox/inboxCopy.ts')
  assert.equal(zipName(new Date(2026, 9, 22)), 'slynk-2026-10-22.zip')
  assert.equal(KEY_FILE_NAME, 'slynk-passphrase-backup.txt')
  assert.deepEqual([copy.READY_QR_FILE(false), copy.READY_QR_FILE(true)], ['slynk-inbox-qr.svg', 'slynk-quantum-safe-inbox-qr.svg'])
  assert.match(read('../src/ui/share.ts'), /safeName\(item\.name, `\$\{FILE_PREFIX\}-file`\)/)
  assert.match(read('../src/ui/notify.ts'), /const BASE_TITLE = SITE_NAME/)
})

describe('the pages, at build time (scripts/site-name.ts)', () => {
  const pages = ['../index.html', '../about/index.html', '../public/404.html']

  test('slynk.me’s own build changes nothing', () => {
    for (const p of pages) assert.equal(fillSiteName(read(p), SITE_NAME, SITE_ADDRESS), read(p), p)
  })

  test('a fork’s name and address go wherever the page says Slynk or slynk.me, but not in comments', () => {
    const html = [
      '<!-- Slynk on slynk.me -->',
      '<title>About Slynk</title><a href="https://slynk.me/#abc" aria-label="Slynk home">Slynk’s page, slynk.me’s key server.</a>',
      '<a href="#slynk-sees">k.slynk.me, slynk.me.example and SlynkCore stay</a>',
    ].join('\n')
    assert.equal(
      fillSiteName(html, 'Parcel', 'parcel.example'),
      [
        '<!-- Slynk on slynk.me -->',
        '<title>About Parcel</title><a href="https://parcel.example/#abc" aria-label="Parcel home">Parcel’s page, parcel.example’s key server.</a>',
        '<a href="#slynk-sees">k.slynk.me, slynk.me.example and SlynkCore stay</a>',
      ].join('\n'),
    )
    // "$$" in a name is the name, not a pattern.
    assert.equal(fillSiteName('Slynk', 'A$$B', 'slynk.me'), 'A$$B')
  })

  test('a name or address that would break the pages or the links stops the build', () => {
    for (const name of ['', ' Slynk', 'Sly<nk', 'A&B', 'Say "hi"']) assert.throws(() => checkSiteName(name, 'slynk.me'), /SITE_NAME/, name)
    for (const address of ['', 'Slynk.me', 'localhost', 'slynk.me/', 'https://slynk.me', 'slynk.me:443', '-x.me', 'slynk..me', '127.0.0.1']) {
      assert.throws(() => checkSiteName('Slynk', address), /SITE_ADDRESS/, address)
    }
    for (const address of ['slynk.me', 'parcel.example', 'drop.example.org', 'xn--slynk-9ua.example']) checkSiteName('Slynk', address)
  })

  test('the build fills them in, public’s plain page too, and checks the key server is in the CSP', () => {
    const config = read('../vite.config.ts')
    assert.match(config, /transformIndexHtml: \(html\) => fillSiteName\(html, SITE_NAME, SITE_ADDRESS\)/)
    assert.match(config, /const file = join\(options\.dir!, '404\.html'\)/)
    assert.match(config, /the CSP's connect-src doesn't list the key server/)
  })
})
