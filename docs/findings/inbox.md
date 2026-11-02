# Slynk's anonymous inbox: a mailbox made of the xx network

*Slynk, 2026-10-31. All times UTC.*

Slynk is a private, link-based file and message drop built on the xx network's cMix
mixnet. Everything happens in the visitor's browser: it joins the mixnet as a new,
in-memory identity, and the website only serves static files. Besides one-to-one links,
Slynk offers anonymous inboxes: a permanent address, shared as a link or QR code, that
anyone can write to without an account, and that only the holder of 12 words can read.

This note explains how an inbox works underneath: where its messages wait, what the 12
words make, how a message is sealed so it looks like random bytes, how the owner finds
their messages, and what the design can't hide. It's written for xx network developers
and anyone who wants to check the reasoning. The quantum-safe address every inbox also
has is in its own note, [quantum-safety.md](quantum-safety.md).

## In short

- **No server holds anything.** A message is one sealed cMix message to a mailbox worked
  out from the inbox's public key, where it waits for up to about three weeks. The
  owner's browser joins as a fresh identity and looks back through the mailbox's history.
- **12 words are the only secret:** every key, the address and the mailbox come from
  them.
- **Every message looks the same:** one full cMix message, every byte random-looking.
- **The link is the address.** Inboxes have no names.
- **Replies are opt-in,** proved to the owner but deniable to everyone else.
- **What it can't hide:** anyone with the address can see when messages reach its
  mailbox, and how many.
- **We found a crash in xx's crypto library** on crafted keys, which xx's direct
  messages reach: one crafted DM looks able to crash its recipient's client (section 11).

## 1. The mixnet is the mailbox

A cMix message is sent to a recipient ID and stored by the gateways of the round that
carried it, until the network sweeps it by age (xxDK assumes 500 hours, about three
weeks; Slynk has collected messages 17 days old). Picking messages up needs no account: a request names
only a short mailbox label (an ephemeral ID, derived from the recipient ID, which many
recipients share) and a round (`GetMessages` in comms v0.0.6). The label changes every
24 hours.

So an inbox needs no storage of its own. Its mailbox is a reception ID hashed from its
public key, `BLAKE2b-256("slynk/inbox/v1/mailbox" ‖ ed25519 key)` with xx's "User" type
byte ([inbox.go](../../core/transfer/inbox.go), `inboxMailboxID`). The label is
Slynk's own, so the same key used as an xx DM identity would have a different mailbox.
There's no DM-style token: for a public inbox, being reachable from the key alone is the
point.

To read it, the owner's browser tracks that ID back through history (section 5). Most of
what it collects belongs to other recipients sharing the label; whatever the inbox's key
doesn't open is ignored.

## 2. Twelve words, and what comes from them

An inbox is 128 random bits from the browser's `crypto.getRandomValues` (via Go's
`crypto/rand`), written as 12 BIP-39 words with their checksum (xx's `mnemonic`
package). Owners never choose the secret: the public key lets anyone test guesses
offline. Everything else is derived with HKDF-SHA256 under labels of its own
([inbox.go](../../core/transfer/inbox.go), `inboxKeyFromEntropy`):

| Derived | Label | Used for |
|---|---|---|
| ed25519 seed | `slynk/inbox/v1/ed25519` | the public key in the address, the mailbox, signing the quantum-safe address |
| X25519 key | (the clamped ed25519 scalar) | opening messages, reply proofs |
| ML-KEM-768 seed | `slynk/inbox/v4/mlkem768` | the quantum-safe address |
| reply root | `slynk/inbox/v4/reply` | reply keys ([reply.go](../../core/transfer/reply.go)) |
| store secret, 48 bytes | `slynk/inbox/v1/store` | sealing and naming what's kept on a device (`InboxKey.StoreSecret`) |

The X25519 key is the ed25519 scalar, so its public key is the Montgomery form of the
ed25519 key in the address: one key for signing and key exchange, as with Signal's XEdDSA
(sound for this use; see [quantum-safety.md](quantum-safety.md)). Creating an inbox works
offline, and nothing is stored until its owner asks: they type 3 of the 12 words back
before the inbox is ready ([create.ts](../../web/src/inbox/create.ts)).

## 3. The address, and why inboxes have no names

