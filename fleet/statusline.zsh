#!/usr/bin/env zsh
#
# statusline.zsh - ONE statusline for both machines (Mac + server).
#
# History: the Mac copy (244 lines) and the server copy (180 lines, a Jul-15 fork)
# diverged. Two renderers, two cache schemas, and an account label that was wrong
# under OAT tokens. Merged here on 2026-09-07 as the single source of truth.
# Deploy = symlink every `~/.claude/statusline.zsh` at this file. The statusline
# re-executes on every render, so a symlink swap is live instantly: no restarts.
#
# Two things the old scripts got wrong and this one fixes:
#
#  1. ACCOUNT IDENTITY under an injected CLAUDE_CODE_OAUTH_TOKEN. `claude auth
#     status` reports authMethod=oauth_token with NO email, so the Mac script fell
#     back to a GLOBAL /tmp/.claude_auth_cache - meaning a `dcx work` session
#     rendered whatever the last session on the machine happened to write (usually
#     the keychain login). Resolution order is now explicit, cheapest-first:
#        CLAUDE_ACCT_LABEL env
#     -> md5(CLAUDE_CODE_OAUTH_TOKEN) vs the stored token files
#     -> $HOME/.claude/kushbot-auth-account  (written by fleet-ctl at launch)
#     -> `claude auth status` email, cached PER HOME + PER AUTH METHOD
#     -> "?"
#     The token hash sits ABOVE the marker on purpose: the marker is a launch-time
#     note that goes stale on an account switch, the hash is what is being spent.
#     `acct:<label>` now renders ALWAYS (it is identity, not a nice-to-have).
#
#  2. CACHE SCHEMA. Both scripts wrote /tmp/.claude_status_<session>.json but with
#     different fields, so no reader could tell which ACCOUNT a cache belonged to.
#     One schema now, a superset of both, with `label`/`email`/`host` added:
#        session_id host agent label email model effort ctx_pct ctx_size
#        five_h_pct five_h_resets seven_d_pct seven_d_resets ts
#     Readers that must keep working: kushbot /status (src/status.ts),
#     /account + readAllStatusCaches (src/accounts.ts), src/session.ts,
#     fleet-watchdog.sh L1/L2, fleet-ctl status, macctl, claude-acct.sh usage.
#     ts is INTEGER SECONDS (the watchdog normalizes s vs ms; keep it seconds).

# Read JSON from stdin
json=$(cat)

# ANSI colors
RED=$'\033[31m'
YELLOW=$'\033[33m'
GREEN=$'\033[32m'
CYAN=$'\033[36m'
MAGENTA=$'\033[38;5;165m'  # vivid magenta-purple - Fable highlight (pops on light themes)
ORANGE=$'\033[38;5;208m'
BOLD=$'\033[1m'
DIM=$'\033[2m'
RESET=$'\033[0m'
ESC=$'\033'

# OSC 8 hyperlink helper: link URL TEXT
link() { printf '%s' "${ESC}]8;;${1}${ESC}\\${2}${ESC}]8;;${ESC}\\"; }

# --- Platform branch (the only real Mac/Linux difference: stat + date + md5) ---
UNAME=$(uname -s)
if [[ "$UNAME" == "Darwin" ]]; then
  mtime_of() { stat -f %m "$1" 2>/dev/null || echo 0 }
  at_epoch() { date -r "$1" "+$2" 2>/dev/null }            # at_epoch <epoch> <fmt>
  md5_str()  { printf '%s' "$1" | md5 -q 2>/dev/null }
else
  mtime_of() { stat -c %Y "$1" 2>/dev/null || echo 0 }
  at_epoch() { date -d "@$1" "+$2" 2>/dev/null }
  md5_str()  { printf '%s' "$1" | md5sum 2>/dev/null | cut -d' ' -f1 }
fi

# Host identity. server wears an orange badge (it is the always-on server and
# the owner reads the badge to know he is looking at a server pane); the Mac wears
# none, exactly as before. Per-machine dashboard IP also branches here.
short_host=$(uname -n 2>/dev/null)
short_host=${short_host%%.*}
if [[ "$short_host" == *server* ]]; then
  host_name="server"
  host_badge="🖥️ server"
  dash_ip="100.64.0.1"
  default_home="/home/owner"
else
  host_name="mac"
  host_badge=""
  dash_ip="100.64.0.2"
  default_home="/Users/${USER:-$(id -un)}"
