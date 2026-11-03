#!/bin/bash
# X bookmarks -> Reading/Inbox notes (kind: tweet, via: x-bookmarks).
#
#   ./x-bookmarks.sh --seed    scroll the whole list, up to 300 newest
#   ./x-bookmarks.sh           first screen only (hourly)
#
# Auth is two cookies (auth_token, ct0) lifted from the Dia export. The bulk
# --curl import rejects the httpOnly/secure fields, so they are set one by one.
# The log records counts only, plus handle and title per added note.
set -uo pipefail
source "$(dirname "$0")/lib.sh"

SESSION="read-later-x"
CAP=40
ROUNDS=1
if [[ "${1:-}" == "--seed" ]]; then CAP=300; ROUNDS=60; fi

ab() { agent-browser --session "$SESSION" "$@"; }
cleanup() { ab close >/dev/null 2>&1 || true; rm -f "$SEEN_FILE" 2>/dev/null; }

SEEN_FILE=$(mktemp)
trap cleanup EXIT

if [[ ! -s "$RL_COOKIES" ]]; then
  rl_log "x-bookmarks: no cookie file at $RL_COOKIES, skipping"
  exit 1
fi

ab open https://x.com/ >/dev/null 2>&1 || true

for name in auth_token ct0; do
  val=$(awk -F'\t' -v n="$name" '$1 ~ /x\.com$/ && $6==n {print $7; exit}' "$RL_COOKIES")
  if [[ -z "$val" ]]; then
    rl_log "x-bookmarks: cookie $name missing from the export, cannot authenticate"
    exit 1
  fi
  ab cookies set "$name" "$val" --domain .x.com --path / --secure --httpOnly --url https://x.com >/dev/null 2>&1 \
    || { rl_log "x-bookmarks: failed to set cookie $name"; exit 1; }
done
unset val

ab open https://x.com/i/bookmarks >/dev/null 2>&1 || true
sleep 6

# x.com serves bookmarks as a tab on /i/history. Select it if it is not already.
ab eval '(()=>{const t=[...document.querySelectorAll("[role=\"tab\"]")].find(x=>/bookmark/i.test(x.innerText));if(t&&t.getAttribute("aria-selected")!=="true"){t.click();return "clicked"}return t?"already":"no-tab"})()' >/dev/null 2>&1
sleep 3

# X renders a link as several spans, so innerText breaks URLs across lines.
# Walk the nodes instead: <br> and block children become newlines, emoji images
# become their alt text, everything else concatenates as written.
HARVEST='(()=>{function txt(el){if(!el)return "";var s="";(function w(n){n.childNodes.forEach(function(c){if(c.nodeType===3){s+=c.nodeValue;return}if(c.nodeType!==1)return;var t=c.tagName;if(t==="BR"){s+="\n";return}if(t==="IMG"){s+=c.getAttribute("alt")||"";return}if(t==="DIV"&&s&&!/\n$/.test(s))s+="\n";w(c)})})(el);return s}const out=[];document.querySelectorAll("article[data-testid=\"tweet\"]").forEach(a=>{const t=a.querySelector("time");const link=t&&t.closest("a");const perm=link&&link.getAttribute("href");if(!perm||!/\/status\/\d+/.test(perm))return;const un=a.querySelector("div[data-testid=\"User-Name\"]");out.push({perm:perm,dt:t.getAttribute("datetime")||"",text:txt(a.querySelector("div[data-testid=\"tweetText\"]")),name:un?un.innerText.split("\n")[0]:""})});return out})()'

# The list is virtualized (about six articles in the DOM at a time), so harvest
# after every scroll and accumulate here rather than reading the DOM once.
COLLECTED=$(mktemp)
trap 'cleanup; rm -f "$COLLECTED"' EXIT
stale=0
for ((r=0; r<ROUNDS; r++)); do
  before=$(wc -l < "$COLLECTED")
  ab --json eval "$HARVEST" 2>/dev/null | jq -c '.data.result[]?' 2>/dev/null >> "$COLLECTED"
  awk 'match($0,/"perm":"[^"]*"/){k=substr($0,RSTART,RLENGTH); if(!(k in s)){s[k]=1; print}}' "$COLLECTED" > "$COLLECTED.u" && mv "$COLLECTED.u" "$COLLECTED"
  now=$(wc -l < "$COLLECTED")
  [[ $now -ge $CAP ]] && break
  [[ $ROUNDS -eq 1 ]] && break
  if [[ "$now" -eq "$before" ]]; then
    stale=$((stale+1)); [[ $stale -ge 4 ]] && break
  else
    stale=0
  fi
  ab eval 'window.scrollBy(0, window.innerHeight*3); "ok"' >/dev/null 2>&1
  sleep 3
