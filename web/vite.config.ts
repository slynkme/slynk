import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { builtFrom, footerText } from './scripts/commit.ts'
import { licences } from './scripts/licences.ts'
import { fillRelease } from './scripts/release.ts'
import { fillRules } from './scripts/rules.ts'
import { checkSiteName, fillSiteName } from './scripts/site-name.ts'
import { fillSourceLinks } from './scripts/source-links.ts'
import { INBOX_FILES, KEY_SERVER, ONE_TIME_ONLY, RELEASE, SITE_ADDRESS, SITE_NAME, type Release, VISIT_LOGS, releaseLink, sourceLink } from './src/site.ts'

// The live security headers live in public/.htaccess (deploy/webserver/deploy.sh gives Caddy the same ones).
// `vite preview` sends the same ones, so header-sensitive changes can be
// checked locally before deploying. The dev server can't: Vite injects inline
// styles while developing.
const securityHeaders = Object.fromEntries(
  [...readFileSync(new URL('./public/.htaccess', import.meta.url), 'utf8')
    .matchAll(/^Header always set ([\w-]+) "([^"]+)"$/gm)].map((m) => [m[1], m[2]]),
)
if (!securityHeaders['Content-Security-Policy']) {
  throw new Error('public/.htaccess: no "Header always set Content-Security-Policy" line found')
}
// The page may talk only to what the CSP lists, so a fork's key server (src/site.ts) must be there too.
const keyServerOrigin = new URL(KEY_SERVER).origin
if (!/connect-src ([^;]+)/.exec(securityHeaders['Content-Security-Policy'])?.[1].split(/\s+/).includes(keyServerOrigin)) {
  throw new Error(`public/.htaccess: the CSP's connect-src doesn't list the key server, ${keyServerOrigin} (src/site.ts KEY_SERVER)`)
}
checkSiteName(SITE_NAME, SITE_ADDRESS)

// A worker takes its CSP and COEP from its own response, so a cached worker
// keeps the headers it was served with. Workers' names therefore carry a hash
// of the security headers: changing one renames every worker, and they can be
// cached like the other assets, so starting one later fetches nothing and the
// host's logs can't tell who used what (src/preload.ts).
const headersTag = createHash('sha256').update(JSON.stringify(securityHeaders)).digest('hex').slice(0, 8)

// One-time links talk to slynk.me's key server (src/site.ts KEY_SERVER). In
// development the page uses /api/k instead, and the dev and preview servers
// pass /api on to port 8099: a key server run with -dev there
// (core/cmd/keyserver).
const api = { '/api': 'http://127.0.0.1:8099' }

// The downloadable copy's parts of the pages, from its latest release (src/site.ts
// RELEASE; left out while there's none: scripts/release.ts). To see them before
// there's a release, SLYNK_RELEASE_PREVIEW names a JSON file shaped like a
// Release, and the downloads point at example.invalid, which never resolves.
const previewRelease = process.env.SLYNK_RELEASE_PREVIEW
const release: Release | undefined = previewRelease ? JSON.parse(readFileSync(previewRelease, 'utf8')) : RELEASE
const releaseHref = previewRelease
  ? (f: { name: string }) => `https://example.invalid/slynk/releases/download/${release!.tag}/${f.name}`
  : (f: Release['files'][number]) => releaseLink(release!, f)

// licenses.txt: every licence of the code and data the site serves, from what
// the page's and the workers' bundles hold (scripts/licences.ts).
const licenceFile = licences()

// The commit this is built from, and when it was committed (scripts/commit.ts):
// never the build's own time, so the same commit builds to the same bytes.
const commit = builtFrom()
const BUILD = '<span id="build"></span>'

export default defineConfig({
  plugins: [
    // What's true with the site's rules (src/site.ts ONE_TIME_ONLY, INBOX_FILES, VISIT_LOGS): scripts/rules.ts.
    { name: 'slynk-rules', transformIndexHtml: (html) => fillRules(html, { ONE_TIME_ONLY, INBOX_FILES, VISIT_LOGS }) },
    // The site's name and address (src/site.ts), in the pages and in public/'s plain 404 page, copied as it is.
    {
      name: 'slynk-site-name',
      transformIndexHtml: (html) => fillSiteName(html, SITE_NAME, SITE_ADDRESS),
      writeBundle(options) {
        const file = join(options.dir!, '404.html')
        writeFileSync(file, fillSiteName(readFileSync(file, 'utf8'), SITE_NAME, SITE_ADDRESS))
      },
    },
    // Links to Slynk's published code, left out until it's published (src/site.ts SOURCE_URL).
    { name: 'slynk-source-links', transformIndexHtml: (html) => fillSourceLinks(html, sourceLink) },
    // The footer's "Run locally (download)" and the About page's downloads, once there's a release.
    { name: 'slynk-release', transformIndexHtml: (html) => fillRelease(html, release, releaseHref) },
    licenceFile.page,
    // The footer names the commit, so anyone can find its fingerprint list
    // (scripts/fingerprints.ts). Written into the page, not its code, so a
    // commit that changes nothing else renames no code file.
    {
      name: 'slynk-build',
      transformIndexHtml(html, ctx) {
        if (ctx.path === '/index.html' && !html.includes(BUILD)) throw new Error(`index.html: no ${BUILD} in the footer`)
        return html.replace(BUILD, `<span id="build">${footerText(commit)}</span>`)
      },
    },
  ],
  build: {
    // No source maps: they would publish the original source and file paths.
    sourcemap: false,
    // The app, and the About / FAQ page (served at /about/).
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        about: fileURLToPath(new URL('./about/index.html', import.meta.url)),
      },
    },
  },
  worker: {
    // ES module workers, so the strip worker can load each format's code as
    // its own chunk (the default IIFE format can't split code).
    format: 'es',
    plugins: () => [licenceFile.worker()],
    rolldownOptions: { output: { entryFileNames: `assets/[name]-[hash]-${headersTag}.js` } },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: api,
  },
  preview: {
    port: 4173,
    strictPort: true,
    headers: securityHeaders,
    proxy: api,
  },
})
