#!/bin/bash
# Shared helpers for the read-later feeds (youtube-wl.sh, x-bookmarks.sh).
#
# The feeds only ever write PLACEHOLDER notes (fetched: false) or, for tweets,
# a note whose body is already complete. Full article/transcript fetching stays
# in ~/.claude/skills/read-later/add.sh, which the dashboard calls with --full
# on first open. One fetch implementation, not two.
#
# Source this file; it defines RL_INBOX and the rl_* functions.

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

RL_VAULT="/Users/owner/work/self/notes-vault"
RL_INBOX="$RL_VAULT/Reading/Inbox"
RL_TRASH="$RL_VAULT/Reading/Trash"
RL_COOKIES="$HOME/.config/read-later/cookies.txt"

# --- URL normalization -------------------------------------------------------
# Strips tracking params, folds youtu.be into youtube.com/watch?v=, folds
# twitter.com into x.com, drops a trailing slash. Used for dedupe keys only;
# the note keeps the cleaned (not folded) URL as `source`.
rl_norm_url() {
  local u="$1"
  u=$(printf '%s' "$u" | sed -E 's/[?&](utm_[^&]*|fbclid|gclid|mc_[ce]id|ref|source|si|feature|pp)=[^&]*//g; s/[?&]$//; s/\?&/?/')
  u=${u#http://}; u=${u#https://}; u=${u#www.}; u=${u#m.}; u=${u#mobile.}
  case "$u" in
    youtu.be/*)
      local id=${u#youtu.be/}; id=${id%%\?*}; id=${id%%&*}
      u="youtube.com/watch?v=$id" ;;
    youtube.com/watch*)
      local id=${u#*v=}; id=${id%%&*}
      u="youtube.com/watch?v=$id" ;;
    twitter.com/*) u="x.com/${u#twitter.com/}" ;;
  esac
  u=${u%/}
  printf '%s' "$u"
}

# --- Dedupe index ------------------------------------------------------------
# rl_index_build populates RL_INDEX (a temp file of normalized source URLs).
# Call once per run, then rl_seen <url> per candidate.
RL_INDEX=""
rl_index_build() {
  RL_INDEX=$(mktemp)
  local src
  # Trash counts as known. A note he deleted is a decision, and the feeds
  # re-creating it an hour later would quietly overrule him. Restoring is
  # moving the file back into Inbox.
  grep -h -E '^(source|link):' "$RL_INBOX"/*.md "$RL_TRASH"/*.md 2>/dev/null \
    | sed -E 's/^(source|link):[[:space:]]*//; s/^"(.*)"$/\1/' \
    | while IFS= read -r src; do
        [[ -n "$src" ]] && rl_norm_url "$src" && echo
      done > "$RL_INDEX"
}

rl_index_clean() { [[ -n "$RL_INDEX" ]] && rm -f "$RL_INDEX"; RL_INDEX=""; }

rl_seen() {
  [[ -s "$RL_INDEX" ]] || return 1
  grep -qxF "$(rl_norm_url "$1")" "$RL_INDEX"
}

rl_index_add() { rl_norm_url "$1" >> "$RL_INDEX"; echo >> "$RL_INDEX"; }

# rl_note_source <file> -> the source URL, unquoted.
# Splitting the line on ": " would also split on the colon in "https:", which is
# how every clipper note briefly ended up typed as an article.
rl_note_source() {
  sed -n 's/^source:[[:space:]]*//p' "$1" | head -1 | tr -d '"' | sed 's/[[:space:]]*$//'
}

# --- Note writing ------------------------------------------------------------
# rl_safe_name <title> -> a filename-safe stem, deduped against the inbox.
rl_safe_name() {
  local safe
  safe=$(printf '%s' "$1" | tr '/:*?"<>|\\' '-' | tr '\n' ' ' | tr -s ' ' ' ' | cut -c1-100 | sed 's/^ *//; s/ *$//')
  [[ -z "$safe" ]] && safe="untitled"
  local stem="$safe" i=2
  while [[ -e "$RL_INBOX/$stem.md" ]]; do stem="$safe-$i"; i=$((i+1)); done
  printf '%s' "$stem"
}

# rl_write_note <title> <url> <site> <author> <published> <kind> <via> <fetched> <body> [h1] [extra_fm]
# The filename comes from <title>; <h1> overrides only the heading in the body,
# which is how a tweet keeps its short filename but gets a readable heading.
# Never overwrites: rl_safe_name has already picked a free path.
rl_write_note() {
  local title="$1" url="$2" site="$3" author="$4" published="$5"
  local kind="$6" via="$7" fetched="$8" body="$9"
  local h1="${10:-}" extra="${11:-}"
  [[ -z "$h1" ]] && h1="$title"
  local stem file
  stem=$(rl_safe_name "$title")
  file="$RL_INBOX/$stem.md"
  {
    echo "---"
    echo "source: $url"
    if [[ -n "$author" ]]; then
      echo "author:"
      echo "  - \"[[$author]]\""
    else
      echo "author:"
    fi
    echo "site: $site"
    if [[ -n "$published" ]]; then echo "published: $published"; else echo "published:"; fi
    echo "clipped: $(date +%Y-%m-%d)"
    echo "added: $(date +%Y-%m-%dT%H:%M:%S)"
    echo "status: unread"
    echo "fetched: $fetched"
    echo "rating:"
    echo "tags:"
    echo "  - reading"
    echo "kind: $kind"
    echo "via: $via"
    [[ -n "$extra" ]] && printf '%s\n' "$extra"
    echo "---"
    echo "# $h1"
    echo
    printf '%s\n' "$body"
  } > "$file"
  printf '%s' "$file"
}

rl_log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

# Per-item failures go to the detail log beside the run summary. A count with no
# file name in it is not something anyone can act on.
RL_DETAIL="$HOME/kush/logs/read-later-sync.log.detail"
rl_detail() {
  mkdir -p "$(dirname "$RL_DETAIL")" 2>/dev/null
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$RL_DETAIL"
}

# --- Tweets via fxtwitter ----------------------------------------------------
# The bookmarks page only ever renders the collapsed "Show more" text and drops
# the quoted tweet entirely, so the page is used for permalinks and fxtwitter is
# used for content. Same API add.sh already talks to.

# rl_fx_fetch <handle> <status_id> -> the JSON on stdout, non-zero if unusable
rl_fx_fetch() {
  local h="$1" id="$2" json
  json=$(curl -s --max-time 12 "https://api.fxtwitter.com/${h}/status/${id}" 2>/dev/null) || return 1
  [[ -z "$json" ]] && return 1
  [[ "$(jq -r '.code // 0' <<<"$json" 2>/dev/null)" == "200" ]] || return 1
  # A tweet is usable if it has text, media, or an article. The previous check
  # piped the concatenated text into the media test, so `.tweet` was evaluated
  # against a string and jq errored: every X Article looked like a dead fetch.
  jq -e '.tweet as $t
         | ((($t.text | strings) // "") != "")
           or ((($t.raw_text | strings) // "") != "")
           or (((($t.raw_text | objects).text // "")) != "")
           or ((($t.media.all // []) | length) > 0)
           or (($t.article | type) == "object")' <<<"$json" >/dev/null 2>&1 || return 1
  printf '%s' "$json"
}

# One post as markdown: its words as a blockquote, the tweet it quotes, then its
# media. Split out of the render below because a thread needs the same shape for
# every post in it, and two copies of the media rules would drift.
RL_POST_JQ='
def flat: gsub("\n"; " ") | gsub("  +"; " ") | sub("^ +";"") | sub(" +$";"");
# a reply opens with the handles it is replying to; they are not the sentence
def dementions: sub("^(@[A-Za-z0-9_]+[[:space:]]+)+"; "");
def title($s):
  if ($s | length) <= 120 then $s
  else ($s[0:120]) as $head
    | ([$head | match("[.!?]"; "g")] | last | .offset) as $p
    | if ($p != null and $p > 25) then $head[0:$p+1]
      else (([$head | match(" "; "g")] | last | .offset) as $sp
            | if $sp then ($head[0:$sp] + "...") else $head end)
      end
  end;
def tweettext($x):
  if (($x.text | type) == "string" and ($x.text | length) > 0) then $x.text
  elif ($x.raw_text | type) == "string" then $x.raw_text
  elif ($x.raw_text | type) == "object" then ($x.raw_text.text // "")
  else "" end;
# An X Article is a long-form post; the tweet shell around it has no text at
# all, which is why these arrived blank. fxtwitter carries the whole thing.
def articleof($t):
  if (($t.article | type) == "object") and ((($t.article.content.blocks // []) | length) > 0)
  then { title: ($t.article.title // ""),
         md: ($t.article.content.blocks | map(.text // "") | map(select(. != "")) | join("\n\n")) }
  else null end;
# the trailing t.co is the quoted tweet itself; the quote block replaces it
def bodytext($t):
  tweettext($t) as $raw
  | if ($t.quote | type) == "object"
    then ($raw | sub("[[:space:]]*https?://[^[:space:]]+[[:space:]]*$"; ""))
    else $raw end;
def postmd($t):
  ([ ("> " + (bodytext($t) | gsub("\n"; "\n> "))) ]
  + (if ($t.quote | type) == "object" then
      [ "",
        "## Quoting @" + ($t.quote.author.screen_name // "unknown"),
        "",
        "> " + (tweettext($t.quote) | gsub("\n"; "\n> ")),
        "",
        "[" + ($t.quote.url // "") + "](" + ($t.quote.url // "") + ")" ]
    else [] end)
  + (($t.media.all // []) | map(
      if .type == "photo" then ("\n![](" + .url + ")")
      else ("\n[" + (.type | ascii_upcase) + "](" + .url + ")") end))
  | join("\n"));
'

RL_TWEET_JQ="$RL_POST_JQ"'
.tweet as $t
| bodytext($t) as $body
| articleof($t) as $art
| {
    is_article: ($art != null),
    h1: (if $art != null and ($art.title | length) > 0 then $art.title else title($body | flat | dementions) end),
    published: (if $t.created_timestamp then ($t.created_timestamp | strftime("%Y-%m-%d")) else "" end),
    handle: ($t.author.screen_name // ""),
    name: ($t.author.name // ""),
    md: (if $art != null then
      ($art.md + "\n\n**[Read on x.com →](" + $URL + ")**")
    else
      (postmd($t) + "\n\n**[Open on x.com →](" + $URL + ")**")
    end)
  }'

# rl_resolve_link <t.co url> -> where it actually goes, or nothing
rl_resolve_link() {
  local out
  out=$(curl -sIL --max-time 10 -o /dev/null -w '%{url_effective}' "$1" 2>/dev/null) || return 1
  [[ -n "$out" && "$out" != "$1" ]] || return 1
  printf '%s' "$out"
}

# rl_page_title <url> -> the <title>, or the host
rl_page_title() {
  local t
  t=$(curl -sL --max-time 10 -A "Mozilla/5.0" "$1" 2>/dev/null \
      | tr '\n' ' ' | grep -oE '<title[^>]*>[^<]+</title>' | head -1 \
      | sed -E 's/<[^>]*>//g; s/^ *//; s/ *$//')
  [[ -n "$t" ]] && printf '%s' "$t" || printf '%s' "$(awk -F/ '{print $3}' <<<"$1")"
}

# --- Threads -----------------------------------------------------------------
# A thread is one author replying to himself, and it is one piece of reading:
# the note should carry the whole chain, not the single post that was bookmarked.
#
# Walking UP is solved: fxtwitter says which post a reply replies to
# (`replying_to` is the handle, `replying_to_status` the id), so from any post we
# can climb to the root, signed out, for one cheap call per hop.
#
# Walking DOWN is not. Nothing public returns a tweet's children - checked on
# 2026-09-11: fxtwitter and vxtwitter have no such field (and no /thread route),
# cdn.syndication.twimg.com's tweet-result carries the tweet and its `parent`
# only, and every nitter mirror still up answers with a bot check. The one place
# the replies exist is the status page, so DOWN reads it through the signed-in
# agent-browser session and verifies each candidate against fxtwitter before
# believing it. When that session is not usable - x.com answers a cookie-less
# browser with 403 - the thread is simply what the UP walk found, and the note
# keeps everything it already had.

RL_THREADS="${RL_THREADS:-1}"              # 0 skips the thread step entirely
RL_THREAD_MAX="${RL_THREAD_MAX:-25}"       # a chain longer than this is a bug
RL_THREAD_BROWSER="${RL_THREAD_BROWSER:-1}"
RL_X_SESSION="${RL_X_SESSION:-read-later-x}"
RL_X_DOWN=0        # set once the status page has proved unusable, for the run
RL_X_DOWN_STAMP="${TMPDIR:-/tmp}/read-later-x-down"
RL_X_DOWN_FOR=1800 # seconds a proven-signed-out session is believed
RL_FX_CACHE=""

# The walk visits the same post several times (once climbing, once rendering),
# and a backfill visits every post of a thread once per saved note in it. Cache
# what fxtwitter said, so the network sees each post once per run.
rl_fx_cached() {
  local h="$1" id="$2" f json
  [[ -z "$RL_FX_CACHE" ]] && RL_FX_CACHE=$(mktemp -d)
  f="$RL_FX_CACHE/$id.json"
  [[ -s "$f" ]] && { cat "$f"; return 0; }
  json=$(rl_fx_fetch "$h" "$id") || return 1
  printf '%s' "$json" > "$f"
  printf '%s' "$json"
}

rl_fx_cache_put() {
  [[ -z "$RL_FX_CACHE" ]] && RL_FX_CACHE=$(mktemp -d)
  printf '%s' "$2" > "$RL_FX_CACHE/$1.json"
  return 0
}

rl_thread_clean() { [[ -n "$RL_FX_CACHE" ]] && rm -rf "$RL_FX_CACHE"; RL_FX_CACHE=""; return 0; }

# rl_thread_up <handle> <id> -> the ids above <id>, oldest first, one per line
rl_thread_up() {
  local h="$1" id="$2" json parent pauthor chain="" i=0
  while [[ $i -lt $RL_THREAD_MAX ]]; do
    json=$(rl_fx_cached "$h" "$id") || break
    pauthor=$(jq -r '.tweet.replying_to // ""' <<<"$json" 2>/dev/null)
    parent=$(jq -r '.tweet.replying_to_status // ""' <<<"$json" 2>/dev/null)
    [[ -z "$parent" || "$parent" == "null" ]] && break
    # only the author answering himself is a thread. A reply to someone else is
    # a conversation, and dragging that in would change what he saved.
    [[ "$(tr 'A-Z' 'a-z' <<<"$pauthor")" == "$(tr 'A-Z' 'a-z' <<<"$h")" ]] || break
    chain="$parent
$chain"
    id="$parent"; i=$((i+1))
    sleep 0.7   # gentle: fxtwitter is somebody's free API
  done
  printf '%s' "$chain"
}

rl_ab() {
  local to
  to=$(command -v timeout || command -v gtimeout || true)
  if [[ -n "$to" ]]; then "$to" 60 agent-browser --session "$RL_X_SESSION" "$@"
  else agent-browser --session "$RL_X_SESSION" "$@"; fi
}

# The session has its own cookie jar, and nobody else fills it. x-bookmarks.sh
# signs in at the top of its run, so the down-walk inherited a signed-in session
# only when the feed happened to have run first; on its own it met x.com's 403
# and concluded he was logged out. Sign in here too, once per process. The
# values are read from the export and never printed.
RL_X_AUTHED=0
rl_x_auth() {
  [[ "$RL_X_AUTHED" == "1" ]] && return 0
  [[ -s "$RL_COOKIES" ]] || return 1
  local name val
  rl_ab open https://x.com/ >/dev/null 2>&1 || true
  for name in auth_token ct0; do
    val=$(awk -F'\t' -v n="$name" '$1 ~ /x\.com$/ && $6==n {print $7; exit}' "$RL_COOKIES")
    [[ -z "$val" ]] && { unset val; return 1; }
    rl_ab cookies set "$name" "$val" --domain .x.com --path / --secure --httpOnly --url https://x.com >/dev/null 2>&1 \
      || { unset val; return 1; }
  done
  unset val
  RL_X_AUTHED=1
  return 0
}

# rl_x_children <handle> <root_id> -> status-page permalink ids for that author.
# Candidates only: the page also carries other people's replies and whatever X
# decided to show underneath, so the caller checks the chain before using them.
rl_x_children() {
  local h="$1" root="$2" out="" got r js
  [[ "$RL_THREAD_BROWSER" == "1" && "$RL_X_DOWN" == "0" ]] || return 1
  command -v agent-browser >/dev/null 2>&1 || { RL_X_DOWN=1; return 1; }
  # Capture is interactive: a save from Telegram must not spend fifteen seconds
  # per tweet re-proving that the session is signed out. One process finding it
  # dead spares the next half hour of them.
  local age
  if [[ -f "$RL_X_DOWN_STAMP" ]]; then
    age=$(( $(date +%s) - $(stat -f %m "$RL_X_DOWN_STAMP" 2>/dev/null || stat -c %Y "$RL_X_DOWN_STAMP" 2>/dev/null || echo 0) ))
    [[ "$age" -lt "$RL_X_DOWN_FOR" ]] && { RL_X_DOWN=1; return 1; }
  fi
  if ! rl_x_auth; then
    rl_detail "thread DOWN unavailable: no usable x.com cookies in the export"
    RL_X_DOWN=1; touch "$RL_X_DOWN_STAMP" 2>/dev/null; return 1
  fi
  js='(()=>{const o=[];document.querySelectorAll("article[data-testid=\"tweet\"]").forEach(a=>{const t=a.querySelector("time");const l=t&&t.closest("a");const p=l&&l.getAttribute("href");if(p&&/\/status\/[0-9]+/.test(p))o.push(p)});return o.join(" ")})()'
  rl_ab open "https://x.com/${h}/status/${root}" >/dev/null 2>&1
  sleep 6
  # the conversation is virtualized like the bookmarks list, so harvest after
  # every scroll and accumulate rather than reading the DOM once
  for r in 1 2 3 4 5; do
    got=$(rl_ab --json eval "$js" 2>/dev/null | jq -r '.data.result // ""' 2>/dev/null)
    # nothing at all on the first look means not signed in (x.com answers a
    # cookie-less browser with 403). Say so once and stop trying this run.
    if [[ $r -eq 1 && -z "$got" ]]; then
      RL_X_DOWN=1
      : > "$RL_X_DOWN_STAMP" 2>/dev/null
      rl_detail "thread DOWN unavailable: x.com/$h/status/$root rendered no tweets (signed out?)"
      return 1
    fi
    out="$out $got"
    rl_ab eval 'window.scrollBy(0, window.innerHeight*2); "ok"' >/dev/null 2>&1
    sleep 2
  done
  # the author's own posts, newest-id last, each id once. Lowercased first
  # because BSD awk has no IGNORECASE and a handle is case-insensitive.
  printf '%s' "$out" | tr ' ' '\n' | tr 'A-Z' 'a-z' \
    | awk -v h="$(tr 'A-Z' 'a-z' <<<"$h")" '$0 ~ "^/" h "/status/[0-9]+" {sub("^/[^/]*/status/",""); sub("[^0-9].*$",""); if(!($0 in s)){s[$0]=1; print}}' \
    | awk -v root="$root" 'length($0) > length(root) || (length($0) == length(root) && $0 > root)' \
    | awk '{print length, $0}' | sort -n -k1,1 -k2,2 | cut -d' ' -f2
}

# rl_thread_ids <handle> <id> -> every id of the self-chain <id> belongs to, in
# order. One line when the post stands alone.
rl_thread_ids() {
  local h="$1" id="$2" up chain last cand json rt rts
  up=$(rl_thread_up "$h" "$id")
  chain=$(printf '%s\n%s\n' "$up" "$id" | grep -v '^$')
  last=$(printf '%s' "$chain" | tail -1)
  # DOWN: the page's candidates are only believed when fxtwitter confirms each
  # one is the author replying to the post before it.
  while IFS= read -r cand; do
    [[ -z "$cand" ]] && continue
    json=$(rl_fx_cached "$h" "$cand") || continue
    rt=$(jq -r '.tweet.replying_to // ""' <<<"$json" 2>/dev/null)
    rts=$(jq -r '.tweet.replying_to_status // ""' <<<"$json" 2>/dev/null)
    [[ "$rts" == "$last" ]] || continue
    [[ "$(tr 'A-Z' 'a-z' <<<"$rt")" == "$(tr 'A-Z' 'a-z' <<<"$h")" ]] || continue
    chain="$chain
$cand"
    last="$cand"
    sleep 0.7
  done <<< "$(rl_x_children "$h" "$(printf '%s' "$chain" | head -1)" 2>/dev/null || true)"
  printf '%s\n' "$chain"
}

# rl_thread_md <ndjson of tweets, in order> <url> -> the posts as one body
rl_thread_md() {
  jq -rs --arg URL "$2" "$RL_POST_JQ"'
    length as $n
    | to_entries
    | map("**" + ((.key + 1) | tostring) + "/" + ($n | tostring) + "**\n\n" + postmd(.value.tweet))
    | join("\n\n")
    | . + "\n\n**[Open on x.com →](" + $URL + ")**"' "$1"
}

# rl_tweet_render <json> <url> -> compact JSON {h1, is_article, published,
# handle, name, md, thread, thread_root}. `thread` is the number of posts (1
# when the tweet stands alone) and `thread_root` is set only when the saved post
# is not the first one.
rl_tweet_render() {
  local json="$1" url="$2" render h id ids n root tmp one
  render=$(jq -c --arg URL "$url" "$RL_TWEET_JQ" <<<"$json")
  [[ "$RL_THREADS" == "1" ]] || { printf '%s' "$render"; return 0; }
  # an X Article is already the long read; it has no thread around it
  [[ "$(jq -r '.is_article' <<<"$render" 2>/dev/null)" == "true" ]] && { printf '%s' "$render"; return 0; }
  h=$(jq -r '.tweet.author.screen_name // ""' <<<"$json" 2>/dev/null)
  id=$(jq -r '.tweet.id // ""' <<<"$json" 2>/dev/null)
  [[ -n "$h" && -n "$id" ]] || { printf '%s' "$render"; return 0; }

  rl_fx_cache_put "$id" "$json"
  ids=$(rl_thread_ids "$h" "$id")
  n=$(printf '%s\n' "$ids" | grep -c '[0-9]')
  [[ "$n" -lt 2 ]] && { printf '%s' "$render"; return 0; }

  tmp=$(mktemp)
  while IFS= read -r one; do
    [[ -z "$one" ]] && continue
    rl_fx_cached "$h" "$one" >> "$tmp" && echo >> "$tmp"
  done <<< "$ids"
  n=$(jq -s 'length' "$tmp" 2>/dev/null || echo 0)
  if [[ "$n" -lt 2 ]]; then rm -f "$tmp"; printf '%s' "$render"; return 0; fi

  root=$(printf '%s\n' "$ids" | grep '[0-9]' | head -1)
  render=$(jq -c --arg md "$(rl_thread_md "$tmp" "$url")" --argjson n "$n" \
              --arg root "$(if [[ "$root" == "$id" ]]; then echo ""; else echo "$root"; fi)" \
              '.md = $md | .thread = $n | .thread_root = $root' <<<"$render")
  rm -f "$tmp"
  printf '%s' "$render"
}
