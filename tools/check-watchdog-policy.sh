#!/usr/bin/env bash
# Machine gate for watchdog v11: only children are supervised.
# A root session must never be the target of a watchdog send/nudge/interrupt.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
plugin="$repo/plugin/watchdog.js"

node --check "$plugin"

node - "$plugin" <<'NODE'
const fs = require("fs");
const src = fs.readFileSync(process.argv[2], "utf8");

const targets = [...src.matchAll(/\bsend\(\s*([A-Za-z0-9_.]+)/g)].map((m) => m[1]);
const allowed = new Set(["parentID", "s.parentID"]);
const badTargets = targets.filter((t) => !allowed.has(t));
if (badTargets.length) {
  console.error("FAIL: watchdog send() must target a parent only:", badTargets.join(", "));
  process.exit(1);
}

const forbidden = [
  "spin -> nudge self",
  "busy-parent nudge",
  "pre-kill warning",
  "stale, interrupting",
];
for (const needle of forbidden) {
  if (src.includes('"' + needle + '"')) {
    console.error("FAIL: root-session supervision returned:", needle);
    process.exit(1);
  }
}
for (const needle of [
  "root idle, no action:",
  "spin -> notify parent:",
  "child idle -> notify parent:",
  "child loop -> notify parent:",
]) {
  if (!src.includes('"' + needle + '"')) {
    console.error("FAIL: missing child-only policy marker:", needle);
    process.exit(1);
  }
}

console.log("PASS: watchdog send targets = parents only; root supervision disabled");
NODE
