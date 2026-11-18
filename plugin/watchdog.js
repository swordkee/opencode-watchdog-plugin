// watchdog.js — session watchdog, OpenCode V2 server plugin (superagent-ops)
// v3 (2026-11-01): adds drift detection, loop detection, stall nudge and
// permission-wait gating, absorbing the best mechanisms from the ecosystem
// survey (akane: ping-before-kill + pause on permission; superadvisor:
// independent-model drift review; ertval: nudge-then-escalate).
//
// Per-location ownership: each location's instance watches ONLY sessions
// under its own directory — one session corresponds to its own watchdog.
//
// Layers (all logged to ~/.local/state/opencode/watchdog/plugin.log):
//   L1 nudge     : 15 min silent while running -> one steer ping per run
//   L2 loop      : same tool input hash x3 in a row -> one steer warning
//   L3 drift     : long run + every 60 min -> flash judge vs. session goal;
//                  warning steer + log only, NEVER interrupts
//   L4 interrupt : 30 min silent (bmall 90 min) -> auto interrupt
// Gates: permission-pending sessions are skipped (waiting on a human, not
// stuck). session.tool.progress keeps long single tool calls alive.
const EVERY_MS = 5 * 60 * 1000
const DEFAULT_STALE_MS = 30 * 60 * 1000
const STALE_OVERRIDES = { "e:/work/bmall": 90 * 60 * 1000 }
const NUDGE_MS = 15 * 60 * 1000
const DRIFT_EVERY_MS = 60 * 60 * 1000
const DRIFT_MIN_RUN_MS = 30 * 60 * 1000
const REVIVE_CAP = 2 // auto-revive budget per session per run window
// v9: spin = producing turns but no productive tool for this long -> notify.
const SPIN_MS = 10 * 60 * 1000
const SPIN_COOLDOWN_MS = 20 * 60 * 1000
// child sessions are supervised ONLY by their own parent (session-level
// scope): a lead must not manage another lead's fleet. 60 min idle -> notify
// the parent; 4 h idle -> interrupt the child and tell the parent.
const CHILD_NUDGE_MS = 60 * 60 * 1000
const CHILD_INTERRUPT_MS = 4 * 60 * 60 * 1000
const fs = require("fs")
const path = require("path")
const { spawn } = require("child_process")

const LOG_DIR = path.join(
  process.env.USERPROFILE || process.env.HOME || ".",
  ".local",
  "state",
  "opencode",
  "watchdog"
)
const LOG_FILE = path.join(LOG_DIR, "plugin.log")

function log(...a) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true })
    fs.appendFileSync(LOG_FILE, new Date().toISOString() + " " + a.join(" ") + "\n")
  } catch {}
}

// Judge model for drift checks: prefer cheap flash-class models per the
// house rule (deepseek-v4.1-flash > deepseek-v4-flash > glm-5.3-flash),
// then fall back to the location default. Note model.default() returns
// { location, data:{ providerID, modelID } } — the payload is nested.
async function pickJudgeModel(ctx) {
  try {
    const list = await ctx.model.list()
    const arr = Array.isArray(list) ? list : (list && list.data) || []
    const cheap = arr.filter((m) => {
      if (!m) return false
      const id = String(m.modelID || m.id || "").toLowerCase()
      return (
        m.enabled !== false &&
        /deepseek-v4\.1-flash|deepseek-v4-flash|glm-5\.3-flash/.test(id)
      )
    })
    cheap.sort((a, b) => {
      const rank = (m) => {
        const id = String(m.modelID || m.id || "").toLowerCase()
        let r = 2
        if (id.includes("deepseek-v4.1-flash")) r = 0
        else if (id.includes("deepseek-v4-flash")) r = 1
        const p = m.providerID === "volcengine-coding-plan" ? 0 : 1
        return r * 10 + p
      }
      return rank(a) - rank(b)
    })
    if (cheap.length > 0) {
      const m = cheap[0]
      return { providerID: m.providerID, id: m.modelID || m.id }
    }
  } catch {}
  try {
    const def = await ctx.model.default()
    const d = def && def.data ? def.data : def
    if (d && d.providerID && (d.modelID || d.id))
      return { providerID: d.providerID, id: d.modelID || d.id }
  } catch {}
  return null
}

