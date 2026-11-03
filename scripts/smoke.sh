#!/usr/bin/env bash
# smoke.sh — boot the MCP server in a throwaway sandbox and prove it handshakes.
#
# WHY: `bun build` only parses, and `tsc --noEmit` only typechecks. Neither
# EXECUTES the import graph — so neither catches TDZ / import-order / top-level
# side-effect bugs, the exact class a file split introduces. This does: it runs
# the real entry point and requires a real `initialize` response.
#
# ISOLATION: KUSHBOT_STATE + KUSHBOT_ROOT are pointed at a temp dir, so the boot
# sees an empty pool — no slot is claimed, no live bot is touched, no claim file
# of the running kc/kush1/son sessions is written. Safe to run while the fleet
# is up.
#
# Usage: ./scripts/smoke.sh          (from the repo root)
# Exit:  0 = handshake OK, 1 = boot failed
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/kushbot-smoke.XXXXXX")"
trap 'rm -rf "$SANDBOX"' EXIT

INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'
LIST='{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'

OUT="$(printf '%s\n%s\n' "$INIT" "$LIST" \
  | KUSHBOT_STATE="$SANDBOX/kushbot.json" \
    KUSHBOT_ROOT="$SANDBOX/kushbots" \
    timeout 15 bun server.ts 2>"$SANDBOX/stderr.log")"

# 1. MCP handshake came back and the server named itself
if ! grep -q '"serverInfo"' <<<"$OUT" || ! grep -q 'kushbot' <<<"$OUT"; then
  echo "SMOKE FAIL: no initialize response"
  echo "--- stdout ---"; head -c 600 <<<"$OUT"
  echo "--- stderr ---"; head -20 "$SANDBOX/stderr.log"
  exit 1
fi

# 2. The tool surface actually registered (catches a wiring block that silently
#    never ran — the failure mode where boot "succeeds" but the server is inert).
for tool in attach reply pool_status send_to_agent; do
  grep -q "\"$tool\"" <<<"$OUT" || { echo "SMOKE FAIL: tool '$tool' missing from tools/list"; exit 1; }
done

# 3. No import-time explosions (module-not-found, TDZ, undefined identifier).
if grep -qiE 'cannot find module|is not defined|before initialization|SyntaxError' "$SANDBOX/stderr.log"; then
  echo "SMOKE FAIL: import-time error"
  grep -iE 'cannot find module|is not defined|before initialization|SyntaxError' "$SANDBOX/stderr.log" | head -5
  exit 1
fi

TOOLS=$(grep -o '"name":"[a-z_]*"' <<<"$OUT" | wc -l | tr -d ' ')
echo "SMOKE OK: handshake + ${TOOLS} tools registered, clean import graph"
