# KushDarbar roadmap: parked ideas

Ideas the owner has explicitly parked. Not scheduled. Each entry says why it is worth doing, what exists already, and what the first step would be. Do not start any of these without his word.

## Serve Codex, Grok and other model accounts to teammates from server (parked 2026-09-11)

Why: teammates (another teammate first) want to use Grok and Codex without the owner's account being logged in on their machines. Copying the credential json is the wrong shape: one login fighting across machines, no per-person revocation.

What exists: cliproxyapi runs on server (`systemctl --user cliproxyapi`, port 8317) holding `~/.cli-proxy-api/xai-<account>.json` (Grok, 14 models incl. grok-4.6, grok-4.5, grok-4.3, grok-4.20 variants, imagine) and `codex-<account>-plus.json` (Codex). One client key in `client-key.txt`. `fleet-ctl start --engine gateway --model <id>` already consumes it; `gateway/README.md` has the rules. Claude Code clients switch model in-session with `/model <id>` when launched without a `--model` pin.

Shape when picked up:
1. Per-person client keys in cliproxyapi `api-keys` (label per teammate), so revocation is deleting a key and usage shows per key in `logs/`.
2. Reach: teammate joins the tailnet, or `tailscale serve` puts the gateway on HTTPS without adding devices.
3. Hand-out: two lines per client type (Claude Code: `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`; OpenAI-compatible: `/v1` base URL + key).
4. Later: more providers behind the same door (Gemini, others cliproxyapi supports), quotas per key if cliproxyapi grows them, a darbar scan row per key.

Caveats to state when it ships: shared consumer rate limits (one teammate's heavy day slows everyone), and account-level exposure if a provider objects to shared consumer use. Real API volume belongs on a proper API key (console.x.ai / OpenAI platform) with a spend cap, not on this door.
