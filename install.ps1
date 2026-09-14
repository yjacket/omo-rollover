# Copy the extensions into the OMO global extension dir (no symlink).
$dst = Join-Path $HOME ".omo\agent\extensions"
New-Item -ItemType Directory -Force $dst | Out-Null
foreach ($f in "rollover.ts", "ulw-ledger-guard.ts") {
  Copy-Item (Join-Path $PSScriptRoot "extension\$f") (Join-Path $dst $f) -Force
  Write-Host "installed -> $(Join-Path $dst $f)"
}
Write-Host "In a running omo session type /reload (or restart omo). Check with /rollover status and /ledger-guard status."
