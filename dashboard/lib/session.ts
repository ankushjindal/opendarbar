// Claude Code session (.jsonl) viewer.
// Routes:
//   GET /session?file=<abs-path>                  — statusline mode
//   GET /session/<project-dir>/<session-uuid>     — manual link mode
// Query params:
//   compact=1   — strip everything except real user+assistant text

import { readFile } from "fs/promises";
import { resolve, join, basename } from "path";
import { homedir } from "os";
import { md } from "./html";
import type { TgProvider, TgMatch, TgCapabilities } from "./tg";

interface TgInfo { match: TgMatch | null; caps: TgCapabilities; }

const HOME = homedir();
const PROJECTS_DIR = join(HOME, ".claude", "projects");

// ---------- entry point ----------

export async function sessionRoute(url: URL, tg?: TgProvider, roots?: string[]): Promise<Response> {
  const filePath = await resolveSessionPath(url, roots);
  if (!filePath) return helpPage();

  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (e: any) {
    return errorPage(`Could not read ${filePath}`, e.message);
  }

  const entries = parseJsonl(raw);

  // Best-effort: is this session's cwd currently on a Telegram slot?
  let tgInfo: TgInfo | undefined;
  if (tg) {
    const find = (k: string) => entries.find(e => e[k] != null && e[k] !== "")?.[k];
    try {
      const match = await tg.matchSession({ cwd: find("cwd") || "", sessionId: find("sessionId") || "", filePath });
      tgInfo = { match, caps: tg.capabilities() };
    } catch { /* provider down → no TG section */ }
  }

  // Both layouts ship in one page; compact vs full is a client-side toggle (remembered
  // in localStorage), so switching never refreshes and the choice carries to the next session.
  const html = renderPage(filePath, entries, tgInfo);
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

async function resolveSessionPath(url: URL, roots?: string[]): Promise<string | null> {
  const allowed = roots && roots.length ? roots : [PROJECTS_DIR];
  const f = url.searchParams.get("file");
  if (f) {
    const abs = resolve(f);
    // allow files under any configured session root (main HOME + son/vaidya homes on server)
    if (!allowed.some((r) => abs.startsWith(r + "/"))) return null;
    return abs;
  }
  const m = url.pathname.match(/^\/session\/([^\/]+)\/([^\/]+?)(?:\.jsonl)?$/);
  if (m) return join(allowed[0], m[1], `${m[2]}.jsonl`);
  return null;
}

function parseJsonl(raw: string): any[] {
  const out: any[] = [];
  for (const ln of raw.split("\n")) {
    if (!ln.trim()) continue;
    try { out.push(JSON.parse(ln)); } catch { /* skip */ }
  }
  return out;
}

// ---------- helpers ----------

function esc(s: any): string {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function shortId(s: string | undefined, n = 8): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) : s;
}
function fmtTs(ts: string | undefined): string {
  if (!ts) return "";
  try {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return ts;
    const p = (x: number) => String(x).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  } catch { return ts; }
}
function fmtN(n: number | undefined): string {
  if (n == null) return "0";
  return n.toLocaleString();
}

// ---------- role inference ----------
// Critical: a `type: user` entry whose content is purely tool_result blocks is NOT a real user turn —
// the Anthropic API requires tool_result content to live inside a "user"-role message.
// Distinguish them so badges, rail glyphs and compact mode don't mislead.
function effectiveRole(e: any): string {
  const t = e.type;
  if (t === "assistant") return "assistant";
  if (t === "system") return "system";
  if (t === "attachment") return "attachment";
  if (t === "user") {
    const c = e.message?.content;
    if (Array.isArray(c) && c.length > 0 && c.every((p: any) => p?.type === "tool_result")) {
      return "tool_result";
    }
    return "user";
  }
  if (["custom-title", "last-prompt", "permission-mode", "agent-name", "mode", "bridge-session", "file-history-snapshot", "queue-operation"].includes(t)) {
    return "meta";
  }
  return "other";
}

// What's the "real" type label to show on the badge (overrides raw e.type when role disagrees).
function badgeLabel(e: any, role: string): string {
  if (e.type === "user" && role === "tool_result") return "tool_result";
  return e.type || "?";
}

// Filter key — same as raw e.type, except split raw "user" into "user" (real prompts)
// vs "tool_result" (Anthropic-API-style tool_result-wrapped-as-user). Lets the filter
// dropdown count and filter them separately even though both are `type:user` in the file.
function filterKey(e: any, role: string): string {
  if (e.type === "user") return role; // "user" or "tool_result"
  return e.type || "?";
}

// ---------- glyphs for left rail ----------

function railGlyph(e: any, role: string): string {
  if (role === "user") return "☞";        // ☞ pointing finger
  if (role === "assistant") return "◆";   // ◆ diamond
  if (role === "tool_result") return "↵"; // ↵ return
  if (role === "system") return "§";      // § section
  if (role === "attachment") return "▣";  // ▣ framed square
  switch (e.type) {
    case "custom-title":         return "❝"; // ❝
    case "permission-mode":      return "⚑"; // ⚑
    case "mode":                 return "⚑"; // ⚑
    case "agent-name":           return "❖"; // ❖
    case "file-history-snapshot": return "❐"; // ❐
    case "bridge-session":       return "⇌"; // ⇌
    case "queue-operation":      return "≡"; // ≡
    case "last-prompt":          return "▸"; // ▸
    default:                     return "·"; // ·
  }
}

function entryPreview(e: any): string {
  const c = e.message?.content;
  if (typeof c === "string") return c.slice(0, 160);
  if (Array.isArray(c)) {
    for (const p of c) {
      if (p?.type === "text" && p.text) return p.text.slice(0, 160);
      if (p?.type === "tool_use" && p.name) return p.name + "(…)";
      if (p?.type === "tool_result") {
        if (typeof p.content === "string") return p.content.slice(0, 160);
        if (Array.isArray(p.content)) {
          const t = p.content.find((x: any) => x?.type === "text");
          if (t?.text) return t.text.slice(0, 160);
        }
        return "(tool result)";
      }
      if (p?.type === "thinking") return "thinking…";
    }
  }
  if (e.type === "custom-title") return "title → " + (e.customTitle || "");
  if (e.type === "permission-mode") return "permission → " + (e.permissionMode || e.mode || "");
  if (e.type === "agent-name") return "agent → " + (e.agentName || "");
  if (e.type === "mode") return "mode → " + (e.mode || "");
  if (e.type === "last-prompt") return "last-prompt cursor";
  if (e.type === "bridge-session") return "bridge: " + (e.bridgeSessionId || "");
  if (e.type === "queue-operation") return "queue " + (e.operation || "");
  if (e.type === "file-history-snapshot") return "file snapshot";
  if (e.type === "attachment") return "attachment";
  return e.type || "";
}

