# Slynk's changes to xxDK

*Slynk, 2026-10-31. All times UTC.*

Slynk runs the xx network's client SDK, xxDK, in the browser and on the command line, and
changes it in a few places. This page lists every change in one place, for xx network
developers who want to know what Slynk runs, or who might take some of it upstream. For each
one it says what stock xxDK does, what Slynk changed and why, what we measured, whether we
think it's worth taking upstream, and how risky it is. Where another write-up goes deeper,
it's linked.

## In short

- Slynk builds on **Keith Millette's fork of xxDK** (tag `v4.8.5-courier.5`, on xxDK
  v4.8.4) and **comms v0.0.6**, unmodified.
- Its changes are small, and each is marked in the code with a `Slynk:` comment. More than
  half of the added lines are tests.
- The ones we'd most like to see upstream: a crash fix for failed historical round lookups,
  the comms round-update fix (one line in comms; Slynk works around it in the client), and
  the file transfer's look-back to when a file was sent.
- None of it changes the cMix protocol or the format of the messages a client sends.

## 1. The base, and why the code is copied into the repo

**Keith Millette's fork.** `gitlab.com/keith16/client`, tag `v4.8.5-courier.5`, is xxDK
v4.8.4 with fixes Keith made for his Courier client (its own `FORK.md` and `NOTICE` were
last updated at earlier tags; the copy here is `v4.8.5-courier.5`). Slynk relies on three
of them: the file transfer's send backoff, which also drops the parts of a transfer that
has stopped running; `CloseReceive`, which abandons a download cleanly; and the repair of
an identity whose generation window has collapsed, which otherwise leaves a client deaf.
The fork also
skips rounds that start too soon to reach. It keeps the module path
`gitlab.com/elixxir/client/v4`, so it can be swapped in with no import changes.

**comms v0.0.6** is the version xxDK v4.8.4 requires, and Slynk uses it as released, from
Go's public module proxy.

