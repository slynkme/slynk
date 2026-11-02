# Credits

Slynk is a thin layer on top of other people's hard work.

## The xx network

- **David Chaum** designed cMix, the mixnet that hides who talks to whom and
  that Slynk relies on for metadata privacy.
- **The xx foundation and xx network SEZC** built and run the xx network and
  wrote the xx client SDK (xxDK), including the file transfer module Slynk
  uses. xxDK is BSD 2-Clause licensed, Copyright (c) 2020 xx network SEZC; so
  is `xx_network/crypto`, and their other modules Slynk builds with (comms,
  crypto, ekv, primitives, ring) are BSD 2-Clause, Copyright © 2024 xx
  foundation.
  - Original code: gitlab.com/elixxir/client, mirrored at github.com/xxfoundation.
  - `third_party/xx_network-crypto` is their `xx_network/crypto` module, unmodified.
- **Rick Carback** (Richard T. Carback III) has made more commits than anyone
  else to much of the xx code Slynk builds on, by the GitHub mirrors' count on
  2026-11-01: xxDK itself (about 1,900 of its 8,300), both crypto modules
  (`elixxir/crypto` and `xx_network/crypto`) and the encrypted key-value store
  (`ekv`), and he's among the top three in comms and primitives. He's one of the
  three authors of xx's design documents (github.com/xxfoundation/elixxir-docs),
  with Benjamin Wenger and David Stainton, which Slynk's write-ups cite
  throughout. The BIP-39 code behind an inbox's 12 words is his fork of go-bip39
  (below).
- The xx node and gateway operators keep the mixnet running.

## Keith Millette

Keith's fork of xxDK, built for his Courier engine and co-nexx.us
(gitlab.com/keith16/client), fixes several file-transfer and cMix
reliability bugs that Slynk would otherwise hit. `third_party/xxdk-client` is
his `v4.8.5-courier.5` release. The fork is BSD 2-Clause licensed:
modifications Copyright (c) 2026 Keith Millette. See its `NOTICE` and
`FORK.md`.

## Password links

- **Argon2id** comes from Go's `golang.org/x/crypto/argon2` (BSD 3-Clause,
  Copyright (c) 2009 The Go Authors), which xxDK already depends on. It runs
  in the small helper module (`core/cmd/tools-wasm`).
- **Suggested passwords** use the BIP-39 English word list by Marek Palatinus,
  Pavol Rusnak, Aaron Voisine and Sean Bowe (BIP-39 is MIT licensed), as shipped
  in go-bip39 (MIT, Copyright (c) 2014-2018 Tyler Smith and contributors), in
  Rick Carback's fork that xxDK already uses (`github.com/rcarback/go-bip39`
  v1.1.1). Slynk leaves out some of its words (`web/src/ui/words.ts`). An
  inbox's 12 words are BIP-39 words too, from xx's own mnemonic code.

## Brotli

"Stronger compression" uses **Brotli**, designed at Google by Jyrki
Alakuijala and Zoltán Szabadka (MIT, Copyright (c) 2009, 2010, 2013-2016 by
the Brotli Authors), through **Andy Balholm's Go port**,
`github.com/andybalholm/brotli` v1.2.7 (MIT, under the Brotli Authors'
licence), translated from Google's C code. It runs in the small helper module
(`core/cmd/tools-wasm`). `third_party/andybalholm-brotli` is that release
without its tests and its web-server helper (`SLYNK.md` says what differs).

## Libraries in the web page

Every visit fetches these at the start, whatever it goes on to do, so the web
host's logs can't show which features someone used. Each keeps its own licence.

- **lean-qr** 2.7.4 (MIT, by David Evans) draws the "Show QR code" image.
- **jsQR** 1.4.0 (Apache-2.0, by Cosmo Wolfe and Jefff Nelson) reads an inbox's
  QR code from the camera or a photo, in the page, when its owner scans one.
