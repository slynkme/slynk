// The About page for a copy run from one's own computer: some of it is
// true only of the website (visit logs, the page coming from slynk.me, tabs), so the page carries
// both versions where they differ, and shows one (style.css, html[data-local] from ui/localLinks.ts).
// Run: npm --prefix web test
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { seenOn, sitePage } from './helpers/pages.ts'

const raw = sitePage('about/index.html')
const text = (html: string) => html.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
const web = text(seenOn(raw, 'web'))
const local = text(seenOn(raw, 'local'))

test('the website reads as it did', () => {
  for (const said of [
    /No account, nothing to install, and Slynk never receives what you send/,
    /Each visit uses a brand-new, temporary identity on the network, which lives only in the tab/,
    /like any website, the page comes from slynk\.me each time you visit/,
    /The same files for every visit\./,
    /No visit logs\. When you use slynk\.me’s website, it keeps no record of visits/,
    /The website’s hosting provider can see connections\./,
    /Use a VPN , so slynk\.me’s website and key server, their hosting providers and the xx network see the VPN’s address/,
    /Use a private window on a device someone else may look at/,
    /It then opens it only in a new tab, so your inbox stays open/,
    /Only slynk\.me, for the page itself and, for one-time links, its key server; and the xx network/,
  ]) {
    assert.match(web, said)
  }
  assert.doesNotMatch(web, /No visits\. The desktop app|It doesn’t update itself|a second Slynk window|Paste the links you receive into the desktop app/)
})

test('a copy on one’s own computer says only what’s true of it', () => {
  for (const notTrue of [
    /nothing to install/,
    /like any website, the page comes from slynk\.me/,
    /The same files for every visit/,
    /No visit logs/,
    /hosting provider can see connections/,
    /slynk\.me’s website and key server/,
    /Use a private window on a device/,
    /When there’s a new version, it appears here/,
    /Only slynk\.me, for the page itself/,
    /Run Slynk from your own computer/, // it is
    /\btabs?\b/, // it's a window
    /\byour copy\b/, // it's the desktop app ("your copy" sounds odd)
  ]) {
    assert.doesNotMatch(local, notTrue)
  }
  for (const said of [
    /No account, and Slynk never receives what you send/,
    /Each time Slynk’s window opens, it uses a brand-new, temporary identity on the network, which lives only in the window/,
    /the desktop app is only as sound as the file you downloaded: check its fingerprint against the one on Slynk’s page on GitHub\./,
    /No visits\. The desktop app runs from your own computer, so slynk\.me’s website never sees you/,
    /It doesn’t update itself\./,
    /Use a VPN , so slynk\.me’s key server, its hosting provider and the xx network see the VPN’s address/,
    /Paste the links you receive into the desktop app , rather than clicking them/,
    /It then opens a Slynk link in a second Slynk window, so your inbox stays open, and another site’s in your usual browser/,
    /Only your own computer, for the page itself; slynk\.me’s key server, for one-time links; and the xx network/,
    /For the desktop app, check its download/,
  ]) {
    assert.match(local, said)
  }
})

test('the two versions never nest, so the page shows exactly one of each', () => {
  for (const m of raw.matchAll(/<span class="on-(web|local)">([\s\S]*?)<\/span>/g)) assert.doesNotMatch(m[2], /<span/, m[0].slice(0, 80))
  const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8')
  assert.match(css, /html:not\(\[data-local\]\) \.on-local,\nhtml\[data-local\] \.on-web \{\n {2}display: none !important;\n\}/)
  assert.match(readFileSync(new URL('../src/ui/localLinks.ts', import.meta.url), 'utf8'), /if \(!localCopy\) return\n\s+document\.documentElement\.dataset\.local = ''/)
  assert.match(readFileSync(new URL('../src/about.ts', import.meta.url), 'utf8'), /\nwireLocalLinks\(\)\n/)
  // The front page's "Run locally (download)" isn't offered inside the copy itself.
  assert.match(readFileSync(new URL('../index.html', import.meta.url), 'utf8'), /<span class="on-web"><button class="soft-link" id="local-why-go"/)
})
