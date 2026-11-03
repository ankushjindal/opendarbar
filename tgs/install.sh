#!/bin/sh
# Installs the `tgs` launcher into ~/bin and (optionally) the tgsd launchd agent.
#   ./install.sh            # launcher only
#   ./install.sh --launchd  # also install + load com.example.tgsd (keeps tgsd alive)
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
VENV="$HOME/.config/tgs/venv"
PY="$VENV/bin/python"
# Deployed copy: runtime never depends on the repo checkout path. (Also dodges macOS TCC, which
# blocks background processes from ~/Downloads and hangs Python at startup.)
DEPLOY="$HOME/.config/tgs/tgs.py"

if [ ! -x "$PY" ]; then
  echo "creating venv at $VENV"
  mkdir -p "$HOME/.config/tgs" && chmod 700 "$HOME/.config/tgs"
  uv venv --python 3.13 "$VENV"
  uv pip install --python "$PY" telethon
fi

cp "$HERE/tgs.py" "$DEPLOY" && chmod 644 "$DEPLOY"
mkdir -p "$HOME/bin"
cat > "$HOME/bin/tgs" <<LAUNCH
#!/bin/sh
exec "$PY" "$DEPLOY" "\$@"
LAUNCH
chmod +x "$HOME/bin/tgs"
echo "deployed $HERE/tgs.py -> $DEPLOY ; launcher ~/bin/tgs"

if [ "$1" = "--launchd" ]; then
  PLIST="$HOME/Library/LaunchAgents/com.example.tgsd.plist"
  sed -e "s|__PY__|$PY|g" -e "s|__TGS__|$DEPLOY|g" -e "s|__HOME__|$HOME|g" \
    "$HERE/com.example.tgsd.plist" > "$PLIST"
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST"
  echo "loaded $PLIST"
fi
