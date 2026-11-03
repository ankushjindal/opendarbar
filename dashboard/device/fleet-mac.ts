// Mac FleetBackend — shells out to fleet/macctl (standing agents + kc) and
// spawns pool sessions with an engine picker:
//   claude — kushbot spawn path (tmux kush-slotN, dev-channels, auto-attach)
//   codex  — codex-bridge son via codex-son (tmux codex-slotN)
//   dcg    — claude harness + GPT/Grok brain via local CLIProxyAPI (gateway env
//            injected AT SPAWN inside the tmux shell; key never in argv/logs)
//
// Security posture: dashboard binds the Tailscale IP only; action/agent names
// are whitelist-validated; nothing user-typed is interpolated into a shell.

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { shell } from "../lib/shell";
import { DASHBOARDS } from "./dashboards";
import type { FleetBackend, FleetResult, FleetSpawnOpts, FleetStatus } from "../lib/fleet";
import {
  labelsInDir, labelFromCache, statusCache, sshPushToken,
  type AccountsBackend, type SessionRow,
} from "../lib/accounts";

const HOME = homedir();
const MACCTL = join(HOME, ".claude/plugins/local/kushbot/fleet/macctl");
const CODEX_SON = join(HOME, ".claude/plugins/local/kushbot/codex-bridge/codex-son");
const DCG_KEY_FILE = join(HOME, ".cli-proxy-api/client-key.txt");
const CLAUDE_BIN = join(HOME, ".local/bin/claude");

const NAME_RE = /^[a-z0-9-]{1,24}$/;
const SLOTS = [1, 2, 3];

function slotFree(n: number): boolean {
  const f = join(HOME, `.claude/channels/kushbots/slot${n}/claimed_by.pid`);
  if (!existsSync(f)) return true;
  try {
    const pid = parseInt(readFileSync(f, "utf8").trim(), 10);
    if (!Number.isFinite(pid)) return true;
    process.kill(pid, 0);
    return false; // claim alive
  } catch { return true; } // dead pid = stale claim = usable
}

async function tmuxHas(name: string): Promise<boolean> {
  const r = await shell(["tmux", "has-session", "-t", name], 4000);
  return r.exitCode === 0;
}

// Boot-prompt dismissal for dashboard-spawned tmux sessions (trust folder +
// dev-channels confirm). Fire-and-forget taps at 3/6/9/12s — same trick as
// kushbot's spawn and macctl's start loop.
function tapEnterLater(tmuxName: string): void {
  for (const delay of [3000, 6000, 9000, 12000]) {
    setTimeout(() => { void shell(["tmux", "send-keys", "-t", tmuxName, "Enter"], 3000); }, delay);
  }
}

