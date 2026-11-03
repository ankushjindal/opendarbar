# home-dashboard

Personal multi-device dashboard. One Bun server, two machines (Mac + server), one codebase, device-aware widgets.

- **Mac** (`laptop`): personal widgets (recent files, tailscale, git, sessions) + taildrop actions + the read-later reader + the Claude Code session viewer.
- **server** (Linux VM, Tailscale-only): ops/monitoring widgets (systemd services, kai-tasks, server health) + journalctl viewer.

Shared on both: file browser, `/session` Claude Code transcript viewer, `/sessions` top-level CC session index.

## Quick start

```bash
cd dashboard        # this subtree of the repo
bun install
bun run server.ts
```

Browse at `http://localhost:3456/`, or at the machine's Tailscale IP (set `DASHBOARD_TAILSCALE_IP`) from other tailnet devices.

## Device detection

`server.ts` detects the device in this order:

1. `$DASHBOARD_DEVICE` env var (`mac` or `server`)
2. `os.hostname()` substring match (`laptop` → mac, `server` → server; edit `server.ts` to match your hostnames)
3. Hard error if neither matches — no silent fallback

Override for testing: `DASHBOARD_DEVICE=server bun run server.ts`.

## Routes

| Route | Devices | What |
|-------|---------|------|
| `/` | both | dashboard with device-specific widget cards |
| `/sessions` | both | top-level Claude Code session browser |
| `/session?file=…` | both | single-session transcript viewer (referenced by Claude Code statusline) |
| `/files/*` | both | file browser (scoped to `device.filesRoot`) |
| `/raw/*` `/download/*` | both | file serve |
| `/api/widget/<id>` | both | AJAX widget refresh (60s polling) |
| `/fleet` | both | fleet cockpit + the Accounts panel (accounts, token health, per-session account switch, token renewal) |
| `/api/fleet/accounts*` | both | accounts API: `probe`, `switch`, `renew`, `renew/code`, `renew/cancel`, `default` |
| `/api/save/<rel>` | both | inline file editor save |
| `/api/action/<name>` | mac | taildrop, optional custom script |
| `/logs/<unit>` | server | journalctl viewer (whitelisted units) |

## The Accounts panel

`lib/accounts.ts` renders under the fleet table on both machines: which Anthropic
account each session is burning, per-account token health and 5h/weekly usage,
a per-session switch that resumes the same conversation, and a `claude
setup-token` renewal flow. Each device supplies an `AccountsBackend`
(`device/fleet-mac.ts`, `device/fleet-server.ts`) for the parts that differ:
where tokens live, how a session id is found, and which script does the switch.
Full write-up in `../fleet/README.md`.

Two rules that module is built around: a token is never printed, logged,
returned or rendered (only its last 4 characters), and page loads read the
shared `quota.sh` probe cache rather than calling the API.

## Layout

```
device/        device detection + per-device configs (mac.ts, server.ts)
lib/           shared infra (html, files, shell, log, session viewer)
widgets/       one widget per file; device config picks which to load
pages/         multi-route view modules (sessions-index, server/*)
static/        global CSS
```

## Deploy

**Mac** (launchd):
```bash
cd ~/work/tools/dashboard
git pull
launchctl kickstart -k gui/$(id -u)/com.example.dashboard
```

**server** (systemd user):
```bash
cd ~/dashboard
git pull
systemctl --user restart server-dashboard.service
```

## Adding a widget

1. Create `widgets/<name>.ts` exporting `async function widget(): Promise<string>`.
2. Register in `device/mac.ts` or `device/server.ts` (or both) in the `widgets` array.
3. Restart.

## Adding a device

1. Create `device/<name>.ts` exporting a `DeviceConfig`.
2. Add detection rule in `device/index.ts`.
3. Set `DASHBOARD_DEVICE=<name>` on the new machine.
