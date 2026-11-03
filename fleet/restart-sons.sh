#!/usr/bin/env bash
# Restart server son bots by killing their tmux session + relaunching with the
# original spawn command. Use this after `~/kai/sync-kushbot.sh` deploys a new
# server.ts — Claude 2.1.x /reload-plugins does NOT restart MCP bun children
# for dev-loaded channels (kushbot is `--dangerously-load-development-channels
# server:kushbot`, not a real installed plugin), so a full claude restart is
# the only way to pick up new kushbot code.
#
# WARNING: This wipes each son's in-session memory. If anyone (a teammate, a family member,
# the owner) is mid-conversation with vaidya/raju/guru/kai{1,2,3}-son/munshi/rishi,
# that thread is reset.
#
# Does NOT touch the parent kai session (slot 0, this kai you're talking to).
# To restart parent kai, owner has to do it himself from his own terminal.
#
# Usage: ~/kai/restart-sons.sh [son-name|all]
#   son-name = vaidya | kai1-son | kai2-son | kai3-son | kai4-son | raju | guru | pulse | munshi | rishi | daroga
#   all (default) = all 11 sons
#
# Naming: kai1-son / kai2-son / kai3-son / kai4-son are four identical mirrors
# of parent kai — same persona (--agent kai-son loads the shared `kai-son` agent
# file in each son's HOME), independent sessions/lives. Renamed from
# kai-son/kai2/kai3 on 2026-06-24 for semantic clarity. kai4-son added
# 2026-06-29 via BotFather (@kai_son_4_bot).

set -euo pipefail

TARGET="${1:-all}"

declare -A SPAWN=(
  [vaidya]="HOME=/home/owner/vaidya-home /home/owner/.local/bin/claude --dangerously-load-development-channels server:kushbot --dangerously-skip-permissions -r always-on-vaidya --remote-control --agent vaidya --add-dir /home/owner/health"
  [kai1-son]="HOME=/home/owner/kai-son-home /home/owner/.local/bin/claude --dangerously-load-development-channels server:kushbot --dangerously-skip-permissions --agent kai-son"
  [raju]="HOME=/home/owner/raju-home /home/owner/.local/bin/claude --dangerously-load-development-channels server:kushbot --dangerously-skip-permissions --agent raju --add-dir /home/owner/teammate1-monorepo"
  [kai2-son]="HOME=/home/owner/kai2-home /home/owner/.local/bin/claude --dangerously-load-development-channels server:kushbot --dangerously-skip-permissions --agent kai-son"
  [kai3-son]="HOME=/home/owner/kai3-home /home/owner/.local/bin/claude --dangerously-load-development-channels server:kushbot --dangerously-skip-permissions --agent kai-son"
  [kai4-son]="HOME=/home/owner/kai4-home /home/owner/.local/bin/claude --dangerously-load-development-channels server:kushbot --dangerously-skip-permissions --agent kai-son --add-dir /home/owner/monorepo"
  [guru]="HOME=/home/owner/guru-home /home/owner/.local/bin/claude --dangerously-load-development-channels server:kushbot --dangerously-skip-permissions --agent guru --add-dir /home/owner/monorepo"
  [pulse]="HOME=/home/owner/pulse-home /home/owner/.local/bin/claude --dangerously-load-development-channels server:kushbot --dangerously-skip-permissions --agent pulse --add-dir /home/owner/pulse-home --add-dir /home/owner/monorepo"
  [daroga]="HOME=/home/owner/daroga-home /home/owner/.local/bin/claude --dangerously-load-development-channels server:kushbot --dangerously-skip-permissions --agent daroga --add-dir /home/owner/monorepo"
  [munshi]="HOME=/home/owner/munshi-home /home/owner/.local/bin/claude --dangerously-load-development-channels server:kushbot --dangerously-skip-permissions --agent munshi --add-dir /home/owner/monorepo"
  [rishi]="HOME=/home/owner/rishi-home /home/owner/.local/bin/claude --dangerously-load-development-channels server:kushbot --dangerously-skip-permissions --agent rishi --add-dir /home/owner/teammate2-monorepo"
)
declare -A CWD=(
  [vaidya]="/home/owner/vaidya-home"
  [kai1-son]="/home/owner"
  [raju]="/home/owner/teammate1-monorepo"
  [kai2-son]="/home/owner"
  [kai3-son]="/home/owner"
  [kai4-son]="/home/owner/monorepo"
  [guru]="/home/owner/guru-home"
  [pulse]="/home/owner/pulse-home"
  [daroga]="/home/owner/monorepo"
  [munshi]="/home/owner/munshi-home"
  [rishi]="/home/owner/teammate2-monorepo"
)

