import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.resolve(here, "../plugin/watchdog.js"), "utf8");

function loadPlugin({ fetchImpl, spawnImpl }) {
  const module = { exports: {} };
  const fakeFs = {
    readFileSync(file, encoding) {
      if (String(file).endsWith("notify-state.json")) return "{}";
      return fs.readFileSync(file, encoding);
    },
    appendFileSync() {},
    mkdirSync() {},
    writeFileSync() {},
    openSync() { return 1; },
  };
  const fakeRequire = (id) => {
    if (id === "fs") return fakeFs;
    if (id === "child_process") return { spawn: spawnImpl || (() => ({ unref() {} })) };
    return require(id);
  };
  vm.runInNewContext(source.replace("export default", "module.exports ="), {
    require: fakeRequire,
    module,
    exports: module.exports,
    Buffer,
    Date,
    AbortController,
    console,
    process,
    fetch: fetchImpl,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  });
  return module.exports;
}

function eventBus() {
  const queue = [];
  let waiter = null;
  return {
    iterator: {
      [Symbol.asyncIterator]() { return this; },
      next() {
        if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
        return new Promise((resolve) => { waiter = resolve; });
      },
      return() { return Promise.resolve({ done: true }); },
    },
    emit(event) {
      if (waiter) {
        const resolve = waiter;
        waiter = null;
        resolve({ value: event, done: false });
      } else {
        queue.push(event);
      }
    },
  };
}

async function flush() {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

function harness() {
  const bus = eventBus();
  const prompts = [];
  const interrupts = [];
  const contexts = new Map();
  const messages = new Map();
  const sessions = new Map();
  let promptHook = null;
  const directory = "E:/work/watchdog-test";
  const session = (id, parentID, title) => ({
    id,
    parentID,
    title,
    location: { directory },
    time: { created: Date.now(), updated: Date.now() },
  });
  const addSession = (id, parentID, title) => sessions.set(id, session(id, parentID, title));
  const fetchImpl = async (url) => {
    if (String(url).endsWith("/api/session/active")) {
      return { ok: true, json: async () => ({ data: Object.fromEntries([...sessions.keys()].map((id) => [id, {}])) }) };
    }
    const m = String(url).match(/\/api\/session\/([^/]+)\/message/);
    if (m) {
      return { ok: true, json: async () => ({ data: messages.get(m[1]) || [] }) };
    }
    return { ok: false };
  };
  const ctx = {
    location: { directory },
    model: {
      list: async () => [],
      default: async () => null,
    },
    session: {
      list: async () => [],
      get: async ({ sessionID }) => sessions.get(sessionID),
      context: async ({ sessionID }) => contexts.get(sessionID) || [],
      prompt: async (p) => { prompts.push(p); },
      interrupt: async (p) => { interrupts.push(p); },
      hook: async (name, fn) => { if (name === "prompt") promptHook = fn; },
    },
    event: { subscribe: () => bus.iterator },
    rpc: () => { throw new Error("no goal rpc in test"); },
  };
  return {
    ctx, bus, prompts, interrupts, contexts, messages, sessions,
    addSession,
    get promptHook() { return promptHook; },
  };
}

test("two failed children produce one aggregated parent notification", async (t) => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  mock.timers.setTime(Date.UTC(2026, 10, 25));
  t.after(() => mock.timers.reset());
  const h = harness();
  h.addSession("parent", null, "parent");
  h.addSession("child-a", "parent", "child A");
  h.addSession("child-b", "parent", "child B");
  const plugin = loadPlugin({ fetchImpl: async (url) => {
    if (String(url).endsWith("/api/session/active")) {
      return { ok: true, json: async () => ({ data: { parent: {}, "child-a": {}, "child-b": {} } }) };
    }
    return { ok: false };
  } });
  const cleanup = await plugin.setup(h.ctx);
  h.bus.emit({ type: "session.created", data: { sessionID: "child-a", parentID: "parent" } });
  h.bus.emit({ type: "session.execution.started", data: { sessionID: "child-a" } });
  h.bus.emit({ type: "session.execution.failed", data: { sessionID: "child-a", error: { name: "APIError", message: "429 quota" } } });
  h.bus.emit({ type: "session.created", data: { sessionID: "child-b", parentID: "parent" } });
  h.bus.emit({ type: "session.execution.started", data: { sessionID: "child-b" } });
  h.bus.emit({ type: "session.execution.failed", data: { sessionID: "child-b", error: { name: "AuthError", message: "401" } } });
  await flush();
  mock.timers.tick(2000);
  await flush();
  assert.equal(h.prompts.length, 1);
  assert.equal(h.prompts[0].sessionID, "parent");
  assert.match(h.prompts[0].text, /child A/);
  assert.match(h.prompts[0].text, /child B/);
  assert.match(h.prompts[0].text, /provider_rate_limit/);
  assert.match(h.prompts[0].text, /provider_auth/);
  cleanup();
});