fi

# --- Parse stdin JSON ---
model=$(echo "$json" | jq -r '.model.display_name // ""')
effort=$(echo "$json" | jq -r '.effort.level // ""')
agent=$(echo "$json" | jq -r '.agent.name // ""')
cwd=$(echo "$json" | jq -r '.workspace.current_dir // .cwd // ""')
ctx=$(echo "$json" | jq -r '.context_window.used_percentage // ""')
ctx_size=$(echo "$json" | jq -r '.context_window.context_window_size // ""')
five_h=$(echo "$json" | jq -r '.rate_limits.five_hour.used_percentage // ""')
five_h_resets=$(echo "$json" | jq -r '.rate_limits.five_hour.resets_at // ""')
seven_d=$(echo "$json" | jq -r '.rate_limits.seven_day.used_percentage // ""')
seven_d_resets=$(echo "$json" | jq -r '.rate_limits.seven_day.resets_at // ""')
transcript=$(echo "$json" | jq -r '.transcript_path // ""')

# ---------------------------------------------------------------------------
# Account label resolution (see header note 1). Cheapest signal first; each step
# only runs if the previous one came up empty, so the common case (fleet-launched
# son, or dcx/kcx with CLAUDE_ACCT_LABEL) costs zero subprocesses.
# ---------------------------------------------------------------------------
acct_label=""
auth_email=""
auth_method=""

# (1) env label - set by the dcx / kcx / kaic launchers.
if [[ -n "${CLAUDE_ACCT_LABEL:-}" ]]; then
  acct_label="$CLAUDE_ACCT_LABEL"
  auth_method="env-label"
fi

