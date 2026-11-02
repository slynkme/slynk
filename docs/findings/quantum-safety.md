# Quantum safety in Slynk: what's protected, and the quantum-safe inbox

*Slynk, 2026-10-31. All times UTC.*

Slynk is a private, link-based file and message drop built on the xx network's cMix
mixnet. Everything happens in the visitor's browser: it joins the mixnet as a new,
in-memory identity, sends encrypted pieces, and hands back a link whose secret travels
only in the part after the `#`. Slynk also offers anonymous inboxes: an address anyone
can write to, read with 12 words only its owner holds (how they work is in
[inbox.md](inbox.md)).

This note explains which parts of Slynk would stay private if large quantum computers
arrive, why inboxes needed extra work, what fits in a cMix message, and the choices we
made. It's for anyone who wants to check our reasoning, especially people who know the
xx network or post-quantum cryptography better than we do.

## In short

- **Links are quantum-resistant by design.** What a link opens is encrypted with a
  256-bit symmetric key that travels only inside the link, never across the network. A
  quantum computer doesn't help against a key it never sees.
- **An inbox's secure (compact) address is not.** It's an X25519 key, the kind most
  messengers relied on until recently. A message sealed to it could be recorded today and
  opened by a large quantum computer later.
- **So every inbox also has a quantum-safe address,** made from the same 12 words.
  Messages to it are sealed with X-Wing, a hybrid of ML-KEM-768 (the NIST standard) and
  X25519, and stay private as long as either holds. Replies stay quantum-safe too.
- **The costs:** a first or anonymous message to it takes two cMix pieces instead of one,
  sent a few seconds apart; the address is longer (so is its QR code); and on today's
  quiet network such a sender is easier to pick out (a VPN helps).
- **What no seal can fix:** who talks to whom. cMix's own protection of that is
  classical, and gateways see senders' internet addresses (see
  [gateway-metadata.md](gateway-metadata.md)).

## 1. Who can collect an inbox's messages

A message waits on its round's gateways for about three weeks, and picking it up needs
no login: a request names only a short mailbox label and a round (`GetMessages`, comms
v0.0.6), so gateways can't tie a pickup to an account. An inbox's messages can therefore
be collected, still sealed, by anyone with its address (its mailbox follows from it), by
the gateways that stored each round, and by anyone recording the sender's or owner's
connection, since cMix's own encryption of the trip is classical.

Nobody can read them now. The risk is "harvest now, decrypt later": keep the recordings
until a quantum computer can work out the inbox's private key from its public address,
once, then open every recorded message sent to it.

This isn't special to Slynk. A DM mailbox on xx needs a token as well as the key, but
every channel message a user posts with DMs enabled carries their token (xxDK,
`channels/send.go`), so anyone in such a channel has it; DMs use X25519 too, and each
carries the sender's long-term key inside (crypto v0.0.15, `dm/cipher.go`), which a
future decryption would expose. A Slynk inbox message carries no sender identity unless
the sender includes their own inbox.

## 2. What fits in one cMix piece

On mainnet, with its 4,096-bit cMix group, a message is 1,024 bytes. Slynk fills its
926 bytes of contents, plus 62 more in the key-fingerprint and MAC fields, as xx's DMs
do: 988 bytes. A compact notice spends 64 of them (a 32-byte one-time key, a 16-byte
tag, a 16-byte header with the round and an id), leaving 924 for text.

Sizes in bytes of the candidates we weighed:

| Method | Standing (October 2026) | Public key | Ciphertext |
|---|---|---|---|
| X25519 (compact addresses) | classical | 32 | 32 |
| ML-KEM-512 | FIPS 203, category 1 | 800 | 768 |
| ML-KEM-768 | FIPS 203, the recommended default | 1,184 | 1,088 |
| ML-KEM-1024 | FIPS 203, category 5 | 1,568 | 1,568 |
| X-Wing (ML-KEM-768 + X25519) | Internet-Draft (draft-connolly-cfrg-xwing-kem) | 1,216 | 1,120 |
| HQC-1 | chosen by NIST in 2025 as a backup | 2,241 | 4,433 |
| Classic McEliece 348864 | ISO covers its larger sets | 261,120 | 96 |
| CSIDH-512 | research; strength disputed | 64 | 64 |

