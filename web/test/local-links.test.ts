// Links in a copy of Slynk run from one's own computer:
// it opens in a window of its own with no tabs, so Slynk's own
// pages open in that window while nothing would be lost, else in a second
// Slynk window, and other sites open in the person's own browser, through the
// program (lab/run-locally, /api/open). On slynk.me nothing changes.
// Run: npm --prefix web test
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const mod = read('../src/ui/localLinks.ts')
const main = read('../src/main.ts')
const about = read('../src/about.ts')
const css = read('../src/style.css')

test('only a copy at the one local address acts differently', () => {
  assert.match(mod, /export const localCopy = typeof location !== 'undefined' && location\.origin === LOCAL_ORIGIN/)
  assert.match(mod, /export function wireLocalLinks\(\) \{\n\s+if \(!localCopy\) return/)
})

test('Slynk’s own pages open in the window while leaving loses nothing, else through the program', () => {
  assert.match(mod, /if \(to\.origin === location\.origin && mayLeave\(\)\) \{\n\s+location\.assign\(to\.href\)/)
  assert.match(mod, /fetch\('\/api\/open', \{ method: 'POST', body: href, credentials: 'omit', referrerPolicy: 'no-referrer' \}\)/)
  // An older program without /api/open: a new window, as before.
  assert.match(mod, /ok \|\| window\.open\(to\.href, '_blank', 'noopener,noreferrer'\)/)
  // The front page with nothing written or added, no inbox open and nothing going on.
  assert.match(main, /setMayLeave\(\(\) => view === 'compose' && !transferring && !pendingDrop && !owner\.isOpen\(\) && !textBox\.value\.trim\(\) && !draftsWaiting\(\) && !tray\.count\(\)\)/)
  assert.match(main, /\nwireLocalLinks\(\)\n/)
  assert.match(about, /\nwireLocalLinks\(\)\n/)
})

test('links that ask first still ask: only a click nothing else handled opens, so other sites go through "Leave Slynk?"', () => {
  assert.match(mod, /if \(e\.defaultPrevented \|\| \(e\.type === 'auxclick' && e\.button !== 1\)\) return/)
  assert.match(read('../src/ui/linkWarn.ts'), /const ask = \(e: MouseEvent\) => \{\n\s+e\.preventDefault\(\)/)
})

test('the program stops once Slynk’s last window closes: each page holds a connection, and says when it goes', () => {
  assert.match(mod, /if \(!localCopy\) return\n\s+document\.documentElement\.dataset\.local = ''\n\s+keepProgramRunning\(\)/)
  assert.match(mod, /new EventSource\('\/api\/alive'\)/)
  // keepalive, so it's sent as the page goes; fetch, so the browser sends the page's Origin, which the program checks.
  assert.match(mod, /addEventListener\('pagehide', \(\) => \{\n\s+void fetch\('\/api\/bye', \{ method: 'POST', keepalive: true, credentials: 'omit', referrerPolicy: 'no-referrer' \}\)/)
  // Only to the program on this computer, which the page's rules allow ('self').
  assert.match(read('../public/.htaccess'), /connect-src 'self' /)
})

test('no new-tab arrow or "(opens in new tab)" on Slynk’s own pages there', () => {
  assert.match(css, /\[data-local\] a\[target='_blank'\]\[href\^='\/'\]::after \{\n\s+content: none;/)
  assert.match(css, /\[data-local\] \.footer-new-tab \{\n\s+display: none;/)
})

test('"Received a Slynk link? Paste it here." reads a whole link, whichever site it names, or just its # part', async () => {
  const { pastedFragment } = await import('../src/ui/localLinks.ts')
  const part = 'Ab3_-'.repeat(40) // a link's part after the #: 200 characters of base64url
  assert.equal(pastedFragment(`https://slynk.me/#${part}`), `#${part}`)
  assert.equal(pastedFragment(`http://127.0.0.1:8293/#${part}`), `#${part}`)
  // A message app's line breaks and spaces, and the space before or after a copied link.
  assert.equal(pastedFragment(`  https://slynk.me/#${part.slice(0, 90)}\n${part.slice(90)} `), `#${part}`)
  assert.equal(pastedFragment(part), `#${part}`)
  assert.equal(pastedFragment('https://slynk.me/#/new-inbox'), '#/new-inbox')
  for (const t of ['', 'hello', 'https://slynk.me/', 'https://slynk.me/#', 'short_part']) assert.equal(pastedFragment(t), undefined, t)
})

test('the paste box is only in a local copy, not while writing to an inbox, and never puts the link in the address bar', () => {
  const html = read('../index.html')
  assert.match(html, /<form class="open-link" id="open-link" hidden novalidate>\s+<label class="opts-label" for="open-link-field">Received a Slynk link\?<\/label>/)
  assert.match(html, /<input id="open-link-field" type="text" placeholder="Paste it here" autocomplete="off"/)
  assert.ok(html.indexOf('id="open-link"') < html.indexOf('id="to-inbox"'), 'at the top of the card')
  assert.match(main, /\$\('open-link'\)\.hidden = !localCopy \|\| !!to/)
  assert.match(main, /\$\('open-link'\)\.hidden = !localCopy \|\| !!addressed/)
  // The same checks as a link from the address bar, without going through it.
  assert.match(main, /history\.replaceState\(null, '', location\.pathname \+ location\.search\)\n {2}return openFragment\(fragment\)\n\}/)
  const submit = main.slice(main.indexOf('function openPasted('), main.indexOf("$('open-link').addEventListener('submit'"))
  assert.match(submit, /openFragment\(fragment!\)/)
  assert.doesNotMatch(submit, /location|history/)
  // An inbox unlocked in the window: said in the box, not a toast about tabs.
  assert.match(submit, /owner\.isOpen\(\) && !inboxRoute\(fragment\) \? PASTE_INBOX_OPEN/)
  // The About page names it as it is.
  assert.match(read('../about/index.html'), /paste it into “Received a Slynk link\?” at the top of\s+its page/)
})

test('the paste box can scan a QR code too: the inbox’s scanner, for a link or an inbox’s address', () => {
  const html = read('../index.html')
  const box = html.slice(html.indexOf('id="open-link"'), html.indexOf('id="open-link-error"'))
  assert.match(box, /<span class="field-wrap">\s+<input id="open-link-field"[^>]*\/>\s+<button class="field-btn" id="open-link-scan" type="button">/)
  assert.match(main, /\$\('open-link-scan'\)\.addEventListener\('click', \(\) => openScanFor\(pastedFragment, \(fragment\) => openPasted\(fragment\), SCAN_LINK_WORDS\)\)/)
  // What's scanned goes the way a pasted link does, checks and all.
  assert.match(main, /\$\('open-link'\)\.addEventListener\('submit', \(e\) => \{\n {2}e\.preventDefault\(\)\n {2}openPasted\(/)
  const scan = read('../src/inbox/scan.ts')
  assert.match(scan, /export function openScan\(found: \(address: Uint8Array\) => void\) \{\n {2}openScanFor\(addressFromInput, found, INBOX_WORDS\)/)
  assert.match(mod, /notIt: `That QR code isn’t a \$\{SITE_NAME\} link or an inbox’s address\.`/)
  // The About page says where the camera can be used.
  assert.match(read('../about/index.html'), /In the desktop app, so does the box for links\s+you’ve received\./)
})
