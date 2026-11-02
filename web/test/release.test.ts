// The downloadable copy's parts of the pages: the
// footer's "Run locally (download)" and its popup, and the About page's
// downloads, filled in from the latest release, and left out while there's
// none, so neither page describes a version that doesn't exist yet.
// Run: npm --prefix web test
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { fillRelease, releaseDate, releaseSize } from '../scripts/release.ts'
import { LOCAL_ORIGIN, RELEASE, type Release, SOURCE_URL, releaseLink } from '../src/site.ts'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const pages = { app: read('../index.html'), about: read('../about/index.html') }
const sum = (c: string) => c.repeat(64)
const release: Release = {
  tag: 'v1.0.0',
  date: '2026-11-03',
  files: [
    { system: 'windows', name: 'slynk.exe', bytes: 20_673_024, sha256: sum('a') },
    { system: 'mac-arm', name: 'slynk-mac-arm64.zip', bytes: 13_297_087, sha256: sum('b') },
    { system: 'mac-intel', name: 'slynk-mac-x64.zip', bytes: 13_402_790, sha256: sum('c') },
    { system: 'linux', name: 'slynk-linux-x64.zip', bytes: 13_367_314, sha256: sum('d') },
  ],
}
const link = (f: { name: string }) => `https://github.com/OWNER/slynk/releases/download/v1.0.0/${f.name}`

describe('before the first release', () => {
  test('neither page offers a download, mentions running it locally, or jumps to the downloads', () => {
    for (const [name, page] of Object.entries(pages)) {
      const built = fillRelease(page, undefined, link)
      assert.doesNotMatch(built, /Run locally|id="download"|href="#download"|id="local-why|data-release-|<!-- \/?release -->/, name)
      assert.doesNotMatch(built, /Run Slynk (on|from) your (own )?computer/, name)
    }
  })

  test('nor does a release while the code (and so its releases) isn’t published', () => {
    for (const page of Object.values(pages)) assert.equal(fillRelease(page, release, () => ''), fillRelease(page, undefined, link))
  })

  test('slynk.me has none yet, and releases come from the published code', () => {
    if (!SOURCE_URL) assert.equal(RELEASE, undefined)
    assert.equal(releaseLink(release, release.files[0]), SOURCE_URL ? `${SOURCE_URL}/releases/download/v1.0.0/slynk.exe` : '')
    assert.equal(LOCAL_ORIGIN, 'http://127.0.0.1:8293') // the key server answers this one address (core/keyserver)
  })
})

describe('with a release', () => {
  const about = fillRelease(pages.about, release, link)
  const app = fillRelease(pages.app, release, link)

  test('the footer offers it, in a popup that leads to the About page’s downloads in a new tab', () => {
    assert.match(app, /id="local-why-go"[^>]*>Run locally \(download\)</)
    assert.match(app, /<dialog id="local-why"[\s\S]*?href="\/about\/#download" target="_blank" rel="noopener">See the downloads</)
    assert.match(read('../src/main.ts'), /infoSheet\('local-why', 'local-why-go'\)/)
  })

  test('each download goes to its file in the release, in a new tab, with its size and fingerprint', () => {
    for (const f of release.files) {
      // Its size on the button, and what it's for in words for screen readers.
      assert.match(
        about,
        new RegExp(`<a class="btn [^"]*" href="${link(f)}" target="_blank" rel="noopener noreferrer">[^<]*<span class="sr-only">[^<]*</span>[^<]*<span class="dl-size">${releaseSize(f.bytes)}</span></a>`),
        f.system,
      )
      // Its fingerprint, small, under the name.
      assert.match(about, new RegExp(`<div class="dl-sums">[^]*?SHA-256 <code>${f.sha256}</code>`), f.system)
    }
    assert.ok(about.includes('Built 3 November 2026.'))
    assert.doesNotMatch(about + app, /data-release-|<!-- \/?release -->/)
  })

  test('the About page says what changes, and every jump to the downloads finds them', () => {
    assert.match(about, /<details class="section" id="download">/)
    assert.match(about.replace(/\s+/g, ' '), /Paste or scan the links you receive\./)
    assert.ok((about.match(/href="#download"/g) ?? []).length >= 3)
  })
})

describe('written wrong, it stops the build rather than reach a page', () => {
  test('values', () => {
    assert.throws(() => fillRelease('', { ...release, tag: '1.0' }, link))
    assert.throws(() => fillRelease('', { ...release, date: '2026-13-01' }, link))
    assert.throws(() => fillRelease('', { ...release, files: [{ ...release.files[0], sha256: 'x' }] }, link))
    assert.throws(() => fillRelease('', { ...release, files: [{ ...release.files[0], name: 'a"b.exe' }] }, link))
    // Windows gets the program itself, the others a zip (an app is a folder; Linux keeps it runnable).
    assert.throws(() => fillRelease('', { ...release, files: [{ ...release.files[0], name: 'slynk-windows-x64.zip' }] }, link))
    assert.throws(() => fillRelease('', { ...release, files: [{ ...release.files[1], name: 'slynk.exe' }] }, link))
    assert.throws(() => fillRelease('', { ...release, files: [release.files[0], release.files[0]] }, link))
  })

  test('markup', () => {
    assert.throws(() => fillRelease('<!-- release --><a data-release-href="bsd">x</a><!-- /release -->', release, link))
    assert.throws(() => fillRelease('<!-- release -->unclosed', release, link))
    assert.throws(() => fillRelease('<!-- release --><!-- release -->x<!-- /release --><!-- /release -->', release, link))
    assert.throws(() => fillRelease('<!-- release --><b data-release-size="linux">x</b><!-- /release -->', release, link))
    assert.throws(() => fillRelease('<a data-release-href="linux">outside a part</a>', undefined, link))
  })

  test('dates and sizes as the page writes them', () => {
    assert.equal(releaseDate('2026-10-22'), '22 October 2026')
    assert.equal(releaseSize(13_448_602), '13.4 MB')
  })
})
