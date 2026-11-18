#!/usr/bin/env bash
# Worktree Go env helper (superagent-ops). See go-env.ps1 for the policy.
# Usage: source tools/go-env.sh   (GOCACHE_PRIVATE=1 to isolate)
export GOWORK=off
top="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
name="$(basename "$top")"
if [ "${GOCACHE_PRIVATE:-0}" = "1" ]; then
  export GOCACHE="E:/dev/goPath/cache-$name"
  mkdir -p "$GOCACHE"
  echo "GOCACHE (private) = $GOCACHE"
else
  export GOCACHE="E:/dev/goPath/cache"
  echo "GOCACHE (shared)  = $GOCACHE  [GOCACHE_PRIVATE=1 to isolate]"
fi
