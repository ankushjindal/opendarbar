// GET /fleet — server fleet cockpit (kushbot-improvements 2026-07-06).
//   Live table of every fleet agent (proc/model/ctx%/5h%/claim/lease/parked),
//   per-agent controls (start/stop/park/unpark/repair) wired to fleet-ctl,
//   and a health panel (watchdog last-cycle + 6h alert count + A2A outbox).
// Replaces the stale single-bot /tg view on server. Actions shell out to
// ~/kai/fleet-ctl via /api/fleet/* (dashboard is Tailscale-only = access-gated);
// destructive actions (stop) require a confirm tap.

import { layout, esc } from "../../lib/html";
import { shell } from "../../lib/shell";

const FLEET_CTL = "/home/owner/kai/fleet-ctl";

export interface FleetAgent {
  name: string; up: boolean; tmux: boolean; claudePid: string; bunPid: string;
  claim: string; parked: boolean; lease: string; model: string;
  ctx: number | null; fiveH: number | null; session: string; outbox: number;
}
export interface FleetStatus {
  ts: number; watchdog: { lastCycle: string; alerts6h: number }; agents: FleetAgent[];
}

export async function fleetStatus(): Promise<FleetStatus> {
  const r = await shell([FLEET_CTL, "status", "--json"], 30000);
  if (r.exitCode !== 0) throw new Error(r.stderr || "fleet-ctl status failed");
  return JSON.parse(r.stdout.trim());
}

// Whitelisted action dispatch — never interpolates arbitrary strings into a shell.
export async function fleetAction(action: string, name: string, opts?: { fresh?: boolean; brief?: string }): Promise<{ success: boolean; message: string }> {
  const ALLOWED = new Set(["start", "stop", "park", "unpark", "repair"]);
  if (!ALLOWED.has(action)) return { success: false, message: `action '${action}' not allowed` };
  if (!/^[a-z0-9-]{1,20}$/.test(name) && action !== "repair") return { success: false, message: "bad agent name" };
  const args = [FLEET_CTL, action];
  if (action !== "repair") args.push(name);
  if (action === "start" && opts?.fresh) args.push("--fresh");
  if (action === "start" && opts?.brief) { args.push("-m", opts.brief); }
  const r = await shell(args, 90000);
  const out = (r.stdout || r.stderr || "").trim();
  return { success: r.exitCode === 0, message: out || (r.exitCode === 0 ? "ok" : "failed") };
}

function pct(n: number | null): string {
  if (n == null) return `<span class="dim">—</span>`;
  const c = n >= 85 ? "#e06c6c" : n >= 70 ? "#e0b26c" : "var(--text2,#b8b8be)";
  return `<span style="color:${c}">${Math.round(n)}%</span>`;
}

