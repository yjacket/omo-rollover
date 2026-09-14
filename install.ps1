# Copy the extension into the OMO global extension dir (no symlink).
$dst = Join-Path $HOME ".omo\agent\extensions\rollover.ts"
New-Item -ItemType Directory -Force (Split-Path $dst) | Out-Null
Copy-Item (Join-Path $PSScriptRoot "extension\rollover.ts") $dst -Force
Write-Host "installed -> $dst"
Write-Host "In a running omo session type /reload (or restart omo). Check with /rollover status."
