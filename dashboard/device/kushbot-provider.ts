// Mac TgProvider — backed by the local kushbot bot-pool plugin.
//
// State lives in ~/.claude/channels/kushbots/ (read-only from here):
//   slot{N}/.env            → TELEGRAM_BOT_TOKEN
//   slot{N}/claimed_by.pid  → the MCP server pid holding the slot (absent/dead = free)
//   _status/<claudePid>     → "slot=N" (leaks on crash — never trusted for liveness)
//   _requests/<claudePid>.json / .ack.json → Tier-2 attach/detach channel
//
// We can READ pool state, SPAWN sessions (replicating kushbot's exact tmux+dc cmd),
// and — only with the Tier-2 request-watcher deployed in the fork — attach/detach a
// *running* session. Without it, detach = kill the tmux session (slot frees on death).

import { join, dirname } from "path";
import { homedir } from "os";
import { readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync, statSync } from "fs";
import { randomBytes } from "crypto";
import { shell } from "../lib/shell";
import {
  isPidAlive,
  resolveClaude,
  tmuxSessions,
  listClaudeSessions,
  sleep,
  TMUX,
  type TgProvider,
  type TgBinding,
  type TgPoolStatus,
  type TgSpawnTarget,
  type TgCapabilities,
  type TgSpawnResult,
  type TgActionResult,
  type TgMatch,
  type TgUnboundSession,
} from "../lib/tg";

export interface KushbotProviderOpts {
  channelsRoot: string; // ~/.claude/channels/kushbots
  spawnDirs: TgSpawnTarget[]; // allowlist for the New-session form
  handleMap: Record<number, string>; // slot → bot @handle (no @)
  tier2?: boolean; // request-watcher deployed in the kushbot fork?
  cacheTtlMs?: number; // pool-status cache (default 7s; lsof is dear)
  ledgerPath?: string; // spawn provenance (slot → session uuid); default ~/.claude/dashboard/tg-spawns.json
}

// Spawn ledger: maps a slot to the session it spawned, so /sessions can badge the
// EXACT row even when several sons share a cwd (cwd-join can't disambiguate them).
interface SpawnRec { tmux: string; dir: string; spawnedAt: number; sessionId?: string }