**Why `third_party/`.** xx's GitLab repositories are gone. Their code survives in the xx
foundation's GitHub mirrors, and most module versions are still on Go's public module proxy,
but `gitlab.com/xx_network/crypto` v0.0.11 isn't, so builds can't download it. Slynk keeps
copies of that module (taken from the GitHub mirror at tag v0.0.11) and of Keith's fork, and
Go uses them through `replace` directives in [core/go.mod](../../core/go.mod). Each copy was
imported unmodified ([third_party/README.md](../../third_party/README.md)). Slynk's changes
since are marked with `Slynk:` comments (`grep -rn 'Slynk:' third_party/xxdk-client`; a few
knock-on lines, such as a call given a new argument, aren't), and diffing the folder
against the fork's tag shows every one exactly. Files that are entirely Slynk's are named
`*_slynk.go` or say so in a header. The changes are
released under the same BSD 2-Clause licence as xxDK.

The xx crypto copy has no changes. Everything below is in
[third_party/xxdk-client/](../../third_party/xxdk-client/).

## 2. Uploads

### 2.1 Put back the upcoming rounds comms drops

- **Stock:** comms' `Instance.RoundUpdates` assigns its "rounds to remove" slice to the
  "rounds to add" variable (`network/instance.go:481`). So every COMPLETED or FAILED update
  in a poll throws away the QUEUED rounds listed before it, and senders never see them.
- **Change:** after `RoundUpdates`, the follower re-inserts every round whose last update
  in the poll is QUEUED, that hasn't started and that is missing from the waiting list
  (`cmix/roundUpdatesFix.go`, one call in `cmix/follow.go`).
- **Measured** on mainnet on 2026-10-14: the bug hid 36–70% of announced upcoming rounds per
  upload. With the workaround, uploads used 67–70% of the round IDs they spanned with stock
  batch sizes, and a 1 MB upload with fuller batches 83%, against 38–43% for stock.
- **Upstream:** the right fix is one line in comms. The workaround then becomes a no-op.
- **Risk:** low. It only re-adds rounds the poll announced, from data comms itself stored.

The full write-up is [comms-roundupdates-bug.md](comms-roundupdates-bug.md).

### 2.2 Batches of 9 to 11 parts, and a size formula that stays in range

- **Stock:** each batch of file parts gets a random size from 1 to 11 (6 on average). The
  file transfer puts at most one batch into each round, so the batch size sets the upload
  speed.
- **Change:** the minimum is 9 (`minPartsSendPerRound`), so batches average 10 and stay
  random. The stock size formula, `num % max + min`, only stays within 11 when the minimum
  is 1; with 9 it would give 9 to 19, and the gateway, which refuses a call with more than
  11 messages, would reject every batch over 11. It's now `num % (max − min + 1) + min`.
  `Wrapper.SetMinPartsPerSend` lets a caller choose the minimum, clamped to 1–11, from the
  next batch built (`channelsFileTransfer/batchSize.go`). Slynk's "Uneven uploads" setting
  uses 1.
- **Measured** on mainnet on 2026-10-14: the shipped combination (round fix, 9–11 batches,
  2 s send timeout) sent a 1 MB upload at 10.4 KB/s with 9.9 parts per send, against
  2.9–3.4 KB/s for stock on the same path. Random 1–11 batches, with the other two changes,
  ran at 4.6–6.6 KB/s.
- **Upstream:** the formula fix, yes: it's a latent bug for anyone who raises the minimum.
  A settable minimum perhaps. The default is a privacy choice for the foundation: fuller
  batches put more of one upload into each round, which makes it stand out a little more.
- **Risk:** low in code. The privacy trade-off is discussed in
  [upload-throughput-2026-10.md](upload-throughput-2026-10.md), section 5.

### 2.3 Optionally confirm parts by their rounds' results

- **Stock:** an uploader confirms its parts by downloading them back. It tracks the
  upload's recipient ID, registers the parts' fingerprints, and re-sends any part it hasn't
  seen after `ResendWait` (30 s). That polling ties the uploader's IP address to the
  recipient ID, which every downloader later polls too.
- **Change:** `Wrapper.SetConfirmByRound`, off by default
  (`channelsFileTransfer/confirmByRound.go`). With it on, a part counts as delivered once the
  round carrying it reports Succeeded, and the uploader never tracks the recipient. A round
  whose outcome is unknown counts as failed and its parts are sent again. Slynk's core turns
  it on.
- **Measured** on mainnet on 2026-10-14: a 200 KB upload with it on downloaded intact from a
  fresh identity, and the uploader's log showed no tracked recipient. With three more
  (40 KB, 250 KB and 1 MB) before Slynk turned it on, that's four uploads and 1,616 parts,
  none lost.
- **Upstream:** worth offering as an option, for any app that hands a file link to someone
  else rather than reading the file itself.
- **Risk:** medium, so it stays off unless a caller turns it on. Succeeded means every node
  finished the round, not that a gateway stored every message in it, and nothing re-sends a
  part lost after that. Beyond those four uploads, we have no measurement of how often that
  happens. It also removes only the uploader's own poll: a round's gateways still see its
  senders and the recipient IDs it delivers to, so a multi-round upload can still be matched
  to its recipient.

Something in stock `cmix/results.go` (`getRoundResults`) is worth a look. When a round's
event times out but the round is in the client's buffer, the code works out its state, and
then a `continue` skips recording it. So a round found COMPLETED is still reported as
TimeOut, and one still running can leave `allRoundsSucceeded` true and `timedOut` false. That's
why `roundSucceeded` checks every round's own status rather than the callback's flag.

### 2.4 A setting, not a code change: the send timeout

Slynk sets the file transfer's `SendTimeout` to 2 s instead of the default 500 ms
([core/transfer/transfer.go](../../core/transfer/transfer.go)). Nearly every batch goes
through a proxy gateway, and at 500 ms, 13 of 14 batches reported as timed out had in fact
landed, so their parts were sent again. At 2 s, 1 of 326 gateway calls timed out (measured
on mainnet on 2026-10-14).

## 3. Downloads and pickups

### 3.1 Downloads look back to when the file was sent

- **Stock:** `Download` registers the link's recipient ID with `AddIdentity`, which only
  looks back one ephemeral-ID period (24 hours and 5 seconds). Gateways keep messages for
  much longer (xxDK assumes 500 hours), but a link opened more than a day after it was sent never finds its parts.
- **Change:** `AddIdentityWithHistory` from the link's `SentTimestamp`; xxDK clamps that to
  its 500-hour retention (`channelsFileTransfer/manager.go`). A link without a
  sent time behaves as before.
- **Measured** on mainnet: two links uploaded on 2026-10-13 downloaded intact after about
  42½ hours (2026-10-15), and again after 18 days 1½ hours (2026-10-31): 250 KB in 92 s and
  1 MB in 110 s.
- **Upstream:** yes. As far as we can tell, a channel member who is away for more than a
  day can't fetch a file shared in the meantime.
- **Risk:** low. An older link's download checks more past ephemeral IDs, so it takes longer
  to start.

### 3.2 Retry a failed round pickup once, 10 s later

- **Stock:** a round whose pickup fails is due again after 10 s by `backOffTable`, but the
  sweep that retries it runs only every 120 s, so its messages arrive about two minutes late.
- **Change:** `quickRetry` sends such a round back to the retrieval workers once, after 10 s,
  only if the sweep hasn't retried it yet (`cmix/pickup/retrieve.go`). A round
  that fails again goes back to the sweep.
- **Measured** on mainnet on 2026-10-15: before it, the last 10–20 pieces of a download
  waited about 80 s, doubling a 2 MB download to about two minutes. With it, a round that
  failed 50 s into a download had its last 10 pieces 11 s later.
- **Upstream:** the better fix is in the sweep itself (mark rounds in flight, or schedule
  each retry). Until then, this is a cheap stopgap.
- **Risk:** low: at most one extra request per failed round.

The full write-up is [pickup-retry-delay.md](pickup-retry-delay.md).

## 4. History look-back

Slynk's anonymous inbox is a recipient ID that its owner opens by looking back through the
network's history, up to three weeks, with `AddIdentityWithHistory`. xxDK does the look-back
well but says nothing about it, so these changes report it and let it resume. They're used by
the core's inbox code ([core/transfer/inbox.go](../../core/transfer/inbox.go)), which turns
them into the counts the page shows as "Finished looking back" and "Carrying on where it
left off".

### 4.1 Report how far a look-back has got

- **Stock:** the past ephemeral identities are polled one after another and pruned, and
  their round pickups finish later. Nothing tells the app when it's all done.
- **Change:** `LookbackStatus(source)` returns the past ephemeral identities still to be
  polled, the pickups queued or under way, and the pickups that failed and wait for the
  sweep (`cmix/lookback_slynk.go`, `cmix/pickup/pending_slynk.go`,
  `cmix/identity/receptionID/history_slynk.go`). A caller reaches it through the
  `LookbackReporter` interface by a type assertion, so no existing interface or mock
  changes. Only the default retrieval path is counted; batch retrieval is off by default.
- **Measured** on mainnet on 2026-10-16: a full 21-day look-back of a test inbox finished
  1 min 51 s after it opened, having found a 26-hour-old message 3.6 s in.
- **Upstream:** useful to any app that restores an identity's history and wants to say when
  it's done.
- **Risk:** low. It's counting, beside the existing code paths.

### 4.2 Skip a stretch already checked

- **Stock:** a look-back cut short, for example by a closed tab, has to start again from
  scratch: xxDK neither says which past days it has finished nor can be told to skip them.
- **Change:** `AddIdentityWithHistorySkipping` is `AddIdentityWithHistory`, except that past
  ephemeral identities lying wholly within a given stretch aren't checked again. The current
  identity is never skipped. `LookbackPendingUntil` gives the end of the newest past
  identity still to check; past identities are checked newest first, so everything after it
  is done (`cmix/identity/skip_slynk.go`, three lines in `tracker.go`).
- **Measured** on mainnet on 2026-10-16: a look-back cut short at 7 of 21 days carried on
  and finished 100 s after the inbox was opened again (a full one took about 125 s), and the
  next open 28 s; each found the same 5 messages.
- **Upstream:** a natural companion to `AddIdentityWithHistory` for apps that keep what they
  received.
- **Risk:** low. It applies only to the identity's first generation, and only when a
  stretch is given.

### 4.3 Pick up a poll's rounds oldest first

- **Stock:** each poll hands `GetMessagesFromRound` up to 100 rounds with messages for an
  identity, newest first. A look-back through a busy day is read in chunks of 100, each
  chunk backwards, so two messages a few rounds apart, either side of a chunk boundary, are
  read about 200 rounds' worth of messages apart.
- **Change:** both loops in `cmix/follow.go` go oldest first.
- **Why:** Slynk's quantum-safe inbox messages can travel as two pieces, the first held,
  within a bound, until the second arrives. Read backwards, a flood of junk could push a
  first piece out far more cheaply in a look-back than live. Live polls carry a round or two,
  so nothing changes there.
- **Measured:** not on mainnet; the `cmix` test suites pass.
- **Upstream:** neutral. Arrival order seems the more natural default.
- **Risk:** low: only the order of pickups changes.

## 5. File transfer limits and cancelling

### 5.1 A 2 MB cap

- **Stock:** `fileMaxSize` is 250,000 bytes.
- **Change:** 2,000,000 bytes (`fileMaxSize` in `channelsFileTransfer/manager.go`). Slynk's
  limit is exactly this, with its own encryption layers inside it.
- **Measured** on mainnet on 2026-10-15: a link filled to exactly the limit (2,165 pieces)
  sent from a browser in 4 min 4 s, about 8.2 KB/s, and was collected in 2 min 4 s.
- **Upstream:** as a parameter, perhaps; the default is the foundation's call, since a bigger
  file is more load on a shared network.
- **Risk:** low in code; the cost is time and network load per transfer.

### 5.2 Cancel an upload under way

- **Stock:** an upload can only be closed out once it has completed or failed.
- **Change:** `Wrapper.CancelUpload` fails the transfer on purpose and closes it out
  (`channelsFileTransfer/cancelUpload.go` and `store/sentCancel.go`: new files, no upstream
  lines changed). The fork's send loop already drops the parts of a transfer that isn't
  running, so nothing more is sent.
- **Measured** on mainnet on 2026-10-17: after a cancel at 22% of a 250 KB upload, three
  batches already waiting for their rounds went out within 2 s, then nothing. The bound is
  one batch per sending worker, 4.
- **Upstream:** yes, together with the fork's send-loop checks.
- **Risk:** low.

The full write-up is [cancel-upload.md](cancel-upload.md).

## 6. Crash fixes

### 6.1 A failed historical round lookup no longer stops the client

- **Stock:** when a historical round lookup fails for good, its callback (marked
  "TODO: Implement me") still sends an empty `rounds.Round` to the message retrievers.
  `processMessageRetrieval` stores it as round 0 in the unchecked-round store and calls
  `getGatewayList`, whose `ri.Topology.Len()` panics on the empty round's nil topology. The
  panic stops the whole client.
- **Change:** the failed round is counted as a failed pickup and left in the unchecked
  store, where the periodic sweep retries it, and nothing is passed on
  (`cmix/pickup/get.go`). A lookup that couldn't be started is counted the same way.
- **Why it matters more for Slynk:** an inbox's three-week look-back makes historical
  lookups the normal case rather than a rare one.
- **Tested:** a test with a failing historical lookup checks that nothing is passed on and
  no round 0 is stored, and fails without the fix.
- **Upstream:** yes. It could affect any xxDK client that picks up older rounds.
- **Risk:** low: it only changes a path that would otherwise crash.

## 7. At a glance

Three small client bugs we noticed but didn't change are in
[upload-throughput-2026-10.md](upload-throughput-2026-10.md), section 3.

| Change | Where | Upstream? | Risk |
|---|---|---|---|
| Put back rounds comms drops | `cmix/roundUpdatesFix.go` | Yes, as a one-line comms fix | Low |
| 9–11 part batches, size formula, settable minimum | `channelsFileTransfer/batchBuilder.go`, `batchSize.go` | Formula yes; default is a choice | Low |
| Confirm parts by round results (opt-in) | `channelsFileTransfer/confirmByRound.go` | As an option | Medium |
| Downloads look back to the sent time | `channelsFileTransfer/manager.go` | Yes | Low |
| Quick retry of a failed pickup | `cmix/pickup/retrieve.go` | Stopgap; fix the sweep | Low |
| Look-back status | `cmix/lookback_slynk.go`, `cmix/pickup/pending_slynk.go` | Useful | Low |
| Skip a stretch already checked | `cmix/identity/skip_slynk.go` | Useful | Low |
| Oldest-first pickups | `cmix/follow.go` | Neutral | Low |
| 2 MB cap | `channelsFileTransfer/manager.go` | As a parameter | Low |
| Cancel an upload | `channelsFileTransfer/cancelUpload.go` | Yes | Low |
| Failed historical lookup crash | `cmix/pickup/get.go` | Yes | Low |

To run the patched packages' tests from the repo root:
`go -C core test gitlab.com/elixxir/client/v4/channelsFileTransfer/... gitlab.com/elixxir/client/v4/cmix/...`

## Sources

- xxDK v4.8.4: `gitlab.com/elixxir/client/v4`, mirrored at github.com/xxfoundation
- comms v0.0.6: `gitlab.com/elixxir/comms`, mirrored at github.com/xxfoundation
- `gitlab.com/xx_network/crypto` v0.0.11, from the GitHub mirror at tag v0.0.11
- Keith Millette's fork of xxDK: `gitlab.com/keith16/client`, tag `v4.8.5-courier.5`, and
  its `FORK.md`; Courier: `gitlab.com/keith16/courier`
- Slynk's changes: [third_party/xxdk-client/](../../third_party/xxdk-client/), each marked
  with a `Slynk:` comment

## Credits

Thanks to the xx foundation for cMix, the xx network and xxDK, to Rick Carback, xxDK's
leading contributor, whose code most of these changes touch, and to Keith Millette, whose
fork's reliability fixes Slynk builds on.

— Slynk
