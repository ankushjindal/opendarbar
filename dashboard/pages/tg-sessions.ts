// GET /tg — Telegram session control surface (phone-first).
//   - "New session" form: pick a dir (allowlist) + slot (auto/N) → spawn a bot-attached session
//   - "Live pool": which bot is on which session, with detach + a DM deep-link
//   - "Attach existing" (Tier 2 only): live sessions not on a bot, attach to a free slot
// The authoritative answer to "what's on Telegram" lives here; /sessions row badges are hints.

import { layout, esc } from "../lib/html";
import type { TgProvider, TgBinding } from "../lib/tg";

function stateBadge(b: TgBinding): string {
  const color =
    b.state === "claimed" ? "var(--green,#6ad36a)" :
    b.state === "reserved" ? "var(--accent,#7eb3ff)" :
    "var(--text3,#888)";
  return `<span style="color:${color};font-size:11px;text-transform:uppercase;letter-spacing:.04em">${esc(b.state)}</span>`;
}

export async function tgSessionsPage(tg: TgProvider): Promise<Response> {
  const caps = tg.capabilities();
  let pool;
  try {
    pool = await tg.poolStatus();
  } catch (e: any) {
    return layout("Telegram", `<p style="color:var(--red)">pool error: ${esc(e.message)}</p>`);
  }

  const freeSlots = pool.bindings.filter((b) => b.state === "free" && !b.reserved);
  const dirOptions = caps.spawnTargets
    .map((t) => `<option value="${esc(t.path)}">${esc(t.label)}</option>`)
    .join("");
  const slotOptions =
    `<option value="">auto (first free)</option>` +
    freeSlots.map((b) => `<option value="${esc(b.id)}">${esc(b.label)} · @${esc(b.botUsername)}</option>`).join("");

  const poolRows = pool.bindings
    .map((b) => {
      const s = b.session;
      const dm = b.state === "claimed" || b.state === "reserved"
        ? `<a class="tg-dm" href="${esc(b.deepLink)}">DM →</a>`
        : "";
      const actions =
        b.state === "claimed" && !b.reserved
          ? `<button class="tg-detach" data-slot="${esc(b.id)}" title="take off Telegram, keep running">detach</button> <button class="tg-kill" data-slot="${esc(b.id)}" title="close the session entirely">close</button>`
          : b.reserved
          ? `<span class="dim" style="font-size:11px">protected</span>`
          : "";
      return `<tr>
        <td><strong>${esc(b.label)}</strong></td>
        <td>@${esc(b.botUsername)} ${dm}</td>
        <td>${stateBadge(b)}</td>
        <td><code class="tg-cwd">${esc(s?.cwd ?? "")}</code></td>
        <td>${esc(s?.tmuxSession ?? "")}</td>
        <td>${actions}</td>
      </tr>`;
    })
    .join("");

  const unboundSection =
    caps.canAttachExisting && pool.unbound.length
      ? `<section class="tg-card">
          <h2>Running sessions not on Telegram</h2>
          <table class="tg-table"><thead><tr><th>pid</th><th>cwd</th><th>tty</th><th></th></tr></thead><tbody>
          ${pool.unbound
            .map(
              (u) => `<tr>
              <td><code>${u.claudePid}</code></td>
              <td><code class="tg-cwd">${esc(u.cwd)}</code></td>
              <td>${esc(u.tty)}</td>
              <td><button class="tg-attach" data-pid="${u.claudePid}">attach →</button></td>
            </tr>`
            )
            .join("")}
          </tbody></table>
        </section>`
      : "";

  const attachSlotPicker =
    caps.canAttachExisting && freeSlots.length
      ? `<datalist id="free-slots">${freeSlots.map((b) => `<option value="${esc(b.id)}">`).join("")}</datalist>`
      : "";

  const tmuxWarn = pool.tmuxAvailable ? "" : `<p class="dim" style="font-size:12px">tmux server not running yet — it starts automatically on first spawn.</p>`;

  const body = `
    <style>
      .tg-card { background:var(--bg2,#14161b); border:1px solid var(--line,#2a2d33); border-radius:8px; padding:14px 16px; margin:14px 0; }
      .tg-card h2 { font-size:15px; font-weight:500; margin:0 0 10px; }
      .tg-row { display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
      .tg-row select, .tg-row button { font:inherit; padding:9px 12px; border-radius:6px; border:1px solid var(--line,#2a2d33); background:var(--bg3,#181a1f); color:var(--text,#d8d8db); }
      .tg-row select { flex:1 1 200px; min-width:160px; }
      .tg-row button, .tg-detach, .tg-attach { cursor:pointer; }
      #tg-spawn { background:var(--accent,#1c4e9c); border-color:var(--accent,#1c4e9c); color:#fff; font-weight:500; }
      .tg-table { border-collapse:collapse; width:100%; font-size:13px; }
      .tg-table th { text-align:left; color:var(--text3,#888); font-weight:normal; padding:6px 8px; border-bottom:1px solid var(--line,#2a2d33); }
      .tg-table td { padding:7px 8px; border-bottom:1px solid #1a1c20; vertical-align:middle; }
      .tg-cwd { font-size:11px; color:var(--text2,#b8b8be); word-break:break-all; }
      .tg-detach, .tg-attach, .tg-kill { font-size:11px; padding:4px 9px; border:1px solid var(--line,#2a2d33); border-radius:5px; background:var(--bg3,#181a1f); color:var(--text2,#b8b8be); cursor:pointer; }
      .tg-detach:hover, .tg-kill:hover { border-color:var(--red,#e06c6c); color:var(--red,#e06c6c); }
      .tg-dm { font-size:11px; color:var(--accent,#7eb3ff); text-decoration:none; margin-left:6px; }
      #tg-spawn-result { margin-top:12px; }
      .tg-deeplink { display:inline-block; margin-top:8px; padding:14px 22px; background:#1c4e9c; color:#fff !important; border-radius:12px; font-weight:600; font-size:16px; text-decoration:none; }
      .tg-msg { font-size:13px; margin:6px 0; }
    </style>

    <h1 style="margin:12px 0 2px;font-weight:500">Telegram sessions</h1>
    <p class="dim" style="font-size:12px;margin:0 0 6px">Spawn + control sessions over Telegram. <strong>detach</strong> = take off Telegram (session keeps running) · <strong>close</strong> = end the session + free the slot.</p>

    <section class="tg-card">
      <h2>New session</h2>
      <div class="tg-row">
        <select id="tg-dir">${dirOptions}</select>
        <select id="tg-slot">${slotOptions}</select>
        <button id="tg-spawn">Spawn</button>
      </div>
      ${tmuxWarn}
      <div id="tg-spawn-result"></div>
    </section>

    <section class="tg-card">
      <h2>Live pool <button id="tg-refresh" style="float:right;font-size:11px;padding:3px 9px;cursor:pointer">refresh</button></h2>
      <table class="tg-table">
        <thead><tr><th>slot</th><th>bot</th><th>state</th><th>cwd</th><th>tmux</th><th></th></tr></thead>
        <tbody>${poolRows}</tbody>
      </table>
    </section>

    ${unboundSection}
    ${attachSlotPicker}

    <script>
      const detachMode = ${JSON.stringify(caps.detachMode)};
      async function post(path, b) {
        const r = await fetch(path, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(b) });
        return r.json();
      }
      document.getElementById("tg-spawn").addEventListener("click", async () => {
        const dir = document.getElementById("tg-dir").value;
        const slot = document.getElementById("tg-slot").value || undefined;
        const out = document.getElementById("tg-spawn-result");
        out.innerHTML = '<p class="tg-msg dim">Spawning…</p>';
        try {
          const j = await post("/api/tg/spawn", { dir, slot });
          if (j.success === false) { out.innerHTML = '<p class="tg-msg" style="color:var(--red)">'+ (j.message||"failed") +'</p>'; return; }
          out.innerHTML = '<p class="tg-msg">'+ (j.message||"") +'</p>' +
            (j.deepLink ? '<a class="tg-deeplink" href="'+ j.deepLink +'">DM @'+ (j.botUsername||"bot") +'</a>' : '');
          setTimeout(() => location.reload(), 11000);
        } catch (e) { out.innerHTML = '<p class="tg-msg" style="color:var(--red)">request failed</p>'; }
      });
      document.querySelectorAll(".tg-detach").forEach(btn => btn.addEventListener("click", async () => {
        const slot = btn.dataset.slot;
        if (detachMode === "kill-session" && !confirm("This stops the whole session (slot "+slot+"). Continue?")) return;
        btn.textContent = "…";
        const j = await post("/api/tg/detach", { slot });
        alert(j.message || (j.success ? "done" : "failed"));
        location.reload();
      }));
      document.querySelectorAll(".tg-kill").forEach(btn => btn.addEventListener("click", async () => {
        const slot = btn.dataset.slot;
        if (!confirm("Close this session entirely ("+slot+")? Ends the Claude session and frees the slot.")) return;
        btn.textContent = "…";
        const j = await post("/api/tg/kill", { slot });
        alert(j.message || (j.success ? "done" : "failed"));
        location.reload();
      }));
      document.querySelectorAll(".tg-attach").forEach(btn => btn.addEventListener("click", async () => {
        const claudePid = parseInt(btn.dataset.pid, 10);
        const slot = prompt("Attach pid "+claudePid+" to which slot? (blank = auto)") || undefined;
        btn.textContent = "…";
        const j = await post("/api/tg/attach", { claudePid, slot: slot ? "slot"+slot.replace(/\\D/g,"") : undefined });
        alert(j.message || (j.success ? "done" : "failed"));
        location.reload();
      }));
      const rf = document.getElementById("tg-refresh");
      if (rf) rf.addEventListener("click", () => location.reload());
    </script>
  `;
  return layout("Telegram", body);
}
