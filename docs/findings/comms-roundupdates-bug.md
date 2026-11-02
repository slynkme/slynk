# comms: `Instance.RoundUpdates` drops upcoming rounds, and doesn't remove rounds that fail before their start

*Slynk, 2026-10-31. All times UTC.*

This is a bug in the xx network's comms library (module `gitlab.com/elixxir/comms`) that
every client built on xxDK runs into: it hides about half of the upcoming mixnet rounds
from the client, so a bulk sender waits for rounds it could have used. It's written for xx
network developers and anyone building on xxDK. It covers the bug, what it did on mainnet,
the one-line fix, a reproduction, and how Slynk works around it without changing comms.
The longer story of Slynk's upload speed, of which this was the largest part, is in
[upload-throughput-2026-10.md](upload-throughput-2026-10.md).

## 1. Where it is

- **comms v0.0.6**, the version xxDK v4.8.4 requires. The same code is in the newest comms
  source in the xx foundation's GitHub mirror, as far as we can tell.
- Slynk builds on Keith Millette's fork of xxDK (tag `v4.8.5-courier.5`, based on v4.8.4),
  which doesn't touch the code involved. The client follower (`cmix/follow.go`) calls
  `Instance.RoundUpdates` with every poll's round updates, the same as stock xxDK.
- Gateways forward only QUEUED, COMPLETED and FAILED updates to clients (gateway
  `cmd/filteredUpdates.go`), so those are the states that matter here. A round is QUEUED
  when it has been scheduled and given a start time; senders pick from the rounds that are
  QUEUED and haven't started yet, which comms keeps in a "waiting list"
  (`network/dataStructures/waitingRounds.go`).

## 2. The bug

`RoundUpdates` in `network/instance.go` is the plural form the follower calls. It sorts each
update into rounds to add to the waiting list and rounds to remove, but assigns the second
slice to the wrong variable:

```go
state := states.Round(round.State)
if state == states.QUEUED {
    addedRounds = append(addedRounds, rnd)
} else if state > states.QUEUED {
    addedRounds = append(removedRounds, rnd) // line 481: should assign to removedRounds
}
...
i.waitingRounds.Insert(addedRounds, removedRounds)
```

`removedRounds` stays empty, so every update past QUEUED **replaces** `addedRounds` with a
one-element slice holding that round. Three effects follow:

1. **Upcoming rounds are dropped.** Every QUEUED round listed before a COMPLETED or FAILED
   update in the same poll is thrown away. It never reaches the waiting list, so
   `GetUpcomingRealtime` never offers it to a sender.
2. **Nothing is removed by state.** A round that was QUEUED in one poll and FAILED before
   its start in the next stays in the waiting list, offered as sendable, until its start
   time passes.
3. **A failed round can be added.** If the last update past QUEUED in a poll is a FAILED
   round whose start time is still in the future, `Insert` adds it as sendable. Its doc
   comment says it skips rounds that aren't QUEUED, but the code only checks the start
   time.

Polls routinely mix QUEUED updates with finished ones, so the first effect is large.

## 3. What it did on mainnet

On 2026-10-14 we instrumented ten uploads, of 250 KB and 1 MB, and compared each poll's
updates with the waiting list straight after `RoundUpdates`. A round counted as *announced*
if its last update in the poll was QUEUED with a future start time, and as *missing* if it
wasn't in the waiting list afterwards.

- **36–70% of announced upcoming rounds were missing per upload** (276 of 550 overall),
  and 47–48% in the two uploads with stock behaviour.
- **Every one of those losses came from this line.** Separately, about 4% of QUEUED updates
  arrived too late to use.
- **Effects 2 and 3 never occurred** in the 501 polls we logged: no finished or failed round
  was ever in the waiting list, because rounds almost always fail after their start time.

## 4. Why it matters

xxDK's channels file transfer puts at most one batch of parts into each round, so a bulk
sender spends most of its time waiting for a round it can see. In our baseline uploads, 97%
of round picks had to wait for one. With half the announced rounds hidden, a sender gets
about half the throughput the network offers. A single chat message is likely to wait
longer for a usable round too, though we haven't measured that.

