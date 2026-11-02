# The privacy choices behind Slynk, and why

*Slynk, 2026-10-31. All times UTC.*

Slynk is a private, link-based file and message drop on the xx network's cMix mixnet. A
Go core compiled to WebAssembly joins the mixnet from the visitor's browser, sends
encrypted pieces, and makes a link whose secret lives after the `#`. This page lists its
main design choices, most important first: what we chose, why, and what it costs. Fuller
write-ups are linked.

## In short

- The website logs nothing, serves every visit the same files, and lets the page contact
  only slynk.me's two servers and the xx network.
- One-time links keep half their key on a memory-only key server whose answers all look
  alike, among cover requests.
- The browser keeps nothing unless asked, and every visit is a new network identity.
- Inbox messages are fixed-size HPKE seals, with an optional quantum-safe address.
- Files are cleaned, shrunk and checked in the browser, and the live site can be checked
  against the published code.

## 1. What the website sees

### Every visit fetches the same files

Once the page and the mixnet engine have loaded, every visit fetches every optional part
of Slynk (the cleaner, pdf.js, the video worker, the helper module, the other workers),
whatever the visitor goes on to do ([web/src/preload.ts](../../web/src/preload.ts));
[web/test/uniform-loading.test.ts](../../web/test/uniform-loading.test.ts) fails if
anything loads on demand.

**Why:** a host's logs record each file a visit fetches, and their sizes show through HTTPS,
so code fetched when needed would show that someone added a PDF or used a password.

**Cost:** every visitor downloads code they may never use (cached after the first visit).

### No visit logs

slynk.me's own server runs Caddy with no request logs, leaving out even the error
messages that would name a request ([deploy/webserver/Caddyfile](../../deploy/webserver/Caddyfile));
its own messages and login records stay in memory. A copy on a host that logs sets
`VISIT_LOGS` ([web/src/site.ts](../../web/src/site.ts)), and its About page says so.

**Why:** what isn't kept can't leak or be demanded.

**Cost:** nothing to look back on for debugging or abuse, and the server's provider can
still see that an address connected.

### No third-party requests, and nothing in front of the site

The Content Security Policy in [web/public/.htaccess](../../web/public/.htaccess) lets the
page contact only slynk.me, its key server `k.slynk.me`, and the xx network's signed node
list (on Amazon S3), client registrar and gateways (`*.xxnode.io`). No inline scripts,
analytics, web fonts or embeds, and no CDN or proxy in front of the site.

**Why:** every outside request tells someone a visit happened, and a CDN or proxy decrypts
every request; many inject a bot-check script, which could read the link's secret after
the `#`.

**Cost:** no CDN speed or flood protection, and every library is served from slynk.me, so
Slynk uses few.

### Quantum-safe connections to slynk.me and its key server

