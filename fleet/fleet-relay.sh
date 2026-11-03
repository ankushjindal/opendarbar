#!/usr/bin/env bash
# fleet-relay.sh — cross-machine A2A transport (KushDarbar, 2026-07-06).
#
# A2A v1 is file-inbox based and same-machine. This relay carries envelopes
# BETWEEN machines over tailscale so `send_to_agent` works fleet-wide:
#
#   send side  : server.ts fleetSend() spools a cross-machine envelope to
#                fleet/_outbound/<peer-machine>/<id>.json
#   this relay : for each peer, scp every spooled envelope to that peer's
#                fleet/<to>/inbox/<id>.json over tailscale, then archive locally
#   recv side  : the peer's existing 5s poller (checkFleetInbox) delivers it —
#                no receiver-side code change needed
#   receipts   : on delivery the receiver writes fleet/<from>/receipts/<id>.json
#                locally; this relay pulls receipts for OUR agents back from the
#                peer so /outbox can flip relaying → delivered
#
# Connection details per peer live in the registry under `peers`:
#   "peers": { "laptop": { "ssh": "user@100.x.y.z", "fleetRoot": "/Users/.../fleet" } }
#
# Idempotent + safe: uses scp with a temp name + atomic rename on the far side,
# archives sent envelopes locally (never deletes blindly), and no-ops cleanly if
# the peer is unreachable (envelopes stay spooled, retried next tick).
#
# Runs from a systemd user timer (~30s). Usage: fleet-relay.sh [--once] [--dry-run]
set -uo pipefail

# Machine-agnostic home. The fleet lives under the LOGIN user's home
# (/home/owner on server, /Users/owner on the Mac). The systemd
# unit / launchd plist sets FLEET_HOME explicitly so this works on both and
# never mis-resolves when invoked from a son's HOME-override session.
B="${FLEET_HOME:-$HOME}"
FLEETROOT="$B/.claude/channels/fleet"
REG="$FLEETROOT/registry.json"
LOG="$FLEETROOT/logs/fleet-relay.log"
SELF_MACHINE="$(jq -r '.selfMachine // "server"' "$REG" 2>/dev/null || echo server)"
DRY=""; [ "${1:-}" = "--dry-run" ] && DRY=1
mkdir -p "$(dirname "$LOG")"
log() { echo "$(date -u +%FT%TZ) $*" >> "$LOG"; }

SSH_OPTS="-o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new"

# peers = every machine in the registry that isn't us
peers=$(jq -r --arg self "$SELF_MACHINE" '.peers // {} | keys[]' "$REG" 2>/dev/null)
[ -z "$peers" ] && { log "no peers configured; nothing to relay"; exit 0; }

for peer in $peers; do
  SSH=$(jq -r --arg p "$peer" '.peers[$p].ssh // empty' "$REG")
  RROOT=$(jq -r --arg p "$peer" '.peers[$p].fleetRoot // empty' "$REG")
  [ -z "$SSH" ] || [ -z "$RROOT" ] && { log "peer $peer missing ssh/fleetRoot in registry; skip"; continue; }

  # reachability probe — if the peer is down, leave envelopes spooled (retried
  # next tick). Skipped under --dry-run so you can inspect the push plan offline.
  if [ -z "$DRY" ] && ! ssh $SSH_OPTS "$SSH" true 2>/dev/null; then
    log "peer $peer ($SSH) unreachable; leaving spool intact"
    continue
  fi

  # ---- PUSH: our outbound envelopes -> peer inboxes -------------------------
  spool="$FLEETROOT/_outbound/$peer"
  if [ -d "$spool" ]; then
    for env in "$spool"/*.json; do
      [ -e "$env" ] || continue
      id=$(basename "$env" .json)
      to=$(jq -r '.to' "$env" 2>/dev/null); [ -z "$to" ] || [ "$to" = null ] && { log "bad envelope $env; skip"; continue; }
      if [ -n "$DRY" ]; then echo "DRY push $id -> $peer:$to"; continue; fi
      # atomic far-side write: scp to a temp name, then ssh-rename into place
      if ssh $SSH_OPTS "$SSH" "mkdir -p '$RROOT/$to/inbox'" 2>>"$LOG" \
         && scp $SSH_OPTS -q "$env" "$SSH:$RROOT/$to/inbox/.$id.tmp" 2>>"$LOG" \
         && ssh $SSH_OPTS "$SSH" "mv '$RROOT/$to/inbox/.$id.tmp' '$RROOT/$to/inbox/$id.json'" 2>>"$LOG"; then
        mkdir -p "$spool/.sent"; mv "$env" "$spool/.sent/$id.json"
        log "pushed $id -> $peer:$to"
      else
        log "push failed for $id -> $peer:$to (left spooled, retry next tick)"
      fi
    done
  fi

  # ---- PULL: receipts for OUR agents written on the peer --------------------
  # The peer, on delivering an envelope FROM one of our agents, wrote a receipt
  # into its fleet/<our-agent>/receipts/. Pull those back so /outbox updates.
  # Our agents = registry agents whose machine == SELF_MACHINE.
  for agent in $(jq -r --arg self "$SELF_MACHINE" '.agents[] | select(.machine==$self) | .name' "$REG"); do
    [ -n "$DRY" ] && { echo "DRY pull receipts $peer:$agent"; continue; }
    mkdir -p "$FLEETROOT/$agent/receipts"
    rsync -az --ignore-existing -e "ssh $SSH_OPTS" \
      "$SSH:$RROOT/$agent/receipts/" "$FLEETROOT/$agent/receipts/" 2>>"$LOG" \
      && : # best-effort; missing dir on peer is fine
  done
done
log "relay cycle done"
