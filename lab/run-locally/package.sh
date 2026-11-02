#!/usr/bin/env bash
# Packs the downloads from a built site (web/dist after `npm run build:deploy`):
# the program with the site inside, for Windows (slynk.exe as it is: no
# console window, with its icon), Macs (Slynk.app, signed ad hoc, for Apple
# silicon and Intel, zipped: an app is a folder) and Linux (zipped, which keeps
# it runnable), with SHA256SUMS.txt. The same site always packs into the same
# bytes, so anyone can rebuild a release from its commit and match its
# checksums.
#   lab/run-locally/package.sh SITE OUT_DIR
# Needs Go and zip. The release workflow (.github/workflows/release.yml) and
# build-test.sh run it.
set -euo pipefail
export TZ=UTC
usage='usage: package.sh SITE OUT_DIR'
site=$(cd "${1:?$usage}" && pwd)
out=${2:?$usage}
mkdir -p "$out"
out=$(cd "$out" && pwd)
here=$(cd "$(dirname "$0")" && pwd)
pack=$(mktemp -d)
trap 'rm -rf "$pack"' EXIT

# Every file in the zips is dated when the site's commit was made (its list
# says when), so they depend on the commit only.
stamp=$(sed -n 's/^# [0-9a-f]\{40\} (\([0-9-]* [0-9:]*\) UTC)\.$/\1/p' "$site/SHA256SUMS.txt" 2>/dev/null || true)
[ -n "$stamp" ] || { echo "package.sh: $site has no SHA256SUMS.txt naming its commit (build it with npm run build:deploy)" >&2; exit 1; }

# The program, with the site inside, less the brotli copies (the gzip ones
# serve every browser).
mkdir -p "$pack/out"
cp "$here"/*.go "$here/go.mod" "$here/slynk.png" "$here/rsrc_windows_amd64.syso" "$pack/"
rm -f "$pack"/*_test.go
cp -a "$site" "$pack/site"
(cd "$pack/site" && rm -f assets/*.wasm.br)

build() { # GOOS GOARCH OUT [ldflags]
	(cd "$pack" && GOOS=$1 GOARCH=$2 CGO_ENABLED=0 go build -tags embed -trimpath -buildvcs=false -ldflags="-s -w ${4:-}" -o "out/$3" .)
}
build windows amd64 windows/slynk.exe -H=windowsgui
build linux amd64 linux-x64/slynk
for arch in arm64 amd64; do
	dir=mac-$([ $arch = arm64 ] && echo apple-silicon || echo intel)
	app="$pack/out/$dir/Slynk.app/Contents"
	mkdir -p "$app/MacOS" "$app/Resources"
	build darwin $arch "$dir/Slynk.app/Contents/MacOS/slynk"
	cp "$here/mac/Info.plist" "$app/Info.plist"
	cp "$here/slynk.icns" "$app/Resources/slynk.icns"
	# Signed ad hoc as a whole, or Apple silicon calls it damaged (macsign/).
	(cd "$here" && go run ./macsign "$pack/out/$dir/Slynk.app")
done

# A zip keeps each file's permissions, time and order: the same ones wherever
# it's packed.
chmod -R u=rwX,go=rX "$pack/out"
find "$pack/out" -exec touch -h -d "${stamp/ /T}:00" {} +
rm -f "$out"/slynk.exe "$out"/slynk-*.zip "$out/SHA256SUMS.txt"
cp -p "$pack/out/windows/slynk.exe" "$out/slynk.exe"
for d in mac-apple-silicon mac-intel linux-x64; do
	(cd "$pack/out/$d" && find . -mindepth 1 | sed 's|^\./||' | LC_ALL=C sort | zip -q -X -9 -@ "$out/slynk-$d.zip")
done
sha() { if command -v sha256sum >/dev/null; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }
(cd "$out" && sha slynk.exe slynk-*.zip > SHA256SUMS.txt && cat SHA256SUMS.txt)
