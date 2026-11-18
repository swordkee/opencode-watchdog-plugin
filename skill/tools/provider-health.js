#!/usr/bin/env node
// provider-health.js - probe model provider accounts BEFORE dispatching work.
// A 429 "insufficient_quota" account silently turns every worker into a
// retry-black-hole, so the Router should check this first.
//
// usage:
//   node provider-health.js          # table of all accounts
//   node provider-health.js --json   # machine-readable
//   node provider-health.js --pick   # print the healthiest worker agent name
// exit:  0 all healthy, 1 at least one hard failure (429/401/5xx)
const { execFileSync } = require("child_process");

// agent = the subagent slot bound to this account.
const TARGETS = [
  { name: "opencode-go (main)", match: /^OpenCode Go$/, agent: "worker-go" },
  { name: "opencode-go-2 (neurondev)", match: /neurondev/, agent: "worker-go2" },
  { name: "bailian (magiclight)", match: /magiclight/, alibaba: true, agent: "worker-bailian" },
  { name: "bailian2 (xinxiaohui)", match: /鑫小汇/, alibaba: true, agent: "worker-bailian2" },
];

const OPENCODE_GO = "https://opencode.ai/zen/go/v1/chat/completions";
const ALIBABA = "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions";

function authExport() {
  try {
    const win = process.platform === "win32";
    const cmd = win ? "cmd" : "opencode";
    const args = win ? ["/c", "opencode", "auth", "export"] : ["auth", "export"];
    return JSON.parse(execFileSync(cmd, args, { encoding: "utf8" }));
  } catch (e) {
    console.error("cannot read credentials:", e.message);
    process.exit(2);
  }
}

async function probe(t, creds) {
  const c = creds.find((x) => t.match.test(x.label || ""));
  const key = c && c.value && (c.value.key || c.value.token);
  if (!key) return { ...t, status: "no-credential", ms: Infinity };
  const url = t.alibaba ? ALIBABA : OPENCODE_GO;
  const model = "deepseek-v4.1-flash";
  const headers = { Authorization: "Bearer " + key, "Content-Type": "application/json" };
  if (!t.alibaba) headers["x-opencode-session"] = "health-" + Date.now();
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "reply OK" }],
        max_tokens: 5,
      }),
    });
    const ms = Date.now() - t0;
    const body = await r.text();
    let detail = "";
    if (r.status === 429) {
      const ra = r.headers.get("retry-after");
      detail = "quota/rate limited" + (ra ? " retry-after=" + ra + "s" : "");
      try {
        const j = JSON.parse(body);
        const m = (j.error && (j.error.message || j.error.type)) || "";
        if (m) detail += " | " + String(m).slice(0, 120);
      } catch {}
    } else if (r.status >= 400) {
      detail = body.replace(/\s+/g, " ").slice(0, 120);
    }
    return { name: t.name, agent: t.agent, status: r.status, ms, detail };
  } catch (e) {
    return { name: t.name, agent: t.agent, status: "ERR", ms: Date.now() - t0, detail: e.message };
  }
}

(async () => {
  const creds = authExport();
  const out = [];
  for (const t of TARGETS) out.push(await probe(t, creds));
  const healthy = out.filter((x) => x.status === 200).sort((a, b) => a.ms - b.ms);
  const bad = out.filter((x) => !(x.status === 200 || x.status === "no-credential"));

  if (process.argv.includes("--pick")) {
    if (!healthy.length) {
      console.log("NO_HEALTHY_PROVIDER");
      process.exit(1);
    }
    // print agent first (easy to consume), then one-line context
    console.log(healthy[0].agent);
    console.error(
      "pick: " + healthy[0].name + " (" + healthy[0].ms + "ms) | healthy=" +
        healthy.map((x) => x.agent + ":" + x.ms + "ms").join(", ")
    );
    return;
  }

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    for (const x of out) {
      console.log(
        String(x.name).padEnd(28),
        String(x.status).padEnd(6),
        String(x.ms).padStart(6) + "ms",
        x.detail || ""
      );
    }
  }
  process.exit(bad.length ? 1 : 0);
})();