Both servers accept the hybrid key exchange `X25519MLKEM768` (X25519 with ML-KEM-768,
NIST's post-quantum standard), checked with a client offering only that: the website
through Caddy 2.11 from Caddy's own package source, as Debian 13's Caddy 2.6 lacks it
([deploy/webserver/README.md](../../deploy/webserver/README.md)), the key server through
Go 1.26's TLS defaults ([core/cmd/keyserver/main.go](../../core/cmd/keyserver/main.go)).

**Why:** the key server's half of each link's key travels in them, and a recording could
otherwise be opened by a future quantum computer.

**Cost:** older browsers fall back to classical key exchange, and Caddy comes from outside
Debian. Connections to the xx network's gateways remain classical
([quantum safety](quantum-safety.md)).

## 2. The key server and one-time links

### A key server apart from the website, in memory only

A one-time link splits the outer key of what it opens in two: one half in the link, the
other on slynk.me's key server ([core/keyserver/](../../core/keyserver/)), which hands it
out once and deletes it. On its own small server, it keeps the halves only in memory
(locked, never swapped or dumped; saved only at a clean shutdown, and destroyed at the next
start), logs nothing about requests, and stores no internet addresses.

**Why:** the mixnet can't delete (gateways keep data about three weeks), so a used link is
made useless by destroying a key, which must live where nothing, such as a web host's
backups, copies it.

**Cost:** a second server to run and trust. Its provider can read a virtual machine's
memory, and a crash loses every waiting link. A dishonest key server still never sees a
link or what it opens: [one-time links](one-time-links.md).

### Every answer looks alike, among cover requests

Every request is 256 bytes, and every POST gets HTTP 200 and exactly 128 bytes, no sooner
than 0.1 s, whatever happened (an overloaded server answers at once)
([core/keyserver/server.go](../../core/keyserver/server.go)). Every open tab of the app
also sends holds on random IDs at random moments, one per 25 s on average and six times as
often in its first minute ([web/src/burnCover.ts](../../web/src/burnCover.ts)); where it
can, a real request takes a cover one's place. They're on by default.

**Why:** sizes and timing show through encryption, and anyone who sees who talks to the key
server would otherwise see exactly the visits that made or opened a link.

**Cost:** padding, delay and more load (a real request may wait up to 8 s for a slot in
the first minute). It hides which visitors used a link, not that they visited.

### Every link opens once

slynk.me makes and opens one-time links only (`ONE_TIME_ONLY` in
[web/src/site.ts](../../web/src/site.ts)), and the key server enforces it too. Nothing
connects until the opener taps, and the tap holds the link for them for 15 minutes.

**Why:** slynk.me is for one person passing something to another. A widely shared link
would send crowds, each a new identity and a full download, to a mixnet that can't carry
them, and could spread harm under Slynk's name; and the recipient can tell if someone else
opened it first.

**Cost:** no links for a group, and the first opener gets it. A fork can turn the rule off:
[why links open once](why-links-open-once.md).

## 3. What stays on the visitor's device

### Nothing kept unless the visitor asks

The identity and all its state live in the worker's memory
([core/transfer/memkv.go](../../core/transfer/memkv.go)). No localStorage, IndexedDB or
cookies, but for three opt-in exceptions, off by default: "Remember these settings", and
keeping an inbox and remembering its passphrase (below).
[web/test/inbox-kept.test.ts](../../web/test/inbox-kept.test.ts) fails if storage is
touched anywhere else.

**Why:** browser storage outlives the visit, for anyone who later uses the device.

**Cost:** closing the tab loses everything: settings, an open inbox, a link not yet copied.

### A new identity for every visit

Each visit joins the xx network as a brand-new identity, made in memory when the visitor
starts writing, adds a file or opens a link. Messages to an inbox never go from an identity
that makes links or checks an inbox: a tab that does both connects a second identity.

**Why:** visits stay unlinkable, with no long-term identity to follow or find on the device.

**Cost:** joining takes about 12 to 27 s, and every new identity is admitted by the network's
central registrar, only so many a day network-wide:
[network identities](network-identities.md).

### Keeping an inbox on the device, if asked

"Keep this inbox on this device" keeps messages, folders, names, replies and blocked
senders (never files) in one IndexedDB record, sealed with AES-256-GCM under a key worked
out from the inbox's 12 words, never the words themselves
([web/src/inbox/kept.ts](../../web/src/inbox/kept.ts)). The record's name comes from the
same secret, its contents are padded to multiples of 16 KiB, and "Forget this device"
deletes it.

**Why:** keeping messages beyond the network's three weeks, or blocking a sender, needs a
place, and the device is the one that isn't someone else's.

**Cost:** anyone using the device can tell something is kept (not what), and the device
plus the words reads it all.

### Remembering the passphrase, if asked

"Remember my passphrase", offered only on the inbox's own screens with the warnings in
sight, keeps its 12 words on the device. Without a password they're kept as they are (any
key to seal them would sit beside them), and the inbox opens with a tap; with one, they're
sealed with Argon2id and AES-256-GCM, which then guards the kept record too.

**Why:** typing 12 words on a phone every time drives people to store them somewhere worse.

