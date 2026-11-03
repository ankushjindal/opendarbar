// /sessions — top-level Claude Code session browser.
// Scans ~/.claude/projects/*/*.jsonl, extracts metadata (title, cwd, branch, size, timestamps)
// from each file's HEAD+TAIL only — never the whole file — so a cold load reads ~64KB/file
// instead of up to 50MB. Exact msg/token counts are dropped (would need a full read); we show
// file size instead. Renders a filterable table; each row links into /session?file=<abs>.

import { readdir, stat } from "fs/promises";
import { join, basename } from "path";
import { homedir } from "os";
import { layout, esc } from "../lib/html";
import { baseLog } from "../lib/log";
import { timeAgo } from "../widgets/_helpers";
import type { TgProvider, TgBinding } from "../lib/tg";

const PROJECTS_DIR = join(homedir(), ".claude", "projects");
const CACHE_TTL_MS = 30_000;

interface SessionMeta {
  filePath: string;
  sid: string;
  project: string;          // basename of project dir
  title: string;
  cwd: string;
  branch: string;
  size: number;             // bytes (proxy for msg count — exact counts need a full read)
  firstTs: string | null;
  lastTs: string | null;
  mtime: number;
}

let CACHE: { ts: number; data: SessionMeta[] } = { ts: 0, data: [] };

async function scanAll(roots: string[]): Promise<SessionMeta[]> {
  if (Date.now() - CACHE.ts < CACHE_TTL_MS && CACHE.data.length) return CACHE.data;

  const results: SessionMeta[] = [];
  await Promise.all(roots.map(async (root) => {
    let projects: string[] = [];
    try { projects = await readdir(root); } catch { return; }
    await Promise.all(projects.map(async (proj) => {
      const projPath = join(root, proj);
      const projStat = await stat(projPath).catch(() => null);
      if (!projStat?.isDirectory()) return;
      const files = await readdir(projPath).catch(() => []);
      await Promise.all(files.map(async (f) => {
        if (!f.endsWith(".jsonl") || f.startsWith("agent-")) return;
        const fPath = join(projPath, f);
        const fStat = await stat(fPath).catch(() => null);
        if (!fStat) return;
        try {
          const meta = await parseSessionMeta(fPath, proj, fStat.mtimeMs, fStat.size);
          if (meta) results.push(meta);
        } catch (e) {
          baseLog.error(`scan failed for ${fPath}:`, e);
        }
      }));
    }));
  }));

  results.sort((a, b) => b.mtime - a.mtime);
  CACHE = { ts: Date.now(), data: results };
  return results;
}

async function parseSessionMeta(filePath: string, project: string, mtime: number, size: number): Promise<SessionMeta | null> {
  // HEAD+TAIL only — never the whole file. title/cwd/branch/firstTs live in the head;
  // lastTs (and a late customTitle) in the tail. Boundary lines may be partial, so we
  // drop the head's last line and the tail's first line when both halves are read.
  const HT = 32 * 1024;
  const f = Bun.file(filePath);
  let headText = "", tailText = "";
  if (size <= HT * 2) {
    headText = await f.text(); // small file → read it all, no tail
  } else {
    headText = await f.slice(0, HT).text();
    tailText = await f.slice(size - HT, size).text();
  }

  let title = "", cwd = "", branch = "";
  let firstTs: string | null = null, lastTs: string | null = null;
  let sawAny = false;

  const scan = (text: string, dropFirst: boolean, dropLast: boolean) => {
    const lines = text.split("\n");
    const start = dropFirst ? 1 : 0;
    const end = dropLast ? lines.length - 1 : lines.length;
    for (let i = start; i < end; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      let d: any;
      try { d = JSON.parse(line); } catch { continue; }
      sawAny = true;
      if (!cwd && d.cwd) cwd = d.cwd;
      if (!branch && d.gitBranch) branch = d.gitBranch;
      if (d.type === "custom-title" && d.customTitle) title = d.customTitle; // latest wins
      if (d.timestamp) { if (!firstTs) firstTs = d.timestamp; lastTs = d.timestamp; }
    }
  };
  scan(headText, false, !!tailText); // drop head's last line only if a tail follows
  if (tailText) scan(tailText, true, false); // drop tail's first (partial) line

  if (!sawAny) return null;
  const sid = filePath.split("/").pop()!.replace(".jsonl", "");
  return {
    filePath, sid, project,
    title: title || "(untitled)",
    cwd: cwd || "—",
    branch: branch || "—",
    size, firstTs, lastTs, mtime,
  };
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(n >= 10 * 1024 * 1024 ? 0 : 1) + "MB";
  if (n >= 1024) return Math.round(n / 1024) + "KB";
  return n + "B";
}

