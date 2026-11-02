# The link and envelope formats

*Slynk, 2026-10-31. All times UTC.*

A Slynk link holds everything needed to find, decrypt and check what was sent, and
nothing else. This piece describes it byte by byte: the core's 148-byte link, the 183-byte
link slynk.me wraps it in, the extra encryption layers, the envelope inside, how
untrusted bytes are decoded, how older pages are kept from misreading newer links, and
the choices behind the QR code and the zip. Every size comes from the code and its
tests. It's for xx network developers and anyone writing a compatible reader.

## In short

- The core's link is 148 bytes: xxDK's file link, packed. slynk.me's links add 35 bytes
  (mode, expiry and one half of a second key) for 183, which is
  `https://slynk.me/#` plus 244 base64url characters.
- Inside the upload, from the inside out: the envelope (one message and files, each with
  its name, type and compression), the one-time seal (AES-256-GCM, 28 bytes more) and,
  if there's a password, the password layer (Argon2id and AES-256-GCM, 45 bytes more).
  All of it fits within xxDK's 2,000,000-byte limit.
- Decoding trusts nothing: every length is checked, declared sizes are enforced while
  decompressing, and types a browser could run are neutralised.
- Feature bits are split into "ignorable" and "must understand", so an older page refuses
  what it can't read, and refuses before it uses up a one-time link.

## 1. The core link: 148 bytes

xxDK's channels file transfer describes an upload with a `FileLink`, as JSON (one recorded
on mainnet is 372 characters). [core/transfer/link.go](../../core/transfer/link.go) packs
the same fields into fixed binary, big-endian:

| Bytes | Field | |
|---|---|---|
| 1 | version | always 1 |
| 32 | file ID | xxDK's hash of the uploaded bytes |
| 33 | recipient ID | the random single-use xx ID the pieces went to (32 bytes and a type byte) |
| 8 | sent time | Unix nanoseconds, when the upload was first queued |
| 32 | key | xxDK's 256-bit transfer key |
| 32 | MAC | an HMAC of the whole upload under that key |
| 4 | size | bytes uploaded |
| 2 | parts | how many pieces |
| 4 | retry | xxDK's resend allowance, a float32 as its bits |

That's 148 bytes, or 198 base64url characters. The recipient's core unpacks it back into
xxDK's `FileInfo` JSON for `Download`. The sent time matters: Slynk's fork of xxDK tracks
the recipient ID from that moment onward, so a link can be collected for as long as the
network keeps its pieces: xxDK assumes 500 hours, and links 18 days old were collected on
mainnet on 2026-10-31 ([notes.md](notes.md)). `link_test.go` round-trips two links
recorded on mainnet and refuses short, long and wrong-version links.

A copy of Slynk without slynk.me's one-time rule can send this link as it is (an
"ordinary" link): its whole key is inside, and it needs no server.

## 2. slynk.me's link: 183 bytes

Every slynk.me link opens once ([why-links-open-once.md](why-links-open-once.md)), which
needs a second key in two halves: `L` in the link, `S` on slynk.me's key server
([one-time-links.md](one-time-links.md)). [web/src/linkv2.ts](../../web/src/linkv2.ts)
wraps the core link:

| Bytes | Field | |
|---|---|---|
| 1 | version | 2; the top bit (`0x80`) set if a password is needed |
| 1 | mode | 1 expiring, 2 one-time; `0x80` set if it needs a page that reads Brotli, `0x40` if it carries more than 51 items |
| 2 | TTL | hours, 1 to 500 |
| 147 | core link | without its version byte, which is always 1 |
| 32 | `L` | the link's half of the key |

That's 183 bytes, exactly 244 base64url characters (`burn-link.test.ts` checks both
numbers), so a link is `https://slynk.me/#` plus 244 characters, 262 in all. The ID the
key server files `S` under is derived from `L`, so it isn't stored. The sender chooses
the TTL: 1 hour, 1 day, 7 days or up to 3 weeks (500 hours) if nobody opens it.