## 5. The fix

One line in comms:

```go
} else if state > states.QUEUED {
    removedRounds = append(removedRounds, rnd)
}
```

## 6. Reproduction

Two hand-made polls, each in update-ID order as a gateway returns them, with start times
relative to now:

| Poll | Round | State | Start |
|---|---|---|---|
| 1 | 95 | QUEUED | +7 s |
| 2 | 100 | QUEUED | +5 s |
| 2 | 90 | COMPLETED | −3 s |
| 2 | 101 | QUEUED | +6 s |
| 2 | 95 | FAILED | +7 s |
| 2 | 103 | QUEUED | +9 s |
| 2 | 103 | FAILED | +9 s |
| 2 | 102 | QUEUED | +8 s |
| 2 | 104 | QUEUED | −1 s (already started) |

After both polls, stock `RoundUpdates` leaves the waiting list as `[95 102 103]`: 100 and
101 are dropped, the failed 95 is never removed, and the failed 103 is added. With the
one-line fix it would be `[100 101 102]`.

The test is
[third_party/xxdk-client/cmix/roundUpdatesFix_test.go](../../third_party/xxdk-client/cmix/roundUpdatesFix_test.go).
It fails with "has comms changed?" if stock `RoundUpdates` ever stops giving
`[95 102 103]`, so a comms upgrade that fixes the bug shows up at once.

## 7. How Slynk works around it

Slynk keeps the unmodified comms v0.0.6 release and repairs the waiting list in the client
instead
([third_party/xxdk-client/cmix/roundUpdatesFix.go](../../third_party/xxdk-client/cmix/roundUpdatesFix.go),
called from `cmix/follow.go` straight after `RoundUpdates`). For each poll,
`requeueDroppedRounds` re-inserts every round that:

- has QUEUED as its last update in the poll,
- hasn't started yet,
- is missing from the waiting list, and
- has a stored round (`GetWrappedRound`) whose start time matches the update.

It only puts back what the poll announced, using the wrapper `RoundUpdates` itself stored,
so it never offers a round the stock code wouldn't have offered had the line been right. On
the reproduction it gives `[95 100 101 102 103]`: it restores 100 and 101, but, like stock,
keeps the failed 95 and 103. It doesn't remove failed rounds, because on mainnet that case
never arose (section 3).

With the workaround, no announced round stayed lost. Uploads with it but stock batch sizes
used 67–70% of the round IDs they spanned, against 38–43% for stock. Together with fuller
batches, a 1 MB upload used 83% and ran at 10.4 KB/s, against about 3 KB/s for stock on
the same path (measured on mainnet on 2026-10-14; the details are in
[upload-throughput-2026-10.md](upload-throughput-2026-10.md)). The workaround is one of
Slynk's changes to xxDK, all listed in [xxdk-changes.md](xxdk-changes.md).

Once comms is fixed, the workaround becomes a no-op: with nothing dropped, it finds nothing
to put back.

## Sources

- comms v0.0.6, `network/instance.go` (`RoundUpdates`) and
  `network/dataStructures/waitingRounds.go` (`Insert`): `gitlab.com/elixxir/comms`, mirrored
  at github.com/xxfoundation
- xxDK v4.8.4, `cmix/follow.go`: `gitlab.com/elixxir/client/v4`, mirrored at
  github.com/xxfoundation
- the xx gateway's `cmd/filteredUpdates.go`, which forwards QUEUED, COMPLETED and FAILED
  updates
- Keith Millette's fork of xxDK: `gitlab.com/keith16/client`, tag `v4.8.5-courier.5`

## Credits

Thanks to the xx foundation for cMix, the xx network and xxDK; to Rick Carback, the leading
contributor to xxDK and one of the main authors of its comms code; and to Keith Millette,
whose fork Slynk builds on.

— Slynk
