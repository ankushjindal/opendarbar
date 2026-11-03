# gateway — GPT + Grok inside Claude Code (`dcg`)

Run **non-Claude brains in the Claude Code harness**: same tools, skills, MCP
(kushbot!), subagents, session files — but the model answering is GPT or Grok,
billed to the owner's ChatGPT / xAI subscriptions instead of Anthropic.

The trick is **CLIProxyAPI**: a local server on `127.0.0.1:8317` that
impersonates the Anthropic API. Claude Code is pointed at it via
`ANTHROPIC_BASE_URL`; the proxy reads the model name on each request and routes
`gpt-*` → OpenAI (ChatGPT OAuth), `grok-*` → xAI (Grok OAuth), translating
formats both ways. Claude Code cannot tell the difference.

**The engine-choice ladder (the owner, 2026-07-14):** prefer `dcg` (GPT in our
harness) > the official codex plugin (`/codex:review`, delegation) >
codex-bridge (full Codex harness on TG). All three coexist; each has its use.

## Install (per machine)

```bash
./install.sh          # install + harden + start (idempotent)
./install.sh --check  # audit only
```

Then the two provider logins, ONCE per machine (interactive, needs the owner's
browser/phone — both are device flows, URL + code, no localhost callback):

```bash
<bin> -codex-device-login     # GPT (ChatGPT account)
<bin> -xai-login -no-browser  # Grok (xAI account)
```

`<bin>` = `/opt/homebrew/opt/cliproxyapi/bin/cliproxyapi` (Mac) or
`~/cliproxyapi/cli-proxy-api` (server). Credentials land in
`~/.cli-proxy-api/*.json`.

Finally, source the launcher from `~/.zshrc` (path differs per machine, the
command doesn't):

```zsh
source ~/.claude/plugins/local/kushbot/gateway/dcg.zsh   # Mac
source ~/kai/KushDarbar/gateway/dcg.zsh                  # server
```

## Use

```bash
dcg                        # session on gpt-5.6-sol (default)
dcg --model grok-4.5       # session on Grok
dcg --resume <id>          # resume a gateway session (see RULES)
dcg-status                 # is the gateway up, how many models
/model grok-4.5            # hop models MID-SESSION (context carries over!)
```

`/model` picker is auto-populated from the gateway
(`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`). Ignore the weird
`claude-fable-5-dd-…` entries — that's the proxy disguising foreign models for
strict clients; the real names (`gpt-5.6-sol`, `grok-4.5`) work directly.

## RULES — read before using (each learned the hard way)

1. **Resume gateway sessions ONLY with `dcg --resume`.** A session whose model
   is `gpt-*`/`grok-*` resumed via plain `dc` sends that model name to the real
   Anthropic API and dies.
2. **Mid-session model switch: confirm with `s`, not Enter.** Enter SAVES the
   model as the machine-wide default → every plain `claude`/`dc` session then
   tries a gateway model against Anthropic and errors on boot. (Happened
   2026-07-14; fix: set `"model"` back to a real alias in
   `~/.claude/settings.json`.)
3. **Never wire kc / kai / fleet bots through the gateway.** Proxied sessions
   lose claude.ai connectors + remote control, and Claude-account-via-proxy is
   the ToS-riskiest move (see below). The gateway is for ad-hoc/opt-in sessions.
4. **No Claude auth lives in the proxy — by design.** `/model opus` inside a
   dcg session will NOT route. Decision on adding an Anthropic **API key**
   (metered, legit) is the owner's, pending. **The gateway only serves four
   models — `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `grok-4.5` — and
   NOTHING claude-*.** Requesting any Claude model returns `502 unknown
   provider for model claude-…`. Equivalence when you must pick by hand:

   | Anthropic tier | gateway equivalent |
   |---|---|
   | Opus    | `gpt-5.6-terra` (or `grok-4.5`) |
   | Sonnet  | `gpt-5.6-luna` |
   | Fable   | `gpt-5.6-sol` |

   **Subagent gotcha (2026-07-15):** a dcg session's Task/workflow **subagents**
   don't inherit the gateway model — they request their own (often
   `claude-sonnet-5`), which 502s and kills the subagent. Until the proxy
   aliases claude-* → the equivalents above (right fix, mechanism TBD — the
   auth-JSON `models:` field is api-key-only; OAuth auths need the management
   API), spawn subagents with an explicit gateway model, e.g. workflow
   `agent(prompt, {model: 'gpt-5.6-luna'})` or an agent def pinned to a gateway
   model — never a bare `sonnet`/`opus`.
5. **`~/.cli-proxy-api/` is never backed up or committed.** It is 100% live
   OAuth credentials. Recovery = re-run the two login flows (~2 min), same
   policy as `claude /login`. Auth is always re-earned, never restored.
6. **Quota, not tokens:** dcg turns burn the ChatGPT Plus / Grok subscription
   quotas. Claude Code's harness is chattier than Codex's (~3x token use on
   comparable tasks per community benchmarks) — heavy dcg use hits Plus limits
   fast. Mid-turn errors on gpt models usually = quota, not breakage.
7. **ToS posture (be honest with yourself):** subscription OAuth through an
   unofficial proxy is against OpenAI/xAI terms; enforcement = account bans
   (reports exist in the wild). We keep it opt-in, localhost-only, cloaking
   features OFF. The ToS-clean alternatives: the official codex plugin
   (delegation) and codex-bridge (real Codex CLI).

## Known gaps (upstream CLIProxyAPI issues)

- Vision/image inputs not forwarded to gpt-codex models (#1806).
- Very large prompts can fail on the codex route (#636).
- Tool-calling is solid on the native codex/xai OAuth routes we use; the
  horror stories (#1741 etc.) are about third-party OpenAI-compat upstreams.

## Files

- `dcg.zsh` — the `dcg` + `dcg-status` shell functions (sourced from zshrc)
- `install.sh` — install + harden + start, Mac (brew) and Linux (installer+systemd)
- Proxy config: `/opt/homebrew/etc/cliproxyapi.conf` (Mac),
  `~/cliproxyapi/config.yaml` (server, user systemd unit `cliproxyapi.service`).
  Hardening = bind `127.0.0.1`,
  single generated client key at `~/.cli-proxy-api/client-key.txt` (600).

## Sessions & backup

dcg sessions are ordinary Claude Code sessions — jsonl under
`~/.claude/projects/…`, covered by the existing claude-data backups. Nothing
new to back up except NOTHING: the proxy's auth dir is deliberately excluded
(rule 5).
