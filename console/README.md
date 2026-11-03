# KushConsole — Raycast extension

Kush space, keyboard edition. The dashboard (`../dashboard`) is the browser/any-device surface;
this is the Mac/fastest-actions surface. Shared data, separate UIs.

## 0.4: Compose (multi-line, same bar)

| You do | It does |
|---|---|
| `@carolwa 72% (month) - Means: …` then ⌘⇧↵ | **Compose Long Message**: a form with the text so far, target fixed (`@key · label · transport`). ↵ = new line, ⌘↵ sends through the same path as the bar (same transport, errors, toast), bar clears |
| any note text (or nothing) then ⌘⇧↵ | **Compose Long Note**: same form, target = Saved Messages, ⌘↵ saves |

⌘⇧N (Long Note) still works for notes; in `@` mode it is hidden so `@name …` text can never be saved as a note by accident.

## 0.3 — Send (in the Saved bar) + Fleet

**Send** — same bar, `@name` prefix:

| You do | It does |
|---|---|
| `@alice pick up milk` ↵ | WhatsApp via wacli · `@bob …` iMessage via imsg · `@kai …`/`@kush …`/any fleet bot → Telegram DM via tgs · `@carol …`/`@dave …` → Google Chat via gog |
| `@` or `@al` | lists matching contacts; ↵ fills `@alice ` and you keep typing |
| `@kai ` ↵ (no text) | long multi-line message form (⌘⇧N on a contact row does the same) |
| `@me …` | Saved Messages, explicitly |
| ⌘⇧A · ⌘⇧R · ⌘⇧V while `@name …` | attach a file · record + send a voice note · send the clipboard — to that contact |
| ⌘T while `@name …` | open that chat in its app |
| Sent section | last 10 sends this session; ↵ opens the chat |
| ⌘⇧F on a message · ⌃⇧F with a selection | forward → pick a contact from the sublist, ↵ sends (Telegram: native forward, media kept; others: text + file re-upload) |

Address book: `~/.config/kushconsole/contacts.json` (people, 0600, restored by the secrets bundle) — WhatsApp targets must be the full JID (`<country><number>@s.whatsapp.net`); a bare number is ambiguous once wacli has also seen a device JID (`91…:17@…`) + every agent with a `bot` field in `~/.claude/channels/fleet/registry.json`. Fleet replies come back to Telegram — the console only confirms delivery (reading replies = Inbox, 0.4).

**Fleet** — separate command, both machines from their dashboards (`/api/fleet/status` over Tailscale):

| Key | Action |
|---|---|
| ↵ · ⌘T | message the agent's bot (form) · open its Telegram chat |
| ⌘R · ⌘⇧R | restart (resume) · restart fresh |
| ⌃X · ⌘⇧P · ⌘⇧I | stop (kill + park) · park / unpark · ping |
| ⌘L · ⌘D · ⌘⇧C · ⌘⇧N | log on the dashboard · open dashboard · copy tmux attach command · spawn a Mac session |

All mutating actions confirm first. Rows show kind/lease, model, ctx % and 5h % (red ≥ 85, amber ≥ 70), outbox count.

## 0.2 — Telegram Saved Messages

One command, **Saved Messages** — bind to `⌥K`. The search bar is a composer.

| You do | It does |
|---|---|
| type text, ↵ | saves to Telegram Saved (pinned "Save: …" row is auto-selected so ↵ = save), bar clears, message lands on top |
| type `/query` | server-side search replaces the list; clear the bar to return |
| empty bar, ↵ on a message | edit (form, ⌘↵ submits) |
| scroll to the end / ⌘L | next 5 |
| ⌘C · ⌘↵ · ⌃X · ⌘R · ⌘⇧V | copy · full view · delete (confirm) · refresh · save clipboard |
| ⌘M · ⌘⇧M | select/deselect a message · select all loaded — selected rows get a green check |
| ⌘⇧C · ⌃⇧X | copy all selected (joined) · delete all selected (one confirm, one API call) |
| Raycast root: `saved <text>` ↵ | saves instantly (optional argument), then opens the list |
| ⌘⇧A · ⌘⇧N · ⌘T | attach a file with caption · long multi-line note · open the message in Telegram |
| media rows: ⌘O · ⌘S · ⌘Y · ⌘E | open · save to Downloads · Quick Look (downloads on first press) · edit caption |
| voice rows: ↵ / ⌘⇧P | play in place (afplay), press again to stop; duration on the row |
| ⌘⇧R | record from the mic; ⌘⇧R again stops and sends as a voice note, bar text = caption |

Shells out to `~/bin/tgs --json` (see `../tgs`). No Telegram credentials live here. Icon: Bender.

## Install (dev mode, local only)

```bash
cd ~/.claude/plugins/local/kushbot/console
npm install
npm run build        # ray build — installs into Raycast as a local extension, no process left running
```

Then Raycast → Settings → Extensions → KushConsole → *Saved Messages* → Hotkey `⌥K`.
`npm run dev` (ray develop) hot-reloads while iterating; `npm run build` again when done.

## Roadmap

- ~~0.2 Fleet · 0.3 Send (WhatsApp, iMessage, Telegram DMs, Google Chat)~~ — shipped 2026-09-03 as 0.3.x, see above and `DESIGN-fleet-send.md` §6
- 0.5 **Inbox**: read replies from fleet bots inside the console (`tgs history`, `tgs chats` exist; needs unread tracking)
- ideas: Ask Kush, Pull/Taildrop, Sessions, Today

Product context and decisions: `../tgs/PRODUCT.md` §4.
