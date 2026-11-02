#!/usr/bin/env bash
# Build Slynk's core as WebAssembly for the website.
#
# Writes web/src/core/generated/{slynk-core.wasm,slynk-tools.wasm,wasm_exec.js}
# and go-licences.txt (not in git). slynk-tools.wasm is the small helper module
# (cmd/tools-wasm): Argon2id for password links and Brotli for what's sent.
# -trimpath keeps local file paths out of the binary.
set -euo pipefail
cd "$(dirname "$0")"
command -v go >/dev/null || export PATH="$HOME/.local/toolchains/go/bin:$PATH"

out=../web/src/core/generated
mkdir -p "$out"
# -buildvcs=false: Go would otherwise stamp the commit's ID and time into
# each file, so every deploy renamed them (they're named by their contents)
# and deleted the old ones. A page left open across a deploy then couldn't
# start a worker: "Couldn't lock it with your password" on a
# phone, 2026-10-17. Without it, the same code builds to the same bytes.
GOOS=js GOARCH=wasm go build -trimpath -buildvcs=false -ldflags="-s -w" -o "$out/slynk-core.wasm" ./cmd/wasm
GOOS=js GOARCH=wasm go build -trimpath -buildvcs=false -ldflags="-s -w" -o "$out/slynk-tools.wasm" ./cmd/tools-wasm
# wasm_exec.js must come from the same Go version that built the .wasm.
cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" "$out/wasm_exec.js"

# The licences of the Go code in both files, for the site's licenses.txt
# (web/scripts/licences.ts): the minified site keeps no notices of its own.
# Each module's licence, notice and patent files, sorted, with no local paths:
# the same code writes the same text. A module with none stops the build.
{
  printf '==== Go %s: its standard library, in both WebAssembly files, and wasm_exec.js ====\n' "$(go env GOVERSION)"
  for f in LICENSE PATENTS; do printf '\n-- %s --\n' "$f"; cat "$(go env GOROOT)/$f"; done
  for pkg in ./cmd/wasm ./cmd/tools-wasm; do
    GOOS=js GOARCH=wasm go list -deps \
      -f '{{with .Module}}{{if not .Main}}{{.Path}}|{{.Version}}|{{with .Replace}}{{.Path}}{{end}}|{{.Dir}}{{end}}{{end}}' "$pkg"
  done | LC_ALL=C sort -u | while IFS='|' read -r path ver copy dir; do
    note=
    [ -z "$copy" ] || note=" (Slynk's copy in ${copy#../})"
    printf '\n\n==== %s %s%s ====\n' "$path" "$ver" "$note"
    seen=
    for f in $(ls -1 "$dir" | LC_ALL=C sort | grep -iE '^(licen[cs]e|copying|notice|patents)([.-].*)?$' || true); do
      sum=$(sha256sum < "$dir/$f" | cut -c1-64)
      case " $seen " in *" $sum "*) continue ;; esac # LICENSE and LICENSE.md alike
      seen="$seen $sum"
      printf '\n-- %s --\n' "$f"
      cat "$dir/$f"
    done
    [ -n "$seen" ] || { echo "build-wasm.sh: no licence file for $path" >&2; exit 1; }
  done
} > "$out/go-licences.txt"
echo "built $out/slynk-core.wasm ($(du -h "$out/slynk-core.wasm" | cut -f1)) and slynk-tools.wasm ($(du -h "$out/slynk-tools.wasm" | cut -f1)) with $(go version | cut -d' ' -f3)"
