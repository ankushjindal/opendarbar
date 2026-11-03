# backup — session-data backup automation (all machines)

Canonical home of every session-backup script. The live machines run these via
symlink/LaunchAgent, so a bare KushDarbar clone carries the full automation.

## The four backup repos (all private, github.com/example-owner/*)

| repo | machine | source tree | layout | cadence |
|---|---|---|---|---|
| `claude-data` | Mac | `~/.claude` (in-place git) | whole tree, gitignore excludes secrets | LaunchAgent, 7d |
| `codex-data` | Mac | `~/.codex` (in-place git) | whole tree | same run |
| `claude-data-server` | server | parent `~/.claude` + EVERY `~/*-home/.claude/projects` | staging clone `~/claude-data-server`, per-home subdirs (`parent/`, `vaidya-home/`, …) | cron Sun 04:30 + @reboot |
| `codex-data-server` | server | `~/.codex` | staging clone `~/codex-data-server`, `parent/` | same cron slots |

Design invariants (hold these when editing):
- **Auth is never backed up.** `auth.json`, `.credentials.json`, `*.env`,
  `*.token`, `*.key` are excluded everywhere. On a new machine auth is
  re-earned (`claude /login`, `codex login`, gateway device flows) — never
  restored from a repo. Same rule as `~/.cli-proxy-api/` (see ../gateway/).
- **Additive, not mirror.** Local pruning (disk-space cleanup, retention
  policies) must NOT delete history from GitHub. Mac scripts use
  `git add --ignore-removal`; server rsyncs without `--delete`.
- **95MB guard + chunk failsafe.** GitHub hard-fails at 100MB/file, no LFS.
  Oversized files are unstaged, then handed to `claude-data-chunk.sh`, which
  commits them as gzipped line-aligned parts under `large-files/`. Rebuild with
  `claude-data-restore.sh`. 95MB is a **ceiling, not a tunable** — raising it
  past 100MB turns a clean skip into a push failure that blocks the whole commit.
  Chunking must stay **rare**: at 2026-08-01 it fires on 1 of 19,373 tracked
  files. Several entries in the log means bad session hygiene, not a bad
  threshold. (Added 2026-08-01 after a 167MB session sat with zero off-disk
  copies for weeks because the old guard skipped it silently.)

## Files

| file | runs on | wired via |
|---|---|---|
| `mac-claude-data-backup.sh` | Mac | `~/kush/bin/claude-data-backup.sh` (symlink here) ← LaunchAgent `com.kush.claude-data-backup.plist` |
| `claude-data-chunk.sh` | any | `~/kush/bin/claude-data-chunk.sh` (symlink here) ← called by the backup script's 95MB guard |
| `claude-data-restore.sh` | any | `~/kush/bin/claude-data-restore.sh` (symlink here) ← run by hand during recovery |
| `com.kush.claude-data-backup.plist` | Mac | copy in `~/Library/LaunchAgents/` |
| `claude-data-server-backup.sh` | server | `~/kai/claude-data-server-backup.sh` (symlink here) ← crontab |
| `codex-data-server-backup.sh` | server | `~/kai/codex-data-server-backup.sh` (symlink here) ← crontab |

server crontab entries:

```cron
30 4 * * 0 /home/owner/kai/claude-data-server-backup.sh
@reboot sleep 60 && /home/owner/kai/claude-data-server-backup.sh
35 4 * * 0 /home/owner/kai/codex-data-server-backup.sh
@reboot sleep 90 && /home/owner/kai/codex-data-server-backup.sh
```

Logs: `~/kush/logs/claude-data-backup.log` (Mac),
`~/kai/logs/{claude,codex}-data-server-backup.log` (server).
All scripts are safe to run manually any time.

## Restore

See ../RECOVERY.md §"Session data" — short version: clone the machine's repos
AFTER the tooling is installed, `rsync` the trees into place (server: per-home
subdirs back into each `~/<name>-home/.claude/projects`), then re-auth
everything by hand.

**Then rebuild the chunked files** — anything under `large-files/` is NOT a
usable transcript until reassembled, and a plain `rsync` will leave you silently
missing your largest sessions:

```bash
claude-data-restore.sh --list                  # what's chunked, sizes, integrity
claude-data-restore.sh --all                   # rebuild in place (sha256-verified)
claude-data-restore.sh --all --dest /tmp/stage # or stage somewhere first
```

Restore refuses to overwrite an existing file (`--force` to override), refuses
to write if any part is missing, and verifies the reassembled sha256 against the
manifest before moving it into place.