- **ML-KEM-512** is the only well-trusted method whose ciphertext fits one piece with
  room to spare. But sent as it is, it's easy to recognise: its numbers mod 3,329 are
  squeezed into 10 bits each, unevenly, and a simple likelihood test in our prototype
  picked out 96% of ML-KEM ciphertexts from random bytes
  ([lab/pq-inbox/distinguish.go](../../lab/pq-inbox/distinguish.go)). Encoded to look
  random, as compact notices do, it leaves almost no room, and none once paired with
  X25519. It's also a size several security agencies don't recommend, and Go's standard
  library doesn't include it.
- **Classic McEliece** has tiny ciphertexts, but its public keys can't go in a link or
  QR code, and fetching one from anywhere would tell that place who is writing to which
  inbox.
- **CSIDH** has 64-byte keys, but researchers disagree on how large its parameters must
  be against quantum attacks; at the sizes the cautious estimates need, each operation
  takes seconds.

So nothing trusted fits in one piece with useful room while still looking random.

## 3. The quantum-safe address

**Sealing.** A message is sealed with HPKE (RFC 9180, the standard for sealing a message
to a public key) using its MLKEM768-X25519 KEM, which is X-Wing, with HKDF-SHA256 and
ChaCha20-Poly1305 as for compact addresses ([inbox4.go](../../core/transfer/inbox4.go)).
The owner opens it with Go's `crypto/hpke` (new in Go 1.26; Slynk builds with Go
1.27.2). A hybrid stays safe while either half holds: ML-KEM against a future quantum
computer, X25519 against a flaw found in the much younger ML-KEM. No new dependency was
needed.

**Looking random.** X-Wing's encapsulated key is ML-KEM's ciphertext followed by an
X25519 key. The X25519 half is Elligator 2 encoded, as for compact addresses. The ML-KEM
half is encoded with Kemeleon (draft-irtf-cfrg-kemeleon-02, its rejection variant,
section 5.1; [kemeleon.go](../../core/transfer/kemeleon.go)): each 10-bit number is
widened at random to one of the values it stands for, all 768 are written as one
base-3,329 number, and the sender encapsulates again whenever that number would need
more than 8,986 bits, or a 0 in the second part loses a 1-in-209 draw (about 77% of
encodings succeed). That costs 164 bytes (1,252 instead of 1,088) and makes the
ciphertext uniform. Both encodings are covered by the seal's associated data, so a copy
re-encoded by someone else won't open.

**Two pieces.** The encoded keys alone, 1,284 bytes, exceed one piece, so a quantum-safe
message fills exactly two, leaving 652 bytes for text (about 1,210 characters of an
English letter after compression). The pieces go one at a time
([apart.go](../../core/transfer/apart.go)): the first, either half at random, is sealed
for its own round; once that round succeeds, the second goes with the same bytes after a
random 2-to-15-second pause, in a round of its own no more than 800 rounds away. They
arrive about 10 to 25 seconds apart. The second is retried, up to 3 times, only if its
round certainly failed, since two copies both arriving would be visible to anyone
fetching the mailbox; if the first fails, the second never goes.