test("empty successful child finish notifies; normal text completion does not", async (t) => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  mock.timers.setTime(Date.UTC(2026, 10, 25));
  t.after(() => mock.timers.reset());
  const h = harness();
  h.addSession("parent", null, "parent");
  h.addSession("empty", "parent", "empty child");
  h.addSession("done", "parent", "done child");
  h.contexts.set("empty", [{ type: "agent", content: [{ type: "reasoning", text: "thinking" }] }]);
  h.contexts.set("done", [{ type: "agent", content: [{ type: "text", text: "finished" }] }]);
  const plugin = loadPlugin({ fetchImpl: async (url) => {
    if (String(url).endsWith("/api/session/active")) {
      return { ok: true, json: async () => ({ data: { parent: {}, empty: {}, done: {} } }) };
    }
    return { ok: false };
  } });
  const cleanup = await plugin.setup(h.ctx);
  for (const id of ["empty", "done"]) {
    h.bus.emit({ type: "session.created", data: { sessionID: id, parentID: "parent" } });
    h.bus.emit({ type: "session.execution.started", data: { sessionID: id } });
    h.bus.emit({ type: "session.execution.succeeded", data: { sessionID: id } });
  }
  await flush();
  mock.timers.tick(3000);
  await flush();
  mock.timers.tick(2000);
  await flush();
  assert.equal(h.prompts.length, 1);
  assert.match(h.prompts[0].text, /empty child/);
  assert.match(h.prompts[0].text, /空回复/);
  assert.doesNotMatch(h.prompts[0].text, /done child/);
  cleanup();
});

test("wake cap resets only on a real user prompt", async (t) => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  mock.timers.setTime(Date.UTC(2026, 10, 25));
  t.after(() => mock.timers.reset());
  const h = harness();
  h.addSession("parent", null, "parent");
  const wakes = [];
  const plugin = loadPlugin({
    spawnImpl: (_cmd, args) => { wakes.push(args); return { unref() {} }; },
    fetchImpl: async (url) => {
      if (String(url).endsWith("/api/session/active")) {
        return { ok: true, json: async () => ({ data: Object.fromEntries([...h.sessions.keys()].filter((id) => id !== "parent").map((id) => [id, {}])) }) };
      }
      return { ok: false };
    },
  });
  const cleanup = await plugin.setup(h.ctx);
  const failChild = async (id) => {
    h.addSession(id, "parent", id);
    h.bus.emit({ type: "session.created", data: { sessionID: id, parentID: "parent" } });
    h.bus.emit({ type: "session.execution.started", data: { sessionID: id } });
    h.bus.emit({ type: "session.execution.failed", data: { sessionID: id, error: { name: "APIError", message: "500" } } });
    await flush();
    mock.timers.tick(2000);
    await flush();
  };
  for (let i = 0; i < 7; i++) await failChild("c" + i);
  assert.equal(wakes.length, 6);
  assert.equal(typeof h.promptHook, "function");
  h.promptHook({ sessionID: "parent", prompt: { text: "[watchdog] synthetic ping" } });
  await failChild("c7");
  assert.equal(wakes.length, 6);
  h.promptHook({ sessionID: "parent", prompt: { text: "real user instruction" } });
  await failChild("c8");
  assert.equal(wakes.length, 7);
  cleanup();
});

test("quick tool stall notifies after budget; long build remains protected", async (t) => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  mock.timers.setTime(Date.UTC(2026, 10, 25));
  t.after(() => mock.timers.reset());
  const h = harness();
  h.addSession("parent", null, "parent");
  h.addSession("quick", "parent", "quick child");
  h.addSession("build", "parent", "build child");
  const now = Date.now();
  h.messages.set("quick", [{ type: "agent", content: [{ type: "tool", id: "tq", name: "read", state: { status: "running", input: { path: "a.go" } }, time: { ran: now } }] }]);
  h.messages.set("build", [{ type: "agent", content: [{ type: "tool", id: "tb", name: "shell", state: { status: "running", input: { command: "go test ./..." } }, time: { ran: now } }] }]);
  const plugin = loadPlugin({ fetchImpl: async (url) => {
    if (String(url).endsWith("/api/session/active")) {
      return { ok: true, json: async () => ({ data: { parent: {}, quick: {}, build: {} } }) };
    }
    const m = String(url).match(/\/api\/session\/([^/]+)\/message/);
    if (m) return { ok: true, json: async () => ({ data: h.messages.get(m[1]) || [] }) };
    return { ok: false };
  } });
  const cleanup = await plugin.setup(h.ctx);
  for (const id of ["quick", "build"]) {
    h.bus.emit({ type: "session.created", data: { sessionID: id, parentID: "parent" } });
    h.bus.emit({ type: "session.execution.started", data: { sessionID: id } });
  }
  await flush();
  mock.timers.tick(5 * 60 * 1000);
  await flush();
  mock.timers.tick(2000);
  await flush();
  assert.equal(h.prompts.length, 1);
  assert.match(h.prompts[0].text, /quick child/);
  assert.match(h.prompts[0].text, /read 工具/);
  assert.doesNotMatch(h.prompts[0].text, /build child/);
  cleanup();
});
