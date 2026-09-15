// samebrain completion notifications for opencode (macOS).
//
// Long autonomous runs finish while the user is looking elsewhere. Fire one
// desktop notification per idle turn (throttled per session) and one when a run
// stalls on an approval prompt. No-op on non-macOS and when disabled.
//
// Env knobs:
//   OPENCODE_NOTIFY=0          load nothing
//   OPENCODE_NOTIFY_MIN_MS     per-session idle throttle (default 30000)
//   OPENCODE_NOTIFY_LOG=path   append the message here instead of osascript (tests)

import { spawn } from "node:child_process"
import { appendFileSync } from "node:fs"
import { basename } from "node:path"

const DISABLED = process.env.OPENCODE_NOTIFY === "0"
const LOG = process.env.OPENCODE_NOTIFY_LOG
const THROTTLE_MS = Number(process.env.OPENCODE_NOTIFY_MIN_MS ?? 30000) || 30000

function notify(message) {
  if (LOG) {
    try { appendFileSync(LOG, `${message}\n`) } catch { /* best-effort */ }
    return
  }
  if (process.platform !== "darwin") return
  const escaped = message.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
  try {
    spawn("osascript", ["-e", `display notification "${escaped}" with title "opencode"`], {
      stdio: "ignore",
      detached: true,
    }).unref()
  } catch { /* notifications are best-effort */ }
}

export default async ({ directory }) => {
  if (DISABLED) return {}
  const last = new Map()
  const label = basename(directory || "opencode")

  return {
    event: async ({ event }) => {
      const p = event.properties ?? {}
      if (event.type === "session.error") {
        notify(`opencode session error in ${label}`)
        return
      }
      if (event.type !== "session.idle") return
      const id = p.sessionID ?? "default"
      const now = Date.now()
      if (now - (last.get(id) ?? 0) < THROTTLE_MS) return
      last.set(id, now)
      notify(`opencode task done in ${label}`)
    },

    "permission.ask": async (_input, output) => {
      if (output.status === "ask") notify(`opencode needs approval in ${label}`)
    },
  }
}