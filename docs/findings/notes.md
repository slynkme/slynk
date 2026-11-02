# Notes from building Slynk on the xx network

*Slynk, 2026-10-31. All times UTC.*

Short notes for anyone building on the xx network: things we learned while putting a
browser file and message drop on cMix, with what we measured on mainnet. The upload-speed
story is in [upload-throughput-2026-10.md](upload-throughput-2026-10.md), what the
network's computers can see in [gateway-metadata.md](gateway-metadata.md), and the cost of
a new identity per visit in [network-identities.md](network-identities.md).

## 1. Using the file transfer without a chat

xxDK's channels file transfer (`channelsFileTransfer`) is meant to run inside a
channels manager. It works fine on its own: call the extension builder that
`NewWrapper` returns with your own in-memory event model and a nil channels manager.
The channels manager is only used by `Send`, which posts the file link to a channel.
Slynk never calls it: it uploads to a random, single-use recipient ID and hands the
link over itself (`startFileTransfer` in
[core/transfer/transfer.go](../../core/transfer/transfer.go), the event model in
[core/transfer/eventmodel.go](../../core/transfer/eventmodel.go)).

## 2. Anyone with the link can download, later

The file link from the channels file transfer is self-contained: file ID, recipient ID,
sent time, key, MAC, size, parts and retry. A completely unrelated identity can
download with only that, long after the uploader has gone offline. The sender and
recipient never need to be online together.

## 3. How long links last

Gateways sweep messages by age, at a cut-off the network's permissioning server sends them;
its live value isn't published. xxDK assumes 500 hours, roughly three weeks
(`NetworkRetention = 500 * time.Hour` in `cmix/identity/tracker.go`), and Slynk's links last
no longer than that. The measurements below show at least 18 days.

Stock xxDK's file download only tracks the recipient from now on, which reaches back
about one ephemeral-ID period (roughly a day), so older links can't be fetched. Slynk's
fork tracks the recipient from the link's sent time instead, with xxDK's
`AddIdentityWithHistory`; xxDK clamps the start to its retention window
(`addFingerprints` in
[channelsFileTransfer/manager.go](../../third_party/xxdk-client/channelsFileTransfer/manager.go)).

We tested it with two real links uploaded on 2026-10-13, 250 KB at 17:33 and 1 MB at
17:37 (their link files are in
[lab/mixnet-smoketest/testdata/](../../lab/mixnet-smoketest/testdata/)), downloading
both with one fresh identity each time and checking them against their SHA-256:

- **After about 42½ hours** (2026-10-15, 12:02–12:05): both intact. The 250 KB file's
  first part came 14 s after the download started and 262 of its 271 parts by 24 s,
  then the last 9 (one round's pickup) after an 80 s wait, 105 s in all. That wait is
  described in [pickup-retry-delay.md](pickup-retry-delay.md); Slynk's fork now retries
  a failed round pickup once, 10 s later. The 1 MB file took 33 s.
- **After 18 days 1½ hours** (2026-10-31, 18:59–19:03): both intact. The identity joined
  in 14 s (155 of 178 nodes registered). The 250 KB file's first parts came about 85 s
  after the download started, while the client worked through 18 days of rounds, then all
  271 within 6 s; 92 s in all. The 1 MB file took 110 s.
- **An inbox, the same day:** an anonymous inbox's messages sent 17 days earlier were
  all found 85 s after connecting, by looking back through the rounds delivered to its
  address.

The last 2–3 days of the ~500 hour window are untested, so "up to about three weeks" is
measured to 18 days. An old link's first part can take well over a minute to arrive, so
Slynk's "nothing has arrived yet" notice waits 2 minutes plus 15 s for each day of the
link's age ([core/transfer/stall.go](../../core/transfer/stall.go)).

## 4. Joining the network

A new identity is ready to send once it has registered with 85% of the nodes listed in
the network's directory (`readyFraction`, xxDK's `IsReady`) *and* xxDK reports the
network healthy: a waiting round seen in the last 15 s and a completed round in the last
30 s (`cmix/health/tracker.go`). Sends made before that routinely fail. A join usually
takes 12–27 s; registration keeps rising in the background, and the nodes left over seem to be
mostly ones that aren't serving in teams: in one upload, only about 4% of picked rounds
had a node whose key was still missing.