A compact address is 33 bytes: a version byte (3, after the link versions 1 and 2, so
one byte tells a fragment's kind) and the ed25519 key. On slynk.me it's
`https://slynk.me/#` plus 44 base64url characters, 62 in all, which fits a version 4 QR
code (33 squares a side) at correction level M
([address.ts](../../web/src/inbox/address.ts)). It holds no secret.

Every address is checked before anything is sent to it, because addresses come from
anyone: the key must be a canonical encoding of a curve point, and not of small order,
or every sender's shared secret would be predictable (`newInboxAddress`).

Early designs gave each inbox a codename worked out from its key, as xx's apps do. We
dropped it: codenames come from fixed word lists, so anyone can grind keys until one
gives the codename they want, and a name only helps people trust an address if a
directory says who owns it, which we don't want to run. So the link itself is the
address, and where it's published (an organisation's own website, a poster) is what
people trust. The owner can give the inbox a label, and senders names in an address book,
but these stay on the owner's side ([mailbox.ts](../../web/src/inbox/mailbox.ts)). Before
writing, a sender can compare the address they're using with one they paste or scan
([check.ts](../../web/src/inbox/check.ts)).

## 4. A notice: one sealed, random-looking message

A message to a compact address (Slynk's code calls it a notice) fills exactly one cMix
message. On mainnet's 4,096-bit group a message has 926 bytes of contents. As xx's DMs
do, Slynk also fills the key-fingerprint and MAC fields, all but their first byte (whose
top bit the network needs clear, so it's random with that bit 0): 62 more, 988 in all.

```
stream:    key(32) sealed(plaintext)
plaintext: version(1) kind(1) bodyLen(2) round(4) id(8) body zeros
```

- **Sealing** is HPKE (RFC 9180) from Go's standard library: DHKEM(X25519,
  HKDF-SHA256), HKDF-SHA256 and ChaCha20-Poly1305, with the info string
  `slynk/inbox/v1/notice`. That leaves 924 bytes for the body.
- **The one-time key is Elligator 2 encoded.** A plain X25519 public key is easy to
  recognise (its top bit is always clear, and it's always in the prime-order subgroup).
  The sender adds a random small-order point, keeps only keys that have an Elligator
  representative (about half), picks one of its two representatives at random and fills
  the spare top bits with random bits ([elligator.go](../../core/transfer/elligator.go)).
  The owner reverses it with one scalar multiplication. The encoded key is the AEAD's
  associated data, so a copy re-encoded by someone else won't open.
- **Every notice is padded** to the same size. Text may be compressed with raw DEFLATE
  first (Haven compresses too), up to 8,192 bytes unpacked: about 1,800 characters of an English
  letter fit.
- **The round is sealed in.** The low 32 bits of the round it goes in are sealed as it's
  sent (through xxDK's assembler, which asks again for every round it tries), and the
  owner drops a notice found in any other round. Anyone with the address can fetch its
  mailbox's messages, so this stops an old notice being sent again as new. xx's DMs do
  the same (`dm/receiver.go`).
- **A random 8-byte id**, the same for every try at one notice, means a retry that
  arrived after all shows once.

So every byte of every message looks random, as a cover message's does (Slynk's optional
blank messages are shaped exactly like compact notices,
[cover.go](../../core/transfer/cover.go)). "Delivered" means the round succeeded — the
network accepted it, not that anyone has read it — and the sender never tracks the
mailbox, which would tie their internet address to it. A small mainnet test on 2026-10-14
found an Elligator-encoded notice 1.5 s after a fresh identity connected.

## 5. Opening an inbox: the look-back

The owner's page opens the inbox looking back `lookbackSince`, 500 hours, which xxDK
clamps to what it keeps ([core/cmd/wasm/inbox.go](../../core/cmd/wasm/inbox.go)), walking
back through each past day's label newest first. Every message is tried as a compact
notice, then as a reply, then held to be paired as half of a quantum-safe notice
([inbox.go](../../core/transfer/inbox.go), `Process`).

Stock xxDK can't say when a look-back is finished, so Slynk's fork adds
`LookbackStatus`: labels still to check, and pickups under way or failed. The page shows
"finished" once both are 0 for 3 s (never before 10 s), or, if only rounds the network
won't hand over are left, after a minute, saying some weren't. Three more fork patches
matter here, all in [third_party/xxdk-client/](../../third_party/xxdk-client/) (lines
marked `Slynk:`): a historical round lookup that failed for good used to panic the client
on an empty round's nil topology, common over three-week look-backs; a day's rounds are
now picked up oldest first, so messages arrive in order; and a failed pickup is retried
once after 10 s rather than waiting for xxDK's two-minute sweep.

Measured on mainnet on 2026-10-16: Slynk's command-line client looked back 21 days in 1
min 51 s, and a browser tab finished looking back 145 s after Open, about 30 s of it
joining the network. On 2026-10-31 a look-back found notices sent 17 days earlier. A
kept inbox (section 8) looks back only to where it left off, skipping days a look-back
cut short had already finished (`AddIdentityWithHistorySkipping`), though xxDK always
checks at least about a day.

## 6. A separate identity for writing to inboxes

cMix nodes see which identity sent each message. If the identity a tab uses to make
links or to check its own inbox also sent messages to inboxes, the network could tie
them together. So a message to an inbox never goes from an identity that makes links or
checks an inbox ([main.ts](../../web/src/main.ts), "Which identity does what"):

- a tab that only writes to inboxes uses its one identity;
- a tab whose identity has made a link or opened an inbox sends from a second identity in
  the same worker, which connects as soon as someone starts writing, so the moment it
  registers doesn't mark the moment of sending;
- a tab that has written to an inbox gets a fresh identity before it makes a link,
  collects one or opens an inbox.

The two still come from one internet address, which a gateway could see; the About page
says so, and that a VPN hides it.

## 7. Replies: including your own inbox

Anonymous is the default. A sender who has their own inbox open can switch on "Let them
reply" and give a name. The notice then carries their compact address, the name (up to
40 characters, 160 bytes) and a 32-byte proof:

```
body:  fromAddress(33) nameLen(1) name proof(32) [replyKeys(40)] rest
proof: HMAC-SHA256(fromKey, sealed keys ‖ plaintext up to the proof ‖ rest)
```

`fromKey` is HKDF over X25519 between the sender's inbox key and the recipient's, so only
those two inboxes can make it. That convinces the owner, who knows they didn't; but the
owner could have made it too, so unlike a signature it proves nothing to anyone else. A
notice whose proof fails is refused whole. One limit follows: someone who had the owner's
12 words could write to them as if from any inbox. Including an inbox takes 66 bytes plus
the name, leaving 858 bytes for text with no name. In a quantum-safe notice it also
carries the sender's reply keys, so the answer is quantum-safe too
([quantum-safety.md](quantum-safety.md)).

Anyone can choose any name, so the owner's page tells senders apart only by their inbox,
never by name. Names are cleaned before they're shown (Unicode NFKC; invisible,
control, format, private-use and unassigned characters removed; at most two combining
marks on a letter) and compared after folding case, accents and letters that look like
Latin ones (Unicode's confusables, UTS #39), so the owner is warned when a name changes
or looks like another sender's ([names.ts](../../web/src/inbox/names.ts)).

## 8. On the owner's device: keeping, remembering, backing up, blocking

By default an inbox lives in the tab's memory only, and Lock ends the worker, the only
way to be sure Go's memory is gone. Three things are opt-in:

- **"Keep this inbox on this device"** keeps one IndexedDB record: messages, folders,
  titles, read state, the address book, senders and their names, reply keys, sent
  messages, blocks, and entries for uploads, never files. It's sealed with AES-256-GCM
  under the first 32 bytes of the store secret; the other 16 name the record, so the
  device doesn't say which inbox it is. Contents are padded to 16 KB steps
  ([kept.ts](../../web/src/inbox/kept.ts)). The words themselves aren't kept.
- **"Remember my passphrase"** keeps the 12 words beside that record. Without a password
  they're kept as they are, so the inbox opens with a tap; with one, they're sealed as a
  key file is (Argon2id with 64 MiB, 3 passes, then AES-256-GCM under a label of their
  own), and since the record's key comes from the words, the password guards everything
  kept ([rememberPw.ts](../../web/src/inbox/rememberPw.ts)).
- **Backup files** hold the words (and label) sealed the same way, with a password of at
  least 12 characters; "Back up your inbox" adds everything kept, padded to 16 KB steps,
  under another label ([keyfile.ts](../../web/src/inbox/keyfile.ts)).

**Blocking** needs a sender who included their inbox, and an inbox kept on the device
so the block is remembered. It can't stop anything reaching the owner: nobody can tell
who sent a message until the owner's page opens it. So a blocked sender's messages are
set aside (out of the list, the counts and the alerts), the newest 100 kept in case
they're unblocked (`Mailbox.setAside`).

## 9. Files and longer messages, where a site turns them on

slynk.me's inboxes take one-piece messages only (`INBOX_FILES` is false in
[site.ts](../../web/src/site.ts)), and its pages don't collect uploads sent from other
copies of Slynk. The reason: an upload is many pieces, and while few people use the
network, a gateway operator could sometimes match a large upload to the internet address
it came from and to the inbox it was for, whose owner is often public.

