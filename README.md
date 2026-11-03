# KushDarbar

> ### ⚠️ Sanitized public copy
> This is a scrubbed copy of a private repo, published with **fresh history**.
> Secrets, bot tokens, chat ids, identities, hostnames, IPs, personal paths and
> personal/company data have been **removed or replaced with placeholders**
> (`example_parent_bot`, `OWNER_CHAT_ID`, `server`, `laptop`, `/home/owner`, ...).
> Some directories were deleted outright. Everything is listed in
> **[`REDACTIONS.md`](./REDACTIONS.md)**. Expect to fill in placeholders before running anything.

KushDarbar started as a fork of the official Claude Code Telegram channel plugin
(`telegram@0.0.6`, see [`UPSTREAM.md`](./UPSTREAM.md)) and grew into the repo for a
**fleet of Telegram-reachable agent sessions**: one bot per Claude Code (or Codex)
session, spread over two machines (an always-on Linux **server** and the owner's
**laptop**), with a controller, a watchdog, agent-to-agent mail, account/quota
tooling, a dashboard and backups around it.

## Repo map

| Path | What |
|---|---|
| `server.ts`, `src/` | The kushbot MCP server: Telegram poller + tools (`reply`, `react`, `edit_message`, `ask`, `download_attachment`, `pool_status`, `spawn`, `attach`, ...), slot pool, access control, A2A mail, `/model` `/quota` `/account` commands. |
| `broker.ts`, [`BROKER.md`](./BROKER.md) | Planned per-user sessions behind one bot token (not deployed). |
| [`ACCESS.md`](./ACCESS.md) | Allowlist / pairing / group semantics. |
| [`CLAUDE.md`](./CLAUDE.md) | Fleet operations doc: machines, slot model, restart, new-bot procedure, sync flow. |
| [`fleet/`](./fleet/README.md) | Ops layer: `fleet-ctl` (server), `macctl` (laptop), watchdog, creds-guard, relay, account switch, quota tools, statusline, systemd units, `move`. |
| [`codex-bridge/`](./codex-bridge/README.md) | Run a slot on OpenAI Codex instead of Claude Code. |
| [`gateway/`](./gateway/README.md) | `dcg`: GPT/Grok models inside Claude Code via CLIProxyAPI. |
| [`backup/`](./backup/README.md) | Session-history backup scripts (Claude + Codex, both machines). |
| [`dashboard/`](./dashboard/README.md) | Bun dashboard: fleet cockpit, accounts/usage, session viewer, read-later reader. |
| [`console/`](./console/README.md) | Raycast extension for sending to the fleet / contacts. |
| [`tgs/`](./tgs/README.md) | Telegram Saved Messages CLI. |
| [`skills/darbar/`](./skills/darbar/SKILL.md) | Fleet review skill. |
| [`docs/`](./docs/) | `move` design, parked roadmap. |
| [`RECOVERY.md`](./RECOVERY.md) | Rebuild-from-scratch runbook. |

## Quick start (one bot, one session)

Prerequisites: [Bun](https://bun.sh), Claude Code, a Telegram account.

1. **Create a bot** with [@BotFather](https://t.me/BotFather): `/newbot`, copy the token.
2. **Install deps:** `bun install` in this directory.
3. **Store the token** (never commit it):
   ```bash
   mkdir -p ~/.claude/channels/telegram
   printf 'TELEGRAM_BOT_TOKEN=%s\n' '<token>' > ~/.claude/channels/telegram/.env
   chmod 600 ~/.claude/channels/telegram/.env
   ```
4. **Allowlist yourself.** Find your numeric Telegram user id (e.g. via
   [@userinfobot](https://t.me/userinfobot)) and write
   `~/.claude/channels/telegram/access.json`:
   ```json
   {"dmPolicy":"allowlist","allowFrom":["<OWNER_CHAT_ID>"],"groups":{},"pending":{}}
   ```
   Details and the pairing flow: [`ACCESS.md`](./ACCESS.md).
5. **Attach a session:** install this directory as a local plugin
   (`~/.claude/plugins/local/kushbot`, wired by `.mcp.json`) and start Claude Code with
   ```bash
   claude --dangerously-load-development-channels server:kushbot
   ```
   DM the bot; the message arrives in the session, which answers with the `reply` tool.

For a multi-bot fleet (slot pool, sons with their own HOMEs, controller and watchdog)
read [`CLAUDE.md`](./CLAUDE.md) and [`fleet/README.md`](./fleet/README.md), starting
from [`fleet/registry.example.json`](./fleet/registry.example.json).

## License

Apache-2.0, as upstream (see [`LICENSE`](./LICENSE)).
