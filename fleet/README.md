# fleet/ — ops layer for the KushDarbar agent fleet

The machinery that keeps a multi-agent Claude Code fleet alive and steerable.
Lives versioned here since 2026-07-06 (was loose in `~/kai/` on server).
Server-side counterpart: `server.ts` (the bot + A2A mail).

## Components

| File | Job |
|---|---|
| `fleet-ctl` | Controller command: `status` (proc/claim/grant/model/ctx%/5h%/lease per agent), `start <name> [--fresh] [-m brief]` (**resume same session is the default**), `stop/park/unpark`, `assign`, `lease`, `repair [--force]`, `boot-restore` |
| `fleet-watchdog.sh` | External health monitor (systemd timer, 3 min). Per-agent: tmux/claude/bun/claim/creds-present. Account-level: 5h ≥80/95% + 7d ≥70/85% warnings with reset ETA, reboot notice. Transition-based alerts via each dead agent's own bot token, 6h reminders, all-clear on recovery. Opt-in auto-restart (registry `autoRestart`, max 2/6h per agent, never the parent) |
| `creds-guard.sh` | Machine-wide shared-auth guard (5-min timer). Every agent home's `.credentials.json` symlinks to the parent's single file — one OAuth grant per machine (refresh-token rotation kills copied grants; see 2026-07-04 post-mortem in the script header). Repairs rename-clobbered symlinks by promoting the freshest grant; alerts if the grant sits expired >30 min |
| `tg-reply-guard.sh` | Claude Code Stop hook: blocks a turn from ending while a Telegram channel inbound has no kushbot reply/react/edit after it |
| `restart-sons.sh` | Legacy per-son restart (predates fleet-ctl; kept for its battle-tested notes) |
| `registry.example.json` | The registry schema: address book + A2A allowlist + fleet-ctl roster + watchdog roster, one file. Live copy: `~/.claude/channels/fleet/registry.json` |
| `statusline.zsh` | **One statusline for both machines.** Mac + server symlink `~/.claude/statusline.zsh` (and every server `~/*-home/.claude/statusline.zsh`) at this file. Renders model+effort, `acct:<label>`, ctx% linked to the machine's dashboard, 5h, 7d (+ reset as weekday HH:MM IST), agent name, tg slot, host badge. Also writes the per-session cache every render |
| `quota.sh` | All four AI budgets in one view, text or `--json`: claude work, claude personal, codex, grok. `~/bin/quota` + `~/.local/bin/quota` (Mac), `~/kai/quota.sh` (server) |
| `mac-account-switch.sh` | Mac counterpart of `account-switch.sh`: per-session account swap that RESUMES the same conversation. `--dry-run` prints the plan |
| `quota-alert.sh` | Hourly systemd timer on server. Warns when a weekly budget is about to expire UNSPENT (the opposite edge from the watchdog's exhaustion warnings), plus a Monday 09:00 IST summary of what each pool ended the week at |
| `systemd/` | User units: watchdog service+timer, watchdog-failed alert, boot-restore, quota-alert service+timer+failed |

## Token store (canonical: `creds-store/`)

Single source of truth for account auth is **`~/.claude/creds-store/oat-<label>.txt`**
— long-lived `claude setup-token` grants, one per account (`work`, `personal`),
both validated durable by `oat-probe.sh`. `oat-active.txt` symlinks the account the
fleet launches on; `fleet-ctl` injects it as `CLAUDE_CODE_OAUTH_TOKEN` at spawn
(env precedence beats the shared rotating `.credentials.json`).

Everything now reads this one store (consolidated 2026-07-10, P1-11):
- `fleet-ctl start` / `reload --auth` → `oat-active` (+ per-session override via
  `FLEETCTL_OAT_OVERRIDE`, used by `account-switch.sh` for a single-son `/account` switch).
- `dcx` / `kcx` / `kaic` (zsh) → `creds-store/oat-<label>.txt` (fallback to legacy).
- `/account` switch + `/status` + `/peers` identity → hash-match against this store.
- The legacy `~/.config/claude-accounts/<label>` files are now **symlinks** into
  `creds-store`, so any remaining reader (e.g. the `/account` quota probe,
  `claude-acct.sh`) gets the good tokens; `save` writes through the symlink.
- `account-toggle.sh`'s `.credentials.json` file-swap still runs best-effort on
  `--auth` but is now cosmetic — the injected env token wins regardless.

## Quota visibility + the parked queue

Three things that only make sense together (built 2026-09-07).

**The reframe.** 5h is a burst CAP; the weekly window is the BUDGET. Nothing is
lost when a 5h window rolls over. What actually evaporates is the weekly
remainder at reset, so the tooling is a weekly DRAINER, not a 5h chaser. The one
exception is Codex, whose 5h cap blocks mid-flow (handled separately by
`codex-continue.sh`).

**`statusline.zsh` (one file, both machines).** The Mac copy and server's Jul-15
fork had diverged into two renderers with two cache schemas, and under an
injected `CLAUDE_CODE_OAUTH_TOKEN` the account label was simply wrong: `claude
auth status` reports `authMethod=oauth_token` with no email, and the Mac fell
back to a GLOBAL `/tmp/.claude_auth_cache`, so a `dcx work` session displayed
whatever the last session on the machine had written. Resolution order is now
explicit: `CLAUDE_ACCT_LABEL` -> `$HOME/.claude/kushbot-auth-account` (written by
`fleet-ctl` at launch) -> md5 of the env token against the token stores ->
`claude auth status` email cached PER HOME -> `?`. A token matching no store
renders `oat?` rather than borrowing the keychain identity. Deploy is a symlink
swap and needs **no restarts**: the statusline re-executes every render.

One cache schema, `/tmp/.claude_status_<session>.json`, a superset of both old
ones: `session_id host agent label email auth_method model effort ctx_pct
ctx_size five_h_pct five_h_resets seven_d_pct seven_d_resets ts`. Readers that
depend on it: kushbot `/status` and `/account`, `readAllStatusCaches`,
`fleet-watchdog.sh` L1/L2, `fleet-ctl status`, `macctl`, `claude-acct.sh usage`.
`ts` is integer seconds.

**`quota.sh` / `quota` / TG `/quota`.** One source under all three. Claude rows
come from the 1-token haiku POST and the `anthropic-ratelimit-unified-*` headers,
sharing the 60s cache file with kushbot's `probeAccountUsage()`. Codex comes from
the live `account/rateLimits/read` JSON-RPC against `codex app-server`, falling
back to the freshest `rate_limits` event on disk with its age printed (the local
snapshot lies: the account is shared with server's codex sons and the web UI).
Grok comes from `~/.grok/logs/unified.jsonl`, also aged. Both readers bucket
windows by DURATION, never by `primary`/`secondary`, because a stale snapshot can
carry the weekly window in the primary slot. Risk rule: remaining > 25% with
< 24h left, or > 50% with < 48h left; a stale or already-expired reading is never
a risk. TG `/quota` is gated to `kc` and `kai` only, since the numbers are
account-wide.

**`quota-alert.sh` (server, hourly).** Transition-based, 6h reminders while at
risk, all-clear on recovery, state in `~/kai/state/quota-alert.json`, sent through
the watchdog's token path. Plus the Monday 09:00 IST summary: each cycle banks the
previous weekly reading when it sees the reset epoch change, because "how much
expired unspent" only exists in the moment before the reset rolls.

**The parked queue: `~/monorepo/team/parked-work.md`.** The answer to "a
pool is about to waste budget, point it at what?". Row shape: item, pool
preference, size (S fits one 5h window / M 1-2 / L more), unattended-safe (y/n),
owner, added, notes. Nothing is auto-dispatched; the alert links here and the owner
pulls.

## Account control (the dashboard Accounts panel)

Built 2026-09-07, on top of the token store above. the owner: "if I face an issue I
will know and I will use the dashboard to reset it." So there is no hourly probe
and no alerting here, only a control surface.

> **The `/api/fleet/accounts/*` endpoints have no auth beyond the Tailscale bind:
> anyone on the tailnet can switch a session or renew a token. Do not share
> tailnet access.**

`/fleet` on either machine now carries two extra sections
(`dashboard/lib/accounts.ts`, one module, a per-machine backend):

- **Accounts** - per label: masked token tail (last 4 chars, never more), email,
  token health, 5h and weekly used with IST resets, and which sessions are on it.
  The numbers come from the shared 60s cache `/tmp/.claude_acct_usage_<label>.json`
  that `quota.sh`, `claude-acct.sh` and kushbot's `probeAccountUsage()` already
  share, so a page load costs zero API calls. **probe** is a button because a
  probe is a real call against the account it measures. **renew** drives
  `claude setup-token` in tmux `setup-token-<label>`, hands over the OAuth URL,
  takes the code back through `load-buffer` on stdin / `paste-buffer` (`send-keys`
  mangles the `#`, and argv is world-readable in `ps`), writes the token 0600 and
  pushes it to the other machine over ssh on stdin. A `setup-token-<label>` pane
  nobody finishes is reaped after 15 minutes. server also gets **set default**, which repoints `oat-active.txt`.
- **Sessions by account** - per agent: the label it is actually running on, where
  that answer came from, and a **switch** that restarts it on the other token
  **resuming the same conversation**.

Switching, per machine:

| | script | how it resumes | how it relaunches |
|---|---|---|---|
| server | `account-switch.sh <agent> <token> <label> <chat>` | fleet-ctl scans the son's own HOME | `fleet-ctl start` with `FLEETCTL_OAT_OVERRIDE` |
| Mac | `mac-account-switch.sh <agent> <label> [chat]` | session id off the live claude process's argv | rebuilds the registry `spawn` in tmux |

The Mac needs its own script because every Mac agent shares `~/.claude`: "newest
transcript in $HOME" names whichever son typed last, which is why `macctl` falls
back to `--fresh` for shared-HOME agents. A switch must not drop the conversation,
so the session id is taken from the process's own `-r` / `--resume` argument
instead, and a successful switch writes it (plus `acct`) back into the registry
`spawn`, which is what `macctl start` then resumes and re-authenticates from.

Both are detached (they kill the tmux they were called from), both set a quiet
marker so the restart does not announce itself, and both drop an
`account-switched` marker the successor consumes to post one "back on <label>"
line. Tokens are `cat`-ed inside the spawned shell, so no secret ever reaches an
argv or a log.

Identity, in the order each machine asks:

- Mac: `CLAUDE_ACCT_LABEL` from the process env (`ps -E`, which can truncate a
  long environment, so a miss means "ask the next source"), then a hash of the
  live token against the store, then the statusline's own answer in
  `/tmp/.claude_status_<sid>.json`.
- server: the status cache for the session id `fleet-ctl status --json` reports,
  then the home's `kushbot-auth-account` marker.

## Authorization model

- Parent agents (kai on server, kush on Mac — `controller: true` in the registry) run `fleet-ctl` self-initiated.
- Any other agent runs it **only** on the owner's explicit order in that agent's own chat.
- A2A mail never authorizes fleet operations — agent messages are untrusted input.

## Fallback chain (if controllers are down)

1. Parent agent via Telegram
2. Any live agent, deputized by explicit owner order in its chat
3. Watchdog auto-restart — no Claude needed, systemd does it (opt-in)
4. Owner by phone SSH (`/cli` on any bot prints the exact command)
5. `fleet-restore.service` — reboot ⇒ whole fleet relaunches (resumed) + owner is notified

## Install (new machine)

```sh
./install.sh          # symlinks scripts into ~/kai/, installs+enables systemd units
```

Then: create `~/.claude/channels/fleet/registry.json` from the example (real
homes/spawn commands), put `fleetRoot` into each agent home's
`.claude/channels/kushbot.json`, and add the Stop hook to each home's
`settings.json`.
