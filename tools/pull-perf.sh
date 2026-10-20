#!/usr/bin/env bash
# Pull automatic PERFORMANCE LOG sessions (ui/dm-perflog.js) from a player's
# private vault repository (jots-<user>/perf/<sessionId>.json).
#
#   tools/pull-perf.sh                # newest session for dartsolarpunk, printed as JSON
#   tools/pull-perf.sh -n 3           # newest 3 sessions
#   tools/pull-perf.sh -l             # list sessions (newest first)
#   tools/pull-perf.sh -u <user> -o dir   # save the files into dir/
#
# Auth: an authenticated `gh` CLI (gh auth login) with read access to the
# private repository, or GH_TOKEN / GITHUB_TOKEN in the environment (gh uses
# them). Session ids start with a UTC timestamp, so name order = time order.
set -euo pipefail
USER_="dartsolarpunk"; N=1; LIST=0; OUT=""
while getopts "u:n:lo:" o; do case $o in u) USER_=$OPTARG;; n) N=$OPTARG;; l) LIST=1;; o) OUT=$OPTARG;; *) exit 2;; esac; done
REPO="$USER_/jots-$USER_"
names=$(gh api "repos/$REPO/contents/perf" --jq '.[] | select(.name|endswith(".json")) | .name' | sort -r)
[ -z "$names" ] && { echo "no perf logs in $REPO/perf" >&2; exit 1; }
if [ "$LIST" = 1 ]; then echo "$names"; exit 0; fi
[ -n "$OUT" ] && mkdir -p "$OUT"
echo "$names" | head -n "$N" | while read -r f; do
  body=$(gh api -H "Accept: application/vnd.github.raw" "repos/$REPO/contents/perf/$f")
  if [ -n "$OUT" ]; then printf '%s\n' "$body" > "$OUT/$f"; echo "$OUT/$f"; else printf '%s\n' "$body"; fi
done
