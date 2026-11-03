// /logs/<unit> — journalctl viewer scoped to a whitelist of systemd user units.

import { shell } from "../../lib/shell";
import { layout, esc } from "../../lib/html";

export function logsPage(allowedUnits: string[]) {
  return async function(unit: string): Promise<Response> {
    if (!allowedUnits.includes(unit)) {
      return layout("logs", `<p style="color:var(--red)">Unit not allowed: ${esc(unit)}</p>
        <p style="color:var(--text3)">Whitelisted: ${allowedUnits.map(esc).join(", ")}</p>`);
    }
    const { stdout, stderr } = await shell(
      ["journalctl", "--user", "-u", `${unit}.service`, "-n", "200", "--no-pager"],
      15_000
    );
    const body = `
      <h1 style="margin:8px 0 4px;color:var(--text);font-weight:500">journalctl · ${esc(unit)}</h1>
      <p style="color:var(--text3);font-size:12px;margin:0 0 10px">last 200 lines · <a href="/" style="color:var(--accent)">← back</a></p>
      <pre style="font-size:11px;color:var(--text2,#b8b8be);background:#0a0b0e;border-radius:4px;padding:10px;overflow:auto;white-space:pre-wrap;word-break:break-word">${esc(stdout || stderr || "(empty)")}</pre>
    `;
    return layout(`logs ${unit}`, body);
  };
}