export async function fleetPage(): Promise<Response> {
  let st: FleetStatus;
  try { st = await fleetStatus(); }
  catch (e: any) { return layout("Fleet", `<p style="color:var(--red)">fleet-ctl error: ${esc(e.message)}</p>`); }

  const rows = st.agents.map((a) => {
    const dot = a.parked ? `<span style="color:#888">◦ parked</span>`
      : a.up ? `<span style="color:#6ad36a">● up</span>`
      : `<span style="color:#e06c6c">○ down</span>`;
    const claimBadge = a.claim === "stale" ? `<span style="color:#e06c6c">stale</span>`
      : a.claim === "ok" ? `<span class="dim">ok</span>` : `<span class="dim">—</span>`;
    const controls = a.parked
      ? `<button class="fa" data-act="unpark" data-name="${esc(a.name)}">unpark</button>
         <button class="fa" data-act="start" data-name="${esc(a.name)}">start</button>`
      : `<button class="fa" data-act="start" data-name="${esc(a.name)}" title="resume (default)">restart</button>
         <button class="fa fa-danger" data-act="stop" data-name="${esc(a.name)}">stop</button>`;
    const parentNote = a.name === "kai" ? ` <span class="dim" title="parent — restart captures live cmdline">★</span>` : "";
    return `<tr class="${a.up ? "" : "row-down"}">
      <td><strong>${esc(a.name)}</strong>${parentNote}</td>
      <td>${dot}</td>
      <td>${esc(a.model || "—")}</td>
      <td>${pct(a.ctx)}</td>
      <td>${pct(a.fiveH)}</td>
      <td>${claimBadge}</td>
      <td class="dim" style="font-size:11px">${esc(a.lease || "—")}</td>
      <td class="dim" style="font-size:11px">${a.outbox || 0}</td>
      <td class="fa-cell">${controls}</td>
    </tr>`;
  }).join("");

  const wd = st.watchdog;
  const wdAge = wd.lastCycle ? `${Math.round((st.ts - Math.floor(new Date(wd.lastCycle).getTime() / 1000)) / 60)}m ago` : "—";
  const wdAlert = wd.alerts6h > 0 ? `<span style="color:#e0b26c">${wd.alerts6h} alert(s)/6h</span>` : `<span style="color:#6ad36a">quiet</span>`;
  const upCount = st.agents.filter((a) => a.up).length;
  const totalOut = st.agents.reduce((s, a) => s + (a.outbox || 0), 0);

  const body = `
    <style>
      .fleet-card { background:var(--bg2,#14161b); border:1px solid var(--line,#2a2d33); border-radius:8px; padding:14px 16px; margin:14px 0; }
      .fleet-card h2 { font-size:15px; font-weight:500; margin:0 0 10px; }
      .fleet-table { border-collapse:collapse; width:100%; font-size:13px; }
      .fleet-table th { text-align:left; color:var(--text3,#888); font-weight:normal; padding:6px 8px; border-bottom:1px solid var(--line,#2a2d33); font-size:11px; text-transform:uppercase; letter-spacing:.04em; }
      .fleet-table td { padding:8px 8px; border-bottom:1px solid #1a1c20; vertical-align:middle; }
      .row-down { opacity:.6; }
      .fa-cell { white-space:nowrap; }
      .fa { font-size:11px; padding:5px 10px; margin-left:4px; border:1px solid var(--line,#2a2d33); border-radius:5px; background:var(--bg3,#181a1f); color:var(--text2,#b8b8be); cursor:pointer; }
      .fa:hover { border-color:var(--accent,#7eb3ff); color:var(--accent,#7eb3ff); }
      .fa-danger:hover { border-color:var(--red,#e06c6c); color:var(--red,#e06c6c); }
      .health-row { display:flex; gap:22px; flex-wrap:wrap; font-size:13px; }
      .health-row b { color:var(--text,#d8d8db); font-weight:500; }
      #fleet-msg { font-size:13px; margin-top:10px; min-height:18px; }
      .dim { color:var(--text3,#888); }
    </style>

    <h1 style="margin:12px 0 2px;font-weight:500">Fleet</h1>
    <p class="dim" style="font-size:12px;margin:0 0 6px">server agent fleet · <strong>restart</strong> resumes the same session (default) · <strong>stop</strong> parks it · ★ = parent (careful). Auto-refresh 20s.</p>

    <section class="fleet-card">
      <h2>Health <button id="fleet-refresh" style="float:right;font-size:11px;padding:3px 9px;cursor:pointer">refresh</button></h2>
      <div class="health-row">
        <div><b>${upCount}/${st.agents.length}</b> up</div>
        <div>watchdog: <b>${esc(wdAge)}</b></div>
        <div>${wdAlert}</div>
        <div>A2A msgs sent: <b>${totalOut}</b></div>
      </div>
    </section>

    <section class="fleet-card">
      <table class="fleet-table">
        <thead><tr><th>agent</th><th>state</th><th>model</th><th>ctx</th><th>5h</th><th>claim</th><th>lease</th><th>a2a</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div id="fleet-msg"></div>
    </section>

    <script>
      async function fleetAct(action, name) {
        if (action === "stop" && !confirm("Stop + park " + name + "? (session keeps its transcript; restart resumes it)")) return;
        const msg = document.getElementById("fleet-msg");
        msg.textContent = action + " " + name + "…"; msg.style.color = "var(--text3,#888)";
        try {
          const r = await fetch("/api/fleet/action", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ action, name }) });
          const j = await r.json();
          msg.textContent = j.message || (j.success ? "done" : "failed");
          msg.style.color = j.success ? "#6ad36a" : "#e06c6c";
          setTimeout(() => location.reload(), j.success ? 2500 : 5000);
        } catch (e) { msg.textContent = "request failed"; msg.style.color = "#e06c6c"; }
      }
      document.querySelectorAll(".fa").forEach(b => b.addEventListener("click", () => fleetAct(b.dataset.act, b.dataset.name)));
      document.getElementById("fleet-refresh").addEventListener("click", () => location.reload());
      let t = setTimeout(() => location.reload(), 20000);
    </script>
  `;
  return layout("Fleet", body);
}
