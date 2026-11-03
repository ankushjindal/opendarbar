# broker.ts — per-user sessions on one bot (deployment plan)

**Status: planned, not deployed.** the owner greenlit the plan on 2026-07-14; nothing is
running. The daemon exists (`broker.ts`), the client half is fully wired in `server.ts`
(`broker-client` mode, ~30 references), and there is no launcher.

## The problem it solves

`guru` serves **four people** — the owner, a teammate, a family member, another teammate — and `vaidya` serves
**two** (the owner + a family member). Today each is ONE session, so all four users share one
conversation, one context window, and one memory. a teammate's question lands in the same
thread as a family member's. That is wrong for a *learning* agent whose whole value is a per-user
knowledge graph (`~/learn/<user>/`), and it is wrong for a health agent handling two
people's private data in one context.

The obvious fix — one bot per person — means four BotFather bots, four tokens, four
allowlists, four `/newbot` dances per agent. And Telegram permits exactly **one
`getUpdates` consumer per token**, which is the actual constraint underneath.

## How the broker fixes it

One token, one poller, N sessions:

```
Telegram ──getUpdates──▶ broker.ts        (the ONLY poller for @example_guru_bot)
                            │  routes by user_id, over a Unix socket
              ┌─────────────┼─────────────┬─────────────┐
              ▼             ▼             ▼             ▼
         guru:owner   guru:teammate1   guru:family1   guru:teammate2
         (own HOME, own session, own context, own ~/learn/<user>/)
```

Each session runs `server.ts` in `broker-client` mode: it connects to the socket,
subscribes with its own `allowFrom` filter, and feeds forwarded updates through its
normal handler stack via `bot.handleUpdate()`. **Outbound is not proxied** — replies are
stateless HTTPS that each client sends directly with the shared token. Only `getUpdates`
is exclusive, so only `getUpdates` is brokered.

Offline sessions don't lose mail: the broker queues per-label (bounded, ordered by
`update_id`) and flushes on reconnect.

## Deployment steps

1. **Routes.** `<channelsDir>/routes.json`:
   ```json
   { "routes": { "<OWNER_CHAT_ID>": "owner", "<TEAMMATE_CHAT_ID>": "teammate1",
                 "<family1_id>": "family1", "<teammate2_id>": "teammate2" },
     "default": "unrouted" }
   ```
   An unrouted DM gets a one-line "ask the operator to add your ID" reply and is logged
   to `unrouted.log`. It is never silently dropped.

2. **Per-user HOMEs.** `~/guru-owner-home/`, `~/guru-teammate1-home/`, … Each needs its
   own `.credentials.json` (**OAuth does not transfer across HOMEs** — one browser dance
   each) and a `kushbot.json` with `mode: "broker-client"` + a `label` matching
   routes.json. They SHARE the token `.env` at the broker's channels dir.

3. **Registry + fleet-ctl.** Add `guru-owner`, `guru-teammate1`, … as agents so
   `fleet-ctl` and the watchdog manage them like any son. The broker daemon itself needs
   a systemd unit (`fleet/systemd/`), because nothing currently launches it.

4. **Persona.** One shared `guru.md`; per-user knowledge stays in `~/learn/<user>/`,
   which the persona already assumes.

## What to watch

- **The broker is a single point of failure for the whole bot.** If it dies, all four
  users go deaf at once — worse than today's shared session, which at least fails
  independently. It needs watchdog coverage *before* it carries real traffic.
- **Token blast radius.** Every broker-client holds the same bot token and can send as
  the bot. Fine for a family/team bot; not fine if a session is ever untrusted.
- **Cost.** 4 sessions instead of 1 = 4 context windows against the same Anthropic quota
  pool. `guru` × 4 + `vaidya` × 2 replaces 2 sessions with 6.
- The daemon has been committed and untouched since 2026-06-09. **Re-read it before
  trusting it** — it has never run in production.

## Recommendation

Do `vaidya` first (2 users, both household, lowest stakes) as the proving ground, and
only then `guru` (4 users, two of them co-workers). Add the systemd unit + watchdog
coverage in the same change — a broker without a watchdog is a worse failure mode than
the shared session it replaces.
