// Device config contract. Each device module (mac.ts, server.ts) exports a `device: DeviceConfig`.
// The bootstrap (server.ts) picks one via `detect()` and registers its widgets + routes.

import type { TgProvider } from "../lib/tg";

export interface NavLink {
  href: string;
  label: string;
}

export interface WidgetRegistration {
  id: string;
  title: string;
  fn: () => Promise<string> | string;
}

export interface DeviceConfig {
  /** Identifier — 'mac' | 'server' | future */
  name: string;
  /**
   * Bind hostname. BOTH devices bind their Tailscale IP only, so the dashboard
   * is reachable on the tailnet and nowhere else. The Mac falls back to
   * 127.0.0.1 when Tailscale is down, which is a local-only degraded mode, not
   * the normal bind.
   */
  hostname: string;
  /** Listen port. Default 3456 across all devices. */
  port: number;
  /** Root the file browser is allowed to expose. Mac=$HOME, server=$HOME/monorepo. */
  filesRoot: string;
  /**
   * Extra `.claude/projects` roots for /sessions to scan + the viewer to allow, beyond the
   * default `$HOME/.claude/projects`. Needed when HOME-overridden sessions (server's son,
   * Vaidya) write their transcripts under a different home. Omit on Mac (sons share $HOME).
   */
  sessionRoots?: string[];
  /** Top nav links (Dashboard, Files, Sessions, plus device-specific shortcuts). */
  navLinks: NavLink[];
  /** Ordered widgets shown on the home dashboard. */
  widgets: WidgetRegistration[];
  /**
   * Optional extra routes (taildrop actions, server detail pages, etc.).
   * Return `null` if this device doesn't claim the path; the bootstrap then falls through
   * to the common routes (`/files`, `/session`, etc.) or 404.
   */
  routes?: (url: URL, req: Request) => Promise<Response | null>;
  /**
   * Action handler for /api/action/<name>. Mac uses this for taildrop + custom.
   * Return `null` to signal the action is unknown on this device.
   */
  action?: (name: string, body: unknown) => Promise<{ success: boolean; message: string } | null>;
  /**
   * Telegram session control. Mac = kushbot pool; server = one-bot-per-session.
   * When present, the bootstrap mounts /tg + /api/tg/*. Absent → those 404.
   */
  tg?: TgProvider;
  /**
   * Fleet cockpit (shared page, lib/fleet.ts). Mac = fleet/macctl backend;
   * server = ~/kai/fleet-ctl backend. When present, the bootstrap mounts
   * /fleet + /api/fleet/*. Absent → device.routes may still serve its own.
   */
  fleet?: import("../lib/fleet").FleetBackend;
}
