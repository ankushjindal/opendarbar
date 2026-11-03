# Fleet crash-recovery runbook

> **Sanitized public copy.** The owner's private repo also carries an encrypted token
> bundle (`secrets/`) and an identity snapshot (`fleet-backup/`). Both are **removed**
> from this copy; the steps that used them are described generically below. See
> [`REDACTIONS.md`](./REDACTIONS.md).

**Purpose:** rebuild the whole agent/bot fleet (laptop + server) from scratch after a
disk or laptop death, using a private copy of this repo plus one passphrase kept in a
password manager.

The private repo is the recovery layer. It carries:
- the **kushbot plugin code** (the Telegram bot engine),
- **encrypted bot tokens** (a gpg-symmetric bundle; removed here),
- an **identity/config snapshot** of personas, agent defs and scripts (removed here),
- the **fleet ops layer** (`fleet/`: `fleet-ctl`, watchdog, creds-guard, relay, systemd
  units; installed by `fleet/install.sh`) and orchestration scripts (`restart-fleet.sh`),
- this runbook.

---

## 0. What survives a crash

| asset | where it lives | recovered from |
|---|---|---|
| work repos | your git host | `git clone` |
| kushbot engine (+ private token bundle and identity snapshot) | a private copy of this repo | `git clone` |
| **bot tokens** | encrypted bundle in the private repo | decrypt with the passphrase |
| **passphrase** | password manager | the one thing not in git |
| personas, agent defs, parent scripts | identity snapshot in the private repo | copy back to `~/kush`, `~/.claude/agents`, `~/kai` |
| API creds under `~/.config/` | per machine, outside git | re-auth |
| laptop Claude sessions (`~/.claude`) | private `claude-data` repo | clone; the tree is the repo |
| laptop Codex sessions (`~/.codex`) | private `codex-data` repo | clone |
| server Claude sessions (parent + all `*-home`s) | private `claude-data-server` repo | clone, rsync per-home subdirs back |
| server Codex sessions | private `codex-data-server` repo | clone, rsync `parent/` back |
| gateway (dcg) | `gateway/` (code); auth NOT backed up | `gateway/install.sh` + device-flow logins |

Backup automation for the four session repos lives in [`backup/`](./backup/README.md).

**The only secret not in git is the passphrase.** Lose both the laptop AND the password
manager and the tokens are unrecoverable: re-mint them via BotFather (see §5).

**Auth doctrine:** OAuth/credentials (`claude /login` grants, codex `auth.json`,
`~/.cli-proxy-api/`, `.credentials.json`) are NEVER in any backup. On a rebuilt
machine you re-earn every auth by hand: `claude /login`, `codex login`,
`gateway/install.sh` + its device flows, `gh auth login`.

---

## 1. The fleet (what you are rebuilding)

**Laptop (POOL model, `~/.claude/channels/kushbots/`):** slot 0 = the always-on parent
`kush` (`@example_laptop_bot`); slots 1-3 = ad-hoc sons spawned on demand.

**Server (one HOME per bot, `/home/owner/<bot>-home/`):** parent `kai`
(`@example_parent_bot`), its mirror sons, and any standing personas from the registry.

---

## 2. Laptop recovery (bare metal to live fleet)

```bash
# 2.1 prerequisites
brew install gnupg tmux git rsync bun gh
# install Claude Code, then: gh auth login; install + log in to Tailscale

# 2.2 clone the (private) recovery repo
mkdir -p ~/.claude/plugins/local
git clone git@github.com:<you>/<private-kushdarbar>.git ~/.claude/plugins/local/kushbot
cd ~/.claude/plugins/local/kushbot && bun install

# 2.3 restore identity/config from your private snapshot
#     (personas -> ~/kush, agent defs -> ~/.claude/agents, statusline, shell functions)

# 2.4 restore the bot tokens from your encrypted bundle into
#     ~/.claude/channels/kushbots/slot{N}/.env  (chmod 600)

# 2.5 bring the parent up
./restart-fleet.sh status     # confirm slot tokens present
./restart-fleet.sh up         # runs the parent in tmux
```
**Verify:** DM `@example_laptop_bot` from your phone; it responds. Sons spawn on demand
via the kushbot `spawn` tool; nothing to pre-start.

