# Slynk core

The Go code that talks to the xx network, compiled to WebAssembly for the
browser. It runs in a Web Worker (`web/src/core/worker.ts`).

| Path | What it is |
|---|---|
| `transfer/` | Connect, upload and download, built on xxDK's channels file transfer; the link format; anonymous inboxes (sealing, replies, the quantum-safe address) |
| `cmd/wasm/` | The browser bridge: exposes the core to JavaScript as `slynkCore` |
| `cmd/slynk-cli/` | The same core as a command-line tool, for testing and cross-checks |
| `keyserver/`, `cmd/keyserver/` | slynk.me's key server for one-time links (`deploy/keyserver/` sets one up) |
| `kdf/`, `squeeze/`, `cmd/tools-wasm/` | A small second WebAssembly module: Argon2id for password links, and Brotli compression |
| `build-wasm.sh` | Builds `web/src/core/generated/` (both `.wasm` files plus Go's `wasm_exec.js`) |

## How a transfer works

1. **Connect.** Download and verify the signed network definition, then
   create a brand-new identity whose state lives only in memory (`memkv.go`).
   Register with at least 85% of mixnet nodes. This takes about 12–27 s.
2. **Upload.** xxDK encrypts the data with a random key, splits it into
   ~920-byte parts, and sends them through the mixnet to a random single-use
   recipient ID. A part counts as delivered once its round reports success.
3. **Link.** The key, recipient ID and other details are packed into 148 bytes
   (`link.go`). The website wraps them in its own 183-byte link (one-time mode,
   expiry, half of an outer key) and puts it after the `#` in the URL, which
   browsers never send to servers.
4. **Download.** A different, equally fresh identity fetches the parts for
   that recipient ID and checks them against the link's MAC.

Sender and recipient never need to be online at the same time. The network
keeps messages for up to about 21 days.

## Building

```bash
./build-wasm.sh                                      # WebAssembly for the website
go build -trimpath -o /tmp/slynk-cli ./cmd/slynk-cli # native command-line tool
/tmp/slynk-cli send FILE                             # prints a https://slynk.me/#... link
/tmp/slynk-cli receive LINK OUT                      # LINK: URL or a lab *.json link file
go test ./transfer/                                  # offline tests: links, inboxes, sealing
```

Builds use `-trimpath` so local file paths never end up in the binaries.

`slynk-cli` moves raw bytes. It knows nothing about the website's envelope
(`web/src/payload.ts`), so its links won't open properly on the website, and receiving
a website link gives you the envelope rather than the original file. Use it for
network and speed tests. `SLYNK_VERBOSE=1` prints xxDK's logs to stdout.
