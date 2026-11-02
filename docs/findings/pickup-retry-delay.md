# client: a failed message pickup waits for the 120 s unchecked-round sweep

*Slynk, 2026-10-31. All times UTC.*

When a client fails to pick up one round's messages, xxDK's retry schedule says to try
again after 10 seconds, but the retry actually comes at the next two-minute sweep. For
Slynk that meant the last pieces of a download arrived about 80 s after the rest. This
write-up is for xx network developers and anyone building on xxDK (module
`gitlab.com/elixxir/client/v4`). It explains why it happens, why the obvious setting change
would cause a different problem, the small patch Slynk ships, and what might fix it
properly upstream.

## 1. Where it is

- xxDK v4.8.4. The files involved (`cmix/pickup/params.go`, `unchecked.go`, `retrieve.go`,
  `get.go`, `store/store.go`, `cmix/gateway/sender.go`, `pool.go`) are the same in the xx
  foundation's GitHub mirror as far as we can tell.
- Slynk builds on Keith Millette's fork (tag `v4.8.5-courier.5`, based on v4.8.4), which
  doesn't change these files apart from adding pool statistics and reselection to
  `gateway/sender.go`.
- Seen in the browser (Go compiled to WebAssembly, as xxdk-wasm is) and natively.

A *pickup* is the client asking a round's gateways for the messages that round delivered
to one of its ephemeral IDs (the short, shared addresses messages are filed under).

## 2. What happens

**One slow gateway fails the whole round.** `getMessagesFromGateway` calls
`sender.SendToPreferred` with the pickup's `SendTimeout`, 3 s by default. `SendToPreferred`
tries the round's gateways one after another and gives up once 3 s have passed since it
started. It hands each attempt the time remaining, but the pickup's send function ignores
that argument (`_ time.Duration`), so a single slow `RequestMessages` call can use the
whole budget, and the round's other gateways are never asked. The log reads:

```
[processMessageRetrieval] Failed to get pickup round N from all gateways (...):
Failed to request messages for round N: sending to target in HostPool timed out after 3s
```

**The retry waits for the next sweep.** The failed round stays in the
`UncheckedRoundStore`. By `backOffTable` it is due again after 10 s (`tryZero`), then 30 s.
But `processUncheckedRounds` only looks at the store when the client starts and then every
`UncheckRoundPeriod`, 120 s by default, so the round is retried at the next tick. The sweep
starts with the network follower, and early failures are the common case, so in practice
the retry comes about 120 s after the client started. The 10 s and 30 s steps never take
effect as written.

## 3. How it showed up

Slynk downloads a file, up to about 2,200 pieces, with a fresh identity. On 2026-10-15, in
two browser downloads and an earlier native one, most pieces arrived within about 45 s,
then the last 10–20 (one or two rounds' worth) waited about 80 s. The console showed the
"timed out after 3s" error for one or two rounds about 15 s in. The wait matched the sweep:
about 120 s after connecting, in every download. That doubled a 2 MB download from about
one minute to about two. One full-size browser test the same day (2,165 pieces) collected
2,155 of them in 44 s, then waited about 80 s for one round's last 10, whose pickup had
timed out at all five gateways.

We haven't tested Haven. The copy of its web app's source we read (not a tagged release)
starts from the default cMix parameters and changes only `EnableImmediateSending`, so we
would expect the same delay for a message there whenever its round's pickup fails.

## 4. Why not just shorten `UncheckRoundPeriod`

The store holds rounds that haven't failed too:

- `GetMessagesFromRound` adds a round whose details aren't in memory before its historical
  lookup starts, and a retrieval worker adds every round when it takes it from the queue.
- `IterateOverList` skips only rounds marked `beingChecked`, and nothing ever sets that
  flag to true.

With a short period, every round whose historical lookup or retrieval was still pending 10
s after it was added would be requested again. For a large download of an older link, that
is dozens of extra requests to gateways. The TODO above `processUncheckedRounds` says as
much: the system should "know which rounds are still in progress instead of just assume by
time".

## 5. What Slynk does

A small patch in
[third_party/xxdk-client/cmix/pickup/retrieve.go](../../third_party/xxdk-client/cmix/pickup/retrieve.go),
`quickRetry`:

- When a round's pickup fails and its `NumChecks` is still 0 (the sweep hasn't retried it
  yet), it is sent back to the retrieval workers once, after `quickRetryDelay`, which is
  `tryZero` (10 s).
- The retried lookup is marked, so it is never quick-retried again. A round that fails a
  second time goes back to the sweep's backoff, exactly as before.
- If the retrieval queue is full when the 10 s are up, the retry is dropped and the sweep
  handles the round, as stock would.

So each failed round costs at most one extra request, and rounds that haven't failed are
never asked for twice. The tests
([retrieve_slynk_test.go](../../third_party/xxdk-client/cmix/pickup/retrieve_slynk_test.go))
check that a flaky gateway's round arrives on the quick retry, and that a gateway that
always fails gets exactly one; both fail with the call removed.

**Measured on mainnet on 2026-10-15**, on slynk.me with the patch: one round's pickup
failed 50 s into a download, and its last 10 pieces arrived 11 s later, 61 s in all, where
the old code would have waited for the sweep (about 2 min 20 s). Two other downloads of the
same 2 MB link that day had no failed round: 22.9 s natively and 44.8 s in a browser.

## 6. Suggestions for upstream

- **Honour the backoff table.** Mark rounds in flight (set `beingChecked` when a lookup
  starts, clear it when it ends), so the sweep can run every few seconds without
  re-requesting work under way; or schedule each failed round's retry with a timer at its
  due time.
- **Don't let one gateway use the whole budget.** Pass the remaining timeout through to
  `RequestMessages`, or give each gateway its own share of `SendTimeout`, so a slow gateway
  is skipped and the round's other gateways are still asked.
- **Worth a look.** `GetPreferred` returns the targets that are in the host pool first,
  then random proxies, but `SendToPreferred` pairs `targetHosts[i]` with `targets[i]` in
  the caller's order. When the round's first target isn't in the pool, a target that is
  gets used as a proxy for a different target, rather than being asked directly for its own
  round. We haven't measured whether this matters.

Slynk's other changes to xxDK, including two more in the pickup code (a crash fix for
failed historical lookups, and reporting how far a look-back has got), are in
[xxdk-changes.md](xxdk-changes.md).

## Sources

- xxDK v4.8.4: `gitlab.com/elixxir/client/v4`, mirrored at github.com/xxfoundation. Files
  `cmix/pickup/{params,unchecked,retrieve,get}.go`, `cmix/pickup/store/store.go`,
  `cmix/gateway/{sender,pool}.go`
- Keith Millette's fork of xxDK: `gitlab.com/keith16/client`, tag `v4.8.5-courier.5`
- Slynk's patch: [third_party/xxdk-client/cmix/pickup/retrieve.go](../../third_party/xxdk-client/cmix/pickup/retrieve.go)
  and its tests

## Credits

Thanks to the xx foundation for cMix, the xx network and xxDK, to Rick Carback, the leading
contributor to xxDK, and to Keith Millette, whose fork Slynk builds on.

— Slynk
