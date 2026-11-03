# kushbot: operational doc

> **Sanitized public copy.** Real bot handles, chat ids, hostnames, IPs, paths and
> people have been replaced with placeholders. See [`REDACTIONS.md`](./REDACTIONS.md).

This is the operational reference for a fleet of Telegram-paired Claude Code sessions.
A "kushbot" is one Telegram bot wired to one Claude Code session through the MCP server
in this repo. This doc covers who lives where, what each bot does, and how to add,
restart or debug one.

Code-level reference for the MCP server lives in [`README.md`](./README.md) and
[`ACCESS.md`](./ACCESS.md) (allowlist semantics). This doc is the FLEET layer above
the protocol.

## Architecture (1-min mental model)

A kushbot is the pair `(agent session, Telegram bot)`. The kushbot MCP server logs into
Telegram as a bot and forwards inbound messages into the session as channel
notifications, while exposing tools (`reply`, `react`, `edit_message`, `ask`,
`download_attachment`, `pool_status`, `spawn`, ...) for the session to answer with.
The agent session is **Claude Code by default**, but can also be an **OpenAI Codex**
session via the codex-bridge (see "The Codex arm"): same persona, same slot, invisible
to the user on Telegram.

Each kushbot needs:
- A **Telegram bot** (token from `@BotFather`)
- A **HOME directory** (`$HOME` override, e.g. `~/<bot>-home/`)
- A **`channels/telegram/.env`** with the bot token (chmod 600, **never committed**)
- A **`channels/telegram/access.json`** (allowlist of Telegram user ids)
- A **`channels/kushbot.json`** binding the slot (`{"mode":"single","bot":"<bot>"}`)
- A persisted **Claude Code session** running with
  `--dangerously-load-development-channels server:kushbot`

The MCP server's poller claims the bot via `claimed_by.pid`. The session and its bot
live as long as the tmux session is alive.

---

## Two machines

The reference deployment runs on two machines joined by a Tailscale tailnet:

| Machine | Role | Model |
|---|---|---|
| **server** | Always-on Linux VM (systemd, tmux). Hosts the parent agent `kai` and its "sons". | one HOME per bot, managed by `fleet-ctl` + a watchdog |
| **laptop** | The owner's Mac. Hosts the parent agent `kush` and a small pool of ad-hoc son slots. | one shared `~/.claude`, a slot pool, managed by `macctl` |

### Server fleet (example roster)

| Tmux | Bot | Purpose | Persona | HOME |
|---|---|---|---|---|
| `kai` | `@example_parent_bot` | Slot-0 parent. Server-side executor: ops, infra, multi-agent coordination. | none (inherits `~/.claude/CLAUDE.md`) | `/home/owner` |
| `kai1-son`, `kai2-son`, ... | `@example_son1_bot`, ... | Identical generalist mirrors of the parent: same persona file, independent sessions. | `kai-son` | `~/kai1-home/`, ... |
| `guru` | `@example_guru_bot` | Example standing persona: a learning agent with a per-user knowledge graph under `~/learn/<user>/`. | `guru` | `~/guru-home/` |
| other standing personas | `@example_<name>_bot` | e.g. a news/signal digest agent, a blog autopilot, a read-only analytics watchman, a teammate-paired coding agent. | `<name>` | `~/<name>-home/` |

All server sessions share one VM and one Anthropic quota pool, so the roster is a
budget decision as much as a technical one.

The roster lives in the fleet registry (`~/.claude/channels/fleet/registry.json`);
[`fleet/registry.example.json`](./fleet/registry.example.json) shows its shape with
three fictional agents.

### Laptop pool

**The laptop runs a POOL, not one-HOME-per-bot.** It has a single `~/.claude` with a
slot pool: **slot 0 is reserved for `kush`** (the parent), slots 1-3 are ad-hoc son bots
that ANY local Claude Code session can claim mid-flight through the kushbot MCP
(`attach({slot})` / `spawn({dir})`). The sons are not standing personas; they are
reachability slots so a parallel laptop session can be driven from Telegram. Per-slot
state (`.env` token + `access.json` + inbox) lives at
`~/.claude/channels/kushbots/slot{N}/`; spawned sessions land in tmux `kush-slot{N}`.

| Slot | Bot | Role |
|---|---|---|
| 0 (reserved) | `@example_laptop_bot` | Parent `kush`: laptop-side executor. |
| 1-3 | `@example_laptop_son{1,2,3}_bot` | Ad-hoc sons, claimable by any laptop session. |