// ---------- content rendering ----------

function renderContent(content: any): string {
  if (content == null) return "";
  if (typeof content === "string") return `<div class="text">${md(content)}</div>`;
  if (!Array.isArray(content)) return `<pre class="raw-content">${esc(JSON.stringify(content, null, 2))}</pre>`;

  return content.map((p: any) => {
    if (!p || typeof p !== "object") return `<pre class="raw-content">${esc(JSON.stringify(p, null, 2))}</pre>`;
    if (p.type === "text") return `<div class="text">${md(p.text || "")}</div>`;
    if (p.type === "thinking") return `<details class="thinking"><summary>∴ thinking</summary><div class="text">${md(p.thinking || "")}</div></details>`;
    if (p.type === "tool_use") {
      const inputStr = typeof p.input === "string" ? p.input : JSON.stringify(p.input, null, 2);
      return `<details class="tool-use" open><summary>⚙ ${esc(p.name)} <span class="dim">${esc(shortId(p.id, 10))}</span></summary><pre class="json">${esc(inputStr)}</pre></details>`;
    }
    if (p.type === "tool_result") {
      const errClass = p.is_error ? " err" : "";
      const inner = typeof p.content === "string"
        ? `<pre class="tool-result-text">${esc(p.content)}</pre>`
        : Array.isArray(p.content)
          ? p.content.map((c: any) => c?.type === "text" ? `<pre class="tool-result-text">${esc(c.text)}</pre>` : c?.type === "image" ? `<div class="dim">[image result]</div>` : `<pre class="json">${esc(JSON.stringify(c, null, 2))}</pre>`).join("")
          : `<pre class="json">${esc(JSON.stringify(p.content, null, 2))}</pre>`;
      return `<details class="tool-result${errClass}"><summary>↵ result <span class="dim">${esc(shortId(p.tool_use_id, 10))}</span>${p.is_error ? ' <span class="err-tag">ERROR</span>' : ""}</summary>${inner}</details>`;
    }
    if (p.type === "image") return `<div class="dim">[image]</div>`;
    return `<pre class="raw-content">${esc(JSON.stringify(p, null, 2))}</pre>`;
  }).join("");
}

function renderUsage(u: any): string {
  if (!u) return "";
  const parts: string[] = [];
  if (u.input_tokens != null)              parts.push(`<span class="tk">in ${fmtN(u.input_tokens)}</span>`);
  if (u.output_tokens != null)             parts.push(`<span class="tk">out ${fmtN(u.output_tokens)}</span>`);
  if (u.cache_read_input_tokens != null)   parts.push(`<span class="tk dim">cache_r ${fmtN(u.cache_read_input_tokens)}</span>`);
  if (u.cache_creation_input_tokens != null) parts.push(`<span class="tk dim">cache_w ${fmtN(u.cache_creation_input_tokens)}</span>`);
  return `<div class="usage">${parts.join(" · ")}</div>`;
}

// ---------- per-entry rendering (full mode) ----------

function renderEntry(e: any, idx: number): string {
  const role = effectiveRole(e);
  const type = e.type || "?";
  const label = badgeLabel(e, role);
  const ts = fmtTs(e.timestamp);

  const metaBits: string[] = [];
  if (e.uuid)                  metaBits.push(`<span title="${esc(e.uuid)}">uuid:${esc(shortId(e.uuid))}</span>`);
  if (e.parentUuid)             metaBits.push(`<span title="${esc(e.parentUuid)}">parent:${esc(shortId(e.parentUuid))}</span>`);
  if (e.requestId)              metaBits.push(`<span title="${esc(e.requestId)}">req:${esc(shortId(e.requestId))}</span>`);
  if (e.message?.id)            metaBits.push(`<span title="${esc(e.message.id)}">msg:${esc(shortId(e.message.id))}</span>`);
  if (e.permissionMode)         metaBits.push(`mode:${esc(e.permissionMode)}`);
  if (e.agentName)              metaBits.push(`agent:${esc(e.agentName)}`);
  if (e.attributionMcpServer)   metaBits.push(`mcp:${esc(e.attributionMcpServer)}${e.attributionMcpTool ? "/" + esc(e.attributionMcpTool) : ""}`);
  if (e.gitBranch)              metaBits.push(`branch:${esc(e.gitBranch)}`);
  if (e.isSidechain)            metaBits.push(`<span class="tag">sidechain</span>`);
  if (e.isMeta)                 metaBits.push(`<span class="tag">meta</span>`);
  if (e.isCompactSummary)       metaBits.push(`<span class="tag">compact</span>`);
  if (e.durationMs != null)     metaBits.push(`${e.durationMs}ms`);
  if (e.message?.stop_reason)   metaBits.push(`stop:${esc(e.message.stop_reason)}`);
  if (e.message?.model)         metaBits.push(`<span class="model">${esc(e.message.model)}</span>`);

  let body = "";
  if (e.message?.content !== undefined) {
    body += renderContent(e.message.content);
    if (e.message.usage) body += renderUsage(e.message.usage);
  } else if (e.content !== undefined) {
    body += renderContent(e.content);
  }
  if (e.toolUseResult) {
    const txt = typeof e.toolUseResult === "string" ? e.toolUseResult : JSON.stringify(e.toolUseResult, null, 2);
    body += `<details class="tool-result"><summary>↵ toolUseResult</summary><pre class="tool-result-text">${esc(txt)}</pre></details>`;
  }
  if (!body) {
    if (type === "custom-title")             body = `<div class="meta-event">title → <strong>${esc(e.customTitle)}</strong></div>`;
    else if (type === "permission-mode")     body = `<div class="meta-event">permission mode → <strong>${esc(e.permissionMode || e.mode)}</strong></div>`;
    else if (type === "agent-name")          body = `<div class="meta-event">agent → <strong>${esc(e.agentName)}</strong></div>`;
    else if (type === "mode")                body = `<div class="meta-event">mode → <strong>${esc(e.mode)}</strong></div>`;
    else if (type === "bridge-session")      body = `<div class="meta-event">bridge: ${esc(e.bridgeSessionId)} · seq:${esc(e.lastSequenceNum)}</div>`;
    else if (type === "last-prompt")         body = `<div class="meta-event">last-prompt cursor: <code>${esc(shortId(e.lastPrompt, 24))}…</code></div>`;
    else if (type === "queue-operation")     body = `<div class="meta-event">queue ${esc(e.operation)} <span class="dim">${e.messageCount != null ? "(" + e.messageCount + " msgs)" : ""}</span></div>`;
    else if (type === "file-history-snapshot") {
      const n = Array.isArray(e.snapshot) ? e.snapshot.length : (e.snapshot ? 1 : 0);
      body = `<details class="meta-event"><summary>file history snapshot (${n} ops)</summary><pre class="json">${esc(JSON.stringify(e.snapshot, null, 2))}</pre></details>`;
    }
    else if (type === "attachment") body = `<div class="meta-event">attachment <span class="dim">${esc(JSON.stringify(e.attachment))}</span></div>`;
  }

  const fkey = filterKey(e, role);
  return `
  <article class="entry e-${role}" data-type="${esc(type)}" data-role="${esc(role)}" data-filter="${esc(fkey)}" id="e${idx}">
    <header class="e-head">
      <span class="ts">${esc(ts)}</span>
      <span class="badge b-${esc(role)}">${esc(label)}</span>
      ${metaBits.length ? `<details class="meta-toggle"><summary>meta</summary><span class="meta">${metaBits.join(" · ")}</span></details>` : ""}
    </header>
    <div class="e-body">${body}</div>
    <details class="raw"><summary>raw</summary><pre class="json">${esc(JSON.stringify(e, null, 2))}</pre></details>
  </article>`;
}

