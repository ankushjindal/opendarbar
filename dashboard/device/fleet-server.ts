// server FleetBackend — wraps ~/kai/fleet-ctl (status --json / start / stop /
// park / unpark / repair, kai's cockpit machinery) and adds the tmux ping probe
// so the shared /fleet page (lib/fleet.ts) serves both machines identically.
// No spawn on server v1: its agents are standing sons managed by fleet-ctl.

import { existsSync, readFileSync, readdirSync, readlinkSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { shell } from "../lib/shell";
import { DASHBOARDS } from "./dashboards";
import type { FleetBackend, FleetResult, FleetStatus } from "../lib/fleet";
import {
  labelFromCache, statusCache, sshPushToken,
  type AccountsBackend, type SessionRow,
} from "../lib/accounts";

const HOME = homedir();
const FLEET_CTL = join(HOME, "kai/fleet-ctl");
const REG = join(HOME, ".claude/channels/fleet/registry.json");
const NAME_RE = /^[a-z0-9-]{1,24}$/;

function tmuxNameFor(name: string): string {
  try {
    const reg = JSON.parse(readFileSync(REG, "utf8"));
    const a = (reg.agents ?? []).find((x: any) => x.name === name);
    if (a?.tmux) return a.tmux;
  } catch {}
  return name;
}

async function tmuxPing(name: string): Promise<FleetResult> {
  const tmuxs = tmuxNameFor(name);
  const has = await shell(["tmux", "has-session", "-t", tmuxs], 4000);
  if (has.exitCode !== 0) return { success: false, message: `✗ ${name}: no tmux session (${tmuxs})` };
  const paneR = await shell(["tmux", "capture-pane", "-t", tmuxs, "-p", "-S", "-5"], 5000);
  if ((paneR.stdout || "").includes("esc to interrupt"))
    return { success: false, message: `· ${name} is BUSY mid-turn — probe skipped` };
  const nonce = Math.random().toString(36).slice(2, 8);
  await shell(["tmux", "send-keys", "-t", tmuxs, `fleet-ping: reply with exactly PING-${nonce} and nothing else`], 5000);
  await new Promise((r) => setTimeout(r, 1000));
  await shell(["tmux", "send-keys", "-t", tmuxs, "Enter"], 5000);
  for (let waited = 0; waited < 45; ) {
    await new Promise((r) => setTimeout(r, 3000)); waited += 3;
    const cap = await shell(["tmux", "capture-pane", "-t", tmuxs, "-p", "-S", "-15"], 5000);
    const lines = (cap.stdout || "").split("\n").filter((l) => !l.includes("fleet-ping:"));
    if (lines.some((l) => l.includes(`PING-${nonce}`)))
      return { success: true, message: `✅ ${name} responded in ~${waited}s` };
  }
  return { success: false, message: `✗ ${name} did NOT respond in 45s — wedged or auth-dead (try restart)` };
}

export function serverFleetBackend(): FleetBackend {
  return {
    machine: "server",
    otherLinks: [{ label: "mac", url: DASHBOARDS["laptop"] }],

    async status(): Promise<FleetStatus> {
      const r = await shell([FLEET_CTL, "status", "--json"], 30000);
      if (r.exitCode !== 0) throw new Error(r.stderr || "fleet-ctl status failed");
      return JSON.parse(r.stdout.trim());
    },

    async action(action, name, opts): Promise<FleetResult> {
      // "restart" maps to fleet-ctl start (resume default = kill+resume semantics
      // handled inside fleet-ctl); keep kai's whitelist + add restart alias.
      const ALLOWED = new Set(["start", "restart", "stop", "park", "unpark", "repair"]);
      if (!ALLOWED.has(action)) return { success: false, message: `action '${action}' not allowed` };
      if (!NAME_RE.test(name) && action !== "repair") return { success: false, message: "bad agent name" };
      const real = action === "restart" ? "start" : action;
      const args = [FLEET_CTL, real];
      if (real !== "repair") args.push(name);
      if (real === "start" && opts?.fresh) args.push("--fresh");
      const r = await shell(args, 120000);
      const out = (r.stdout || r.stderr || "").trim();
      return { success: r.exitCode === 0, message: out || (r.exitCode === 0 ? "ok" : "failed") };
    },

    ping: tmuxPing,
    accounts: serverAccountsBackend(),
  };
}

// ── Accounts (lib/accounts.ts backend) ─────────────────────────────────────
//
// server shape: one HOME per son, tokens in ~/.claude/creds-store/oat-<label>.txt
// (what fleet-ctl injects at launch), with ~/.config/claude-accounts/<label>
// symlinked at them for the tools that look there. oat-active.txt is a real
// fleet-wide default: it is the token every fleet-ctl launch picks up, so this
// panel can repoint it.
//
// Session identity is easy here compared with the Mac: fleet-ctl status --json
// already reports each son's session id, and the statusline writes that
// session's account label into /tmp. The home marker is the backstop for a son
// whose statusline has not rendered since its last restart.

const CREDS = join(HOME, ".claude/creds-store");
const ACTIVE = join(CREDS, "oat-active.txt");
const SWITCH_SH = join(HOME, "kai/account-switch.sh");
const CLAUDE_BIN_B = join(HOME, ".local/bin/claude");
const NOTIFY_CHAT_B = process.env.OWNER_CHAT_ID ?? "";   // the owner, so a dashboard switch confirms on TG

function serverLabels(): string[] {
  try {
    return readdirSync(CREDS)
      .filter((f) => /^oat-.+\.txt$/.test(f) && f !== "oat-active.txt")
      .map((f) => f.slice(4, -4));
  } catch { return []; }
}
function homeOf(name: string): string | null {
  try {
    const reg = JSON.parse(readFileSync(REG, "utf8"));
    return (reg.agents ?? []).find((a: any) => a.name === name)?.home ?? null;
  } catch { return null; }
}

// `fleet-ctl status --json` is the expensive call on this page: it walks every
// son's tmux and transcript, and it took ~2s of the ~4.6s /fleet load. The page
// already made it once for the agent table, so take that result when the caller
// hands it over and only fetch when there is nothing to reuse (the JSON API
// route, which renders no agent table).
async function serverSessionRows(status?: FleetStatus): Promise<SessionRow[]> {
  let st: any = status;
  if (!st) {
    const r = await shell([FLEET_CTL, "status", "--json"], 30000);
    if (r.exitCode !== 0) throw new Error(r.stderr || "fleet-ctl status failed");
    st = JSON.parse(r.stdout.trim());
  }
  return (st.agents ?? []).map((a: any): SessionRow => {
    const c = a.session ? statusCache(a.session) : null;
    const f = labelFromCache(c);
    let label = f.label, source = f.source;
    if (!label) {
      const h = homeOf(a.name);
      if (h) {
        try {
          const m = readFileSync(join(h, ".claude/kushbot-auth-account"), "utf8").trim().split(/\s/)[0];
          if (m) { label = m; source = "home marker (launch)"; }
        } catch {}
      }
    }
    return {
      agent: a.name, sessionId: a.session || "", up: !!a.up,
      label, labelSource: source, email: c?.email || null, model: a.model || c?.model || "",
      ageMin: f.ageMin,
      switchable: !!a.up && !a.parked,
      note: a.parked ? "parked" : a.up ? "" : "down",
    };
  });
}

export function serverAccountsBackend(): AccountsBackend {
  return {
    machine: "server",
    storeNote: "Tokens in ~/.claude/creds-store/oat-<label>.txt; oat-active.txt is the default every fleet-ctl launch injects.",
    labels: serverLabels,
    tokenPath: (l) => join(CREDS, `oat-${l}.txt`),
    defaultLabel(): string | null {
      try { return (readlinkSync(ACTIVE).match(/oat-(.+)\.txt$/) ?? [])[1] ?? null; } catch { return null; }
    },
    async setDefault(label): Promise<FleetResult> {
      if (!serverLabels().includes(label)) return { success: false, message: "unknown label" };
      const r = await shell(["ln", "-sfn", join(CREDS, `oat-${label}.txt`), ACTIVE], 6000);
      return r.exitCode === 0
        ? { success: true, message: `oat-active now points at ${label}. Running sessions keep their own token until they restart.` }
        : { success: false, message: (r.stderr || "ln failed").trim() };
    },
    sessions: serverSessionRows,
    setupCwd: HOME,
    claudeBin: CLAUDE_BIN_B,
    peer: {
      name: "mac",
      push: (label, token) => sshPushToken("mac", `$HOME/.config/claude-accounts/${label}`, token),
    },
    async switchTo(agent, label): Promise<FleetResult> {
      if (!existsSync(SWITCH_SH)) return { success: false, message: "~/kai/account-switch.sh missing" };
      const r = await shell([SWITCH_SH, agent, join(CREDS, `oat-${label}.txt`), label, NOTIFY_CHAT_B], 30000);
      const out = (r.stdout || r.stderr || "").trim();
      return { success: r.exitCode === 0, message: out || (r.exitCode === 0 ? "scheduled" : "switch failed") };
    },
  };
}
