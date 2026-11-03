# tgs — Telegram Saved Messages CLI (product doc)

Written 2026-09-03. Owner: the owner. Status: **V0.3 shipped 2026-09-03** — 0.1 list/search/show/add/edit/delete + tgsd; 0.2 media/pin/record/transcribe; 0.3 `send`/`forward`/`chats`/`history` to any chat. Raycast wrapper = KushConsole (`../console`).

> **Decisions 2026-09-03 (TG):** telecrawl dropped. Search in V0.1. Daemon promoted to V0.1 (1–2 s cold start rejected). Console = Raycast extension named **KushConsole**, hotkey **⌥K**. KushConsole later shares data with KushDarbar dashboard (fleet/bot status) — shared API, separate surfaces.

---

## 1. The product space

Three layers. Keep them separate; each has a different job and a different failure mode.

```
┌───────────────────────────────────────────────────────────────┐
│  L3  AGENTS        kushbot fleet · OpenClaw                    │
│      Bot API. Claude sessions that RECEIVE + ACT. Not you.     │
├───────────────────────────────────────────────────────────────┤
│  L2  CONSOLE       "dispatch" (future) — hotkey / Raycast /   │
│      menu bar. One capture surface that fans out to L1.       │
├───────────────────────────────────────────────────────────────┤
│  L1  TRANSPORTS    imsg (iMessage) · wacli (WhatsApp) ·        │
│      gog (Google Chat) · **tgs (Telegram — NEW)**              │
│      One CLI per network, acting AS YOU on YOUR account.       │
└───────────────────────────────────────────────────────────────┘
```

**L1 is what we build now.** `tgs` is the missing transport. Every other L1 tool
exists and is installed. The console (L2) composes them later and is *not* the
focus.

### Why a bot can't do this

Saved Messages is your account's self-chat. Bot API (kushbot, OpenClaw) cannot
see it — bots only see chats they are members of. `telecrawl` (openclaw/tap)
can *read* it from the local Telegram.app DB but cannot send or edit. Add/edit
require **MTProto with a user session** (Telethon). No sibling tool avoids this.

### How tgs relates to what you already have

