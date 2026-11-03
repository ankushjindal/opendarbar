// Shared fleet cockpit — ONE page module for both machines (the owner 2026-07-17:
// "simple, mobile friendly, nothing much, fleet ctl"). A device supplies a
// FleetBackend (Mac → fleet/macctl, server → ~/kai/fleet-ctl) and the page
// renders: health row, agent cards/table with restart/ping/stop, and a
// new-session spawner with an engine picker (claude | codex | dcg).
//
// Grown out of kai's server /fleet cockpit (home-dashboard 61e24d7) — same
// FleetStatus JSON shape, so server's fleet-ctl status --json plugs straight in.

import { layout, esc } from "./html";
import { accountsSection, accountsRoutes, redact, type AccountsBackend } from "./accounts";

export interface FleetAgent {
  name: string; up: boolean; tmux: boolean;
  claim: string; parked: boolean; lease: string; model: string;
  ctx: number | null; fiveH: number | null; session: string; outbox: number;
  kind?: string; // parent | standing | pool (mac); absent on server
}
export interface FleetStatus {
  ts: number; watchdog: { lastCycle: string; alerts6h: number }; agents: FleetAgent[];
}
export interface FleetSpawnOpts { engine: string; dir: string; slot?: number; model?: string }
export interface FleetResult {
  success: boolean;
  message: string;
  /** Set by an account switch the agent refused because its pane is mid-turn.
   *  The UI turns it into a second confirm that offers to kill the turn. */
  busy?: boolean;
}

export interface FleetBackend {
  machine: string;                                  // "mac" | "server"
  otherLinks: { label: string; url: string }[];     // cross-machine hop
  status(): Promise<FleetStatus>;
  action(action: string, name: string, opts?: { fresh?: boolean }): Promise<FleetResult>;
  ping?(name: string): Promise<FleetResult>;
  spawn?(opts: FleetSpawnOpts): Promise<FleetResult>;
  spawnEngines?: string[];                          // e.g. ["claude","codex","dcg"]
  spawnDirs?: { label: string; dir: string }[];
  spawnSlots?: number[];                            // pool slots offered
  // Accounts panel (lib/accounts.ts): which Anthropic account each session runs
  // on, per-account token health + quota, switch, and token renewal. Optional so
  // a machine without a token store still gets the rest of the cockpit.
  accounts?: AccountsBackend;
}

function pct(n: number | null): string {
  if (n == null) return `<span class="dim">—</span>`;
  const c = n >= 85 ? "#e06c6c" : n >= 70 ? "#e0b26c" : "var(--text2,#b8b8be)";
  return `<span style="color:${c}">${Math.round(n)}%</span>`;
}