done

rl_index_build
added=0; skipped=0; scanned=0

while IFS= read -r row; do
  [[ -z "$row" ]] && continue
  scanned=$((scanned+1))
  [[ $scanned -gt $CAP ]] && break
  perm=$(jq -r '.perm' <<<"$row")
  handle=$(cut -d/ -f2 <<<"$perm")
  url="https://x.com${perm%%\?*}"
  if rl_seen "$url"; then skipped=$((skipped+1)); continue; fi
  text=$(jq -r '.text // ""' <<<"$row")
  name=$(jq -r '.name // ""' <<<"$row")
  dt=$(jq -r '.dt // ""' <<<"$row")
  published="${dt:0:10}"
  sid=$(sed -E 's#.*/status/([0-9]+).*#\1#' <<<"$perm")

  # The page only ever has the collapsed "Show more" text and never the quoted
  # tweet, so the body comes from fxtwitter and the scrape is the fallback.
  h1=""; extra=""
  fx=$(rl_fx_fetch "$handle" "$sid") || fx=""
  if [[ -n "$fx" ]]; then
    render=$(rl_tweet_render "$fx" "$url")
    h1=$(jq -r '.h1 // ""' <<<"$render")
    body=$(jq -r '.md // ""' <<<"$render")
    fxpub=$(jq -r '.published // ""' <<<"$render")
    fxname=$(jq -r '.name // ""' <<<"$render")
    [[ -n "$fxpub" && "$fxpub" != "null" ]] && published="$fxpub"
    [[ -n "$fxname" && "$fxname" != "null" ]] && name="$fxname"
    [[ -n "$body" ]] && extra="enriched: true"
    # the thread walk happens inside rl_tweet_render; the body already carries
    # the posts, the frontmatter needs to say how many
    thread=$(jq -r '.thread // 1' <<<"$render")
    thread_root=$(jq -r '.thread_root // ""' <<<"$render")
    [[ "$thread" -ge 2 ]] && extra="$extra
thread: $thread"
    [[ -n "$thread_root" ]] && extra="$extra
thread_root: $thread_root"
    # the "1/7" markers of a thread are not words the title should be made of
    text=$(grep -v '^\*\*[0-9][0-9]*/[0-9][0-9]*\*\*$' <<<"$body" | sed -E 's/^> //' | head -c 400)
  fi
  if [[ -z "$extra" ]]; then
    quoted=$(printf '%s' "$text" | sed 's/^/> /')
    body="**[Open on x.com →]($url)**

$quoted"
  fi

  short=$(printf '%s' "$text" | tr '\n' ' ' | cut -c1-80 | sed 's/ *$//')
  [[ -z "$short" ]] && short="(no text)"
  # X shows the display name and the handle; when they are the same string do
  # not print it twice. The filename keeps this short form even when fxtwitter
  # gave us a better heading.
  if [[ -n "$name" && "$(tr 'A-Z' 'a-z' <<<"${name#@}")" != "$(tr 'A-Z' 'a-z' <<<"$handle")" ]]; then
    title="$name (@$handle): $short"
  else
    title="@$handle: $short"
  fi
  rl_write_note "$title" "$url" "x.com" "@$handle" "$published" \
                "tweet" "x-bookmarks" "true" "$body" "$h1" "$extra" > /dev/null
  sleep 0.5   # polite to fxtwitter
  rl_index_add "$url"
  added=$((added+1))
done < "$COLLECTED"

rl_index_clean
rl_thread_clean
rl_log "x-bookmarks: collected=$(wc -l < "$COLLECTED" | tr -d ' ') cap=$CAP added=$added already-stored=$skipped"
