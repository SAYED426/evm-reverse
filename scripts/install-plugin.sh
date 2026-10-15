#!/usr/bin/env bash
#
# Register the evm-reverse OpenCode plugin with the OpenCode config on this
# machine.
#
# The plugin file is copied into <config>/plugins/evm-reverse and the config is
# updated to point at it. Existing config files are left alone (you get the
# snippet to paste instead of a rewrite).
#
# Config directory resolution, in order:
#   1. $EVM_REVERSE_OPENCODE_DIR
#   2. ~/.config/opencode                    (native Linux/macOS)
#   3. <Windows profile>/.config/opencode    (WSL, via cmd.exe)
#
# Override the CLI/home used by the plugin with:
#   EVM_REVERSE_WSL_HOME=<linux home>   EVM_REVERSE_CLI=<path to bin/evm-reverse>

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO_DIR/plugins/evm-reverse"

# ---------------------------------------------------------------- config dir

resolve_config_dir() {
  if [ -n "${EVM_REVERSE_OPENCODE_DIR:-}" ]; then
    printf '%s' "$EVM_REVERSE_OPENCODE_DIR"
    return
  fi
  if [ -d "$HOME/.config/opencode" ]; then
    printf '%s' "$HOME/.config/opencode"
    return
  fi
  if command -v cmd.exe >/dev/null 2>&1; then
    local win_profile
    win_profile="$(cmd.exe /c 'echo %USERPROFILE%' 2>/dev/null | tr -d '\r' || true)"
    if [ -n "$win_profile" ] && command -v wslpath >/dev/null 2>&1; then
      local linux_profile
      linux_profile="$(wslpath "$win_profile" 2>/dev/null || true)"
      if [ -n "$linux_profile" ] && [ -d "$linux_profile/.config/opencode" ]; then
        printf '%s' "$linux_profile/.config/opencode"
        return
      fi
    fi
  fi
}

# OpenCode may run on the host while this script runs inside WSL, so the path we
# write into the config must be one the host understands.
to_host_path() {
  local path="$1"
  if [[ "$path" =~ ^/mnt/([a-zA-Z])/(.*)$ ]]; then
    printf '%s:/%s' "$(printf '%s' "${BASH_REMATCH[1]}" | tr '[:lower:]' '[:upper:]')" "${BASH_REMATCH[2]}"
  else
    printf '%s' "$path"
  fi
}

CONFIG_DIR="$(resolve_config_dir || true)"
if [ -z "$CONFIG_DIR" ]; then
  echo "error: could not locate an OpenCode config directory." >&2
  echo "       set EVM_REVERSE_OPENCODE_DIR=/path/to/.config/opencode and re-run." >&2
  exit 1
fi

# ------------------------------------------------------------------- install

DEST_PLUGINS="$CONFIG_DIR/plugins"
mkdir -p "$DEST_PLUGINS"
rm -rf "$DEST_PLUGINS/evm-reverse"
cp -r "$SRC" "$DEST_PLUGINS/evm-reverse"

HOST_PLUGIN_PATH="$(to_host_path "$DEST_PLUGINS/evm-reverse")"

CONFIG="$CONFIG_DIR/opencode.jsonc"
if [ -f "$CONFIG" ]; then
  echo "config already exists — leaving it untouched: $CONFIG"
  echo "make sure it lists this plugin path:"
  echo
  echo "  \"$HOST_PLUGIN_PATH\""
  echo
else
  cat > "$CONFIG" <<JSON
{
  "\$schema": "https://opencode.ai/config.json",
  "plugins": [
    "$HOST_PLUGIN_PATH"
  ]
}
JSON
  echo "wrote $CONFIG"
fi

echo "--- installed plugin ---"
find "$DEST_PLUGINS/evm-reverse" -type f | sed "s|^|  |"
echo
echo "restart OpenCode so the plugin is picked up."
