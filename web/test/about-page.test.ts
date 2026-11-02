// The About / FAQ page as a whole: what
// Slynk is for near the top, the app's links into it, links that leave
// slynk.me, and links to the published code left out until it's published.
// The answers' own sentences are checked by the tests of each feature.
// Run: npm --prefix web test
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { describe, test } from 'node:test'
import { fillSourceLinks } from '../scripts/source-links.ts'
import { SOURCE_URL, sourceLink } from '../src/site.ts'
import { seenOn } from './helpers/pages.ts'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const html = seenOn(read('../about/index.html'))
const flat = html.replace(/\s+/g, ' ')
const main = flat.slice(flat.indexOf('<main'), flat.indexOf('</main>'))

describe('the order', () => {
  test('what Slynk is and isn’t comes first, then how it works, how private it is, and the questions', () => {
    const at = (s: string) => {
      const i = main.indexOf(s)
      assert.ok(i >= 0, s)
      return i
    }
    const order = [
      // What it is, then what it isn't, then the project and what inboxes are for, in the box.
      'What Slynk is, and isn’t',
      'One to one, with a link.',
      'Many to one, for organisations.',
      'Not a messenger.',
      'A closed loop, by design.',
      'In everyday life we take privacy for granted',
      'Slynk is a small digital privacy project',
      'Anonymous inboxes are for people who need to reach an organisation',
      '</section>',
      // Then the main sections, each folded under its heading, and
      // where it comes from at the end, open.
      '<details class="section" id="how"> <summary><h2>How it works</h2></summary>',
      '<details class="section" id="private"> <summary><h2>How private is it?</h2></summary>',
      'Compared with messaging apps',
      'The honest limits',
      'More privacy, if you need it',
      // Running it on your own computer, once there's a release to download (scripts/release.ts).
      '<details class="section" id="download"> <summary><h2>Run Slynk on your computer</h2></summary>',
      '<details class="section" id="sending"> <summary><h2>Sending something</h2></summary>',
      '<details class="section" id="inbox"> <summary><h2>Anonymous inboxes</h2></summary>',
      '<details class="section" id="depth"> <summary><h2>In more depth</h2></summary>',
      '<details class="section" id="open"> <summary><h2>Open source and credits</h2></summary>',
      '<h2 id="origins">',
      'Send something with Slynk',
    ].map(at)
    assert.deepEqual(order, [...order].sort((a, b) => a - b))
  })

  test('each section ends with a way to close it, and nothing but the sections folds at the top level', () => {
    // Seven with the downloads, which are left out until there's a release (release.test.ts).
    assert.equal(main.match(/<details class="section"/g)?.length, 7)
    assert.equal(main.match(/data-close-section>Close this section<\/button>/g)?.length, 7)
    assert.doesNotMatch(main, /You come to Slynk to check/)
  })

  test('every jump on the page goes somewhere on it', () => {
    for (const [, id] of main.matchAll(/href="#([^"]+)"/g)) assert.match(html, new RegExp(`id="${id}"`), id)
  })

  test('every link the app makes to an answer still finds it', () => {
    const app = read('../index.html') + readdirSync(new URL('../src/', import.meta.url), { recursive: true })
      .filter((f) => String(f).endsWith('.ts'))
      .map((f) => read(`../src/${f}`))
      .join('\n')
    const ids = [...new Set([...app.matchAll(/\/about\/#([\w-]+)/g)].map((m) => m[1]))]
    assert.ok(ids.length >= 8)
    for (const id of ids) assert.match(html, new RegExp(`id="${id}"`), id)
  })
})

describe('compared with messaging apps', () => {
  test('in general terms, never naming an app, and in proportion', () => {
    assert.ok(!/whatsapp|telegram|imessage|instagram|facebook|snapchat|viber|wechat|co-nexx/i.test(main))
    assert.ok(!/\b(Signal|Messenger|Haven)\b/.test(main)) // "Not a messenger." is fine
    // Checked against the apps' own pages (2026-10-22): not all encrypt by default, and "usually" who sent it.
    assert.match(main, /Most of the big messaging apps need your phone number, and many show it, or your real name/)
    assert.match(main, /though not all do by default/)
    assert.match(main, /from which internet address and, usually, who sent it/)
    assert.match(main, /hasn’t been checked by independent security experts yet/)
  })

  test('more privacy: cover requests stay on, said as Settings says them (on by default)', () => {
    assert.match(main, /<strong>Keep Cover requests on<\/strong> in Settings \(they’re on unless you switch them off\)/)
    assert.match(read('../index.html'), /<strong>Cover requests<\/strong><span>Empty requests to slynk\.me’s key server that look like real ones, so nobody watching can tell which visitors sent or opened a link\./)
    assert.match(read('../src/ui/settings.ts'), /coverRequests: true,/)
  })

  test('the desktop app, inbox only, talks to nothing but the xx network: no inbox code reaches the key server', () => {
    assert.match(main, /<strong>Inbox only, nothing but the xx network\.<\/strong> Use only an inbox and switch Cover requests off in Settings, and the desktop app talks to nothing but the xx network: its directory, the service that admits each new connection, and its gateways\. slynk\.me’s key server hears from it only when you make, open or cancel a link\./)
    // The key server's client (burn.ts) is used by links (main.ts) and cover requests (burnCover.ts); the others take
    // only its types and sizes. Anything else reaching for it (an inbox's code, say) means the line above needs another look.
    const src = new URL('../src/', import.meta.url)
    const users = readdirSync(src, { recursive: true })
      .map(String)
      .filter((f) => f.endsWith('.ts') && /from '(?:\.\.?\/)+burn(?:\.ts)?'/.test(readFileSync(new URL(f, src), 'utf8')))
      .sort()
    assert.deepEqual(users, ['burnCover.ts', 'main.ts', 'ui/linkText.ts', 'ui/meter.ts'])
    assert.match(read('../src/ui/linkText.ts'), /^import type \{[^}]*\} from '\.\.\/burn\.ts'/m)
    assert.match(read('../src/ui/meter.ts'), /^import \{ MAX_PAYLOAD_SEALED \} from '\.\.\/burn\.ts'/m)
    // Cover requests start only with the setting on.
    assert.match(read('../src/main.ts'), /\nif \(settings\(\)\.coverRequests\) startCover\(\)\n/)
  })

  test('the connections to slynk.me and its key server: quantum-safe where the browser supports it, no more', () => {
    // Checked 2026-10-22: both negotiate TLS 1.3 with X25519MLKEM768 (a Go handshake offering only it), and
    // Chrome/Edge 131+, Firefox 132+ and Safari 26 offer it by default. The xx network's own hosts aren't claimed.
    const answer = main.slice(main.indexOf('<details id="connects-to">'), main.indexOf('</details>', main.indexOf('<details id="connects-to">')))
    assert.match(answer, /<summary>What does Slynk connect to\?<\/summary>/)
    assert.match(answer, /Your browser’s connections to slynk\.me and its key server use a quantum-safe key exchange where your browser supports it/)
    assert.doesNotMatch(main, /quantum-proof|unbreakable|guarantee/i)
  })

  test('what slynk.me sees, in "How private is it?": the same files for every visit, and its key server', () => {
    const sees = main.slice(main.indexOf('<h3 id="slynk-sees">'), main.indexOf('<h3 id="honest-limits">The honest limits</h3>'))
    assert.ok(sees.length > 0 && main.indexOf('<h3 id="slynk-sees">') > main.indexOf('<details class="section" id="private">'))
    // Every visit fetches the same files (src/preload.ts, uniform-loading.test.ts): what's said, never "ever".
    assert.match(sees, /Every visit to the website loads all of Slynk at the start, whatever you go on to do, so what a visit loads can’t show what you did/)
    assert.doesNotMatch(sees, /\bever\b|\bwe\b/)
    assert.match(read('../src/preload.ts'), /export function preloadEverything/)
    // The key server: memory only, no addresses, answers alike (core/keyserver: ResponseBytes, MinResponse).
    assert.match(sees, /only in its memory: never logged, not written to its disk while it runs/)
    assert.match(sees, /every answer from the key server is the same size and takes at least a tenth of a second/)
    const go = read('../../core/keyserver/protocol.go') + read('../../core/keyserver/server.go')
    assert.match(go, /ResponseBytes\s+=\s+128/)
    assert.match(go, /MinResponse:\s+100 \* time\.Millisecond/)
    // "How do one-time links work?" and "What does Slynk connect to?" point here rather than repeat it.
    assert.equal(main.match(/<a href="#slynk-sees">What slynk\.me sees<\/a>/g)?.length, 2)
  })

  test('the closed loop: nothing is pushed, by email or otherwise, and the tab’s dot is all there is', () => {
    assert.match(main, /Nothing arrives by email, text or notification on your phone/)
    assert.match(read('../index.html'), /A dot on this tab when a transfer finishes or a message reaches your open inbox/)
  })
})

describe('links that leave slynk.me', () => {
  const pages = { about: html, app: read('../index.html') }

  test('open in a new tab, with the arrow, and tell the next site nothing of where they came from', () => {
    for (const [name, page] of Object.entries(pages)) {
      for (const [a] of page.matchAll(/<a\b[^>]*>/g)) {
        if (/href="https?:/.test(a) || /data-source=|class="source-link"/.test(a)) {
          assert.match(a, /target="_blank"/, `${name}: ${a}`)
          assert.match(a, /rel="noopener noreferrer"/, `${name}: ${a}`)
          assert.doesNotMatch(a, /class="[^"]*no-ext/, `${name}: ${a}`)
        }
      }
    }
    for (const [a] of html.matchAll(/<p class="source-link"[^>]*><a [^>]*>/g)) assert.match(a, /target="_blank" rel="noopener noreferrer"/)
  })

  test('ask first: the About page has the same popup as the app, and both pages wire it', () => {
    const dialog = (page: string) => {
      const d = page.slice(page.indexOf('<dialog id="link-warn"'), page.indexOf('</dialog>', page.indexOf('<dialog id="link-warn"')))
      return d.replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ')
    }
    assert.equal(dialog(html), dialog(pages.app))
    assert.match(read('../src/about.ts'), /fillCopy\(document\.getElementById\('link-warn'\)!\)\naskBeforeLeaving\(\)/)
    assert.match(read('../src/main.ts'), /\naskBeforeLeaving\(\)/)
  })
})

describe('links to the published code (the write-ups in docs/findings)', () => {
  // The write-ups in docs/findings, with its index (README.md).
  const planned = [
    'one-time-links.md', 'cancel-upload.md', 'why-links-open-once.md', 'link-and-envelope-format.md',
    'hidden-data-cleaning.md', 'inbox.md', 'gateway-metadata.md', 'quantum-safety.md', 'decisions.md',
    'network-identities.md', 'upload-throughput-2026-10.md', 'notes.md', 'comms-roundupdates-bug.md',
    'pickup-retry-delay.md', 'xxdk-changes.md', 'preparing-files.md', 'README.md',
  ]
  const paths = [...html.matchAll(/data-source="([^"]*)"/g)].map((m) => m[1])

  test('each names the code itself, the write-ups folder, one planned write-up, or the site check', () => {
    assert.ok(paths.length >= 10)
    for (const p of paths) {
      if (p === 'deploy/check-site.sh') assert.ok(existsSync(new URL(`../../${p}`, import.meta.url)), p)
      else assert.ok(p === '' || p === 'docs/findings/' || planned.includes(p.replace(/^docs\/findings\//, '')), p)
    }
    for (const f of readdirSync(new URL('../../docs/findings/', import.meta.url))) assert.ok(planned.includes(f), `${f} is published but not in the list`)
  })

  test('"How private is it?" ends with the write-ups on its privacy choices', () => {
    const start = html.indexOf('<details class="section" id="private">')
    const section = html.slice(start, html.indexOf('<details class="section"', start + 1))
    const tail = section.slice(section.lastIndexOf('</ul>'))
    for (const f of ['one-time-links.md', 'gateway-metadata.md', 'decisions.md']) assert.ok(tail.includes(`data-source="docs/findings/${f}"`), f)
  })

  test('with no published code (a fork’s empty SOURCE_URL), the page shows none of them', () => {
    const built = fillSourceLinks(html, () => '')
    assert.ok(!/class="source-link"|data-source="|technical write-up|See Slynk’s code/.test(built.replace(/<!--[\s\S]*?-->/g, '')))
    // Nothing else changes.
    assert.equal(built.replace(/\s+/g, ''), html.replace(/[ \t]*<p class="source-link"[^\n]*\n/g, '').replace(/\s+/g, ''))
  })

  test('the site’s own links follow SOURCE_URL', () => {
    assert.equal(sourceLink('docs/findings/inbox.md'), SOURCE_URL && `${SOURCE_URL}/blob/main/docs/findings/inbox.md`)
    assert.equal(sourceLink('docs/findings/'), SOURCE_URL && `${SOURCE_URL}/tree/main/docs/findings`)
    assert.equal(sourceLink(''), SOURCE_URL)
  })

  test('with published code, each gets its address, in a new tab', () => {
    const base = 'https://code.example/owner/slynk'
    const link = (p: string) => (p === '' ? base : `${base}/${p.endsWith('/') ? 'tree' : 'blob'}/main/${p.replace(/\/$/, '')}`)
    const built = fillSourceLinks(html, link)
    assert.ok(!/data-source="/.test(built))
    const hrefs = [...built.matchAll(/<p class="source-link"><a href="([^"]+)" target="_blank" rel="noopener noreferrer">[^<]+<\/a><\/p>/g)].map((m) => m[1])
    assert.equal(hrefs.length, paths.length)
    assert.ok(hrefs.includes(`${base}/blob/main/docs/findings/one-time-links.md`))
    assert.ok(hrefs.includes(`${base}/tree/main/docs/findings`))
    assert.ok(hrefs.includes(base))
  })

  test('the code check says what the fingerprints catch, and what they can’t', () => {
    assert.doesNotMatch(flat, /Before Slynk opens to everyone, each version will come with a list of its files’ fingerprints/)
    const start = flat.indexOf('<details id="verify">')
    const answer = flat.slice(start, flat.indexOf('</details>', start))
    for (const said of [
      /built by GitHub from Slynk’s published code/,
      /always builds to exactly the same files, so anyone can rebuild it and compare/,
      /What no outside check can catch is a changed page sent to one person/,
      /Nor can a page vouch for itself/,
    ]) {
      assert.match(answer, said)
    }
  })

  test('one written any other way stops the build rather than reach the page unfilled', () => {
    assert.throws(() => fillSourceLinks('<p data-source="x.md"><a>Read</a></p>', () => ''))
    assert.throws(() => fillSourceLinks('<p class="source-link" data-source="x.md"><a>Read <b>it</b></a></p>', () => ''))
  })
})