# (2) hash the live env token against the stored token files. This is GROUND
# TRUTH about what the session is actually spending, so it outranks the home
# marker below: fleet-ctl writes that marker once at launch, and it goes stale
# the moment the session is restarted onto another account (or the file is left
# behind by a previous tenant of the home). A marker saying "personal" while the
# injected token is the work token is precisely the lie this script exists to
# kill. Both stores are checked: the fleet's canonical
# creds-store/oat-<label>.txt (server) and ~/.config/claude-accounts/<label>
# (the Mac's real files; on server these are symlinks into creds-store).
# NEVER prints or logs a token - md5 comparison only.
if [[ -z "$acct_label" && -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]]; then
  tok_md5=$(md5_str "$CLAUDE_CODE_OAUTH_TOKEN")
  if [[ -n "$tok_md5" ]]; then
    # (N) = null_glob: a missing store must not abort the render (the Mac has no
    # creds-store/, server's claude-accounts/ are symlinks into it).
    for f in "${HOME}"/.claude/creds-store/oat-*.txt(N) "${HOME}"/.config/claude-accounts/*(N); do
      [[ -r "$f" ]] || continue
      base=${f:t}
      [[ "$base" == "oat-active.txt" ]] && continue
      cand=${base%.txt}; cand=${cand#oat-}
      if [[ "$(md5_str "$(<"$f")")" == "$tok_md5" ]]; then
        acct_label="$cand"; auth_method="token-hash"; break
      fi
    done
    [[ -z "$acct_label" ]] && auth_method="token-unmatched"
  fi
fi

# (3) fleet-ctl's per-home marker. Reached only when there is no token, or the
# token matched nothing in either store. A token-injected session cannot
# self-report its account, so fleet-ctl writes what it launched on: useful for a
# token stored outside the stores, but never allowed to overrule step 2.
if [[ -z "$acct_label" && -r "${HOME}/.claude/kushbot-auth-account" ]]; then
  acct_label=$(<"${HOME}/.claude/kushbot-auth-account")
  acct_label="${acct_label%%[$'\n\r ']*}"
  [[ -n "$acct_label" ]] && auth_method="home-marker"
fi

# (4) keychain / .credentials.json grant: ask claude for the email. Cached PER HOME
# and PER AUTH METHOD (never one global file - that was the old cross-session lie).
# `claude auth status` costs ~200ms, so cache it 120s.
# Guard: only when NO env token is present. `claude auth status` describes the
# FILE/keychain grant, so under an unmatched injected OAT it would report the
# keychain email - a different account than the one the session is actually
# spending. That is the exact lie this rewrite exists to kill: an unidentified
# token renders `oat?`, never a borrowed identity.
if [[ -z "$acct_label" && -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]]; then
  home_tag=$(md5_str "$HOME"); home_tag=${home_tag[1,10]}
  auth_cache="/tmp/.claude_auth_cache_${home_tag}_file"
  if [[ -f "$auth_cache" ]] && (( $(date +%s) - $(mtime_of "$auth_cache") < 120 )); then
    auth_email=$(<"$auth_cache")
  else
    auth_email=$(claude auth status 2>/dev/null | jq -r '.email // ""')
    print -rn -- "$auth_email" > "$auth_cache" 2>/dev/null
    # Legacy mirror: src/session.ts readAuthEmail() still reads the global path.
    # Only the DEFAULT home writes it, so it is deterministically the parent's
    # email instead of "whichever home rendered last".
    [[ "$HOME" == "$default_home" ]] && print -rn -- "$auth_email" > /tmp/.claude_auth_cache 2>/dev/null
  fi
  if [[ -z "$acct_label" && -n "$auth_email" ]]; then
    case "$auth_email" in
      *@personal.example*) acct_label="personal" ;;
      *@work.example*)     acct_label="work" ;;
      *)               acct_label="$auth_email" ;;
    esac
    auth_method="auth-email"
  fi
fi

# (5) give up loudly rather than silently showing someone else's account.
# `oat?` = a token IS injected but matches no stored account (a stale grant, or one
# saved outside the stores). `?` = no signal at all.
if [[ -z "$acct_label" ]]; then
  if [[ "$auth_method" == "token-unmatched" ]]; then acct_label="oat?"
  else acct_label="?"; auth_method="${auth_method:-unknown}"; fi
fi

acct_color() {
  case "$1" in
    work)     printf '%s' "$YELLOW" ;;
    personal) printf '%s' "$GREEN" ;;
    gateway)  printf '%s' "$DIM" ;;
    '?'|'oat?') printf '%s' "$RED" ;;
    *)        printf '%s' "$CYAN" ;;
  esac
}

# --- Color for percentage ---
pct_color() {
  local val=$1
  if (( val >= 90 )); then echo "$RED"
  elif (( val >= 70 )); then echo "$YELLOW"
  else echo "$GREEN"
  fi
}

# Simplify model name: Opus/Sonnet/Haiku/Fable → one word, else full name
simplify_model() {
  local name=$1
  if [[ "$name" == *Opus* ]]; then
    echo "Opus"
  elif [[ "$name" == *Sonnet* ]]; then
    echo "Sonnet"
  elif [[ "$name" == *Haiku* ]]; then
    echo "Haiku"
  elif [[ "$name" == *Fable* ]]; then
    echo "Fable"
  else
    echo "$name"
  fi
}

# Abbreviate effort level: low/medium/high/xhigh/max → lo/md/hi/xh/max
short_effort() {
  case $1 in
    low) echo "lo" ;;
    medium) echo "md" ;;
    high) echo "hi" ;;
    xhigh) echo "xh" ;;
    max) echo "max" ;;
    *) echo "$1" ;;
  esac
}

# Effort style ladder - bolder/hotter as effort rises:
# lo dim → md plain → hi yellow → xh bold orange → max bold red
effort_style() {
  case $1 in
    low) echo "$DIM" ;;
    medium) echo "" ;;
    high) echo "$YELLOW" ;;
    xhigh) echo "${BOLD}${ORANGE}" ;;
    max) echo "${BOLD}${RED}" ;;
    *) echo "" ;;
  esac
}

sep=" ${DIM}|${RESET} "

# --- Single line ---
# Model → opens cwd in Finder / file manager
model_display=$(simplify_model "$model")
# Fable is new - highlight it in magenta so it stands out; other models stay plain bold.
if [[ "$model_display" == "Fable" ]]; then
  model_style="${BOLD}${MAGENTA}"
else
  model_style="${BOLD}"
fi
model_part="$(link "file://${cwd}" "${model_style}${model_display}${RESET}")"
# Effort suffix on the model, abbreviated (Fable:xh), styled by effort_style
if [[ -n "$effort" && "$effort" != "null" ]]; then
  model_part+="${DIM}:${RESET}$(effort_style "$effort")$(short_effort "$effort")${RESET}"
fi
parts=("$model_part")

# Account label, right after the model (server's position - it is identity, and
# now that it always resolves it belongs up front, not tucked at the end).
parts+=("${DIM}acct:${RESET}$(acct_color "$acct_label")${acct_label}${RESET}")

# --- Worktree indicator ---
# Show the worktree name when cwd is inside a linked git worktree.
# A linked worktree's git-dir lives under <repo>/.git/worktrees/<name> (e.g.
# Claude Code's .claude/worktrees/<name>), unlike the main checkout whose
# git-dir is just <repo>/.git - so a "/worktrees/" segment is the signal.
if [[ -n "$cwd" && "$cwd" != "null" ]]; then
  git_dir=$(git -C "$cwd" rev-parse --absolute-git-dir 2>/dev/null)
  if [[ "$git_dir" == *"/worktrees/"* ]]; then
    wt_name=$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null)
    wt_name=${wt_name:t}
    [[ -n "$wt_name" ]] && parts+=("${DIM}wt:${RESET}${CYAN}${wt_name}${RESET}")
  fi
fi

# ctx: → opens the transcript in this machine's dashboard session viewer.
# Tailscale IP (not localhost): the dashboard binds the TS IP only, so the link
# works when clicked from any Tailnet device, including this one.
if [[ -n "$ctx" && "$ctx" != "null" ]]; then
  c=$(pct_color "$ctx")
  ctx_label="$(link "http://${dash_ip}:3456/session?file=${transcript}" "ctx:")${RESET}"
  ctx_pct="$(printf '%.0f' "$ctx")%"
  if [[ -n "$ctx_size" && "$ctx_size" != "null" ]]; then
    if (( ctx_size >= 1000000 )); then
      ctx_fmt="${DIM}$(( ctx_size / 1000000 ))m${RESET}"
    else
      ctx_fmt="${DIM}$(( ctx_size / 1000 ))k${RESET}"
    fi
    ctx_pct+="/${ctx_fmt}"
  fi
  parts+=("${ctx_label} ${c}${ctx_pct}${RESET}")
fi

# 5h burst cap: used% / time-to-reset (rounded to 15-min buckets).
if [[ -n "$five_h" && "$five_h" != "null" ]]; then
  c=$(pct_color "$five_h")
  five_h_str="5h: ${c}$(printf '%.0f' "$five_h")%${RESET}"
  if [[ -n "$five_h_resets" && "$five_h_resets" != "null" ]]; then
    now=$(date +%s)
    secs_left=$(( five_h_resets - now ))
    (( secs_left < 0 )) && secs_left=0
    # round to nearest 15 minutes (900s)
    mins_left=$(( (secs_left + 450) / 900 * 15 ))
    hrs=$(( mins_left / 60 ))
    mins=$(( mins_left % 60 ))
    if (( hrs == 0 )); then
      time_left="${mins}m"
    elif (( mins == 0 )); then
      time_left="${hrs}h"
    else
      time_left="$(printf '%d:%02dh' $hrs $mins)"
    fi
    five_h_str+="${DIM}/${time_left}${RESET}"
  fi
  parts+=("$five_h_str")
fi

# 7d budget: used% / week-elapsed% + the reset moment as weekday+HH:MM IST.
# The weekly budget is the thing that actually expires unspent, so say WHEN.
if [[ -n "$seven_d" && "$seven_d" != "null" ]]; then
  c=$(pct_color "$seven_d")
  seven_d_int=$(printf '%.0f' "$seven_d")
  seven_d_label="$(link "https://claude.ai/settings/usage" "7d:")${RESET}"
  seven_d_str="${seven_d_label} ${c}${seven_d_int}%${RESET}"
  if [[ -n "$seven_d_resets" && "$seven_d_resets" != "null" ]]; then
    now=$(date +%s)
    wk_elapsed=$(( (now - (seven_d_resets - 604800)) * 100 / 604800 ))
    (( wk_elapsed < 0 )) && wk_elapsed=0
    (( wk_elapsed > 100 )) && wk_elapsed=100
    seven_d_str+="${DIM}/${wk_elapsed}%${RESET}"
    reset_ist=$(TZ=Asia/Kolkata at_epoch "${seven_d_resets%.*}" '%a %H:%M')
    [[ -n "$reset_ist" ]] && seven_d_str+=" ${DIM}${reset_ist}${RESET}"
  fi
  parts+=("$seven_d_str")
fi

[[ -n "$agent" ]] && parts+=("${agent}")

# --- Telegram-attached indicator ---
# `tg ✅`    - slot 0 attached (kc parent - the always-on bot)
# `tg ✅-N`  - slot N≥1 attached (a son spawned for ad-hoc reachability)
# Walks up our process tree, matches against ~/.claude/channels/kushbots/_status/<claude_pid>
# written by the kushbot plugin on attach. Silent when nothing is attached.
ancestor_pids=()
p=$$
while [[ -n "$p" && "$p" != "1" && "$p" != "0" ]]; do
  ancestor_pids+=("$p")
  p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')
done

tg_label=""
for ap in "${ancestor_pids[@]}"; do
  status_file="$HOME/.claude/channels/kushbots/_status/$ap"
  if [[ -f "$status_file" ]]; then
    slot_line=$(<"$status_file")
    slot_num="${slot_line#slot=}"
    slot_num="${slot_num%%[$'\n\r ']*}"
    if [[ "$slot_num" == "0" ]]; then
      tg_label="tg ${GREEN}✅${RESET}"
    else
      tg_label="tg ${GREEN}✅${RESET}-${slot_num}"
    fi
    break
  fi
done

[[ -n "$tg_label" ]] && parts+=("$tg_label")

# shared-seat marker: the personal-domain seat is shared with a household member, and the owner
# wants that called out by name (kept from the Mac script).
[[ "$auth_email" == *@personal.example* ]] && parts+=("${YELLOW}shared seat${RESET}")

# Host badge last (server only - see host identity above).
[[ -n "$host_badge" ]] && parts+=("${ORANGE}${host_badge}${RESET}")

line=""
first=1
for part in "${parts[@]}"; do
  [[ $first -eq 0 ]] && line+="$sep"
  line+="$part"
  first=0
done

printf '%s\n' "$line"

# ---------------------------------------------------------------------------
# Persist the per-session status cache. Written AFTER render so a hiccup here can
# never affect the statusline itself. This is the ONLY channel by which the
# kushbot MCP child (a separate process from claude) learns the model, ctx %,
# rate limits and which ACCOUNT the session is on. See header note 2.
# ---------------------------------------------------------------------------
session_id=$(echo "$json" | jq -r '.session_id // ""' 2>/dev/null)
if [[ -z "$session_id" || "$session_id" == "null" ]]; then
  if [[ -n "$transcript" && "$transcript" != "null" ]]; then
    session_id="${transcript:t:r}"          # basename minus .jsonl
  else
    session_id="tmux-${TMUX_PANE:-unknown}"
  fi
fi
if [[ -n "$session_id" ]]; then
  # Write via a temp + mv: a plain `> cache` truncates BEFORE jq runs, so any jq
  # failure would leave a 0-byte file that every reader then fails to parse
  # (exactly how server's caches died on jq 1.6, which reserves `label` as a
  # keyword - hence the quoted keys below). Atomic swap or nothing.
  _sl_tmp="/tmp/.claude_status_${session_id}.json.$$"
  jq -nc \
    --arg session_id "$session_id" --arg host "$host_name" \
    --arg model "$model" --arg effort "$effort" \
    --arg email "$auth_email" --arg agent "$agent" \
    --arg acct "$acct_label" --arg auth_method "$auth_method" \
    --argjson ctx "${ctx:-null}" --argjson ctx_size "${ctx_size:-null}" \
    --argjson five_h "${five_h:-null}" --argjson five_h_resets "${five_h_resets:-null}" \
    --argjson seven_d "${seven_d:-null}" --argjson seven_d_resets "${seven_d_resets:-null}" \
    --argjson ts "$(date +%s)" \
    '{"session_id":$session_id,"host":$host,"model":$model,"effort":$effort,"email":$email,
      "label":$acct,"auth_method":$auth_method,"agent":$agent,
      "ctx_pct":$ctx,"ctx_size":$ctx_size,
      "five_h_pct":$five_h,"five_h_resets":$five_h_resets,
      "seven_d_pct":$seven_d,"seven_d_resets":$seven_d_resets,"ts":$ts}' \
    > "$_sl_tmp" 2>/dev/null \
    && mv -f "$_sl_tmp" "/tmp/.claude_status_${session_id}.json" 2>/dev/null
  rm -f "$_sl_tmp" 2>/dev/null
fi
