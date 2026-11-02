// Links begin with the site's address (site.ts SITE_URL), not the page's: a
// copy downloaded and run on one's own computer, at http://127.0.0.1:8293,
// makes https://slynk.me/#… links and inbox addresses that anyone can open,
// and treats them as its own. The files are the site's, so it's decided as the
// page runs (home.ts). Run: npm --prefix web test
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { inboxLink, inboxQrText } from '../src/inbox/address.ts'
import { LOCAL_ORIGIN, SITE_ADDRESS, SITE_URL } from '../src/site.ts'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const g = globalThis as { location?: { origin: string } }

/** home.ts as a page at origin loads it: a fresh copy of the module, with location set first. */
async function homeAt(origin: string) {
  g.location = { origin }
  try {
    return await import(`../src/home.ts?at=${encodeURIComponent(origin)}`)
  } finally {
    delete g.location
  }
}

test('the site’s address is one setting, and links begin with it', () => {
  assert.equal(SITE_ADDRESS, 'slynk.me')
  assert.equal(SITE_URL, 'https://slynk.me')
  assert.equal(LOCAL_ORIGIN, 'http://127.0.0.1:8293')
})

test('a copy at 127.0.0.1 makes links and inbox addresses for https://slynk.me', async () => {
  const home = await homeAt(LOCAL_ORIGIN)
  assert.equal(home.ENDPOINT, 'https://k.slynk.me/', 'a downloaded copy talks to the site’s key server')
  assert.equal(home.LINK_ORIGIN, 'https://slynk.me')
  g.location = { origin: LOCAL_ORIGIN }
  try {
    assert.deepEqual(home.homeOrigins(), ['https://slynk.me', LOCAL_ORIGIN])
  } finally {
    delete g.location
  }
  // An inbox's address, as create.ts and owner.ts show it and put it in its QR code.
  const compact = new Uint8Array(33).fill(7)
  compact[0] = 1
  assert.match(inboxLink(home.LINK_ORIGIN, compact), /^https:\/\/slynk\.me\/#[\w-]+$/)
  assert.match(inboxQrText(home.LINK_ORIGIN, compact), /^https:\/\/slynk\.me\/#/)
  // On slynk.me itself, nothing changes.
  assert.equal((await homeAt('https://slynk.me')).LINK_ORIGIN, 'https://slynk.me')
})

test('every link and inbox address is built from LINK_ORIGIN, never the page’s address', () => {
  const main = read('../src/main.ts')
  assert.match(main, /\$<HTMLInputElement>\('link'\)\.value = `\$\{LINK_ORIGIN\}\/#\$\{fragment\}`/)
  for (const f of ['../src/main.ts', '../src/inbox/create.ts', '../src/inbox/owner.ts', '../src/inbox/check.ts', '../src/ui/linkWarn.ts', '../src/ui/links.ts']) {
    assert.doesNotMatch(read(f), /location\.origin/, f)
  }
  for (const f of ['../src/inbox/create.ts', '../src/inbox/owner.ts', '../src/inbox/check.ts']) {
    const src = read(f)
    for (const m of src.matchAll(/inbox(?:Link|QrText)\(([^,]+),/g)) assert.equal(m[1], 'LINK_ORIGIN', `${f}: ${m[0]}`)
  }
  // Development and test builds whose key server is the page's own (/api/k) keep the page's address.
  assert.match(read('../src/home.ts'), /LINK_ORIGIN: string = ENDPOINT\.startsWith\('\/'\) && typeof location !== 'undefined' \? location\.origin : SITE_URL/)
})

test('in a downloaded copy, the site’s links open in the copy', () => {
  const mod = read('../src/ui/localLinks.ts')
  assert.match(mod, /if \(to\.origin === SITE_URL\) to = new URL\(to\.pathname \+ to\.search \+ to\.hash, location\.origin\)/)
  // Messages' links know both as Slynk's own (message-links.test.ts has the cases).
  assert.match(read('../src/ui/linkWarn.ts'), /findLinks\(text, \.\.\.homeOrigins\(\)\)/)
})