// ---------- per-entry rendering (compact mode) ----------

function renderEntryCompact(e: any, idx: number): string {
  const role = effectiveRole(e);
  if (role !== "user" && role !== "assistant") return "";
  const c = e.message?.content;
  const textParts: string[] = [];
  if (typeof c === "string") textParts.push(c);
  else if (Array.isArray(c)) {
    for (const p of c) {
      if (p?.type === "text" && p.text) textParts.push(p.text);
    }
  }
  if (!textParts.length) return "";
  const text = textParts.join("\n\n");
  const ts = fmtTs(e.timestamp);
  return `<article class="c-msg c-${role}" id="c${idx}"><div class="c-head"><span class="c-role b-${role}">${esc(role)}</span><span class="c-ts">${esc(ts)}</span></div><div class="c-body">${md(text)}</div></article>`;
}

// ---------- session header (collapsible) ----------

// Telegram status row + (optional) detach control for the session header.
// Returns { row } for the <dl> and { script } to place after </details>.
function renderTgHeader(tgInfo?: TgInfo): { row: string; script: string } {
  if (!tgInfo) return { row: "", script: "" };
  const { match, caps } = tgInfo;
  if (!match) {
    const hint = caps.canAttachExisting
      ? ` <a href="/tg" style="color:var(--accent,#7eb3ff);font-size:11px">attach via /tg →</a>`
      : "";
    return { row: `<div><dt>telegram</dt><dd><span class="dim">not attached</span>${hint}</dd></div>`, script: "" };
  }
  const b = match.binding;
  if (b.reserved) {
    return { row: `<div><dt>telegram</dt><dd>📱 ${esc(b.label)} · @${esc(b.botUsername)} <span class="dim">(protected)</span></dd></div>`, script: "" };
  }
  const row = `<div><dt>telegram</dt><dd>📱 <a href="${esc(b.deepLink)}" style="color:var(--accent,#7eb3ff)">@${esc(b.botUsername)}</a> · ${esc(b.label)} <span class="dim">(cwd match)</span> <button id="tg-detach-btn" data-slot="${esc(b.id)}" style="margin-left:8px;font-size:11px;padding:3px 9px;cursor:pointer">detach</button></dd></div>`;
  const script = `<script>(function(){var b=document.getElementById('tg-detach-btn');if(!b)return;b.addEventListener('click',async function(){var m=${JSON.stringify(caps.detachMode)};if(m==='kill-session'&&!confirm('This stops the whole session. Continue?'))return;b.textContent='…';try{var r=await fetch('/api/tg/detach',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({slot:b.dataset.slot})});var j=await r.json();alert(j.message||'done');}catch(e){alert('request failed');}});})();</script>`;
  return { row, script };
}

