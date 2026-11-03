// Systemd user-services health widget (server only).
// Polls a configured list of units, renders status indicator + last-exit / next-trigger.

import { shell } from "../lib/shell";
import { esc } from "../lib/html";

export interface ServiceUnit {
  /** Display label (e.g. "chat-bridge"). */
  label: string;
  /** Unit names to query (one or more — e.g. timer + paired service). */
  units: string[];
}

export function servicesWidget(opts: { units: ServiceUnit[] }) {
  return async function(): Promise<string> {
    const rows = await Promise.all(opts.units.map(renderUnit));
    return rows.join("");
  };
}

async function renderUnit(u: ServiceUnit): Promise<string> {
  const parts = await Promise.all(u.units.map(queryUnit));
  // Combined: dot color is the "worst" across all units; details are concatenated.
  const dotClass = parts.some(p => p.state === "failed")
    ? "offline"
    : parts.some(p => p.state === "activating")
      ? "warn"
      : parts.every(p => p.state === "active")
        ? "online"
        : "offline";

  const details = parts.map(p => {
    const sub = p.subState ? `<span style="color:var(--text3);font-size:11px"> · ${esc(p.subState)}</span>` : "";
    const exit = p.lastExit ? ` <span style="color:var(--text3);font-size:11px">(exit ${esc(p.lastExit)})</span>` : "";
    const next = p.nextTrigger ? ` <span style="color:var(--text3);font-size:11px">next ${esc(p.nextTrigger)}</span>` : "";
    return `<div style="font-size:11px;color:var(--text2,#b8b8be)">${esc(p.name)}${sub}${exit}${next}</div>`;
  }).join("");

  return `<div class="device">
    <span class="dot ${dotClass}"></span>
    <span><strong>${esc(u.label)}</strong>${details}</span>
  </div>`;
}

interface UnitState {
  name: string;
  state: string;          // active / inactive / failed / activating / unknown
  subState: string;
  lastExit: string;
  nextTrigger: string;
}

async function queryUnit(name: string): Promise<UnitState> {
  const { stdout } = await shell([
    "systemctl", "--user", "show", name,
    "--property=ActiveState,SubState,ExecMainStatus,NextElapseUSecRealtime,Result",
  ]);
  const kv: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    kv[line.slice(0, eq)] = line.slice(eq + 1).trim();
  }
  return {
    name,
    state: kv.ActiveState || "unknown",
    subState: kv.SubState || "",
    lastExit: kv.ExecMainStatus && kv.ExecMainStatus !== "0" ? kv.ExecMainStatus : "",
    nextTrigger: kv.NextElapseUSecRealtime && kv.NextElapseUSecRealtime !== "0" ? kv.NextElapseUSecRealtime : "",
  };
}
