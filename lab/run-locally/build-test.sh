#!/usr/bin/env bash
# Builds the test downloads from the last commit: the website, as CI builds it,
# then the downloads from it with their SHA256SUMS.txt (package.sh, as the
# release workflow does).
#   lab/run-locally/build-test.sh OUT_DIR
# Run from the repository with Go and Node on the PATH, after
# `npm --prefix web run build:core` (it needs web/src/core/generated).
set -euo pipefail
export TZ=UTC
out=${1:?usage: build-test.sh OUT_DIR}
repo=$(git rev-parse --show-toplevel)
cache=${XDG_CACHE_HOME:-$HOME/.cache}
src="$cache/slynk-local-src"

# The website, as CI builds it, from the commit (not whatever is unsaved). An
# archive has no git history, so the commit's ID and time go with it
# (web/scripts/commit.ts).
rm -rf "$src" && mkdir -p "$src"
git -C "$repo" archive HEAD web/src web/about web/public web/index.html web/vite.config.ts web/scripts web/lab web/package.json web/package-lock.json web/tsconfig.json LICENSE CREDITS.md README.md | tar -x -C "$src"
ln -s "$repo/web/node_modules" "$src/web/node_modules"
mkdir -p "$src/web/src/core/generated"
cp "$repo"/web/src/core/generated/{slynk-core.wasm,slynk-tools.wasm,wasm_exec.js,go-licences.txt} "$src/web/src/core/generated/"
SLYNK_COMMIT=$(git -C "$repo" rev-parse HEAD)
SOURCE_DATE_EPOCH=$(git -C "$repo" log -1 --format=%ct HEAD)
export SLYNK_COMMIT SOURCE_DATE_EPOCH
(cd "$src/web" && npx tsc --noEmit && npx vite build --logLevel warn && node scripts/precompress.mjs --drop-raw && node scripts/fingerprints.ts)

"$repo/lab/run-locally/package.sh" "$src/web/dist" "$out"
