# /darbar — fleet review skill (DESIGN)

> Darbar: the court assembles, every subject reports, the ruler decides.
> On-demand review of both machines: servers, bots, git. Approved intent
> (the owner, 2026-07-14 Q&A): name **darbar** · **tiered** probing · actions are
> **proposed + tap-confirmed each** · **on-demand only** (no cron).

## Invocation

```
/darbar [scope] [domain] [--deep]
  scope:  local | server | both     (default: both on Mac, local on server)
  domain: server | bots | git | all (default: all)
  --deep: live-probe EVERY bot (default: tiered — probe only suspicious)
```

Runnable from terminal or TG (kc/kai). Output adapts: terminal = tables,
TG = compact card + `<blockquote expandable>` detail + action buttons.

## Architecture — scanner does the thinking, the model orchestrates

Two layers, deliberately:

1. **`scan.sh`** — ONE deterministic bash script, machine-agnostic
   (darwin/linux), `scan.sh --domain server|bots|git --json`. Emits strict
   JSON facts. No model judgment inside. Remote execution needs no install:
   `ssh server 'bash -s -- --domain bots --json' < scan.sh`.
2. **`SKILL.md`** — instructions simple enough for a mediocre model: run
   scanner → classify with the decision table → render template → propose
   actions via `ask` buttons → on tap, run the exact command from the action
   table → **verify** → report.

Why: every failure we hit this month (watchdog resuming a dead-auth session,
"healthy" bots that 401 on a real turn, false vaidya fix) came from *judgment
embedded in checks*. Facts and judgment are split so the judgment is visible,
documented, and overridable.

## Domain: server

Per machine, JSON keys → checks:

| key | source | flag when |
|---|---|---|
| disk_pct, disk_free | `df -h /` | >85% / <3G |
| ram_pct, swap | `vm_stat` (mac) / `free` (linux) | >90% |
| load1 vs cores | `uptime`, `nproc/sysctl` | load1 > cores |
| uptime_days | `uptime` | reboot <1h ago (unexpected?) |
| tailscale | `tailscale status --json` (Self.Online, peer server/laptop) | offline / peer unreachable |
| gateway | GET 127.0.0.1:8317/v1/models w/ client key | down / 0 models |
| services | server: `systemctl --user is-active cliproxyapi`, chat-bridge units, `systemctl --failed`; mac: dashboard :3456 probe, launchd backup agent loaded | inactive/failed |
| watchdog | server: systemd timer last-run + maint flags in `~/kai/state/` | timer dead; stale maint flag (expired epoch) |
| backups | last line of each backup log + `git -C <staging> log -1 --format=%ct` | >8 days old (weekly cadence + 1 grace) |
| oat | tail of oat-probe log | last probe FAIL |

## Domain: bots (session + TG bot health)

Enumerate from the fleet registry (server) + kushbot pool dirs (mac slots).
Per bot:

| field | source |
|---|---|
| engine | claude / **gateway** (pid env has `ANTHROPIC_BASE_URL`) / codex-bridge (tmux `codex-slot<N>`) |
| model · effort | kushbot status cache + `settings.json`/`~/.claude.json` effort |
| ctx %, 5h/7d | status cache (fleet-ctl already surfaces these) |
| tmux / claude pid / bun poller / claim | tmux has-session; pid alive (by HOME in `/proc/*/environ`, NOT argv patterns — the kai1 lesson); claim pid == live poller; orphan-poller sweep |
| account | work/personal — oat-active symlink target (server) / keychain acct (mac) |
| creds | credentials file present (not content) |
| last_activity | newest session-jsonl mtime + inbox mtime |
| parked? maint? | registry.parked, `state/maint-<name>` (with epoch validity) |

**SUSPICIOUS classification (decision table in SKILL.md):** any dead component
· claim/poller mismatch · model ≠ expected for engine · ctx unreadable while
claim held · last_activity gap >24h on an always-on bot · maint flag expired
but present · registry says parked but tmux alive (or inverse).

**Live probe (the truth serum):** inject a marker turn via tmux
(`darbar-probe-<nonce>: reply with the nonce`), poll pane ≤60s for the echo.
Catches: dead auth (401), wrong brain, wedged TUI — everything passive checks
missed this month. Default: only SUSPICIOUS bots. `--deep`: every bot.
NEVER probe a bot mid-turn (`esc to interrupt` visible in pane → skip, report
"busy — probe skipped").

## Domain: git

| repo group | checks | depth |
|---|---|---|
| **monorepo/ + every submodule** | branch, dirty file LIST, ahead/behind origin, submodule pointer drift vs parent | **deep**: per-file dirty summary + **suggested step commands** (exact copy-paste sequence: stage/commit/pull --rebase/push/submodule bump, in dependency order) |
| KushDarbar (both machines) | same + home-copy sync drift (md5 of server.ts vs repo — the "12 stale copies" check) | standard |
| data repos ×4 (claude-data, codex-data, *-server) | last auto-commit age vs cadence, push success from log | freshness only |

## Actions (all proposed → tap-confirm each, per Q3)

| action | command (exact, in SKILL.md) | verify after |
|---|---|---|
| respawn (fresh) | fleet-ctl start --fresh <bot> / mac tmux relaunch | **live probe must pass** |
| respawn (resume) | fleet-ctl start <bot> | live probe (401 risk — offer fresh first when auth-suspect) |
| kill | tmux kill-session + poller sweep by HOME-scoped pattern | procs gone, claim released |
| park / unpark | fleet-ctl park / registry edit | status reflects |
| clear stale claim | rm claim file (only if pid dead) | pool_status clean |
| clear leftover 👀 | clear-reaction.sh <chat> <msg> | — |
| set/remove maint flag | epoch write / rm | watchdog log skips/resumes |
| run backup now | the backup/*.sh script | log line ✓ pushed |
| restart gateway/watchdog | brew services / systemctl --user | health probe |
| disk relief | report top offenders only (delete = separate explicit ask) | — |

Rules: one action at a time · destructive (kill/park of a LIVE session) gets a
second confirm with the bot's last-activity shown · every respawn is verified
by live probe before reporting success (no false "fixed" — 2026-07-12 lesson).

## Cross-machine

Skill + scanner ship in KushDarbar (`skills/darbar/`), symlinked into each
machine's `~/.claude/skills/`. Mac reaches server via ssh (`server`);
server cannot reach Mac — `/darbar both` from kai degrades to server + a note.
SSH flake rule: retry once, then report the scan as UNREACHABLE (never guess).

## Output shapes

- **TG card:** header (machines · N bots ✅ / M ⚠️ / K 🔴) → per-domain compact
  lines → `<blockquote expandable>` full tables → action buttons (max 3-4
  proposals per message, ranked by severity).
- **Terminal:** aligned tables, same data, no buttons (inline y/n per action).
- JSON kept on disk (`~/kush/darbar-runs/<ts>.json` / `~/kai/darbar-runs/`)
  for diffing "since last darbar".

## Build plan (after design sign-off)

1. `scan.sh` server domain (both OSes) — smallest, proves the JSON contract
2. bots domain incl. engine detection + suspicious table + live probe
3. git domain incl. monorepo/ deep mode
4. `SKILL.md` (the mediocre-model runbook: templates, decision tables, action
   table, edge cases)
5. symlinks both machines + `/darbar both all` live demo to the owner on TG