The parser is strict: base64url with no padding and one spelling per value (a value that
doesn't re-encode to the same text is refused); a fragment longer than 1,024 characters
is refused before it's decoded; the length must be exactly 148 or 183; the sent time must
not be zero, the TTL must be 1 to 500 and `L` must not be all zeros.

A password sets the top bit of the first byte in either format (`0x81` is an ordinary
link that needs a password, `0x82` a 183-byte one), so a password link is the same length
as any other: the salt travels with the data.

## 3. In the fragment, and only there

Links travel after the `#`, the URL fragment, which browsers never send to a server. The
page reads it and at once replaces the address with one without it
(`history.replaceState`), so it doesn't stay in the address bar; the browser's history
still has it, which the About page points out. Links begin with the site's address
(`LINK_ORIGIN` in [web/src/home.ts](../../web/src/home.ts)), even when the page runs from
a downloaded copy on the user's own computer, so anyone can open them.

## 4. The layers inside an upload

What's uploaded is built from the inside out ([web/src/main.ts](../../web/src/main.ts),
`send`):

1. **The envelope** (section 5), with each item compressed where that helps.
2. **The one-time seal** ([web/src/burn.ts](../../web/src/burn.ts)): a random 12-byte
   nonce, then AES-256-GCM with a 16-byte tag, under
   `K = HKDF-SHA256(L || S, salt "slynk/v2/salt", info "slynk/v2/key")`, with
   `slynk/v2/aad` as associated data. 28 bytes more. The key server's ID for the link is
   `HKDF-SHA256(L)` with info `slynk/v2/id`, 16 bytes.
3. **The password layer**, if any ([web/src/password.ts](../../web/src/password.ts)):
   version (1), a random 16-byte salt, a 12-byte nonce, then AES-256-GCM with its 16-byte
   tag, under a 32-byte key from Argon2id. The associated data is `slynk/pw/v1`, the
   version and the salt, so neither can be swapped. 45 bytes more.
4. **xxDK's own encryption** of the pieces, under the transfer key in the core link.

The total must fit xxDK's `fileMaxSize` of 2,000,000 bytes
([third_party/xxdk-client/channelsFileTransfer/manager.go](../../third_party/xxdk-client/channelsFileTransfer/manager.go)),
so the composer's limit is 2,000,000 less the layers' 28 and 45 bytes.

The password layer is outside the seal on purpose: the recipient's page checks the
password before it asks the key server for `S`, so a wrong password never uses up a
one-time link. The password itself never leaves the browser.

