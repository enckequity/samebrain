#!/bin/bash
# Unattended smartloop driver. opencode has no native scheduled wake, so a scheduler
# re-invokes this on an interval; one pass resumes each non-done, non-blocked run once,
# then exits. The smartloop skill and state files are agent-neutral — this only supplies
# the wake. macOS uses launchd (--install); on Linux, run it from cron or a systemd timer.
#
#   bin/smartloop-driver.sh              one pass (what the scheduler runs)
#   bin/smartloop-driver.sh --install    write + load a launchd job (macOS); opt-in
#   bin/smartloop-driver.sh --uninstall  unload + remove it
#
# Config (env, or $STATE_DIR/driver.env, which is local and gitignored):
#   SMARTLOOP_DIR       state dir                     (default ~/.smartloop)
#   SMARTLOOP_AGENT     opencode agent to run         (default autonomous)
#   SMARTLOOP_OWNER     coordination lease owner      (default opencode@<host>)
#   SMARTLOOP_SCOPE     if set, hold a lease for this scope for the pass
#   SMARTLOOP_INTERVAL  seconds between passes        (default 1800, --install only)
#   SMARTLOOP_TIMEOUT   per-run wall-clock cap, secs  (default 3600)
#   SMARTLOOP_LOG       log file                      (default ~/logs/smartloop-driver.log)
# Allowlist: $STATE_DIR/driver-allowlist (one slug per line). Absent = drive all runs.
set -u

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="${SMARTLOOP_DIR:-$HOME/.smartloop}"
# Instance-local overrides (never committed): machine-specific scope, owner, agent.
[ -f "$STATE_DIR/driver.env" ] && . "$STATE_DIR/driver.env"

AGENT="${SMARTLOOP_AGENT:-autonomous}"
HOST="$(hostname -s 2>/dev/null || hostname)"
OWNER="${SMARTLOOP_OWNER:-opencode@$HOST}"
SCOPE="${SMARTLOOP_SCOPE:-}"
INTERVAL="${SMARTLOOP_INTERVAL:-1800}"
RUN_TIMEOUT="${SMARTLOOP_TIMEOUT:-3600}"
LOG="${SMARTLOOP_LOG:-$HOME/logs/smartloop-driver.log}"
LABEL="dev.samebrain.smartloop-driver"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" >>"$LOG"; }

# portable timeout (macOS has no `timeout`)
run_timeout() { # $1 = seconds, rest = command
  local secs="$1"; shift
  "$@" &
  local pid=$!
  ( sleep "$secs"; kill -TERM "$pid" 2>/dev/null; sleep 10; kill -KILL "$pid" 2>/dev/null ) &
  local watchdog=$!
  wait "$pid" 2>/dev/null; local rc=$?
  kill "$watchdog" 2>/dev/null
  return $rc
}

install() {
  if [ "$(uname -s)" != "Darwin" ]; then
    echo "smartloop-driver: --install is launchd (macOS) only — use cron or a systemd timer on Linux." >&2
    exit 1
  fi
  mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
  # Prepend opencode's directory so the job finds it without a login shell.
  local oc_dir; oc_dir="$(dirname "$(command -v opencode 2>/dev/null || echo /usr/local/bin/opencode)")"
  cat >"$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$REPO/bin/smartloop-driver.sh</string></array>
  <key>StartInterval</key><integer>$INTERVAL</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>$HOME</string>
    <key>PATH</key><string>$oc_dir:/usr/local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StandardOutPath</key><string>$HOME/logs/smartloop-driver.launchd.log</string>
  <key>StandardErrorPath</key><string>$HOME/logs/smartloop-driver.launchd.log</string>
</dict>
</plist>
PLIST_EOF
  launchctl unload "$PLIST" 2>/dev/null
  launchctl load "$PLIST" && echo "smartloop-driver: installed $PLIST (every ${INTERVAL}s)"
}

uninstall() {
  [ -f "$PLIST" ] || { echo "smartloop-driver: no job at $PLIST"; return 0; }
  launchctl unload "$PLIST" 2>/dev/null
  rm -f "$PLIST"
  echo "smartloop-driver: removed $PLIST"
}

case "${1:-}" in
  --install)   install; exit 0;;
  --uninstall) uninstall; exit 0;;
esac

mkdir -p "$(dirname "$LOG")"
log "pass start"

# Hold a coordination lease across the whole pass, if this instance uses one.
if [ -n "$SCOPE" ]; then
  node "$REPO/hooks/lease-check.mjs" claim "$SCOPE" --owner "$OWNER" --ttl 1209600 >>"$LOG" 2>&1
fi

QUEUE_LIST=$(node "$REPO/hooks/smartloop-sweep.mjs" --portfolio 2>/dev/null \
             | grep -oE '/smartloop resume [a-z0-9-]+' | awk '{print $3}')
if [ -z "$QUEUE_LIST" ]; then log "queue empty"; exit 0; fi

# Optional allowlist: $STATE_DIR/driver-allowlist (one slug per line). Absent = drive all.
ALLOW="$STATE_DIR/driver-allowlist"
if [ -f "$ALLOW" ]; then
  FILTERED=""
  for s in $QUEUE_LIST; do grep -qx "$s" "$ALLOW" && FILTERED="$FILTERED $s"; done
  QUEUE_LIST="$FILTERED"
  log "allowlist active:${QUEUE_LIST:- none}"
  [ -z "${QUEUE_LIST# }" ] && exit 0
fi

# OpenCode exposes no session id to the agent, so hand smartloop a stable one.
export SMARTLOOP_SESSION_ID="${SMARTLOOP_SESSION_ID:-opencode-$HOST}"
export SMARTLOOP_OWNER_MACHINE="$HOST"

for slug in $QUEUE_LIST; do
  sf="$STATE_DIR/$slug/state.md"
  [ -f "$sf" ] || continue
  status=$(grep -m1 '^status:' "$sf" | cut -d' ' -f2-)
  case "$status" in blocked:*|done) log "skip $slug ($status)"; continue;; esac
  log "resume $slug (was: $status)"
  run_timeout "$RUN_TIMEOUT" opencode run --auto --agent "$AGENT" "/smartloop resume $slug" </dev/null >>"$LOG" 2>&1
  newst=$(grep -m1 '^status:' "$sf" | cut -d' ' -f2-)
  log "$slug -> $newst"
done
log "pass end"
