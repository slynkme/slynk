# One-time links, the key server and cover requests

*Slynk, 2026-10-31. All times UTC.*

Every link slynk.me makes opens once. The xx network can't delete what it stores, so a
link is "burnt" by destroying a key instead: half of it lives in the link, the other half
on slynk.me's key server, which hands it out once and then forgets it. This piece covers
that design, the key server as it runs today, the defences around it, and what it can't
do. It's for xx network developers and anyone who wants to check Slynk's privacy claims
against the code.

## In short

- What a link carries is sealed a second time, under a key made from two random halves:
  `L` in the link, `S` on the key server, which never sees `L`, the link or the item.
- The key server keeps every `S` in memory only, and writes them to disk only at a clean
  shutdown, destroying that file at the next start before it answers anything.
- A recipient's tap holds the link; one claim hands `S` over; a tombstone keeps the ID
  taken until the link would have expired.
- Every request is answered with HTTP 200 and 128 bytes, after at least 0.1 s, and every
  open tab sends cover requests that real requests replace where they can.
- New links carry a small proof of work and are limited to 600 at once, then 60 a minute.
- None of this hides who you are. A VPN or Tor does that.

## 1. Why the mixnet can't burn anything

A Slynk upload is a set of encrypted pieces, about 920 bytes each, sent through cMix
rounds to a random single-use recipient ID. Gateways keep each round's messages so that
recipients can collect them later, and serve them to anyone who asks with the right
ephemeral ID and round. Collecting only reads them.

The gateway service in comms v0.0.6 (`service Gateway` in `mixmessages/mixmessages.proto`)
has calls to register, send, poll and fetch messages, and none to delete one. Gateways
drop stored rounds and their messages in bulk, by age: each deletes everything older than
a cut-off the network's permissioning server sends it (the gateway's `clearOldStorage`,
from the permissioning server's `messageRetentionLimit`). The live setting isn't
published; xxDK assumes 500 hours (`NetworkRetention`), and Slynk collected links 18 days
old on mainnet on 2026-10-31 ([notes.md](notes.md)). Each round is run by a team of five
nodes on mainnet, and clients may collect from any of the team's gateways
([third_party/xxdk-client/cmix/pickup/retrieve.go](../../third_party/xxdk-client/cmix/pickup/retrieve.go)).
A delete call would be hard to add: ephemeral IDs are deliberately shared by many clients,
so deleting "your" messages would mean proving which ID is yours.

So for up to about three weeks every link's pieces stay on the gateways of the rounds
that carried them. What can be destroyed is a key.

## 2. A key in two halves

[web/src/burn.ts](../../web/src/burn.ts) adds a layer on top of xxDK's own encryption.
When someone sends, the page makes `L` (32 random bytes, for the link), `S` (32 random
bytes, for the key server) and a 16-byte cancel token. The key is
`K = HKDF-SHA256(L || S)` with fixed labels, used for AES-256-GCM and held by WebCrypto as
a non-extractable key. The key server files `S` under an ID derived from `L`
(`HKDF-SHA256(L)`, 16 bytes), which can't be turned back into `L`. The page stores `S`
(`put`), seals the item, wipes `S`, uploads, and puts `L` in the link (the 183-byte format
is in [link-and-envelope-format.md](link-and-envelope-format.md)).

A recipient needs both halves. The link is useless once `S` is gone, and `S` is useless
without the link: the key server doesn't even know the link's recipient ID, so it couldn't
find the pieces.

The key server runs on a machine of its own, apart from the web server, so the website
never holds a half.

## 3. The protocol

Every request is a 256-byte JSON body padded with dots, sent by `POST` as `text/plain`, so
a browser sends it to another origin without a CORS preflight. The key server
([core/keyserver/protocol.go](../../core/keyserver/protocol.go),
[store.go](../../core/keyserver/store.go)) has six operations; slynk.me uses five.

| Operation | Sent by | What it does |
|---|---|---|
| `put` | sender | stores `S`, its mode, expiry and the cancel token's hash, if the puzzle is solved |
| `hold` | recipient's tap | keeps others out for 15 minutes; hands nothing out |
| `claim` | recipient, after the download | hands `S` over once, to the nonce holding the link |
| `done` | recipient | lets the key server delete `S` now |
| `revoke` | sender ("Cancel this link") | replaces the record with a tombstone, given the cancel token |
| `get` | forks only | hands out an expiring link's `S` without using it up |