A copy of Slynk that turns the switch on sends anything that won't fit one notice as an
ordinary upload, up to 2,000,000 bytes, to a random single-use pickup address, as a link
would, from the tab's own identity. A notice carrying its plain 148-byte link (never a
key-server link, so inboxes don't depend on one) follows from the second identity, a
random 1 to 3 minutes after the upload ends (`UploadNoticeDelay`), so the two don't sit
side by side in the network's rounds ([drop.ts](../../web/src/inbox/drop.ts)). The owner
collects it on a tap, one at a time, straight from the notice and never through a URL;
files are never kept on the device.

## 10. Limits

- **Size:** 924 bytes a message after compression (652 to a quantum-safe address). The
  owner's page holds up to 5,000 messages; a flood past that is counted, not shown.
- **Three weeks:** gateways sweep messages by age, read or not (xxDK assumes 500 hours). An owner
  who doesn't keep their inbox should open it at least weekly.
- **What anyone with the address sees:** the mailbox follows from the address, so they
  can ask the network when messages arrived there and how many. Never what they say or
  who sent them.
- **What the network sees:** gateways see a sender's internet address, temporary
  identity, and when and how many pieces they send. A message hides among its round's
  other senders, a small crowd on today's network
  ([gateway-metadata.md](gateway-metadata.md)). The owner's gateways see the owner's
  internet address beside the mailbox. A VPN hides either.