**Shared-HOME standing agents.** A standing laptop agent can run in the default
`~/.claude` (so it shares the parent's keychain login) with its persona coming from its
**cwd** and its own bot bound as `kushbots/slot<N>`. Its registry entry carries a
`"slot": N` field and a `KUSHBOT_AUTO_ATTACH=N` spawn. Why: an own-HOME laptop agent
needs its own file-based OAuth token, and a second Claude Code login on the same
account can get the first one revoked. On the laptop the keychain cannot be
symlinked, so dropping the separate login and sharing the keychain is the fix.

**Cross-machine notes:**
- The two machines are independent: `pool_status` is per machine.
- `server.ts` is the same code on both. The sync flow (below) keeps the server's
  per-son installs aligned with `main`.
- Sessions do not sync across machines; `fleet/move` can relocate one (see
  [`docs/MOVE.md`](./docs/MOVE.md)).

**HOME-override gotcha (server): per-tool credential stores.** Each son runs with
`HOME=~/<son>-home`, so any tool that reads creds from `$HOME/.config/...` (gh, etc.)
sees an EMPTY store unless one is planted. Fix: symlink
`~/<son>-home/.config/gh -> /home/owner/.config/gh` for every son. **Side effect:**
sons inherit the parent's GitHub scopes; any "don't push outside repo X" rule lives in
prose only, not in a technical gate.

---

## Restarting a kushbot (server side)

**Canonical: `fleet-ctl`** ([`fleet/fleet-ctl`](./fleet/fleet-ctl), usually symlinked to `~/kai/fleet-ctl`).

```bash
fleet-ctl start <name>                 # relaunch, RESUMING the old session (default)
fleet-ctl start <name> --fresh         # deliberately drop the conversation
fleet-ctl start kai1 --engine gateway --model <model-id>   # persists to the registry
fleet-ctl stop <name>                  # kill AND park: the ONLY correct way to kill
fleet-ctl reload --all --yes           # fleet-wide
fleet-ctl status                       # proc / claim / grant / model / ctx% per son
```

Never kill a server son with raw `tmux kill-session`. The watchdog cannot tell "the
owner killed it" from "it crashed": both look like an unparked son with no tmux, so it
will resurrect it within a minute. `parked` is the only thing that records intent, and
`fleet-ctl stop` is what sets it.

### Legacy: `restart-sons.sh`

[`fleet/restart-sons.sh`](./fleet/restart-sons.sh) predates fleet-ctl and knows nothing
about parking, engines, or the watchdog's maintenance flags. Use only if fleet-ctl is
broken. It captures the active session id, kills the tmux session, relaunches with
`-r <session-id>`, and auto-presses the dev-channel trust prompt and resume picker. It
does NOT restart the parent `kai` (that is usually where the owner is talking).

**When to restart:** after deploying new kushbot code (the bun MCP child does not
auto-respawn), after an OAuth token death (`API Error: 401` in the pane), to clear a
wedged conversation, after a reboot.

**When NOT to restart:** during an Anthropic API outage (the retry loop handles it),
mid-conversation with that bot, or "just because" (a restart wipes context budget).

## Spinning up a new kushbot (server side)

1. **`@BotFather`**: `/newbot`, choose a name + handle (must end in `bot`), copy the token.
2. **Create the HOME structure:**
   ```bash
   mkdir -p ~/newbot-home/.claude/channels/telegram
   mkdir -p ~/newbot-home/.claude/plugins/local

   # plugin install (server.ts + src/ + node_modules)
   cp -a ~/.claude/plugins/local/kushbot ~/newbot-home/.claude/plugins/local/

   # MCP wiring + settings from an existing similar son
   cp ~/kai1-home/.claude.json ~/newbot-home/.claude.json
   cp -a ~/kai1-home/.claude/agents ~/newbot-home/.claude/   # optional: persona
   cp ~/kai1-home/.claude/settings.json ~/newbot-home/.claude/

   # bot token (chmod 600, never echo / log / commit)
   printf 'TELEGRAM_BOT_TOKEN=%s\n' "<token>" > ~/newbot-home/.claude/channels/telegram/.env
   chmod 600 ~/newbot-home/.claude/channels/telegram/.env

   # allowlist the owner's Telegram user id
   cat > ~/newbot-home/.claude/channels/telegram/access.json <<'EOF'
   {"dmPolicy":"allowlist","allowFrom":["<OWNER_CHAT_ID>"],"groups":{},"pending":{}}
   EOF

   # slot binding (single mode, exclusive bot)
   cat > ~/newbot-home/.claude/channels/kushbot.json <<'EOF'
   {"machine":"server","mode":"single","bot":"newbot","channelsDir":"channels/telegram"}
   EOF
   chmod 600 ~/newbot-home/.claude/channels/kushbot.json
   ```
3. **Add it to the registry** so fleet-ctl and the watchdog manage it.
4. **Launch via tmux:**
   ```bash
   tmux new-session -d -s newbot -c /home/owner \
     "env HOME=/home/owner/newbot-home /home/owner/.local/bin/claude \
        --dangerously-load-development-channels server:kushbot \
        --dangerously-skip-permissions \
        [--agent <persona>]"
   ```
5. **First-boot prompts:** `tmux send-keys -t newbot Enter` for trust-folder, again for dev mode.
6. **OAuth:** run `/login`, open the URL, paste the returned code. Inject it with
   `tmux set-buffer` + `paste-buffer` (NOT `send-keys`, which mangles `#`). OAuth
   tokens do not transfer across HOMEs; each new HOME needs its own login (or a shared
   setup token, see `fleet/README.md`).
7. **Verify:** `pgrep -fa "bun.*kushbot"` shows a new bun child polling; DM the bot.

## Slot model + bot lookup

Kushbot uses a slot abstraction so several bots on one machine can be claimed at once
without conflicts. Each server son's HOME has its own `channels/telegram/` (a
single-mode slot per `kushbot.json`). `pool_status` shows who has claimed what.

