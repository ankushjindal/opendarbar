#!/bin/bash
# One-shot: give every note an `added:` timestamp so ordering stops depending on
# file mtime, which any background write reshuffles.
#
# The value is the clipped date with the file's birth time for the clock part,
# so a seeded batch keeps the order it was created in and an older clipper note
# keeps the day it was clipped.
set -uo pipefail
source "$(dirname "$0")/lib.sh"

n=0
for f in "$RL_INBOX"/*.md; do
  [[ -e "$f" ]] || continue
  grep -q '^added:' "$f" && continue
  day=$(awk '/^clipped:/ {gsub(/"/,"",$2); print $2; exit}' "$f")
  [[ "$day" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || day=$(stat -f "%SB" -t "%Y-%m-%d" "$f")
  clock=$(stat -f "%SB" -t "%H:%M:%S" "$f")
  tmp=$(mktemp)
  awk -v a="$day"T"$clock" '
    /^---$/ { c++; if (c == 2 && !seen) print "added: " a; print; next }
    c == 1 && /^added:/ { print "added: " a; seen=1; next }
    { print }
  ' "$f" > "$tmp" && cat "$tmp" > "$f" && rm -f "$tmp"
  n=$((n+1))
done
rl_log "backfill-added: stamped $n note(s)"
