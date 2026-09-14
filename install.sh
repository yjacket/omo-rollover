#!/usr/bin/env sh
# Copy the extension into the OMO global extension dir (no symlink).
set -e
dst="$HOME/.omo/agent/extensions/rollover.ts"
mkdir -p "$(dirname "$dst")"
cp "$(dirname "$0")/extension/rollover.ts" "$dst"
echo "installed -> $dst"
echo "In a running omo session type /reload (or restart omo). Check with /rollover status."