---

## 3. Server recovery (bare metal to live fleet)

```bash
ssh server
sudo apt update && sudo apt install -y gnupg tmux git rsync     # + Claude Code, bun
git clone https://github.com/<you>/<private-kushdarbar>.git ~/kai/KushDarbar
# restore each son's channels/telegram/.env from the encrypted bundle (chmod 600)
# restore the parent's scripts + personas into ~/kai from the identity snapshot
```

**Install the ops layer. Do NOT skip this.**
```bash
cd ~/kai/KushDarbar/fleet && ./install.sh
```
This is what makes the fleet *stay* up rather than merely start: `fleet-ctl`, the
watchdog + its systemd timer, `creds-guard`, `boot-restore`, the A2A relay, and the
`tg-reply-guard` hook. A machine rebuilt without it comes up looking healthy and then
rots: no auto-heal when a son dies, and no creds-guard.

Deploy the code to every home, then bring the fleet up:
```bash
~/kai/KushDarbar/fleet/sync-kushbot.sh     # server.ts + src/ + package.json + bun.lock
~/kai/fleet-ctl boot-restore               # starts every non-parked son
# the parent kai is started by hand from your own terminal
```

**Verify:** DM `@example_parent_bot` and one son; they respond. Then
`fleet-ctl status`: every non-parked son shows a live proc + claim.

---

## 4. Keep the backups fresh

The encrypted tokens and the identity snapshot are point-in-time. Refresh them after
editing a persona, adding/removing a bot, or rotating a token. Monthly is enough.

---

## 5. Token rotation / re-mint

- **Re-bundle** after adding a bot: rebuild the gpg bundle and commit it to the private repo.
- **New passphrase:** rebuild with the new one and update the password manager.
- **Lost everything:** re-mint each bot via **@BotFather** (`/token` or `/newbot`),
  write the new token to its `.env`, then rebuild the bundle.

Security model of the private bundle: gpg `--symmetric --cipher-algo AES256`, inert
without the passphrase; the passphrase lives only in the password manager; the
bundle directory's `.gitignore` is an allowlist (`*.gpg`, `README.md`, `.gitignore`).

---

## 6. Lessons from a VM-to-VM migration

The server moved to a new VM by rsyncing the home directory (same user, same paths) instead of rebuilding from git. Lessons, in order of pain:

1. `rsync --delete-excluded` deletes excluded paths ON THE DESTINATION. Use plain `--delete`; keep new-only files under a path listed in the exclude file (excluded paths are protected from `--delete`).
2. Every full-home rsync overwrites `~/.ssh/authorized_keys` on the destination with the source copy. Exclude it, or you lock the source box out of the destination after each pass.
3. rsync carries systemd enablement (`~/.config/systemd/user/*.wants/` symlinks). A copied box is ARMED: a reboot double-runs timers and bot pollers against the live box. Disable everything right after the copy; re-enable from the saved lists at cutover only.
4. Exclude old `~/.local/share/claude/versions/*` only if you repoint `~/.local/bin/claude` (a symlink into that dir) to a version you kept. Otherwise every son dies at launch with "No such file" and fleet-ctl reports "did NOT verify up".
5. `pgrep -f <name>` / `pkill -f <pattern>` from a shell whose own command line contains the name matches itself: waiters never exit, pkill kills your ssh. Filter by pid list.
6. cliproxyapi OAuth tokens rotate; a copied Codex token is stale the moment the source instance refreshes. Plan a `cli-proxy-api -codex-device-login` on the new box; never run the copy while the source is live.
7. scp old->new failed ("lost connection") while ssh and rsync worked; use rsync for single files too.
8. The dashboard binds to the Tailscale IP (`DASHBOARD_TAILSCALE_IP`); the service will not bind on a new VM until it is changed. Not cosmetic.
