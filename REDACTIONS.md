# REDACTIONS

This repo is a sanitized copy of a private repo, published with fresh history
(one commit). This file lists what was removed, what was replaced, and what still
needs a human decision before the repo is made public.

Sanitized on 2026-11-03 from the private working tree (tracked + untracked files),
excluding `.git`, `node_modules`, `*.bak*`, `__pycache__`, `.DS_Store`.

## 1. Deleted outright

| Path | Why |
|---|---|
| `secrets/` | gpg-encrypted bundle of every bot token + the scripts that build/restore it. Ciphertext of real tokens; never publish. |
| `fleet-backup/` | Identity snapshot: personas ("soul"), private agent definitions, memory/journal notes, task lists, parent scripts with company and partner references, darbar run outputs, a real fleet registry. |
| `dashboard/static/fund/` (untracked) | Fundraising and investor pages. |
| `dashboard/static/reports/` (git-ignored) | Generated per-machine report HTML. |
| `dashboard/static/learn/` | A product-strategy explainer page (company content). |
| `dashboard/data/` | `recents.json`: recently opened personal and company file paths. |
| `dashboard/logs/` | Runtime logs (empty, removed anyway). |
| `dashboard/MOVED.md` | Pointer to the owner's old private dashboard repo. |
| `dashboard/lib/finance.ts`, `dashboard/widgets/finance.ts`, `dashboard/pages/server/finance-detail.ts` | Company finance: burn, runway, ledger. |
| `dashboard/widgets/food.ts` | Weekly meal-plan widget (health). |
| `dashboard/widgets/books.ts`, `dashboard/widgets/journal-week.ts` | Personal reading list and founder-journal widgets. |
| `dashboard/pages/mac/launch-tracker.ts`, `dashboard/lib/posthog.ts` | Product launch analytics for the company. |
| `dashboard/widgets/notifications.ts`, `dashboard/pages/server/notifications-detail.ts` | Company email-flow queue monitor. |
| `dashboard/widgets/chat-bridge.ts`, `dashboard/pages/server/chat-bridge-detail.ts` | Company Google Chat bridge monitor (embedded space ids). |
| `console/DESIGN-fleet-send.md` | Design notes containing the real address book (people, chat ids, transports). |
| `.firecrawl/` | Scraped third-party policy pages, unrelated to the code. |
| `fleet/quota.sh.bak.*`, `dashboard/static/fund/*.bak` | Backups (excluded by pattern). |

No `*.env`, `*.pid`, `*.log`, `*.jsonl`, `inbox/`, `approved/`, `claimed_by*`, or
`AGENTS.md` persona files existed in the tree after the copy.

`tgs/` was **kept**: it is the source of a Telegram Saved Messages CLI (code, README,
product doc, launchd plist), not chat data or stickers. `console/` was **kept**: a
Raycast extension's source; no session data (its `dist/` build output was dropped).

## 2. Rewritten by hand

