// Mac device config — the laptop. Personal widgets + taildrop + a custom action hook.

import { join } from "path";
import { homedir, networkInterfaces } from "os";
import type { DeviceConfig } from "./types";
import { baseLog } from "../lib/log";

import { recentsWidget } from "../widgets/recents";
import { serversWidget } from "../widgets/servers";
import { tailscaleWidget } from "../widgets/tailscale";
import { gitWidget } from "../widgets/git";
import { sessionsWidget } from "../widgets/sessions";
import { actionsWidget, makeActionHandler } from "../widgets/actions";
import { kushbotProvider } from "./kushbot-provider";
import { readingPage, readerPage, readingApi, readingIcon, readingFile, readingThumb, readingAsset, readingAddPage } from "../pages/mac/reading";
import { readingAudioFile, readingAudioCues } from "../pages/mac/reading-audio";
import { readingStatic, readingSw, readingManifest, readingImg } from "../pages/mac/reading-offline";
import { DASHBOARDS } from "./dashboards";
import { macFleetBackend } from "./fleet-mac";

const HOME = process.env.HOME;
if (!HOME) throw new Error("$HOME not set on mac device");

const WORKDIR = join(HOME, "work");
const REPO = join(WORKDIR, "monorepo");
// The laptop's Tailscale IP. Set DASHBOARD_TAILSCALE_IP; the CGNAT-range default is a placeholder.
const TAILSCALE_IP = process.env.DASHBOARD_TAILSCALE_IP || "100.64.0.2";
const TAILSCALE_BIN = "/usr/local/bin/tailscale";

// Telegram session control via the kushbot pool. tier2 flips on once the
// request-watcher ships in the kushbot fork (enables headless detach + attach-existing).
const tg = kushbotProvider({
  channelsRoot: join(HOME, ".claude/channels/kushbots"),
  handleMap: {
    0: "example_laptop_bot",
    1: "example_laptop_son1_bot",
    2: "example_laptop_son2_bot",
    3: "example_laptop_son3_bot",
    4: "example_hunter_bot", // reddit-hunter standing agent (shared-HOME slot4, not ad-hoc pool)
  },
  spawnDirs: [
    { label: "work/", path: WORKDIR },
    { label: "monorepo", path: REPO },
    { label: "dashboard", path: join(WORKDIR, "tools/dashboard") },
    { label: "home (~)", path: HOME },
  ],
  tier2: true, // kushbot request-watcher is deployed → true detach + attach-existing
});

const actionConfig = {
  home: HOME,
  tailscaleBin: TAILSCALE_BIN,
  // customScript: join(WORKDIR, "bin/custom-action.sh"),  // optional; shows a "Run custom action" button
  taildropTargets: {
    phone: "phone",
    tablet: "tablet",
    server: "server",
  },
};

const actionHandler = makeActionHandler(actionConfig);

// Tailscale-down fallback ────────────────────────────────────────────────────
// Binding to TAILSCALE_IP fails outright when Tailscale is disconnected (bun
// surfaces it as a confusing EADDRINUSE), which used to leave the launchd job
// crash-looping every 10s with nothing serving at all. Serve on loopback
// instead so the Mac still works, then exit the moment the Tailscale IP comes
// back — launchd's KeepAlive restarts us bound to it, restoring phone access
// with no manual step. Read via os.networkInterfaces(), never the Tailscale
// CLI: that CLI blocks on the app's IPC outside an interactive session.
function tailscaleIpPresent(ip: string): boolean {
  try {
    return Object.values(networkInterfaces())
      .flat()
      .some((n) => n?.address === ip);
  } catch {
    return false;
  }
}

const TS_UP = tailscaleIpPresent(TAILSCALE_IP);
if (!TS_UP && !process.env.DASHBOARD_HOSTNAME) {
  baseLog.warn(
    `Tailscale IP ${TAILSCALE_IP} not on any interface — Tailscale looks disconnected. ` +
      `Serving on 127.0.0.1 only (no phone access). Reconnect Tailscale from the menu bar; ` +
      `this process exits within 15s of the IP returning and launchd rebinds it.`
  );
  setInterval(() => {
    if (tailscaleIpPresent(TAILSCALE_IP)) {
      baseLog.info(`Tailscale IP ${TAILSCALE_IP} is back — exiting so launchd rebinds to it.`);
      process.exit(0);
    }
  }, 15_000).unref?.();
}

export const device: DeviceConfig = {
  name: "mac",
  // Bind Tailscale-IP-only (not 0.0.0.0): /api/tg/spawn is effectively code-exec,
  // so the dashboard must not be LAN-reachable. The phone reaches it over Tailscale
  // from anywhere; the Mac reaches its own TS IP locally (statusline uses it too).
  // Override with DASHBOARD_HOSTNAME=0.0.0.0 only for local debugging.
  hostname: process.env.DASHBOARD_HOSTNAME || (TS_UP ? TAILSCALE_IP : "127.0.0.1"),
  port: parseInt(process.env.DASHBOARD_PORT || "3456", 10),
  filesRoot: HOME,
  navLinks: [
    { href: "/", label: "Dashboard" },
    { href: "/fleet", label: "Fleet" },
    { href: "/sessions", label: "Sessions" },
    { href: "/reading", label: "Reading" },
    { href: "/files/", label: "Files" },
    { href: "/files/work", label: "work/" },
    { href: "/files/work/monorepo", label: "monorepo" },
  ],
  widgets: [
    { id: "servers",   title: "Active Servers",                                                          fn: serversWidget({ tailscaleIp: TAILSCALE_IP, platform: "mac" }) },
    { id: "recents",   title: `Recent files <a href="/files/" style="float:right;font-size:12px">browse →</a>`, fn: recentsWidget },
    { id: "sessions",  title: "Claude Sessions",                                                         fn: sessionsWidget },
    { id: "git",       title: "Git Status",                                                              fn: gitWidget({ repoPath: REPO }) },
    { id: "tailscale", title: "Tailscale Devices",                                                       fn: tailscaleWidget({ binary: TAILSCALE_BIN, dashboards: DASHBOARDS, self: "laptop" }) },
    { id: "actions",   title: "Quick Actions",                                                           fn: () => actionsWidget(actionConfig) },
  ],
  action: actionHandler,
  tg,
  fleet: macFleetBackend(),
  routes: async (url, req) => {
    const p = url.pathname;
    if (p === "/reading") return readingPage(url);
    if (p === "/reading/item") return readerPage(url);
    if (p === "/reading/icon.svg") return readingIcon();
    // Offline. The chrome hangs off /reading rather than /static because a
    // service worker can only intercept inside its own scope, and the scope is
    // /reading — chrome served from /static could never come out of the cache.
    if (p.startsWith("/reading/static/")) return readingStatic(url);
    if (p === "/reading/sw.js") return readingSw();
    if (p === "/reading/manifest.webmanifest") return readingManifest();
    if (p === "/reading/img") return readingImg(url);
    if (p === "/reading/file") return readingFile(url);
    if (p === "/reading/add") return readingAddPage(url);
    if (p === "/reading/thumb") return readingThumb(url);
    if (p === "/reading/asset") return readingAsset(url);
    if (p === "/reading/audio") return readingAudioFile(url, req);
    if (p === "/reading/audio/cues") return readingAudioCues(url);
    if (p.startsWith("/api/reading/")) return readingApi(p, req, url);
    // /bookmarks was the earlier three-tab view; /reading replaced it.
    if (p === "/bookmarks") return Response.redirect("/reading", 302);
    return null;
  },
};
