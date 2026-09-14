#!/usr/bin/env sh
# Copy the extension into the OMO global extension dir (no symlink).
set -e
dst="$HOME/.omo/agent/extensions"
mkdir -p "$dst"
for f in rollover.ts ulw-ledger-guard.ts; do
  cp "$(dirname "$0")/extension/$f" "$dst/$f"
  echo "installed -> $dst/$f"
done
echo "In a running omo session type /reload (or restart omo). Check with /rollover status and /ledger-guard status."
