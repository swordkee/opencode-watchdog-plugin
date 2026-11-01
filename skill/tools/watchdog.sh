#!/usr/bin/env bash
# =============================================================
# watchdog.sh - opencode session watchdog (superagent-ops skill, bash edition)
# Companion to watchdog.ps1; shares the same state dir and log format.
#
# Usage:
#   watchdog.sh                          report only
#   watchdog.sh --interrupt              interrupt stale sessions
#   watchdog.sh --interrupt --resume-file FILE
#                                        relaunch interrupted sessions via
#                                        "opencode run -s <id> --continue"
#                                        (FILE = UTF-8 instruction text)
#   watchdog.sh --report                 post scan summary to the main
#                                        (top-level) session: steer if live,
#                                        else queue; never into a worker
#   watchdog.sh --daemon [SEC]           loop forever (default 300s), nohup-able
#   watchdog.sh --status                 show last scan + log tail
# Options: --stale-minutes N (default 45)  --base-url URL  --service-json PATH
#
# Stale criterion: in /api/session/active map AND updated idle >= N minutes.
# outcome=succeeded is NOT trusted (proven unreliable on this machine).
# State: ~/.local/state/opencode/watchdog/   (shared with watchdog.ps1)
# =============================================================
set -u

STALE_MINUTES=45
BASE_URL=""
SERVICE_JSON="${HOME}/.local/state/opencode/service.json"
INTERRUPT=0
RESUME_FILE=""
DAEMON_SEC=0
STATUS=0
REPORT=0

STATE_DIR="${HOME}/.local/state/opencode/watchdog"
LOG_FILE="${STATE_DIR}/watchdog.log"
SCAN_FILE="${STATE_DIR}/last-scan.tsv"
PID_FILE="${STATE_DIR}/watchdog.sh.pid"
RESUME_JS="$(cd "$(dirname "$0")" && pwd)/resume_runner.js"
OC_EXE_DEFAULT="D:/Dev/Scoop/apps/nodejs-lts/current/bin/node_modules/@opencode/cli/bin/opencode.exe"

while [ $# -gt 0 ]; do
  case "$1" in
    --interrupt)     INTERRUPT=1 ;;
    --report)        REPORT=1 ;;
    --resume-file)   RESUME_FILE="$2"; INTERRUPT=1; shift ;;
    --daemon)
      DAEMON_SEC=300
      if [ $# -ge 2 ] && [[ "$2" =~ ^[0-9]+$ ]]; then DAEMON_SEC="$2"; shift; fi ;;
    --stale-minutes) STALE_MINUTES="$2"; shift ;;
    --base-url)      BASE_URL="$2"; shift ;;
    --service-json)  SERVICE_JSON="$2"; shift ;;
    --status)        STATUS=1 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

mkdir -p "$STATE_DIR"