**The tap before claiming.** Mail and chat services, and some scanners, open links on
their own, so opening a link does nothing by itself, and nothing joins the mixnet until
the recipient presses Open it now. That tap sends `hold` with a random 16-byte nonce kept
in the tab. Anyone else who taps in the next 15 minutes is told "Someone else is opening
this link" before downloading anything. After the download and any password check, the
same tab sends `claim` with the same nonce, opens the item and sends `done`. An unclaimed
hold lapses after 15 minutes. (So anyone with a link can tell whether it's still waiting,
but only by starting to open it.)

**Retries.** A claim whose answer was lost can be repeated with the same nonce, and only
that nonce, for 10 minutes. `done` turns the claim into a tombstone without `S` at once;
the opener's page sends it as soon as the item is open (in the next cover slot, or at
once if the tab is hidden or closed). Without a `done`, the claim keeps `S` until the
first hourly clean-up after its 10 minutes, so at most about 70 minutes.

**Expiry.** The sender picks when an unopened link stops working: 1 hour, 1 day, 7 days
or up to 3 weeks (500 hours, the default). The key server counts from the `put`, adds 10
minutes for the upload and the sender's clock, and rounds up to the hour, so it keeps a
half about 10 to 70 minutes past the expiry the sender was shown. The page refuses a link past
that stated expiry, by its own clock, without asking. Once the key server's own expiry
passes, the record is refused at once and erased at the next hourly clean-up, which runs
a few seconds after each hour.

**Cancelling** needs the cancel token, which lives only in the sender's tab. A wrong token
gets the same answer as a missing link.

## 4. What the key server keeps and sees

Each record is 76 bytes ([store.go](../../core/keyserver/store.go), `record`): its kind
(waiting, claimed or tombstone), mode and a tombstone's reason; the expiry, to the hour,
and the latest hold or claim, to the minute; `S` (none in a tombstone); and the first 16
bytes of SHA-256 of the cancel token and of the claim nonce. It's filed under the first 16
bytes of `SHA-256("slynk-burn-v1" || ID)`.

There are no addresses and no request log. Go's web server error log, which would print
client addresses, is discarded, and a crash prints no stack trace, which could hold
request bytes ([core/cmd/keyserver/main.go](../../core/cmd/keyserver/main.go)). Once an
hour the server writes one status line, in memory: links kept, new links against the
usual rate, and warnings. It says "under 60" for fewer new links and "under 1,000" for
fewer kept, so while few people use Slynk it gives no exact counts that could help match
an hour's visits to links ([report.go](../../core/keyserver/report.go)).

While answering, the key server sees a request's contents: the ID, the nonce or cancel
token, and for a `put`, `S`, the mode and the expiry. It never sees `L`, the link, the
recipient ID, the item, its size or a password. Like any server, the program and its
operating system see each connection's address while it's open; the program keeps none.
The kernel does hold addresses briefly, in memory and unlogged: the firewall's
per-address limits
([deploy/keyserver/server/nftables.conf](../../deploy/keyserver/server/nftables.conf))
keep a rate entry for a minute after it's made and a connection count while that
address has connections open, and connection tracking keeps each connection's entry
for a couple of minutes after it closes.

## 5. Memory only, and its finer limits

The key server runs on a small virtual machine of its own, set up as
[deploy/keyserver/README.md](../../deploy/keyserver/README.md) describes.

- **Never swapped or dumped.** The program refuses to start while swap is on, locks its
  memory into RAM (`mlockall`) and makes itself undumpable, which also stops other
  processes, root aside, reading its memory
  ([harden_linux.go](../../core/cmd/keyserver/harden_linux.go)). Its service
  ([keyserver.service](../../deploy/keyserver/keyserver.service)) has core dumps off and
  discards its output, apart from start-up problems; the system's log and login records
  are kept in memory only.
- **A clean stop saves; the next start destroys.** On a restart, reboot or automatic
  update, the program writes all its records (waiting links, claims still within their
  10 minutes, tombstones) to a shutdown file, synced and checksummed. The next start
  reads it, overwrites it with zeros, deletes it, and only then answers
  ([save.go](../../core/keyserver/save.go)). If it can't destroy the file, it won't
  serve, so a later start can't bring back a half used meanwhile.
- **After a crash, answers say so.** Without a whole shutdown file the key server starts
  empty, and for the next three weeks every answer carries `"r":1`. A page told "gone" then
  says the link may have been lost in a restart, not that someone else opened it.