**Argon2id settings** (format version 1): 3 passes over 64 MiB in one lane, which is
RFC 9106's second recommended option with one lane, since the browser gives the work a
single thread. It runs in WebAssembly (`golang.org/x/crypto/argon2`, in
[core/kdf/](../../core/kdf/)), checked against known answers worked out independently.
We estimate about half a second on a laptop and a second or two on a phone (not
benchmarked). Suggested passwords are five words drawn evenly from 1,904 everyday words
(BIP-39's English list without 144 to avoid), about 54 bits.

**`normalizePassword`** fixes the form a password is used in, because passwords get
retyped from chats and notes on other devices. It applies NFKC, removes invisible
characters (zero-width spaces and joiners, the word joiner, the byte-order mark, soft
hyphens), turns curly quotes and long dashes into `'`, `"` and `-`, lower-cases, applies
NFKC again, squeezes runs of white space to one space and trims both ends. Capitals don't
matter, which costs a chosen password a bit or two and suggested ones nothing. Passwords
are 8 to 200 code points. This function, the labels and the Argon2id settings are frozen
with version 1: changing any of them needs a new version byte, or every existing
password link stops opening.

## 5. The envelope

[web/src/payload.ts](../../web/src/payload.ts) wraps everything sent in one envelope,
inside all the encryption, so neither the mixnet nor any server sees names or types.
Version 2, big-endian:

```
version(1)=2  flags(1)  count(1)  extLength(2)  ext[extLength]
then count items:
kind(1)  flags(1)  nameLength(1)  name  typeLength(1)  type  size(4)  storedLength(4)  body
```

- **The header** is 5 bytes; each item adds 12, plus its name and type. A message is an
  item of kind 1 with no name or type; files are kind 0. Items keep the sender's order,
  message first. An envelope holds 1 to 201 items: one message and up to 200 files.
- **Names** are UTF-8, up to 255 bytes, shortened on a character boundary with the
  extension kept (`report….pdf`). **Types** are a lower-case MIME type of up to 100
  characters, or nothing.
- **`size`** is the item's real length and `storedLength` the bytes that follow; they
  differ only when the body is compressed.
- **Extensions** are records of type (1), length (2) and value. None is defined yet.

**Compression, per item.** Each item goes as it is, deflated, or in Brotli:

- **deflate** (`deflate-raw`, the browser's own `CompressionStream`), used only when it
  saves at least 5%. Files that are already compressed, recognised by their first bytes
  (zip, JPEG, PNG, MP4 and others), aren't tried; for a file over 256 KB, three 64 KB
  samples are tried first, and if none shrinks by 3% the whole isn't deflated for
  nothing.
- **Brotli**, with "Stronger compression" on (the default), in a worker running Slynk's
  WebAssembly helper with a Go Brotli encoder, for items up to 25,000,000 bytes. Nothing
  waits for it: the deflated version is ready at once, and Brotli's replaces it when it's
  done and smaller. Each Brotli stream is decompressed and compared before it's used, so
  an encoder bug can only cost space.
- **A zip sent unpacked.** A zip the sender adds can go with every file stored
  uncompressed, then squeezed whole with Brotli, which finds what its files have in
  common; the recipient's page compresses each file again
  ([web/src/zipInside.ts](../../web/src/zipInside.ts), `repackZip`), so they get an
  ordinary zip. Its `size` is then the unpacked zip's.

**Item flags:** bit 0, the body is compressed (deflate, unless bit 4 says Brotli); bit 1,
the sender says hidden details were removed; bit 2, the sender says it's a smaller copy
their browser made; bit 3, unused and ignorable; bit 4, the compression is Brotli, always
with bit 0; bit 5, a zip sent unpacked, always with bits 0 and 4. Bits 1 and 2 are only
the sender's claim, and the recipient's screen words them that way.

Version 1 envelopes (a single item) are still read, for links made before version 2.

## 6. Decoding untrusted bytes

Whoever made a link chose every byte inside it, so the decoder treats the envelope as
hostile:

- **Every length is checked** against what's left before it's read, and the envelope must
  end exactly where its last item does. The whole is at most 2,000,000 bytes.
- **Two passes.** Every header and length is read before anything is decompressed. Sizes
  declared for all items together may not exceed 100,000,000 bytes. A body that isn't
  compressed must be exactly its declared size. A Brotli item without bit 0, or an
  unpacked zip without Brotli, is damaged.
- **Declared sizes are enforced while decompressing.** A `DecompressionStream` inflates
  each input chunk in full before anyone can read it, so deflated input goes in 4 KB
  slices: deflate expands at most about 1,032 times, so one slice can't produce more than
  about 4 MB, and output past the declared size stops it. The result must be exactly the
  declared size. Brotli is decompressed by a Go decoder, which is memory-safe, gives
  exactly the declared size or an error, refuses Brotli's "large window" extension, and
  turns a panic into an error.
- **Types a browser could run are replaced.** Any HTML, SVG or XML flavour, scripts and
  MIME containers become `application/octet-stream`, so an opened download is never
  rendered as a page. Malformed types are dropped.
- **Names are cleaned when saved** ([web/src/zip.ts](../../web/src/zip.ts), `safeName`):
  no path separators, characters file systems refuse, control characters, or invisible
  characters that can disguise a name (`invoice`, then the right-to-left override U+202E,
  then `fdp.exe`, displays as `invoiceexe.pdf`), and reserved Windows names get a `_` in
  front.
- **A zip sent unpacked is repacked within bounds:** at most 10,000 files in one, 20,000
  across the envelope, and only if every entry is stored; anything else is given as it
  arrived.

Before any of this, xxDK checks every piece and the whole upload against the link's MAC,
and AES-GCM checks each layer, so a damaged or altered upload fails before the envelope is
read. The checks above are for an envelope made maliciously by whoever made the link.

## 7. Forward compatibility

Everything a later version might add is either ignorable or must-understand:

- **Header flags:** bits 0 to 3 ignorable, 4 to 7 must-understand. Bit 4 means more than
  51 items (pages read up to 51 until 2026-10-26).
- **Extension records:** type bit 7 means must-understand.
- **Item kinds:** 0 and 1 are known; 2 to 127 must be understood; 128 to 255 are optional
  and skipped.
- **Item flags:** bits 0 to 3 ignorable, 4 to 7 must-understand.

A page that meets a must-understand bit it doesn't know says "This link was made by a
newer version of Slynk. Reload the page, then open the link again", rather than
misreading it or calling it damaged. That's why Brotli is bit 4 always with bit 0: a
decoder first checks that a body marked uncompressed is exactly its declared size, so
without bit 0 a page from before Brotli would call the item damaged before it reached the
unknown bit.

**Refusing before anything is used up.** The envelope is only read after the download and
the claim, when a one-time link is already used. So whatever a page from before couldn't
read is also flagged in the 183-byte link: `0x80` on the mode byte for Brotli, `0x40` for
more than 51 items. An older page sees a mode it doesn't know and says "made by a newer
version" before it holds or claims anything. The password flag on the first byte works
the same way: pages from before passwords refuse such a link as damaged or newer.

## 8. The QR code

The sent screen offers "Show QR code". The code is the secret link, so it's drawn only on
request and removed when hidden. "Save QR code" under it saves it as a picture only when the
sender asks, to show or print it later in person: a PNG of about 1,024 pixels a side, each
module a whole number of pixels, with a note that the picture is the link itself, that phones
may copy pictures to the cloud, and to delete it once it's done its job. It's made by lean-qr
2.7.4 (MIT, about 8 KB, part of every page load), at error correction M or higher. Since
base64url mixes upper and lower case, the link goes in QR's byte mode, and its 262
characters make a version 12 code, 65 × 65 modules. It's drawn black on white with a
four-module quiet zone, in both themes, so phone cameras read it whichever the page uses.
The About page advises scanning with the phone's own camera, not a scanner app: whatever
reads the code gets the link.

A smaller code was possible: an upper-case base32 form of the link, used only for the QR
code, would let most of it use QR's alphanumeric mode and make a version 11 code (61 × 61)
at M, but it would be a second link format (311 characters) for every page to accept, so
it wasn't adopted. (Both versions computed with lean-qr 2.7.4.)

An inbox's address is different: it's public, so its code shows at once and can be saved
for posters.

## 9. The zip, built only on the recipient's device

Several files travel as separate items in one envelope, never as a zip made by Slynk. A
zip on the wire would cost 76 bytes per file (a 30-byte local header and a 46-byte
directory entry) plus the name twice, and 22 bytes more per archive, against the
envelope's 12 bytes plus the name once. It has nowhere to say that an item is a message
or what type it is; it would put the sender's local clock into every entry; and it would
mean every recipient parsing an archive shaped by a stranger.

So "Save all (.zip)" builds the zip on the recipient's device, with fflate's synchronous
`zipSync` ([web/src/zip.ts](../../web/src/zip.ts); its asynchronous API would start
`blob:` workers, which the page's security policy forbids). Entries are stored as they
are, since compressing again gains nothing; every entry gets the same date, 1 January
1980, so the zip says nothing about when or where it was made; names are cleaned and made
unique, ignoring case; and a message never goes in. A zip the sender added themselves
travels as one file, and arrives as one.

## Sources

- Slynk: [core/transfer/link.go](../../core/transfer/link.go) and `link_test.go`,
  [web/src/linkv2.ts](../../web/src/linkv2.ts), [web/src/burn.ts](../../web/src/burn.ts),
  [web/src/password.ts](../../web/src/password.ts), [core/kdf/](../../core/kdf/),
  [web/src/payload.ts](../../web/src/payload.ts),
  [web/src/zipInside.ts](../../web/src/zipInside.ts), [web/src/zip.ts](../../web/src/zip.ts),
  [core/squeeze/](../../core/squeeze/), [web/src/inbox/qr.ts](../../web/src/inbox/qr.ts),
  and the tests in [web/test/](../../web/test/) (`burn-link`, `burn-crypto`, `payload`,
  `password`)
- xxDK v4.8.4, `channelsFileTransfer/info.go` (`FileLink`) and `manager.go`
  (`fileMaxSize`): `gitlab.com/elixxir/client/v4`, mirrored at github.com/xxfoundation
- RFC 5869 (HKDF); RFC 9106 (Argon2); RFC 7932 (Brotli); RFC 1951 (deflate); RFC 4648
  (base64url); Unicode Standard Annex #15 (NFKC); ISO/IEC 18004 (QR codes); PKWARE's ZIP
  application note (APPNOTE.TXT)
- lean-qr 2.7.4, fflate 0.8.3, `github.com/andybalholm/brotli` v1.2.7,
  `golang.org/x/crypto/argon2`

## Credits

Thanks to the xx foundation for xxDK and its file transfer, to Rick Carback, its leading
contributor, to Keith Millette, whose fork of xxDK Slynk builds on, and to the authors of
lean-qr (David Evans), fflate (Arjun Barrett) and the Go Brotli port (Andy Balholm).

— Slynk
