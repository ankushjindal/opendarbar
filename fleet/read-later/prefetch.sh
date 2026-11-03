#!/bin/bash
# Fetch bodies ahead of time for the newest unread notes that do not have one.
#
# Opening a note that was never fetched costs a defuddle run or a yt-dlp
# transcript, which is a wait on a phone on a train. The hourly sync does it
# first instead. Work goes through the read-later skill's add.sh, the same path
# the reader uses on first open, so there is one fetch implementation.
#
#   ./prefetch.sh [limit] [budget_seconds]      defaults 20 and 240
set -uo pipefail
source "$(dirname "$0")/lib.sh"

LIMIT="${1:-20}"
BUDGET="${2:-240}"
ADD="$HOME/.claude/skills/read-later/add.sh"
[[ -x "$ADD" ]] || { rl_log "prefetch: $ADD missing"; exit 1; }

started=$(date +%s)
done_n=0; fail_n=0; skipped=0

# newest first by modification time, which is also the order things arrived
while IFS= read -r f; do
  # a marker is a finished answer: two attempts already came back with nothing
  if grep -q '^transcript: none' "$f"; then
    rl_detail "prefetch SKIP $(basename "$f") no captions, already established"
    continue
  fi
  if grep -q '^body: unavailable' "$f"; then
    rl_detail "prefetch SKIP $(basename "$f") text would not extract, already established"
    continue
  fi
  grep -q '^fetched: false' "$f" || continue
  grep -q '^status: unread' "$f" || continue
  [[ $((done_n + fail_n)) -ge $LIMIT ]] && break
  if [[ $(( $(date +%s) - started )) -ge $BUDGET ]]; then
    skipped=$((skipped+1)); continue
  fi
  src=$(rl_note_source "$f")
  if [[ -z "$src" ]]; then
    rl_detail "prefetch FAIL $(basename "$f") no source url in frontmatter"
    fail_n=$((fail_n+1)); continue
  fi

  out=$(timeout 120 "$ADD" "$src" --full 2>&1); rc=$?
  if [[ $rc -eq 0 ]] && grep -q '^MODE: \(full\|transcript\|tweet\|document\)' <<<"$out"; then
    done_n=$((done_n+1))
    continue
  fi

  # Say which one and why, in the words of whatever actually refused.
  if [[ $rc -eq 124 ]]; then
    reason="timeout after 120s"
  elif [[ $rc -ne 0 ]]; then
    reason="add.sh exit $rc: $(tail -1 <<<"$out" | cut -c1-120)"
  elif grep -q '^MODE: placeholder' <<<"$out"; then
    case "$src" in
      *youtube.com*|*youtu.be*) reason="yt-dlp returned no subtitles" ;;
      *.pdf|*.pdf\?*)          reason="the pdf would not download" ;;
      *)                        reason="empty body from defuddle" ;;
    esac
  else
    reason="unrecognised add.sh output: $(tail -1 <<<"$out" | cut -c1-120)"
  fi
  # Record the attempt so a note that cannot be fetched stops being retried
  # every hour; the second failure writes the marker the reader reads.
  tries=$(awk '/^fetch_attempts:/ {print $2; exit}' "$f")
  [[ "$tries" =~ ^[0-9]+$ ]] || tries=0
  tries=$((tries+1))
  kind=$(awk '/^kind:/ {print $2; exit}' "$f")
  tmp=$(mktemp)
  awk -v t="$tries" -v kind="$kind" -v done_key="$([[ $tries -ge 2 ]] && echo yes || echo no)" '
    /^---$/ { c++
      if (c == 2) {
        if (!seen_t) print "fetch_attempts: " t
        if (done_key == "yes" && !seen_m) print (kind == "video" ? "transcript: none" : "body: unavailable")
      }
      print; next }
    c == 1 && /^fetch_attempts:/ { print "fetch_attempts: " t; seen_t=1; next }
    c == 1 && /^(transcript|body):/ { print; seen_m=1; next }
    c == 1 && done_key == "yes" && /^fetched:/ { print "fetched: true"; next }
    { print }
  ' "$f" > "$tmp" && cat "$tmp" > "$f" && rm -f "$tmp"

  rl_detail "prefetch FAIL $(basename "$f") $reason (attempt $tries)"
  fail_n=$((fail_n+1))
done < <(ls -t "$RL_INBOX"/*.md 2>/dev/null)

rl_log "prefetch: fetched=$done_n failed=$fail_n out-of-budget=$skipped"
