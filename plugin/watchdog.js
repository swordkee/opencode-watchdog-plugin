// watchdog.js — session watchdog, OpenCode V2 server plugin (superagent-ops)
// v3 (2026-11-01): adds drift detection, loop detection, stall nudge and
// permission-wait gating, absorbing the best mechanisms from the ecosystem
// survey (akane: ping-before-kill + pause on permission; superadvisor:
// independent-model drift review; ertval: nudge-then-escalate).
//
// Per-location ownership: each location's instance watches ONLY sessions
// under its own directory — one session corresponds to its own watchdog.
//
// v11 (2026-11-25): ROOT sessions are human-supervised. The watchdog never
// nudges, drift-warns or interrupts a root; it only supervises children:
//   10 min spin  -> notify that child's parent
//   60 min idle  -> notify that child's parent
//   4 h idle     -> interrupt that child + notify its parent
// The v3 root-supervision helpers below are retained but intentionally disabled.
//
// v12 (2026-11-25): V2.4 event.data + agent-message compatibility; child
// terminal error/empty-finish detection; per-tool stall budgets; parent
// notification batching; wake budget resets only on a real user prompt.
//
// Layers (all logged to ~/.local/state/opencode/watchdog/plugin.log):
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

const QUICK_TOOL_MS = 2 * 60 * 1000
const LONG_TOOL_MS = 30 * 60 * 1000
const SUBAGENT_TOOL_MS = 60 * 60 * 1000
const QUICK_TOOLS = new Set([
  "read", "edit", "write", "patch", "multiedit", "apply_patch",
  "grep", "glob", "list",
])

// V2.4 moved event payloads to event.data; older builds used
// event.properties.data or event.properties directly. Keep one parser so a
// host upgrade cannot silently disable terminal/tool supervision.
function parseSessionEvent(event) {
  if (!event || !event.type) return null
  const p = event.properties || {}
  const data = event.data || p.data || p
  const sessionID =
    (data && data.sessionID) ||
    (p.info && (p.info.id || p.info.sessionID))
  if (!sessionID) return null
  return { type: event.type, sessionID, data }
}

function isAssistantMessage(m) {
  return !!m && (m.type === "assistant" || m.type === "agent")
}

function errorCategory(error) {
  const e = error || {}
  const name = String(e.name || e.type || e.code || "")
  const message = String(e.message || "")
  const text = (name + " " + message).toLowerCase()
  if (/429|rate.?limit|quota|insufficient/.test(text)) return "provider_rate_limit"
  if (/401|403|auth|permission|forbidden|unauthorized/.test(text)) return "provider_auth"
  if (/timeout|timed.?out|deadline/.test(text)) return "provider_timeout"
  if (/network|connection|socket|stream|reset|closed/.test(text)) return "provider_network"
  return "provider_error"
}

function classifyChildTerminal({ eventType, reason, error, messages }) {
  if (eventType === "session.execution.failed") {
    return { kind: "provider_error", category: errorCategory(error) }
  }
  if (eventType === "session.execution.interrupted") {
    return reason === "inactivity" ? { kind: "execution_inactivity" } : null
  }
  if (eventType !== "session.execution.succeeded") return null
  const list = Array.isArray(messages) ? messages : []
  const last = [...list].reverse().find(isAssistantMessage)
  if (!last) return null
  const parts = last.content || last.parts || []
  const hasText = parts.some(
    (p) => p && p.type === "text" && String(p.text || "").trim().length > 0
  )
  const hasTool = parts.some((p) => p && p.type === "tool")
  return hasText || hasTool ? null : { kind: "empty_finish" }
}

function sanitizeDiagnostic(value, max = 160) {
  let s = String(value == null ? "" : value)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  s = s
    .replace(/\bBearer\s+[^\s]+/gi, "Bearer [REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED]")
    .replace(
      /\b(?:sk|pk|api[_-]?key|access[_-]?key|token|secret|password|passwd|pwd|private[_-]?key)[-_=:]\s*[A-Za-z0-9._-]{8,}/gi,
      "[REDACTED]"
    )
  if (max > 0 && s.length > max) s = s.slice(0, max) + "…"
  return s
}

