# Kushbot fork — upstream tracking

## Source

Forked from: `claude-plugins-official/telegram` version **0.0.6**
Source path on disk (cache): `~/.claude/plugins/cache/claude-plugins-official/telegram/0.0.6/`

## Why fork (not patch upstream in place)

The cache dir gets overwritten when the upstream plugin updates, so any in-place patch is fragile. A fork lets us track upstream as a clean source while keeping our delta isolated.

## Delta vs upstream

The structural changes in `server.ts`:

1. **Token / bot lifecycle is dynamic, not boot-time.**
   - Removed `const TOKEN = process.env.TELEGRAM_BOT_TOKEN` and the `process.exit(1)` if missing.
   - Replaced with mutable `currentSlot`, `currentToken`, `currentBot`, `currentBotUsername`.
   - Plugin starts dormant. Polling begins only after `attach()`.

2. **State dir is per-slot, not single-rooted.**
   - Upstream uses `STATE_DIR = ~/.claude/channels/telegram` for a single `.env`, `access.json`, `inbox/`, `approved/`, `bot.pid`.
   - Fork uses `KUSHBOTS_ROOT = ~/.claude/channels/kushbots` containing `slot1/`, `slot2/`, ..., each with its own `.env`, `access.json`, `inbox/`, `approved/`, `claimed_by.pid`.
   - All path-using helpers (`assertSendable`, `loadAccess`, `saveAccess`, `checkApprovals`) read from `slotDir(currentSlot)`.

3. **Three new MCP tools:** `attach({slot?})`, `detach()`, `current()`.

4. **Auto-attach env var.** If `KUSHBOT_AUTO_ATTACH=<N>` is set at process boot, the server self-calls `attach({slot:N})` after MCP connection completes. Powers the spawn-on-demand workflow (`/spawn-attached-dc`).

5. **Free-slot picker.** `attach()` with no slot arg scans `slot{N}/claimed_by.pid` and picks the first slot whose pid file is missing or points to a dead PID.

6. **Slot ownership via `claimed_by.pid`.** Written on attach (this server's `process.pid`), removed on detach / clean shutdown. Pre-empts stale pollers (kills any live PID found there) before claiming.

7. **Handler registration is a function**, not module-scope. `registerHandlers(bot)` re-attaches all `bot.command()` / `bot.on()` handlers to the new Bot instance on each attach.

8. **Polling loop is per-attach**, not module-scope. `runBot(bot, slot)` retries with backoff and exits cleanly when `bot.stop()` is called (during detach or shutdown).

9. **Outbound tools resolve token from `currentToken`**, not the cached const. The `download_attachment` and inbound photo-download paths use `currentToken` for the file URL.

10. **`assertSendable` skips when no slot is bound** (nothing to leak), and points STATE_DIR at `slotDir(currentSlot)` otherwise.

11. **Shutdown calls `detach()`** so the slot frees for the next session.

## Files copied verbatim

- `package.json`, `bun.lock`, `node_modules/`, `LICENSE`, `.npmrc`, `.mcp.json`, `ACCESS.md`, `README.md` — copied from upstream. Only the plugin name in `.claude-plugin/plugin.json` changed (telegram → kushbot).

## Reused logic (semantics preserved)

- `gate()`, `pruneExpired()`, `isMentioned()`, `chunk()`, `safeName()`, `defaultAccess()`, the `Access` and `PendingEntry` types, the permission-relay flow (notification handler + callback_query inline-button handler), the `PERMISSION_REPLY_RE` text intercept, the typing/ack-reaction UX, and the orphan-watchdog interval — all functionally identical to upstream, just sourced from per-slot paths.
- The 4 reply tools (`reply`, `react`, `download_attachment`, `edit_message`) keep upstream input schemas.

## How to rebase on a future upstream version

1. Read the new upstream `server.ts` (in `~/.claude/plugins/cache/claude-plugins-official/telegram/<NEW>/`).
2. Diff against the version listed at the top of this file.
3. Cherry-pick non-conflicting changes (gate logic fixes, attachment handling, etc.) into our `server.ts`.
4. Anything that touches `TOKEN`, the `bot` const, `STATE_DIR`, or the polling loop needs to be re-expressed in slot-aware form.
5. Bump the version at the top of this file and commit.

## Audit log

### 2026-06-14 — upstream HEAD scan (no rebase)

Compared cached 0.0.6 against `anthropics/claude-plugins-official` HEAD `external_plugins/telegram/server.ts`. Single commit since 0.0.6:

- `5a71459c` (2026-04-23) `telegram: gate /start, /help, /status behind dmPolicy` — adds `dmCommandGate()` helper, makes the three commands silent for senders not on `allowFrom` when `dmPolicy === 'allowlist'`.
  - **Verdict: skip.** Kushbot's /status intentionally responds to unpaired senders with their sender ID + pairing instructions — that's the onboarding loop. Upstream's gate suppresses it. /start and /help carry similar (lighter) onboarding copy. The fork's existing per-command access checks (/compact /clear /reload already gate on `allowFrom`) cover the actual sensitive surface.

Nothing else upstream-side. Next rebase only needed if upstream ships a non-trivial change.

## When to retire the fork

If upstream ever grows native multi-bot support (token hot-swap or per-session state-dir override that's actually mid-flight callable), retire the fork. Until then, the delta is self-contained enough to maintain.
