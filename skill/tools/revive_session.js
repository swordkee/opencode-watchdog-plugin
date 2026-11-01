// revive_session.js <sessionID> [instruction]
// Documented revive flow: interrupt (clear fake-running), then drive the
// session with "opencode run -s <id> --continue" detached, output to log.
const http = require("http")
const fs = require("fs")
const path = require("path")
const { spawn } = require("child_process")

const id = process.argv[2]
const instr =
  process.argv[3] ||
  "你因 30 分钟无活动被看门狗中断。请立即向用户汇报当前进度、已完成项与卡点（先不要做新的写操作），等待下一步指令。"

const svc = JSON.parse(
  fs.readFileSync(
    path.join(process.env.USERPROFILE, ".local/state/opencode/service.json"),
    "utf8"
  )
)
const auth = "Basic " + Buffer.from("opencode:" + svc.password).toString("base64")
const BASE = (svc.url || "http://127.0.0.1:49374").replace("0.0.0.0", "127.0.0.1")

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null
    const headers = { Authorization: auth, "Content-Type": "application/json" }
    if (data) headers["Content-Length"] = Buffer.byteLength(data)
    const r = http.request(BASE + p, { method, headers }, (res) => {
      let b = ""
      res.on("data", (c) => (b += c))
      res.on("end", () => {
        try { resolve(JSON.parse(b)) } catch { resolve(b) }
      })
    })
    r.on("error", reject)
    r.setTimeout(20000, () => r.destroy(new Error("timeout")))
    if (data) r.write(data)
    r.end()
  })
}

;(async () => {
  try {
    const r = await req("POST", "/api/session/" + id + "/interrupt", {})
    console.log("interrupt:", JSON.stringify(r).slice(0, 120))
  } catch (e) {
    console.log("interrupt err:", String(e))
  }
  await new Promise((r) => setTimeout(r, 1500))

  const stateDir = path.join(
    process.env.USERPROFILE,
    ".local/state/opencode/watchdog"
  )
  fs.mkdirSync(stateDir, { recursive: true })
  const out = fs.openSync(path.join(stateDir, "revive-" + id + ".log"), "a")
  // resolve the CLI instead of hardcoding (Scoop path drifts): env override,
  // then PATH lookup
  function resolveOpencode() {
    if (process.env.OPENCODE_EXECUTABLE) return process.env.OPENCODE_EXECUTABLE
    try {
      const { execSync } = require("child_process")
      const res = execSync("where.exe opencode", { encoding: "utf8" })
      const exe = res
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => /\.exe$/i.test(s))[0]
      if (exe) return exe
    } catch {}
    return "opencode"
  }
  const oc = resolveOpencode()
  console.log("opencode exe:", oc)
  const p = spawn(
    oc,
    ["run", "-s", id, "--continue", "--agent", "build", "--auto", instr],
    { detached: true, stdio: ["ignore", out, out], windowsHide: true }
  )
  p.unref()
  console.log("revive spawned pid=" + p.pid)
})().catch((e) => {
  console.error(String(e))
  process.exit(1)
})