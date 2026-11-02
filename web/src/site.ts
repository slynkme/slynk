// The site Slynk's code runs as: its name, its address and its rules, as
// slynk.me has them. A developer launching their own version of Slynk
// changes this one file, and takes on the responsibility for any rule they
// change. A few things outside the page must agree with it:
//   - public/.htaccess: the CSP's connect-src lists KEY_SERVER's address (the
//     build stops if it doesn't).
//   - The key server (deploy/keyserver/README.md): -allow-origin lists SITE_URL
//     and LOCAL_ORIGIN, and with ONE_TIME_ONLY off it runs with
//     -one-time-only=false.
//   - The downloadable copy (lab/run-locally) serves at LOCAL_ORIGIN's port.
//   - slynk-cli prints links for SLYNK_SITE (https://slynk.me unless set).
// Credits and the licence stay Slynk's.

/**
 * The site's name, as its pages and messages show it. The pages are written
 * with "Slynk" and "slynk.me", and the build puts SITE_NAME and SITE_ADDRESS in
 * their place (scripts/site-name.ts); the page's own texts take them from here.
 */
export const SITE_NAME = 'Slynk'

/**
 * The site's address, as people read it ("Messages never go to slynk.me"). It
 * serves the page at its root over HTTPS, and every link and inbox address
 * begins https://SITE_ADDRESS/#, wherever the page that made it is running
 * (home.ts): one made in a downloaded copy opens for anyone.
 */
export const SITE_ADDRESS = 'slynk.me'

/** The site's origin, which links and inbox addresses begin with. */
export const SITE_URL = `https://${SITE_ADDRESS}`

/** The name as files saved from the site begin ("slynk-inbox-qr.svg"). */
export const FILE_PREFIX = SITE_NAME.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-')

/**
 * Every link opens once only. slynk.me shouldn't
 * become a way to pass something on to many people, and a link shared widely
 * shouldn't send crowds to download it from the mixnet, which the network's
 * nodes couldn't carry. So the page makes only one-time links, opens only
 * one-time links, and holds a link for its first opener (burn.ts, reserve).
 * Explained on the About page ("Why does every link open only once?").
 *
 * Turned off, the page makes and opens ordinary, expiring and one-time links,
 * and its wording follows (burnCopy.ts, and the pages' <!-- when ONE_TIME_ONLY
 * --> parts, scripts/rules.ts). The key server enforces the rule too, so it
 * must then run with -one-time-only=false, or expiring links fail.
 */
export const ONE_TIME_ONLY = true

/**
 * slynk.me's key server (core/cmd/keyserver), which keeps the server's half of
 * each one-time link's key, in memory only
 * (docs/findings/one-time-links.md). It's on its own host, so it's listed in
 * the CSP's connect-src (public/.htaccess). Local development uses /api/k
 * instead, which Vite passes on to a key server run with -dev (home.ts).
 */
export const KEY_SERVER = 'https://k.slynk.me/'

/** Whether this page opens a link of this kind at all. */
export const opensHere = (kind: 'ordinary' | 'expiring' | 'one-time') => !ONE_TIME_ONLY || kind === 'one-time'

/**
 * Files and longer messages to anonymous inboxes. The code can send them, as an ordinary upload
 * to a random pickup address announced by a notice to the inbox, but an
 * upload is many pieces: while few people use the network, someone running
 * one of its gateways could sometimes match a large upload to the internet
 * address it came from and to the inbox it was for, whose owner is often
 * public. So slynk.me's inboxes take one-piece messages only, as before, and
 * an owner's page doesn't collect uploads sent from other copies of Slynk.
 * A copy that switches it on takes on the responsibility for that. Explained
 * on the About page ("Can people send files to an inbox?"), whose inbox
 * answers follow it (the pages' <!-- when INBOX_FILES --> parts).
 */
export const INBOX_FILES = false

/**
 * Whether the website keeps visit logs: each request's internet address and
 * time, as most web hosts do. slynk.me's keeps none
 * (since 2026-10-26): it runs on a server of its own, whose Caddy logs no requests
 * and leaves out the error messages that would name one
 * (deploy/webserver/Caddyfile). A copy on a host that keeps them sets this
 * true, and the About page then says so (the pages' <!-- when VISIT_LOGS -->
 * parts, scripts/rules.ts).
 */
export const VISIT_LOGS = false

/**
 * Where Slynk's published source code is, e.g. "https://github.com/OWNER/slynk"
 * (no slash at the end). While it's empty, the About page's links to the code
 * and its technical write-ups are left out of the built page, so it never shows
 * a dead link. A fork puts the address of its own code here.
 */
export const SOURCE_URL = 'https://github.com/slynkme/slynk'

/**
 * The address of a file or folder ("docs/findings/") of the published code,
 * or the code itself for '', on GitHub's layout; '' while SOURCE_URL is empty.
 */
export function sourceLink(path: string): string {
  if (!SOURCE_URL) return ''
  if (path === '') return SOURCE_URL
  return `${SOURCE_URL}/${path.endsWith('/') ? 'tree' : 'blob'}/main/${path.replace(/\/$/, '')}`
}

/**
 * Where a copy of Slynk downloaded and run on one's own computer serves the
 * page (lab/run-locally): 127.0.0.1 is every computer's own address. The port
 * never changes, since the browser keeps an inbox and settings per address and
 * port, and slynk.me's key server answers this one address besides slynk.me
 * (its -allow-origin).
 */
export const LOCAL_ORIGIN = 'http://127.0.0.1:8293'

/** A downloadable copy for one kind of computer, as a release on GitHub holds it. */
export interface ReleaseFile {
  system: 'windows' | 'mac-arm' | 'mac-intel' | 'linux'
  /** The file's name in the release: "slynk.exe" for Windows (no zip: it would only add a step), a zip for the others. */
  name: string
  bytes: number
  /** Its SHA-256, in lower-case hex. */
  sha256: string
}

export interface Release {
  /** The release's tag on GitHub, e.g. "v1.0.0". */
  tag: string
  /** When it was built, as YYYY-MM-DD (UTC). */
  date: string
  files: ReleaseFile[]
}

/**
 * The latest release of the downloadable copy, published beside the code
 * (SOURCE_URL), with each file's checksum. While there's none, the footer's
 * "Run locally (download)", its popup and the About page's downloads are left
 * out of the built pages (scripts/release.ts), which never describe a version
 * that doesn't exist.
 */
export const RELEASE: Release | undefined = undefined

/** A release file's download address, or '' while there's no published code. */
export function releaseLink(release: Release, file: ReleaseFile): string {
  if (!SOURCE_URL) return ''
  return `${SOURCE_URL}/releases/download/${release.tag}/${file.name}`
}
