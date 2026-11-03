// server device config — ops/monitoring on the always-on Linux VM (systemd, Tailscale).

import { join } from "path";
import type { DeviceConfig } from "./types";

import { recentsWidget } from "../widgets/recents";
import { serversWidget } from "../widgets/servers";
import { sessionsWidget } from "../widgets/sessions";
import { gitWidget } from "../widgets/git";
import { servicesWidget } from "../widgets/services";
import { kaiTasksWidget } from "../widgets/kai-tasks";
import { systemWidget } from "../widgets/system";
import { tailscaleWidget } from "../widgets/tailscale";
import { DASHBOARDS } from "./dashboards";

import { logsPage } from "../pages/server/logs";
import { kaiSonProvider } from "./kai-son-provider";
import { serverFleetBackend } from "./fleet-server";

const HOME = process.env.HOME;
if (!HOME) throw new Error("$HOME not set on server device");

const REPO = join(HOME, process.env.DASHBOARD_REPO_DIR || "monorepo");
const KAI = join(HOME, "kai");
// The server's Tailscale IP. Set DASHBOARD_TAILSCALE_IP; the CGNAT-range default is a placeholder.
const TAILSCALE_IP = process.env.DASHBOARD_TAILSCALE_IP || "100.64.0.1";
const TAILSCALE_BIN = "/usr/bin/tailscale";  // Linux path (Mac uses /usr/local/bin)

const KAI_TASKS = join(KAI, "tasks.md");

const ALLOWED_LOG_UNITS = [
  "server-dashboard", "fleet-watchdog", "fleet-relay",
];

const logs = logsPage(ALLOWED_LOG_UNITS);

// Telegram: the single @example_son1_bot son (one-bot model; not a pool).
const tg = kaiSonProvider({
  sonHome: join(HOME, "kai-son-home"),
  botUsername: "example_son1_bot",
  tmuxSession: "kai-son",
  dir: REPO,
  claudeBin: join(HOME, ".local/bin/claude"),
});

export const device: DeviceConfig = {
  name: "server",
  hostname: process.env.DASHBOARD_HOSTNAME || TAILSCALE_IP,
  port: parseInt(process.env.DASHBOARD_PORT || "3456", 10),
  filesRoot: REPO,  // server file browser is scoped to monorepo only
  // HOME-overridden sessions write transcripts under their own home — scan those too.
  sessionRoots: [
    join(HOME, ".claude/projects"),          // kai (main)
    join(HOME, "kai-son-home/.claude/projects"),  // @example_son1_bot
  ],
  navLinks: [
    { href: "/",                       label: "Dashboard" },
    { href: "/sessions",               label: "Sessions" },
    { href: "/fleet",                  label: "Fleet" },
    { href: "/usage",                  label: "Usage" },
    { href: "/tg",                     label: "Telegram" },
    { href: "/files/",                 label: "Files" },
  ],
  widgets: [
    { id: "services",      title: "Services",                                                                              fn: servicesWidget({ units: [
      { label: "fleet-watchdog", units: ["fleet-watchdog.timer", "fleet-watchdog.service"] },
      { label: "fleet-relay",    units: ["fleet-relay.timer", "fleet-relay.service"] },
    ] }) },
    { id: "recents",       title: `Recent files <a href="/files/" style="float:right;font-size:12px">browse →</a>`,           fn: recentsWidget },
    { id: "sessions",      title: "Claude Sessions",                                                                          fn: sessionsWidget },
    { id: "tasks",         title: "Kai Tasks",                                                                                fn: kaiTasksWidget({ path: KAI_TASKS }) },
    { id: "git",           title: "Git Status",                                                                               fn: gitWidget({ repoPath: REPO }) },
    { id: "system",        title: "System",                                                                                   fn: systemWidget({}) },
    { id: "servers",       title: "Active Servers",                                                                           fn: serversWidget({ tailscaleIp: TAILSCALE_IP, platform: "linux" }) },
    { id: "tailscale",     title: "Tailscale Devices",                                                                        fn: tailscaleWidget({ binary: TAILSCALE_BIN, dashboards: DASHBOARDS, self: "server" }) },
  ],
  tg,
  // Shared cockpit (lib/fleet.ts) — replaces pages/server/fleet.ts (kai's
  // original, kept for reference); adds ping + the mac hop link.
  fleet: serverFleetBackend(),
  routes: async (url, _req) => {
    const p = url.pathname;
    const logsMatch = p.match(/^\/logs\/([a-z0-9-]+)$/);
    if (logsMatch) return logs(logsMatch[1]);
    return null;
  },
};
