---
name: darbar
description: Fleet review — servers, bots, git across Mac + server. Scans, classifies, proposes tap-confirmed fixes. Use when the owner says /darbar, "review the fleet", "how are the bots", "server health", "is everything ok".
---

# /darbar — hold court over the fleet

You run a deterministic scanner, classify its facts with the tables below,
render a report, and propose fixes as **tap-confirmed buttons**. You never act
without a confirmation tap/yes. You never report a fix as done without the
verify step passing.

**Parse the invocation:** `/darbar [scope] [domain] [--deep]`
- scope: `local` | `server` | `both`
- domain: `server` | `bots` | `git` | `all`
- `--deep`: live-probe EVERY bot (default: only SUSPICIOUS ones)

## Step 0 — bare invocation? ASK FIRST (the owner, 2026-07-14)

If invoked with NO arguments, do not scan yet — ask two questions so the
review is targeted:

1. **Scope** (single-select): `both (rec)` / `local` / `server`
2. **Review modes** (MULTI-select): `server health` / `bots + TG sessions` /
   `bots — deep (live-probe every bot)` / `git status`

How to ask: **terminal** → one AskUserQuestion call carrying both questions
(Q2 with multiSelect:true). **TG** → two kushbot `ask` messages (single-select;
for Q2 offer: `all` / `server` / `bots` / `bots deep` / `git` / `server+bots` /
`bots+git`). Free-text answers override buttons.

Explicit arguments skip Step 0 entirely (`/darbar server bots` just runs).

**Depth rule:** ONE selected mode ⇒ detailed report (full per-item tables,
every advice row, more proposals — up to 6). TWO+ modes ⇒ compact card, top
3-4 proposals, details in expandable/collapsed sections.

## Step 1 — scan

Scanner lives next to this file: `scan.py`. It outputs pure facts as JSON.

```bash
# local machine
python3 <skilldir>/scan.py --domain all

# server from the Mac (no install needed — piped over ssh)
ssh server 'python3 - --domain all' < <skilldir>/scan.py
```

SSH rule: if ssh fails, retry ONCE, then report server as UNREACHABLE — never
substitute guesses or stale data. Save each scan to
`~/kush/darbar-runs/<ts>-<machine>.json` (Mac) / `~/kai/darbar-runs/` (server)
so the next darbar can say "since last time".

## Step 2 — classify

### server flags

| fact | flag when | severity |
|---|---|---|
| disk.pct_used / free_gb | >85% or <3G | 🔴 (propose disk relief) |
| ram.pct_used | >90% | ⚠️ |
| load.load1 | > cores | ⚠️ (note top process) |
| uptime.days | <0.05 (~1h) | ⚠️ "unexpected reboot?" |
| tailscale | self_online false or peer_online false | 🔴 |
| gateway | installed && !up, or models==0 | ⚠️ (bots on gateway engine → 🔴) |
| services | anything "down"/"inactive"/"NOT LOADED"/failed>0 | ⚠️ |
| watchdog.maint_flags | valid:false (expired flag still present) | ⚠️ propose remove |
| backups.*.last_commit_age_h | >192 (8 days) | ⚠️ propose run-now |
| oat.tail | contains FAIL | 🔴 |

### bot SUSPICIOUS table — any row true ⇒ SUSPICIOUS ⇒ live-probe it