function renderSessionHeader(filePath: string, entries: any[], tgInfo?: TgInfo): string {
  const tg = renderTgHeader(tgInfo);
  const findField = (k: string) => entries.find(e => e[k] != null && e[k] !== "")?.[k];
  const sessionId = findField("sessionId") || "";
  const gitBranch = findField("gitBranch") || "—";
  const cwd       = findField("cwd") || "—";
  const version   = findField("version") || "—";

  const titles = entries.filter(e => e.type === "custom-title").map(e => e.customTitle).filter(Boolean);
  const latestTitle = titles[titles.length - 1] || basename(filePath);

  const tsEntries = entries.filter(e => e.timestamp);
  const first = tsEntries[0]?.timestamp;
  const last  = tsEntries[tsEntries.length - 1]?.timestamp;

  const counts: Record<string, number> = {};
  for (const e of entries) {
    const k = filterKey(e, effectiveRole(e));
    counts[k] = (counts[k] || 0) + 1;
  }

  let inTok = 0, outTok = 0, cR = 0, cW = 0;
  for (const e of entries) {
    const u = e.message?.usage;
    if (!u) continue;
    inTok += u.input_tokens || 0;
    outTok += u.output_tokens || 0;
    cR += u.cache_read_input_tokens || 0;
    cW += u.cache_creation_input_tokens || 0;
  }

  const countParts = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `<label class="tf"><input type="checkbox" data-type-filter="${esc(t)}" checked> <span>${esc(t)}</span> <span class="dim">${n}</span></label>`)
    .join("");

  return `
  <details class="session-head" open>
    <summary>
      <h1>${esc(latestTitle)}</h1>
      <div class="summary-line">
        <span>${entries.length} msgs</span>
        <span class="dim">·</span>
        <span>${esc(gitBranch)}</span>
        <span class="dim">·</span>
        <span>in <b>${fmtN(inTok)}</b> / out <b>${fmtN(outTok)}</b></span>
        <span class="dim">·</span>
        <span>${esc(fmtTs(first))} → ${esc(fmtTs(last))}</span>
      </div>
    </summary>
    <dl class="kv">
      ${tg.row}
      <div><dt>session</dt><dd><code>${esc(sessionId)}</code></dd></div>
      <div><dt>branch</dt><dd>${esc(gitBranch)}</dd></div>
      <div><dt>cwd</dt><dd><code>${esc(cwd)}</code>${cwd && cwd.startsWith("/") ? ` <a href="claude-cli://open?cwd=${encodeURIComponent(cwd)}" title="open a new Claude Code terminal in this dir (desktop only)" style="font-size:11px">⤓ terminal</a>` : ""}</dd></div>
      <div><dt>cc version</dt><dd>${esc(version)}</dd></div>
      <div><dt>file</dt><dd><code class="break">${esc(filePath)}</code></dd></div>
      <div><dt>span</dt><dd>${esc(fmtTs(first))} → ${esc(fmtTs(last))}</dd></div>
      <div><dt>messages</dt><dd>${entries.length}</dd></div>
      <div><dt>tokens</dt><dd>in <b>${fmtN(inTok)}</b> · out <b>${fmtN(outTok)}</b> · cache_r <b>${fmtN(cR)}</b> · cache_w <b>${fmtN(cW)}</b></dd></div>
    </dl>
    <div class="controls">
      <input id="q" placeholder="search content… (live filter)" autocomplete="off">
      <details class="type-filters" id="tf-dd">
        <summary>filter types</summary>
        <div class="tf-panel">
          <div class="tf-actions">
            <button type="button" id="tf-all">all</button>
            <button type="button" id="tf-none">none</button>
          </div>
          <div class="tf-grid">${countParts}</div>
        </div>
      </details>
      <button id="toggle-raw" data-state="visible">raw: <span class="state">on</span></button>
      <button id="toggle-meta" data-state="visible">meta events: <span class="state">on</span></button>
      <button id="mode-toggle" class="btn-link" type="button">compact view →</button>
    </div>
  </details>${tg.script}`;
}

// ---------- left rail (minimap) ----------

const MAX_RAIL_MARKS = 500;

function renderRail(entries: any[]): string {
  const timed = entries.map((e, idx) => ({ e, idx })).filter(x => x.e.timestamp);
  if (timed.length === 0) return "";
  const t0 = +new Date(timed[0].e.timestamp);
  const tN = +new Date(timed[timed.length - 1].e.timestamp);
  const span = Math.max(1, tN - t0);

  // sqrt-compressed top% per entry
  let positioned = timed.map(({ e, idx }) => {
    const dt = +new Date(e.timestamp) - t0;
    const top = Math.sqrt(Math.max(0, dt) / span) * 100;
    return { e, idx, top };
  });

  // Decimate if we have too many marks. Keep ALL user+assistant marks (those are the
  // load-bearing "what happened" signal); sample others evenly to fit the budget.
  if (positioned.length > MAX_RAIL_MARKS) {
    const keep: typeof positioned = [];
    const others: typeof positioned = [];
    for (const p of positioned) {
      const role = effectiveRole(p.e);
      if (role === "user" || role === "assistant") keep.push(p);
      else others.push(p);
    }
    const budget = Math.max(0, MAX_RAIL_MARKS - keep.length);
    if (budget > 0 && others.length > budget) {
      const step = others.length / budget;
      const sampled = others.filter((_, i) => Math.floor(i % step) === 0).slice(0, budget);
      positioned = [...keep, ...sampled].sort((a, b) => a.idx - b.idx);
    } else {
      positioned = [...keep, ...others].sort((a, b) => a.idx - b.idx);
    }
  }

  // nudge marks that are too close (< 0.4%) so glyphs don't visually merge
  let lastTop = -10;
  for (const p of positioned) {
    if (p.top - lastTop < 0.4) p.top = Math.min(100, lastTop + 0.4);
    lastTop = p.top;
  }

  const marks = positioned.map(({ e, idx, top }) => {
    const role = effectiveRole(e);
    const g = railGlyph(e, role);
    const preview = entryPreview(e);
    const type = e.type || "?";
    const fkey = filterKey(e, role);
    return `<a class="rail-mark m-${role}" href="#e${idx}" data-idx="${idx}" data-type="${esc(type)}" data-role="${esc(role)}" data-filter="${esc(fkey)}" data-ts="${esc(e.timestamp || "")}" data-preview="${esc(preview)}" style="top:${top.toFixed(3)}%"><span class="g">${g}</span></a>`;
  }).join("");

  return `
  <aside class="rail" id="rail" data-collapsed="false">
    <div class="rail-track">${marks}</div>
    <div class="rail-viewport" id="rail-viewport"></div>
    <button class="rail-toggle" id="rail-toggle" aria-label="Collapse rail">‹</button>
  </aside>
  <div class="rail-tooltip" id="rail-tt" hidden></div>`;
}

// ---------- style + script ----------