The finer limits, plainly:

- **The halves touch the disk during a clean restart,** between stop and the next start:
  seconds for a restart, about a minute for a reboot, longer only if the machine stays
  off. The file is then overwritten and deleted, and the disk told to discard the freed
  blocks (`fstrim`), but a virtual disk can keep old copies. Whoever recovered them would
  still need each link, and the pieces leave the mixnet after about three weeks.
- **The machine underneath can read a running virtual machine's memory.** The provider,
  or anyone who can compel it, could copy the halves held at that moment. After a half
  is deleted there's nothing to find (though copies Go's runtime made while its map grew
  may linger until that memory is reused).
- **A crash loses the links waiting then.** Their senders have to send again.

## 6. What limits a dishonest key server

Suppose the key server, or whoever runs it, misbehaved.

- **It can't open anything.** It never has `L` or the link: the secret part is after the
  `#`, which browsers never send.
- **It could keep halves, or hand one out twice.** That breaks the burn and the one-time
  rule, but only for someone who also has the link.
- **It could refuse service, or hand out a wrong `S`.** AES-GCM refuses a wrong key, so
  the item shows as damaged; nothing false is opened.
- **Its settings are bounded by the page.** Every answer carries the puzzle's difficulty
  and the mean gap between cover requests; pages keep the difficulty at 28 bits or below
  and the gap between 10 s and an hour, so a hostile answer can't make them spin for ever
  (28 bits would be minutes of work on a phone) or flood.
- **It could record who talks to it.** Cover requests (section 8) hide real requests from
  people watching connections, not from the key server, which sees each request's ID. One
  that logged addresses could pair the address that made a link with the one that opened
  it. The published program doesn't.

**Checking the program.** The key server is `core/cmd/keyserver`, built from Go's
standard library and [core/keyserver](../../core/keyserver/) alone, with the command in
[deploy/README.md](../../deploy/README.md) ("Updating the program"):

```
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go -C core build -trimpath -buildvcs=false -ldflags="-s -w -buildid=" -o keyserver ./cmd/keyserver
```

With Go 1.27.2, separate builds of the same commit give byte-identical programs, so anyone
can confirm what a commit builds to. That isn't proof of what runs: no outside check can
prove which program a server runs, and Slynk publishes no checksum or commit for the
program the live key server runs.

## 7. Tombstones

A used or cancelled link's record becomes a tombstone: no `S`, just its expiry and why.
It stays until the link would have expired, and a `put` with that ID meanwhile is answered
`exists`. Two reasons:

- **An interceptor can't cover their tracks.** Someone who intercepted a link and opened
  it first has `L`, `S` and the ID. Without tombstones they could store the same `S` under
  the same ID again, and the real recipient would open the item, never knowing. With them,
  the recipient is told the link was already used.
- **A `put` can't test a link.** Otherwise a `put` with a link's ID would succeed or fail
  depending on whether it had been opened. A waiting link and a tombstone both answer
  `exists`; only the sender, repeating the same `put`, gets `ok`.

## 8. Answers that look alike, and cover requests

Otherwise the key server's traffic would show which visits sent a link (a `put`) or opened
one (`hold`, `claim`, `done`).

- **Every answer looks the same.** Every `POST` gets HTTP 200 and exactly 128 bytes of
  JSON, the outcome only inside, after at least 0.1 s whatever happened (an overloaded
  server answers "down" at once). Every request is 256 bytes, over TLS with a post-quantum
  key exchange (X25519MLKEM768) where the browser offers one.
- **Every tab sends cover requests** ([web/src/burnCover.ts](../../web/src/burnCover.ts)):
  from the moment the app's page loads, holds on random IDs with random nonces, as a
  Poisson process with a mean gap of 25 s. Exponential gaps have no floor or ceiling, so
  their timing says nothing. In the page's first minute, when most links are opened and
  short messages sent, they come six times as often (about every 4 s). The key server
  answers each "gone" from a read-locked lookup, changing nothing. They're on by default
  (Settings, Cover requests), and the desktop app sends them too.
- **Real requests take a cover request's place where they can.** A real request waits for
  the next slot and goes instead of its cover request, adding nothing to the visit's
  count. In the first minute, a request someone is waiting on (`put`, `hold`, `claim`,
  cancel) waits at most 8 s; after it, such a request goes at once, one extra among
  dozens. A `done`, which nobody
  waits on, waits for a slot, but goes at once if the tab is hidden or closed meanwhile.
  In a hidden tab, every other real request waits for a slot.

