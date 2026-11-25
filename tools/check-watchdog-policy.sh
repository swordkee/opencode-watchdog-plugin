#!/usr/bin/env bash
# Machine gate for watchdog v12:
#   - roots are never watchdog targets
#   - V2.4 event.data + agent-message schema are supported
#   - child terminal failures, per-tool budgets, and parent batching are wired
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
plugin="$repo/plugin/watchdog.js"

node --check "$plugin"
node --test "$repo/test/watchdog-rules.test.mjs"
node --test "$repo/test/watchdog-integration.test.mjs"

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
  'log("stale, interrupting:',
  'm.type !== "assistant"',
  "fetchRunningTool",
];
for (const needle of forbidden) {
  if (src.includes(needle)) {
    console.error("FAIL: obsolete/root-supervision shape returned:", needle);
    process.exit(1);
  }
}

const required = [
  "parseSessionEvent(event)",
  "inspectChildTerminal(id, eventType, d, gen)",
  "reconcileTools(id, toolStates)",
  "hasProtectedTool(id, now)",
  "queueParentNotification(",
  'ctx.session.hook("prompt"',
  "root idle, no action:",
  "spin -> notify parent:",
  "child idle -> notify parent:",
  "child loop -> notify parent:",
  "child terminal -> notify parent:",
  "child tool stall -> notify parent:",
];
for (const needle of required) {
  if (!src.includes(needle)) {
    console.error("FAIL: missing v12 wiring marker:", needle);
    process.exit(1);
  }
}

console.log("PASS: watchdog v12 rules, integration, and child-only policy gates");
NODE
