# Slynk's copy of github.com/andybalholm/brotli

Taken from tag `v1.2.7` (commit `33c2a98`). What differs from it:

- **Left out at import:** the tests (`*_test.go`), `testdata/`, `corpus-test/`
  and the `flate/` package, which Slynk doesn't use. To run the tests, run
  `go test ./...` in Go's module cache copy of v1.2.7.
- **Removed:** `http.go`, a helper for web servers (`HTTPCompressor`,
  `NewHandler`, `Accept-Encoding` negotiation). Slynk never serves HTTP from
  this code, and the file imports `net/http` and `compress/gzip`, which made
  the WebAssembly module about 4 MB bigger.

- **Changed:** `decode.go`, `inverseMoveToFrontTransform`: the loop that moved
  the table up one byte at a time is one `copy` (the same result). A crafted
  stream of many context maps made the old loop take about 24 s per 2 MB in the
  browser, against about 2.6 s now (an adversarial review, 2026-10-26).

Nothing else is changed.