- `README.md`: replaced (it was still the upstream plugin's text).
- `CLAUDE.md`: rewritten as a generic fleet operations doc (two machines, example
  roster). The private changelog, parked ideas and per-agent ownership table were dropped.
- `RECOVERY.md`: rewritten around generic steps; references to the deleted `secrets/`
  and `fleet-backup/` replaced with descriptions; the VM-migration lessons kept with
  addresses removed.
- `fleet/registry.example.json`: was a copy of the real registry (13 agents with real
  homes and bots). Replaced with 3 fictional agents (`kai`, `kai1`, `guru`), same schema
  and top-level notes.
- `dashboard/device/mac.ts`, `dashboard/device/server.ts`: removed widgets above;
  Tailscale IP now from `DASHBOARD_TAILSCALE_IP` with a CGNAT placeholder default.
- `dashboard/lib/usage.ts`: the default seat list (real account labels and emails)
  replaced with `work`, `personal`, `team-a`, `team-b` on `*.example` domains.
- `fleet/statusline.zsh`, `fleet/quota.sh`: account-email globs now match
  `@work.example` / `@personal.example`.
- `console/README.md`, `console/CHANGELOG.md`, `console/src/lib/contacts.ts`: contact
  handles replaced with fictional names (`@alice`, `@bob`, `@carol`, `@dave`).
- Hard-coded owner chat id in code became `process.env.OWNER_CHAT_ID` (TS),
  `${OWNER_CHAT_ID:-}` / `${OWNER_CHAT_ID:?}` (shell), or a literal `OWNER_CHAT_ID`
  with a "replace before installing" comment (two systemd units).
- The custom "cook-food" quick action became a generic `customScript` hook.

## 3. Replaced mechanically

Ordered regex replacement over every text file (`bun.lock`, `package-lock.json`,
`LICENSE` and images untouched). Counts are occurrences replaced.

| Category | Placeholder(s) | Count |
|---|---|---|
| Hostnames / tailnet / cloud resource groups | `server`, `laptop`, `server.TAILNET.ts.net`, `laptop.TAILNET.ts.net`, `example-rg`, `phone`, `tablet` | 497 |
| Personal names (owner, teammates, family, contacts) | `the owner`, `a teammate`, `another teammate`, `a family member`, `a contact`; lowercase ids `owner`, `teammate1`, `teammate2`, `family1` | 266 |
| Home paths and personal directories | `/Users/owner`, `/home/owner`, `~/work`, `~/work/monorepo`, `notes-vault` | 258 |
| Company / partner / org names | `the product`, `the company`, `a partner`, `monorepo`, `teammate1-monorepo`, `com.example.` | 76 |
| Telegram bot usernames | `example_parent_bot`, `example_son{N}_bot`, `example_laptop_bot`, `example_laptop_son{N}_bot`, `example_<persona>_bot`, `example_hunter_bot` | 59 |
| Tailscale and public IPs | `100.64.0.1` / `100.64.0.2` / `100.64.0.9` (CGNAT placeholders), `203.0.113.x` (TEST-NET-3) | 24 |
| GitHub user / org | `example-owner`, `<you>/<private-kushdarbar>` | 20 |
| Telegram chat / user ids | `OWNER_CHAT_ID` / `<OWNER_CHAT_ID>`, `<TEAMMATE_CHAT_ID>` | 17 |
| Email addresses | `someone@example.com`, `you@work.example`, `you@personal.example`, `seat-a@example.com` | 10 + 7 seat rows |
| Phone numbers | `<PHONE>`, `+<country code>...` | 1 (help text) |
| Stray identifiers (machine name, a side project, a podcast guest) | generic wording | 4 |

Files renamed: files named after the server host now use `server` (`dashboard/device/server.ts`,
`dashboard/device/fleet-server.ts`, `dashboard/pages/server/`,
`backup/*-server-backup.sh`) and launchd plists named after the owner or the company now use `com.example.*`.

Secrets found in the tree before sanitizing (besides the deleted `secrets/` bundle):
none. No Telegram bot tokens, API keys or OAuth secrets were present in plaintext.
Strings that look like keys (`sk-...`) were systemd unit names; they were renamed with
the company references.

## 4. Kept on purpose (owner decides)

- Software names `kushbot`, `KushDarbar`, `kush`, `kai`, `darbar`, `macctl`, `kc`.
  They derive from the owner's first name; rename before going public if that matters.
- Agent persona names as examples: `kai`, `guru`, `vaidya`, `munshi`, `pulse`,
  `daroga`, `raju`, `rishi`. Their health/finance/family content is gone; the names remain.
- Vendor names: Deepgram, Sarvam (TTS/STT voice ids include Indian first names such as
  `priya`, `anand`, `shubh`; these are the vendor's voice catalogue).
- Dates, Telegram example ids in `ACCESS.md` (they are the upstream plugin's own examples).

## 5. Needs the owner's eyes

| # | Where | Why |
|---|---|---|
| 1 | `fleet/restart-sons.sh:17,33,41,46,54` | Legacy script still lists the full real server roster (11 sons) with per-son homes; `raju`/`rishi` are named after, and paired with, real teammates (`teammate1-monorepo`, `teammate2-monorepo`). |
| 2 | `BROKER.md:9-14` | Describes who uses which agent (owner, two teammates, a family member; a health agent for a household). Placeholders hide names but not the household/team structure. |
| 3 | `docs/ROADMAP.md:5-9`, `gateway/README.md:5,96` | Describes sharing consumer ChatGPT/Grok subscriptions with teammates through a proxy. Public statement with possible terms-of-service implications. |
| 4 | `fleet/read-later/export-dia-cookies.py:2-5`, `fleet/read-later/README.md` ("The cookie file") | Tool that lifts logged-in browser cookies for YouTube/Google/X. Legitimate for personal use; decide whether to publish. |
| 5 | `fleet/quota.sh:55`, `dashboard/lib/usage.ts:241`, `fleet/quota-alert.sh:51` (and others) | Hard-coded `Asia/Kolkata` / IST everywhere reveals the owner's region; functional, so left in. |
| 6 | `dashboard/static/reading/reader.js:1797`, `dashboard/pages/mac/reading-align.ts:44`, `fleet/read-later/README.md:325` | Comments mention specific things the owner listened to / read. Harmless but personal. |
| 7 | `src/accounts.ts:59`, `fleet/statusline.zsh:116-192` | Account-label logic still models "work vs personal (shared with a household member)" seats. |
| 8 | `fleet/move:22,321-339` | Path-mapping code now points at `/Users/owner/work/monorepo` and `/home/owner/monorepo`; placeholders, not working defaults. |
| 9 | `dashboard/server.ts` device detection, `dashboard/device/*.ts` | Hostname substrings are now `laptop` / `server`; set `DASHBOARD_DEVICE` or edit before running. |
| 10 | `console/`, `tgs/` | Personal-productivity tools (Raycast, Saved Messages). Kept as code; decide whether they belong in a public fleet repo. |

## 6. Re-run the checks

From the repo root:

```bash
# secret scanner
gitleaks detect --no-git -s . --redact

# Telegram bot tokens
grep -rnIE '[0-9]{8,10}:[A-Za-z0-9_-]{35}' .
# common API key shapes
grep -rnIE '(sk-ant-[A-Za-z0-9]{8}|sk-[A-Za-z0-9]{32,}|ghp_[A-Za-z0-9]{20}|gho_|xox[bp]-|AKIA[0-9A-Z]{16}|tskey-[a-z]+-[A-Za-z0-9]{8}|AIza[0-9A-Za-z_-]{30}|phc_[A-Za-z0-9]{20}|TELEGRAM_BOT_TOKEN=[0-9])' .
# numeric ids that could be chat/user ids (expect only ACCESS.md examples + numeric constants)
grep -rnIoE '\b-?[0-9]{9,13}\b' . | grep -vE 'bun.lock|package-lock'
# Tailscale IPs other than the placeholders
grep -rnIoE '\b100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]+\.[0-9]+\b' . | grep -vE '100\.64\.0\.[129]\b'
# any other IPv4
grep -rnIoE '\b([0-9]{1,3}\.){3}[0-9]{1,3}\b' . | grep -vE '127\.0\.0\.1|0\.0\.0\.0|100\.64\.0\.|203\.0\.113\.'
# emails that are not placeholders
grep -rnIoE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}' . | grep -vE '@example\.com|\.example\b|noreply@anthropic|bun.lock|package-lock|git@github'
# personal names, hosts, companies: keep the term list OUTSIDE the repo, one regex per line
grep -rnIiE -f ~/pi-terms.txt .
```

The term list used for this pass is kept outside the repo (it contains the very names
being removed). At the time of publishing, the last command returned only vendor
voice-catalogue names.