const STYLE = `
  :root {
    --bg: #0c0d10; --bg2: #111316; --bg3: #16181c;
    --fg: #d8d8db; --fg-dim: #888; --fg-dimmer: #6a6c75;
    --line: #2a2d33; --line2: #1d2026;
    --green: #6ad36a; --blue: #5ea9ff; --orange: #ffa14f; --purple: #c97aff;
    --purple2: #c0a0ff; --red: #ff7070; --tool: #98e898; --tool2: #9ec5ff;
    --rail-w: 28px; --rail-w-collapsed: 6px;
  }
  * { box-sizing: border-box; }
  html, body { overflow-x: hidden; }
  body { background: var(--bg); color: var(--fg); font: 13px/1.5 ui-monospace, "JetBrains Mono", Menlo, monospace; margin: 0; padding-left: var(--rail-w); }
  body.no-rail { padding-left: 0; }
  body.rail-collapsed { padding-left: var(--rail-w-collapsed); }
  main { padding: 14px 22px 80px; max-width: 1100px; margin: 0 auto; }

  /* view-mode toggle (client-side, no reload): html.compact ⇄ full */
  html.compact .full-only { display: none !important; }
  html:not(.compact) .compact-only { display: none !important; }
  html.compact body { padding-left: 0; }
  html.compact #rail { display: none; }

  /* session header (collapsible) */
  details.session-head { position: sticky; top: 0; background: var(--bg); z-index: 10; border-bottom: 1px solid #222; padding: 12px 0 8px; }
  details.session-head > summary { list-style: none; cursor: pointer; }
  details.session-head > summary::-webkit-details-marker { display: none; }
  details.session-head h1 { display: inline-block; margin: 0 8px 4px 0; font-size: 18px; color: #f0f0f0; font-weight: 500; }
  details.session-head > summary::after { content: " ▼"; color: var(--fg-dim); font-size: 10px; }
  details.session-head[open] > summary::after { content: " ▲"; }
  .summary-line { color: var(--fg-dim); font-size: 12px; display: flex; gap: 6px; flex-wrap: wrap; }
  .summary-line b { color: var(--fg); font-weight: 500; }
  .kv { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 2px 18px; margin: 10px 0; }
  .kv > div { display: flex; gap: 8px; align-items: baseline; }
  .kv dt { color: #888; min-width: 80px; font-weight: normal; }
  .kv dd { margin: 0; word-break: break-all; }
  .kv code.break { word-break: break-all; }

  /* controls */
  .controls { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 6px; }
  .controls input, .controls button, .controls .btn-link, .controls .type-filters > summary {
    background: var(--bg3); color: var(--fg); border: 1px solid var(--line); border-radius: 4px; padding: 5px 9px; font: inherit;
  }
  .controls input { min-width: 240px; flex: 1 1 240px; }
  .controls button, .controls .btn-link { cursor: pointer; text-decoration: none; display: inline-block; }
  .controls button:hover, .controls .btn-link:hover, .controls .type-filters > summary:hover { background: #22252b; }
  .controls button[data-state="hidden"] { color: var(--fg-dim); border-style: dashed; }
  .controls button .state { color: var(--green); }
  .controls button[data-state="hidden"] .state { color: var(--red); }

  .type-filters { position: relative; }
  .type-filters > summary { cursor: pointer; list-style: none; }
  .type-filters > summary::-webkit-details-marker { display: none; }
  .tf-panel { position: absolute; top: calc(100% + 4px); left: 0; min-width: 380px; background: #14161b; border: 1px solid var(--line); padding: 10px; border-radius: 6px; z-index: 100; box-shadow: 0 6px 18px rgba(0,0,0,0.5); }
  .tf-actions { display: flex; gap: 6px; margin-bottom: 8px; padding-bottom: 8px; border-bottom: 1px solid var(--line2); }
  .tf-actions button { font-size: 11px; padding: 3px 8px; }
  .tf-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 14px; }
  label.tf { white-space: nowrap; cursor: pointer; user-select: none; }
  label.tf span { color: var(--fg); }
  label.tf span.dim { color: var(--fg-dim); }

  /* entries (full mode) */
  .entry { border-left: 3px solid var(--line); padding: 8px 12px; margin: 10px 0; background: var(--bg2); border-radius: 0 6px 6px 0; overflow-wrap: anywhere; }
  .e-user        { border-color: var(--green); }
  .e-assistant   { border-color: var(--blue); }
  .e-tool_result { border-color: var(--tool); }
  .e-system      { border-color: var(--orange); }
  .e-meta        { border-color: #555; background: #0e1013; }
  .e-attachment  { border-color: var(--purple); }
  .e-other       { border-color: #444; }

  .e-head { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; margin-bottom: 6px; }
  .ts { color: var(--fg-dimmer); font-size: 11px; }
  .badge { font-size: 10px; padding: 1px 6px; border-radius: 3px; background: var(--bg3); color: #b8b8be; text-transform: uppercase; letter-spacing: 0.04em; }
  .b-user        { background: #1a2c1a; color: #98e898; }
  .b-assistant   { background: #1a2333; color: #9ec5ff; }
  .b-tool_result { background: #1a2c20; color: var(--tool); }
  .b-system      { background: #2c241a; color: #ffc488; }
  .b-meta        { background: #1a1c1f; color: #888; }
  .b-attachment  { background: #2a1a33; color: var(--purple); }
  .b-other       { background: #1a1c1f; color: #888; }
  details.meta-toggle { display: inline; }
  details.meta-toggle > summary { cursor: pointer; color: var(--fg-dim); font-size: 11px; list-style: none; padding: 1px 6px; border-radius: 3px; background: var(--bg3); border: 1px solid var(--line); }
  details.meta-toggle > summary::-webkit-details-marker { display: none; }
  details.meta-toggle > summary::before { content: "▸ "; }
  details.meta-toggle[open] > summary::before { content: "▾ "; }
  details.meta-toggle .meta { display: block; margin-top: 4px; color: #7a7c85; font-size: 11px; }
  .meta .tag { background: var(--bg3); padding: 1px 5px; border-radius: 3px; color: #aaa; }
  .meta .model { color: var(--purple2); }

  .e-body { margin: 6px 0; }
  .text { color: var(--fg); word-break: break-word; }
  .text p { margin: 4px 0; }
  .text pre, .text code { background: #1a1c20; }
  .text pre { padding: 8px 10px; border-radius: 4px; overflow-x: auto; white-space: pre-wrap; word-break: break-word; }
  .text code { padding: 1px 4px; border-radius: 3px; font-size: 12px; word-break: break-all; }
  .text pre code { padding: 0; background: transparent; }
  .text a { color: #7eb3ff; word-break: break-all; }
  .text ul, .text ol { padding-left: 22px; margin: 4px 0; }
  .text table { border-collapse: collapse; margin: 6px 0; display: block; overflow-x: auto; }
  .text th, .text td { border: 1px solid var(--line); padding: 4px 8px; }
  details { margin: 4px 0; }
  details summary { cursor: pointer; user-select: none; color: #9aa1ab; }
  details summary:hover { color: #c8ced8; }
  .tool-use, .tool-result, .thinking { background: var(--bg3); border: 1px solid #23262c; border-radius: 4px; padding: 6px 9px; margin: 4px 0; }
  .tool-use summary { color: var(--tool2); }
  .tool-result summary { color: var(--tool); }
  .tool-result.err { border-color: #5e2a2a; }
  .tool-result.err summary { color: #ff8888; }
  .err-tag { background: #5e2a2a; color: #ffb0b0; padding: 1px 5px; border-radius: 3px; font-size: 10px; }
  .thinking summary { color: var(--purple2); font-style: italic; }
  .raw { margin-top: 6px; }
  .raw summary { color: #555; font-size: 11px; }
  .raw pre { font-size: 11px; color: #888; max-height: 400px; }
  pre.json, pre.raw-content, pre.tool-result-text {
    background: #0a0b0e; color: #b0b4bb; padding: 8px 10px; border-radius: 4px;
    overflow-x: auto; max-height: 600px; white-space: pre-wrap; word-break: break-word; margin: 0;
  }
  .usage { color: var(--fg-dim); font-size: 11px; margin-top: 4px; display: flex; gap: 6px; flex-wrap: wrap; }
  .usage .tk { background: var(--bg3); padding: 1px 6px; border-radius: 3px; }
  .dim { color: var(--fg-dimmer); }
  .meta-event { color: #aab; padding: 2px 0; }
  .meta-event code { background: var(--bg3); padding: 1px 4px; border-radius: 3px; }
  .hidden { display: none !important; }
  h1, h2 { color: #f0f0f0; }
  .error { color: #ff7070; background: #2a1414; padding: 14px; border-radius: 6px; border-left: 3px solid var(--red); }

  /* compact mode — iMessage layout */
  .entries.compact-stream { max-width: 760px; margin: 8px auto 0; padding: 0 8px; }
  .c-msg { padding: 9px 13px; margin: 6px 0; max-width: 78%; word-break: break-word; font-size: 13.5px; line-height: 1.45; }
  .c-user      { margin-left: auto;  margin-right: 0;  background: #1c4e9c; color: #f0f0f0; border-radius: 18px 18px 4px 18px; border-left: none; }
  .c-assistant { margin-right: auto; margin-left: 0;   background: #1c2620; color: #d8d8db; border-radius: 18px 18px 18px 4px; border-left: none; }
  .c-head { font-size: 10px; opacity: 0.55; margin-bottom: 2px; display: flex; gap: 6px; }
  .c-role { display: none; }  /* color + side conveys the role; no badge needed */
  .c-ts { font-size: 10px; opacity: 0.7; }
  .c-body { word-break: break-word; }
  .c-body p { margin: 3px 0; }
  .c-body pre { background: rgba(0,0,0,0.28); padding: 7px 9px; border-radius: 4px; overflow-x: auto; white-space: pre-wrap; word-break: break-word; font-size: 11.5px; }
  .c-body code { background: rgba(0,0,0,0.28); padding: 1px 4px; border-radius: 3px; font-size: 11.5px; }
  .c-body a { color: inherit; text-decoration: underline; }
  @media (max-width: 600px) {
    .c-msg { max-width: 86%; }
  }

  /* left rail */
  .rail { position: fixed; top: 0; left: 0; bottom: 0; width: var(--rail-w); background: #0a0b0e; border-right: 1px solid var(--line2); overflow: hidden; z-index: 20; transition: width 150ms ease; }
  .rail[data-collapsed="true"] { width: var(--rail-w-collapsed); }
  .rail[data-collapsed="true"] .rail-mark .g { opacity: 0; }
  .rail-track { position: relative; height: 100%; }
  .rail-track::before { content: ""; position: absolute; left: 50%; top: 0; bottom: 0; width: 1px; background: var(--line2); transform: translateX(-0.5px); }
  .rail-mark { position: absolute; left: 0; right: 0; height: 14px; margin-top: -7px; display: flex; align-items: center; justify-content: center; font: 12px/1 "SF Mono", Menlo, monospace; color: var(--fg-dimmer); text-decoration: none; transition: color 100ms, transform 100ms; }
  .rail-mark:hover { color: var(--fg); transform: scale(1.5); z-index: 21; }
  .rail-mark.active { color: var(--fg); }
  .rail-mark.m-user        { color: var(--green); }
  .rail-mark.m-assistant   { color: var(--blue); }
  .rail-mark.m-tool_result { color: var(--tool); }
  .rail-mark.m-system      { color: var(--orange); }
  .rail-mark.m-attachment  { color: var(--purple); }
  .rail-mark.m-meta        { color: #555; }
  .rail-mark.m-other       { color: #555; }
  .rail-viewport { position: absolute; left: 0; right: 0; background: rgba(94,169,255,0.10); border-top: 1px solid rgba(94,169,255,0.35); border-bottom: 1px solid rgba(94,169,255,0.35); pointer-events: none; transition: top 60ms linear, height 60ms linear; }
  .rail-toggle { position: absolute; bottom: 8px; left: 4px; width: 20px; height: 20px; padding: 0; background: var(--bg3); color: #888; border: 1px solid var(--line); border-radius: 3px; cursor: pointer; font-size: 11px; }
  .rail[data-collapsed="true"] .rail-toggle { transform: rotate(180deg); }
  .rail-tooltip { position: fixed; left: calc(var(--rail-w) + 6px); background: #14161b; border: 1px solid var(--line); border-radius: 6px; padding: 8px 10px; max-width: 360px; font-size: 12px; color: var(--fg); pointer-events: none; z-index: 30; box-shadow: 0 4px 12px rgba(0,0,0,0.5); }
  .rail-tooltip .tt-type { color: var(--fg-dimmer); text-transform: uppercase; letter-spacing: 0.05em; font-size: 10px; }
  .rail-tooltip .tt-ts { color: var(--fg-dimmer); font-size: 11px; margin-left: 6px; }
  .rail-tooltip .tt-prev { margin-top: 4px; color: #b8b8be; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }

  /* mobile */
  @media (max-width: 768px) {
    body { padding-left: 0; font-size: 14px; }
    main { padding: 10px 12px 60px; }
    .rail { display: none; }
    .kv { grid-template-columns: 1fr; }
    .controls input { min-width: 0; width: 100%; }
    .tf-panel { min-width: 280px; left: auto; right: 0; }
    .tf-grid { grid-template-columns: 1fr; }
    details.session-head h1 { font-size: 16px; display: block; }
    .summary-line { font-size: 11px; }
    .entry { padding: 6px 9px; margin: 8px 0; }
    pre.json, pre.raw-content, pre.tool-result-text { max-height: 400px; font-size: 11px; }
  }
`;

