# Slynk

A private, link-based drop for files and messages, carried by the
[xx network](https://xx.network)'s cMix mixnet. Everything happens in your browser and in
memory: no accounts, no tracking, nothing kept. Live at **https://slynk.me**.

Slynk is free and non-commercial, a gift to the xx community.

## What it does

- Send a message, up to 200 files, or both, as long as the whole bundle is at most
  2 MB after compression. You get a link, and the recipient can open it any time while
  the network holds the data (up to about three weeks).
- Photos, videos, audio, PDFs and Office documents are made smaller in the browser
  before they're sent: as small as they'll go by default, or only enough to fit, or
  only when you ask (Settings).
- Hidden information is removed from files before they leave your browser: things
  like GPS location and camera details in photos and videos, author names and editing
  history in documents, and audio tags. This is on by default.
- Every link is a **one-time link** (burn after reading): it opens once, for one
  person, and stops working after 1 hour, 1 day, 7 days or up to 3 weeks if nobody
  opens it, with a "Cancel this link" button. A password can be added too. One-time
  links are slynk.me's own rule (`web/src/site.ts`); see the About page for why.
- An **anonymous inbox**: anyone can write to it without an account, and its owner
  opens it with 12 words. Replies between inboxes, a quantum-safe address and keeping
  the inbox on your device are all there if you want them.
- The recipient sees previews of photos, videos, audio and documents, and a plain
  warning on files that could run as programs. Nothing in a file runs on the page.
- A QR code for a link or an inbox, shown only when you ask for it.
- No server ever sees your data or your link's secret.

## How it works

1. **Joining.** When you start sending or open a link, your browser joins the mixnet
   as a brand-new identity. That identity lives only in this tab's memory. The client
   is the xx network's Go SDK (xxDK), compiled to WebAssembly and run in a Web Worker.
2. **Uploading.** Your bundle is encrypted and split into pieces of about 900 bytes.
   xxDK's file transfer sends them to a random, single-use recipient ID, and cMix
   rounds shuffle them with everyone else's traffic.
3. **The link.** The link carries the file's key, plus where and when to collect it.
   All of that is after the `#`, the URL fragment, which browsers never send to a
   server. The page also wipes it from the address bar after reading it.
4. **Collecting.** The recipient's browser joins as another fresh identity, collects
   the pieces, and checks every piece and the whole file against the link before
   showing anything.
5. **The key server.** slynk.me serves the page, and its key server
   (`core/cmd/keyserver`, on a small server of its own) holds half of each link's extra
   key, a random 32-byte share and never your data or link, in memory only, until the
   link is used, cancelled or expires. (A copy of Slynk without slynk.me's one-time
   rule can also make ordinary links, which need no key server.)
6. **Inboxes.** A message to an inbox is sealed for its owner and left at the inbox's
   own address on the network. The owner's browser joins as a fresh identity, looks
   back through the network's history for it, and opens what's theirs.

The technical write-ups in [`docs/findings/`](docs/findings/) go deeper: how each part
works, the choices behind them, and what we learned about the xx network.

**For your own app.** The code that cleans, shrinks and compresses every file sent on
slynk.me is offered for other apps too: one function, `prepareFiles`, with Slynk's
defaults and settings as options, and a demo in `web/examples/file-prep/`. Slynk is its
worked example. See
[`docs/findings/preparing-files.md`](docs/findings/preparing-files.md).

## Privacy, honestly

- **Content.** It's encrypted end to end. Only someone with the link can read it.
- **Metadata.** The mixnet is built to hide who sent what to whom, and it works better
  the more people use it. Your IP address never travels through the mix itself, but
  the network's gateways see it, along with how many pieces you send in each round,
  and share that with each other. While the network is quiet, one curious gateway
  operator could match a large upload to its link. Use a VPN if your IP address
  matters to you. The details are in
  [`docs/findings/gateway-metadata.md`](docs/findings/gateway-metadata.md).
- **Hosting.** slynk.me's website keeps no visit logs. The hosting providers of the
  website and its key server can still see which IP addresses connect, and when. None of
  them ever sees what you send.
- **Details.** The privacy choices behind Slynk, and why, are in
  [`docs/findings/decisions.md`](docs/findings/decisions.md).

## Quick start

You need [Go](https://go.dev/dl/) 1.26 or newer (the site is built with 1.27.2) and
[Node.js](https://nodejs.org/) 24.

```bash
git clone https://github.com/slynkme/slynk.git
cd slynk/web
npm ci
npm run build:core   # builds the Go core to WebAssembly; repeat after changing core/ or third_party/
npm run dev          # http://localhost:5173
```

The first `build:core` downloads about 300 MB of Go modules and takes a few minutes.
Testing on the real network costs one new xx identity per page that sends or receives,
so please don't reload in loops. The network's registrar admits only so many new
identities a day for everyone.

### Production build

```bash
cd web
npm run build          # type-checks and builds into web/dist
npm run build:deploy   # the same, plus .wasm.br/.wasm.gz copies (the core is ~40 MB raw,
                       # 6 MB brotli) and SHA256SUMS.txt, as CI deploys it
```

**Checking slynk.me.** `deploy/check-site.sh` compares every file slynk.me serves with
the SHA-256 list CI publishes in the `deploy` branch. The footer names the commit it was
built from, and that commit always builds to the same bytes: `npm ci && npm run
build:deploy` with the Node and Go versions in `.github/workflows/deploy.yml` gives the
same `web/dist/SHA256SUMS.txt`.

`web/dist` is a static site. To host it yourself you need:
- **A host that can set response headers.** `web/public/.htaccess` (read by Apache and
  the servers compatible with it) has the strict Content-Security-Policy and the other
  security headers. Translate them for other servers: slynk.me itself runs on Caddy,
  and `deploy/webserver/` has its set-up.
- **The pre-compressed core.** Serve `.wasm.br` or `.wasm.gz` with the right
  `Content-Encoding`; the `.htaccess` shows how.
- **No CDN that injects scripts.** Bot-check JavaScript could read the URL fragment.
- **A key server, for one-time and expiring links.** `deploy/keyserver/README.md` sets
  one up on a small server of its own. With slynk.me's rule every link needs it.

### Your own version

Everything that makes the site slynk.me is in one file, `web/src/site.ts`:

- **`SITE_NAME` and `SITE_ADDRESS`:** the name and address the pages show, and the
  address every link and inbox address begins with (`https://SITE_ADDRESS/#…`), even
  when the page runs from a downloaded copy. The pages are written with "Slynk" and
  "slynk.me", and the build puts yours in their place.
- **`ONE_TIME_ONLY`:** slynk.me's rule that every link opens once (the About page says
  why). Set it to `false`, and run your key server with `-one-time-only=false`: the page
  then also makes ordinary links (which need no key server) and links that expire
  sooner, and opens them any number of times, and its wording follows. The choice, and
  what comes of it, is yours.
- **`INBOX_FILES`:** files and longer messages to anonymous inboxes, off on slynk.me (the
  About page says why). Switch it on, and the About page's inbox answers follow.
- **`VISIT_LOGS`:** whether your website keeps visit logs. slynk.me's keeps none
  (`deploy/webserver/`), but most web hosts do: if yours does, set it to `true`, and the
  About page says so.
- **`KEY_SERVER`:** your key server's address. Add it to the CSP's `connect-src` in
  `web/public/.htaccess` (the build stops if it's missing), and list your site's address,
  and your downloadable copy's if you offer one, in the key server's `-allow-origin`.
- **`SOURCE_URL`, `LOCAL_ORIGIN` and `RELEASE`:** where your code is published, the
  address your downloadable copy serves its page at (choose a port of your own), and its
  latest release.

Slynk's credits and licence stay as they are.

### Command line

```bash
go -C core build -trimpath -o slynk-cli ./cmd/slynk-cli
./slynk-cli send FILE        # prints a link
./slynk-cli receive LINK OUT
```

The CLI uses the same core as the browser. For now it moves raw bytes rather than the
website's bundle format, so its links are for the CLI, not for slynk.me. Its links and
inbox addresses begin `https://slynk.me/#`; `SLYNK_SITE=https://example.org` gives your
site's instead.

### Tests

```bash
go -C core test ./transfer/                                            # links, inboxes, sealing
go -C core test gitlab.com/elixxir/client/v4/channelsFileTransfer/...  # the patched file transfer
npm --prefix web test                                                  # the website's tests
```

## Layout

| Path | What it is |
|---|---|
| `web/` | The website: Vite + TypeScript, no UI framework |
| `core/` | The Go core (`transfer/`), its WebAssembly bridge, the CLI and the key server |
| `third_party/` | The xx Go modules we build against, with our changes marked (see its README) |
| `deploy/` | How slynk.me's web server and key server are set up, and `check-site.sh` |
| `lab/` | Experiments: the native mixnet smoke test, the quantum-safe inbox prototype, the downloadable copy |
| `docs/findings/` | Technical write-ups: how Slynk works, the choices behind it, and what we found about the xx network |
| `docs/ideas/` | Ideas researched but not built |
| `web/examples/file-prep/` | Slynk's file pipeline (cleaning, shrinking, compression) as an example for your own app |
| `.github/workflows/` | The build that publishes the site |

## Credits and licence

Slynk stands on David Chaum's cMix, the xx foundation's network and SDK (Rick Carback
its leading contributor), and Keith Millette's fork of that SDK. See [`CREDITS.md`](CREDITS.md). Slynk's own code is BSD
2-Clause licensed ([`LICENSE`](LICENSE)); third-party code keeps its own licence.
