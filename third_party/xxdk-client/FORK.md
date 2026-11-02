# This is a fork of xxDK

This repository is a fork of the xx network client SDK (xxDK). It exists to back
the **Courier** cMixx client engine, which calls a handful of APIs that are not
in the released SDK. If you are building Courier, you need this fork; a build
against the stock `v4.8.4` tag will not compile.

## Provenance

| | |
|---|---|
| Canonical import path | `gitlab.com/elixxir/client/v4` *(unchanged — this fork does not rename the module)* |
| Forked from | tag `v4.8.4` (commit `92631c67`) |
| Published as | `gitlab.com/keith16/client` |
| Fork tag | `v4.8.5-courier.3` |

The module path is deliberately kept canonical so that, if the xx network team
ever wants these changes upstream, adopting them requires **no import changes**
in any downstream consumer — they merge the commits, cut a tag, and Courier drops
its fork pin. Nothing here forces that; it is simply structured to make it easy.

## What it changes

**14 functional commits** on top of `v4.8.4`: **53 files changed, +2813 / −87**
(28 source files plus 25 `_test.go` files — most of the latter only add mock
stubs so dependent packages compile). Inspect the exact diff:

    git log --oneline v4.8.4..v4.8.5-courier.3
    git diff --stat v4.8.4..v4.8.5-courier.3

### 1. Gateway pool observability + reselection
Commits `26c95251`, `6d1350e7`, `9fd50929`.
- `cmix.Client.GatewayPoolStats() gateway.PoolStats` and `RefreshGatewayPool(ctx) error`.
- `cmix/gateway/{hostPool,sender,runner}.go`, `cmix/{interface,client}.go`.

### 2. cMix send-reliability instrumentation + too-late-round skip
Commits `8337ee7a`, `cda2ea88`, `b70650bf`, `531c0237`, `10d6583a`.
- New `cmix/sendAttempt.go`: `SendAttemptObserver` + `RegisterSendAttemptObserver`,
  `SendAttemptInfo` / `SendSkipInfo`, skip reasons (`SendSkipReasonTooLateRound`,
  `best_round_nil`, `contains_blacklisted`, `process_round_err`).
- `CMIXParams.TooLateThreshold` (default 500ms; `0` disables — backwards
  compatible): skip a round whose pre-clamp send-timeout is below threshold
  before the gRPC call. Exported the `calculateSendTimeout` pre-clamp value;
  collapsed double-calc dead code; excluded failed rounds from re-pick.
- `cmix/{sendCmix,sendManyCmix,sendCmixUtils,params,client,interface}.go`.

### 3. channels lease-machinery bug fixes
Commit `923aae6c`.
- `channels/lease.go`: fix a duplicate-fingerprint nil-deref panic; add the
  `ErrLeaseAlreadyExpired` sentinel.
- `channels/eventModel.go`: finite-lease expiry-undo now clears the display.

### 4. device-side channel mention pings
Commits `d4967d27`, `14008c9a`.
- Surface device-side mention pings via a `MessagePing` UiCallback, gated on the
  muted set so a muted author cannot ping you.
- `channels/{interface,manager,userListener,joinedChannel,eventModel}.go`,
  `bindings/channelsCallbacks.go`, `cmd/channels.go`.

### 5. channelsFileTransfer download recovery
The single commit in `v4.8.5-courier.0..v4.8.5-courier.1`.
- `channelsFileTransfer/wrapper.go`: `Download` now keeps the **newer** of the
  inbound and stored `FileLink` (the comparison was inverted, so a fresh link
  was discarded in favour of the stale stored one) and starts the transfer from
  the same link it persists — previously it always started from the inbound
  link regardless, leaving the running download and the resumable record
  disagreeing.
- New `Wrapper.CloseReceive(fileID)`: abandon an in-progress download, freeing
  its fingerprints, cMix identity, storage and callbacks without touching the
  event model. Without it, a transfer whose `FileLink` expired can never be
  completed or replaced: file IDs are content-addressed, so a re-announce
  short-circuits onto the same dead transfer. Backed by `manager.closeReceive`,
  factored out of the teardown already inside `manager.receive`.
- `channelsFileTransfer/{wrapper,manager,interface}.go`.

### 6. cMix identity generation-window recovery
The functional commit in `v4.8.5-courier.1..v4.8.5-courier.2`.
- `cmix/identity/tracker.go`: repair a tracked identity whose generation window
  has degenerated to the zero time. Such an identity generates no ephemeral IDs,
  so it is never polled for and the client goes permanently deaf — while sending
  still works and the network follower still looks healthy.
- `cmix/identity/{tracker,tracker_test}.go`.

### 7. channelsFileTransfer send backoff
The single commit in `v4.8.5-courier.2..v4.8.5-courier.3`.

