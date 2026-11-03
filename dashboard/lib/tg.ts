// Device-agnostic Telegram session-control contract + shared unix helpers.
//
// Two device topologies implement TgProvider:
//   - Mac     → a *pool* of pre-created bots (kushbot, slots 0..N). device/kushbot-provider.ts
//   - server  → *one bot per session* (telegram plugin). device/kai-son-provider.ts (later)
// The dashboard UI is provider-agnostic: it renders bindings[] and reads capabilities().

import { existsSync } from "fs";
import { shell } from "./shell";

// Resolve binaries to absolute paths so we don't depend on the dashboard's PATH
// (launchd/systemd give a minimal PATH; tmux lives in /usr/local/bin, lsof in
// /usr/sbin — neither guaranteed on PATH). Falls back to the bare name for PATH lookup.
function resolveBin(name: string, candidates: string[]): string {
  for (const c of candidates) {
    try { if (existsSync(c)) return c; } catch { /* keep looking */ }
  }
  return name;
}
const PS = resolveBin("ps", ["/bin/ps", "/usr/bin/ps"]);
const LSOF = resolveBin("lsof", ["/usr/sbin/lsof", "/usr/bin/lsof"]);
export const TMUX = resolveBin("tmux", ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"]);

// ── contract ──

export interface TgSpawnTarget {
  label: string;
  path: string; // absolute; the spawn allowlist
}

export interface TgBindingSession {
  claudePid?: number;
  cwd?: string;
  tmuxSession?: string | null;
  sessionId?: string; // the CC session uuid (jsonl) — captured at spawn for exact /sessions matching
}

export interface TgBinding {
  id: string; // provider-defined, e.g. "slot2"
  label: string; // human, e.g. "slot 2"
  botUsername: string; // "example_laptop_son2_bot" (no @)
  deepLink: string; // "https://t.me/example_laptop_son2_bot?start=dash"
  state: "free" | "claimed" | "reserved" | "stale";
  reserved?: boolean; // slot0/kc — never offer destructive ops
  session?: TgBindingSession; // present iff claimed/reserved-live
}

export interface TgUnboundSession {
  claudePid: number;
  cwd: string;
  tty: string;
}

export interface TgPoolStatus {
  bindings: TgBinding[];
  unbound: TgUnboundSession[]; // live claude sessions not on any bot (for attach)
  tmuxAvailable: boolean;
}

export interface TgCapabilities {
  canSpawn: boolean;
  detachMode: "kill-session" | "true-detach";
  canAttachExisting: boolean;
  spawnTargets: TgSpawnTarget[];
}

export interface TgSpawnResult {
  bindingId: string;
  botUsername: string;
  deepLink: string;
  tmuxSession: string;
  dir: string;
  message: string;
}

export interface TgActionResult {
  success: boolean;
  message: string;
}

export interface TgMatch {
  binding: TgBinding;
  confidence: "exact" | "cwd-guess";
}

export interface TgProvider {
  poolStatus(): Promise<TgPoolStatus>;
  spawn(o: { dir: string; bindingId?: string }): Promise<TgSpawnResult>;
  detach(o: { bindingId: string }): Promise<TgActionResult>;        // off Telegram, keep session alive
  kill?(o: { bindingId: string }): Promise<TgActionResult>;          // close the session entirely
  attach?(o: { claudePid?: number; sessionFile?: string; bindingId?: string }): Promise<TgActionResult>;
  capabilities(): TgCapabilities;
  matchSession(m: { cwd: string; sessionId: string; filePath: string }): Promise<TgMatch | null>;
}

// ── shared unix helpers (async, non-blocking — Bun.serve event loop) ──

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Liveness via signal-0. Cheap syscall, safe to call synchronously. */
export function isPidAlive(pid: number): boolean {
  if (!pid || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Walk a pid's ancestor chain to the first process whose comm contains "claude".
 * Mirrors kushbot's resolveSession (server.ts:100) but async so we don't block
 * the dashboard's request loop. Returns null if no claude ancestor within 10 hops.
 */
export async function resolveClaude(
  mcpPid: number
): Promise<{ claudePid: number; cwd: string; tty: string } | null> {
  let p = mcpPid;
  for (let i = 0; i < 10; i++) {
    const { stdout: ppidOut, exitCode } = await shell([PS, "-o", "ppid=", "-p", String(p)]);
    if (exitCode !== 0) break;
    const ppid = parseInt(ppidOut.trim(), 10);
    if (!ppid || ppid <= 1) break;
    const { stdout: commOut } = await shell([PS, "-o", "comm=", "-p", String(ppid)]);
    const base = commOut.trim().split("/").pop() || "";
    if (/claude/i.test(base)) {
      const cwd = await cwdOfPid(ppid);
      const { stdout: ttyOut } = await shell([PS, "-o", "tty=", "-p", String(ppid)]);
      return { claudePid: ppid, cwd, tty: ttyOut.trim() || "?" };
    }
    p = ppid;
  }
  return null;
}

/** Working directory of a pid via `lsof -Fn` (the only reliable way on macOS). */
export async function cwdOfPid(pid: number): Promise<string> {
  const { stdout, exitCode } = await shell([LSOF, "-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
  if (exitCode !== 0) return "?";
  for (const ln of stdout.split("\n")) {
    if (ln.startsWith("n")) return ln.slice(1).trim();
  }
  return "?";
}

/** Current tmux sessions; available=false when no tmux server is running. */
export async function tmuxSessions(): Promise<{ available: boolean; names: Set<string> }> {
  const { stdout, exitCode } = await shell([TMUX, "list-sessions", "-F", "#{session_name}"]);
  if (exitCode !== 0) return { available: false, names: new Set() };
  return {
    available: true,
    names: new Set(stdout.split("\n").map((s) => s.trim()).filter(Boolean)),
  };
}

/**
 * Enumerate live interactive `claude` processes, excluding a set of already-bound
 * claude pids. Used to offer "attach an existing session" (Tier 2). Each lookup
 * does one lsof, so callers should cache.
 */
export async function listClaudeSessions(exclude: Set<number>): Promise<TgUnboundSession[]> {
  const { stdout, exitCode } = await shell([PS, "-axo", "pid=,comm="]);
  if (exitCode !== 0) return [];
  const out: TgUnboundSession[] = [];
  for (const ln of stdout.split("\n")) {
    const m = ln.trim().match(/^(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = parseInt(m[1], 10);
    const base = (m[2].split("/").pop() || "").trim();
    // exactly "claude" — avoids matching "claude-..." helper/MCP child processes
    if (base !== "claude") continue;
    if (exclude.has(pid)) continue;
    const { stdout: ttyOut } = await shell([PS, "-o", "tty=", "-p", String(pid)]);
    const tty = ttyOut.trim();
    if (!tty || tty === "??") continue; // skip non-interactive (background/agent) procs
    const cwd = await cwdOfPid(pid);
    out.push({ claudePid: pid, cwd, tty });
  }
  return out;
}
