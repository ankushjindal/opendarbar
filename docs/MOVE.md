# move: relocate a running agent session between the Mac and server

`fleet/move` moves ONE tmux pane running Claude Code or Codex from one machine to the other: the transcript, the working tree state (via git), and a relaunch in tmux at the destination. v1 (2026-09-04) scope: tmux to tmux, monorepo checkouts only, no Telegram changes, orchestrated from the Mac.

```
move <tmux-target> to-server|to-mac [--copy] [--wip commit|refuse] [--dry-run]
move --resume <move-id> | --rollback <move-id> | list | show <move-id>
```

`<tmux-target>` is a tmux session name when it holds one agent pane, or `session:window.pane` when it holds several (preflight lists them). Always run `--dry-run` first; it prints the move card and changes nothing.

## What happens, in order

| Stage | Where | What |
|---|---|---|
| preflight | source | find the agent process under the pane (claude or codex, subagents ignored), its cwd, git branch / ahead / dirty files / worktree, registry membership. Refuses: cwd outside monorepo/, detached HEAD, dirty tree on main/staging/master/production, several agent panes without a pane address. |
| quiesce | source | types `[move] freeze ...` into the pane and waits (max 5 min) for `MOVE-READY-<nonce>`. The reply is what locates the transcript, so the session id is never typed. Live subagents (`--parent-session-id`) block the move. |
| carry | source | dirty tree → `git add -A` + wip commit on the same branch; then `git push -u origin <branch>`. Push failure unwinds the wip commit. |
| copy | orchestrator | transcript copied (backup if one exists at the destination), monorepo/ path prefix rewritten in the copy, referenced plan files copied. Codex transcripts keep their `~/.codex/sessions/YYYY/MM/DD/` path. |
| launch | destination | fetch + checkout the branch (worktree add if the source was a worktree), `reset --soft HEAD~1` + `reset` to make the tree dirty again, force the wip commit back off origin (lease = the wip head), start tmux `<origin>-<name>` (`mac-kush5`, `server-kai2`; `-2` on collision) with `claude -r <id> "<handoff>"` or `codex resume <id> "<handoff>"`, auto-answer the startup prompts, wait (max 4 min) for `MOVE-ACK-<nonce>`. |
| cut | source | (default) park the son in the registry if it is registered (`state: moved:<machine>:<tmux>`), kill the agent, respawn the pane with a note + the rollback command. `--copy` skips this and tells the source it is the archive. |
| report | orchestrator | prints the attach line: `ssh server -t tmux attach -t mac-kush5` or `tmux attach -t server-kai2`. |

State: `~/.claude/channels/fleet/moves/<move-id>.json` (plus the same file shipped to `/tmp` on the remote for remote stages). `--resume` re-runs only the stages that did not complete. `--rollback` kills the destination tmux, unwraps the wip commit on the source, drops it from origin, unparks the son and relaunches the source pane from its kept transcript.

## What does not travel (the handoff message says so)
- crons / loops / background bash tasks (counts are listed)
- pending kushbot asks and permission prompts
- Telegram: the moved session has no bot at the destination in v1; the Mac slot claim lapses
- anything outside the repo (`~/kush/scratch` on the Mac, `~/kai` on server)
- git-ignored files (node_modules etc.); run installs at the destination

## Requirements
- Both machines: `tmux`, `jq`, `git`, `realpath`, the agent binaries (`~/.local/bin/claude`; codex at `/opt/homebrew/bin/codex` on the Mac, `~/.local/bin/codex` on server), and this repo checked out (`~/.claude/plugins/local/kushbot` on the Mac, `~/kai/KushDarbar` on server, kept in sync by `fleet/sync-kushbot.sh` / `git pull`).
- ssh alias `server` from the Mac.
- The destination checkout of the same submodule/worktree must exist and be clean on the branch's target path.

## Gotchas learned on the first run
- Claude's trust prompt now defaults to "No, exit"; the launcher presses Down then Enter when it sees "Yes, I trust this folder".
- `sget` (jq `// empty`) returns empty for `false`; read booleans with `jq -r` directly.
- Unwrapping the wip commit at the destination leaves origin one commit ahead; the launch stage force-pushes (with lease) the real head back, so origin never keeps wip commits after a successful move.

## Not in v1
kushbot MCP `move` tool (kc shells the CLI on request instead), Telegram peer map (kushN <-> kaiN), `--carry` for non-repo dirs, non-monorepo repos, running the orchestrator from server.
