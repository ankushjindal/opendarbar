// Tailscale devices widget (binary path differs by OS — see device configs).
//
// Devices listed in `dashboards` (laptop, server) render their name
// as a link to that device's dashboard, so you can hop between them. The current
// device (`self`) gets a "this" tag. Offline devices are never linked.

import { shell } from "../lib/shell";

export function tailscaleWidget(opts: {
  binary: string;
  /** Tailscale device name → dashboard base URL, for the cross-dashboard links. */
  dashboards?: Record<string, string>;
  /** This device's Tailscale name, tagged "this" in the list. */
  self?: string;
}) {
  const dashboards = opts.dashboards ?? {};
  return async function(): Promise<string> {
    const { stdout } = await shell([opts.binary, "status"]);
    if (!stdout.trim()) return `<p style="color:var(--red)">Tailscale not running</p>`;

    return stdout
      .trim()
      .split("\n")
      .filter((l) => l.trim())
      .map((line) => {
        const parts = line.trim().split(/\s{2,}/);
        const [ip, name, , os, status] = parts;
        const isOffline = status?.includes("offline");
        const dotClass = isOffline ? "offline" : "online";
        const statusText = isOffline ? status : os || "online";

        const dashUrl = dashboards[name];
        const isSelf = opts.self != null && name === opts.self;
        // Link the name to its dashboard when one exists and the device is up.
        // Same-tab navigation so the two dashboards feel like back/forward pages.
        const nameHtml = dashUrl && !isOffline
          ? `<a href="${dashUrl}" style="color:var(--accent);text-decoration:none"><strong>${name}</strong></a>`
          : `<strong>${name}</strong>`;
        const selfTag = isSelf ? ` <span style="color:var(--text3);font-size:10px">this</span>` : "";

        return `<div class="device">
          <span class="dot ${dotClass}"></span>
          <span>${nameHtml}${selfTag} <span style="color:var(--text3)">${ip}</span></span>
          <span style="color:var(--text3);margin-left:auto;font-size:11px">${statusText}</span>
        </div>`;
      })
      .join("");
  };
}
