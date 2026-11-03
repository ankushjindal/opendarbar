#!/usr/bin/env bash
# tg-reply-guard — Claude Code Stop hook (kushbot-improvements 2026-07-03, item 6).
#
# Blocks a turn from ending when the latest Telegram channel inbound got NO
# outbound kushbot tool call (reply/react/edit_message/ask) after it — the
# "answered in the terminal that the owner never sees" failure class. The
# CLAUDE.md routing rule is prompt-level discipline; this is the mechanical
# backstop.
#
# Loop escape: when stop_hook_active is true we already blocked once this
# turn — allow the stop rather than ping-pong forever.
set -uo pipefail

payload=$(cat)
python3 - "$payload" <<'PYEOF'
import json, sys

try:
    hook = json.loads(sys.argv[1])
except Exception:
    sys.exit(0)

if hook.get("stop_hook_active"):
    sys.exit(0)  # already blocked once this turn — let it stop

tp = hook.get("transcript_path")
if not tp:
    sys.exit(0)

REPLY_TOOLS = (
    "mcp__kushbot__reply", "mcp__kushbot__react", "mcp__kushbot__edit_message",
    "mcp__kushbot__ask", "mcp__plugin_telegram_telegram__reply",
    "mcp__plugin_telegram_telegram__react", "mcp__plugin_telegram_telegram__edit_message",
)

try:
    with open(tp, "r", errors="replace") as f:
        lines = f.readlines()[-600:]   # tail is plenty: one turn's worth
except Exception:
    sys.exit(0)

last_inbound = None   # index of last real channel inbound (user turn)
answered_after = False
for i, ln in enumerate(lines):
    try:
        e = json.loads(ln)
    except Exception:
        continue
    t = e.get("type")
    msg = e.get("message") or {}
    content = msg.get("content")
    if t == "user":
        # channel inbound? (exclude tg-slash injections — not routable-back)
        text = ""
        if isinstance(content, str):
            text = content
        elif isinstance(content, list):
            text = " ".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")
        if '<channel source=' in text and 'source="tg-slash"' not in text:
            last_inbound = i
            answered_after = False
    elif t == "assistant" and last_inbound is not None and isinstance(content, list):
        for b in content:
            if isinstance(b, dict) and b.get("type") == "tool_use" and b.get("name") in REPLY_TOOLS:
                answered_after = True
                break

if last_inbound is not None and not answered_after:
    print(json.dumps({
        "decision": "block",
        "reason": ("A Telegram channel inbound in this turn has no kushbot reply/react/edit_message call after it. "
                   "The user CANNOT see terminal text. Send your answer now via mcp__kushbot__reply "
                   "(chat_id from the inbound tag). If you already answered substantively and this inbound "
                   "truly needs no reply, send a one-line ack instead."),
    }))
    sys.exit(0)

sys.exit(0)
PYEOF
