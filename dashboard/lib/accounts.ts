// Accounts panel - the control half of the quota work (2026-09-07).
//
// `quota` answers "how much is left". This answers "on whose budget, and can I
// move that". It renders as a section on /fleet on BOTH machines:
//
//   Accounts   one row per label (work / personal): masked token tail, email,
//              token health, 5h + weekly used, and which sessions are on it.
//   Sessions   one row per agent: the account it is actually running on right
//              now, and a Switch control that restarts it RESUMING the same
//              conversation on the other token.
//   Renew      drive `claude setup-token` in a tmux session, hand the OAuth URL
//              to the browser, take the code back, write the new token to the
//              local store and push it to the other machine.
//
// Two rules the whole file is built around:
//
//  1. A token is never printed, logged, returned in a response, or rendered.
//     The only part that ever leaves this module is the last 4 characters, and
//     every string that could have come from a terminal pane goes through
//     redact() before anyone sees it.
//  2. Quota numbers come from the SHARED probe cache
//     /tmp/.claude_acct_usage_<label>.json, the same file quota.sh,
//     claude-acct.sh and kushbot's probeAccountUsage() read and write. Page
//     loads read that cache and never probe; probing is a button, because each
//     probe is a real API call against the account it is measuring.

import { existsSync, readFileSync, readdirSync, writeFileSync, chmodSync } from "fs";
import { homedir } from "os";
import { shell } from "./shell";
import { esc } from "./html";
import type { FleetResult, FleetStatus } from "./fleet";

const HOME = homedir();

// ── types ──────────────────────────────────────────────────────────────────

// "capped" is not a broken token: it is a healthy account the API is currently
// refusing work on (HTTP 429, or a unified-ratelimit status other than allowed).
// It renders amber, never green, because green here means "go ahead and switch
// onto it" and that is exactly what a capped account cannot honour.
export type Health = "ok" | "capped" | "dead" | "error" | "untested";

export interface AccountRow {
  label: string;
  email: string | null;
  tokenTail: string;          // last 4 chars, the only part ever rendered
  present: boolean;           // a non-empty token file exists
  health: Health;
  healthNote: string;
  fivePct: number | null;
  fiveResetIst: string;
  weeklyPct: number | null;
  weeklyResetIst: string;
  probedAgoS: number | null;
  isDefault: boolean;
  sessions: string[];         // agent names currently on this label
}

export interface SessionRow {
  agent: string;
  sessionId: string;
  up: boolean;
  label: string | null;
  labelSource: string;        // env-label / token-hash / home-marker / auth-email / stale / unknown
  email: string | null;
  model: string;
  ageMin: number | null;      // age of the status cache that supplied the label
  switchable: boolean;
  note: string;
}

export interface AccountsBackend {
  machine: string;
  /** Human description of the token store, shown under the table. */
  storeNote: string;
  labels(): string[];
  /** Absolute path of the file holding <label>'s setup token. */
  tokenPath(label: string): string;
  /** Fleet-wide default label, when the machine has such a concept. */
  defaultLabel(): string | null;
  setDefault?(label: string): Promise<FleetResult>;
  /** `status` is the fleet status the page already fetched. A backend that
   *  needs one must use it when given, so a page load costs ONE fleet-ctl call
   *  instead of one per consumer. */
  sessions(status?: FleetStatus): Promise<SessionRow[]>;
  /** `force` kills a pane that is mid-turn; without it a busy agent is refused
   *  with `busy: true` so the UI can ask before throwing a live turn away. */
  switchTo(agent: string, label: string, force?: boolean): Promise<FleetResult>;
  /** The other machine, for pushing a freshly renewed token. */
  peer: { name: string; push(label: string, token: string): Promise<string> } | null;
  /** Working directory for the `claude setup-token` tmux session. */
  setupCwd: string;
  claudeBin: string;
}

// ── secrets hygiene ────────────────────────────────────────────────────────

/** Last 4 characters of a token file, or "" - never more than that. */
export function tokenTail(path: string): string {
  try {
    const t = readFileSync(path, "utf8").trim();
    return t.length >= 4 ? t.slice(-4) : "";
  } catch { return ""; }
}

/** Scrub anything token-shaped out of text that came from a terminal pane. */
export function redact(s: string): string {
  return String(s)
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "<token hidden>")
    .replace(/\b[A-Za-z0-9_-]{60,}\b/g, "<redacted>");
}