We first sent both in one round (xxDK's `SendManyWithAssembler`), like an xx DM; but a
DM's two pieces go to two mailboxes, while these went to one — a shape hardly anything
else makes, visible to the round's gateways and to anyone with the address. Sent apart
that shape is gone, though two single messages close together can still be noticed.

**Pairing the pieces.** Both pieces look random, so the owner can't see which messages
belong together, and trying every pair would let anyone with the address bog the owner
down with junk. So the second piece starts with an 8-byte tag worked out from X-Wing's
X25519 shared secret, which only the sender and owner can compute. The owner works out
each message's tag once and looks it up; only a matching pair, in rounds at most 800
apart, is unlocked, and only if sealed for whichever of its rounds started first (by
start time: round numbers aren't in start order). Limits
([inbox4.go](../../core/transfer/inbox4.go), `pairing`): a pair that isn't one matches by
chance once in 2^64; up to 128 unpaired messages are held a round and 12,288 in all, for
up to an hour; a tag matches one held message each way, so a crafted message costs one
unlocking attempt. To stop a notice pairing, a flood would need more than 128 messages in
a round before a half it brought, or 12,288 between its halves, in every round, since
nobody can tell which round a notice is in. Go's HPKE keeps the X25519 secret to itself,
so Slynk writes out the sender's side of the seal (X-Wing's combiner and HPKE's key
schedule, [xwing.go](../../core/transfer/xwing.go),
[hpke.go](../../core/transfer/hpke.go)). Someone who could later break X25519 could tell
which two messages pair; what they say stays behind ML-KEM.

**The same 12 words, and a signed address.** The ML-KEM key is derived from the words,
beside the keys the compact address uses, so every inbox has both addresses, existing
ones included, with the same mailbox. The quantum-safe address is version 4, the
ed25519 key, the ML-KEM-768 key and the inbox's Ed25519 signature on that key: 1,281
bytes. Without the signature, anyone could put their own ML-KEM key beside a real
inbox's key and pass the result off as that inbox; this was found and fixed before
release. On slynk.me the link is 1,726 characters; its QR code holds the address as
3,084 digits, which QR codes store more compactly: version 30 (137 squares a side) where
a compact address needs version 4 (33). The same key signs and does X25519, as Signal's
XEdDSA does; that's been studied and found sound (Thormarker, IACR ePrint 2021/509),
and here it can't be otherwise, since the signature must check against the key the
compact address already has.

**On screen.** An inbox is one list; every message, conversation and inbox being written
to carries a marker — a padlock (secure) or an atom (quantum-safe)
([marker.ts](../../web/src/inbox/marker.ts)). The two addresses appear as tabs only where
the owner chooses what to share (creating an inbox, and Share), with a small (i) that
explains what each costs.

**Sealed to its round.** Every inbox message seals the number of the round it goes in —
each half of a quantum-safe message its own — and the owner drops one that arrives in any
other, so a re-sent copy can't be passed off as new ([inbox.md](inbox.md), section 4).

**Replies stay quantum-safe** ([reply.go](../../core/transfer/reply.go)). A sender's
quantum-safe address doesn't fit in a message, so the owner can only reply to their
compact one. Instead, a quantum-safe message that includes its sender's inbox also
carries their reply keys for the owner: an 8-byte token and a 32-byte key, both worked
out from the sender's words, so there's nothing new to keep. The reply is sealed to the
compact address with HPKE's PSK mode, the reply key as the pre-shared key and the token
as its ID, the token hidden by a pad from the KEM's secret. Opening it takes both the
X25519 key and the reply key, which has only ever travelled inside quantum-safe
messages. Every reply carries its sender's own keys, so the conversation stays
quantum-safe both ways, one piece a message: 916 bytes of room, 810 after the sender's
inbox and keys (a quantum-safe first message letting them reply has 546). The limits:
this guards against harvest now, decrypt later; the proof of who sent a message stays
classical, as in Signal's PQXDH; RFC 9180 notes PSK mode's post-quantum security hasn't
been formally proven (section 9.1.3); and the key holds no more than the words' 128
bits, the same as every key an inbox has.

**Speed.** Measured on 2026-10-31 with
[inbox4_bench_test.go](../../core/transfer/inbox4_bench_test.go) in WebAssembly under
Node (close to a browser): sealing a quantum-safe message takes about 1.9 ms and opening
it 1.1 ms; a message that isn't for the inbox costs the owner about 1.2 ms (0.7 ms if it
were tried as compact only), and a round with 32 junk messages and a notice 38 ms.

**Files, where a site turns them on.** slynk.me's inboxes take text only. With
`INBOX_FILES` on ([site.ts](../../web/src/site.ts)), anything that won't fit a notice
goes as an ordinary upload and the inbox gets a message carrying its 148-byte link
([inbox.md](inbox.md), section 9). The upload is protected by keys inside that link, so
files announced to a quantum-safe address are quantum-safe too; announced to a compact
one, they are only as safe as the message that carried the link.