const STYLE = `
  .sessions-controls { display:flex; gap:10px; flex-wrap:wrap; margin: 10px 0 14px; align-items:center; }
  .sessions-controls input, .sessions-controls select {
    background: var(--bg3, #181a1f); color: var(--text, #d8d8db);
    border: 1px solid var(--line, #2a2d33); border-radius: 4px;
    padding: 5px 9px; font: inherit;
  }
  .sessions-controls input { min-width: 240px; flex: 1 1 240px; }
  .sessions-controls .count { color: var(--text3, #888); font-size: 12px; margin-left: auto; }
  table.sessions { border-collapse: collapse; width: 100%; font-size: 12.5px; }
  table.sessions th { text-align: left; color: var(--text3, #888); font-weight: normal; padding: 6px 10px; border-bottom: 1px solid var(--line, #2a2d33); position: sticky; top: 0; background: var(--bg, #0d0d0d); }
  table.sessions td { padding: 7px 10px; border-bottom: 1px solid #1a1c20; vertical-align: top; }
  table.sessions tr:hover { background: #14161b; }
  table.sessions a { color: var(--text); text-decoration: none; }
  table.sessions a:hover { color: var(--accent, #7eb3ff); }
  .s-title { font-weight: 500; max-width: 360px; word-break: break-word; }
  .s-proj { color: var(--text3); font-size: 11px; }
  .s-cwd { color: var(--text3); font-size: 11px; max-width: 280px; word-break: break-all; }
  .s-tokens { font-variant-numeric: tabular-nums; color: var(--text2, #b8b8be); }
  .s-tokens .in { color: var(--green, #6ad36a); }
  .s-tokens .out { color: var(--accent, #7eb3ff); }
  /* Mobile: 6 columns don't fit — collapse each row into a card. Title on top,
     the rest as a compact wrapping meta line. Fixes the per-character title wrap. */
  @media (max-width: 768px) {
    table.sessions thead { display: none; }
    table.sessions, table.sessions tbody, table.sessions tr.s-row { display: block; width: 100%; }
    table.sessions tr.s-row { border: 1px solid var(--line, #2a2d33); border-radius: 8px; padding: 10px 12px; margin: 8px 0; }
    table.sessions tr.s-row:hover { background: none; }
    table.sessions td { display: inline-block; border: none; padding: 0; margin: 0 8px 0 0; font-size: 12px; color: var(--text3, #999); vertical-align: middle; }
    table.sessions td.s-title { display: block; max-width: none; font-size: 15px; color: var(--text); word-break: normal; overflow-wrap: anywhere; margin-bottom: 5px; }
    table.sessions td.s-title .s-cwd { display: none; }
    table.sessions td.s-title a { word-break: normal; overflow-wrap: anywhere; }
    table.sessions td.col-branch { display: none; }
    table.sessions td:empty { display: none; }
  }
`;

const SCRIPT = `
  const q = document.getElementById('q');
  const projSel = document.getElementById('proj');
  const ageSel = document.getElementById('age');
  const countEl = document.getElementById('count');
  function apply() {
    const term = (q.value || '').toLowerCase();
    const proj = projSel.value;
    const ageH = parseInt(ageSel.value, 10);
    const cutoff = ageH > 0 ? Date.now() - ageH * 3600 * 1000 : 0;
    let n = 0;
    document.querySelectorAll('tr.s-row').forEach(tr => {
      const text = (tr.dataset.title + ' ' + tr.dataset.cwd + ' ' + tr.dataset.proj).toLowerCase();
      const mtime = parseInt(tr.dataset.mtime, 10);
      const ok = (!term || text.includes(term)) &&
                 (!proj || tr.dataset.proj === proj) &&
                 (!cutoff || mtime >= cutoff);
      tr.style.display = ok ? '' : 'none';
      if (ok) n++;
    });
    countEl.textContent = n + ' shown';
  }
  q.addEventListener('input', apply);
  projSel.addEventListener('change', apply);
  ageSel.addEventListener('change', apply);
  apply();
`;

