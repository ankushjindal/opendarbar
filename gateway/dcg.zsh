# dcg — Claude Code through the local CLIProxyAPI gateway (GPT + Grok brains,
# Claude Code harness). Source this file from ~/.zshrc on EVERY machine:
#
#   Mac:    source ~/.claude/plugins/local/kushbot/gateway/dcg.zsh
#   server: source ~/kai/KushDarbar/gateway/dcg.zsh
#
# The `dcg` command is then IDENTICAL on all machines. See gateway/README.md
# for what this is, why, and the caveats (resume rule, model-save gotcha, ToS).
#
# Requirements on the machine: cliproxyapi running on 127.0.0.1:8317 with a
# client key at ~/.cli-proxy-api/client-key.txt (gateway/install.sh sets all
# of this up) and provider OAuth logins done (codex + xai).

DCG_PORT="${DCG_PORT:-8317}"
DCG_KEY_FILE="${DCG_KEY_FILE:-$HOME/.cli-proxy-api/client-key.txt}"
DCG_DEFAULT_MODEL="${DCG_DEFAULT_MODEL:-gpt-5.6-sol}"

dcg() {
  if [ ! -r "$DCG_KEY_FILE" ]; then
    echo "dcg: no client key at $DCG_KEY_FILE — run gateway/install.sh first" >&2
    return 1
  fi
  if ! curl -sf -m 2 -o /dev/null "http://127.0.0.1:${DCG_PORT}/" 2>/dev/null; then
    # / may 404 while the service is fine; probe the models endpoint too
    if ! curl -s -m 2 -o /dev/null -H "x-api-key: $(cat "$DCG_KEY_FILE")" \
        "http://127.0.0.1:${DCG_PORT}/v1/models" 2>/dev/null; then
      echo "dcg: cliproxyapi not reachable on 127.0.0.1:${DCG_PORT}" >&2
      echo "     Mac: brew services start cliproxyapi | server: sudo systemctl start cliproxyapi" >&2
      return 1
    fi
  fi
  local -a args=("$@") modelflag=()
  # Only inject the default model when the caller didn't pick one.
  [[ " $* " != *" --model"* ]] && modelflag=(--model "$DCG_DEFAULT_MODEL")
  ANTHROPIC_BASE_URL="http://127.0.0.1:${DCG_PORT}" \
  ANTHROPIC_AUTH_TOKEN="$(cat "$DCG_KEY_FILE")" \
  CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1 \
  claude --dangerously-load-development-channels server:kushbot \
    --dangerously-skip-permissions "${modelflag[@]}" "${args[@]}"
}

# dcg-status — one-liner health check of the gateway itself.
dcg-status() {
  local key; key="$(cat "$DCG_KEY_FILE" 2>/dev/null)" || { echo "no client key"; return 1; }
  curl -s -m 5 -H "x-api-key: $key" "http://127.0.0.1:${DCG_PORT}/v1/models" \
    | python3 -c 'import sys,json; d=json.load(sys.stdin); print("gateway up ·", len(d.get("data",[])), "models")' \
    2>/dev/null || echo "gateway DOWN on 127.0.0.1:${DCG_PORT}"
}
