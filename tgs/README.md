# tgs — Telegram Saved Messages CLI

V0.1: list / search / show / add / edit your Saved Messages. Live API, no local archive.
Product doc: [PRODUCT.md](./PRODUCT.md).

## Install

```bash
./install.sh            # venv (if missing) + ~/bin/tgs
tgs login               # api_id / api_hash from my.telegram.org, then phone + code
tgs doctor
./install.sh --launchd  # once stable: keep tgsd alive across reboots
```

Secrets live in `~/.config/tgs/` (chmod 700). `tgs.session` is full account access.

## Use

```bash
tgs list                 # last 5, newest first        (ID* = edited)
tgs list -n 10 --before 4120
tgs search "invoice"
tgs show last            # ids: 4120 | last | -1 | -2 …
tgs add "buy milk"
echo "note" | tgs add
tgs add --clip           # clipboard
tgs add --bg "note"      # returns instantly; macOS notification only on failure
tgs edit last "buy oat milk"
tgs edit 4120            # opens $EDITOR prefilled
tgs rm last              # delete; also: tgs delete 4120 4121
tgs --json list          # contract for KushConsole
```

Exit codes: 0 ok · 1 telegram error · 2 auth needed (`tgs login`).

## 0.3 — any chat, not just Saved

```
tgs send @example_parent_bot "check disk"          # Telegram DM (bots, people, groups by @username or id)
tgs send me "note" --file ~/x.pdf              # same delivery path as add
tgs send @example_laptop_bot --voice ~/v.m4a      # voice note bubble
tgs forward @example_munshi_bot last -2               # native forward (media kept), several ids ok
tgs chats -n 30                                # recent dialogs: id, kind, name, @username, unread
tgs history @example_parent_bot -n 10              # last messages of a chat (› = sent by you)
```

## Deploy note

`install.sh` copies `tgs.py` to `~/.config/tgs/tgs.py` and everything runs from there, so the daemon
and launcher never depend on where this repo is checked out. (Original reason: the first home was
under `~/Downloads`, which macOS TCC blocks for background processes — launchd hung at Python startup
with no error.) **After editing `tgs.py`, re-run `./install.sh`.**

## Daemon

`tgs` talks to `tgsd` over `~/.config/tgs/tgs.sock` (~30–50 ms). If no daemon is up it runs cold
(~1–2 s) and spawns one for next time. `tgs daemon start|stop|restart|status|log`. Under launchd (`./install.sh --launchd`) the CLI never self-spawns; it kicks the launchd job instead. A flock on `tgsd.lock` guarantees one instance.

## Latency (measured)

Pre-login baseline (2026-09-03, M-series Mac):

| Path | Time |
|---|---|
| `tgs` process start → socket (no Telethon import) | 50–60 ms |
| `import telethon` (cold path only) | 120–150 ms |

After login (2026-09-03, wall-clock incl. ~50 ms process start; Telegram DC RTT ≈ 70 ms):

| Command | Cold (no daemon) | Warm (tgsd) |
|---|---|---|
| `list -n 5` | 780 ms | ~150 ms |
| `add` | 770 ms | ~150 ms |
| `add --bg` (returns before send) | — | ~50 ms |
| `search` | — | ~230 ms |
| `edit last` (2 round trips: resolve + edit) | — | ~300 ms |
| `show last` (2 round trips) | — | ~230 ms |

Floor is process start (~50 ms) + one DC round trip (~70 ms). Sub-100 ms needs a compiled client; not worth it yet.
