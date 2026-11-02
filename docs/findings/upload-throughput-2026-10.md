# Upload throughput over cMix: what limited it, a round-visibility bug, and the choices Slynk made

*Slynk, 2026-10-31. All times UTC.*

Slynk is a private, link-based file and message drop built on the xx network. The
visitor's browser joins the mixnet as a brand-new, in-memory identity, uploads encrypted
parts to a random single-use recipient ID with xxDK's channels file transfer, and hands
back a link whose secret travels only in the URL fragment.

It's built on Keith Millette's fork of xxDK (`gitlab.com/keith16/client`, tag
`v4.8.5-courier.5`, based on v4.8.4), with comms v0.0.6. Everything below applies to
stock xxDK v4.8.4 unless it's marked as the fork's or Slynk's; Slynk's own changes are in
[third_party/xxdk-client/](../../third_party/xxdk-client/), marked with `Slynk:`
comments. This note explains what limited its uploads, what we changed, and the
trade-offs behind each choice, for anyone who knows the network better than we do. The
measurements were made on mainnet on 2026-10-14 unless another date is given.

## In short

- One client gets at most one batch of at most 11 parts into each round, so its upload
  rate is roughly rounds per second × parts per batch × ~923 bytes.
- A bug in comms' `RoundUpdates` hid about half of the upcoming rounds from the client.
  Working around it, filling batches with 9–11 parts and allowing 2 s per gateway call
  took uploads from about 3 KB/s to about 10 natively and about 8 in the browser.
- Uploads confirm each part by its round's result, not by downloading it back, so the
  uploader never polls the link's pickup address.
- An opt-in "Uneven uploads" setting goes back to stock 1–11 part batches, at a little
  over half the speed.

## 1. What bounds a single client's upload rate

Two structural limits multiply together:

- **One batch per round per client.** The channels file transfer gives all of its send
  workers one shared excluded-rounds tracker (`channelsFileTransfer/send.go`,
  `sentRoundTracker.NewManager`). A round is marked as soon as a worker picks it, even if
  that send then fails, and every other worker skips it. So a round carries at most one
  file-transfer `SendMany` from a client, however many workers it runs. No round carried
  two of our sends in any single-send run.
