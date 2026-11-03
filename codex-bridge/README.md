# codex-bridge — the Codex arm of KushDarbar

Makes an OpenAI **Codex** `app-server` session act as a kushbot son: same persona,
same slot pool, reachable on Telegram **exactly like a Claude son**. Claude stays
the default engine; Codex is opt-in per slot.

The bridge is the host-side counterpart to the four env-gated modes in the kushbot
server (`../server.ts`): `NO_POLL`, `CODEX_MODE`, `QUIET_LIFECYCLE`, `FAST_SHUTDOWN`.
With none of those set the kushbot server behaves byte-identically to before, so the
Claude pool is unaffected.

## Why a bridge exists

Claude Code understands a proprietary MCP notification (`notifications/claude/channel`)
that kushbot uses to push inbound Telegram messages into the session. **Codex's MCP
client silently drops it.** So kushbot's outbound tools port to Codex as-is, but the
*inbound* leg had to be rebuilt. The bridge plays the role Claude Code plays: it is
kushbot's MCP **client** (so it receives that notification) and drives Codex over the
`app-server` JSON-RPC protocol.

## Architecture

The bridge holds three connections:

1. **Codex `app-server`** — JSON-RPC over newline-delimited JSON (JSONL) on stdio.
   The bridge spawns `codex app-server`, starts (or resumes) a thread seeded with the
   son's persona (`--persona`, e.g. `~/.codex/kush3/AGENTS.md`), and injects each
   inbound message as a user turn prefixed with a routing header.
2. **Codex's own kushbot MCP** — the bridge gives Codex the kushbot server
   **session-scoped** (via `-c mcp_servers.kushbot.*` launch overrides, never global
   `~/.codex/config.toml`), in `NO_POLL` outbound-only mode, so Codex issues its OWN
   `reply`/`react`/`edit_message`/`ask`/`send_to_agent`/`download_attachment` calls.
3. **The bridge's own kushbot MCP client** — spawns kushbot as the INBOUND poller
   (`KUSHBOT_AUTO_ATTACH=<slot>`), receives inbound Telegram + agent-to-agent messages
   as `notifications/claude/channel`, and is the fallback outbound path.

**Hard constraint:** Telegram allows one `getUpdates` consumer per bot token. The
inbound child is the sole poller + owns the slot claim. Codex's `NO_POLL` child shares
the same slot but never polls/claims — send-only, so no 409 conflict.

**Flow:** inbound TG msg → kushbot notification → bridge adds routing header →
codex `turn/start` → codex (as the son) calls `mcp__kushbot__reply` itself → bridge
sees the reply tool-call and does **not** relay. If codex issued no reply tool-call
but produced `agentMessage` text, the bridge relays it (fallback — no silent drops).
Turns are serialized (one at a time per thread).

## What works

- **Messaging** — inbound text → codex turn → codex replies via its own tools.
- **Eye-react (👀)** — the inbound child auto-adds 👀 on delivery (`access.ackReaction`,
  which the bridge sets on startup and removes on shutdown). The bridge clears it on
  `turn/completed` using the slot's own bot token (see Notes).
- **Commands** (`CODEX_MODE`) — `/stop /clear /model /effort /compact` from Telegram are
  emitted by the kushbot server as `meta.source="command"` notifications (not tmux
  send-keys) and mapped by the bridge to app-server methods:
  - `/stop` → `turn/interrupt` (only if a turn is running)
  - `/clear` → new `thread/start` (fresh thread; persisted id updated)
  - `/compact` → `thread/compact/start`
  - `/model [name]` → sets a persisted **`turn/start` model override** (applied on the
    next turn); no-arg → `model/list` → tappable buttons via `ask`
  - `/effort [low|medium|high]` → persisted `turn/start` effort override; no-arg → buttons
  - Note: `thread/settings/update` does **not** exist in the protocol — model/effort are
    `turn/start` overrides that persist "for this and subsequent turns".
- **Attachments** — inbound images become a `localImage` turn input (codex actually
  *sees* them); voice is auto-transcribed and inlined; other files are noted with their
  on-disk path. Outbound: codex's `reply` supports `files:[…]`.
- **Agent-to-agent** — inbound agent mail (`meta.source="agent"`) gets its own routing
  header + trust framing and is injected as a turn; codex replies via `send_to_agent`
  (hops+1, max 2). Treated as untrusted input.
- **Resume across restarts** — the threadId is persisted to
  `<persona-dir>/.thread-state-slot<N>.json`. On startup the bridge `thread/resume`s it
  (falls back to a fresh `thread/start` if the thread has no persisted rollout yet), so
  a restart/crash doesn't wipe the conversation.

