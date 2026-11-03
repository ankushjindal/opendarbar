#!/usr/bin/env bash
# sync-kushbot.sh — deploy the kushbot server to every server home.
#
# WHY THIS EXISTS (2026-07-14): the server used to be ONE file, so deployment was
# `cp server.ts <home>/...` in a for-loop, and the drift check was one md5. After
# the split the deployed artifact is a SET:
#
#     server.ts + src/*.ts + package.json + bun.lock
#
# Copying server.ts alone onto a home that has no src/ produces a son that boots
# into `Cannot find module './src/config'` and goes deaf — with no error anywhere
# a human would look. Worse, a NEW server.ts over a STALE src/ boots fine and
# misbehaves subtly. So the set moves together, atomically per home, or not at all.
#
# Every boot runs `bun install --no-summary && bun server.ts`, which is why
# package.json and bun.lock are part of the artifact and not just build inputs:
# a home with a new package.json and a stale lock resolves dependencies at boot,
# and if the registry is unreachable at that moment the `&&` blocks the server
# entirely.
#
# Running bots load code at RESTART, not on write. This script only stages the
# code; `fleet-ctl reload <name>` is what makes a son actually run it.
#
# Usage:
#   ./sync-kushbot.sh                 # pull + deploy to every home
#   ./sync-kushbot.sh --dry-run       # show what would change, touch nothing
#   ./sync-kushbot.sh --no-pull       # deploy the working tree as-is
#   ./sync-kushbot.sh --only kai3     # ONE home — canary before the fleet
set -uo pipefail

B=/home/owner
REPO=$B/kai/KushDarbar
LOG=$B/kai/logs/sync-kushbot.log
mkdir -p "$(dirname "$LOG")"
log() { echo "$(date -u +%FT%TZ) $*" >> "$LOG"; }

DRY=0; PULL=1; ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --no-pull) PULL=0 ;;
    --only)    shift; ONLY="${1:-}" ;;   # canary: deploy to one home, probe, then the rest
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done

[ -d "$REPO" ] || { echo "no repo at $REPO"; exit 1; }

if [ $PULL -eq 1 ]; then
  git -C "$REPO" pull -q --ff-only origin main || { echo "git pull failed — refusing to deploy a divergent tree"; exit 1; }
fi
HEAD_SHA=$(git -C "$REPO" rev-parse --short HEAD)

# Refuse to deploy a tree that cannot even parse. A syntax error shipped to 11
# homes is 11 deaf bots.
if ! (cd "$REPO" && bun build server.ts --target=bun --outfile=/dev/null) >/dev/null 2>&1; then
  echo "❌ $REPO/server.ts does not build — refusing to deploy"
  log "REFUSED deploy of $HEAD_SHA: build failed"
  exit 1
fi

HAS_SRC=0
[ -d "$REPO/src" ] && [ -n "$(ls -A "$REPO/src" 2>/dev/null)" ] && HAS_SRC=1

homes=()
for h in "$B"/*-home "$B"; do
  d="$h/.claude/plugins/local/kushbot"
  [ -f "$d/server.ts" ] || continue
  if [ -n "$ONLY" ]; then
    # --only takes an AGENT name; resolve it to that agent's home via the registry
    # (kai1 lives in kai-son-home — name and dir are not the same string).
    ohome=$(jq -r --arg n "$ONLY" '.agents[] | select(.name==$n) | .home' "$B/.claude/channels/fleet/registry.json")
    [ "$h" = "$ohome" ] || continue
  fi
  homes+=("$d")
done
[ ${#homes[@]} -eq 0 ] && { echo "no homes matched${ONLY:+ (--only $ONLY)}"; exit 1; }

echo "repo @ $HEAD_SHA  ·  src/ $( [ $HAS_SRC -eq 1 ] && echo present || echo 'absent (pre-split)')  ·  ${#homes[@]} homes"
changed=0
for d in "${homes[@]}"; do
  name=$(basename "$(dirname "$(dirname "$(dirname "$(dirname "$d")")")")")
  if [ $DRY -eq 1 ]; then
    echo "  DRY $name"
    continue
  fi

  # src/ first, so a home is never left with a new server.ts and no modules.
  # --delete is scoped STRICTLY to src/ — never the plugin root, which also holds
  # node_modules/ and the bot's channels state.
  if [ $HAS_SRC -eq 1 ]; then
    mkdir -p "$d/src"
    rsync -a --delete "$REPO/src/" "$d/src/" || { echo "  ✗ $name: src rsync failed"; continue; }
  fi
  cp "$REPO/server.ts" "$REPO/package.json" "$REPO/bun.lock" "$d/" 2>/dev/null || { echo "  ✗ $name: copy failed"; continue; }

  # Skills are per-HOME. A son with its own $HOME does NOT see the parent's
  # ~/.claude/skills, so /darbar simply does not exist there — which is how kai4
  # came up without it (2026-07-14: "why dont we have darbar skill in kai4 now?").
  # Symlink rather than copy: the skill then tracks the repo with no second sync.
  home_root=$(dirname "$(dirname "$(dirname "$d")")")   # .../<home>/.claude
  mkdir -p "$home_root/skills"
  ln -sfn "$REPO/skills/darbar" "$home_root/skills/darbar" 2>/dev/null || true

  changed=$((changed+1))
  echo "  ✓ $name"
done

[ $DRY -eq 1 ] && { echo "(dry run — nothing written)"; exit 0; }

log "deployed $HEAD_SHA to $changed home(s)"
echo ""
echo "✅ staged $HEAD_SHA to $changed home(s)."
echo "   Code loads on RESTART: ~/kai/fleet-ctl reload <name>   (or --all --yes)"
echo "   Verify: darbar scan --domain git  ->  stale_copies empty, missing_src empty"
