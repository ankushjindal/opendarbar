#!/bin/bash
# One-shot backfill: give every Reading/Inbox note a `kind:` and a `via:`.
# Notes that already have `kind:` are left alone, bodies are never touched.
# Idempotent, so it is safe to re-run after an Obsidian Web Clipper batch.
set -uo pipefail
source "$(dirname "$0")/lib.sh"

VIA="${1:-clipper}"
added=0; fixed=0
for f in "$RL_INBOX"/*.md; do
  [[ -e "$f" ]] || continue
  src=$(rl_note_source "$f")
  case "$src" in
    *youtube.com*|*youtu.be*) kind=video ;;
    *x.com*|*twitter.com*)    kind=tweet ;;
    *)                        kind=article ;;
  esac
  have=$(awk '/^kind:/ {print $2; exit}' "$f")
  [[ "$have" == "$kind" ]] && continue

  tmp=$(mktemp)
  if [[ -z "$have" ]]; then
    awk -v kind="$kind" -v via="$VIA" '
      /^---$/ { c++; if (c == 2) { print "kind: " kind; print "via: " via } }
      { print }
    ' "$f" > "$tmp"
    added=$((added+1))
  else
    # only the kind line changes; via and everything else stay as they are
    awk -v kind="$kind" '
      /^---$/ { c++ }
      c == 1 && /^kind:/ { print "kind: " kind; next }
      { print }
    ' "$f" > "$tmp"
    fixed=$((fixed+1))
  fi
  cat "$tmp" > "$f" && rm -f "$tmp"
done
rl_log "backfill-kind: added=$added corrected=$fixed (via=$VIA for new tags)"