export function macFleetBackend(): FleetBackend {
  return {
    machine: "mac",
    otherLinks: [{ label: "server", url: DASHBOARDS["server"] }],
    spawnEngines: ["claude", "codex", "dcg"],
    spawnDirs: [
      { label: "monorepo", dir: join(HOME, "work/monorepo") },
      { label: "~ (home)", dir: HOME },
      { label: "KushDarbar", dir: join(HOME, ".claude/plugins/local/kushbot") },
    ],
    spawnSlots: SLOTS,
    accounts: macAccountsBackend(),

    async status(): Promise<FleetStatus> {
      const r = await shell([MACCTL, "status", "--json"], 30000);
      if (r.exitCode !== 0) throw new Error(r.stderr || "macctl status failed");
      return JSON.parse(r.stdout.trim());
    },

    async action(action, name, opts): Promise<FleetResult> {
      const ALLOWED = new Set(["start", "restart", "stop", "park", "unpark"]);
      if (!ALLOWED.has(action)) return { success: false, message: `action '${action}' not allowed` };
      if (!NAME_RE.test(name)) return { success: false, message: "bad agent name" };
      const args = [MACCTL, action, name];
      if (action === "start" && opts?.fresh) args.push("--fresh");
      const r = await shell(args, 120000);
      const out = (r.stdout || r.stderr || "").trim();
      return { success: r.exitCode === 0, message: out || (r.exitCode === 0 ? "ok" : "failed") };
    },

    async ping(name): Promise<FleetResult> {
      if (!NAME_RE.test(name)) return { success: false, message: "bad agent name" };
      const r = await shell([MACCTL, "ping", name], 60000);
      const out = (r.stdout || r.stderr || "").trim();
      return { success: r.exitCode === 0, message: out || "no output" };
    },

    async spawn(o: FleetSpawnOpts): Promise<FleetResult> {
      const dirs = new Set(this.spawnDirs!.map((d) => d.dir));
      if (!dirs.has(o.dir)) return { success: false, message: "dir not in allowlist" };
      const slot = o.slot ?? SLOTS.find(slotFree);
      if (!slot || !SLOTS.includes(slot)) return { success: false, message: "no free slot (1-3)" };
      if (!slotFree(slot)) return { success: false, message: `slot ${slot} is claimed — pick another` };

      if (o.engine === "codex") {
        const tmuxName = `codex-slot${slot}`;
        if (await tmuxHas(tmuxName)) return { success: false, message: `${tmuxName} already exists` };
        const args = [CODEX_SON, "start", "--slot", String(slot), "--cwd", o.dir];
        if (o.model) args.push("--model", o.model);
        const r = await shell(args, 60000);
        const out = (r.stdout || r.stderr || "").trim().split("\n")[0];
        return { success: r.exitCode === 0, message: r.exitCode === 0 ? `codex son on slot ${slot} (${tmuxName}) — ${out}` : out };
      }

      // claude + dcg share the tmux-claude spawn; dcg adds the gateway env.
      const tmuxName = `kush-slot${slot}`;
      if (await tmuxHas(tmuxName)) return { success: false, message: `${tmuxName} already exists` };
      let envPrefix = `KUSHBOT_AUTO_ATTACH=${slot}`;
      let modelFlag = "";
      if (o.engine === "dcg") {
        if (!existsSync(DCG_KEY_FILE)) return { success: false, message: "dcg: no gateway client key (gateway/install.sh)" };
        // key is read INSIDE the tmux shell at spawn — never in argv or this process
        envPrefix += ` ANTHROPIC_BASE_URL=http://127.0.0.1:8317 ANTHROPIC_AUTH_TOKEN="$(cat ${DCG_KEY_FILE})" CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`;
        modelFlag = ` --model ${o.model ?? "gpt-5.6-sol"}`;
      } else if (o.model) {
        modelFlag = ` --model ${o.model}`;
      }
      const cmd = `${envPrefix} ${CLAUDE_BIN} --dangerously-load-development-channels server:kushbot --dangerously-skip-permissions${modelFlag}`;
      const r = await shell(["tmux", "new-session", "-d", "-s", tmuxName, "-c", o.dir, cmd], 15000);
      if (r.exitCode !== 0) return { success: false, message: (r.stderr || "tmux spawn failed").trim() };
      tapEnterLater(tmuxName);
      return { success: true, message: `${o.engine} session spawning on slot ${slot} (tmux ${tmuxName}) — bot goes live in ~20s` };
    },
  };
}

// ── Accounts (lib/accounts.ts backend) ─────────────────────────────────────
//
// Mac shape: one shared ~/.claude, tokens in ~/.config/claude-accounts/<label>
// (what dcx/kcx already launch on), no fleet-wide default symlink. Because the
// HOME is shared, an agent's session id cannot be found by "newest transcript
// in $HOME" - it comes off the live claude process's own argv, and the account
// it is really on comes off that process's own environment. Both are read from
// a single `ps -E` dump, so the panel costs two subprocesses no matter how many
// agents there are.

const ACCT_DIR = join(HOME, ".config/claude-accounts");
const MAC_SWITCH = join(HOME, ".claude/plugins/local/kushbot/fleet/mac-account-switch.sh");
const REG = join(HOME, ".claude/channels/fleet/registry.json");
const NOTIFY_CHAT = process.env.OWNER_CHAT_ID ?? "";   // the owner, so a dashboard switch confirms on TG