- **At most 11 messages per batch.** A gateway accepts at most 11 messages in one
  `PutManyMessages` call (`maxManyMessages = 11` in the gateway's `cmd/gateway.go`). The
  stock file transfer draws each batch's size at random from 1 to 11, 6 on average.

So **throughput ≈ usable rounds per second × parts per batch × ~923 bytes**. During our
tests mainnet completed about 1.2 rounds a second (1.1–1.5 per upload). With full
11-part batches in every round, one client's limit is near 12 KB/s.

Stock fell short on both factors: batches averaged 6 parts, and the client used only
about 40% of the rounds. That gives 1.2 × 0.4 × 6 × 923 B ≈ 2.7 KB/s. Most of the lost
rounds came from the bug in §2.

On mainnet, rounds have 1,000 slots and teams of 5 nodes, are announced a median 2.3 s
before they start, and use an 18-bit ephemeral address space. 92% of our 417
`PutManyMessages` calls went through a proxy gateway, as expected: the native client keeps
14 of the ~180 gateways in its pool (the square root of their number, at most 20) and the
browser 7 (`cmix/gateway/hostPool.go`, `defaults_js.go`), so a round's entry gateway is
usually not among them.

## 2. The round-visibility bug in comms

Every poll, the client follower (`cmix/follow.go`) hands the gateway's round updates to
comms' `Instance.RoundUpdates`, which feeds the waiting list senders pick rounds from. In
comms v0.0.6, which is also the newest comms code in the GitHub mirror as far as we can
tell:

```go
if state == states.QUEUED {
    addedRounds = append(addedRounds, rnd)
} else if state > states.QUEUED {
    addedRounds = append(removedRounds, rnd) // network/instance.go:481
}
...
i.waitingRounds.Insert(addedRounds, removedRounds)
```

`removedRounds` is always empty, so every update past QUEUED (with the gateway's
filtered updates, every COMPLETED or FAILED one) resets `addedRounds` to that one round.
Three effects follow:
- Every QUEUED round listed before such an update in the same poll is thrown away.
- Nothing is removed when its state changes: a round that fails before its start stays
  offered until its start time passes.
- A FAILED round with a future start time can be added as if it were sendable.

Polls routinely mix QUEUED updates with finished ones, so the first effect is large.

**How we measured it.** An instrumented client compared each poll's updates with the
waiting list afterwards. A round counted as announced if its last update in the poll
was QUEUED with a future start, as lost if it was missing from the waiting list right
after `RoundUpdates`, and as too late if it started less than 0.75 s later.

**What we found:**
- **47–48% of announced upcoming rounds were lost** in our two stock-behaviour
  uploads, and 36–70% per upload across all ten we instrumented (276 of 550 overall).
- **Every lost round was lost to this line.** About 4% of QUEUED updates arrived too
  late to use.
- **Sends spent their time waiting.** In the baseline uploads, 97% of round picks
  (94 of 97) had to wait for a round: a median of 2.8 s, and up to 37 s. Gateway calls
  themselves took a median 148 ms.
- **The other two effects never showed up.** In 501 polls, no finished or failed round
  was ever in the waiting list, because rounds almost always fail after their start.

The fix in comms is one line (`removedRounds = append(removedRounds, rnd)`). Slynk works
around it in the client instead, so it can keep the unmodified comms v0.0.6 release.
After `RoundUpdates`, it re-adds every round whose last update in the poll is QUEUED,
that hasn't started, and that is missing from the waiting list, using the wrapper
`RoundUpdates` stored
([cmix/roundUpdatesFix.go](../../third_party/xxdk-client/cmix/roundUpdatesFix.go), with an
offline test). It only restores the dropped rounds.

With the workaround, no announced round stayed lost. Uploads with the fix but stock
1–11 batches used 67–70% of the round IDs they spanned, our 1 MB upload with every change
(§6) used 83% (109 of 131), and the three baseline uploads 38–43%. Any client built on the
follower should also see a chat message wait longer for a usable round, though we haven't
measured that. A short bug report is in
[comms-roundupdates-bug.md](comms-roundupdates-bug.md).

## 3. Smaller findings

- **Stock batch sizes are as designed.** With the same core as the browser, they fit a
  uniform 1–11 draw: 6.2 parts on average over all 130 sends of three baseline uploads
  (χ² = 6.2, 10 degrees of freedom). Our first harness measured 4.5, partly because its
  failed sends were re-queued in small groups. In one 40 KB browser upload, two of five
  batches came out under 9 parts; we haven't followed that up yet.
- **The size formula only works with a minimum of 1.** With a minimum of 9,
  `num % max + min` gives 9–19, and the gateway rejects every batch over 11. Slynk's fork
  uses `num % (max − min + 1) + min`
  ([channelsFileTransfer/batchBuilder.go](../../third_party/xxdk-client/channelsFileTransfer/batchBuilder.go)).
- **The 500 ms send timeout causes phantom failures.** The file transfer gives each
  batch 500 ms to reach the round's entry gateway, and nearly every call is proxied. Of
  14 batches reported as `DeadlineExceeded` in our first 1 MB upload (2026-10-13) and
  three baselines, 13 had in fact landed. Their parts were sent again, and the proxy
  gateway was dropped from the pool.
- **2 s mostly fixes it.** Each call is still capped to end 250 ms before the round's
  start (`calculateSendTimeout`). With 2 s, 1 of 326 gateway calls timed out, when its
  round's start had cut its budget to 851 ms, and its parts had landed anyway. Slynk sets
  it in [core/transfer/transfer.go](../../core/transfer/transfer.go) (`sendTimeout`).
- **The 45 s "no rounds" timeouts come from too many workers.** In that first 1 MB
  upload, with 16 send workers instead of xxDK's 4 and before any fix, the workers shared
  about 0.5 usable rounds a second, and 108 of 365 `SendMany` calls ran out of xxDK's
  45-second round search. 80 reported a timeout; 28 said "unknown error", having hit the
  deadline at exactly 45.000 s, where millisecond network time leaves `elapsed > Timeout`
  false and the loop uses up its 10 round tries with no time left
  (`cmix/sendManyCmix.go`). With 4 workers there were none; a longer timeout would only
  hide the queue for rounds.
- **The probe setting isn't a lever.** `SendMany` asks an attempts tracker how much lead
  to require of a round. Only probe sends feed it, and the file transfer never probes,
  so it always reports "insufficient data" and uses 4 attempts: a minimum lead of 47.5 ms,
  where the range is 10–87.5 ms (comms' `waitingRounds.go`).
- **More chunks or identities gain nothing worth having.** Transfers inside one client
  share one batch builder, send queue, worker pool and excluded-rounds tracker, so
  splitting a file gains nothing. An identity per chunk would get round the
  one-batch-per-round limit, but each costs a registrar admission (see
  [network-identities.md](network-identities.md)), a join of 12–27 s and more memory in a
  browser tab. We haven't tried it.
- **Not bottlenecks:** node registration (18 of 453 picked rounds skipped for a missing
  node key); the fork's too-late skip (`TooLateThreshold`: rounds starting within about
  750 ms, 2 skipped in a 1 MB run); and gateway rate limits (no rate-limit or full-batch
  error in any run).
- **Unrelated small bugs** in the client:
  - **A rejected node key is never replaced.** On an auth failure the client looks for
    "…registered with these nodes?", but the gateway says "…with this node (…)?"
    (client `cmix/sendCmixUtils.go`, gateway `cmd/gateway.go`), so the "delete the key and
    re-register" path never runs. We hit this once.
  - **Lost parts on stop.** Parts held by a stopped batch builder (stock
    `batchBuilder.go`) or backoff requeue (the fork's `requeueAfter`) are dropped until
    the transfer is next loaded from storage: for an in-memory client, for good.
  - **Wasted requeues.** Failed sends' parts are re-queued without checking whether they
    were already read back: 22 already-delivered parts in one 250 KB upload.

## 4. How an upload confirms its parts

Stock xxDK confirms an upload by reading it back: the uploader tracks the upload's
recipient ID, and re-sends any part it hasn't seen come back within `ResendWait` (30 s).
So the uploader polls the link's pickup address from its own IP address, through the
gateways that carried its upload, which could tie the two together without statistics.

Since 2026-10-14 Slynk's uploads **confirm by round** instead
([channelsFileTransfer/confirmByRound.go](../../third_party/xxdk-client/channelsFileTransfer/confirmByRound.go),
switched on in `startFileTransfer` in
[core/transfer/transfer.go](../../core/transfer/transfer.go)). A part counts as delivered
once the round that carried it reports Succeeded, and the uploader never tracks the
recipient. A round whose outcome is unknown counts as failed, and its parts are sent
again. `slynk-cli` turns the old read-back on with `SLYNK_READ_BACK=1` for comparisons.

It removes only the uploader's own poll; what gateways see of every round is unchanged.
And it's best-effort: Succeeded means every node finished the round, not that a gateway
stored this message, and nothing re-sends a part lost after that. The link's MAC is the
safety net: a download missing a part fails rather than giving a damaged file. Before
switching it on, we uploaded 40 KB, 250 KB and 1 MB with it from one identity, at 3.0,
8.5 and 9.1 KB/s with no part sent twice, and a fresh identity downloaded all three
intact in 4, 6 and 13 s. With an earlier 200 KB test, that's 4 uploads and 1,616 parts,
none lost.

## 5. Privacy trade-offs and what we chose

A cMix round hides *which* input becomes *which* output, not *how many* pieces a sender
puts into it, and gateways see both a sender's count going in and each recipient's
coming out (see [gateway-metadata.md](gateway-metadata.md)). An upload sends to one
recipient over dozens of consecutive rounds, so it stands out; our choices change how
much, not whether.

- **Bigger batches, still random: 9–11 parts** (10 on average) rather than a fixed 11.
  By §1 that keeps about 91% (10/11) of the speed of fixed 11-part batches (not measured
  side by side), and it stands out about as much; we chose it as the more conservative.
- **No second send per round.** We let a client put up to two `SendMany` calls into the
  same round, each still skipping rounds it had tried: about 1.8× the sending rate
  (20–27 KB/s) and 1.3× overall in two short uploads, with no rate-limit errors at 25–30
  messages a second. We haven't shipped it: it doubles our pieces per round, to about 20,
  and leans harder on per-sender rate limits whose mainnet values clients can't see (the
  client's NDF carries them as zero; gateways read the full NDF).
- **An "Uneven uploads" setting, off by default** (the code says `variedBatches`). It
  goes back to the stock random 1–11, which looks like stock file-transfer traffic round
  by round, spreading an upload over about 1.7 times as many rounds at roughly 60% of the
  default's rate. It keeps one recipient, so it doesn't stop an upload being matched to
  its pickup address, and the setting claims nothing more than "uneven bursts".
- **Always on: the round fix, the 2 s timeout and confirm by round.** The first two don't
  change the counts per round, and the third removes a link.

## 6. Results

Measured with the native client (`slynk-cli`, the same core as the browser), uploading
random data, with read-back confirmation (§4 came that evening). Each identity made up to
three uploads in a row; later ones, at the top of each range, found every node already
registered. **Overall** runs from connected (12–22 s) to the last part confirmed; **while
sending**, from the first batch out to the last part landing. **Rounds used** counts
distinct rounds over the span of round IDs the upload covered; the 250 KB runs span only
22–75 IDs, so their shares carry roughly ±7–10 points of noise.

| Configuration | Uploads | Overall KB/s | While sending | Parts per send | Rounds used |
|---|---|---|---|---|---|
| Stock¹ | 3 × 250 KB | 2.9–3.4 | 3.0–4.5 | 5.8–6.5 | 38–43% |
| Round fix² + 11-part batches + 2 s timeout | 3 × 250 KB | 7.9–13.2 | 10.2–16.4 | 10.8 | 44–58% |
| … plus two sends per round | 2 × 250 KB | 11.4–14.9 | 20.0–26.7 | 10.8 | (not comparable) |
| **Shipped: round fix + 9–11 batches + 2 s** | 1 × 1 MB | **10.4** | 11.0 | 9.9 | 83% |
| "Uneven uploads": round fix + 1–11 + 2 s | 2 × 250 KB | 4.6–6.6 | 5.1–8.3 | 5.4–6.8 | 67–70% |

¹ One run of the unmodified build, plus two of an instrumented build with every change
switched off.
² These rows also switched on removal of finished rounds from the waiting list, which
never triggered. Every row except the first used the instrumented build's switches; the
shipped code makes the same changes.

The shipped 1 MB upload took 1 min 36 s after connecting, against roughly 5–6 minutes for
stock code on the same path.

In the browser, which runs the core single-threaded in WebAssembly with 7 gateways:
- a development build sent 250 KB in 28.8 s after connecting (about 8.7 KB/s), on
  2026-10-14, with read-back;
- a production build with the live security headers sent a full 2 MB link (2,165 parts,
  confirmed by round) in 4 min 4 s (8.2 KB/s), on 2026-10-15. The page's time estimate
  uses that rate ([web/src/ui/meter.ts](../../web/src/ui/meter.ts)).

"Uneven uploads" hasn't been timed in the browser; the page assumes its CLI figure of
6 KB/s. With opt-in cover messages on, a 250 KB CLI upload ran at 8.2 KB/s, against 8.5
without.

The tests used 11 native uploads on 6 fresh identities, plus 3 browser identities. Each
new identity goes through the client registrar, so we kept the count low.

## 7. Questions we'd love answers to

1. Is "one batch per round per client" in the channels file transfer a deliberate
   privacy property, or an implementation convenience?
2. What per-sender and per-IP rate limits do mainnet gateways enforce? They decide
   whether several sends per round would be acceptable.
3. Is a fix for `RoundUpdates` likely to land upstream, so clients can drop
   workarounds like ours?
4. Is the file transfer's 500 ms send timeout deliberate, given that most sends are
   proxied?
5. Would confirming by round, or something like it, be welcome upstream, since read-back
   makes every uploader poll its own recipient's pickup address?
6. Is the 18-bit address space still the intended setting for today's user numbers?

The registrar and gateway questions are in [network-identities.md](network-identities.md)
and [gateway-metadata.md](gateway-metadata.md).

## Method

The measurements come from an instrumented build of the same client (log lines at each
poll, round pick, gateway call and batch), driven by a small summary script. We're
happy to share both on request.

## Sources

- xxDK v4.8.4, `github.com/xxfoundation/elixxir-client` (tag `v4.8.4`):
  `channelsFileTransfer/`, `cmix/follow.go`, `sendManyCmix.go`, `sendCmixUtils.go`,
  `cmix/gateway/`.
- comms v0.0.6, `github.com/xxfoundation/elixxir-comms` (tag `v0.0.6`):
  `network/instance.go`, `network/dataStructures/waitingRounds.go`.
- The gateway, `github.com/xxfoundation/elixxir-gateway` (tag `v3.16.1`):
  `cmd/gateway.go`.
- Keith Millette's fork, `gitlab.com/keith16/client` (tag `v4.8.5-courier.5`):
  `requeueAfter`, `TooLateThreshold`.
- Slynk's changes: [third_party/xxdk-client/](../../third_party/xxdk-client/), and
  [core/transfer/transfer.go](../../core/transfer/transfer.go).

## Credits

Thanks to David Chaum and the cMix authors, and to the xx foundation, for cMix and the xx
network, and to Rick Carback, the leading contributor to xxDK. Thanks also to Keith
Millette, whose fork's file-transfer reliability fixes Slynk builds on.

— Slynk