This hides what a tab does, not that a tab of Slynk is open, or for how long.

## 9. Floods

Links cost the key server memory, so new ones are limited.

- **A puzzle on each new link** ([web/src/pow/puzzle.ts](../../web/src/pow/puzzle.ts)):
  an 8-byte nonce such that `SHA-256("slynk/v1/pow" || ID || window || nonce)` starts with
  20 zero bits, the window being the current 10-minute span or the one before. It's bound
  to the ID, so a solution can't serve another link, and a repeated `put` of a known ID
  counts towards nothing. The page solves it in a worker while the person writes. On
  average that's an estimated second on a mid-range phone and a third of a second on a
  computer (worked out from a desktop's speed, not measured on phones; about 1 puzzle in
  20 takes three times as long); checking costs the server a hash or two. It stops lazy
  scripts, not a determined attacker.
- **A rate limit for everyone together:** 600 new links at once after a quiet spell, then
  60 a minute. There's no per-address limit on new links, because the program keeps no
  addresses.
- **A cap:** 2 million records, about 400 MB (403 MB in a local test on 2026-10-21). At
  60 a minute at most about 1.8 million links exist at once, so the rate alone can't fill
  it.
- **Connections:** at most 2,048 per port, idle ones closed after 15 s; the firewall
  allows each address 20 new connections a second (a burst of 50) and 128 at once.
- **Warnings:** the hourly line flags a busy hour (four times the usual and over 60) or
  refused links, for a week afterwards, and a store 80% full while it is. It alerts
  nobody; it's a line to read. Against a flood, the operator raises the puzzle's
  difficulty (`-pow-bits`, each step doubling the work), and open pages follow from their
  next answer.

## 10. The limits, in plain words

- **A VPN or Tor is what hides who you are.** Cover requests and fixed-size answers hide
  what you do from people watching connections, not your address from the key server, its
  provider or the xx network's gateways.
- **A flood can block new links for a while,** until the allowance refills. It can never
  expose or open an existing link: that needs the link.
- **A modified copy of Slynk can do as it likes with its own links.** It could skip the
  tap, keep what it opens, or never send `done`. With slynk.me's links it can do only what
  the key server allows, since the one-time rule, holds and tombstones are enforced there,
  and browsers on other websites are refused (`-allow-origin`).
- **Whoever opens a link can pass on what's inside,** some other way.

## 11. Why publishing this is safe

Nothing here depends on being secret. The key server holds no secret of its own besides
the halves, which are useless without links it never sees. The puzzle protects by the work
it takes, and cover requests by being indistinguishable from real ones, not by hiding how
either works. The limits are numbers an attacker could measure anyway. Publishing the
design lets anyone check that it does what slynk.me's About page says.

## Sources

- Slynk: [web/src/burn.ts](../../web/src/burn.ts), [web/src/burnCover.ts](../../web/src/burnCover.ts),
  [web/src/pow/](../../web/src/pow/), [core/keyserver/](../../core/keyserver/) (with
  `keyserver_test.go`), [core/cmd/keyserver/](../../core/cmd/keyserver/),
  [deploy/keyserver/](../../deploy/keyserver/)
- comms v0.0.6, `mixmessages/mixmessages.proto`: `gitlab.com/elixxir/comms`, mirrored at
  github.com/xxfoundation
- xxDK v4.8.4, `cmix/identity/tracker.go` (`NetworkRetention`) and
  `cmix/pickup/retrieve.go`: `gitlab.com/elixxir/client/v4`, mirrored at
  github.com/xxfoundation
- The xx gateway, version 3.16.1, `cmd/instance.go` (`beginStorageCleanup`,
  `clearOldStorage`) and `storage/storage.go` (`ClearOldStorage`):
  `gitlab.com/elixxir/gateway`; the permissioning server, version 3.6.1,
  `cmd/nodeMetricTracker.go` (the cut-off from `messageRetentionLimit`):
  `gitlab.com/elixxir/registration`; both mirrored at github.com/xxfoundation
- RFC 5869 (HKDF); NIST SP 800-38D (AES-GCM); Adam Back, "Hashcash", 2002

## Credits

Thanks to the xx foundation for cMix, the xx network and xxDK, to Rick Carback, the leading
contributor to xxDK, and to Keith Millette, whose fork of xxDK Slynk builds on.

— Slynk
