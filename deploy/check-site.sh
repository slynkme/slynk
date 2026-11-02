#!/usr/bin/env bash
# Checks that a site serves exactly the files of a published build: each file's
# SHA-256 against the build's list, SHA256SUMS.txt, which CI writes into the
# deploy branch with the files (web/scripts/fingerprints.ts).
#
#   deploy/check-site.sh [SITE] [LIST]
#     SITE  the site's address (default https://slynk.me)
#     LIST  the build's list: a git branch or commit that holds it (default
#           origin/deploy, fetched first), a file, or a web address
#
# It fetches every file at its own address, the pages at / and /about/ too, and
# the WebAssembly as browsers get it (asking for brotli, then gzip); and it
# compares the security headers the list's .htaccess sets with what the site
# sends. It can't fetch .htaccess or PHP files themselves, can't see files the
# list doesn't name, and sees only what the site sends this computer: the About
# page's "How can I check this is the published code?" says what that means.
# Needs bash, curl and git (for a branch), and sha256sum or shasum.
set -euo pipefail
site=${1:-https://slynk.me}
site=${site%/}
list=${2:-origin/deploy}

sha() { if command -v sha256sum >/dev/null; then sha256sum; else shasum -a 256; fi | cut -c1-64; }

# get NAME: a file of the build, from beside its list.
if [[ $list =~ ^https?:// ]]; then
	get() { curl -fsS "${list%/*}/$1"; }
elif [ -f "$list" ]; then
	get() { cat "$(dirname "$list")/$1"; }
else
	[ "$list" != origin/deploy ] || git fetch -q origin deploy
	rev=$list list=SHA256SUMS.txt
	get() { git show "$rev:$1"; }
fi
sums=$(get "$(basename "$list")")
sed -n 's/^# //p' <<<"$sums"
echo "Checking $site against it."

bad=0 good=0
# check PATH SHA256 [ENCODING]: does the site's PATH have this SHA-256 (asked
# for in this compression, as a browser asks for the WebAssembly)?
check() {
	local got how=${3:+ (asking for $3)}
	if ! got=$(curl -fsS ${3:+-H "Accept-Encoding: $3"} "$site/$1" | sha); then
		echo "FAILED     /$1$how: couldn't fetch it"
		bad=$((bad + 1))
	elif [ "$got" != "$2" ]; then
		echo "DIFFERENT  /$1$how"
		bad=$((bad + 1))
	else
		good=$((good + 1))
	fi
}

while read -r want path; do
	case $path in
	.htaccess) htaccess=$want ;;
	*.php) echo "skipped    /$path: the server runs it, so its source can't be fetched" ;;
	*.wasm.br) check "$path" "$want"; check "${path%.br}" "$want" br ;;
	*.wasm.gz) check "$path" "$want"; check "${path%.gz}" "$want" gzip ;;
	index.html) check "$path" "$want"; check "" "$want" ;;
	*/index.html) check "$path" "$want"; check "${path%index.html}" "$want" ;;
	*) check "$path" "$want" ;;
	esac
done < <(grep -E '^[0-9a-f]{64}  ' <<<"$sums")

# .htaccess can't be fetched; what it makes the server send can.
rules=$(mktemp)
trap 'rm -f "$rules"' EXIT
if [ -z "${htaccess:-}" ]; then
	:
elif ! get .htaccess >"$rules" 2>/dev/null; then
	echo "skipped    the security headers: no .htaccess beside the list to compare them with"
elif [ "$(sha <"$rules")" != "$htaccess" ]; then
	echo "DIFFERENT  the .htaccess beside the list isn't the one it names"
	bad=$((bad + 1))
else
	headers=$(curl -fsS -o /dev/null -D - "$site/" | tr -d '\r') || headers=
	while IFS='|' read -r name value; do
		# Browsers ignore HSTS over plain http, so a local copy leaves it out.
		[[ $site == http://* && $name == Strict-Transport-Security ]] && continue
		# The name in any case (HTTP/2 sends it in lower case), the value exactly.
		if grep -i "^$name: " <<<"$headers" | cut -d' ' -f2- | grep -qxF "$value"; then
			good=$((good + 1))
		else
			echo "DIFFERENT  header $name"
			bad=$((bad + 1))
		fi
	done < <(sed -n 's/^Header always set \([A-Za-z-]*\) "\(.*\)"$/\1|\2/p' "$rules")
fi

if [ "$bad" -eq 0 ]; then
	echo "All $good checks match."
else
	echo "$bad of $((good + bad)) checks don't match."
	exit 1
fi
