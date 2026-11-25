import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginPath = path.resolve(here, "../plugin/watchdog.js");
const source = fs.readFileSync(pluginPath, "utf8");
const require = createRequire(import.meta.url);
const module = { exports: {} };
vm.runInNewContext(source.replace("export default", "module.exports ="), {
  require,
  module,
  exports: module.exports,
  Buffer,
  Date,
  console,
  process,
});
const mod = module.exports;

const MIN = 60 * 1000;

test("V2.4 event payloads and legacy payloads parse identically", () => {
  const data = { sessionID: "ses_child", id: "call_1", input: { command: "git status" } };
  assert.equal(
    JSON.stringify(mod.parseSessionEvent({ type: "session.tool.called", data })),
    JSON.stringify({ type: "session.tool.called", sessionID: "ses_child", data })
  );
  assert.equal(
    JSON.stringify(mod.parseSessionEvent({ type: "session.tool.called", properties: { data } })),
    JSON.stringify({ type: "session.tool.called", sessionID: "ses_child", data })
  );
  assert.equal(
    JSON.stringify(mod.parseSessionEvent({ type: "session.tool.called", properties: data })),
    JSON.stringify({ type: "session.tool.called", sessionID: "ses_child", data })
  );
  assert.equal(mod.parseSessionEvent({ type: "server.connected", data: {} }), null);
});

test("assistant detection accepts V2.4 agent messages and legacy assistant messages", () => {
  assert.equal(mod.isAssistantMessage({ type: "assistant" }), true);
  assert.equal(mod.isAssistantMessage({ type: "agent" }), true);
  assert.equal(mod.isAssistantMessage({ type: "user" }), false);
});

test("child terminal classifier catches provider errors and empty finishes only", () => {
  assert.equal(
    JSON.stringify(mod.classifyChildTerminal({
      eventType: "session.execution.failed",
      error: { name: "APIError", message: "429 insufficient quota" },
      messages: [],
    })),
    JSON.stringify({ kind: "provider_error", category: "provider_rate_limit" })
  );
  assert.equal(
    JSON.stringify(mod.classifyChildTerminal({
      eventType: "session.execution.succeeded",
      messages: [
        { type: "agent", content: [{ type: "reasoning", text: "thinking..." }] },
      ],
    })),
    JSON.stringify({ kind: "empty_finish" })
  );
  assert.equal(
    mod.classifyChildTerminal({
      eventType: "session.execution.succeeded",
      messages: [
        { type: "agent", content: [{ type: "text", text: "done" }] },
      ],
    }),
    null
  );
  assert.equal(
    mod.classifyChildTerminal({
      eventType: "session.execution.succeeded",
      messages: [
        { type: "agent", content: [{ type: "tool", name: "shell", state: { status: "completed" } }] },
      ],
    }),
    null
  );
  assert.equal(
    mod.classifyChildTerminal({
      eventType: "session.execution.interrupted",
      reason: "user",
      messages: [],
    }),
    null
  );
});

test("diagnostic sanitizer masks credentials and control characters before persistence", () => {
  const out = mod.sanitizeDiagnostic("Bearer abcdefghijklmnop\nsk-1234567890abcdef password=supersecret123", 200);
  assert.equal(out.includes("abcdefghijklmnop"), false);
  assert.equal(out.includes("sk-1234567890abcdef"), false);
  assert.equal(out.includes("supersecret123"), false);
  assert.equal(/[\r\n]/.test(out), false);
  assert.equal(mod.sanitizeDiagnostic("x".repeat(500), 20).length <= 21, true);
});

test("tool budgets distinguish quick reads, long builds, and unknown commands", () => {
  assert.equal(mod.toolBudgetMs("read", { path: "a.go" }), 2 * MIN);
  assert.equal(mod.toolBudgetMs("edit", { path: "a.go" }), 2 * MIN);
  assert.equal(mod.toolBudgetMs("shell", { command: "git status" }), 2 * MIN);
  assert.equal(mod.toolBudgetMs("shell", { command: "go test ./..." }), 30 * MIN);
  assert.equal(mod.toolBudgetMs("shell", { command: "mystery --watch" }), 30 * MIN);
  assert.equal(mod.toolBudgetMs("subagent", {}), 60 * MIN);
  assert.equal(mod.isToolStalled(1000, 1000 + 2 * MIN, 2 * MIN), true);
  assert.equal(mod.isToolStalled(1000, 1000 + 2 * MIN - 1, 2 * MIN), false);
  assert.equal(mod.isToolStalled(0, 999999, 0), false);
});

test("parent notifications are grouped, deduped, and bounded", () => {
  const out = mod.aggregateParentNotifications([
    { parentID: "p1", text: "child A spinning" },
    { parentID: "p1", text: "child A spinning" },
    { parentID: "p1", text: "child B idle" },
    { parentID: "p2", text: "child C failed" },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].parentID, "p1");
  assert.equal((out[0].text.match(/child A spinning/g) || []).length, 1);
  assert.equal(out[0].text.includes("child B idle"), true);
  assert.equal(out[1].parentID, "p2");
  assert.equal(out[0].text.length < 4000, true);
});

test("watchdog prompts do not reset the wake budget; real user prompts do", () => {
  assert.equal(mod.isWatchdogPrompt("[watchdog] child failed"), true);
  assert.equal(mod.isWatchdogPrompt("  [watchdog] ping"), true);
  assert.equal(mod.isWatchdogPrompt("please continue"), false);
  assert.equal(mod.isWatchdogPrompt(""), false);
});