- **fflate** 0.8.3 (MIT, by Arjun Barrett) builds the "Save all (.zip)" file on
  the recipient's device, and reads and writes the ZIP packages inside Office
  and OpenDocument files when hidden details are removed.
- **@xmldom/xmldom** 0.9.12 by Christopher J. Brody, jindw and the xmldom
  contributors (MIT) parses and writes XML in the cleaning worker, which has no
  built-in XML parser.
- **pdf-lib** 1.17.1 by Andrew Dillon (MIT) reads and rewrites PDFs when one is
  cleaned or made smaller. It brings along pako 1.0.11 by Vitaly Puzrin and
  Andrei Tuputcyn (MIT and Zlib), tslib 1.14.1 by Microsoft (0BSD),
  @pdf-lib/standard-fonts 1.0.0 by Andrew Dillon (MIT) and @pdf-lib/upng 1.0.1
  by Photopea (MIT). pdf-lib's stream decoders are adapted from pdf.js
  (Apache-2.0, Mozilla Foundation); pako's zlib code keeps zlib's licence (Jean-loup
  Gailly and Mark Adler); and standard-fonts, a fork of Christopher Brown's afm
  (MIT), carries the metrics of the 14 standard PDF fonts from Adobe's Core 14
  AFM files, under Adobe's notice (each font's copyright line is in its data).
- **pdf.js** (`pdfjs-dist`) 6.4.299 by Mozilla and the pdf.js contributors
  (Apache-2.0) draws PDFs' pages for "Show photo, media and document previews", in
  the page and its worker. Only its code and worker are used: none of its fonts,
  character maps, colour profiles or WebAssembly files.
- **Vite** 8.3.4 (MIT, VoidZero Inc. and Vite contributors) and **Rolldown**
  1.2.13 (MIT; its runtime helpers follow esbuild's, MIT, Evan Wallace) build
  the site, and leave a few small helpers in the page and its workers.

## Go code in the WebAssembly

The mixnet engine (`slynk-core.wasm`) and the small helper module
(`slynk-tools.wasm`: Argon2id and Brotli) are Go, compiled with Go's own standard library (BSD
3-Clause, The Go Authors), which also provides `wasm_exec.js`. Besides the xx
modules and Keith's fork above, the engine links about 50 Go modules, under the
BSD, MIT, Apache-2.0, ISC and CC0 licences: among them grpc and yaml.v3 (whose
NOTICE files go with them), protobuf, golang.org/x/crypto, net, sys and text,
and circl. Some carry more than their licence files say:

- **go-diceware** (MIT, Seth Vargo), which xx's crypto links, holds the EFF's
  word lists (2016, Electronic Frontier Foundation) and Arnold G. Reinhold's
  English Diceware word list, both under CC BY 4.0. Diceware is a trademark of
  A G Reinhold.
- **xx's crypto** includes code from the Go Cloud Development Kit
  (`broadcast/escape`, Copyright 2019 The Go Cloud Development Kit Authors,
  Apache-2.0).
- **libphonenumber** (MIT, Trey Tacon) is a Go port of Google's libphonenumber,
  and builds on its phone number data (Apache-2.0).

## Unicode data

- **Look-alike letters.** When two people who write to an inbox use names that
  look the same, the owner's page warns them. Which letters look like Latin
  letters and digits comes from Unicode's confusables data (UTS #39, version
  17.0.0, `confusables.txt`), Copyright © 2025 Unicode, Inc., under the
  Unicode License v3. `web/src/inbox/lookalikes.ts` is generated from it by
  `web/scripts/lookalikes.mjs`, keeping only those letters.

## Licences

Slynk's own code is BSD 2-Clause licensed (see `LICENSE`). Third-party code
keeps its original licence and notices; see `third_party/README.md`.

The minified site keeps no notices of its own, so the build writes
`licenses.txt` beside it, with every licence and notice above in full
(`web/scripts/licences.ts`, the Go side by `core/build-wasm.sh`). The About
page links to it under "Credits and licences".