async function macSessionRows(): Promise<SessionRow[]> {
  let agents: any[] = [];
  try {
    agents = (JSON.parse(readFileSync(REG, "utf8")).agents ?? [])
      .filter((a: any) => a.machine === "laptop" && a.spawn);
  } catch (e: any) { throw new Error(`registry unreadable: ${e.message}`); }

  const panes = await shell(["tmux", "list-panes", "-a", "-F", "#{session_name} #{pane_pid}"], 6000);
  const panePid = new Map<string, string>();
  for (const line of (panes.stdout || "").split("\n")) {
    const [s, p] = line.trim().split(/\s+/);
    if (s && p && !panePid.has(s)) panePid.set(s, p);
  }
  // -E appends the environment after the argv, so one dump gives us both the
  // resume id and CLAUDE_ACCT_LABEL. Never printed: only matched against.
  const ps = await shell(["ps", "-E", "-o", "pid=,ppid=,command="], 10000);
  const byParent = new Map<string, { pid: string; cmd: string }[]>();
  const psCmd = new Map<string, string>();
  for (const line of (ps.stdout || "").split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    psCmd.set(m[1], m[3]);
    const list = byParent.get(m[2]) ?? [];
    list.push({ pid: m[1], cmd: m[3] });
    byParent.set(m[2], list);
  }

  return agents.map((a: any): SessionRow => {
    // Registry `tmux` drifts (slot5 still says codex-slot5 long after fleet-up
    // started launching a Claude son as `kush5`), so try the pool's naming
    // conventions too, the way macctl's status --json already does.
    const n = /^slot(\d+)$/.exec(a.name)?.[1];
    const cands = [a.tmux, a.name, ...(n ? [`kush${n}`, `kush-slot${n}`, `codex-slot${n}`] : [])].filter(Boolean);
    const tmuxName = cands.find((c: string) => panePid.has(c)) ?? (a.tmux || a.name);
    const pp = panePid.get(tmuxName);
    // The pane pid ITSELF first: a son launched through a shell has claude as a
    // child, one relaunched by mac-account-switch.sh has tmux exec claude as the
    // pane process. And match the BINARY, not the substring: the kushbot MCP
    // child's argv carries the plugin path under ~/.claude and would otherwise
    // win, giving a row with an inherited env label and no session id.
    const isClaude = (cmd: string) => /(?:^|\/)claude(?:\s|$)/.test(cmd);
    const procs = pp ? [{ pid: pp, cmd: psCmd.get(pp) ?? "" }, ...(byParent.get(pp) ?? [])] : [];
    const proc = procs.find((c) => isClaude(c.cmd));
    const codex = /^codex-/.test(tmuxName);
    const up = !!pp && (!!proc || codex);
    const sid = proc?.cmd.match(/(?:-r|--resume)\s+([0-9a-f-]{36})/)?.[1] ?? "";
    const envLabel = proc?.cmd.match(/\bCLAUDE_ACCT_LABEL=([A-Za-z0-9._-]+)/)?.[1] ?? null;
    const c = sid ? statusCache(sid) : null;
    const fromCache = labelFromCache(c);
    // The launch env is the ground truth for a token session; the status cache
    // is the only thing that knows a keychain session's identity.
    const label = envLabel ?? fromCache.label;
    const source = envLabel ? "process env" : fromCache.source;
    const note = !up ? (a.parked ? "parked" : "down") : codex ? "codex engine" : "";
    return {
      agent: a.name, sessionId: sid, up,
      label, labelSource: source,
      email: c?.email || null, model: c?.model || "",
      ageMin: fromCache.ageMin,
      switchable: up && !codex,
      note,
    };
  });
}

export function macAccountsBackend(): AccountsBackend {
  return {
    machine: "mac",
    storeNote: `Tokens in ~/.config/claude-accounts/<label> (the store dcx/kcx launch from).`,
    labels: () => labelsInDir(ACCT_DIR),
    tokenPath: (l) => join(ACCT_DIR, l),
    defaultLabel: () => null,          // no fleet-wide default on the Mac
    sessions: macSessionRows,
    setupCwd: HOME,
    claudeBin: CLAUDE_BIN,
    peer: {
      name: "server",
      push: (label, token) => sshPushToken("server", `$HOME/.claude/creds-store/oat-${label}.txt`, token),
    },
    async switchTo(agent, label, force): Promise<FleetResult> {
      if (!existsSync(MAC_SWITCH)) return { success: false, message: "mac-account-switch.sh missing" };
      const args = force ? [MAC_SWITCH, "--force", agent, label, NOTIFY_CHAT] : [MAC_SWITCH, agent, label, NOTIFY_CHAT];
      const r = await shell(args, 30000);
      const out = (r.stdout || r.stderr || "").trim();
      // exit 3 = the pane is mid-turn. Not a failure, a question: the UI asks
      // whether to kill the turn and comes back with force.
      if (r.exitCode === 3) return { success: false, busy: true, message: out || `${agent} is mid-turn` };
      return { success: r.exitCode === 0, message: out || (r.exitCode === 0 ? "scheduled" : "switch failed") };
    },
  };
}