**Cost:** without a password, anyone using that browser can open the inbox and write as its
owner, and the words can never be changed. A passkey unlock was set aside:
[passkey unlock](../ideas/passkey-unlock.md).

## 4. On the mixnet

### Links keep their secrets in the link

What a link opens is encrypted under keys that travel only after the `#`, which browsers
never send to a server and the page wipes from the address bar: xxDK's 256-bit
file-transfer key (XChaCha20) with the file's MAC, and for a one-time link, the link's half
of an outer key.

**Why:** nothing on the network or at slynk.me can open a file without the link, and as
these symmetric keys never cross the mixnet, a recording of it stays closed even to a
future quantum computer.

**Cost:** whoever has the link can open it; a password adds a second secret:
[link and envelope format](link-and-envelope-format.md).

### Uploads confirmed by their rounds, not by reading parts back

A piece counts as delivered once its round reports Succeeded
([confirmByRound.go](../../third_party/xxdk-client/channelsFileTransfer/confirmByRound.go)),
where xxDK's default has the sender download every piece back.

**Why:** reading back polled the pickup address from the sender's own internet address,
tying the sender to the address every recipient later polls.

**Cost:** Succeeded doesn't prove a gateway stored the piece, and one lost after that isn't
resent. Gateways still see each round's senders and recipients, so a many-round upload can
still be matched to its pickup address: [gateway metadata](gateway-metadata.md).

### Cover messages, opt-in