// ── shared usage cache (the quota.sh contract) ─────────────────────────────

type Usage = { five: number; fiveReset: number; seven: number; sevenReset: number; status: string; http?: number };
const usageCacheFile = (label: string) => `/tmp/.claude_acct_usage_${label}.json`;

/** Read the shared cache. `ts` is tolerated in ms or s (claude-acct.sh wrote s). */
function readUsageCache(label: string): { ts: number; v: Usage } | null {
  try {
    const c = JSON.parse(readFileSync(usageCacheFile(label), "utf8"));
    let ts = Number(c.ts);
    if (!Number.isFinite(ts)) return null;
    if (ts < 1e11) ts *= 1000;
    if (!c.v) return null;
    return { ts, v: c.v as Usage };
  } catch { return null; }
}

/**
 * One 1-token haiku POST, read the anthropic-ratelimit-unified-* headers. The
 * same call quota.sh makes, writing the same cache shape (plus an additive
 * `http` field so a 401 is distinguishable from a probe that never ran).
 */
export async function probeAccount(be: AccountsBackend, label: string): Promise<{ health: Health; note: string }> {
  let tok = "";
  try { tok = readFileSync(be.tokenPath(label), "utf8").trim(); } catch {}
  if (!tok) return { health: "untested", note: "no token file" };
  let r: Response;
  try {
    r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${tok}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 1, messages: [{ role: "user", content: "x" }] }),
    });
  } catch (e: any) {
    return { health: "error", note: `probe failed: ${redact(e?.message ?? "network error")}` };
  }
  const num = (h: string) => { const v = Number(r.headers.get(h)); return Number.isFinite(v) ? v : NaN; };
  const v: Usage = {
    five: num("anthropic-ratelimit-unified-5h-utilization"),
    fiveReset: num("anthropic-ratelimit-unified-5h-reset"),
    seven: num("anthropic-ratelimit-unified-7d-utilization"),
    sevenReset: num("anthropic-ratelimit-unified-7d-reset"),
    status: r.headers.get("anthropic-ratelimit-unified-status") || "?",
    http: r.status,
  };
  // Only overwrite the shared cache with a reading that actually carries
  // numbers; a 401 must not blank out quota.sh's last good row.
  if (Number.isFinite(v.fiveReset)) {
    try { writeFileSync(usageCacheFile(label), JSON.stringify({ ts: Date.now(), v })); } catch {}
  }
  if (r.status === 401 || r.status === 403) return { health: "dead", note: `HTTP ${r.status}, token rejected` };
  const cap = capped(r.status, v);
  if (cap) return cap;
  if (Number.isFinite(v.fiveReset)) return { health: "ok", note: "" };
  return { health: "error", note: `HTTP ${r.status}, no ratelimit headers` };
}

/** The one place that decides an account is rate-capped rather than healthy. */
function capped(http: number | undefined, v: Usage): { health: Health; note: string } | null {
  const rated = http === 429;
  const flagged = !!v.status && v.status !== "allowed" && v.status !== "?";
  if (!rated && !flagged) return null;
  const until = ist(v.fiveReset);
  const why = rated ? "HTTP 429" : `status ${v.status}`;
  return { health: "capped", note: until ? `${why}, 5h resets ${until}` : why };
}

function healthFromCache(c: { ts: number; v: Usage } | null): { health: Health; note: string } {
  if (!c) return { health: "untested", note: "" };
  if (c.v.http === 401 || c.v.http === 403) return { health: "dead", note: `HTTP ${c.v.http}` };
  const cap = capped(c.v.http, c.v);
  if (cap) return cap;
  if (Number.isFinite(c.v.fiveReset)) return { health: "ok", note: "" };
  return { health: "untested", note: "" };
}