log() { printf '%s [%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" "$2" | tee -a "$LOG_FILE"; }

wpath() {  # convert to Windows path for node.exe when under Git Bash/MSYS
  if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi
}

if [ "$STATUS" -eq 1 ]; then
  echo "=== last scan (tsv) ==="
  [ -f "$SCAN_FILE" ] && cat "$SCAN_FILE" || echo "(no scan yet)"
  echo "=== log tail ==="
  [ -f "$LOG_FILE" ] && tail -n 30 "$LOG_FILE"
  exit 0
fi

command -v node  >/dev/null 2>&1 || { echo "node not found on PATH" >&2; exit 1; }
command -v curl  >/dev/null 2>&1 || { echo "curl not found on PATH" >&2; exit 1; }
[ -f "$SERVICE_JSON" ] || { echo "service.json not found: $SERVICE_JSON" >&2; exit 1; }

PASSWORD=$(sed -n 's/.*"password"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$SERVICE_JSON" | head -n 1)
[ -n "$PASSWORD" ] || { echo "password not found in service.json" >&2; exit 1; }

if [ -z "$BASE_URL" ]; then
  BASE_URL=$(sed -n 's/.*"url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$SERVICE_JSON" | head -n 1)
  [ -n "$BASE_URL" ] || BASE_URL="http://127.0.0.1:49374"
  # service.json may advertise the bind address 0.0.0.0, which is not
  # routable as a client target; force loopback instead.
  BASE_URL="${BASE_URL//0.0.0.0/127.0.0.1}"
fi

# --- daemon guard -----------------------------------------------------------
if [ "$DAEMON_SEC" -gt 0 ]; then
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE" 2>/dev/null)" 2>/dev/null; then
    log ERROR "daemon already running pid=$(cat "$PID_FILE")"
    exit 1
  fi
  echo $$ > "$PID_FILE"
  trap 'rm -f "$PID_FILE"; exit 0' INT TERM
  log INFO "daemon started pid=$$ interval=${DAEMON_SEC}s stale=${STALE_MINUTES}min interrupt=${INTERRUPT} resume=$( [ -n "$RESUME_FILE" ] && echo on || echo off )"
fi

fetch() {  # $1=url  $2=outfile
  curl -s -m 30 -u "opencode:${PASSWORD}" "$1" -o "$2" || return 1
  [ -s "$2" ] || return 1
  return 0
}

# node: emit TSV (id, title, dir, outcome, idleMinutes) for sessions in active map
parse_running() {  # $1=active.json $2=sessions.json $3=outfile
  node -e '
const fs = require("fs");
const raw = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const map = raw.data || raw;
const active = new Set(Object.keys(map));
const j = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const list = (j && j.data) || [];
const now = Date.now();
const clean = v => String(v == null ? "" : v).replace(/[\t\r\n\u001f]+/g, " ");
const US = String.fromCharCode(31); // unit separator: survives bash read (no IFS collapsing)
for (const s of list) {
  if (!s || !s.id || !active.has(s.id)) continue;
  let idle=-1;
  if (s.time && s.time.updated) idle = Math.round((now - s.time.updated) / 60000);
  console.log([s.id, clean(s.parentID), clean(s.title), clean(s.location && s.location.directory), clean(s.outcome), idle].join(US));
}' "$1" "$2" > "$3"
}

list_active_ids() {  # $1=active.json -> prints comma-joined ids
  node -e '
const fs = require("fs");
const raw = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const map = raw.data || raw;
console.log(Object.keys(map).join(","));' "$1"
}

run_once() {
  # rotate log if > 10MB
  if [ -f "$LOG_FILE" ] && [ "$(stat -c %s "$LOG_FILE" 2>/dev/null || echo 0)" -gt 10485760 ]; then
    mv -f "$LOG_FILE" "${LOG_FILE}.old"
  fi

  local atmp stmp
  atmp=$(mktemp) || return 1
  stmp=$(mktemp) || return 1

  if ! fetch "${BASE_URL}/api/session/active" "$atmp"; then
    log ERROR "fetch active failed (${BASE_URL})"
    rm -f "$atmp" "$stmp"; return 1
  fi
  if ! fetch "${BASE_URL}/api/session?limit=1000" "$stmp"; then
    log ERROR "fetch sessions failed"
    rm -f "$atmp" "$stmp"; return 1
  fi
  if ! parse_running "$atmp" "$stmp" "$SCAN_FILE"; then
    log ERROR "parse running sessions failed"
    rm -f "$atmp" "$stmp"; return 1
  fi
  rm -f "$atmp" "$stmp"

  local running=0 candidates=""
  while IFS=$'\037' read -r id parent title dir outcome idle; do
    [ -n "$id" ] || continue
    case "$idle" in ''|*[!0-9]*) idle=-1 ;; esac
    running=$((running + 1))
    local stale=0
    if [ "$idle" -ge "$STALE_MINUTES" ]; then stale=1; candidates="$candidates $id"; fi
    log INFO "running $id title='$title' dir='$dir' outcome=$outcome idle=${idle}min stale=$stale"
  done < "$SCAN_FILE"

  if [ "$INTERRUPT" -eq 0 ] && [ "$REPORT" -eq 0 ]; then
    log INFO "scan done: $running running, $( [ -n "$candidates" ] && echo $(wc -w <<< "$candidates") || echo 0 ) stale (report-only)"
    return 0
  fi
  if [ -z "$candidates" ]; then
    log INFO "scan done: no stale sessions, nothing to interrupt"
    return 0
  fi

  # --- interrupt ---
  local done_ids=""
  for id in $candidates; do
    local resp rc
    resp=$(curl -s -m 30 -u "opencode:${PASSWORD}" -X POST -H "Content-Type: application/json" -d "{}" "${BASE_URL}/api/session/${id}/interrupt")
    rc=$?
    log INFO "interrupt $id rc=$rc resp=${resp}"
    [ $rc -eq 0 ] && done_ids="$done_ids $id"
  done

  # --- verify interrupted ids left the active map ---
  sleep 3
  local vtmp still
  vtmp=$(mktemp)
  if fetch "${BASE_URL}/api/session/active" "$vtmp"; then
    still=$(list_active_ids "$vtmp")
    for id in $done_ids; do
      case ",$still," in
        *",$id,"*) log WARN "interrupt NOT confirmed for $id (stuck session, will retry next run)" ;;
        *)         log INFO "interrupt confirmed for $id" ;;
      esac
    done
  else
    log WARN "post-interrupt verify failed"
  fi
  rm -f "$vtmp"

  # --- report: per-family to each top-level root session ---
  if [ "$REPORT" -eq 1 ]; then
    local SJSON FJSON
    SJSON=$(mktemp); FJSON=$(mktemp)
    if fetch "${BASE_URL}/api/session?limit=1000" "$SJSON"; then
      node -e '
const fs = require("fs");
const raw = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const byId = {};
(raw.data || []).forEach(s => { if (s && s.id) byId[s.id] = s; });
const US = String.fromCharCode(31);
const recs = fs.readFileSync(process.argv[2], "utf8").split(/\r?\n/).filter(Boolean).map(l => {
  const f = l.split(US);
  return { id: f[0], parent: f[1] || "", title: f[2] || "", idle: parseInt(f[5], 10) };
});
const famMembers = {}, famOf = {};
recs.forEach(r => {
  let rid = null;
  if (!r.parent) rid = r.id;
  else {
    let cur = r.parent, d = 0;
    while (cur && d < 10) { const p = byId[cur]; if (p && p.parentID) { cur = p.parentID; d++; } else break; }
    rid = cur;
  }
  if (!rid) rid = "(orphan)";
  famOf[r.id] = rid;
  (famMembers[rid] = famMembers[rid] || []).push(r);
});
const stamp = process.argv[3];
const staleAfter = parseInt(process.argv[4], 10);
const maxIdle = parseInt(process.argv[5], 10);
const done = (process.argv[6] || "").split(/\s+/).filter(Boolean);
Object.keys(famMembers).forEach(rid => {
  const members = famMembers[rid];
  if (members.length < 2) return;
  const rootAll = byId[rid];
  if (!rootAll) return;
  let rt = rootAll.title || "";
  if (rt.length > 24) rt = rt.slice(0, 24) + "...";
  const list = members.map(m => { let t = m.title || ""; if (t.length > 24) t = t.slice(0, 24) + "..."; return t + "(idle " + m.idle + "m)"; }).join("; ");
  const staleN = members.filter(m => m.idle >= staleAfter).length;
  const intN = done.filter(id => famOf[id] === rid).length;
  const text = "[watchdog " + stamp + " | family \x27" + rt + "\x27] members " + members.length + ": " + list + ". stale: " + staleN + "; interrupted now: " + intN + ". (auto-report, no reply needed, keep working)";
  let delivery = "queue";
  const rootRec = members.find(m => m.id === rid);
  if (rootRec && rootRec.idle >= 0 && rootRec.idle < maxIdle) delivery = "steer";
  const body = JSON.stringify({ text: text, delivery: delivery, resume: false });
  process.stdout.write(rid + "\t" + delivery + "\t" + body + "\n");
});
' "$SJSON" "$SCAN_FILE" "$(date +%H:%M)" "$STALE_MINUTES" 10 "$done_ids" > "$FJSON"
      while IFS=$'\t' read -r rid delivery body; do
        [ -n "$rid" ] || continue
        local BFILE OFILE BREF rc
        BFILE=$(mktemp); OFILE=$(mktemp)
        printf '%s' "$body" > "$BFILE"
        BREF="@$(cygpath -m "$BFILE" 2>/dev/null || echo "$BFILE")"
        curl -s -m 30 -u "opencode:${PASSWORD}" -X POST -H "Content-Type: application/json" --data-binary "$BREF" "${BASE_URL}/api/session/${rid}/prompt" -o "$OFILE"
        rc=$?
        log INFO "report -> $rid via $delivery rc=$rc resp=$(head -c 160 "$OFILE" 2>/dev/null)"
        rm -f "$BFILE" "$OFILE"
      done < "$FJSON"
    else
      log WARN "report skipped: could not fetch session list"
    fi
    rm -f "$SJSON" "$FJSON"
  fi

  # --- optional auto-resume ---
  if [ -z "$RESUME_FILE" ]; then
    log INFO "done: $(wc -w <<< "$done_ids") interrupted, resume disabled (no --resume-file)"
    return 0
  fi
  if [ ! -f "$RESUME_FILE" ]; then log ERROR "resume file not found: $RESUME_FILE"; return 1; fi
  if [ ! -f "$RESUME_JS" ];  then log ERROR "resume_runner.js not found: $RESUME_JS"; return 1; fi

  local oc="$OC_EXE_DEFAULT"
  [ -f "$oc" ] || oc=$(command -v opencode 2>/dev/null || echo "")
  [ -n "$oc" ] || { log ERROR "opencode executable not found"; return 1; }

  for id in $done_ids; do
    local rlog="${STATE_DIR}/resume-${id}.log"
    nohup node "$(wpath "$RESUME_JS")" "$id" "$(wpath "$RESUME_FILE")" "$(wpath "$rlog")" "$oc" >>"$rlog" 2>&1 &
    log INFO "resume launched for $id (log: $rlog)"
  done
  log INFO "done with resume"
  return 0
}

if [ "$DAEMON_SEC" -gt 0 ]; then
  while true; do
    run_once || log ERROR "run_once failed rc=$?"
    sleep "$DAEMON_SEC"
  done
else
  run_once
  exit $?
fi