With Settings → Cover messages on, a connected tab sends blank messages to random
recipients, each shaped exactly like a one-piece inbox message: one to five every 5 to
55 s (xx Messenger's original pace), one or two every 2 to 18 minutes after half an hour
without a transfer ([core/transfer/cover.go](../../core/transfer/cover.go)).

**Why opt-in:** each is stored on its round's gateways for about three weeks, on shared
capacity, and costs data and battery; and it can't disguise a many-piece upload. The cost:
few turn it on, so the crowd is small.

### Stopping an upload

xxDK's file transfer can't cancel an upload under way, so Slynk adds `CancelUpload`, which
fails the transfer on purpose: the identity stays connected, and an inbox open in the tab
stays open, where ending the mixnet worker would close it and spend another identity.

**Cost:** batches already waiting for their rounds still go, at most one per sending worker
(four; on mainnet on 2026-10-17, three, within 2 s): [stopping an upload](cancel-upload.md).

## 5. Inboxes

### Inbox messages are sealed with HPKE, not with xx's message types

Each inbox message is sealed with HPKE (RFC 9180, the IETF standard for sealing a message
to a public key: X25519, HKDF-SHA256, ChaCha20-Poly1305) from Go's standard library, and
sent as a plain cMix message ([core/transfer/inbox.go](../../core/transfer/inbox.go)), the
send xxDK's comments reserve for "implementing a protocol on top".

**Why** not xxDK's message types, for an anonymous public inbox:
- **Direct messages** are built for two people who know each other: each carries the
  sender's long-term identity, copies itself to the sender's own mailbox, and goes to a
  mailbox found with a token, where an inbox needs one anyone can work out from a printed
  address. And a crafted key can crash the code DMs use (`Edwards2EcdhNikePublicKey`
  ignores `FromEdwards`'s error, then `DeriveSecret` panics): [the inbox](inbox.md),
  section 11.
- **Single-use requests** carry a tag made from the recipient's ID and an app's chosen
  word, so anyone who knows both can pick them out. An inbox's messages look like random
  bytes, the sender's one-time key included (encoded with Elligator 2).
- **Partner messaging** needs a two-way handshake first, and its quantum-resistant layer
  used SIDH, broken in 2022.

HPKE uses the same ingredients as xx's DMs (X25519, ChaCha20-Poly1305), and has a standard
quantum-safe mode.

**Cost:** a protocol of Slynk's own, so its soundness rests on Slynk's code and tests. And
anyone with the address can collect an inbox's messages, still encrypted, as anyone can a
Haven user's DMs once they've seen the user's DM token in a public channel. What differs
is the sender: no sender identity unless they include their own inbox, and an identity
made for that visit.

### Every message is one fixed size

A message to an inbox is one cMix piece (two to a quantum-safe address), padded to one
size for its kind. With the fingerprint and MAC fields used for message bytes, as xx's DMs
do, and raw DEFLATE where it helps, that's 924 bytes (an English letter of about 1,800
characters), or 652 to a quantum-safe address
([web/src/inbox/address.ts](../../web/src/inbox/address.ts)).

**Why:** length then gives nothing away, and long messages aren't split, since each extra
piece makes a sender rarer. Haven caps messages too, at 700 characters once compressed and
base64-encoded; the co-nexx.us app at 700 bytes of text.

**Cost:** a length limit. And the page sends a quantum-safe message's two pieces about 10
to 25 s apart, each in its own round ([core/transfer/apart.go](../../core/transfer/apart.go)),
because two pieces to one mailbox in one round is a shape hardly anything else makes.

### Messages are sealed to their round

Each inbox message seals the number of its round, and the owner drops any found in another
round, as xx's DMs do. xxDK asks for the message afresh for every round it tries, so retries
still work, and a random 8-byte ID shows a retry that arrived twice only once.

**Why:** anyone with the address can fetch a stored message; a copy sent again later can't
pass for new.

**Cost:** 12 bytes of room (the round and the ID), and a fresh seal for every try.

### An optional quantum-safe address

An inbox's usual address is its Ed25519 key, whose scalar is also its X25519 key, so a
message to it could be recorded now and opened by a large quantum computer later. So every
inbox also has a quantum-safe address from the same 12 words, sealed with HPKE's hybrid of
ML-KEM-768 and X25519 (X-Wing), private while either holds
([core/transfer/inbox4.go](../../core/transfer/inbox4.go)). The inbox signs its ML-KEM key,
so nobody can pass their own off as its; the second piece starts with an 8-byte tag from
the X25519 shared secret, so the owner looks pairs up rather than trying every pair.

**Why optional:** a longer address, a denser QR code, and on today's quiet network a
two-piece sender is easier to pick out: [quantum safety](quantum-safety.md).

### No files to inboxes on slynk.me

Slynk's code can send files and longer messages to an inbox, as an upload whose link goes
in a one-piece message, but slynk.me leaves it off (`INBOX_FILES` in
[web/src/site.ts](../../web/src/site.ts)), and its owners' pages don't collect such uploads
from other copies.

**Why:** while the network is quiet, someone running a gateway could sometimes match a
many-piece upload to the address it came from and to the inbox, whose owner is often
public.

**Cost:** inboxes on slynk.me take text only.

## 6. Files

### Hidden details cleaned by default, on the device

Before sending, a worker in the sender's browser removes hidden details (where a photo was
taken, the device, dates, a document's author and history) from most photos and videos,
MP3 and FLAC audio, SVG, PDF, Office, OpenDocument and RTF files
([web/src/strip/](../../web/src/strip/)), on by default.

**Why:** most people don't know these details are there, and the files never leave the
device to be cleaned.

**Cost:** it can't remove what can be seen, or a camera's own patterns; signed,
password-protected and older Office files (.doc, .xls, .ppt) are left as they are; and
"Hidden details were removed" is the sender's word, not proof:
[hidden-data cleaning](hidden-data-cleaning.md).

### Files made smaller in the browser, mostly with Slynk's own code

Files are made smaller on the sender's device (as small as they'll go by default; Settings can
choose only to fit, or to ask) with the browser's own
abilities: photos redrawn on a canvas; HEIC read by Slynk's own HEIF reader for the
browser's HEVC decoder; video and audio re-encoded (H.264, Opus) with WebCodecs into
Slynk's own MP4 writer, which zeroes every time field and names no device or software
([web/src/video/mux.ts](../../web/src/video/mux.ts)); pictures in PDFs and Office files
shrunk with pdf-lib and fflate, which the cleaner already uses. "Stronger compression" adds
one new library, a Go port of Brotli, whose smaller result replaces the deflated file when
ready.

