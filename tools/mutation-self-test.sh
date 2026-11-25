#!/usr/bin/env bash
# Prove the watchdog gate is falsifiable: each mutation must turn it red.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/plugin" "$tmp/test" "$tmp/tools"
cp "$repo/plugin/watchdog.js" "$tmp/plugin/"
cp "$repo/test/"*.mjs "$tmp/test/"
cp "$repo/tools/check-watchdog-policy.sh" "$tmp/tools/"

mutate() {
  local name="$1" old="$2" new="$3"
  node - "$tmp/plugin/watchdog.js" "$old" "$new" <<'NODE'
const fs = require("fs");
const [file, oldText, newText] = process.argv.slice(2);
const src = fs.readFileSync(file, "utf8");
if (!src.includes(oldText)) {
  console.error("mutation anchor missing:", oldText);
  process.exit(2);
}
fs.writeFileSync(file, src.replace(oldText, newText));
NODE
  if bash "$tmp/tools/check-watchdog-policy.sh" >"$tmp/$name.log" 2>&1; then
    echo "FAIL: mutation did not turn gate red: $name"
    cat "$tmp/$name.log"
    exit 1
  fi
  echo "PASS: mutation turned gate red: $name"
  cp "$repo/plugin/watchdog.js" "$tmp/plugin/watchdog.js"
}

mutate "terminal-error-blind" \
  'return { kind: "provider_error", category: errorCategory(error) }' \
  'return null'
mutate "quick-tool-budget-lost" \
  'if (QUICK_TOOLS.has(n)) return QUICK_TOOL_MS' \
  'if (QUICK_TOOLS.has(n)) return LONG_TOOL_MS'
mutate "v24-event-data-blind" \
  'const data = event.data || p.data || p' \
  'const data = p.data || p'
mutate "wake-budget-no-reset" \
  'if (!isWatchdogPrompt(text)) wakeCount.delete(id)' \
  'wakeCount.delete(id)'

bash "$tmp/tools/check-watchdog-policy.sh" >/dev/null
echo "PASS: restored implementation is green"
