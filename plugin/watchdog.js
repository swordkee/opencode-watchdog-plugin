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

    const send = (sessionID, text, delivery) =>
      ctx.session
        .prompt({ sessionID, text, delivery: delivery || "steer", resume: false })
        .catch((e) => log("steer failed:", sessionID, String(e)))

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
        if (u && u >= cutoff)
          running.set(s.id, {
            lastSeen: Math.max(u, now0 - 60000),
            startedAt: u,
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
        const prompt =
          "你在做会话偏航检查。会话目标（标题）：" +
          title +
          "\n最近对话摘要：\n" +
          digest +
          '\n判断：最近的工作是否仍在服务于该目标？只输出一行 JSON：{"drift":true|false,"reason":"不超过40字"}'
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
          const last = Math.max(e.lastSeen || 0, dbUpdated)
          const idleMin = last ? Math.round((now - last) / 60000) : -1

          // workers (child sessions) are supervised by their main session:
          // no nudge, no interrupt here — prevents retry storms (W-5 x5)
          if (s.parentID) continue

          // busy parent = waiting on running subagents: courtesy nudge at 2x
          // window, never interrupt
          if (busyParents.has(id)) {
            if (!e.nudged && idleMin >= (NUDGE_MS * 2) / 60000) {
              e.nudged = true
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

          // L3 drift (long runs only, every 60 min, warn-only)
          if (
            e.startedAt &&
            now - e.startedAt >= DRIFT_MIN_RUN_MS &&
            now - (e.lastDriftAt || 0) >= DRIFT_EVERY_MS
          ) {
            void driftCheck(id, e, s)
          }

          // L1 nudge: silent 15 min but not yet stale — one ping per run
          if (
            !e.nudged &&
            idleMin >= NUDGE_MS / 60000 &&
            idleMin < staleMs / 60000
          ) {
            e.nudged = true
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