const SCRIPT = `
  // ---- view mode toggle (compact ⇄ full), no reload, remembered in localStorage ----
  (function(){
    const mt = document.getElementById('mode-toggle');
    function sync(){ if (mt) mt.textContent = document.documentElement.classList.contains('compact') ? '← full view' : 'compact view →'; }
    sync();
    if (mt) mt.addEventListener('click', () => {
      const on = document.documentElement.classList.toggle('compact');
      try { localStorage.setItem('cc-view-mode', on ? 'compact' : 'full'); } catch(e){}
      sync();
      if (!on) window.dispatchEvent(new Event('resize')); // recompute rail bracket when back to full
    });
  })();

  // ---- search + type filters ----
  const q = document.getElementById('q');
  const tfilters = Array.from(document.querySelectorAll('input[data-type-filter]'));
  function applyFilters() {
    const term = (q?.value || '').toLowerCase();
    const allowed = new Set(tfilters.filter(c => c.checked).map(c => c.dataset.typeFilter));
    document.querySelectorAll('article.entry').forEach(a => {
      const t = a.dataset.filter || a.dataset.type;
      const txt = a.textContent.toLowerCase();
      const ok = allowed.has(t) && (!term || txt.includes(term));
      a.classList.toggle('hidden', !ok);
    });
    // mirror to rail marks (compact mode has no rail)
    document.querySelectorAll('.rail-mark').forEach(m => {
      const t = m.dataset.filter || m.dataset.type;
      m.classList.toggle('hidden', !allowed.has(t));
    });
  }
  if (q) q.addEventListener('input', applyFilters);
  tfilters.forEach(c => c.addEventListener('change', applyFilters));

  // select all / none
  document.getElementById('tf-all')?.addEventListener('click', () => { tfilters.forEach(c => c.checked = true); applyFilters(); });
  document.getElementById('tf-none')?.addEventListener('click', () => { tfilters.forEach(c => c.checked = false); applyFilters(); });

  // ---- stateful show/hide buttons ----
  function setBtnState(btn, on) {
    btn.dataset.state = on ? 'visible' : 'hidden';
    const stateEl = btn.querySelector('.state');
    if (stateEl) stateEl.textContent = on ? 'on' : 'off';
  }
  const rawBtn = document.getElementById('toggle-raw');
  if (rawBtn) {
    rawBtn.addEventListener('click', () => {
      const on = rawBtn.dataset.state !== 'visible';
      setBtnState(rawBtn, on);
      document.querySelectorAll('details.raw').forEach(d => d.style.display = on ? '' : 'none');
    });
    // start with raw hidden by default — too noisy
    setBtnState(rawBtn, false);
    document.querySelectorAll('details.raw').forEach(d => d.style.display = 'none');
  }
  const metaBtn = document.getElementById('toggle-meta');
  if (metaBtn) {
    metaBtn.addEventListener('click', () => {
      const on = metaBtn.dataset.state !== 'visible';
      setBtnState(metaBtn, on);
      document.querySelectorAll('article.e-meta').forEach(a => a.style.display = on ? '' : 'none');
      document.querySelectorAll('.rail-mark.m-meta').forEach(m => m.style.display = on ? '' : 'none');
    });
  }

  // close type-filter dropdown on outside click
  document.addEventListener('click', (ev) => {
    const dd = document.getElementById('tf-dd');
    if (!dd || !dd.open) return;
    if (!dd.contains(ev.target)) dd.open = false;
  });

  // ---- left rail: hover tooltip, active mark, viewport bracket, collapse ----
  const rail = document.getElementById('rail');
  const railVp = document.getElementById('rail-viewport');
  const tt = document.getElementById('rail-tt');
  const railToggle = document.getElementById('rail-toggle');

  if (rail) {
    rail.addEventListener('mouseover', (ev) => {
      const m = ev.target.closest('.rail-mark');
      if (!m || !tt) return;
      const type = m.dataset.type, ts = m.dataset.ts, prev = m.dataset.preview;
      tt.innerHTML = '<div><span class="tt-type">' + type + '</span><span class="tt-ts">' + (ts || '') + '</span></div><div class="tt-prev">' + (prev || '').replace(/</g,'&lt;') + '</div>';
      tt.hidden = false;
      const r = m.getBoundingClientRect();
      tt.style.top = Math.max(8, Math.min(window.innerHeight - 100, r.top - 8)) + 'px';
    });
    rail.addEventListener('mouseleave', () => { if (tt) tt.hidden = true; });

    if (railToggle) {
      railToggle.addEventListener('click', () => {
        const collapsed = rail.dataset.collapsed === 'true';
        rail.dataset.collapsed = collapsed ? 'false' : 'true';
        document.body.classList.toggle('rail-collapsed', !collapsed);
      });
    }

    // Active mark via IntersectionObserver — O(1) per scroll (vs O(N) getBoundingClientRect loop).
    const marksByIdx = new Map(Array.from(document.querySelectorAll('.rail-mark')).map(m => [m.dataset.idx, m]));
    const io = new IntersectionObserver((ioEntries) => {
      for (const e of ioEntries) {
        if (!e.isIntersecting) continue;
        const idx = e.target.id.replace(/^e/, '');
        marksByIdx.forEach((mk, k) => mk.classList.toggle('active', k === idx));
      }
    }, { rootMargin: '-10% 0px -85% 0px', threshold: 0 });
    document.querySelectorAll('article.entry').forEach(a => io.observe(a));

    // Viewport bracket — cached docH/railH, recomputed on resize only.
    let docH = 0, railH = 0;
    function measure() {
      docH = document.documentElement.scrollHeight - window.innerHeight;
      railH = rail.clientHeight;
      updateVp();
    }
    function updateVp() {
      if (!railVp || docH <= 0) return;
      const ratio = window.innerHeight / (docH + window.innerHeight);
      railVp.style.height = (ratio * railH) + 'px';
      railVp.style.top = ((window.scrollY / docH) * (railH * (1 - ratio))) + 'px';
    }
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', updateVp, { passive: true });
  } else {
    document.body.classList.add('no-rail');
  }
`;

