#!/bin/bash
# Tag untagged notes with a headless Sonnet call, against kc's taxonomy.
#
#   ./autotag.sh [max_calls]        default 5 calls of up to 20 notes
#   ./autotag.sh --all              no cap, for the one-off seed
#   ./autotag.sh --file <path>      one note, used by the capture path
#
# The prompt is fed verbatim from tagger-prompt.md, which is also what the
# by-hand tagger agent uses, so there is one description of the job. Failure is
# always survivable: notes are simply left untagged and the run is logged.
set -uo pipefail
source "$(dirname "$0")/lib.sh"

DIR="$(cd "$(dirname "$0")" && pwd)"
TAXONOMY="$RL_VAULT/Reading/tags.md"
PROMPT_FILE="$DIR/tagger-prompt.md"
TOKEN_FILE="$HOME/.config/claude-accounts/work"
LOG="$HOME/kush/logs/read-later-tags.log"
MODEL="claude-sonnet-4-6"
BATCH=20

MAX_CALLS=5
ONE_FILE=""
case "${1:-}" in
  --all)  MAX_CALLS=1000 ;;
  --file) ONE_FILE="${2:-}"; MAX_CALLS=1 ;;
  [0-9]*) MAX_CALLS="$1" ;;
esac

mkdir -p "$(dirname "$LOG")"
[[ -r "$TOKEN_FILE" ]] || { rl_log "autotag: no work account token"; exit 1; }
[[ -r "$PROMPT_FILE" ]] || { rl_log "autotag: $PROMPT_FILE missing"; exit 1; }
[[ -r "$TAXONOMY" ]] || { rl_log "autotag: $TAXONOMY missing"; exit 1; }