function norm(p) {
  return (p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
}

// Never hardcode the CLI path (Scoop upgrades move it). The server process IS
// the opencode binary, so process.execPath re-runs it; then Bun.which; then
// plain PATH lookup as last resort.
function resolveOpencode() {
  if (process.env.OPENCODE_EXECUTABLE) return process.env.OPENCODE_EXECUTABLE
  try {
    if (/(^|[\\/])opencode(\.exe)?$/i.test(process.execPath || ""))
      return process.execPath
  } catch {}
  try {
    if (typeof Bun !== "undefined" && Bun.which) {
      const p = Bun.which("opencode")
      if (p) return p
    }
  } catch {}
  return "opencode"
}

function owns(myDir, sessionDir) {
  if (!myDir || !sessionDir) return false
  const s = norm(sessionDir)
  return s === myDir || s.startsWith(myDir + "/")
}

// v7: authoritative "is running" source. v2.2.5 keeps `outcome` on RUNNING
// sessions (it holds the previous execution's outcome), so the old
// `!s.outcome` backfill matched nothing, and events alone never re-add a
// session that started before the plugin loaded. Ask the server's own
// active endpoint instead (same service credentials as the CLI uses).
const SERVICE_JSON = path.join(
  process.env.USERPROFILE || process.env.HOME || ".",
  ".local",
  "state",
  "opencode",
  "service.json"
)
async function fetchActiveIds() {
  try {
    const sj = JSON.parse(fs.readFileSync(SERVICE_JSON, "utf8"))
    const auth =
      "Basic " + Buffer.from("opencode:" + sj.password).toString("base64")
    const r = await fetch(
      "http://127.0.0.1:" + (sj.port || 49374) + "/api/session/active",
      { headers: { Authorization: auth, Accept: "application/json" } }
    )
    if (!r.ok) return null
    const j = await r.json()
    return new Set(Object.keys((j && j.data) || {}))
  } catch {
    return null
  }
}

// Notify dedupe that survives plugin reloads (reloads reset in-memory flags,
// which produced duplicate nudges to the same session).
const NOTIFY_FILE = path.join(LOG_DIR, "notify-state.json")
function readNotifyState() {
  try {
    return JSON.parse(fs.readFileSync(NOTIFY_FILE, "utf8"))
  } catch {
    return {}
  }
}
function writeNotifyState(o) {
  try {
    // Keep the file small: drop entries older than 7 days.
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
    for (const k of Object.keys(o)) {
      if (!(Number(o[k]) >= cutoff)) delete o[k]
    }
    fs.writeFileSync(NOTIFY_FILE, JSON.stringify(o))
  } catch {}
}

// Long running tools (go build, protoc, tests) produce no new messages while
// they run; never interrupt a session whose newest assistant turn still has a
// tool in progress.
async function fetchRunningTool(id) {
  try {
    const sj = JSON.parse(fs.readFileSync(SERVICE_JSON, "utf8"))
    const auth = "Basic " + Buffer.from("opencode:" + sj.password).toString("base64")
    const r = await fetch(
      "http://127.0.0.1:" + (sj.port || 49374) + "/api/session/" + id + "/message?limit=3",
      { headers: { Authorization: auth, Accept: "application/json" } }
    )
    if (!r.ok) return false
    const j = await r.json()
    const arr = (j && (j.data || j)) || []
    for (const m of arr) {
      if (!m || m.type !== "assistant") continue
      for (const p of m.content || m.parts || []) {
        const st = p && p.type === "tool" && p.state && String(p.state.status || "")
        if (st && !["completed", "error", "failed", "cancelled"].includes(st)) return true
      }
      break
    }
    return false
  } catch {
    return false
  }
}
// by inbox/steer deliveries, so a fake-dead session can look "0 min idle"
// while producing nothing for an hour. Messages only advance when the session
// actually produces turns.
//
// v9: spin detection — a session can keep producing turns (reads/greps/
// verifications) while never writing anything. Track the newest turn, the
// newest PRODUCTIVE turn (write/edit/patch, or a shell command that is not a
// pure read), and how many turns landed in the last window.
const READ_SHELL =
  /^\s*(Get-Content|Get-ChildItem|Select-String|Get-Item|Test-Path|Resolve-Path|rg\b|grep\b|ls\b|dir\b|type\b|head\b|tail\b|wc\b|git\s+(status|log|diff|show|branch|rev-parse|remote|tag|ls-files)|where\.exe|Get-Command|Get-Process|netstat|tasklist|echo\b)/i
const WRITE_TOOLS = new Set(["edit", "write", "patch", "multiedit", "apply_patch"])
const WRITE_SHELL =
  /\b(New-Item|Copy-Item|Move-Item|Remove-Item|Rename-Item|Set-Content|Add-Content|Out-File|Set-ItemProperty|New-ItemProperty|mkdir|rmdir|touch|cp\b|mv\b|rm\b|tee\b|sed\s+-i|protoc\b|go\s+(build|generate|test|run)\b|npm\b|pnpm\b|yarn\b|make\b|gradle|mvn\b|vite\b|tsc\b|python3?\b|node\b|bun\b|deno\b|dotnet\b|cargo\b|rustc\b|javac\b|git\s+(add|commit|apply|checkout|merge|rebase|stash|restore|reset|push)\b|>>?\s*\S)/i
function isProductivePart(p) {
  try {
    const name = String((p && p.name) || "")
    if (!name) return false
    if (name === "shell") {
      const cmd = String(
        (p.state && p.state.input && p.state.input.command) ||
          (p.input && p.input.command) ||
          ""
      )
      return cmd
        .split(/\r?\n|;|&&|\|\|/)
        .map((x) => x.trim())
        .filter(Boolean)
        .some((seg) => !/^cd\b/i.test(seg) && WRITE_SHELL.test(seg))
    }
    return WRITE_TOOLS.has(name)
  } catch {
    return false
  }
}
async function fetchRecent(id, windowMs) {
  try {
    const sj = JSON.parse(fs.readFileSync(SERVICE_JSON, "utf8"))
    const auth = "Basic " + Buffer.from("opencode:" + sj.password).toString("base64")
    const r = await fetch(
      "http://127.0.0.1:" + (sj.port || 49374) + "/api/session/" + id + "/message?limit=12",
      { headers: { Authorization: auth, Accept: "application/json" } }
    )
    if (!r.ok) return null
    const j = await r.json()
    const arr = (j && (j.data || j)) || []
    const now = Date.now()
    let last = 0
    let lastProductive = 0
    let turnsInWindow = 0
    for (const m of arr) {
      const t = m && m.time && (m.time.completed || m.time.created)
      if (!t) continue
      if (t > last) last = t
      if (m.type !== "assistant") continue
      if (t >= now - windowMs) turnsInWindow++
      const parts = m.content || m.parts || []
      const productive = parts.some(isProductivePart)
      if (productive && t > lastProductive) lastProductive = t
    }
    return { last, lastProductive, turnsInWindow }
  } catch {
    return null
  }
}

function msgText(m) {
  try {
    if (m && typeof m.text === "string" && m.text) return m.text
    const parts = (m && m.parts) || []
    const t = parts
      .map((p) => (p && typeof p.text === "string" ? p.text : ""))
      .filter(Boolean)
      .join(" ")
    if (t) return t
    return ""
  } catch {
    return ""
  }
}

export default {
  id: "watchdog",
  async setup(ctx) {
    const myDir = norm(ctx.location && ctx.location.directory)
    const staleMs = STALE_OVERRIDES[myDir] || DEFAULT_STALE_MS
    // sessionID -> { lastSeen, startedAt, nudged, loopWarned, lastDriftAt }
    const running = new Map()
    const pendingPermission = new Map() // sessionID -> askedAt
    const toolHistory = new Map() // sessionID -> [inputHash,...]
    const reviveCount = new Map() // sessionID -> auto-revives this run window
    const wakeCount = new Map() // sessionID -> wakes spawned (idle-session nudges)
    const WAKE_CAP = 6

    // Cross-reload notify dedupe (reloads reset in-memory flags).
    let notifyState = readNotifyState()
    const notifiedRecently = (id, kind, ms) => {
      const v = notifyState[id + "|" + kind] || 0
      return Date.now() - v < ms
    }
    const markNotified = (id, kind) => {
      notifyState[id + "|" + kind] = Date.now()
      writeNotifyState(notifyState)
    }

    // Post-mortem capture (classic NMI-before-reset): dump the hung session's
    // tail so the human can see what it was doing when it froze.
    const postMortem = async (id) => {
      try {
        const msgs = (await ctx.session.context({ sessionID: id })) || []
        const tail = msgs
          .slice(-8)
          .map((m) => msgText(m).replace(/\s+/g, " ").slice(0, 300))
          .filter(Boolean)
        let title = ""
        try {
          const s = await ctx.session.get({ sessionID: id })
          title = (s && s.title) || ""
        } catch {}
        const file = path.join(
          LOG_DIR,
          "postmortem-" + id + "-" + Date.now() + ".log"
        )
        fs.appendFileSync(
          file,
          "session: " + id + "\ntitle: " + title + "\n\n" + tail.join("\n---\n") + "\n"
        )
        log("post-mortem written:", file)
      } catch (e) {
        log("post-mortem failed:", id, String(e))
      }
    }

    const send = async (sessionID, text, delivery) => {
      try {
        // A prompt to an IDLE session only lands in its inbox and is never
        // consumed (opencode v2 does not wake idle sessions on prompt). If the
        // target is not running, spawn a real continued run so the message is
        // actually read; if it is running, steer into the live execution.
        const act = await fetchActiveIds()
        if (act && !act.has(sessionID)) {
          wake(sessionID, text)
          return
        }
        await ctx.session.prompt({
          sessionID,
          text,
          delivery: delivery || "steer",
          resume: false,
        })
      } catch (e) {
        log("steer failed:", sessionID, String(e))
      }
    }

    // Wake an idle session with a real run (opencode run -s <id> --continue).
    // Capped per session to avoid wake loops.
    const wake = (sessionID, text) => {
      try {
        const n = wakeCount.get(sessionID) || 0
        if (n >= WAKE_CAP) {
          log("wake skipped (cap reached):", sessionID)
          return
        }
        wakeCount.set(sessionID, n + 1)
        const oc = resolveOpencode()
        const out = fs.openSync(
          path.join(LOG_DIR, "wake-" + sessionID + ".log"),
          "a"
        )
        const p = spawn(
          oc,
          ["run", "-s", sessionID, "--continue", "--auto", text],
          { detached: true, stdio: ["ignore", out, out], windowsHide: true }
        )
        p.unref()
        log("wake spawned:", sessionID, "n=" + (n + 1))
      } catch (e) {
        log("wake failed:", sessionID, String(e))
      }
    }

    // Goal awareness: the native /goal plugin exposes RPC "opencode.goal"
    // with get({sessionID}) -> Goal.State|null. While a goal is active the
    // goal engine itself continues the session on idle (its own reviewer +
    // continuation loop), so the watchdog hands off: no nudge, no warning,
    // no interrupt, no drift check.
    let goalClient = null
    try {
      goalClient = ctx.rpc({ id: "opencode.goal", methods: { get: {} }, events: {} })
      log("goal rpc attached")
    } catch (e) {
      log("goal rpc unavailable:", String(e))
    }
    const goalActive = async (sessionID) => {
      if (!goalClient) return false
      try {
        const g = await goalClient.get({ sessionID })
        return !!(g && g.status === "active")
      } catch {
        return false
      }
    }

    // Interrupt alone leaves an idle session with queued notes nobody reads
    // (prompts never wake an idle session). Drive it with the documented
    // revive flow so it reports and can continue. Capped per run window.
    const autoRevive = (id, staleMin) => {
      try {
        const n = reviveCount.get(id) || 0
        if (n >= REVIVE_CAP) {
          log("revive skipped (cap reached):", id)
          return
        }
        reviveCount.set(id, n + 1)
        const oc = resolveOpencode()
        const out = fs.openSync(path.join(LOG_DIR, "revive-" + id + ".log"), "a")
        const p = spawn(
          oc,
          [
            "run", "-s", id, "--continue", "--agent", "build", "--auto",
            "你因 ≥" + staleMin + " 分钟无活动被看门狗自动打断。请立即向用户汇报当前进度、已完成项与卡点（先不要做新的写操作），等待下一步指令。",
          ],
          { detached: true, stdio: ["ignore", out, out], windowsHide: true }
        )
        p.unref()
        log("auto-revive spawned:", id, "n=" + (n + 1))
      } catch (e) {
        log("auto-revive failed:", id, String(e))
      }
    }

    // --- probe: what does this build actually expose (drift depends on it) ---
    try {
      log("probe: ctx keys =", Object.keys(ctx).join(","))
      log(
        "probe: generate =",
        typeof (ctx.generate && ctx.generate.text),
        "| exp.generate =",
        typeof (ctx.experimental &&
          ctx.experimental.generate &&
          ctx.experimental.generate.text)
      )
      const md =
        ctx.model && typeof ctx.model.default === "function"
          ? await ctx.model.default()
          : ctx.model && ctx.model.default
            ? await ctx.model.default
            : null
      log("probe: model.default =", JSON.stringify(md))
      try {
        log("judge model:", JSON.stringify(await pickJudgeModel(ctx)))
      } catch (e) {
        log("judge model probe failed:", String(e))
      }
    } catch (e) {
      log("probe failed:", String(e))
    }

    // --- backfill (owned + no outcome + updated within 1h) ---
    try {
      const now0 = Date.now()
      const cutoff = now0 - 60 * 60 * 1000
      const page = await ctx.session.list({ limit: 1000 })
      for (const s of (page && (page.data || page)) || []) {
        if (!s || !s.id || s.outcome) continue
        if (!owns(myDir, s.location && s.location.directory)) continue
        const u = s.time && s.time.updated ? Number(s.time.updated) : 0
        const busy = s.time && s.time.busy ? Number(s.time.busy) : 0
        const created = s.time && s.time.created ? Number(s.time.created) : 0
        if (u && u >= cutoff)
          running.set(s.id, {
            lastSeen: Math.max(u, now0 - 60000),
            startedAt: created || busy || u,
            nudged: false,
            loopWarned: false,
            lastDriftAt: 0,
          })
      }
      log("setup", myDir || "(no dir)", "backfill: running =", running.size)
    } catch (e) {
      log("backfill failed:", String(e))
    }

    // --- event stream ---
    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({
          types: [
            "session.execution.started",
            "session.execution.succeeded",
            "session.execution.failed",
            "session.execution.interrupted",
            "session.idle",
            "session.tool.progress",
            "session.tool.called",
            "permission.asked",
            "permission.replied",
          ],
          signal: controller.signal,
        })) {
          const p = event.properties || {}
          const d = p.data || p
          const id = d.sessionID || (p.info && (p.info.id || p.info.sessionID))
          if (!id) continue

          if (event.type === "session.execution.started") {
            running.set(id, {
              lastSeen: Date.now(),
              startedAt: Date.now(),
              nudged: false,
              warned: false,
              loopWarned: false,
              lastDriftAt: 0,
            })
            toolHistory.set(id, [])
            reviveCount.set(id, 0)
          } else if (
            event.type === "session.execution.succeeded" ||
            event.type === "session.execution.failed" ||
            event.type === "session.execution.interrupted" ||
            event.type === "session.idle"
          ) {
            running.delete(id) // stale-relevant state ends with the run
            toolHistory.delete(id)
          } else if (event.type === "session.tool.progress") {
            const e0 = running.get(id)
            if (e0) {
              e0.lastSeen = Date.now()
              e0.warned = false
            }
          } else if (event.type === "session.tool.called") {
            const e0 = running.get(id)
            if (!e0) continue
            e0.lastSeen = Date.now()
            e0.warned = false
            // L2 loop detection: 3 identical tool inputs in a row
            try {
              const h = JSON.stringify(d.input || {})
              const hist = toolHistory.get(id) || []
              hist.push(h)
              if (hist.length > 6) hist.shift()
              toolHistory.set(id, hist)
              const n = hist.length
              if (
                n >= 3 &&
                hist[n - 1] === hist[n - 2] &&
                hist[n - 2] === hist[n - 3] &&
                !e0.loopWarned
              ) {
                e0.loopWarned = true
                log("loop detected:", id)
                send(
                  id,
                  "[watchdog] 检测到你连续 3 次以相同参数调用同一工具——疑似陷入循环。请停下重试，换一种策略，或说明卡点后收尾。"
                )
              }
            } catch {}
          } else if (event.type === "permission.asked") {
            pendingPermission.set(id, Date.now())
          } else if (event.type === "permission.replied") {
            pendingPermission.delete(id)
          }
        }
      } catch (e) {
        log("event stream ended:", String(e))
      }
    })()

    // --- L3 drift check (semantic, warn only) ---
    const driftCheck = async (id, entry, s) => {
      try {
        entry.lastDriftAt = Date.now()
        let msgs = []
        try {
          msgs = (await ctx.session.context({ sessionID: id })) || []
        } catch {}
        const tail = msgs.slice(-12)
        const digest = tail
          .map((m) => msgText(m).replace(/\s+/g, " ").slice(0, 200))
          .filter(Boolean)
          .join("\n")
        if (!digest) return
        const title = (s && s.title) || ""
        // Anchor the drift judgement on the latest REAL user instruction
        // (v2 messages use `type`, not `role`; watchdog steers are type=user
        // too, so they must be excluded). No anchor => no drift verdict.
        const userText = msgs
          .filter(
            (m) =>
              m &&
              m.type === "user" &&
              typeof m.text === "string" &&
              m.text.length >= 8 &&
              !/^\[watchdog\]/i.test(m.text)
          )
          .slice(-2)
          .map((m) => msgText(m).replace(/\s+/g, " ").slice(0, 300))
          .filter(Boolean)
          .join("\n")
        if (!userText) {
          log("drift skipped (no user anchor):", id)
          return
        }
        const prompt =
          "你在做会话偏航检查。\n最近用户指令（判定基准；用户主动换话题不算偏航）：\n" +
          (userText || "(无)") +
          "\n会话标题（仅参考，可能过时）：" +
          title +
          "\n最近 assistant 工作摘要：\n" +
          digest +
          '\n判断：最近的工作是否仍在服务于最新用户指令？只输出一行 JSON：{"drift":true|false,"reason":"不超过40字"}'
        let model = null
        try {
          model = await pickJudgeModel(ctx)
        } catch {}
        const gen =
          (ctx.experimental && ctx.experimental.generate && ctx.experimental.generate.text) ||
          (ctx.generate && ctx.generate.text)
        if (!gen || !model) {
          log("drift skipped (no generate/model):", id)
          return
        }
        const out = await gen({ model, prompt })
        const text = (out && (out.text || out.answer)) || ""
        log("drift result:", id, String(text).replace(/\s+/g, " ").slice(0, 200))
        if (/"drift"\s*:\s*true/.test(String(text))) {
          const reason = (String(text).match(/"reason"\s*:\s*"([^"]*)"/) || [])[1] || "方向偏移"
          send(
            id,
            "[watchdog] 偏航预警：最近的工作疑似偏离原始目标（" +
              reason +
              "）。请核对任务目标；若确认偏航，回到主线或向用户确认。"
          )
        }
      } catch (e) {
        log("drift failed:", id, String(e))
      }
    }

    const sweep = async () => {
      try {
        const now = Date.now()
        // pass 1: refresh session infos. A parent session that has a running
        // child counts as BUSY, not stale — a lead waiting on its 20-60 min
        // worker fleet must not be interrupted (hawk: subagent-aware).
        const infos = new Map()
        // v7: refresh membership from the server's active list; event-only
        // tracking goes blind whenever a session starts before plugin load.
        const activeIds = await fetchActiveIds()
        if (activeIds) {
          for (const id of [...running.keys()]) {
            if (!activeIds.has(id)) {
              running.delete(id)
              toolHistory.delete(id)
            }
          }
          for (const id of activeIds) {
            if (running.has(id)) continue
            let s0 = null
            try {
              s0 = await ctx.session.get({ sessionID: id })
            } catch {
              continue
            }
            if (!s0) continue
            if (!owns(myDir, s0.location && s0.location.directory)) continue
            const upd0 = s0.time && s0.time.updated ? Number(s0.time.updated) : 0
            const busy0 = s0.time && s0.time.busy ? Number(s0.time.busy) : 0
            const created0 = s0.time && s0.time.created ? Number(s0.time.created) : 0
            const mt0 = (await fetchRecent(id, SPIN_MS))?.last
            running.set(id, {
              lastSeen: mt0 || upd0 || Date.now(),
              startedAt: created0 || busy0 || upd0 || Date.now(),
              nudged: false,
              warned: false,
              loopWarned: false,
              lastDriftAt: 0,
            })
            toolHistory.set(id, [])
            log("track:", id, "idle", upd0 ? Math.round((now - upd0) / 60000) + "m" : "?")
          }
        }
        for (const id of [...running.keys()]) {
          let s = null
          try {
            s = await ctx.session.get({ sessionID: id })
          } catch {
            running.delete(id)
            continue
          }
          if (!s) {
            running.delete(id)
            continue
          }
          if (!owns(myDir, s.location && s.location.directory)) continue
          infos.set(id, s)
        }
        const busyParents = new Set()
        for (const [cid, cs] of infos) {
          if (cs.parentID && infos.has(cs.parentID)) busyParents.add(cs.parentID)
        }

        // pass 2: per-session decisions
        for (const [id, e] of [...running.entries()]) {
          const s = infos.get(id)
          if (!s) continue
          const dbUpdated = s.time && s.time.updated ? Number(s.time.updated) : 0
          const recent = await fetchRecent(id, SPIN_MS)
          const mt = recent && recent.last
          const last = mt
            ? Math.max(e.lastSeen || 0, mt)
            : Math.max(e.lastSeen || 0, dbUpdated)
          const idleMin = last ? Math.round((now - last) / 60000) : -1
          e.recent = recent

          // v9 spin: turns keep landing but nothing productive (no write/edit/
          // patch, no non-read shell) for SPIN_MS -> notify. Child: tell its
          // parent; root: nudges itself. Cooldown prevents spam.
          let spinFired = false
          const spin =
            recent &&
            recent.turnsInWindow >= 2 &&
            now - (recent.lastProductive || 0) >= SPIN_MS &&
            now - e.startedAt >= SPIN_MS
          if (spin && !notifiedRecently(id, "spin", SPIN_COOLDOWN_MS)) {
            markNotified(id, "spin")
            spinFired = true
            const spinMin = Math.round(
              (now - (recent.lastProductive || now - SPIN_MS)) / 60000
            )
            if (s.parentID) {
              log("spin -> notify parent:", id, spinMin + "m without writes")
              send(
                s.parentID,
                "[watchdog] 你派发的子会话「" +
                  ((s && s.title) || id) +
                  "」已 " +
                  spinMin +
                  " 分钟只有读取/确认、没有任何写操作（空转）。请检查它是否在反复核对；必要时给硬指令或中断重派。"
              )
            } else {
              log("spin -> nudge self:", id, spinMin + "m without writes")
              send(
                id,
                "[watchdog] 你已 " +
                  spinMin +
                  " 分钟没有落地任何写操作（只有读取/确认）。停止继续考古，立即按工单落代码；若确认无需改动请直接汇报结论。"
              )
            }
          }

          // child sessions: session-level ownership — a lead supervises only
          // the children IT spawned. Notifications always go to that parent
          // (never to another session); the child itself is only interrupted
          // as a last resort after 4 h. This bounds the blast radius and
          // avoids a global "worker" policy.
          if (s.parentID) {
            const childTitle = (s && s.title) || id
            if (idleMin >= CHILD_INTERRUPT_MS / 60000) {
              if (await fetchRunningTool(id)) {
                log("skip child interrupt (tool running):", id, idleMin + "m")
                continue
              }
              log("child stale, interrupting:", id, "idle", idleMin + "m", childTitle)
              try {
                await ctx.session.interrupt({ sessionID: id, resume: false })
              } catch (err) {
                log("child interrupt failed:", id, String(err))
              }
              send(
                s.parentID,
                "[watchdog] 你派发的子会话「" +
                  childTitle +
                  "」已 " +
                  idleMin +
                  " 分钟无活动，已自动打断。请检查其产出或重新派发。"
              )
              continue
            }
            if (
              idleMin >= CHILD_NUDGE_MS / 60000 &&
              !notifiedRecently(id, "child", CHILD_NUDGE_MS) &&
              !notifiedRecently(id, "spin", SPIN_COOLDOWN_MS)
            ) {
              markNotified(id, "child")
              log("child idle -> notify parent:", id, "idle", idleMin + "m")
              send(
                s.parentID,
                "[watchdog] 你派发的子会话「" +
                  childTitle +
                  "」已 " +
                  idleMin +
                  " 分钟无活动；若已卡死请介入或重新派发（≥" +
                  CHILD_INTERRUPT_MS / 3600000 +
                  "h 将自动打断）。"
              )
            }
            continue
          }

          // busy parent = waiting on running subagents: courtesy nudge at 2x
          // window, never interrupt
          if (busyParents.has(id)) {
            if (!notifiedRecently(id, "busy", NUDGE_MS * 2) && idleMin >= (NUDGE_MS * 2) / 60000) {
              markNotified(id, "busy")
              log("busy-parent nudge:", id, idleMin + "m")
              send(
                id,
                "[watchdog ping] 你的子任务仍在运行；若在等待请忽略；若子任务已卡死，请介入处理。"
              )
            }
            continue
          }

          // gate: waiting on a human permission card — not stuck
          const askedAt = pendingPermission.get(id)
          if (askedAt && now - askedAt < 2 * 60 * 60 * 1000) {
            log("skip (permission pending):", id, idleMin + "m")
            continue
          }

          // gate: an ACTIVE goal session is driven by the native goal engine
          // (idle-hook continuation + reviewer) — hands off entirely.
          if (
            idleMin >= NUDGE_MS / 60000 ||
            (e.startedAt && now - e.startedAt >= DRIFT_MIN_RUN_MS)
          ) {
            if (await goalActive(id)) {
              log("goal-active, skip:", id, idleMin + "m")
              continue
            }
          }

          // L3 drift (long runs only, only when not actively producing, every
          // 60 min, warn-only)
          if (
            e.startedAt &&
            idleMin >= 10 &&
            now - e.startedAt >= DRIFT_MIN_RUN_MS &&
            now - (e.lastDriftAt || 0) >= DRIFT_EVERY_MS
          ) {
            void driftCheck(id, e, s)
          }

          // L1 nudge: silent 15 min but not yet stale — one ping per run
          if (
            idleMin >= NUDGE_MS / 60000 &&
            idleMin < staleMs / 60000 &&
            !spinFired &&
            !notifiedRecently(id, "nudge", NUDGE_MS * 2)
          ) {
            markNotified(id, "nudge")
            log("nudge:", id, idleMin + "m")
            send(
              id,
              "[watchdog ping] 你已 " +
                idleMin +
                " 分钟无活动。若仍在推进请忽略本条；若卡住请换策略；若已完成请汇报结果。"
            )
          }

          // L4 interrupt with pre-kill warning (ping-before-kill): the first
          // time past the threshold only warns; interrupt on the NEXT sweep if
          // the session is still silent — protects long tools/长回合.
          if (idleMin >= staleMs / 60000) {
            if (!e.warned) {
              e.warned = true
              log("pre-kill warning:", id, "idle", idleMin + "m", (s && s.title) || "")
              send(
                id,
                "[watchdog] 你已 " +
                  idleMin +
                  " 分钟无活动；若下一轮巡检前仍无进展将被自动打断并复苏。若在长任务中请继续。"
              )
              continue
            }
            log("stale, interrupting:", id, "idle", idleMin + "m", (s && s.title) || "")
            if (await fetchRunningTool(id)) {
              log("skip interrupt (tool running):", id, idleMin + "m")
              continue
            }
            try {
              await ctx.session.interrupt({ sessionID: id, resume: false })
            } catch (err) {
              log("interrupt failed:", id, String(err))
            }
            autoRevive(id, staleMs / 60000)
            void postMortem(id)
          }
        }
        log("sweep done:", myDir || "(no dir)", "running =", running.size)
      } catch (e) {
        log("sweep failed:", String(e))
      }
    }

    const timer = setInterval(() => void sweep(), EVERY_MS)
    const boot = setTimeout(() => void sweep(), 10 * 1000)
    if (timer.unref) timer.unref()
    if (boot.unref) boot.unref()

    log(
      "loaded:",
      myDir || "(no dir)",
      "| every",
      EVERY_MS / 60000,
      "min, nudge >",
      NUDGE_MS / 60000,
      "min, stale >",
      staleMs / 60000,
      "min | opencode exe:",
      resolveOpencode()
    )
    return () => {
      clearInterval(timer)
      clearTimeout(boot)
      controller.abort()
      log("unloaded:", myDir || "(no dir)")
    }
  },
}// hot-reload probe 2026-11-01T19:51:43.2440905+08:00
