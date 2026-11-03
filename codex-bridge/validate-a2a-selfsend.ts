#!/usr/bin/env bun
/**
 * validate-a2a-selfsend.ts — the integration test that would have caught the P0.
 *
 * THE BUG (2026-07-10): a codex slot runs TWO kushbot server processes — the
 * inbound child (real poller, notifications reach the bridge) and codex's NO_POLL
 * child (outbound-only). `checkFleetInbox` ran unconditionally in BOTH, so the
 * NO_POLL child raced for A2A envelopes; when it won it injected into codex's MCP
 * client (which drops channel notifications), wrote the receipt, deleted the
 * envelope — "delivered" while the message reached no one. The unit validators
 * never ran the two-process topology, so the race was invisible by construction.
 *
 * THIS TEST runs the REAL topology: it drops an A2A envelope into a live codex
 * slot's fleet inbox and asserts the BRIDGE consumed it (a turn was driven),
 * never silently receipted-and-dropped.
 *
 * REQUIRES A LIVE CODEX BRIDGE. Run AFTER `codex-son start` (or the server
 * ~/kai/codex-kai4.sh) is up:
 *
 *   bun validate-a2a-selfsend.ts --slot 3 --self kush3 --fleet ~/.claude/channels/fleet
 *
 * It does NOT stub anything — that's the point. A pass here means the gate
 * (server.ts: `if (NO_POLL) return` in checkFleetInbox) is holding in production.
 */
import { readdirSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

function arg(name: string, def?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (def !== undefined) return def;
  throw new Error(`missing --${name}`);
}

const slot = arg("slot", "3");
const self = arg("self", "kush3");                    // the codex agent's registry name
const fleetRoot = arg("fleet", join(process.env.HOME!, ".claude", "channels", "fleet"));
const tmuxSession = arg("tmux", `codex-slot${slot}`); // where the bridge logs
const TIMEOUT_MS = 20_000;

const id = `selftest-${Date.now()}`;
const inbox = join(fleetRoot, self, "inbox");
const receiptDir = join(fleetRoot, "a2a-selftest", "receipts");
mkdirSync(inbox, { recursive: true });

const envelope = {
  id, from: "a2a-selftest", to: self, hops: 1, reply_expected: false,
  priority: "normal", ts: new Date(0).toISOString(),   // fixed ts (no Date.now in body)
  body: `[a2a self-test ${id}] If you see this as a turn, the NO_POLL gate is holding.`,
};

console.log(`→ dropping envelope ${id} into ${inbox}`);
writeFileSync(join(inbox, `${id}.json`), JSON.stringify(envelope), { mode: 0o600 });

// Poll the bridge's tmux pane for the "inbound A2A from=" line the bridge logs
// (bridge.ts) when it — not the NO_POLL child — consumed the envelope.
const deadline = Date.now() + TIMEOUT_MS;
let sawBridgeConsume = false;
while (Date.now() < deadline) {
  try {
    const pane = execSync(`tmux capture-pane -t ${tmuxSession} -p -S -400`, { encoding: "utf8" });
    if (pane.includes(`inbound A2A from=a2a-selftest`) || pane.includes(id)) { sawBridgeConsume = true; break; }
  } catch { /* tmux not found — bridge not running */ }
  execSync("sleep 1");
}

// If the envelope is GONE from the inbox but the bridge never logged consuming it,
// the NO_POLL child ate it (the P0). If the bridge logged it, the gate held.
const stillQueued = existsSync(join(inbox, `${id}.json`)) || existsSync(join(inbox, `${id}.json.processing`));

console.log(`\nRESULT:`);
console.log(`  bridge consumed (logged): ${sawBridgeConsume ? "YES ✓" : "NO"}`);
console.log(`  envelope still in inbox : ${stillQueued ? "yes" : "no"}`);

if (sawBridgeConsume) {
  console.log(`\n✅ PASS — the inbound child (bridge) consumed the A2A envelope; NO_POLL gate is holding.`);
  process.exit(0);
} else if (!stillQueued) {
  console.log(`\n❌ FAIL — envelope was consumed but the bridge never logged it: the NO_POLL child ate it (the P0 regressed). Check server.ts checkFleetInbox NO_POLL gate.`);
  process.exit(1);
} else {
  console.log(`\n⚠️  INCONCLUSIVE — envelope still queued after ${TIMEOUT_MS}ms. Is the bridge running (tmux ${tmuxSession})? Is ${self} the right registry name?`);
  process.exit(2);
}
