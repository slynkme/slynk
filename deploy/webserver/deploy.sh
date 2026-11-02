#!/usr/bin/env bash
# Puts a published build on the web server.
#
#   deploy/webserver/deploy.sh [HOST] [BUILD]
#     HOST   the server's name for ssh (default slynk-web, from ~/.ssh/config)
#     BUILD  a commit of the deploy branch (default origin/deploy, fetched first)
#
# It checks every file against the build's own list, SHA256SUMS.txt (and that
# the build has no file the list doesn't name), turns the build's .htaccess
# security headers into Caddy's, copies both to a new folder on the server,
# and runs slynk-activate there, which switches over once Caddy accepts them.
# To check the build is what its commit makes, build it here first and compare
# the lists (deploy/README.md); to check the live site afterwards, run
# deploy/check-site.sh. Needs bash, git, rsync and sha256sum.
set -euo pipefail
host=${1:-slynk-web}
build=${2:-origin/deploy}
[ "$build" != origin/deploy ] || git fetch -q origin deploy
rel=$(git rev-parse --short=12 "$build^{commit}")
git log -1 --format='Deploying %h: %s' "$rel"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir "$work/site"
git archive "$rel" | tar -x -C "$work/site"

cd "$work/site"
grep -E '^[0-9a-f]{64}  ' SHA256SUMS.txt | sha256sum -c --quiet -
extra=$(comm -23 <(find . -type f ! -path ./SHA256SUMS.txt | sed 's|^\./||' | sort) \
	<(sed -n 's/^[0-9a-f]\{64\}  //p' SHA256SUMS.txt | sort))
if [ -n "$extra" ]; then
	echo "Files the build's list doesn't name: $extra" >&2
	exit 1
fi
echo "All $(grep -cE '^[0-9a-f]{64}  ' SHA256SUMS.txt) files match the build's list."

# The headers, from the lines vite.config.ts and check-site.sh read too. A
# value with a quote, backslash or brace isn't copied (Caddy would read it
# differently), and the counts then differ.
{
	echo "# Build $rel's security headers, from its .htaccess (deploy/webserver/deploy.sh)."
	echo "header {"
	sed -n 's/^Header always set \([A-Za-z-]*\) "\([^"\\{}]*\)"$/\t\1 "\2"/p' .htaccess
	echo "}"
} >"$work/headers.caddy"
want=$(grep -c '^Header always set ' .htaccess)
got=$(grep -c $'^\t' "$work/headers.caddy")
if [ "$want" -eq 0 ] || [ "$want" != "$got" ]; then
	echo "Read $got of the $want headers in .htaccess." >&2
	exit 1
fi

rsync -rlpt --delete --chmod=D755,F644 "$work/site/" "$host:/srv/slynk/releases/$rel/"
rsync -pt --chmod=F644 "$work/headers.caddy" "$host:/srv/slynk/releases/$rel.headers.caddy"
ssh "$host" /usr/local/sbin/slynk-activate "$rel"
