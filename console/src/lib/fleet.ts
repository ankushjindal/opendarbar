/**
 * Fleet client — reads the KushDarbar dashboards (Mac + server) over Tailscale. Same JSON the
 * dashboard's /fleet page renders (dashboard/lib/fleet.ts FleetStatus), no second scanner.
 * URLs mirror dashboard/device/dashboards.ts.
 */

export type Machine = { key: "mac" | "server"; label: string; url: string };

export const MACHINES: Machine[] = [
  { key: "mac", label: "Mac", url: "http://100.64.0.2:3456" },
  { key: "server", label: "server", url: "http://100.64.0.9:3456" },
];

export type FleetAgent = {
  name: string;
  up: boolean;
  tmux: boolean;
  claim: string;
  parked: boolean;
  lease: string;
  model: string;
  ctx: number | null;
  fiveH: number | null;
  session: string;
  outbox: number;
  kind?: string; // parent | standing | pool (mac only)
  tmuxName?: string;
};
export type FleetStatus = {
  ts: number;
  watchdog: { lastCycle: string; alerts6h: number };
  agents: FleetAgent[];
};
export type FleetResult = { success: boolean; message: string };
export type FleetAction = "start" | "restart" | "stop" | "park" | "unpark";

async function http<T>(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  const { timeoutMs = 3000, ...rest } = init;
  const r = await fetch(url, {
    ...rest,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return (await r.json()) as T;
}

export function fetchStatus(m: Machine): Promise<FleetStatus> {
  return http<FleetStatus>(`${m.url}/api/fleet/status`, { timeoutMs: 4000 });
}

export function fleetAction(
  m: Machine,
  action: FleetAction,
  name: string,
  fresh = false,
): Promise<FleetResult> {
  return http<FleetResult>(`${m.url}/api/fleet/action`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, name, fresh }),
    timeoutMs: 90_000,
  });
}

export function fleetPing(m: Machine, name: string): Promise<FleetResult> {
  return http<FleetResult>(`${m.url}/api/fleet/ping`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
    timeoutMs: 90_000,
  });
}

export function fleetSpawn(
  m: Machine,
  o: { engine: string; dir: string; slot?: number },
): Promise<FleetResult> {
  return http<FleetResult>(`${m.url}/api/fleet/spawn`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(o),
    timeoutMs: 60_000,
  });
}

export function isParent(a: FleetAgent): boolean {
  return a.name === "kc" || a.name === "kai";
}

/** "3m" · "2h" · "—" */
export function ageOf(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const m = Math.max(0, Math.round((now - t) / 60000));
  return m < 60 ? `${m}m` : `${Math.round(m / 60)}h`;
}