A transfer's fingerprints are spent on every part **attempt**, before any network
I/O, and are never returned — and a batch whose send or round failed was
re-queued with **no delay at all**. On a flaky uplink that spent the whole budget
in a burst: a 9-part voice note exhausted all 27 of its fingerprints in five
seconds and was permanently dead, while plain messages over the same link at the
same moment succeeded, because every other send path in the SDK retries with a
backoff. This does not enlarge the budget; it spreads it over enough wall clock
to outlast a transient outage.

- `channelsFileTransfer/send.go`: both re-queue edges — the `SendMany` error in
  `sendCmix` and the failed round in `roundResultsCallback` — now go through
  `requeueFailedParts`, which waits out a per-transfer escalating backoff in a
  spawned goroutine. Neither caller may sleep: `sendCmix` runs on the
  4-goroutine sending pool shared by every concurrent transfer, and
  `batchBuilderThread` is a single goroutine they all funnel through. A batch
  landing on a good round resets that transfer's count.
- `channelsFileTransfer/send.go`: `sendCmix` now **returns** after a failed
  `SendMany` instead of falling through to `GetRoundResults`. It was asking for
  the results of the zero `Round`, which starts a historical lookup for round 0
  that times out 15 s later and re-queues the very same parts a second time —
  doubling the fingerprint burn per failed batch, and keeping a dead transfer
  sending long after it gave up.
- `channelsFileTransfer/send.go`: `sendCmix` skips parts whose transfer is no
  longer `Running`, and returns early rather than calling `SendMany` with an
  empty message list. An empty send is rejected by gateways as a malformed
  message object, and — should one ever answer `Accepted=false` with no error —
  trips the `FATAL` panic in `cmix.SendManyCMIX`.
- `channelsFileTransfer/batchBuilder.go`: drops parts of a non-`Running`
  transfer as they leave `batchQueue`. That is the one point every re-queue
  passes through, so it is where a dead transfer stops circulating.
- `channelsFileTransfer/params.go`: new `SendRetryWait` (2 s) and
  `MaxSendRetryWait` (10 s). A `SendRetryWait` of 0 restores the previous
  un-paced behaviour.
- `channelsFileTransfer/manager.go`: the per-transfer failure counter, cleared by
  `closeSend`, plus a broadcast quit channel so a pending backoff cannot outlive
  `Stop`. A `stoppable.Single` cannot serve as that broadcast — its `Close`
  *sends* one value on a buffered-1 channel rather than closing it, so a
  sleeping goroutine would steal the token from the thread that owes the
  stoppable its `ToStopped`, hanging shutdown.
- `channelsFileTransfer/manager.go`: `send` now returns the `SentTransfer` it
  built rather than a bare `nil`. The only production caller discards it, so
  this is behaviour-neutral, but a success handing back a nil pointer is a trap
  and made the send path untestable at that level.
- `channelsFileTransfer/store/part.go`: new `Part.TransferStatus()` accessor.
- Tests: `channelsFileTransfer/send_backoff_test.go`, plus `mockCmix` knobs for
  a deterministic `SendMany` failure. Before this, `mockCmix.SendMany` always
  returned `nil` and `failSomeSends` modelled part *loss*, so **both** failure
  branches in `send.go` were unreachable from any test.

## CI/CD is disabled here, deliberately

**GitLab CI/CD is turned off for this project (Settings → General → Visibility),
as of 2026-07-27. Leave it off.** It was disabled after every pipeline the fork
had ever run failed, on every commit, regardless of contents — the failures said
nothing about the code.

`.gitlab-ci.yml` is inherited verbatim from upstream and depends on group-level
CI/CD variables that exist in the `elixxir` group but not in a personal fork:

- `DOCKER_IMAGE` — the Go build image. Unset, so GitLab falls back to its default
  `ruby:3.1`, which has no Go toolchain.
- `SSH_PRIVATE_KEY` — the deploy key for the private `gitlab.com/elixxir/*`
  dependencies.
- `MIN_CODE_COVERAGE` — the `test` job's coverage gate.

So the `test` and `wasm-test` jobs die inside `before_script` with
`go: command not found` and `Error loading key "(stdin)"`, having never reached
`go build` or a single test. `build`, `bindings-ios` and `bindings-android` are
skipped. The config is left untouched on purpose: editing it would be divergence
from upstream that buys nothing and would have to be carried through every
re-base.

**This fork is verified through Courier's gates instead** — per-module build and
vet, the `channelsFileTransfer` package suite, and Courier's live mainnet gates,
all run before a fork commit is pushed. That is the real gate, and it is why
disabling the pipeline costs nothing.

If you ever re-enable CI here, expect the same failures until those three
variables are supplied. Patching `.gitlab-ci.yml` to work around them is the
wrong fix: it is upstream divergence that buys nothing and has to be carried
through every re-base.

## License

Original work © 2020 xx network SEZC, BSD 2-Clause (see `LICENSE`, retained
verbatim). Modifications in the commits above © 2026 Keith Millette, contributed
under the **same BSD 2-Clause license** — so the whole tree stays BSD-2 and can
be merged upstream with no relicensing.

See `NOTICE` for a short summary, and the Courier repository's `docs/dependency.md`
for how the two projects depend on one another.