## 4. The trade-offs

- **A two-piece sender is easier to pick out.** Gateways see how many pieces each sender
  puts in a round. On today's quiet network the crowd a sender hides in may be small, and
  two rounds can be matched to the mailbox's as one can, so sending apart doesn't make a
  sender harder for a gateway operator to find: it takes away a shape, and helps more as
  the network grows busier. Cover messages don't help (they're single pieces); a VPN
  hides the sender's internet address. We can't measure the crowd from a client, so the
  screens say so.
- **Slower first messages.** A first or anonymous message takes a few seconds longer;
  from the first reply on, a conversation's messages are one piece.
- **Longer, denser links and QR codes.** A 1,726-character link works in browsers, email
  and most chat apps, but can't be typed, and its QR code needs printing larger and
  scanning from closer; Slynk's own scanner reads a high-resolution camera picture
  ([scan.ts](../../web/src/inbox/scan.ts)).
- **The compact address can be worked out from the quantum-safe one,** so a sender could
  still write the classical way; an organisation that wants every message quantum-safe
  should publish only the quantum-safe address.
- **Messages already sent stay as they were sealed.**

## 5. How xx's own apps compare

We read the code of the xx network apps we know, to learn from them. None of this is a
criticism: ML-KEM was standardised only in August 2024, and Go's standard library gained
HPKE with quantum-safe hybrids only in 2026.

- **xxDK's direct messages** (used by Haven and co-nexx.us) are a Noise handshake,
  `Noise_X_25519_ChaChaPoly_BLAKE2s` (crypto v0.0.15, `dm/noiseX.go`), which is
  classical. Channels encrypt with a symmetric key derived from the channel's 32-byte
  secret (`broadcast/symmetric.go`), so a private channel's messages are about as
  quantum-resistant as a Slynk link, if that secret was passed on safely.
- **co-nexx.us** (`gitlab.com/co-nexx-us/app`, commit `6c4ffee`) is built on Courier
  (`gitlab.com/keith16/courier`), which uses the same `dm` and `channels` code. It caps
  a message at 700 bytes of UTF-8 (`src/lib/messageLimits.ts`); Haven caps it at 700
  characters once compressed and base64-encoded.
- **xxDK's end-to-end messages,** which the original xx Messenger used, pair 3,072-bit
  Diffie-Hellman with SIDH over p503 (xxDK v4.8.4, `storage/utility/sidhParams.go`,
  `auth/fmt.go`). Both keys fit in one cMix message, and keys are exchanged now and then
  rather than with every message. SIDH was broken on an ordinary computer in 2022
  (Castryck and Decru, ePrint 2022/975).

**Why Slynk's inboxes don't use xx's DMs.** DMs suit two people who know each other:
each carries the sender's long-term key, the mailbox is hidden behind a token, and a copy
goes to the sender's own mailbox. An anonymous public inbox wants the opposite: no sender
identity, a mailbox anyone can work out from a poster, and nothing left where the sender
later checks. HPKE over plain cMix messages fits that, comes from Go's standard library
and has a standard quantum-safe mode. Both use X25519 and ChaCha20-Poly1305; neither is
weaker. It also keeps Slynk clear of a crash in xx's key-conversion code that the DM
path can reach ([inbox.md](inbox.md), section 11).

## 6. What we decided against

- **ML-KEM-512 in one piece, Classic McEliece, and CSIDH,** for the reasons in section 2:
  respectively recognisable and cramped (and a size agencies like least), un-linkable
  public keys, and disputed strength at usable speeds.
- **Longer messages in more pieces:** every extra piece makes the sender rarer and shows
  the message's length. Each kind keeps one fixed size; where a site turns files to
  inboxes on, anything longer goes as an upload.

## 7. How it's been checked, and what we'd welcome