- **Classical encryption:** a compact address is an X25519 key, which a future quantum
  computer could break ([quantum-safety.md](quantum-safety.md)).
- **No outside audit** of this code has been done.

## 11. A crash in xx's crypto library

While building the inbox we found that `gitlab.com/elixxir/crypto` v0.0.15, the version
xxDK v4.8.4 requires (Keith Millette's fork requires it too), can be made to panic by a
crafted public key, and that xx's direct messages (`dm`) reach that code both when
sending and when receiving. A panic that nothing recovers ends the whole program, so on
the receiving side this looks like a way for anyone to crash someone else's DM client.

### The cause, in `nike/ecdh`

Two small issues combine:

- **`Edwards2EcdhNikePublicKey` ignores an error** (`nike/ecdh/edwards.go`). It calls
  `PublicKey.FromEdwards`, which returns an error when the bytes aren't a point on the
  curve, and drops it, leaving the key empty. `FromEdwards`, and `FromBytes` which calls
  it, also accept points of small order: the identity point (encoded `01 00 … 00`)
  decodes cleanly and converts to an all-zero X25519 key.
- **`PrivateKey.DeriveSecret` panics rather than returning an error**
  (`nike/ecdh/ecdh.go`). It passes any error from X25519 to `panicOnError`, which calls
  `jww.FATAL.Panic`. X25519 fails on an empty key and on a small-order point.

So a key that isn't a point reaches the panic through the ignored error, and the
identity point reaches it through X25519's own refusal, even where the caller checks
`FromBytes`'s error.

### Where xx's direct messages reach it

- **Receiving.** xxDK's `dmProcessor.Process` (`dm/receiver.go`) hands each DM to the
  crypto library's `dm.Cipher.Decrypt` (`dm/cipher.go`). After the Noise layer is
  removed, `Decrypt` reads the sender's static key with `FromBytes`, which refuses a
  non-point but accepts the identity point, then calls `DeriveSecret` on it, before the
  message's integrity check (`isValidBengerCode`) on the next line. So the check doesn't
  help: the panic comes first. Building such a message needs only the recipient's DM
  public key and DM reception ID, which anyone in a channel where they post with DMs
  enabled can see: encrypt to their key a payload whose embedded sender key is the
  identity point, and send it to their reception ID. It matches no fingerprint or
  service, so xxDK's message handler passes it to the DM processor, its fall-through
  processor, in the same call (`cmix/message/handler.go`). There's no `recover()` in the
  `dm` package or on that receive path, so the panic ends the client. Messages still
  being processed are kept and tried again later (the in-process buffer drops one only
  after 10 tries and 15 minutes, by default), so such a message might crash the client
  again after a restart; we haven't tested that.
- **Sending.** `Send` (`dm/send.go`) computes the message's tag with `MakeSenderSihTag`
  (`dm/sihTag.go`) before anything is sent, which converts the partner's key with
  `Edwards2EcdhNikePublicKey` and calls `DeriveSecret`. `Send` checks only that the
  partner's key isn't missing or all zeros, so sending to a crafted key panics. How
  reachable this is depends on how an app accepts a DM recipient's key; we haven't
  looked at each app.

`DeriveSecret` has other callers in xxDK (node registration, with keys from the signed
network definition, and the RPC module's Noise handshakes); the DM paths are the ones
clearly open to anyone.

### What we checked, and what we didn't

Offline, against v0.0.15's code, we confirmed both panics: the identity point decodes,
converts to an all-zero key and makes X25519 fail; a non-point leaves an empty key that
makes X25519 fail; either way `panicOnError` panics, and a genuine key doesn't. We read
the send and receive paths above in xxDK v4.8.4 (the same in Keith Millette's fork).
We didn't run an xx app or send anything on the network, so that a crafted DM reaches a
running client and crashes it is inferred from the code, not observed. Nor did we check
which crypto version each shipping app uses.

### How it could be fixed

In `nike/ecdh`: return `FromEdwards`'s error from the `Edwards2Ecdh…` conversions rather
than dropping it; reject small-order points in `FromEdwards` and `FromBytes` (for
example, a point whose multiple by the cofactor is the identity); and have `DeriveSecret`
return an error instead of panicking. The first two together, or the third alone,
remove the crash; all three is cleanest. Code that takes keys from strangers, as the DM
paths do, should also validate them or recover.

### How Slynk avoids it

Slynk never uses `nike/ecdh` or xx's `dm` package. It converts keys with
`filippo.io/edwards25519`, refusing non-canonical and small-order points
(`newInboxAddress`), does X25519 with Go's `crypto/ecdh`, which returns an error for an
all-zero result (`fromKey`), and, because anyone can send to an inbox, recovers from a
panic in its own message handler (`Process`), counting the message as unreadable.

## Sources

- Slynk: [core/transfer/inbox.go](../../core/transfer/inbox.go),
  [elligator.go](../../core/transfer/elligator.go),
  [reply.go](../../core/transfer/reply.go), [cover.go](../../core/transfer/cover.go) and
  their tests; [core/cmd/wasm/inbox.go](../../core/cmd/wasm/inbox.go);
  [web/src/inbox/](../../web/src/inbox/); [web/src/site.ts](../../web/src/site.ts);
  Slynk's xxDK patches in [third_party/xxdk-client/](../../third_party/xxdk-client/).
- xxDK v4.8.4 (github.com/xxfoundation mirror): `cmix` (`AddIdentityWithHistory`),
  `dm/send.go`, `dm/receiver.go`, `dm/client.go`, `cmix/message/handler.go`. comms v0.0.6: `gateway/endpoint.go`,
  `mixmessages/mixmessages.proto` (`GetMessages`). `gitlab.com/elixxir/crypto` v0.0.15,
  the version xxDK v4.8.4 requires: `nike/ecdh/edwards.go`, `nike/ecdh/ecdh.go`,
  `dm/cipher.go`, `dm/sihTag.go`.
- Keith Millette's fork, `gitlab.com/keith16/client`, tag `v4.8.5-courier.5`, on which
  Slynk's patches build.
- RFC 9180 (HPKE); RFC 9380, section 6.7.1 (the Elligator 2 map); Bernstein, Hamburg,
  Krasnova and Lange, "Elligator", 2013; BIP-39; RFC 8032.
- Unicode Technical Standard #39 (confusables), version 17.0.0.

## Credits

Thanks to David Chaum and the cMix authors, and to the xx foundation, for cMix, the xx
network and xxDK; to Rick Carback, the leading contributor to xxDK and xx's crypto code;
to Keith Millette, whose fork Slynk builds on; and to the authors of Go's `crypto/hpke`
and `crypto/ecdh` and of `filippo.io/edwards25519`.

— Slynk