# --- reading and writing the tags list -------------------------------------
# "reading" marks membership of the queue and "starred" belongs to the Star
# button, so neither counts as a tag for the purpose of "is this tagged yet".
rl_tags_of() {
  awk '
    /^---$/ { c++; if (c >= 2) exit; next }
    c == 1 && /^tags:[[:space:]]*\[/ { line=$0; sub(/^tags:[[:space:]]*\[/,"",line); sub(/\].*$/,"",line); gsub(/[",]/," ",line); print line; exit }
    c == 1 && /^tags:[[:space:]]*$/ { block=1; next }
    c == 1 && block && /^[[:space:]]+-[[:space:]]/ { t=$0; sub(/^[[:space:]]+-[[:space:]]*/,"",t); gsub(/"/,"",t); printf "%s ", t; next }
    c == 1 && block { block=0 }
  ' "$1" | tr -s ' '
}

rl_is_untagged() {
  local t
  t=$(rl_tags_of "$1" | tr ' ' '\n' | grep -v -x -e reading -e starred -e '' || true)
  [[ -z "$t" ]]
}

# rl_set_tags <file> <space separated tags> -- keeps the file's own YAML style
rl_set_tags() {
  local f="$1"; shift
  local list="reading $*"
  local tmp; tmp=$(mktemp)
  awk -v list="$list" '
    BEGIN { n = split(list, arr, " ") }
    /^---$/ { c++; print; next }
    c == 1 && /^tags:[[:space:]]*\[/ {
      out = "tags: ["
      for (i = 1; i <= n; i++) out = out arr[i] (i < n ? ", " : "")
      print out "]"; done=1; next }
    c == 1 && /^tags:[[:space:]]*$/ {
      print "tags:"
      for (i = 1; i <= n; i++) print "  - " arr[i]
      skip=1; done=1; next }
    c == 1 && skip && /^[[:space:]]+-[[:space:]]/ { next }
    c == 1 && skip { skip=0 }
    { print }
  ' "$f" > "$tmp" && cat "$tmp" > "$f" && rm -f "$tmp"
}

# --- the batch -------------------------------------------------------------
note_brief() {
  local f="$1" kind title site body
  kind=$(awk '/^kind:/ {print $2; exit}' "$f")
  title=$(awk '/^# /{sub(/^# /,""); print; exit}' "$f")
  site=$(awk -F'"' '/^site:/ {gsub(/^site:[[:space:]]*/,""); gsub(/"/,""); print; exit}' "$f")
  body=$(awk '/^---$/{c++; next} c>=2' "$f" | sed '1{/^# /d;}' | tr '\n' ' ' | tr -s ' ' | cut -c1-600)
  printf 'FILE: %s\nkind: %s\ntitle: %s\nsite: %s\ntext: %s\n---\n' \
    "$(basename "$f")" "${kind:-article}" "$title" "$site" "$body"
}

taxonomy_table() { grep '^|' "$TAXONOMY"; }

# The model retypes the file name it was given and quietly straightens the
# curly quotes and en dashes in it, so names are matched on a normalised form
# rather than byte for byte.
rl_norm_name() { sed "s/[‘’]/'/g; s/[“”]/\"/g; s/[–—]/-/g" | tr 'A-Z' 'a-z'; }

NAME_INDEX=$(mktemp)
build_index() {
  : > "$NAME_INDEX"
  local f
  for f in "$RL_INBOX"/*.md; do
    [[ -e "$f" ]] || continue
    printf '%s\t%s\n' "$(basename "$f" | rl_norm_name)" "$f" >> "$NAME_INDEX"
  done
}
resolve_name() {
  awk -F'\t' -v k="$(printf '%s' "$1" | rl_norm_name)" '$1 == k { print $2; exit }' "$NAME_INDEX"
}

MCP_EMPTY=$(mktemp); echo '{"mcpServers":{}}' > "$MCP_EMPTY"
cleanup() { rm -f "$MCP_EMPTY" "$NAME_INDEX"; }
trap cleanup EXIT

# call_model <prompt file> -> the model's raw text on stdout, non-zero on failure
call_model() {
  local out
  out=$(CLAUDE_CODE_OAUTH_TOKEN="$(cat "$TOKEN_FILE")" timeout 180 claude -p \
        --model "$MODEL" --output-format json \
        --strict-mcp-config --mcp-config "$MCP_EMPTY" \
        --disallowed-tools "Bash,Read,Write,Edit,WebFetch,WebSearch,Glob,Grep,Task,NotebookEdit" \
        < "$1" 2>/dev/null) || return 1
  jq -r '.result // empty' <<<"$out" 2>/dev/null | sed 's/^```json//; s/^```//; s/```$//'
}

# --- collect ---------------------------------------------------------------
build_index
FILES=()
if [[ -n "$ONE_FILE" ]]; then
  [[ -f "$ONE_FILE" ]] && rl_is_untagged "$ONE_FILE" && FILES+=("$ONE_FILE")
else
  while IFS= read -r f; do
    rl_is_untagged "$f" && FILES+=("$f")
  done < <(ls -t "$RL_INBOX"/*.md 2>/dev/null)
fi

if [[ ${#FILES[@]} -eq 0 ]]; then
  rl_log "autotag: nothing untagged"
  exit 0
fi

total=0; calls=0; NEW_TAGS=()
KNOWN=$(awk -F'|' '/^\|/ && $2 !~ /tag/ && $2 !~ /^[[:space:]]*-+[[:space:]]*$/ {gsub(/ /,"",$2); if ($2 != "") print $2}' "$TAXONOMY")

# run_batch <retry_allowed> <file>...  -> tags what it can, names what it cannot
run_batch() {
  local retry="$1"; shift
  local batch=("$@")
  [[ ${#batch[@]} -eq 0 ]] && return 0

  local req; req=$(mktemp)
  { cat "$PROMPT_FILE"; echo; echo "## Taxonomy"; echo; taxonomy_table; echo; echo "## Notes"; echo; } > "$req"
  local f
  for f in "${batch[@]}"; do note_brief "$f" >> "$req"; done

  local raw; raw=$(call_model "$req") || raw=""
  rm -f "$req"
  calls=$((calls+1))

  if [[ -z "$raw" ]] || ! jq -e 'type == "object"' <<<"$raw" >/dev/null 2>&1; then
    local why="empty answer"
    [[ -n "$raw" ]] && why="bad json"
    # A batch can be refused for being long or for one awkward note in it, and
    # halving separates those two cases cheaply.
    if [[ "$retry" == "yes" && ${#batch[@]} -gt 1 ]]; then
      rl_log "autotag: batch of ${#batch[@]} returned $why, retrying as halves"
      local half=$(( ${#batch[@]} / 2 ))
      run_batch no "${batch[@]:0:$half}"
      run_batch no "${batch[@]:$half}"
      return 0
    fi
    for f in "${batch[@]}"; do rl_detail "autotag SKIP $(basename "$f") $why"; done
    rl_log "autotag: batch of ${#batch[@]} returned $why, notes left untagged"
    return 0
  fi

  # what came back, so the rest can be named as unanswered
  local answered; answered=$(mktemp)
  local applied=0 name tags local_f t
  while IFS=$'\t' read -r name tags; do
    [[ -z "$name" ]] && continue
    local_f="$RL_INBOX/$name"
    [[ -f "$local_f" ]] || local_f=$(resolve_name "$name")
    if [[ -z "$local_f" || ! -f "$local_f" ]]; then
      rl_detail "autotag SKIP $name name unresolved"
      continue
    fi
    basename "$local_f" >> "$answered"
    [[ -z "$tags" ]] && { rl_detail "autotag SKIP $(basename "$local_f") empty tag list"; continue; }
    rl_is_untagged "$local_f" || continue
    rl_set_tags "$local_f" $(tr ',' ' ' <<<"$tags")
    applied=$((applied+1))
    for t in $(tr ',' ' ' <<<"$tags"); do
      grep -qx "$t" <<<"$KNOWN" || { NEW_TAGS+=("$t"); KNOWN="$KNOWN"$'\n'"$t"; }
    done
  done < <(jq -r 'to_entries[] | select(.value | type == "array") | "\(.key)\t\(.value | map(select(type == "string")) | join(","))"' <<<"$raw" 2>/dev/null)

  for f in "${batch[@]}"; do
    grep -qxF "$(basename "$f")" "$answered" 2>/dev/null || rl_detail "autotag SKIP $(basename "$f") not in the answer"
  done
  rm -f "$answered"
  total=$((total+applied))
}

i=0
while [[ $i -lt ${#FILES[@]} && $calls -lt $MAX_CALLS ]]; do
  BATCH_FILES=()
  n=0
  while [[ $i -lt ${#FILES[@]} && $n -lt $BATCH ]]; do
    BATCH_FILES+=("${FILES[$i]}")
    i=$((i+1)); n=$((n+1))
  done
  run_batch yes "${BATCH_FILES[@]}"
done

# --- taxonomy upkeep -------------------------------------------------------
# Counts are recounted from the inbox rather than incremented, so the table is
# right even if a run died halfway or someone edited tags by hand.
if [[ $total -gt 0 || ${#NEW_TAGS[@]} -gt 0 ]]; then
  for t in "${NEW_TAGS[@]:-}"; do
    [[ -z "$t" ]] && continue
    grep -q "^| $t |" "$TAXONOMY" || printf '| %s | new tag, needs a one-line meaning | 0 |\n' "$t" >> "$TAXONOMY"
  done
  tmp=$(mktemp)
  while IFS= read -r line; do
    if [[ "$line" =~ ^\|\ ([a-z0-9-]+)\ \| ]] && [[ "$line" != "| tag | meaning | count |" ]]; then
      tag="${BASH_REMATCH[1]}"
      c=$(grep -l -E "^([[:space:]]*-[[:space:]]*\"?$tag\"?[[:space:]]*|tags:.*[][:space:],]$tag[],[:space:]].*)$" "$RL_INBOX"/*.md 2>/dev/null | wc -l | tr -d ' ')
      echo "$line" | awk -F'|' -v c="$c" 'BEGIN{OFS="|"} {$4=" " c " "; print}'
    else
      echo "$line"
    fi
  done < "$TAXONOMY" > "$tmp" && cat "$tmp" > "$TAXONOMY" && rm -f "$tmp"
fi

newlist="none"
[[ ${#NEW_TAGS[@]} -gt 0 ]] && newlist=$(printf '%s,' "${NEW_TAGS[@]}" | sed 's/,$//')
printf '%s tagged=%s new_tags=%s files=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$total" "$newlist" "${#FILES[@]}" >> "$LOG"
rl_log "autotag: tagged=$total calls=$calls new_tags=$newlist"
