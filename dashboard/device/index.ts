// Device auto-detect. Resolution order:
//   1. $DASHBOARD_DEVICE env var ('mac' | 'server')
//   2. os.hostname() substring match (laptop → mac, server → server)
//   3. hard error — never fall back silently

import os from "os";
import type { DeviceConfig } from "./types";
import { device as mac } from "./mac";
import { device as server } from "./server";
import { baseLog } from "../lib/log";

const KNOWN: Record<string, DeviceConfig> = { mac, server };

export function detect(): DeviceConfig {
  const envName = (process.env.DASHBOARD_DEVICE || "").trim().toLowerCase();
  if (envName) {
    const d = KNOWN[envName];
    if (!d) throw new Error(`DASHBOARD_DEVICE=${envName} but no matching device module. Known: ${Object.keys(KNOWN).join(", ")}`);
    baseLog.info(`device: ${envName} (via DASHBOARD_DEVICE)`);
    return d;
  }
  const host = os.hostname().toLowerCase();
  if (host.includes("laptop") || host.includes("macbook") || host.endsWith(".local")) {
    baseLog.info(`device: mac (via hostname=${host})`);
    return mac;
  }
  if (host.includes("server")) {
    baseLog.info(`device: server (via hostname=${host})`);
    return server;
  }
  throw new Error(`Cannot determine device for hostname=${host}. Set DASHBOARD_DEVICE=mac|server.`);
}

export type { DeviceConfig } from "./types";