## Durable operation — `codex-son`

`codex-son` runs the bridge under a tmux supervisor loop (auto-respawn on crash;
resume restores context). This is the recommended way to run it in production.

```
codex-son {start|stop|status|logs} [--slot N] [--persona PATH] [--cwd DIR] [--home DIR]
```

- `start` — preflight (persona + slot token exist, slot is FREE — refuses to stomp a
  live session, no existing tmux session), then launches
  `while true; do bun bridge.ts …; sleep 2; done` in tmux `codex-slot<N>` (distinct
  from the Claude pool's `kush-slot<N>`).
- `stop` — kills the tmux session (fast, clean shutdown via `FAST_SHUTDOWN`), then a
  belt-and-suspenders sweep clears any stale (dead-pid only) claim + leftover 👀.
- `status` / `logs` — session + slot + ackReaction state; pane dump.

Defaults are slot 3 / kush3, so a bare `codex-son start` is a smoke test.

`com.example.codex-son.slot3.plist` is a launchd alternative to the tmux loop, left
**unloaded** (Mac login-session caveat documented inline; the tmux loop is preferred).

## Run directly (without the launcher)

Nothing is hardcoded to a slot/persona/cwd/home — any slot (incl. slot 0 = parent) can
be Codex-backed. Both `--flag V` and `--flag=V` forms are accepted.

```
bun bridge.ts [--selftest | --selftest-reply] [--slot N] [--persona PATH] [--cwd DIR] [--home DIR]

  --selftest        Codex half only (no kushbot, no Telegram, no slot). Phase-1 gate.
  --selftest-reply  Load NO_POLL kushbot MCP into codex, inject a turn with a BOGUS
                    chat_id, prove codex ISSUES mcp__kushbot__reply. No poll/claim/ping.
  --slot N          kushbot slot to auto-attach (KUSHBOT_AUTO_ATTACH). Default 3. Slot 0 valid.
  --persona PATH    File read for developerInstructions. Default ~/.codex/kush3/AGENTS.md
  --cwd DIR         Codex thread working directory. Default $HOME
  --home DIR        HOME override for the kushbot child env (server one-HOME-per-bot). Default $HOME
  -h, --help        Show help.
```

Live single run (bare = slot 3 / kush3 — starts an INBOUND poller; one poller per slot):

```bash
bun /Users/owner/.claude/plugins/local/kushbot/codex-bridge/bridge.ts
```

## The four server modes (in `../server.ts`, all env-gated + additive)

| Env var | Effect |
|---|---|
| `KUSHBOT_NO_POLL=1` | Attach a slot the inbound child already owns, expose ONLY the messaging tools, never poll/claim/writeStatus, never touch the inbound claim on detach. |
| `KUSHBOT_CODEX_MODE=1` | Route `/model /effort /stop /clear /compact` to a `meta.source="command"` notification (for the bridge) instead of tmux send-keys. |
| `KUSHBOT_QUIET_LIFECYCLE=1` | Suppress the attach/detach owner pings (a persistent bridge shouldn't spam online/offline). |
| `KUSHBOT_FAST_SHUTDOWN=1` | On detach, release the claim + clear status FIRST, then stop the bot fire-and-forget. Teardown 5s+ → ~16ms; never orphans the claim. |

Unset, every one of these is a no-op — the kushbot server is byte-identical to upstream.

## Files

- `bridge.ts` — the whole program: codex app-server JSONL client, kushbot MCP client,
  routing headers, command mapping (`SessionController`), eye-react, attachments,
  A2A, thread persistence/resume, `--selftest` / `--selftest-reply`.
- `codex-son` — durable tmux-supervised launcher.
- `com.example.codex-son.slot3.plist` — launchd alternative, unloaded.
- `package.json` / `bun.lock` — declares `@modelcontextprotocol/sdk`. `node_modules` is gitignored.
- `validate-*.ts` — isolation regression checks (controller, app-server, phase4, crash-resume).

Personas live outside the repo at `~/.codex/<son>/AGENTS.md` (codex config; backed up
by codex-data).

## Notes

- **Reaction clearing uses the slot's own token directly.** `clear-reaction.sh`
  auto-detects the slot via a `claude` process ancestor + `_status` file, which the
  bridge's process tree lacks (it would fall back to slot0's bot). The bridge reads
  `slotN/.env` and calls `setMessageReaction reaction:[]` itself.
- The bridge clears ALL reactions on a message at turn end, so a mid-turn `react` from
  codex is cleared along with the 👀.
- All activity is logged verbosely with timestamps to stderr. SIGINT/SIGTERM/SIGHUP
  remove the ackReaction, close the MCP client, and kill the codex child (fast).