function toolBudgetMs(name, input) {
  const n = String(name || "").toLowerCase()
  if (QUICK_TOOLS.has(n)) return QUICK_TOOL_MS
  if (n === "subagent" || n === "task") return SUBAGENT_TOOL_MS
  if (n === "websearch" || n === "webfetch") return 5 * 60 * 1000
  if (n === "shell" || n === "bash") {
    const cmd = String((input && input.command) || "")
    const seg = cmd
      .split(/\r?\n|;|&&|\|\|/)
      .map((x) => x.trim())
      .find((x) => x && !/^cd\b/i.test(x)) || ""
    return READ_SHELL.test(seg) ? QUICK_TOOL_MS : LONG_TOOL_MS
  }
  return LONG_TOOL_MS
}

function isToolStalled(startedAt, now, budgetMs) {
  const start = Number(startedAt)
  const budget = Number(budgetMs)
  return Number.isFinite(start) && start > 0 && Number.isFinite(budget) && budget > 0 && now - start >= budget
}

function aggregateParentNotifications(items) {
  const groups = new Map()
  for (const item of Array.isArray(items) ? items : []) {
    const parentID = item && item.parentID
    const text = sanitizeDiagnostic(item && item.text, 500)
    if (!parentID || !text) continue
    if (!groups.has(parentID)) groups.set(parentID, [])
    const lines = groups.get(parentID)
    if (!lines.includes(text)) lines.push(text)
  }
  const out = []
  for (const [parentID, all] of groups) {
    const lines = all.slice(0, 12)
    let text = "[watchdog] 检测到 " + lines.length + " 个子会话异常：\n" + lines.map((x) => "- " + x).join("\n")
    if (all.length > lines.length) text += "\n- …另有 " + (all.length - lines.length) + " 条"
    if (text.length > 3800) text = text.slice(0, 3799) + "…"
    out.push({ parentID, text })
  }
  return out
}

