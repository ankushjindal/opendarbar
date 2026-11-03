#!/bin/bash
# YouTube Watch Later -> Reading/Inbox notes (kind: video, via: youtube-wl).
#
#   ./youtube-wl.sh --seed    newest 50 only (first run)
#   ./youtube-wl.sh           newest 60, minus what is already stored (hourly)
#
# The hourly window is deliberately not the whole playlist. Watch Later holds a
# 261-entry backlog the owner has never intended to read; scanning all of it once
# dumps every one of them into the queue. New additions land at the top, so a
# 60-entry window catches them with a wide margin.
#
# Notes are written with fetched: false. The transcript is pulled on first open
# in the dashboard reader, which shells out to the read-later skill's add.sh.
# Removing a video from Watch Later never removes its note.
set -uo pipefail
source "$(dirname "$0")/lib.sh"

CAP=60
BACKFILL=false
case "${1:-}" in
  --seed) CAP=50 ;;
  # one-off: the playlist JSON carries a duration for every entry, so notes
  # seeded before durations were recorded can be filled in with one request
  --durations) BACKFILL=true; CAP=100000 ;;
esac

if [[ ! -s "$RL_COOKIES" ]]; then
  rl_log "youtube-wl: no cookie file at $RL_COOKIES, skipping"
  exit 1
fi

JSON=$(mktemp)
trap 'rm -f "$JSON"' EXIT

if ! timeout 300 yt-dlp --cookies "$RL_COOKIES" --flat-playlist -J \
      "https://www.youtube.com/playlist?list=WL" > "$JSON" 2>/tmp/rl-ytwl.err; then
  rl_log "youtube-wl: yt-dlp failed: $(tail -1 /tmp/rl-ytwl.err)"
  exit 1
fi

TOTAL=$(jq '.entries | length' "$JSON" 2>/dev/null || echo 0)
if [[ "$TOTAL" == "0" || "$TOTAL" == "null" ]]; then
  rl_log "youtube-wl: playlist came back empty (cookies stale?)"
  exit 1
fi

# Playlist order is newest-added first, so head -n is "newest n".
LIMIT=$TOTAL
[[ $CAP -lt $TOTAL ]] && LIMIT=$CAP

if [[ "$BACKFILL" == true ]]; then
  filled=0
  while IFS=$'\t' read -r id duration; do
    [[ "$duration" =~ ^[0-9]+$ ]] || continue
    while IFS= read -r f; do
      grep -q '^duration:' "$f" && continue
      tmp=$(mktemp)
      awk -v d="$duration" '
        /^---$/ { c++; if (c == 2) print "duration: " d; print; next }
        { print }
      ' "$f" > "$tmp" && cat "$tmp" > "$f" && rm -f "$tmp"
      filled=$((filled+1))
    done < <(grep -l "watch?v=$id" "$RL_INBOX"/*.md 2>/dev/null)
  done < <(jq -r '.entries[] | select(.duration != null) | [.id, (.duration | floor | tostring)] | @tsv' "$JSON")
  rl_log "youtube-wl: durations filled on $filled note(s)"
  exit 0
fi

rl_index_build
added=0; skipped=0

while IFS=$'\t' read -r id title channel published duration; do
  [[ -z "$id" ]] && continue
  url="https://www.youtube.com/watch?v=$id"
  if rl_seen "$url"; then skipped=$((skipped+1)); continue; fi
  [[ -z "$title" || "$title" == "null" ]] && title="youtube.com/$id"
  [[ "$channel" == "null" ]] && channel=""
  channel=$(printf '%s' "$channel" | sed 's/ *$//')
  if [[ "$published" == "null" || -z "$published" ]]; then
    published=""
  else
    published="${published:0:4}-${published:4:2}-${published:6:2}"
  fi
  body="**[Watch on YouTube →]($url)**

![]($url)

*Transcript not fetched yet. Opening this note in the reader pulls it.*"
  extra=""
  [[ "$duration" =~ ^[0-9]+$ ]] && extra="duration: $duration"
  rl_write_note "$title" "$url" "youtube.com" "$channel" "$published" \
                "video" "youtube-wl" "false" "$body" "" "$extra" > /dev/null
  rl_index_add "$url"
  added=$((added+1))
done < <(jq -r --argjson n "$LIMIT" '.entries[:$n][] | [.id, (.title // ""), (.channel // .uploader // ""), (.upload_date // ""), (.duration // "")] | @tsv' "$JSON")

rl_index_clean
rl_log "youtube-wl: playlist=$TOTAL scanned=$LIMIT added=$added already-stored=$skipped"