export async function fleetPage(be: FleetBackend): Promise<Response> {
  let st: FleetStatus;
  try { st = await be.status(); }
  catch (e: any) { return layout("Fleet", `<p style="color:var(--red)">fleet status error: ${esc(e.message)}</p>`); }

  const rows = st.agents.map((a) => {
    const dot = a.parked ? `<span style="color:#888">◦ parked</span>`
      : a.up ? `<span style="color:#6ad36a">● up</span>`
      : `<span style="color:#e06c6c">○ down</span>`;
    const isParent = a.name === "kc" || a.name === "kai";
    const isPool = a.kind === "pool";
    let controls = "";
    if (isPool) {
      controls = `<a class="fa" href="/tg" style="text-decoration:none">manage on /tg</a>`;
    } else if (a.parked) {
      controls = `<button class="fa" data-act="unpark" data-name="${esc(a.name)}">unpark</button>
                  <button class="fa" data-act="start" data-name="${esc(a.name)}">start</button>`;
    } else {
      controls = `${be.ping ? `<button class="fa" data-act="ping" data-name="${esc(a.name)}">ping</button>` : ""}
                  <button class="fa ${isParent ? "fa-danger" : ""}" data-act="restart" data-name="${esc(a.name)}"
                    title="kill + resume same session">restart</button>
                  ${isParent ? "" : `<button class="fa fa-danger" data-act="stop" data-name="${esc(a.name)}">stop</button>`}`;
    }
    const parentNote = isParent ? ` <span class="dim" title="parent — restart resumes; no stop">★</span>` : "";
    const sub = [a.model || null, a.kind || a.lease || null, a.claim === "stale" ? "claim:stale" : null]
      .filter(Boolean).join(" · ");
    return `<tr class="${a.up || a.parked ? "" : "row-down"}">
      <td><strong>${esc(a.name)}</strong>${parentNote}<div class="dim sub">${esc(sub)}</div></td>
      <td>${dot}</td>
      <td class="col-ctx">${pct(a.ctx)}</td>
      <td class="fa-cell">${controls}</td>
    </tr>`;
  }).join("");

  const wd = st.watchdog;
  const wdAge = wd.lastCycle ? `${Math.round((st.ts - Math.floor(new Date(wd.lastCycle).getTime() / 1000)) / 60)}m` : "—";
  const upCount = st.agents.filter((a) => a.up).length;
  const hop = be.otherLinks.map((l) => `<a class="hop" href="${esc(l.url)}/fleet">⇄ ${esc(l.label)}</a>`).join(" ");

  const spawnCard = be.spawn ? `
    <section class="fleet-card">
      <h2>＋ New session</h2>
      <div class="spawn-row">
        <select id="sp-engine">${(be.spawnEngines ?? ["claude"]).map((e) => `<option>${esc(e)}</option>`).join("")}</select>
        <select id="sp-dir">${(be.spawnDirs ?? []).map((d) => `<option value="${esc(d.dir)}">${esc(d.label)}</option>`).join("")}</select>
        <select id="sp-slot"><option value="">auto slot</option>${(be.spawnSlots ?? []).map((s) => `<option value="${s}">slot ${s}</option>`).join("")}</select>
        <button class="fa" id="sp-go" style="font-size:13px;padding:8px 16px">spawn</button>
      </div>
      <p class="dim" style="font-size:11px;margin:8px 0 0">claude = normal session · codex = codex-bridge son · dcg = GPT/Grok via gateway (gpt-5.6-sol default)</p>
    </section>` : "";

  const acctSection = be.accounts
    ? await accountsSection(be.accounts, st).catch((e: any) => `<section class="fleet-card"><h2>&#128273; Accounts</h2><p style="color:var(--red)">accounts panel error: ${esc(redact(e?.message ?? e))}</p></section>`)
    : "";

  const body = `
    <style>
      .fleet-card { background:var(--bg2,#14161b); border:1px solid var(--line,#2a2d33); border-radius:8px; padding:14px 16px; margin:14px 0; }
      .fleet-card h2 { font-size:15px; font-weight:500; margin:0 0 10px; }
      .fleet-table { border-collapse:collapse; width:100%; font-size:14px; }
      .fleet-table th { text-align:left; color:var(--text3,#888); font-weight:normal; padding:6px 8px; border-bottom:1px solid var(--line,#2a2d33); font-size:11px; text-transform:uppercase; letter-spacing:.04em; }
      .fleet-table td { padding:10px 8px; border-bottom:1px solid #1a1c20; vertical-align:middle; }
      .row-down { opacity:.6; }
      .sub { font-size:11px; margin-top:2px; }
      .fa-cell { white-space:nowrap; text-align:right; }
      .fa { font-size:12px; padding:8px 12px; margin-left:4px; border:1px solid var(--line,#2a2d33); border-radius:6px; background:var(--bg3,#181a1f); color:var(--text2,#b8b8be); cursor:pointer; }
      .fa:hover { border-color:var(--accent,#7eb3ff); color:var(--accent,#7eb3ff); }
      .fa-danger:hover { border-color:var(--red,#e06c6c); color:var(--red,#e06c6c); }
      .health-row { display:flex; gap:18px; flex-wrap:wrap; font-size:13px; align-items:center; }
      .health-row b { color:var(--text,#d8d8db); font-weight:500; }
      .hop { font-size:13px; padding:6px 12px; border:1px solid var(--accent,#7eb3ff); border-radius:6px; color:var(--accent,#7eb3ff); text-decoration:none; }
      #fleet-msg { font-size:13px; margin-top:10px; min-height:18px; }
      .dim { color:var(--text3,#888); }
      .spawn-row { display:flex; gap:8px; flex-wrap:wrap; }
      .spawn-row select { font-size:13px; padding:8px; background:var(--bg3,#181a1f); color:var(--text2,#b8b8be); border:1px solid var(--line,#2a2d33); border-radius:6px; max-width:46vw; }
      @media (max-width: 560px) {
        .col-ctx { display:none; }
        .fa { padding:9px 10px; }
        .fleet-table td { padding:10px 4px; }
      }
    </style>

    <h1 style="margin:12px 0 2px;font-weight:500">Fleet · ${esc(be.machine)}</h1>
    <p class="dim" style="font-size:12px;margin:0 0 6px"><strong>restart</strong> resumes the same session · <strong>stop</strong> parks · <strong>ping</strong> injects a probe turn and waits for the echo. Auto-refresh 30s.</p>

    <section class="fleet-card">
      <div class="health-row">
        <div><b>${upCount}/${st.agents.length}</b> up</div>
        <div>watchdog: <b>${esc(wdAge)}</b></div>
        ${hop}
        <button id="fleet-refresh" class="fa" style="margin-left:auto">refresh</button>
      </div>
    </section>

    <section class="fleet-card">
      <table class="fleet-table">
        <thead><tr><th>agent</th><th>state</th><th class="col-ctx">ctx</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div id="fleet-msg"></div>
    </section>

    ${acctSection}

    ${spawnCard}

    <script>
      let refreshTimer = setTimeout(() => location.reload(), 30000);
      function holdRefresh() { clearTimeout(refreshTimer); }
      async function fleetAct(action, name) {
        if ((action === "stop") && !confirm("Stop + park " + name + "? (transcript kept; restart resumes)")) return;
        if (action === "restart" && (name === "kc" || name === "kai") &&
            !confirm("Restart the PARENT " + name + "? It resumes its session, but interrupts anything mid-turn.")) return;
        holdRefresh();
        const msg = document.getElementById("fleet-msg");
        msg.textContent = action + " " + name + "… (ping/restart can take ~1 min)"; msg.style.color = "var(--text3,#888)";
        try {
          const url = action === "ping" ? "/api/fleet/ping" : "/api/fleet/action";
          const r = await fetch(url, { method:"POST", headers:{"Content-Type":"application/json"},
            body: JSON.stringify(action === "ping" ? { name } : { action, name }) });
          const j = await r.json();
          msg.textContent = j.message || (j.success ? "done" : "failed");
          msg.style.color = j.success ? "#6ad36a" : "#e06c6c";
          if (action !== "ping") setTimeout(() => location.reload(), j.success ? 2500 : 6000);
        } catch (e) { msg.textContent = "request failed"; msg.style.color = "#e06c6c"; }
      }
      document.querySelectorAll(".fa[data-act]").forEach(b => b.addEventListener("click", () => fleetAct(b.dataset.act, b.dataset.name)));
      document.getElementById("fleet-refresh").addEventListener("click", () => location.reload());
      const spGo = document.getElementById("sp-go");
      if (spGo) spGo.addEventListener("click", async () => {
        holdRefresh();
        const msg = document.getElementById("fleet-msg");
        const engine = document.getElementById("sp-engine").value;
        const dir = document.getElementById("sp-dir").value;
        const slot = document.getElementById("sp-slot").value;
        msg.textContent = "spawning " + engine + " session… (~30s)"; msg.style.color = "var(--text3,#888)";
        try {
          const r = await fetch("/api/fleet/spawn", { method:"POST", headers:{"Content-Type":"application/json"},
            body: JSON.stringify({ engine, dir, slot: slot ? parseInt(slot,10) : undefined }) });
          const j = await r.json();
          msg.textContent = j.message || (j.success ? "spawned" : "spawn failed");
          msg.style.color = j.success ? "#6ad36a" : "#e06c6c";
          if (j.success) setTimeout(() => location.reload(), 3000);
        } catch (e) { msg.textContent = "request failed"; msg.style.color = "#e06c6c"; }
      });
    </script>
  `;
  return layout("Fleet", body);
}