export async function sessionsIndex(_url: URL, tg?: TgProvider, roots?: string[]): Promise<Response> {
  const all = await scanAll(roots && roots.length ? roots : [PROJECTS_DIR]);
  const projects = [...new Set(all.map(s => s.project))].sort();

  // TG attachment. Prefer EXACT match by session id (captured at spawn) — that pins
  // the right row even when several sons share a cwd. Fall back to a cwd-guess only
  // for live bindings whose session id we don't know (e.g. manually-attached).
  const sidBindings = new Map<string, TgBinding>(); // session uuid → binding (exact)
  const cwdBindings = new Map<string, TgBinding>(); // cwd → binding (guess; only when no sid)
  if (tg) {
    try {
      const pool = await tg.poolStatus();
      for (const b of pool.bindings) {
        if (b.state !== "claimed" && b.state !== "reserved") continue;
        const sid = b.session?.sessionId;
        if (sid) sidBindings.set(sid, b);
        else {
          const c = b.session?.cwd;
          if (c && c !== "?" && !cwdBindings.has(c)) cwdBindings.set(c, b);
        }
      }
    } catch { /* provider unavailable → no badges */ }
  }
  const badgedCwds = new Set<string>();

  const projectOptions = ['<option value="">all projects</option>']
    .concat(projects.map(p => {
      // Decode the encoded path-as-project-name: -Users-name-Downloads-foo → ~/.../foo
      const display = p.replace(/^-/, "").replace(/-/g, "/");
      const short = display.split("/").slice(-2).join("/");
      return `<option value="${esc(p)}">${esc(short)}</option>`;
    }))
    .join("");

  const ageOptions = [
    `<option value="0">all</option>`,
    `<option value="24" selected>last 24h</option>`,
    `<option value="168">last 7d</option>`,
    `<option value="720">last 30d</option>`,
  ].join("");

  const rows = all.map((s) => {
    const lastAgo = s.lastTs ? timeAgo(new Date(s.lastTs).getTime()) : "—";
    const lastAbs = s.lastTs ? new Date(s.lastTs).toLocaleString("en-IN") : "";
    const cwdShort = s.cwd === "—" ? "—" : basename(s.cwd);
    let tgCell = "";
    const exact = sidBindings.get(s.sid);
    if (exact) {
      const slotNum = exact.id.replace(/^slot/, "") || exact.id;
      tgCell = `<a href="/tg" title="@${esc(exact.botUsername)} — live on Telegram" style="display:inline-block;font-size:10px;font-weight:600;color:#fff;background:#1c4e9c;padding:2px 7px;border-radius:10px;text-decoration:none">TG·${esc(slotNum)}</a>`;
    } else {
      const cb = s.cwd && s.cwd !== "—" ? cwdBindings.get(s.cwd) : undefined;
      if (cb && !badgedCwds.has(s.cwd)) {
        badgedCwds.add(s.cwd);
        const slotNum = cb.id.replace(/^slot/, "") || cb.id;
        tgCell = `<a href="/tg" title="@${esc(cb.botUsername)} — cwd match (guess), confirm on /tg" style="display:inline-block;font-size:10px;font-weight:600;color:#cdd6f4;background:#26324d;padding:2px 7px;border-radius:10px;text-decoration:none">TG?·${esc(slotNum)}</a>`;
      }
    }
    return `<tr class="s-row" data-title="${esc(s.title)}" data-cwd="${esc(s.cwd)}" data-proj="${esc(s.project)}" data-mtime="${s.mtime}">
      <td class="s-title"><a href="/session?file=${encodeURIComponent(s.filePath)}">${esc(s.title)}</a><div class="s-cwd">${esc(s.cwd)}${s.cwd && s.cwd.startsWith("/") ? ` · <a href="claude-cli://open?cwd=${encodeURIComponent(s.cwd)}" title="open terminal here (desktop only)" style="color:var(--accent,#7eb3ff)">term</a>` : ""}</div></td>
      <td>${tgCell}</td>
      <td>${esc(cwdShort)}</td>
      <td title="${esc(lastAbs)}">${esc(lastAgo)}</td>
      <td class="s-tokens">${fmtBytes(s.size)}</td>
      <td class="col-branch">${esc(s.branch)}</td>
    </tr>`;
  }).join("");

  const newBtn = tg
    ? `<a href="/tg" style="float:right;margin-top:6px;padding:7px 14px;background:#1c4e9c;color:#fff;border-radius:8px;text-decoration:none;font-size:13px;font-weight:500">＋ New session (Telegram)</a>`
    : "";

  const body = `
    <style>${STYLE}</style>
    ${newBtn}
    <h1 style="margin: 12px 0 4px; color: var(--text); font-weight: 500;">Claude Code sessions</h1>
    <p style="color: var(--text3); font-size: 12px; margin: 0 0 4px;">Cached 30s. Source: <code>~/.claude/projects/*/*.jsonl</code>${tg ? ` · spawn + Telegram control on <a href="/tg" style="color:var(--accent,#7eb3ff)">/tg</a>` : ""}</p>
    <div class="sessions-controls">
      <input id="q" placeholder="search title / cwd / project…" autocomplete="off">
      <select id="proj">${projectOptions}</select>
      <select id="age">${ageOptions}</select>
      <span class="count" id="count">${all.length} total</span>
    </div>
    <table class="sessions">
      <thead><tr><th>Title</th><th>TG</th><th>Project</th><th>Last</th><th>Size</th><th class="col-branch">Branch</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <script>${SCRIPT}</script>
  `;
  return layout("Sessions", body);
}