// "Mon 12 Sep 11:43 IST", byte-identical to quota.sh's `ist()`. Assembled from
// numeric parts rather than a locale string because the two machines ship
// different ICU data: the Mac renders "Sep", server "Sept", and en-GB slips an
// " at " between date and time on one of them.
const IST_PARTS: Intl.DateTimeFormatOptions = {
  timeZone: "Asia/Kolkata", weekday: "short", day: "2-digit", month: "numeric",
  year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function ist(epochS: number | null | undefined): string {
  if (!epochS || !Number.isFinite(epochS)) return "";
  const p: Record<string, string> = {};
  for (const x of new Intl.DateTimeFormat("en-GB", IST_PARTS).formatToParts(new Date(epochS * 1000))) p[x.type] = x.value;
  const mon = MONTHS[Number(p.month) - 1] ?? p.month;
  return `${(p.weekday ?? "").slice(0, 3)} ${p.day} ${mon} ${p.hour}:${p.minute} IST`;
}

// ── rows ───────────────────────────────────────────────────────────────────

export async function accountRows(be: AccountsBackend, sessions: SessionRow[]): Promise<AccountRow[]> {
  const def = be.defaultLabel();
  return be.labels().sort().map((label) => {
    const path = be.tokenPath(label);
    const tail = tokenTail(path);
    const c = readUsageCache(label);
    const h = healthFromCache(c);
    // Email: the freshest status cache that both carries this label and knows
    // an email. Setup tokens have no user:profile scope, so the probe cannot
    // ask; the statusline is the only place an email is ever observed.
    const email = sessions.find((s) => s.label === label && s.email)?.email ?? null;
    return {
      label,
      email,
      tokenTail: tail,
      present: !!tail,
      health: h.health,
      healthNote: h.note,
      fivePct: c && Number.isFinite(c.v.five) ? Math.round(c.v.five * 100) : null,
      fiveResetIst: ist(c?.v.fiveReset),
      weeklyPct: c && Number.isFinite(c.v.seven) ? Math.round(c.v.seven * 100) : null,
      weeklyResetIst: ist(c?.v.sevenReset),
      probedAgoS: c ? Math.round((Date.now() - c.ts) / 1000) : null,
      isDefault: def === label,
      sessions: sessions.filter((s) => s.up && s.label === label).map((s) => s.agent),
    };
  });
}

/** Read a session's statusline cache. Shared by both machines: /tmp is per-host. */
export function statusCache(sid: string): any | null {
  if (!/^[0-9a-f-]{36}$/.test(sid)) return null;
  try { return JSON.parse(readFileSync(`/tmp/.claude_status_${sid}.json`, "utf8")); } catch { return null; }
}

/** Turn a status cache into (label, source, age). Stale past 10 minutes. */
export function labelFromCache(c: any | null): { label: string | null; source: string; ageMin: number | null } {
  if (!c) return { label: null, source: "no status cache", ageMin: null };
  const ageMin = Number.isFinite(c.ts) ? Math.round((Date.now() / 1000 - c.ts) / 60) : null;
  const l = String(c.label ?? "").trim();
  if (!l || l === "?" || l === "oat?") return { label: null, source: c.auth_method || "unresolved", ageMin };
  if (ageMin != null && ageMin > 10) return { label: l, source: `${c.auth_method || "cache"} (${ageMin}m old)`, ageMin };
  return { label: l, source: c.auth_method || "cache", ageMin };
}

// ── the renew flow ─────────────────────────────────────────────────────────
//
// `claude setup-token` is interactive: it prints an OAuth URL, waits for the
// pasted code, then prints the token. So we drive it in its own tmux session
// and scrape the pane, exactly the way kushbot's /account login drives /login.
// The pane is created 400 columns wide so the URL cannot wrap, and captured
// with -J so a wrap could not hide it anyway.

const setupTmux = (label: string) => `setup-token-${label}`;
// The authorize host has moved around (claude.ai, console.anthropic.com, now
// claude.com/cai), so match on the one part that has never changed: an https
// URL with "oauth" in it.
const URL_RE = /https:\/\/[^\s"'\\]*oauth[^\s"'\\]*/i;
/** The OAuth URL, re-joined if Claude Code's renderer hard-wrapped it: take the
 *  line that starts it, then append following lines until a blank line or one
 *  containing a space (URLs never contain one). -J cannot undo these breaks,
 *  they are real newlines the TUI wrote, not tmux soft-wraps. */
export function extractUrl(pane: string): string | null {
  const lines = pane.split("\n");
  const i = lines.findIndex((l) => /https:\/\/\S*oauth/i.test(l) || /https:\/\/\S+$/.test(l.trimEnd()) && /oauth/i.test(lines.slice(lines.indexOf(l), lines.indexOf(l) + 3).join("")));
  if (i < 0) return null;
  let url = lines[i].slice(lines[i].indexOf("https://")).trimEnd();
  for (let j = i + 1; j < lines.length; j++) {
    const t = lines[j].trimEnd();
    if (!t || /\s/.test(t)) break;
    url += t;
  }
  const m = url.match(URL_RE);
  return m && /client_id=/.test(m[0]) ? m[0] : null;
}
const TOKEN_RE = /sk-ant-oat01-[A-Za-z0-9_-]{20,}/;

async function pane(name: string): Promise<string> {
  const r = await shell(["tmux", "capture-pane", "-t", name, "-p", "-J", "-S", "-200"], 6000);
  return r.stdout || "";
}
async function tmuxAlive(name: string): Promise<boolean> {
  return (await shell(["tmux", "has-session", "-t", name], 4000)).exitCode === 0;
}
async function killSetup(name: string): Promise<void> {
  await shell(["tmux", "kill-session", "-t", name], 6000);
}

// A renew that nobody finishes (browser closed at the login screen, code never
// pasted) leaves `claude setup-token` sitting in a tmux session forever, holding
// a half-open OAuth flow. Nothing else ever reaps it: renewStart only kills the
// session for the label it is about to reuse. So sweep every setup-token-* pane
// older than the TTL, from the page load as well as from renewStart, because the
// abandoning click and the dashboard restart that follows it are the common case.
const SETUP_TTL_S = 60 * 60;   // was 15m: a sign-in that took 18m got reaped mid-flow (2026-10-18)
async function reapStaleSetup(): Promise<void> {
  const r = await shell(["tmux", "list-sessions", "-F", "#{session_name} #{session_created}"], 6000);
  if (r.exitCode !== 0) return;   // no server running = nothing to reap
  const now = Math.floor(Date.now() / 1000);
  for (const line of (r.stdout || "").split("\n")) {
    const [name, created] = line.trim().split(/\s+/);
    if (!name || !name.startsWith("setup-token-")) continue;
    const age = now - Number(created);
    if (Number.isFinite(age) && age > SETUP_TTL_S) await killSetup(name);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function renewStart(be: AccountsBackend, label: string): Promise<{ success: boolean; message: string; url?: string }> {
  if (!be.labels().includes(label)) return { success: false, message: `unknown label '${label}'` };
  const name = setupTmux(label);
  await reapStaleSetup();
  await killSetup(name);
  const r = await shell(
    ["tmux", "new-session", "-d", "-s", name, "-x", "400", "-y", "50", "-c", be.setupCwd, `${be.claudeBin} setup-token`],
    15000
  );
  if (r.exitCode !== 0) return { success: false, message: redact(r.stderr || "tmux spawn failed").trim() };
  // -x/-y on new-session lose to the server's window-size policy whenever any
  // client is attached anywhere (2026-10-18: the pane came up 51 wide and the
  // URL hard-wrapped into a link with no client_id). Pin it wide explicitly.
  await shell(["tmux", "set-option", "-t", name, "window-size", "manual"], 4000);
  // setup-token prints the token and EXITS; without remain-on-exit tmux tears
  // the pane down with the token still in it and renewCode sees "exited
  // without printing a token" (2026-10-18). Keep the dead pane readable; the
  // killSetup() calls already clean it up on every path.
  await shell(["tmux", "set-option", "-t", name, "remain-on-exit", "on"], 4000);
  await shell(["tmux", "resize-window", "-t", name, "-x", "400", "-y", "50"], 4000);

  for (let waited = 0; waited < 45; waited += 2) {
    await sleep(2000);
    const p = await pane(name);
    const url = extractUrl(p);
    if (url) return { success: true, message: `OAuth URL ready. Log in as the ${label} account, then paste the code below.`, url };
    if (/Press Enter|to continue|\[Y\/n\]/i.test(p)) await shell(["tmux", "send-keys", "-t", name, "Enter"], 4000);
    if (!(await tmuxAlive(name))) return { success: false, message: "setup-token exited before printing a URL" };
  }
  const tail = redact(await pane(name)).split("\n").filter(Boolean).slice(-3).join(" | ");
  await killSetup(name);
  return { success: false, message: `no OAuth URL in 45s. Last pane: ${tail || "(empty)"}` };
}

export async function renewCode(be: AccountsBackend, label: string, code: string): Promise<FleetResult> {
  if (!be.labels().includes(label)) return { success: false, message: `unknown label '${label}'` };
  const name = setupTmux(label);
  if (!(await tmuxAlive(name))) return { success: false, message: "no setup-token session waiting. Start the renew again." };
  if (!code.trim()) return { success: false, message: "empty code" };
  if (code.length > 400 || /[\r\n]/.test(code)) return { success: false, message: "that does not look like an OAuth code" };

  // paste-buffer, never send-keys: the code contains '#', which send-keys
  // mangles (the lesson from every kushbot OAuth dance). And load-buffer from
  // STDIN, never set-buffer from argv: argv is world-readable in ps, so the one
  // credential in this whole flow that we hand to a subprocess must not travel
  // there. Same reasoning as sshPushToken below.
  const buf = `acct-${label}`;
  const lb = Bun.spawn(["tmux", "load-buffer", "-b", buf, "-"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  lb.stdin.write(code.trim());
  await lb.stdin.end();
  const lbErr = await new Response(lb.stderr).text();
  await lb.exited;
  if (lb.exitCode !== 0) return { success: false, message: redact(lbErr || "load-buffer failed") };
  await shell(["tmux", "paste-buffer", "-b", buf, "-t", name], 6000);
  await shell(["tmux", "delete-buffer", "-b", buf], 4000);
  await sleep(500);
  await shell(["tmux", "send-keys", "-t", name, "Enter"], 6000);

  for (let waited = 0; waited < 60; waited += 2) {
    await sleep(2000);
    const p = await pane(name);
    const m = p.match(TOKEN_RE);
    if (m) {
      const token = m[0];
      const path = be.tokenPath(label);
      try {
        writeFileSync(path, token + "\n", { mode: 0o600 });
        chmodSync(path, 0o600);
      } catch (e: any) {
        await killSetup(name);
        return { success: false, message: `got a token but could not write ${path}: ${redact(e?.message ?? "")}` };
      }
      await killSetup(name);
      let peerNote = "";
      if (be.peer) {
        try { peerNote = ` ${await be.peer.push(label, token)}`; }
        catch (e: any) { peerNote = ` copy to ${be.peer.name} FAILED: ${redact(e?.message ?? "")}`; }
      }
      const h = await probeAccount(be, label);
      return { success: true, message: `${label} token replaced (ends ${token.slice(-4)}), health ${h.health}${h.note ? ` (${h.note})` : ""}.${peerNote}` };
    }
    if (/invalid|expired|failed|error|denied/i.test(p) && !/Paste code|authorization code/i.test(p.slice(-400))) {
      const tail = redact(p).split("\n").filter(Boolean).slice(-3).join(" | ");
      await killSetup(name);
      return { success: false, message: `setup-token rejected the code: ${tail}` };
    }
    if (!(await tmuxAlive(name))) return { success: false, message: "setup-token exited without printing a token" };
  }
  const tail = redact(await pane(name)).split("\n").filter(Boolean).slice(-3).join(" | ");
  await killSetup(name);
  return { success: false, message: `no token in 60s, session cleaned up. Last pane: ${tail || "(empty)"}` };
}

export async function renewCancel(label: string): Promise<FleetResult> {
  await killSetup(setupTmux(label));
  return { success: true, message: `setup-token session for ${label} closed` };
}

/** Push a token to the other machine over ssh, on stdin so it never hits argv. */
export async function sshPushToken(host: string, remotePath: string, token: string): Promise<string> {
  const proc = Bun.spawn(
    ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, `umask 077; cat > ${remotePath}.new && mv ${remotePath}.new ${remotePath} && chmod 600 ${remotePath} && echo PUSHED`],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" }
  );
  proc.stdin.write(token + "\n");
  await proc.stdin.end();
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  if (proc.exitCode !== 0 || !out.includes("PUSHED")) {
    throw new Error(redact((err || out || "ssh failed").trim()).slice(0, 200));
  }
  return `copied to ${host}.`;
}

// ── render ─────────────────────────────────────────────────────────────────

function healthChip(h: Health, note: string): string {
  const map: Record<Health, [string, string]> = {
    ok: ["#6ad36a", "ok"], capped: ["#e0b26c", "capped"], dead: ["#e06c6c", "DEAD"],
    error: ["#e0b26c", "error"], untested: ["#888", "untested"],
  };
  const [c, txt] = map[h];
  return `<span style="color:${c}">${txt}</span>${note ? ` <span class="dim">${esc(note)}</span>` : ""}`;
}
function pctCell(n: number | null, reset: string): string {
  if (n == null) return `<span class="dim">-</span>`;
  const c = n >= 85 ? "#e06c6c" : n >= 70 ? "#e0b26c" : "var(--text2,#b8b8be)";
  return `<span style="color:${c}">${n}%</span>${reset ? `<div class="dim sub">${esc(reset)}</div>` : ""}`;
}
function ago(s: number | null): string {
  if (s == null) return "never";
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

export async function accountsSection(be: AccountsBackend, status?: FleetStatus): Promise<string> {
  // Fire and forget: the sweep must not add latency to a page that just spent
  // two seconds asking fleet-ctl how everyone is doing.
  void reapStaleSetup().catch(() => {});
  let sessions: SessionRow[] = [];
  let sessErr = "";
  try { sessions = await be.sessions(status); } catch (e: any) { sessErr = e?.message ?? "sessions failed"; }
  const accts = await accountRows(be, sessions);
  const labels = accts.map((a) => a.label);

  const acctRows = accts.map((a) => `<tr>
      <td><strong>${esc(a.label)}</strong>${a.isDefault ? ` <span class="dim" title="fleet default">default</span>` : ""}
        <div class="dim sub">${esc(a.email || "email unknown")} &middot; token ...${esc(a.tokenTail || "??")}</div></td>
      <td>${a.present ? healthChip(a.health, a.healthNote) : `<span style="color:#e06c6c">missing</span>`}
        <div class="dim sub">${esc(ago(a.probedAgoS))}</div></td>
      <td>${pctCell(a.fivePct, a.fiveResetIst)}</td>
      <td>${pctCell(a.weeklyPct, a.weeklyResetIst)}</td>
      <td class="dim">${a.sessions.length ? esc(a.sessions.join(", ")) : "-"}</td>
      <td class="fa-cell">
        <button class="fa" data-acct="probe" data-label="${esc(a.label)}">probe</button>
        <button class="fa" data-acct="renew" data-label="${esc(a.label)}">renew</button>
        ${be.setDefault && !a.isDefault ? `<button class="fa" data-acct="default" data-label="${esc(a.label)}">set default</button>` : ""}
      </td>
    </tr>`).join("");

  // 5h load per label, handed to the switch handler so it can warn before moving
  // an agent ONTO an account that has nothing left. Numbers only, no token data.
  const capJson = JSON.stringify(Object.fromEntries(
    accts.map((a) => [a.label, { pct: a.fivePct, reset: a.fiveResetIst, health: a.health }])
  ));

  const sessRows = sessions.map((s) => {
    const opts = labels.filter((l) => l !== s.label)
      .map((l) => `<option value="${esc(l)}">${esc(l)}</option>`).join("");
    const ctrl = !s.switchable
      ? `<span class="dim">${esc(s.note || "not switchable")}</span>`
      : `<select class="sw-sel" data-agent="${esc(s.agent)}">${opts}</select>
         <button class="fa" data-acct="switch" data-agent="${esc(s.agent)}">switch</button>`;
    return `<tr class="${s.up ? "" : "row-down"}">
      <td><strong>${esc(s.agent)}</strong><div class="dim sub">${esc(s.model || "")}${s.sessionId ? ` &middot; ${esc(s.sessionId.slice(0, 8))}` : ""}</div></td>
      <td>${s.up ? `<span style="color:#6ad36a">&#9679;</span>` : `<span style="color:#e06c6c">&#9675;</span>`}</td>
      <td>${s.label ? `<strong>${esc(s.label)}</strong>` : `<span class="dim">unknown</span>`}
        <div class="dim sub">${esc(s.labelSource)}</div></td>
      <td class="fa-cell">${ctrl}</td>
    </tr>`;
  }).join("");

  return `
    <section class="fleet-card" id="accounts">
      <h2>&#128273; Accounts &middot; ${esc(be.machine)}</h2>
      <table class="fleet-table">
        <thead><tr><th>account</th><th>token</th><th>5h</th><th>weekly</th><th class="col-ctx">sessions</th><th></th></tr></thead>
        <tbody>${acctRows || `<tr><td colspan="6" class="dim">no accounts in the store</td></tr>`}</tbody>
      </table>
      <p class="dim" style="font-size:11px;margin:8px 0 0">${esc(be.storeNote)} Quota is the shared 60s probe cache, so it is only as fresh as the last probe. <b>probe</b> makes one 1-token call and refreshes both numbers and health.</p>
      <div id="acct-msg"></div>
      <div id="renew-box" style="display:none;margin-top:10px;padding:10px;border:1px solid var(--line,#2a2d33);border-radius:6px">
        <div id="renew-step" style="font-size:13px"></div>
        <div id="renew-code-row" style="display:none;margin-top:8px">
          <input id="renew-code" placeholder="paste the code (it contains a #)" style="font-size:13px;padding:8px;width:min(420px,60vw);background:var(--bg3,#181a1f);color:var(--text2,#b8b8be);border:1px solid var(--line,#2a2d33);border-radius:6px">
          <button class="fa" id="renew-submit">submit code</button>
          <button class="fa" id="renew-cancel">cancel</button>
        </div>
      </div>
    </section>

    <section class="fleet-card">
      <h2>&#128100; Sessions by account</h2>
      ${sessErr ? `<p style="color:#e06c6c">sessions: ${esc(redact(sessErr))}</p>` : ""}
      <table class="fleet-table">
        <thead><tr><th>agent</th><th></th><th>on account</th><th></th></tr></thead>
        <tbody>${sessRows || `<tr><td colspan="4" class="dim">no sessions</td></tr>`}</tbody>
      </table>
      <p class="dim" style="font-size:11px;margin:8px 0 0">Switch = kill + relaunch on the other token, <b>resuming the same conversation</b>. Takes about a minute; the bot goes quiet and posts one confirmation when it is back.</p>
    </section>

    <script>
      (function () {
        var acctCap = ${capJson};
        var msg = document.getElementById("acct-msg");
        var box = document.getElementById("renew-box");
        var step = document.getElementById("renew-step");
        var codeRow = document.getElementById("renew-code-row");
        var renewLabel = null;
        function say(t, good) { msg.textContent = t; msg.style.color = good === undefined ? "var(--text3,#888)" : (good ? "#6ad36a" : "#e06c6c"); }
        async function post(path, body) {
          var r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
          return await r.json();
        }
        document.querySelectorAll("[data-acct]").forEach(function (b) {
          b.addEventListener("click", async function () {
            var act = b.dataset.acct, label = b.dataset.label, agent = b.dataset.agent;
            if (typeof holdRefresh === "function") holdRefresh();
            if (act === "probe") {
              say("probing " + label + "...");
              var j = await post("/api/fleet/accounts/probe", { label: label });
              say(j.message, j.success); if (j.success) setTimeout(function () { location.reload(); }, 1200);
            } else if (act === "default") {
              if (!confirm("Make " + label + " the fleet default for new launches?")) return;
              var j2 = await post("/api/fleet/accounts/default", { label: label });
              say(j2.message, j2.success); if (j2.success) setTimeout(function () { location.reload(); }, 1500);
            } else if (act === "switch") {
              var sel = document.querySelector('.sw-sel[data-agent="' + agent + '"]');
              var to = sel && sel.value;
              if (!to) { say("no other account to switch to", false); return; }
              var warn = (agent === "kc" || agent === "kai")
                ? "Switch the PARENT " + agent + " to " + to + "? It restarts and resumes its conversation, but anything mid-turn is interrupted."
                : "Switch " + agent + " to " + to + "? It restarts and resumes the same conversation.";
              // Moving onto an account with no 5h headroom left just relocates
              // the problem, so say so before the switch, not after it.
              var cap = acctCap[to];
              if (cap && (cap.health === "capped" || (cap.pct !== null && cap.pct >= 100))) {
                warn = to + " has NO 5h capacity left"
                  + (cap.pct !== null ? " (" + cap.pct + "% used" + (cap.health === "capped" ? ", the API is capping it" : "") + ")" : "")
                  + (cap.reset ? ". It resets " + cap.reset + "." : ".")
                  + "\\n\\nSwitching " + agent + " onto it now may hit the cap straight away.\\n\\n" + warn;
              }
              if (!confirm(warn)) return;
              say("switching " + agent + " to " + to + "... (about a minute)");
              var j3 = await post("/api/fleet/accounts/switch", { agent: agent, label: to });
              // The agent refused because it is mid-turn. Ask a SECOND time,
              // naming it, and say plainly that the turn dies. Only that answer
              // is allowed to send force.
              if (!j3.success && j3.busy) {
                var kill = confirm(agent + " is BUSY right now: a turn is in flight.\\n\\n"
                  + "Switching kills that turn. The work in it is lost, not resumed.\\n\\n"
                  + "Kill " + agent + "'s current turn and switch it to " + to + "?");
                if (!kill) { say(agent + " left alone, still mid-turn", false); return; }
                say("forcing the switch of " + agent + " to " + to + "...");
                j3 = await post("/api/fleet/accounts/switch", { agent: agent, label: to, force: true });
              }
              say(j3.message, j3.success);
              if (j3.success) setTimeout(function () { location.reload(); }, 60000);
            } else if (act === "renew") {
              if (!confirm("Renew the " + label + " setup token? You will log in as that account in the browser.")) return;
              renewLabel = label; box.style.display = "block"; codeRow.style.display = "none";
              step.textContent = "starting claude setup-token for " + label + "...";
              var j4 = await post("/api/fleet/accounts/renew", { label: label });
              if (!j4.success) { step.textContent = j4.message; step.style.color = "#e06c6c"; return; }
              step.style.color = "";
              step.innerHTML = j4.message + '<br><a href="' + j4.url + '" target="_blank" rel="noopener" style="word-break:break-all">' + j4.url + "</a>";
              codeRow.style.display = "block";
            }
          });
        });
        var sub = document.getElementById("renew-submit");
        if (sub) sub.addEventListener("click", async function () {
          var code = document.getElementById("renew-code").value;
          if (!code) return;
          step.textContent = "submitting code...";
          var j = await post("/api/fleet/accounts/renew/code", { label: renewLabel, code: code });
          document.getElementById("renew-code").value = "";
          step.textContent = j.message; step.style.color = j.success ? "#6ad36a" : "#e06c6c";
          if (j.success) { codeRow.style.display = "none"; setTimeout(function () { location.reload(); }, 4000); }
        });
        var can = document.getElementById("renew-cancel");
        if (can) can.addEventListener("click", async function () {
          var j = await post("/api/fleet/accounts/renew/cancel", { label: renewLabel });
          step.textContent = j.message; codeRow.style.display = "none";
        });
      })();
    </script>
  `;
}

// ── routes ─────────────────────────────────────────────────────────────────

const LABEL_RE = /^[a-zA-Z0-9._-]{1,32}$/;
const AGENT_RE = /^[a-zA-Z0-9._-]{1,32}$/;

export async function accountsRoutes(path: string, req: Request, be: AccountsBackend): Promise<Response | null> {
  if (!path.startsWith("/api/fleet/accounts")) return null;
  const body: any = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  const label = String(body.label ?? "");

  if (path === "/api/fleet/accounts" && req.method === "GET") {
    const sessions = await be.sessions();
    return Response.json({ accounts: await accountRows(be, sessions), sessions });
  }
  if (req.method !== "POST") return null;
  if (path !== "/api/fleet/accounts/switch" && !LABEL_RE.test(label)) {
    return Response.json({ success: false, message: "bad label" });
  }

  if (path === "/api/fleet/accounts/probe") {
    if (!be.labels().includes(label)) return Response.json({ success: false, message: "unknown label" });
    const h = await probeAccount(be, label);
    const good = h.health === "ok" || h.health === "capped";
    return Response.json({ success: good, message: `${label}: ${h.health}${h.note ? ` (${h.note})` : ""}` });
  }
  if (path === "/api/fleet/accounts/switch") {
    const agent = String(body.agent ?? "");
    if (!AGENT_RE.test(agent)) return Response.json({ success: false, message: "bad agent name" });
    if (!LABEL_RE.test(label) || !be.labels().includes(label)) return Response.json({ success: false, message: "bad label" });
    return Response.json(await be.switchTo(agent, label, body.force === true));
  }
  if (path === "/api/fleet/accounts/renew") return Response.json(await renewStart(be, label));
  if (path === "/api/fleet/accounts/renew/code") return Response.json(await renewCode(be, label, String(body.code ?? "")));
  if (path === "/api/fleet/accounts/renew/cancel") return Response.json(await renewCancel(label));
  if (path === "/api/fleet/accounts/default") {
    if (!be.setDefault) return Response.json({ success: false, message: "no fleet default on this machine" });
    if (!be.labels().includes(label)) return Response.json({ success: false, message: "unknown label" });
    return Response.json(await be.setDefault(label));
  }
  return null;
}

// ── small shared helpers for the device backends ───────────────────────────

export function labelsInDir(dir: string): string[] {
  try { return readdirSync(dir).filter((f) => !f.startsWith(".")); } catch { return []; }
}
export function fileExistsNonEmpty(p: string): boolean {
  try { return readFileSync(p, "utf8").trim().length > 0; } catch { return false; }
}
export { HOME as ACCOUNTS_HOME };