// Thin route handler so server.ts mounting stays one block.
export async function fleetRoutes(path: string, req: Request, be: FleetBackend): Promise<Response | null> {
  if (path === "/fleet") return fleetPage(be);
  if (path.startsWith("/api/fleet/accounts")) {
    if (!be.accounts) return Response.json({ success: false, message: "no account store on this machine" }, { status: 404 });
    return accountsRoutes(path, req, be.accounts);
  }
  if (path === "/api/fleet/status") return Response.json(await be.status());
  if (path === "/api/fleet/action" && req.method === "POST") {
    let b: any = {}; try { b = await req.json(); } catch {}
    return Response.json(await be.action(String(b.action ?? ""), String(b.name ?? ""), { fresh: !!b.fresh }));
  }
  if (path === "/api/fleet/ping" && req.method === "POST") {
    if (!be.ping) return Response.json({ success: false, message: "ping not supported" }, { status: 404 });
    let b: any = {}; try { b = await req.json(); } catch {}
    return Response.json(await be.ping(String(b.name ?? "")));
  }
  if (path === "/api/fleet/spawn" && req.method === "POST") {
    if (!be.spawn) return Response.json({ success: false, message: "spawn not supported" }, { status: 404 });
    let b: any = {}; try { b = await req.json(); } catch {}
    return Response.json(await be.spawn({ engine: String(b.engine ?? "claude"), dir: String(b.dir ?? ""), slot: b.slot, model: b.model }));
  }
  return null;
}
