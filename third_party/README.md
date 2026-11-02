# Third-party code

Local copies of Go modules that Slynk builds against. Each folder keeps its
original licence.

| Folder | Source | Why it's here |
|---|---|---|
| `xx_network-crypto/` | `gitlab.com/xx_network/crypto` v0.0.11, taken from the GitHub mirror github.com/xxfoundation/xxnetwork-crypto (tag v0.0.11) | xx's GitLab repos are gone and Go's public module mirror doesn't have this version, so builds can't download it. |
| `andybalholm-brotli/` | `github.com/andybalholm/brotli` v1.2.7 (tag `v1.2.7`, commit `33c2a98`), its Go code, licence and README; its tests and their test data are left out (run them in Go's module cache) | Brotli compression for what's sent (the small helper module, `core/cmd/tools-wasm`). A copy so its web-server helper (`http.go`), which would bring Go's whole web server and TLS into the module, can be left out. v1.2.7 has the decoder fix for CVE-2026-111497 (a crafted stream made v1.2.6 and earlier panic). |
| `xxdk-client/` | Keith's fork of the xx client SDK: gitlab.com/keith16/client, tag `v4.8.5-courier.5` (based on `gitlab.com/elixxir/client/v4` v4.8.4) | Fixes file-transfer reliability bugs we would otherwise hit (download recovery, send backoff, deaf-identity repair). See its `NOTICE` and `FORK.md`. |

Go modules use these through `replace` directives with relative paths.

## Changes we make

Our own changes to these copies are marked with `Slynk:` comments (a few
knock-on lines aren't; diffing against the upstream tag shows every change),
and a file left out is listed in the folder's `SLYNK.md`.
[`docs/findings/xxdk-changes.md`](../docs/findings/xxdk-changes.md) explains
each change to xxDK and why. They're released under the same terms as the code
they modify (BSD 2-Clause for the xx modules, MIT for Brotli).