// ---------- page assembly ----------

function renderPage(filePath: string, entries: any[], tgInfo?: TgInfo): string {
  // Both layouts ship together; a body-level class toggles between them client-side.
  const header = renderSessionHeader(filePath, entries, tgInfo);
  const rail = renderRail(entries);
  const fullBody = entries.map(renderEntry).join("\n");
  const compactBody = entries.map(renderEntryCompact).join("");
  const composer = renderComposer(filePath);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(basename(filePath))} — cc session</title>
  <script>
    /* no-flash: set initial view mode before paint. ?compact=1/0 forces it; else last choice. */
    (function(){try{
      var p = new URLSearchParams(location.search);
      var on = p.has('compact') ? p.get('compact') === '1'
                                : localStorage.getItem('cc-view-mode') === 'compact';
      if (on) document.documentElement.classList.add('compact');
    }catch(e){}})();
  </script>
  <style>${STYLE}</style>
</head>
<body>
${rail}
<main>
  ${header}
  <section class="entries full-only">${fullBody}</section>
  <section class="entries compact-stream compact-only">${compactBody}</section>
  <div class="compact-only">${composer}</div>
</main>
<script>${SCRIPT}</script>
</body>
</html>`;
}

// Compact-mode composer: type a reply → claude -p --resume → appended bubble.
function renderComposer(filePath: string): string {
  return `
  <style>
    .composer { position: sticky; bottom: 0; display: flex; gap: 8px; max-width: 760px;
      margin: 10px auto 0; padding: 8px; background: var(--bg,#0d0d0d);
      border-top: 1px solid var(--line,#2a2d33); }
    .composer textarea { flex: 1; resize: none; font: inherit; line-height: 1.4;
      padding: 9px 12px; border-radius: 16px; border: 1px solid var(--line,#2a2d33);
      background: var(--bg3,#181a1f); color: var(--text,#d8d8db); max-height: 140px; }
    .composer button { padding: 0 16px; border-radius: 16px; border: none;
      background: #1c4e9c; color: #fff; font-weight: 500; cursor: pointer; }
    .composer button:disabled { opacity: .5; cursor: default; }
    .c-msg.c-pending { opacity: .6; }
    .c-msg.c-error { background: #3a1c1c !important; color: #f0c0c0; }
    .composer-note { max-width: 760px; margin: 4px auto 0; font-size: 10px; color: var(--text3,#888); text-align: center; }
  </style>
  <form id="composer" class="composer">
    <textarea id="composer-input" rows="1" placeholder="Reply to this session… (Enter to send, Shift+Enter for newline)" autocomplete="off"></textarea>
    <button id="composer-send" type="submit">Send</button>
  </form>
  <div class="composer-note">conversational (read-only) · continues this session via claude -p · works only when it isn't open in a terminal / on Telegram</div>
  <script>
  (function(){
    var file = ${JSON.stringify(filePath)};
    var form = document.getElementById('composer');
    if (!form) return;
    var input = document.getElementById('composer-input');
    var btn = document.getElementById('composer-send');
    var stream = document.querySelector('.entries.compact-stream');
    function bubble(role, text, pending){
      var a = document.createElement('article');
      a.className = 'c-msg c-' + role + (pending ? ' c-pending' : '');
      var b = document.createElement('div'); b.className = 'c-body'; b.textContent = text;
      a.appendChild(b); stream.appendChild(a);
      a.scrollIntoView({behavior:'smooth', block:'end'});
      return a;
    }
    input.addEventListener('input', function(){ input.style.height='auto'; input.style.height=Math.min(input.scrollHeight,140)+'px'; });
    input.addEventListener('keydown', function(e){ if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); form.requestSubmit(); }});
    form.addEventListener('submit', async function(e){
      e.preventDefault();
      var msg = input.value.trim(); if(!msg) return;
      input.value=''; input.style.height='auto'; btn.disabled=true;
      bubble('user', msg);
      var pending = bubble('assistant', '…', true);
      try {
        var r = await fetch('/api/session/reply', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({file:file, message:msg})});
        var j = await r.json();
        pending.classList.remove('c-pending');
        pending.querySelector('.c-body').textContent = j.success ? (j.reply || '(empty reply)') : ('\\u26a0 ' + (j.message || 'failed'));
        if(!j.success) pending.classList.add('c-error');
      } catch(err){
        pending.classList.remove('c-pending');
        pending.querySelector('.c-body').textContent = '\\u26a0 request failed';
        pending.classList.add('c-error');
      } finally { btn.disabled=false; input.focus(); }
    });
  })();
  </script>`;
}

function helpPage(): Response {
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>cc session viewer</title><style>${STYLE}</style></head>
  <body class="no-rail"><main>
    <h1>cc session viewer</h1>
    <p class="dim">Pass either:</p>
    <ul class="text">
      <li><code>/session?file=&lt;absolute-jsonl-path&gt;</code> (must be under <code>~/.claude/projects/</code>)</li>
      <li><code>/session/&lt;project-dir&gt;/&lt;session-uuid&gt;</code></li>
    </ul>
    <p class="dim">Add <code>&compact=1</code> for chat-only view (strips tool calls, thinking, meta events).</p>
  </main></body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function errorPage(title: string, detail: string): Response {
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>cc session viewer — error</title><style>${STYLE}</style></head>
  <body class="no-rail"><main>
    <div class="error"><h2>${esc(title)}</h2><pre class="raw-content">${esc(detail)}</pre></div>
  </main></body></html>`;
  return new Response(html, { status: 500, headers: { "Content-Type": "text/html; charset=utf-8" } });
}