A join can stall short of ready, for example on a patchy phone connection. Since
2026-10-24, Slynk's core starts it again by itself with a fresh identity when no new node
has registered for 30 s, or it isn't ready 90 s after it began, up to 3 times; then it
gives up with the code "stalled". The whole join is capped at 5 minutes (`retryJoin` and
`joinWait` in [core/transfer/transfer.go](../../core/transfer/transfer.go), with offline
tests in `connect_test.go`). Settings also has a Restart button once a join has taken
30 s. Every fresh start is a new identity, from the registrar's shared allowance (§6), so
the limits are deliberately few.

## 5. Round numbers aren't in start order

A round is numbered when it's made, and it starts when it's ready; xxDK sends in the
soonest-starting round it knows of. So a send made seconds after another often goes in
a lower-numbered round: in our mainnet logs, a send made 4–9 s after another went in a
lower-numbered round 18% of the time, and on 2026-10-18 a retry went in a lower-numbered
round that started later than the first try's.

Anything that needs messages in order should order their rounds by start time (the
round's QUEUED timestamp), falling back to the round number only when the start times are
equal or unknown. Slynk's quantum-safe inbox pairs a message's two pieces this way
(`startsBefore` in [core/transfer/inbox4.go](../../core/transfer/inbox4.go)).

## 6. The client registrar is a shared budget

Every new identity is admitted by the client registrar, a central service. In its
published example configuration, it admits 1,000 new identities a day across the whole
network; the live setting isn't public. An app that makes a fresh identity per visit
should therefore join only when someone actually sends or receives, which Slynk does.
The details are in [network-identities.md](network-identities.md).

## 7. Mainnet details we measured

- Rounds have 1,000 slots, are run by teams of 5 nodes, and are announced a median
  2.3 s before they start.
- Mainnet uses an 18-bit ephemeral address space, and the network's directory listed
  181 nodes and 181 gateways on 2026-10-13.
- About 1.2 rounds completed per second during our tests. Round IDs advanced a little
  faster (about 1.4 a second in one run), so some rounds failed or never ran; the
  network's public dashboard reported about 0.09 failed rounds a second for the 24
  hours to 2026-10-14 18:00. We haven't reconciled the two, and nothing we built depends
  on it.
- A few gateways don't answer at any given moment. Clients cope: the gateway pool
  replaces them.

## 8. Browser specifics

- **Gateway certificates.** Gateways are reached at
  `<first 54 hex chars of the gateway ID>.xxnode.io`, with publicly trusted
  certificates. They don't send the intermediate certificate: browsers cope, but
  tools like curl don't.
- **Size of the core.** The Go core compiled to WebAssembly is about 42 MB raw and
  6.4 MB with Brotli (built 2026-10-31). Some hosts don't compress `.wasm` on the fly,
  so ship pre-compressed copies ([web/scripts/precompress.mjs](../../web/scripts/precompress.mjs)).
- **Smaller gateway pool.** The browser keeps a pool of 7 gateways (14 natively), so
  nearly every send goes through a proxy gateway.

## 9. Small client bugs we noticed

- **A rejected node key is never replaced.** The client checks for the wrong error
  wording. See §3 of the throughput write-up.
- **Lost parts on stop.** Parts held in the file transfer's batch builder are dropped
  if it is stopped mid-batch.
- **Wasted requeues.** Failed sends are requeued without checking which parts were
  already read back.
- **Round-update bug.** comms' `RoundUpdates` drops upcoming rounds. See the
  [bug report](comms-roundupdates-bug.md).
- **Slow pickup retries.** A failed round pickup waits for a 120 s sweep. See
  [pickup-retry-delay.md](pickup-retry-delay.md).

## 10. Where the code lives now

xx's GitLab repositories are gone. Their code survives in the xx foundation's GitHub
mirrors, and most module versions are still served by the public Go module proxy. One,
`gitlab.com/xx_network/crypto` v0.0.11, isn't, so Slynk keeps a copy in
[third_party/](../../third_party/).

## Sources

- xxDK v4.8.4, `github.com/xxfoundation/elixxir-client` (tag `v4.8.4`):
  `channelsFileTransfer/`, `cmix/identity/tracker.go`, `cmix/health/tracker.go`,
  `cmix/gateway/defaults_js.go`.
- comms v0.0.6, `github.com/xxfoundation/elixxir-comms` (tag `v0.0.6`).
- Keith Millette's fork, `gitlab.com/keith16/client` (tag `v4.8.5-courier.5`).
- Slynk's changes to xxDK: [third_party/xxdk-client/](../../third_party/xxdk-client/).

## Credits

Thanks to the xx foundation for the xx network and xxDK, to Rick Carback, its leading
contributor, and to Keith Millette, whose fork Slynk builds on.

— Slynk
