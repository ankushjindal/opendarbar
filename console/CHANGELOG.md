# KushConsole changelog

Two commands: **Saved Messages** (⌥K — composer, `@name` sends) and **Fleet**.

## 0.4.0 - 2026-09-29
- **Compose Long Message** ⌘⇧↵ while the bar holds `@name …`: pushes a form with the text typed so far, the target shown and fixed (`@key · label · transport`), ↵ = new line, ⌘↵ sends. It calls the bar's own send (`doSend`), so transport code, errors, toast and the Sent section are identical to ↵; the bar clears on success, a failed send keeps the form and the text.
- **Compose Long Note** ⌘⇧↵ with no `@name`: same form (`src/compose-form.tsx`), target = Saved Messages, saved through the bar's `save()`.
- ⌘⇧N Long Note is hidden in `@` mode (it would have saved `@name …` as a note; contact rows keep their own ⌘⇧N Long Message).
- Composer row in `@` mode with text shows the hint "⌘⇧↵ long message".
- Transports: newlines already reach every CLI verbatim (argv arrays, no shell; wacli escapes off; imsg hands argv to an AppleScript run handler). Fixed text that starts with "-" (a bulleted message): gog now gets `--text=…` (kong rejected `--text "- a"`), imsg gets an invisible word joiner in front (its parser reads a leading "-" as an option and has no `=` form).
- Verified: 4-line message with a leading "- " and a blank line sent to @me through `tgs send`, read back byte-identical (#22373).

## 0.3.2 — 2026-09-04
- **Copy Image** ⌘C on photos, stickers and GIFs puts the picture itself on the clipboard (downloads once, cached); ⌥⌘C copies any other file. Copy Text moves to ⇧⌘C on image messages only.
- tgs daemon: reconnects after a network drop instead of sitting "disconnected" (infinite connection retries + connect-on-request); the "Couldn't load Saved Messages / Cannot send requests while disconnected" state is gone.

## 0.3.1 — 2026-09-03
- **Forward** ⌘⇧F on a message → sublist of contacts, ↵ forwards. Telegram targets get a native forward (`tgs forward <to> <ids…>`, media intact); WhatsApp/iMessage/Google Chat get the text plus the original file re-uploaded. ⌃⇧F forwards all selected.
- "Open Saved Messages in Telegram" (⌘T) moved from the per-message section to the end of Console.
- WhatsApp contacts: `to` must be the full JID (`<country><number>@s.whatsapp.net`) — a bare number is ambiguous once wacli has seen a device JID.

## 0.3.0 — 2026-09-03
- **Send, folded into the Saved bar**: `@alice pick up milk` ↵ → WhatsApp (wacli); `@bob …` → iMessage (imsg); `@kai …` / `@kush …` / any fleet bot → Telegram DM (tgs 0.3 `send`); `@carol …` / `@dave …` → Google Chat (gog). `@` alone lists contacts, ↵ picks; `@name` + ↵ with no text opens a long-message form (⌘⇧N on a contact does too). `@me` = Saved. Sent section (last 10, ↵ opens that chat). ⌘⇧A / ⌘⇧R / ⌘⇧V in @ mode attach a file / voice note / clipboard to that contact. Root argument `saved @kai …` lands in send mode.
- **Address book**: `~/.config/kushconsole/contacts.json` (0600, packed by the secrets bundle) + every fleet agent with a `bot` in `~/.claude/channels/fleet/registry.json` (registry entries stamped with `bot`). `src/lib/contacts.ts`, `src/lib/transports.ts`.
- **Fleet command**: both dashboards' `/api/fleet/status` (Mac + server, parallel, 4 s timeout, cached snapshot paints instantly, 30 s auto-refresh). Rows: state dot, kind/lease/claim, model, ctx %, 5h %, outbox. ↵ message the bot · ⌘T open its chat · ⌘R restart · ⌘⇧R restart fresh (Mac: stop → start --fresh) · ⌃X stop · ⌘⇧P park/unpark · ⌘⇧I ping · ⌘L log · ⌘D dashboard · ⌘⇧C tmux attach command · ⌘⇧N spawn (Mac). Every mutating action confirms. Unreachable machine = one grey row, never blocks the other.
- tgs 0.3: `send <me|@user|id> [text] [--file] [--voice]`, `chats [-n]`, `history <peer> [-n]`; `add` and `send` share one delivery path.
- Decisions (the owner, TG 2026-09-03): full fleet control from the console; Google Chat in (gog verified, text only); address book only, no bare phone/email targets; Send folded into the Saved bar rather than a second command.

## 0.1.3 — 2026-09-03
- Typing filters live: loaded messages + throttled server matches under "Matches"; ↵ still saves as new.
- Search placeholder clarified: `/word`, e.g. `/invoice` (not `/query word`).
- Fix: stray JSX from a generated patch broke the build in f9ab677.

## 0.1.2 — 2026-09-03
- Bulk select: ⌘M select/deselect · ⌘⇧M select all loaded · ⌘⇧C copy selected (joined) · ⌃⇧X delete selected (one confirm, one API call). (Was "mark"; renamed 0.1.4.)
- Icon renamed to `bender.png` to bust Raycast's icon cache.
- `dist/` build for Raycast's *Import Extension* (drops the Development badge).

## 0.1.1 — 2026-09-03
- Composer-first: the bar saves on ↵ via a pinned, auto-selected "Save: …" row.
- `/query` = server-side search replacing the list.
- Native scroll pagination (+ ⌘L), ⌘⇧V save clipboard, optional root argument (`saved <text>` saves instantly).
- "Save to Telegram" command folded in. Bender icon.

## 0.1.0 — 2026-09-03
- Saved list (last 5, ⌘L more), Enter edit, ⌘N new, ⌘C copy, ⌘↵ view, ⌃X delete, search-as-you-type. Separate "Save to Telegram" command.

## 0.2.2 — 2026-09-03
- **Transcription**: ⌘⇧T Sarvam (default, better on Hindi/Hinglish), ⌥⇧T Deepgram Nova-3; transcript as row subtitle + in detail; second ⌘⇧T sets it as the Telegram caption (searchable). ⌘⇧C copies. `voice-bridge/transcribe.sh --engine deepgram`, `tgs transcribe ID [--engine] [--force]`, cached per engine.
- **Pin/unpin** ⌘⇧I; Pinned section always on top, cached, refreshed after page 1 (never on the add path). `tgs pin/unpin`, `list --pinned`.
- **Links**: pure-URL rows get link icon + host, ↵ opens browser; any text with a URL gets ⌘O.
- **Voice playback**: `lib/player.ts` — survives ⌘↵/edit pushes, stops within 0.5s of closing the console (view-alive counter), sh-wrapper backstop if the process is SIGKILLed. One Play action (↵ / ⌘⇧P). Open/Quick Look use m4a (cache key bump). Recorded voice notes carry duration.
- ⌘T opens Saved Messages (native macOS Telegram has no message-level deep link for private chats — tested).
- Reopen keeps the number of rows you had loaded (⌘L pages no longer snap back to 5).
- While a draft exists, ↵ on any row saves it — highlight no longer matters (⌘E edits a match). Controlled selection removed.
- Root-argument quick save no longer saves twice.
- Playback after transcribing: media cache lookup no longer picks the transcript file.
- Fixes for three self-inflicted broken commits (3958472, f9ab677, and a partial-apply); all repaired same hour.

## 0.2.1 — 2026-09-03
- **Voice notes**: ↵ / ⌘⇧P plays in place via afplay (Telegram voice is Opus/OGG; tgs transcodes to m4a, cached), same key stops, ▶ marker + duration on the row. ⌘O / ⌘Y use the m4a.
- **Upload as voice note**: ⌘⇧A form gets a "Send as voice note" checkbox (auto-on for audio files); converted to Opus/OGG.
- **⌘⇧R record**: mic → Opus via ffmpeg avfoundation; press again to stop and upload, bar text = caption. Picks up a recording left running.
- Command-level icon set; re-registered via `ray develop` (Raycast only re-reads a dev extension's manifest that way — a `ray build` alone left the renamed icon unresolved).
- ⌘P was reserved by Raycast (search-bar dropdown) → Play is ⌘⇧P.
- tgs: `media --m4a`, `add --voice PATH [caption]`, `record start|stop|status [--seconds N] [--device N]`, `duration` in JSON.

## 0.2.0 — 2026-09-03
- **Media**: real labels (Photo / Video / Voice note / file name) instead of `[media]`, photo/video/sticker thumbnails as row icons (lazy, cached), ⌘O open, ⌘S save to Downloads, ⌘Y Quick Look (first press downloads, second shows), ⌘E edit caption. `[media]` no longer shows for link previews.
- **Attach on save**: ⌘⇧A file picker + caption; ⌘⇧V now saves a clipboard image as a photo (text still saves as a note).
- **Instant open**: first page, thumbnails and downloaded paths are cached (`useCachedState`) — ⌥K renders immediately, refreshes in the background.
- **Open in Telegram** ⌘T via `tg://openmessage` (verify on native macOS Telegram).
- **Long note** ⌘⇧N multi-line form.
- Relative times ("12m", "3h", "yesterday", "4d"); hover for the exact time. File sizes shown.
- Fix: `/search` results no longer overwrite the cached first page.
- tgs 0.2: `media_type/file_name/mime/size` in `--json`, `tgs media ID [--thumb] [--out]`, `tgs add --file PATH [caption]`.
- Not done: pin (the owner cut it). Esc-clears-draft is Raycast's own behaviour — verify.

## 0.2 — original proposal
Order: 2 → 1 → 3 → 4 → 6 → 7 → 5. the owner: all except 5.
1. **Media**: real names/types instead of `[media]`, photo thumbnails, ⌘↵ Quick Look, ⌘O open, ⌘S save to Downloads, attach on save (file picker ⌘⇧A + clipboard image). Needs `tgs add --file`, `tgs media`, richer `--json`.
2. **Instant open**: cache the last page so ⌥K renders immediately, then refreshes.
3. **Open in Telegram** (⌘T) — deeplink to the message. Verify `tg://openmessage` on native macOS Telegram.
4. **Long notes**: ⌘⇧N multi-line form.
5. **Pin/unpin** (needs `tgs pin`).
6. Esc with a draft clears the draft first; second Esc closes.
7. Relative times ("2h ago", "yesterday").
