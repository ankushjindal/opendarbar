# batt — attach to a server agent session by LOGICAL name, regardless of engine.
#
#   batt              → list all agents; codex ones are marked "(codex)". Pick one;
#                       for a codex session it then asks: [l]og stream or [w]ork
#                       interactively. (You usually don't know the engine from
#                       outside — the list tells you, then you choose.)
#   batt munshi       → attach directly (Claude son = interactive TUI; codex son =
#                       the bridge's live log stream)
#   batt kai2         → resolves to codex-kai2 or kai2-son automatically
#   batt 2            → attach by list position (same numbering `batt` prints;
#                       kai1=1, kai2=2, … — `kai` sits last so the digits line up)
#   batt -w kai2      → shortcut: straight into interactive codex WORK mode on
#                       kai2's thread (pauses its Telegram bridge, auto-restarts on
#                       exit). No-op-ish for a Claude son (already interactive).
#
# Codex WORK mode = an interactive codex TUI on the son's own thread. A codex
# thread can't serve the TUI and its Telegram bridge at once, so WORK pauses the
# bridge and restarts it on exit (server-side ~/kai/codexwork.sh).
#
# Canonical copy lives in KushDarbar (fleet/batt.zsh); ~/.zshrc sources it.
batt() {
  local work=0
  [[ "$1" == "-w" || "$1" == "--work" ]] && { work=1; shift; }

  local live
  live=("${(@f)$(ssh server 'tmux ls -F "#{session_name}" 2>/dev/null')}")
  # Resolve a LOGICAL agent name to its live tmux session, whatever engine backs
  # it: Claude son = <name>-son, Codex son = codex-<name>, standing bots = bare.
  _batt_resolve() {
    local n="${1%-son}" c
    for c in "$1" "codex-$n" "${n}-son" "$n"; do
      [[ " ${live[*]} " == *" $c "* ]] && { print -r -- "$c"; return 0; }
    done
    return 1
  }
  # Attach one resolved session, honoring work-mode + engine.
  _batt_go() {   # $1 = resolved tmux session name, $2 = 1 if work-mode requested
    local target="$1" w="$2" base="${1#codex-}"
    if [[ "$target" == codex-* ]]; then
      if [[ "$w" -eq 1 ]]; then
        TERM=xterm-256color ssh -t server "~/kai/codexwork.sh $base"
      else
        TERM=xterm-256color ssh -t server "tmux attach -t $target"
      fi
    else
      [[ "$w" -eq 1 ]] && echo "'$target' is a Claude son — already interactive."
      TERM=xterm-256color ssh -t server "tmux attach -t $target"
    fi
  }

  # Build the ordered agent list ONCE — the interactive menu and the `batt N`
  # numeric shortcut share it, so the numbers you see are the numbers you type.
  # `kai` (the parent) sits LAST on purpose: that keeps kai1..kai4 on positions
  # 1..4, so `batt 2` == kai2. Down agents keep their slot so numbering is stable.
  local sel s t
  local -a want=(kai1 kai2 kai3 kai4 daroga guru munshi pulse raju rishi vaidya kai)
  local -a labels=() names=() downs=()
  for s in "${want[@]}"; do
    if t="$(_batt_resolve "$s")"; then
      [[ "$t" == codex-* ]] && labels+=("$s (codex)") || labels+=("$s")
      names+=("$t"); downs+=(0)
    else
      labels+=("$s (down)"); names+=("$s"); downs+=(1)
    fi
  done
  for s in "${(@o)live}"; do
    [[ " ${names[*]} " == *" $s "* ]] || { labels+=("$s"); names+=("$s"); downs+=(0); }
  done

  if [[ -n "$1" ]]; then
    # numeric arg → attach by list position (1-indexed, matches the menu)
    if [[ "$1" == <-> ]]; then
      local i="$1"
      (( i >= 1 && i <= ${#names} )) || { echo "no agent #$i (1-${#names})"; return 1; }
      [[ "${downs[$i]}" -eq 1 ]] && { echo "${names[$i]} is not running on server."; return 1; }
      [[ "${labels[$i]}" == "${names[$i]}" ]] || echo "→ ${names[$i]}"
      _batt_go "${names[$i]}" "$work"; return
    fi
    local target
    if ! target="$(_batt_resolve "$1")"; then
      echo "no server tmux session for '$1' (live: ${live[*]})"; return 1
    fi
    [[ "$target" != "$1" ]] && echo "→ $target"
    _batt_go "$target" "$work"
    return
  fi

  # --- list mode ---
  echo "server agents:"
  PS3="attach which? (number) "
  select sel in "${labels[@]}"; do
    [[ -z "$sel" ]] && continue
    local name="${names[$REPLY]}"
    if [[ "$sel" == *"(down)" ]]; then
      echo "$name is not running on server."; break
    fi
    if [[ "$name" == codex-* ]]; then
      local mode
      echo -n "  $name is CODEX — [l]og stream or [w]ork interactively? (l/w) "
      read -r mode
      [[ "$mode" == w* ]] && { _batt_go "$name" 1; break; }
      _batt_go "$name" 0; break
    fi
    _batt_go "$name" 0; break
  done
}