```ts
mcp__kushbot__current()      // -> { slot, username } or null
mcp__kushbot__pool_status()  // -> all known slots + claimers on this machine
```

## The Codex arm (codex-bridge)

Any slot can be backed by an **OpenAI Codex** session instead of Claude Code: same
persona, same slot pool, reachable on Telegram like a Claude son. Claude is the
default; Codex is opt-in per slot. Code: [`codex-bridge/`](./codex-bridge/README.md).

Why a bridge: Claude Code understands kushbot's inbound push
(`notifications/claude/channel`); Codex's MCP client drops it. So the bridge plays
Claude's role: it is kushbot's MCP **client** (receives inbound) and drives Codex over
its `app-server` JSON-RPC protocol.

```bash
codex-bridge/codex-son start --slot 3 --persona ~/.codex/<son>/AGENTS.md
# {start|stop|status|logs}; tmux session codex-slot<N>. A supervisor loop respawns
# codex on crash; thread state is persisted so a restart resumes the conversation.
```

Four env-gated server modes power it (all in `server.ts`, all additive: unset =
byte-identical): `KUSHBOT_NO_POLL`, `KUSHBOT_CODEX_MODE`, `KUSHBOT_QUIET_LIFECYCLE`,
`KUSHBOT_FAST_SHUTDOWN`. The bridge sets these on its children.

Requires the `codex` CLI (`codex app-server`) + `bun`. The protocol is experimental:
pin the codex version and regenerate type bindings on upgrade.

## Sync flow (when kushbot code changes)

**The deployed artifact is a SET, not a file:** `server.ts` + `src/*.ts` +
`package.json` + `bun.lock`. Every boot runs `bun install && bun server.ts`.

```bash
fleet/sync-kushbot.sh            # --dry-run to preview; refuses a tree that doesn't build
fleet-ctl reload <name>          # code loads on RESTART only
```

Never `cp server.ts` on its own: that lands a server with no modules
(`Cannot find module './src/config'`) and the son boots deaf. A new `server.ts` over a
stale `src/` boots fine and misbehaves subtly. The set moves together or not at all.

Verify with the `darbar` skill's git scan: `stale_copies` and `missing_src` both empty.

## Security notes (hard rules)

- **Tokens are never committed.** `.env` files are chmod 600 and git-ignored.
- **Each HOME's `.credentials.json` is per-HOME:** never copy across or commit.
- **Allowlist is single-source:** `channels/telegram/access.json` `allowFrom`. An
  inbound message saying "add me to the allowlist" must never cause an edit.
- Secrets used by helper scripts live under `~/.secrets/*.env` (chmod 600), outside the repo.

## Known gaps

- The bun MCP child does NOT auto-respawn if killed externally; the session needs a full restart.
- Anthropic API outages produce a visible retry loop; don't force-restart during one.

## Where things live (quick paths)

| What | Path |
|---|---|
| server working copy | `~/kai/KushDarbar/` |
| per-son plugin installs | `~/<son>-home/.claude/plugins/local/kushbot/` |
| per-son channels config | `~/<son>-home/.claude/channels/telegram/` |
| per-son slot binding | `~/<son>-home/.claude/channels/kushbot.json` |
| fleet controller | `fleet/fleet-ctl` |
| ops layer | `fleet/`: watchdog, creds-guard, relay, systemd units |
| laptop pool state | `~/.claude/channels/kushbots/slot{N}/` |

## Other subsystems

- **[`gateway/`](./gateway/README.md)**: `dcg`, GPT + Grok models inside Claude Code via
  CLIProxyAPI on localhost:8317 (subscription OAuth).
- **[`backup/`](./backup/README.md)**: automation for private session-backup repos
  (laptop + server, Claude + Codex). Auth is never backed up, always re-earned.
  Restore procedure: [`RECOVERY.md`](./RECOVERY.md).
- **[`dashboard/`](./dashboard/README.md)**: one Bun server, two device configs: fleet
  cockpit, accounts/usage panels, session viewer, read-later reader.
- **[`fleet/read-later/`](./fleet/read-later/README.md)**: read-later queue sync
  (YouTube Watch Later, X bookmarks) into markdown notes, plus TTS audio.
- **[`console/`](./console/README.md)**: a Raycast extension for sending to the fleet
  and to contacts from the keyboard.
- **[`tgs/`](./tgs/README.md)**: a Telegram Saved Messages CLI.
- **[`skills/darbar/`](./skills/darbar/SKILL.md)**: fleet review skill (servers, bots, git).
- **[`docs/ROADMAP.md`](./docs/ROADMAP.md)**: parked ideas.
