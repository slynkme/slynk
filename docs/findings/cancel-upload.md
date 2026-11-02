# Stopping an upload part-way

*Slynk, 2026-10-31. All times UTC.*

Slynk lets a sender press Cancel while something is still being sent. The upload stops, no
link is made, and nobody can open what got out. Stock xxDK can't do this: its file transfer
has no way to cancel an upload under way. This write-up covers the small addition Slynk
makes to xxDK to allow it, how the app uses it, what we measured on mainnet, and what
stays on the network afterwards. It's for xx network developers and curious technical
readers, and it's the detail behind the About page's answer to "Can I take a link back?"
for a send still under way. Cancelling a link once it's made works through slynk.me's key
server instead, and is covered in [one-time-links.md](one-time-links.md).

## In short

- Slynk adds `Wrapper.CancelUpload` to xxDK's channels file transfer. It fails the
  transfer on purpose and closes it out. It builds on Keith Millette's fork, whose send loop
  already drops the parts of a transfer that isn't running.
- After a cancel, at most one batch per sending worker can still leave: 4 batches of up to
  11 pieces. On mainnet, 3 batches went out within 2 s of a cancel, and nothing after.
- The pieces that got out stay on the network until it sweeps them by age, after about three
  weeks. They can't be read without the link, and the link is never made.
- For a one-time link, slynk.me's key server is also told to destroy its half of the key.
- The tab's identity stays connected, so the sender can fix what they were sending and send
  again at once.

## 1. What stock xxDK does

xxDK's channels file transfer (`channelsFileTransfer`) splits a file into parts of about 920
bytes, encrypted under a key made for that transfer. The parts go through a few queues:

1. **The batch builder** collects parts into batches of a random size (1 to 11 parts in
   stock xxDK, 9 to 11 by default in Slynk).
2. **Four sending workers** (`workerPoolThreads = 4`) each take a batch and call `SendMany`,
   which waits for a usable mixnet round and hands the batch to that round's gateway.
3. **Failed batches** go back to the queue to be sent again.

A transfer ends only when every part is delivered, or when it fails by running out of
retries. The wrapper's `CloseSend` refuses a transfer that is neither completed nor failed
("file not completed or failed"), and nothing else lets a caller fail one. So a sender who
picked the wrong file could only wait for it to finish, or close the tab, which also ends
the tab's mixnet identity.

## 2. What Keith Millette's fork already did

Slynk builds on Keith's fork of xxDK (tag `v4.8.5-courier.5`, based on v4.8.4). Among its
send-reliability fixes, the send loop checks the transfer's status wherever a part can be
waiting, and drops the parts of any transfer that isn't `Running`:

- as parts leave the batch builder's queue (`batchBuilder.go`), the one point every re-queue
  passes through;
- just before `SendMany`, where a batch's parts are skipped and an empty send isn't made
  (`send.go`, `sendCmix`);
- when failed parts are re-queued after their backoff (`send.go`).

The fork added this so that a transfer that has failed stops circulating. It also means
that a transfer failed on purpose stops sending at once.

## 3. Slynk's addition: `CancelUpload`

Two small new files, with no upstream lines changed:
[channelsFileTransfer/cancelUpload.go](../../third_party/xxdk-client/channelsFileTransfer/cancelUpload.go)
and
[channelsFileTransfer/store/sentCancel.go](../../third_party/xxdk-client/channelsFileTransfer/store/sentCancel.go).

`Wrapper.CancelUpload(fileID)`:

1. finds the transfer, and does nothing if it has already finished and been closed out;
2. marks it failed (`SentTransfer.Cancel`, which calls the store's own
   `markTransferFailed`), so the fork's checks drop its parts wherever they are;
3. closes it out (`closeSend`): its record is deleted, it leaves the list of transfers, its
   progress callbacks are removed, and so is Slynk's confirm-by-round entry, so a round
   that carried some of its parts and reports later can't complete it;
4. marks the file as `Error` in the event model.

Uploading the same file again starts afresh, with a new random recipient ID. The tests
(`cancelUpload_test.go`) check each queue: a batch waiting to go is skipped, parts waiting
to be batched are dropped, parts re-queued after a failed round aren't put back, and a late
round result doesn't complete the cancelled upload. They pass with the whole
`channelsFileTransfer` suite.

## 4. How Slynk uses it

**In the core** ([core/transfer/transfer.go](../../core/transfer/transfer.go)):
`UploadStoppable` is `Upload` with a stop channel. When the stop closes, it calls
`CancelUpload`, deletes the file from its in-memory event model and returns
`ErrUploadStopped`. The identity carries on.

**In the browser bridge** ([core/cmd/wasm/main.go](../../core/cmd/wasm/main.go)):
`slynkCore.stopUpload()` closes the running upload's stop. The stop is in place before
`upload` returns its promise, so a tap that comes straight after starting always finds it,
even before the first piece has gone.