**Why:** the limit is 2 MB at about 8 KB a second; every library is fetched by every
visitor and is more code to trust; and a remade file carries none of the original's
hidden details.

**Cost:** more of Slynk's own code to review, and support varies by browser and device.
Other apps can reuse the whole pipeline: [preparing files for the mixnet](preparing-files.md).

### Plain warnings for recipients

When a file arrives, the recipient's browser checks what kind of file it is and what's
packed in it: a program, macros, scripts, or a document that contacts the internet when
opened, and the same for each file in a zip
([web/src/filecheck/check.ts](../../web/src/filecheck/check.ts)). It reads structure, never
what a picture or recording shows, and only recipients see the warnings.

**Why:** recipients didn't choose what arrives, and nothing is sent anywhere to check.

**Cost:** it isn't a virus scanner (whose signature lists every visitor would fetch, daily),
and a file without a warning can still be harmful.

## 7. Checking the code

### Verifiable, reproducible builds

Each version of slynk.me is built by GitHub Actions from the published code, with
`SHA256SUMS.txt`, every file's SHA-256, in the `deploy` branch
([web/scripts/fingerprints.ts](../../web/scripts/fingerprints.ts)). The same commit always
builds to the same bytes, so anyone can rebuild and compare, and
[deploy/check-site.sh](../../deploy/check-site.sh) compares every file and security header
slynk.me serves with that list. The page's footer names the version.

**Why:** a website is sent afresh on every visit, so open code means little unless the site
can be checked against it.

**Cost:** builds must stay deterministic. And no outside check can catch a changed page
sent to one person: only the visitor's own browser could, and nothing does that yet.

## Sources

- HPKE: RFC 9180. ML-KEM: NIST FIPS 203. X-Wing: draft-connolly-cfrg-xwing-kem. The TLS
  hybrid: draft-ietf-tls-ecdhe-mlkem (`X25519MLKEM768`).
- Thormarker, "On using the same key pair for Ed25519 and an X25519 based KEM", IACR ePrint
  2021/509.
- xxDK v4.8.4, `github.com/xxfoundation/elixxir-client` (tag `v4.8.4`): `cmix/interface.go`,
  `dm/send.go`, `dm/receiver.go`, `single/`, `auth/`. `gitlab.com/elixxir/crypto` v0.0.15,
  the version xxDK v4.8.4 requires: `nike/ecdh/ecdh.go`, `nike/ecdh/edwards.go`,
  `sih/service.go`.
- Keith Millette's fork of xxDK, `gitlab.com/keith16/client`, tag `v4.8.5-courier.5`,
  vendored in [third_party/xxdk-client/](../../third_party/xxdk-client/) with Slynk's
  changes marked `Slynk:` ([xxDK changes](xxdk-changes.md)).
- Haven's web app, version 0.4.0 by its `package.json`: `MESSAGE_MAX_SIZE` in
  `src/components/common/ChannelChat/UserTextArea/UserTextArea.tsx`;
  `src/utils/compression.ts`; `src/contexts/dm-client-context.tsx`.
- The co-nexx.us app, `gitlab.com/co-nexx-us/app`, commit `6c4ffee`:
  `src/lib/messageLimits.ts`.
- Brotli: `github.com/andybalholm/brotli` v1.2.7, vendored in
  [third_party/andybalholm-brotli/](../../third_party/andybalholm-brotli/).

## Credits

Thanks to David Chaum and the cMix authors, and to the xx foundation, for cMix, the xx
network and xxDK; to Rick Carback, the leading contributor to xxDK and xx's crypto code; to
Keith Millette, whose fork's file-transfer fixes Slynk builds on; and to the authors of
Brotli, pdf-lib, pdf.js, fflate and the other libraries in [CREDITS.md](../../CREDITS.md).

— Slynk
