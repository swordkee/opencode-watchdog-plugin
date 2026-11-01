// children_check.js <parentSessionID> — status table of a main session's
// running child fleet (children = sessions whose parentID matches).
// Prints: id, title, idle minutes (since time.updated), outcome, stale flag.
const http = require("http")
const fs = require("fs")
const path = require("path")

const PARENT = process.argv[2]
if (!PARENT) {
  console.error("usage: node children_check.js <parentSessionID>")
  process.exit(1)
}
const STALE_MIN = 30

const svc = JSON.parse(
  fs.readFileSync(
    path.join(process.env.USERPROFILE, ".local/state/opencode/service.json"),
    "utf8"
  )
)
const auth = "Basic " + Buffer.from("opencode:" + svc.password).toString("base64")
const BASE = (svc.url || "http://127.0.0.1:49374").replace("0.0.0.0", "127.0.0.1")

function req(method, p) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      BASE + p,
      { method, headers: { Authorization: auth } },
      (res) => {
        let b = ""
        res.on("data", (c) => (b += c))
        res.on("end", () => {
          try { resolve(JSON.parse(b)) } catch { resolve(b) }
        })
      }
    )
    r.on("error", reject)
    r.setTimeout(30000, () => r.destroy(new Error("timeout")))
    r.end()
  })
}

;(async () => {
  const active = await req("GET", "/api/session/active")
  const activeIds = new Set(Object.keys((active && active.data) || {}))
  const all = await req("GET", "/api/session?limit=1000")
  const now = Date.now()
  const children = (all.data || []).filter((s) => s && s.parentID === PARENT)
  if (children.length === 0) {
    console.log("no child sessions for", PARENT)
    return
  }
  const rows = children.map((s) => {
    const u = s.time && s.time.updated ? Number(s.time.updated) : 0
    const idleMin = u ? Math.round((now - u) / 60000) : -1
    const isRunning = activeIds.has(s.id)
    const stale = isRunning && idleMin >= STALE_MIN
    return {
      id: s.id,
      title: (s.title || "").slice(0, 30),
      state: isRunning ? "RUNNING" : "done",
      idleMin,
      outcome: s.outcome || "-",
      stale,
    }
  })
  rows.sort((a, b) => b.idleMin - a.idleMin)
  console.log(
    "parent:",
    PARENT,
    "| children:",
    rows.length,
    "| running:",
    rows.filter((r) => r.state === "RUNNING").length,
    "| stale(>=" + STALE_MIN + "m & running):",
    rows.filter((r) => r.stale).length
  )
  for (const r of rows) {
    console.log(
      r.stale ? "[STALE] " : "        ",
      r.id,
      r.state.padEnd(8),
      String(r.idleMin).padStart(5) + "m",
      String(r.outcome).padEnd(10),
      r.title
    )
  }
})().catch((e) => {
  console.error(String(e))
  process.exit(1)
})
