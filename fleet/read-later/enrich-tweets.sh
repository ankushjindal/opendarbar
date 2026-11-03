#!/bin/bash
# Rewrite tweet notes from fxtwitter instead of the bookmarks page.
#
# The scrape can only see the collapsed "Show more" text and never sees the
# quoted tweet at all, so a bookmarked thread arrives truncated and without the
# thing it was quoting. fxtwitter returns the full text, the quote, the media
# and the real timestamp. Notes carrying `enriched: true` are skipped, so this
# is safe to re-run and cheap on a second pass.
#
#   ./enrich-tweets.sh              every tweet note not yet enriched
#   ./enrich-tweets.sh --force      all of them again
#   ./enrich-tweets.sh --threads    the thread step over notes that have no
#                                   thread yet: cheap to re-run (one fxtwitter
#                                   call for a post that turns out to stand
#                                   alone) and it catches a thread that grew
#                                   after the note was saved. Add --force to
#                                   redo the ones already known to be threads.
set -uo pipefail
source "$(dirname "$0")/lib.sh"

FORCE=false
THREADS=false
for a in "$@"; do
  case "$a" in
    --force)   FORCE=true ;;
    --threads) THREADS=true ;;
    *) echo "Unknown arg: $a" >&2; exit 1 ;;
  esac
done

done_n=0; skip_n=0; fail_n=0; articles_n=0; links_n=0; threads_n=0; posts_n=0
FAILED=()

for f in "$RL_INBOX"/*.md; do
  [[ -e "$f" ]] || continue
  grep -q '^kind: tweet' "$f" || continue
  if [[ "$THREADS" == true ]]; then
    # the thread pass: everything except what is already known to be a thread
    if [[ "$FORCE" == false ]] && grep -q '^thread: ' "$f"; then
      skip_n=$((skip_n+1)); continue
    fi
  elif [[ "$FORCE" == false ]] && grep -q '^enriched: true' "$f"; then
    skip_n=$((skip_n+1)); continue
  fi

  src=$(rl_note_source "$f")
  handle=$(sed -E 's#^https?://[^/]+/##; s#/.*##' <<<"$src")
  sid=$(sed -E 's#.*/status/([0-9]+).*#\1#' <<<"$src")
  if [[ -z "$handle" || -z "$sid" || ! "$sid" =~ ^[0-9]+$ ]]; then
    fail_n=$((fail_n+1)); FAILED+=("$(basename "$f"): unparseable source"); continue
  fi

  json=$(rl_fx_fetch "$handle" "$sid") || { sleep 1; json=$(rl_fx_fetch "$handle" "$sid") || true; }
  if [[ -z "$json" ]]; then
    fail_n=$((fail_n+1)); FAILED+=("$handle/$sid"); sleep 0.5; continue
  fi

  render=$(rl_tweet_render "$json" "$src") || { fail_n=$((fail_n+1)); FAILED+=("$handle/$sid render"); continue; }
  h1=$(jq -r '.h1' <<<"$render")
  pub=$(jq -r '.published' <<<"$render")
  md=$(jq -r '.md' <<<"$render")
  is_article=$(jq -r '.is_article' <<<"$render")
  thread=$(jq -r '.thread // 1' <<<"$render")
  thread_root=$(jq -r '.thread_root // ""' <<<"$render")
  if [[ "$thread" -ge 2 ]]; then
    threads_n=$((threads_n+1)); posts_n=$((posts_n+thread))
    rl_detail "thread $handle/$sid $thread posts$([[ -n "$thread_root" ]] && echo " (root $thread_root)")"
  fi

  # No text, no media, no article: the bookmark was a bare link, and the link is
  # the whole point of it. Resolve the t.co, keep it, and say where it went.
  link=""
  if [[ -z "$md" || "$md" == "null" ]]; then
    tco=$(jq -r '(.tweet.raw_text | strings) // ((.tweet.raw_text | objects).text // "")' <<<"$json" | grep -oE 'https://t\.co/[A-Za-z0-9]+' | head -1)
    if [[ -n "$tco" ]] && link=$(rl_resolve_link "$tco"); then
      title=$(rl_page_title "$link")
      h1="$title"
      md="**[$title]($link)**

*Shared as a link on X.*

**[Open on x.com →]($src)**"
      links_n=$((links_n+1))
    fi
  fi

  [[ -z "$h1" || "$h1" == "null" ]] && { fail_n=$((fail_n+1)); FAILED+=("$handle/$sid empty"); continue; }
  [[ "$is_article" == "true" ]] && articles_n=$((articles_n+1))

  # Frontmatter is rewritten in place: published filled in, enriched recorded,
  # every other key left exactly as it was. The filename never changes.
  tmp=$(mktemp)
  awk -v pub="$pub" -v art="$is_article" -v link="$link" -v thr="$thread" -v root="$thread_root" '
    /^---$/ { c++
      if (c == 2) {
        if (!seen_pub && pub != "") print "published: " pub
        if (!seen_enriched) print "enriched: true"
        if (art == "true" && !seen_art) print "article: true"
        if (link != "" && !seen_link) print "link: " link
        if (thr + 0 >= 2 && !seen_thr) print "thread: " thr
        if (root != "" && !seen_root) print "thread_root: " root
      }
      print; next }
    c == 1 && /^published:/ { print (pub == "" ? "published:" : "published: " pub); seen_pub=1; next }
    c == 1 && /^enriched:/ { print "enriched: true"; seen_enriched=1; next }
    c == 1 && /^article:/ { if (art == "true") print "article: true"; seen_art=1; next }
    c == 1 && /^link:/ { print (link == "" ? $0 : "link: " link); seen_link=1; next }
    # a post that turned out to stand alone loses the keys, so a thread that was
    # deleted down to one post does not leave the note claiming otherwise
    c == 1 && /^thread:/ { if (thr + 0 >= 2) print "thread: " thr; seen_thr=1; next }
    c == 1 && /^thread_root:/ { if (root != "") print "thread_root: " root; seen_root=1; next }
    c == 1 { print; next }
  ' "$f" > "$tmp"
  # What the owner wrote into the note is his and does not come back from
  # fxtwitter: the Highlights and Notes sections live at the end, and the body
  # rewrite has to put them back.
  his=$(awk '/^## (Highlights|Notes)[[:space:]]*$/ {found=1} found {print}' "$f")
  {
    echo "# $h1"
    echo
    printf '%s\n' "$md"
    [[ -n "$his" ]] && { echo; printf '%s\n' "$his"; }
  } >> "$tmp"
  cat "$tmp" > "$f" && rm -f "$tmp"
  done_n=$((done_n+1))
  sleep 0.5   # about two requests a second, which fxtwitter is fine with
done

rl_thread_clean

if [[ ${#FAILED[@]} -gt 0 ]]; then
  rl_log "enrich-tweets: could not fetch ${FAILED[*]}"
fi
rl_log "enrich-tweets: enriched=$done_n articles=$articles_n links=$links_n threads=$threads_n thread-posts=$posts_n already-done=$skip_n failed=$fail_n"