**On the page** ([web/src/main.ts](../../web/src/main.ts)): while a link is being sent, the
progress line has a small Cancel link. It asks "Stop sending?", and stopping takes the
sender back to the composer as it was, with their message, files and settings, and the
note "Sending stopped". If the upload finishes just as it's stopped, the link it hands back
is wiped, not shown.

**File messages to an inbox.** In a copy of Slynk with files to inboxes turned on (the
`INBOX_FILES` setting, off on slynk.me), the message telling the inbox about an upload
waits 1 to 3 minutes after the upload's last piece, so the two don't sit side by side in
the network's rounds. The bridge's `stopFileNotice()` stops it while it's still waiting.
Once it has started to go it can't be called back, and the page says it's too late.

## 5. What can still leave after a cancel

A batch that a sending worker has already passed to `SendMany` is out of the file
transfer's hands: it may be waiting for its round, but it will go. So up to one batch per
sending worker can still leave after a cancel, that is, 4 batches of at most 11 pieces.

**Measured on mainnet on 2026-10-17,** with xxDK's logs on:

- A 250 KB upload was stopped at 22% (62 of 271 pieces). Three batches already inside
  `SendMany`, waiting for their rounds, went out within 2 s of the cancel. Nothing more of
  it was sent in the next 30 s.
- The same tab then sent again in full straight away, and a second tab opened that link
  intact.
- On slynk.me the same evening, a 150 KB one-time send was stopped at 37% (61 of 163
  pieces). The page went back to the composer with the file kept and the identity still
  connected, and the key server's answers to setting up the link and to cancelling it were
  both ok.

## 6. What stays on the network

The xx network has no way to delete a message once it's delivered: gateways keep each
round's messages until they sweep them by age, after a cut-off the network sets (xxDK
assumes 500 hours, about three weeks; links 18 days old have been collected).
So the pieces that got out stay there until then. That's why a cancel can't be undone on
the network, only made harmless:

- **They can't be read without the link.** The pieces are encrypted under the transfer's
  key, which only the link carries. A cancelled upload never produces a link, and its
  record, key included, is deleted from the tab's in-memory store.
- **Nobody knows where to look.** They were sent to a random recipient ID used for nothing
  else, which is also only in the link.
- **What the network saw** is what it sees of any upload: a sender putting batches into
  rounds for one recipient ID. Stopping part-way doesn't change that, it only makes it
  shorter.

## 7. The one-time link's half of the key

On slynk.me every link opens once. Before the upload starts, the page seals what's being
sent in an outer layer whose key is in two halves: one for the link, and one kept by
slynk.me's key server until the link is opened
([web/src/burn.ts](../../web/src/burn.ts)). The pieces on the network are this sealed
copy (locked with the password as well, for a password link).

When a send is stopped:

- **during the password step** (a password link's key takes a moment to make), nothing has
  gone anywhere yet;
- **while the key server is being asked, or during the upload,** the page asks the key
  server to revoke its half. The server replaces the half with a marker saying the link was
  cancelled, so the half is gone for good. With cover requests on (the default), the
  request goes quietly in place of one of the cover requests every tab sends, since nobody
  waits for it and the half would expire anyway. The link's own half was only ever in the
  tab, and is wiped.

So what got out is locked twice over: by the transfer's key, which nobody gets, and by a
one-time key whose server half no longer exists.

## 8. Is it worth taking upstream?

We think so. It's small, it changes no upstream lines, and any app with a "stop" button
needs it, with one condition: it depends on the fork's status checks in the send loop.
Without those, failing a transfer would leave its queued parts circulating. Both together
give a cancel whose cost is bounded by the number of sending workers. Slynk's other changes
to xxDK are listed in [xxdk-changes.md](xxdk-changes.md).

## Sources

- xxDK v4.8.4, `channelsFileTransfer/{wrapper,manager,send,batchBuilder}.go`:
  `gitlab.com/elixxir/client/v4`, mirrored at github.com/xxfoundation
- Keith Millette's fork of xxDK: `gitlab.com/keith16/client`, tag `v4.8.5-courier.5`
  (its channelsFileTransfer send backoff, which drops a non-running transfer's parts)
- Slynk's addition:
  [third_party/xxdk-client/channelsFileTransfer/cancelUpload.go](../../third_party/xxdk-client/channelsFileTransfer/cancelUpload.go)
  and its tests; the core's `UploadStoppable`
  ([core/transfer/transfer.go](../../core/transfer/transfer.go)); the bridge's
  `stopUpload` and `stopFileNotice`
  ([core/cmd/wasm/main.go](../../core/cmd/wasm/main.go),
  [core/cmd/wasm/inbox.go](../../core/cmd/wasm/inbox.go))

## Credits

Thanks to Keith Millette, whose fork's send-loop fixes this builds on, to the xx foundation
for cMix, the xx network and xxDK, and to Rick Carback, the leading contributor to xxDK and
its file transfer.

— Slynk