restart_one() {
  local name="$1"
  local cmd="${SPAWN[$name]:-}"
  local cwd="${CWD[$name]:-}"
  if [[ -z "$cmd" ]]; then
    echo "  ? $name — no spawn command mapped, skipping"
    return
  fi

  # ── Capture current session ID BEFORE killing so we can pin -r <id> on relaunch ──
  # 2026-06-15: discovered the hard way that Claude without `-r` doesn't
  # auto-resume the previously-active session — kai-son got swapped from
  # paywall-watch (fd8d00e4...) to partner (c0268695...) after yesterday's
  # restart. Now we capture-then-pin.
  #
  # Two sources, in order:
  #   1. Active claude proc's args: if it has `-r <id>` or `-r <name>`, reuse that
  #   2. Fallback: most-recently-modified .jsonl in this son's projects/ dir
  local session=""
  # Active proc — only useful if it has -r in args
  session=$(ps -ef | grep -E "claude.*--agent $name" | grep -v grep | grep -oE " -r [a-zA-Z0-9_-]+" | awk '{print $2}' | head -1 || true)
  if [[ -z "$session" ]]; then
    # Fallback: newest jsonl in this son's projects subtree. find won't follow into
    # subdirs deeper than 3 to avoid huge scans; .jsonl files live directly under
    # projects/<workspace-slug>/.
    local home_dir="${cwd}"
    case "$name" in
      vaidya) home_dir="/home/owner/vaidya-home" ;;
      kai1-son) home_dir="/home/owner/kai-son-home" ;;
      raju) home_dir="/home/owner/raju-home" ;;
      kai2-son) home_dir="/home/owner/kai2-home" ;;
      kai3-son) home_dir="/home/owner/kai3-home" ;;
      kai4-son) home_dir="/home/owner/kai4-home" ;;
      guru) home_dir="/home/owner/guru-home" ;;
      pulse) home_dir="/home/owner/pulse-home" ;;
      daroga) home_dir="/home/owner/daroga-home" ;;
      munshi) home_dir="/home/owner/munshi-home" ;;
      rishi) home_dir="/home/owner/rishi-home" ;;
    esac
    local newest
    newest=$(find "$home_dir/.claude/projects" -maxdepth 3 -name "*.jsonl" -type f -printf "%T@ %p\n" 2>/dev/null | sort -nr | head -1 | awk '{print $2}' || true)
    if [[ -n "$newest" ]]; then
      session=$(basename "$newest" .jsonl)
    fi
  fi

  echo "  > $name — killing + relaunching (session=${session:-FRESH})"
  tmux kill-session -t "$name" 2>/dev/null || true
  sleep 1

  # Inject -r <session> into the spawn command IF the command doesn't already have one
  # AND we found a session ID. This preserves the previously-active session across restart.
  local relaunch="$cmd"
  if [[ -n "$session" && "$cmd" != *" -r "* ]]; then
    # Splice -r <session> right after `--dangerously-skip-permissions`
    relaunch="${cmd/--dangerously-skip-permissions/--dangerously-skip-permissions -r $session}"
  fi

  tmux new-session -d -s "$name" -c "$cwd" "$relaunch"
  # Fresh claude launch shows TWO confirm prompts in sequence, both default
  # to the safe option:
  #   1) "Do you trust this folder?" — Enter selects "Yes, trust".
  #   2) "Channels: server:kushbot — I am using this for local development?"
  #      — Enter selects "I am using this for local development".
  # When -r <session> is also passed, claude additionally MIGHT show a
  # "resume from summary vs full" picker (rare; only if the prior session
  # is large). We do NOT send a "2 Enter" by default anymore — that mis-sent
  # to the dev-channel prompt = "Exit" = claude dies. Bug observed
  # 2026-06-24 on pulse/munshi/kai2-son restarts. If a son needs the
  # summary-vs-full picker, do it manually post-restart.
  sleep 6
  tmux send-keys -t "$name" Enter      # trust folder
  sleep 5
  tmux send-keys -t "$name" Enter      # dev-channels
  sleep 4
}

if [[ "$TARGET" == "all" ]]; then
  echo "[$(date -u +%H:%M:%SZ)] Restarting all 11 sons (vaidya, kai1-son, raju, kai2-son, kai3-son, kai4-son, guru, pulse, daroga, munshi, rishi)"
  for s in vaidya kai1-son raju kai2-son kai3-son kai4-son guru pulse daroga munshi rishi; do
    restart_one "$s"
  done
else
  restart_one "$TARGET"
fi

sleep 5
echo ""
echo "[$(date -u +%H:%M:%SZ)] Bun procs after restart:"
ps -ef | grep -E "bun run.*kushbot" | grep -v grep | awk '{print "  " $2 " " $9 " " $10}'
echo ""
echo "Done. If a bot's bun is missing, run \`tmux capture-pane -p -t <name>\` and"
echo "look for a stalled onboarding prompt (login, theme, trust dialog)."