export function kushbotProvider(opts: KushbotProviderOpts): TgProvider {
  const ROOT = opts.channelsRoot;
  const TTL = opts.cacheTtlMs ?? 7000;
  const requestsDir = join(ROOT, "_requests");
  const LEDGER = opts.ledgerPath ?? join(homedir(), ".claude/dashboard/tg-spawns.json");

  const slotDir = (n: number) => join(ROOT, `slot${n}`);
  const pidFile = (n: number) => join(slotDir(n), "claimed_by.pid");
  const envFile = (n: number) => join(slotDir(n), ".env");
  const handle = (n: number) => opts.handleMap[n] || `slot${n}`;
  const deepLink = (n: number) => `https://t.me/${handle(n)}?start=dash`;

  function listSlots(): number[] {
    try {
      return readdirSync(ROOT)
        .map((s) => /^slot(\d+)$/.exec(s))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => parseInt(m[1], 10))
        .sort((a, b) => a - b);
    } catch {
      return [];
    }
  }
  function slotMcpPid(n: number): number | null {
    try {
      const p = parseInt(readFileSync(pidFile(n), "utf8"), 10);
      return Number.isFinite(p) ? p : null;
    } catch {
      return null;
    }
  }
  function slotClaimed(n: number): boolean {
    const p = slotMcpPid(n);
    return !!(p && isPidAlive(p));
  }
  function slotHasToken(n: number): boolean {
    try {
      return /TELEGRAM_BOT_TOKEN=\S/.test(readFileSync(envFile(n), "utf8"));
    } catch {
      return false;
    }
  }

  // ── spawn ledger (slot id → the session it spawned) ──
  function readLedger(): Record<string, SpawnRec> {
    try { return JSON.parse(readFileSync(LEDGER, "utf8")); } catch { return {}; }
  }
  function writeLedger(l: Record<string, SpawnRec>): void {
    try { mkdirSync(dirname(LEDGER), { recursive: true, mode: 0o700 }); writeFileSync(LEDGER, JSON.stringify(l, null, 2)); } catch {}
  }
  // ~/.claude/projects/<encoded-cwd> (claude replaces "/" with "-")
  function projectDir(cwd: string): string {
    return join(homedir(), ".claude/projects", cwd.replace(/\//g, "-"));
  }
  // newest non-agent .jsonl in the cwd's project dir born at/after `since` ms — the spawned son
  function newestSessionSince(cwd: string, since: number): string | null {
    let best: { sid: string; birth: number } | null = null;
    try {
      const dir = projectDir(cwd);
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".jsonl") || f.startsWith("agent-")) continue;
        const birth = statSync(join(dir, f)).birthtimeMs;
        if (birth >= since - 2000 && (!best || birth > best.birth)) best = { sid: f.replace(/\.jsonl$/, ""), birth };
      }
    } catch {}
    return best?.sid ?? null;
  }

  // ── pool status (cached; lsof is 50-200ms) ──
  let cache: { ts: number; data: TgPoolStatus } | null = null;
  const invalidate = () => { cache = null; };

  async function poolStatus(): Promise<TgPoolStatus> {
    if (cache && Date.now() - cache.ts < TTL) return cache.data;
    const tmux = await tmuxSessions();
    const bindings: TgBinding[] = [];
    const boundClaudePids = new Set<number>();
    const ledger = readLedger();
    let ledgerDirty = false;

    for (const n of listSlots()) {
      const reserved = n === 0;
      const live = slotClaimed(n);
      const base = {
        id: `slot${n}`,
        label: reserved ? `slot ${n} · kc` : `slot ${n}`,
        botUsername: handle(n),
        deepLink: deepLink(n),
        reserved: reserved || undefined,
      };
      if (live) {
        const resolved = await resolveClaude(slotMcpPid(n)!);
        if (resolved) boundClaudePids.add(resolved.claudePid);
        const tmuxName = `kush-slot${n}`;
        bindings.push({
          ...base,
          state: reserved ? "reserved" : "claimed",
          session: {
            claudePid: resolved?.claudePid,
            cwd: resolved?.cwd ?? "?",
            tmuxSession: tmux.names.has(tmuxName) ? tmuxName : null,
            sessionId: ledger[`slot${n}`]?.sessionId,
          },
        });
      } else {
        // slot0 should always be live (kc); if it isn't, still mark reserved so the
        // UI never offers it as a spawn target.
        bindings.push({ ...base, state: reserved ? "reserved" : "free" });
        // free slot → drop any stale ledger entry
        if (ledger[`slot${n}`]) { delete ledger[`slot${n}`]; ledgerDirty = true; }
      }
    }
    if (ledgerDirty) writeLedger(ledger);

    // Live claude sessions not on any bot — only enumerated when attach is possible.
    let unbound: TgUnboundSession[] = [];
    if (opts.tier2) {
      try {
        unbound = await listClaudeSessions(boundClaudePids);
      } catch {
        unbound = [];
      }
    }

    const data: TgPoolStatus = { bindings, unbound, tmuxAvailable: tmux.available };
    cache = { ts: Date.now(), data };
    return data;
  }

  // ── spawn ──
  async function spawn({ dir, bindingId }: { dir: string; bindingId?: string }): Promise<TgSpawnResult> {
    const allowed = opts.spawnDirs.find((t) => t.path === dir);
    if (!allowed) throw new Error(`directory not in allowlist: ${dir}`);

    let target: number;
    if (bindingId) {
      const m = /^slot(\d+)$/.exec(bindingId);
      if (!m) throw new Error(`bad bindingId: ${bindingId}`);
      target = parseInt(m[1], 10);
      if (target === 0) throw new Error("slot 0 is reserved for kc — pick 1+");
      if (!listSlots().includes(target)) throw new Error(`slot${target} is not configured`);
    } else {
      const free = listSlots().find((n) => n !== 0 && !slotClaimed(n));
      if (free == null) throw new Error("no free slot ≥1 — detach one first");
      target = free;
    }

    // TOCTOU: re-check right before spawning.
    if (slotClaimed(target)) throw new Error(`slot${target} just got claimed — pick another`);
    if (!slotHasToken(target)) throw new Error(`slot${target}/.env has no TELEGRAM_BOT_TOKEN`);

    const sessionName = `kush-slot${target}`;
    await shell([TMUX, "kill-session", "-t", sessionName]); // best-effort zombie cleanup
    // Invoke claude directly, NOT the `dc` alias: `exec dc` resolves to /usr/bin/dc
    // (the RPN calculator) because zsh doesn't alias-expand after `exec`. This is the
    // expansion of the `dc` alias + the kush persona, minus the cosmetic stderr filter.
    const claudeCmd =
      "claude --dangerously-load-development-channels server:kushbot --dangerously-skip-permissions --agent kush";
    const innerCmd = `cd ${JSON.stringify(dir)}; export KUSHBOT_AUTO_ATTACH=${target}; exec ${claudeCmd}`;
    const res = await shell(
      [TMUX, "new-session", "-d", "-s", sessionName, "-c", dir, "/bin/zsh", "-i", "-c", innerCmd],
      15000
    );
    if (res.exitCode !== 0) throw new Error(`tmux new-session failed: ${res.stderr.trim() || "unknown"}`);
    const spawnedAt = Date.now();
    const ledger = readLedger();
    ledger[`slot${target}`] = { tmux: sessionName, dir, spawnedAt };
    writeLedger(ledger);
    invalidate();
    // Fire-and-forget: confirm startup dialogs, then capture the session uuid. Returns immediately.
    void postSpawn(sessionName, target, dir, spawnedAt);
    return {
      bindingId: `slot${target}`,
      botUsername: handle(target),
      deepLink: deepLink(target),
      tmuxSession: sessionName,
      dir,
      message: `Spawned in ${dir} → slot${target} (@${handle(target)}). Give it ~10s to connect, then tap to chat.`,
    };
  }

  // Press Enter past claude's startup dialogs (dev-channels warning, dir-trust) until
  // the slot attaches, THEN capture the spawned session's uuid into the ledger so
  // /sessions can badge the exact row. Matches dialog-specific text only (never submits
  // an empty message). ~120s window covers a cold start.
  async function postSpawn(sessionName: string, slot: number, dir: string, spawnedAt: number): Promise<void> {
    for (let i = 0; i < 60; i++) {
      await sleep(2000);
      if (slotClaimed(slot)) {
        const sid = newestSessionSince(dir, spawnedAt);
        if (sid) {
          const l = readLedger();
          if (l[`slot${slot}`]) { l[`slot${slot}`].sessionId = sid; writeLedger(l); invalidate(); }
        }
        return;
      }
      const { stdout } = await shell([TMUX, "capture-pane", "-t", sessionName, "-p"]);
      if (/local development|Enter to confirm|Do you trust|trust this (folder|directory)/i.test(stdout)) {
        await shell([TMUX, "send-keys", "-t", sessionName, "Enter"]);
      }
    }
  }

  // ── detach ──
  async function detach({ bindingId }: { bindingId: string }): Promise<TgActionResult> {
    const m = /^slot(\d+)$/.exec(bindingId);
    if (!m) return { success: false, message: `bad bindingId: ${bindingId}` };
    const n = parseInt(m[1], 10);
    if (n === 0) return { success: false, message: "slot 0 (kc) is protected" };

    if (opts.tier2) {
      const mcp = slotMcpPid(n);
      if (!mcp || !isPidAlive(mcp)) {
        invalidate();
        return { success: true, message: `slot${n} is already free` };
      }
      const resolved = await resolveClaude(mcp);
      if (!resolved) return { success: false, message: `couldn't resolve the session on slot${n}` };
      const r = await writeRequestAndAwait(resolved.claudePid, { action: "detach" });
      invalidate();
      return r;
    }

    // Tier 1: kill the tmux session; kushbot's SIGHUP handler frees the slot.
    const res = await shell(["tmux", "kill-session", "-t", `kush-slot${n}`]);
    invalidate();
    return res.exitCode === 0
      ? { success: true, message: `Killed kush-slot${n} — slot frees in a few seconds.` }
      : { success: true, message: `No live tmux session kush-slot${n}; slot will free on its own.` };
  }

  // ── kill: close the session entirely (unlike detach, which keeps it running headless) ──
  async function kill({ bindingId }: { bindingId: string }): Promise<TgActionResult> {
    const m = /^slot(\d+)$/.exec(bindingId);
    if (!m) return { success: false, message: `bad bindingId: ${bindingId}` };
    const n = parseInt(m[1], 10);
    if (n === 0) return { success: false, message: "slot 0 (kc) is protected" };
    const tmuxName = `kush-slot${n}`;
    if (!(await tmuxSessions()).names.has(tmuxName)) {
      // Only close dashboard-spawned (tmux) sons. A manually-attached session is the
      // user's own — don't kill it from here.
      invalidate();
      return slotClaimed(n)
        ? { success: false, message: `slot${n} isn't a dashboard-spawned session (no tmux) — use detach, or close it in its own terminal.` }
        : { success: true, message: `slot${n} is already free.` };
    }
    // claude ignores SIGTERM/SIGHUP (built to survive disconnects), so: drop the tmux,
    // SIGTERM the MCP (cleanly releases the slot), then SIGKILL the claude process
    // (uncatchable), then SIGKILL the MCP if it lingers.
    const mcp = slotMcpPid(n);
    let claudePid: number | undefined;
    if (mcp && isPidAlive(mcp)) claudePid = (await resolveClaude(mcp))?.claudePid;
    await shell([TMUX, "kill-session", "-t", tmuxName]);
    if (mcp) { try { process.kill(mcp, "SIGTERM"); } catch {} }
    if (claudePid) { try { process.kill(claudePid, "SIGKILL"); } catch {} }
    await sleep(800);
    if (mcp && isPidAlive(mcp)) { try { process.kill(mcp, "SIGKILL"); } catch {} }
    const l = readLedger(); if (l[`slot${n}`]) { delete l[`slot${n}`]; writeLedger(l); }
    invalidate();
    return { success: true, message: `Closed slot${n} — session killed${claudePid ? ` (pid ${claudePid})` : ""}, slot freed.` };
  }

  // ── attach (Tier 2 only) ──
  async function attach({
    claudePid,
    bindingId,
  }: {
    claudePid?: number;
    sessionFile?: string;
    bindingId?: string;
  }): Promise<TgActionResult> {
    if (!opts.tier2) return { success: false, message: "attach needs the kushbot request-watcher (Tier 2)" };
    if (!claudePid) return { success: false, message: "attach needs a claudePid — pick a running session" };
    let slot: number | undefined;
    if (bindingId) {
      const m = /^slot(\d+)$/.exec(bindingId);
      if (m) slot = parseInt(m[1], 10);
      if (slot === 0) return { success: false, message: "slot 0 is reserved for kc" };
    }
    const r = await writeRequestAndAwait(claudePid, { action: "attach", slot });
    invalidate();
    return r;
  }

  // Tier-2 request/ack protocol. The kushbot watcher in the target session reads
  // _requests/<claudePid>.json, applies it, writes _requests/<claudePid>.ack.json.
  async function writeRequestAndAwait(
    claudePid: number,
    payload: { action: "attach" | "detach"; slot?: number }
  ): Promise<TgActionResult> {
    mkdirSync(requestsDir, { recursive: true, mode: 0o700 });
    const nonce = randomBytes(6).toString("hex");
    const reqPath = join(requestsDir, `${claudePid}.json`);
    const ackPath = join(requestsDir, `${claudePid}.ack.json`);
    try { rmSync(ackPath, { force: true }); } catch {}
    writeFileSync(reqPath, JSON.stringify({ ...payload, nonce, ts: Date.now() }));

    for (let i = 0; i < 25; i++) {
      await sleep(200);
      try {
        const ack = JSON.parse(readFileSync(ackPath, "utf8"));
        if (ack.nonce !== nonce) continue;
        try { rmSync(ackPath, { force: true }); } catch {}
        if (ack.ok) {
          return {
            success: true,
            message:
              payload.action === "attach"
                ? `Attached to slot${ack.slot} (@${ack.username}).`
                : "Detached from Telegram — session still running headless.",
          };
        }
        return { success: false, message: ack.error || "the session rejected the request" };
      } catch {
        /* ack not written yet */
      }
    }
    return { success: false, message: "request sent but no ack in 5s — is the session alive and the watcher deployed?" };
  }

  // ── best-effort session→binding match (cwd join; inherently a guess) ──
  async function matchSession({ cwd }: { cwd: string; sessionId: string; filePath: string }): Promise<TgMatch | null> {
    if (!cwd || cwd === "—" || cwd === "?") return null;
    const pool = await poolStatus();
    const hits = pool.bindings.filter(
      (b) => (b.state === "claimed" || b.state === "reserved") && b.session?.cwd === cwd
    );
    return hits.length === 1 ? { binding: hits[0], confidence: "cwd-guess" } : null;
  }

  function capabilities(): TgCapabilities {
    return {
      canSpawn: true,
      detachMode: opts.tier2 ? "true-detach" : "kill-session",
      canAttachExisting: !!opts.tier2,
      spawnTargets: opts.spawnDirs,
    };
  }

  return { poolStatus, spawn, detach, kill, attach, capabilities, matchSession };
}
