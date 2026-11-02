# Quantum-safe inbox notices (offline prototype)

An experiment behind Slynk's quantum-safe inbox address
(`docs/findings/quantum-safety.md`): what a quantum-safe
message to an anonymous inbox would cost, and a working prototype of the
recommended design. It runs offline and never touches the xx network. Nothing
here is used by the website or the core.

## What it does

- **`notice4.go`**: a v4 ("quantum-safe") inbox address and its notices.
  - The same 12 words as today make the same inbox (same ed25519 and X25519
    keys, same mailbox) plus an ML-KEM-768 key. The address is version 4, the
    ed25519 key and the ML-KEM-768 encapsulation key: 1,217 bytes.
  - A notice is sealed with HPKE's MLKEM768-X25519 hybrid (X-Wing) from Go's
    standard library, with HKDF-SHA256 and ChaCha20-Poly1305 as today.
  - It fills **two** cMix messages, meant to go in the same round. Both look
    like random bytes: the X25519 half is Elligator-encoded as today
    (`elligator.go`, copied from the core), and the ML-KEM half is
    Kemeleon-encoded (`kemeleon.go`).
  - The owner tries the messages a round brought in pairs (`openRound`).
- **`kemeleon.go`**: makes an ML-KEM-768 ciphertext look uniformly random:
  the rejection variant of draft-irtf-cfrg-kemeleon-02 (section 5.1), 1,252
  bytes, laid out as its section 5.1.1 describes. It's this lab's own code, not
  checked against test vectors, and its big-number code isn't constant-time.
- **`distinguish.go`**: the simple test that tells a raw ML-KEM ciphertext from
  random bytes, used to show the encoding works.
- **`main.go`**: prints the measurements below.
- **`qr.mjs`**: QR code sizes for each address size, with the site's lean-qr,
  and a printable test sheet (`qr-sheet.html`, gitignored).
- **`qrscan.mjs`**: how few camera pixels per module jsQR (the site's own
  in-page scanner) needs, on codes drawn small, slightly blurred and noisy.

## Running it

From the repo root, after the usual `export PATH=…` line:

```bash
GOPROXY=off go -C lab/pq-inbox test -count=1 .
GOPROXY=off go -C lab/pq-inbox run . -n 2000
```

As WebAssembly under Node (close to a browser's speed):

```bash
GOOS=js GOARCH=wasm GOPROXY=off go -C lab/pq-inbox build -trimpath -buildvcs=false -o /tmp/pq-inbox.wasm . && node "$(go env GOROOT)/lib/wasm/wasm_exec_node.js" /tmp/pq-inbox.wasm -n 300
```

QR codes (needs `web/node_modules`):

```bash
node lab/pq-inbox/qr.mjs
node lab/pq-inbox/qrscan.mjs
```

## Results (2026-10-17, Go 1.27.2, Node 24)

**A cMix message on mainnet** (4096-bit group, read from the signed NDF):
1,024 bytes, of which Slynk fills 926 ("contents"). The key fingerprint and
MAC fields add 62 more usable bytes (their top bits are fixed), as xx DMs use
them: 988. Today's notice uses 56 bytes (32 key, 16 tag, 8 header), leaving 870.

**What a v4 notice leaves for text:** 544 bytes in two messages of 926, or 668
using the fingerprint and MAC fields too; 1,470 / 1,656 in three. The full
comparison table is in the report.

**Speed** (median):

| | native (amd64) | WebAssembly in Node |
|---|---|---|
| keys from the words | 0.15 ms | 0.7 ms |
| seal a notice (2.4–2.5 encapsulations on average) | 0.5 ms | 5.5–5.9 ms |
| open a notice | 0.5 ms | 1.8–1.9 ms |
| try a pair that isn't one | 0.5 ms | 1.7–2.0 ms |
| a round of 2 / 5 / 10 / 20 messages with no notice (2 / 20 / 90 / 380 pairs) | 1 / 12 / 57 / 231 ms | 4 / 40 / 176 / 765 ms |

ML-KEM itself is about 0.1 ms in WebAssembly. Most of the sealing time is the
Kemeleon encoding asking for random bytes one at a time, and most of the
opening time its big-number division; both could be made several times faster
(one batch of random bytes; dividing by q⁵ at a time). Pairing costs up to
n(n−1) tries for a round of n messages: a round of junk with no notice in it is
the worst case.

**Randomness** (2,000 and 20,000 notices):
- A simple likelihood test flags 96% of raw ML-KEM-768 ciphertexts as ML-KEM,
  against 3–4% of random strings. On encoded notices it flags 3–4%, the same
  as random.
- 23% of encodings are rejected (the base-q number would need its top bit, or
  a 0 in v loses its 1-in-209 draw), as the draft predicts; the sender then
  encapsulates again.
- Every one of the 14,816 bit positions of the two pieces is balanced; the
  worst position was within what random bits show (p = 0.08 to 0.38 over three
  runs).

**Deliberate breakages** (each applied to a scratch copy, one at a time): the
tests caught all 8 real ones: associated data covering only the X25519 key;
widening always to the first value; no rejection step; no Elligator; spare bits
left zero; the decoder keeping the spare bits; u sent raw; 0s in v never
rejected. A 9th, a stricter rejection cut-off, wasn't caught, and needn't be:
it only makes encoding slower, and its output is still uniform.

**QR codes** (lean-qr, correction level M as the site uses): today's address is
version 4 (33 modules). The v4 address is version 34 (153 modules) written as
base64url, or 29 (133) written as decimal digits; 30 and 25 at level L.

**jsQR on small, softened codes** (`qrscan.mjs`, four runs with random
addresses; pixels per module needed, with a slight blur and noise / with more):
today's code 2.25–2.5 / 3–3.5; the v4 code as digits 3–4.75 / 5.75 or more; as
base64url 3.25–4 / more than 6. The in-page scanner reads at most a 640-pixel
square (`web/src/inbox/scan.ts`, `middleSquare`), so a v4 code would have to
fill two-thirds of it or more even when the picture is sharp; today's needs a
fifth. A v4 scanner would need a bigger square (about 1,280 pixels). Phone
camera apps use other decoders and more pixels; only a phone test settles it.

## Limits

- A prototype for measuring, not production code: no "include my inbox",
  no cMix sending, no cap on the pairs tried per round.
- `kemeleon.go` follows the draft's rejection variant and layout but hasn't
  been checked against test vectors, and its big-number code isn't
  constant-time (the draft warns that timing can leak the encoding's random
  choices).
- An independent fact-check of the report reviewed this code on 2026-10-17;
  its points are applied (see the report's Verification section).
