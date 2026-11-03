// Tailscale device name → its dashboard base URL. Lets the Tailscale Devices
// widget render those rows as links so you can hop between dashboards
// (laptop ⇄ server). Keys must match the names `tailscale status`
// reports (MagicDNS hostnames).

export const DASHBOARDS: Record<string, string> = {
  "laptop": "http://100.64.0.2:3456",
  "server": "http://100.64.0.1:3456",
};