- **Known-answer tests:** every kind of notice, with and without a sender's inbox; the
  sender's side of the seal against draft-ietf-hpke-pq's test vector for this suite (as
  Go 1.27 ships it) and `crypto/hpke`; PSK mode against RFC 9180's vector.
- **Kemeleon** has no published test vectors (as of October 2026), so it's checked
  against a plain transcription of the draft's pseudocode and the prototype's
  independent decoder. Statistical tests draw fresh samples each run, with bounds set so
  a correct encoder fails by chance less than once in 10^8 runs: the likelihood test
  flags encodings as often as random bytes, and every bit position is balanced.
- **Deliberate breakages:** more than a hundred, across the encoding, pairing, round
  sealing and replies, to check the tests notice; the few they miss are equivalent
  changes or judged harmless.
- **Mainnet, 2026-10-18:** a secure, a quantum-safe and a long compressed quantum-safe
  message, delivered 5 to 11.5 s after Send and found within seconds; a three-message
  quantum-safe conversation between two inboxes, each reply one piece; and two messages
  sent apart (with a shorter pause than today's), their pieces 13 to 34 rounds apart,
  paired live and in a later look-back.
- **No outside audit** has been done.

The parts most worth a second pair of eyes are Slynk's own: the Kemeleon and Elligator
encodings, the sender's side of the seal and the pairing tag, round sealing, pairing
across rounds, reply keys, the address's signature, and one key for X25519 in both
addresses and for that signature.

## Sources

- Slynk: [core/transfer/inbox.go](../../core/transfer/inbox.go),
  [inbox4.go](../../core/transfer/inbox4.go), [apart.go](../../core/transfer/apart.go),
  [reply.go](../../core/transfer/reply.go), [hpke.go](../../core/transfer/hpke.go),
  [xwing.go](../../core/transfer/xwing.go), [kemeleon.go](../../core/transfer/kemeleon.go),
  [elligator.go](../../core/transfer/elligator.go) and their tests;
  [web/src/inbox/](../../web/src/inbox/); the prototype in
  [lab/pq-inbox/](../../lab/pq-inbox/).
- xxDK v4.8.4 and comms v0.0.6 (github.com/xxfoundation mirrors); `gitlab.com/elixxir/crypto`
  v0.0.15, which xxDK v4.8.4 requires; Courier, `gitlab.com/keith16/courier`; the
  co-nexx.us app, `gitlab.com/co-nexx-us/app`, commit `6c4ffee`.
- NIST FIPS 203 (ML-KEM), August 2024; NIST SP 800-227 (recommendations for KEMs),
  September 2025.
- RFC 9180 (HPKE); draft-ietf-hpke-pq; draft-connolly-cfrg-xwing-kem;
  draft-irtf-cfrg-concrete-hybrid-kems; draft-irtf-cfrg-kemeleon-02 (July 2026).
- Günther, Stebila and Veitch, "Obfuscated Key Exchange", ACM CCS 2024 (ePrint 2024/1086).
- Bernstein, Hamburg, Krasnova and Lange, "Elligator", 2013; RFC 9380.
- Thormarker, "On using the same key pair for Ed25519 and an X25519 based KEM", ePrint
  2021/509.
- Castryck and Decru, "An efficient key recovery attack on SIDH", ePrint 2022/975.
- On CSIDH's parameters: Peikert (ePrint 2019/725); Bonnetain and Schrottenloher
  (ePrint 2018/537); Chávez-Saab et al., "The SQALE of CSIDH" (ePrint 2020/1520).
- Classic McEliece (classic.mceliece.org); HQC (pqc-hqc.org).
- Agency guidance: BSI TR-02102-1 (2026-01); ANSSI (2023); UK NCSC (2024); NSA CNSA 2.0.

## Credits

Thanks to David Chaum and the cMix authors, and to the xx foundation, for cMix and the xx
network; to Rick Carback, the leading contributor to xxDK and xx's crypto code; to Keith
Millette, whose fork Slynk builds on; to the authors of the standards and papers above;
and to Go's cryptography maintainers for `crypto/hpke` and `crypto/mlkem`.

— Slynk
