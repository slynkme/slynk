# Running Slynk locally (prototype)

A small program that serves a built copy of Slynk's website on your own computer, at
`http://127.0.0.1:8293/`, so the page runs from files you downloaded instead of from
slynk.me on every visit. It's an experiment to see what that takes, not a release.

It does what a plain file server can't:

- **Sends slynk.me's security headers**, read from the site's own `.htaccess`: the
  Content-Security-Policy (for the page *and* its workers, which take theirs from their
  own response), cross-origin isolation (COOP, COEP, CORP), no framing by other sites,
  the Permissions-Policy and `no-referrer`. HSTS is left out: browsers ignore it over
  plain http.
- **Serves the compressed WebAssembly.** A published build has only `.wasm.br` and
  `.wasm.gz` copies of the mixnet engine (39.9 MB raw); this serves the one the browser
  accepts, as `.htaccess` does, or unpacks the gzip copy for a browser that takes
  neither.

Everything else is the page's own work, as on slynk.me: the browser talks to the xx
network and to slynk.me's key server itself. The key server answers pages at
`http://127.0.0.1:8293` as well as `https://slynk.me` (its `-allow-origin`), so
one-time links work only on that port.

It listens on 127.0.0.1 only (not your local network), answers only requests addressed
to `127.0.0.1:<port>` (so another name pointed at your computer gets nothing; a page
opened as `localhost:<port>` is sent to `127.0.0.1:<port>`), never serves hidden files
such as `.htaccess`, and writes no log.

## What people see

Nothing of the program's own (a Terminal or black window puzzles people). Slynk opens in a window of its own (Chrome, Edge or Brave as an app, with
Slynk's own profile: no address bar, extensions or account; `browser.go`), or in the usual
browser without one of them. Closing it stops the program (`lifetime.go`): each Slynk page
holds a connection to `/api/alive` and says it's going on `/api/bye`
(`web/src/ui/localLinks.ts`), so it stops 10 s after the last page says so (a reload or the
About page connects again first), as soon after the browser it started ends, or after 30
minutes with no page at all. It closes the browser it started as it stops, gently: on a
Mac a browser keeps running with no window. Problems ("another program is using
127.0.0.1:8293") go in a message box when there's no terminal to print them in.

- **Windows:** `slynk.exe`, built with `-H=windowsgui` (no console window), carries
  Slynk's icon and its name, from `rsrc_windows_amd64.syso`.
- **Mac:** `Slynk.app` (`mac/Info.plist`, `slynk.icns`): background-only, so no Dock icon
  of its own; macOS 13 or later. Not signed by Apple, so the first time it takes Privacy &
  Security's Open Anyway (the About page's steps).
- **Linux:** the first run adds Slynk to the apps menu, with its logo, opening no terminal.

`icons/icons.mjs` makes the icon files from the logo; run it only when the logo changes.

## Try it

Build the site as usual, outside this folder:

```bash
npm --prefix web run build:core
cd web && npx vite build --outDir "$HOME/.cache/slynk-local-build/site" && cd ..
```

(`precompress.mjs` writes into `web/dist`, so to test the compressed copies, build into
`web/dist` on a machine where nothing else uses it, run `node scripts/precompress.mjs
--drop-raw`, and copy `dist` out.)

Then run it from this folder:

```bash
go build -trimpath -buildvcs=false -o slynk-local . && ./slynk-local -site "$HOME/.cache/slynk-local-build/site"
```

It opens Slynk's window when it starts, and stops once that closes. `-open=false` opens
nothing, `-stay` keeps it running until Ctrl+C (both for development), and `-port`
changes the port (but see below). To keep tests off the live key server, build the site
with `VITE_KEY_SERVER` pointing at a local one; the CSP must then allow it too.

**The downloads:** `package.sh SITE OUT_DIR` packs them from a site built with `npm run
build:deploy`: the site (gzip copies only) inside the program (`-tags
embed`, `embed.go`), for Windows (`slynk.exe`), both kinds of Mac (`Slynk.app`, zipped)
and Linux (zipped), about 13.5 MB each, with `SHA256SUMS.txt`. The same site always packs
into the same bytes, so a release can be rebuilt and checked. The release workflow
(`.github/workflows/release.yml`, run by hand) runs it, and `build-test.sh OUT_DIR` makes
test copies from the last commit the same way.

## Keep the address the same

The browser keeps Slynk's settings and kept inboxes per address *and* port, and the key
server answers only the one address. Run it on another port, or serve it as `localhost`
instead of `127.0.0.1` (this program sends `localhost` to `127.0.0.1`), and Slynk starts
empty (the data is still there, under the old address) and can't make links. So the
program refuses to start if its port is taken rather than pick another one (checked on
Linux; macOS and Windows may let it share a port with a program listening on all
addresses, which a real version must rule out).

## Not done here

Links made here begin `https://slynk.me/#`, so anyone can open them: the page builds them
from the site's address, not its own (`web/src/home.ts`). A slynk.me link in a message
opens in this copy. One clicked anywhere else opens on slynk.me in the browser; to open it
here, replace `https://slynk.me` with `http://127.0.0.1:8293` in the address bar, until the
page has its box to paste a link into (shown only off slynk.me).