function isWatchdogPrompt(text) {
  return /^\s*\[watchdog\]/i.test(String(text || ""))
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

// Snapshot running tools from the message API. V2.4 names assistant messages
// `agent` and stores tool start time at part.time.ran; older builds used
// `assistant`. This fallback reconstructs tools that started before the plugin
// loaded or while the event stream was reconnecting.
async function fetchToolStates(id) {
  try {
    const sj = JSON.parse(fs.readFileSync(SERVICE_JSON, "utf8"))
    const auth = "Basic " + Buffer.from("opencode:" + sj.password).toString("base64")
    const r = await fetch(
      "http://127.0.0.1:" + (sj.port || 49374) + "/api/session/" + id + "/message?limit=3",
      { headers: { Authorization: auth, Accept: "application/json" } }
    )
    if (!r.ok) return null
    const j = await r.json()
    const arr = (j && (j.data || j)) || []
    for (const m of arr) {
      if (!isAssistantMessage(m)) continue
      const out = []
      for (const p of m.content || m.parts || []) {
        if (!p || p.type !== "tool" || !p.state) continue
        const st = String(p.state.status || "")
        if (["completed", "error", "failed", "cancelled"].includes(st)) continue
        out.push({
          id: p.id || "",
          name: p.name || "unknown",
          input: p.state.input || p.input || {},
          startedAt: Number((p.time && (p.time.ran || p.time.created)) || 0),
          status: st,
        })
      }
      return out
    }
    return []
  } catch {
    return null
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
      if (!isAssistantMessage(m)) continue
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
    const parts = (m && (m.content || m.parts)) || []
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
  // Exposed for the offline rule gate; the host ignores extra properties.
  parseSessionEvent,
  isAssistantMessage,
  classifyChildTerminal,
  sanitizeDiagnostic,
  toolBudgetMs,
  isToolStalled,
  aggregateParentNotifications,
  isWatchdogPrompt,
  async setup(ctx) {
    const myDir = norm(ctx.location && ctx.location.directory)
    const staleMs = STALE_OVERRIDES[myDir] || DEFAULT_STALE_MS
    // sessionID -> { lastSeen, startedAt, nudged, loopWarned, lastDriftAt }
    const running = new Map()
    const parentIDs = new Map() // sessionID -> parentID; roots are absent/empty
    const pendingPermission = new Map() // sessionID -> askedAt
    const toolHistory = new Map() // sessionID -> [inputHash,...]
    const toolNames = new Map() // tool call ID -> tool name (input.started)
    const activeTools = new Map() // sessionID -> Map(toolID -> {name,input,startedAt,budgetMs,notified})
    const executionGen = new Map() // sessionID -> increments on each real execution start
    const terminalChecked = new Map() // sessionID -> terminal event already inspected this execution
    const reviveCount = new Map() // sessionID -> auto-revives this run window
    const wakeCount = new Map() // sessionID -> wakes spawned since the last real user prompt
    const pendingNotifications = new Map() // parentID -> {lines,timer}
    const pendingTimers = new Set()
    const schedule = (fn, ms) => {
      const timer = setTimeout(() => {
        pendingTimers.delete(timer)
        fn()
      }, ms)
      pendingTimers.add(timer)
      if (timer.unref) timer.unref()
      return timer
    }
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

    // Batch child alerts per parent for 2 seconds. Ten children failing in one
    // sweep must produce one parent wake, not ten competing turns.
    const queueParentNotification = (parentID, text) => {
      const clean = sanitizeDiagnostic(text, 500)
      if (!parentID || !clean) return
      let entry = pendingNotifications.get(parentID)
      if (!entry) {
        entry = { lines: [], timer: null }
        pendingNotifications.set(parentID, entry)
      }
      if (!entry.lines.includes(clean)) entry.lines.push(clean)
      if (!entry.timer) {
        entry.timer = schedule(() => {
          pendingNotifications.delete(parentID)
          void flushParentNotifications(parentID, entry.lines)
        }, 2000)
      }
    }

    const flushParentNotifications = async (parentID, lines) => {
      for (const item of aggregateParentNotifications(
        lines.map((text) => ({ parentID, text }))
      )) {
        log("parent notify:", parentID, "alerts=" + lines.length)
        await send(parentID, item.text)
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

    const inspectChildTerminal = async (id, eventType, data, gen) => {
      let parentID = parentIDs.get(id)
      if (!parentID) {
        try {
          const s = await ctx.session.get({ sessionID: id })
          parentID = s && s.parentID
          if (parentID) parentIDs.set(id, parentID)
        } catch {
          return
        }
      }
      if (!parentID) return
      // Let the final assistant message settle before deciding that a
      // successful execution produced no usable result.
      if (eventType === "session.execution.succeeded") {
        await new Promise((resolve) => schedule(resolve, 3000))
      }
      if (executionGen.get(id) !== gen) return
      let messages = []
      if (eventType === "session.execution.succeeded") {
        try {
          messages = (await ctx.session.context({ sessionID: id })) || []
        } catch {
          return
        }
      }
      const verdict = classifyChildTerminal({
        eventType,
        reason: data && data.reason,
        error: data && data.error,
        messages,
      })
      if (!verdict) return
      let title = id
      try {
        const s = await ctx.session.get({ sessionID: id })
        title = sanitizeDiagnostic((s && s.title) || id, 80)
      } catch {}
      const detail =
        verdict.kind === "provider_error"
          ? "以 " + verdict.category + " 结束，未返回可用结果"
          : verdict.kind === "empty_finish"
            ? "执行成功但没有最终文本或工具结果（空回复）"
            : "因 inactivity 被系统中断"
      markNotified(id, "terminal", 10 * 60 * 1000)
      log("child terminal -> notify parent:", id, verdict.kind, verdict.category || "")
      queueParentNotification(
        parentID,
        "子会话「" + title + "」" + detail + "。请检查并决定重试、收口或重派。"
      )
    }

    const trackTool = (id, d) => {
      if (!d || !d.id) return
      const name = toolNames.get(d.id) || "unknown"
      const input = d.input || {}
      let map = activeTools.get(id)
      if (!map) {
        map = new Map()
        activeTools.set(id, map)
      }
      map.set(d.id, {
        id: d.id,
        name,
        input,
        startedAt: Date.now(),
        budgetMs: toolBudgetMs(name, input),
        notified: false,
      })
    }

    const clearTool = (id, toolID) => {
      toolNames.delete(toolID)
      const map = activeTools.get(id)
      if (!map) return
      map.delete(toolID)
      if (map.size === 0) activeTools.delete(id)
    }

    const reconcileTools = (id, states) => {
      if (!states) return
      const map = new Map()
      for (const t of states) {
        const prev = activeTools.get(id) && activeTools.get(id).get(t.id)
        const name = t.name && t.name !== "unknown" ? t.name : (prev && prev.name) || "unknown"
        const input = t.input || (prev && prev.input) || {}
        const startedAt = t.startedAt || (prev && prev.startedAt) || 0
        map.set(t.id, {
          id: t.id,
          name,
          input,
          startedAt,
          budgetMs: toolBudgetMs(name, input),
          notified: !!(prev && prev.notified),
        })
      }
      if (map.size) activeTools.set(id, map)
      else activeTools.delete(id)
    }

    const hasProtectedTool = (id, now) => {
      const map = activeTools.get(id)
      if (!map || map.size === 0) return false
      for (const t of map.values()) {
        // Unknown start time is protected: fail closed rather than kill a tool
        // whose age we cannot establish.
        if (!isToolStalled(t.startedAt, now, t.budgetMs)) return true
      }
      return false
    }

    // A watchdog wake is itself a user-role prompt. Only a REAL user prompt
    // resets the per-parent wake budget; otherwise six alerts would become a
    // permanent lifetime cap or reset on every plugin reload.
    try {
      await ctx.session.hook("prompt", (event) => {
        const id = event && event.sessionID
        if (!id) return
        const text =
          (event.prompt && event.prompt.text) ||
          (event.prompt && event.prompt.content) ||
          ""
        if (!isWatchdogPrompt(text)) wakeCount.delete(id)
      })
      log("prompt hook attached")
    } catch (e) {
      log("prompt hook unavailable:", String(e))
    }

    // --- event stream ---
    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({
          types: [
            "session.created",
            "session.deleted",
            "session.execution.started",
            "session.execution.succeeded",
            "session.execution.failed",
            "session.execution.interrupted",
            "session.idle",
            "session.tool.input.started",
            "session.tool.progress",
            "session.tool.called",
            "session.tool.success",
            "session.tool.failed",
            "permission.asked",
            "permission.replied",
          ],
          signal: controller.signal,
        })) {
          const parsed = parseSessionEvent(event)
          if (!parsed) continue
          const { type: eventType, sessionID: id, data: d } = parsed

          if (eventType === "session.created") {
            if (d.parentID) parentIDs.set(id, d.parentID)
            else parentIDs.delete(id)
          } else if (eventType === "session.deleted") {
            running.delete(id)
            parentIDs.delete(id)
            toolHistory.delete(id)
            activeTools.delete(id)
            executionGen.delete(id)
            terminalChecked.delete(id)
            pendingPermission.delete(id)
          } else if (eventType === "session.execution.started") {
            if (!parentIDs.has(id)) {
              void ctx.session.get({ sessionID: id })
                .then((s) => {
                  if (s && s.parentID) parentIDs.set(id, s.parentID)
                })
                .catch(() => {})
            }
            executionGen.set(id, (executionGen.get(id) || 0) + 1)
            terminalChecked.delete(id)
            activeTools.delete(id)
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
            eventType === "session.execution.succeeded" ||
            eventType === "session.execution.failed" ||
            eventType === "session.execution.interrupted"
          ) {
            const gen = executionGen.get(id) || 0
            if (!terminalChecked.get(id)) {
              terminalChecked.set(id, true)
              void inspectChildTerminal(id, eventType, d, gen)
            }
            running.delete(id)
            toolHistory.delete(id)
            activeTools.delete(id)
          } else if (eventType === "session.idle") {
            running.delete(id)
            toolHistory.delete(id)
            activeTools.delete(id)
          } else if (eventType === "session.tool.input.started") {
            if (d.id) toolNames.set(d.id, d.name || "unknown")
          } else if (eventType === "session.tool.progress") {
            const e0 = running.get(id)
            if (e0) {
              e0.lastSeen = Date.now()
              e0.warned = false
            }
          } else if (eventType === "session.tool.called") {
            trackTool(id, d)
            const e0 = running.get(id)
            if (!e0) continue
            e0.lastSeen = Date.now()
            e0.warned = false
            // v11 loop detection: only CHILD sessions are auto-supervised.
            // Fingerprint tool name + args so alternating loops are visible.
            try {
              const name = toolNames.get(d.id) || "unknown"
              const h = JSON.stringify({ name, input: d.input || {} })
              const hist = toolHistory.get(id) || []
              hist.push(h)
              if (hist.length > 6) hist.shift()
              toolHistory.set(id, hist)
              const n = hist.length
              const parentID = parentIDs.get(id)
              if (
                parentID &&
                n >= 3 &&
                hist[n - 1] === hist[n - 2] &&
                hist[n - 2] === hist[n - 3] &&
                !e0.loopWarned
              ) {
                e0.loopWarned = true
                log("child loop -> notify parent:", id)
                queueParentNotification(
                  parentID,
                  "子会话「" + id + "」连续 3 次以相同参数调用同一工具，疑似陷入循环。请检查它是否需要换策略或中断重派。"
                )
              }
            } catch {}
          } else if (
            eventType === "session.tool.success" ||
            eventType === "session.tool.failed"
          ) {
            clearTool(id, d.id)
          } else if (eventType === "permission.asked") {
            pendingPermission.set(id, Date.now())
          } else if (eventType === "permission.replied") {
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
        if (s.parentID && /"drift"\s*:\s*true/.test(String(text))) {
          const reason = (String(text).match(/"reason"\s*:\s*"([^"]*)"/) || [])[1] || "方向偏移"
          queueParentNotification(
            s.parentID,
            "子会话「" + sanitizeDiagnostic((s && s.title) || id, 80) +
              "」最近的工作疑似偏离原始目标（" + sanitizeDiagnostic(reason, 80) +
              "）。请核对它的任务目标；必要时纠偏或重派。"
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
              activeTools.delete(id)
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
            if (s0.parentID) parentIDs.set(id, s0.parentID)
            else parentIDs.delete(id)
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
          if (s.parentID) parentIDs.set(id, s.parentID)
          else parentIDs.delete(id)
          infos.set(id, s)
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

          // v11 spin: turns keep landing but nothing productive (no write/edit/
          // patch, no non-read shell) for SPIN_MS -> notify the PARENT only.
          // Root sessions are never nudged for spin: a lead legitimately spends
          // time reading, waiting on children, or waiting for the human, and
          // telling it "you haven't written anything" is just noise. Cooldown
          // prevents spam.
          const spin =
            !!s.parentID &&
            recent &&
            recent.turnsInWindow >= 2 &&
            now - (recent.lastProductive || 0) >= SPIN_MS &&
            now - e.startedAt >= SPIN_MS
          if (spin && !notifiedRecently(id, "spin", SPIN_COOLDOWN_MS)) {
            markNotified(id, "spin")
            const spinMin = Math.round(
              (now - (recent.lastProductive || now - SPIN_MS)) / 60000
            )
            log("spin -> notify parent:", id, spinMin + "m without writes")
            queueParentNotification(
              s.parentID,
              "子会话「" + sanitizeDiagnostic((s && s.title) || id, 80) + "」已 " +
                spinMin +
                " 分钟只有读取/确认、没有任何写操作（空转）。请检查它是否在反复核对；必要时给硬指令或中断重派。"
            )
          }

          // child sessions: session-level ownership — a lead supervises only
          // the children IT spawned. Notifications always go to that parent
          // (never to another session); the child itself is only interrupted
          // as a last resort after 4 h. This bounds the blast radius and
          // avoids a global "worker" policy.
          if (s.parentID) {
            const childTitle = sanitizeDiagnostic((s && s.title) || id, 80)

            // Reconcile event-tracked tools with the server snapshot. This
            // catches tools that started before plugin load or during an event
            // reconnect, and clears stale entries after a missed success event.
            const toolStates = await fetchToolStates(id)
            reconcileTools(id, toolStates)
            const toolMap = activeTools.get(id)
            if (toolMap) {
              for (const t of toolMap.values()) {
                if (
                  t.startedAt &&
                  isToolStalled(t.startedAt, now, t.budgetMs) &&
                  !t.notified &&
                  !notifiedRecently(id, "tool:" + t.id, 30 * 60 * 1000)
                ) {
                  t.notified = true
                  markNotified(id, "tool:" + t.id, 30 * 60 * 1000)
                  const min = Math.round((now - t.startedAt) / 60000)
                  log("child tool stall -> notify parent:", id, sanitizeDiagnostic(t.name, 40), min + "m")
                  queueParentNotification(
                    s.parentID,
                    "子会话「" + childTitle + "」的 " + sanitizeDiagnostic(t.name, 40) +
                      " 工具已运行 " + min + " 分钟未结束（预算 " +
                      Math.round(t.budgetMs / 60000) + " 分钟）。请检查是否卡死。"
                  )
                }
              }
            }

            if (idleMin >= CHILD_INTERRUPT_MS / 60000) {
              if (hasProtectedTool(id, now)) {
                log("skip child interrupt (tool within budget):", id, idleMin + "m")
                continue
              }
              log("child stale, interrupting:", id, "idle", idleMin + "m", childTitle)
              try {
                await ctx.session.interrupt({ sessionID: id, resume: false })
              } catch (err) {
                log("child interrupt failed:", id, String(err))
              }
              queueParentNotification(
                s.parentID,
                "子会话「" + childTitle + "」已 " + idleMin +
                  " 分钟无活动，且没有仍在预算内运行的工具，已自动打断。请检查其产出或重新派发。"
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
              queueParentNotification(
                s.parentID,
                "子会话「" + childTitle + "」已 " + idleMin +
                  " 分钟无活动；若已卡死请介入或重新派发（≥" +
                  CHILD_INTERRUPT_MS / 3600000 + "h 将自动打断）。"
              )
            }
            continue
          }

          // v11: only CHILD sessions are auto-supervised (handled above). A
          // root session is driven by the human: it may legitimately sit idle
          // while the human reads, thinks, or waits on other work. Never nudge,
          // drift-check, warn at, or interrupt a root — a ping here wakes an
          // idle session for nothing and only produces noise.
          if (idleMin >= NUDGE_MS / 60000 && !notifiedRecently(id, "rootidle", 60 * 60 * 1000)) {
            markNotified(id, "rootidle")
            log("root idle, no action:", id, idleMin + "m")
          }
          continue
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
      "loaded: v12",
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
      for (const t of pendingTimers) clearTimeout(t)
      pendingTimers.clear()
      pendingNotifications.clear()
      log("unloaded:", myDir || "(no dir)")
    }
  },
}// hot-reload probe 2026-11-01T19:51:43.2440905+08:00
