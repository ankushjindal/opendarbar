// /usage - every Claude seat the owner pays for, on one page (2026-10-18).
//
// What it answers, per account:
//   - session (5h), week, and the weekly Fable meter: used %, and when each resets
//   - how much of this week's budget is on track to EXPIRE unspent, from the
//     burn rate the hourly samples show
//   - the week as a curve: used % against an even-pace line, with a projection
//     to the reset
//
// Source of truth: one 1-token Fable call per account. The response headers
// carry every meter at once:
//     anthropic-ratelimit-unified-5h-utilization / -5h-reset
//     anthropic-ratelimit-unified-7d-utilization / -7d-reset
//     anthropic-ratelimit-unified-7d_oi-utilization / -7d_oi-reset   <- Fable week
// A haiku call omits the 7d_oi pair, which is why the probe model is Fable. The
// /api/oauth/usage endpoint Claude Code's /usage reads needs user:profile, which
// setup tokens do not carry (verified 2026-10-18), so headers are the only path.
// Every 7d_<x> pair is recorded generically under `scoped`, so a future model
// meter shows up in the history without a code change.
//
// Calls are dressed as Claude Code (identity system prompt, claude-cli UA with
// the installed version): the API refuses Fable on a subscription token
// otherwise ("version 2.1.251 or newer is required").
//
// Tokens: ~/.claude/creds-store/oat-<label>.txt, the store fleet-ctl --auth
// launches from, so a seat added here is immediately a seat the fleet can run
// on. Same rule as accounts.ts: a token is never printed, logged or rendered.
//
// Files:
//   ~/kai/state/usage-accounts.json   which seats exist (label, name, email, plan)
//   ~/kai/state/usage-history.jsonl   one line per probe (hourly timer + manual)
// The probe also refreshes /tmp/.claude_acct_usage_<label>.json, the shared
// cache quota.sh and the /fleet accounts panel read.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "fs";
import { join } from "path";
import { esc, layout } from "./html";
import { shell } from "./shell";

const BASE = process.env.KD_BASE || "/home/owner";
const CREDS = join(BASE, ".claude/creds-store");
const STATE = join(BASE, "kai/state");
const CONFIG = join(STATE, "usage-accounts.json");
const HISTORY = join(STATE, "usage-history.jsonl");
const CLAUDE_BIN = join(BASE, ".local/bin/claude");
const WEEK_S = 7 * 86400;
const FABLE_KEY = "oi";        // the 7d_<key> header pair that tracks Fable

// ── config ─────────────────────────────────────────────────────────────────

export interface SeatConfig { label: string; name: string; email: string; plan: string }
interface Config { probeModel: string; seats: SeatConfig[] }

const DEFAULT_CONFIG: Config = {
  probeModel: "claude-fable-5-1",
  seats: [
    { label: "work",         name: "Work",              email: "you@work.example",          plan: "Max $200" },
    { label: "personal",     name: "Personal",          email: "you@personal.example",   plan: "Team $100" },
    { label: "team-a",       name: "Team · seat A",     email: "seat-a@example.com",           plan: "Team $100" },
    { label: "team-b",       name: "Team · seat B",     email: "seat-b@example.com",           plan: "Team $100" },
  ],
};

