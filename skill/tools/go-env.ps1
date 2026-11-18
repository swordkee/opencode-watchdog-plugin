# Worktree Go env helper (superagent-ops).
# Default: SHARED GOCACHE (Go's build cache is documented as safe for
# concurrent use by multiple go commands). Set GOCACHE_PRIVATE=1 to isolate
# this worktree's cache — only needed when concurrent go test runs in the
# same repo historically produced cross-worktree false failures.
#
# Usage (dot-source so env vars stick):
#   . "$HOME\.agents\skills\superagent-ops\tools\go-env.ps1"
$ErrorActionPreference = "Stop"
$env:GOWORK = "off"
try { $top = (git rev-parse --show-toplevel 2>$null).Trim() } catch { $top = (Get-Location).Path }
$name = Split-Path $top -Leaf
if ($env:GOCACHE_PRIVATE -eq "1") {
  $env:GOCACHE = "E:\dev\goPath\cache-$name"
  New-Item -ItemType Directory -Force -Path $env:GOCACHE | Out-Null
  Write-Host "GOCACHE (private) = $env:GOCACHE"
} else {
  $env:GOCACHE = "E:\dev\goPath\cache"
  Write-Host "GOCACHE (shared)  = $env:GOCACHE  [GOCACHE_PRIVATE=1 to isolate]"
}