| check | field(s) |
|---|---|
| tmux dead (and not parked) | tmux:false, parked:false |
| claude pid missing | pid:null while tmux:true |
| poller dead / claim mismatch | poller_pids empty, or claim.alive:false, or claim.matches_poller:false |
| model unreadable | model AND pane_model both null |
| engine surprise | engine:gateway but you/the owner expect claude for this bot (kai1+kush1 are gateway BY DESIGN right now) |
| creds missing | creds_present:false (claude engine only; gateway doesn't need it) |
| stale always-on | last_activity_h > 24 for kai/kc; > 72 for other sons (vaidya etc. are sporadic — note, don't alarm) |
| maint flag expired | maint_flag.valid:false |
| parked mismatch | parked:true but tmux:true (or inverse) |

### live probe — the truth serum (passive checks LIE; see 2026-07-14 watchdog incident)

Only on SUSPICIOUS bots (all bots with `--deep`). NEVER when `busy:true`
(report "busy — probe skipped" instead; a probe would inject into the owner's
live turn).

```bash
# 1. inject a marker turn (text first, Enter separately — one call swallows it)
tmux send-keys -t <tmux_name> "darbar-probe: reply with exactly PROBE-<nonce> and nothing else"
sleep 1 && tmux send-keys -t <tmux_name> Enter
# 2. poll ≤60s for the echo
tmux capture-pane -t <tmux_name> -p -S -20 | grep "PROBE-<nonce>"
```

(nonce = any 6 random chars you make up). Echo appears → ALIVE. 401/login text
in pane → AUTH-DEAD (respawn **fresh**, never resume — resume re-adopts dead
auth). No echo, no error → WEDGED (propose respawn, offer resume first).
On server prefix with `ssh server '...'`.

### git advice table (monorepo/ in depth)

| state | advise (exact commands, copy-paste order) |
|---|---|
| dirty submodule | `cd <sub> && git add -A && git commit` (show the dirty list; the owner words the message) → push → parent bump: `cd <parent> && git add <sub> && git commit -m "<sub>: bump" && git push` |
| behind upstream | `git pull --rebase origin <branch>` (warn if also dirty: stash or commit first) |
| ahead + clean | `git push origin <branch>` |
| submodule drift (+/- prefix in git submodule status) | `git submodule update --init <sub>` (pointer behind) or commit the bump (pointer ahead) |
| KushDarbar stale_copies non-empty | propose the sync action below |
| detached HEAD anywhere | STOP — report only, let the owner decide |

claude-data/codex-data dirty counts are NORMAL (session churn between weekly
auto-commits) — only flag if last_commit_age_h > 192.

## Step 3 — render

TG (kc/kai chat): compact card, worst news first. Terminal: same content as tables.

```
🏛 darbar · mac + server · 14:32
🔴 2  ⚠️ 3  ✅ 14 bots · servers ok · git: 2 need action

🔴 vaidya AUTH-DEAD (401 on probe) → [respawn fresh?]
🔴 server disk 6.9G free → [show top offenders?]
⚠️ 11 kushbot home copies stale vs repo → [sync now?]
⚠️ kush2 ctx 82% → [suggest /compact to owner]
⚠️ monorepo/: definition dirty (3 files) → steps in detail
<blockquote expandable>full tables: every bot, every repo, every server metric</blockquote>
```

Buttons via kushbot `ask` tool, ONE action per question, max 3-4 proposals per
message ranked by severity. More findings → "…and N more: /darbar <domain>".

## Step 4 — act (only on a tap / explicit yes)

| action | command | verify (MANDATORY before reporting done) |
|---|---|---|
| respawn fresh (server son) | `ssh server '~/kai/fleet-ctl start --fresh <name>'` | live probe passes |
| respawn resume (server son) | `ssh server '~/kai/fleet-ctl start <name>'` | live probe (401 → redo as fresh) |
| respawn mac son | `tmux kill-session -t kush<N>` then relaunch per gateway/README.md or plain dc + `KUSHBOT_AUTO_ATTACH=<N>` | live probe |
| **kill (server son)** | `ssh server '~/kai/fleet-ctl stop <name>'` — kills tmux AND parks. **NEVER raw `tmux kill-session`** (see below) | rescan: tmux:false AND parked:true |
| kill (Mac son) | `tmux kill-session -t kush<N>` + kill poller pids from scan (EXPLICIT pids only — never pkill patterns). No watchdog on Mac, so no parking needed | scan shows tmux:false, claim released |
| park / unpark | `ssh server '~/kai/fleet-ctl park <name>'` / `unpark <name>` | fleet-ctl status reflects |
| clear stale claim | `rm <home>/.claude/channels/telegram/claimed_by.pid` — ONLY if claim.alive:false | rescan clean |
| remove expired maint flag | `rm ~/kai/state/maint-<name>` | rescan clean |
| set maint flag (N hours) | `date -d "+N hours" +%s > ~/kai/state/maint-<name>` | file content > now |
| run backup now | the matching `backup/*.sh` script | log tail shows `✓ pushed` |
| sync stale home copies | `ssh server '~/kai/KushDarbar/fleet/sync-kushbot.sh'` — deploys the whole source set (server.ts + src/ + package.json + bun.lock). **NEVER `cp server.ts` alone**: since the split that lands a server with no modules → boot crash → deaf son | rescan: `stale_copies` AND `missing_src` both empty. NOTE: running bots load it on next RESTART — say so |
| **missing_src (boot-breaking)** | a home has the new server.ts but no `src/` — it cannot boot. Run the sync above, then `fleet-ctl reload <name>` | rescan clean + live probe |
| restart gateway | mac `brew services restart cliproxyapi` / server `systemctl --user restart cliproxyapi` | gateway.up:true |
| disk relief | `du -xh -d2 <dir> \| sort -rh \| head -15` — REPORT only; deletion is a separate explicit ask per path | — |

**Hard rules:**
1. One action at a time; rescan/verify between actions.
2. Destructive on a LIVE session (kill, park, respawn of a bot with
   last_activity_h < 1) → second confirmation showing what dies.
3. NEVER report success without the verify column passing (2026-07-12 false
   "vaidya fixed" lesson).
4. Auth-suspect bots: fresh > resume (2026-07-14 resume-poison lesson). AMENDMENT
   2026-07-21 (daroga): a poisoned resume CAN be rescued in place — resume the old
   session (401s), then the OWNER runs /login in the pane (browser dance). Verified
   by live probe. Offer this before declaring the old session lost; fresh remains
   the no-owner-available fallback. Removing the creds symlink does NOT fix it.
5. No broad pkill patterns, ever. Explicit pids from the scan.
6. kc (slot0) is the owner's live session — never respawn/kill it; report only.
7. kai (server parent) — same: propose, but require the owner's explicit yes with
   the extra line "this is parent kai, your main server session".

## Edge cases

- Scanner errors under any key: report that check as UNKNOWN, don't guess.
- `busy:true` bot: skip probe, note "mid-turn". Offer re-check.
- Registry lists an agent whose machine ≠ scan machine (e.g. kc on server's
  registry): scanner filters these; if you see one anyway, ignore it.
- Two poller pids per bot is NORMAL (`bun run` wrapper + child).
- Mac kc has no tmux pane to read: claim.alive is the only passive signal —
  and if darbar is running, kc is you; you are alive by cogito.
- Gateway session resumed with plain `dc` shows model errors — remind about
  `dcg --resume` (gateway/README.md rule 1).
- If the owner free-texts an action not in the table, map it to the closest
  documented command; if none fits, say what you'd run and get a yes first.