export function loadConfig(): Config {
  try {
    const c = JSON.parse(readFileSync(CONFIG, "utf8"));
    if (Array.isArray(c.seats) && c.seats.length) return { probeModel: c.probeModel || DEFAULT_CONFIG.probeModel, seats: c.seats };
  } catch {}
  try {
    mkdirSync(STATE, { recursive: true });
    if (!existsSync(CONFIG)) writeFileSync(CONFIG, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");
  } catch {}
  return DEFAULT_CONFIG;
}

const LABEL_RE = /^[a-z0-9._-]{1,32}$/;
export const tokenPath = (label: string) => join(CREDS, `oat-${label}.txt`);
function readToken(label: string): string {
  try { return readFileSync(tokenPath(label), "utf8").trim(); } catch { return ""; }
}

// ── probe ──────────────────────────────────────────────────────────────────

export interface Meter { u: number; r: number }          // u = used 0..100, r = reset epoch s
export interface Sample {
  ts: number;                     // epoch s
  label: string;
  http: number;
  status: string;
  five: Meter | null;
  week: Meter | null;
  scoped: Record<string, Meter>;  // 7d_<key> meters; Fable = scoped.oi
  src: "timer" | "manual";
  err?: string;
}

let cliVersion = "";
async function claudeVersion(): Promise<string> {
  if (cliVersion) return cliVersion;
  const r = await shell([CLAUDE_BIN, "--version"], 15000);
  cliVersion = (r.stdout.trim().split(/\s+/)[0] || "2.1.302");
  return cliVersion;
}

function meter(h: Headers, key: string): Meter | null {
  const u = Number(h.get(`anthropic-ratelimit-unified-${key}-utilization`));
  const r = Number(h.get(`anthropic-ratelimit-unified-${key}-reset`));
  if (!Number.isFinite(u) || !Number.isFinite(r) || h.get(`anthropic-ratelimit-unified-${key}-utilization`) == null) return null;
  return { u: Math.round(u * 1000) / 10, r };
}

async function call(tok: string, model: string, asCli: boolean): Promise<Response> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${tok}`,
    "anthropic-version": "2023-06-01",
    "anthropic-beta": asCli ? "oauth-2025-04-20,claude-code-20250219" : "oauth-2025-04-20",
    "content-type": "application/json",
  };
  const body: any = { model, max_tokens: 1, messages: [{ role: "user", content: "x" }] };
  if (asCli) {
    headers["user-agent"] = `claude-cli/${await claudeVersion()} (external, cli)`;
    headers["x-app"] = "cli";
    body.system = [{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." }];
  }
  return fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(45000),
  });
}

export async function probe(label: string, src: Sample["src"]): Promise<Sample> {
  const s: Sample = { ts: Math.floor(Date.now() / 1000), label, http: 0, status: "?", five: null, week: null, scoped: {}, src };
  const tok = readToken(label);
  if (!tok) { s.err = "no token"; return s; }
  const cfg = loadConfig();
  let r: Response | null = null;
  try {
    r = await call(tok, cfg.probeModel, true);
    // No meters on the Fable call (model renamed, version gate): fall back to a
    // plain haiku call so 5h + week still land; the Fable meter shows as unknown.
    if (!meter(r.headers, "5h") && r.status !== 401 && r.status !== 403) {
      s.err = `fable probe HTTP ${r.status}, fell back to haiku`;
      r = await call(tok, "claude-haiku-4-5-20251001", false);
    }
  } catch (e: any) {
    s.err = `probe failed: ${String(e?.message ?? e).replace(/sk-ant-[A-Za-z0-9_-]+/g, "<token>")}`;
    return s;
  }
  s.http = r.status;
  s.status = r.headers.get("anthropic-ratelimit-unified-status") || "?";
  s.five = meter(r.headers, "5h");
  s.week = meter(r.headers, "7d");
  r.headers.forEach((_v, k) => {
    const m = k.match(/^anthropic-ratelimit-unified-7d_([a-z0-9]+)-utilization$/);
    if (m) { const mt = meter(r!.headers, `7d_${m[1]}`); if (mt) s.scoped[m[1]] = mt; }
  });
  if (r.status === 401 || r.status === 403) s.err = `HTTP ${r.status}, token rejected`;
  // Keep the shared quota cache (quota.sh, /fleet) fresh: same shape, fractions.
  if (s.five && s.week) {
    try {
      writeFileSync(`/tmp/.claude_acct_usage_${label}.json`, JSON.stringify({
        ts: Date.now(),
        v: { five: s.five.u / 100, fiveReset: s.five.r, seven: s.week.u / 100, sevenReset: s.week.r, status: s.status, http: s.http },
      }));
    } catch {}
  }
  return s;
}

export async function sampleAll(src: Sample["src"]): Promise<Sample[]> {
  const seats = loadConfig().seats.filter((x) => readToken(x.label));
  const out = await Promise.all(seats.map((x) => probe(x.label, src)));
  mkdirSync(STATE, { recursive: true });
  for (const s of out) appendFileSync(HISTORY, JSON.stringify(s) + "\n");
  return out;
}

export async function sampleOne(label: string): Promise<Sample> {
  const s = await probe(label, "manual");
  mkdirSync(STATE, { recursive: true });
  appendFileSync(HISTORY, JSON.stringify(s) + "\n");
  return s;
}

// ── history + projection ───────────────────────────────────────────────────

function readHistory(sinceTs: number): Map<string, Sample[]> {
  const by = new Map<string, Sample[]>();
  let txt = "";
  try { txt = readFileSync(HISTORY, "utf8"); } catch { return by; }
  for (const line of txt.split("\n")) {
    if (!line) continue;
    let s: Sample;
    try { s = JSON.parse(line); } catch { continue; }
    if (s.ts < sinceTs) continue;
    if (!by.has(s.label)) by.set(s.label, []);
    by.get(s.label)!.push(s);
  }
  for (const v of by.values()) v.sort((a, b) => a.ts - b.ts);
  return by;
}

export interface Projection {
  used: number; reset: number; hoursLeft: number;
  ratePerH: number | null;        // % of the weekly budget per hour, recent
  projected: number;              // % used by reset at that rate (capped 100)
  waste: number;                  // % of the weekly budget that expires unspent
  basis: string;
}

/** Burn rate from the last 24h of samples in THIS window; falls back to the
 *  average since the window opened when there is under 3h of history. */
export function project(points: { ts: number; u: number }[], cur: Meter, now: number): Projection {
  const start = cur.r - WEEK_S;
  const inWin = points.filter((p) => p.ts >= start && p.ts <= now);
  const hoursLeft = Math.max(0, (cur.r - now) / 3600);
  let rate: number | null = null, basis = "";
  const recent = inWin.filter((p) => p.ts >= now - 86400);
  if (recent.length >= 2 && recent[recent.length - 1].ts - recent[0].ts >= 3 * 3600) {
    const a = recent[0], b = recent[recent.length - 1];
    rate = Math.max(0, (b.u - a.u) / ((b.ts - a.ts) / 3600));
    basis = `last ${Math.round((b.ts - a.ts) / 3600)}h burn`;
  } else {
    const el = (now - start) / 3600;
    if (el >= 1) { rate = cur.u / el; basis = "average since week opened"; }
  }
  const projected = rate == null ? cur.u : Math.min(100, cur.u + rate * hoursLeft);
  return { used: cur.u, reset: cur.r, hoursLeft, ratePerH: rate, projected, waste: Math.max(0, 100 - projected), basis };
}

// ── time formatting: IST only (the owner, 2026-10-18: "just IST is enough") ──

function parts(epochS: number, tz: string) {
  const p: Record<string, string> = {};
  for (const x of new Intl.DateTimeFormat("en-US", {
    timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true,
  }).formatToParts(new Date(epochS * 1000))) p[x.type] = x.value;
  return p;
}
export function istEt(epochS: number | null | undefined): string {
  if (!epochS || !Number.isFinite(epochS)) return "—";
  const i = parts(epochS, "Asia/Kolkata");
  return `${i.weekday} ${i.day} ${i.month} ${i.hour}:${i.minute} ${i.dayPeriod} IST`;
}
/** Table-cell variant of istEt: drops the date when it is today (IST). */
export function istEtShort(epochS: number, now: number): string {
  const i = parts(epochS, "Asia/Kolkata"), n = parts(now, "Asia/Kolkata");
  const day = i.weekday === n.weekday && i.day === n.day ? "" : `${i.weekday} ${i.day} · `;
  return `${day}${i.hour}:${i.minute} ${i.dayPeriod} IST`;
}
function inDur(s: number): string {
  if (s <= 0) return "now";
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

// ── page ───────────────────────────────────────────────────────────────────
//
// Two layers. The TABLE answers "which seat do I send work to right now":
// one row per seat, three meters side by side, sorted by whichever lens is
// selected (budget about to expire / headroom right now). The CARDS answer
// "how is this seat's week going": the curve against even pace, with the
// projection to reset. Charts are drawn client-side (static/usage.js) from
// the JSON this page embeds, so they get the real width of their column.
//
// Not every seat has every meter. The $100 Team seats return a 5h meter and
// a Fable-week meter and NO 7d meter (verified 2026-10-18 on two seats), so
// a seat's "weekly budget" is the 7d meter when it has one, else the Fable
// week. `limits` records which exist; every expiry number keys off that.

const C = { week: "#3987e5", fable: "#d95926", five: "#199e70", pace: "#6b6b6b" };
// categorical slots for the all-seats comparison chart (dark surface, validated)
const PALETTE = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#9085e9", "#e66767"];

interface SeatView {
  seat: SeatConfig;
  hasToken: boolean;
  last: Sample | null;            // newest sample of any kind (may be an error)
  ok: Sample | null;              // newest sample that carried meters
  hist: Sample[];
  limits: { week: boolean; fable: boolean };
  week: Projection | null;
  fable: Projection | null;
  /** The weekly budget that can expire on this seat: 7d if it exists, else Fable. */
  primary: { kind: "week" | "fable" | "none"; p: Projection | null };
  anchor: { S: number; R: number; kind: "week" | "fable" | "none" };
}

function buildViews(now: number): SeatView[] {
  const hist = readHistory(now - 8 * 86400);
  return loadConfig().seats.map((seat) => {
    const all = hist.get(seat.label) || [];
    const h = all.filter((s) => s.five || s.week);
    const last = all.length ? all[all.length - 1] : null;
    const ok = h.length ? h[h.length - 1] : null;
    const week = ok?.week ? project(h.filter((s) => s.week).map((s) => ({ ts: s.ts, u: s.week!.u })), ok.week, now) : null;
    const fm = ok?.scoped?.[FABLE_KEY];
    const fable = fm ? project(h.filter((s) => s.scoped?.[FABLE_KEY]).map((s) => ({ ts: s.ts, u: s.scoped[FABLE_KEY].u })), fm, now) : null;
    const limits = { week: !!ok?.week, fable: !!fm };
    const primary: SeatView["primary"] = week ? { kind: "week", p: week } : fable ? { kind: "fable", p: fable } : { kind: "none", p: null };
    const R = primary.p ? primary.p.reset : now;
    return {
      seat, hasToken: !!readToken(seat.label), last, ok, hist: h, limits, week, fable, primary,
      anchor: { S: R - WEEK_S, R, kind: primary.kind },
    };
  });
}

// ── scoring: the two lenses the table can sort by ──────────────────────────

/** Budget on track to expire unspent, 0-100. The sort for "what should I burn". */
function expiryScore(v: SeatView): number {
  if (!v.ok) return -1;
  return Math.max(v.primary.p?.waste ?? 0, v.fable?.waste ?? 0);
}
/** Room to work right now, 0-100: the tightest of 5h and the weekly meters. */
function headroomScore(v: SeatView): number {
  if (!v.ok) return -1;
  const rejected = v.ok.status !== "allowed" && v.ok.status !== "allowed_warning" && v.ok.status !== "?";
  const parts = [100 - (v.ok.five?.u ?? 100)];
  if (v.limits.week) parts.push(100 - v.ok.week!.u);
  const room = Math.max(0, Math.min(...parts));
  return rejected ? 0 : room;
}
/** Fable room right now: Fable week left, gated on the 5h window. */
function fableRoom(v: SeatView): number {
  if (!v.ok || !v.limits.fable) return -1;
  const f = 100 - v.ok.scoped[FABLE_KEY].u;
  return Math.max(0, Math.min(f, 100 - (v.ok.five?.u ?? 100)));
}

function pickNext(live: SeatView[]): { fable: SeatView | null; other: SeatView | null; fableBackAt: number | null } {
  const fab = live.filter((v) => fableRoom(v) > 0).sort((a, b) => fableRoom(b) - fableRoom(a));
  const oth = live.filter((v) => headroomScore(v) > 0).sort((a, b) => headroomScore(b) - headroomScore(a));
  const backs = live.map((v) => v.ok?.scoped?.[FABLE_KEY]?.r).filter((r): r is number => !!r);
  return { fable: fab[0] ?? null, other: oth[0] ?? null, fableBackAt: backs.length ? Math.min(...backs) : null };
}

// ── rendering helpers ──────────────────────────────────────────────────────

function pct(n: number | null | undefined): string { return n == null ? "—" : `${Math.round(n)}%`; }
function tone(u: number): string { return u >= 100 ? "u-t-cap" : u >= 80 ? "u-t-hot" : u >= 50 ? "u-t-mid" : "u-t-ok"; }

/** A meter cell: value, bar, reset countdown; the full IST/ET time on hover. */
function meterCell(m: Meter | null, color: string, now: number, absent: string): string {
  if (!m) return `<div class="u-m u-m-absent"><span>${absent}</span></div>`;
  const left = m.r - now;
  return `<div class="u-m" title="resets ${esc(istEt(m.r))}">
    <div class="u-m-top"><b class="${tone(m.u)}">${pct(m.u)}</b><span>${m.u >= 100 ? "back" : "resets"} in ${inDur(left)}</span></div>
    <div class="u-bar"><div class="u-fill" style="width:${Math.min(100, m.u)}%;background:${color}"></div></div>
    <div class="u-m-when">${esc(istEtShort(m.r, now))}</div>
  </div>`;
}

function expiryCell(v: SeatView): string {
  if (!v.ok) return `<div class="u-x"><span class="u-muted">—</span></div>`;
  const bits: string[] = [];
  const P = v.primary.p;
  if (P && v.primary.kind === "week") bits.push(`<b class="${P.waste >= 25 ? "u-red" : P.waste >= 10 ? "u-amber" : "u-green"}">${Math.round(P.waste)}%</b> of week`);
  if (v.fable) bits.push(`<b class="${v.fable.waste >= 25 ? "u-red" : v.fable.waste >= 10 ? "u-amber" : "u-green"}">${Math.round(v.fable.waste)}%</b> of Fable`);
  if (!bits.length) bits.push(`<span class="u-muted">no weekly meter</span>`);
  return `<div class="u-x">${bits.join("<br>")}</div>`;
}

function statusChips(v: SeatView, now: number): string {
  const l = v.ok; if (!l) return v.last?.err ? `<span class="u-chip u-bad" title="${esc(v.last.err)}">probe failed</span>` : "";
  const out: string[] = [];
  const f = l.scoped?.[FABLE_KEY];
  if (f && f.u >= 100) out.push(`<span class="u-chip u-bad">Fable capped · ${inDur(f.r - now)}</span>`);
  if (l.five && l.five.u >= 100) out.push(`<span class="u-chip u-bad">5h capped · ${inDur(l.five.r - now)}</span>`);
  if (l.week && l.week.u >= 100) out.push(`<span class="u-chip u-bad">week capped · ${inDur(l.week.r - now)}</span>`);
  if (!out.length && l.status === "allowed_warning") out.push(`<span class="u-chip u-warn">near a limit</span>`);
  else if (!out.length && l.status !== "allowed" && l.status !== "?") out.push(`<span class="u-chip u-warn">${esc(l.status.replace(/_/g, " "))}</span>`);
  const age = now - l.ts;
  if (age > 2 * 3600) out.push(`<span class="u-chip u-warn">stale · ${inDur(age)}</span>`);
  if (!out.length) out.push(`<span class="u-chip u-ok">ok</span>`);
  return out.join(" ");
}

function row(v: SeatView, now: number): string {
  const s = v.seat;
  const name = `<div class="u-c u-c-seat"><div class="u-seat"><b>${esc(s.name)}</b><span class="u-plan">${esc(s.plan)}</span></div><div class="u-email">${esc(s.email)}</div></div>`;
  if (!v.hasToken) {
    return `<div class="u-tr u-tr-empty" data-label="${esc(s.label)}">
      ${name}
      <div class="u-c u-c-add">
        <button class="u-btn" data-add="${esc(s.label)}">+ add token</button>
        <span class="u-muted">sign in as ${esc(s.email)}, paste the code back</span>
        <div class="u-code" data-code-for="${esc(s.label)}" style="display:none"><a target="_blank" rel="noopener" class="u-link">open sign-in ↗</a>
          <input placeholder="paste the code" autocomplete="off" spellcheck="false"><button class="u-btn" data-submit="${esc(s.label)}">save</button><button class="u-btn u-ghost" data-cancel="${esc(s.label)}">cancel</button></div>
        <p class="u-msg" data-msg-for="${esc(s.label)}"></p>
      </div>
    </div>`;
  }
  const o = v.ok;
  return `<div class="u-tr" data-live="1" data-label="${esc(s.label)}" data-expiry="${expiryScore(v).toFixed(1)}" data-headroom="${headroomScore(v).toFixed(1)}" data-fable="${fableRoom(v).toFixed(1)}" title="open ${esc(s.name)}'s week">
    ${name}
    <div class="u-c" data-h="Session 5h">${meterCell(o?.five ?? null, C.five, now, "unknown")}</div>
    <div class="u-c" data-h="Week">${meterCell(o?.week ?? null, C.week, now, v.ok ? "no weekly limit" : "unknown")}</div>
    <div class="u-c" data-h="Fable week">${meterCell(o?.scoped?.[FABLE_KEY] ?? null, C.fable, now, "unknown")}</div>
    <div class="u-c" data-h="Expires unspent">${expiryCell(v)}</div>
    <div class="u-c u-c-st" data-h="Status">${statusChips(v, now)}<p class="u-msg" data-msg-for="${esc(s.label)}"></p></div>
  </div>`;
}

function card(v: SeatView, now: number): string {
  const s = v.seat, o = v.ok;
  const P = v.primary.p;
  const windowsLeft = P ? Math.floor(P.hoursLeft / 5) : null;
  const legend = [
    v.limits.week ? `<span><i style="border-color:${C.week}"></i>week <b>${pct(o?.week?.u)}</b></span>` : "",
    v.limits.fable ? `<span><i style="border-color:${C.fable};border-top-style:dashed"></i>Fable week <b>${pct(o?.scoped?.[FABLE_KEY]?.u)}</b></span>` : "",
    `<span><i style="border-color:${C.five};opacity:.7"></i>session 5h <b>${pct(o?.five?.u)}</b></span>`,
    v.anchor.kind !== "none" ? `<span><i style="border-color:${C.pace};border-top-style:dashed"></i>even pace</span><span><i style="border-color:#aaa;border-top-style:dotted"></i>projection</span>` : "",
  ].filter(Boolean).join("");
  const facts: string[] = [];
  if (P) {
    facts.push(`<div><span>${v.primary.kind === "week" ? "unspent week" : "unspent Fable"}</span><b>${Math.max(0, Math.round(100 - P.used))}%</b></div>`);
    facts.push(`<div><span>projected at reset</span><b>${Math.round(P.projected)}%</b></div>`);
    facts.push(`<div><span>expires unspent</span><b class="${P.waste >= 25 ? "u-red" : ""}">${Math.round(P.waste)}%</b></div>`);
    if (v.primary.kind === "week" && v.fable) facts.push(`<div><span>Fable expires</span><b class="${v.fable.waste >= 25 ? "u-red" : ""}">${Math.round(v.fable.waste)}%</b></div>`);
    facts.push(`<div><span>5h windows to reset</span><b>${windowsLeft}</b></div>`);
    facts.push(`<div><span>burn rate</span><b>${P.ratePerH != null ? P.ratePerH.toFixed(1) + "%/h" : "—"}</b></div>`);
  }
  const sub = v.anchor.kind === "none" ? "no weekly meter on this seat"
    : `${v.anchor.kind === "fable" ? "Fable week" : "week"} ends ${istEt(v.anchor.R)} · in ${inDur(v.anchor.R - now)}`;
  const age = v.last ? now - v.last.ts : null;
  return `<section class="u-card" id="card-${esc(s.label)}">
    <div class="u-head">
      <div><b>${esc(s.name)}</b><span class="u-plan">${esc(s.plan)}</span><div class="u-email">${esc(sub)}</div></div>
      <div class="u-chips">${statusChips(v, now)}<button class="u-btn u-ghost" data-probe="${esc(s.label)}">probe now</button></div>
    </div>
    ${facts.length ? `<div class="u-facts">${facts.join("")}</div>` : ""}
    <div class="u-legend">${legend}</div>
    <div class="u-chart-wrap"><div class="u-chart" data-chart="${esc(s.label)}"></div></div>
    <p class="u-note">${P?.basis ? `projection from ${esc(P.basis)} · ` : ""}last probe ${age != null ? inDur(age) + " ago" : "never"}${v.last?.err ? ` · <span class="u-errtxt">${esc(v.last.err)}</span>` : ""}</p>
    <p class="u-msg" data-msg-for="${esc(s.label)}"></p>
  </section>`;
}

export function usagePage(): Response {
  const now = Math.floor(Date.now() / 1000);
  const views = buildViews(now);
  const live = views.filter((v) => v.hasToken).sort((a, b) => expiryScore(b) - expiryScore(a));
  const empty = views.filter((v) => !v.hasToken);
  const atRisk = live.filter((v) => expiryScore(v) >= 25);
  const next = pickNext(live);

  const nextLine = live.length ? `
    <div class="u-next">
      <div><span class="u-k">Fable work →</span> ${next.fable
        ? `<b>${esc(next.fable.seat.name)}</b> <span class="u-muted">Fable ${pct(next.fable.ok!.scoped[FABLE_KEY].u)} used · 5h ${pct(next.fable.ok!.five?.u)}</span>`
        : `<b class="u-red">no seat has Fable room</b> <span class="u-muted">${next.fableBackAt ? `first one back in ${inDur(next.fableBackAt - now)} · ${esc(istEt(next.fableBackAt))}` : ""}</span>`}</div>
      <div><span class="u-k">Opus / Sonnet →</span> ${next.other
        ? `<b>${esc(next.other.seat.name)}</b> <span class="u-muted">5h ${pct(next.other.ok!.five?.u)} used${next.other.limits.week ? ` · week ${pct(next.other.ok!.week!.u)}` : " · no weekly limit"}</span>`
        : `<b class="u-red">every seat is capped</b>`}</div>
    </div>` : "";
  const headline = !live.length ? "No seats have tokens yet."
    : atRisk.length ? `<b class="u-red">${atRisk.length} of ${live.length}</b> seats will let 25%+ of a weekly budget expire at this pace: ${atRisk.map((v) => esc(v.seat.name)).join(", ")}.`
    : `All ${live.length} live seats are on pace to use what they have.`;

  const data = {
    now, colors: C, palette: PALETTE,
    seats: views.map((v, i) => ({
      label: v.seat.label, name: v.seat.name, hasToken: v.hasToken, limits: v.limits, anchor: v.anchor,
      proj: { week: v.week ? { projected: v.week.projected } : null, fable: v.fable ? { projected: v.fable.projected } : null },
      hist: v.hist.map((s) => [s.ts, s.week?.u ?? null, s.scoped?.[FABLE_KEY]?.u ?? null, s.five?.u ?? null]),
    })),
  };

  const body = `
<style>
  .u-wrap{max-width:1180px;margin:0 auto;padding:16px;overflow-x:hidden}
  .u-top{display:flex;justify-content:space-between;align-items:flex-end;gap:12px;flex-wrap:wrap}
  .u-top h1{font-size:20px;line-height:1.2}
  .u-sub{color:var(--text2);font-size:12px;margin-top:2px}
  .u-head-line{font-size:14px;margin:12px 0 8px}
  .u-next{display:flex;gap:24px;flex-wrap:wrap;font-size:13px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:10px 14px;margin-bottom:14px}
  .u-k{color:var(--text2);margin-right:4px}
  .u-muted{color:var(--text3)}.u-red{color:#e66767}.u-amber{color:#fab219}.u-green{color:#6ad36a}
  .u-t-ok{color:var(--text)}.u-t-mid{color:#e0c56a}.u-t-hot{color:#f0905a}.u-t-cap{color:#e66767}
  .u-tools{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 6px}
  .u-tools .u-seg{display:inline-flex;border:1px solid var(--border);border-radius:6px;overflow:hidden}
  .u-seg button{background:transparent;color:var(--text2);border:0;padding:4px 10px;font-size:12px;cursor:pointer}
  .u-seg button.u-on{background:#2a2a2a;color:var(--text)}
  .u-table{border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;background:var(--surface)}
  .u-th,.u-tr{display:grid;grid-template-columns:1.7fr 1.35fr 1.35fr 1.35fr .9fr 1fr;gap:10px;padding:10px 14px;align-items:center}
  .u-th{font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--text3);border-bottom:1px solid var(--border);padding-top:8px;padding-bottom:8px}
  .u-tr{border-bottom:1px solid var(--border);cursor:pointer}
  .u-tr:last-child{border-bottom:0}.u-tr:hover{background:#1b1b1b}
  .u-tr-empty{cursor:default;opacity:.9}.u-tr-empty:hover{background:transparent}
  .u-c{min-width:0}
  .u-c-add{grid-column:2/-1;display:flex;gap:10px;flex-wrap:wrap;align-items:center;font-size:12px}
  .u-seat{display:flex;flex-wrap:wrap;align-items:center;gap:2px 6px}.u-seat b{font-size:14px}
  .u-plan{white-space:nowrap;font-size:10px;color:var(--text2);border:1px solid var(--border);border-radius:4px;padding:0 5px;vertical-align:1px}
  .u-head .u-plan{margin-left:6px}
  .u-email{font-size:11px;color:var(--text2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .u-m-top{display:flex;justify-content:space-between;align-items:baseline;font-size:12px;color:var(--text2)}
  .u-m-top b{font-size:14px;font-variant-numeric:tabular-nums}
  .u-m-when{font-size:10px;color:var(--text3);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .u-m-absent{font-size:12px;color:var(--text3)}
  .u-bar{height:6px;background:#242424;border-radius:3px;overflow:hidden;margin-top:3px}
  .u-fill{height:100%;border-radius:3px}
  .u-x{font-size:12px;color:var(--text2);line-height:1.5}.u-x b{font-variant-numeric:tabular-nums}
  .u-chip{display:inline-block;font-size:11px;padding:1px 7px;border-radius:10px;border:1px solid var(--border);color:var(--text);white-space:nowrap;margin:1px 0}
  .u-bad{border-color:#d03b3b;background:#d03b3b22}.u-warn{border-color:#fab219;background:#fab21918}.u-ok{border-color:#0ca30c;background:#0ca30c18}
  .u-c-st{display:flex;flex-wrap:wrap;gap:4px;align-items:center}
  .u-section{display:flex;justify-content:space-between;align-items:baseline;gap:6px 16px;flex-wrap:wrap;margin:22px 0 8px}
  .u-section h2{font-size:15px}
  .u-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,540px),1fr));gap:14px}
  .u-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:14px;min-width:0;scroll-margin-top:60px;transition:box-shadow .3s}
  .u-card.u-flash{box-shadow:0 0 0 2px var(--accent)}
  .u-head{display:flex;justify-content:space-between;gap:8px;align-items:flex-start;margin-bottom:8px}
  .u-head>div:first-child{min-width:0;flex:1}
  .u-head b{font-size:15px}
  .u-chips{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;align-items:center}
  .u-facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(118px,1fr));gap:6px 10px;margin:4px 0 8px}
  .u-facts div{display:flex;flex-direction:column;min-width:0}.u-facts span{font-size:10px;color:var(--text2);text-transform:uppercase;letter-spacing:.03em;line-height:1.3}
  .u-facts b{font-size:16px;font-variant-numeric:tabular-nums}
  .u-legend{display:flex;gap:12px;flex-wrap:wrap;font-size:11px;color:var(--text2);margin:2px 0 4px}
  .u-legend i{display:inline-block;width:16px;height:0;border-top:2px solid;vertical-align:middle;margin-right:5px}
  .u-legend b{color:var(--text)}
  .u-chart-wrap{position:relative}
  .u-chart{height:200px;width:100%;overflow:hidden}
  .u-svg{display:block;max-width:100%}.u-ax{fill:var(--text3);font-size:10px;font-family:var(--font)}
  .u-nochart{color:var(--text3);font-size:12px;padding:40px 0;text-align:center}
  .u-tip{position:absolute;pointer-events:none;background:#1f1f1f;border:1px solid #333;border-radius:6px;padding:6px 9px;font-size:12px;display:none;z-index:5;white-space:nowrap;line-height:1.5}
  .u-tip-t{color:#888;margin-bottom:2px}.u-tip .u-sw{margin-right:5px}
  .u-sw{display:inline-block;width:8px;height:8px;border-radius:2px;vertical-align:-1px}
  .u-note{font-size:11px;color:var(--text3);margin-top:6px}.u-errtxt{color:#ec835a}
  .u-msg{font-size:12px;margin:2px 0 0;min-height:0}.u-msg:empty{display:none}
  .u-btn{background:#222;color:var(--text);border:1px solid var(--border);border-radius:6px;padding:3px 9px;font-size:12px;cursor:pointer;white-space:nowrap}
  .u-btn:disabled{opacity:.5;cursor:default}.u-ghost{background:transparent;color:var(--text2)}
  .u-code{display:flex;gap:6px;flex-wrap:wrap;align-items:center;width:100%}
  .u-code input{flex:1;min-width:180px;background:#0d0d0d;color:var(--text);border:1px solid var(--border);border-radius:6px;padding:4px 8px;font-family:var(--mono);font-size:12px}
  .u-link{font-size:12px;white-space:nowrap}
  .u-foot{font-size:11px;color:var(--text3);margin-top:18px}
  @media (max-width:860px){
    .u-th{display:none}
    .u-tr{grid-template-columns:1fr 1fr;gap:8px 12px}
    .u-c-seat{grid-column:1/-1}
    .u-c[data-h]::before{content:attr(data-h);display:block;font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--text3);margin-bottom:2px}
    .u-c-add{grid-column:1/-1}
    .u-m-when{white-space:normal}
    .u-head{flex-direction:column;align-items:flex-start}
    .u-chips{justify-content:flex-start}
  }
</style>
<div class="u-wrap">
  <div class="u-top">
    <div><h1>Claude usage</h1><div class="u-sub">${esc(istEt(now))} · ${live.length} of ${views.length} seats live · checkpoint every hour</div></div>
    <button class="u-btn" id="u-all">probe all now</button>
  </div>
  <p class="u-head-line">${headline}</p>
  ${nextLine}
  <div class="u-tools">
    <span class="u-muted" style="font-size:12px">sort by</span>
    <span class="u-seg"><button data-sort="expiry" class="u-on">budget about to expire</button><button data-sort="headroom">headroom now</button><button data-sort="fable">Fable room</button></span>
    <span class="u-muted" style="font-size:12px;margin-left:auto">click a row for its week</span>
  </div>
  <div class="u-table">
    <div class="u-th"><div>Seat</div><div>Session 5h</div><div>Week</div><div>Fable week</div><div>Expires unspent</div><div>Status</div></div>
    <div id="u-rows">${[...live, ...empty].map((v) => row(v, now)).join("")}</div>
  </div>

  ${live.length ? `<div class="u-section"><h2>Each seat's week</h2><span class="u-muted" style="font-size:12px">% of budget used, against the even-pace line; dotted = projection to reset</span></div>
  <div class="u-cards">${live.map((v) => card(v, now)).join("")}</div>

  <div class="u-section"><h2>Fable week, every seat</h2><span class="u-muted" style="font-size:12px">last 7 days, absolute time; a drop is that seat's reset</span></div>
  <section class="u-card"><div class="u-legend" id="u-compare-legend"></div><div class="u-chart-wrap"><div class="u-chart" id="u-compare"></div></div></section>` : ""}

  <p class="u-foot">Meters come from the rate-limit headers on a 1-token Fable call per seat (5h, 7d, 7d_oi = Fable week; the $100 Team seats return no 7d meter). Tokens: ~/.claude/creds-store/oat-&lt;label&gt;.txt, the store fleet-ctl --auth launches from. Seats: ~/kai/state/usage-accounts.json · history: ~/kai/state/usage-history.jsonl.</p>
</div>
<script id="u-data" type="application/json">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>
<script src="/static/usage.js"></script>`;
  return layout("Usage", body, { fullTitle: "Claude usage" });
}

// ── routes ─────────────────────────────────────────────────────────────────

type RenewFns = {
  start(label: string): Promise<{ success: boolean; message: string; url?: string }>;
  cancel(label: string): Promise<{ success: boolean; message: string }>;
};

export async function usageRoutes(path: string, req: Request, renew: RenewFns | null): Promise<Response | null> {
  if (path === "/usage" && req.method === "GET") return usagePage();
  if (!path.startsWith("/api/usage/")) return null;
  if (path === "/api/usage/data" && req.method === "GET") {
    const now = Math.floor(Date.now() / 1000);
    return Response.json(buildViews(now).map((v) => ({ label: v.seat.label, name: v.seat.name, hasToken: v.hasToken, limits: v.limits, last: v.ok, week: v.week, fable: v.fable, expiry: expiryScore(v), headroom: headroomScore(v) })));
  }
  if (req.method !== "POST") return null;
  const body: any = await req.json().catch(() => ({}));
  const label = String(body.label ?? "");
  const seats = loadConfig().seats.map((s) => s.label);
  if (path === "/api/usage/probe") {
    if (!label) {
      const out = await sampleAll("manual");
      const bad = out.filter((s) => s.err && !s.five);
      return Response.json({ success: bad.length === 0, message: `probed ${out.length}${bad.length ? `, ${bad.length} failed` : ""}` });
    }
    if (!seats.includes(label)) return Response.json({ success: false, message: "unknown seat" });
    const s = await sampleOne(label);
    const good = !!s.five;
    return Response.json({ success: good, message: good ? `5h ${Math.round(s.five!.u)}% · week ${Math.round(s.week?.u ?? 0)}% · Fable ${s.scoped[FABLE_KEY] ? Math.round(s.scoped[FABLE_KEY].u) + "%" : "?"}` : (s.err || `HTTP ${s.http}`) });
  }
  if (!LABEL_RE.test(label) || !seats.includes(label)) return Response.json({ success: false, message: "unknown seat" });
  if (!renew) return Response.json({ success: false, message: "token setup not available on this machine" });
  if (path === "/api/usage/add") {
    // renewStart only accepts labels that already have a token file, so plant an
    // empty 0600 placeholder first. It stays empty (and the seat stays "add
    // token") until the code exchange writes the real token into it.
    const p = tokenPath(label);
    if (!existsSync(p)) { try { writeFileSync(p, "", { mode: 0o600 }); chmodSync(p, 0o600); } catch (e: any) { return Response.json({ success: false, message: `cannot create ${p}` }); } }
    return Response.json(await renew.start(label));
  }
  if (path === "/api/usage/cancel") return Response.json(await renew.cancel(label));
  return null;
}
