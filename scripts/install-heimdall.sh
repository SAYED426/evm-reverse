#!/usr/bin/env bash
#
# Install the Heimdall decompiler binary into ~/.local/bin.
#
# Heimdall is a Rust tool. The release publishes prebuilt Linux x86_64 binaries,
# so no Rust toolchain is needed. Override with:
#   HEIMDALL_VERSION=<tag>    release tag to install (default: 0.9.3)
#   HEIMDALL_BIN=<path>       destination path (default: ~/.local/bin/heimdall)
#
# On macOS or arm64 you will need to build from source:
#   https://github.com/Jon-Becker/heimdall-rs

set -euo pipefail

VERSION="${HEIMDALL_VERSION:-0.9.3}"
DEST="${HEIMDALL_BIN:-$HOME/.local/bin/heimdall}"
URL="https://github.com/Jon-Becker/heimdall-rs/releases/download/${VERSION}/heimdall-linux-amd64"

mkdir -p "$(dirname "$DEST")"

echo "downloading heimdall ${VERSION}"
echo "  ${URL}"
curl -fsSL -o "$DEST" "$URL"
chmod +x "$DEST"

echo
echo "installed:"
"$DEST" --version || true

case ":$PATH:" in
  *":$(dirname "$DEST"):"*) ;;
  *)
    echo
    echo "note: $(dirname "$DEST") is not on your PATH."
    echo "      add this to your shell profile:"
    echo "        export PATH=\"\$HOME/.local/bin:\$PATH\""
    ;;
esac