| Tool | Plane | Relationship to tgs |
|---|---|---|
| **kushbot / OpenClaw** | L3, Bot API | Orthogonal. They are agents' ears/mouth; tgs is *your* hands. Meeting point (future): an agent runs `tgs add` to drop a note in your Saved, or `tgs list --json` to read your notes-to-self as a capture inbox. |
| **imsg / wacli / gog** | L1 siblings | tgs copies their conventions (`--json`, verb-first subcommands) so a future console adapter is uniform. Note consistency models differ: wacli = local DB + sync, imsg = reads Messages DB, tgs = live API. Console must tolerate that. |
| **telecrawl** | L1, read-only archive | Optional. Not needed for V0.1. Worth installing separately for offline full-text search + encrypted backup of all Telegram history. Don't split the saved-messages workflow across two binaries. |
| **tools/raycast/**, **~/kush/swiftbar/** | L2 surfaces | Existing homes for the console when it comes. |

---

## 2. tgs V0.1 — scope (locked)

**One job: get, add, edit Saved Messages. CLI only. Nothing else.**

### Commands

```
tgs login                     # one-time: api_id/api_hash + phone code → session file
tgs doctor                    # session valid? connected? latency?
tgs list [-n 5] [--before ID] # last N saved msgs, newest first; paginate with --before
tgs add "text"                # send to Saved. Also: echo "x" | tgs add ; tgs add --clip
tgs edit ID "text"            # edit by message id. ID accepts: last, -1, -2 … or int
tgs edit ID                   # no text → opens $EDITOR prefilled with current text
tgs show ID                   # full text of one message (list truncates)
tgs search "query" [-n 10]    # server-side search within Saved (messages.search on peer=me)
tgs delete ID [ID…]           # alias rm. Added to 0.1 on request (2026-09-03)
```

All commands accept `--json`. Exit codes: 0 ok, 1 telegram error, 2 auth needed.

**Explicitly out of V0.1:** media, other chats, reactions, pinned.

### Design decisions

- **Runtime:** Python 3.13 venv at `~/.config/tgs/venv` (already created, Telethon 1.44 installed). Shebang in `~/bin/tgs` points at it. No uv at runtime.
- **Code lives at** `KushDarbar/tgs/` → `tgs.py`, `install.sh` (symlinks `~/bin/tgs`), `README.md`, this doc.
- **Secrets live at** `~/.config/tgs/` (`chmod 700`): `creds.json` (api_id/hash) + `tgs.session`. **Never** under `self/` (Obsidian-synced) and never in the repo. The session file = full account access; treat like a password.
- **No archive.** tgs stores zero messages. Every call is live. This is the opposite of telecrawl.
- **Message IDs are real Telegram ids** (ints), plus `last`/`-1`/`-2` aliases. No invented index that drifts between calls.
- **Output:** human default is `ID  date  first-80-chars`. `--json` is the contract for the console.

### Speed — the constraint that shapes everything

Telethon cold start (import + connect + auth handshake) is ~1–2 s. Unacceptable
for a hotkey *if you wait for it*. Two answers, in order:

**Decision: daemon in V0.1.** 1–2 s cold start was rejected outright.

Where the cold time goes (est.): Telethon import ~300 ms · MTProto connect +
handshake ~400–600 ms · session load ~100 ms · request ~100–200 ms. Shaving
imports buys ~150 ms. Only a resident connection removes the rest.

1. **`tgsd` — resident daemon.** Holds one connected Telethon client. Listens
   on `~/.config/tgs/tgs.sock` (unix socket, JSON lines). Every `tgs` call →
   socket → ~30–50 ms end to end.
2. **Self-healing CLI.** `tgs` tries the socket first. If no daemon: run the
   command cold (still works, 1–2 s) *and* spawn `tgsd` in the background so
   the next call is fast. No launchd dependency to start; add a launchd
   KeepAlive plist once it's proven stable.
3. **Fire-and-forget on the capture path** stays: the Raycast wrapper returns
   instantly; failure → macOS notification.

Targets: warm `add` / `list` / `search` < 100 ms. Cold fallback < 2 s.

### Sub-tasks — V0.1 (all done 2026-09-03 except 10 → KushConsole)

| # | Task | Done when |
|---|---|---|
| 1 | Scaffold `tools/tgs/` (tgs.py, install.sh, README, .gitignore) | `tgs --help` runs from anywhere |
| 2 | **You:** get `api_id` + `api_hash` from my.telegram.org → API development tools | creds exist |
| 3 | `tgs login` + `tgs doctor` | session file written, doctor green |
| 4 | `tgs list` / `show` with `--json`, `-n`, `--before` | matches Telegram.app Saved view |
| 5 | `tgs add` (arg, stdin, `--clip`) | message appears in Saved within 2 s |
| 6 | `tgs edit` (arg, `$EDITOR`, `last` alias) | edit visible in Telegram.app |
| 7 | `tgs search` | server-side, `--json` |
| 8 | `tgsd` daemon + socket protocol + self-healing fallback | warm calls < 100 ms, measured |
| 9 | launchd KeepAlive plist for `tgsd` | survives reboot/login |
| 10 | Fire-and-forget wrapper + failure notification | hotkey path feels instant |

Steps 1, 4–8 are mine. Step 2 is the only blocker and it's yours. Step 3 is
interactive (phone code), so you run it; I'll have the command ready.

---

## 3. tgs roadmap — one feature per version

| Ver | Feature | Notes |
|---|---|---|
| **0.1** | Saved: list / add / edit / search + daemon | this doc |
| 0.2 | Pin on Saved — **done** | small |
| 0.3 | DM other users: `tgs send @user "text"`, `tgs history @user -n` — **done** (contacts live in KushConsole's address book) | |
| 0.4 | Read: `tgs chats` **done**, `tgs unread` pending | now it's a full sibling to wacli/imsg |
| 0.5 | Media: `tgs add --file`, `tgs media` download — **done** (0.2) | |
| 0.6 | Delete, forward, pin — **done**; reactions pending | |
| later | Agent hook: kushbot skill that reads Saved as a capture inbox | L3 ↔ L1 bridge |

---

## 4. The console ("dispatch") — future, defined now so tgs fits it

**Not the focus. Written down so V0.1 of tgs doesn't paint us into a corner.**

One capture surface, many transports. **Raycast extension. Name: KushConsole. Hotkey: ⌥K.**

### KushConsole ↔ KushDarbar dashboard — the "Kush space"

the owner (2026-09-03): both are one product space. Dashboard = browser, Tailscale-reachable from any device, broader features. Console = Raycast, Mac-only, the quickest actions; some overlap by design.

Decision: **shared data, separate surfaces.** The dashboard (`tools/dashboard`,
Bun, Mac + server) is the glance/multi-device surface. KushConsole is the
keyboard/capture surface. Neither becomes the other. KushConsole reads fleet
and bot status from the same API the dashboard serves (or kushbot
`pool_status`), and adds a "Fleet" list command alongside "Saved". Dashboard
gains nothing from tgs V0.1; it may later show the Saved capture inbox.

### Console V0.1 — Saved Messages only — **built 2026-09-03**, `KushDarbar/console/`

- Show last 5 saved; "show 5 more" pages via `--before`.
- Click a message → edit (prefilled form).
- Add → hotkey, type, Enter. Fire-and-forget.

**Surface: Raycast extension (decided).** List + inline form + per-command
hotkeys natively. `tools/raycast/` already exists.

**Hotkey: `⌥K`** (KushConsole) opens the console. Flow: `⌥K` → type → `↵` →
gone. Target: <300 ms perceived, backed by the warm daemon.

### Console V0.2+ — other transports

- iMessage → a contact (`imsg send`)
- WhatsApp → a family member (`wacli send`)
- Google Chat (`gog chat`)
- Telegram DMs (tgs 0.3)

Each transport is an adapter over an existing L1 CLI. The console never talks
to a network directly. That's why tgs V0.1 must have a clean `--json` contract.

---

## 5. Lessons from the V0.1 build

- **`~/Downloads` is poison for background processes.** macOS TCC blocks launchd agents (and
  Raycast) from reading it without a prompt they can't show; Python hangs at startup with no
  error. `install.sh` deploys to `~/.config/tgs/tgs.py`. Any future tool in `owner/tools/` that
  runs headless needs the same treatment.
- **launchd + self-spawn race.** Two daemons came up. Fixed with a flock on `tgsd.lock`; when
  launchd owns the job the CLI kicks it instead of spawning.
- **Telegram login codes can't travel through Telegram.** Sending the code in any TG chat
  invalidates it instantly. Spaced digits bypass the detector; or type it at the Mac.
- **Latency floor** is ~50 ms Python start + ~70 ms DC round trip. Warm ≈ 150 ms, not <100.

## 6. Open decisions

- Socket protocol shape (JSON lines vs length-prefixed) — mine, trivial.
- Whether KushConsole "Fleet" reads dashboard API or kushbot `pool_status` directly.
