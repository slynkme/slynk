# Mixnet smoke test

A throwaway command-line experiment that checks Slynk's core idea against the
**live xx network mainnet**:

1. A brand-new xx identity uploads a file into the cMix mixnet, addressed to
   a random single-use ID, and gets back a small "file link".
2. The uploader exits, so it is offline.
3. A second, unrelated identity downloads the file using **only** that link.

It uses xxDK's `channelsFileTransfer` module directly, with a tiny in-memory
event model (`main.go`), so none of the channels/chat/E2E machinery is involved.

## Results (2026-10-13, native Go client on this VM)

| Build | Size | Connect (new identity) | Upload | Download |
|---|---|---|---|---|
| Stock xxDK v4.8.4 | 250 KB | ~20–26 s | 1 min 59 s (2.1 KB/s) | 12 s (21 KB/s) |
| Keith's fork, 2 MB cap, 16 send workers | 1 MB | ~20–27 s | 8 min 22 s (2.0 KB/s) | 1 min 43 s (9.7 KB/s) |

Downloads were checked byte-for-byte (SHA-256) against the upload.

Going from 4 to 16 send workers didn't speed uploads up, so that change was
dropped and the project's copy of the fork keeps 4. The log shows the
uploader repeatedly waiting up to 45 s for a suitable round
(`No rounds to send to … were found before timeout 45s`). It only sends into
rounds whose whole node team it holds keys for. So round selection is the
bottleneck, not parallelism. What came of it is in
`docs/findings/upload-throughput-2026-10.md`.

`testdata/` holds the links from the first runs (250 KB and 1 MB), in UTC. They're
the probes for the retention tests in `docs/findings/notes.md`: the network is designed to
keep messages for about 500 hours, but stock xxDK only looked back about a day when a
download started (Slynk's fork now looks back to the send time).

## Running it

Go comes from `~/.local/toolchains/go/bin`. Open a new terminal, or run
`source ~/.bashrc`, so it's on your PATH.

```bash
go build -trimpath -o smoketest .
TZ=UTC ./smoketest upload   -state /tmp/st/up   -size 250000 -link /tmp/st/link.json
TZ=UTC ./smoketest download -state /tmp/st/down -link /tmp/st/link.json -out /tmp/st/file.bin
```

Each run needs its own fresh `-state` directory, because that directory *is*
the client's xx identity. Detailed xxDK logs go to `<state>.log`.

### Building against the project's fork

`go.tuned.mod` swaps stock xxDK for the project's copy of Keith's fork in
`third_party/xxdk-client`, which carries Slynk's patches (size cap, download
look-back; see `git log -- third_party/`):

```bash
go build -trimpath -modfile=go.tuned.mod -o smoketest-tuned .
```

### Dependency note

xxDK's original GitLab home is gone. `gitlab.com/xx_network/crypto v0.0.11`
isn't on Go's public module mirror, so both module files point at the copy in
`third_party/xx_network-crypto` (see `third_party/README.md`).
